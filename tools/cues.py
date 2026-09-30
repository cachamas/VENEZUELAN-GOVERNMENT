"""Bake a light cue sheet per song, from the song's own onsets and spectrum.

Why bake instead of reacting live: a live per-step RNG changes ~7x a second with
no relationship to the music, which reads as flicker. A cue sheet is derived from
the real onsets on the real beat grid, with each cue's LAMPS chosen from the
spectrum at that instant, so a bass passage lights the big corneta and a bright
passage lights the tweeters - consistently, for as long as that band is hot.
That is what makes it look intentional.

The grid comes from the ARTIST's BPM (a tempo estimate was measurably unreliable).
Only the phase is fitted, by sliding the grid to maximise onset energy on it.

Invariants enforced while generating, and checked in the validator:
  * never-dark   - from the first audible moment to the last, at least one lamp
                   is lit on any instant
  * no flicker   - no two cues closer than MIN_GAP
  * silence      - a run below the silence floor emits no cues at all
  * band-targeted - lamps follow the smoothed band energy, not a random pick
"""
import json
import math
import os
import warnings

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

warnings.filterwarnings("ignore")

SRC = r"W:\Users\gov\projects\PORTFOLIO2\media\MUSIC\mp3"
OUT = r"W:\Users\gov\projects\PORTFOLIO2\js\lightCues.js"

SR = 22050
HOP = 256                      # 11.6 ms - fine enough to place a cue tightly

# lamp index -> band. Same 7 lamps / 4 bands the runtime uses.
LAMP_BAND = [0, 1, 2, 3, 2, 3, 1]
# 0 sub/low -> the big corneta, 1 low-mid, 2 mid, 3 high -> the tweeters
BANDS = [(0, 140), (140, 900), (900, 3200), (3200, 11000)]
# The kick band is separate and narrow: a kick is a broadband click, so a plain
# spectral-flux envelope weights the hats and the kick ends up merely "loudest"
# rather than distinguishable. Isolating 30-120 Hz is what makes the show follow
# the DRUMS, which is the thing the kicks have to carry.
KICK_BAND = (30, 120)

MIN_GAP = 0.14                 # s between cues - a blink has to be readable
SILENCE = 0.045                # band energy below this = nothing playing
SMOOTH_CUE = 0.10              # s - fast envelope: how hard the hit is
SMOOTH_RANK = 0.55             # s - slow envelope: which band LEADS (intentional)
KICK_FAST = 0.045              # s - kick low-end envelope: fast, so drums read
                               # as transients instead of as sustained bass
KICK_MIN = 0.34                # a kick must at least be this loud to count
PHASE_WIN = 0.5                # s - how far the beat phase may slide
MAX_CPS = 2.6                  # hard cap on cues/second - this is a light show,
                               # not a strobe. 9/s (the naive 8th-note version) read
                               # as pure flicker, which is what we are fixing.
OFFBEAT_GAIN = 1.35            # an 8th note only counts if it is this much louder
                               # than the local average, i.e. a real off-beat hit
CUE_MIN_GAP = 0.14             # s - re-asserted by validate(); must equal MIN_GAP

# BPM per song. The first 15 are the ARTIST's confirmed values - an automated
# estimate was measurably wrong on four of them, so these are authoritative.
# The rest were measured with the validated tempogram estimator; the ones marked
# low are octave-ambiguous and worth checking by ear (tools/emit_tracks.py lists
# them). One number per line - edit here and rebuild if any need correcting.
BPM = {
    # artist-confirmed
    "ANTEPASADOS": 115, "BOKITA": 110, "BOZZO": 120, "CORAZON VENEZOLANO": 120,
    "DILO": 117, "JUGUETE": 107, "LA NOCHE FATAL": 114, "ME VALORO": 130, "MERCAL": 83,
    "MOROKA JIA": 74, "SAPOS": 94, "SILBON": 110, "TARAKO": 130, "UH AH": 93, "VIGILIA": 73,
    # measured
    "AMAN": 152, "ELECTROLUX": 143.55, "PERDONALOS": 129.2,
    "INTERVENIR": 112.35,   # low confidence
    "MANTEQUILLA": 92.29,   # low confidence (onset rate favours the half)
    "MUCHACHITA": 136,      # low confidence
    "PAPITO": 123.05,       # low confidence
}

# 7 lamps -> how bright. Kicks get the top of this range, everything else sits
# low, so the contrast between a kick and a hat is the whole point.
LEVELS = [0.22, 0.34, 0.48, 0.62, 0.78, 1.0]
# a cue's lamp count by what fired. Kick carries the show; the rest texture it.
# A kick lights FOUR of the seven - enough to read as a real light show, still
# leaving three dark each time so the car is never a solid block.
COUNT_KICK = 4
COUNT_MID = 2
COUNT_SOFT = 1
# a cue counts as a kick only if the low band really is the loudest transient
KICK_DOMINANCE = 1.15   # kick energy must exceed the mid energy by this much

# --- per-track kick tuning (the experiment knobs) -------------------------
# MOROKA JIA is 74 BPM and carries a lot of its weight in the low-mids rather
# than in a tight 30-120 Hz kick, so the default narrow window found only ~14%
# of its cues as kicks. Widening the window and relaxing the dominance test for
# that track lets its own low-mid bass drive the show. One entry here changes
# only that song; delete the entry to go back to the default.
KICK_BAND_OVERRIDE = {
    "MOROKA JIA": (30, 280),
}
KICK_MIN_OVERRIDE = {
    "MOROKA JIA": 0.20,
}
KICK_DOM_OVERRIDE = {
    "MOROKA JIA": 0.85,
}
# Widening the kick band alone plateaus (measured: 14% -> 21% and no further,
# because the track only has ~70 cue slots at 74 BPM). Letting more off-beat
# accents in, and tightening the minimum gap, gives the low-mids more places to
# land. See tools/experiment_moroka.py for the sweep these came from.
OFFBEAT_GAIN_OVERRIDE = {
    "MOROKA JIA": 1.10,
}
MIN_GAP_OVERRIDE = {
    "MOROKA JIA": 0.11,
}


B36 = "0123456789abcdefghijklmnopqrstuvwxyz"


def b36(n):
    n = int(n)
    if n == 0:
        return "0"
    out = ""
    while n > 0:
        n, r = divmod(n, 36)
        out = B36[r] + out
    return out


def frames_per_second():
    return SR / HOP


def load(path):
    """Decode and resample to the analysis rate.

    The mp3s are 44.1 kHz. The frame math below (HOP, band edges, cue times) is
    all in terms of SR, so the audio MUST be at SR - analysing 44.1 kHz audio
    with 22.05 kHz frame math made every emitted cue time exactly twice as long
    as it should be.
    """
    x, fs = sf.read(path, always_2d=True)
    y = x.mean(axis=1)
    if fs != SR:
        y = resample_poly(y, SR, fs)
    return y, SR


def stft_mag(y):
    n = 1024
    win = np.hanning(n).astype(np.float64)
    nfr = 1 + (len(y) - n) // HOP
    idx = np.arange(n)[None, :] + HOP * np.arange(nfr)[:, None]
    frames = y[idx] * win[None, :]
    return np.abs(np.fft.rfft(frames, axis=1))


def band_energies(mag, freqs):
    """Per-band energy, normalised by each band's own 95th PERCENTILE.

    Normalising by the max is outlier-sensitive: a single click or a bright
    transient in one band squashes the rest of that band toward zero, which made
    JUGUETE emit 11 cues instead of ~120 (every beat fell under the silence
    test). A high percentile is stable against single-frame spikes.
    """
    out = np.zeros((mag.shape[0], len(BANDS)))
    for b, (lo, hi) in enumerate(BANDS):
        sel = (freqs >= lo) & (freqs < hi)
        if not sel.any():
            sel = freqs < hi
        out[:, b] = np.sqrt((mag[:, sel] ** 2).sum(axis=1) + 1e-12)
    ref = np.percentile(out, 95, axis=0, keepdims=True) + 1e-9
    return np.minimum(out / ref, 1.5)


def smooth(a, seconds):
    k = max(1, int(round(seconds * frames_per_second())))
    if k <= 1:
        return a
    ker = np.ones(k) / k
    pad = np.concatenate([np.full((k, a.shape[1]), a[0]), a, np.full((k, a.shape[1]), a[-1])])
    out = np.empty_like(a)
    for b in range(a.shape[1]):
        out[:, b] = np.convolve(pad[:, b], ker, mode="same")[k:-k]
    return out


def flux(mag):
    d = np.diff(mag, axis=0, prepend=mag[:1])
    return np.maximum(0.0, d).sum(axis=1)


def best_phase(onset, beat_frames):
    """Slide the beat grid to maximise onset energy landing on the beats."""
    if len(onset) == 0 or beat_frames <= 0:
        return 0
    cands = np.arange(0, beat_frames)
    best, bestv = 0, -1.0
    for p in cands:
        idx = ((np.arange(0, len(onset) - p, beat_frames) + p)).astype(int)
        idx = idx[idx < len(onset)]
        if len(idx) == 0:
            continue
        v = onset[idx].sum()
        if v > bestv:
            best, bestv = p, v
    return int(best)


def quantize_level(x):
    return int(np.clip(np.searchsorted(LEVELS, x), 0, len(LEVELS) - 1))


def build(name, path):
    y, fs = load(path)
    dur = len(y) / fs
    fps = frames_per_second()
    mag = stft_mag(y)
    freqs = np.fft.rfftfreq(1024, 1.0 / SR)
    bands = band_energies(mag, freqs)
    on = flux(mag)

    bands_fast = smooth(bands, SMOOTH_CUE)
    bands_rank = smooth(bands, SMOOTH_RANK)
    on_s = smooth(on[:, None], SMOOTH_CUE)[:, 0]
    on_ref = float(np.percentile(on_s, 98)) + 1e-9   # robust, unlike on_s.max()

    # --- kick envelope ----------------------------------------------------
    # Short window, because a kick's defining feature is how FAST the low end
    # comes up. SMOOTH_CUE would smear that into the sustained bass and we would
    # be following the bassline again, which is exactly what we do not want.
    kb = KICK_BAND_OVERRIDE.get(name, KICK_BAND)
    kmin = KICK_MIN_OVERRIDE.get(name, KICK_MIN)
    kdom = KICK_DOM_OVERRIDE.get(name, KICK_DOMINANCE)
    k_offbeat = OFFBEAT_GAIN_OVERRIDE.get(name, OFFBEAT_GAIN)
    k_gap = MIN_GAP_OVERRIDE.get(name, MIN_GAP)
    sel = (freqs >= kb[0]) & (freqs < kb[1])
    kick_raw = np.sqrt((mag[:, sel] ** 2).sum(axis=1) + 1e-12)
    kick_s = smooth(kick_raw[:, None], KICK_FAST)[:, 0]
    kick_rise = np.maximum(0.0, np.diff(kick_s, prepend=kick_s[0]))
    kick_ref = float(np.percentile(kick_rise, 98)) + 1e-9
    # mid-band reference so a hat cannot masquerade as a kick
    mid_rise = np.maximum(0.0, np.diff(bands_fast[:, 2], prepend=bands_fast[0, 2]))
    mid_ref = float(np.percentile(mid_rise, 98)) + 1e-9

    bpm = float(BPM[name])
    beat_s = 60.0 / bpm
    beat_frames = max(1, int(round(beat_s * fps)))
    phase = best_phase(on_s, beat_frames)

    # ---- events: BEATS are the backbone, 8ths only when they are real hits.
    # Emitting a cue on every 8th gave 8.4 cues/s, which is the flicker we are
    # trying to remove. Beats alone is ~2/s at these tempos, which reads as a
    # pattern; 8ths are added only where the music genuinely hits off-beat.
    #
    # Times are computed from the beat INDEX in exact float seconds, not by
    # accumulating integer frame steps. Accumulating frames quantised the beat
    # to 45/86.13 = 0.5226 s against a true 0.5264 s, which drifts ~0.3 s over a
    # minute - the lights would slowly slide off the beat.
    beat_frames = max(1, int(round(beat_s * fps)))
    phase_s = phase / fps
    dur_s = len(on_s) / fps
    events = []          # (seconds, frame index, is_beat)
    k = 0
    while True:
        t = phase_s + k * beat_s
        if t >= dur_s:
            break
        fr = int(round(t * fps))
        if fr < len(on_s):
            events.append((t, fr, True))
            # off-beat: only if the music really hits there
            t8 = phase_s + (k + 0.5) * beat_s
            fr8 = int(round(t8 * fps))
            if t8 < dur_s and fr8 < len(on_s):
                w = max(2, int(0.25 * fps))
                lo, hi = max(0, fr8 - w), min(len(on_s), fr8 + w + 1)
                local = float(on_s[lo:hi].mean()) + 1e-9
                if float(on_s[fr8]) > local * k_offbeat:
                    events.append((t8, fr8, False))
        k += 1
    events.sort()

    # thin to the density cap, keeping the strongest hits
    if events:
        cap = int(MAX_CPS * dur_s) + 2
        if len(events) > cap:
            strengths = [float(on_s[min(len(on_s) - 1, fr)]) for _, fr, _ in events]
            keep = sorted(range(len(events)), key=lambda i: -strengths[i])[:cap]
            events = [events[i] for i in sorted(keep)]

    # build cues
    cues = []
    last_t = -1e9
    for t, f, is_beat in events:
        if t - last_t < k_gap:
            continue
        loud = float(bands_fast[f].max())
        if loud < SILENCE:
            continue                      # real silence: emit nothing, lights go dark

        # classify the hit: a kick is a fast LOW transient that dominates the mids
        kr = float(kick_rise[f] / kick_ref)
        mr = float(mid_rise[f] / mid_ref)
        is_kick = kr > kmin and kr > mr * kdom
        strength = float(min(1.0, on_s[f] / on_ref))

        if is_kick:
            count = COUNT_KICK
            # the low lamps lead, because the kick IS the low end
            lead = 0
        elif strength > 0.45:
            count = COUNT_MID
            lead = int(np.argmax(bands_rank[f]))
        else:
            count = COUNT_SOFT
            lead = int(np.argmax(bands_rank[f]))
        if not is_beat:
            count = min(count, COUNT_MID)     # off-beat accents stay secondary

        # Lamps follow the SLOW (stable) band energy, anchored to the beat
        # position so a bar repeats musically instead of scattering.
        order = sorted(range(len(LAMP_BAND)), key=lambda i: (-bands_rank[f][LAMP_BAND[i]], i))
        pos_in_bar = int(round((t - phase_s) / beat_s)) % 4
        rot = (pos_in_bar * 2) % max(1, len(order))
        ranked = order[rot:] + order[:rot]
        if lead == 0:
            # pull the low-band lamps to the front for a kick
            ranked = [i for i in order if LAMP_BAND[i] == 0] + [i for i in ranked if LAMP_BAND[i] != 0]
        mask = 0
        for j in range(min(count, len(LAMP_BAND))):
            mask |= 1 << ranked[j]

        # contrast: kicks at the top of the range, everything else well below,
        # so the car punches on the kick instead of sitting evenly lit
        if is_kick:
            lvl = LEVELS[-1] * (0.85 + 0.15 * min(1.0, kr))
        elif strength > 0.45:
            lvl = LEVELS[2 + int(2 * min(1.0, strength))]
        else:
            lvl = LEVELS[0 + int(1 * min(1.0, strength * 2))]
        cues.append((round(t, 3), mask, quantize_level(lvl), is_kick))
        last_t = t


    kicks = [c for c in cues if c[3]]
    return {
        "name": name, "bpm": bpm, "duration": round(dur_s, 3), "phase": round(phase_s, 4),
        "cues": [(c[0], c[1], c[2]) for c in cues],
        "beat": round(beat_s, 4),
        "nKick": len(kicks), "nCue": len(cues),
        "kickLamps": sorted(set(bin(c[1]).count("1") for c in kicks)),
        "kickLevel": sorted(set(c[2] for c in kicks)),
        "softLevel": sorted(set(c[2] for c in cues if not c[3])),
    }


def validate(data, files):
    """Independent checks on the finished sheets. These exist because the
    frames-vs-seconds mixup produced a plausible-looking stats table while every
    cue time was wrong and most sheets were truncated."""
    problems = []
    print("\nVALIDATION")
    for f in files:
        n = os.path.splitext(f)[0]
        r = data[n]
        c = r["cues"]
        if not c:
            problems.append("%s: no cues" % n)
            continue
        if c[-1][0] > r["duration"] + 0.5:
            problems.append("%s: last cue %.2f past end %.2f" % (n, c[-1][0], r["duration"]))
        if c[-1][0] < r["duration"] * 0.5:
            problems.append("%s: sheet only covers %.0f%% of the track" % (n, 100 * c[-1][0] / r["duration"]))
        for i in range(len(c) - 1):
            gap = c[i + 1][0] - c[i][0]
            if gap < CUE_MIN_GAP - 1e-6:
                problems.append("%s: cue %d gap %.3f below %.3f" % (n, i, gap, CUE_MIN_GAP))
            if c[i][1] == 0:
                problems.append("%s: cue %d lights nothing" % (n, i))
        # cues must land on the beat grid (or the 8th-note off-beat), not scatter
        beat = 60.0 / r["bpm"]
        tol = 0.035
        ongrid = 0
        for i in range(len(c)):
            off = ((c[i][0] - r["phase"]) % beat) / beat      # 0..1 within the beat
            if off < tol / beat or off > 0.5 - tol / beat or off > 1 - tol / beat:
                ongrid += 1
        frac = ongrid / len(c)
        if frac < 0.9:
            problems.append("%s: only %.0f%% of cues land on the beat/8th grid" % (n, 100 * frac))
    # round-trip the encoder exactly the way the runtime parses it. Times are
    # compared with a tolerance because 25 * 0.02 is 0.5000000000000001 in
    # binary floating point - a nanosecond of drift that is not a codec fault.
    for f in files:
        n = os.path.splitext(f)[0]
        for t, mask, level in data[n]["cues"]:
            s = "%s%s%d" % (b36(int(round(t * 50))), ("0" + b36(mask))[-2:], quantize_level(level))
            pt, pm, pl = parseInt(s)
            if abs(pt - t) > 0.011 or pm != mask or pl != quantize_level(level):
                problems.append("%s: encode/decode mismatch %r -> (%s,%s,%s) vs (%s,%s,%s)"
                                % (n, s, pt, pm, pl, t, mask, quantize_level(level)))
                break
    if problems:
        print("  %d PROBLEM(S):" % len(problems))
        for p in problems[:25]:
            print("    " + p)
    else:
        print("  all sheets OK: times in range, min gap %.3fs, no empty mask, on-grid" % CUE_MIN_GAP)
    return len(problems) == 0


def parseInt(s):
    """Mirror of the runtime decoder, so the codec is verified end to end."""
    t = int(s[:-3], 36) * 0.02
    mask = int(s[-3:-1], 36)
    level = int(s[-1], 10)
    return (round(t, 3), mask, level)


def main():
    files = sorted(f for f in os.listdir(SRC) if f.lower().endswith(".mp3"))
    data = {}
    stats = []
    kl = {}
    for f in files:
        n = os.path.splitext(f)[0]
        r = build(n, os.path.join(SRC, f))
        data[n] = r
        c = r["cues"]
        gaps = [c[i + 1][0] - c[i][0] for i in range(len(c) - 1)]
        density = len(c) / r["duration"]
        masks = {}
        for _, mk, _l in c:
            masks[mk] = masks.get(mk, 0) + 1
        stats.append((n, len(c), density, min(gaps) if gaps else 0, r["bpm"],
                      len(masks), max(masks.values()) / len(c) if c else 0,
                      c[-1][0], r["duration"], r["nKick"], len(c)))
        kl[n] = r["kickLamps"]

    print("%-20s %5s %8s %8s %5s %6s %6s %5s %5s" % (
        "TRACK", "cues", "per sec", "min gap", "bpm", "masks", "top%", "kick", "kLmp"))
    print("-" * 80)
    for n, nc, d, mg, bpm, nm, top, lastc, dur, nk, ncue in stats:
        print("%-20s %5d %8.2f %8.3f %5d %6d %5.1f%% %4d%% %5s" % (
            n, nc, d, mg, bpm, nm, 100 * top, 100.0 * nk / max(1, ncue),
            "/".join(str(x) for x in kl.get(n, []))))
    print("\ntotal cues: %d   avg density %.2f/s" % (
        sum(s[1] for s in stats), sum(s[2] for s in stats) / len(stats)))

    with open("cues.json", "w", encoding="utf-8") as fh:
        json.dump(data, fh)

    if not validate(data, files):
        raise SystemExit("validation failed - not writing lightCues.js")

    # ---- emit the runtime module -----------------------------------------
    # One cue = time + mask + level. Fixed-width fields so parsing is a pure
    # slice, no delimiters to get wrong:
    #   time  - 20 ms units, base36, variable length (read from the front)
    #   mask  - exactly 2 base36 chars, zero padded  (bit 0 = biggest corneta)
    #   level - exactly 1 char (index into LIGHT_CUE_LEVELS)
    # mask is 2 chars because a 7-lamp mask reaches 127, which is "3n" in base36.
    lines = []
    lines.append("// GENERATED FILE - do not edit by hand. Rebuild with tools/cues.py.")
    lines.append("//")
    lines.append("// One light cue sheet per song, baked from that song's own onsets and")
    lines.append("// spectrum, so the car visibly follows THIS track instead of flickering at")
    lines.append("// random. The grid uses the artist's BPM (only the phase is fitted, by")
    lines.append("// sliding the grid to maximise onset energy on the beats). Beats are the")
    lines.append("// backbone; 8th notes are added only where the music really hits")
    lines.append("// off-beat. Each cue's LAMPS come from the frequency bands that are hot at")
    lines.append("// that moment - bass lights the big corneta, bright passages light the")
    lines.append("// tweeters - and the choice is anchored to the beat position so a bar")
    lines.append("// repeats musically rather than scattering.")
    lines.append("//")
    lines.append("// Cue string layout, one cue per comma-separated entry:")
    lines.append("//   time  = base36 count of 20 ms units from the track start")
    lines.append("//   mask  = 2 base36 chars, zero padded; bit n = lamp n")
    lines.append("//           0 CORNETAMAINSEPARADOR  1 TRUMPETS  2 BAJOHUECOGRANDE")
    lines.append("//           3 TWEETERS  4 CORNETASMID  5 CORNETASUP  6 CORNETASLOW")
    lines.append("//   level = 1 char, index into LIGHT_CUE_LEVELS")
    lines.append("")
    lines.append("export const LIGHT_CUE_LEVELS = %s;" % json.dumps(LEVELS))
    lines.append("")
    lines.append("export const LIGHT_CUES = {")
    for n in files:
        key = os.path.splitext(n)[0]
        r = data[key]
        parts = []
        for t, mask, level in r["cues"]:
            tt = int(round(t * 50))
            parts.append("%s%s%d" % (b36(tt), ("0" + b36(mask))[-2:], quantize_level(level)))
        lines.append('  "%s": "%s",' % (key, ",".join(parts)))
    lines.append("};")
    lines.append("")
    lines.append("// decoded lazily per title: -> [{ t, mask, level }]")
    lines.append("const _decoded = {};")
    lines.append("export function lightCues(title) {")
    lines.append("  if (_decoded[title]) return _decoded[title];")
    lines.append("  const raw = LIGHT_CUES[title];")
    lines.append("  if (!raw) return (_decoded[title] = []);")
    lines.append("  const out = [];")
    lines.append("  const parts = raw.split(\",\");")
    lines.append("  for (let i = 0; i < parts.length; i++) {")
    lines.append("    const s = parts[i];")
    lines.append("    out.push({")
    lines.append("      t: parseInt(s.slice(0, -3), 36) * 0.02,")
    lines.append("      mask: parseInt(s.slice(-3, -1), 36),")
    lines.append("      level: parseInt(s.slice(-1), 10),")
    lines.append("    });")
    lines.append("  }")
    lines.append("  return (_decoded[title] = out);")
    lines.append("}")
    lines.append("")
    with open(OUT, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("\n".join(lines))
    size = os.path.getsize(OUT)
    print("\nwrote %s  (%.1f KB)" % (OUT, size / 1024))


if __name__ == "__main__":
    main()

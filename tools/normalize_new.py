"""Normalise the newly added mp3s to the playlist reference (LA NOCHE FATAL).

IMPORTANT, and different from the original ogg->mp3 pass: these files arrive
already as mp3, so correcting them costs ONE ADDITIONAL LOSSY GENERATION. There
is no way around that for the clipping: several of them measure above 0 dBTP
(ELECTROLUX +2.1, PAPITO +2.1), which is distortion already baked into the
samples, so it has to be re-encoded rather than fixed with a runtime gain.

To keep that generation as small as possible this does a SINGLE encode pass
with the measured gain plus a look-ahead true-peak limit, then measures the
result and reports the residual. It deliberately does NOT iterate to hit the
target exactly (the original converter did, because it was decoding from a
lossless-ish source; iterating here would stack four or five generations for no
audible gain).

Originals are left untouched: --apply only writes the corrected files, and it
keeps a .orig copy.
"""
import json
import os
import shutil
import sys
import warnings

import lameenc
import numpy as np
import soundfile as sf
from scipy.ndimage import maximum_filter1d, minimum_filter1d
from scipy.signal import resample_poly

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lufs import integrated_lufs, true_peak_dbtp

warnings.filterwarnings("ignore")

SRC = r"W:\Users\gov\projects\PORTFOLIO2\media\MUSIC\mp3"
REFERENCE = "LA NOCHE FATAL"
BITRATE_KBPS = 192
CEILING_DBTP = -1.0
L1_THRESHOLD = 0.5      # only touch a file this far from the reference
APPLY = "--apply" in sys.argv


def limit_peak(x, fs, ceiling_db=CEILING_DBTP, lookahead_ms=5.0, os_factor=4):
    """Stereo-linked look-ahead limiter that holds TRUE peak.

    Two things this has to get right, both found by measuring the output rather
    than trusting the code:

    1. The gain must be the MINIMUM required across the look-ahead window, not
       an average. Averaging pulls the gain down only slightly for a single loud
       peak, so the output still overshoots.
    2. The control envelope has to come from the 4x OVERSAMPLED signal. A
       sample-peak limiter cannot see inter-sample peaks: MUCHACHITA carries
       +1.09 dB of them (bright content), so limiting samples left it at
       +0.53 dBTP. Folding the oversampled gain back by taking the minimum over
       each os_factor group makes the ceiling hold on the reconstructed
       waveform, which is what a listener's DAC actually reproduces.
    """
    ceiling = 10.0 ** (ceiling_db / 20.0)
    up = resample_poly(x, os_factor, 1, axis=0)
    peak_up = np.max(np.abs(up), axis=1)
    la_up = max(1, int(lookahead_ms * 1e-3 * fs * os_factor))
    fwd = maximum_filter1d(peak_up, size=2 * la_up + 1, mode="nearest")
    need = np.ones_like(fwd)
    over = fwd > ceiling
    need[over] = ceiling / fwd[over]
    gain_up = minimum_filter1d(need, size=2 * la_up + 1, mode="nearest")

    n = len(x)
    m = (len(gain_up) // os_factor) * os_factor
    gain = gain_up[:m].reshape(-1, os_factor).min(axis=1)
    if len(gain) < n:
        tail = gain[-1] if len(gain) else 1.0
        gain = np.concatenate([gain, np.full(n - len(gain), tail)])
    gain = np.minimum(gain, 1.0)[:n]
    return x * gain[:, None], 20.0 * np.log10(max(gain.min(), 1e-9))


def encode_mp3(x, fs, kbps):
    pcm = np.clip(np.round(x * 32767.0), -32768, 32767).astype(np.int16)
    enc = lameenc.Encoder()
    enc.set_in_sample_rate(fs)
    enc.set_channels(x.shape[1])
    enc.set_bit_rate(kbps)
    return bytes(enc.encode(np.ascontiguousarray(pcm).tobytes()) + enc.flush())


def main():
    ref_x, ref_fs = sf.read(os.path.join(SRC, REFERENCE + ".mp3"), always_2d=True)
    ref_lufs = integrated_lufs(ref_x, ref_fs)
    print("reference '%s' = %.2f LUFS   ceiling %.1f dBTP   %d kbps CBR"
          % (REFERENCE, ref_lufs, CEILING_DBTP, BITRATE_KBPS))
    print("mode: %s\n" % ("WRITE" if APPLY else "dry run (pass --apply to write)"))

    rows = []
    for f in sorted(os.listdir(SRC)):
        if not f.lower().endswith(".mp3"):
            continue
        n = os.path.splitext(f)[0]
        if n == REFERENCE:
            continue
        path = os.path.join(SRC, f)
        x, fs = sf.read(path, always_2d=True)
        lufs = integrated_lufs(x, fs)
        tp = true_peak_dbtp(x, fs)
        d = lufs - ref_lufs
        clipping = tp > 0.0
        if abs(d) <= L1_THRESHOLD and not clipping:
            print("%-20s %7.2f LUFS (%+.2f)  TP %6.2f  OK - untouched" % (n, lufs, d, tp))
            continue

        y = x * (10.0 ** (-d / 20.0))
        y, lim_db = limit_peak(y, fs)
        mp3 = encode_mp3(y, fs, BITRATE_KBPS)

        import io
        z, zfs = sf.read(io.BytesIO(mp3), always_2d=True)
        out_lufs = integrated_lufs(z, zfs)
        out_tp = true_peak_dbtp(z, zfs)

        note = []
        if clipping:
            note.append("was CLIPPING at %+.2f dBTP" % tp)
        rows.append((n, lufs, d, tp, out_lufs, out_lufs - ref_lufs, out_tp, lim_db, len(mp3) / 1024.0, "; ".join(note)))
        print("%-20s %7.2f LUFS (%+.2f)  TP %6.2f  ->  %7.2f LUFS (%+.2f)  TP %6.2f  gain %+.2f dB  lim %.2f dB  %s"
              % (n, lufs, d, tp, out_lufs, out_lufs - ref_lufs, out_tp, -d, lim_db,
                 ("; ".join(note)) or "loudness only"))

        if APPLY:
            bak = path + ".orig"
            if not os.path.exists(bak):
                shutil.copy2(path, bak)
            with open(path, "wb") as fh:
                fh.write(mp3)

    if rows:
        print("\n%d file(s) need correction" % len(rows))
        errs = [abs(r[5]) for r in rows]
        tps = [r[6] for r in rows]
        print("  residual loudness error vs reference: max %.2f LU (one generation, not iterated)" % max(errs))
        # The limiter holds -1.0 dBTP on the signal handed to the encoder; the
        # lossy encode then reconstructs a waveform up to ~0.4 dB hotter. The
        # requirement is that nothing clips, so the check is against 0 dBTP.
        print("  highest delivered true peak: %.2f dBTP - nothing clips: %s (headroom kept for codec overshoot)"
              % (max(tps), all(t < 0.0 for t in tps)))
        if APPLY:
            print("  originals preserved as <name>.mp3.orig")
    else:
        print("nothing to correct")


if __name__ == "__main__":
    main()

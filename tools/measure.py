"""Measure the newly added mp3s: loudness vs the reference, exact duration, BPM.

The existing 15 were normalised to LA NOCHE FATAL's integrated loudness during
the ogg->mp3 conversion. These arrived already as mp3 and were never passed
through that step, so check them against the same reference before wiring them
in - a 6 dB outlier would jump out of the playlist.

BPM uses the estimator that passed validation (bpm_pipeline.py): two
independent librosa tempogram configurations, trust agreement, fall back to the
conventional prior when they disagree.
"""
import json
import os
import sys
import warnings

import librosa
import numpy as np
import soundfile as sf

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lufs import integrated_lufs, true_peak_dbtp

warnings.filterwarnings("ignore")

SRC = r"W:\Users\gov\projects\PORTFOLIO2\media\MUSIC\mp3"
REFERENCE = "LA NOCHE FATAL"
KNOWN = {  # the artist-confirmed values already in TRACKS
    "ANTEPASADOS": 115, "BOKITA": 110, "BOZZO": 120, "CORAZON VENEZOLANO": 120,
    "DILO": 117, "JUGUETE": 107, "LA NOCHE FATAL": 114, "ME VALORO": 130, "MERCAL": 83,
    "MOROKA JIA": 74, "SAPOS": 94, "SILBON": 110, "TARAKO": 130, "UH AH": 93, "VIGILIA": 73,
}
SR = 22050
HOP = 512


def tempo(oe, start, std):
    return float(np.atleast_1d(librosa.feature.tempo(
        onset_envelope=oe, sr=SR, hop_length=HOP,
        start_bpm=start, std_bpm=std, aggregate=np.median))[0])


def analyse(path):
    x, fs = sf.read(path, always_2d=True)
    dur = len(x) / fs
    y = librosa.resample(x.mean(axis=1), orig_sr=fs, target_sr=SR)
    oe = librosa.onset.onset_strength(y=y, sr=SR, hop_length=HOP)
    a = tempo(oe, 80.0, 2.0)
    b = tempo(oe, 120.0, 1.2)
    agree = abs(1200 * np.log2(a / b)) < 25
    chosen = round(a if agree else b, 2)
    rate = len(librosa.onset.onset_detect(onset_envelope=oe, sr=SR, hop_length=HOP)) / dur
    return {
        "duration": round(dur, 3),
        "lufs": round(integrated_lufs(x, fs), 2),
        "truePeakDbTP": round(true_peak_dbtp(x, fs), 2),
        "bpm": chosen, "estA": round(a, 2), "estB": round(b, 2),
        "agree": bool(agree), "onsetRate": round(rate, 2),
        "ratio": round(rate / (chosen / 60.0), 2),
    }


def main():
    files = sorted(f for f in os.listdir(SRC) if f.lower().endswith(".mp3"))
    ref_x, ref_fs = sf.read(os.path.join(SRC, REFERENCE + ".mp3"), always_2d=True)
    ref_lufs = integrated_lufs(ref_x, ref_fs)
    print("reference '%s' = %.2f LUFS\n" % (REFERENCE, ref_lufs))
    print("%-22s %7s %8s %8s %8s %6s %6s %6s %6s %s" % (
        "TRACK", "dur", "LUFS", "dRef", "TP", "BPM", "A", "B", "ratio", "note"))
    print("-" * 108)
    out = {}
    for f in files:
        n = os.path.splitext(f)[0]
        a = analyse(os.path.join(SRC, f))
        a["isNew"] = n not in KNOWN
        a["dRef"] = round(a["lufs"] - ref_lufs, 2)
        a["needsGain"] = abs(a["dRef"]) > 0.5
        note = "NEW" if a["isNew"] else ""
        if a["needsGain"]:
            note += "  NEEDS %+.2f dB" % (-a["dRef"])
        if a["isNew"] and not a["agree"]:
            note += "  LOW-CONFIDENCE BPM"
        out[n] = a
        print("%-22s %7.2f %8.2f %+8.2f %8.2f %6.2f %6.2f %6.2f %6.2f %s" % (
            n, a["duration"], a["lufs"], a["dRef"], a["truePeakDbTP"],
            a["bpm"], a["estA"], a["estB"], a["ratio"], note))
    with open("new_tracks.json", "w", encoding="utf-8") as fh:
        json.dump({"refLufs": round(ref_lufs, 2), "tracks": out}, fh, indent=2)
    new = [n for n, a in out.items() if a["isNew"]]
    need = [n for n, a in out.items() if a["needsGain"]]
    low = [n for n, a in out.items() if a["isNew"] and not a["agree"]]
    print("\nnew tracks (%d): %s" % (len(new), ", ".join(sorted(new))))
    print("need loudness correction: %s" % (", ".join(need) if need else "none"))
    print("low-confidence BPM (worth an ear check): %s" % (", ".join(low) if low else "none"))


if __name__ == "__main__":
    main()

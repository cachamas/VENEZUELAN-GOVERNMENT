"""Experiment: what kick tuning suits MOROKA JIA?

It is 74 BPM with its weight in the low-mids, so the default 30-120 Hz window
finds few kicks (14% of cues). This sweeps a few (band, min, dominance) settings
for that track only and reports what each does to the kick share, the cue
density and the lamp variety, so the choice is made on numbers rather than
guesswork. Run cues.py afterwards to bake whichever row wins.
"""
import os
import sys
import warnings

import numpy as np
import soundfile as sf

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cues as C

warnings.filterwarnings("ignore")

TRACK = "MOROKA JIA"

OFFBEAT_GAIN_OVERRIDE = {
    "MOROKA JIA": 1.05,
}
MIN_GAP_OVERRIDE = {
    "MOROKA JIA": 0.11,
}


# (label, band, min, dominance)
VARIANTS = [
    ("default (30-120, 0.34, 1.15)", None, None, None, None, None),
    ("A low-mid only (30-280)", (30, 280), 0.20, 0.85, None, None),
    ("B low-mid + 8th accents", (30, 280), 0.20, 0.85, 1.20, None),
    ("C low-mid + 8th + tighter gap", (30, 280), 0.20, 0.85, 1.10, 0.11),
    ("D wider band (30-400) + 8th", (30, 400), 0.18, 0.75, 1.10, 0.11),
    ("E full low (30-900) + 8th", (30, 900), 0.15, 0.70, 1.10, 0.11),
    ("F max drive (30-900, easy)", (30, 900), 0.10, 0.60, 1.02, 0.10),
]


def run(label, band, kmin, kdom, obg, mgap):
    dicts = (C.KICK_BAND_OVERRIDE, C.KICK_MIN_OVERRIDE, C.KICK_DOM_OVERRIDE,
             C.OFFBEAT_GAIN_OVERRIDE, C.MIN_GAP_OVERRIDE)
    saved = [dict(d) for d in dicts]
    for d in dicts:
        d.pop(TRACK, None)
    if band:
        C.KICK_BAND_OVERRIDE[TRACK] = band
        C.KICK_MIN_OVERRIDE[TRACK] = kmin
        C.KICK_DOM_OVERRIDE[TRACK] = kdom
    if obg:
        C.OFFBEAT_GAIN_OVERRIDE[TRACK] = obg
    if mgap:
        C.MIN_GAP_OVERRIDE[TRACK] = mgap
    try:
        r = C.build(TRACK, os.path.join(C.SRC, TRACK + ".mp3"))
    finally:
        for d, s in zip(dicts, saved):
            d.clear(); d.update(s)
    c = r["cues"]
    n = len(c)
    gap = min((c[i + 1][0] - c[i][0]) for i in range(n - 1)) if n > 1 else 0
    return {
        "label": label, "cues": n, "perSec": n / r["duration"],
        "kickPct": 100.0 * r["nKick"] / max(1, n),
        "masks": len(set(m for _, m, _ in c)), "minGap": gap,
    }


def main():
    print("MOROKA JIA  (%.1fs, %d BPM)\n" % (C.build(TRACK, os.path.join(C.SRC, TRACK + ".mp3"))["duration"],
                                            C.BPM[TRACK]))
    print("%-32s %6s %8s %7s %7s %9s" % ("variant", "cues", "per sec", "kick%", "masks", "min gap"))
    print("-" * 76)
    for label, band, kmin, kdom, obg, mgap in VARIANTS:
        s = run(label, band, kmin, kdom, obg, mgap)
        print("%-32s %6d %8.2f %6.0f%% %7d %8.3fs" % (
            s["label"], s["cues"], s["perSec"], s["kickPct"], s["masks"], s["minGap"]))


if __name__ == "__main__":
    main()

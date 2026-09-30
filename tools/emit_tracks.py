"""Emit the TRACKS table and the cues.py BPM table from the actual mp3 files.

Durations are read back from the delivered files rather than typed by hand, so
they cannot drift from what the player will actually see. BPM comes from the
artist for the tracks they confirmed, and from tools/measure.py for the new
ones - the uncertain ones are listed so they can be checked.
"""
import os
import sys
import warnings

import soundfile as sf

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lufs import integrated_lufs

warnings.filterwarnings("ignore")

SRC = r"W:\Users\gov\projects\PORTFOLIO2\media\MUSIC\mp3"

# artist-confirmed
ARTIST_BPM = {
    "ANTEPASADOS": 115, "BOKITA": 110, "BOZZO": 120, "CORAZON VENEZOLANO": 120,
    "DILO": 117, "JUGUETE": 107, "LA NOCHE FATAL": 114, "ME VALORO": 130, "MERCAL": 83,
    "MOROKA JIA": 74, "SAPOS": 94, "SILBON": 110, "TARAKO": 130, "UH AH": 93, "VIGILIA": 73,
}
# measured for the new tracks. `conf` low = the two tempogram configs disagreed
# by an octave, so the value is a guess worth checking by ear.
NEW_BPM = {
    "AMAN":         (152.00, "high"),
    "ELECTROLUX":   (143.55, "high"),
    "PERDONALOS":   (129.20, "high"),
    "INTERVENIR":   (112.35, "low"),
    "PAPITO":       (123.05, "low"),
    "MUCHACHITA":   (136.00, "low"),
    # onset rate implies ~1.4 onsets per beat at 184, which is not credible for
    # this material; half tempo lands it at 2.7, so the slower value is used
    "MANTEQUILLA":  (92.29,  "low"),
}


def main():
    files = sorted(f for f in os.listdir(SRC) if f.lower().endswith(".mp3"))
    names = [os.path.splitext(f)[0] for f in files]
    missing = [n for n in names if n not in ARTIST_BPM and n not in NEW_BPM]
    if missing:
        raise SystemExit("no BPM for: %s" % ", ".join(missing))

    ref = integrated_lufs(*sf.read(os.path.join(SRC, "LA NOCHE FATAL.mp3"), always_2d=True))

    print("const TRACKS = [")
    rows = []
    for n in names:
        info = sf.info(os.path.join(SRC, n + ".mp3"))
        dur = round(info.duration, 3)
        if n in ARTIST_BPM:
            bpm, conf = ARTIST_BPM[n], "artist"
        else:
            bpm, conf = NEW_BPM[n]
        bs = ("%d" % bpm) if float(bpm) == int(bpm) else ("%g" % bpm)
        rows.append((n, dur, bpm, conf))
        # align on the longest title so the columns line up
        pad = " " * max(1, 20 - len('"%s",' % n))
        print('  { title: %-21s artist: MUSIC_ARTIST, src: MUSIC_DIR + "%s.mp3",%s duration: %s, bpm: %s },%s'
              % ('"%s",' % n, n, pad, dur, bs, "   // " + conf if conf != "artist" else ""))
    print("];")
    print("\n// %d tracks" % len(names))

    print("\n--- tools/cues.py BPM dict ---")
    print("BPM = {")
    for n, dur, bpm, conf in rows:
        print('    "%s": %s,%s' % (n, bpm, "   # %s" % conf if conf != "artist" else ""))
    print("}")

    print("\n--- low-confidence BPMs worth checking by ear ---")
    for n, dur, bpm, conf in rows:
        if conf == "low":
            print("  %-16s %s" % (n, bpm))
    print("\nreference loudness: %.2f LUFS" % ref)


if __name__ == "__main__":
    main()

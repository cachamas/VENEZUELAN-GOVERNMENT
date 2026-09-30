"""
Convert a video into a 1-bit dot-matrix clip in the exact format the ATM and
radio displays consume.

THE FORMAT (reverse-engineered from js/videos/*.js + js/mainDisplay.js)
---------------------------------------------------------------------
A module exports an object:

    export const nameVideoData = {
      fps: 12, w: 172, h: 132, frames: 240, bytes: 2838,
      blob: Uint8Array.from(atob("...."), function (c) { return c.charCodeAt(0); }),
    };

* w * h / 8 bytes per frame, so w MUST be a multiple of 8.
* Packing is row-major, left-to-right, top-to-bottom, MSB first. From
  mainDisplay.js drawVideoFrame():

      led[i] = (blob[off + (i >> 3)] >> (7 - (i & 7))) & 1;
      led[r * COLS + c] = ...

  so linear index i = r*COLS + c, byte i>>3, bit 7-(i&7).
* 1 = lit dot. The renderer paints white dots and leaves everything else fully
  transparent, so the source must be reduced to pure black/white first.
* Shipped panels are 172x132 (ATM + hover) and 120x24 (radio), both 12 fps.

THRESHOLDING
------------
Hard thresholding is right for the graphic clips the panels normally show, and
wrong for photographic footage: no hard edges means a muddy result that
flickers as fine detail crosses the cutoff. For live action use --dither, which
distributes the error and reads far better at 1 bit per pixel.

Usage
-----
  python tools/video_to_dotmatrix.py SRC.mp4 --out js/videos/loading.js \\
      --name loading --width 144 --height 144 --fps 12 --seconds 4 \\
      --dither --preview out/preview.png
"""
import argparse
import base64
import math
import os
import subprocess
import sys

import numpy as np
from PIL import Image
from scipy import ndimage

# Bayer 8x8 ordered-dither matrix, normalised to 0..1. Ordered (not random)
# dithering keeps the pattern stable frame to frame, so it does not add
# temporal noise on top of the motion.
BAYER8 = np.array([
    [0, 32, 8, 40, 2, 34, 10, 42],
    [48, 16, 56, 24, 50, 18, 58, 26],
    [12, 44, 4, 36, 14, 46, 6, 38],
    [60, 28, 52, 20, 62, 30, 54, 22],
    [3, 35, 11, 43, 1, 33, 9, 41],
    [51, 19, 59, 27, 49, 17, 57, 25],
    [15, 47, 7, 39, 13, 45, 5, 37],
    [63, 31, 55, 23, 61, 29, 53, 21],
], dtype=np.float64) / 64.0


def read_gray_frames(path, width, height, fps, seconds, start=0.0):
    """Decode to raw 8-bit grayscale frames at the target size.

    Aspect handling is 'fit': the frame is scaled to COVER the target and then
    centre-cropped, so a square source into a square panel fills it edge to
    edge with no letterbox bars wasting dot rows.
    """
    w, h = width, height
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", path],
        capture_output=True, text=True, check=True)
    sw, sh = (int(v) for v in out.stdout.strip().split("x")[:2])
    src_aspect = sw / sh

    # cover: scale so the smaller dimension matches, then centre-crop
    if src_aspect > w / h:
        scale_h, scale_w = h, int(round(sw * h / sh))
    else:
        scale_w, scale_h = w, int(round(sh * w / sw))
    if (scale_w, scale_h) == (sw, sh):
        vf = "fps=%d" % fps
    else:
        vf = "fps=%d,scale=%d:%d" % (fps, scale_w, scale_h)

    # One trim with an explicit end, then RESET the timestamps.
    # Two traps here, both of which silently yield the wrong number of frames
    # rather than an error:
    #   * chaining a second trim=0:N does not work - trim leaves the original
    #     timestamps alone, so a following trim=0:3 discards everything when
    #     start > 0;
    #   * a trimmed stream still carries absolute PTS, and the fps filter then
    #     emits frames for the whole remaining span. Without the setpts reset,
    #     --start 6 --seconds 3 returned 108 frames (9s) instead of 36.
    if start or seconds:
        end = (start + seconds) if seconds else None
        spec = "start=%g" % start
        if end is not None:
            spec += ":end=%g" % end
        vf = "trim=%s,setpts=PTS-STARTPTS," % spec + vf

    cmd = ["ffmpeg", "-v", "error", "-i", path, "-vf", vf,
           "-pix_fmt", "gray", "-f", "rawvideo", "-"]
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout

    stride = scale_w * scale_h
    if stride == 0:
        raise SystemExit("ffmpeg produced no frames")
    n = len(raw) // stride
    if n == 0:
        raise SystemExit(
            "ffmpeg decoded 0 frames at %g..%gs. Check --start/--seconds against "
            "the source duration (ffprobe the file)." % (start, start + (seconds or 0)))
    frames = np.frombuffer(raw[:n * stride], dtype=np.uint8)
    frames = frames.reshape(n, scale_h, scale_w)

    x0 = max(0, (scale_w - w) // 2)
    y0 = max(0, (scale_h - h) // 2)
    return frames[:, y0:y0 + h, x0:x0 + w]


def _box(f, k):
    if k <= 1:
        return f
    pad = k // 2
    fp = np.pad(f, ((0, 0), (pad, pad), (pad, pad)), mode="edge")
    csum = fp.cumsum(axis=1).cumsum(axis=2)
    csum = np.pad(csum, ((0, 0), (1, 0), (1, 0)), mode="constant")
    h, w = f.shape[1], f.shape[2]
    return (csum[:, k:, k:] - csum[:, :-k, k:] - csum[:, k:, :-k]
            + csum[:, :-k, :-k]) / (k * k)


def _local_contrast(f, k=25, target_mean=110.0, target_std=52.0):
    """Flatten local brightness so a blown sky stops swallowing the frame."""
    m = _box(f, k)
    m2 = _box(f * f, k)
    sd = np.sqrt(np.maximum(m2 - m * m, 0.0)) + 1e-6
    return np.clip((f - m) / sd * target_std + target_mean, 0, 255)


def _sobel(f):
    gx = ndimage.sobel(f, axis=2, mode="nearest")
    gy = ndimage.sobel(f, axis=1, mode="nearest")
    return np.sqrt(gx * gx + gy * gy)


THRESHOLD_MODES = ("fixed", "dither")


def binarise(frames, mode, threshold, invert, blur, edge_pct=88.0):
    """frames: uint8 (n,h,w) luma -> bool (n,h,w) True = dot lit.

    'fixed' is the mode the shipped clips use. Decoding the existing modules
    (js/videos/hovAbout.js and friends) and histogramming the lit fraction of
    every 8x8 block gives a sharply bimodal distribution with almost nothing in
    between: solid-dark and solid-light, i.e. a hard cutoff, NOT ordered
    dithering and NOT edge detection. Their mean density runs 21-63% lit.

    'edge' is kept for footage with no usable tonal separation, but it is NOT
    what this project does and does not match the panels.
    """
    f = frames.astype(np.float64)
    if blur:
        # A light box smooth reduces per-frame edge noise, which is most of what
        # makes a 1-bit conversion of live action crawl.
        f = _box(f, max(1, int(blur)))

    if mode == "fixed":
        t = 128.0 if threshold is None else threshold
        bits = f > t
    elif mode == "otsu":
        # one global threshold for the whole clip, so brightness does not pump
        # between frames (a per-frame threshold makes the whole panel flicker)
        hist, edges = np.histogram(f, bins=256, range=(0, 255))
        p = hist.astype(np.float64) / max(1, hist.sum())
        omega = np.cumsum(p)
        mu = np.cumsum(p * np.arange(256))
        mu_t = mu[-1]
        denom = omega * (1 - omega)
        with np.errstate(divide="ignore", invalid="ignore"):
            sigma = np.where(denom > 0, (mu_t * omega - mu) ** 2 / denom, 0)
        bits = f > edges[int(np.argmax(sigma)) + 1]
    elif mode == "dither":
        t = 128.0 if threshold is None else threshold
        tile = np.tile(BAYER8, (f.shape[1] // 8 + 2, f.shape[2] // 8 + 2))[:f.shape[1], :f.shape[2]]
        bits = f > (t - 24 + 48 * tile)
    elif mode == "edge":
        # The right mode for PHOTOGRAPHIC footage. Thresholding live action
        # gives blown-out white masses and an unreadable subject, because there
        # are no hard edges for one bit to catch. Lighting the dots on the
        # gradient instead turns the frame into a line drawing that actually
        # reads as a picture, and it is also far sparser, so it compresses.
        src = _local_contrast(f)
        mag = _sobel(src)
        pct = edge_pct if threshold is None else (100.0 - threshold)
        bits = mag > np.percentile(mag, pct)
        # Deliberately NO morphological opening here. A Sobel line is one pixel
        # wide, so a 2x2 opening deletes the entire drawing and leaves confetti.
        # Specks are handled by --blur on the way in instead.
    else:
        raise SystemExit("unknown mode %r" % mode)

    if invert:
        bits = ~bits
    return bits


def pack(bits):
    """(n,h,w) bool -> (n, h*w/8) uint8, row-major MSB first."""
    n, h, w = bits.shape
    assert w % 8 == 0, "width must be a multiple of 8"
    flat = bits.reshape(n, h * w).astype(np.uint8)
    return np.packbits(flat, axis=1, bitorder="big")


def emit_module(path, name, fps, w, h, frames_n, blob, comment, gen=""):
    b64 = base64.b64encode(blob).decode("ascii")
    chunks = [b64[i:i + 120] for i in range(0, len(b64), 120)]
    body = "\n".join('  "%s" +' % c for c in chunks[:-1]) + '\n  "%s"' % chunks[-1]
    text = (
        "// %s\n"
        "// Generated by tools/video_to_dotmatrix.py - do not edit by hand.\n"
        "// 1-bit dot-matrix clip: %dx%d, %d fps, %d frames, %d B/frame.\n"
        "// Packed row-major, MSB first, to match drawVideoFrame() in\n"
        "// js/mainDisplay.js. 1 = lit dot.\n"
        "%s"
        "export const %sVideoData = {\n"
        "  fps: %d,\n"
        "  w: %d, h: %d, frames: %d, bytes: %d,\n"
        "  blob: Uint8Array.from(atob(\n%s), function (c) { return c.charCodeAt(0); }),\n"
        "};\n"
    ) % (comment, w, h, fps, frames_n, w * h // 8, gen,
         name, fps, w, h, frames_n, w * h // 8, body)
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    return len(text)


def render_preview(bits, path, scale=3, on=(255, 255, 255), off=(0, 0, 0),
                   grid=True, labels=None, cell=1):
    """Composite a few frames exactly as the panel would: lit dots on a dark
    ground, with the cell grid, so the result can be eyeballed before shipping."""
    n = bits.shape[0]
    picks = [0, n // 4, n // 2, (3 * n) // 4, n - 1]
    picks = sorted(set(p for p in picks if 0 <= p < n))
    h, w = bits.shape[1], bits.shape[2]
    gap = 1 if grid else 0
    tw = (w * scale + gap) + 8
    th = (h * scale + gap) + 8
    sheet = Image.new("RGB", (tw * len(picks), th), off)
    for k, fi in enumerate(picks):
        b = bits[fi]
        img = np.zeros((h, w, 3), dtype=np.uint8)
        img[:] = off
        img[b] = on
        im = Image.fromarray(img).resize((w * scale, h * scale), Image.NEAREST)
        if grid:
            d = Image.new("RGB", (w * scale + gap, h * scale + gap), (26, 34, 60))
            d.paste(im, (0, 0))
            im = d
        sheet.paste(im, (k * tw + 4, 4))
    if labels:
        from PIL import ImageDraw
        d = ImageDraw.Draw(sheet)
        for k, fi in enumerate(picks):
            lbl = labels(k, fi, n)
            if lbl:
                d.text((k * tw + 6, th - 12), lbl, fill=(140, 150, 170))
    sheet.save(path)
    return path


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("src")
    ap.add_argument("--out", required=True, help="output .js module path")
    ap.add_argument("--name", required=True, help="export base name, e.g. loading")
    ap.add_argument("--width", type=int, default=144)
    ap.add_argument("--height", type=int, default=144)
    ap.add_argument("--fps", type=int, default=12)
    ap.add_argument("--seconds", type=float, default=4.0)
    ap.add_argument("--mode", choices=("fixed", "otsu", "dither", "edge"),
                    default="fixed",
                    help="fixed = the hard threshold the shipped panels use "
                         "(default). edge = gradient only, for footage with no "
                         "tonal separation; does NOT match the panels.")
    ap.add_argument("--threshold", type=float, default=None)
    ap.add_argument("--edge-pct", type=float, default=88.0,
                    help="edge mode: keep the strongest N%% of gradient "
                         "(lower = thinner lines, fewer dots)")
    ap.add_argument("--start", type=float, default=0.0, help="start offset, seconds")
    ap.add_argument("--invert", action="store_true")
    ap.add_argument("--blur", type=int, default=1, help="box smoothing kernel (1=off)")
    ap.add_argument("--comment", default="dot-matrix clip")
    ap.add_argument("--preview", default=None, help="write a preview contact sheet PNG")
    ap.add_argument("--preview-mode", default=None,
                    help="separate mode for the preview only, to compare looks")
    args = ap.parse_args()

    if args.width % 8:
        raise SystemExit("--width must be a multiple of 8 (packing is byte-aligned)")

    frames = read_gray_frames(args.src, args.width, args.height, args.fps,
                              args.seconds, args.start)
    bits = binarise(frames, args.mode, args.threshold, args.invert, args.blur,
                    args.edge_pct)
    n, h, w = bits.shape
    blob = pack(bits).tobytes()

    # The exact command line, so this clip can always be regenerated and so a
    # verifier can re-derive the pixels and compare them bit for bit. Arguments
    # containing spaces are quoted, which matters here because the default
    # source lives under "media/LOADING INTRO/".
    def _q(a):
        a = str(a)
        return '"%s"' % a if (" " in a or "\t" in a) else a

    gen = ("// gen: %s\n"
           % " ".join(_q(x) for x in
                      [os.path.basename(sys.argv[0])] + sys.argv[1:]))
    size = emit_module(args.out, args.name, args.fps, w, h, n, blob,
                       args.comment, gen)

    lit = bits.mean() * 100
    # temporal churn: how much the panel changes frame to frame. High churn on
    # photographic content is the flicker problem, so it is worth reporting.
    churn = float(np.abs(np.diff(bits.astype(np.int8), axis=0)).mean() * 100) if n > 1 else 0.0

    print("source      : %s  (from %.1fs)" % (args.src, args.start))
    print("panel       : %dx%d  %d fps  %d frames  (%.2fs)"
          % (w, h, args.fps, n, n / args.fps))
    print("mode        : %s" % args.mode)
    print("bytes/frame : %d" % (w * h // 8))
    print("packed      : %d B raw -> %d B base64 in the module"
          % (len(blob), size))
    print("lit dots    : %.1f%% of the panel" % lit)
    print("churn       : %.2f%% of pixels change per frame (flicker risk)" % churn)
    if size > 200 * 1024:
        wire = None
        try:
            import brotli
            wire = len(brotli.compress(open(args.out, "rb").read(), quality=5))
        except Exception:
            pass
        if wire is not None and wire > 90 * 1024:
            print("WARNING     : %d B brotli on the critical path. Cut --seconds," % wire)
            print("              --width/--height or --fps before shipping this.")
        else:
            print("note         : %d B on disk, %s on the wire after compression."
                  % (size, ("%d B" % wire) if wire else "unknown"))

    if args.preview:
        render_preview(bits, args.preview,
                       labels=lambda k, fi, tot: "frame %d/%d" % (fi, tot - 1))
        print("preview     : %s" % args.preview)
        if args.preview_mode and args.preview_mode != args.mode:
            b2 = binarise(frames, args.preview_mode, args.threshold, args.invert, args.blur)
            p2 = args.preview.replace(".png", "_%s.png" % args.preview_mode)
            render_preview(b2, p2, labels=lambda k, fi, tot: "%s  frame %d" % (args.preview_mode, fi))
            c2 = float(np.abs(np.diff(b2.astype(np.int8), axis=0)).mean() * 100) if n > 1 else 0
            print("preview     : %s  (%s, churn %.2f%%)" % (p2, args.preview_mode, c2))
    return 0


if __name__ == "__main__":
    sys.exit(main())

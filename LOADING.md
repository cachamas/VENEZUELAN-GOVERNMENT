# LOADING SCREEN + DOT-MATRIX SYSTEM

Reference for the initial-load screen and the 1-bit dot-matrix format it shares
with the ATM and radio displays. Written because the format is not obvious from
reading any one file, and because regenerating the clip is the one job here
that needs a tool rather than an editor.

---

## 1. The 1-bit dot-matrix format

A "clip" is one JS module in `js/videos/`. Every matrix on the site uses the
same shape:

```js
export const nameVideoData = {
  fps: 12,
  w: 172, h: 132, frames: 240, bytes: 2838,
  blob: Uint8Array.from(atob("...."), function (c) { return c.charCodeAt(0); }),
};
```

Rules, all of them load-bearing:

| rule | why |
|---|---|
| `bytes` is exactly `w * h / 8` | one bit per dot |
| `w` **must** be a multiple of 8 | packing is byte-aligned; an odd width silently corrupts every row after the first partial one |
| packing is **row-major, left-to-right, top-to-bottom, MSB first** | see below |
| `1` = lit dot | the renderer paints white and leaves everything else transparent |
| shipped panels are 172×132 (ATM, hover) and 120×24 (radio) | 12 fps throughout |

The bit order comes straight from `drawVideoFrame()` in `js/mainDisplay.js`:

```js
led[i] = (blob[off + (i >> 3)] >> (7 - (i & 7))) & 1;   // i = r * COLS + c
```

so linear index `i` is row-major, the byte is `i >> 3`, and the bit within it is
`7 - (i & 7)`. Get this backwards and the panel plays recognisable-but-wrong
noise, which is much harder to spot than an outright failure.

## 2. Converting a video into a clip

`tools/video_to_dotmatrix.py` is the tool. It is generated-output-only: never
hand-edit a module in `js/videos/`.

```powershell
python tools/video_to_dotmatrix.py SRC.mp4 --out js/videos/loading.js --name loading `
    --width 120 --height 120 --fps 12 --seconds 10 --mode fixed --threshold 120 --start 15
```

Useful flags:

| flag | notes |
|---|---|
| `--mode fixed` | **the default, and the one this project uses** — hard threshold |
| `--mode edge` | gradient only. Does **not** match the panels; only for footage with no usable tonal separation |
| `--threshold N` | the cutoff for `fixed`. The only knob that really matters |
| `--start N` / `--seconds N` | which slice of the source to take |
| `--blur N` | box smooth before thresholding; cuts per-frame speckle |
| `--preview out.png` | contact sheet, so you can look before shipping |
| `--preview-mode` | render a second sheet with a different mode, to compare |

### Why `fixed` and not dithering

This is worth stating because it is the mistake I made first. Decoding the
shipped modules and histogramming the lit fraction of every 8×8 block gives a
sharply **bimodal** distribution — solid-dark and solid-light with almost
nothing between:

```
hovAbout    52% solid-dark  20% solid-light  28% intermediate   mean lit 34.3%
hovContact  27% solid-dark  22% solid-light  50% intermediate   mean lit 49.3%
```

Ordered dithering would spread that across the middle. It does not. So the panels
are a hard cutoff, and so is this tool's default.

Their densities run **21–63% lit**. `verify_loading.py` asserts the loading clip
lands inside the band measured from the real modules, so a clip that would look
foreign on the same panel fails the check rather than shipping.

### Two traps in the ffmpeg pipeline

Both fail by returning the wrong number of frames, not by erroring:

- **Chained `trim` does not work.** `trim` leaves original timestamps alone, so
  `trim=start=6,trim=0:3` discards everything. Use one trim with an explicit end.
- **A trimmed stream still carries absolute PTS**, so a following `fps=` filter
  emits frames for the whole remaining span. `--start 6 --seconds 3` returns 108
  frames instead of 36 unless you add `setpts=PTS-STARTPTS` after the trim.

### Provenance

Each generated module records the exact command that made it:

```js
// gen: video_to_dotmatrix.py "media\LOADING INTRO\loading.mp4" --out ... --mode fixed --threshold 120 ...
```

`verify_loading.py` parses that line and re-derives the pixels to compare them
**bit-exact** against the shipped blob. If the clip is ever regenerated with
different settings, the check follows automatically instead of going stale.

---

## 3. The loading screen

`js/loadingScreen.js` + `index.html` + the `#loading` block in `css/style.css`.

Layout, inside a square blue plate on a black field:

```
NOT A GOVERNMENT WEBSITE      <- 5x7 LED, scaled to the clip's exact width
┌──────────────────────────┐
│                          │
│   dot-matrix clip        │ <- loops, in 1-bit
│                          │
└──────────────────────────┘
LOADING PORTFOLIO... - ...  <- 5x7 LED belt, scrolling left to right
```

### Decisions worth keeping

**It is a separate entry point.** `index.html` loads `js/loadingScreen.js`
alongside `js/main.js`, and it **dynamically** imports the clip. A static import
would put a 300 KB base64 payload in `main.js`'s dependency graph and make it a
blocking prerequisite for the whole site. This way it arrives in parallel with
the room model and never holds it up.

**The rAF loop must survive the clip not being there yet.** The first frame
fires long before the dynamic import resolves. Returning early *without*
re-requesting a frame kills the loop permanently, and because `start()`
early-outs while already running, nothing ever schedules another one — the
panel stays blank forever. `kick()` exists solely to keep the loop alive across
that gap. This was a real bug; the symptom was a permanently empty canvas.

**The loop stops when `#loading` gets `.hide`.** The overlay is faded, never
removed, so an unconditional rAF loop would repaint a canvas forever behind a
transparent element. A `MutationObserver` on the class is the only reliable
signal.

**The font is its own module.** `FONT5x7` lives in `js/font5x7.js`, and
`js/radioDisplay.js` re-exports it so every existing importer is untouched. It
used to live inside `radioDisplay.js`, which statically imports seven radio
clips — so importing the font from there would have put ~800 KB of video on the
loading screen's critical path for the sake of a few letters.

**Both LED lines are sized to each other, not hardcoded.** The top line is scaled
to the clip's width; the belt's tile is drawn at the same scale via
`background-size`. That makes the clip size circular, so `sizeCanvas()` solves it
rather than iterating:

```
video * (1 + 2 * lineH / lineW) = plate - padding - gaps
```

**The belt is declared in longhand.** With the `animation` shorthand, one
unparseable custom property invalidates the whole declaration at computed-value
time and the belt dies silently. It also has **no** `prefers-reduced-motion`
override: the belt is the only thing saying the load is alive, and an earlier
version froze it under reduced motion, stranding a fragment of the message
mid-sentence on any desktop with animation effects off.

### The LED type

Rendered as an SVG data URI of `<circle>` elements, exactly like the
LENGUAJE / LANGUAGE badge:

| constant | value | matches |
|---|---|---|
| `LED_CELL` | `4` | `LANG_CELL` in `main.js` |
| `LED_DOT_RADIUS` | `0.24` | `LANG_DOT_RADIUS` in `main.js` |

The video panel uses a different pitch on purpose: radius `0.4` of the cell, as in
`dotSprite()`, which leaves a visible ~0.2-cell gap between dots. The backing
store is always sized in **whole** dot cells so the grid never lands on a half
pixel and the gaps stay even.

---

## 4. RETRY

A failed first load shows a `RETRY` / `REINTENTAR` button, in the same LED face,
over a black field. `main.js`'s `loadScene` failure path calls
`window.__loadingScreen.showRetry()`.

- Only for the **first** load. A failed room change must not black out a site
  that is still running; that path keeps the small `#room-loading` indicator.
- The retry re-issues the scene with `silent = false` on purpose — `silent`
  suppresses the failure path, so a second failure would leave a frozen screen.
- A second failure reloads the page. The only way to clear a half-initialised
  three.js state is a clean boot.

---

## 5. Transport

`serve.py` does brotli/gzip and caching. Measured on this tree:

| | before | after |
|---|---|---|
| first-paint JS + CSS + HTML | 8.89 MB | **1.73 MB** (brotli) |
| repeat visit | 8.89 MB | **~0** (ETag 304s) |

- Compression is **never** applied to `Range` responses, nor to media/model
  types — byte offsets have to address stored bytes for seeking to work.
- `Accept-Encoding` is parsed with q-values, so `gzip;q=0` is honoured.
- `ETag` on everything, `Vary: Accept-Encoding` so caches never hand a brotli
  body to a client that cannot read it.
- `Cache-Control`: `no-cache` for HTML, `max-age=0, must-revalidate` for JS/CSS
  (fresh edits, free revisits), `max-age=86400` for media. `SERVE_CACHE=aggressive`
  switches media to one year immutable.
- `404.html` is served for any missing path **with a real 404 status**; a pretty
  page served as 200 would tell a search engine the URL is fine. Its asset URLs
  are root-absolute, because a relative URL in a 404 resolves against whatever
  directory the visitor actually asked for.

**GitHub Pages, Netlify and Cloudflare all compress at the edge for free.** The
work in `serve.py` matters most locally, so what you measure matches what you
deploy.

---

## 6. Verifying

Run the server first (`python serve.py`), then:

| check | what it proves |
|---|---|
| `python tools/video_to_dotmatrix.py ... --preview p.png` | the clip looks right before you ship it |
| `verify` on the loading module | module shape, size on the wire, **bit-exact** round trip, density inside the shipped band, wiring |
| reachability sweep | every asset the client requests is reachable and correctly typed |
| 404 path check | the 404 document's assets resolve at any missing-path depth |

The harnesses at the repo root (`smoke.js`, `cardvisible.js`, `diag.js`,
`crashlogtest.js`) need `playwright-core` and a local Edge/Chrome. They drive a
real browser — worth knowing that headless Chrome throttles `requestAnimationFrame`
unless you pass
`--disable-backgrounding-occluded-windows --disable-renderer-backgrounding
--disable-background-timer-throttling --disable-features=CalculateNativeWinOcclusion`,
or every rAF loop silently stops and the suite reports "no errors" while the page
is broken.

---

## 7. Things that will bite

- **`node --check` only validates grammar.** Deleting a `let` during a refactor
  leaves a file that passes and throws the first time that line *runs*.
- **A relative URL in `404.html` breaks at depth.** See §5.
- **A `2x2` morphological opening destroys a dot-matrix drawing** — a Sobel line
  is one pixel wide, so opening deletes the whole thing and leaves confetti.
- **The dot-matrix overlay is a `destination-in` composite.** The pattern has to
  be transparent between dots, or the whole panel is masked out.
- **Never put the 30.9 MB master clip on the critical path.** It is
  gitignored; the shipped artefact is the module, 53 KB brotli, 592× smaller.

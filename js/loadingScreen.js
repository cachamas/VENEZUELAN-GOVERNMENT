/* ------------------------------------------------------------------ */
/*  INITIAL LOADING SCREEN                                             */
/*                                                                     */
/*  A small dot-matrix clip in exactly the format the ATM and radio    */
/*  displays use (see tools/video_to_dotmatrix.py), plus the          */
/*  disclaimer and the animated status line.                          */
/*                                                                     */
/*  Two decisions worth keeping:                                      */
/*                                                                     */
/*  1. The clip is DYNAMICALLY imported. main.js and this file are     */
/*     separate entry points, so the 120 KB base64 payload is never   */
/*     a static dependency of the site - it lands in parallel with    */
/*     the room model instead of in front of it.                      */
/*                                                                     */
/*  2. The render loop STOPS the moment #loading gets .hide. The      */
/*     overlay is only faded, never removed from the DOM, so an       */
/*     unconditional rAF loop here would keep repainting a 120x120    */
/*     canvas forever behind a transparent element.                   */
/* ------------------------------------------------------------------ */

const loadingEl = document.getElementById("loading");
const canvas = document.getElementById("load-canvas");
const disclaimerEl = document.querySelector(".load-disclaimer");
const statusEl = document.querySelector(".load-text");
const scalerEl = document.querySelector(".load-scale");
const plateEl = document.querySelector(".load-plate");
const panelEl = document.querySelector(".load-panel");
// Declared here, assigned here: the retry section further down uses these, and
// a `let` assigned before its own declaration is a temporal-dead-zone throw.
let retryBox = document.querySelector(".load-retry");
let retryBtn = document.getElementById("load-retry");

// The two lines are rendered in the SAME 5x7 LED face as the LENGUAJE /
// LANGUAGE badge on the intro gate - not as webfont text. Same dot pitch, same
// dot radius, same white-on-nothing dots, so the loading screen belongs to the
// same object as the rest of the site. The font is imported from its own module
// because radioDisplay.js (which used to own it) statically imports seven
// radio clips, and that is ~800 MB of video this screen must not wait for.
import { FONT5x7 } from "./font5x7.js";

// LED geometry, identical to LANG_CELL / LANG_DOT_RADIUS in main.js.
const LED_CELL = 4;          // px per dot
const LED_DOT_RADIUS = 0.24; // in dot units -> 1.92px LED
const LED_ROWS = 7;

function ledRows(text) {
  const txt = String(text).toUpperCase();
  const grid = [];
  for (let gy = 0; gy < LED_ROWS; gy++) {
    let row = "";
    for (let i = 0; i < txt.length; i++) {
      const g = FONT5x7[txt[i]];
      if (!g) { row += "....."; continue; }
      for (let gx = 0; gx < 5; gx++) row += g[gy][gx];
      row += ".";
    }
    grid.push(row);
  }
  return grid;
}

function ledURI(text) {
  const grid = ledRows(text);
  const C = grid[0].length;
  let dots = "";
  for (let r = 0; r < LED_ROWS; r++) {
    for (let c = 0; c < C; c++) {
      if (grid[r][c] === "#") {
        dots += '<circle cx="' + c + '" cy="' + r + '" r="' + LED_DOT_RADIUS +
                '" fill="#ffffff"/>';
      }
    }
  }
  return {
    uri: "data:image/svg+xml;charset=utf-8," +
         encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' +
                           C + " " + LED_ROWS + '">' + dots + "</svg>"),
    chars: String(text).length,
    w: C * LED_CELL,
    h: LED_ROWS * LED_CELL,
  };
}

const DISCLAIMER = ledURI("NOT A GOVERNMENT WEBSITE");

// The status line is a scrolling band, the same repeating tile over and over.
// One tile is a whole repeat, so the loop is seamless at any speed.
const TILE_TEXT = "LOADING PORTFOLIO... - ";
const TILE = ledURI(TILE_TEXT);
const TILE_W = TILE.w;
const BAND_SPEED_PX_S = 34;   // slow enough to read, fast enough to feel alive

function applyLED(el, led, label) {
  if (!el) return;
  el.style.backgroundImage = 'url("' + led.uri + '")';
  el.style.width = led.w + "px";
  el.style.height = led.h + "px";
  el.textContent = "";
  el.setAttribute("role", "img");
  el.setAttribute("aria-label", label);
}

applyLED(disclaimerEl, DISCLAIMER, "Not a government website");

// The belt under the clip: one repeating LED tile translated by exactly its own
// width, so the loop point is invisible. The background image has to be set
// here - the CSS supplies the repeat, the geometry and the keyframes.
if (statusEl) {
  statusEl.style.backgroundImage = 'url("' + TILE.uri + '")';
  statusEl.style.setProperty("--tile-w", TILE_W + "px");
  statusEl.style.setProperty("--tile-dur", (TILE_W / BAND_SPEED_PX_S).toFixed(2) + "s");
  statusEl.setAttribute("role", "img");
  statusEl.setAttribute("aria-label", "Loading portfolio");
}

// clip is authored at 120x120; the canvas backing store is sized in whole
// pixels-per-dot so the grid stays perfectly crisp at any display size
let COLS = 120;
let ROWS = 120;


let clip = null;        // { fps, w, h, frames, bytes, blob }
let bits = null;        // ImageData, one entry per dot
let dotPattern = null;  // repeating round-dot pattern
let raf = 0;
let timer = 0;
let startedAt = 0;
let running = false;
let lastDrawMs = 0;
let loaded = false;

const ctx = canvas.getContext("2d", { alpha: true });
const src = document.createElement("canvas");

/* --- layout: square panel, at least as wide as the disclaimer ---------- */
const DOT_R = 0.4;           // radius as a fraction of the cell, as in
                             // dotSprite() in js/mainDisplay.js. At the pitch
                             // the plate ends up giving us, the ~0.2-cell gap
                             // between dots is visible - which is the point.

/* --- the round dot, matching dotSprite() in js/mainDisplay.js -------- */
function makeDotPattern(cell) {
  const s = cell;
  const c = document.createElement("canvas");
  c.width = s;
  c.height = s;
  const g = c.getContext("2d");
  const r = s * DOT_R;
  const grd = g.createRadialGradient(s / 2, s / 2, r * 0.1, s / 2, s / 2, r);
  grd.addColorStop(0, "rgba(255,255,255,1)");
  grd.addColorStop(0.55, "rgba(255,255,255,1)");
  grd.addColorStop(0.8, "rgba(255,255,255,0.55)");
  grd.addColorStop(1, "rgba(255,255,255,0)");
  g.beginPath();
  g.arc(s / 2, s / 2, r, 0, Math.PI * 2);
  g.fillStyle = grd;
  g.fill();
  return ctx.createPattern(c, "repeat");
}

/* --- sizing ----------------------------------------------------------- */
// The plate is a modest square in the middle of the screen, not a field that
// fills it. Half the short edge is the default; the clamps stop it becoming
// uselessly small on a phone and absurdly large on a 4K display.
const PLATE_FRAC = 0.5;
const PLATE_MIN = 240;
const PLATE_MAX = 520;

function sizeCanvas() {
  if (!canvas) return;
  const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
  const vw = window.innerWidth || 1280;
  const vh = window.innerHeight || 800;

  const plate = Math.max(PLATE_MIN, Math.min(PLATE_MAX,
    Math.round(Math.min(vw, vh) * PLATE_FRAC)));
  // Padding and gap follow the plate rather than being fixed, so the
  // proportions survive the clamp at both ends.
  const pad = Math.max(9, Math.min(22, Math.round(plate * 0.055)));
  const gap = Math.max(7, Math.min(20, Math.round(plate * 0.045)));

  // The top line and the belt are the SAME size, so both are the same scaled
  // height. That makes the clip size circular - the line is scaled to the clip's
  // width, and the clip is what is left after the lines are placed - so solve it
  // rather than iterate:
  //
  //   video = K - 2*lineH,  lineH = fit*DISCLAIMER.h,  fit = video/DISCLAIMER.w
  //   =>  video * (1 + 2*DISCLAIMER.h / DISCLAIMER.w) = K
  const K = plate - pad * 2 - gap * 2;
  const denom = 1 + (2 * DISCLAIMER.h) / DISCLAIMER.w;
  const video = Math.max(60, Math.min(K, Math.round(K / denom)));

  // Belt tile rendered at the same dot scale as the top line, so the two read
  // as one typeface at one size.
  const fit = video / DISCLAIMER.w;
  const lineH = Math.round(DISCLAIMER.h * fit);
  const tileW = Math.round(TILE_W * fit);

  if (plateEl) {
    plateEl.style.width = plate + "px";
    plateEl.style.height = plate + "px";
    plateEl.style.padding = pad + "px";
    plateEl.style.gap = gap + "px";
  }
  if (panelEl) {
    panelEl.style.width = video + "px";
    panelEl.style.height = video + "px";
  }
  if (disclaimerEl) {
    disclaimerEl.style.width = DISCLAIMER.w + "px";
    disclaimerEl.style.height = DISCLAIMER.h + "px";
    disclaimerEl.style.transform = "scale(" + fit.toFixed(4) + ")";
    // a scaled box still reserves its unscaled size, so take the difference
    // back out of the flow or the stack grows taller than the plate
    disclaimerEl.style.marginBottom = (-(DISCLAIMER.h * (1 - fit))).toFixed(1) + "px";
  }
  if (statusEl) {
    statusEl.style.height = lineH + "px";
    // The tile is drawn at the top line's scale, and the loop travels exactly
    // one rendered tile - so the seam stays invisible at any plate size.
    statusEl.style.setProperty("--tile-w", tileW + "px");
    // Floored: animation-duration is declared in longhand, and an invalid or
    // 0s value falls back to 0s, which would park the belt on its end state and
    // look frozen. Never let the arithmetic produce that.
    const dur = Math.max(4, tileW / BAND_SPEED_PX_S);
    statusEl.style.setProperty("--tile-dur", dur.toFixed(2) + "s");
  }

  // The plate is already sized to the viewport, so no further scaling is needed;
  // this is only a safety net for viewports smaller than PLATE_MIN.
  const scale = Math.min(1, (vw - 12) / plate, (vh - 12) / plate);
  if (scalerEl) scalerEl.style.transform = "scale(" + scale.toFixed(4) + ")";

  // Backing store: whole dot cells, so the grid never lands on a half pixel and
  // the gaps between dots stay even at every size.
  const cell = Math.max(2, Math.round((video * scale * dpr) / COLS));
  const w = COLS * cell;
  if (canvas.width !== w || canvas.height !== w) {
    canvas.width = w;
    canvas.height = w;
  }
  if (ctx) ctx.imageSmoothingEnabled = false;
  dotPattern = makeDotPattern(cell);
  if (bits) lastDrawMs = 0;   // force one repaint at the new size
}

/* --- unpack one 1-bit frame into an ImageData ------------------------ */
function frameToImageData(idx) {
  const blob = clip.blob;
  const off = idx * clip.bytes;
  const d = bits.data;
  for (let i = 0; i < COLS * ROWS; i++) {
    // row-major, MSB first - the packing tools/video_to_dotmatrix.py writes
    const on = (blob[off + (i >> 3)] >> (7 - (i & 7))) & 1;
    const p = i * 4;
    d[p] = 255; d[p + 1] = 255; d[p + 2] = 255;
    d[p + 3] = on ? 255 : 0;
  }
  return bits;
}

function kick() {
  if (raf) return;
  raf = requestAnimationFrame(draw);
}

function draw() {
  raf = 0;
  if (!running) return;

  // The loop must survive the clip not being here yet. The first frame fires
  // long before the dynamic import resolves, so returning early WITHOUT
  // re-requesting killed the loop permanently: start() early-outs while
  // `running` is already true, so nothing ever scheduled a frame again and the
  // panel stayed blank forever.
  if (clip && bits && ctx) {
    const t = (performance.now() - startedAt) / 1000;
    const idx = Math.floor(t * clip.fps) % clip.frames;
    // 12 fps source: only repaint when the frame actually changes, otherwise we
    // would clear and recomposite the canvas 60x a second for no reason
    if (t * 1000 - lastDrawMs >= 1000 / clip.fps - 1) {
      lastDrawMs = t * 1000;

      if (src.width !== COLS) src.width = COLS;
      if (src.height !== ROWS) src.height = ROWS;
      src.getContext("2d").putImageData(frameToImageData(idx), 0, 0);

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
      // knock the square pixels down to round dots
      if (dotPattern) {
        ctx.globalCompositeOperation = "destination-in";
        ctx.fillStyle = dotPattern;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.globalCompositeOperation = "source-over";
      }
    }
  }

  kick();
}

/* --- the retry control ------------------------------------------------ */
/* A failed load is the one error a visitor can do something about, so it gets a
   real button. Same 5x7 face, same dot pitch as the loading screen, and the
   label follows the language picked at the intro gate like every other string
   on the site (RETRY / REINTENTAR). */
const RETRY_EN = ledURI("RETRY");
const RETRY_ES = ledURI("REINTENTAR");
let onRetry = null;

function label() {
  const lang = (typeof window !== "undefined" && window.__PORTFOLIO_LANG__) || "es";
  return lang === "en" ? RETRY_EN : RETRY_ES;
}

function paintRetry() {
  if (!retryBtn) return;
  const led = label();
  retryBtn.style.backgroundImage = 'url("' + led.uri + '")';
  retryBtn.style.width = led.w + "px";
  retryBtn.style.height = led.h + "px";
  retryBtn.setAttribute("aria-label",
    (typeof window !== "undefined" && window.__PORTFOLIO_LANG__) === "en"
      ? "Retry" : "Reintentar");
}

// Reads the plate's on-screen scale so the button's hit area matches what is
// actually drawn, even after the viewport fit has shrunk everything.
function fitRetry() {
  if (!retryBtn) return;
  const s = scalerEl
    ? (parseFloat((scalerEl.style.transform.match(/scale\(([\d.]+)\)/) || [])[1]) || 1)
    : 1;
  retryBtn.style.transform = "scale(" + s.toFixed(4) + ")";
}

function showRetry(handler) {
  if (!retryBox) return;
  onRetry = handler || null;
  paintRetry();
  fitRetry();
  retryBox.hidden = false;
  // stop the clip: a stalled load behind a RETRY button is just noise
  stop();
  // focus it so the keyboard path works without a second tab stop
  setTimeout(function () { if (retryBtn) retryBtn.focus(); }, 30);
}

function hideRetry() {
  if (retryBox) retryBox.hidden = true;
  onRetry = null;
}

if (retryBtn) {
  retryBtn.addEventListener("click", function (e) {
    e.preventDefault();
    const fn = onRetry;
    hideRetry();
    if (fn) fn();
    else location.reload();
  });
}

// There is no JS timer for the status line any more: the scrolling band is a
// pure CSS animation on a repeating background, so it costs nothing to leave
// running and it freezes on its own when the overlay is hidden.
function start() {
  if (!loadingEl) return;
  // Idempotent, but always make sure a frame is actually pending: loadClip()
  // lands after start() has already run, and that is the only moment the panel
  // becomes paintable.
  if (!running) {
    running = true;
    startedAt = performance.now();
    lastDrawMs = 0;
    sizeCanvas();
  }
  kick();
}

function stop() {
  running = false;
  if (raf) { cancelAnimationFrame(raf); raf = 0; }
  if (timer) { clearTimeout(timer); timer = 0; }
}

function isHidden() {
  return !loadingEl || loadingEl.classList.contains("hide");
}

function begin() {
  if (isHidden()) return;         // loaded from cache / instant: never show
  start();
  // main.js fades the overlay with .hide rather than removing it, so watch the
  // class instead of trusting a load event
  new MutationObserver(function () {
    if (isHidden()) stop();
    else start();
  }).observe(loadingEl, { attributes: true, attributeFilter: ["class"] });
}

async function loadClip() {
  if (loaded) return;
  loaded = true;
  try {
    const mod = await import("./videos/loading.js");
    clip = mod.loadingVideoData;
    COLS = clip.w;
    ROWS = clip.h;
    src.width = COLS;
    src.height = ROWS;
    const sctx = src.getContext("2d");
    bits = sctx.createImageData(COLS, ROWS);
    sizeCanvas();
    // the panel may have been sized before the real dimensions were known
    if (running) lastDrawMs = 0;
    begin();
  } catch (err) {
    // Never let the animation be the reason the screen looks broken. The text
    // and the blue field are pure CSS, so a failure here is invisible anyway -
    // and there is no point keeping a rAF loop alive with nothing to draw.
    stop();
    console.warn("[loading] dot-matrix clip unavailable:", err && err.message);
  }
}

// the canvas can be laid out at any time by the CSS above, so re-fit on resize
let resizeTimer = 0;
window.addEventListener("resize", function () {
  if (!running) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(sizeCanvas, 150);
});

// give the text a frame to paint before the clip's own request lands
begin();
loadClip();

window.__loadingScreen = {
  get running() { return running; },
  get loaded() { return !!clip; },
  get frames() { return clip ? clip.frames : 0; },
  get size() { return clip ? clip.w + "x" + clip.h : "none"; },
  start: start,
  stop: stop,
  // called by main.js when a scene fails, so a dead network gets a real
  // control instead of a dead end
  showRetry: showRetry,
  hideRetry: hideRetry,
  get retryVisible() { return !!(retryBox && !retryBox.hidden); },
};

import * as THREE from "three";
import { FONT5x7 } from "./radioDisplay.js";
import { m1VideoData } from "./videos/m1.js";
import { m2VideoData } from "./videos/m2.js";
import { m3VideoData } from "./videos/m3.js";
import { m4VideoData } from "./videos/m4.js";
import { m5VideoData } from "./videos/m5.js";
import { hov3d } from "./videos/hov3d.js";
import { hovAbout } from "./videos/hovAbout.js";
import { hovArt } from "./videos/hovArt.js";
import { hovClothes } from "./videos/hovClothes.js";
import { hovContact } from "./videos/hovContact.js";
import { hovMusic } from "./videos/hovMusic.js";

/* ------------------------------------------------------------------ */
/*  MAIN overlay dot-matrix (same system as the MUSIC room display,    */
/*  near-square panel at ~8x the radio's dot count; TRANSPARENT        */
/*  background, white dots)                                            */
/* ------------------------------------------------------------------ */

const COLS = 172;
const ROWS = 132;
const CELL = 4;
const DOT = 1.6;
const CW = COLS * CELL;
const CH = ROWS * CELL;

// playlist of converted clips; each plays once in order, then the whole
// list loops forever
const VIDEOS = [m1VideoData, m2VideoData, m3VideoData, m4VideoData, m5VideoData];

// hover clips: while a menu button is hovered the panel dissolves into that
// section's clip; on unhover it dissolves back to the playlist
const HOVER_VIDEOS = {
  CLOTHES: hovClothes,
  ABOUT:   hovAbout,
  ART:     hovArt,
  MUSIC:   hovMusic,
  CONTACT: hovContact,
  "3D":    hov3d,
};

/* ------------------------------------------------------------------ */
/*  ATM hover labels — TWEAK ME                                        */
/*                                                                     */
/*  Each menu button lights a fixed label on the panel while hovered.  */
/*  Coordinates are LED CELLS on the 172x132 matrix:                   */
/*      x: 0 = left edge .. 171 = right edge                           */
/*      y: 0 = top edge .. 131 = bottom edge                           */
/*  x/y is the label's TOP-LEFT corner. Nudge them freely to sit       */
/*  right next to each button's highlight on the wall.                 */
/*  TEXT_SCALE multiplies the 5x7 font (a glyph becomes SCALE*6 cells  */
/*  wide incl. gap, SCALE*7 tall) — re-tune x/y if you change it.      */
/* ------------------------------------------------------------------ */
const TEXT_SCALE = 2;

// default grid: two columns x three rows (left col / right col)
// ROW TUNING: the y value is the label's top edge in cells (0..131).
// 132 cells = full panel height, so 1% ≈ 1.3 cells.
const HOVER_LAYOUT = {
  CLOTHES: { x: 6,   y: 48  },  // top-left   <- change y here to move the TOP ROW
  ABOUT:   { x: 108, y: 48  },  // top-right  <-
  ART:     { x: 6,   y: 72  },  // mid-left   <- change y here to move the MID ROW
  MUSIC:   { x: 108, y: 72  },  // mid-right  <-
  CONTACT: { x: 6,   y: 99  },  // bottom-left <- change y here to move the BOTTOM ROW
  "3D":    { x: 144, y: 99  },  // bottom-right <-
};

// transparent padding (cells) cleared around a label so it reads over the video
const LABEL_PAD = 3;

// Spanish x-drift — ACERCA and MUSICA render wider than their English names,
// so their box is nudged left ~10% of the anchor x to stay visually centered
// on the same button column as the other labels.
const HOVER_SHIFT_ES = {
  ABOUT: 0.10,
  MUSIC: 0.10,
};
// Spanish menu labels — mesh names stay English (they drive hit-testing,
// video lookups and 3D hooks), but the ATM panel renders translated text.
const LABEL_ES = {
  ABOUT:   "ACERCA",
  CLOTHES: "MODA",
  ART:     "ARTE",
  CONTACT: "CONTACTO",
  MUSIC:   "MUSICA",
  "3D":    "3D",
};

function getHoverLabel(name) {
  if (!name) return name;
  const lang = (typeof window !== "undefined" && window.__PORTFOLIO_LANG__) || "es";
  return lang === "en" ? name : (LABEL_ES[name] || name);
}

/* ------------------------------------------------------------------ */
/*  LOOP ticker — flashing text stamped over the playlist while NO     */
/*  menu button is hovered. Messages cycle forever; each one blinks    */
/*  LOOP_BLINKS times (on LOOP_ON_MS / off LOOP_OFF_MS), centered.     */
/*  Drawn at font scale 1 so the longest line fits the 172-col panel.  */
/* ------------------------------------------------------------------ */
const LOOP_TEXTS = [
  "THIS IS A PORTFOLIO",
  "ESTO ES UN PORTAFOLIO",
  ["IG: @GOB.VE", "", "TIKTOK: @GOB.VE"],   // arrays render as stacked lines
  ["VENEZUELAN GOVERNMENT", "(ARTIST)"],
];

// the ticker leads with the repertoire language chosen at the intro gate
// (window.__PORTFOLIO_LANG__ is set by main.js when the player picks); the
// message count never changes, so phase math is unaffected
function activeLoopTexts() {
  const lang = (typeof window !== "undefined" && window.__PORTFOLIO_LANG__) || "es";
  return lang === "en"
    ? [LOOP_TEXTS[1], LOOP_TEXTS[0], LOOP_TEXTS[2], LOOP_TEXTS[3]]
    : LOOP_TEXTS;
}
const LOOP_ON_MS = 700;
const LOOP_OFF_MS = 300;
const LOOP_BLINKS = 4;
const LOOP_LINE_GAP = 4;   // blank rows between stacked lines

let animT = 0;
let lastDraw = 0;

const led = new Uint8Array(COLS * ROWS);
const prevLed = new Uint8Array(COLS * ROWS);

function wrapMod(v, m) {
  return ((v % m) + m) % m;
}

function dotSprite() {
  const c = document.createElement("canvas");
  c.width = CELL;
  c.height = CELL;
  const g = c.getContext("2d");
  // hot core: pure solid white across most of the dot, quick falloff at the
  // rim — keeps the LEDs reading bright instead of grey-blended
  const grd = g.createRadialGradient(CELL / 2, CELL / 2, DOT * 0.1, CELL / 2, CELL / 2, DOT);
  grd.addColorStop(0, "rgba(255,255,255,1)");
  grd.addColorStop(0.55, "rgba(255,255,255,1)");
  grd.addColorStop(0.8, "rgba(255,255,255,0.55)");
  grd.addColorStop(1, "rgba(255,255,255,0)");
  g.beginPath();
  g.arc(CELL / 2, CELL / 2, DOT, 0, Math.PI * 2);
  g.fillStyle = grd;
  g.fill();
  return c;
}

function createDisplay() {
  const canvas = document.createElement("canvas");
  canvas.width = CW;
  canvas.height = CH;
  const ctx = canvas.getContext("2d");

  // NO background layer: the canvas stays fully transparent wherever no LED
  // is lit, so only the white dots are painted onto the mesh.
  const dot = dotSprite();
  const tex = new THREE.CanvasTexture(canvas);
  // mag stays Nearest so dots are crisp up close; min uses mipmaps so the
  // grid AVERAGES when far away instead of point-sampling into moire.
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.flipY = false;
  tex.needsUpdate = true;

  function drawVideoFrame(videoData, frameIdx) {
    const blob = videoData.blob;
    const off = frameIdx * videoData.bytes;
    for (let i = 0; i < led.length; i++) {
      led[i] = (blob[off + (i >> 3)] >> (7 - (i & 7))) & 1;
    }
  }

  /* --- ATM hover-label layer (drawn ON TOP of the video) -------------- */

  function setCell(c, r, on) {
    if (c < 0 || c >= COLS || r < 0 || r >= ROWS) return;
    led[r * COLS + c] = on ? 1 : 0;
  }

  function rect(c, r, w, h, on) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) setCell(c + x, r + y, on);
  }

  function labelWidth(s, sc) {
    const k = sc || TEXT_SCALE;
    let w = 0;
    const str = String(s).toUpperCase();
    for (let i = 0; i < str.length; i++) w += str[i] === " " ? 3 * k : 6 * k;
    return Math.max(0, w - k);
  }

  function drawCharScaled(ch, col, row, on, sc) {
    const g = FONT5x7[ch];
    const k = sc || TEXT_SCALE;
    if (!g) return col + 6 * k;
    for (let gy = 0; gy < 7; gy++) {
      const line = g[gy];
      for (let gx = 0; gx < 5; gx++) {
        if (line[gx] === "#") rect(col + gx * k, row + gy * k, k, k, on);
      }
    }
    return col + 6 * k;
  }

  function drawTextScaled(s, col, row, on, sc) {
    const str = String(s).toUpperCase();
    let x = col;
    for (let i = 0; i < str.length; i++) {
      if (str[i] === " ") { x += 3 * (sc || TEXT_SCALE); continue; }
      x = drawCharScaled(str[i], x, row, on, sc);
    }
    return x;
  }

  // knock the video OUT under a label (transparent pocket), then stamp the
  // text over it — the label floats above whatever clip is playing
  function drawHoverLayer() {
    if (!hoverName) return;
    const cfg = HOVER_LAYOUT[hoverName];
    const label = getHoverLabel(hoverName);
    const shift = label !== hoverName && HOVER_SHIFT_ES[hoverName] ? HOVER_SHIFT_ES[hoverName] : 0;
    const x = cfg.x - Math.round(cfg.x * shift);
    const p = LABEL_PAD;
    rect(x - p, cfg.y - p, labelWidth(label) + p * 2, 7 * TEXT_SCALE + p * 2, 0);
    drawTextScaled(label, x, cfg.y, 1);
  }

  /* --- loop ticker layer (playlist only) ------------------------------- */

  const LOOP_PERIOD = (LOOP_ON_MS + LOOP_OFF_MS) * LOOP_BLINKS;
  const LOOP_CYCLE = LOOP_TEXTS.length * LOOP_PERIOD;

  // current ticker phase at animT: which message and on/off blink state
  function loopPhase() {
    const t = wrapMod(animT, LOOP_CYCLE);
    return {
      idx: Math.floor(t / LOOP_PERIOD),
      on: (t % LOOP_PERIOD) % (LOOP_ON_MS + LOOP_OFF_MS) < LOOP_ON_MS,
    };
  }

  // flashing announcement stamped over the playlist; silent while a hover
  // clip is the source being shown or dissolved towards. A message is either
  // a string or an array of lines; each line centers itself horizontally.
  function drawLoopTextLayer() {
    if ((trans ? trans.to : curHover) !== null) return;
    const ph = loopPhase();
    if (!ph.on) return;
    const msg = activeLoopTexts()[ph.idx];
    const lines = Array.isArray(msg) ? msg : [msg];
    let w = 0;
    for (let i = 0; i < lines.length; i++) w = Math.max(w, labelWidth(lines[i], 1));
    const h = (lines.length - 1) * (7 + LOOP_LINE_GAP) + 7;
    const y = Math.floor((ROWS - h) / 2);
    const x = Math.floor((COLS - w) / 2) - LABEL_PAD;
    rect(x, y - LABEL_PAD, w + LABEL_PAD * 2, h + LABEL_PAD * 2, 0);
    for (let i = 0; i < lines.length; i++) {
      drawTextScaled(lines[i], Math.floor((COLS - labelWidth(lines[i], 1)) / 2), y + i * (7 + LOOP_LINE_GAP), 1, 1);
    }
  }

  /* --- source scheduler ------------------------------------------------ */
  /* Steady state plays the VIDEOS playlist; while a menu button is       */
  /* hovered it plays that section's HOVER_VIDEOS clip instead. Switches  */
  /* run through a TRANSITION_MS random-dot dissolve: each cell flips to  */
  /* the new clip when the progress passes that cell's threshold.         */

  const TRANSITION_MS = 1000;

  const CLIPS = VIDEOS.map(function (v) {
    return { data: v, dur: v.frames / v.fps };
  });
  const TOTAL = CLIPS.reduce(function (a, c) { return a + c.dur; }, 0);

  function clipAt(t) {
    const ct = wrapMod(t, TOTAL);
    let acc = 0;
    for (let i = 0; i < CLIPS.length; i++) {
      if (ct < acc + CLIPS[i].dur) return { index: i, clip: CLIPS[i], local: ct - acc };
      acc += CLIPS[i].dur;
    }
    return { index: 0, clip: CLIPS[0], local: 0 };
  }

  // per-cell dissolve thresholds in [0, 0.99]: mostly organic noise tilted
  // by a slight diagonal sweep so the new clip eats across the panel
  const dissolveThr = new Float32Array(COLS * ROWS);
  (function seedThresholds() {
    let s = 0x9e3779b9;
    function rnd() {
      s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
      return (s >>> 0) / 4294967296;
    }
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        dissolveThr[r * COLS + c] =
          Math.min(0.99, rnd() * 0.7 + ((c / COLS + r / ROWS) * 0.15));
      }
    }
  })();

  // steady source: which hover clip is playing (null = playlist), plus an id
  // bumped on every switch so the redraw-skip key can't collide across clips
  let curHover = null;
  let modeId = 0;
  let trans = null; // { from: led snapshot, to: hover name|null, start }

  function steadyFrameIdx() {
    if (curHover) {
      const v = HOVER_VIDEOS[curHover];
      return Math.floor((animT / 1000) * v.fps) % v.frames;
    }
    const s = clipAt(animT / 1000);
    return Math.floor(s.local * s.clip.data.fps) % s.clip.data.frames;
  }

  function drawTarget(name) {
    if (name) {
      const v = HOVER_VIDEOS[name];
      drawVideoFrame(v, Math.floor((animT / 1000) * v.fps) % v.frames);
    } else {
      const s = clipAt(animT / 1000);
      drawVideoFrame(s.clip.data, Math.floor(s.local * s.clip.data.fps) % s.clip.data.frames);
    }
  }

  function render() {
    drawTarget(curHover);
    drawHoverLayer();
    drawLoopTextLayer();
  }

  function blit() {
    ctx.clearRect(0, 0, CW, CH);
    let changed = 0;
    for (let i = 0; i < led.length; i++) {
      if (led[i] === prevLed[i]) continue;
      prevLed[i] = led[i];
      changed++;
    }
    for (let i = 0; i < led.length; i++) {
      // the panel's authored UV layout shows the canvas rotated 180°, so both
      // axes are painted mirrored: row r from the bottom edge, col c from the
      // right edge
      if (!led[i]) continue;
      const col = i % COLS;
      const row = Math.floor(i / COLS);
      ctx.drawImage(dot, CW - (col + 1) * CELL, CH - (row + 1) * CELL);
    }
    if (changed) tex.needsUpdate = true;
    return changed;
  }

  let lastFrameKey = -1;

  function tick(now) {
    if (lastDraw === 0) lastDraw = now;
    animT += now - lastDraw;
    lastDraw = now;

    // consume hover requests queued by setOverlayHover between frames; a
    // request for the source already playing (or dissolving towards) is a
    // no-op, anything else starts a fresh dissolve from the current blend
    if (requestDirty) {
      requestDirty = false;
      const steady = trans ? trans.to : curHover;
      if (pendingHover !== steady) {
        trans = { from: led.slice(), to: pendingHover, start: now };
        lastFrameKey = -1;
      }
    }

    // mid-dissolve: draw the target clip live, keep every cell whose
    // threshold hasn't been crossed on the snapshot, blit every frame.
    // This is the worst case in the whole display — a full repaint of every
    // lit LED plus a full texture upload, sixty times a second, for the length
    // of the transition. In lite mode the dissolve is skipped entirely and the
    // panel snaps to its new label, which keeps the cost of a hover on a weak
    // device to a single blit.
    if (trans) {
      if (lite) {
        // Snap straight to the FINISHED state. That is exactly what the
        // normal path does at p >= 1: drawTarget paints the LEDs for the new
        // label and nothing is restored from the `from` snapshot.
        //
        // It is tempting to shortcut this with `led.set(trans.to)`, and it is
        // wrong on two counts: `trans.to` is a hover NAME, not LED data, and it
        // is null whenever the pointer leaves a menu or lands on one with no
        // video. `Uint8Array.set(null)` throws, and this runs inside a
        // requestAnimationFrame loop — so it turned a one-frame transition into
        // an uncaught TypeError every frame, on every lite device (i.e. the
        // iPhones), which is exactly the crash the heartbeat was reporting.
        drawTarget(trans.to);
        curHover = trans.to;
        modeId++;
        trans = null;
        lastFrameKey = -1;
        drawHoverLayer();
        drawLoopTextLayer();
        blit();
        return;
      }
      const p = (now - trans.start) / TRANSITION_MS;
      drawTarget(trans.to);
      if (p >= 1) {
        curHover = trans.to;
        modeId++;
        trans = null;
      } else {
        const from = trans.from;
        for (let i = 0; i < led.length; i++) {
          if (dissolveThr[i] >= p) led[i] = from[i];
        }
      }
      drawHoverLayer();
      drawLoopTextLayer();
      blit();
      return;
    }

    // content only changes at the clip fps, when the ticker blink/message
    // flips (or when a hover label flips on/off) — skip redraws in between;
    // at this dot count a full blit is worth skipping 4 of every 5 frames
    const fi = steadyFrameIdx();
    const ph = loopPhase();
    const tphase = ph.idx * 2 + (ph.on ? 1 : 0);
    const key = (modeId * LOOP_TEXTS.length * 2 + tphase) * 4096 + fi;
    if (!labelDirty && key === lastFrameKey) return;
    labelDirty = false;
    lastFrameKey = key;
    drawTarget(curHover);
    drawHoverLayer();
    drawLoopTextLayer();
    blit();
  }

  return { canvas: canvas, tex: tex, tick: tick, render: render, blit: blit };
}

let display = null;

// current hover label (menu name or null); flipping it forces one redraw
let hoverName = null;
let labelDirty = false;

// requested steady source from the latest hover event (menu name or null);
// consumed by the display loop, which turns it into a dissolve transition
let pendingHover = null;
let requestDirty = false;

export function setOverlayHover(name) {
  const n = name && HOVER_LAYOUT[name] ? String(name) : null;
  if (n === hoverName && !requestDirty) return;
  hoverName = n;
  labelDirty = true;
  pendingHover = n && HOVER_VIDEOS[n] ? n : null;
  requestDirty = true;
}

function ensureDisplay() {
  if (display) return display;
  display = createDisplay();
  display.render();
  display.blit();
  requestAnimationFrame(function loop(now) {
    requestAnimationFrame(loop);
    if (document.hidden) return;
    display.tick(now);
  });
  return display;
}

export function getMainDisplay() {
  return ensureDisplay();
}

// LITE MODE, driven by js/perf.js from main.js. Flips the hover dissolve from
// a per-frame cross-fade to a single repaint — the steady state was already
// change-detected, so the dissolve was the only unbounded cost here.
let lite = false;
export function setMainDisplayLite(v) { lite = !!v; }

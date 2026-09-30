/* ------------------------------------------------------------------ */
/*  perf.js — adaptive quality, so the same build runs on an S24 Ultra   */
/*  and on a cheap tablet without being tuned for either.                 */
/* ------------------------------------------------------------------ */
/*                                                                       */
/*  WHY THIS EXISTS. Every scene is a full-screen 3D room lit entirely by  */
/*  baked emissive textures, and it is fill-rate bound: there are no real   */
/*  lights, no shadows, and the geometry is simple, so almost all of the    */
/*  frame cost is "how many pixels are you shading". That makes the cost    */
/*  almost perfectly proportional to (pixel ratio)^2, and the pixel ratio   */
/*  is the one lever we can move at RUNTIME without reloading.              */
/*                                                                       */
/*  WHAT MOVES, AND WHEN.                                                   */
/*                                                                       */
/*  antialias  Fixed at context creation — a WebGLRenderer cannot turn     */
/*             MSAA on or off afterwards. So it is decided ONCE, up front,  */
/*             from the hardware probe below, and never adapted. This is     */
/*             the most expensive single decision (MSAA multiplies every      */
/*             fragment's bandwidth), which is why it is made from hardware  */
/*             hints rather than guessed at runtime.                           */
/*                                                                       */
/*  pixelRatio Fully dynamic, and the main lever. Dropped in steps by the    */
/*             frame-rate watchdog, restored if headroom comes back.         */
/*                                                                       */
/*  lite mode  Switches off the per-frame CPU work that does not affect     */
/*             layout: the canvas-backed animated textures (fly atlas,       */
/*             smoke, the dot-matrix radio/main displays) and the contact     */
/*             card's blur chain. Each of those is a CPU canvas paint plus a   */
/*             full texture upload EVERY FRAME, which is brutal on a weak     */
/*             GPU and invisible to a static screenshot.                       */
/*                                                                       */
/*  WHY A WATCHDOG AND NOT JUST A PROBE. The probe is a guess; only         */
/*  measured frame time is evidence. So the probe picks the starting tier     */
/*  (so a weak tablet does not spend its first ten seconds at 8fps) and the    */
/*  watchdog corrects it either way. Downgrades are quick because a struggling */
/*  device needs relief now; upgrades are slow and rate-limited because a      */
/*  device that oscillates between tiers is worse than one that sits low.     */
/* ------------------------------------------------------------------ */

// how much the cost of one tier is relative to the next, in pixels
const TIERS = [
  { name: "high",     ratio: 2.0,  lite: false },
  { name: "medium",   ratio: 1.5,  lite: false },
  { name: "low",      ratio: 1.25, lite: true  },
  { name: "minimum",  ratio: 1.0,  lite: true  },
  // the last resort. Below 1.0 the browser upscales the canvas, so this is
  // genuinely soft — but "soft" beats "the tab died", and a 0.75 ratio on a
  // 2x panel is 14% of the fragments of the high tier. Reserved for devices
  // that measure slow even after every other step.
  { name: "floor",    ratio: 0.75, lite: true  },
];
const TIER_MIN = 0;
const TIER_MAX = TIERS.length - 1;

// frame-rate thresholds (fps). The gap between DOWN_FPS and UP_FPS is the
// hysteresis band: without it a device sitting near 45fps would flip tier
// every second and the resolution would visibly pump.
const DOWN_FPS = 42;
const UP_FPS = 56;
// how long a bad (or good) streak must last before acting
const DOWN_HOLD_S = 1.2;
const UP_HOLD_S = 6.0;
// after changing tier, ignore the watchdog this long so the new setting can
// settle — otherwise the transient of the change itself re-triggers it
const SETTLE_S = 2.5;
// Downgrades may go all the way to TIER_MIN — that is the whole point, a weak
// device must be able to fall as far as it needs to. The limit applies to
// UPGRADES only: a device that measured as too slow never climbs back ABOVE
// the tier it launched at, so the resolution cannot pump up and down forever.
// It may still climb back to that starting tier if the load lightens.

/* ---- hardware probe ------------------------------------------------ */
// Deliberately conservative and additive rather than clever: the only way to
// be wrong here is to start too HIGH, and the watchdog fixes that within a
// couple of seconds. Starting too low would need a long, visible climb.
const WEAK_GPU = /(mali-[tg]?[456]|mali-g3|adreno \(tm\) (3|4|5)\d\d|adreno 505|adreno 506|adreno 508|powervr|hd graphics( \d|\b)|swiftshader|llvmpipe|software|apple a[789]x?)/i;

// iOS gets a floor on its starting tier, and it is not a guess about the
// hardware — it is about the platform. Safari does not implement
// deviceMemory, iOS enforces a far tighter per-tab memory budget than Android,
// and a killed tab on iOS is the single most expensive failure mode this build
// has (measured: an iPhone 18.7 device sat in the MUSIC room fine and died on
// the way OUT, which is a peak-memory event, not a frame-rate one).
//
// So iOS starts with lite mode already ON — the mode that removes the unbounded
// per-frame work: the CONTACT card's blurred backdrop, the fly/smoke canvas
// repaints, the dot-matrix hover dissolve, the MUSIC panel repaint. None of
// that changes what a room looks like at rest; it all changes how much the
// main thread and the allocator are doing while the GPU is also resizing its
// buffers for an incoming scene. The watchdog can still move it from there in
// either direction.
const IOS_START_TIER = 2;
function isIOS() {
  var ua = navigator.userAgent || "";
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && typeof document !== "undefined" && "ontouchend" in document);
}

function probe() {
  const out = { cores: 0, memoryGb: 0, gpu: "", tier: 0, antialias: true, reason: "defaults", preloadAll: true, memoryNote: "" };
  try {
    out.cores = navigator.hardwareConcurrency || 0;
  } catch (e) { /* not available */ }
  // deviceMemory is Chromium-only and deliberately coarse (it rounds to
  // powers of two), but 4 or less is a genuinely useful "low-end" signal
  try {
    out.memoryGb = navigator.deviceMemory || 0;
  } catch (e) { /* not available */ }

  // MEMORY. This is a separate axis from frame rate and it is the one that
  // actually KILLS a phone rather than making it stutter: all five scenes are
  // preloaded and stay resident, so the fifth load is what tips a device over
  // its budget and gets the tab terminated. The drawing buffer is usually the
  // biggest single allocation — on a 3x phone at ratio 2 with MSAA, colour +
  // depth + multisample is comfortably over 100MB on its own, and the GLBs sit
  // on top of that.
  // Safari does not implement deviceMemory at all, and iOS enforces a much
  // tighter per-tab budget than Android, so "a touch device with no memory
  // readout" is treated as low-memory rather than unknown.
  const hasMemReadout = typeof navigator === "object" && "deviceMemory" in navigator;
  const touchish = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  out.ios = isIOS();
  if (!hasMemReadout && touchish) {
    out.preloadAll = false;
    out.memoryNote = "no deviceMemory on a touch device — preloading conservatively";
  }
  if (out.memoryGb && out.memoryGb <= 4) {
    out.preloadAll = false;
    out.memoryNote = out.memoryNote || (out.memoryGb + "GB reported");
  }

  const gl = document.createElement("canvas").getContext("webgl2") ||
             document.createElement("canvas").getContext("webgl");
  if (gl) {
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    if (dbg) {
      try { out.gpu = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || ""); } catch (e) { /* blocked */ }
    }
    if (!out.gpu) { try { out.gpu = String(gl.getParameter(gl.RENDERER) || ""); } catch (e) { /* blocked */ } }
    // a debugging context can keep a real context alive for the life of the
    // page; throw ours away immediately, we only wanted the string
    const lose = gl.getExtension("WEBGL_lose_context");
    if (lose) lose.loseContext();
  }

  const notes = [];
  // cores: 2 is a very hard floor for this scene. 4 is where we start easing.
  if (out.cores && out.cores <= 2) notes.push("cores " + out.cores);
  else if (out.cores && out.cores <= 4) notes.push("cores " + out.cores);
  if (out.memoryGb && out.memoryGb <= 2) notes.push(out.memoryGb + "GB");
  if (out.gpu && WEAK_GPU.test(out.gpu)) notes.push("gpu " + out.gpu.slice(0, 34));

  // one signal -> drop one tier; two or more -> drop two. Anything we do not
  // recognise gets the full-quality default, because the watchdog is the
  // real safety net and a wrong "weak" guess on a good phone is the expensive
  // mistake to make.
  out.tier = notes.length >= 2 ? 2 : notes.length === 1 ? 1 : 0;
  if (out.ios) {
    // hard floor for the platform, whatever the signals said
    out.tier = Math.max(out.tier, IOS_START_TIER);
    out.ios = true;
  }
  out.antialias = out.tier < 2;
  out.reason = notes.length ? notes.join(" + ") : "no weak signals found";
  return out;
}

/* ---- the manager --------------------------------------------------- */
export function createPerf() {
  const p = probe();

  // ?q=high|medium|low|minimum forces a tier, ?pr=1.25 forces a pixel-ratio
  // cap, and ?lite=1 forces the cheap paths — all three exist so a weak
  // device (or an iPhone) can be diagnosed and pinned without a rebuild
  const q = new URLSearchParams(location.search);
  const forced = q.get("q");
  let tier = p.tier;
  let ratioCap = null;
  let antialias = p.antialias;
  if (forced) {
    const i = TIERS.findIndex(function (t) { return t.name === forced; });
    if (i >= 0) tier = i;
  }
  const pr = parseFloat(q.get("pr"));
  if (pr > 0) ratioCap = pr;
  if (q.get("lite") === "1") tier = Math.max(tier, 2);
  if (forced || pr > 0) antialias = tier < 2;
  // ?preload=0 forces on-demand scene loading, ?preload=1 forces the
  // background preload back on for a device the heuristic was too cautious
  // about. Handy for confirming the memory hypothesis on a real phone.
  let preloadAll = p.preloadAll;
  let preloadForced = null;
  if (q.get("preload") === "0") preloadForced = false;
  if (q.get("preload") === "1") preloadForced = true;

  const startTier = tier;
  // upgrades may climb back up to the tier we launched at, but no higher
  const upgradeLimit = startTier;

  const state = {
    tier: tier,
    startTier: startTier,
    upgradeLimit: upgradeLimit,
    antialias: antialias,
    ratioCap: ratioCap,
    preloadAll: preloadAll,
    preloadForced: preloadForced,
    fps: 0,
    hold: 4.0,          // ignore the first seconds: model decode + texture
                        // upload is janky on EVERY device and must not be
                        // mistaken for a weak GPU
    downFor: 0,
    upFor: 0,
    changes: 0,
    locked: forced != null || pr > 0,
    probe: p,
  };

  // exponential moving average of the frame time: responsive to a real change
  // without flickering on a single slow frame
  let emaMs = 16.7;

  return {
    // --- the flags the rest of the build reads ---
    get tier() { return state.tier; },
    get name() { return TIERS[state.tier].name; },
    // "cheap the CPU work that isn't visible in the layout"
    get lite() { return TIERS[state.tier].lite; },
    get antialias() { return state.antialias; },
    get locked() { return state.locked; },
    get probe() { return state.probe; },
    get changes() { return state.changes; },
    get fps() { return state.fps; },
    // whether every scene may be preloaded in the background. False means
    // scenes load on demand instead, which costs a wait on first entry but
    // keeps peak memory at one scene rather than five. This is the lever for
    // "the tab just died", which frame-rate adaptation cannot fix.
    //
    // The probe decides up front, and the watchdog can veto it later: a device
    // that probes clean but then MEASURES slow is exactly as memory-constrained
    // as one that probed badly, and it is the common case — plenty of cheap
    // hardware reports a healthy core count and plenty of RAM. Lite is
    // reserved for the constrained tiers, which is the point at which the
    // measurement is strong enough to trust over the guess.
    get preloadAll() {
      if (state.preloadForced !== null) return state.preloadForced;
      if (TIERS[state.tier].lite) return false;
      return state.preloadAll;
    },

    // the pixel ratio to hand the renderer: the tier's cap, the manual
    // override if there is one, and never above the device's own ratio
    pixelRatio() {
      const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
      const cap = state.ratioCap != null ? state.ratioCap : TIERS[state.tier].ratio;
      return Math.max(0.5, Math.min(dpr, cap));
    },

    // call once per rendered frame with the frame's dt in seconds
    frame(dt) {
      if (!(dt > 0)) return state.tier;
      // A tab-switch or a GC pause produces an enormous dt that says nothing
      // about rendering cost, and must not be averaged in. This used to be
      // 0.5s — which meant that a device running at 2fps (500ms frames) had
      // EVERY frame discarded as a "stall", so the average never moved, fps
      // stayed 0, and the watchdog never once downgraded it. It was blind
      // precisely when it was needed. A real slow frame is now allowed all
      // the way to 4s; beyond that it genuinely is a pause, not a frame.
      if (dt > 4) return state.tier;
      emaMs += (dt * 1000 - emaMs) * 0.05;
      state.fps = 1000 / emaMs;

      if (state.locked) return state.tier;

      if (state.hold > 0) {
        state.hold -= dt;
        state.downFor = 0;
        state.upFor = 0;
        return state.tier;
      }

      if (state.fps < DOWN_FPS && state.tier < TIER_MAX) {
        state.upFor = 0;
        state.downFor += dt;
        if (state.downFor >= DOWN_HOLD_S) {
          state.tier += 1;
          state.changes += 1;
          state.downFor = 0;
          state.hold = SETTLE_S;
        }
      } else if (state.fps > UP_FPS && state.tier > state.upgradeLimit) {
        state.downFor = 0;
        state.upFor += dt;
        if (state.upFor >= UP_HOLD_S) {
          state.tier -= 1;
          state.changes += 1;
          state.upFor = 0;
          state.hold = SETTLE_S;
        }
      } else {
        state.downFor = 0;
        state.upFor = 0;
      }
      return state.tier;
    },

    // push the watchdog off for a moment (scene loaders, the first seconds)
    settle(seconds) { state.hold = Math.max(state.hold, seconds || 0); },

    setTier(n) {
      state.tier = Math.max(TIER_MIN, Math.min(TIER_MAX, n | 0));
      state.changes += 1;
      state.hold = SETTLE_S;
    },

    info() {
      return {
        tier: state.tier,
        name: TIERS[state.tier].name,
        startTier: state.startTier,
        upgradeLimit: state.upgradeLimit,
        // antialias is FIXED at context creation and is NOT re-decided when the
        // watchdog moves the tier, so this reports the startup choice, not the
        // current tier. Most of the relief on a weak device comes from the pixel
        // ratio anyway: the fragment shader runs once per pixel regardless of
        // sample count, so halving the ratio quarters the shading cost while
        // MSAA mostly costs bandwidth.
        antialias: state.antialias,
        antialiasLocked: true,
        locked: state.locked,
        changes: state.changes,
        fps: +state.fps.toFixed(1),
        pixelRatio: +this.pixelRatio().toFixed(3),
        devicePixelRatio: (window.devicePixelRatio || 1),
        lite: TIERS[state.tier].lite,
        gpu: state.probe.gpu,
        cores: state.probe.cores,
        memoryGb: state.probe.memoryGb,
        reason: state.probe.reason,
        preloadAll: this.preloadAll,
        preloadHint: state.preloadAll,
        memoryNote: state.probe.memoryNote,
      };
    },
  };
}

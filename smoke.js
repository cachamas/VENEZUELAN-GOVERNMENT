/* ------------------------------------------------------------------ */
/*  smoke.js â€” load the site in a real browser and report runtime       */
/*  errors.                                                             */
/*                                                                      */
/*  WHY THIS EXISTS. `node --check` only validates grammar. A module    */
/*  that assigns to an undeclared variable is perfectly valid syntax and */
/*  throws a ReferenceError the first time that line RUNS â€” which, for a */
/*  top-level event handler, is the first time the user touches the      */
/*  page. That is how a refactor that deletes a `let` can look completely */
/*  fine in review and crash on contact.                                 */
/*                                                                      */
/*  Static analysis is not a substitute: a hand-rolled unbound-          */
/*  identifier check over-collects bindings from multi-line object       */
/*  literals and misses real cases. The only trustworthy check is to     */
/*  actually run the thing. So this drives headless Edge over the DevTools */
/*  protocol, loads the page, and reports anything thrown â€” plus it      */
/*  dispatches real input events so the top-level handlers actually      */
/*  execute rather than sitting unexercised.                             */
/*                                                                      */
/*  Usage:  node smoke.js [url] [viewportW] [viewportH]                  */
/* ------------------------------------------------------------------ */

const { spawn } = require("child_process");
const os = require("os");
const path = require("path");
const fs = require("fs");

const URL_ = process.argv[2] || "http://localhost:8000/";
const VW = parseInt(process.argv[3] || "390", 10);
const VH = parseInt(process.argv[4] || "844", 10);

const EDGE_PATHS = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];
const browser = EDGE_PATHS.find((p) => fs.existsSync(p));
if (!browser) { console.error("no chromium browser found"); process.exit(2); }

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-"));
const PORT = 9333 + Math.floor(Math.random() * 400);

const proc = spawn(browser, [
  "--headless=new",
  "--remote-debugging-port=" + PORT,
  "--user-data-dir=" + profile,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-gpu",
  // software GL so WebGL actually works headless; the scenes are all baked
  // emissive materials, so this exercises the same code paths
  "--use-gl=angle",
  "--use-angle=swiftshader",
  "--enable-unsafe-swiftshader",
  // IMPORTANT: without these, headless throttles/deprioritises requestAnimation
  // even while document.hidden is false, and every rAF-driven loop in the build
  // (the dot-matrix displays, the swipe parallax) silently stops running. A
  // crash test that reports "no errors" because the code never executed is
  // worse than no test at all — this exact flag omission hid a real TypeError.
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-background-timer-throttling",
  "--disable-features=CalculateNativeWinOcclusion",
  "--window-size=" + VW + "," + VH,
  "--autoplay-policy=no-user-gesture-required",
  "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function endpoint() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch("http://127.0.0.1:" + PORT + "/json/version");
      const j = await r.json();
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
    } catch (e) { /* not up yet */ }
    await sleep(250);
  }
  throw new Error("browser never exposed a debugging endpoint");
}

function cdp(ws) {
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    } else if (msg.method) {
      listeners.forEach((fn) => fn(msg));
    }
  });
  return {
    send(method, params, sessionId) {
      const mid = ++id;
      const payload = { id: mid, method, params: params || {} };
      if (sessionId) payload.sessionId = sessionId;
      ws.send(JSON.stringify(payload));
      return new Promise((resolve, reject) => pending.set(mid, { resolve, reject }));
    },
    on(fn) { listeners.push(fn); },
  };
}

(async function main() {
  const wsUrl = await endpoint();
  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", j); });
  const c = cdp(ws);

  const { targetId } = await c.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await c.send("Target.attachToTarget", { targetId, flatten: true });

  const problems = [];
  const consoleErrors = [];
  c.on((msg) => {
    if (msg.sessionId !== sessionId) return;
    if (msg.method === "Runtime.exceptionThrown") {
      const d = msg.params.exceptionDetails;
      const desc = (d.exception && (d.exception.description || d.exception.value)) || d.text;
      const where = (d.url || "") + ":" + (d.lineNumber + 1);
      problems.push({ kind: "exception", text: String(desc).split("\n")[0], where });
    }
    if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
      const text = msg.params.args.map((a) => a.description || a.value || a.type).join(" ");
      consoleErrors.push(String(text).split("\n")[0]);
    }
    if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") {
      consoleErrors.push("[log] " + msg.params.entry.text);
    }
  });

  await c.send("Runtime.enable", {}, sessionId);
  await c.send("Log.enable", {}, sessionId);
  await c.send("Page.enable", {}, sessionId);
  await c.send("Emulation.setDeviceMetricsOverride",
    { width: VW, height: VH, deviceScaleFactor: 2, mobile: true }, sessionId);
  await c.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 }, sessionId);

  await c.send("Page.navigate", { url: URL_ }, sessionId);
  // MAIN's controls only unlock at camera frame 450 (~19s at 24fps), and that
  // is exactly when the mute button appears and the menu goes interactive â€”
  // so a short wait would miss the code that actually crashed. Override with
  // SMOKE_WAIT to go further (e.g. 40) to reach a background scene.
  const waitMs = parseInt(process.env.SMOKE_WAIT || "26000", 10);
  await sleep(waitMs);

  // Force lite mode on. The dot-matrix hover dissolve only takes its lite
  // branch in lite mode, and that is where a real crash lived (a throw inside
  // this display's rAF loop), so the interaction below has to happen with lite
  // ON to be worth anything. LITE=0 to skip.
  if (process.env.LITE !== "0") {
    await c.send("Runtime.evaluate",
      { expression: "(window.__viewer.__setLite && __viewer.__setLite(true))", returnByValue: true }, sessionId);
    await sleep(300);
  }

  // Exercise the handlers that are only reached by input. This is the part
  // that catches a deleted declaration in an event listener: nothing above
  // would have executed it.
  const touch = async (type, x, y) => {
    await c.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: type === "touchEnd" ? [] : [{ x, y, id: 1 }],
    }, sessionId);
  };
  const mouse = async (type, x, y) => {
    await c.send("Input.dispatchMouseEvent", { type, x, y, button: "none", clickCount: 0 }, sessionId);
  };

  const before = problems.length;
  // --- the dot-matrix hover dissolve ---
  // Driven through __viewer.__hover, which is the same entry point updateMenus
  // uses. Two details make this actually exercise the transition:
  //  1. park the cursor somewhere no menu is under, so updateMenus stops
  //     re-asserting its own hover every frame and overwriting the value this
  //     loop sets (it calls setOverlayHover itself whenever its hover changes,
  //     so a cursor sitting on a menu makes every scripted hover a no-op)
  //  2. alternate a real label with null — null is the case that broke, and it
  //     is the one a user produces constantly by moving the pointer off a menu
  await mouse("mouseMoved", 4, 4);
  await sleep(200);
  const hoverLabels = ["3D", null, "ART", null, "CLOTHES", null, "MUSIC", null, "ABOUT", null, "CONTACT", null];
  for (const label of hoverLabels) {
    const r = await c.send("Runtime.evaluate", {
      expression: "(window.__viewer.__hover && __viewer.__hover(" + (label === null ? "null" : JSON.stringify(label)) + "))",
      returnByValue: true,
    }, sessionId);
    if (r.exceptionDetails) {
      problems.push({
        kind: "exception",
        text: String(r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text).split("\n")[0],
        where: "hover " + String(label),
      });
    }
    await sleep(120);
  }
  await sleep(400);
  // a tap, a double tap, and a swipe
  await touch("touchStart", VW / 2, VH / 2); await touch("touchEnd", VW / 2, VH / 2);
  await sleep(400);
  await touch("touchStart", VW / 2, VH / 2); await touch("touchEnd", VW / 2, VH / 2);
  await sleep(400);
  // a swipe, so swipeBegin/swipeMove/swipeEnd all run
  await touch("touchStart", 40, VH / 2);
  for (let x = 40; x <= 340; x += 30) { await touch("touchMove", x, VH / 2); await sleep(16); }
  await touch("touchEnd", 340, VH / 2);
  await sleep(600);
  // mouse move, so the desktop parallax branch runs
  for (let i = 0; i < 12; i++) { await mouse("mouseMoved", 20 + i * 28, 200 + i * 20); await sleep(16); }
  await sleep(600);
  // a resize, to exercise syncViewport + the display resync
  await c.send("Emulation.setDeviceMetricsOverride",
    { width: VH, height: VW, deviceScaleFactor: 2, mobile: true }, sessionId);
  await sleep(2500);
  await c.send("Emulation.setDeviceMetricsOverride",
    { width: VW, height: VH, deviceScaleFactor: 2, mobile: true }, sessionId);
  await sleep(1500);

  // ask the page what state it thinks it is in
  let state = null, perf = null;
  try {
    const r = await c.send("Runtime.evaluate", {
      expression: "JSON.stringify({fit: __viewer && __viewer.fitInfo, perf: __viewer && __viewer.perfInfo, state: __viewer && __viewer.state})",
      returnByValue: true,
    }, sessionId);
    state = JSON.parse(r.result.value);
  } catch (e) { state = { error: String(e.message) }; }

  const inputProblems = problems.length - before;

  console.log("=".repeat(64));
  console.log("viewport " + VW + "x" + VH + "  ->  " + URL_);
  console.log("=".repeat(64));
  console.log("exceptions on load : " + (problems.length - inputProblems));
  console.log("exceptions on input: " + inputProblems + "   (menu hover/unhover, tap, double-tap, swipe, mouse, resize)");
  console.log("console errors     : " + consoleErrors.length);
  if (state) {
    console.log("scene              : " + state.state);
    if (state.perf) {
      console.log("perf               : " + state.perf.name + " tier " + state.perf.tier +
        ", ratio " + state.perf.pixelRatio + ", " + state.perf.fps + "fps, lite " + state.perf.lite +
        ", preload " + state.perf.preloadAll);
    }
    if (state.fit) {
      console.log("portrait fit       : aspect " + state.fit.aspect + ", level " + state.fit.level +
        ", fov " + state.fit.fov + " (base " + state.fit.baseFov + ")");
    }
  }
  const all = problems.concat(consoleErrors.map((t) => ({ kind: "console", text: t, where: "" })));
  if (all.length) {
    console.log("\nPROBLEMS:");
    all.slice(0, 25).forEach((p) => console.log("  [" + p.kind + "] " + p.text + (p.where ? "\n        at " + p.where : "")));
    if (all.length > 25) console.log("  ... and " + (all.length - 25) + " more");
  } else {
    console.log("\nno runtime errors");
  }

  try { ws.close(); } catch (e) { /* ignore */ }
  proc.kill();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  process.exit(all.length ? 1 : 0);
})().catch((e) => {
  console.error("harness failed: " + e.message);
  try { proc.kill(); } catch (x) { /* ignore */ }
  process.exit(2);
});

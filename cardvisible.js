/* ------------------------------------------------------------------ */
/*  cardvisible.js - does the CONTACT card actually reach the glass?   */
/*                                                                      */
/*  The card is a separate scene composited AFTER the room, so every    */
/*  one of its own state flags (loaded / OPEN / on-screen) is true     */
/*  while not a single pixel of it is visible. That is the whole       */
/*  failure mode here: the card reports healthy and shows nothing.      */
/*                                                                      */
/*  So this does not read state - it reads PIXELS. For each MAIN camera */
/*  position it grabs the frame with the card closed and the frame     */
/*  with it open, inside the same rAF tick (so the WebGL drawing       */
/*  buffer is still readable with preserveDrawingBuffer:false), and    */
/*  counts how many sampled pixels changed. Zero changed pixels == the */
/*  card is being drawn and then thrown away.                          */
/*                                                                      */
/*  The readback runs in a rAF callback registered AFTER the render    */
/*  loop's own, so it fires later in the same frame, after the render  */
/*  and before the compositor discards the buffer.                     */
/*                                                                      */
/*  Usage: node cardvisible.js [url] [W] [H] [lite|full]              */
/* ------------------------------------------------------------------ */

const { spawn } = require("child_process");
const os = require("os");
const path = require("path");
const fs = require("fs");

const URL_ = process.argv[2] || "http://localhost:8000/";
const VW = parseInt(process.argv[3] || "1280", 10);
const VH = parseInt(process.argv[4] || "800", 10);
const MODE = process.argv[5] || "lite";
const N = 48; // readback grid

const EDGE_PATHS = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
];
const browser = EDGE_PATHS.find((p) => fs.existsSync(p));
if (!browser) { console.error("no chromium browser found"); process.exit(2); }

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "cardvis-"));
const PORT = 9800 + Math.floor(Math.random() * 90);
const proc = spawn(browser, [
  "--headless=new", "--remote-debugging-port=" + PORT, "--user-data-dir=" + profile,
  "--no-first-run", "--no-default-browser-check", "--disable-gpu",
  "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
  "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
  "--disable-background-timer-throttling", "--disable-features=CalculateNativeWinOcclusion",
  "--window-size=" + VW + "," + VH, "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Snapshot the live canvas into a downsampled grid, inside the same frame the
// renderer drew it. Registered after the loop's own rAF, so it runs after it.
const SNAP = `(function () {
  return new Promise(function (res) {
    requestAnimationFrame(function () {
      var src = __viewer.__renderer.domElement;
      var t = document.createElement('canvas');
      t.width = ${N}; t.height = ${N};
      var g = t.getContext('2d', { willReadFrequently: true });
      g.drawImage(src, 0, 0, ${N}, ${N});
      res(Array.prototype.slice.call(g.getImageData(0, 0, ${N}, ${N}).data));
    });
  });
})()`;

(async function main() {
  let wsUrl;
  for (let i = 0; i < 60; i++) {
    try {
      const j = await (await fetch("http://127.0.0.1:" + PORT + "/json/version")).json();
      if (j.webSocketDebuggerUrl) { wsUrl = j.webSocketDebuggerUrl; break; }
    } catch (e) { /* not up yet */ }
    await sleep(250);
  }
  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", j); });
  let id = 0; const pending = new Map();
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id); pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    }
  });
  const send = (method, params, sessionId) => {
    const mid = ++id; const p = { id: mid, method, params: params || {} };
    if (sessionId) p.sessionId = sessionId;
    ws.send(JSON.stringify(p));
    return new Promise((resolve, reject) => pending.set(mid, { resolve, reject }));
  };
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Runtime.enable", {}, sessionId);
  await send("Page.enable", {}, sessionId);
  await send("Emulation.setDeviceMetricsOverride", { width: VW, height: VH, deviceScaleFactor: 1, mobile: VW < VH }, sessionId);
  if (VW < VH) await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 }, sessionId);

  const evalJS = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
    if (r.exceptionDetails) return { __err: String((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text) };
    return r.result.value;
  };

  await send("Page.navigate", { url: URL_ }, sessionId);
  await sleep(parseInt(process.env.WAIT || "12000", 10));
  await evalJS("__viewer.__setLite(" + (MODE === "lite") + ")");
  // open once so the GLB is resident before any measurement
  await evalJS("__viewer.openContact()");
  await sleep(6000);
  await evalJS("__viewer.closeContact(true)");
  await sleep(600);

  console.log("=".repeat(74));
  console.log("CONTACT card visibility - " + MODE + " mode, " + VW + "x" + VH +
    "  (0 changed px = card drawn then thrown away)");
  console.log("=".repeat(74));
  console.log("frame   px changed   of " + (N * N) + "   verdict");

  const frames = (process.env.FRAMES || "0,150,300,450,500,600,720")
    .split(",").map(Number);
  let hidden = 0;
  for (const f of frames) {
    await evalJS("__viewer.seek(" + (f / 24) + ")");
    await sleep(900);
    const a = await evalJS(SNAP);
    await evalJS("__viewer.openContact()");
    await sleep(1600);            // past OPENING (0.9s)
    const b = await evalJS(SNAP);
    const dbg = JSON.parse(await evalJS("JSON.stringify(__viewer.contact())"));
    await evalJS("__viewer.closeContact(true)");
    await sleep(400);

    if (!Array.isArray(a) || !Array.isArray(b)) { console.log(String(f).padStart(5) + "   readback failed"); continue; }
    let changed = 0;
    for (let i = 0; i < a.length; i += 4) {
      if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 18) changed++;
    }
    if (changed === 0) hidden++;
    console.log(String(f).padStart(5) + "   " + String(changed).padStart(8) + "        " +
      (changed === 0 ? "NOT VISIBLE  (state says " + dbg.state + ", fitDist " + dbg.fitDist + ")"
                     : "visible      (state " + dbg.state + ")"));
  }
  console.log("-".repeat(74));
  console.log(hidden + " of " + frames.length + " camera positions render no card at all");

  // ---- the occlusion test -------------------------------------------------
  // Frames alone are a weak check: the fly-through only happens to put a surface
  // inside the card's depth range at some positions, so "visible everywhere I
  // looked" proves very little. This plants a wall directly between the lens and
  // the card and demands the card still shows — which is the card's contract, and
  // the one thing a shared depth buffer silently breaks.
  console.log("");
  console.log("occlusion test - a wall 1m in front of the lens, card at " +
    JSON.parse(await evalJS("JSON.stringify(__viewer.contact())")).fitDist + "m");
  const cases = [];
  for (const mode of ["lite", "full"]) {
    await evalJS("__viewer.__setLite(" + (mode === "lite") + ")");
    await evalJS("__viewer.closeContact(true)");
    await sleep(500);
    // a big opaque slab 1m ahead, parented to the camera so it tracks the view
    const addWall = await evalJS(`(function () {
      try {
        var cam = __viewer.__camera, THREE = __viewer.__THREE;
        if (!cam || !THREE) return "no camera/three";
        var p = new THREE.Mesh(
          new THREE.PlaneGeometry(40, 40),
          new THREE.MeshBasicMaterial({ color: 0xff00ff })
        );
        p.name = "OCCLUDER_TEST_WALL";
        p.position.set(0, 0, -1);
        cam.add(p);
        window.__occluder = p;
        return "added";
      } catch (err) { return "err: " + err.message; }
    })()`);
    if (String(addWall) !== "added") console.log("  (could not plant the wall: " + addWall + ")");
    await sleep(900);
    const a = await evalJS(SNAP);
    await evalJS("__viewer.openContact()");
    await sleep(1800);
    const b = await evalJS(SNAP);
    await evalJS("__viewer.closeContact(true)");
    // note: Object3D.remove() returns the parent, so this must be voided or
    // CDP tries to deep-serialise the whole scene graph back over the wire
    await evalJS("(function(){ if (window.__occluder && window.__occluder.parent) window.__occluder.parent.remove(window.__occluder); window.__occluder = null; return 'removed'; })()");
    await sleep(600);

    if (!Array.isArray(a) || !Array.isArray(b)) { cases.push([mode, "readback failed"]); continue; }
    let changed = 0;
    for (let i = 0; i < a.length; i += 4) {
      if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 18) changed++;
    }
    cases.push([mode, changed]);
  }
  console.log("mode    px changed   verdict");
  let failed = 0;
  for (const [mode, n] of cases) {
    const ok = typeof n === "number" && n > 20;
    if (!ok) failed++;
    console.log(mode.padEnd(7) + String(n).padStart(8) + "        " +
      (ok ? "card still on top - PASS" : "card hidden behind the wall - FAIL"));
  }

  proc.kill();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("harness failed: " + e.message); try { proc.kill(); } catch (x) { /* ignore */ } process.exit(2); });

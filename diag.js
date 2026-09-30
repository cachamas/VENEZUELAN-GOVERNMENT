/* ------------------------------------------------------------------ */
/*  diag.js — walk through the rooms in a real browser and watch memory.  */
/*                                                                      */
/*  Used to find the MUSIC crash: is it a genuine leak (something grows  */
/*  every frame), a one-off spike on entry, or neither? Measures the JS  */
/*  heap, three.js's resource counts, and the draw-call/triangle load    */
/*  over time in each room.                                             */
/*                                                                      */
/*  Usage:  node diag.js [url] [viewportW] [viewportH]                  */
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
];
const browser = EDGE_PATHS.find((p) => fs.existsSync(p));
if (!browser) { console.error("no chromium browser found"); process.exit(2); }

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "diag-"));
const PORT = 9800 + Math.floor(Math.random() * 300);
const proc = spawn(browser, [
  "--headless=new", "--remote-debugging-port=" + PORT, "--user-data-dir=" + profile,
  "--no-first-run", "--no-default-browser-check", "--disable-gpu",
  "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
  "--window-size=" + VW + "," + VH, "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async function main() {
  let wsUrl;
  for (let i = 0; i < 60; i++) {
    try { wsUrl = (await (await fetch("http://127.0.0.1:" + PORT + "/json/version")).json()).webSocketDebuggerUrl; if (wsUrl) break; } catch (e) {}
    await sleep(250);
  }
  if (!wsUrl) throw new Error("no debugging endpoint");
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
  await send("Performance.enable", {}, sessionId);
  await send("Emulation.setDeviceMetricsOverride", { width: VW, height: VH, deviceScaleFactor: 2, mobile: true }, sessionId);
  await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 }, sessionId);

  const errors = [];
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === "Runtime.exceptionThrown" && m.sessionId === sessionId) {
      const d = m.params.exceptionDetails;
      errors.push(String((d.exception && d.exception.description) || d.text).split("\n")[0]);
    }
  });

  const evaluate = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: false }, sessionId);
    if (r.exceptionDetails) return { __err: String(r.exceptionDetails.text) };
    return r.result.value;
  };

  await send("Page.navigate", { url: URL_ }, sessionId);
  await sleep(parseInt(process.env.DIAG_WAIT || "22000", 10));

  // probe: everything we can read out of the running page in one shot
  const PROBE = `JSON.stringify((function(){
    var v = window.__viewer || {};
    var r = v.__renderer;
    var gl = r && r.info;
    return {
      state: v.state,
      heapMB: performance.memory ? +(performance.memory.usedJSHeapSize/1048576).toFixed(1) : null,
      perf: v.perfInfo ? {fps: v.perfInfo.fps, tier: v.perfInfo.name, pr: v.perfInfo.pixelRatio, lite: v.perfInfo.lite} : null,
      gl: gl ? {
        geo: gl.memory.geometries,
        tex: gl.memory.textures,
        calls: gl.render.calls,
        tris: gl.render.triangles,
        progs: gl.programs ? gl.programs.length : null,
      } : null,
    };
  })())`;

  const row = async (label) => {
    const raw = await evaluate(PROBE);
    const o = typeof raw === "string" ? JSON.parse(raw) : raw;
    const mb = o.heapMB == null ? "   n/a" : String(o.heapMB).padStart(6);
    const g = o.gl || {};
    console.log(label.padEnd(22) + mb + "MB  geo " + String(g.geo ?? "?").padStart(4) +
      "  tex " + String(g.tex ?? "?").padStart(4) +
      "  calls " + String(g.calls ?? "?").padStart(5) +
      "  tris " + String(g.tris ?? "?").padStart(8) +
      "  fps " + String(o.perf ? o.perf.fps : "?").padStart(5));
    return o;
  };

  console.log("=".repeat(90));
  console.log("JS heap + renderer load per room   (viewport " + VW + "x" + VH + ")");
  console.log("=".repeat(90));

  const first = await row("MAIN (after load)");
  console.log("  -- entering MUSIC --");
  await evaluate("__viewer.goToScene('MUSIC'); 1");
  await sleep(9000);
  await row("MUSIC t+9s");
  await sleep(9000);
  const m2 = await row("MUSIC t+18s");
  await sleep(9000);
  const m3 = await row("MUSIC t+27s");
  await sleep(9000);
  const m4 = await row("MUSIC t+36s");

  console.log("");
  if (m2.heapMB != null && m4.heapMB != null) {
    const d = m4.heapMB - m2.heapMB;
    console.log("  MUSIC heap from t+9s to t+36s (27s): " + (d >= 0 ? "+" : "") + d.toFixed(1) +
      "MB  -> " + (Math.abs(d) < 3 ? "NOT a leak" : d > 0 ? "GROWING (leak?)" : "shrinking"));
  }

  console.log("\n  now leaving MUSIC (back to MAIN) --");
  await evaluate("__viewer.goToScene('MAIN'); 1");
  await sleep(9000);
  const back = await row("MAIN again");
  if (back.heapMB != null && first.heapMB != null) {
    console.log("  MAIN heap on first visit " + first.heapMB + "MB, after a MUSIC round trip " + back.heapMB + "MB");
  }

  console.log("\nerrors: " + errors.length);
  errors.slice(0, 10).forEach((e) => console.log("  " + e));

  // ---- repeated room cycles: this is the leak signature -----------------
  // Each MAIN -> ROOM -> MAIN trip re-rolls MAIN's decals, which is where a
  // GPU texture used to be stranded every visit. If the fix holds, the texture
  // count should settle instead of climbing by a fixed amount each time.
  console.log("\n" + "=".repeat(90));
  console.log("leak check: repeated MAIN <-> room trips (each re-rolls MAIN's decals)");
  console.log("=".repeat(90));
  const texOf = async () => {
    const raw = await evaluate(PROBE);
    const o = typeof raw === "string" ? JSON.parse(raw) : raw;
    return { tex: o.gl ? o.gl.tex : null, geo: o.gl ? o.gl.geo : null, state: o.state };
  };
  await evaluate("__viewer.goToScene('MAIN'); 1");
  await sleep(8000);
  const base = await texOf();
  console.log("  at MAIN            tex " + String(base.tex).padStart(4) + "   geo " + base.geo);
  const rooms = ["MUSIC", "TORIS", "ART", "CLOTHES", "MUSIC", "TORIS", "ART", "CLOTHES"];
  for (let i = 0; i < rooms.length; i++) {
    await evaluate("__viewer.goToScene('" + rooms[i] + "'); 1");
    await sleep(8000);
    await evaluate("__viewer.goToScene('MAIN'); 1");
    await sleep(8000);
    const t = await texOf();
    console.log("  after " + rooms[i].padEnd(8) + " round trip   tex " + String(t.tex).padStart(4) +
      "   geo " + String(t.geo).padStart(4) + "   delta vs start " +
      (t.tex - base.tex >= 0 ? "+" : "") + (t.tex - base.tex));
  }
  const final = await texOf();
  const grew = final.tex - base.tex;
  console.log("\n  " + rooms.length + " round trips -> texture delta " + (grew >= 0 ? "+" : "") + grew);
  console.log("  " + (grew <= 2 ? "STABLE (leak fixed)" : grew <= rooms.length ? "slow growth, likely bounded" : "STILL LEAKING"));

  try { ws.close(); } catch (e) {}
  proc.kill();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  process.exit(0);
})().catch((e) => {
  console.error("harness failed: " + e.message);
  try { proc.kill(); } catch (x) {}
  process.exit(2);
});

/* crashlog test — does a crash actually get reported, automatically?
 *
 * Simulates a real phone death: the RENDERER for the tab is destroyed with no
 * pagehide, no error event, no clean exit — which is what jetsam does. The
 * localStorage record therefore survives as an unfinished session. Then the
 * site is opened again (same browser profile, so same localStorage) and it
 * should report the previous death by itself.
 *
 * Usage: node crashlogtest.js [url]
 */
const { spawn } = require("child_process");
const os = require("os");
const path = require("path");
const fs = require("fs");

const URL_ = process.argv[2] || "http://localhost:8000/";
const EDGE = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find((p) => fs.existsSync(p));
if (!EDGE) { console.error("no browser"); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "cl-"));
const PORT = 9900 + Math.floor(Math.random() * 90);
const proc = spawn(EDGE, [
  "--headless=new", "--remote-debugging-port=" + PORT, "--user-data-dir=" + profile,
  "--no-first-run", "--no-default-browser-check", "--disable-gpu",
  "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
  "--window-size=390,844", "about:blank",
], { stdio: "ignore" });

(async function main() {
  let wsUrl;
  for (let i = 0; i < 80; i++) {
    try {
      wsUrl = (await (await fetch("http://127.0.0.1:" + PORT + "/json/version")).json()).webSocketDebuggerUrl;
      if (wsUrl) break;
    } catch (e) { /* not up */ }
    await sleep(300);
  }
  if (!wsUrl) throw new Error("no debugging endpoint");

  const sock = new WebSocket(wsUrl);
  await new Promise((r, j) => { sock.addEventListener("open", r); sock.addEventListener("error", j); });
  let id = 0; const pend = new Map();
  sock.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) { const { resolve, reject } = pend.get(m.id); pend.delete(m.id); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); }
  });
  const send = (method, params, sessionId) => {
    const mid = ++id; const p = { id: mid, method, params: params || {} };
    if (sessionId) p.sessionId = sessionId;
    sock.send(JSON.stringify(p));
    return new Promise((resolve, reject) => pend.set(mid, { resolve, reject }));
  };

  // open a fresh tab running the site, sized like a phone
  async function openSite(label) {
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    await send("Runtime.enable", {}, sessionId);
    await send("Page.enable", {}, sessionId);
    await send("Emulation.setDeviceMetricsOverride",
      { width: 390, height: 844, deviceScaleFactor: 3, mobile: true }, sessionId);
    await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 }, sessionId);
    const logs = [];
    sock.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.sessionId !== sessionId) return;
      if (m.method === "Runtime.consoleAPICalled" && m.params.type === "log") {
        const t = m.params.args.map((a) => a.description || a.value || "").join(" ");
        if (t.indexOf("[crashlog]") === 0) logs.push(t);
      }
    });
    await send("Page.navigate", { url: URL_ }, sessionId);
    console.log(label);
    return { targetId, sessionId, logs, ev: async (e) => (await send("Runtime.evaluate", { expression: e, returnByValue: true }, sessionId)).result?.value };
  }

  // ---------------- session 1: live, then the tab is destroyed ----------
  // MODE=exit reproduces the shape the user actually reported: the page dies
  // WHILE LEAVING MUSIC, not inside it. That distinction is the whole point —
  // the room-entry breadcrumb has to survive into the crash report so the log
  // can say "died going out of MUSIC" rather than "died in MUSIC".
  const mode = process.env.MODE || "inside";
  const a = await openSite("SESSION 1  loading the site...");
  await sleep(20000);
  const ev1 = await a.ev("JSON.stringify(__viewer.crashLog)");
  console.log("  heartbeat state:", ev1);
  console.log("  going into MUSIC");
  await a.ev("__viewer.goToScene('MUSIC'); 1");
  await sleep(9000);
  const ev2 = await a.ev("JSON.stringify(__viewer.crashLog)");
  console.log("  in MUSIC:", ev2);
  if (mode === "exit") {
    console.log("  starting the exit back to MAIN, then destroying the tab mid-turn");
    await a.ev("__viewer.goToScene('MAIN'); 1");
    await sleep(700); // mid 1.6s turn
  } else {
    console.log("  destroying the tab (no pagehide = a crash)");
  }
  const ev3 = await a.ev("JSON.stringify(__viewer.crashLog)");
  console.log("  at the moment of death:", ev3);
  // Target.closeTarget tears the renderer down without firing pagehide
  await send("Target.closeTarget", { targetId: a.targetId });
  await sleep(2000);

  // ---------------- session 2: the user opens the site again -------------
  const b = await openSite("\nSESSION 2  the user opens the site again...");
  await sleep(8000);
  console.log("\n  crashlog console output on reopen:");
  b.logs.forEach((l) => console.log("    " + l));

  const st = await b.ev("JSON.stringify(__viewer.crashLog)");
  console.log("\n  new session's own state:", st);

  // a clean exit from this one, so we do not leave a false crash behind
  await b.ev("1");
  try { sock.close(); } catch (e) { /* ignore */ }
  proc.kill();
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  process.exit(0);
})().catch((e) => {
  console.error("harness failed: " + e.message);
  try { proc.kill(); } catch (x) { /* ignore */ }
  process.exit(2);
});

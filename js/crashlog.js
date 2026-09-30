/* ------------------------------------------------------------------ */
/*  crashlog.js — report crashes and hangs back to the dev server        */
/* ------------------------------------------------------------------ */
/*                                                                       */
/*  WHY THIS IS A HEARTBEAT AND NOT AN ERROR REPORTER                     */
/*                                                                       */
/*  The obvious thing — window.onerror — cannot see what is happening to   */
/*  you. It catches JavaScript exceptions: a ReferenceError, a TypeError,  */
/*  a rejected promise. That is genuinely useful (it is how the last one    */
/*  got caught) but it is NOT what a phone dying looks like.               */
/*                                                                       */
/*  When iOS runs out of memory it kills the tab outright — jetsam. The    */
/*  JS context is torn down; no error event fires, nothing is thrown, no   */
/*  handler runs. Same for a GPU process crash, and for the watchdog       */
/*  killing a page that has stopped responding. From inside the page, that  */
/*  death is completely invisible. Which is consistent with what you are    */
/*  seeing: the site does not throw, it just stops.                         */
/*                                                                       */
/*  The only thing on the server side that can see it is a PULSE. The page  */
/*  checks in every couple of seconds; if the pulses simply stop while the  */
/*  page was in the FOREGROUND, the session ended without ending. That is   */
/*  weak evidence on its own — it tells you WHEN and WHERE, not WHY — but    */
/*  combined with which room it was in, it turns "MUSIC kills the iPhone"   */
/*  into "the pulse stops 4.1s after entering MUSIC, 22s into the session".  */
/*  That is a real, timestamped observation on your own hardware, with no    */
/*  console, no cable and no device setup.                                  */
/*                                                                       */
/*  AND IT REPORTS ITSELF. The dead page cannot send anything, so the next  */
/*  time the site opens, it notices the previous session never said goodbye  */
/*  and uploads that automatically. You do not have to do anything: open    */
/*  the site after a crash and it has already told us.                       */
/*                                                                       */
/*  NOT REPORTED AS A CRASH (deliberately, these would be noise):            */
/*                                                                       */
/*    - the page going to the background. iOS freezes and evicts background */
/*      tabs without firing pagehide, so every app switch would otherwise   */
/*      log a fake crash. The last known foreground state is recorded and a  */
/*      session that died while hidden is reported as a plain exit.         */
/*    - a normal reload or navigation, which fires pagehide and says bye.   */
/*    - the very first load, before there is anything to compare against.    */
/*                                                                       */
/*  Everything is local: the log is appended to a file next to serve.py and   */
/*  nothing leaves the machine. If the endpoint is missing (a deploy that   */
/*  does not use this serve.py) every call here fails silently and the site  */
/*  behaves exactly as it would with this file deleted.                      */
/*                                                                       */
/*  DEV-ONLY, AND NOW ENFORCED. This used to key off `?log=off`, which meant */
/*  it was ON BY DEFAULT everywhere — including the public deploy, where    */
/*  serve.py does not exist. Two things followed from that: the console     */
/*  filled with `POST /__log 405` every 2 s, and every visitor was posting   */
/*  their user agent, iOS version, core count, device memory, GPU string and */
/*  screen size to a same-origin endpoint that did not want it.              */
/*                                                                       */
/*  It now requires a loopback or private-LAN hostname, which is what the  */
/*  dev server and the phone-on-the-same-wifi case both are. On the real    */
/*  domain it is off unconditionally and there is no query string that can  */
/*  turn it back on from a visitor's browser.                               */
/* ------------------------------------------------------------------ */

const ENDPOINT = "/__log";
const BEAT_MS = 2000;
const KEY = "portfolio.crashlog.v1";
// loopback, a private-LAN range, or a .local/.localhost name.
//
// The IP alternatives are anchored at BOTH ends deliberately. An earlier
// version used `^(127\.|10\.|192\.168\.|...)` which is a prefix pattern, but
// wrapping it in ^...$ makes it demand the WHOLE hostname be "192." — so
// 192.168.1.179 failed to match and the reporter silently stayed off on the
// wifi address it exists for. Anchoring both ends is also what stops a public
// host that merely begins with digits, like "10.evil.com", from qualifying.
const IS_DEV_HOST = (function () {
  var h = location.hostname;
  if (h === "localhost" || h === "[::1]" || h === "::1") return true;
  if (/\.local$/i.test(h) || /\.localhost$/i.test(h)) return true;
  return /^(?:127\.\d{1,3}\.\d{1,3}\.\d{1,3}|0\.0\.0\.0|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/.test(h);
})();
const ENABLED = IS_DEV_HOST && new URLSearchParams(location.search).get("log") !== "off";

let sessionId = "";
let beatTimer = null;
let lastRoom = null;
let pendingErrors = [];

// ---- device description (coarse, local, diagnostic only) ----
function deviceInfo() {
  var ua = navigator.userAgent || "";
  var coarse = matchMedia("(pointer: coarse)").matches;
  // iOS in particular: version matters a lot for WebGL memory behaviour
  var ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && "ontouchend" in document);
  var m = ua.match(/(?:iPhone )?OS (\d+)[_.](\d+)/);
  return {
    ua: ua.slice(0, 180),
    ios: ios,
    iosVersion: m ? m[1] + "." + m[2] : null,
    touch: coarse,
    cores: navigator.hardwareConcurrency || 0,
    // Chromium only; absent on iOS, which is itself a useful signal
    memoryGb: navigator.deviceMemory || null,
    dpr: window.devicePixelRatio || 1,
    screen: window.innerWidth + "x" + window.innerHeight,
    // max texture size is a decent proxy for the GPU class
    gl: glDescription(),
  };
}

function glDescription() {
  try {
    var c = document.createElement("canvas");
    var gl = c.getContext("webgl2") || c.getContext("webgl");
    if (!gl) return null;
    var dbg = gl.getExtension("WEBGL_debug_renderer_info");
    var r = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    var lose = gl.getExtension("WEBGL_lose_context");
    if (lose) lose.loseContext();
    return String(r || "").slice(0, 90) + " maxTex=" + gl.getParameter(gl.MAX_TEXTURE_SIZE);
  } catch (e) {
    return null;
  }
}

// ---- transport ----
// sendBeacon is the only thing here that survives the page going away, which
// is the entire point. fetch+keepalive is the fallback for the rare engine
// without it. Both are fire-and-forget: nothing waits on the server.
function post(kind, fields) {
  if (!ENABLED) return;
  var body;
  try {
    body = JSON.stringify(Object.assign({
      kind: kind,
      sid: sessionId,
      t: Date.now(),
    }, fields || {}));
  } catch (e) {
    return;
  }
  try {
    if (navigator.sendBeacon) {
      var blob = new Blob([body], { type: "text/plain" });
      if (navigator.sendBeacon(ENDPOINT, blob)) return;
    }
  } catch (e) { /* fall through */ }
  try {
    if (window.fetch) {
      window.fetch(ENDPOINT, {
        method: "POST",
        body: body,
        keepalive: true,
        headers: { "Content-Type": "text/plain" },
      }).catch(function () {});
    }
  } catch (e) { /* give up silently */ }
}

// ---- local record, so the NEXT load can report the last death ----
function readRecord() {
  try {
    var raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null; // private mode / storage disabled
  }
}
function writeRecord(r) {
  try {
    localStorage.setItem(KEY, JSON.stringify(r));
  } catch (e) { /* nothing we can do */ }
}
function clearRecord() {
  try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ }
}

var record = { started: 0, lastBeat: 0, room: null, roomSince: 0, fg: true, beats: 0 };

// ---- lifecycle ----
function beat() {
  if (!ENABLED) return;
  record.lastBeat = Date.now();
  record.beats++;
  var mem = null;
  // Chromium only
  if (performance.memory) {
    mem = {
      usedMB: Math.round(performance.memory.usedJSHeapSize / 1048576),
      limitMB: Math.round(performance.memory.jsHeapSizeLimit / 1048576),
    };
  }
  // Roll the live quality state into the local record on every beat. The
  // session that DIES cannot send anything, so this is the only way the report
  // can say what the device was actually doing when it stopped — reading it at
  // report time instead would capture the NEW page's state, which is
  // meaningless (it was the exact mistake that made the first six crash
  // reports come back with empty scene/fov fields).
  record.quality = qualitySnapshot();
  post("beat", {
    room: record.room,
    fg: record.fg,
    ms: Date.now() - record.started,
    mem: mem,
  });
  writeRecord(record);
}

// cheap snapshot of what the running build thinks about itself
function qualitySnapshot() {
  try {
    var v = window.__viewer;
    if (!v) return null;
    var out = { scene: v.state || null };
    if (v.perfInfo) {
      var p = v.perfInfo;
      out.tier = p.name;
      out.tierIndex = p.tier;
      out.pixelRatio = p.pixelRatio;
      out.lite = p.lite;
      out.antialias = p.antialias;
      out.fps = p.fps;
      out.changes = p.changes;
      out.preloadAll = p.preloadAll;
    }
    if (v.fitInfo) out.fov = v.fitInfo.fov;
    if (v.cardBrief) out.card = v.cardBrief();
    if (v.musicInfo) {
      out.musicInteracted = v.musicInfo.interacted;
      out.musicExiting = v.musicInfo.exiting;
    }
    return out;
  } catch (e) {
    return null;
  }
}

// a one-off breadcrumb for anything worth a line in the log but not worth a
// heartbeat. Breadcrumbs are the difference between "the site was in MAIN" and
// "the card opened, the GLB loaded, the state machine reached OPEN" — which is
// the whole question when something is drawn but never appears.
export function note(kind, fields) {
  if (!ENABLED) return;
  post(kind, Object.assign({ ms: Date.now() - record.started }, fields || {}));
}

function sayBye() {
  if (!ENABLED) return;
  post("bye", { room: record.room, ms: Date.now() - record.started, beats: record.beats });
  clearRecord();
}

// called by main.js whenever the active scene changes
export function setRoom(name) {
  if (!ENABLED || name === lastRoom) return;
  lastRoom = name;
  record.room = name;
  record.roomSince = Date.now();
  // a room transition is the single most useful breadcrumb: it lines the
  // heartbeat up with "which room was it in when the pulse stopped"
  post("room", { room: name, ms: Date.now() - record.started });
  writeRecord(reportCurrent());
}

// A snapshot of whatever the running build already knows about itself, taken
// at the moment the session ends. Read from __viewer rather than threaded
// through from main.js so this module stays independent of the 3D code — and
// the quality tier a device DIED at is one of the more useful facts in the
// whole report ("crashed in MUSIC while at tier floor, lite on").
// Only used as a fallback: the normal path is the quality snapshot rolled into
// the local record on every heartbeat, which describes the session that died.
function atDeathSnapshot() {
  try {
    var v = window.__viewer;
    if (!v) return null;
    var out = { scene: v.state || null };
    if (v.perfInfo) {
      var p = v.perfInfo;
      out.tier = p.name;
      out.pixelRatio = p.pixelRatio;
      out.lite = p.lite;
      out.antialias = p.antialias;
      out.fps = p.fps;
      out.preloadAll = p.preloadAll;
    }
    if (v.fitInfo) out.fov = v.fitInfo.fov;
    if (v.cardBrief) out.card = v.cardBrief();
    if (v.musicInfo) {
      out.musicInteracted = v.musicInfo.interacted;
      out.musicExiting = v.musicInfo.exiting;
    }
    return out;
  } catch (e) {
    return null;
  }
}

export function initCrashLog() {
  if (!ENABLED) {
    // one quiet line, and only on a dev host — production says nothing at all
    if (IS_DEV_HOST) {
      console.log("[crashlog] disabled (?log=off)");
    }
    return;
  }
  sessionId = "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  var dev = deviceInfo();

  // ---- report the PREVIOUS session, if it never said goodbye ----
  var prev = readRecord();
  if (prev && !prev.bye && prev.sid !== sessionId) {
    var wasForeground = prev.fg !== false;
    var alive = Date.now() - (prev.lastBeat || prev.started || 0);
    var hadJsErrors = prev.errors && prev.errors.length;
    // ALWAYS reported, and always as a crash. The foreground flag is attached
    // as data rather than used to suppress: iOS freezes and evicts BACKGROUND
    // tabs, so a session that ends while hidden is probably just an app switch —
    // but this code cannot be certain the flag was still accurate when the
    // process died, and silently dropping what might be the one real crash we
    // are hunting is far worse than logging an extra candidate. The server
    // labels a hidden one "ambiguous" and the log lets us judge.
    var kind = hadJsErrors ? "crash+js" : "crash";
    post(kind, {
      prev: {
        sid: prev.sid,
        room: prev.room,
        // how long it had been in that room when it stopped
        inRoomSec: prev.roomSince ? Math.round(((prev.lastBeat || 0) - prev.roomSince) / 1000) : null,
        started: prev.started,
        lastBeat: prev.lastBeat,
        beats: prev.beats,
        fg: prev.fg,
        errors: prev.errors || [],
        // the DEAD session's own last-known quality state
        quality: prev.quality || null,
      },
      // how long the pulse was silent before this page loaded
      silentMs: alive,
      // "it had been in the foreground when we last heard from it"
      wasForeground: wasForeground,
      reportedBy: dev,
      // only a fallback for when the beat never got to record quality
      atDeath: prev.quality || qualitySnapshot(),
    });
    console.log("[crashlog] reported previous session " + prev.sid +
      " (room " + (prev.room || "?") + ", " + Math.round(alive / 1000) + "s silent, " +
      (wasForeground ? "was in the FOREGROUND" : "was hidden - may just be an app switch") + ")");
  }
  clearRecord();

  // ---- start this session ----
  record = {
    sid: sessionId,
    started: Date.now(),
    lastBeat: Date.now(),
    room: null,
    roomSince: Date.now(),
    fg: !document.hidden,
    beats: 0,
    errors: [],
    bye: false,
  };
  writeRecord(record);

  post("open", { dev: dev });

  // ---- the two things that DO throw ----
  window.addEventListener("error", function (e) {
    var msg = String((e && e.message) || "error") + " @ " +
      (e && e.filename ? e.filename.split("/").pop() + ":" + (e.lineno || "?") : "?");
    record.errors.push(msg);
    if (record.errors.length > 12) record.errors.shift();
    post("jserror", { message: msg.slice(0, 300), room: record.room });
    writeRecord(record);
  });
  window.addEventListener("unhandledrejection", function (e) {
    var r = e && e.reason;
    var msg = "unhandled rejection: " + (r && (r.message || r) ? (r.message || r) : String(r));
    record.errors.push(msg);
    post("jserror", { message: msg.slice(0, 300), room: record.room });
    writeRecord(record);
  });

  // ---- foreground state: the difference between a crash and an app switch ----
  document.addEventListener("visibilitychange", function () {
    record.fg = !document.hidden;
    writeRecord(record);
    // coming back to the foreground is a good moment to prove we are alive
    if (!document.hidden) beat();
  });
  window.addEventListener("pagehide", sayBye);
  // Safari/iOS do not always fire pagehide on a tab kill, which is exactly the
  // case we want to notice, so nothing is done here on purpose.

  // WEBGL CONTEXT LOSS. Nothing in a normal error report can see this: no
  // exception fires, the tab stays alive, the heartbeat keeps arriving on time
  // and every frame just... stops drawing new content. On a device that has been
  // pushed to its memory budget by an incoming GLB, this is the single most
  // plausible "it loaded, the state says OPEN, and nothing is on screen". It has
  // to be listened for explicitly, because the alternative is inferring it from
  // a symptom days later.
  var canvas = document.getElementById("stage");
  if (canvas && canvas.addEventListener) {
    canvas.addEventListener("webglcontextlost", function (e) {
      post("webgl", { event: "lost", room: record.room, ms: Date.now() - record.started });
    });
    canvas.addEventListener("webglcontextrestored", function () {
      post("webgl", { event: "restored", room: record.room, ms: Date.now() - record.started });
    });
  }

  beatTimer = setInterval(beat, BEAT_MS);
  beat();
  console.log("[crashlog] session " + sessionId + " -> " + ENDPOINT + " every " + (BEAT_MS / 1000) + "s");
}

// full current state, for a manual "what does it think it is" dump
export function crashLogState() {
  return reportCurrent();
}
function reportCurrent() {
  return {
    sid: sessionId,
    started: record.started,
    lastBeat: record.lastBeat,
    room: record.room,
    fg: record.fg,
    beats: record.beats,
    errors: record.errors || [],
    endpoint: ENABLED ? ENDPOINT : "(disabled)",
  };
}
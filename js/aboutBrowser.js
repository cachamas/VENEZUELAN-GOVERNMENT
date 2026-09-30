/* ABOUT fake-browser overlay: opens the saved spoof wikipedia page inside a
 * single-tab, chrome-style browser window floating above the 3D scene.
 * Every interaction event landing on the window chrome is stopped cold so
 * the scene handlers in main.js never see clicks/drags meant for the OS. */

const FRAME_SRC_EN = "media/ABOUT/vzpreswikipedia.html";
const FRAME_SRC_ES = "media/ABOUT/vzpreswikipedia_es.html";
// the ACKTUAL article is a local satirical page; the address bar shows the
// "real" wikipedia url it is pretending to be. The Spanish article is loaded
// whenever Spanish was chosen at the language gate.
const ADDRESS_EN = "en.wikipedia.org/wiki/Venezuelan_Government_(Artist)";
const ADDRESS_ES = "es.wikipedia.org/wiki/Gobierno_de_Venezuela_(Artista)";

function wikiLang() {
  return window.__PORTFOLIO_LANG__ === "es" ? "es" : "en";
}
function defaultFrameSrc() {
  return wikiLang() === "es" ? FRAME_SRC_ES : FRAME_SRC_EN;
}
function defaultAddress() {
  return wikiLang() === "es" ? ADDRESS_ES : ADDRESS_EN;
}

// true while the frame is still showing the given local page (src). Reading
// the frame's location throws once an inner link has carried it to a real,
// cross-origin wikipedia article, which is how the drift below is detected so
// the satire article is restored whenever the browser is reopened.
function frameOnArticle(src) {
  try {
    const loc = frameEl.contentWindow.location.href;
    if (!loc) return false;
    const want = new URL(src, location.href);
    want.hash = "";
    return loc.split("#")[0] === want.href;
  } catch (err) {
    return false;
  }
}
const CLOSE_MS = 320; // keep in sync with the .ab-window transition

let root = null;
let winEl = null;
let frameEl = null;
let fsBtn = null;
let urlEl = null;
let loaded = false;
let currentSrc = "";
let currentAddress = "";
let hideTimer = 0;

// in-window navigation history for the Back / Forward chrome buttons. Only
// same-origin (local file) navigations can be recorded, which covers exactly
// the journeys that matter: article -> image_format file page -> article.
// Cross-origin jumps (a real wikipedia / external link clicked in the article)
// can't be read, so instead they set onExternal: Back then returns straight to
// the last local page (the article) so you can always get back out.
let backBtn = null;
let fwdBtn = null;
let hist = [];
let histIdx = -1;
let onExternal = false;

// window drag state (offset from its resting centered position)
let dragX = 0;
let dragY = 0;

function $(sel) {
  return root.querySelector(sel);
}

function stopEvent(e) {
  e.stopPropagation();
}

function updateNav() {
  if (!backBtn || !fwdBtn) return;
  // while on a cross-origin page we can't record, Back must stay live (it
  // returns to the article); Forward can only re-walk recorded local pages
  backBtn.disabled = histIdx <= 0 && !onExternal;
  fwdBtn.disabled = onExternal || histIdx >= hist.length - 1;
}

function forgetHistory() {
  hist = [];
  histIdx = -1;
  onExternal = false;
  updateNav();
}

// every local navigation inside the frame lands here (load event). It reads the
// frame's own location and records it as a new history entry unless it is the
// entry we already point at (restoring via Back/Forward, reloads). A load we
// can't read is a cross-origin (real wikipedia / external) page: remember that
// so Back can still jump back to the article.
function recordFrameLoad() {
  if (!loaded || !frameEl) return;
  let loc = "";
  try { loc = frameEl.contentWindow.location.href || ""; } catch (err) { loc = ""; }
  if (!loc) {
    onExternal = true;
    updateNav();
    return;
  }
  onExternal = false;
  if (hist[histIdx] && hist[histIdx].url === loc) return;
  hist = hist.slice(0, histIdx + 1);
  hist.push({ url: loc });
  histIdx = hist.length - 1;
  updateNav();
}

function goBack(e) {
  stopEvent(e);
  if (!frameEl || histIdx < 0) return;
  if (onExternal) {
    // no readable entry for the page we're on, but the one behind it (the
    // article) is known exactly: jump straight back there
    onExternal = false;
    frameEl.src = hist[histIdx].url;
    updateNav();
    return;
  }
  if (histIdx <= 0) return;
  histIdx--;
  frameEl.src = hist[histIdx].url;
  updateNav();
}

function goForward(e) {
  stopEvent(e);
  if (!frameEl || histIdx >= hist.length - 1) return;
  histIdx++;
  frameEl.src = hist[histIdx].url;
  updateNav();
}

function applyDrag(x, y) {
  dragX = x;
  dragY = y;
  winEl.style.transform = "translate(" + x + "px," + y + "px)";
}

// keep enough of the title bar / body reachable that it can always be
// dragged back or closed
const DRAG_KEEP_VISIBLE = 110;

function initDrag() {
  const strip = $(".ab-tabstrip");
  let pid = -1;
  let sx = 0;
  let sy = 0;
  let ox = 0;
  let oy = 0;
  let minX = 0;
  let maxX = 0;
  let minY = 0;
  let maxY = 0;
  let dist = 0;
  let suppressDbl = false;

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  strip.addEventListener("pointerdown", function (e) {
    if (e.target.closest("button")) return;
    if (root.classList.contains("fs")) return; // parked while fullscreen
    const rect = winEl.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    minX = -(rect.width - DRAG_KEEP_VISIBLE);
    maxX = vw - DRAG_KEEP_VISIBLE;
    minY = 0;
    maxY = vh - Math.min(rect.height, DRAG_KEEP_VISIBLE + 40);
    pid = e.pointerId;
    sx = e.clientX;
    sy = e.clientY;
    ox = dragX;
    oy = dragY;
    dist = 0;
    root.classList.add("dragging");
    strip.setPointerCapture(pid);
  });

  strip.addEventListener("pointermove", function (e) {
    if (e.pointerId !== pid) return;
    const dx = e.clientX - sx;
    const dy = e.clientY - sy;
    dist = Math.max(dist, Math.abs(dx) + Math.abs(dy));
    applyDrag(clamp(ox + dx, minX, maxX), clamp(oy + dy, minY, maxY));
  });

  function endDrag(e) {
    if (e.pointerId !== pid) return;
    pid = -1;
    root.classList.remove("dragging");
    if (dist > 5) {
      // a real drag just happened: don't let the release count as a
      // double-click's first tap for fullscreen purposes
      suppressDbl = true;
      setTimeout(function () { suppressDbl = false; }, 400);
    }
  }
  strip.addEventListener("pointerup", endDrag);
  strip.addEventListener("pointercancel", endDrag);

  // double-click empty tab-strip space toggles fullscreen (unless mid-drag)
  strip.addEventListener("dblclick", function (e) {
    if (suppressDbl || e.target.closest("button")) return;
    toggleFullscreen();
  });
}

function toggleFullscreen() {
  const on = root.classList.toggle("fs");
  fsBtn.setAttribute("aria-pressed", on ? "true" : "false");
  fsBtn.title = on ? "Exit fullscreen" : "Fullscreen";
  // clear any drag offset so the inline transform doesn't fight the
  // fullscreen inset transition (and so re-opening starts centered again)
  applyDrag(0, 0);
}

function initDom() {
  root = document.getElementById("about-browser");
  if (!root) return false;
  winEl = $(".ab-window");
  frameEl = $(".ab-frame");
  fsBtn = $(".ab-winbtn.fs");
  urlEl = $(".ab-url");

  // swallow every interaction aimed at the browser chrome
  [
    "click", "pointerdown", "pointerup", "mousedown", "mouseup",
    "touchstart", "touchmove", "touchend", "dblclick", "wheel",
  ].forEach(function (t) {
    root.addEventListener(t, stopEvent);
  });

  $(".ab-tab-close").addEventListener("click", function () { closeAboutBrowser(); });
  $(".ab-winbtn.close").addEventListener("click", function () { closeAboutBrowser(); });
  $(".ab-reload").addEventListener("click", function () { frameEl.src = currentSrc || defaultFrameSrc(); });
  fsBtn.addEventListener("click", toggleFullscreen);

  // the first two .ab-navbtn are Back and Forward (reload is the third-ish one)
  var navBtns = root.querySelectorAll(".ab-navbtn");
  backBtn = navBtns.length > 0 ? navBtns[0] : null;
  fwdBtn = navBtns.length > 1 ? navBtns[1] : null;
  if (backBtn) backBtn.addEventListener("click", goBack);
  if (fwdBtn) fwdBtn.addEventListener("click", goForward);
  frameEl.addEventListener("load", recordFrameLoad);
  updateNav();

  // drag the window by its tab strip (dblclick-fullscreen handled in there)
  initDrag();

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && isAboutBrowserOpen()) closeAboutBrowser();
  });
  return true;
}

// open the fake-browser overlay. `src` is the local page loaded in the frame;
// `addressUrl` is the satirical wikipedia url shown in the address bar (falls
// back to the default article). Passing a different src reloads the frame.
export function openAboutBrowser(src, addressUrl) {
  if (!root && !initDom()) return;
  clearTimeout(hideTimer);
  const loadedSrc = src || defaultFrameSrc();
  const shownUrl = addressUrl || defaultAddress();
  if (!loaded || loadedSrc !== currentSrc) {
    frameEl.src = loadedSrc;
    currentSrc = loadedSrc;
    loaded = true;
    forgetHistory();
  } else if (!frameOnArticle(loadedSrc)) {
    // reopened after an inner (real wikipedia) link carried the frame away:
    // bring it back to the satire article
    frameEl.src = loadedSrc;
    forgetHistory();
  }
  if (shownUrl !== currentAddress && urlEl) {
    urlEl.textContent = shownUrl;
    currentAddress = shownUrl;
  }
  root.hidden = false;
  // double rAF so the unhide paints before the .open transition starts
  requestAnimationFrame(function () {
    requestAnimationFrame(function () {
      root.classList.add("open");
    });
  });
}

export function closeAboutBrowser() {
  if (!root || !root.classList.contains("open")) return;
  root.classList.remove("open");
  hideTimer = setTimeout(function () { root.hidden = true; }, CLOSE_MS);
}

export function isAboutBrowserOpen() {
  return !!root && root.classList.contains("open");
}

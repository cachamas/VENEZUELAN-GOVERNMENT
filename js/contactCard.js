import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { FONT5x7 } from "./radioDisplay.js";

/* ------------------------------------------------------------------ */
/*  CONTACT calling card — media/CONTACT/contact.glb                   */
/*                                                                     */
/*  Pressing CONTACT raises the card up from the bottom of the screen  */
/*  to center. It is sized so its top/bottom hug the window edges, is  */
/*  spun around Y by sideways drag (revolving door) with a little tilt */
/*  from vertical drag, and softly sways/bobs so it feels alive.       */
/*  Clicking the QR zooms into it; clicking away unzooms; another      */
/*  click puts the card back down.                                     */
/*                                                                     */
/*  The card lives in its OWN scene, pinned to the camera's pose but   */
/*  rendered in a separate pass, so it always sits on top of the room  */
/*  geometry (no occlusion) while the blurred world flows behind it.   */
/*                                                                     */
/*  Set window.__DEBUG_CARD__ = true for an on-screen diagnostic.      */
/* ------------------------------------------------------------------ */

const GLB_PATH = "media/CONTACT/contact.glb";
// up to 7 card variants, files named {n}_es.webp / {n}_en.webp + {n}normal_*.
// one is picked at random when the card loads, and rerolled to another number
// every time the contact section is exited, so re-entering shows another card.
const CARD_COUNT = 7;
const CARD_TEX_BASE = "media/CONTACT/TEXTURES/";
let cardIndex = 1;

function pickCardIndex() {
  if (CARD_COUNT < 2) return;
  const prev = cardIndex;
  do {
    cardIndex = 1 + Math.floor(Math.random() * CARD_COUNT);
  } while (cardIndex === prev);
}

function cardTexturePaths() {
  const lang = langCode() === "en" ? "en" : "es";
  return {
    map: CARD_TEX_BASE + cardIndex + "_" + lang + ".webp",
    normal: CARD_TEX_BASE + cardIndex + "normal_" + lang + ".webp",
  };
}

// timing (seconds) and framing
const OPEN_TIME = 0.9;
const CLOSE_TIME = 0.55;
const ZOOM_TIME = 0.7;
const FIT_FRAC = 0.80;   // card height as a fraction of window height (smaller
// when zoomed out, leaving room under it for the contact strip)
const LIFT_FRAC = 0.102; // 10% lower again, final (was 0.113)
const ZOOM_FRAC = 0.374; // 0.44 minus ~15%: even closer scan of the QR
const MIN_DIST = 0.5;
// generous ceiling: the portrait width fit legitimately asks for a larger
// distance than the old height-only fit ever did, and clamping it back down
// would silently re-introduce the side-cropping this fit exists to prevent
const MAX_DIST = 14;
const ROTATE_SPEED = 0.006; // radians per px of horizontal drag
const PITCH_SPEED = 0.004;  // radians per px of vertical drag (tilt)
const PITCH_CLAMP = 0.35;   // max tilt from vertical drag (~20 deg)
const TILT_MAX = 0.06;      // subtle cursor-follow tilt
const TILT_SMOOTH = 7;      // lerp rate of that tilt (per second)
const SWAY_AMP = 0.035;     // idle sway amplitude (radians)
const SWAY_SPEED = 1.15;
const BOB_AMP = 0.012;      // idle bob amplitude (world units)
const CLICK_MAX_DRAG = 6;   // px of pointer travel still counts as a click
const FLIP_V = true;        // authored face renders mirrored vertically; flip textures

// intro: the card rises showing its BACK, holds it INTRO_BACK_TIME seconds,
// then spins to the QR side over INTRO_FLIP_TIME
const INTRO_BACK_TIME = 4.0;
const INTRO_FLIP_TIME = 0.8;
// How long the card will sit unrevealed waiting for its own artwork before it
// opens on the GLB's baked texture anyway. See the reveal gate in loadCard().
const TEXTURE_REVEAL_TIMEOUT = 5;
// idle auto-rotate: after IDLE_AUTO_DELAY seconds without manipulation the
// card slowly revolves on Y (IDLE_AUTO_SPEED rad/s) to show both faces
const IDLE_AUTO_DELAY = 2.0;
const IDLE_AUTO_SPEED = 0.55;

// normal map strength: original 0.44, reduced 30% -> 0.31
const NORMAL_SCALE = 0.31;

// world-blur behind the card: downsample factor and gaussian tap spread
const BLUR_K = 5;
const BLUR_SPREAD = 2.5;

// card-scene lighting: a directional key (the "style" light), a lower / softer
// fill from the opposite side so the flipped (back) face never goes pitch black,
// plus a stronger ambient. Ambient + fill were bumped ~67% so the flip reads.
const CARD_LIGHT_INTENSITY = 1.955;   // key light, +15% (was 1.7)
const CARD_AMBIENT_INTENSITY = 0.575; // ambient, +15% (was 0.5)
const CARD_LIGHT_POS = [2, 2.45, 4]; // key lowered another ~30% in the world (was y=3.5)
const CARD_FILL_INTENSITY = 0.63;    // second lamp side-by-side, +15% (was 0.55)
const CARD_FILL_POS = [-2.6, 2.2, 3.2];
// brighter lamp while zoomed in on the QR (+15% too, was 2.73)
const CARD_LIGHT_ZOOM_MULT = 3.14;
const CARD_LIGHT_SMOOTH = 6; // per-second lerp when switching between the two

// QR attention pulse: two bright flashes when the zoom settles, hinting it's
// hoverable/clickable (like a scanner "ping")
const QR_PULSE_PEAK = 1.0;     // emissive intensity added at each flash peak
const QR_PULSE_CYCLES = 2;     // number of flashes
const QR_PULSE_SECONDS = 1.7;  // total time of the 2 flashes

/* ------------------------------------------------------------------ */
/*  contact form — same-origin relay, and honest when it is not.         */
/*                                                                       */
/*  WHY THERE IS NO formsubmit.co OR web3forms.com IN THIS FILE          */
/*                                                                       */
/*  The form used to POST straight from the browser to a third-party      */
/*  form host. That put every delivery behind someone else's CORS policy   */
/*  and bot protection, and neither was reliable.                        */
/*                                                                       */
/*  A cross-origin POST needs an Access-Control-Allow-Origin header, so  */
/*  when that host stops sending one the browser blocks it and the form  */
/*  is dead with nothing fixable in this repo. There is also nothing to   */
/*  whitelist: FormSubmit requires no registration and has no account,    */
/*  so there is no settings page on which to allow-list gov.info.ve.      */
/*                                                                       */
/*  And it was never actually CORS. Every route on formsubmit.co was     */
/*  returning Cloudflare 522 - origin unreachable - during testing,      */
/*  which is what the "five minute MESSAGE SENT" was. A 522 sits and      */
/*  retries below TLS before it surfaces, so the stall looked like slow  */
/*  delivery and was really a dead server.                               */
/*                                                                       */
/*  The endpoint below is /api/contact, a Cloudflare Pages Function on    */
/*  the SAME origin as this page. Same-origin means the browser never     */
/*  runs a cross-origin request, so CORS is not consulted at all, and    */
/*  the provider API keys live in server-side environment variables       */
/*  instead of being shipped to every visitor. See functions/api/         */
/*  contact.js for the transports it tries.                              */
/*                                                                       */
/*  The timeout stays because a hung relay is still possible, and the    */
/*  outbox stays because a visitor must never lose an enquiry. Nothing    */
/*  here reports success without a real success response: the bug fixed   */
/*  two commits earlier was exactly that, and the person on the other    */
/*  end of this form may be commissioning work.                           */
/* ------------------------------------------------------------------ */

const FORM_ENDPOINT = "/api/contact";
// Must stay ABOVE the relay's GLOBAL_BUDGET_MS (12000) or the client abandons
// the request before the server can explain what went wrong, and the visitor
// gets a bare "timed out" instead of the real reason. 15s leaves headroom for
// the round trip while still bounding the wait.
const FORM_TIMEOUT_MS = 15000;
const OUTBOX_KEY = "portfolio.contact.outbox.v1";

// AbortSignal.timeout() is Safari 16.4+ / Chrome 103+. This site is opened on
// phones and the manual fallback is two lines, so older iOS gets a real deadline
// rather than a TypeError that would take the whole form down.
function timeoutSignal(ms) {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(ms);
  }
  var c = new AbortController();
  setTimeout(function () { c.abort(); }, ms);
  return c.signal;
}

// One same-origin POST with a real deadline. The status is mapped to a flag the
// UI can distinguish, because a bare "HTTP 502" tells a visitor nothing.
function postForm(msg, honey) {
  return fetch(FORM_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({
      name: msg.name,
      email: msg.email,
      message: msg.message,
      company: honey || "",        // honeypot: must stay empty for a real person
    }),
    signal: timeoutSignal(FORM_TIMEOUT_MS),
  }).then(function (r) {
    return r.json().catch(function () { return {}; }).then(function (res) {
      if (r.ok && (res.success === true || res.success === "true")) return res;
      var err = new Error(String(res.message || "HTTP " + r.status));
      if (r.status === 429) err.rateLimited = true;
      // No relay at this host: either it is not deployed yet, or you are on the
      // local serve.py, which cannot do POST at all and answers 501 (501 and 404
      // both mean "no Pages Function here"). Say so plainly instead of showing a
      // bare status a visitor cannot act on.
      if (r.status === 404 || r.status === 501) err.noRelay = true;
      // "processed, but nothing delivered". The relay answers 200 for this on
      // purpose: Cloudflare REPLACES the body of any 5xx with its own error
      // page, which would throw away the per-transport reasons this needs.
      if (res.delivered === false) err.noRoute = true;
      err.needsActivation = /activat/i.test(err.message);
      throw err;
    });
  });
}

// A single endpoint now, so "deliver" is just "post, once" - but it stays a
// function so the retry and outbox paths have one thing to call.
function deliver(msg, honey) {
  return postForm(msg, honey);
}

/* --- outbox: a message that failed is KEPT, not thrown away --------------
   The visitor may have closed the tab. Anything that did not get a real
   success is parked in localStorage and retried on the next visit, so a
   flaky backend cannot silently cost an enquiry. Cleared only on a
   confirmed success.                                                           */

function outboxRead() {
  try {
    var raw = localStorage.getItem(OUTBOX_KEY);
    var arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}
function outboxWrite(arr) {
  try {
    if (arr.length) localStorage.setItem(OUTBOX_KEY, JSON.stringify(arr.slice(-10)));
    else localStorage.removeItem(OUTBOX_KEY);
  } catch (e) { /* private mode */ }
}
function outboxPush(msg) {
  var arr = outboxRead();
  arr.push({ msg: msg, at: Date.now() });
  outboxWrite(arr);
}
function retryOutbox() {
  var arr = outboxRead();
  if (!arr.length) return Promise.resolve(0);
  return deliver(arr[0].msg).then(function () {
    outboxWrite(arr.slice(1));
    return retryOutbox();
  }).catch(function () {
    // still failing: stop, and keep the queue intact for next time
    return 0;
  });
}

const FORM_SUBJECT = "Portfolio contact";

// direct contact details shown under the card and in the form
const CONTACT_EMAIL = "dm@gov.info.ve";
const CONTACT_PHONE = "+58 424-865-4333";
const CONTACT_DISCORD = "@alejandrote";
const DISCORD_URL = "https://discord.gg/Swnt5xK5Xt";
const INSTAGRAM_URL = "https://www.instagram.com/gob.ve";
const WHATSAPP_URL = "https://wa.me/584248654333";

const S = { HIDDEN: 0, OPENING: 1, OPEN: 2, ZOOM_IN: 3, ZOOMED: 4, ZOOM_OUT: 5, CLOSING: 6 };
const STATE_NAME = ["HIDDEN", "OPENING", "OPEN", "ZOOM_IN", "ZOOMED", "ZOOM_OUT", "CLOSING"];

let loaded = false;
let failed = null;
let renderer = null;
let cardScene = null;  // private scene: card + its rig + its own lights
let rig = null;        // carries the car at the camera's world pose (translation only)
let pivot = null;      // rotation hinge centered on the MODEL CENTER (no bottom-heavy tilt)
let wrapper = null;    // gltf.scene (rotated by baseAlignY + spin + sway)
let cardMesh = null;
let qrMesh = null;
let cardMat = null;
let qrMat = null;
let keyLight = null;   // the single directional light (brightens on zoom)
let baseQrEmissive = null;
let baseQrEmissiveInt = 0;
let qrPulse = 0;       // QR attention-flash timer (seconds); 0 = not pulsing
let formOpen = false;  // message form modal state
let gridEl = null;     // contact strip (long DIRECT MESSAGE bar + symbol row)
let modalEl = null;    // the form modal
let popEl = null;      // centered detail popup (phone / email)
let popKind = null;    // "PHONE" | "EMAIL"
let toastEl = null;
let toastTimer = 0;
let baseAlignY = 0;    // authored card-to-camera facing correction
let qrShiftY = 0;      // zoom Y that puts the QR exactly on screen center

// The strip's bar used to be a fixed pixel width, which on a phone was wider
// than the viewport: the blue plate was cropped at both edges AND the
// dot-matrix label inside it ran off. The bar is now viewport-driven in CSS
// (min of its natural width and the available screen), and the label inside
// scales with it via ledSize's max-width + aspect-ratio. Nothing here needs to
// re-measure on resize — the bar re-flows on its own.
export function resyncContactCardLayout() {
  return;
}

// fitted framing measured from the model
let modelHeight = 1.5;
let modelWidth = 2.2;  // the card is WIDE (a business card), which is what makes
//                        portrait hard: fitting the HEIGHT alone lets the width
//                        run off both sides of a phone screen
let liftY = 0;         // serving the card (10% + 10%) of its height above center
let fitDist = 2.1;     // distance that fits the model to the window height
let riseDist = 2.0;    // how far below screen center it starts/ends
// How much further back the card sits than the plain "fit its height" distance
// needs. 1.0 = exactly fitted; raise it to pull the card away from the lens so
// it reads as an object in the room rather than a fullscreen panel.
const CARD_PUSHBACK = 1.34;
// On a narrow portrait screen the card is fitted to its WIDTH as well (it is the
// wider of the two by far), so the fitting distance becomes the LARGER of the
// two. 1.0 fits the width exactly; a little over that leaves a margin.
const CARD_WIDTH_FIT = 1.06;
// Below this viewport aspect the width fit takes over from the height fit.
const CARD_NARROW_ASPECT = 1.0;

// world-blur pass chain: world -> worldRT -> blurRT -> fullscreen gaussian -> card
let worldRT = null;
let blurRT = null;
let quadScene = null;
let quadCam = null;
let blurQuad = null;
let blurQuadMat = null;
let compositeQuad = null;
let compositeMat = null;
const COMPOSITE_VERT = [
  "varying vec2 vUv;",
  "void main(){",
  "  vUv = uv;",
  "  gl_Position = vec4(position.xy, 0.0, 1.0);",
  "}",
].join("\n");
const COMPOSITE_FRAG = [
  "uniform sampler2D tBlur;",
  "uniform vec2 texel;",
  "varying vec2 vUv;",
  "void main(){",
  "  vec3 acc = vec3(0.0);",
  "  float sw = 0.0;",
  "  for (int i = -1; i <= 1; i++) {",
  "    for (int j = -1; j <= 1; j++) {",
  "      vec2 off = vec2(float(i), float(j)) * texel * " + BLUR_SPREAD.toFixed(2) + ";",
  "      float w = exp(-dot(vec2(float(i), float(j)), vec2(float(i), float(j))) * 1.0);",
  "      acc += texture2D(tBlur, vUv + off).rgb * w;",
  "      sw += w;",
  "    }",
  "  }",
  "  gl_FragColor = vec4(acc / sw, 1.0);",
  "}",
].join("\n");

let state = S.HIDDEN;
let t = 0;
let dur = 0;
let fromY = 0;
let toY = 0;
let fromDist = 0;
let toDist = 0;
let cy = 0;          // current camera-local Y offset
let cd = OPEN_().dist; // current camera-local distance
let animT = 0;       // idle-animation clock (sway / bob)
let rotY = 0;        // accumulated "revolving door" spin
let rotX = 0;        // accumulated tilt from vertical drag
let tiltX = 0;       // smoothed cursor-follow tilt
let tiltY = 0;
let mouseNdcX = 0;
let mouseNdcY = 0;
let introFlip = 0;   // 1 = intro holding the BACK face, eased back to 0 (front)
let introTimer = 0;  // s the back has been held during this intro
let idleTimer = 0;   // s since last manipulation -> IDLE_AUTO_DELAY then slow spin
let autoY = 0;       // accumulated slow auto-rotation (radians)
let returnFront = false; // easing all spin/tilt back to the QR-facing front
let pendingOpen = false;
let active = false;
let cameraRef = null;

let dragId = null;
let dragLastX = 0;
let dragLastY = 0;
let dragMove = 0;
// SWIPE MOMENTUM. A finger flick carries velocity that a 1:1 drag mapping
// throws away, so the release velocity is captured and bled off over the next
// second — the card coasts to a stop like a real object on a turntable rather
// than stopping dead under the thumb. spinY is radians/second.
let dragVelX = 0;   // smoothed pointer velocity, px/s (positive = rightward)
let dragVelY = 0;   // smoothed pointer velocity, px/s (positive = downward)
let dragSampleT = 0; // timeStamp of the last pointermove sample, seconds
let spinY = 0;      // live spin, rad/s
let spinX = 0;      // live tilt velocity, rad/s
const SPIN_DECAY = 2.6;  // how fast momentum bleeds off (1/s)
const SPIN_MAX = 9;      // rad/s ceiling, so a hard flick can't turn it silly
const SWIPE_GAIN = 1.0;  // px/s -> rad/s conversion for the flick
const TOUCH_GAIN = 1.7;  // touch drags rotate faster per px than a mouse

const texCache = { key: null, map: null, normal: null };

const raycaster = new THREE.Raycaster();
const pointerV = new THREE.Vector2();

const _tmpV = new THREE.Vector2();
const _tmpV3 = new THREE.Vector3();
const _box = new THREE.Box3();
const _centerV = new THREE.Vector3();

// on-screen diagnostics (window.__DEBUG_CARD__ = true)
let debugEl = null;

function OPEN_() { return { dist: 2.1 }; }

function easeOut(p) { return 1 - Math.pow(1 - p, 3); }

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

function langCode() {
  return (typeof window !== "undefined" && window.__PORTFOLIO_LANG__) || "es";
}

function begin(ns, nY, nD, time) {
  fromY = cy;
  fromDist = cd;
  toY = nY;
  toDist = nD;
  state = ns;
  t = 0;
  dur = time;
}

function applyPose() {
  const bob = Math.sin(animT * SWAY_SPEED * 1.4) * BOB_AMP;
  const intro = Math.PI * introFlip; // intro flip now revolves the other way
  pivot.position.set(0, cy + bob, -cd);
  pivot.rotation.set(
    rotX + tiltX + Math.sin(animT * SWAY_SPEED * 1.23 + 1.7) * SWAY_AMP,
    baseAlignY + rotY + tiltY + autoY + intro + Math.sin(animT * SWAY_SPEED) * SWAY_AMP,
    Math.sin(animT * SWAY_SPEED * 0.77 + 3.1) * SWAY_AMP * 0.5
  );
}

function cardLive() { return state === S.OPEN || state === S.ZOOMED; }

// Keep an angle in (-PI, PI]. Needed because a mid-intro grab now folds the
// remaining intro flip into rotY (see the pointerdown handler), and without a
// wrap that would add up to a full half-turn every time someone catches the
// back face. Wrapping by 2*PI is visually a no-op - it lands on the same
// orientation - so this only stops the number growing without bound.
function wrapAngle(a) {
  a = a % (Math.PI * 2);
  if (a > Math.PI) a -= Math.PI * 2;
  else if (a <= -Math.PI) a += Math.PI * 2;
  return a;
}

// Hand the intro's remaining flip to the drag, instead of throwing it away.
//
// The intro holds the BACK face for INTRO_BACK_TIME (4s) with introFlip pinned
// at 1, then decays it to 0 over INTRO_FLIP_TIME. applyPose() adds
// `Math.PI * introFlip` to the pivot's Y rotation, so during that hold the
// card sits a full 180 degrees around from the QR side.
//
// Zeroing introFlip on grab - which is what this used to do - therefore yanked
// the card through that 180 degrees in a single frame. Catching the back face
// during the hold, which is the most natural thing to do, produced a visible
// snap to the front that had nothing to do with where the finger went.
//
// Moving the remaining angle into rotY instead leaves the total Y rotation
// exactly as it was, so the pose does not change on the frame of the grab and
// the drag/physics simply continues from the angle the card was already at.
// The flip animation is genuinely abandoned rather than fast-forwarded: the
// card stays where the visitor put it, and the idle revolve takes over from
// there.
function absorbIntroFlip() {
  if (introFlip <= 0) return;
  rotY = wrapAngle(rotY + Math.PI * introFlip);
  introFlip = 0;
}

// Distance that frames the card. Two constraints compete:
//   height — the card fills FIT_FRAC of the window height (the desktop rule)
//   width  — on a portrait phone the card is much wider than it is tall, so
//            fitting height alone pushes its left and right edges off screen
// The distance that satisfies BOTH is the larger of the two, so below the
// aspect breakpoint the width fit takes over automatically. CARD_PUSHBACK then
// eases the camera back a little further so the card sits in the room instead
// of filling it — this is the "card a bit further away" tune.
function computeFrame() {
  if (!cameraRef || !(cameraRef.fov > 0)) { fitDist = 2.1; riseDist = 2.0; return; }
  const halfAng = Math.tan(THREE.MathUtils.degToRad(cameraRef.fov / 2));
  if (!(halfAng > 0)) { fitDist = 2.1; riseDist = 2.0; return; }
  const distH = modelHeight / (2 * FIT_FRAC * halfAng);
  // horizontal half-angle: same lens, narrowed by the viewport aspect
  const halfW = halfAng * Math.max(0.05, cameraRef.aspect);
  const distW = modelWidth / (2 * CARD_WIDTH_FIT * halfW);
  // blend rather than switch, so a resize across the breakpoint doesn't jump
  const narrow = clamp((CARD_NARROW_ASPECT - cameraRef.aspect) / 0.35, 0, 1);
  fitDist = Math.max(distH, distH + (distW - distH) * narrow) * CARD_PUSHBACK;
  fitDist = clamp(fitDist, MIN_DIST, MAX_DIST);
  riseDist = fitDist * halfAng * 1.35;
}

function faceAngle() {
  // The card is a thin slab. Its front/back ambiguity is resolved by the QR's
  // own "up" axis (the QR's local geometry is a flat plane, so its Y after
  // the node transform is the outward normal — i.e. the face the QR is
  // printed on). Find the Y-rotation that swings that normal onto -Z (the
  // lens axis) so the QR-bearing side always faces us.
  let n;
  if (qrMesh) {
    const q = new THREE.Quaternion();
    qrMesh.getWorldQuaternion(q);
    n = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
  } else {
    n = new THREE.Vector3(1, 0, 0);
  }
  n.y = 0;
  if (n.lengthSq() < 1e-6) return 0;
  n.normalize();
  return Math.atan2(n.x, -n.z);
}

function qrShift() {
  const q = new THREE.Vector3();
  qrMesh.getWorldPosition(q);
  // the wrapper was slid so the model center sits at the pivot origin, so the
  // QR's Y here is its offset from the model center; moving the pivot by the
  // negated offset puts the QR exactly on screen center
  return -q.y;
}

function flipV(tex) {
  if (!tex) return;
  tex.repeat.set(1, -1);
  tex.offset.set(0, 1);
  tex.needsUpdate = true;
}

function applyFlip(mat) {
  if (!mat || !FLIP_V) return;
  [mat.map, mat.normalMap, mat.alphaMap, mat.aoMap].forEach(flipV);
}

function setupCardLighting() {
  // directional key (the "style" light) + faint ambient so the reverse face is
  // never pure black while spinning
  keyLight = new THREE.DirectionalLight(0xffffff, CARD_LIGHT_INTENSITY);
  keyLight.position.set(CARD_LIGHT_POS[0], CARD_LIGHT_POS[1], CARD_LIGHT_POS[2]);
  cardScene.add(keyLight);
  // second lamp, side-by-side on the opposite side, so the flipped back face
  // keeps some ink instead of falling into pitch black
  const fillLight = new THREE.DirectionalLight(0xffffff, CARD_FILL_INTENSITY);
  fillLight.position.set(CARD_FILL_POS[0], CARD_FILL_POS[1], CARD_FILL_POS[2]);
  cardScene.add(fillLight);
  cardScene.add(new THREE.AmbientLight(0xffffff, CARD_AMBIENT_INTENSITY));
}

function switchCardTexture(onSettled) {
  if (!cardMat) { if (onSettled) onSettled(); return; }
  const t = cardTexturePaths();
  const key = (t.map + "|" + t.normal);
  // already holding exactly this design: nothing to wait for
  if (texCache.key === key) { if (onSettled) onSettled(); return; }
  let settled = false;
  const settle = function () {
    if (settled) return;
    settled = true;
    if (onSettled) onSettled();
  };
  new THREE.TextureLoader().load(t.map, function (tex) {
    tex.colorSpace = THREE.SRGBColorSpace;
    if (cardMat.map) cardMat.map.dispose();
    cardMat.map = tex;
    flipV(tex);
    cardMat.needsUpdate = true;
    texCache.map = tex;
    settle();
  }, undefined, function () {
    // a failed design must not strand the caller waiting forever
    console.warn("[contact] design texture failed:", t.map);
    settle();
  });
  new THREE.TextureLoader().load(t.normal, function (tex) {
    if (cardMat.normalMap) cardMat.normalMap.dispose();
    cardMat.normalMap = tex;
    cardMat.normalScale.set(NORMAL_SCALE, NORMAL_SCALE);
    flipV(tex);
    cardMat.needsUpdate = true;
    texCache.normal = tex;
  });
  texCache.key = key;
}

function buildQuads() {
  quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  quadScene = new THREE.Scene();
  const geo = new THREE.PlaneGeometry(2, 2);
  blurQuadMat = new THREE.MeshBasicMaterial({
    map: null,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  blurQuad = new THREE.Mesh(geo, blurQuadMat);
  blurQuad.frustumCulled = false;
  compositeMat = new THREE.ShaderMaterial({
    uniforms: {
      tBlur: { value: null },
      texel: { value: new THREE.Vector2(0, 0) },
    },
    vertexShader: COMPOSITE_VERT,
    fragmentShader: COMPOSITE_FRAG,
    depthTest: false,
    depthWrite: false,
  });
  compositeQuad = new THREE.Mesh(geo, compositeMat);
  compositeQuad.frustumCulled = false;
  quadScene.add(blurQuad);
}

function ensurePassTargets() {
  const size = renderer.getDrawingBufferSize(_tmpV);
  const w = Math.max(2, Math.floor(size.x));
  const h = Math.max(2, Math.floor(size.y));
  if (!worldRT) {
    worldRT = new THREE.WebGLRenderTarget(w, h, rtOpts());
    blurRT = new THREE.WebGLRenderTarget(Math.max(2, Math.floor(w / BLUR_K)), Math.max(2, Math.floor(h / BLUR_K)), rtOpts());
    quadScene.add(compositeQuad);
  } else if (worldRT.width !== w || worldRT.height !== h) {
    worldRT.setSize(w, h);
    blurRT.setSize(Math.max(2, Math.floor(w / BLUR_K)), Math.max(2, Math.floor(h / BLUR_K)));
  }
  compositeMat.uniforms.texel.value.set(1 / blurRT.width, 1 / blurRT.height);
}

function rtOpts() {
  return {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: false,
    depthBuffer: true,
  };
}

function loadCard() {
  new GLTFLoader().load(
    GLB_PATH,
    function (gltf) {
      wrapper = gltf.scene;
      cardMesh = null;
      qrMesh = null;
      wrapper.traverse(function (o) {
        if (!o.isMesh) return;
        if (o.name === "CARD") cardMesh = o;
        else if (o.name === "QR") qrMesh = o;
      });
      if (!cardMesh) {
        failed = "CARD mesh not found";
        console.error("[contact] " + failed);
        return;
      }
      wrapper.updateMatrixWorld(true);
      // measure the whole model (card + QR) in wrapper space, then slide the
      // wrapper so the model center lands exactly on the pivot origin (level
      // rotation hinge)
      _box.setFromObject(wrapper);
      _box.getCenter(_centerV);
      wrapper.position.set(-_centerV.x, -_centerV.y, -_centerV.z);
      wrapper.updateMatrixWorld(true);
      const rawX = _box.max.x - _box.min.x;
      const rawY = _box.max.y - _box.min.y;
      const rawZ = _box.max.z - _box.min.z;
      modelHeight = Math.max(0.1, rawY);
      baseAlignY = faceAngle();
      // WIDTH, measured in the frame the card is actually PRESENTED in.
      //
      // This used to be the model's raw X extent, which is simply the wrong
      // axis: contact.glb is authored with the card lying in the YZ plane, so
      // its X extent is the slab's THICKNESS (measured 0.1 units, which then
      // hit the Math.max(0.1, …) floor and reported exactly 0.1) while its real
      // on-screen width comes from Z (about 0.84). The width fit was therefore
      // being handed the thickness and could never bind — CARD_WIDTH_FIT and
      // CARD_NARROW_ASPECT were dead code, on exactly the narrow portrait
      // screens they were written for.
      //
      // baseAlignY is a rotation about Y, so rotating the box into the facing
      // frame mixes only X and Z and leaves the height alone. For an
      // axis-aligned box that is exactly |cos|·X + |sin|·Z.
      const ca = Math.abs(Math.cos(baseAlignY));
      const sa = Math.abs(Math.sin(baseAlignY));
      modelWidth = Math.max(0.1, ca * rawX + sa * rawZ);
      liftY = modelHeight * LIFT_FRAC;
      qrShiftY = qrMesh ? qrShift() : 0;
      cardMat = Array.isArray(cardMesh.material) ? cardMesh.material[0] : cardMesh.material;
      if (qrMesh) {
        qrMat = qrMesh.material;
        if (Array.isArray(qrMat)) qrMat = qrMat[0];
        baseQrEmissive = qrMat.emissive ? qrMat.emissive.clone() : null;
        baseQrEmissiveInt = qrMat.emissiveIntensity || 0;
      }
      applyFlip(cardMat);
      applyFlip(qrMat);
      pivot.add(wrapper);
      setupCardLighting();
      pickCardIndex();

      // THE REVEAL WAITS FOR THE DESIGN.
      //
      // `loaded = true` used to fire here, the moment the GLB arrived, so the
      // card became visible wearing whatever texture is baked into contact.glb
      // while the real, randomly-chosen design was still downloading as a
      // separate request. Measured cold at 3 Mbit/s: on screen from 11.5s, the
      // intended design not live until 37.8s - 26 seconds of the wrong face.
      // On a fast machine that same window is the "half a second of weird
      // texture" that reads like a UV glitch; on a phone it can easily outlast
      // the visit, which is why it looked like the flip never corrected.
      //
      // So the card is not revealed until its own artwork is actually applied.
      // It can never wait forever though: a 404, a dropped connection or a
      // wedged image decode falls through to the baked texture after
      // TEXTURE_REVEAL_TIMEOUT, because a card that refuses to open is worse
      // than a card that opens on the wrong picture.
      let revealed = false;
      const reveal = function () {
        if (revealed) return;
        revealed = true;
        clearTimeout(revealTimer);
        loaded = true;
        console.log("[contact] card ready h=" + modelHeight.toFixed(3) + " w=" + modelWidth.toFixed(3) +
          " (raw box " + rawX.toFixed(3) + "x" + rawY.toFixed(3) + "x" + rawZ.toFixed(3) + ")" +
          " liftY=" + liftY.toFixed(3) +
          " alignY=" + baseAlignY.toFixed(3) + " qrShiftY=" + qrShiftY.toFixed(3));
        if (pendingOpen) {
          pendingOpen = false;
          startOpening();
        }
      };
      const revealTimer = setTimeout(function () {
        console.warn("[contact] design texture slow or unavailable; revealing on the baked texture");
        reveal();
      }, TEXTURE_REVEAL_TIMEOUT * 1000);
      switchCardTexture(reveal);
    },
    undefined,
    function (err) {
      failed = Boolean(err);
      console.error("[contact] load failed", err);
    }
  );
}

function startOpening() {
  rig.visible = true;
  computeFrame();
  switchCardTexture();
  begin(S.OPENING, liftY, fitDist, OPEN_TIME);
  // a fresh open ALWAYS plays the intro and faces the QR side dead-on: reset
  // any spin/tilt a previous drag (or the slow auto-revolve) left behind, so
  // a fast close + re-enter never resurrects a sideways pose
  rotY = 0;
  rotX = 0;
  tiltX = 0;
  tiltY = 0;
  autoY = 0;
  // intro: hold the BACK face up, flip to the QR side after INTRO_BACK_TIME
  introFlip = 1;
  introTimer = 0;
  idleTimer = 0;
  returnFront = false;
}

/* ------------------------------ public API ------------------------------ */

export function initContactCard(rend) {
  renderer = rend;
  cardScene = new THREE.Scene();
  rig = new THREE.Object3D();
  rig.name = "CONTACT_CARD_RIG";
  rig.matrixAutoUpdate = false;
  rig.visible = false;
  cardScene.add(rig);
  pivot = new THREE.Object3D();
  pivot.name = "CONTACT_CARD_PIVOT";
  rig.add(pivot);
  buildQuads();
  // WARM THE CARD NOW, not when it is first clicked.
  //
  // loadCard() used to be reached only through openContactCard(), so the very
  // first tap on CONTACT started a 462 KB GLB download and then, once that
  // arrived, a SECOND round trip for the design textures (452 KB of webp). Two
  // sequential fetches, both started at the moment of the click, both competing
  // with the 10.7 MB MAIN scene. Measured cold at 3 Mbit/s that left the card
  // waiting ~30 s for artwork it needed before it could be revealed.
  //
  // Starting it here overlaps that with the room loading instead, so by the
  // time anyone clicks CONTACT the geometry and the artwork are usually
  // already in. It is a background fetch: loadCard() is fire-and-forget and
  // sets loaded/pendingOpen itself, so a visitor who clicks during the load
  // still waits for it rather than getting an empty card.
  if (!wrapper) loadCard();
  // Flush anything a previous visit could not confirm. Fire-and-forget: this
  // is background repair, and nothing the visitor is doing should wait on it.
  retryOutbox();
}

export function ensureContactCard(cam) {
  cameraRef = cam;
  if (loaded || wrapper) return;
  loadCard();
}

export function openContactCard(cam) {
  if (!cam) return;
  ensureContactForm();
  active = true;
  updateContactPad();
  cameraRef = cam;
  if (!wrapper) ensureContactCard(cam);
  if (!loaded) { pendingOpen = true; return; }
  // a re-open while an earlier close is still animating (rapid exit/re-enter)
  // behaves like a fresh visit: restart the full open animation instead of
  // letting the old close run to hidden with the card never coming back
  if (state !== S.HIDDEN && state !== S.CLOSING && state !== S.ZOOM_OUT) return;
  startOpening();
}

export function closeContactCard(instant) {
  active = false;
  pendingOpen = false;
  returnFront = false;
  // reroll to another card number so the next visit shows a different design
  pickCardIndex();
  if (!wrapper || state === S.HIDDEN) return;
  if (instant) {
    state = S.HIDDEN;
    rig.visible = false;
    return;
  }
  if (state === S.ZOOMED || state === S.ZOOM_IN) begin(S.ZOOM_OUT, liftY, fitDist, ZOOM_TIME);
  else begin(S.CLOSING, liftY - riseDist, fitDist, CLOSE_TIME);
}

export function isContactCardOpen() {
  return state !== S.HIDDEN;
}

export function stepContactCard(dt) {
  if (loaded && rig && cameraRef) {
    // pin the card to the active camera's pose every frame
    cameraRef.updateMatrixWorld(true);
    rig.matrix.copy(cameraRef.matrixWorld);
  }
  // strip visibility follows the "active" flag (set the instant CONTACT is
  // selected) even while the card is still loading / not yet out
  updateContactPad();
  if (!wrapper || state === S.HIDDEN) return;
  animT += dt;
  // gentle cursor-follow tilt (dropped while dragging so drag owns the pose)
  const aiming = dragId === null;
  const tgtX = aiming ? -mouseNdcY * TILT_MAX : 0;
  const tgtY = aiming ? mouseNdcX * TILT_MAX : 0;
  const k = 1 - Math.exp(-TILT_SMOOTH * dt);
  tiltX += (tgtX - tiltX) * k;
  tiltY += (tgtY - tiltY) * k;

  t += dt;

  // intro flip: hold the BACK face INTRO_BACK_TIME s, then spin to the QR side
  introTimer += dt;
  if (introFlip > 0 && introTimer >= INTRO_BACK_TIME) {
    introFlip = Math.max(0, introFlip - dt / INTRO_FLIP_TIME);
  }

  // idle slow Y rotation: after IDLE_AUTO_DELAY s without manipulation the
  // card slowly revolves so both faces cycle past the camera
  let handHeld = dragId !== null || formOpen || returnFront || (popEl && !popEl.hidden);
  if (state === S.OPEN && !handHeld && introFlip <= 0) {
    idleTimer += dt;
  } else if (handHeld) {
    idleTimer = 0;
  }
  let auto = state === S.OPEN && !handHeld && idleTimer >= IDLE_AUTO_DELAY;
  if (auto) {
    // passive revolve scrolls left -> right: negative Y rotation
    autoY = (autoY - IDLE_AUTO_SPEED * dt) % (Math.PI * 2);
  } else {
    const k = 1 - Math.exp(-5 * dt);
    autoY += (0 - autoY) * k;
  }

  // SWIPE MOMENTUM: once the finger is up (and no pointer is down), bleed the
  // captured flick velocity off exponentially. Runs only while the card is
  // live and nobody is holding it, and is skipped entirely while the card is
  // easing itself back to the front so the two never fight over rotY/rotX.
  const coasting = dragId === null && cardLive() && !returnFront && !formOpen;
  if (coasting && (Math.abs(spinY) > 1e-4 || Math.abs(spinX) > 1e-4)) {
    const decay = Math.exp(-SPIN_DECAY * dt);
    spinY *= decay;
    spinX *= decay;
    rotY += spinY * dt;
    rotX = clamp(rotX + spinX * dt, -PITCH_CLAMP, PITCH_CLAMP);
    applyPose();
    if (Math.abs(spinY) <= 1e-4) spinY = 0;
    if (Math.abs(spinX) <= 1e-4) spinX = 0;
  } else if (dragId !== null || !cardLive() || returnFront || formOpen) {
    // grabbing the card (or closing it) kills any leftover coast immediately,
    // so a new touch never fights momentum still in flight
    spinY = 0;
    spinX = 0;
  }

  // "go straight to the front": a card click (not the QR) eases every acquired
  // spin/tilt back so the QR side faces us again. Never closes the card.
  if (returnFront) {
    const k = 1 - Math.exp(-4 * dt);
    rotY += (0 - rotY) * k;
    rotX += (0 - rotX) * k;
    autoY += (0 - autoY) * k;
    if (introFlip > 0) introFlip = Math.max(0, introFlip - dt / INTRO_FLIP_TIME);
    if (Math.abs(rotY) < 0.02 && Math.abs(rotX) < 0.02 &&
        Math.abs(autoY) < 0.02 && introFlip <= 0) {
      rotY = 0; rotX = 0; autoY = 0; returnFront = false;
    }
  }

  if (cardLive()) {
    cy = state === S.ZOOMED ? qrShiftY : liftY;
    cd = state === S.ZOOMED ? (fitDist * ZOOM_FRAC) : fitDist;
    applyPose();
  } else {
    const p = Math.min(1, t / dur);
    const e = easeOut(p);
    cy = fromY + (toY - fromY) * e;
    cd = fromDist + (toDist - fromDist) * e;
    applyPose();
    if (p >= 1) {
      if (state === S.OPENING) state = S.OPEN;
      else if (state === S.ZOOM_IN) { state = S.ZOOMED; qrPulse = 0; }
      else if (state === S.ZOOM_OUT) state = S.OPEN;
      else if (state === S.CLOSING) { state = S.HIDDEN; rig.visible = false; }
    }
  }
  updateCardLighting(dt);
  updateQrPulse(dt);
  updateHoverCursor();
  updateDebug();
}

// the contact strip rides bottom-center while the card is up. It appears the
// instant CONTACT is selected (even mid-load) and disappears again as soon as
// the card starts going back down (CLOSING), so the section fully clears out.
function updateContactPad() {
  if (!gridEl) return;
  const closing = state === S.CLOSING || state === S.HIDDEN;
  const show = active && !closing;
  gridEl.classList.toggle("cc-on", show);
}

// lamp gets noticeably brighter while zoomed in on the QR
function updateCardLighting(dt) {
  if (!keyLight) return;
  const target = state === S.ZOOMED
    ? CARD_LIGHT_INTENSITY * CARD_LIGHT_ZOOM_MULT
    : CARD_LIGHT_INTENSITY;
  const k = 1 - Math.exp(-CARD_LIGHT_SMOOTH * dt);
  keyLight.intensity += (target - keyLight.intensity) * k;
}

// when the zoom settles, the QR "pings" bright twice to signal it's liveness
function updateQrPulse(dt) {
  if (!qrMat) return;
  if (state === S.ZOOMED && qrPulse < QR_PULSE_SECONDS) {
    qrPulse += dt;
    const per = QR_PULSE_SECONDS / QR_PULSE_CYCLES;
    const flash = QR_PULSE_PEAK * Math.abs(Math.sin(Math.PI * (qrPulse / per)));
    if (baseQrEmissive) qrMat.emissive.copy(baseQrEmissive);
    qrMat.emissiveIntensity = baseQrEmissiveInt + flash;
  } else {
    if (baseQrEmissive) qrMat.emissive.copy(baseQrEmissive);
    qrMat.emissiveIntensity = baseQrEmissiveInt;
  }
}

// pointer cursor over the QR while the card is showing (hover hint)
function updateHoverCursor() {
  if (!document.body) return;
  if (state === S.HIDDEN || !cameraRef) {
    document.body.style.cursor = "";
    return;
  }
  pointerV.set(mouseNdcX, mouseNdcY);
  raycaster.setFromCamera(pointerV, cameraRef);
  const over = raycaster.intersectObjects([qrMesh], true).length > 0;
  document.body.style.cursor = over ? "pointer" : "";
}

// LITE MODE. The blurred backdrop is the most expensive thing in the whole
// build: it renders the ENTIRE room a second time into a full-resolution
// render target, then a 9-tap gaussian, then a fullscreen composite — three
// extra full-screen passes plus the whole scene drawn twice, every frame, for
// as long as the card is up. On a weak tablet that alone is enough to fall
// off a cliff. In lite mode the world is drawn once and composited sharp, so
// the card still appears cleanly over the room, just without the depth-of-field
// behind it.
let liteMode = false;
export function setContactCardLite(v) { liteMode = !!v; }

export function renderContactCardComposite(worldScene, camera) {
  if (!renderer || !cardScene) return;
  if (liteMode) {
    // no backdrop pass at all: one scene render, then the card on top
    const wasAuto = renderer.autoClear;
    renderer.autoClear = false;
    renderer.clear();
    renderer.render(worldScene, camera);
    clearDepth();
    renderer.render(cardScene, camera);
    renderer.autoClear = wasAuto;
    return;
  }
  ensurePassTargets();
  renderer.setRenderTarget(worldRT);
  renderer.render(worldScene, camera);
  blurQuadMat.map = worldRT.texture;
  renderer.setRenderTarget(blurRT);
  quadScene.remove(compositeQuad);
  renderer.render(quadScene, quadCam);
  compositeMat.uniforms.tBlur.value = blurRT.texture;
  renderer.setRenderTarget(null);
  const wasAuto = renderer.autoClear;
  renderer.autoClear = false;
  renderer.clear();
  quadScene.remove(blurQuad);
  quadScene.add(compositeQuad);
  renderer.render(quadScene, quadCam);
  clearDepth();
  renderer.render(cardScene, camera);
  renderer.autoClear = wasAuto;
  quadScene.remove(compositeQuad);
  quadScene.add(blurQuad);
}

// Drop the depth buffer before the card is drawn, so the card starts from a
// clean slate instead of inheriting whatever the room pass just wrote.
//
// THE CARD IS AN OVERLAY, NOT PART OF THE ROOM. It is deliberately given its own
// scene and its own pass so it can never be occluded — its whole framing depends
// on that, since it is a UI object pinned to the lens, not a thing standing in the
// world at fitDist metres. Sharing the depth buffer breaks exactly that: any
// surface nearer than the card — a wall, the ATM panel, a decal the fly-through
// happens to be passing — silently eats it, and nothing reports it. The card's
// own state stays perfectly healthy through all of it (loaded, OPEN, rig visible,
// correctly framed), which is why this presented as "the card doesn't show" on
// some devices and not others rather than as an error.
//
// It only ever bit in LITE mode, and that is the whole device split. The blurred
// path clears the framebuffer before compositing, so its depth buffer is already
// empty when the card is drawn and the card was never at risk. Lite mode draws
// the room straight to the canvas, leaves that room's depth in place, and then
// drew the card into it. So the card appeared on whichever devices stayed on the
// full-quality blurred path — the S24 Ultra, which never gets downgraded — and
// vanished on every device the perf watchdog (or the iOS start tier) pushed into
// lite mode: the iPhone, the tablet, and a desktop GPU demoted for frame rate.
//
// Cheap, and unconditional: one clear per frame, and it makes the card immune to
// anything the room does.
function clearDepth() {
  renderer.clearDepth();
}

export function contactDebug() {
  return {
    loaded: loaded,
    failed: failed,
    state: STATE_NAME[state],
    open: isContactCardOpen(),
    pendingOpen: pendingOpen,
    t: +t.toFixed(3),
    dur: dur,
    rotY: +rotY.toFixed(3),
    rotX: +rotX.toFixed(3),
    // The three angles that sum into the pivot's Y, kept separate because the
    // intro hand-off in absorbIntroFlip() moves value between them, and "the
    // card jumped" is only diagnosable if you can see which term moved.
    introFlip: +introFlip.toFixed(4),
    introTimer: +introTimer.toFixed(3),
    autoY: +autoY.toFixed(3),
    returnFront: returnFront,
    dragId: dragId,
    // what the viewer actually sees, and what a grab must not change
    pivotY: pivot ? +pivot.rotation.y.toFixed(4) : null,
    pivotX: pivot ? +pivot.rotation.x.toFixed(4) : null,
    tilt: [+tiltX.toFixed(3), +tiltY.toFixed(3)],
    alignY: +baseAlignY.toFixed(3),
    qrShiftY: +qrShiftY.toFixed(3),
    modelHeight: +modelHeight.toFixed(3),
    modelWidth: +modelWidth.toFixed(3),
    liftY: +liftY.toFixed(3),
    fitDist: +fitDist.toFixed(3),
    riseDist: +riseDist.toFixed(3),
    fov: cameraRef ? cameraRef.fov : null,
    aspect: cameraRef ? +cameraRef.aspect.toFixed(3) : null,
    dmChars: DM_CHARS,
    rigVisible: rig ? rig.visible : null,
    pos: pivot ? [pivot.position.x, pivot.position.y, pivot.position.z].map(function (n) { return +n.toFixed(3); }) : null,
    mat: cardMat ? cardMat.type : null,
    hasMap: !!(cardMat && cardMat.map),
    // Which texture is actually on the card right now, and is it flipped?
    // flipV() mutates repeat/offset, which are per-TEXTURE, not per-material,
    // and glTF hands the same texture object to more than one slot - so "the
    // card is mirrored" can only be diagnosed by naming the texture that is
    // live and reading its own transform.
    mapState: cardMat && cardMat.map ? {
      file: (cardMat.map.image && (cardMat.map.image.currentSrc || cardMat.map.image.src) || "").split("/").pop().slice(0, 40),
      uuid: cardMat.map.uuid.slice(0, 8),
      repeatY: +cardMat.map.repeat.y.toFixed(3),
      offsetY: +cardMat.map.offset.y.toFixed(3),
      flipY: cardMat.map.flipY,
      wanted: cardTexturePaths().map.split("/").pop(),
    } : null,
    normalState: cardMat && cardMat.normalMap ? {
      file: (cardMat.normalMap.image && (cardMat.normalMap.image.currentSrc || cardMat.normalMap.image.src) || "").split("/").pop().slice(0, 40),
      uuid: cardMat.normalMap.uuid.slice(0, 8),
      repeatY: +cardMat.normalMap.repeat.y.toFixed(3),
      offsetY: +cardMat.normalMap.offset.y.toFixed(3),
    } : null,
    sameMapAndNormal: !!(cardMat && cardMat.map && cardMat.map === cardMat.normalMap),
    // The card mesh may carry SEVERAL materials and only material[0] is ever
    // given the injected texture and the flip, so list them all: a face drawn
    // with a slot that was missed is exactly how a mirrored card can appear.
    matCount: cardMesh ? (Array.isArray(cardMesh.material) ? cardMesh.material.length : 1) : 0,
    mats: cardMesh ? (Array.isArray(cardMesh.material) ? cardMesh.material : [cardMesh.material]).map(function (mm, gi) {
      return {
        i: gi,
        name: mm ? mm.name : null,
        map: mm && mm.map ? ((mm.map.image && (mm.map.image.currentSrc || mm.map.image.src) || "").split("/").pop().slice(0, 24) || "baked") : null,
        repeatY: mm && mm.map ? +mm.map.repeat.y.toFixed(3) : null,
        offsetY: mm && mm.map ? +mm.map.offset.y.toFixed(3) : null,
        isCardMat: mm === cardMat,
      };
    }) : [],
    vflip: FLIP_V,
    blur: !!worldRT,
    rt: worldRT ? [worldRT.width, worldRT.height] : null,
    screen: cardScreenRect(),
  };
}

// Where the card actually lands on screen, in CSS pixels, plus how much of the
// frame it covers. The framing maths is in world units and depends on the live
// fov/aspect, so "is it on screen" cannot be answered from the pose alone — this
// projects the real bounding box through the real camera. A card that renders
// but is off-frame (or behind the lens) is indistinguishable from one that never
// loaded by eye, and that is exactly the ambiguity this removes.
//
// It measures the whole wrapper, NOT the mesh named CARD: in the shipped GLB
// "CARD" is a thin sliver next to the QR, so measuring it reported a 1x30px
// rect while a card covering a third of the screen was plainly visible — a
// diagnostic that is worse than none, because it disagrees with the screen.
function cardScreenRect() {
  const target = wrapper || cardMesh;
  if (!target || !cameraRef || state === S.HIDDEN) return null;
  // setFromObject already walks the graph and returns a WORLD-space box, so
  // there is no matrixWorld to apply here — doing so transforms the card twice
  // and reports a rect thousands of pixels off screen.
  _box.setFromObject(target);
  if (_box.isEmpty()) return null;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  let behind = 0;
  const w = window.innerWidth, h = window.innerHeight;
  for (let i = 0; i < 8; i++) {
    const v = new THREE.Vector3(
      i & 1 ? _box.max.x : _box.min.x,
      i & 2 ? _box.max.y : _box.min.y,
      i & 4 ? _box.max.z : _box.min.z
    );
    // depth test in view space, then let project() do the single view+proj
    // transform — applying matrixWorldInverse here as well would double it
    _tmpV3.copy(v).applyMatrix4(cameraRef.matrixWorldInverse);
    if (_tmpV3.z > -cameraRef.near) behind++;
    const p = v.project(cameraRef);
    const px = (p.x * 0.5 + 0.5) * w;
    const py = (-p.y * 0.5 + 0.5) * h;
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
  }
  return {
    x: [Math.round(minX), Math.round(maxX)],
    y: [Math.round(minY), Math.round(maxY)],
    w: Math.round(maxX - minX),
    h: Math.round(maxY - minY),
    // share of the viewport the card occupies, so "0.4 of the frame" is
    // comparable between a phone and a desktop without eyeballing pixels
    cover: +(((maxX - minX) * (maxY - minY)) / (w * h)).toFixed(3),
    behind: behind,
    viewport: [w, h],
    onScreen: behind === 0 && minX < w && maxX > 0 && minY < h && maxY > 0,
  };
}

/* ------------------------------ debug overlay ------------------------------ */

function updateDebug() {
  const want = typeof window !== "undefined" && window.__DEBUG_CARD__;
  if (!want) {
    if (debugEl) { debugEl.remove(); debugEl = null; }
    return;
  }
  if (!debugEl) {
    debugEl = document.createElement("div");
    debugEl.id = "card-debug";
    debugEl.style.position = "fixed";
    debugEl.style.left = "12px";
    debugEl.style.top = "50%";
    debugEl.style.transform = "translateY(-50%)";
    debugEl.style.background = "rgba(0,0,0,0.75)";
    debugEl.style.color = "#0f0";
    debugEl.style.font = "11px/1.45 monospace";
    debugEl.style.padding = "8px 10px";
    debugEl.style.borderRadius = "6px";
    debugEl.style.zIndex = "999999";
    debugEl.style.pointerEvents = "none";
    debugEl.style.whiteSpace = "pre";
    document.body.appendChild(debugEl);
  }
  const d = contactDebug();
  debugEl.textContent = [
    "CONTACT card",
    "state: " + d.state + (d.open ? " OPEN" : " hidden"),
    "ready: " + d.loaded + " vflip: " + d.vflip + " blur: " + d.blur,
    "fov: " + d.fov + " fitDist: " + d.fitDist,
    "model h: " + d.modelHeight + " lift: " + d.liftY,
    "pos: " + (d.pos ? d.pos.map(function (n) { return n.toFixed(2); }).join(",") : "?"),
    "rot: " + d.rotX + " / " + d.rotY + " tilt " + d.tilt.join(","),
  ].join("\n");
}

/* ------------------------------ interaction ------------------------------ */

function pointerAt(e) {
  pointerV.x = (e.clientX / window.innerWidth) * 2 - 1;
  pointerV.y = -(e.clientY / window.innerHeight) * 2 + 1;
  return pointerV;
}

function handleClick(e) {
  raycaster.setFromCamera(pointerAt(e), cameraRef);
  const qrHits = raycaster.intersectObjects([qrMesh], true);
  const cardHits = qrHits.length > 0 || raycaster.intersectObjects([cardMesh], true).length > 0;
  idleTimer = 0; // a click is manipulation
  if (state === S.ZOOMED) {
    if (qrHits.length) openContactForm();
    else if (cardHits) begin(S.ZOOM_OUT, liftY, fitDist, ZOOM_TIME);
    else begin(S.ZOOM_OUT, liftY, fitDist, ZOOM_TIME); // outside just unzooms
    return;
  }
  // OPEN: the QR zooms; the card itself swings back to the front; only empty
  // space outside the card closes it.
  if (qrHits.length) begin(S.ZOOM_IN, qrShiftY, fitDist * ZOOM_FRAC, ZOOM_TIME);
  else if (cardHits) returnFront = true;
  else {
    // closing the card over empty space counts as "exiting" — roll another
    // card so the next visit shows a different design without reloading.
    pickCardIndex();
    begin(S.CLOSING, liftY - riseDist, fitDist, CLOSE_TIME);
  }
}

/* --------------------- contact strip + form overlay --------------------- */

// language-aware strings for the strip + form (site default: es)
var CONTACT_STRINGS = {
  es: {
    dmBar: "MENSAJE DIRECTO ▶",
    copyLbl: "COPIAR",
    popPhone: "NÚMERO DE TELÉFONO",
    popEmail: "CORREO",
    whatsapp: "WHATSAPP",
    mailLbl: "CORREO",
    msgMe: "Enviarme un mensaje",
    mailCopied: "Correo copiado",
    phoneCopied: "Teléfono copiado",
    discordCopied: "@alejandrote copiado — pégalo en Discord",
    crumb: "gob.ve &rsaquo; Atenci&oacute;n al Cliente &rsaquo; Oficina Virtual",
    formTitle: "Contacto",
    formDesc: "A continuación puede escribirme directamente: el mensaje cae en mi bandeja y te respondo lo antes posible.",
    nameLab: "Nombre",
    emailLab: "Correo",
    msgLab: "Mensaje",
    namePh: "Tu nombre",
    emailPh: "Tu correo (para responderte)",
    msgPh: "Cuéntame sobre tu proyecto…",
    send: "Enviar",
    volver: "Volver",
    credit: "Oficina de Tecnolog&iacute;as de la Informaci&oacute;n &mdash; Alejandro Enrique",
    scanAlt: "¿Prefieres escanear? Haz clic en el QR de la tarjeta.",
    fillErr: "Por favor completa todos los campos.",
    sending: "Enviando…",
    sent: "¡Mensaje enviado — gracias!",
    needsActivation: "Formulario pendiente de activar: revisa el correo enviado a " + CONTACT_EMAIL + " y pulsa «Activar formulario». El mensaje no se entrega hasta entonces.",
    timedOut: "El servidor tardó demasiado y no respondió. He guardado tu mensaje para reintentarlo — si puedes, escríbeme directamente.",
    noRelay: "Este formulario solo funciona en el sitio publicado — no hay servidor de correo en esta dirección.",
    rateLimited: "Demasiados mensajes desde esta dirección. Espera unos minutos e inténtalo de nuevo.",
    noRoute: "No pude entregar el mensaje por ningún canal. He guardado tu mensaje; si puedes, escríbeme directamente.",
    netErr: "No se pudo enviar ahora.",
  },
  en: {
    dmBar: "DIRECT MESSAGE ▶",
    copyLbl: "COPY",
    popPhone: "PHONE NUMBER",
    popEmail: "EMAIL",
    whatsapp: "WHATSAPP",
    mailLbl: "MAIL",
    msgMe: "Message me",
    mailCopied: "Email copied",
    phoneCopied: "Phone copied",
    discordCopied: "@alejandrote copied — paste it into Discord",
    crumb: "gob.ve &rsaquo; Customer Service &rsaquo; Virtual Office",
    formTitle: "Contact",
    formDesc: "Write to me directly below: your message lands in my inbox and I'll reply as soon as I can.",
    nameLab: "Name",
    emailLab: "Email",
    msgLab: "Message",
    namePh: "Your name",
    emailPh: "Your email (so I can reply)",
    msgPh: "Tell me about your project…",
    send: "Send",
    volver: "Back",
    credit: "Office of Information Technologies &mdash; Alejandro Enrique",
    scanAlt: "Prefer scanning? Click the QR on the card.",
    fillErr: "Please fill in all fields.",
    sending: "Sending…",
    sent: "Message sent — thank you!",
    needsActivation: "Form still needs activation: check the email sent to " + CONTACT_EMAIL + " and click “Activate Form”. Messages are not delivered until you do.",
    timedOut: "The server took too long and never replied. I have saved your message to retry — you can also email me directly below.",
    noRelay: "This form only works on the published site — there is no mail server at this address.",
    rateLimited: "Too many messages from this address. Wait a few minutes and try again.",
    noRoute: "I could not deliver the message by any channel. It is saved; you can also email me directly below.",
    netErr: "Could not send right now.",
  },
};
function curStrings() {
  return (typeof window !== "undefined" && window.__PORTFOLIO_LANG__ === "en")
    ? CONTACT_STRINGS.en : CONTACT_STRINGS.es;
}

/* ------------------------------------------------------------------ */
/*  LED helpers — replicate the ATM dot-matrix look exactly:           */
/*   - icons use the same dot ratio as the UI arrows (r=0.32)          */
/*   - letters/numbers render in the 5x7 LED font ("THIS IS A          */
/*     PORTFOLIO"), 4px per cell, 3.2px dots (mainDisplay's CELL/DOT)  */
/* ------------------------------------------------------------------ */
const PL_CELL = 4;      // px per LED unit (matches ATM overlay + lang badge)
const PL_TEXT_R = 0.4;  // 3.2px dot on a 4px cell (same as the ATM text)
const PL_BLANK = [".....", ".....", ".....", ".....", ".....", ".....", "....."];

function ledRowsURI(rows, radius) {
  var R = rows.length, C = rows[0].length, dots = "";
  for (var r = 0; r < R; r++) {
    for (var c = 0; c < C; c++) {
      if (rows[r].charAt(c) === "#") dots += '<circle cx="' + c + '" cy="' + r + '" r="' + radius + '" fill="#ffffff"/>';
    }
  }
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + C + " " + R + '">' + dots + '</svg>');
}
function textRows(txt) {
  var s = String(txt).toUpperCase(), rows = [];
  for (var ry = 0; ry < 7; ry++) {
    var row = "";
    for (var i = 0; i < s.length; i++) {
      var g = FONT5x7[s[i]] || PL_BLANK;
      for (var gx = 0; gx < 5; gx++) row += g[ry][gx];
      row += ".";
    }
    rows.push(row);
  }
  return rows;
}
function textURI(txt) {
  return ledRowsURI(textRows(txt), PL_TEXT_R);
}
function textSize(txt) {
  return { w: String(txt).length * 6 * PL_CELL, h: 7 * PL_CELL };
}

// the DIRECT MESSAGE bar renders at a FIXED width in both languages so the
// symbol row underneath lines up identically. 17 LED cells = longest label
// ("MENSAJE DIRECTO ▶"); EN is padded with blank cells to match.
// the DIRECT MESSAGE bar renders at a FIXED LED width in both languages so the
// symbol row underneath lines up identically. 17 LED cells = longest label
// ("MENSAJE DIRECTO ▶"); EN is padded with blank cells to match.
const DM_CHARS = 17;
function padDm(s) {
  var diff = DM_CHARS - s.length;
  if (diff <= 0) return s;
  var left = Math.floor(diff / 2);
  var right = diff - left;
  return " ".repeat(left) + s + " ".repeat(right);
}

/* ------------------------------------------------------------------ */
/*  Symbol row — plain white SVG glyphs (NO dot matrix here).          */
/*  fill glyphs = discord; the others are stroke icons.               */
/* ------------------------------------------------------------------ */
function symbolSVG(name) {
  var body = SYMBOLS[name] || "";
  var fill = name === "discord" ? "currentColor" : "none";
  var stroke = name === "discord" ? "none" : "currentColor";
  return '<svg width="22" height="22" viewBox="0 0 24 24" fill="' + fill + '" stroke="' + stroke +
    '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + '</svg>';
}
const SYMBOLS = {
  discord: '<path d="M20.317 4.369a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.372-.291a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z"/>',
  phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 5.07 12.81 19.79 19.79 0 0 1 2 4.18 2 2 0 0 1 4 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>',
  instagram: '<rect x="2" y="2" width="20" height="20" rx="5"/><circle cx="12" cy="12" r="4"/><path d="M17.5 6.5h.01"/>',
  mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m2 6 10 7 10-7"/>',
};
// LED label spans are laid out at their natural pixel size, but the bars they
// sit in are sized to the viewport — so on a phone the natural width overflows
// and the blue plate gets cropped. Every span therefore gets `max-width:100%`
// plus an explicit aspect-ratio, so when the max-width clamps, the HEIGHT
// follows from the ratio and the dot grid stays square instead of being
// squashed. Natural size is preserved on desktop (max-width never binds).
function ledSize(span, sz) {
  span.style.width = sz.w + "px";
  span.style.maxWidth = "100%";
  span.style.height = "auto";
  span.style.aspectRatio = sz.w + " / " + sz.h;
}
function ledSpan(txt, cls) {
  var sz = textSize(txt);
  return '<span class="' + (cls || "cc-txt") + '" aria-hidden="true" style="background-image:url(\'' +
    textURI(txt) + "');width:" + sz.w + "px;max-width:100%;height:auto;aspect-ratio:" +
    sz.w + " / " + sz.h + '"></span>';
}

function ensureContactForm() {
  if (gridEl) return;
  var ui = document.createElement("div");
  ui.id = "cc-ui";
  ui.innerHTML =
    '<div id="cc-grid">' +
      '<button id="cc-msg-btn" class="cc-bar" type="button">' + ledSpan("") + '</button>' +
      '<div class="cc-symrow">' +
        '<button id="cc-sym-discord" type="button" aria-label="Discord">' + symbolSVG("discord") + '</button>' +
        '<button id="cc-sym-phone" type="button" aria-label="Phone">' + symbolSVG("phone") + '</button>' +
        '<button id="cc-sym-ig" type="button" aria-label="Instagram">' + symbolSVG("instagram") + '</button>' +
        '<button id="cc-sym-mail" type="button" aria-label="Email">' + symbolSVG("mail") + '</button>' +
      '</div>' +
    '</div>' +
    '<div id="cc-pop" hidden>' +
      '<div class="cc-popbox">' +
        '<button class="cc-pop-led" type="button" aria-label="Copy">' + ledSpan("") + '</button>' +
        '<div class="cc-pop-actions">' +
          '<button id="cc-pop-copy" class="cc-pop-act" type="button" aria-label="Copy">' + ledSpan("") + '</button>' +
          '<em>|</em>' +
          '<a id="cc-pop-open" class="cc-pop-act" href="javascript:void(0)" rel="noopener noreferrer">' + ledSpan("") + '</a>' +
        '</div>' +
      '</div>' +
    '</div>' +
    '<div id="cc-modal" hidden>' +
      '<div class="cc-panel">' +
        '<button id="cc-x" type="button" aria-label="Cerrar">×</button>' +
        '<div class="cc-head">' +
          '<img class="cc-emblem" src="media/CONTACT/cantv_banner.webp" alt="Cantv">' +
        '</div>' +
        '<div class="cc-crumb">' +
          '<span id="cc-crumb-text"></span>' +
        '</div>' +
        '<div class="cc-body">' +
          '<h2 id="cc-title" class="cc-title">Contacto</h2>' +
          '<p id="cc-desc" class="cc-desc"></p>' +
          '<form id="cc-form" novalidate>' +
            '<input type="text" name="_honey" style="display:none" tabindex="-1" autocomplete="off">' +
            '<div class="cc-field"><h3 id="cc-lab-name"></h3><input id="cc-name" name="name" required></div>' +
            '<div class="cc-field"><h3 id="cc-lab-email"></h3><input id="cc-email" name="email" type="email" required></div>' +
            '<div class="cc-field"><h3 id="cc-lab-msg"></h3><textarea id="cc-msg" name="message" rows="4" required></textarea></div>' +
            '<div class="cc-sendrow"><button id="cc-send" type="submit"></button></div>' +
            '<p id="cc-status" role="status"></p>' +
            '<p id="cc-alt" class="cc-alt"></p>' +
          '</form>' +
        '</div>' +
        '<div class="cc-credits">' +
          '<p id="cc-credit"></p>' +
          '<a id="cc-volver" href="javascript:void(0)"></a>' +
        '</div>' +
      '</div>' +
    '</div>' +
    '<div id="cc-toast" role="status"></div>';
  document.body.appendChild(ui);
  // The bar's natural width (17 LED cells) as the UPPER bound only — the CSS
  // takes min(this, viewport) so a phone gets a bar that fits the screen with
  // the label scaled down inside it rather than cropped.
  var dmW = (DM_CHARS * 6 * PL_CELL) + "px";
  var css = document.createElement("style");
  css.id = "cc-css";
  css.textContent = [
    /* contact strip (bottom center while the card is out) — the blue bar    */
    /* wraps the DOT-MATRIX text exactly, and the symbol row underneath lies */
    /* under that same text (discord at the left tip, mail at the right tip) */
    "#cc-ui{font:inherit;z-index:40}",
    // bottom: the safe-area inset is added on top of the 20px so the strip
    // clears the iPhone home indicator in portrait. The width is the min of
    // the natural LED width and the screen, so the blue plate always fits and
    // the label scales with it (ledSize) instead of being cropped.
    "#cc-grid{position:fixed;left:50%;bottom:max(20px,calc(env(safe-area-inset-bottom,0px) + 10px));",
    "  transform:translateX(-50%);display:flex;flex-direction:column;align-items:stretch;",
    "  gap:12px;width:min(" + dmW + ",calc(100vw - 24px));",
    "  opacity:0;pointer-events:none;transition:opacity .25s}",
    "#cc-grid.cc-on{opacity:1;pointer-events:auto}",
    "#cc-grid .cc-bar{display:flex;align-items:center;justify-content:center;width:100%;",
    "  box-sizing:border-box;padding:14px 0;background-color:#1f4ef8;border:none;",
    "  border-radius:0;color:#fff;cursor:pointer;box-shadow:0 0 16px rgba(0,120,255,.6)}",
    "#cc-grid .cc-bar:hover{background-color:#2f61ff}",
    "#cc-grid .cc-bar:active{transform:scale(.98)}",
    "#cc-grid .cc-bar .cc-txt{background-repeat:no-repeat;background-position:center;",
    "  background-size:100% 100%;flex:none}",
    "#cc-grid .cc-symrow{display:flex;justify-content:space-between;align-items:center;margin-top:0}",
    "#cc-grid .cc-symrow button{display:grid;place-items:center;width:40px;height:40px;padding:0;",
    "  background-color:#1f4ef8;border:none;border-radius:0;color:#fff;cursor:pointer;",
    "  box-shadow:0 0 10px rgba(0,120,255,.45);transition:transform .15s ease,background-color .15s ease}",
    "#cc-grid .cc-symrow button:hover{background-color:#2f61ff;transform:scale(1.08)}",
    "#cc-grid .cc-symrow button:active{transform:scale(.94)}",
    /* centered detail popup — no backdrop or box, just the dot-matrix    */
    /* value on its blue bar + the COPY | WHATSAPP/MAIL blue LED buttons   */
    "#cc-pop{position:fixed;inset:0;display:grid;place-items:center;z-index:45;background:transparent}",
    "#cc-pop[hidden]{display:none}",
    ".cc-popbox{display:flex;flex-direction:column;align-items:center;gap:16px;max-width:94vw}",
    ".cc-pop-led{display:grid;place-items:center;background-color:#1f4ef8;border:none;",
    "  border-radius:0;color:#fff;cursor:pointer;padding:12px 18px;line-height:0}",
    ".cc-pop-led:hover{background-color:#2f61ff}",
    ".cc-pop-led .cc-txt{background-repeat:no-repeat;background-position:center;",
    "  background-size:100% 100%;cursor:pointer}",
    ".cc-pop-actions{display:flex;align-items:center;gap:16px;color:#fff}",
    ".cc-pop-actions em{font-style:normal;color:#7ea0ff}",
    ".cc-pop-act{display:grid;place-items:center;background-color:#1f4ef8;border:none;",
    "  border-radius:0;color:#fff;cursor:pointer;padding:10px 16px;line-height:0}",
    ".cc-pop-act:hover{background-color:#2f61ff}",
    ".cc-pop-act .cc-txt{background-repeat:no-repeat;background-position:center;",
    "  background-size:100% 100%}",
    "#cc-pop-open{text-decoration:none}",
    /* toast */
    "#cc-toast{position:fixed;left:50%;bottom:18px;transform:translateX(-50%) translateY(8px);",
    "  background:#e2b34d;color:#12100a;padding:7px 14px;border-radius:999px;font-size:12px;font-weight:700;",
    "  letter-spacing:.06em;opacity:0;pointer-events:none;transition:opacity .25s,transform .25s;z-index:60}",
    "#cc-toast.cc-on{opacity:1;transform:translateX(-50%) translateY(0)}",
    /* CANTV "Oficina Virtual" parody modal */
    "#cc-modal{position:fixed;inset:0;background:rgba(4,6,12,.62);display:grid;place-items:center;",
    "  z-index:45;backdrop-filter:blur(3px)}",
    "#cc-modal[hidden]{display:none}",
    ".cc-panel{width:min(470px,93vw);background:#fff;color:#666;border-radius:0;overflow:hidden;",
    "  position:relative;box-shadow:0 26px 80px rgba(0,0,0,.6);border:1px solid #6b6ea3;",
    "  font-family:Arial,Helvetica,sans-serif}",
    ".cc-head{position:relative;overflow:hidden;background:#0b2a5e;border-bottom:2px solid #0e2a57;line-height:0}",
    ".cc-emblem{display:block;width:100%;height:auto}",
    "#cc-x{position:absolute;top:4px;right:8px;border:0;background:none;color:#fff;font-size:22px;",
    "  line-height:1;cursor:pointer;padding:2px;z-index:2}",
    "#cc-x:hover{color:#ffd9d9}",
    ".cc-crumb{background:#fff;border-bottom:1px solid #ddd;padding:5px 12px;font:11px Arial,Helvetica,sans-serif;color:#666}",
    ".cc-body{background:#c6cded;border-top:1px solid #6b6ea3;border-bottom:1px solid #6b6ea3;padding:12px 14px}",
    ".cc-title{margin:0 0 6px;background:#cccccc;color:#000;font:700 13px Arial,Helvetica,sans-serif;letter-spacing:.02em;padding:3px 6px}",
    ".cc-desc{margin:0 0 10px;font:11px Arial,Helvetica,sans-serif;color:#333;line-height:1.5}",
    ".cc-field{margin-bottom:8px}",
    ".cc-field h3{margin:0 0 3px;font:700 11px Arial,Helvetica,sans-serif;color:#333}",
    ".cc-panel input,.cc-panel textarea{width:100%;box-sizing:border-box;border:1px solid #6b6ea3;",
    "  padding:5px 6px;font:10px Verdana,Arial,Helvetica,sans-serif;color:#666;outline:none;",
    "  background:#fff;border-radius:0}",
    ".cc-panel input:focus,.cc-panel textarea:focus{border-color:#245B98;box-shadow:0 0 0 1px rgba(36,91,152,.25)}",
    ".cc-panel textarea{resize:vertical}",
    ".cc-sendrow{margin-top:10px}",
    "#cc-send{width:100%;padding:8px;border:1px solid #5a2d6e;background:linear-gradient(#a94cc4,#7c2d9b);",
    "  color:#fff;font:700 12px Arial,Helvetica,sans-serif;letter-spacing:.1em;cursor:pointer;",
    "  text-transform:uppercase;border-radius:0}",
    "#cc-send:hover{filter:brightness(1.08)}",
    "#cc-send:active{transform:translateY(1px)}",
    "#cc-send:disabled{opacity:.55;cursor:default}",
    "#cc-status{min-height:16px;margin:8px 0 0;font:11px Arial,Helvetica,sans-serif;color:#1a7a3a;text-align:center}",
    "#cc-status.cc-err{color:#b02727}",
    ".cc-alt{font-size:10px;color:#555;margin:6px 0 0;text-align:center}",
    ".cc-credits{background:#245B98;color:#fff;padding:10px 14px;font:9.5px Arial,sans-serif}",
    ".cc-credits p{margin:0;text-align:center;line-height:1.5}",
    ".cc-credits a{display:block;color:#fff;text-align:center;cursor:pointer;font:700 12px Arial,sans-serif;",
    "  margin-top:5px;letter-spacing:.1em}",
    ".cc-credits a:hover{color:#ffd9d9;text-decoration:none}",
  ].join("");
  document.head.appendChild(css);

  gridEl = document.getElementById("cc-grid");
  modalEl = document.getElementById("cc-modal");
  popEl = document.getElementById("cc-pop");
  toastEl = document.getElementById("cc-toast");

  ui.addEventListener("click", function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    if (t.closest("#cc-modal")) {
      if (t.closest("#cc-volver") || t.id === "cc-x") { closeContactForm(); return; }
      if (e.target === modalEl) closeContactForm();
      return;
    }
    if (t.closest("#cc-pop")) {
      if (t.closest(".cc-pop-led") || t.closest("#cc-pop-copy")) { copyCurrentPop(); return; }
      if (t.closest("#cc-pop-open")) return;
      closeContactPop();
      return;
    }
    if (t.closest("#cc-sym-discord")) { window.open(DISCORD_URL, "_blank", "noopener"); return; }
    if (t.closest("#cc-sym-ig")) { window.open(INSTAGRAM_URL, "_blank", "noopener"); return; }
    if (t.closest("#cc-sym-phone")) { openContactPop("PHONE"); return; }
    if (t.closest("#cc-sym-mail")) { openContactPop("EMAIL"); return; }
    if (t.closest("#cc-msg-btn")) { openContactForm(); return; }
    var cp = t.closest("[data-copy]");
    if (cp) { doCopy(cp.getAttribute("data-copy")); return; }
  });

  document.getElementById("cc-form").addEventListener("submit", submitContactForm);
  applyContactStrings();
}

function openContactForm() {
  ensureContactForm();
  applyContactStrings();
  closeContactPop();
  formOpen = true;
  modalEl.hidden = false;
}

function closeContactForm() {
  formOpen = false;
  modalEl.hidden = true;
}

/* centered detail popup — the dot-matrix number/email on a blue bar,
   click-to-copy, plus a COPY | WHATSAPP (or COPY | MAIL) blue square pair */
function setLed(span, txt) {
  var sz = textSize(txt);
  span.style.backgroundImage = "url('" + textURI(txt) + "')";
  ledSize(span, sz);
}
function setLedLabel(el, txt) {
  var span = el.querySelector(".cc-txt");
  setLed(span, txt);
  el.setAttribute("aria-label", txt);
}
function openContactPop(kind) {
  ensureContactForm();
  var S = curStrings();
  popKind = kind;
  var isPhone = kind === "PHONE";
  var val = isPhone ? CONTACT_PHONE : CONTACT_EMAIL;
  setLed(popEl.querySelector(".cc-pop-led .cc-txt"), val);
  setLedLabel(popEl.querySelector("#cc-pop-copy"), S.copyLbl);
  var o = popEl.querySelector("#cc-pop-open");
  setLedLabel(o, isPhone ? S.whatsapp : S.mailLbl);
  o.href = isPhone ? WHATSAPP_URL : "mailto:" + CONTACT_EMAIL;
  o.target = isPhone ? "_blank" : "_self";
  o.removeAttribute("rel");
  if (isPhone) o.setAttribute("rel", "noopener noreferrer");
  popEl.hidden = false;
  formOpen = false;
}

function closeContactPop() {
  if (!popEl) return;
  popEl.hidden = true;
  popKind = null;
}

function copyCurrentPop() {
  if (popKind === "PHONE") copyText(CONTACT_PHONE, curStrings().phoneCopied);
  else if (popKind === "EMAIL") copyText(CONTACT_EMAIL, curStrings().mailCopied);
  else closeContactPop();
}

function applyContactStrings() {
  var S = curStrings();
  if (gridEl) {
    var mb = gridEl.querySelector("#cc-msg-btn");
    setLed(mb.querySelector(".cc-txt"), padDm(S.dmBar));
    mb.setAttribute("aria-label", S.dmBar.replace("▶", "") + " " + S.msgMe);
  }
  if (popEl) {
    setLedLabel(popEl.querySelector("#cc-pop-copy"), S.copyLbl);
  }
  if (modalEl) {
    modalEl.querySelector("#cc-crumb-text").innerHTML = S.crumb;
    modalEl.querySelector("#cc-title").textContent = S.formTitle;
    modalEl.querySelector("#cc-desc").textContent = S.formDesc;
    modalEl.querySelector("#cc-lab-name").textContent = S.nameLab;
    modalEl.querySelector("#cc-lab-email").textContent = S.emailLab;
    modalEl.querySelector("#cc-lab-msg").textContent = S.msgLab;
    modalEl.querySelector("#cc-name").placeholder = S.namePh;
    modalEl.querySelector("#cc-email").placeholder = S.emailPh;
    modalEl.querySelector("#cc-msg").placeholder = S.msgPh;
    modalEl.querySelector("#cc-send").textContent = S.send;
    modalEl.querySelector("#cc-volver").textContent = S.volver;
    modalEl.querySelector("#cc-credit").innerHTML = S.credit;
    modalEl.querySelector("#cc-alt").textContent = S.scanAlt;
  }
}

function doCopy(kind) {
  var S = curStrings();
  if (kind === "EMAIL") copyText(CONTACT_EMAIL, S.mailCopied);
  else if (kind === "PHONE") copyText(CONTACT_PHONE, S.phoneCopied);
  else if (kind === "DISCORD") {
    if (DISCORD_URL) { window.open(DISCORD_URL, "_blank", "noopener"); return; }
    copyText(CONTACT_DISCORD, S.discordCopied);
  }
}

function copyText(txt, toast) {
  var done = function () { showToast(toast); };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(txt).then(done).catch(function () { legacyCopy(txt, done); });
  } else legacyCopy(txt, done);
}

function legacyCopy(txt, done) {
  var ta = document.createElement("textarea");
  ta.value = txt;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  var ok = false;
  try { ok = document.execCommand("copy"); } catch (err) {}
  document.body.removeChild(ta);
  if (ok) done();
}

function showToast(msg) {
  if (!toastEl) return;
  toastEl.textContent = msg;
  toastEl.classList.add("cc-on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { toastEl.classList.remove("cc-on"); }, 1800);
}

function submitContactForm(e) {
  e.preventDefault();
  var form = e.target;
  var status = document.getElementById("cc-status");
  var altEl = document.getElementById("cc-alt");
  var send = document.getElementById("cc-send");
  var S = curStrings();
  var f = new FormData(form);
  var msg = {
    name: String(f.get("name") || "").trim(),
    email: String(f.get("email") || "").trim(),
    message: String(f.get("message") || "").trim(),
  };
  if (!msg.name || !msg.email || !msg.message) {
    status.textContent = S.fillErr;
    status.className = "cc-err";
    return;
  }
  // the hidden honeypot input must stay empty; the relay drops the message if
  // it is filled, and answers as though it worked
  var honey = String(f.get("_honey") || "").trim();

  // Park it BEFORE the network call. If the tab dies mid-request, or the
  // backend hangs and the visitor gives up, the message is already on disk and
  // goes out on their next visit instead of vanishing.
  outboxPush(msg);

  status.textContent = S.sending;
  status.className = "";
  altEl.textContent = "";
  altEl.style.display = "none";
  send.disabled = true;
  deliver(msg, honey)
    .then(function () {
      // only a CONFIRMED success reaches here. Nothing in this path invents
      // one, which is the whole point: the previous version printed
      // "Message sent" on failures and lost real enquiries.
      outboxWrite(outboxRead().filter(function (x) { return x.msg !== msg; }));
      status.textContent = S.sent;
      status.className = "";
      altEl.textContent = "";
      form.querySelectorAll("input,textarea").forEach(function (el) {
        if (el.name !== "_honey") el.value = "";
      });
    })
    .catch(function (err) {
      console.warn("[contact] form failed:", err);
      // Order matters only in that the specific flags come first. The last
      // branch is the one that used to leak: a request that never produced a
      // response has no status and no server message, so the visitor was shown
      // the browser's own "Failed to fetch".
      if (err && err.noRelay) status.textContent = S.noRelay;
      else if (err && err.rateLimited) status.textContent = S.rateLimited;
      else if (err && err.noRoute) status.textContent = S.noRoute;
      else if (err && err.needsActivation) status.textContent = S.needsActivation;
      else if (err && err.timedOut) status.textContent = S.timedOut;
      else status.textContent = String((err && err.message) || S.netErr).slice(0, 200);
      status.className = "cc-err";
      // The message is saved and will retry on the next visit, but never make
      // a visitor depend on that: hand them the address, which always works.
      altEl.innerHTML = '<a href="mailto:' + CONTACT_EMAIL + '">' + CONTACT_EMAIL + "</a>";
      altEl.style.display = "";
    })
    .finally(function () { send.disabled = false; });
}

document.addEventListener("pointerdown", function (e) {
  if (formOpen) return;
  if (e.target && e.target.closest && e.target.closest("#cc-ui")) return;
  if (!cardLive() || dragId !== null) return;
  dragId = e.pointerId;
  dragLastX = e.clientX;
  dragLastY = e.clientY;
  dragMove = 0;
  dragVelX = 0;
  dragVelY = 0;
  // touching the card cancels any coast still in flight (see the momentum block
  // in the update step) so the new drag owns the pose from the first frame
  spinY = 0;
  spinX = 0;
  idleTimer = 0;      // manipulation resets the idle auto-rotate clock
  // mid-intro grab: keep the card exactly where it is and let the drag own it
  // from here, rather than snapping the held-back face round to the front
  absorbIntroFlip();
});

document.addEventListener("pointermove", function (e) {
  mouseNdcX = (e.clientX / window.innerWidth) * 2 - 1;
  mouseNdcY = -(e.clientY / window.innerHeight) * 2 + 1;
  if (formOpen) return;
  if (e.target && e.target.closest && e.target.closest("#cc-ui")) return;
  if (e.pointerId !== dragId || !cardLive()) return;
  const dx = e.clientX - dragLastX;
  const dy = e.clientY - dragLastY;
  // velocity from the gap since the last move (pointermove is coalesced, so
  // this is a real elapsed-time sample, not a fixed frame step)
  const now = (typeof e.timeStamp === "number" ? e.timeStamp : 0) / 1000;
  const dt = now > 0 && dragSampleT > 0 ? now - dragSampleT : 1 / 60;
  dragLastX = e.clientX;
  dragLastY = e.clientY;
  dragSampleT = now;
  dragMove += Math.abs(dx) + Math.abs(dy);
  // a finger covers fewer px per gesture than a mouse does, so a touch swipe
  // is scaled up to feel like the equivalent mouse drag
  const gain = e.pointerType === "touch" ? TOUCH_GAIN : 1;
  rotY += dx * ROTATE_SPEED * gain;
  rotX = clamp(rotX - dy * PITCH_SPEED * gain, -PITCH_CLAMP, PITCH_CLAMP);
  // smoothed velocity, so one jittery sample can't launch a wild flick
  if (dt > 0.0005 && dt < 0.2) {
    dragVelX = dragVelX * 0.6 + (dx / dt) * 0.4;
    dragVelY = dragVelY * 0.6 + (dy / dt) * 0.4;
  }
  applyPose();
});

document.addEventListener("pointerup", function (e) {
  if (e.pointerId !== dragId) return;
  if (e.target && e.target.closest && e.target.closest("#cc-ui")) {
    dragId = null;
    return;
  }
  const wasLive = cardLive();
  const wasDrag = dragMove;
  const gain = (e.pointerType === "touch" ? TOUCH_GAIN : 1) * SWIPE_GAIN;
  const vx = dragVelX;
  const vy = dragVelY;
  dragId = null;
  dragSampleT = 0;
  // FLICK: a real swipe hands off its release velocity to the momentum decay.
  // Only a genuine drag qualifies (a tap is a click, not a spin), and a slow
  // drag releases with no coast so it still stops where you let go.
  if (wasLive && wasDrag > CLICK_MAX_DRAG) {
    spinY = clamp(vx * ROTATE_SPEED * gain, -SPIN_MAX, SPIN_MAX);
    spinX = clamp(-vy * PITCH_SPEED * gain, -SPIN_MAX, SPIN_MAX);
  }
  dragVelX = 0;
  dragVelY = 0;
  if (!wasLive || wasDrag > CLICK_MAX_DRAG) return;
  handleClick(e);
});

document.addEventListener("pointercancel", function () {
  dragId = null;
  dragSampleT = 0;
  dragVelX = 0;
  dragVelY = 0;
  spinY = 0;
  spinX = 0;
});
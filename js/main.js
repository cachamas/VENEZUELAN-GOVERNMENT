import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { getDisplay, player as radioPlayer, TRACKS as radioTracks, mixInfo as radioDisplayDebug, setRadioDisplayLite, setRadioDisplayActive } from "./radioDisplay.js";
import { lightCues, LIGHT_CUE_LEVELS } from "./lightCues.js";
import { FONT5x7 } from "./radioDisplay.js";
import { getMainDisplay, setOverlayHover, setMainDisplayLite } from "./mainDisplay.js";
import { openAboutBrowser, isAboutBrowserOpen } from "./aboutBrowser.js";
import { openContactCard, closeContactCard, isContactCardOpen, stepContactCard, initContactCard, renderContactCardComposite, contactDebug, resyncContactCardLayout, setContactCardLite } from "./contactCard.js";
import { createPerf } from "./perf.js";
import { initCrashLog, setRoom as crashLogSetRoom, crashLogState, note as crashLogNote } from "./crashlog.js";

/* ------------------------------------------------------------------ */
/*  config                                                             */
/* ------------------------------------------------------------------ */

// every model in the exhibit; MENU -> scene mapping below
const SCENES = {
  MAIN:    { name: "MAIN",    file: "media/models/MAIN_compressed.glb" },
  TORIS:   { name: "TORIS",   file: "media/models/TORIS_compressed.glb" },
  ART:     { name: "ART",     file: "media/models/ART_compressed.glb" },
  CLOTHES: { name: "CLOTHES", file: "media/models/CLOTHES_compressed.glb" },
  MUSIC:   { name: "MUSIC",   file: "media/models/MUSIC_compressed.glb" },
};
const MENU_TO_SCENE = { "3D": "TORIS", ART: "ART", CLOTHES: "CLOTHES", MUSIC: "MUSIC" };

// inverted parallax at 10% of the original strength. The VERTICAL axis is 2x
// as dramatic as the horizontal: pitch rotation and up/down drift both double
// (PARALLAX_SHIFT_Y) so the view rides up and down freely, while yaw and the
// left/right drift keep the old gentler values. Updated: the vertical axis is
// now 4x the horizontal (pitch/shiftY doubled again) for a stronger sway.
const PARALLAX_YAW = -0.007;
const PARALLAX_PITCH = -0.0248;
const PARALLAX_SHIFT_X = -0.003;
const PARALLAX_SHIFT_Y = -0.012;

// while the cursor is over a menu the fly-through slows to this fraction so
// the player doesn't have to chase a moving button (damped smoothly)
const HOVER_DAMP = 0.85;

// per-scene camera framing. Each scene can nudge its authored camera in
// camera-local axes — right (+), down (+), and back/further-away (+), each as
// a fraction of the view extent at the focal distance (right/down) or of the
// focal distance itself (back). Zero means "no offset". To retune a scene's
// shot, edit one number here. Applied every frame by applySceneFrame and
// compensated exactly when a scene root is placed for a handover turn.
const SCENE_CAM = {
  MAIN:    { right: -0.13, down: 0.1, back: 0 },
  // `down` walked 0.57 -> 0.45 -> 0.34 -> 0.14: the lens sat so low that the
  // near floor edge clipped through the bottom of the frame, and every milder
  // nudge was still reading as "under the floor". `down` is a fraction of the
  // half-height of the view at the focus distance, so 0.14 is a real lift
  // (~1.5 units at this room's scale) and 0.57 was a dive. `back` 0.60 -> 0.28
  // for the same reason the portrait dolly came down: the room read small and
  // distant. Raise `down` toward 0.4 for the old low, floor-heavy shot.
  CLOTHES: { right: -0.5,    down: 0.14, back: 0.28 },
  ART:     { right: -0.2,    down: 0.10, back: 0 },
  TORIS:   { right: 0,    down: 0.20, back: 0.30 },
  MUSIC:   { right: 0,    down: 0.024, back: 0 },
};
const DEFAULT_CAM = { right: 0, down: 0, back: 0 };
const FOCUS = new THREE.Vector3(0, 1.45, 0);
// MAIN's framing eases from the SCENE_CAM start shot to a settled shot over
// the first `endFrame` frames of its camera animation, then stays put — the
// camera loop ping-pongs frames 500..720, so once the intro has played the
// framing is the settled shot forever.
const CAM_RAMP = {
  MAIN: { to: { right: -0.09, down: 0.03, back: 0 }, endFrame: 500 },
};
// framing distances are clamped so outlier geometry (a stray mesh hundreds of
// metres from the camera path) can't inflate a "20% lower" into a 40m swing.
// 6m keeps the physical offsets moderate: right/down stay small fractions of
// the view while back stays a few metres at most.
const MAX_FRAME_DIST = 6;

/* ------------------------------------------------------------------ */
/*  PORTRAIT FIT — the whole 3D view adapting to a tall phone screen     */
/* ------------------------------------------------------------------ */
/*                                                                       */
/*  THE LENS IS BARELY TOUCHED. The GLB cameras ship a fixed vertical FOV    */
/*  that the shots were composed for, and the scenes are deliberately         */
/*  composed for a TALL, VERTICAL frame — so a phone should see through       */
/*  essentially the same lens the desktop uses. An earlier version of this     */
/*  file rebuilt the vertical FOV in portrait to "recover" the horizontal      */
/*  field a narrow aspect throws away; that was wrong. It undid the whole       */
/*  point of composing for a vertical frame, and it read as the camera being   */
/*  too far away rather than as a room problem.                                */
/*                                                                         */
/*  Portrait now only asks for a modest pull-back — a handful of degrees of    */
/*  lens, not a rebuild of it. One number, `level`, is the fraction of the     */
/*  authored horizontal field the viewport throws away (0 at 16:9 and above,   */
/*  ~0.74 on a 390x844). Everything scales off it:                             */
/*                                                                         */
/*    lens     + level * PORTRAIT_FOV_WIDEN degrees. Small and linear, so a   */
/*             phone lands within a few degrees of the authored lens and a    */
/*             wide desktop is untouched.                                     */
/*    dolly    sceneFrameOffset adds level * PORTRAIT_BACK_MAX of the focus   */
/*             distance straight back down the view axis. A FRACTION of the   */
/*             focus distance, so it stays a small absolute nudge even though  */
/*             the scenes are ~160 units across.                              */
/*    shift    ...and level * PORTRAIT_SHIFT_RIGHT of the view width along the */
/*             camera's right axis. Sign matters, and it is the opposite of    */
/*             what it looks like:                                       */
/*               POSITIVE moves the CAMERA right, so the room slides          */
/*                         screen-LEFT. Used to have been +0.1, which pushed  */
/*                         the subject too far left and left the right half   */
/*                         of a portrait screen empty.                         */
/*               NEGATIVE moves the camera LEFT, so the room slides           */
/*                         screen-RIGHT and more of the room's left side      */
/*                         comes into view.                                    */
/*             It is now the same magnitude as the +0.1 that used to live here */
/*             but in the direction that was actually needed: +0.1 pushed the  */
/*             subject too far left and opened an empty gap on the right.      */
/*                                                                         */
/*  Landscape — desktop, or a phone on its side — is bit-for-bit unchanged,   */
/*  because level is 0 there and all three terms vanish.                      */
/*                                                                         */
/*  All three ride inside the normal framing path, so a scene handover still   */
/*  lands exactly on the turned pose (placeSceneRootFramed solves against the */
/*  same functions).                                                          */
/* ------------------------------------------------------------------ */

// the aspect the shots were authored against: at or above this, no fit at all
const PORTRAIT_REF_ASPECT = 16 / 9;
// Extra vertical FOV at full portrait, in DEGREES (not a ratio). A deliberate
// nudge: the scenes are composed for a tall frame, so they only need to open
// up a little to clear the near geometry, not to be rebuilt for landscape.
// 17.5 lands a 390x844 phone on 73 degrees (level 0.74), which is the tuned
// framing: enough headroom to see the whole subject without the room going
// wide and flat. 0 leaves the authored lens exactly as authored; 25+ starts to
// undo the vertical composition again.
const PORTRAIT_FOV_WIDEN = 17.5;
// extra dolly at full fit, as a fraction of the focus distance (the same unit
// SCENE_CAM's `back` uses). Deliberately tiny: every 0.01 here costs about half
// a percent of the framing, because a pull-back is the one thing that pushes
// the camera AWAY from the subject. 0.04 works out to ~3% of the focus
// distance on a 390x844 phone. Raise to 0.08+ if the portrait view starts
// clipping through walls; drop to 0 for the tightest possible crop.
const PORTRAIT_BACK_MAX = 0.04;
// Framing nudge along the camera's right axis, as a fraction of the view width
// at full portrait. See the sign note above. Negative = camera moves left,
// room slides right, more of the room's LEFT side comes into view. This is the
// same magnitude as the +0.1 that used to live here, but in the direction that
// was actually needed: a phone at -0.10 leans 7.4% of the frame left of
// centre. Set 0 for dead centre.
const PORTRAIT_SHIFT_RIGHT = -0.1;
// live viewport state, refreshed by syncViewport (also on every resize /
// orientation change). `level` is the 0..1 fit level, `aspect` the current
// viewport aspect.
const fit = { level: 0, aspect: 1 };

// how much of the authored horizontal field this viewport loses: 0 at (or
// above) PORTRAIT_REF_ASPECT, rising linearly as the frame gets taller, ~0.74
// on a 390x844 phone. Linear in the aspect ratio on purpose — it is exactly
// the horizontal-width loss the pullback + shift exist to make up for, so both
// stay proportional to how portrait the screen actually is.
function portraitLevel(aspect) {
  if (!(aspect > 0) || aspect >= PORTRAIT_REF_ASPECT) return 0;
  return 1 - aspect / PORTRAIT_REF_ASPECT;
}

// The portrait lens: the authored FOV plus a small linear widening. A plain
// additive degree offset, NOT a rebuild of the lens — the scenes are composed
// for a tall frame, so the phone only needs to open up a little. Landscape
// returns the authored value untouched.
function fitFov(baseFov, aspect) {
  return baseFov + portraitLevel(aspect) * PORTRAIT_FOV_WIDEN;
}

// camera loop: play the full animation once, then ping-pong the last segment
// (frames 500..720 forward, then 720..500 backward) — no hard wrap jump
const CAM_FPS = 24;
const CAM_START = 500 / CAM_FPS;
const CAM_END = 719 / CAM_FPS;

// per-scene camera loop ranges that change over time. MUSIC plays in phases:
// frames 0..550 until the player interacts, clicking an interaction (STEREO,
// RADIOBASE, CHAVEZHEAD, stand, HEADPHONES) or a button (PLAYPAUSE, INSTAGRAM,
// FORWARD, BACKWARD, SPOTIFY, YOUTUBE) jumps the camera straight to frame 560
// and the loop becomes the standby 700..970. A second click on empty space
// plays the zoom-out exit (977..1085) and, on completing it, returns to the
// base 0..550 loop (starting from frame 0, so every re-entry starts fresh).
const SCENE_LOOP = {
  MUSIC: {
    baseStart: 0,
    baseEnd: 550 / CAM_FPS,
    jump: 560 / CAM_FPS,
    afterStart: 700 / CAM_FPS,
    afterEnd: 970 / CAM_FPS,
    exitStart: 977 / CAM_FPS,
    exitEnd: 1085 / CAM_FPS,
  },
  // ART plays its intro from frame 0 once (camera fly-in, laptop opening,
  // laptopshade fade 124..134), then settles into the desk idle loop 342..600.
  // Clicking DESK / laptop top / laptop bottom / laptopshade (only possible
  // from frame 330 on) glides the camera into the close-up loop 601..720 and
  // it becomes interactive. After the first pass reaches 720 the loop narrows
  // to 650..720 so the deep zoom-in only plays during the entry glide.
  ART: {
    baseStart: 342 / CAM_FPS,
    baseEnd: 600 / CAM_FPS,
    interactStart: 601 / CAM_FPS,
    interactEnd: 720 / CAM_FPS,
    interactBounceStart: 650 / CAM_FPS,
  },
};

// --- ART INTERACTION TUNING (manually tweak these) --------------------------
// ART_INTERACT_AFTER: the laptop is clickable (and glows) only at/after this
//   camera frame; before it the intro plays uninterrupted.
// ART_ENTER_TARGET_FRAME: when interaction begins the camera eases to this
//   frame instead of snapping to the loop start.
// ART_ENTER_SEC: how long that entry glide takes (seconds).
// ART_CAM_INTERACT: PERSISTENT framing while the interactive loop is active.
//   `back` pulls the camera FURTHER AWAY (fractions of the dist to the laptop),
//   `right` shifts it right (flip the sign to go the other way), `down` lowers
//   it. This is what fixes the "only the bottom-left corner of the screen is
//   visible" framing so the whole laptop screen fits for the entire loop.
// -----------------------------------------------------------------------------
const ART_INTERACT_AFTER = 330;
const ART_ENTER_TARGET_FRAME = 640;
const ART_ENTER_SEC = 1.2;
const ART_CAM_INTERACT = { right: -0.06, down: 0.10, back: 0.18 };
// laptopshade fade-out window (camera frames): the laptop cover fades away to
// reveal the screen. Authored at 124..134; shifted 40 frames EARLIER (84..94)
// so the screen becomes visible sooner.
const ART_SHADE_FADE_START = 84;
const ART_SHADE_FADE_END = 94;
// ART popup cascade: clicking a window opens its artwork in a modal, then the
// rest of the portfolio pops in one at a time every ART_POPUP_INTERVAL ms
// (draggable + closable), until the whole set has appeared. Opening an art
// never closes previously opened popups. The modal browses the whole
// portfolio: swipe left/right on it, press the arrow keys, or use the two
// bottom-center arrow buttons — each swaps image + info.
const ART_POPUP_INTERVAL = 2200;
// horizontal drag distance on the modal that counts as "swipe to next/prev"
const ART_POPUP_SWIPE_PX = 60;
// every artwork shows this line (links to the site)
const ART_PORTFOLIO_URL = "https://alejandroenrique.com";

// handover: a simple 180-degree POV turn in place — no flying across the
// scene. Clicking a scene button swings the camera to the RIGHT, the back
// button to MAIN swings LEFT. The target scene's root is placed so its
// authored + framed camera lands exactly on the turned pose, so returning to
// MAIN resumes precisely where it left off. Swap at the halfway point.
const TURN_SEC = 1.6;
const TURN_LEFT = 1;
const TURN_RIGHT = -1;

// after a turn completes the view is handed to the target scene's camera and
// briefly LERPED from the exact turn endpoint to the target's framed pose
// (REACQUIRE_SEC). Normally that distance is ~zero because the placement is
// exact; the lerp + double-check in finishReacquire guarantee the two always
// agree, so every scene change settles identically.
const REACQUIRE_SEC = 0.4;

// on EXIT a scene's textures are re-rolled, but only after a beat — the turn
// animation gets to fully play (the source root is hidden at the halfway
// point, ~0.8s into the 1.6s turn) and the texture swap happens while the
// scene is out of view, so no pop or swap-in is ever visible.
const REROLL_DELAY_MS = 1000;

// horror "failing light" flicker: every flickerable emissive material swings
// UNIFORMLY off one broken-light signal (walls, murals, the dim set and ATM1
// all at the same depth — only HTML / OVERLAY stay fully static). The light
// STAYS LIT: dips are shallow (never near-black) and the signal sits near full
// most of the time, with the odd brief pop ABOVE full (HORROR_BLIP_*) so it
// reads as a weak bulb flickering, not a light going out. The BUS flickers
// the same way but a little softer (BUS_SOFTEN) because it's further away.
const HORROR_FLOOR = 0.5; // never dimmer than this fraction of full
const HORROR_CEIL = 1.2; // occasionally brighter than full, for a moment
const HORROR_DIP_MIN = 0.15;
const HORROR_DIP_MAX = 0.9;
const HORROR_DIP_CHANCE = 0.3;
const HORROR_DIP_LEVEL_MIN = 0.55;
const HORROR_DIP_LEVEL_MAX = 0.85;
const HORROR_BLIP_CHANCE = 0.25;
const HORROR_BLIP_MIN = 1.08;
const HORROR_BLIP_MAX = 1.2;
const HORROR_CALM_MIN = 0.8;
const HORROR_CALM_MAX = 2.2;
const BUS_SOFTEN = 0.6;

// meshes that must stay fully static under the horror light — everything else
// (including ATM1, the BUS, DYNAMIC, smoke, â€¦) is flickerable
const STATIC_MESH = /^(HTML|OVERLAY)$/;
const ATM_MESH = /^ATM1$/;
const BUS_MESH = /^BUS$/;

// CLOTHES runs the same "broken light" flicker, now kept GENTLE so the baked
// scene never reads too dark: dips fall only ~45% dark at worst (and usually
// less), blips pop ~3-5% brighter, dips are rarer/shorter and calm spells
// longer. EVERY material swings off the same signal — emissive and unlit alike
// (unlit materials are MeshBasic, so their COLOR is scaled) — EXCEPT the static
// `SKY` backdrop(s) and the `skylights` glass, which keeps its own flare pulse
// in stepSkylightPulse. NIGHTSKY flickers with the rest.
const CLOTHES_HORROR_FLOOR = 0.55;         // deepest dip: only 45% dark
const CLOTHES_HORROR_CEIL = 1.05;          // brightest blip: 5% brighter
const CLOTHES_HORROR_DIP_CHANCE = 0.25;
const CLOTHES_HORROR_DIP_MIN = 0.2;
const CLOTHES_HORROR_DIP_MAX = 0.7;
const CLOTHES_HORROR_DIP_LEVEL_MIN = 0.55;
const CLOTHES_HORROR_DIP_LEVEL_MAX = 0.85;
const CLOTHES_HORROR_BLIP_CHANCE = 0.15;
const CLOTHES_HORROR_BLIP_MIN = 1.02;
const CLOTHES_HORROR_BLIP_MAX = 1.05;
const CLOTHES_HORROR_CALM_MIN = 0.9;
const CLOTHES_HORROR_CALM_MAX = 2.4;
// meshes/materials that must stay fully static in CLOTHES (SKY backdrops; the
// skylights glass keeps its own flare, so it's excluded here too)
const CLOTHES_STATIC = /^(SKY|SKYLIGHTS)$/i;

// interactive menu planes
const MENU_NAMES = ["3D", "ART", "ABOUT", "CONTACT", "CLOTHES", "MUSIC"];
const MENU_HOVER = 0.35;
const MENU_FLASH = 0.6;
const MENU_FLASH_SEC = 0.6;
// with no lights the labels are pure emissive (baked); a hover needs a much
// higher emissive to read as brightly as the old baseColor x light did
const MENU_EMISSIVE = 2.0;

/* ------------------------------------------------------------------ */
/*  DOM                                                                */
/* ------------------------------------------------------------------ */

const stage = document.getElementById("stage");
const loadingEl = document.getElementById("loading");
const titleEl = document.getElementById("title");
const subtitleEl = document.getElementById("subtitle");
const backEl = document.getElementById("back");
const zoomOutEl = document.getElementById("zoomout");
const muteEl = document.getElementById("mute");
const ctrls = document.getElementById("ctrls");
const torisArrowL = document.getElementById("toris-left");
const torisArrowR = document.getElementById("toris-right");
const langChoiceEl = document.getElementById("lang-choice");
const langBadgeEl = document.getElementById("lang-badge");
const langEsEl = document.getElementById("lang-es");
const langEnEl = document.getElementById("lang-en");
const langSepEl = document.querySelector("#lang-choice .lang-sep");
const roomLoadingEl = document.getElementById("room-loading");
const roomLoadingDots = document.getElementById("room-loading-dots");

// The first-load overlay (#loading) is a hard black cut over the whole
// viewport. That is right when the site has nothing to show yet, and wrong for
// a room change: the current room is alive and rendering, and covering it reads
// as the site restarting. Room changes therefore use a small quiet indicator
// instead and the handover simply plays when the next room is ready (the
// pendingTarget path in loadScene already supports that).
let roomLoadDepth = 0;
// how many times the first scene has failed and been retried. One retry is a
// transient network blip worth surviving; a second means a clean reload.
let loadRetries = 0;
function setRoomLoading(on) {
  if (!roomLoadingEl) return;
  roomLoadDepth = Math.max(0, roomLoadDepth + (on ? 1 : -1));
  const show = roomLoadDepth > 0;
  if (show && roomLoadingDots && !roomLoadingDots.childElementCount) {
    roomLoadingDots.innerHTML = "<i></i><i></i><i></i>";
  }
  roomLoadingEl.hidden = !show;
}

// The first-load overlay's visible text belongs to js/loadingScreen.js, which
// owns the "LOADING PORTFOLIO" label and its animated ellipsis. This used to
// overwrite it with "loading MAIN_compressed.glb…", which destroyed that
// markup mid-animation. The message is still recorded - on the element and in
// the console - it is just no longer rendered over the top of the design.
function setLoading(msg) {
  if (msg) {
    loadingEl.dataset.loadingMsg = msg;
    console.log("[loading]", msg);
    loadingEl.classList.remove("hide");
  } else {
    loadingEl.classList.add("hide");
  }
}

function setTitle() {
  if (!active || !titleEl) return;
  titleEl.textContent = active.name;
}

/* ------------------------------------------------------------------ */
/*  renderer / scene / lights                                          */
/* ------------------------------------------------------------------ */

// RENDER RESOLUTION + EDGE QUALITY — both now driven by js/perf.js, which
// probes the hardware and then adapts to measured frame rate. Two things are
// worth keeping in mind about where the cost is:
//   the scenes are lit entirely by baked emissive textures, with no real
//   lights and no shadows, so the frame is almost purely fill rate — cost
//   goes as (pixel ratio)^2, and the pixel ratio is the only big lever that
//   moves at runtime.
//   antialias is fixed at context creation (a WebGLRenderer cannot toggle
//   MSAA afterwards), so perf.js decides it ONCE from the hardware probe. It
//   is on by default and off for a device that already looks weak, which is
//   the same trade as before but decided by evidence rather than by "is this
//   a phone".
// Overrides for testing a specific device without a rebuild: ?q=minimum (or
// high/medium/low), ?pr=1.25 (pixel-ratio cap), ?lite=1.
const perf = createPerf();
const isTouchDevice = matchMedia("(pointer: coarse)").matches;

let renderer;
try {
  renderer = new THREE.WebGLRenderer({
    antialias: perf.antialias,
    alpha: false,
    powerPreference: "high-performance",
  });
} catch (err) {
  // some mobile WebViews reject `antialias`/`powerPreference` outright
  renderer = new THREE.WebGLRenderer();
}
renderer.setPixelRatio(perf.pixelRatio());
renderer.setSize(window.innerWidth, window.innerHeight);
console.log("[perf] start tier " + perf.name + " (antialias " + perf.antialias +
  ") — " + perf.probe.reason);
if (perf.probe.gpu) console.log("[perf] gpu: " + perf.probe.gpu);
renderer.outputColorSpace = THREE.SRGBColorSpace;
stage.appendChild(renderer.domElement);
initContactCard(renderer);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);

// no lights at all — the models are fully baked (lighting is in the emissive
// textures), so adding lights washes the render out like Blender's "material
// preview" mode instead of "rendered" mode

/* ------------------------------------------------------------------ */
/*  scene registry                                                     */
/* ------------------------------------------------------------------ */

// camera = the ACTIVE camera node used for rendering (a child of its scene root)
let camera = null;
let active = null; // active scene entry
let turn = null;   // active 180-degree handover, if any
let reacquire = null; // post-turn camera settle (lerp + double-check), if any
let retrackNext = false; // one post-reacquire re-track frame to guarantee centering
let pendingTarget = null;

// after a reacquire settles, ease the resumed fly-through speed up over a short
// window so the camera glides into motion instead of snapping back to full speed
const RESUME_SEC = 0.6;
let resumeRamp = 0; // seconds of speed ramp remaining after a settle

// scratch vectors for the smooth root+camera glide (see stepReacquire)
const _rv = new THREE.Vector3();
const _rv2 = new THREE.Vector3();
const _rq = new THREE.Quaternion();
const _rq2 = new THREE.Quaternion();
const _rootKeepP = new THREE.Vector3();
const _rootKeepQ = new THREE.Quaternion();

// last handover captured at the exact start/end poses (debug/verification)
let handoffInfo = null;
let returnInfo = null;

const scenes = {};
Object.keys(SCENES).forEach(function (k) {
  scenes[k] = {
    name: k,
    file: SCENES[k].file,
    gltf: null,
    root: null,
    camNode: null,
    mixers: [],
    posTrack: null,
    rotTrack: null,
    camT: 0,
    dir: 1,
    loopStart: 0,
    loopEnd: 0,
    focal: null, // world center of this scene's room (framing distance anchor)
    baseFov: null, // the lens as authored in the GLB (the portrait fit maps off this)
    roomPending: false, // a room change is fetching this one; drives the quiet indicator
    state: "unloaded",
  };
});

// shared scratch
const _m4 = new THREE.Matrix4();
const _qI = new THREE.Quaternion();
const _pos = new THREE.Vector3();
const _q0 = new THREE.Quaternion();
const _q1 = new THREE.Quaternion();
const _quatW = new THREE.Quaternion();
const _qAxis = new THREE.Quaternion();
const _vp = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _w2l = new THREE.Vector3();
const _w2lt = new THREE.Vector3();
const _cwp = new THREE.Vector3();
const _upAxis = new THREE.Vector3(0, 1, 0);
const _lp = new THREE.Vector3();
const _lp2 = new THREE.Vector3();
const _lq = new THREE.Quaternion();
const _lq2 = new THREE.Quaternion();
const _qT = new THREE.Quaternion();
const _baseP = new THREE.Vector3();
const _sh = new THREE.Vector3();
const _rightV = new THREE.Vector3();
const _upV = new THREE.Vector3();
const _backV = new THREE.Vector3();
const _off = new THREE.Vector3();
const _dirV = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v4 = new THREE.Vector3();

/* ------------------------------------------------------------------ */
/*  loading                                                            */
/* ------------------------------------------------------------------ */

const loader = new GLTFLoader();
const draco = new DRACOLoader();
draco.setDecoderPath("https://www.gstatic.com/draco/versioned/decoders/1.5.6/");
loader.setDRACOLoader(draco);

function findCameraTracks(s) {
  if (!s.camNode) return null;
  const prefix = s.camNode.name + ".";
  for (let i = 0; i < s.gltf.animations.length; i++) {
    const clip = s.gltf.animations[i];
    const pos = clip.tracks.find(function (t) { return t.name === prefix + "position"; });
    const rot = clip.tracks.find(function (t) { return t.name === prefix + "quaternion"; });
    if (pos || rot) return { pos: pos, rot: rot };
  }
  return null;
}

// push the current viewport into one scene camera. The FOV is the AUTHORED one
// plus the small portrait widening; the rest of the portrait adaptation is the
// pullback + framing shift in sceneFrameOffset.
function applySceneFit(s) {
  const cam = s.camNode;
  if (!cam || s.baseFov == null) return;
  cam.aspect = fit.aspect;
  cam.fov = fitFov(s.baseFov, fit.aspect);
  cam.updateProjectionMatrix();
}

function setCamera(s) {
  const cam = s.camNode;
  // the GLBs ship with near = 0.001, which wastes the depth buffer on a
  // 1000-unit scene: at the figure's ~160-unit distance a depth step is ~3m,
  // so coincident surfaces (dress over body, wall decals) z-fight into black
  // triangles. 0.1 keeps a safe margin for the camera's lowest dips (~1.3m)
  // while making the depth step at the figure ~3cm.
  cam.near = 0.1;
  // remember the authored lens once, then hand the camera the PORTRAIT-FIT one
  // for the current viewport (a no-op on every landscape screen)
  if (s.baseFov == null) s.baseFov = cam.fov;
  applySceneFit(s);
  const tracks = findCameraTracks(s);
  if (tracks && tracks.pos) {
    s.posTrack = tracks.pos;
    s.rotTrack = tracks.rot || null;
    if (s.name === "MAIN") {
      s.loopStart = CAM_START;
      s.loopEnd = CAM_END;
    } else {
      const lc = SCENE_LOOP[s.name];
      if (lc) {
        s.loopStart = lc.baseStart;
        s.loopEnd = lc.baseEnd;
      } else {
        s.loopStart = s.posTrack.times[0];
        s.loopEnd = s.posTrack.times[s.posTrack.times.length - 1];
      }
    }
    s.camT = 0;
    s.dir = 1;
  } else {
    console.warn("no camera animation found in", s.name);
    s.posTrack = null;
  }
}

// one mixer per skinned armature (root of each skinned mesh) plus one scene
// mixer for everything else. Several rigs in the GLBs share bone names
// ("spine.004", "spine.005", ...) so a single scene mixer would bind every
// clip to the FIRST matching bone and all the actions would fight on it;
// grouping by armature keeps each rig on its own bones. Each clip is given to
// the SMALLEST armature whose subtree covers all of its track names, so e.g.
// MAIN's "Action.001" lands on the BAG1 rig (3 bones) not the full TECHO rig.
function setupSceneMixer(s) {
  const prefix = (s.camNode ? s.camNode.name : "") + ".";
  const arms = [];
  const seen = new Set();
  s.root.traverse(function (o) {
    if (!o.isSkinnedMesh || !o.parent || seen.has(o.parent)) return;
    seen.add(o.parent);
    arms.push(o.parent);
  });
  const nameSets = arms.map(function (a) {
    const set = new Set();
    a.traverse(function (o) { set.add(o.name); });
    return set;
  });
  const clips = s.gltf.animations.map(function (clip) {
    const names = new Set();
    clip.tracks.forEach(function (t) {
      const dot = t.name.lastIndexOf(".");
      if (dot > 0) names.add(t.name.slice(0, dot));
    });
    return { clip: clip, names: names };
  });
  const armClips = arms.map(function () { return []; });
  const sceneClips = [];
  clips.forEach(function (c) {
    if (c.clip.tracks.some(function (t) { return t.name.indexOf(prefix) === 0; })) return;
    if (c.names.size > 0) {
      let best = -1;
      let bestSize = Infinity;
      for (let i = 0; i < arms.length; i++) {
        if (nameSets[i].size < c.names.size) continue;
        let all = true;
        c.names.forEach(function (n) { if (!nameSets[i].has(n)) all = false; });
        if (all && nameSets[i].size < bestSize) { best = i; bestSize = nameSets[i].size; }
      }
      if (best >= 0) { armClips[best].push(c); return; }
    }
    sceneClips.push(c);
  });
  s.mixers = [];
  const isOneShot = function (c) {
    // ART: every clip plays once and freezes on its final pose — only the
    // Cube.018Action.* selknam action loop is meant to repeat endlessly.
    if (s.name === "ART") return !/^Cube\.018Action/.test(c.name);
    return c.name === "Plane.004Action";
  };
  // "static tail" of a clip: how long the animation sits motionless before the
  // clip ends. The character's Action (52s) walks 0..42 then HOLDS the start
  // pose until 52 — a 10s freeze. Action.001 (42s) is the same walk with no
  // tail, ending exactly back at the start pose, so it loops seamlessly.
  // When duplicate actions exist for a rig, prefer the seamless one.
  const clipStaticTail = function (c) {
    let last = 0;
    c.tracks.forEach(function (t) {
      if (!/\.position$/.test(t.name)) return;
      const times = t.times, values = t.values;
      const comps = values.length / times.length;
      for (let k = 1; k < times.length; k++) {
        let d = 0;
        for (let c0 = 0; c0 < comps; c0++) d += Math.abs(values[k * comps + c0] - values[(k - 1) * comps + c0]);
        if (d > 1e-4 && times[k] > last) last = times[k];
      }
    });
    return c.duration - last;
  };
  arms.forEach(function (a, i) {
    const list = armClips[i];
    if (!list.length) return;
    // duplicate actions for the same rig: keep the one that animates right up
    // to its end (no static tail), then the longest, then the most channels
    list.sort(function (x, y) {
      return (clipStaticTail(x.clip) - clipStaticTail(y.clip)) ||
        (y.clip.duration - x.clip.duration) ||
        (y.clip.tracks.length - x.clip.tracks.length);
    });
    const kept = [];
    list.forEach(function (c) {
      let overlap = false;
      for (let k = 0; k < kept.length; k++) {
        let hit = false;
        c.names.forEach(function (n) { if (kept[k].names.has(n)) hit = true; });
        if (hit) { overlap = true; break; }
      }
      if (!overlap) kept.push(c);
    });
    const mixer = new THREE.AnimationMixer(a);
    kept.forEach(function (c) {
      const action = mixer.clipAction(c.clip).play();
      if (isOneShot(c.clip)) { action.setLoop(THREE.LoopOnce, 1); action.clampWhenFinished = true; }
    });
    s.mixers.push(mixer);
    console.log("[anim] rig", a.name, "plays", kept.map(function (c) { return c.clip.name; }).join(", "));
  });
  if (sceneClips.length) {
    const mixer = new THREE.AnimationMixer(s.root);
    sceneClips.forEach(function (c) {
      const action = mixer.clipAction(c.clip).play();
      if (isOneShot(c.clip)) { action.setLoop(THREE.LoopOnce, 1); action.clampWhenFinished = true; }
    });
    s.mixers.push(mixer);
    console.log("[anim] scene plays", sceneClips.map(function (c) { return c.clip.name; }).join(", "));
  }
  console.log("[anim]", s.name, "mixers:", s.mixers.length);
}

function loadScene(name, onReady, silent) {
  const s = scenes[name];
  if (s.state !== "unloaded") {
    if (onReady) onReady(s);
    return;
  }
  s.state = "loading";
  const firstEver = active === null;
  if (!silent && firstEver) {
    // only the site's FIRST load uses the full-screen overlay; a room change
    // must not black out a world that is still running behind it
    setLoading("loading " + s.file.split("/").pop() + "\u2026");
  } else if (!silent) {
    setRoomLoading(true);
    s.roomPending = true;
  }
  loader.load(
    s.file,
    function (gltf) {
      s.gltf = gltf;
      s.root = gltf.scene;
      gltf.scene.traverse(function (o) {
        if (o.isCamera && !s.camNode) s.camNode = o;
      });
      scene.add(s.root);
      s.root.visible = false;
      makeUnlit(gltf);
      stabilizeDecals(gltf);
      s.root.updateMatrixWorld(true);
      const _box = new THREE.Box3().setFromObject(s.root);
      s.focal = _box.getCenter(new THREE.Vector3()).clone();

      if (name === "MAIN") {
        s.root.visible = true;
        active = s;
        camera = s.camNode;
        removeDynamic(gltf);
        setupMenus(gltf);
        collectHorror(gltf);
        applyFlyTextures();
        initMainTextureInjection();
        shiftOverlayLeft(gltf);
        setupOverlayDisplay(gltf);
        document.body.classList.add("ready");
        preloadOthers();
      } else if (name === "MUSIC") {
        setupMusic(gltf);
        setupRadioDisplay(gltf);
        setupMusicFlash(gltf);
      } else if (name === "CLOTHES") {
        setupObjectLinks(gltf);
        setupSkylightPulse(gltf);
        collectClothesHorror(gltf);
        initClothesTextureInjection();
        hideUntexturedSmoke(gltf);   // reveal it only once the atlas is applied
      } else if (name === "TORIS") {
        initTorisTextureInjection();
      } else if (name === "ART") {
        setupArt(gltf);
      }
      setCamera(s);
      setupSceneMixer(s);
      s.state = "ready";
      if (s.roomPending) { s.roomPending = false; setRoomLoading(false); }
      setLoading(null);
      setTitle();
      updateBackControl();
      // initial UI presentation: flash the arrows once when MAIN first appears
      // (scene handovers flash again in finishTurn)
      if (name === "MAIN" && !s.wasActive) flashDotArrows();
      s.wasActive = true;

      if (pendingTarget === s.name) {
        pendingTarget = null;
        startTurn(s);
      }
      if (onReady) onReady(s);
    },
    undefined,
    function (err) {
      console.error("failed to load", s.file, err);
      s.state = "unloaded";
      if (s.roomPending) { s.roomPending = false; setRoomLoading(false); }
      if (silent) return;
      // A failed load is the one error a visitor can act on, so it gets a real
      // control rather than a dead screen. RETRY re-issues this scene; if THAT
      // fails too, the page is reloaded, because the only way to clear a
      // half-initialised three.js state is a clean boot.
      if (firstEver) {
        const ls = window.__loadingScreen;
        if (ls && ls.showRetry) {
          loadRetries++;
          ls.showRetry(function () {
            if (loadRetries > 1) { location.reload(); return; }
            // NOT silent: silent would suppress the failure path, so a second
            // failure would leave the visitor staring at a frozen screen
            loadScene(s.name, null, false);
          });
          return;
        }
      }
      setLoading("failed to load " + s.file.split("/").pop());
    }
  );
}

// once MAIN is up and running, fetch the other four scenes quietly in the
// background (staggered so the decode threads don't all spike at once).
//
// SKIPPED — and ABANDONED MID-FLIGHT — when perf.preloadAll is false. All five
// scenes stay resident once loaded, and that resident set is what tips a
// low-memory device over its budget and gets the tab terminated: the failure
// looks like "the site crashed in one specific room" because the LAST scene to
// preload is the one that does it. Loading a room on demand instead (goToScene
// already handles the "unloaded" case) costs a wait on first entry and keeps
// peak memory at one scene.
//
// The re-check matters as much as the up-front test. This runs seconds after
// boot, long before the frame-rate watchdog has measured anything, so a device
// that probes healthy but is actually slow would be halfway through the
// preload by the time the watchdog forms an opinion. Checking again before
// EACH scene means a device that has already been pushed to a constrained tier
// stops where it stands instead of finishing the set.
function preloadOthers() {
  if (!perf.preloadAll) {
    console.log("[perf] background preload OFF — rooms load on demand (" +
      perf.probe.memoryNote + ")");
    return;
  }
  const queue = ["TORIS", "ART", "CLOTHES", "MUSIC"];
  queue.forEach(function (name, i) {
    setTimeout(function () {
      if (!perf.preloadAll) {
        console.log("[perf] preload abandoned before " + name +
          " — device measured as constrained; " +
          queue.slice(i).join(", ") + " will load on demand");
        return;
      }
      loadScene(name, null, true);
    }, 350 * (i + 1));
  });
}

function goToScene(name) {
  if (turn || name === active.name) return;
  if (name === "MAIN") {
    startTurn(scenes.MAIN);
    return;
  }
  const s = scenes[name];
  if (s.state === "ready") {
    startTurn(s);
    return;
  }
  pendingTarget = name;
  if (s.state === "unloaded") loadScene(name);
}

/* ------------------------------------------------------------------ */
/*  camera sampling (author-aided tracks)                              */
/* ------------------------------------------------------------------ */

const quatA = new THREE.Quaternion();
const quatB = new THREE.Quaternion();
const tmpPos = new THREE.Vector3();
const tmpPos2 = new THREE.Vector3();
const _focalV = new THREE.Vector3();

function sampleTrack(track, t, outPos) {
  const times = track.times;
  const values = track.values;
  const n = times.length;
  let i = 0;
  if (t <= times[0]) i = 0;
  else if (t >= times[n - 1]) i = n - 2;
  else while (i < n - 2 && times[i + 1] < t) i++;
  const f = (t - times[i]) / (times[i + 1] - times[i]);
  tmpPos.fromArray(values, i * 3);
  tmpPos2.fromArray(values, (i + 1) * 3);
  outPos.lerpVectors(tmpPos, tmpPos2, f);
}

function sampleQuat(track, t, outQuat) {
  const times = track.times;
  const values = track.values;
  const n = times.length;
  let i = 0;
  if (t <= times[0]) i = 0;
  else if (t >= times[n - 1]) i = n - 2;
  else while (i < n - 2 && times[i + 1] < t) i++;
  const f = (t - times[i]) / (times[i + 1] - times[i]);
  quatA.fromArray(values, i * 4);
  quatB.fromArray(values, (i + 1) * 4);
  outQuat.copy(quatA).slerp(quatB, f);
}

// ping-pong step: play 0..loopEnd once, then bounce loopStart..loopEnd so the
// cinematic pan glides forward and back without a jarring wrap. While the
// cursor hovers a menu the advance slows (HOVER_DAMP) so the button is easy
// to hit.
const focus = { level: 0 }; // 0 = full speed, 1 = fully damped (hovering)
// ART entry glide: ease the camera from wherever it is down to the target
// frame (ART_ENTER_TARGET_FRAME) over ART_ENTER_SEC instead of snapping to the
// loop start. Only the camera pose animates here — sampling + framing still
// run, so the close-up view slides in while the interactive framing blends in.
function stepArtEnter(dt) {
  const s = scenes.ART;
  if (!s || !s.camNode || !art.entering) return;
  resumeRamp = Math.max(0, resumeRamp - dt);
  const e = art.entering;
  e.t = Math.min(e.dur, e.t + dt);
  const k = 1 - Math.pow(1 - e.t / e.dur, 3);
  s.camT = e.from + (e.to - e.from) * k;
  if (e.t >= e.dur) {
    s.camT = e.to;
    art.entering = null;
  }
  sampleTrack(s.posTrack, s.camT, s.camNode.position);
  sampleQuat(s.rotTrack, s.camT, s.camNode.quaternion);
  applySceneFrame(s);
}
function stepCamera(dt, s) {
  if (!s || !s.camNode || !s.posTrack || !s.rotTrack) return;

  if (s.name === "ART" && art.entering) {
    stepArtEnter(dt);
    return;
  }

  // glide into full speed after a reacquire settle instead of snapping back
  const speed = resumeRamp > 0 ? (1 - resumeRamp / RESUME_SEC) : 1;
  resumeRamp = Math.max(0, resumeRamp - dt);
  // while the MAIN zoom-out is active, slide through the path 70% slower —
  // same feel as the hover slow-motion, just tied to the zoom state
  const zoomDamp = mainZoom.on ? MAIN_ZOOM_DAMP : 0;
  const damp = Math.max(0, 1 - HOVER_DAMP * focus.level - zoomDamp);
  s.camT += dt * s.dir * damp * speed;
  if (s.exiting && s.camT >= s.loopEnd) {
    // MUSIC zoom-out finished: land on the base loop (frame 0) + reacquire
    s.camT = s.loopEnd;
    finishMusicExit();
    return;
  }
  if (s.camT >= s.loopEnd) {
    s.camT = s.loopEnd;
    s.dir = -1;
  } else if (s.camT <= s.loopStart && s.dir < 0) {
    s.camT = s.loopStart;
    s.dir = 1;
  }

  sampleTrack(s.posTrack, s.camT, s.camNode.position);
  sampleQuat(s.rotTrack, s.camT, s.camNode.quaternion);
  applySceneFrame(s);
}

/* parallax: a cameraman's subtle look-around on top of the fly-through.
   Desktop drives it from the mouse position; touch drives it from a SWIPE. */
const look = { x: 0, y: 0 };
let mouseX = 0;
let mouseY = 0;
// strict reacquisition: after a turn-away the parallax is disarmed and only
// re-arms once the player actually moves the pointer again (see finishReacquire)
let parallaxArmed = false;
const parQ = new THREE.Quaternion();
const parEuler = new THREE.Euler();
const right = new THREE.Vector3();
const up = new THREE.Vector3();

/* ---- touch swipe parallax -------------------------------------------- */
// On a phone the pointermove that drives the desktop parallax only fires while
// a finger is down, so there is no resting position: the camera would freeze
// wherever the last touch happened and never come home. A swipe instead
// NUDGES the look offset from its rest pose and glides back to rest on
// release.
//
// THREE things make it feel right, and all three are deliberate:
//
//  1. INVERSE. The view moves AGAINST the finger — swipe right, the camera
//     looks left. That is the "you are pushing the room" feel, and it is why
//     the sign below is negative. Same direction as the finger reads as the
//     camera being dragged, which is not what a look-around should feel like.
//  2. IMMEDIATE, and CUMULATIVE. While the finger is down the view is welded
//     1:1 to it — no spring, no lag, nothing to catch up with. Swipes ADD to
//     the current offset rather than each one jumping to a fresh origin, so a
//     second swipe continues from where the first left the view instead of
//     yanking it back first (that snap-back was the last of the doughiness).
//     The accumulated offset eases back to rest once the finger lifts.
//  3. EXAGGERATED. The desktop cursor parallax is deliberately tiny
//     (PARALLAX_YAW is 0.007 rad — about a quarter of a degree, which is
//     right for a mouse you are barely moving). A thumb swipe is a much
//     bigger, faster gesture, so it gets SWIPE_EXAGGERATE times that amount.
//     Without this the effect is technically present and practically invisible.
//
// TUNING:
//   SWIPE_GAIN       look units per pixel of finger travel, normalised by the
//                    viewport. 1.25 means a swipe ~40% of the screen wide
//                    spends the whole of the parallax's range.
//   SWIPE_RANGE      the ceiling on the ACCUMULATED offset, in the same units.
//                    This is the "up to a certain point" — swipes keep adding
//                    up to here and no further, so the view never runs away.
//   SWIPE_RETURN     1/s that the accumulated offset decays once the finger is
//                    up. Frame-rate independent, so it is the same glide at
//                    30fps on a tablet and 120Hz on a phone — a fixed per-frame
//                    lerp would be twice as fast on one as the other.
const SWIPE_GAIN = 1.25;
const SWIPE_RANGE = 1;
const SWIPE_RETURN = 2.2;
const SWIPE_DEAD = 8;
// how many times the (very gentle) desktop parallax strengths the swipe uses
const SWIPE_EXAGGERATE = 7;
// The offset ACCUMULATES across swipes rather than being an absolute function
// of where the current swipe started. That is the fix for two things at once:
// the view no longer lags behind the thumb (a per-swipe spring has to catch up
// from wherever the last one left it, which is what reads as doughy), and a
// second swipe continues from where the first ended instead of yanking the view
// back to a fresh origin first.
const swipe = { x: 0, y: 0, id: null, sx: 0, sy: 0, travel: 0 };
// true while the last pointer activity came from a finger, so the camera reads
// the swipe rather than the (meaningless) last touch position. iOS fires
// compatibility mouse events straight after a tap, so the pointer handlers below
// only clear this when a real mouse move arrives with no recent touch.
let lastPointerWasTouch = false;

function swipeBegin(e) {
  if (e.pointerType !== "touch") return;
  lastPointerWasTouch = true;
  swipe.id = e.pointerId;
  swipe.sx = e.clientX;
  swipe.sy = e.clientY;
  swipe.travel = 0;
  parallaxArmed = true;
}
function swipeMove(e) {
  if (swipe.id !== e.pointerId) return;
  const dx = e.clientX - swipe.sx;
  const dy = e.clientY - swipe.sy;
  swipe.travel += Math.abs(dx) + Math.abs(dy);
  swipe.sx = e.clientX; // track incrementally now, since we accumulate
  swipe.sy = e.clientY;
  if (swipe.travel < SWIPE_DEAD) return; // still a tap, leave the camera alone
  // NEGATIVE = inverse: the view travels against the finger.
  swipe.x = clampRange(swipe.x - dx * 2 * SWIPE_GAIN / Math.max(1, window.innerWidth));
  swipe.y = clampRange(swipe.y - dy * 2 * SWIPE_GAIN / Math.max(1, window.innerHeight));
}
function swipeEnd(e) {
  if (swipe.id !== e.pointerId) return;
  swipe.id = null; // release: the update step glides the offset home
}
function clampRange(v) {
  return v < -SWIPE_RANGE ? -SWIPE_RANGE : v > SWIPE_RANGE ? SWIPE_RANGE : v;
}
function clampNdc(v) {
  return v < -1 ? -1 : v > 1 ? 1 : v;
}

document.addEventListener("pointerdown", function (e) {
  if (e.pointerType === "mouse" && !recentlyTouched()) lastPointerWasTouch = false;
  else lastPointerWasTouch = true;
  swipeBegin(e);
}, { passive: true });

// the authoritative touch signal — see the iOS note above isTouchEvent
document.addEventListener("touchstart", markTouch, { passive: true, capture: true });
document.addEventListener("touchend", markTouch, { passive: true, capture: true });

document.addEventListener("pointermove", function (e) {
  // iOS synthesises pointermove with pointerType "mouse" right after a tap;
  // recentlyTouched() keeps that from undoing the touch we just recorded
  if (e.pointerType === "mouse" && !recentlyTouched()) lastPointerWasTouch = false;
  else lastPointerWasTouch = true;
  mouseX = (e.clientX / window.innerWidth) * 2 - 1;
  mouseY = (e.clientY / window.innerHeight) * 2 - 1;
  parallaxArmed = true;
  swipeMove(e);
}, { passive: true });
document.addEventListener("pointerup", swipeEnd, { passive: true });
document.addEventListener("pointercancel", swipeEnd, { passive: true });
document.addEventListener("mouseout", function (e) {
  if (!e.relatedTarget) {
    mouseX = 0;
    mouseY = 0;
  }
});

function applyParallax(dt) {
  if (!camera) return;
  if (!parallaxArmed) {
    look.x = 0;
    look.y = 0;
    return;
  }
  // the look target: the cursor on desktop, the accumulated swipe offset under
  // a finger. On touch the offset is already 1:1 with the finger while it is
  // down (no spring, no lag); only the way HOME is eased.
  let tx, ty, mag, immediate;
  if (lastPointerWasTouch) {
    if (swipe.id === null) {
      // released: glide the accumulated offset back to rest. Frame-rate
      // independent, so the glide is identical at 30fps and 120fps.
      const k = 1 - Math.exp(-SWIPE_RETURN * dt);
      swipe.x += (0 - swipe.x) * k;
      swipe.y += (0 - swipe.y) * k;
    }
    tx = swipe.x;
    ty = swipe.y;
    // the swipe is a much bigger gesture than a cursor nudge, so it gets a much
    // bigger amplitude out of the same (very gentle) parallax constants
    mag = SWIPE_EXAGGERATE;
    immediate = true;
  } else {
    tx = mouseX;
    ty = mouseY;
    mag = 1;
    immediate = false;
  }
  if (immediate) {
    look.x = tx;
    look.y = ty;
  } else {
    look.x += (tx - look.x) * 0.05;
    look.y += (ty - look.y) * 0.05;
  }

  // damp the look-around too while hovering, so the camera isn't drifting past
  const pd = 1 - 0.7 * focus.level;
  parEuler.set(look.y * PARALLAX_PITCH * pd * mag, look.x * PARALLAX_YAW * pd * mag, 0, "YXZ");
  parQ.setFromEuler(parEuler);
  camera.quaternion.multiply(parQ);

  right.set(1, 0, 0).applyQuaternion(camera.quaternion);
  up.set(0, 1, 0).applyQuaternion(camera.quaternion);
  camera.position.addScaledVector(right, -look.x * PARALLAX_SHIFT_X * pd * mag);
  camera.position.addScaledVector(up, look.y * PARALLAX_SHIFT_Y * pd * mag);
}

/* ------------------------------------------------------------------ */
/*  180-degree turn-around handover                                    */
/* ------------------------------------------------------------------ */

// every model is baked: the lighting lives in the emissive textures, and the
// viewer adds no lights. A positive emissive (textured or solid colour)
// renders fine on its own with zero lights, so keep those; materials whose
// emissive is disabled (zero/negative factor) only ever showed through the old
// albedo x light term — without lights they must render their base-color
// content directly, so convert them to unlit MeshBasicMaterial. FLIES are
// handled separately (fly atlas).
function makeUnlit(gltf) {
  let n = 0;
  gltf.scene.traverse(function (o) {
    if (!o.isMesh || /^FLIES/.test(o.name)) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    mats.forEach(function (m) {
      if (m.userData.unlit) return;
      if (typeof m.emissiveIntensity !== "number") return; // already unlit
      if (m.userData.makeUnlitChecked) return;
      m.userData.makeUnlitChecked = true;
      const em = m.emissive;
      const emSum = em ? (em.r + em.g + em.b) : 0;
      if (emSum > 0.0001) return; // genuine emissive: glows without lights
      const basic = new THREE.MeshBasicMaterial();
      basic.name = m.name;
      if (m.map && m.map.isTexture) basic.map = m.map;
      basic.color.copy(m.color ? m.color : new THREE.Color(1, 1, 1));
      if (m.alphaMap && m.alphaMap.isTexture) basic.alphaMap = m.alphaMap;
      basic.transparent = m.transparent;
      basic.opacity = m.opacity;
      basic.depthWrite = m.depthWrite;
      basic.side = m.side;
      basic.alphaTest = m.alphaTest;
      basic.toneMapped = m.toneMapped;
      basic.userData.unlit = true;
      if (Array.isArray(o.material)) o.material[mats.indexOf(m)] = basic;
      else o.material = basic;
      n++;
      console.log("[unlit]", m.name, "-> MeshBasicMaterial" + (basic.map ? " (textured)" : ""));
    });
  });
  console.log("[unlit] converted", n, "emissive-less materials");
}

// every layer that sits ON a wall — murals, stickers, graffiti, signs, screens,
// labels, decals — lives within a hair of its surface. Any material that carries
// alpha (transparency, opacity, an alpha map, or an alpha test) is treated as a
// layer; pure solid opaque surfaces are left untouched so depth order stays
// authoritative. FLIES planes float free and are left alone.
//
// WHY THESE FLICKER, AND WHY THE OLD FIX DID NOT WORK
//
// In MAIN the wall is not a backdrop the decals sit in front of. Measured from
// the GLB, the translucent wall slab occupies z[-0.2509 .. -0.0105] — 240 mm —
// and the decals are INSIDE that band, not in front of it:
//
//   MURAL      z[-0.0747 .. -0.0665]   8 mm slab, fully inside the wall
//   GRAFFITI1  z[-0.0645 .. -0.0640]   0.5 mm, fully inside the wall
//   GRAFFITI2  z[-0.0599 .. -0.0594]   0.5 mm, fully inside the wall
//
// So the decal and the wall are interpenetrating transparent surfaces, and both
// are alphaMode=BLEND. That put BOTH through isLayer here, so both received the
// IDENTICAL polygonOffset(-1, -2). An offset applied equally to both members of
// a pair cancels: the relative depth was left exactly as the geometry had it, so
// the surfaces still fought, and because the fight is decided by depth
// resolution against camera distance it flipped as the intro dolly moved in.
// Deterministic, same camera position, every run - which is exactly how it
// presents.
//
// Two things have to change, and the measurements further down show that
// neither is sufficient alone:
//
//   1. DEPTH. The wall's front face sits 17mm in front of the mural, inside the
//      same slab. While the wall writes depth the mural simply loses the depth
//      test, and no polygon offset can bridge 17mm (units scale with the depth
//      resolution, which at 1.5m and a 0.1-1000 range is microscopic). So
//      depthWrite goes OFF on both. That is the correct configuration for
//      alpha-blended surfaces anyway: they neither write depth nor occlude one
//      another, and depthTest stays TRUE so opaque geometry — the ATM, the
//      figures — still occludes them, which is the half that matters.
//
//   2. DRAW ORDER. With nothing writing depth, the only thing deciding who
//      paints over whom is three.js's transparent sort, and that sorts by the
//      DEPTH OF ONE ARBITRARY POINT PER MESH — the geometry's bounding-sphere
//      centre. The mural is an 8.7-unit-wide panel centred at x=-0.06; each
//      wall half is a 5.8-unit slab centred at x=-2.95 and x=+1.39. Those
//      centres are nowhere near each other, so as the camera dollies in the
//      comparison between them flips, and for a window of frames the wall
//      sorts NEARER, draws LAST, and composites over the mural. That is the
//      dropout. It cannot be fixed by tuning: the sort key is a property of the
//      geometry, not of the relationship between the surfaces, so it has to be
//      overridden — see TIER_BACKDROP / TIER_LAYER below.
//
// The backdrop is also excluded from the polygon offset rather than sharing it,
// so a layer can no longer be cancelled out by the surface it is competing with.
const BACKDROP_MAT = /^WALL/;
// scratch for ranking decals by depth at load time
const _decalBox = new THREE.Box3();
const _decalV = new THREE.Vector3();
// RENDER ORDER TIERS. three.js never reads a MATERIAL's renderOrder — only an
// Object3D's (WebGLRenderList copies `object.renderOrder` into the render
// item, and reversePainterSortStable compares that). So the tier has to be set
// on the MESH, and a per-material assignment is silently a no-op. The values
// are low integers because nothing else in the build sets an
// Object3D.renderOrder, so they cannot collide with a foreign ordering.
const TIER_BACKDROP = 0;
// First tier given to a decal. Decals are then spaced out from here by their
// own depth — see TIER_Z_STEP.
const TIER_LAYER = 1;
// Decals share one wall, and three.js's remaining sort within a tier is the
// DEPTH OF ONE ARBITRARY POINT PER MESH — the geometry's bounding-sphere
// centre. On a flat wall that is the wrong point to compare. The mural is an
// 8.7-unit panel centred at x=-0.06; GRAFFITI2 is a 1.3-unit patch centred at
// x=-0.90, on the same plane. Their centres are ~0.9 units apart laterally, so
// as the intro camera dollies in the two centres swap apparent depth and the
// mural draws AFTER the graffiti painted on it — the big translucent panel then
// composites straight over it.
//
// That is a second instance of the same class of bug the backdrop tiering
// fixed, one level down: tiering the wall against the decals cannot help when
// the decals fight among themselves. The fix is the same one — override the
// sort — but the correct order is a property of the ARTWORK, not of the camera:
// each decal's own depth into the wall, measured once at load, which is fixed
// and cannot flip. Sorting the wall decals by that gives the painter's order
// (farthest from the lens first) for every camera position, forever.
const TIER_Z_STEP = 1;
// z is quantised to this before being turned into a tier, so two decals a
// fraction of a millimetre apart do not each get their own tier for no reason.
const TIER_Z_QUANTUM = 0.0005;

// Of the two fixes below, BOTH are load-bearing - measured by holding the
// camera at a pinned camT and differencing the frame against the same frame
// with the MURAL hidden (so the bus, the smoke and the horror flicker cancel
// out and only the mural's own contribution to the screen is left):
//
//   camT            12     13     13.5   13.75  14     14.5   15     18
//   HEAD as-shipped 0.39   0.57   7.55   8.35   7.67   3.37   0.13   0.00
//   depthWrite off  5.20   6.82   9.46   0.20   0.55  -0.27   4.18   3.48
//   renderOrder     5.14   6.41   7.61   6.89   3.53   2.01   0.57   0.00
//   BOTH            3.92   5.95   7.40   8.84   7.87   4.84   4.37   3.32
//
// (~0 = the mural is drawing nothing at all, i.e. it has vanished). Either one
// on its own still drops out; together it holds across the whole intro. The
// window matches the report: the dropout is at camT ~13.75-14.5, which is 14-15
// seconds after the language is picked.
function stabilizeDecals(gltf) {
  // Pass 1: does this scene have a backdrop at all? Only MAIN does. Scenes
  // without one keep their existing depth behaviour untouched, so this is a
  // change to one room rather than to every transparent surface in the build.
  const backdrops = new Set();
  gltf.scene.traverse(function (o) {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    mats.forEach(function (m) {
      if (m && BACKDROP_MAT.test(m.name || "")) backdrops.add(m);
    });
  });
  const interpenetrating = backdrops.size > 0;

  let layers = 0;
  let pulled = 0;
  const decals = [];
  gltf.scene.traverse(function (o) {
    if (!o.isMesh || /^FLIES/.test(o.name)) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    // renderOrder lives on the mesh, so the tier is decided per mesh: a mesh
    // carrying a WALL material is a backdrop, anything else that has an
    // alpha-carrying material is a layer.
    let isBackdrop = false;
    let isLayer = false;
    mats.forEach(function (m) {
      if (!m) return;
      if (backdrops.has(m)) { isBackdrop = true; return; }
      if (m.userData.stabilized) return;
      if (m.transparent || m.opacity < 1 || m.alphaMap || m.alphaTest > 0) isLayer = true;
    });

    mats.forEach(function (m) {
      if (!m || m.userData.stabilized) return;
      if (backdrops.has(m)) {
        // The reference surface. It must not occlude (depthWrite off) and it
        // must sort BEFORE every decal.
        m.polygonOffset = false;
        if (interpenetrating) m.depthWrite = false;
        pulled++;
        return;
      }
      if (!(m.transparent || m.opacity < 1 || m.alphaMap || m.alphaTest > 0)) return;
      m.userData.stabilized = true;
      // a decal layer: always sorted after the wall it is painted on
      m.polygonOffset = true;
      m.polygonOffsetFactor = -1;
      m.polygonOffsetUnits = -4;
      if (interpenetrating) m.depthWrite = false;
      layers++;
    });

    if (!interpenetrating) return;
    if (isBackdrop) { o.renderOrder = TIER_BACKDROP; return; }
    if (isLayer) decals.push(o);
  });

  // Order the decals among themselves by their own depth into the wall, taken
  // once here in the scene's own space. The scene root has not been placed yet
  // at load time, but that is irrelevant: the room is rigid, so every decal's
  // depth RELATIVE to the others is the same now as it will ever be. Sorting
  // that fixed order and giving each decal its own tier means the wall is
  // always painted farthest-first, whatever the camera is doing.
  //
  // Ascending z is farthest-first here because MAIN's wall faces +z: the
  // lens looks along -z, so a larger z is nearer the camera and must be
  // painted LATER. Verified against the shipped geometry - GRAFFITIATM is
  // deepest at z=-0.141, SIGN is the most proud at z=-0.048, and both are
  // correct as drawn.
  if (decals.length) {
    // rank on the world z of each decal's bounding-box centre
    const ranked = decals.map(function (o) {
      _decalBox.setFromObject(o);
      _decalBox.getCenter(_decalV);
      return { o: o, z: +_decalV.z.toFixed(4) };
    }).sort(function (a, b) { return a.z - b.z; });
    // quantise, so decals effectively coplanar share a tier rather than each
    // burning one and inflating the numbers
    let tier = TIER_LAYER, lastZ = null;
    ranked.forEach(function (e) {
      if (lastZ === null || Math.abs(e.z - lastZ) > TIER_Z_QUANTUM) { tier += TIER_Z_STEP; lastZ = e.z; }
      e.o.renderOrder = tier;
    });
    console.log("[decals] wall paint order (farthest first): " +
      ranked.map(function (e) { return e.o.name + "@" + e.z; }).join(" "));
  }
  console.log("[decals]", layers, "layer materials,", pulled, "backdrops,",
    decals.length + 1, "meshes tiered;",
    interpenetrating ? "depth-write off (interpenetrating)" : "depth behaviour unchanged");
}

// camera framing: each scene shifts its authored camera in camera-local axes
// (right / down / back) by the SCENE_CAM fractions. The offset is applied in
// world space then folded back into the camera's root-local position, so it
// behaves identically no matter how the scene root is rotated by placement.
function camViewHalf(s) {
  return Math.tan(THREE.MathUtils.degToRad(s.camNode.fov) / 2);
}

// camera-to-focal distance used to scale framing offsets (clamped). The focal
// is a scene-LOCAL point (bounding-box center of the loaded root), so it must
// be transformed into world space before measuring — otherwise a turn that
// displaces the root also rescales the framing offset and shifts the view.
function frameDist(s, cameraWorldPos) {
  let fp = s.focal || FOCUS;
  if (s.focal && s.root) {
    _focalV.copy(s.focal).applyMatrix4(s.root.matrixWorld);
    fp = _focalV;
  }
  const raw = cameraWorldPos.distanceTo(fp);
  return Math.min(raw, MAX_FRAME_DIST);
}

// effective framing for a scene: SCENE_CAM, eased by CAM_RAMP as a scene's
// camera animation progresses (used by MAIN so the intro moves from the start
// shot to the settled shot during the first 500 frames, then holds). ART swaps
// to ART_CAM_INTERACT while its interactive loop is active, blending from the
// base shot during the entry glide so there is no framing pop at the click.
function frameConfig(s) {
  if (s.name === "ART" && art.interacted) {
    let k = 1;
    if (art.entering && art.entering.dur > 0) {
      k = Math.min(1, art.entering.t / art.entering.dur);
      k = 1 - Math.pow(1 - k, 3);
    }
    const base = SCENE_CAM.ART || DEFAULT_CAM;
    return {
      right: base.right + (ART_CAM_INTERACT.right - base.right) * k,
      down: base.down + (ART_CAM_INTERACT.down - base.down) * k,
      back: base.back + (ART_CAM_INTERACT.back - base.back) * k,
    };
  }
  const c = SCENE_CAM[s.name] || DEFAULT_CAM;
  const r = CAM_RAMP[s.name];
  if (!r) return c;
  const k = s.camT * CAM_FPS;
  const t = k >= r.endFrame ? 1 : Math.max(0, k / r.endFrame);
  return {
    right: c.right + (r.to.right - c.right) * t,
    down: c.down + (r.to.down - c.down) * t,
    back: c.back + (r.to.back - c.back) * t,
  };
}

// Per-scene override of the portrait framing SHIFT (see PORTRAIT_SHIFT_RIGHT for
// the sign: negative = camera leans left, room slides right). Scenes that were
// composed for a narrower subject can ask for less of the lean than the global
// default. MUSIC's stereo + buttons already sit well right of centre, so the
// global left lean pushed the useful part of the room too far off the edge; it
// takes NO lean of its own (0 = exactly the authored framing). A scene named
// here is exempt from the global value entirely; anything not listed uses
// PORTRAIT_SHIFT_RIGHT.
const SCENE_PORTRAIT_SHIFT = {
  MUSIC: 0,
};
function portraitShiftFor(s) {
  const own = s && SCENE_PORTRAIT_SHIFT[s.name];
  return own != null ? own : PORTRAIT_SHIFT_RIGHT;
}

// returns the world-space framing offset for this scene's camera at distance
// `dist` from FOCUS, in the frame defined by worldQuat; null if no offset.
// The PORTRAIT-FIT dolly (back) and left shift (right) ride along with the
// authored SCENE_CAM here, so they flow through BOTH applySceneFrame (render)
// and placeSceneRootFramed (handover placement) through the same function —
// which is what keeps a turn landing exactly on the turned pose in portrait.
function sceneFrameOffset(s, worldQuat, dist) {
  const c = frameConfig(s);
  const level = fit.level;
  const right = c.right + level * portraitShiftFor(s);
  const back = c.back + level * PORTRAIT_BACK_MAX;
  if (!right && !c.down && !back) return null;
  const halfV = camViewHalf(s);
  const halfW = halfV * s.camNode.aspect;
  _off.set(0, 0, 0);
  if (right) {
    _rightV.set(1, 0, 0).applyQuaternion(worldQuat);
    _off.addScaledVector(_rightV, right * 2 * halfW * dist);
  }
  if (c.down) {
    _upV.set(0, 1, 0).applyQuaternion(worldQuat);
    _off.addScaledVector(_upV, -c.down * 2 * halfV * dist);
  }
  if (back) {
    _backV.set(0, 0, 1).applyQuaternion(worldQuat);
    _off.addScaledVector(_backV, back * dist);
  }
  return _off;
}

// re-derive the authored pose from the track at time t, then apply this
// scene's framing offset (camera-local) to the camera node. The offset is
// computed from the AUTHORED camera position (dist to the scene's focal
// point) so it never feeds back on itself; placement uses the same math, so
// a placed scene renders exactly where the turn left it.
function applySceneFrame(s) {
  if (!s || !s.camNode) return;
  s.camNode.updateMatrixWorld(true);
  _cwp.setFromMatrixPosition(s.camNode.matrixWorld);
  const dist = frameDist(s, _cwp);
  s.camNode.getWorldQuaternion(_qT);
  const off = sceneFrameOffset(s, _qT, dist);
  if (!off) return;
  _vp.copy(_cwp).add(off);
  if (s.root) {
    _m4.copy(s.root.matrixWorld).invert();
    _vp.applyMatrix4(_m4);
  }
  s.camNode.position.copy(_vp);
  s.camNode.updateMatrixWorld(true);
}

// place a scene root so its camera, at animation time atT, PLUS this scene's
// framing offset lands exactly on worldPos/worldQuat in the shared world.
// The offset is a function of the AUTHORED distance to the scene's focal
// point, which itself depends on the offset, so we solve it to a fixed point
// (a few passes converge quickly) — the camera then lands exactly on the
// target pose and applySceneFrame reproduces the same pose when rendering.
function placeSceneRootFramed(s, worldPos, worldQuat, atT) {
  sampleTrack(s.posTrack, atT, _lp);
  sampleQuat(s.rotTrack, atT, _lq);
  _qT.copy(worldQuat).multiply(_lq2.copy(_lq).invert());
  _v1.copy(_lp).applyQuaternion(_qT);
  s.root.quaternion.copy(_qT);
  s.root.position.copy(worldPos).sub(_v1); // start with zero offset
  let off = null;
  for (let i = 0; i < 5; i++) {
    s.root.updateMatrixWorld(true);
    _cwp.copy(_v1).add(s.root.position); // authored world camera pos
    const dist = frameDist(s, _cwp);
    off = sceneFrameOffset(s, worldQuat, dist);
    if (!off) break;
    s.root.position.copy(worldPos).sub(_v1).sub(off);
  }
  if (off) {
    s.root.updateMatrixWorld(true);
    _cwp.copy(_v1).add(s.root.position);
    off = sceneFrameOffset(s, worldQuat, frameDist(s, _cwp));
    if (off) s.root.position.copy(worldPos).sub(_v1).sub(off);
  }
  s.root.updateMatrixWorld(true);
}

function setCameraPose(s, t) {
  sampleTrack(s.posTrack, t, s.camNode.position);
  sampleQuat(s.rotTrack, t, s.camNode.quaternion);
  s.camNode.updateMatrixWorld(true);
}

function setNodeWorld(node, pos, quat) {
  const parent = node.parent;
  if (parent) {
    _m4.copy(parent.matrixWorld).invert();
    _vp.copy(pos).applyMatrix4(_m4);
    node.position.copy(_vp);
    _qI.setFromRotationMatrix(_m4);
    node.quaternion.copy(_qI).multiply(quat);
  } else {
    node.position.copy(pos);
    node.quaternion.copy(quat);
  }
  node.updateMatrixWorld(true);
}

function startTurn(s) {
  if (turn || !s.posTrack || !s.camNode) return;
  const from = active;
  // the ambient bed starts easing to the destination room's level NOW, while the
  // 1.6s camera swing plays, so the air thins out with the turn instead of
  // stepping on arrival (setScene confirms it once you land)
  radioPlayer.preTurn(s.name);
  // never carry the calling card across a scene change
  if (isContactCardOpen()) closeContactCard(true);
  // dynamic texture re-roll on EXIT: leaving MAIN re-rolls the decals and
  // leaving CLOTHES re-rolls the garments (each picks an image never shown on
  // the previous visit). Scheduled REROLL_DELAY_MS after the exit starts so the
  // turn animation fully plays and the swap happens while the source scene is
  // already hidden (no visible pop). The re-roll functions carry a pass token,
  // so a stale timeout (from a quick exit/re-exit) is silently superseded.
  if (from) {
    // NOTE: no "scene still visible?" guard here — `active` only updates at
    // finishTurn (1.6s), but the timeout fires mid-turn (1.0s) while the from
    // scene is already behind the camera / hidden, so a guard on `active`
    // would wrongly skip EVERY re-roll. Stale loads are handled by the
    // per-inject pass token.
    if (from.name === "MAIN") setTimeout(rerollMainTextures, REROLL_DELAY_MS);
    else if (from.name === "CLOTHES") setTimeout(rerollClothesTextures, REROLL_DELAY_MS);
    // leaving ART clears any open artwork popups / modal over the 3D world
    if (from.name === "ART") artPopupClear();
  }
  // zero the parallax and re-derive the pure authored+framed pose so the
  // captured start is exact (this is what makes the handoff strict)
  look.x = 0;
  look.y = 0;
  setCameraPose(active, active.camT);
  applySceneFrame(active);
  camera.getWorldPosition(_pos);
  camera.getWorldQuaternion(_q0);

  // entering MUSIC always starts from its base loop (frame 0); ART rewinds its
  // clips and clock so the intro (fly-in, laptop opening, shade fade) replays
  if (s.name === "MUSIC") resetMusic(s);
  else if (s.name === "ART") resetArt(s);

  // simple POV turn: swing in place, RIGHT into a sub-scene, LEFT back to MAIN
  const dir = s.name === "MAIN" ? TURN_LEFT : TURN_RIGHT;
  _q1.copy(_q0).multiply(_qAxis.setFromAxisAngle(_upAxis, dir * Math.PI));

  // place the target scene so its authored + framed camera (at its resume
  // point) lands exactly on the turned pose. ART resumes from frame 0 so its
  // intro plays fresh on every entry; everything else resumes its loop start.
  const atT = s.name === "ART" ? 0 : (s.name === "MAIN" ? s.camT : s.loopStart);
  placeSceneRootFramed(s, _pos, _q1, atT);
  setCameraPose(s, atT);
  s.root.visible = false; // revealed once the camera has turned ~90 degrees

  handoffInfo = {
    pos: { x: _pos.x, y: _pos.y, z: _pos.z },
    q0: { x: _q0.x, y: _q0.y, z: _q0.z, w: _q0.w },
    q1: { x: _q1.x, y: _q1.y, z: _q1.z, w: _q1.w },
    dir: dir,
    from: from.name,
    to: s.name,
    camT: atT,
  };
  turn = { from: from, to: s, t: 0, dur: TURN_SEC, pos: _pos.clone(), q0: _q0.clone(), q1: _q1.clone(), dir: dir, swapped: false };
}

function finishTurn() {
  const s = turn.to;
  const atT = s.name === "ART" ? 0 : (s.name === "MAIN" ? s.camT : s.loopStart);

  // the exact world pose the turn just ended on — the reacquire lerp starts
  // here and glides to the target scene's framed pose
  _pos.copy(turn.pos);
  _q0.copy(turn.q1);

  // compute the target's exact authored + framed world pose at its resume time
  setCameraPose(s, atT);
  applySceneFrame(s);
  s.camNode.updateMatrixWorld(true);
  _cwp.setFromMatrixPosition(s.camNode.matrixWorld);
  s.camNode.getWorldQuaternion(_q1);

  // hand the view to the target scene's camera node
  camera = s.camNode;
  active = s;
  s.camT = atT;
  s.root.visible = true;
  if (turn.from.root !== s.root) turn.from.root.visible = false;
  setNodeWorld(camera, _pos, _q0); // start the lerp from the turn endpoint
  // entering CLOTHES restarts the armature's 2 entry beacon pulses. (Texture
  // re-rolls happen on EXIT, in startTurn, so re-entry is already fresh.)
  if (s.name === "CLOTHES") resetClothesGlow();
  returnInfo = {
    pos: { x: _cwp.x, y: _cwp.y, z: _cwp.z },
    quat: { x: _q1.x, y: _q1.y, z: _q1.z, w: _q1.w },
    camT: s.camT,
  };
  // ease the root onto the framed pose during the same glide as the camera so
  // scene + camera move as one unit (never a post-glide correction pop)
  const rp = framedRootPose(s, _cwp, _q1, atT);
  reacquire = {
    from: { x: _pos.x, y: _pos.y, z: _pos.z },
    qFrom: { x: _q0.x, y: _q0.y, z: _q0.z, w: _q0.w },
    to: { x: _cwp.x, y: _cwp.y, z: _cwp.z },
    qTo: { x: _q1.x, y: _q1.y, z: _q1.z, w: _q1.w },
    rootFrom: { x: s.root.position.x, y: s.root.position.y, z: s.root.position.z },
    rootFromQ: { x: s.root.quaternion.x, y: s.root.quaternion.y, z: s.root.quaternion.z, w: s.root.quaternion.w },
    rootTo: rp.p,
    rootToQ: rp.q,
    t: 0,
    dur: REACQUIRE_SEC,
  };
  turn = null;
  menuHits.forEach(function (h) { h.visible = active.name === "MAIN"; });
  // the touch latch is MAIN-only state: drop it on every handover so a button
  // that was left armed in a previous visit can't be pressed by the first tap
  // of the next one
  menuTouch.latch = null;
  // the radio follows the room: full inside MUSIC, faint on MAIN, fainter in
  // the others. Fired on arrival (not on startTurn) so the crescendo lands as
  // you come out of the 180Â° turn rather than playing underneath it.
  radioPlayer.setScene(s.name);
  // the MUSIC panel only repaints while that room is the one on screen
  setRadioDisplayActive(s.name === "MUSIC");
  // breadcrumb for the crash log: the heartbeat is aligned to room changes, so
  // a session whose pulse stops is attributable to the room it was in
  crashLogSetRoom(s.name);
  updateBackControl();
  flashDotArrows();
  setTitle();
}

// smooth the camera onto the target scene's framed pose after a turn. When the
// placement math is exact this is a ~zero-length glide; any residual mismatch
// is eased out instead of snapped, so every scene change settles identically.
// The scene ROOT is eased along the same curve (rootFrom -> rootTo) so camera
// and scene move as ONE rigid unit — there is never a post-glide correction
// pop when the framed root pose differs from the turn placement.
function stepReacquire(dt) {
  reacquire.t += dt;
  const p = Math.min(1, reacquire.t / reacquire.dur);
  const e = p * p * (3 - 2 * p);
  if (reacquire.rootFrom) {
    _rv.set(reacquire.rootFrom.x, reacquire.rootFrom.y, reacquire.rootFrom.z);
    _rv2.set(reacquire.rootTo.x, reacquire.rootTo.y, reacquire.rootTo.z);
    _rv.lerp(_rv2, e);
    _rq.copy(reacquire.rootFromQ);
    _rq2.copy(reacquire.rootToQ);
    _rq.slerp(_rq2, e);
    setNodeWorld(active.root, _rv, _rq);
  }
  _vp.set(reacquire.from.x, reacquire.from.y, reacquire.from.z);
  _v1.set(reacquire.to.x, reacquire.to.y, reacquire.to.z);
  _vp.lerp(_v1, e);
  _lq.copy(reacquire.qFrom);
  _lq2.copy(reacquire.qTo);
  _lq.slerp(_lq2, e);
  setNodeWorld(camera, _vp, _lq);
  if (p >= 1) finishReacquire();
}

// helper: compute the scene root pose that lands the scene's framed camera at
// worldPos/worldQuat at time atT — WITHOUT mutating the live root (capture,
// compute, restore). Returns { p, q } for the framed root pose.
function framedRootPose(s, worldPos, worldQuat, atT) {
  _rootKeepP.copy(s.root.position);
  _rootKeepQ.copy(s.root.quaternion);
  placeSceneRootFramed(s, worldPos, worldQuat, atT);
  const p = { x: s.root.position.x, y: s.root.position.y, z: s.root.position.z };
  const q = { x: s.root.quaternion.x, y: s.root.quaternion.y, z: s.root.quaternion.z, w: s.root.quaternion.w };
  s.root.position.copy(_rootKeepP);
  s.root.quaternion.copy(_rootKeepQ);
  return { p: p, q: q };
}

// DOUBLE-CHECK the reacquisition: the glide already landed the camera exactly
// on the target pose AND eased the root onto the framed pose, so this only
// VERIFIES that re-deriving the authored + framed pose reproduces the same
// pose. No instant re-place, no snap — any residual drift is eased out by
// retrackActive on the next frame.
function finishReacquire() {
  const r = reacquire;
  reacquire = null;
  setCameraPose(active, active.camT);
  applySceneFrame(active);
  active.camNode.updateMatrixWorld(true);
  _cwp.setFromMatrixPosition(active.camNode.matrixWorld);
  active.camNode.getWorldQuaternion(_qI);
  _v1.set(r.to.x, r.to.y, r.to.z);
  _lq2.set(r.qTo.x, r.qTo.y, r.qTo.z, r.qTo.w);
  const prePos = _cwp.distanceTo(_v1);
  const preAng = 1 - Math.abs(_qI.dot(_lq2));

  const dx = r.to.x - r.from.x, dy = r.to.y - r.from.y, dz = r.to.z - r.from.z;
  const glide = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (r.kind === "retrack") {
    console.log("[retrack]", active.name, "settle glide " + glide.toFixed(5) + "m pre " +
      prePos.toFixed(6) + "m/" + preAng.toExponential(2));
  } else {
    console.log("[reacquire]", active.name, "glide " + glide.toFixed(5) + "m pre " +
      prePos.toFixed(6) + "m/" + preAng.toExponential(2) + (prePos > 0.001 ? " DRIFT" : " ok"));
  }

  retrackNext = true;
  resumeRamp = RESUME_SEC; // glide into the resumed fly-through speed

  // strict reacquisition: land dead-center and disarm parallax until the
  // player moves the pointer again, so a fresh scene isn't pre-tilted by the
  // drag's leftover look-around
  look.x = 0;
  look.y = 0;
  // the swipe carries its own rest offset; drop it too, or a scene turn would
  // inherit the tilt the finger had left in it
  swipe.x = 0;
  swipe.y = 0;
  swipe.id = null;
  parallaxArmed = false;
}

// re-track the positioning a frame AFTER the reacquire settled: re-derive the
// active scene's authored + framed pose at camT (without leaving the camera
// touched) and compare against the LIVE camera. Any drift is EASED OUT with a
// short root+camera glide — never snapped.
function retrackActive() {
  if (!active || !active.camNode) return false;
  camera.getWorldPosition(_v1);
  camera.getWorldQuaternion(_lq2);
  setCameraPose(active, active.camT);
  applySceneFrame(active);
  active.camNode.updateMatrixWorld(true);
  _cwp.setFromMatrixPosition(active.camNode.matrixWorld);
  active.camNode.getWorldQuaternion(_qI);
  const posErr = _cwp.distanceTo(_v1);
  const angErr = 1 - Math.abs(_qI.dot(_lq2));
  setNodeWorld(camera, _v1, _lq2); // restore the camera, don't mutate it here
  if (posErr > 0.0002 || angErr > 0.000002) {
    const rp = framedRootPose(active, _cwp, _qI, active.camT);
    reacquire = {
      kind: "retrack",
      from: { x: _v1.x, y: _v1.y, z: _v1.z },
      qFrom: { x: _lq2.x, y: _lq2.y, z: _lq2.z, w: _lq2.w },
      to: { x: _cwp.x, y: _cwp.y, z: _cwp.z },
      qTo: { x: _qI.x, y: _qI.y, z: _qI.z, w: _qI.w },
      rootFrom: { x: active.root.position.x, y: active.root.position.y, z: active.root.position.z },
      rootFromQ: { x: active.root.quaternion.x, y: active.root.quaternion.y, z: active.root.quaternion.z, w: active.root.quaternion.w },
      rootTo: rp.p,
      rootToQ: rp.q,
      t: 0,
      dur: 0.35,
    };
    console.log("[retrack]", active.name, "drift " + posErr.toFixed(6) + "m -> smooth settle");
    return true;
  }
  console.log("[retrack]", active.name, "ok pos " + posErr.toFixed(6) + "m ang " + angErr.toExponential(2));
  return false;
}

backEl.addEventListener("click", function () {
  if (turn || !active) return;
  // the bottom-center button stays inert while the calling card is up
  if (isContactCardOpen()) return;
  if (active.name === "MAIN") {
    // bottom-center button on MAIN doubles as a zoom-out toggle: pressing it
    // widens the FOV AND pulls the camera back at 20% speed to reveal much more
    // of the scene; the next press glides both back to the normal shot
    mainZoom.on = !mainZoom.on;
    if (mainZoom.on && mainZoom.baseFov == null) {
      // the AUTHORED lens of the scene being viewed, so the 2x zoom is
      // relative to the real composition rather than whatever the camera
      // happens to be at this frame
      mainZoom.baseFov = (active && active.baseFov != null) ? active.baseFov : camera.fov;
      mainZoom.targetBack = frameDist(active, camera.getWorldPosition(_v2)) * MAIN_ZOOM_BACK_FRAC;
      mainZoom.prevPos = null;
    }
    updateBackIcon();
    return;
  }
  pendingTarget = null;
  goToScene("MAIN");
});

// The down arrow next to the back button. It is only ever shown while the
// camera is INSIDE an interactable object (the ART laptop or the MUSIC
// stereo), and it pulls the view back OUT to that room's idle shot — the
// back button on its own leaves the scene entirely, so this is the escape
// hatch for "I want to see the room again without going back to MAIN".
// Same dot-matrix arrow + blink as every other UI arrow in the build.
if (zoomOutEl) {
  zoomOutEl.addEventListener("click", function (e) {
    e.preventDefault();
    e.stopPropagation(); // the document click handler would treat this as a scene click
    if (turn || reacquire || !active) return;
    if (isContactCardOpen()) return;
    if (active.name === "ART") {
      if (!art.interacted) return;
      exitArtInteractive();
      updateZoomOutButton();
    } else if (active.name === "MUSIC") {
      if (!music.interacted || music.exiting) return;
      exitMusic();
      updateZoomOutButton();
    }
  });
}

// The mute toggle. It silences the WHOLE site - the music bed and the ambient
// bed both run through one gain node in radioDisplay.js - and the choice holds
// across every room, so it is deliberately not the same thing as the MUSIC
// room's PLAYPAUSE (that one is the car stereo).
//
// The button is gated behind MAIN_BACK_AFTER_FRAME, so it appears once the
// language pick has released the camera and the fly-in has settled - the
// picker itself is left uncluttered.
if (muteEl) {
  muteEl.addEventListener("click", function (e) {
    e.preventDefault();
    e.stopPropagation(); // the document handler would treat this as a scene click
    if (turn || !active) return;
    const muted = radioPlayer.toggleMuted();
    paintMuteButton();
    console.log("[mute] ->", muted ? "muted" : "unmuted");
  });
  muteEl.addEventListener("animationend", function () {
    muteEl.classList.remove("dotarrow-flash");
  });
}

// TORIS set switcher (bottom-center arrows): the left arrow cycles figure 1's
// folder backwards, the right arrow cycles figure 2's forwards, one figure per
// press so the pair never reskins together and never repeats the same folder.
if (torisArrowL) {
  torisArrowL.addEventListener("click", function (e) {
    e.preventDefault();
    e.stopPropagation();
    swapTorisFigure(1, -1);
  });
}
if (torisArrowR) {
  torisArrowR.addEventListener("click", function (e) {
    e.preventDefault();
    e.stopPropagation();
    swapTorisFigure(2, 1);
  });
}

/* ------------------------------------------------------------------ */
/*  interactive menu planes (hover / click)                            */
/* ------------------------------------------------------------------ */

const menuMeshes = [];
const menuHits = [];
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let lastHoverName = null;
let forceHover = null; // test hook: overrides real hover for damp verification
const _center = new THREE.Vector3();
const _quat = new THREE.Quaternion();

// "controls unlocked" flash: the instant the zoom-out button appears on MAIN
// the ATM labels blink 3 times quickly (each blink 150ms on / 150ms off) at
// MENU_EMISSIVE (2x ~ "100% brighter") to show the buttons are live. The same
// off/on rhythm as the dot-matrix UI arrows.
const MENU_FLASH_BLINK_MS = 0.15; // 150ms lit, 150ms dark per blink
const MENU_FLASH_BLINKS = 3;
const menuFlash = { t: 0, active: false };

function triggerMenuFlash() {
  menuFlash.t = 0;
  menuFlash.active = true;
}

// advance the blink clock once per frame; returns whether the labels should be
// lit right now. Deactivates after MENU_FLASH_BLINKS full on/off cycles.
function menuFlashLit(dt) {
  if (!menuFlash.active) return false;
  menuFlash.t += dt;
  const cycle = MENU_FLASH_BLINK_MS * 2;
  const i = Math.floor(menuFlash.t / cycle);
  if (i >= MENU_FLASH_BLINKS) {
    menuFlash.active = false;
    return false;
  }
  return (menuFlash.t % cycle) < MENU_FLASH_BLINK_MS;
}

// each menu plane is only ~13mm; raycast against larger invisible hit areas so
// hovering over the visible text reliably registers
function menuByName(name) {
  for (let i = 0; i < menuMeshes.length; i++) {
    if (menuMeshes[i].name === name) return menuMeshes[i];
  }
  return null;
}

// A `click` is dispatched as a PointerEvent in current Chrome/Firefox, so
// `pointerType` is normally right there — but iOS is the problem case, and the
// problem is real rather than theoretical. After a tap, Safari fires a set of
// COMPATIBILITY MOUSE EVENTS (mouseover / mousemove / mousedown / mouseup /
// click) to keep legacy code working, and it reports those as
// `pointerType: "mouse"`. So a finger on an iPhone looks exactly like a mouse
// to every check based on pointerType, which silently disables the
// tap-to-hover / double-tap-to-press behaviour there — the one device where it
// matters most.
//
// The fix is to trust the real touch signal, not the synthesised mouse one.
// `touchstart` is an unambiguous, first-class touch event on every browser, so
// a tap timestamp taken there cannot be flipped by anything Safari synthesises
// afterwards. The window is generous (a double tap arrives well inside it).
const TOUCH_TRACE_MS = 800;
let lastTouchAt = -1e9;
function markTouch() { lastTouchAt = nowMs(); }
function recentlyTouched() { return nowMs() - lastTouchAt < TOUCH_TRACE_MS; }
function nowMs() {
  return (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
}

// true if this event is part of a touch interaction, even on iOS
function isTouchEvent(e) {
  if (e && e.pointerType === "touch") return true;
  // pointerType "mouse" on iOS is the synthesised compat event, so only believe
  // it when no touch has just happened
  if (e && e.pointerType === "mouse") return recentlyTouched();
  return recentlyTouched() || lastPointerWasTouch;
}

// which menu plane is under this client point, using the same inflated hit
// boxes + nearest-on-screen fallback the hover uses (the labels are tiny on a
// moving camera, so the raw raycast alone misses a lot)
function pickMenuAt(clientX, clientY) {
  screenRaycast(clientX, clientY);
  const hits = raycaster.intersectObjects(menuHits, false);
  if (hits.length) return hits[0].object.userData.menu;
  return nearestMenuOnScreen();
}

/* ---- touch ATM: tap = hover, double tap = press -------------------- */
// A finger has no hover, so a single tap can only mean "light this button up".
// Acting on it immediately is wrong on a phone: one stray thumb commits you to
// a room with no way back. So the first tap LATCHES the button — it stays lit,
// doing exactly what the mouse hover does — and the next tap on the SAME
// button enacts it. Tapping a different button just re-latches to that one, so
// moving between buttons costs one tap each and can never fire by accident.
// The latch is the whole state machine: no timer, because a timing window only
// adds a way to fail (a slow second tap silently doing nothing).
// Desktop is untouched — one click still acts immediately.
const MENU_TOUCH_DRAG_PX = 12; // pointer travel that turns a tap into a swipe
const menuTouch = { latch: null, down: false, sx: 0, sy: 0, moved: false };

// travel tracking, so a swipe that happens to end over a button neither
// latches nor fires it
document.addEventListener("pointerdown", function (e) {
  if (!isTouchEvent(e)) return;
  menuTouch.down = true;
  menuTouch.moved = false;
  menuTouch.sx = e.clientX;
  menuTouch.sy = e.clientY;
}, { passive: true, capture: true });

document.addEventListener("pointermove", function (e) {
  if (!isTouchEvent(e) || !menuTouch.down || menuTouch.moved) return;
  if (Math.abs(e.clientX - menuTouch.sx) + Math.abs(e.clientY - menuTouch.sy) > MENU_TOUCH_DRAG_PX) {
    menuTouch.moved = true;
  }
}, { passive: true, capture: true });

document.addEventListener("pointerup", function (e) {
  if (!isTouchEvent(e)) return;
  menuTouch.down = false;
}, { passive: true, capture: true });

document.addEventListener("pointercancel", function () {
  menuTouch.down = false;
  menuTouch.moved = true;
}, { passive: true, capture: true });

function setupMenus(gltf) {
  gltf.scene.traverse(function (o) {
    if (!o.isMesh) return;
    if (MENU_NAMES.indexOf(o.name) === -1) return;
    const m = o.material;
    m.transparent = true;
    m.depthWrite = false;
    m.opacity = 0;
    m.emissiveIntensity = 0;
    o.userData.hover = false;
    o.userData.flash = 0;
    menuMeshes.push(o);

    new THREE.Box3().setFromObject(o).getCenter(_center);
    o.getWorldQuaternion(_quat);
    const hit = new THREE.Mesh(
      new THREE.PlaneGeometry(0.024, 0.024),
      new THREE.MeshBasicMaterial({ visible: false })
    );
    hit.position.copy(_center);
    hit.quaternion.copy(_quat);
    hit.userData.menu = o;
    gltf.scene.add(hit);
    menuHits.push(hit);
  });
  console.log("[menu] found", menuMeshes.map(function (o) { return o.name; }).join(", "));
}

function updateMenus(dt) {
  if (!camera || menuMeshes.length === 0) return;
  if (turn || !active || active.name !== "MAIN") return;
  // ATM buttons / hover stay dead until the zoom-out button UI is up
  if (!mainControlsActive()) return;
  // frozen while the fake browser is up — the world pauses behind the glass
  if (isAboutBrowserOpen()) return;
  // dead while the calling card is up — it owns the pointer
  if (isContactCardOpen()) return;

  pointer.set(mouseX, -mouseY);
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(menuHits, false);
  let hovered = hits.length ? hits[0].object.userData.menu : null;

  // fallback: the menu planes are tiny (~13mm) on a moving camera, so also
  // select whichever menu is nearest to the cursor on screen
  if (!hovered) hovered = nearestMenuOnScreen();

  // under a finger the latched button wins over whatever the (now stale) last
  // touch position happens to be over, so "tap = hover" really does hold the
  // light on until the player taps somewhere else
  if (lastPointerWasTouch && menuTouch.latch) {
    const latched = menuByName(menuTouch.latch);
    if (latched) hovered = latched;
  }

  const hoverName = hovered ? hovered.name : null;
  if (hoverName !== lastHoverName) {
    lastHoverName = hoverName;
    setOverlayHover(hoverName);
    console.log("[menu] hover:", hoverName ? hoverName : "none");
  }

  const blinkOn = menuFlashLit(dt);
  menuMeshes.forEach(function (o) {
    o.userData.hover = o === hovered;
    if (o.userData.flash > 0) o.userData.flash -= dt;
    const flashOn = (menuFlash.active && blinkOn) || o.userData.flash > 0;
    const alphaTarget = flashOn ? MENU_FLASH : o.userData.hover ? MENU_HOVER : 0;
    // the labels are baked emissive-only now, so the hover glow needs to push
    // well past 1.0 to read as brightly as the old baseColor x light did
    const emissiveTarget = (flashOn || o.userData.hover) ? MENU_EMISSIVE : 0;
    const mat = o.material;
    // fast rise/fill during the unlocked blink so the flashes are crisp,
    // fast rise on hover, slow decay so the glow lingers for everything else
    const k = (o.userData.hover || menuFlash.active) ? 0.5 : 0.08;
    mat.opacity += (alphaTarget - mat.opacity) * k;
    mat.emissiveIntensity += (emissiveTarget - mat.emissiveIntensity) * k;
  });
}

// nearest menu plane to the cursor on screen (in NDC), within ~6% of the viewport
const _v3 = new THREE.Vector3();
function nearestMenuOnScreen() {
  let best = null;
  let bestD = 0.06; // threshold radius
  for (let i = 0; i < menuHits.length; i++) {
    const h = menuHits[i];
    if (!h.visible) continue;
    h.getWorldPosition(_v3);
    _v3.project(camera);
    if (_v3.z > 1 || _v3.z < -1) continue; // behind camera
    const dx = _v3.x - mouseX;
    const dy = _v3.y - (-mouseY);
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < bestD) {
      bestD = d;
      best = h.userData.menu;
    }
  }
  return best;
}

function screenRaycast(clientX, clientY) {
  pointer.set((clientX / window.innerWidth) * 2 - 1, -(clientY / window.innerHeight) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
}

// nearest linked garment to the click on screen (in NDC), within ~12% of the
// viewport. Used as a fallback for CLOTHES clicks: the garments are skinned to
// the walking figure, so raycasting against their bind-pose geometry can miss.
// garmentWorldPoint skins a real vertex so the fallback tracks the garment's
// CURRENT position (cap on the head, shirt on the torso) as the mannequin walks.
function nearestLinkedOnScreen(cx, cy) {
  const ndx = (cx / window.innerWidth) * 2 - 1;
  const ndy = (cy / window.innerHeight) * 2 - 1;
  let best = null;
  let bestD = 0.16; // threshold radius (whole-figure targets: generous)
  for (let i = 0; i < linkedMeshes.length; i++) {
    const o = linkedMeshes[i];
    if (!o.visible) continue;
    scene.updateMatrixWorld(true);
    garmentWorldPoint(o, _v3);
    _v3.project(camera);
    if (_v3.z > 1 || _v3.z < -1) continue; // behind camera
    const dx = _v3.x - ndx;
    const dy = _v3.y - ndy;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < bestD) {
      bestD = d;
      best = o;
    }
  }
  return best;
}

// how close (in NDC, as a fraction of the viewport) the cursor must be to a
// projected skinned surface vertex for the click/hover to register on that
// skinned mesh. Tight enough that clicking the background never counts.
const LINKED_PROX = 0.05;

// is the cursor within LINKED_PROX of this skinned mesh's CURRENT surface?
// Raycasting a skinned mesh tests its BIND pose, which the walking skeleton
// leaves far from the screen — so skin a sample of real vertices (exactly like
// the vertex shader) and project them instead.
function skinnedMeshNear(mesh, ndx, ndy) {
  const geo = mesh.geometry;
  const pos = geo.attributes.position;
  if (!pos || !geo.attributes.skinIndex || !geo.attributes.skinWeight) return false;
  const step = Math.max(1, Math.floor(pos.count / 256));
  for (let i = 0; i < pos.count; i += step) {
    skinLocalPoint(mesh, i, _v3);
    _v3.project(camera);
    if (_v3.z > 1 || _v3.z < -1) continue; // behind camera
    const dx = _v3.x - ndx;
    const dy = _v3.y - ndy;
    if (dx * dx + dy * dy < LINKED_PROX * LINKED_PROX) return true;
  }
  return false;
}

// CLOTHES hit test (click + hover), in NDC with y-up. Non-skinned linked
// meshes (e.g. the static GORRA cap) are raycast-exact; skinned figure/garment
// meshes are matched by projected-vertex proximity so the whole dancer reads as
// clickable WHERE IT ACTUALLY IS as it walks. Returns the hit mesh or null.
function pickLinkedMesh(ndx, ndy) {
  if (!linkedMeshes.length) return null;
  scene.updateMatrixWorld(true);
  if (plainLinked.length) {
    pointer.set(ndx, ndy);
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(plainLinked, false);
    for (let i = 0; i < hits.length; i++) {
      if (hits[i].object.visible) return hits[i].object;
    }
  }
  for (let i = 0; i < skinnedLinked.length; i++) {
    const o = skinnedLinked[i];
    if (o.visible && skinnedMeshNear(o, ndx, ndy)) return o;
  }
  return null;
}

document.addEventListener("click", function (e) {
  if (!camera || turn || !active) return;
  // the fake browser owns the screen while it's open
  if (isAboutBrowserOpen()) return;
  if (active.name === "MAIN") {
    // the calling card owns the pointer while it's up
    if (isContactCardOpen()) return;
    // ATM buttons only register once the zoom-out button UI is up
    if (!mainControlsActive()) return;
    if (menuHits.length === 0) return;
    const target = pickMenuAt(e.clientX, e.clientY);
    if (!target) {
      // a tap on empty space disarms, so the next tap on a button is a first
      // tap again rather than firing a latch left over from before
      if (isTouchEvent(e)) menuTouch.latch = null;
      return;
    }
    // TOUCH: first tap only latches the button (it lights up and stays lit,
    // standing in for the hover a finger can't do); the next tap on this same
    // button is the one that acts. A swipe over a button does neither.
    if (isTouchEvent(e)) {
      if (menuTouch.moved) return;
      if (menuTouch.latch !== target.name) {
        menuTouch.latch = target.name;
        lastHoverName = target.name;
        setOverlayHover(target.name);
        console.log("[menu] touch armed:", target.name, "(tap again to press)");
        return;
      }
      menuTouch.latch = null; // consuming the latch keeps a third tap a first tap
    }
    target.userData.flash = MENU_FLASH_SEC;
    // ABOUT doesn't lead to a room — it opens the spoof wikipedia page in a
    // fake browser window floating over the world
    if (target.name === "ABOUT") {
      setOverlayHover(null);
      lastHoverName = null;
      openAboutBrowser();
      return;
    }
    // CONTACT is not a room: it raises the calling card up from the bottom
    if (target.name === "CONTACT") {
      setOverlayHover(null);
      lastHoverName = null;
      openContactCard(camera);
      return;
    }
    const sceneName = MENU_TO_SCENE[target.name];
    if (sceneName) goToScene(sceneName);
  } else if (active.name === "MUSIC") {
    handleMusicClick(e);
  } else if (active.name === "ART") {
    handleArtClick(e);
  } else if (active.name === "CLOTHES") {
    if (!linkedMeshes.length) return;
    const ndx = (e.clientX / window.innerWidth) * 2 - 1;
    const ndy = -(e.clientY / window.innerHeight) * 2 + 1;
    if (pickLinkedMesh(ndx, ndy)) window.open(OBJECT_LINKS.CLOTHES.url, "_blank");
  } else if (active.name === "TORIS") {
    handleTorisClick(e);
  }
});

/* ------------------------------------------------------------------ */
/*  MUSIC: interactions + buttons (radio base + social controls)        */
/* ------------------------------------------------------------------ */

// MUSIC's camera has phases (see SCENE_LOOP). Clicking any INTERACTION object
// (STEREO, RADIOBASE, CHAVEZHEAD, stand, HEADPHONES) or BUTTON (PLAYPAUSE,
// INSTAGRAM, FORWARD, BACKWARD, SPOTIFY, YOUTUBE) enters the interactive loop:
// the camera jumps to frame 560 and stays in the standby 700..970. Buttons
// also open their external link (e.g. INSTAGRAM -> the IG profile). Clicking
// empty space while interacted plays the zoom-out exit (977..1085) and returns
// to the base loop from frame 0. Hovering anything lifts its emissive so it
// reads as clickable; button names map to their social URL.
const MUSIC_LINKS = {
  INSTAGRAM: "https://www.instagram.com/gob.ve/",
  YOUTUBE: "https://www.youtube.com/@gob_ve",
  SPOTIFY: "https://open.spotify.com/search/venezuelan%20government",
};

// MUSIC objects that open the ABOUT fake-browser instead of just entering the
// interactive loop. The frame loads the local satirical wikipedia page (the
// article genuinely "is" our fake HTML); the address bar pretends to be the
// real en.wikipedia.org article, deep-linked by its section anchor.
const MUSIC_WIKI = {
  HEADPHONES: {
    src: "media/ABOUT/vzpreswikipedia.html#Music_Production",
    address: "en.wikipedia.org/wiki/Venezuelan_Government_(Artist)#Music_Production",
    srcEs: "media/ABOUT/vzpreswikipedia_es.html#Music_Production",
    addressEs: "es.wikipedia.org/wiki/Gobierno_de_Venezuela_(Artista)#Music_Production",
  },
  CHAVEZHEAD: {
    src: "media/ABOUT/vzpreswikipedia.html#Ch%C3%A1vez_Doll",
    address: "en.wikipedia.org/wiki/Venezuelan_Government_(Artist)#Ch\u00e1vez_Doll",
    srcEs: "media/ABOUT/vzpreswikipedia_es.html#Ch%C3%A1vez_Doll",
    addressEs: "es.wikipedia.org/wiki/Gobierno_de_Venezuela_(Artista)#Ch\u00e1vez_Doll",
  },
};
const MUSIC_INTERACTIONS = ["STEREO", "RADIOBASE", "CHAVEZHEAD", "stand", "HEADPHONES"];
// always clickable, but NEVER glow (no beacon, no hover): STEREO / stand are
// skipped entirely in updateMusic so they stay visually inert
const MUSIC_NO_GLOW = ["STEREO", "stand"];
// hover lift suppressed while inside the interactive loop (RADIOBASE is the
// surface you're already standing on — glowing it there feels like a bug)
const MUSIC_NO_HOVER_WHEN_INTERACTED = ["RADIOBASE"];
const MUSIC_BUTTONS = ["PLAYPAUSE", "INSTAGRAM", "FORWARD", "BACKWARD", "SPOTIFY", "YOUTUBE"];

// interactable glow for every non-MAIN interactable (MUSIC targets, CLOTHES
// garments): a short "you can touch this" beacon pulse that fires GLOW_BEACON_PULSES
// times and then STOPS, after which only a STRONG hover lift highlights — so the
// scene stays calm instead of constantly sparkling. Emissive materials get their
// emissiveIntensity lifted; unlit (MeshBasic) materials get their color pushed
// toward white (they have no emissive channel).
const GLOW_PERIOD = 3.6;   // seconds per beacon cycle
const GLOW_RISE = 0.18;    // quick short shine up
const GLOW_FALL = 0.5;     // ...then a slightly slower shine down
const GLOW_PULSE = 2.2;    // beacon strength (multiplier on top of base)
const GLOW_HOVER = 2.2;    // hover strength (multiplier on top of base)
const GLOW_BEACON_PULSES = 2; // beacon pulses per target, then hover-only
// MUSIC re-arms its "count" beacon on EVERY re-entry (see resetMusic), firing
// this many pulses fresh each time so every visit re-highlights the buttons
// and interactions, then falls back to hover-only.
const MUSIC_BEACON_PULSES = 3;

// per-target beacon behaviour. "count" fires `beaconPulses` cycles then goes
// silent (MUSIC); "repeat" keeps pulsing forever (GORRA, every couple of
// seconds); "off" never beacons (GORRA2 / CLOTHES are hover-only).
function beaconLevel(t, period) {
  const q = t % (period || GLOW_PERIOD);
  if (q < GLOW_RISE) return q / GLOW_RISE;
  if (q < GLOW_RISE + GLOW_FALL) return 1 - (q - GLOW_RISE) / GLOW_FALL;
  return 0;
}

// seed a glow target: hover state, a staggered beacon phase, and the base
// colors for unlit materials (so the glow can be applied and removed cleanly)
function initTargetGlow(target) {
  target.hover = 0;
  target.pulseT = Math.random() * GLOW_PERIOD;
  target.beaconMode = "count";
  target.beaconPulses = GLOW_BEACON_PULSES;
  target.beaconPeriod = GLOW_PERIOD;
  target.hoverEnabled = true;
  target.baseColor = {};
  target.flashBoost = 0; // light-show emissive lift (0.25 = +25%); 0 = disabled
  target.mats.forEach(function (m) {
    if (!m) return;
    target.baseColor[m.name] = { r: m.color.r, g: m.color.g, b: m.color.b };
  });
  return target;
}

// build a glow set from a list of meshes (collects unique materials)
function makeGlowSet(meshes, name) {
  const mats = [];
  const base = {};
  const seen = new Set();
  meshes.forEach(function (o) {
    const list = Array.isArray(o.material) ? o.material : [o.material];
    list.forEach(function (m) {
      if (!m || seen.has(m)) return;
      seen.add(m);
      mats.push(m);
      base[m.name] = m.emissiveIntensity !== undefined ? m.emissiveIntensity : 0;
    });
  });
  return initTargetGlow({ name: name, meshes: meshes, mats: mats, base: base });
}

function applyTargetGlow(target, dt, noGlow) {
  if (!target.mats.length) return;
  target.pulseT += dt;
  // beacon behaviour is per-target: "repeat" pulses forever (GORRA), "count"
  // fires beaconPulses times then falls silent (MUSIC, the armature's 2 entry
  // pulses), "off" never beacons (GORRA2 / CLOTHES are hover-only)
  let beacon = 0;
  const period = target.beaconPeriod || GLOW_PERIOD;
  if (target.beaconMode !== "off" && !noGlow) {
    const cycle = Math.floor(target.pulseT / period);
    if (target.beaconMode === "repeat" || cycle < (target.beaconPulses || GLOW_BEACON_PULSES)) {
      beacon = beaconLevel(target.pulseT, period) * GLOW_PULSE;
    }
  }
  const glow = noGlow ? 0 : target.hover * (target.hoverStrength || GLOW_HOVER) + beacon;
  // light-show lift: interactable MUSIC parts add `flashBoost` (60% of the
  // hover glow) while the env light show is lit, scaled by the same smoothed
  // smallLevel that drives the GARAJE texture swap — additive on top of hover/
  // beacon, fading back to normal as the show winds down. STEREO / stand pass
  // noGlow=true so they only get this lift (never hover/beacon).
  const boost = (target.flashBoost || 0) * (musicFlash.ready ? musicFlash.smallLevel : 0);
  // glow == 0 && boost == 0: leave the material ALONE so the CLOTHES flicker
  // keeps driving it (stepClothesHorror runs earlier that frame and the glow
  // must not pin the garments to base — that's what made CLOTHES look stuck
  // bright).
  if (glow + boost <= 0) return;
  // write from the captured BASE values every frame (never *= 1+glow — that
  // ratchets the intensity up and never comes back down).
  const g = glow + boost;
  target.mats.forEach(function (m) {
    if (!m) return;
    if (m.emissiveIntensity !== undefined) {
      m.emissiveIntensity = target.base[m.name] * (1 + g);
    } else {
      const bc = target.baseColor[m.name];
      if (!bc) return;
      const k = Math.min(1, g * 0.6);
      m.color.setRGB(bc.r + (1 - bc.r) * k, bc.g + (1 - bc.g) * k, bc.b + (1 - bc.b) * k);
    }
  });
}

// ease a target's hover level: fast rise (so a short pass is visible), slow
// fall (so the glow lingers after leaving)
function easeHover(target, wanted) {
  const k = wanted ? 0.4 : 0.12;
  const wantedValue = wanted ? 1 : 0;
  target.hover += (wantedValue - target.hover) * k;
  // snap to a NUMBER, never the raw boolean (boolean coerces in arithmetic but
  // breaks anything calling hover.toFixed — see glowInfo)
  if (Math.abs(target.hover - wantedValue) < 0.01) target.hover = wantedValue;
}

const music = {
  interactions: [],
  buttons: [],
  hoverTarget: null,
  interacted: false,
  exiting: false,
};

function collectTargetMeshes(obj) {
  const out = [];
  const seen = new Set();
  if (obj.isMesh) seen.add(obj);
  obj.traverse(function (o) { if (o.isMesh) seen.add(o); });
  seen.forEach(function (o) { out.push(o); });
  return out;
}

function collectTargetMats(meshes) {
  const mats = [];
  const base = {};
  const seen = new Set();
  meshes.forEach(function (o) {
    const list = Array.isArray(o.material) ? o.material : [o.material];
    list.forEach(function (m) {
      if (seen.has(m)) return;
      seen.add(m);
      mats.push(m);
      base[m.name] = m.emissiveIntensity !== undefined ? m.emissiveIntensity : 0;
    });
  });
  return { mats: mats, base: base };
}

function setupMusic(gltf) {
  [].concat(MUSIC_INTERACTIONS, MUSIC_BUTTONS).forEach(function (n) {
    const obj = gltf.scene.getObjectByName(n);
    if (!obj) return;
    const meshes = collectTargetMeshes(obj);
    if (!meshes.length) return;
    const mats = collectTargetMats(meshes);
    const target = {
      name: n,
      meshes: meshes,
      mats: mats.mats,
      base: mats.base,
      isButton: MUSIC_BUTTONS.indexOf(n) >= 0,
    };
    initTargetGlow(target);
    // MUSIC beacons MUSIC_BEACON_PULSES times on every entry, then hover-only
    // (resetMusic re-arms the count by rewinding pulseT on each re-entry)
    target.beaconPulses = MUSIC_BEACON_PULSES;
    // additive light-show lift on every interactable: same look as the hover
    // glow, half intensity, active while the GARAJE-style env light is lit and
    // fading back with it (see applyTargetGlow)
    target.flashBoost = GLOW_HOVER * 0.6;
    if (target.isButton) music.buttons.push(target);
    else music.interactions.push(target);
  });
  console.log("[music] interactions:", music.interactions.map(function (i) { return i.name; }).join(", "));
  console.log("[music] buttons:", music.buttons.map(function (b) { return b.name; }).join(", "));
}

// swap the blank `radio_display` material (a white emissive plane on the
// RADIOBASE group) for an unlit canvas material carrying the live dot-matrix
// display texture — the same canvas-texture pattern as the ART screens.
// RADIOBASE is a GROUP in the GLB; its child meshes are RADIOBASE_1/2/3 and
// the white "display" is RADIOBASE_3 (radio_display material, white emissive
// with alphaMode=BLEND, so it paints white OVER the RADIOSCREEN plane that
// sits ~0.004 units in front of it).
// Verified with RADIOBASE hidden: the white plane IS on RADIOBASE (RADIOBASE_3
// / radio_display); underneath it is the blank RADIOSCREEN plane, which the
// LED swap hides so the canvas texture is the visible screen.
const MUSIC_RADIO_HIDE_BASE = false;
const radioDisplay = {
  ready: false,
  meshes: 0,
  swapped: 0,
  tex: null,
  hideBase: MUSIC_RADIO_HIDE_BASE,
};

// MAIN scene overlay panel: swap the authored OVERLAY material (alphaMode
// BLEND, emissive atlas) for an unlit transparent canvas material carrying
// the live white dot-matrix texture — the same system as the MUSIC room
// display, at ~2x the dot count on a near-square panel. The canvas is
// transparent wherever no LED is lit, so only the dots render.
const overlayDisplay = {
  ready: false,
  tex: null,
};

// slide the whole overlay assembly (dot-matrix OVERLAY + its HTML backing
// panel) toward screen-left so it reads centered on the wall. World -X is
// screen-left for the MAIN camera (it looks straight down -Z). The two nodes
// are re-parented under a wrapper group whose position carries the offset —
// their authored transforms stay untouched, so nothing else can undo the nudge.
// TUNE: fraction of panel width to shift left.
const OVERLAY_SHIFT_LEFT = 0.08;

function shiftOverlayLeft(gltf) {
  const overlay = gltf.scene.getObjectByName("OVERLAY");
  if (!overlay || !overlay.isMesh) { console.warn("[main] OVERLAY mesh not found, no shift"); return; }
  const html = gltf.scene.getObjectByName("HTML");
  const members = [overlay];
  if (html && html.isMesh) members.push(html);
  const group = new THREE.Group();
  group.name = "OVERLAY_ASSEMBLY";
  gltf.scene.add(group);
  // attach() keeps each panel's world transform intact while re-parenting
  members.forEach(function (m) { group.attach(m); });
  group.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(group);
  const w = box.max.x - box.min.x;
  const dx = w * OVERLAY_SHIFT_LEFT;
  const wp = new THREE.Vector3().setFromMatrixPosition(group.matrixWorld);
  wp.x -= dx;
  if (group.parent) group.parent.worldToLocal(wp);
  group.position.copy(wp);
  console.log("[main] overlay assembly shifted left by", dx.toFixed(4), "world units");
}

// Anisotropic filtering for the two dot-matrix panels, which are seen at a
// glancing angle from across their rooms: without it the mip chain over-blurs
// along one axis and the distant display tears into moire bands.
//
// CAPPED, though. `getMaxAnisotropy()` is 16 on a desktop and on most modern
// phones, and 16x on a texture the GPU must keep a deep mip chain for is a
// real cost — bandwidth and memory, both of which are exactly what the weakest
// devices lack. 4x removes essentially all of the visible moire (the streaks
// come from the first couple of mip levels being sampled anisotropically) at a
// quarter of the sampling work. perf.lite drops it to 1x, i.e. off.
const PANEL_ANISOTROPY_MAX = 4;
function panelAnisotropy() {
  const max = renderer.capabilities.getMaxAnisotropy();
  const want = perf.lite ? 1 : PANEL_ANISOTROPY_MAX;
  return Math.max(1, Math.min(max, want));
}

function setupOverlayDisplay(gltf) {
  if (overlayDisplay.ready) return;
  overlayDisplay.ready = true;
  const overlay = gltf.scene.getObjectByName("OVERLAY");
  if (!overlay || !overlay.isMesh) { console.warn("[overlayDisplay] OVERLAY mesh not found"); return; }
  const display = getMainDisplay();
  overlayDisplay.tex = display.tex;
  // glancing-angle legibility, same as the radio display
  display.tex.anisotropy = panelAnisotropy();
  display.tex.needsUpdate = true;
  const led = new THREE.MeshBasicMaterial({
    name: "overlay_display_led",
    map: display.tex,
    // >1 multiplier: the canvas dots are pure white but mipmapping averages
    // them with the TRANSPARENT gaps, so from across the room the panel reads
    // grey. Boosting color re-amplifies those averaged texels back up to
    // (and past) full white before output clamping — LEDs stay hot at range.
    color: new THREE.Color(1.6, 1.6, 1.6),
    transparent: true,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  led.userData.overlayDisplay = true;
  if (Array.isArray(overlay.material)) overlay.material = overlay.material.map(function () { return led; });
  else overlay.material = led;
  console.log("[overlayDisplay] live dot-matrix canvas applied to OVERLAY");
}

// the MAIN scene ships a leftover "DYNAMIC" plane that nothing uses anymore —
// cut it out of the graph and release its GPU resources (its material and
// textures are exclusive to it, verified in the GLB)
function removeDynamic(gltf) {
  const dyn = gltf.scene.getObjectByName("DYNAMIC");
  if (!dyn) return;
  if (dyn.parent) dyn.parent.remove(dyn);
  dyn.traverse(function (o) {
    if (!o.isMesh) return;
    if (o.geometry) o.geometry.dispose();
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    mats.forEach(function (m) {
      if (!m) return;
      ["map", "alphaMap", "emissiveMap", "normalMap", "roughnessMap", "metalnessMap"].forEach(function (k) {
        if (m[k] && m[k].isTexture) m[k].dispose();
      });
      m.dispose();
    });
  });
  console.log("[main] DYNAMIC removed from scene");
}

function blueTestCanvas() {
  const c = document.createElement("canvas");
  c.width = 16;
  c.height = 16;
  const g = c.getContext("2d");
  g.fillStyle = "#2288ff";
  g.fillRect(0, 0, 16, 16);
  return c;
}

function setupRadioDisplay(gltf) {
  if (radioDisplay.ready) return;
  radioDisplay.ready = true;
  const display = getDisplay();
  radioDisplay.tex = display.tex;
  // anisotropic filtering, capped: see panelAnisotropy
  display.tex.anisotropy = panelAnisotropy();
  display.tex.needsUpdate = true;

  const baseGroup = gltf.scene.getObjectByName("RADIOBASE");
  const screen = gltf.scene.getObjectByName("RADIOSCREEN");

  if (MUSIC_RADIO_HIDE_BASE) {
    // DEBUG: hide the whole base and paint RADIOSCREEN bright blue so we can
    // see it's the white plane (radio_display on RADIOBASE) that covers it.
    if (baseGroup) baseGroup.visible = false;
    if (screen && screen.isMesh) {
      const blueTex = new THREE.CanvasTexture(blueTestCanvas());
      blueTex.colorSpace = THREE.SRGBColorSpace;
      const blue = new THREE.MeshBasicMaterial({
        name: "radioscreen_blue_test",
        map: blueTex,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
      blue.userData.radioDisplay = true;
      if (Array.isArray(screen.material)) screen.material = screen.material.map(function () { return blue; });
      else screen.material = blue;
    }
    radioDisplay.meshes = 0;
    radioDisplay.swapped = 0;
    console.log("[radioDisplay] DEBUG: RADIOBASE group hidden (MUSIC_RADIO_HIDE_BASE)");
    return;
  }

  if (!baseGroup) { console.warn("[radioDisplay] RADIOBASE group not found"); return; }

  let meshes = 0, swapped = 0;
  const ledMeshes = [];
  baseGroup.traverse(function (o) {
    if (!o.isMesh) return;
    meshes++;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    mats.forEach(function (m, i) {
      if (!m || m.name !== "radio_display") return;
      const led = new THREE.MeshBasicMaterial({
        name: "radio_display_led",
        map: display.tex,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
      led.userData.radioDisplay = true;
      if (Array.isArray(o.material)) o.material[i] = led;
      else o.material = led;
      swapped++;
      ledMeshes.push({ mesh: o, materialIndex: i });
    });
  });

  // The screen mesh's authored UVs only cover a 97x9 sub-rectangle of the
  // 120x24 LED texture (u in [0.116,0.924], v in [0.380,0.724]). Remap the
  // radio_display UV group linearly to [0,1] so the FULL matrix maps onto
  // the mesh space.
  ledMeshes.forEach(function (t) {
    const g = t.mesh.geometry;
    const uv = g && g.attributes.uv;
    if (!uv) return;
    const groups = g.groups || [];
    const grp = groups.filter(function (gr) { return gr.materialIndex === t.materialIndex; })[0] || { start: 0, count: uv.count };
    const end = Math.min(uv.count, grp.start + grp.count);
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (let i = grp.start; i < end; i++) {
      const u = uv.getX(i), v = uv.getY(i);
      if (u < minU) minU = u; if (u > maxU) maxU = u;
      if (v < minV) minV = v; if (v > maxV) maxV = v;
    }
    const du = maxU - minU, dv = maxV - minV;
    if (!du || !dv) return;
    for (let i = grp.start; i < end; i++) {
      uv.setXY(i, (uv.getX(i) - minU) / du, 1 - (uv.getY(i) - minV) / dv);
    }
    uv.needsUpdate = true;
  });

  radioDisplay.meshes = meshes;
  radioDisplay.swapped = swapped;
  // RADIOSCREEN is a redundant blank plane 0.004 units in FRONT of the display
  // (and the white radio_display currently paints over it) — hide it so the
  // LED canvas is the visible screen.
  if (screen) screen.visible = false;
  console.log("[radioDisplay] applied live LED canvas to", swapped, "radio_display material(s) across", meshes, "RADIOBASE mesh(es); RADIOSCREEN hidden");
}

// MUSIC is by far the heaviest room in the build: ~99k triangles against MAIN's
// ~2k, in a handful of very large meshes. That makes the per-frame hover
// raycast genuinely expensive here — three.js has no BVH, so a ray through the
// room walks every triangle of every music target, every frame. On a phone
// that is enough to look like a crash (a multi-second block per frame), and it
// is why MUSIC specifically was the room that died on the tablet and the
// iPhone while the other four were fine.
//
// The raycast only decides which target GLOWS, so it does not need to run at
// frame rate. It is throttled here, and harder in lite mode. The click path
// (handleMusicClick) always does its own fresh raycast, so tapping is never
// affected by the throttle — only the glow lags by at most one interval.
const MUSIC_HOVER_HZ = 20;
const MUSIC_HOVER_HZ_LITE = 8;
let musicHoverAcc = 0;

function updateMusic(dt, hz) {
  if (music.exiting) return;
  if (!music.interactions.length && !music.buttons.length) return;
  // throttle the hover raycast (see above). `dt` is unused for the rest of
  // this function's logic but keeps the signature uniform with the other
  // per-scene update steps.
  musicHoverAcc += dt;
  const interval = 1 / (hz || MUSIC_HOVER_HZ);
  if (musicHoverAcc < interval) return;
  musicHoverAcc = 0;
  pointer.set(mouseX, -mouseY);
  raycaster.setFromCamera(pointer, camera);
  let target = null;
  // the buttons sit ON the radio base: check buttons FIRST so a button press
  // or hover isn't swallowed by the RADIOBASE interaction underneath
  const all = music.buttons.concat(music.interactions);
  for (let i = 0; i < all.length; i++) {
    if (raycaster.intersectObjects(all[i].meshes, false).length) { target = all[i]; break; }
  }
  const name = target ? target.name : null;
  if (name !== music.hoverTarget) {
    music.hoverTarget = name;
    radioPlayer.hover = name;
    console.log("[music] hover:", name ? name : "none");
  }
  // STEREO / stand stay clickable but NEVER glow; RADIOBASE drops its hover
  // lift while inside the interactive loop (only outside interaction)
  all.forEach(function (t) {
    if (MUSIC_NO_GLOW.indexOf(t.name) !== -1) return;
    const suppressHover = music.interacted && MUSIC_NO_HOVER_WHEN_INTERACTED.indexOf(t.name) !== -1;
    easeHover(t, t === target && !suppressHover);
  });
  all.forEach(function (t) {
    // STEREO / stand get no hover/beacon glow (they stay visually inert), but
    // they still receive the light-show lift, so applyTargetGlow runs for
    // everyone with noGlow=true for the NO_GLOW set.
    applyTargetGlow(t, dt, MUSIC_NO_GLOW.indexOf(t.name) !== -1);
  });
}

// CLOTHES interactables, split into per-part glow targets:
//   GORRA          repeating beacon every GORRA_BEACON_PERIOD + hover
//   the figure     ("the armature", body.002) 2 beacon pulses per entry, no hover
//   GORRA2/CLOTHES hover only (no beacon)
// The click test is the same pickLinkedMesh for every part (raycast for GORRA,
// skinned-vertex projection for the walking meshes) so highlights follow the
// garments WHERE THEY ACTUALLY ARE.
function updateClothesInteractions(dt) {
  if (!clothesTargets.length) return;
  const hit = pickLinkedMesh(mouseX, -mouseY);
  for (let i = 0; i < clothesTargets.length; i++) {
    const t = clothesTargets[i];
    if (!t.meshes.length) continue;
    const hovered = t.hoverEnabled && hit !== null && t.meshes.indexOf(hit) !== -1;
    easeHover(t, hovered);
    applyTargetGlow(t, dt);
  }
}

// enter the interactive standby loop (idempotent: already inside the loop, a
// re-click must NOT reset the camera — it just stays put, e.g. when pressing a
// button again to open its link)
function enterMusicInteractive() {
  const s = scenes.MUSIC;
  if (!s || !s.camNode || !s.posTrack || music.exiting) return;
  if (music.interacted) return; // stay in the loop, don't reset it
  const lc = SCENE_LOOP.MUSIC;
  s.loopStart = lc.afterStart;
  s.loopEnd = lc.afterEnd;
  s.camT = lc.jump;
  s.dir = 1;
  music.interacted = true;
}

// play the zoom-out exit once, then return to the base loop from frame 0
function exitMusic() {
  const s = scenes.MUSIC;
  if (!s || !s.camNode || !s.posTrack || music.exiting || !music.interacted) return;
  music.exiting = true;
  const lc = SCENE_LOOP.MUSIC;
  s.loopStart = lc.exitStart;
  s.loopEnd = lc.exitEnd;
  s.camT = lc.exitStart;
  s.dir = 1;
  s.exiting = true;
  console.log("[music] exiting: zoom-out frames", Math.round(lc.exitStart * CAM_FPS), "..", Math.round(lc.exitEnd * CAM_FPS));
}

// zoom-out finished: land on the base loop (frame 0) with a short reacquire
function finishMusicExit() {
  const s = scenes.MUSIC;
  s.exiting = false;
  const lc = SCENE_LOOP.MUSIC;
  s.loopStart = lc.baseStart;
  s.loopEnd = lc.baseEnd;
  s.camT = lc.baseStart;
  s.dir = 1;
  camera.updateMatrixWorld(true);
  camera.getWorldPosition(_pos);
  camera.getWorldQuaternion(_q0);
  setCameraPose(s, s.camT);
  applySceneFrame(s);
  s.camNode.updateMatrixWorld(true);
  _cwp.setFromMatrixPosition(s.camNode.matrixWorld);
  s.camNode.getWorldQuaternion(_q1);
  const rp = framedRootPose(s, _cwp, _q1, s.camT);
  reacquire = {
    from: { x: _pos.x, y: _pos.y, z: _pos.z },
    qFrom: { x: _q0.x, y: _q0.y, z: _q0.z, w: _q0.w },
    to: { x: _cwp.x, y: _cwp.y, z: _cwp.z },
    qTo: { x: _q1.x, y: _q1.y, z: _q1.z, w: _q1.w },
    rootFrom: { x: s.root.position.x, y: s.root.position.y, z: s.root.position.z },
    rootFromQ: { x: s.root.quaternion.x, y: s.root.quaternion.y, z: s.root.quaternion.z, w: s.root.quaternion.w },
    rootTo: rp.p,
    rootToQ: rp.q,
    t: 0,
    dur: REACQUIRE_SEC,
  };
  music.exiting = false;
  music.interacted = false; // back in the base loop: empty clicks do nothing
  console.log("[music] exit reacquire to frame 0");
}

// reset MUSIC so entering it again always starts from the beginning
function resetMusic(s) {
  const lc = SCENE_LOOP.MUSIC;
  s.loopStart = lc.baseStart;
  s.loopEnd = lc.baseEnd;
  s.camT = lc.baseStart;
  s.dir = 1;
  s.exiting = false;
  music.interacted = false;
  music.exiting = false;
  // re-arm the entry beacon: MUSIC targets fire MUSIC_BEACON_PULSES fresh
  // pulses on every re-entry, then fall back to hover-only. pulseT is frozen
  // whenever applyTargetGlow isn't running (scene inactive / music.exiting),
  // so rewinding it here makes each visit re-highlight from scratch.
  music.interactions.concat(music.buttons).forEach(function (t) {
    t.pulseT = 0;
    t.hover = 0;
  });
  musicFlash.t0 = performance.now();
  musicFlash.lastT = 0;
  musicFlash.cueIdx = 0;          // the sheet is per-song, so rewind on every visit
  musicFlash.envLevel = 0;
  musicFlash.smallLevel = 0;
}

function handleMusicClick(e) {
  if (reacquire || music.exiting) return;
  screenRaycast(e.clientX, e.clientY);
  // buttons sit on the radio base: buttons FIRST so a button click isn't
  // swallowed by the RADIOBASE interaction underneath it
  const all = music.buttons.concat(music.interactions);
  let hit = null;
  for (let i = 0; i < all.length; i++) {
    if (raycaster.intersectObjects(all[i].meshes, false).length) { hit = all[i]; break; }
  }
  if (hit) {
    if (music.exiting) return;
    enterMusicInteractive();
    if (hit.isButton) {
      if (hit.name === "PLAYPAUSE") {
        radioPlayer.toggle();
        console.log("[music] PLAYPAUSE ->", radioPlayer.state);
      } else if (hit.name === "FORWARD") {
        radioPlayer.seekNext();
        console.log("[music] FORWARD ->", radioPlayer.track.title);
      } else if (hit.name === "BACKWARD") {
        radioPlayer.seekPrev();
        console.log("[music] BACKWARD ->", radioPlayer.track.title);
      } else {
        const url = MUSIC_LINKS[hit.name];
        if (url) window.open(url, "_blank");
        console.log("[music] button", hit.name, "->", url);
      }
    } else {
      const wiki = MUSIC_WIKI[hit.name];
      if (wiki) {
        const es = window.__PORTFOLIO_LANG__ === "es";
        openAboutBrowser(es ? wiki.srcEs : wiki.src, es ? wiki.addressEs : wiki.address);
        console.log("[music] wiki", hit.name, "->", es ? wiki.srcEs : wiki.src);
      } else {
        console.log("[music] interaction", hit.name);
      }
    }
    return;
  }
  if (music.interacted) exitMusic();
}

/*  MUSIC: baked-texture flash light show (BPM-driven)                 */
/* ------------------------------------------------------------------ */

// The car's baked parts swap to injected "flashing light" textures in time
// with the beat. MAIN LIGHTS are "wired" to real car-audio lights and carry
// the show; the ENV group (BANDERA, CARRO, GARAJE) is environmental — those
// only light up because they catch the main lights, so they follow a single
// percentage: all mains on = fully lit, half on = ~50%. That percentage is a
// size-weighted average (bigger mains bleed more light), smoothed like
// ambient light. Textures live in media/textures/MUSIC/ as .webp,
// name-coordinated to the scene nodes. The show is generative: a 16th-note
// grid, a per-bar choreography chosen by a seeded RNG, double-time (8th-note)
// pulses — so it never loops bar-to-bar and re-seeds on every entry.
//
// Three things tie it to the actual song rather than a fixed 120 bpm:
//   * the clock is the AUDIO position, not wall time, so the show stays locked
//     to the song, re-phases on a track change, and freezes when paused;
//   * the tempo is the playing track's own BPM (the artist's values, in TRACKS);
//   * and, decisively, the show is NOT reactive. Every song has a cue sheet
//     baked from its own onsets and spectrum (js/lightCues.js, built by
//     tools/cues.py): cues land on the beat, and each cue names the lamps to
//     light based on the frequency bands that are hot at that instant. Bass
//     passages light the big corneta, bright ones light the tweeters, and the
//     choice is anchored to the beat position so a bar repeats musically.
//
// Why baked rather than live: a per-step RNG changed ~7x a second with no
// relationship to the music, which reads as flicker. The sheets run at ~1.9
// cues/s, which reads as a pattern.
//
// Two rules shape the result:
//   * never dark  - each cue's fall is stretched to just reach the next cue, so
//                   the car is lit continuously whenever the song plays. Only
//                   real silence (pause, or the 2 s gap between songs) goes dark.
//   * bounce      - a lamp that fires throws a little light onto the others, so
//                   the car reads as illuminated rather than as seven
//                   independent texture swaps. See MUSIC_FLASH_BOUNCE.
const MUSIC_FLASH_FOLDER = "media/textures/MUSIC/";
// fallback only: every track carries its own `bpm` (see TRACKS in
// radioDisplay.js), so this is just a safety net if a track ever lacks one
const MUSIC_FLASH_BPM_FALLBACK = 120;
// Lamp envelope: snap on hard, fall off hard. The smoothing here is only there
// so a lamp does not strobe at frame rate; the SHAPE comes from the cue.
const MUSIC_FLASH_ATTACK = 0.95;
const MUSIC_FLASH_DECAY = 0.8;
// Ceiling on the bounce - the light a lamp throws onto the OTHERS. This is an
// illusion, not a real light rig, but a lamp firing should still spill onto its
// neighbours or the car body and the flag read as flat cut-outs rather than as
// things standing in each other's light.
//
// It is a RATIO, independent of MUSIC_FLASH_BOOST, so it can be generous here
// while the lamps themselves stay dim. Because only one or two lamps are lit at
// a time now, the realised spill is roughly a quarter of this cap: measured
// mean 5.4% / peak 16.1% at 0.26, hence 0.24, which lands the mean around 5%
// and the peak under 15%.
const MUSIC_FLASH_BOUNCE = 0.24;
// A lamp at or above this is "visibly lit".
const MUSIC_FLASH_MIN_LIT = 0.15;
// How far a main lamp's emissive is pushed above its baked value. Lowered from
// 3, where the car read as permanently lit rather than as flashes - contrast is
// the whole point of the show.
const MUSIC_FLASH_BOOST = 2.0;
// MAIN lights in size-priority order (biggest first). weight = the light-bleed
// percentage that light contributes to the environment while it's on.
// CORNETAMAINSEPARADOR is the biggest, so it bleeds the most.
const MUSIC_FLASH_MAINS = [
  { node: "CORNETAMAINSEPARADOR", file: "CORNETAMAINSEPARADOR", weight: 1.6 },
  { node: "TRUMPETS", file: "TRUMPETS", weight: 1.3 },
  { node: "BAJOHUECOGRANDE", file: "BAJOHUECOGRANDE", weight: 1.2 },
  { node: "TWEETERS", file: "TWEETERS", weight: 1.1 },
  { node: "CORNETASMID", file: "CORNETASMID", weight: 1.05 },
  { node: "CORNETASUP", file: "CORNETASUP", weight: 1.0 },
  { node: "mesh_0002", file: "CORNETASLOW", weight: 0.9 },
];
// fix = material overrides applied once at load (before defaults are captured).
// CARRO: the GLB exports its material as alphaMode=BLEND + doubleSided, which
// three.js turns into transparent:true, depthWrite:false, side:DoubleSide.
// The transparent+no-depth-write combo lets the far geometry (back wheels,
// back faces) paint OVER the near body — the see-through "front wheels from
// the back" artifact. Making it opaque + writing depth renders only the
// nearest face, so the shell reads solid.
// NOTE: CARRO is an ENV target, not a MAIN — the fix must be applied in both
// the mains and env loops (see setupMusicFlash), or CARRO never gets fixed.
const MUSIC_FLASH_FIX = { CARRO: { depthWrite: true, transparent: false } };

function applyMusicFlashFix(obj, nodeName) {
  const fix = MUSIC_FLASH_FIX[nodeName];
  if (!fix) return false;
  const fmats = Array.isArray(obj.material) ? obj.material : [obj.material];
  fmats.forEach(function (m) {
    if (!m) return;
    if (fix.depthWrite) m.depthWrite = true;
    if (fix.transparent !== undefined) m.transparent = fix.transparent;
    if (fix.side) m.side = fix.side;
    m.needsUpdate = true;
  });
  console.log("[musicFlash] fixed", nodeName, JSON.stringify(fix));
  return true;
}
// environmental lights: act as one entity, all at the same percentage.
// GARAJE + CARRO are small-light-biased (respond more to the smaller mains);
// CARRO gets a gain < 1 so it stays dimmer than GARAJE.
//
// CARRO used to carry `driver: "CORNETAMAINSEPARADOR"`, which made the car
// itself punch in time with one lamp - it read as if the bodywork were an LED
// speaker, which is not what it is. It now takes the same smoothed aggregate as
// BANDERA and GARAJE, so the car is only ever lit BY the other lamps (including
// their bounce), never in step with one of them.
const MUSIC_FLASH_ENV = [
  { node: "BANDERA", file: "BANDERA" },
  { node: "CARRO", file: "CARRO", gain: 0.7 },
  { node: "GARAJE", file: "GARAJE", small: true },
];
// env texture-swap hysteresis: the env lights swap to their flash texture only
// once the glow is clearly on (above MUSIC_FLASH_ENV_INJECT) and swap BACK to
// the baked default below MUSIC_FLASH_ENV_RESTORE.
//
// The band is deliberately WIDE. With the punchy lamp envelope the aggregate
// level spends most of its time near zero and spikes on each hit, and a narrow
// band made the swap flip back and forth on every hit - BANDERA / CARRO / GARAJE
// read as flickering at random rather than as lit by the lamps. A wide band
// means they latch on when the car is genuinely lit and stay on until it is
// genuinely dark, which is what "a direct connection" looks like.
const MUSIC_FLASH_ENV_INJECT = 0.30;
const MUSIC_FLASH_ENV_RESTORE = 0.10;
// how fast the environment follows the lamps. Short, because the response is
// meant to be immediate rather than eased into place.
const MUSIC_FLASH_ENV_TAU = 0.025;

const musicFlash = {
  ready: false,
  // fixed length, indexed by MUSIC_FLASH_MAINS position. A slot stays empty until
  // that lamp's texture lands, because cue mask bit i addresses config index i -
  // the array must never be reordered or compacted.
  mains: new Array(MUSIC_FLASH_MAINS.length).fill(null),
  mainOrder: [],    // which node landed in which slot, for the debug read-out
  env: [],         // registered environmental targets
  t0: 0,
  lastT: 0,
  envLevel: 0,     // smoothed environmental percentage (size-weighted)
  smallLevel: 0,   // smoothed environmental percentage (small-light-biased)
  totalWeight: 0,
  maxWeight: 1,
  bpm: MUSIC_FLASH_BPM_FALLBACK, // live tempo, from the playing track
  mask: 0,                       // lamp bitmask the current cue asked for
  mode: "",                      // "cue" while a sheet is driving, else ""
  lit: 0,                        // how many lamps the cue asked for
  cost: 0,                       // smoothed ms/frame spent in this function
  cues: null,                    // decoded cue sheet for the current track
  cueTitle: null,                // which track cues belongs to
  cueIdx: 0,                     // playback pointer into cues
  raw: [0, 0, 0, 0, 0, 0, 0],    // per-lamp level straight from the cue
  bounce: MUSIC_FLASH_BOUNCE,
};

function makeFlashTarget(mesh, tex, weight, small, gain) {
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const defaults = mats.map(function (m) {
    return m ? {
      map: m.map,
      emissiveMap: m.emissiveMap,
      emissive: m.emissive ? { r: m.emissive.r, g: m.emissive.g, b: m.emissive.b } : null,
      intensity: m.emissiveIntensity !== undefined ? m.emissiveIntensity : 1,
      color: m.color ? { r: m.color.r, g: m.color.g, b: m.color.b } : null,
    } : null;
  });
  return {
    mesh: mesh, tex: tex, mats: mats, defaults: defaults,
    weight: weight || 0, small: !!small, gain: gain !== undefined ? gain : 1,
    level: 0, injected: false,
    injectTh: 0.001, restoreTh: 0.001,
  };
}

function setupMusicFlash(gltf) {
  if (musicFlash.ready) return;
  musicFlash.ready = true;
  const loader = new THREE.TextureLoader();
  // Cue masks are bit flags, and bit i means "the lamp at config index i". So the
  // array MUST stay in MUSIC_FLASH_MAINS order for the whole session. Pushing from
  // inside the async texture callback did NOT: browsers deliver textures in
  // whatever order they finish, so mains[i] was whichever lamp happened to load
  // i-th. That silently swapped e.g. TRUMPETS with BAJOHUECOGRANDE, and could
  // differ between reloads. Each target now writes to its own fixed slot instead,
  // leaving a hole until its texture lands; consumers skip the holes.
  MUSIC_FLASH_MAINS.forEach(function (cfg, idx) {
    const obj = gltf.scene.getObjectByName(cfg.node);
    if (!obj || !obj.isMesh) { console.warn("[musicFlash] node not found:", cfg.node); return; }
    applyMusicFlashFix(obj, cfg.node);
    const path = MUSIC_FLASH_FOLDER + cfg.file + ".webp";
    loader.load(path, function (tex) {
      tex.name = cfg.file;
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.flipY = false;
      musicFlash.mains[idx] = makeFlashTarget(obj, tex, cfg.weight);
      musicFlash.mainOrder.push(cfg.node);
      console.log("[musicFlash] main", idx, cfg.node, "<-", path);
    }, undefined, function () { console.warn("[musicFlash] missing:", path); });
  });
  MUSIC_FLASH_ENV.forEach(function (cfg) {
    const obj = gltf.scene.getObjectByName(cfg.node);
    if (!obj || !obj.isMesh) { console.warn("[musicFlash] env node not found:", cfg.node); return; }
    applyMusicFlashFix(obj, cfg.node);
    const path = MUSIC_FLASH_FOLDER + cfg.file + ".webp";
    loader.load(path, function (tex) {
      tex.name = cfg.file;
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.flipY = false;
      const tg = makeFlashTarget(obj, tex, 0, cfg.small, cfg.gain);
      tg.injectTh = MUSIC_FLASH_ENV_INJECT;
      tg.restoreTh = MUSIC_FLASH_ENV_RESTORE;
      tg.driver = cfg.driver || null;
      musicFlash.env.push(tg);
      console.log("[musicFlash] env", cfg.node, "<-", path);
    }, undefined, function () { console.warn("[musicFlash] missing:", path); });
  });
  console.log("[musicFlash] loading", MUSIC_FLASH_MAINS.length, "mains +", MUSIC_FLASH_ENV.length, "env textures");
}

function injectFlashMaterial(m, tex) {
  if (!m) return;
  m.map = tex;
  if (m.emissiveMap !== undefined) {
    m.emissiveMap = tex;
    if (m.emissive) m.emissive.setRGB(1, 1, 1);
  }
  m.needsUpdate = true;
}

function restoreFlashMaterial(m, d) {
  if (!m || !d) return;
  m.map = d.map;
  if (m.emissiveMap !== undefined) m.emissiveMap = d.emissiveMap;
  if (m.emissive && d.emissive) m.emissive.setRGB(d.emissive.r, d.emissive.g, d.emissive.b);
  if (m.color && d.color) m.color.setRGB(d.color.r, d.color.g, d.color.b);
  if (m.emissiveIntensity !== undefined && d.intensity !== undefined) m.emissiveIntensity = d.intensity;
  m.needsUpdate = true;
}

function applyFlashMaterial(m, d, level) {
  if (!m || !d) return;
  if (m.emissiveIntensity !== undefined) {
    m.emissiveIntensity = d.intensity * (1 + level);
  } else if (m.color && d.color) {
    const k = Math.min(1, level * 0.35);
    m.color.setRGB(d.color.r + (1 - d.color.r) * k, d.color.g + (1 - d.color.g) * k, d.color.b + (1 - d.color.b) * k);
  }
}


// --- cue playback ------------------------------------------------------
// The show is NOT reactive any more. Each song has a cue sheet baked from its
// own onsets and spectrum (js/lightCues.js, built by tools/cues.py): cues land
// on the beat, and each cue says which lamps to light based on the frequency
// bands that are hot at that instant. A live per-step RNG changed ~7x a second
// with no relationship to the music, which is exactly what read as flicker.
//
// Cue -> lamp envelope: snap up, hold, then fall over exactly the gap to the
// next cue. Stretching the fall to the gap is what guarantees the car is never
// dark while the song plays, without ever having to force a lamp on artificially.
function musicFlashCueFor(t) {
  const cues = musicFlash.cues;
  if (!cues || !cues.length) return null;
  // pointer only moves forward; re-seek when the clock jumps (seek / track change)
  if (musicFlash.cueIdx >= cues.length || (musicFlash.cueIdx > 0 && cues[musicFlash.cueIdx].t > t)) {
    musicFlash.cueIdx = 0;
  }
  while (musicFlash.cueIdx + 1 < cues.length && cues[musicFlash.cueIdx + 1].t <= t) musicFlash.cueIdx++;
  const c = cues[musicFlash.cueIdx];
  if (c.t > t + 0.001) return null;               // before the first cue
  const next = cues[musicFlash.cueIdx + 1];
  const gap = next ? next.t - c.t : 1.0;
  return { cue: c, age: t - c.t, gap: gap };
}

function musicFlashCueLevel(age, gap, beatDur) {
  // A blink, not a swell. The old envelope held for a third of a beat and then
  // fell across the whole gap, which left the car lit most of the time and read
  // as "slow and careful". Now it is a short spike that is over well before the
  // next hit, so the darkness BETWEEN hits is part of the rhythm.
  const rise = 0.012;
  if (age < rise) return age / rise;
  const hold = 0.035;
  if (age < rise + hold) return 1;
  const fall = Math.max(0.05, Math.min(0.26, (gap - rise - hold) * 0.8));
  const p = (age - rise - hold) / fall;
  return p >= 1 ? 0 : 1 - p;
}

function musicFlashPaint(tg) {
  // hysteresis: once swapped in, stay swapped until the level falls below the
  // (lower) restore threshold; when on the default texture, only swap in above
  // the (higher) inject threshold. Mains keep 0.001/0.001 so they never drift.
  const active = tg.injected
    ? tg.level > (tg.restoreTh || 0.001)
    : tg.level > (tg.injectTh || 0.001);
  if (active && !tg.injected) {
    for (let j = 0; j < tg.mats.length; j++) injectFlashMaterial(tg.mats[j], tg.tex);
    tg.injected = true;
  } else if (!active && tg.injected) {
    for (let j = 0; j < tg.mats.length; j++) restoreFlashMaterial(tg.mats[j], tg.defaults[j]);
    tg.injected = false;
  }
  // Skip the material write when the level has not meaningfully moved.
  // applyFlashMaterial only touches uniforms (emissiveIntensity / color), which
  // three.js refreshes every frame anyway - it does NOT need needsUpdate, and
  // dirtying 10 materials on every frame is pure overhead.
  if (Math.abs(tg.level - tg.painted) < 0.008) return;
  tg.painted = tg.level;
  const level = tg.level * MUSIC_FLASH_BOOST;
  for (let j = 0; j < tg.mats.length; j++) applyFlashMaterial(tg.mats[j], tg.defaults[j], level);
}

function stepMusicFlash() {
  if (!musicFlash.ready || !musicFlash.mains.length) return;
  // mains is a fixed-length slot array, so length is always 7. What we actually
  // need is "something has landed": before the first texture arrives every slot
  // is a hole and there is nothing to paint.
  if (!musicFlash.mainOrder.length) return;
  const now = performance.now();
  const dt = musicFlash.lastT ? Math.min(0.1, (now - musicFlash.lastT) / 1000) : 0;
  musicFlash.lastT = now;

  const n = musicFlash.mains.length;
  const tr = radioPlayer.track;
  const bpm = (tr && tr.bpm) || MUSIC_FLASH_BPM_FALLBACK;
  musicFlash.bpm = bpm;
  const beatDur = 60 / bpm;

  // Swap the cue sheet when the track changes. No live audio analysis: the
  // sheet already knows what to light and when.
  const title = tr ? tr.title : null;
  if (title !== musicFlash.cueTitle) {
    musicFlash.cueTitle = title;
    musicFlash.cues = lightCues(title);
    musicFlash.cueIdx = 0;
  }

  // Clock comes from the AUDIO, so the show stays locked to the song, re-phases
  // on a track change, and freezes when the player is paused. During the
  // inter-track gap (and whenever not actually playing) the car goes dark -
  // that is the only thing allowed to turn it off.
  const playing = radioPlayer.state === "playing";
  const t = playing && radioPlayer.ambient ? radioPlayer.currentTime() : 0;
  const hit = playing ? musicFlashCueFor(t) : null;

  // ---- lamps: straight from the cue, no randomness -------------------------
  const raw = musicFlash.raw;
  for (let i = 0; i < n; i++) raw[i] = 0;
  // largest lamp weight, for the per-lamp brightness scale below. Computed here
  // rather than reusing musicFlash.maxWeight, which is filled in further down
  // and would still hold the previous frame's value.
  let peakW = 0;
  for (let i = 0; i < n; i++) { const t = musicFlash.mains[i]; if (t && t.weight > peakW) peakW = t.weight; }
  if (hit) {
    const env = musicFlashCueLevel(hit.age, hit.gap, beatDur);
    const lvl = LIGHT_CUE_LEVELS[hit.cue.level] * env;
    musicFlash.mask = hit.cue.mask;
    musicFlash.mode = "cue";
    for (let i = 0; i < n; i++) {
      const t = musicFlash.mains[i];
      if (!t) continue; // texture still loading
      if (!(hit.cue.mask & (1 << i))) continue;
      // Scale by lamp size so the lit set is not a row of identical lamps: the
      // big corneta (the strongest reflector on the car) leads and the small
      // ones trail. This is what stops four lights reading as a uniform slab.
      raw[i] = lvl * (0.5 + 0.5 * (t.weight / peakW));
    }
  } else {
    musicFlash.mask = 0;
  }
  musicFlash.lit = 0;
  for (let i = 0; i < n; i++) if (raw[i] >= MUSIC_FLASH_MIN_LIT) musicFlash.lit++;

  // ---- bounce -------------------------------------------------------------
  // We are faking illumination, so a lamp that fires should throw a little light
  // onto the others - otherwise the car body and the flag read as flat cut-outs
  // instead of as things standing in each other's light.
  //
  // Each lamp receives the AVERAGE level of the other lamps, which is closer to
  // how bounce behaves than weighting by lamp size. The earlier weight-ratio
  // version swung about 3x between a big corneta firing and a small one, which
  // put the mean spill and the peak in direct conflict (mean wanted >= 5%, peak
  // wanted <= 15%, and the weight ratio made those mutually exclusive).
  // Unweighted, the spread is about 2x and both fit.
  //
  // Single pass from the raw levels, so it cannot feed back on itself.
  let emit = 0;
  for (let i = 0; i < n; i++) { const t = musicFlash.mains[i]; if (t) emit += raw[i] * t.weight; }

  let agg = 0, sagg = 0, stot = 0, totalW = 0, maxW = 0, live = 0;
  for (let i = 0; i < n; i++) {
    const tg = musicFlash.mains[i];
    if (!tg) continue; // texture still loading
    live++;
    totalW += tg.weight;
    if (tg.weight > maxW) maxW = tg.weight;
    const others = emit - raw[i] * tg.weight;
    const othersAvg = live > 1 ? others / (live - 1) : 0;
    const bounce = MUSIC_FLASH_BOUNCE * othersAvg;
    const target = Math.min(1, raw[i] + bounce);
    if (target > tg.level) tg.level += (target - tg.level) * MUSIC_FLASH_ATTACK;
    else tg.level += (target - tg.level) * MUSIC_FLASH_DECAY;
    if (tg.level < 0.004) tg.level = 0;
    agg += tg.level * tg.weight;
    sagg += tg.level / tg.weight; // small-light bias: smaller mains count more
    stot += 1 / tg.weight;
    musicFlashPaint(tg);
  }
  musicFlash.totalWeight = totalW;
  musicFlash.maxWeight = maxW;
  musicFlash.bounce = MUSIC_FLASH_BOUNCE;

  // environmental percentage: how much of the main lights are on - smoothed so
  // BANDERA / CARRO / GARAJE glow like ambient light instead of strobing.
  // envLevel is size-weighted; smallLevel flips the bias so GARAJE responds
  // more to the smaller lights (TWEETERS / MID / UP / SLOW).
  //
  // CUMULATIVE, and directly tied to the lamps: the average is scaled by how
  // MANY lamps are contributing as well as how bright, so four lamps at 0.3
  // light the environment more than one lamp at 1.0. That is the "how many and
  // what is lit" reading - a single lamp alone barely touches the car body,
  // which is correct, because one lamp really does not light a whole vehicle.
  const envTarget = totalW > 0 ? (agg / totalW) * (0.5 + 0.5 * (musicFlash.lit / n)) : 0;
  const smallTarget = stot > 0 ? sagg / stot : 0;
  const k = dt > 0 ? 1 - Math.exp(-dt / MUSIC_FLASH_ENV_TAU) : 1;
  musicFlash.envLevel += (envTarget - musicFlash.envLevel) * k;
  musicFlash.smallLevel += (smallTarget - musicFlash.smallLevel) * k;
  if (musicFlash.envLevel < 0.001) musicFlash.envLevel = 0;
  if (musicFlash.smallLevel < 0.001) musicFlash.smallLevel = 0;

  for (let i = 0; i < musicFlash.env.length; i++) {
    const tg = musicFlash.env[i];
    if (tg.driver) {
      // follow one main light's level, smoothed so CARRO rises with the big
      // corneta and fades away quickly but never snaps.
      const dm = musicFlash.mains.find(function (m) { return m && m.mesh.name === tg.driver; });
      const target = dm ? dm.level * tg.gain : 0;
      const k2 = dt > 0 ? 1 - Math.exp(-dt / 0.05) : 1;
      tg.level += (target - tg.level) * k2;
    } else {
      tg.level = (tg.small ? musicFlash.smallLevel : musicFlash.envLevel) * tg.gain;
    }
    musicFlashPaint(tg);
  }
  // what this whole function actually costs, so "is the light show heavy?" is
  // a measurement rather than a guess
  const spent = performance.now() - now;
  musicFlash.cost += (spent - musicFlash.cost) * 0.05;
}
// ART plays as a single 0..720-frame timeline. The clips drive only
// transforms; the laptopshade fade (124..134), the screenLOADING /
// screenLOADED swap (534 / 607 / 608) and the window pop-ins have no opacity
// tracks, so they are driven from the CAMERA frame in updateArtTimeline
// (frame = s.camT * 24) — the timeline stays locked to what the camera sees.
const ART_CLICKABLE_NAMES = ["DESK", "laptopshade"];
const ART_LAPTOP_NAMES = ["laptop_top", "laptop_bottom"];

// desktop click hit area is ART_HIT_INFLATE × the object's own size — the
// interaction window is 50% bigger than the object (the box grows by half the
// object's size on every side). This applies to the windows AND the now-
// invisible CLOSE objects, so both are easy to hit.
const ART_HIT_INFLATE = 0.5;
// windows showcase that they are clickable: each pulses ART_WINDOW_PULSES
// times, ART_WINDOW_PERIOD seconds apart, staggered ART_WINDOW_STAGGER seconds
// window-to-window so they ripple instead of pulsing all at once.
const ART_WINDOW_PULSES = 3;
const ART_WINDOW_PERIOD = 2.0;
const ART_WINDOW_STAGGER = 0.5;

// windows + their close buttons are hidden until these frames: each pair pops
// in on the desktop screen during the close-up loop 601..719. Frames are
// CAMERA frames (s.camT): the reveals are driven by the close-up loop, so the
// desktop populates as the camera sweeps through it. CLOSEtb is listed per the
// source spec but is NOT present in the GLB; CLOSEtoris is an orphan close
// (no windowtoris node) that must also start hidden or it floats on the
// desktop from the very first frame. `art` is the portfolio piece each window
// opens when clicked (name-coordinated with media/artwork/<name>.webp).
const ART_WINDOWS = [
  { frame: 676, window: "windowsamurai", close: "CLOSEsamurai", art: "samurai" },
  { frame: 681, window: "windowtb", close: "CLOSEtb", art: "toribash" },
  { frame: 681, window: null, close: "CLOSEtoris", art: null },
  { frame: 686, window: "windowdrg", close: "CLOSEdrg", art: "drg" },
  { frame: 690, window: "windowtf", close: "CLOSEtf", art: "ghosts" },
  { frame: 692, window: "windowengi", close: "CLOSEengi", art: "engi" },
  { frame: 700, window: "windowdnd", close: "CLOSEdnd", art: "dnd" },
  { frame: 705, window: "windowangel", close: "CLOSEangel", art: "angel" },
  { frame: 711, window: null, close: "CLOSEportfolio", art: null },
];

const art = {
  targets: [],       // glow targets: laptop top + laptop bottom
  clickMeshes: [],   // every clickable mesh (DESK, laptop top/bottom, shade)
  hoverTarget: null,
  interacted: false, // close-up loop 601..720 active
  entering: null,    // entry glide: { t, dur, from, to } while easing into 640
  loopNarrowed: false, // true once the loop has narrowed to 650..720
  clock: 0,          // seconds since entry (debug/timer only; timeline is camT-driven)
  bootDone: false,   // screenLOADED latched on after the intro first pass
  debugShow: false,  // DEBUG: artForceShow() pins all overlays visible
  shade: null,       // { meshes, mats, removed } for the laptopshade fade
  loading: null,     // screenLOADING group node
  loaded: null,      // screenLOADED group node
  windows: [],       // [{ frame, shown, nodes, art, node, closeNode }] reveals
  windowMeshes: [],  // the clickable window nodes (each opens its artwork)
  closeMeshes: [],   // the CLOSEx nodes (each removes itself + its window)
  closePortfolio: null, // the CLOSEportfolio node (removes itself + clears overlay)
  windowGlow: [],    // per-window showcase glow targets (3 staggered pulses each)
  popup: null,       // popup cascade state (see ART popup overlay section)
};

// laptopshade uses a material shared with nothing else, but clone it anyway so
// the fade never bleeds into another object and the reset is always clean
function setupArtShade(obj) {
  if (!obj) return null;
  const meshes = collectTargetMeshes(obj);
  if (!meshes.length) return null;
  const mats = [];
  const seen = new Set();
  meshes.forEach(function (o) {
    const list = Array.isArray(o.material) ? o.material : [o.material];
    list.forEach(function (m) {
      if (!m || seen.has(m)) return;
      seen.add(m);
      const clone = m.clone();
      clone.name = m.name + "_artFade";
      clone.transparent = true;
      mats.push(clone);
      if (Array.isArray(o.material)) o.material[list.indexOf(m)] = clone;
      else o.material = clone;
    });
  });
  return { meshes: meshes, mats: mats, removed: false };
}

function setupArt(gltf) {
  art.shade = setupArtShade(gltf.scene.getObjectByName("laptopshade"));
  art.loading = gltf.scene.getObjectByName("screenLOADING") || null;
  art.loaded = gltf.scene.getObjectByName("screenLOADED") || null;
  art.clickMeshes = [];
  art.targets = [];
  // laptop top + bottom are ONE clickable: hovering either part highlights both
  let laptop = [];
  ART_LAPTOP_NAMES.forEach(function (n) {
    const obj = gltf.scene.getObjectByName(n);
    if (obj) laptop = laptop.concat(collectTargetMeshes(obj));
  });
  if (laptop.length) {
    const t = makeGlowSet(laptop, "laptop");
    t.beaconMode = "count";
    t.beaconPulses = MUSIC_BEACON_PULSES;
    art.targets.push(t);
    art.clickMeshes = art.clickMeshes.concat(laptop);
  }
  ART_CLICKABLE_NAMES.forEach(function (n) {
    const obj = gltf.scene.getObjectByName(n);
    if (!obj) return;
    art.clickMeshes = art.clickMeshes.concat(collectTargetMeshes(obj));
  });
  art.windows = [];
  art.windowMeshes = [];
  art.closeMeshes = [];
  art.closePortfolio = null;
  art.windowGlow = [];
  ART_WINDOWS.forEach(function (w) {
    const nodes = [];
    let winNode = null;
    let closeNode = null;
    if (w.window) {
      const o = gltf.scene.getObjectByName(w.window);
      if (o) { nodes.push(o); winNode = o; }
      else console.log("[art] missing window node:", w.window);
    }
    if (w.close) {
      const o = gltf.scene.getObjectByName(w.close);
      if (o) nodes.push(o);
      else console.log("[art] missing close node:", w.close);
      closeNode = o || null;
    }
    if (nodes.length) {
      art.windows.push({ frame: w.frame, shown: false, nodes: nodes, art: w.art || null, node: winNode, closeNode: closeNode, window: w.window });
      if (winNode && w.art) art.windowMeshes.push(winNode);
      if (closeNode) {
        if (w.close === "CLOSEportfolio") art.closePortfolio = closeNode;
        else art.closeMeshes.push(closeNode);
      }
    }
  });
  // one showcase glow target per desktop window: 3 staggered highlight pulses.
  // pulseT is seeded to a fixed per-window offset so the windows ripple left to
  // right instead of flashing together; resetArt rewinds it on every entry.
  art.windows.forEach(function (w, i) {
    if (!w.node || !w.art) return;
    const meshes = collectTargetMeshes(w.node);
    if (!meshes.length) return;
    const t = makeGlowSet(meshes, "win:" + w.window);
    t.beaconMode = "count";
    t.beaconPulses = ART_WINDOW_PULSES;
    t.beaconPeriod = ART_WINDOW_PERIOD;
    t.pulseT = i * ART_WINDOW_STAGGER;
    t.windowRef = w;
    art.windowGlow.push(t);
  });
  resetArtShade();
  resetArtScreens();
  resetArtWindows();
  console.log("[art] glow targets:", art.targets.map(function (t) { return t.name; }).join(", "));
  console.log("[art] clickable meshes:", art.clickMeshes.map(function (o) { return o.name; }).join(", "));
  console.log("[art] windows:", art.windows.map(function (w) { return w.frame + ":" + w.nodes.map(function (o) { return o.name; }).join("+"); }).join(", "));
}

// enter the close-up loop 601..720 (idempotent: already interacted, stay put).
// Only possible at/after ART_INTERACT_AFTER so the intro plays uninterrupted;
// instead of snapping the camera to the loop start it eases to the entry
// target frame, then the normal ping-pong takes over (narrowing to 650..720).
function enterArtInteractive() {
  const s = scenes.ART;
  if (!s || !s.camNode || !s.posTrack || art.interacted) return;
  if (s.camT * CAM_FPS < ART_INTERACT_AFTER) return;
  const lc = SCENE_LOOP.ART;
  s.loopStart = lc.interactStart;
  s.loopEnd = lc.interactEnd;
  art.interacted = true;
  art.loopNarrowed = false;
  art.entering = {
    t: 0,
    dur: Math.max(0.001, ART_ENTER_SEC),
    from: s.camT,
    to: ART_ENTER_TARGET_FRAME / CAM_FPS,
  };
  s.dir = 1;
  console.log("[art] interactive: gliding to frame", ART_ENTER_TARGET_FRAME, "(loop frames", Math.round(lc.interactStart * CAM_FPS), "..", Math.round(lc.interactEnd * CAM_FPS) + ")");
}

// leave the close-up: an empty-space click drops the camera back onto the
// desk idle loop 342..600, starting from its first frame
function exitArtInteractive() {
  const s = scenes.ART;
  if (!s || !s.camNode || !s.posTrack || !art.interacted) return;
  const lc = SCENE_LOOP.ART;
  s.loopStart = lc.baseStart;
  s.loopEnd = lc.baseEnd;
  s.camT = lc.baseStart;
  s.dir = 1;
  art.interacted = false;
  art.entering = null;
  art.loopNarrowed = false;
  artPopupClear();
  console.log("[art] back to base loop frames", Math.round(lc.baseStart * CAM_FPS), "..", Math.round(lc.baseEnd * CAM_FPS));
}

// "remove" a desktop object (window / close): it stops rendering and is no
// longer raycast-able. The userData flag lets a fresh scene entry restore it.
function artRemoveObject(obj) {
  if (!obj) return;
  obj.visible = false;
  obj.userData.artRemoved = true;
}

// reveal a window entry: force the materials opaque (the GLB ships them at 0)
// and show the window node — but the CLOSE object stays INVISIBLE while
// remaining clickable (its "shown" flag only marks it present for hit testing).
function artShowWindow(w) {
  w.shown = true;
  w.nodes.forEach(function (o) {
    artSetShown(o, true);
    if (o === w.closeNode) o.visible = false;
  });
}

// project every vertex of `object` (and any child meshes) to screen px and
// return its true on-screen footprint [minX, minY, maxX, maxY], or null if
// nothing projects in front of the camera. This is the object's real
// silhouette — NOT its AABB — so the 50% hit inflation stays around the shape
// the user actually sees (a big tilted banner can't eat the whole desktop),
// and it works for the invisible CLOSE objects too (geometry + matrixWorld,
// independent of .visible).
// Screen-space bounding box of a (possibly invisible) object, used to hit-test
// the ART windows.
//
// VERTEX BUDGET. This used to project EVERY vertex, and one tap calls it for
// every window and every close button in the room — about 19 full passes. On a
// dense mesh that is millions of matrix multiplies for a single tap, which on
// a weak device is a multi-second freeze: the page looks crashed and the OS
// kills it. The result is only a rectangle that is then inflated 50% for
// hit-testing, so a bounded sample is indistinguishable in practice — a
// silhouette is thousands of vertices across. ART_FOOTPRINT_SAMPLES is a
// ceiling, not a stride: small meshes are still sampled exhaustively.
const ART_FOOTPRINT_SAMPLES = 512;

function artFootprint(object) {
  scene.updateMatrixWorld(true);
  let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
  let ok = false;
  const list = object.isMesh ? [object] : collectTargetMeshes(object);
  for (let i = 0; i < list.length; i++) {
    const geo = list[i].geometry;
    const pos = geo && geo.attributes.position;
    if (!pos) continue;
    const m = list[i].matrixWorld;
    // one sample every N vertices, so the pass is bounded however dense the
    // mesh is. Spread across the WHOLE index range so we still see the
    // silhouette rather than one corner of it.
    const step = Math.max(1, Math.ceil(pos.count / ART_FOOTPRINT_SAMPLES));
    for (let v = 0; v < pos.count; v += step) {
      _v4.set(pos.getX(v), pos.getY(v), pos.getZ(v)).applyMatrix4(m).project(camera);
      if (_v4.z > 1 || _v4.z < -1) continue;
      ok = true;
      const px = (_v4.x * 0.5 + 0.5) * window.innerWidth;
      const py = (-0.5 * _v4.y + 0.5) * window.innerHeight;
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
    }
  }
  return ok ? [minX, minY, maxX, maxY] : null;
}

// is the cursor inside the object's on-screen footprint inflated 50%?
function artObjectHit(object, clientX, clientY) {
  const f = artFootprint(object);
  if (!f) return false;
  const cx = (f[0] + f[2]) / 2;
  const cy = (f[1] + f[3]) / 2;
  const hw = (f[2] - f[0]) * (1 + ART_HIT_INFLATE) / 2;
  const hh = (f[3] - f[1]) * (1 + ART_HIT_INFLATE) / 2;
  return Math.abs(clientX - cx) <= hw && Math.abs(clientY - cy) <= hh;
}

// depth ordering proxy for overlapping candidates (the desktop is near-planar,
// so camera distance is monotonic): distance to the object's world center
function artObjectDist(object) {
  object.getWorldPosition(_v2);
  return _v2.distanceTo(camera.position);
}

function artFindWindowByClose(node) {
  for (let j = 0; j < art.windows.length; j++) {
    if (art.windows[j].closeNode === node) return art.windows[j];
  }
  return null;
}

function handleArtClick(e) {
  if (reacquire) return;
  // clicks on the artwork popups / modal are theirs, not the 3D world's
  if (artModal && artModal.classList.contains("open")) return;
  if (artPopupStage && artPopupStage.contains(e.target)) return;
  if (!art.interacted && scenes.ART.camT * CAM_FPS < ART_INTERACT_AFTER) return;
  screenRaycast(e.clientX, e.clientY);
  if (art.interacted) {
    // desktop click order: CLOSEportfolio > CLOSEx > WINDOWx, then empty space.
    // The laptop itself is not an interactable in interaction mode. Every class
    // is hit-tested through the same ART_HIT_INFLATE inflated on-screen
    // footprint, so the invisible CLOSE objects still register (nearest hit
    // within a class wins).
    // 1) CLOSEportfolio removes itself and closes the whole portfolio overlay
    const cpEntry = artFindWindowByClose(art.closePortfolio);
    if (art.closePortfolio && cpEntry && cpEntry.shown &&
        !art.closePortfolio.userData.artRemoved &&
        artObjectHit(art.closePortfolio, e.clientX, e.clientY)) {
      artRemoveObject(art.closePortfolio);
      artPopupClear();
      console.log("[art] CLOSEportfolio");
      return;
    }
    // 2) a CLOSEx removes itself + the window it is affixed to
    let closeBest = null;
    for (let j = 0; j < art.windows.length; j++) {
      const w = art.windows[j];
      if (!w.closeNode || w.closeNode === art.closePortfolio) continue;
      if (!w.shown || w.closeNode.userData.artRemoved) continue;
      if (!artObjectHit(w.closeNode, e.clientX, e.clientY)) continue;
      const d = artObjectDist(w.closeNode);
      if (!closeBest || d < closeBest.d) closeBest = { w: w, d: d };
    }
    if (closeBest) {
      artRemoveObject(closeBest.w.closeNode);
      if (closeBest.w.node) artRemoveObject(closeBest.w.node);
      console.log("[art] closed window", closeBest.w.window);
      return;
    }
    // 3) a WINDOW opens its artwork (modal + cascade) and is consumed
    let winBest = null;
    for (let j = 0; j < art.windows.length; j++) {
      const w = art.windows[j];
      if (!w.node || !w.art) continue;
      if (!w.shown || !w.node.visible || w.node.userData.artRemoved) continue;
      if (!artObjectHit(w.node, e.clientX, e.clientY)) continue;
      const d = artObjectDist(w.node);
      if (!winBest || d < winBest.d) winBest = { w: w, d: d };
    }
    if (winBest) {
      artRemoveObject(winBest.w.node);
      artPopupOpen(winBest.w.art);
      return;
    }
    // 4) empty space: back to the desk loop
    const hit = raycaster.intersectObjects(art.clickMeshes, false).length > 0;
    if (!hit) exitArtInteractive();
    return;
  }
  if (raycaster.intersectObjects(art.clickMeshes, false).length === 0) return;
  enterArtInteractive();
  console.log("[art] interaction");
}

// reset the ART visuals so a fresh entry plays the timeline from frame 0
function resetArtShade() {
  if (!art.shade) return;
  art.shade.removed = false;
  art.shade.meshes.forEach(function (o) { o.visible = true; });
  art.shade.mats.forEach(function (m) { m.opacity = 1; });
}

function resetArtScreens() {
  art.bootDone = false;
  if (art.loading) art.loading.visible = false;
  if (art.loaded) art.loaded.visible = false;
}

// all window + close elements are hidden until their reveal frame; also clear
// any "opened / closed" removal flags so a fresh entry restores the desktop
function resetArtWindows() {
  art.windows.forEach(function (w) {
    w.shown = false;
    w.nodes.forEach(function (o) { o.userData.artRemoved = false; o.visible = false; });
  });
}

function resetArt(s) {
  const lc = SCENE_LOOP.ART;
  s.loopStart = lc.baseStart;
  s.loopEnd = lc.baseEnd;
  s.camT = 0;
  s.dir = 1;
  art.interacted = false;
  art.entering = null;
  art.loopNarrowed = false;
  // entry clock: pure seconds-since-entry timer now (the timeline events are
  // driven off the CAMERA frames in updateArtTimeline, not this clock)
  art.clock = 0;
  s.mixers.forEach(function (m) {
    (m._actions || []).forEach(function (a) { a.reset(); });
    m.setTime(0);
  });
  resetArtShade();
  resetArtScreens();
  resetArtWindows();
  // re-arm the entry beacon so each visit re-highlights the laptop fresh
  art.targets.forEach(function (t) { t.pulseT = 0; t.hover = 0; });
  // rewind the per-window showcase so the 3 staggered pulses replay on entry
  art.windowGlow.forEach(function (t, i) { t.pulseT = i * ART_WINDOW_STAGGER; t.hover = 0; });
}

// show/hide one overlay mesh AND force its materials opaque. The GLB ships
// every screen/window/CLOSE at material opacity 0 (the author animated
// visibility, which glTF drops), so toggling .visible alone is NOT enough —
// the material must be forced to opacity 1 + transparent so it actually
// rasterizes. Materials are only mutated the first time a mesh is shown.
function artSetShown(mesh, on) {
  if (!mesh) return;
  mesh.visible = on;
  if (!on) return;
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  mats.forEach(function (m) {
    if (m.opacity !== undefined && m.opacity !== 1) m.opacity = 1;
    if (m.transparent !== true) {
      m.transparent = true;
      m.needsUpdate = true;
    }
  });
}

// dead-simple boot, driven off the camera frame (camT * CAM_FPS) since the
// camera starts at frame 0 when the room is entered: the laptopshade must
// come off so the screen is visible at all, then screenLOADING shows once 300
// frames have played and screenLOADED replaces it once 380 frames have played.
// Nothing else — no windows, no interaction gating.
function updateArtTimeline() {
  const s = scenes.ART;
  if (!s || !s.camNode) return;
  const frame = s.camT * CAM_FPS;
  if (art.shade) {
    if (frame >= ART_SHADE_FADE_END) {
      if (!art.shade.removed) {
        art.shade.removed = true;
        art.shade.meshes.forEach(function (o) { o.visible = false; });
        art.shade.mats.forEach(function (m) { m.opacity = 0; });
      }
    } else if (frame >= ART_SHADE_FADE_START) {
      const t = (frame - ART_SHADE_FADE_START) / (ART_SHADE_FADE_END - ART_SHADE_FADE_START);
      const e = t * t * (3 - 2 * t);
      art.shade.mats.forEach(function (m) { m.opacity = 1 - e; });
    }
  }
  if (art.loading) {
    const on = frame >= 300 && frame < 380;
    if (art.loading.visible !== on) artSetShown(art.loading, on);
  }
  if (art.loaded) {
    const on = frame >= 380;
    if (art.loaded.visible !== on) artSetShown(art.loaded, on);
  }
  // windows + CLOSE elements reveal as soon as interaction begins (the
  // close-up loop 601..719), each popping in at its own delay frame. They use
  // artSetShown like the screens, because the GLB ships them at opacity 0.
  // CLOSE objects are then hidden again — invisible but still interactable.
  art.windows.forEach(function (w) {
    if (art.interacted && frame >= w.frame && !w.shown) artShowWindow(w);
  });
}

// DEBUG: force every ART overlay visible (shade removed, desktop + windows
// shown) so it is possible to SEE whether the windows/screens are real and
// sitting on the laptop. `updateArtTimeline` is disabled while this is on.
function artForceShow(on) {
  art.debugShow = !!on;
  const s = scenes.ART;
  if (!s || !s.root) return art.debugShow;
  if (on) {
    if (art.shade) {
      art.shade.removed = true;
      art.shade.meshes.forEach(function (o) { o.visible = false; });
      art.shade.mats.forEach(function (m) { m.opacity = 0; });
    }
    if (art.loading) artSetShown(art.loading, false);
    if (art.loaded) artSetShown(art.loaded, true);
    art.bootDone = true;
    art.windows.forEach(function (w) { artShowWindow(w); });
  } else {
    art.bootDone = false;
  resetArtShade();
  resetArtScreens();
  resetArtWindows();
  artPopupClear();
}
  return art.debugShow;
}

// DEBUG: full inventory of every ART mesh (transform, world bounds, geometry
// size, material) so we can see where each overlay actually is / whether it
// has any geometry at all.
function artDump() {
  const s = scenes.ART;
  if (!s || !s.root) return { error: "no ART root" };
  s.root.updateMatrixWorld(true);
  const box = new THREE.Box3();
  const out = [];
  s.root.traverse(function (o) {
    if (!o.isMesh) return;
    box.setFromObject(o);
    const size = new THREE.Vector3(); box.getSize(size);
    const center = new THREE.Vector3(); box.getCenter(center);
    let verts = 0;
    if (o.geometry && o.geometry.attributes && o.geometry.attributes.position) verts = o.geometry.attributes.position.count;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    out.push({
      name: o.name,
      parent: o.parent ? o.parent.name : null,
      vis: o.visible,
      pos: [ +o.position.x.toFixed(3), +o.position.y.toFixed(3), +o.position.z.toFixed(3) ],
      scale: [ +o.scale.x.toFixed(3), +o.scale.y.toFixed(3), +o.scale.z.toFixed(3) ],
      size: [ +size.x.toFixed(4), +size.y.toFixed(4), +size.z.toFixed(4) ],
      center: [ +center.x.toFixed(3), +center.y.toFixed(3), +center.z.toFixed(3) ],
      verts: verts,
      mat: mats.map(function (m) { return m.name + ":" + m.type; }).join("|"),
      opacity: mats.map(function (m) { return m.opacity; }).join("|"),
      emissiveI: mats.map(function (m) { return m.emissiveIntensity; }).join("|"),
      transparent: mats.some(function (m) { return m.transparent; }),
      map: mats.some(function (m) { return !!(m.map && m.map.isTexture); }),
    });
  });
  return out;
}

function updateArtGlow(dt) {
  if (!art.clickMeshes.length) return;
  // not clickable before frame 330 — no hover glow / beacon either
  if (scenes.ART.camT * CAM_FPS < ART_INTERACT_AFTER) return;
  // in interaction mode the laptop itself is no longer an interactable: the
  // desktop windows are the targets, so don't highlight the laptop
  if (art.interacted) return;
  pointer.set(mouseX, -mouseY);
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(art.clickMeshes, false);
  let hovered = null;
  if (hits.length) {
    for (let i = 0; i < art.targets.length; i++) {
      if (art.targets[i].meshes.indexOf(hits[0].object) !== -1) { hovered = art.targets[i]; break; }
    }
  }
  const name = hovered ? hovered.name : null;
  if (name !== art.hoverTarget) {
    art.hoverTarget = name;
    console.log("[art] hover:", name ? name : "none");
  }
  art.targets.forEach(function (t) {
    easeHover(t, t === hovered);
    applyTargetGlow(t, dt);
  });
}

// showcase: the desktop windows pulse ART_WINDOW_PULSES times each, staggered
// per window (see setupArt), so a first-time visitor sees them ripple as
// "clickable". A window's target only advances while it is revealed and has
// not been clicked/removed; resetArt rewinds the count on every scene entry.
function updateArtWindowGlow(dt) {
  if (!art.interacted || !art.windowGlow.length) return;
  art.windowGlow.forEach(function (t) {
    const w = t.windowRef;
    if (!w || !w.shown || (w.node && w.node.userData.artRemoved)) return;
    applyTargetGlow(t, dt);
  });
}

function updateArt(dt) {
  const s = scenes.ART;
  art.clock += dt;
  // once the interactive loop first reaches its end (720), narrow it to
  // 650..720 so the deep zoom only plays during the entry glide
  if (art.interacted && !art.loopNarrowed && s.camT >= s.loopEnd) {
    const lc = SCENE_LOOP.ART;
    s.loopStart = lc.interactBounceStart;
    art.loopNarrowed = true;
    console.log("[art] loop narrowed to frames", Math.round(s.loopStart * CAM_FPS), "..", Math.round(s.loopEnd * CAM_FPS));
  }
  updateArtTimeline();
  updateArtGlow(dt);
  updateArtWindowGlow(dt);
}


/* ------------------------------------------------------------------ */
/*  ART popup overlay: click a desktop window -> artwork modal, then   */
/*  the rest of the portfolio cascades in as draggable/closable        */
/*  popups floating over the 3D world. Opening an art never closes the */
/*  popups already open. The modal browses every piece in the          */
/*  portfolio (media/artwork/*.webp only): swipe left/right, arrow     */
/*  keys, or the two bottom-center arrows.                             */
/* ------------------------------------------------------------------ */

// every piece in the portfolio (matches media/artwork/*.webp). Clicked art is
// shown in the modal first; the cascade shows the REST of these.
const ART_POPUP_ART = [
  "angel", "bonzi", "china", "daggers", "dnd", "drg", "elephant", "engi",
  "forro", "ghosts", "indios", "linda", "mgs", "mickey", "moto", "mural",
  "WEIWEI", "samurai", "selknam", "tarako", "tesla", "toribash", "toris",
  "venequidad", "yeule",
];

// titles / subtitles / descriptions as authored on the portfolio page
const artworkDefinitions = {
  angel: { title: "ANGEL", subtitle: "Digital commission for Tristan", description: "2022" },
  bonzi: { title: "BONZI", subtitle: '21cm x 14.8cm [8.27" x 5.8"]', description: "November 2023" },
  china: { title: "CH#1", subtitle: '14.8cm x 10.5cm [5.83" x 4.13"]', description: "December 2021" },
  daggers: { title: "DAGGERS", subtitle: '21.6cm x 27.9cm [8.5"x11"]', description: "Tattoo concept, April 2023" },
  dnd: { title: "THE END OF IT ALL", subtitle: "Digital commission for Hal", description: "2022" },
  drg: { title: "MISSION CONTROLLED", subtitle: "Digital commission for Confixil", description: "2023" },
  elephant: { title: "POOKIEPHANT", subtitle: '30cm x 21.6cm [11" x 8"]', description: "September 2022" },
  engi: { title: "ENGINEER", subtitle: "Digital commission for Hal", description: "2021" },
  forro: { title: "CASE", subtitle: '15.8cm x 7.4cm [6.5"x3"]', description: "April 2022" },
  ghosts: { title: "GHOSTS", subtitle: "Digital commission for Cragma", description: "June 2026" },
  indios: { title: "INDIOS", subtitle: '30cm x 21.6cm [11" x 8"]', description: "January 2025" },
  linda: { title: "LINDA EVANGELISTA", subtitle: '15.8cm x 7.4cm [6.5"x3"]', description: "December 2021" },
  mgs: { title: "MGS", subtitle: '2m x 4m [6\'6" x 13\' 1"]', description: "November 2024" },
  mickey: { title: "MICKEY", subtitle: '14.8cm x 10.5cm [5.83" x 4.13"]', description: "2020" },
  moto: { title: "MOTO", subtitle: '30cm x 21.6cm [11" x 8"]', description: "September 2022" },
  mural: { title: "HAVEN", subtitle: '2m x 4.5m [6\'6" x 14\'9"]', description: "April 2022" },
  WEIWEI: { title: "WEIWEI", subtitle: "27.9cm x 21.6cm [11' x 8.5']", description: "November 2023" },
  samurai: { title: "MINAMOTO", subtitle: "Digital commission for Hal", description: "2021" },
  selknam: { title: "SELKNAM", subtitle: '21cm x 14.8cm [8.27" x 5.8"]', description: "February 2022" },
  tarako: { title: "TARAKO", subtitle: '45cm x 71cm [18" x 28"]', description: "March 2026" },
  tesla: { title: "NIKOLA", subtitle: '14.8cm x 10.5cm [5.83" x 4.13"]', description: "December 2021" },
  toribash: { title: "TORIBASH", subtitle: '2m x 5.5m [6\'6" x 18\']', description: "June 2024" },
  toris: { title: "TB WORLD CHAMPIONSHIP", subtitle: "Digital", description: "2022" },
  venequidad: { title: "VENEQUIDAD", subtitle: '21.6cm x 27.9cm [8.5"x11"]', description: "January 2025" },
  yeule: { title: "YEULE", subtitle: '21cm x 14.8cm [8.27" x 5.8"]', description: "January 2022" },
};

// Spanish treatment for the ART metadata: months, commission links, misc UI
// text — never the artwork titles themselves.
const ART_MONTHS_ES = {
  January: "Enero", February: "Febrero", March: "Marzo", April: "Abril",
  May: "Mayo", June: "Junio", July: "Julio", August: "Agosto",
  September: "Septiembre", October: "Octubre", November: "Noviembre",
  December: "Diciembre",
};

function artLangES() {
  return (typeof window !== "undefined" && window.__PORTFOLIO_LANG__) !== "en";
}

function artTranslate(s) {
  if (!s || !artLangES()) return s;
  let out = String(s);
  if (/^Digital commission for /i.test(out)) {
    out = "Comisi\u00f3n digital para " + out.replace(/^Digital commission for /i, "");
  } else if (/^Digital$/i.test(out)) {
    out = "Digital";
  }
  out = out.replace("Tattoo concept", "Idea para tatuaje");
  Object.keys(ART_MONTHS_ES).forEach(function (m) {
    out = out.split(m).join(ART_MONTHS_ES[m]);
  });
  return out;
}

const artPopupStage = document.getElementById("art-popup-stage");
const artModal = document.getElementById("art-modal");
const artModalCard = artModal ? artModal.querySelector(".art-modal-window") : null;
const artNav = document.getElementById("art-nav");
const artNavPrev = artNav ? artNav.querySelector(".art-modal-prev") : null;
const artNavNext = artNav ? artNav.querySelector(".art-modal-next") : null;

const artPopup = {
  active: false,
  pending: [],
  timer: null,
  current: null,     // { name, index } shown in the modal
  topmost: null,
  justSwiped: false, // a swipe just happened -> suppress the click that follows
  z: 40,
};

function artPrettyTitle(name) {
  return String(name).replace(/[_-]/g, " ").toUpperCase();
}

// How far a popup may hang off the side of the screen. On a wide desktop the
// windows are allowed to scatter half off the edge (a cluttered-desktop look);
// on a narrow / portrait screen they are held fully on screen instead, because
// a phone has no spare width to lose and a thumb cannot easily drag a window
// back into view once it has started off it.
const POPUP_SLACK_WIDE = 160;
const POPUP_SLACK_NARROW = 12;
const POPUP_NARROW_W = 720;

function artPopupSlack() {
  return window.innerWidth <= POPUP_NARROW_W ? POPUP_SLACK_NARROW : POPUP_SLACK_WIDE;
}

function artPopupClamp(el, x, y) {
  const slack = artPopupSlack();
  const minX = -slack;
  const minY = 16;
  const maxX = Math.max(minX, window.innerWidth - el.offsetWidth + slack);
  const maxY = Math.max(minY, window.innerHeight - el.offsetHeight);
  el.style.left = (Math.min(maxX, Math.max(minX, x))) + "px";
  el.style.top = (Math.min(maxY, Math.max(minY, y))) + "px";
}

function artPopupRandomPos() {
  const pad = 24;
  // the -240 gives a 320px popup room to wander on a big screen; on a narrow
  // one there is nowhere to wander to, and artPopupClamp pins it anyway
  const w = Math.max(220, window.innerWidth - pad * 2 - 240);
  const h = Math.max(200, window.innerHeight - pad * 2 - 240);
  return {
    x: pad + Math.random() * w,
    y: pad + Math.random() * h,
  };
}

// render the modal media + info for one artwork (also swaps it in place when
// browsing). Every piece gets the site footer line.
function artModalRender(name, index) {
  const def = artworkDefinitions[name] || null;
  const media = artModal.querySelector(".art-modal-media");
  const info = artModal.querySelector(".art-modal-info");
  media.innerHTML = "";
  info.innerHTML = "";

  const img = document.createElement("img");
  img.src = "media/artwork/" + name + ".webp";
  img.alt = name;
  media.appendChild(img);

  const title = document.createElement("h2");
  title.textContent = (def && def.title) ? def.title : artPrettyTitle(name);
  info.appendChild(title);

  if (def && def.subtitle) {
    const sub = document.createElement("p");
    sub.style.marginTop = "0.5rem";
    sub.style.fontWeight = "700";
    sub.textContent = artTranslate(def.subtitle);
    info.appendChild(sub);
  }

  const desc = document.createElement("p");
  desc.style.marginTop = "0.6rem";
  desc.textContent = artTranslate((def && def.description) ||
    (artLangES()
      ? "Una ventana privada para ver la obra seleccionada. La imagen se presenta aqu\u00ed completa, con el t\u00edtulo y contexto a la derecha."
      : "A private viewing window for the selected work. The image is presented here in full, with the accompanying title and context to the right."));
  info.appendChild(desc);

  const foot = document.createElement("p");
  foot.className = "art-modal-portfolio";
  const link = document.createElement("a");
  link.href = ART_PORTFOLIO_URL;
  link.target = "_blank";
  link.rel = "noopener";
  link.textContent = "alejandroenrique.com";
  foot.appendChild(document.createTextNode(artLangES()
    ? "Portafolio de arte digital y tradicional en "
    : "Digital and traditional art portfolio at "));
  foot.appendChild(link);
  info.appendChild(foot);

  const hint = document.createElement("span");
  hint.className = "art-modal-hint";
  hint.textContent = artLangES()
    ? "click fuera para cerrar Â· desliza / flechas para navegar"
    : "click outside to close Â· swipe / arrows to browse";
  info.appendChild(hint);

  artPopup.current = { name: name, index: index };
}

function artModalOpen(name) {
  if (!artModal) return;
  const idx = ART_POPUP_ART.indexOf(name);
  artModalRender(name, idx < 0 ? 0 : idx);
  artModal.classList.add("open");
  document.body.classList.add("popup-open");
  if (artNav) artNav.classList.add("open");
  flashArtArrows();
}

function artModalClose() {
  if (!artModal) return;
  artPopup.current = null;
  artModal.classList.remove("open");
  document.body.classList.remove("popup-open");
  if (artNav) artNav.classList.remove("open");
}

// browse the portfolio from the currently shown artwork
function artModalGo(delta) {
  if (!artPopup.current || !ART_POPUP_ART.length) return;
  const n = ART_POPUP_ART.length;
  let i = (artPopup.current.index + delta) % n;
  if (i < 0) i += n;
  artModalRender(ART_POPUP_ART[i], i);
}

function artPopupCreate(name) {
  if (!artPopupStage) return;

  const el = document.createElement("article");
  el.className = "art-popup";
  el.tabIndex = 0;
  el.style.zIndex = String(artPopup.z);

  const closeBtn = document.createElement("button");
  closeBtn.className = "art-popup-close";
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "Close artwork");
  closeBtn.textContent = "\u00d7";

  const img = document.createElement("img");
  img.src = "media/artwork/" + name + ".webp";
  img.alt = name;
  img.loading = "lazy";
  img.draggable = false;
  img.addEventListener("dragstart", function (e) { e.preventDefault(); });
  img.addEventListener("load", function () {
    el.classList.toggle("portrait", img.naturalHeight > img.naturalWidth);
    el.classList.toggle("landscape", img.naturalHeight <= img.naturalWidth);
    artPopupClamp(el, parseFloat(el.style.left) || 24, parseFloat(el.style.top) || 24);
  });

  const label = document.createElement("span");
  label.className = "art-popup-label";
  label.textContent = artPrettyTitle(name);

  el.appendChild(closeBtn);
  el.appendChild(img);
  el.appendChild(label);
  el.addEventListener("dragstart", function (e) { e.preventDefault(); });
  artPopupStage.appendChild(el);

  const pos = artPopupRandomPos();
  artPopupClamp(el, pos.x, pos.y);
  artPopup.topmost = el;
  artPopup.z += 1;

  el.addEventListener("click", function () {
    if (el.dataset.dragged === "true") { el.dataset.dragged = "false"; return; }
    artModalOpen(name);
  });

  closeBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    el.remove();
    if (artPopup.topmost === el) artPopup.topmost = null;
  });

  let dragging = false;
  let dx = 0;
  let dy = 0;
  let sx = 0;
  let sy = 0;

  el.addEventListener("pointerdown", function (e) {
    if (e.target === closeBtn) return;
    e.preventDefault();
    dragging = true;
    el.dataset.dragged = "false";
    el.classList.add("dragging");
    el.style.transition = "none";
    const rect = el.getBoundingClientRect();
    dx = e.clientX - rect.left;
    dy = e.clientY - rect.top;
    sx = e.clientX;
    sy = e.clientY;
    artPopup.z += 1;
    el.style.zIndex = String(artPopup.z);
    try { el.setPointerCapture(e.pointerId); } catch (err) { /* synthetic events */ }
  });

  el.addEventListener("pointermove", function (e) {
    if (!dragging) return;
    e.preventDefault();
    if (Math.abs(e.clientX - sx) > 4 || Math.abs(e.clientY - sy) > 4) el.dataset.dragged = "true";
    artPopupClamp(el, e.clientX - dx, e.clientY - dy);
  });

  function endDrag() {
    if (!dragging) return;
    dragging = false;
    el.classList.remove("dragging");
    el.style.transition = "left 0.18s ease-out, top 0.18s ease-out";
  }
  el.addEventListener("pointerup", endDrag);
  el.addEventListener("pointercancel", endDrag);
}

// the public entry point: clicking a desktop window calls this. The first call
// starts the cascade; opening another art afterwards only swaps the modal and
// never closes the popups already on screen.
function artPopupOpen(name) {
  console.log("[art] popup open:", name);
  if (!artPopup.active) {
    artPopup.active = true;
    const rest = ART_POPUP_ART.slice();
    const x = rest.indexOf(name);
    if (x !== -1) rest.splice(x, 1); // the clicked piece lives in the modal
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = rest[i]; rest[i] = rest[j]; rest[j] = tmp;
    }
    artPopup.pending = rest;
    if (ART_POPUP_INTERVAL > 0) {
      artPopup.timer = window.setInterval(function () {
        if (!artPopup.active || !artPopup.pending.length) return;
        artPopupCreate(artPopup.pending.shift());
      }, ART_POPUP_INTERVAL);
    }
  }
  artModalOpen(name);
}

function artPopupClear() {
  artPopup.active = false;
  if (artPopup.timer) { window.clearInterval(artPopup.timer); artPopup.timer = null; }
  artPopup.pending = [];
  artPopup.topmost = null;
  artPopup.justSwiped = false;
  artModalClose();
  if (artPopupStage) {
    const kids = artPopupStage.querySelectorAll(".art-popup");
    for (let i = 0; i < kids.length; i++) kids[i].remove();
  }
}

// keyboard: ESC closes the modal first, then the newest popup; arrow keys
// browse the portfolio while the modal is open
document.addEventListener("keydown", function (e) {
  if (!artPopup.active) return;
  if (artPopup.current) {
    if (e.key === "ArrowLeft") { e.preventDefault(); artModalGo(-1); return; }
    if (e.key === "ArrowRight") { e.preventDefault(); artModalGo(1); return; }
  }
  if (e.key !== "Escape") return;
  if (artPopup.current) { artModalClose(); return; }
  if (artPopup.topmost && artPopup.topmost.isConnected) {
    artPopup.topmost.remove();
    artPopup.topmost = null;
  }
});

// browse arrows (fixed bottom-center, above the modal — same look as the
// TORIS scene arrows)
if (artNavPrev) artNavPrev.addEventListener("click", function () { artModalGo(-1); });
if (artNavNext) artNavNext.addEventListener("click", function () { artModalGo(1); });

// swipe left/right on the modal card to browse artworks
if (artModalCard) {
  let swiping = false;
  let sx = 0;
  let sy = 0;
  artModalCard.addEventListener("pointerdown", function (e) {
    if (e.target.closest(".art-modal-close, .art-modal-prev, .art-modal-next")) return;
    swiping = true;
    sx = e.clientX;
    sy = e.clientY;
    try { artModalCard.setPointerCapture(e.pointerId); } catch (err) { /* synthetic events */ }
  });
  artModalCard.addEventListener("pointermove", function (e) {
    if (!swiping) return;
    const dx = e.clientX - sx;
    const dy = e.clientY - sy;
    if (Math.abs(dx) >= ART_POPUP_SWIPE_PX && Math.abs(dx) > Math.abs(dy)) {
      artModalGo(dx < 0 ? 1 : -1);
      artPopup.justSwiped = true;
      swiping = false;
    }
  });
  function endSwipe() { swiping = false; }
  artModalCard.addEventListener("pointerup", endSwipe);
  artModalCard.addEventListener("pointercancel", endSwipe);
}

// closing the modal via its × / clicking the backdrop. stopPropagation keeps
// the click from reaching the 3D world handler (which would ALSO exit the
// interactive loop + clear the popup cascade on the same click). A swipe that
// just happened leaves a phantom click behind -> swallow it.
if (artModal) {
  artModal.addEventListener("click", function (e) {
    e.stopPropagation();
    if (artPopup.justSwiped) { artPopup.justSwiped = false; return; }
    if (e.target === artModal || e.target.classList.contains("art-modal-close")) artModalClose();
  });
}



/* ------------------------------------------------------------------ */
/*  CLOTHES: linked garments (open GACETAOFFICIAL.COM) + dynamic tex   */
/* ------------------------------------------------------------------ */

// Three garments in CLOTHES open the external site in a new tab when clicked:
// GORRA (a plain mesh) and GORRA2 / CLOTHES (skinned garments on the figure).
// The same meshes are the target for dynamic texture injection: injectTexture
// swaps a live texture onto them (UVs are generated if the mesh shipped
// without any), keeping the original map around so it can be restored.
//
// www is REQUIRED, not cosmetic: the apex (gacetaofficial.com) answers 522 -
// origin unreachable - while www.gacetaofficial.com answers 200 in half a
// second. Linking the apex sends visitors to a dead host.
const OBJECT_LINKS = {
  CLOTHES: { url: "https://www.gacetaofficial.com", names: ["GORRA", "GORRA2", "CLOTHES"] },
};
// the walking figure itself ("the armature") is also clickable; it gets 2
// beacon pulses on scene entry and never highlights on hover
const CLOTHES_FIGURE_RE = /^body\.002$/;
const CLOTHES_FIGURE_PULSES = 2;    // armature beacon pulses per scene entry
const GORRA_BEACON_PERIOD = 2.6;    // GORRA's repeating beacon: every couple of seconds
const linkedMeshes = [];
const plainLinked = [];   // non-skinned linked meshes: raycast-exact (e.g. GORRA)
const skinnedLinked = []; // skinned garments (GORRA2/CLOTHES/body): raycast misses their pose, so they're hit-tested via skinned-vertex projection instead
let clothesTargets = [];  // per-part CLOTHES glow targets (see setupObjectLinks)
let clothesFigureSet = null; // the armature target: reset its beacon on scene entry

function setupObjectLinks(gltf) {
  const cfg = OBJECT_LINKS.CLOTHES;
  const wanted = {};
  gltf.scene.traverse(function (o) {
    if (!o.isMesh) return;
    if (cfg.names.indexOf(o.name) !== -1) wanted[o.name] = o;
    else if (CLOTHES_FIGURE_RE.test(o.name)) wanted[o.name] = o;
  });

  // clickable set: the three named garments PLUS the walking figure (the
  // "armature", body.002). GORRA (static cap) is raycast-exact; the skinned
  // GORRA2 / CLOTHES / body are matched by skinned-vertex projection (see
  // pickLinkedMesh / skinnedMeshNear) so they track where the figure actually
  // is as it walks.
  linkedMeshes.length = 0;
  Object.keys(wanted).forEach(function (k) { linkedMeshes.push(wanted[k]); });
  plainLinked.length = 0;
  skinnedLinked.length = 0;
  linkedMeshes.forEach(function (o) {
    if (o.isSkinnedMesh) skinnedLinked.push(o);
    else plainLinked.push(o);
  });

  // depth stabilization on the clickable meshes: keep the cap/shirt/body from
  // z-fighting as the figure moves (same trick as the decals)
  linkedMeshes.forEach(function (o) {
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    mats.forEach(function (m) {
      if (!m) return;
      m.polygonOffset = true;
      m.polygonOffsetFactor = -1;
      m.polygonOffsetUnits = -2;
      m.needsUpdate = true;
    });
  });

  // per-part glow: GORRA repeats its beacon every couple of seconds, the
  // armature fires exactly CLOTHES_FIGURE_PULSES on each entry, and the
  // GORRA2 / CLOTHES garments are hover-only
  clothesTargets = [];
  clothesFigureSet = null;
  if (wanted.GORRA) {
    const t = makeGlowSet([wanted.GORRA], "gorra");
    t.beaconMode = "repeat";
    t.beaconPeriod = GORRA_BEACON_PERIOD;
    clothesTargets.push(t);
  }
  const hoverGarments = [];
  if (wanted.GORRA2) hoverGarments.push(wanted.GORRA2);
  if (wanted.CLOTHES) hoverGarments.push(wanted.CLOTHES);
  if (hoverGarments.length) {
    const t = makeGlowSet(hoverGarments, "garments");
    t.beaconMode = "off";
    clothesTargets.push(t);
  }
  let figure = null;
  Object.keys(wanted).forEach(function (k) {
    if (CLOTHES_FIGURE_RE.test(k)) figure = wanted[k];
  });
  if (figure) {
    const t = makeGlowSet([figure], "figure");
    t.beaconMode = "count";
    t.beaconPulses = CLOTHES_FIGURE_PULSES;
    t.hoverEnabled = false;
    clothesFigureSet = t;
    clothesTargets.push(t);
  }
  console.log("[link] CLOTHES clickable:", linkedMeshes.map(function (o) { return o.name; }).join(", "));
}

// fresh highlight on every CLOTHES entry: the armature's 2 beacon pulses start
// over from zero, and any lingering hover glow is cleared
function resetClothesGlow() {
  clothesTargets.forEach(function (t) {
    t.hover = 0;
    if (t.beaconMode === "count") t.pulseT = 0;
  });
}

// current world point of a linked garment, INCLUDING skinning. A skinned
// mesh's own matrixWorld is its bind pose (the skeleton moves the vertices),
// so the raycast and the naive getWorldPosition both miss GORRA2 / CLOTHES as
// the figure walks. Skin one representative vertex (the one nearest the local
// bounding-box centre) with the bone matrices to get where the garment really
// is right now. Plain meshes (GORRA) just return their world position.
const _bm = new THREE.Matrix4();
const _bv = new THREE.Vector3();
const _bacc = new THREE.Vector3();
// skin one local vertex exactly like the vertex shader: local vertex ->
// bindMatrixInverse -> per-bone (matrixWorld * boneInverse) -> bindMatrix ->
// object matrixWorld. Reads ALL FOUR joint influences (skinIndex/skinWeight
// are VEC4 in glTF) — reading only the first component was the bug that made
// the skinned GORRA2 / CLOTHES / body untouchable.
function skinLocalPoint(mesh, index, target) {
  const geo = mesh.geometry;
  const pos = geo.attributes.position;
  const sk = mesh.skeleton;
  const bones = sk.bones, inv = sk.boneInverses;
  _bacc.set(0, 0, 0);
  for (let b = 0; b < 4; b++) {
    const bi = geo.attributes.skinIndex.getComponent(index, b);
    const w = geo.attributes.skinWeight.getComponent(index, b);
    if (bi >= 0 && bi < bones.length && w > 0) {
      _bm.multiplyMatrices(bones[bi].matrixWorld, inv[bi]);
      _bacc.add(_bv.set(pos.getX(index), pos.getY(index), pos.getZ(index)).applyMatrix4(_bm).multiplyScalar(w));
    }
  }
  if (mesh.bindMatrix) _bacc.applyMatrix4(mesh.bindMatrix);
  _bacc.applyMatrix4(mesh.matrixWorld);
  target.copy(_bacc);
  return target;
}
function garmentWorldPoint(mesh, target) {
  target.set(0, 0, 0);
  if (!mesh.isSkinnedMesh || !mesh.geometry.attributes.skinIndex || !mesh.geometry.attributes.skinWeight) {
    mesh.getWorldPosition(target);
    return target;
  }
  const geo = mesh.geometry;
  const pos = geo.attributes.position;
  if (!geo.boundingBox) geo.computeBoundingBox();
  const c = geo.boundingBox.getCenter(_bv);
  let bestI = 0;
  let bestD = Infinity;
  for (let i = 0; i < pos.count; i++) {
    const dx = pos.getX(i) - c.x, dy = pos.getY(i) - c.y, dz = pos.getZ(i) - c.z;
    const d = dx * dx + dy * dy + dz * dz;
    if (d < bestD) { bestD = d; bestI = i; }
  }
  return skinLocalPoint(mesh, bestI, target);
}

// CLOTHES skylights: the "skylights" plane is the one that reads as the light
// source (the separate "sky" material is just its backdrop). Give the
// skylights glass a VERY noticeable BRIGHT EMISSION ANIMATION: a hard flare
// that pops up to ~11 and then decays SLOWLY over the rest of the cycle, so
// the light visibly throbs. The "sky" material stays at its authored level.
const skylight = { mat: null, mesh: null, base: 0, t: 0, ready: false, flash: 0, dark: 0 };
const SKYLIGHT_PULSE_BASE = 2.0;   // resting emission after the flare decays
const SKYLIGHT_PULSE_PEAK = 9.0;   // extra emission on top of base (~11 total)
const SKYLIGHT_PULSE_PERIOD = 4.5; // seconds per flare cycle
const SKYLIGHT_PULSE_RISE = 0.08;  // fraction of the cycle spent flaring up

function setupSkylightPulse(gltf) {
  if (!gltf || !gltf.scene) return;
  gltf.scene.traverse(function (o) {
    if (skylight.mesh || !o.isMesh || o.name !== "skylights") return;
    const orig = Array.isArray(o.material) ? o.material[0] : o.material;
    const mat = new THREE.MeshStandardMaterial({
      name: "skylights",
      map: orig.map || null,
      emissiveMap: orig.map || null,
      emissive: new THREE.Color(1, 1, 1),
      transparent: !!orig.transparent,
      depthWrite: !!orig.depthWrite,
      // double-sided + no tone mapping so the flare is clearly visible from
      // either side and high intensities aren't clamped to "white" (a 2 vs 11
      // swing is obvious instead of both reading as pure white)
      side: THREE.DoubleSide,
      toneMapped: false,
      alphaTest: orig.alphaTest || 0,
    });
    mat.userData.unlit = true; // never re-converted by makeUnlit (already basic)
    skylight.mat = mat;
    skylight.mesh = o;
    if (Array.isArray(o.material)) o.material[0] = mat; else o.material = mat;
    skylight.base = SKYLIGHT_PULSE_BASE;
    skylight.ready = true;
  });
  if (skylight.ready) console.log("[sky] skylights material -> bright flare + slow decay (SKY material untouched)");
}

function stepSkylightPulse(dt) {
  if (!skylight.ready || !scenes.CLOTHES.root || !skylight.mat) return;
  if (skylight.flash > 0) {
    skylight.flash -= dt;
    skylight.mat.emissiveIntensity = 100; // debug: prove the path works
    if (skylight.flash <= 0) skylight.dark = 0.4; // then slam to 0
    return;
  }
  if (skylight.dark > 0) {
    skylight.dark -= dt;
    skylight.mat.emissiveIntensity = 0;
    return;
  }
  skylight.t += dt;
  const p = skylight.t % SKYLIGHT_PULSE_PERIOD;
  const riseEnd = SKYLIGHT_PULSE_RISE * SKYLIGHT_PULSE_PERIOD;
  let k;
  if (p < riseEnd) {
    k = p / riseEnd; // quick ramp 0..1
  } else {
    k = Math.exp(-(p - riseEnd) / (SKYLIGHT_PULSE_PERIOD * 0.55)); // slow decay
  }
  skylight.mat.emissiveIntensity = skylight.base + SKYLIGHT_PULSE_PEAK * k;
}

// debug: flash the skylight to 100 then 0 quickly to prove the emission path
function flashSkylight() {
  if (!skylight.ready) return false;
  skylight.flash = 0.5;
  skylight.dark = 0;
  console.log("[sky] debug flash 100 -> 0");
  return true;
}

// scaffolding for dynamic texture injection on the linked garments: hand a
// live texture (canvas / atlas) to the meshes matching `pattern`. Returns how
// many materials were patched.
function injectTexture(pattern, tex) {
  if (!scenes.CLOTHES.root || !tex) return 0;
  const re = new RegExp(pattern);
  let n = 0;
  scenes.CLOTHES.root.traverse(function (o) {
    if (!o.isMesh || !re.test(o.name)) return;
    ensureUVs(o);
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    mats.forEach(function (m) {
      if (m.userData._injected === m) return;
      if (m.map && m.map.isTexture && !m.userData._origMap) m.userData._origMap = m.map;
      m.userData._injected = m;
      m.map = tex;
      m.needsUpdate = true;
      n++;
    });
  });
  return n;
}

/* ------------------------------------------------------------------ */
/*  horror flicker (flaky failing light)                               */
/* ------------------------------------------------------------------ */

// every emissive material flickers UNIFORMLY off one broken-light signal
// (walls, murals, the dim set and ATM1 all at the same depth); only STATIC
// meshes (HTML / OVERLAY) are untouched. The BUS is collected separately so
// it can flicker a little softer than the rest (it's further away).
const horror = { full: [], half: [], atm: [], bus: [], t: 0, until: 0, level: 1, inDip: false, inBlip: false, ready: false };

function collectHorror(gltf) {
  const seen = new Set();
  gltf.scene.traverse(function (o) {
    if (!o.isMesh) return;
    if (MENU_NAMES.indexOf(o.name) !== -1) return;
    if (/^FLIES/.test(o.name)) return;
    if (STATIC_MESH.test(o.name)) return;
    const isAtm = ATM_MESH.test(o.name);
    const isBus = BUS_MESH.test(o.name);
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    mats.forEach(function (m) {
      if (seen.has(m)) return;
      seen.add(m);
      const base = m.emissiveIntensity !== undefined ? m.emissiveIntensity : 0;
      const entry = { m: m, base: base > 0 ? base : 1 };
      if (/WALL|MURAL/.test(m.name)) horror.full.push(entry);
      else if (isBus) horror.bus.push(entry);
      else if (isAtm) horror.atm.push(entry);
      else if (m.emissiveMap || (m.emissive && (m.emissive.r + m.emissive.g + m.emissive.b) > 0)) {
        horror.half.push(entry);
      }
    });
  });
  horror.ready = horror.full.length + horror.half.length + horror.atm.length + horror.bus.length > 0;
  if (horror.ready) {
    console.log("[horror]", horror.full.length, "wall/mural,", horror.half.length, "dim,", horror.atm.length, "atm,", horror.bus.length, "bus");
  }
}

function stepHorror(dt) {
  horror.t += dt;
  if (horror.t >= horror.until) {
    // recovery "pop": ease most of the way back to full, with a chaotic,
    // frame-varying rate instead of one fixed bounce
    horror.level += (1 - horror.level) * (0.5 + 0.4 * Math.random());
    const roll = Math.random();
    if (roll < HORROR_DIP_CHANCE) {
      // roll a dip: hold a shallow dim for a ragged, skewed duration
      horror.until = horror.t + HORROR_DIP_MIN + Math.pow(Math.random(), 1.6) * (HORROR_DIP_MAX - HORROR_DIP_MIN);
      horror.inDip = true;
      horror.inBlip = false;
    } else if (roll < HORROR_DIP_CHANCE + HORROR_BLIP_CHANCE) {
      // brief bright pop ABOVE full — reads as the bulb surging for a moment
      horror.until = horror.t + 0.04 + 0.08 * Math.random();
      horror.inDip = false;
      horror.inBlip = true;
    } else {
      // calm spell: actually stay at full brightness until the next roll
      horror.until = horror.t + HORROR_CALM_MIN + Math.random() * (HORROR_CALM_MAX - HORROR_CALM_MIN);
      horror.inDip = false;
      horror.inBlip = false;
    }
  } else if (horror.inDip) {
    // inside a dip: shallow strobing that NEVER goes near black
    horror.level = HORROR_DIP_LEVEL_MIN + Math.random() * (HORROR_DIP_LEVEL_MAX - HORROR_DIP_LEVEL_MIN);
  } else if (horror.inBlip) {
    horror.level = HORROR_BLIP_MIN + Math.random() * (HORROR_BLIP_MAX - HORROR_BLIP_MIN);
  }
  // chaotic but gentle signal: mild incommensurate waves + small per-frame
  // jitter + the odd short stutter — a weak bulb, not a kill switch
  const shim =
    0.97 +
    0.02 * Math.sin(horror.t * 47.0) * Math.sin(horror.t * 31.0 + 1.7) +
    0.01 * Math.sin(horror.t * 13.0 * Math.sin(horror.t * 5.0));
  const jit = 0.94 + 0.12 * Math.random();
  const stutter = Math.random() < 0.02 ? 0.9 : 1.0;
  // clamp so it stays lit but can blip brighter than full for a moment
  const fg = Math.max(HORROR_FLOOR, Math.min(HORROR_CEIL, horror.level * shim * jit * stutter));
  // uniform across the wall/mural, dim, and ATM sets
  for (let i = 0; i < horror.full.length; i++) horror.full[i].m.emissiveIntensity = horror.full[i].base * fg;
  for (let i = 0; i < horror.half.length; i++) horror.half[i].m.emissiveIntensity = horror.half[i].base * fg;
  for (let i = 0; i < horror.atm.length; i++) horror.atm[i].m.emissiveIntensity = horror.atm[i].base * fg;
  // BUS: the same flicker, only a little softer (it's further away)
  const bg = 1 - (1 - fg) * BUS_SOFTEN;
  for (let i = 0; i < horror.bus.length; i++) horror.bus[i].m.emissiveIntensity = horror.bus[i].base * bg;
}

// CLOTHES horror channel: the whole scene (emissive AND unlit materials alike)
// swings off one messy signal — only the SKY backdrop(s) stay static and the
// skylights glass keeps its own flare pulse. Unlit materials are MeshBasic, so
// their COLOR is scaled instead of emissiveIntensity.
const clothesHorror = { list: [], t: 0, until: 0, level: 1, inDip: false, inBlip: false, ready: false };

function collectClothesHorror(gltf) {
  const seen = new Set();
  clothesHorror.list.length = 0;
  gltf.scene.traverse(function (o) {
    if (!o.isMesh) return;
    if (CLOTHES_STATIC.test(o.name || "")) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    mats.forEach(function (m) {
      if (!m || seen.has(m)) return;
      if (CLOTHES_STATIC.test(m.name || "")) return;
      seen.add(m);
      if (typeof m.emissiveIntensity === "number") {
        const base = m.emissiveIntensity;
        clothesHorror.list.push({ m: m, emissive: true, base: base > 0 ? base : 1 });
      } else if (m.color) {
        clothesHorror.list.push({
          m: m, emissive: false,
          baseColor: { r: m.color.r, g: m.color.g, b: m.color.b },
        });
      }
    });
  });
  clothesHorror.ready = clothesHorror.list.length > 0;
  if (clothesHorror.ready) {
    console.log("[horror] CLOTHES:", clothesHorror.list.length, "materials flicker (SKY static)");
  }
}

function stepClothesHorror(dt) {
  clothesHorror.t += dt;
  if (clothesHorror.t >= clothesHorror.until) {
    // recovery "pop": ease most of the way back to full with a chaotic rate
    clothesHorror.level += (1 - clothesHorror.level) * (0.6 + 0.3 * Math.random());
    const roll = Math.random();
    if (roll < CLOTHES_HORROR_DIP_CHANCE) {
      // roll a dip: hold the dim for a ragged, skewed duration
      clothesHorror.until = clothesHorror.t + CLOTHES_HORROR_DIP_MIN + Math.pow(Math.random(), 1.4) * (CLOTHES_HORROR_DIP_MAX - CLOTHES_HORROR_DIP_MIN);
      clothesHorror.inDip = true;
      clothesHorror.inBlip = false;
    } else if (roll < CLOTHES_HORROR_DIP_CHANCE + CLOTHES_HORROR_BLIP_CHANCE) {
      // brief pop slightly brighter than full
      clothesHorror.until = clothesHorror.t + 0.06 + 0.14 * Math.random();
      clothesHorror.inDip = false;
      clothesHorror.inBlip = true;
    } else {
      // brief calm spell before the next disruption
      clothesHorror.until = clothesHorror.t + CLOTHES_HORROR_CALM_MIN + Math.random() * (CLOTHES_HORROR_CALM_MAX - CLOTHES_HORROR_CALM_MIN);
      clothesHorror.inDip = false;
      clothesHorror.inBlip = false;
    }
  } else if (clothesHorror.inDip) {
    // inside a dip: ragged strobing around the 55% floor
    clothesHorror.level = CLOTHES_HORROR_DIP_LEVEL_MIN + Math.random() * (CLOTHES_HORROR_DIP_LEVEL_MAX - CLOTHES_HORROR_DIP_LEVEL_MIN);
  } else if (clothesHorror.inBlip) {
    clothesHorror.level = CLOTHES_HORROR_BLIP_MIN + Math.random() * (CLOTHES_HORROR_BLIP_MAX - CLOTHES_HORROR_BLIP_MIN);
  }
  // messy but gentle: mild incommensurate waves + small per-frame jitter + the
  // odd faint stutter, all clamped to the 0.55..1.05 band
  const shim =
    0.985 +
    0.015 * Math.sin(clothesHorror.t * 53.0) * Math.sin(clothesHorror.t * 29.0 + 1.7) +
    0.008 * Math.sin(clothesHorror.t * 17.0 * Math.sin(clothesHorror.t * 5.0));
  const jit = 0.98 + 0.04 * Math.random();
  const stutter = Math.random() < 0.03 ? 0.93 : 1.0;
  const fg = Math.max(CLOTHES_HORROR_FLOOR, Math.min(CLOTHES_HORROR_CEIL, clothesHorror.level * shim * jit * stutter));
  for (let i = 0; i < clothesHorror.list.length; i++) {
    const e = clothesHorror.list[i];
    if (e.emissive) {
      e.m.emissiveIntensity = e.base * fg;
    } else {
      e.m.color.setRGB(e.baseColor.r * fg, e.baseColor.g * fg, e.baseColor.b * fg);
    }
  }
}

/* ------------------------------------------------------------------ */
/*  fly texture (animated gif as a sprite-sheet atlas)                 */
/* ------------------------------------------------------------------ */

// Preferred path: decode every gif frame with the WebCodecs ImageDecoder,
// bake them into one sprite atlas, then advance a UV offset every frame —
// this animates reliably even where a plain <img> never starts playing.
// Fallback: draw a live <img> into a small canvas on each tick.
const fly = {
  tex: null, img: null, canvas: null, ctx: null,
  w: 160, h: 128, count: 0, cols: 8, rows: 1, index: 0, acc: 0, perMs: 40,
  mode: "none", ready: false, applied: false,
};

function applyFlyTextures() {
  if (!scenes.MAIN.root || !fly.ready || fly.applied) return;
  // flies are DARK: near-black instead of the bright white they showed with
  // an unlit white material. Basic material has no emissive, so the dark tint
  // (FLY_TINT × the gif map) is the "negative emission" equivalent — the gif
  // still flaps through the atlas, just on a near-black body.
  const FLY_TINT = 0.02;
  const m = new THREE.MeshBasicMaterial({
    name: "FLIES",
    map: fly.tex,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    color: new THREE.Color(FLY_TINT, FLY_TINT, FLY_TINT),
  });
  scenes.MAIN.root.traverse(function (o) {
    if (!o.isMesh || !/^FLIES/.test(o.name)) return;
    o.material = m;
  });
  fly.applied = true;
  console.log("[fly] atlas applied to FLIES planes (dark)");
}

// atlas mode: step to the next cell; img mode: re-draw the live <img>
function stepFlyTexture(dt) {
  if (!fly.ready) return;
  if (fly.mode === "img") {
    fly.ctx.clearRect(0, 0, fly.w, fly.h);
    fly.ctx.drawImage(fly.img, 0, 0, fly.w, fly.h);
    fly.tex.needsUpdate = true;
    return;
  }
  if (fly.count < 2) return;
  fly.acc += dt * 1000;
  if (fly.acc < fly.perMs) return;
  fly.acc = fly.acc % fly.perMs;
  fly.index = (fly.index + 1) % fly.count;
  const c = fly.index % fly.cols;
  const r = Math.floor(fly.index / fly.cols);
  fly.tex.offset.x = c / fly.cols;
  fly.tex.offset.y = (fly.rows - 1 - r) / fly.rows;
}

function initFly() {
  if (typeof window.ImageDecoder === "function") {
    initFlyDecoder().catch(function (err) {
      console.warn("[fly] ImageDecoder path failed:", err && err.message);
      initFlyImg();
    });
  } else {
    initFlyImg();
  }
}

async function initFlyDecoder() {
  const res = await fetch("media/textures/fly.gif");
  if (!res.ok) throw new Error("fetch " + res.status);
  const dec = new ImageDecoder({ data: res.body, type: "image/gif" });
  await dec.tracks.ready;
  const track = dec.tracks.selectedTrack;
  const total = track.frameCount;
  const images = [];
  let srcW = 0, srcH = 0, durUs = 0;
  for (let i = 0; i < (total && isFinite(total) ? total : 400); i++) {
    let r;
    try { r = await dec.decode({ frameIndex: i }); } catch (e) { break; }
    if (!r || !r.image) break;
    images.push(r.image);
    srcW = r.image.displayWidth || srcW;
    srcH = r.image.displayHeight || srcH;
    if (!durUs && r.image.duration) durUs = r.image.duration;
  }
  if (images.length < 2) throw new Error("only " + images.length + " frame(s)");
  try { dec.close(); } catch (e) {}

  fly.count = images.length;
  fly.perMs = durUs > 0 ? durUs / 1000 : 40;
  const half = srcW > 256;
  const fw = half ? Math.round(srcW / 2) : srcW;
  const fh = half ? Math.round(srcH / 2) : srcH;
  fly.w = fw;
  fly.h = fh;
  fly.rows = Math.ceil(fly.count / fly.cols);
  const canvas = document.createElement("canvas");
  canvas.width = fw * fly.cols;
  canvas.height = fh * fly.rows;
  const ctx = canvas.getContext("2d");
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    ctx.drawImage(img, 0, 0, srcW, srcH, (i % fly.cols) * fw, Math.floor(i / fly.cols) * fh, fw, fh);
    if (typeof img.close === "function") img.close();
  }
  fly.canvas = canvas;
  fly.ctx = ctx;
  fly.tex = new THREE.CanvasTexture(canvas);
  fly.tex.colorSpace = THREE.SRGBColorSpace;
  fly.tex.magFilter = THREE.NearestFilter;
  fly.tex.minFilter = THREE.LinearFilter;
  fly.tex.repeat.set(1 / fly.cols, 1 / fly.rows);
  fly.tex.offset.set(0, (fly.rows - 1) / fly.rows);
  fly.mode = "atlas";
  fly.ready = true;
  applyFlyTextures();
  console.log("[fly] atlas ready:", fly.count, "frames", fw + "x" + fh, fly.perMs.toFixed(0) + "ms/frame");
}

function initFlyImg() {
  fly.img = new Image();
  fly.img.onload = function () {
    fly.canvas = document.createElement("canvas");
    fly.canvas.width = fly.w;
    fly.canvas.height = fly.h;
    fly.ctx = fly.canvas.getContext("2d");
    fly.tex = new THREE.CanvasTexture(fly.canvas);
    fly.tex.colorSpace = THREE.SRGBColorSpace;
    fly.mode = "img";
    fly.count = 1;
    fly.ready = true;
    applyFlyTextures();
  };
  fly.img.onerror = function () { console.warn("fly.gif failed to load"); };
  fly.img.src = "media/textures/fly.gif";
}

initFly();

/* ------------------------------------------------------------------ */
/*  smoke texture (CLOTHES): animated gif as a sprite-sheet atlas      */
/* ------------------------------------------------------------------ */

// The CLOTHES smoke is a plain unlit white plane with NO UVs (the exported
// mesh only carries positions/normals), so it showed as a blank blob. Give it
// the same treatment as the flies: decode every smoke.gif frame into one
// sprite atlas and advance a UV offset each tick so the puffs animate. UVs
// are generated from the plane's own bounds so the sprite samples cell (0,0).
// The smoke body is PITCH BLACK (SMOKE_TINT = 0) — the gif's alpha still
// animates the puffs as a black silhouette. It plays at 50% opacity
// (SMOKE_OPACITY) and SLOWLY: the gif's native 30ms/frame is clamped up to
// SMOKE_PER_MS so the puffs drift instead of flapping.
const SMOKE_TINT = 0.0;
const SMOKE_OPACITY = 0.5;
const SMOKE_PER_MS = 90;
const smoke = {
  tex: null, img: null, canvas: null, ctx: null,
  w: 160, h: 128, count: 0, cols: 8, rows: 1, index: 0, acc: 0, perMs: 40,
  mode: "none", ready: false, applied: false,
};

function applySmokeTextures() {
  if (!scenes.CLOTHES.root || !smoke.ready || smoke.applied) return;
  let side = THREE.DoubleSide;
  let found = false;
  scenes.CLOTHES.root.traverse(function (o) {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    mats.forEach(function (m) {
      if (m && m.name === "smoke") { found = true; side = m.side || side; }
    });
  });
  if (!found) return;
  const mat = new THREE.MeshBasicMaterial({
    name: "smoke",
    map: smoke.tex,
    transparent: true,
    opacity: SMOKE_OPACITY,
    depthWrite: false,
    side: side,
    color: new THREE.Color(SMOKE_TINT, SMOKE_TINT, SMOKE_TINT),
  });
  scenes.CLOTHES.root.traverse(function (o) {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    mats.forEach(function (m) {
      if (!m || m.name !== "smoke") return;
      ensureUVs(o);
      if (Array.isArray(o.material)) o.material[mats.indexOf(m)] = mat;
      else o.material = mat;
    });
  });
  smoke.applied = true;
  smoke.mat = mat;
  console.log("[smoke] atlas applied to CLOTHES smoke (smoke.gif, dark)");
}

// the smoke plane ships without UVs (Draco dropped them) — bake a 0..1 UV
// set from the geometry's own bounds so the atlas cell fills the plane
function ensureUVs(o) {
  const g = o.geometry;
  if (!g || (g.attributes.uv && g.attributes.uv.count > 0)) return;
  const pos = g.attributes.position;
  if (!pos) return;
  let minX = 1e9, minY = 1e9, minZ = 1e9, maxX = -1e9, maxY = -1e9, maxZ = -1e9;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const sx = maxX - minX, sy = maxY - minY, sz = maxZ - minZ;
  const axes = [sx, sy, sz].map(function (s, i) { return { s: s, i: i }; })
    .sort(function (a, b) { return b.s - a.s; });
  const u = axes[0].i, v = axes[1].i;
  const uMin = [minX, minY, minZ][u], uMax = [maxX, maxY, maxZ][u];
  const vMin = [minX, minY, minZ][v], vMax = [maxX, maxY, maxZ][v];
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const pu = [pos.getX(i), pos.getY(i), pos.getZ(i)][u];
    const pv = [pos.getX(i), pos.getY(i), pos.getZ(i)][v];
    uv[i * 2] = uMax > uMin ? (pu - uMin) / (uMax - uMin) : 0;
    uv[i * 2 + 1] = vMax > vMin ? (pv - vMin) / (vMax - vMin) : 0;
  }
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  g.userData.uvGenerated = true;
}

// Applying the atlas is a ONE-TIME material swap, and it must NOT sit behind
// the lite gate in the render loop. iOS starts in lite mode (IOS_START_TIER),
// so gating this left the smoke plane on its authored GLB material — which has
// no baseColorTexture and no UVs, i.e. a plain white MeshBasicMaterial covering
// the backdrop, which read as a pure-white sky. Only the per-frame advance
// below is expensive, so only that is gated.
//
// The plane is hidden from the moment the room loads until the atlas lands, so
// the white authored material is never shown even for the frames the gif decode
// takes. If the gif never decodes, the plane simply stays hidden instead of
// becoming a white sheet over the room.
function hideUntexturedSmoke(gltf) {
  if (!gltf || !gltf.scene) return;
  gltf.scene.traverse(function (o) {
    if (o.isMesh && o.name === "smoke") o.visible = false;
  });
}

function ensureSmokeApplied() {
  if (smoke.applied || !smoke.ready || !scenes.CLOTHES.root) return;
  applySmokeTextures();
  if (!smoke.applied) return;
  scenes.CLOTHES.root.traverse(function (o) {
    if (o.isMesh && o.name === "smoke") o.visible = true;
  });
}

function stepSmokeTexture(dt) {
  if (!smoke.ready) return;
  if (smoke.mode === "img") {
    smoke.ctx.clearRect(0, 0, smoke.w, smoke.h);
    smoke.ctx.drawImage(smoke.img, 0, 0, smoke.w, smoke.h);
    smoke.tex.needsUpdate = true;
    return;
  }
  if (smoke.count < 2) return;
  smoke.acc += dt * 1000;
  if (smoke.acc < smoke.perMs) return;
  smoke.acc = smoke.acc % smoke.perMs;
  smoke.index = (smoke.index + 1) % smoke.count;
  const c = smoke.index % smoke.cols;
  const r = Math.floor(smoke.index / smoke.cols);
  smoke.tex.offset.x = c / smoke.cols;
  smoke.tex.offset.y = (smoke.rows - 1 - r) / smoke.rows;
}

function initSmoke() {
  if (typeof window.ImageDecoder === "function") {
    initSmokeDecoder().catch(function (err) {
      console.warn("[smoke] ImageDecoder path failed:", err && err.message);
      initSmokeImg();
    });
  } else {
    initSmokeImg();
  }
}

async function initSmokeDecoder() {
  const res = await fetch("media/textures/smoke.gif");
  if (!res.ok) throw new Error("fetch " + res.status);
  const dec = new ImageDecoder({ data: res.body, type: "image/gif" });
  await dec.tracks.ready;
  const track = dec.tracks.selectedTrack;
  const total = track.frameCount;
  const images = [];
  let srcW = 0, srcH = 0, durUs = 0;
  for (let i = 0; i < (total && isFinite(total) ? total : 400); i++) {
    let r;
    try { r = await dec.decode({ frameIndex: i }); } catch (e) { break; }
    if (!r || !r.image) break;
    images.push(r.image);
    srcW = r.image.displayWidth || srcW;
    srcH = r.image.displayHeight || srcH;
    if (!durUs && r.image.duration) durUs = r.image.duration;
  }
  if (images.length < 2) throw new Error("only " + images.length + " frame(s)");
  try { dec.close(); } catch (e) {}
  smoke.count = images.length;
  smoke.perMs = Math.max(durUs > 0 ? durUs / 1000 : 40, SMOKE_PER_MS);
  const half = srcW > 256;
  const fw = half ? Math.round(srcW / 2) : srcW;
  const fh = half ? Math.round(srcH / 2) : srcH;
  smoke.w = fw;
  smoke.h = fh;
  smoke.rows = Math.ceil(smoke.count / smoke.cols);
  const canvas = document.createElement("canvas");
  canvas.width = fw * smoke.cols;
  canvas.height = fh * smoke.rows;
  const ctx = canvas.getContext("2d");
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    ctx.drawImage(img, 0, 0, srcW, srcH, (i % smoke.cols) * fw, Math.floor(i / smoke.cols) * fh, fw, fh);
    if (typeof img.close === "function") img.close();
  }
  smoke.canvas = canvas;
  smoke.ctx = ctx;
  smoke.tex = new THREE.CanvasTexture(canvas);
  smoke.tex.colorSpace = THREE.SRGBColorSpace;
  smoke.tex.magFilter = THREE.LinearFilter;
  smoke.tex.minFilter = THREE.LinearFilter;
  smoke.tex.repeat.set(1 / smoke.cols, 1 / smoke.rows);
  smoke.tex.offset.set(0, (smoke.rows - 1) / smoke.rows);
  smoke.mode = "atlas";
  smoke.ready = true;
  console.log("[smoke] atlas ready:", smoke.count, "frames", fw + "x" + fh, smoke.perMs.toFixed(0) + "ms/frame");
}

function initSmokeImg() {
  smoke.img = new Image();
  smoke.img.onload = function () {
    smoke.canvas = document.createElement("canvas");
    smoke.canvas.width = smoke.w;
    smoke.canvas.height = smoke.h;
    smoke.ctx = smoke.canvas.getContext("2d");
    smoke.tex = new THREE.CanvasTexture(smoke.canvas);
    smoke.tex.colorSpace = THREE.SRGBColorSpace;
    smoke.mode = "img";
    smoke.count = 1;
    smoke.ready = true;
  };
  smoke.img.onerror = function () { console.warn("smoke.gif failed to load"); };
  smoke.img.src = "media/textures/smoke.gif";
}

initSmoke();

/* ------------------------------------------------------------------ */
/*  MAIN decal texture injection (one random webp per name-coded mesh) */
/* ------------------------------------------------------------------ */

// Every decal mesh in MAIN is name-coded, and each pulls ONE webp at random
// from a matching folder: GRAFFITI1/2/ATM -> graffiti/<1|2|ATM>, SIGN -> signs,
// MURAL -> murals, STICKER1..14 -> stickers/<subfolder> (see STICKER_FOLDERS).
// Within a category no two meshes may end up on the SAME image NUMBER — if
// GRAFFITI1 draws 7.webp, GRAFFITI2 / GRAFFITIATM must draw anything but 7 —
// even when the meshes pull from different folders. The decal materials are
// baked emissive (MeshStandardMaterial: baseColor + emissive share one texture
// and there are no lights), so the injected webp replaces BOTH map and
// emissiveMap — the emissive map is what actually shows in the lights-free
// render, and the base-color alpha drives the decal's transparency.

// sticker mesh number -> subfolder it draws from
const STICKER_FOLDERS = {
  1: "1", 2: "2", 3: "3", 4: "4", 5: "3",
  6: "7", 7: "7", 8: "7", 9: "9", 10: "7",
  11: "10", 12: "12", 13: "12", 14: "3",
};

// available webp numbers per folder as compact ranges ("a-b" or "a-b,c-d").
// signs skips 35..40 and stickers/12 skips 5, hence the gaps.
const INJECT_FILES = {
  "media/textures/MAIN/graffiti/1/": "1-44",
  "media/textures/MAIN/graffiti/2/": "1-53",
  "media/textures/MAIN/graffiti/ATM/": "1-21",
  "media/textures/MAIN/signs/": "1-34,41-74",
  "media/textures/MAIN/murals/": "1-27",
  "media/textures/MAIN/stickers/1/": "1-24",
  "media/textures/MAIN/stickers/2/": "1-24",
  "media/textures/MAIN/stickers/3/": "1-69",
  "media/textures/MAIN/stickers/4/": "1-69",
  "media/textures/MAIN/stickers/7/": "1-69",
  "media/textures/MAIN/stickers/9/": "1-21",
  "media/textures/MAIN/stickers/10/": "1-69",
  "media/textures/MAIN/stickers/12/": "1-4,6-69",
};

// category -> how a mesh name maps onto a folder
const INJECT_CATEGORIES = [
  { name: "graffiti", re: /^GRAFFITI/, folder: "media/textures/MAIN/graffiti/" },
  { name: "sign", re: /^SIGN/, folder: "media/textures/MAIN/signs/" },
  { name: "mural", re: /^MURAL/, folder: "media/textures/MAIN/murals/" },
  { name: "sticker", re: /^STICKER/, folder: "media/textures/MAIN/stickers/" },
];

function decalFolderFor(cat, meshName) {
  if (cat.name === "graffiti") {
    const m = /^GRAFFITI(\d+|ATM)$/.exec(meshName);
    return m ? cat.folder + m[1] + "/" : null;
  }
  if (cat.name === "sticker") {
    const m = /^STICKER(\d+)$/.exec(meshName);
    if (!m) return null;
    const sub = STICKER_FOLDERS[parseInt(m[1], 10)];
    return sub ? cat.folder + sub + "/" : null;
  }
  return cat.folder;
}

// expand "1-4,6-69" into a sorted array of numbers
function expandRanges(str) {
  const out = [];
  String(str).split(",").forEach(function (part) {
    const m = /^(\d+)-(\d+)$/.exec(part.trim());
    if (m) for (let i = +m[1]; i <= +m[2]; i++) out.push(i);
    else if (/^\d+$/.test(part.trim())) out.push(parseInt(part.trim(), 10));
  });
  return out;
}

const textureInject = {
  ready: false,
  pass: 0,         // bumped per pass; a late async load only applies if still current
  used: {},        // category -> Set of already-assigned image numbers this pass
  assignments: [], // { mesh, category, folder, image, path, state }
  applied: 0,
  errors: 0,
  lastImage: {},   // mesh name -> image number shown on the previous pass (never re-picked)
  history: {},     // mesh name -> every image number this session has shown it, oldest first
  rolls: 0,        // completed re-rolls this session
};

function initMainTextureInjection() {
  if (!scenes.MAIN.root || textureInject.ready) return;
  textureInject.ready = true;
  rerollMainTextures();
}

// re-roll the MAIN decal textures. Called on every entry to MAIN so the
// display changes each visit; a mesh never gets the same image twice in a row.
// Re-roll policy.
//
// The naive version - "never repeat the previous image" - looks right and
// quietly costs 5.8 MB on EVERY return to MAIN, because it can never pick
// something the browser has already cached. Nineteen decals, no repeats ever,
// means nineteen guaranteed cache misses every single time.
//
// So: novelty first, then deliberate repetition.
//
//   * The opening NOVEL_ROLLS passes maximise newness. A first-time visitor
//     sees a completely different wall each time, which is the whole point of
//     the feature, and it is the window where there is nothing in cache to
//     reuse anyway.
//   * After that, REPEAT_CHANCE of the picks are steered back onto images this
//     session has already shown, so they are served from cache and cost
//     nothing. The oldest seen image wins, which keeps each cached webp alive
//     as long as possible before it comes round again.
//
// Two rules never bend, because breaking them looks like a bug rather than a
// feature: a mesh never shows the image it is already displaying, and no two
// meshes in one category take the same number in a single pass.
const NOVEL_ROLLS = 3;
const REPEAT_CHANCE = 0.4;
const HISTORY_MAX = 24;

function rerollMainTextures() {
  if (!scenes.MAIN.root) return;
  textureInject.pass++;
  textureInject.used = {};
  textureInject.assignments = [];
  textureInject.applied = 0;
  textureInject.errors = 0;

  const tloader = new THREE.TextureLoader();
  const myPass = textureInject.pass;
  const opening = textureInject.rolls < NOVEL_ROLLS;

  INJECT_CATEGORIES.forEach(function (cat) {
    const meshes = [];
    scenes.MAIN.root.traverse(function (o) {
      if (o.isMesh && cat.re.test(o.name)) meshes.push(o);
    });
    if (!meshes.length) return;
    const used = textureInject.used[cat.name] = new Set();

    meshes.forEach(function (o) {
      const folder = decalFolderFor(cat, o.name);
      const numbers = folder ? expandRanges(INJECT_FILES[folder]) : [];
      const hist = textureInject.history[o.name] || (textureInject.history[o.name] = []);
      const prev = textureInject.lastImage[o.name];

      // never the image already on this mesh, never a number another mesh in
      // this category took this pass
      let pool = numbers.filter(function (n) { return !used.has(n) && n !== prev; });
      if (!pool.length) pool = numbers.filter(function (n) { return n !== prev; });
      if (!folder || !pool.length) {
        textureInject.errors++;
        console.warn("[tex]", o.name, "no image available in", folder || "(no folder)");
        return;
      }

      let image;
      if (opening) {
        // maximise newness while the cache has nothing worth reusing
        const fresh = pool.filter(function (n) { return hist.indexOf(n) === -1; });
        const pick = fresh.length ? fresh : pool;
        image = pick[Math.floor(Math.random() * pick.length)];
      } else if (Math.random() < REPEAT_CHANCE) {
        // deliberately re-show something already loaded: sort by how long ago
        // this mesh last drew it, oldest first, and take the stalest
        const seen = pool
          .map(function (n) { return { n: n, at: hist.indexOf(n) }; })
          .filter(function (e) { return e.at !== -1; })
          .sort(function (a, b) { return a.at - b.at; });
        image = seen.length ? seen[0].n : pool[Math.floor(Math.random() * pool.length)];
      } else {
        image = pool[Math.floor(Math.random() * pool.length)];
      }

      used.add(image);
      textureInject.lastImage[o.name] = image;
      hist.push(image);
      if (hist.length > HISTORY_MAX) hist.shift();
      const path = folder + image + ".webp";
      const assign = { mesh: o.name, category: cat.name, folder: folder, image: image, path: path, state: "loading" };
      textureInject.assignments.push(assign);
      tloader.load(
        path,
        function (tex) {
          if (textureInject.pass !== myPass) return; // a newer re-roll superseded this one
          tex.colorSpace = THREE.SRGBColorSpace;
          // baked glTF textures are flipY=false (top-left UV origin); the
          // TextureLoader default (flipY=true) would render the webp flipped
          tex.flipY = false;
          applyWebpToMesh(o, tex);
          assign.state = "ok";
          textureInject.applied++;
          console.log("[tex]", o.name, "<-", path);
        },
        undefined,
        function (err) {
          assign.state = "error";
          textureInject.errors++;
          used.delete(image); // free the number so a re-run can pick it
          console.warn("[tex] failed to load", path, err && err.message);
        }
      );
    });
  });

  const total = textureInject.assignments.length;
  if (total) {
    console.log("[tex] injecting", total, "decals:", textureInject.assignments.map(function (a) { return a.mesh; }).join(", "));
  }
  // Counted after the picks, so the NEXT pass reads the right policy: the
  // first NOVEL_ROLLS passes are the ones that maximise newness.
  textureInject.rolls++;
}

// Injected webps are owned by the material they were assigned to, and three.js
// only frees a GPU texture when dispose() is called on it. Re-rolling a decal
// (every time you leave MAIN, and every time you leave CLOTHES) used to drop
// the previous texture on the floor: the JS object became unreachable, but the
// GL texture behind it did not, so every visit permanently stranded a texture on
// the GPU. That is invisible on a desktop GPU and fatal on a phone, which is
// the difference between "runs for a while" and "the tab dies".
//
// Only textures WE injected are ever disposed. The baked originals are shared
// by many decals, so disposing one of those would blank every mesh using it.
const injectedTextures = new Set();
function disposeInjected(m) {
  if (!m) return;
  // map and emissiveMap are normally the same injected texture, so dispose
  // each at most once per call
  const done = new Set();
  [m.map, m.emissiveMap].forEach(function (t) {
    if (!t || !t.isTexture || !injectedTextures.has(t) || done.has(t)) return;
    done.add(t);
    injectedTextures.delete(t);
    t.dispose();
  });
}
function trackInjected(tex) {
  if (tex && tex.isTexture) injectedTextures.add(tex);
  return tex;
}

// put the injected webp onto the decal material. The baked materials carry the
// SAME texture on both baseColor and emissive and there are no lights, so swap
// map (base color / alpha) AND emissiveMap (the only channel that actually
// renders). Authoring — UVs, transparency, decal polygon offset, horror-flicker
// base — is untouched.
function applyWebpToMesh(o, tex) {
  const mats = Array.isArray(o.material) ? o.material : [o.material];
  trackInjected(tex);
  mats.forEach(function (m) {
    if (!m) return;
    disposeInjected(m);
    m.map = tex;
    m.emissiveMap = tex;
    if (m.emissive) m.emissive.setRGB(1, 1, 1);
    m.needsUpdate = true;
  });
}

/* ------------------------------------------------------------------ */
/*  CLOTHES garment texture injection (one random webp per garment)    */
/* ------------------------------------------------------------------ */

// The three named garments each pull ONE random webp from a matching folder:
// GORRA (static cap) -> GORRAS/GORRA, GORRA2 (skinned cap) -> GORRAS/GORRA2,
// CLOTHES (shirt) -> CLOTHES. Same trick as the MAIN decals: replace map +
// emissiveMap (the channel that actually renders with no lights) so the fabric
// visibly changes; generated UVs if the mesh shipped without them; the original
// map is kept so it could be restored.
const CLOTHES_INJECT = [
  { mesh: "GORRA", folder: "media/textures/CLOTHES/GORRAS/GORRA/", files: "1-6" },
  { mesh: "GORRA2", folder: "media/textures/CLOTHES/GORRAS/GORRA2/", files: "1-6" },
  { mesh: "CLOTHES", folder: "media/textures/CLOTHES/CLOTHES/", files: "1-5" },
];

const clothesInject = {
  ready: false,
  pass: 0,         // bumped per pass; a late async load only applies if still current
  assignments: [],
  applied: 0,
  errors: 0,
  lastImage: {},   // mesh name -> image number shown on the previous pass (never re-picked)
};

function initClothesTextureInjection() {
  if (!scenes.CLOTHES.root || clothesInject.ready) return;
  clothesInject.ready = true;
  rerollClothesTextures();
}

// re-roll the CLOTHES garment textures. Called on every entry to CLOTHES so
// the fabric changes each visit; a garment never gets the same image twice in
// a row (5.webp stays gone until another number has been shown).
function rerollClothesTextures() {
  if (!scenes.CLOTHES.root) return;
  clothesInject.pass++;
  clothesInject.assignments = [];
  clothesInject.applied = 0;
  clothesInject.errors = 0;
  const tloader = new THREE.TextureLoader();
  const myPass = clothesInject.pass;

  CLOTHES_INJECT.forEach(function (cfg) {
    const meshes = [];
    scenes.CLOTHES.root.traverse(function (o) {
      if (o.isMesh && o.name === cfg.mesh) meshes.push(o);
    });
    if (!meshes.length) {
      clothesInject.errors++;
      console.warn("[clothtex]", cfg.mesh, "not found in CLOTHES scene");
      return;
    }
    const numbers = expandRanges(cfg.files);
    const prev = clothesInject.lastImage[cfg.mesh];
    const free = numbers.filter(function (n) { return n !== prev; });
    const image = (free.length ? free : numbers)[Math.floor(Math.random() * (free.length ? free.length : numbers.length))];
    clothesInject.lastImage[cfg.mesh] = image;
    const path = cfg.folder + image + ".webp";
    const assign = { mesh: cfg.mesh, folder: cfg.folder, image: image, path: path, state: "loading" };
    clothesInject.assignments.push(assign);
    tloader.load(
      path,
      function (tex) {
        if (clothesInject.pass !== myPass) return; // a newer re-roll superseded this one
        tex.colorSpace = THREE.SRGBColorSpace;
        // glTF UV origin is top-left; the TextureLoader default (flipY=true)
        // would render the webp flipped
        tex.flipY = false;
        meshes.forEach(function (o) { applyClothesTexture(o, tex); });
        assign.state = "ok";
        clothesInject.applied++;
        console.log("[clothtex]", cfg.mesh, "<-", path);
      },
      undefined,
      function (err) {
        assign.state = "error";
        clothesInject.errors++;
        console.warn("[clothtex] failed to load", path, err && err.message);
      }
    );
  });

  const total = clothesInject.assignments.length;
  if (total) {
    console.log("[clothtex] injecting", total, "garments:", clothesInject.assignments.map(function (a) { return a.mesh; }).join(", "));
  }
}

function applyClothesTexture(o, tex) {
  ensureUVs(o);
  const mats = Array.isArray(o.material) ? o.material : [o.material];
  trackInjected(tex);
  mats.forEach(function (m) {
    if (!m) return;
    if (!m.userData._origMap && m.map && m.map.isTexture) m.userData._origMap = m.map;
    // same GPU-texture leak as the MAIN decals: a re-roll must release the
    // previous webp, or every visit to CLOTHES strands one
    disposeInjected(m);
    m.map = tex;
    // emissive materials need the map on the emissive channel to render (no
    // lights); unlit (basic) materials only have map
    if (m.emissiveMap !== undefined || m.emissive !== undefined) {
      m.emissiveMap = tex;
      if (m.emissive) m.emissive.setRGB(1, 1, 1);
    }
    m.needsUpdate = true;
  });
}

/* ------------------------------------------------------------------ */
/*  TORIS two-dancer texture loading (swap between numbered sets)      */
/* ------------------------------------------------------------------ */

// The TORIS room holds two dancing rigs split by a digit suffix on the mesh
// names — "1" meshes (l_hand1, l_biceps1, j_l_ankle1, ...) are one figure, "2"
// meshes (l_hand2, l_biceps2, ...) the other. Every body part has a matching
// webp in media/TORIS/sets/<n>/<part>.webp (a full body set per folder), so
// each figure loads its whole skin from ONE numbered folder and the two figures
// always come from TWO DIFFERENT folders. The bottom-center arrows swap one
// figure at a time: left cycles figure 1 backward, right cycles figure 2
// forward, wrapping around and skipping the other figure's current folder so
// the pair never repeats. The GLB shares one material instance across both
// rigs (l_hand1 and l_hand2 use the same material), so materials are cloned
// per mesh first — otherwise swapping one figure would re-skin the other too.
const TORIS_SET_DIR = "media/TORIS/sets/";
const TORIS_SETS = expandRanges("1-17");

// clicking any loaded TORIS body part opens that figure's CURRENT set folder's
// texture page (folder number -> toribashtexture deep link)
const TORIS_FOLDER_LINKS = {
  1: "https://toribashtexture.com/?tid=yvw1QstYbdbF",
  2: "https://toribashtexture.com/?tid=dKkLgsUtNtYd",
  3: "https://toribashtexture.com/?tid=wfwcGMK1vyoJ",
  4: "https://toribashtexture.com/?tid=dKzT5SxUPJli",
  5: "https://toribashtexture.com/?tid=90fHi1NcXiHV",
  6: "https://toribashtexture.com/?tid=ZSlNyASYvfgB",
  7: "https://toribashtexture.com/?tid=OG2R_Z7XPeRE",
  8: "https://toribashtexture.com/?tid=vgN-6OHi1fPK",
  9: "https://toribashtexture.com/?tid=T-WdpxLx1j3L",
  10: "https://toribashtexture.com/?tid=yvw1QstYbdbF",
  11: "https://toribashtexture.com/?tid=DrRwqdN1bnJi",
  12: "https://toribashtexture.com/?tid=XVt6r-TRUtFO",
  13: "https://toribashtexture.com/?tid=ZtUQzyZtjgde",
  14: "https://toribashtexture.com/?tid=Gx2bU1ILlsN8",
  15: "https://toribashtexture.com/?tid=A4rXA1RR87k_",
  16: "https://toribashtexture.com/?tid=ex-8KSt8tHbF",
  17: "https://toribashtexture.com/?tid=XC5Da7Xaz2rg",
};

// the authoritative body-part names (each has a <part>.webp in every set
// folder) — everything else (e.g. the background Cube meshes) is left alone
const TORIS_PARTS = [
  "breast", "chest", "j_chest", "head", "l_biceps", "l_foot", "l_hand",
  "l_leg", "l_pecs", "l_thigh", "l_triceps", "j_l_ankle", "j_l_elbow",
  "j_l_glute", "j_l_hip", "j_l_knee", "j_l_pecs", "j_l_shoulder",
  "j_l_wrist", "j_lumbar", "j_neck", "r_biceps", "r_foot", "r_hand",
  "r_leg", "r_pecs", "r_thigh", "r_triceps", "j_r_ankle", "j_r_elbow",
  "j_r_glute", "j_r_hip", "j_r_knee", "j_r_pecs", "j_r_shoulder",
  "j_r_wrist", "stomach", "groin", "j_abs",
];
const TORIS_PART_SET = new Set(TORIS_PARTS);

// leg/thigh parts whose baked texcoords read only a narrow v-slab of the part
// texture (shows it sideways). Regenerating a full 0..1 "upright" projection
// (v = model vertical, u = larger horizontal extent) makes the self-contained
// part webp render correctly, the same way chest/head already do.
const TORIS_UPRIGHT_UV = new Set(["l_leg", "r_leg", "l_thigh", "r_thigh"]);

function regenUprightUVs(o) {
  const g = o.geometry;
  if (!g) return;
  const pos = g.attributes.position;
  if (!pos) return;
  let minX = 1e9, minY = 1e9, minZ = 1e9, maxX = -1e9, maxY = -1e9, maxZ = -1e9;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  // A limb is a cylinder: mapping u straight across the bounding box makes the
  // front and back faces share the same u-columns, so the seam-free part webp
  // reads as duplicated + mirrored around the limb ("wrapped twice"). Instead
  // wrap u AROUND the limb once by sweeping the angle about the long (Y) axis —
  // exactly one full turn per texture, so nothing mirrors or doubles.
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  const spanY = maxY - minY;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const a = Math.atan2(z - cz, x - cx); // -PI..PI around the limb
    uv[i * 2] = (a + Math.PI) / (2 * Math.PI);
    uv[i * 2 + 1] = spanY > 1e-6 ? (y - minY) / spanY : 0.5;
  }
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  g.userData.uvCylindrical = true;
}

// leg/thigh part webps read upright only after the loaded pixel content has been
// turned 90 deg counter-clockwise (left), same list that regenUprightUVs regenerates
const TORIS_LEG_PARTS = new Set(["l_leg", "r_leg", "l_thigh", "r_thigh"]);

// draw `src`'s image onto a canvas rotated 90 deg CCW and return a CanvasTexture
// (the original image is already decoded by the time TextureLoader calls back, so
// this synchronously rebuilds the pixels). Returns a plain, unrotated texture if
// the source has no image.
function rotateTextureLeft90(src) {
  const img = src && src.image;
  if (!img) return src;
  const sx = img.width || 1, sy = img.height || 1;
  const cvs = document.createElement("canvas");
  cvs.width = sy;   // a 90 deg rotation swaps the dimensions
  cvs.height = sx;
  const ctx = cvs.getContext("2d");
  if (!ctx) return src;
  ctx.translate(0, cvs.height);   // rotate 90 deg counter-clockwise (left)
  ctx.rotate(-Math.PI / 2);
  ctx.drawImage(img, 0, 0);
  const rotated = new THREE.CanvasTexture(cvs);
  rotated.colorSpace = (src && src.colorSpace) || THREE.SRGBColorSpace;
  rotated.flipY = false;
  if (src && src.dispose) src.dispose();
  return rotated;
}

/* ------------------------------------------------------------------ */
/*  dot-matrix arrows for every UI arrow (no UI circle / no ring)      */
/* ------------------------------------------------------------------ */

// tiny LED-dot grids — center-lit on an odd 9x9 display so every arrow is
// perfectly symmetric about its axis: ↑/↓ have a sharp triangle head over a
// straight centered shaft, and â†/→ are a symmetric point-and-shaft. `back` is
// the left arrow carrying a little tail that hangs straight down off the right
// end (the return arrow). Small dots leave enough negative space that the
// shape reads solid and sharp. Each button shows ONLY its dot arrow; there is
// no circular ring or filled disc behind it anywhere in the UI.
const DMATRIX_PIXELS = (function () {
  // 0 = off, 1 = on, rows laid out top-to-bottom. centre axis = column 4.
  const arrows = {
    up: [
      "....#....",
      "...###...",
      "..#####..",
      ".#######.",
      ".#######.",
      "...###...",
      "...###...",
      "...###...",
      "...###...",
    ],
    down: [
      "...###...",
      "...###...",
      "...###...",
      "...###...",
      ".#######.",
      ".#######.",
      "..#####..",
      "...###...",
      "....#....",
    ],left: [
      ".........",
      "...##....",
      "..###....",
      ".########",
      "#########",
      ".########",
      "..###....",
      "...##....",
      ".........",
    ],
    right: [
      ".........",
      "....##...",
      "....###..",
      "########.",
      "#########",
      "########.",
      "....###..",
      "....##...",
      ".........",
    ],
    back: [
      "...##....",
      "..###....",
      ".########",
      "#########",
      ".########",
      "..###.###",
      "...##.###",
      "......###",
      "......###",
    ],
    // Mute button (15x11, same dot language as the arrows). Both states are the
    // real speaker glyph: a body box plus a cone that flares to the right. The
    // audible state adds two ")" wave arcs; the muted state keeps the box+cone
    // EXACTLY the same (so the button never changes silhouette under the cursor)
    // and swaps the arcs for a 2-dot-thick diagonal. The 15-wide grid is safe
    // only because the dot radius now scales with grid width - see DMATRIX.
    sound: [
      "............#..",
      "..........#.#..",
      "......###.#..#.",
      "###..####.#..##",
      "###.#####..#.##",
      "###.#####..#.##",
      "###.#####..#.##",
      "###..####.#..##",
      "......###.#..#.",
      "..........#.#..",
      "............#..",
    ],
    muted: [
      ".............##",
      "............##.",
      "......###..##..",
      "###..####.##...",
      "###.#######....",
      "###.######.....",
      "###.#####......",
      "###..####......",
      ".....####......",
      "....##.........",
      "...##..........",
    ],
  };
  return function (dir) {
    const rows = arrows[dir] || arrows.left;
    const R = rows.length, C = rows[0].length;
    // The dot radius scales with the grid WIDTH, so every glyph gets the same
    // physical LED size no matter how many columns it uses. It used to be a
    // hardcoded 0.32, which is exactly right for the 9-wide arrows but shrinks
    // every dot to 43% on a 15-wide grid - that is what turned the first speaker
    // attempt into an unreadable smudge. 0.0356 * 9 = 0.32, so the existing
    // arrows are pixel-identical to before.
    const rad = (C * 0.0356).toFixed(3);
    let dots = "";
    for (let r = 0; r < R; r++) {
      for (let c = 0; c < C; c++) {
        if (rows[r][c] === "#") dots += '<circle cx="' + c + '" cy="' + r + '" r="' + rad + '"/>';
      }
    }
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + C + " " + R + '" fill="#ffffff">' +
      dots +
      "</svg>";
    return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  };
})();

function renderDotMatrixArrow(el, dir) {
  if (!el) return;
  // keep the tap target; drop any text glyph / inline char
  el.textContent = "";
  el.style.backgroundImage = "url(\"" + DMATRIX_PIXELS(dir) + "\")";
  el.style.backgroundRepeat = "no-repeat";
  el.style.backgroundPosition = "center";
  el.style.backgroundSize = "contain";
}

// blink the visible UI arrows 3 times (blue + white LED dots, same rhythm as
// the "THIS IS A PORTFOLIO" bubble) before they stay lit. Runs on every scene
// entry; the class is dropped on animationend so hidden TORIS arrows (only
// visible inside the TORIS scene) return to their normal hidden state.
function flashDotArrows() {
  const isT = !!(active && active.name === "TORIS");
  const els = isT ? [backEl, torisArrowL, torisArrowR] : [backEl];
  els.forEach(function (el) {
    if (!el) return;
    el.classList.remove("dotarrow-flash");
    void el.offsetWidth;
    el.classList.add("dotarrow-flash");
  });
}

// same entrance blink for the artwork-browse arrows every time the modal opens
function flashArtArrows() {
  [artNavPrev, artNavNext].forEach(function (el) {
    if (!el) return;
    el.classList.remove("dotarrow-flash");
    void el.offsetWidth;
    el.classList.add("dotarrow-flash");
  });
}

[backEl, zoomOutEl, torisArrowL, torisArrowR, artNavPrev, artNavNext].forEach(function (el) {
  if (!el) return;
  el.addEventListener("animationend", function () {
    el.classList.remove("dotarrow-flash");
  });
});

// which mute glyph is currently on the button, so paintMuteButton can skip
// repainting on the frames where nothing changed (it is called every frame).
// Declared HERE, above the initial icon pass below, because that pass calls
// paintMuteButton() during module evaluation - a `let` further down the file
// would be in its temporal dead zone and throw, taking the whole module with it.
let mutePainted = null;

// initial icon pass: the TORIS side arrows and the artwork-browse arrows are
// dot-matrix arrows too; updateBackIcon covers the back button
if (torisArrowL) renderDotMatrixArrow(torisArrowL, "left");
if (torisArrowR) renderDotMatrixArrow(torisArrowR, "right");
if (zoomOutEl) renderDotMatrixArrow(zoomOutEl, "down");
if (muteEl) paintMuteButton();
if (artNavPrev) renderDotMatrixArrow(artNavPrev, "left");
if (artNavNext) renderDotMatrixArrow(artNavNext, "right");

const torisInject = {
  ready: false,
  pass: { 1: 0, 2: 0 },     // per-figure swap token: a stale load only applies if current
  sets: { 1: 0, 2: 0 },     // currently assigned set folder per figure
  meshes: { 1: [], 2: [] }, // [{ mesh, base }] body-part meshes per figure
  assignments: [],
  pending: 0,
  applied: 0,
  errors: 0,
  bakedImage: null,         // the shared 512px "breast" atlas image the part webps are crops of
};

// hover highlight on the dancers: hovering ANY part of figure 1 (head1,
// breast1, chest1, ... — every mesh whose name ends in "1") shines that whole
// figure ~40% and leaves figure 2 alone; reverse for figure 2. The glow is
// the same system as the other rooms but gentler: no beacon pulses, and a soft
// +40% lift (x1.4 on the base emissive) instead of the full GLOW_HOVER flash.
const TORIS_HOVER_GLOW = 1.2; // hover shine strength: 1.2 = +120% brightness (x2.2)
const torisGlow = { targets: [], hoverFig: 0 };

function collectTorisFigures(root) {
  torisInject.meshes[1] = [];
  torisInject.meshes[2] = [];
  root.traverse(function (o) {
    if (!o.isMesh) return;
    const m = /^(.*?)([12])$/.exec(o.name);
    if (!m || !TORIS_PART_SET.has(m[1])) return;
    // give each mesh its own material clone so a figure swap can't touch the
    // other rig (the export shares materials across both figures)
    if (Array.isArray(o.material)) o.material = o.material.map(function (mm) { return mm.clone(); });
    else o.material = o.material.clone();
    torisInject.meshes[+m[2]].push({ mesh: o, base: m[1] });
    if (TORIS_UPRIGHT_UV.has(m[1])) regenUprightUVs(o);
    // all body parts share the same baked 512px atlas ("breast" image 0) that
    // the per-part set webps are crops of; capture it before the first swap
    if (!torisInject.bakedImage) {
      const mat = Array.isArray(o.material) ? o.material[0] : o.material;
      const srcTex = (mat && (mat.map || mat.emissiveMap)) || null;
      const src = srcTex && srcTex.source && srcTex.source.data;
      if (src) torisInject.bakedImage = src;
    }
  });
  console.log("[toris] figures 1 x", torisInject.meshes[1].length, "| 2 x", torisInject.meshes[2].length);
}

function initTorisTextureInjection() {
  if (!scenes.TORIS.root || torisInject.ready) return;
  torisInject.ready = true;
  collectTorisFigures(scenes.TORIS.root);
  // per-figure glow sets for the hover highlight (meshes are cloned per
  // figure in collectTorisFigures, so each figure's materials are separate)
  torisGlow.targets = [1, 2].map(function (f) {
    const t = makeGlowSet(torisInject.meshes[f].map(function (e) { return e.mesh; }), "TORIS figure " + f);
    t.fig = f;
    t.beaconMode = "off";                // hover-only: no beacon pulses on the dancers
    t.hoverStrength = TORIS_HOVER_GLOW;  // gentle +40% shine instead of GLOW_HOVER
    return t;
  });
  console.log("[toris] hover glow targets:", torisGlow.targets.length);
  loadTorisFigure(1, TORIS_SETS[0]);
  loadTorisFigure(2, TORIS_SETS[1]);
}

function applyTorisTexture(o, tex) {
  ensureUVs(o);
  const mats = Array.isArray(o.material) ? o.material : [o.material];
  mats.forEach(function (m) {
    if (!m) return;
    if (!m.userData._origMap && m.map && m.map.isTexture) m.userData._origMap = m.map;
    m.map = tex;
    // emissive materials render via the emissive channel (no lights); unlit
    // (basic) materials only have map
    if (m.emissiveMap !== undefined || m.emissive !== undefined) {
      m.emissiveMap = tex;
      if (m.emissive) m.emissive.setRGB(1, 1, 1);
    }
    m.needsUpdate = true;
  });
}

// load one figure's entire skin from set folder `setNum` (async; a newer swap
// supersedes this one via the pass token)
function loadTorisFigure(fig, setNum) {
  const meshes = torisInject.meshes[fig];
  if (!meshes.length || !setNum) return false;
  torisInject.sets[fig] = setNum;
  torisInject.pass[fig]++;      // per-figure token so both figures can load at once
  torisInject.assignments = [];
  const myPass = torisInject.pass[fig];
  const tloader = new THREE.TextureLoader();
  meshes.forEach(function (entry) {
    const path = TORIS_SET_DIR + setNum + "/" + entry.base + ".webp";
    torisInject.pending++;
    const assign = { fig: fig, mesh: entry.mesh.name, set: setNum, path: path, state: "loading" };
    torisInject.assignments.push(assign);
    // leg/thigh part webps are baked with their (vU, vV) = (x, z) long axis, so
    // with the regenerated upright 0..1 UVs they come in turned 90 deg sideways.
    // Load them rotated 90 deg counter-clockwise (left) so they read upright.
    const rotated = TORIS_LEG_PARTS.has(entry.base);
    const applyToMesh = function (tex) {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.flipY = false;
      if (rotated) {
        tex = rotateTextureLeft90(tex);
      }
      applyTorisTexture(entry.mesh, tex);
    };
    tloader.load(
      path,
      function (tex) {
        torisInject.pending--;
        if (torisInject.pass[fig] !== myPass) return; // a newer swap superseded this one
        applyToMesh(tex);
        assign.state = "ok";
        torisInject.applied++;
        console.log("[toris]", entry.mesh.name, "<-", path, rotated ? "(rotated 90 CCW)" : "");
      },
      undefined,
      function (err) {
        torisInject.pending--;
        if (torisInject.pass[fig] !== myPass) return;
        assign.state = "error";
        torisInject.errors++;
        console.warn("[toris] failed to load", path, err && err.message);
      }
    );
  });
  return true;
}

// the folder `fig` steps to in `dir`: one slot over, wrapping around, skipping
// the other figure's current folder so the pair never repeats
function torisNextSet(fig, dir) {
  const other = fig === 1 ? 2 : 1;
  const list = TORIS_SETS.filter(function (n) { return n !== torisInject.sets[other]; });
  const cur = torisInject.sets[fig];
  let idx = list.indexOf(cur);
  if (idx < 0) idx = dir > 0 ? -1 : list.length;
  return list[(idx + dir + list.length) % list.length];
}

function swapTorisFigure(fig, dir) {
  if (!scenes.TORIS.root || !torisInject.ready || torisInject.meshes[fig].length === 0) return false;
  const next = torisNextSet(fig, dir);
  if (next === torisInject.sets[fig]) return false;
  return loadTorisFigure(fig, next);
}

// which TORIS figure (1 or 2) the cursor is over right now. Plain (non-skinned)
// parts are raycast-exact; skinned parts are hit-tested by skinned-vertex
// projection so the dancing pose is what's clickable, never the bind pose.
function pickTorisFigure(ndx, ndy) {
  if (!torisInject.ready) return 0;
  scene.updateMatrixWorld(true);
  const plain = [];
  for (let f = 1; f <= 2; f++) {
    for (let i = 0; i < torisInject.meshes[f].length; i++) {
      const o = torisInject.meshes[f][i].mesh;
      if (!o.isSkinnedMesh) plain.push(o);
    }
  }
  if (plain.length) {
    pointer.set(ndx, ndy);
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(plain, false);
    for (let i = 0; i < hits.length; i++) {
      if (!hits[i].object.visible) continue;
      const m = /^(.*?)([12])$/.exec(hits[i].object.name);
      if (m) return +m[2];
    }
  }
  for (let f = 1; f <= 2; f++) {
    for (let i = 0; i < torisInject.meshes[f].length; i++) {
      const o = torisInject.meshes[f][i].mesh;
      if (o.visible && o.isSkinnedMesh && skinnedMeshNear(o, ndx, ndy)) return f;
    }
  }
  return 0;
}

// clicking any loaded TORIS body part opens the toribashtexture page for that
// figure's CURRENT folder (see TORIS_FOLDER_LINKS)
function handleTorisClick(e) {
  if (!scenes.TORIS.root || !torisInject.ready) return;
  const ndx = (e.clientX / window.innerWidth) * 2 - 1;
  const ndy = -(e.clientY / window.innerHeight) * 2 + 1;
  const fig = pickTorisFigure(ndx, ndy);
  if (!fig) return;
  const set = torisInject.sets[fig];
  const url = TORIS_FOLDER_LINKS[set];
  if (url) window.open(url, "_blank");
}

// per-frame hover highlight: the picked figure (via the same raycast / pose
// hit-test as the click) owns the glow while the cursor stays on ANY of its
// parts; the other figure is eased back down and both stop as soon as the
// cursor leaves both dancers.
function updateTorisHover(dt) {
  if (!torisInject.ready || !torisGlow.targets.length) return;
  let fig = 0;
  if (!isContactCardOpen()) fig = pickTorisFigure(mouseX, -mouseY);
  if (fig !== torisGlow.hoverFig) {
    torisGlow.hoverFig = fig;
    console.log("[toris] hover figure:", fig);
  }
  for (let i = 0; i < torisGlow.targets.length; i++) {
    const t = torisGlow.targets[i];
    easeHover(t, fig === t.fig);
    applyTargetGlow(t, dt);
  }
}

/* ------------------------------------------------------------------ */
/*  loop / resize / visibility                                         */
/* ------------------------------------------------------------------ */

const clock = new THREE.Clock();
let running = true;
let debugPaused = false;

// bottom-center back button: in every scene except MAIN it returns to the menu.
// On MAIN it doubles as a zoom-out toggle: the lens WIDENS (FOV x MAIN_ZOOM_FOV)
// while the camera glides BACKWARD along its own view axis at 20% of the
// fly-through's world speed, pulling out to MAIN_ZOOM_BACK_FRAC of the
// focus distance — a dramatic, gradual recede that reveals much more of the
// scene. Pressing again eases both back to the normal shot.
// The portrait fit adds only a few degrees of lens, so this behaves the same on
// a phone and on desktop.
const MAIN_ZOOM_FOV = 2.0;
const MAIN_ZOOM_FOV_RATE = 2.2;   // lens glide: fraction of the gap closed / s
const MAIN_ZOOM_BACK_FRAC = 0.7;  // pull back this much of the focus distance
const MAIN_ZOOM_SPEED = 0.2;      // camera recedes at 20% of the fly speed
const MAIN_ZOOM_MIN_SPEED = 0.3;  // m/s floor so the pull never stalls on path pauses
const MAIN_ZOOM_RIGHT_FRAC = 0.2; // while zoomed out, also strafe the camera right this fraction of the pull
const MAIN_ZOOM_DAMP = 0.7;       // path camera slows this much (fraction) while zoomed out
const mainZoom = { on: false, frames: 0, baseFov: null, back: 0, targetBack: 0, prevPos: null };

// the resting FOV for whichever scene is live: its authored lens plus the
// portrait widening. `fallback` is used before a scene has been loaded (or
// mid-handover, when mainZoom still holds the previous scene's number).
function restingFov(cam, fallback) {
  const s = active;
  const base = (s && s.baseFov != null) ? s.baseFov : fallback;
  if (base == null) return null;
  return fitFov(base, cam.aspect);
}

function restoreMainZoom() {
  if (!camera || mainZoom.baseFov == null) return;
  const fov = restingFov(camera, mainZoom.baseFov);
  if (fov != null) {
    camera.fov = fov;
    camera.updateProjectionMatrix();
  }
  mainZoom.baseFov = null;
  mainZoom.back = 0;
  mainZoom.targetBack = 0;
  mainZoom.prevPos = null;
}

function updateBackIcon() {
  if (!backEl) return;
  if (active && active.name === "MAIN") {
    // the zoom toggle zooms OUT (wider FOV + camera pulls back), so the resting
    // state shows a down arrow ("Zoom out"); once zoomed out it flips to an up
    // arrow ("Zoom back in").
    renderDotMatrixArrow(backEl, mainZoom.on ? "up" : "down");
    backEl.title = mainZoom.on ? "Zoom back in" : "Zoom out";
  } else {
    renderDotMatrixArrow(backEl, "back");
    backEl.title = "Back to main menu";
  }
}

function updateBackControl() {
  // re-entering MAIN always restarts at the normal shot
  if (active && active.name === "MAIN" && mainZoom.on) {
    mainZoom.on = false;
    restoreMainZoom();
  }
  updateBackIcon();
  if (ctrls) ctrls.classList.toggle("toris", !!(active && active.name === "TORIS"));
}

// MAIN's zoom-out button stays HIDDEN through the camera fly-in and only appears
// once the shot has reached MAIN_BACK_AFTER_FRAME, blinking once as it arrives.
const MAIN_BACK_AFTER_FRAME = 450;
let mainBackShown = false;

// the interactive menu planes ("ATM buttons") stay LOCKED until the zoom-out
// button UI is up: no clicks, no hover glow, no hover slowdown before the MAIN
// camera passes MAIN_BACK_AFTER_FRAME
function mainControlsActive() {
  return !!(active && active.name === "MAIN" && active.camT * CAM_FPS >= MAIN_BACK_AFTER_FRAME);
}

function updateMainBackVisible() {
  if (!backEl) return;
  const cardOpen = typeof isContactCardOpen === "function" && isContactCardOpen();
  if (active && active.name === "MAIN" && !cardOpen) {
    if (active.camT * CAM_FPS >= MAIN_BACK_AFTER_FRAME) {
      if (!mainBackShown) {
        mainBackShown = true;
        // the controls just unlocked: triple-flash the ATM buttons so they
        // read as interactive
        triggerMenuFlash();
        backEl.style.display = "";
        backEl.classList.remove("dotarrow-flash");
        void backEl.offsetWidth;
        backEl.classList.add("dotarrow-flash");
      }
    } else {
      backEl.style.display = "none";
    }
  } else if (cardOpen) {
    // the contact card has its own 2x2 contact pad in this spot
    mainBackShown = false;
    backEl.style.display = "none";
  } else {
    mainBackShown = false;
    backEl.style.display = "";
  }
}

// The down arrow is shown ONLY while the camera is inside an interactable
// object: ART's laptop (`art.interacted`) or MUSIC's stereo/radio
// (`music.interacted`). It is hidden during a turn, during a reacquire and
// while the MUSIC zoom-out exit is still playing, so it never appears on a
// frame where pressing it would do nothing. It blinks once on arrival, the
// same entrance blink every other arrow button gets.
function updateZoomOutButton() {
  if (!zoomOutEl) return;
  let inside = false;
  if (!turn && !reacquire && active && !isContactCardOpen()) {
    if (active.name === "ART") inside = !!art.interacted;
    else if (active.name === "MUSIC") inside = !!music.interacted && !music.exiting;
  }
  const was = !zoomOutEl.hidden;
  zoomOutEl.hidden = !inside;
  if (inside && !was) {
    zoomOutEl.classList.remove("dotarrow-flash");
    void zoomOutEl.offsetWidth;
    zoomOutEl.classList.add("dotarrow-flash");
  } else if (!inside) {
    zoomOutEl.classList.remove("dotarrow-flash");
  }
}

// The mute button lives in MAIN only - it's the room where the ambient bed is
// loud, so it's the room where you'd reach for it. Shown once MAIN's fly-in has
// settled (same MAIN_BACK_AFTER_FRAME gate the back button and the ATM menu
// use), so it doesn't sit over the opening shot, and hidden whenever the
// contact card is up (that overlay owns the screen) or a turn is running.
function updateMuteButton() {
  if (!muteEl) return;
  // Repaint first, and from the audio state rather than from the click: the
  // button used to be repainted only inside its own click handler, which meant
  // any other path to the same state (the debug hook, a future keyboard
  // shortcut) muted the site while leaving the speaker glyph lit. Deriving the
  // glyph here every frame makes that class of drift impossible.
  paintMuteButton();
  const show = !!(active && active.name === "MAIN" && !turn && !isContactCardOpen()
    && active.camT * CAM_FPS >= MAIN_BACK_AFTER_FRAME);
  const was = !muteEl.hidden;
  muteEl.hidden = !show;
  if (show && !was) {
    muteEl.classList.remove("dotarrow-flash");
    void muteEl.offsetWidth;
    muteEl.classList.add("dotarrow-flash");
  } else if (!show) {
    muteEl.classList.remove("dotarrow-flash");
  }
}

// Keep the glyph honest: the speaker when sound is on, the crossed speaker when
// the site is silenced, and the title/aria say which pressing it will do. Only
// repaints when the state actually changes (see mutePainted above) - this runs
// every frame.
function paintMuteButton() {
  if (!muteEl) return;
  const muted = radioPlayer.isMuted();
  if (muted === mutePainted) return;
  mutePainted = muted;
  renderDotMatrixArrow(muteEl, muted ? "muted" : "sound");
  muteEl.title = muted ? "Unmute" : "Mute";
  muteEl.setAttribute("aria-label", muted ? "Unmute all sound" : "Mute all sound");
  muteEl.setAttribute("aria-pressed", muted ? "true" : "false");
}

/* ------------------------------------------------------------------ */
/*  INTRODUCTORY LANGUAGE CHOICE — English / Spanish                   */
/*                                                                     */
/*  On the very first entrance to MAIN the camera flies the intro and  */
/*  boomerangs through the first LANG_LOOP_FRAME frames of the BUS behind   */
/*  a dot-matrix picker mirrored in the middle of the screen inside a blue  */
/*  picker mirrored in the middle of the screen inside a blue LED-display  */
/*  cabinet: a 5x7 LED badge line (LANGUAGE / LENGUAJE) over a fat line   */
/*  (EspaÃ±ol, left), a `/`, US (English, right) — all binary, no color.*/
/* ------------------------------------------------------------------ */
const LANG_LOOP_FRAME = 50;   // BUS boomerang range played behind the picker
const LANG_LOOP_SPEED = 0.7;  // 30% slower while the picker is up
const LANG_SKIP_FRAME = 150;  // cut target once long enough to have reached 250
const LANG_SKIP_DELAY = 4;    // seconds at the picker before that skip is allowed
const LANG_CHOICE_DEFAULT = "es";
let portfolioLang = null;
const langChoice = { pending: true, shown: false, chosen: false, t: 0 };

// data-uri SVG helpers (same LED-dot look as the arrow buttons)
function svgCirc(c, r, rad, fill) {
  return '<circle cx="' + c + '" cy="' + r + '" r="' + rad + '" fill="' + fill + '"/>';
}
function svgDataURI(w, h, dots) {
  return "data:image/svg+xml;charset=utf-8," +
    encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + " " + h + '">' + dots + "</svg>");
}
function rowsDataURI(rows, radius) {
  const R = rows.length, C = rows[0].length;
  let dots = "";
  for (let r = 0; r < R; r++) {
    for (let c = 0; c < C; c++) {
      if (rows[r][c] === "#") dots += svgCirc(c, r, radius, "#ffffff");
    }
  }
  return svgDataURI(C, R, dots);
}

/* ------------------------------------------------------------------ */
/*  LANGUAGE SELECTOR LED UNITS — every dot matrix in this picker      */
/*  (flags, badge, slash) uses the SAME LED size: LANG_CELL px per     */
/*  grid unit and LANG_DOT_RADIUS in unit fractions. All dots render   */
/*  at LANG_CELL * (2 * LANG_DOT_RADIUS) px everywhere.                */
/* ------------------------------------------------------------------ */
const LANG_CELL = 4;           // px per LED grid unit (identical px density)
const LANG_DOT_RADIUS = 0.24;  // radius in units -> 1.92px LED diameter

/* ------------------------------------------------------------------ */
/*  FLAG GENERATORS — SAME low-res grid for both flags (FLAG_SIZE      */
/*  square, 20x20). Stars are SINGLE DOTS — that's the resolution      */
/*  indicator. Binary (white dots only), negative treatment ("color"   */
/*  = lit, flag white = dark holes). TWEAK HERE to reshape either      */
/*  flag; the grid unit is LANG_CELL so the LEDs match the badge.      */
/* ------------------------------------------------------------------ */
const FLAG_SIZE = 20;    // both flags render on the SAME 20x20 grid
const FLAG_DOT = LANG_DOT_RADIUS; // same LED radius as badge + slash

function makeGrid(C, R) {
  const g = [];
  for (let r = 0; r < R; r++) g.push(new Array(C).fill(false));
  return g;
}
function fillRows(g, a, b, on) {
  for (let r = a; r <= b; r++) for (let c = 0; c < g[r].length; c++) g[r][c] = on;
}
function dot(g, x, y, on) {
  if (x >= 0 && x < g[0].length && y >= 0 && y < g.length) g[y][x] = on;
}
function flagRowsToURI(g, radius) {
  const C = g[0].length, R = g.length;
  let dots = "";
  for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) {
    if (g[r][c]) dots += svgCirc(c, r, radius, "#ffffff");
  }
  return svgDataURI(C, R, dots);
}

// Venezuela: three equal bands (yellow / blue / red) kept apart by one dark
// separator row, 8 single-dot stars in a RAINBOW arc (middle high, ends low
// = _--''--_), carved dark out of the blue band (negative)
function venezuelaRows() {
  const g = makeGrid(FLAG_SIZE, FLAG_SIZE);
  const band = 6; // 6 + 1 + 6 + 1 + 6 = 20
  fillRows(g, 0, band - 1, true);              // yellow band rows 0..5
  fillRows(g, band + 1, band + band, true);    // blue band rows 7..12
  fillRows(g, band + band + 2, FLAG_SIZE - 1, true); // red band rows 14..19
  const cy = Math.floor((band + 1 + band + band) / 2); // blue band centre (10)
  const amp = 2;
  for (let i = 0; i < 8; i++) {
    const t = i / 7;
    const x = Math.round(3 + t * 14);              // 3..17 across the flag
    const y = cy + Math.round(amp * (1 - 2 * Math.sin(Math.PI * t))); // ends low, middle high
    dot(g, x, y, false);
  }
  return g;
}

// US: 13 alternating lit/dark stripes (even stripes 2 rows, odd stripes 1
// row -> 20), dark canton (8 x 14) with SINGLE-DOT stars in a grid
function usRows() {
  const g = makeGrid(FLAG_SIZE, FLAG_SIZE);
  let row = 0;
  for (let s = 0; s < 13; s++) {
    const h = s % 2 === 0 ? 2 : 1; // 7 x 2 + 6 x 1 = 20
    fillRows(g, row, row + h - 1, s % 2 === 0);
    row += h;
  }
  const cantW = 8, cantH = 14; // 7 stripes tall, 40% wide
  for (let r = 0; r < cantH; r++) for (let c = 0; c < cantW; c++) g[r][c] = false;
  const xs = [2, 4, 6];
  for (let sr = 0; sr < 4; sr++) {
    const yr = 2 + sr * 3; // 2, 5, 8, 11
    for (let i = 0; i < xs.length; i++) dot(g, xs[i], yr, true);
  }
  return g;
}

function flagDataURI(lang) {
  return flagRowsToURI(lang === "es" ? venezuelaRows() : usRows(), FLAG_DOT);
}

// 5x7 LED badge (LANGUAGE / IDIOMA) in the same white-dot font as the
// "THIS IS A PORTFOLIO" bubble. `padChars` pads the word with blank glyph
// cells so both words render on the SAME fixed grid — same dot size, same
// footprint (IDIOMA is centered instead of rendered smaller than LANGUAGE).
function ledBadgeDataURI(text, padChars) {
  let txt = String(text).toUpperCase();
  if (padChars && txt.length < padChars) {
    const extra = padChars - txt.length;
    const left = Math.floor(extra / 2);
    txt = " ".repeat(left) + txt + " ".repeat(extra - left);
  }
  const grid = [];
  for (let gy = 0; gy < 7; gy++) {
    let row = "";
    for (let i = 0; i < txt.length; i++) {
      const ch = txt[i];
      if (ch === " ") { row += "...."; continue; }
      const g = FONT5x7[ch];
      if (!g) { row += "...."; continue; }
      for (let gx = 0; gx < 5; gx++) row += g[gy][gx];
      row += ".";
    }
    grid.push(row);
  }
  return rowsDataURI(grid, LANG_DOT_RADIUS);
}

const LANG_SLASH = [
  "........#",
  ".......#.",
  "......#..",
  ".....#...",
  "....#....",
  "...#.....",
  "..#......",
  ".#.......",
  "#........",
];

// fixed badge grid: 8 glyph cells (LANGUAGE) tall enough for IDIOMA, each
// glyph cell 6 dots wide, each dot LANG_CELL px
const LANG_BADGE_CHARS = 8;

function setLangBadge(lang) {
  if (!langBadgeEl) return;
  const word = lang === "en" ? "LANGUAGE" : "LENGUAJE";
  langBadgeEl.style.backgroundImage = "url(\"" + ledBadgeDataURI(word, LANG_BADGE_CHARS) + "\")";
  langBadgeEl.style.width = (LANG_BADGE_CHARS * 6 * LANG_CELL) + "px";
  langBadgeEl.style.height = (7 * LANG_CELL) + "px";
  langBadgeEl.setAttribute("aria-label", word);
}

function showLangChoice() {
  if (langChoice.shown || !langChoiceEl) return;
  langChoice.shown = true;
  langChoiceEl.classList.add("show");
}

function chooseLanguage(lang) {
  if (langChoice.chosen) return;
  langChoice.chosen = true;
  langChoice.pending = false;
  portfolioLang = lang;
  window.__PORTFOLIO_LANG__ = lang;
  if (langChoiceEl) langChoiceEl.classList.remove("show");
  // If the player already spent ~enough time to have reached the walk, cut
  // straight to frame LANG_SKIP_FRAME (a natural handover into frame 250) so
  // he's not standing there. Otherwise the intro just resumes and reaches the
  // walk on its own.
  if (active && active.name === "MAIN" && langChoice.t >= LANG_SKIP_DELAY) {
    const cut = LANG_SKIP_FRAME / CAM_FPS;
    if (active.camT < cut) active.camT = cut;
    // bring the scene animation (bus, player) to the same cut so the pose
    // matches the camera — player mid-walk instead of standing at the bus.
    for (let i = 0; i < active.mixers.length; i++) active.mixers[i].setTime(cut);
  }
  // this click is the user gesture that unlocks the AudioContext, so the radio
  // starts here: the bed takes FADE_IN_SEC seconds to ease up to its 20% ambient
  // level, then holds there until the MUSIC room crescendos it to full
  radioPlayer.startAmbient();
  paintMuteButton();
  console.log("[lang] chosen:", lang);
}

// per-frame MAIN driver: reveals the picker and, while it's up, holds the
// camera to a "boomerang" — the BUS's first LANG_LOOP_FRAME frames played
// forward, then back down, at 30% slower than real time. The picker never
// lets the intro drive past frame 50. Choosing a language releases the hold;
// chooseLanguage handles the frame-230 cut when the wait was long enough.
function stepLangChoice(dt) {
  if (!active || active.name !== "MAIN") return;
  if (langChoice.chosen) return;
  if (langChoice.pending) showLangChoice();
  if (!langChoice.shown) return;
  langChoice.t += dt;

  // slide forward through 0..loopEnd, then mirror back (boomerang), slowed 30%
  const loopEnd = LANG_LOOP_FRAME / CAM_FPS;
  const p = (langChoice.t * LANG_LOOP_SPEED) % (loopEnd * 2);
  active.camT = p > loopEnd ? loopEnd * 2 - p : p;
  // the BUS itself is driven by the scene AnimationMixers (real-time, separate
  // from camT), so pin them to the same boomerang clock or the bus drives away.
  for (let i = 0; i < active.mixers.length; i++) active.mixers[i].setTime(active.camT);

  const t = langChoice.t;
  const n = active.camNode;
  n.position.y += Math.sin(t * 1.7) * 0.035;
  n.position.z += Math.sin(t * 0.85) * 0.012;
  n.rotateZ(Math.sin(t * 0.9) * 0.005);
}

// build flag / separator data URIs + wire the picker once (module init)
(function initLangChoice() {
  if (langEsEl) langEsEl.style.backgroundImage = "url(\"" + flagDataURI("es") + "\")";
  if (langEnEl) langEnEl.style.backgroundImage = "url(\"" + flagDataURI("en") + "\")";
  if (langSepEl) langSepEl.style.backgroundImage = "url(\"" + rowsDataURI(LANG_SLASH, LANG_DOT_RADIUS) + "\")";
  setLangBadge(LANG_CHOICE_DEFAULT);
  if (langEsEl) {
    langEsEl.addEventListener("pointerenter", function () { setLangBadge("es"); });
    langEsEl.addEventListener("click", function () { chooseLanguage("es"); });
  }
  if (langEnEl) {
    langEnEl.addEventListener("pointerenter", function () { setLangBadge("en"); });
    langEnEl.addEventListener("click", function () { chooseLanguage("en"); });
  }
})();

// the zoom-out driver: ease the lens toward 2x FOV and glide the camera back
// along its local +Z (straight back down the view) at a slow 20% rate until it
// reaches the target pull. When the toggle turns off it eases both back to the
// authored shot. The target/scale are captured once on toggle-on so every frame
// resolves to the same endpoint (stable), while the fly-through animation keeps
// driving the camera pose — the pull is just an offset on top of it.
function applyMainZoom(dt) {
  if (!camera || mainZoom.baseFov == null) return;
  const base = mainZoom.baseFov;

  // 1) widen the lens (and narrow it back on exit). `base` is the AUTHORED
  //    fov, so both the resting shot and the zoomed-out shot go back through
  //    fitFov and pick up the same small portrait widening — a phone and a
  //    desktop then zoom out by the same 2x from the same starting point.
  const restFov = fitFov(base, camera.aspect);
  const fovTarget = fitFov(base * (mainZoom.on ? MAIN_ZOOM_FOV : 1), camera.aspect);
  if (Math.abs(camera.fov - fovTarget) > 0.01) {
    camera.fov += (fovTarget - camera.fov) * Math.min(1, dt * MAIN_ZOOM_FOV_RATE);
    camera.updateProjectionMatrix();
  }

  // 2) dolly: move the camera BACK at 20% of the fly-through's world speed
  camera.updateMatrixWorld(true);
  camera.getWorldPosition(_v2);
  let worldSpeed = 0;
  if (mainZoom.prevPos) worldSpeed = _v2.distanceTo(mainZoom.prevPos) / Math.max(dt, 1e-4);
  mainZoom.prevPos = _v2.clone();
  const targetDepth = mainZoom.on ? mainZoom.targetBack : 0;
  const diff = targetDepth - mainZoom.back;
  if (Math.abs(diff) > 0.0005) {
    const step = Math.max(MAIN_ZOOM_SPEED * worldSpeed, MAIN_ZOOM_MIN_SPEED) * dt;
    if (Math.abs(diff) <= step) mainZoom.back = targetDepth;
    else mainZoom.back += Math.sign(diff) * step;
  } else {
    mainZoom.back = targetDepth;
  }

  if (mainZoom.back > 0.0005) {
    camera.updateMatrixWorld(true);
    camera.getWorldPosition(_v2);
    camera.getWorldQuaternion(_lq);
    const m = camera.matrixWorld.elements;
    _dirV.set(m[8], m[9], m[10]).normalize(); // world +Z: straight back down the view
    _cwp.copy(_v2).addScaledVector(_dirV, mainZoom.back);
    // strafe the camera's local RIGHT by a fraction of the pull so the zoomed
    // view no longer stays dead-center on the same point
    const s = mainZoom.back * MAIN_ZOOM_RIGHT_FRAC;
    _cwp.x += m[0] * s;
    _cwp.y += m[1] * s;
    _cwp.z += m[2] * s;
    setNodeWorld(camera, _cwp, _lq);
  } else if (!mainZoom.on && mainZoom.back === 0 && Math.abs(camera.fov - restFov) < 0.05) {
    camera.fov = restFov;
    camera.updateProjectionMatrix();
    mainZoom.baseFov = null;
    mainZoom.targetBack = 0;
    mainZoom.prevPos = null;
  }
  mainZoom.frames++;
}

function updateMixers(dt) {
  if (active) {
    for (let i = 0; i < active.mixers.length; i++) active.mixers[i].update(dt);
  }
  if (turn && turn.to !== active) {
    for (let i = 0; i < turn.to.mixers.length; i++) turn.to.mixers[i].update(dt);
  }
}

// The CONTACT card's open/close edges, as breadcrumbs. Everything the card does
// happens inside its own module and its own render pass, so the server log used
// to see nothing at all when a device reported "the card doesn't appear" — the
// heartbeat said MAIN, which is true and useless. One line per edge, carrying
// the card's own state, turns that into an answer: if a device logs
// card-open -> card-state OPEN with onScreen true and the user still sees
// nothing, the fault is in the composite pass and not in the card.
let cardWasOpen = false;
function logContactCardEdge() {
  const open = isContactCardOpen();
  if (open === cardWasOpen) return;
  cardWasOpen = open;
  const d = contactDebug();
  crashLogNote("card", {
    edge: open ? "open" : "close",
    state: d.state,
    loaded: d.loaded,
    failed: d.failed ? String(d.failed).slice(0, 60) : null,
    pending: d.pendingOpen,
    fitDist: d.fitDist,
    onScreen: d.screen ? d.screen.onScreen : null,
    rect: d.screen ? d.screen.w + "x" + d.screen.h : null,
    blur: d.blur,
    lite: perf.lite,
    tier: perf.name,
  });
  // the GLB lands after the click, so "opened" and "actually ready" are two
  // different moments and only the second one means anything
  if (open && !d.loaded) {
    const wait = setInterval(function () {
      const s = contactDebug();
      if (s.loaded || s.failed) {
        clearInterval(wait);
        crashLogNote("card", {
          edge: s.loaded ? "loaded" : "load-failed",
          failed: s.failed ? String(s.failed).slice(0, 60) : null,
          modelW: s.modelWidth,
          modelH: s.modelHeight,
          fitDist: s.fitDist,
          onScreen: s.screen ? s.screen.onScreen : null,
          rect: s.screen ? s.screen.w + "x" + s.screen.h : null,
        });
      }
    }, 250);
  }
}

function loop() {
  if (!running) return;
  requestAnimationFrame(loop);

  const dt = Math.min(clock.getDelta(), 0.1);

  // ADAPTIVE QUALITY: sample the frame first, then push whatever tier it
  // settled on into the renderer. Only re-allocates the drawing buffer when
  // the tier actually changed, so a steady frame rate costs one number compare.
  const wasTier = perf.tier;
  perf.frame(dt);
  if (perf.tier !== wasTier) {
    renderer.setPixelRatio(perf.pixelRatio());
    renderer.setSize(window.innerWidth, window.innerHeight);
    // lite mode also drops the CONTACT card's blurred backdrop (which renders
    // the whole room a second time into a full-res target every frame) and
    // throttles the two dot-matrix displays, whose canvas repaint + texture
    // upload is the other unbounded per-frame cost in the build
    setContactCardLite(perf.lite);
    setRadioDisplayLite(perf.lite);
    setMainDisplayLite(perf.lite);

// start the crash/heartbeat reporter before anything else can throw, so a
// failure during the very first scene load is still captured
initCrashLog();
    console.log("[perf] tier -> " + perf.name + " (" + perf.fps.toFixed(0) +
      "fps, pixel ratio " + perf.pixelRatio().toFixed(2) + ", lite " + perf.lite + ")");
  }

  if (debugPaused) {
    if (camera) {
      scene.updateMatrixWorld(true);
      renderer.render(scene, camera);
    }
    return;
  }

  updateMixers(dt);
  ensureSmokeApplied();
  // in lite mode the canvas-backed animated textures are frozen at their
  // current frame: each one is a CPU canvas paint plus a full texture upload
  // EVERY frame, which is the single most expensive thing in the loop on a
  // weak GPU and is invisible in a still frame
  if (!perf.lite) {
    stepFlyTexture(dt);
    stepSmokeTexture(dt);
  }
  stepSkylightPulse(dt);

  // smooth hover damping: glide toward "damped" while the cursor is over a
  // menu, back to full speed when it leaves
  const hoverNow = forceHover !== null
    ? forceHover
    : (!!lastHoverName && active && active.name === "MAIN" && !turn);
  focus.level += ((hoverNow ? 1 : 0) - focus.level) * Math.min(1, dt * 5);

  if (turn) {
    turn.t += dt;
    const p = Math.min(1, turn.t / turn.dur);
    const e = p * p * (3 - 2 * p);
    scene.updateMatrixWorld(true);
    // swing the camera in place around its own up axis (deterministic
    // direction: turn.dir) — a plain POV head-turn, no positional glide
    _quatW.copy(turn.q0).multiply(_qAxis.setFromAxisAngle(_upAxis, turn.dir * Math.PI * e));
    setNodeWorld(camera, turn.pos, _quatW);
    if (p >= 0.5 && !turn.swapped) {
      turn.swapped = true;
      turn.from.root.visible = false;
      turn.to.root.visible = true;
    }
    if (p >= 1) finishTurn();
  } else if (reacquire) {
    stepReacquire(dt);
  } else if (active) {
    let settling = false;
    if (retrackNext) {
      retrackNext = false;
      settling = retrackActive();
    }
    if (!settling) {
      stepCamera(dt, active);
      if (active.name === "MAIN" && horror.ready) stepHorror(dt);
      else if (active.name === "CLOTHES" && clothesHorror.ready) stepClothesHorror(dt);
    }
  }

  if (camera) {
    if (!turn && !reacquire) applyParallax(dt);
    scene.updateMatrixWorld(true);
    if (active && active.name === "MAIN" && !turn && !reacquire) applyMainZoom(dt);
    if (active && active.name === "MAIN") updateMenus(dt);
    else if (active && active.name === "MUSIC") {
      updateMusic(dt, perf.lite ? MUSIC_HOVER_HZ_LITE : MUSIC_HOVER_HZ);
      stepMusicFlash();
    }
    else if (active && active.name === "ART") updateArt(dt);
    else if (active && active.name === "CLOTHES") updateClothesInteractions(dt);
    else if (active && active.name === "TORIS") updateTorisHover(dt);
    stepLangChoice(dt);
    stepContactCard(dt);
    logContactCardEdge();
    updateMainBackVisible();
    updateZoomOutButton();
    updateMuteButton();
    // the calling card renders in its own pass (blurred room + sharp card)
    // so it always sits above the scene geometry
    if (isContactCardOpen()) renderContactCardComposite(scene, camera);
    else renderer.render(scene, camera);
  }
}

// one place that re-reads the viewport and pushes it into everything that
// cares: the renderer, the PORTRAIT FIT level, and EVERY scene camera (not just
// the active one — a scene that is loaded but not on screen still has to be
// framed for the current aspect before it is ever rendered, and the handover
// placement math reads the target's fov/aspect)
function syncViewport() {
  const w = Math.max(1, window.innerWidth);
  const h = Math.max(1, window.innerHeight);
  // the pixel ratio now comes from perf.js, so a resize honours whatever tier
  // the adaptive watchdog has settled on as well as the device's own ratio
  renderer.setPixelRatio(perf.pixelRatio());
  renderer.setSize(w, h);
  fit.aspect = w / h;
  fit.level = portraitLevel(fit.aspect);
  Object.keys(scenes).forEach(function (k) {
    applySceneFit(scenes[k]);
  });
  // the CONTACT strip is laid out in px from its LED cell count, so it needs
  // the same resize pass to re-measure (it crops the "MENSAJE DIRECTO" label
  // if it keeps a width sized for a wider viewport)
  resyncContactCardLayout();
  // a fit change can land in the middle of the MAIN zoom-out glide; the eased
  // FOV is re-targeted every frame anyway, so just make sure the resting shot
  // is what it would have been
  if (mainZoom.baseFov != null && camera) {
    const fov = restingFov(camera, mainZoom.baseFov);
    if (fov != null) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
  }
}

window.addEventListener("resize", function () {
  syncViewport();
});

// mobile browsers resize the viewport when the URL bar collapses / the on-screen
// keyboard opens, and `resize` alone can miss a bare rotation, so the visual
// viewport gets the same treatment
if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", function () { syncViewport(); });
}

document.addEventListener("visibilitychange", function () {
  running = !document.hidden;
  if (running) {
    clock.getDelta(); // discard stale delta
    requestAnimationFrame(loop);
  }
});

// debug hooks for CDP-driven verification
function countMeshes(obj) {
  let n = 0;
  obj.traverse(function (o) { if (o.isMesh) n++; });
  return n;
}
window.__viewer = {
  goToScene: goToScene,
  contact: function () { return contactDebug(); },
  // Raw handles, for CDP harnesses. `sceneRoots` is what lets a harness
  // replicate three.js's own transparent draw order (groupOrder, then
  // Object3D.renderOrder, then bounding-sphere depth) instead of guessing at it
  // from pixels — the mural dropouts in stabilizeDecals were only separable
  // from a camera move that way. See muralsort.js / muralab.js.
  THREE: THREE,
  sceneRoots: scenes,
  get camera() { return camera; },
  // The CONTACT card is the one thing on the site that renders in its OWN pass
  // over the room, and "it doesn't show" has therefore never been diagnosable
  // from a screenshot: the card's own state reports healthy whether or not a
  // single pixel of it reaches the glass. These two make the failure legible —
  // `cardBrief` rides every heartbeat, and the edge watcher below writes one
  // breadcrumb per open/close so the log can say "opened, GLB loaded, reached
  // OPEN at fitDist X" instead of just "was in MAIN".
  cardBrief: function () {
    var d = contactDebug();
    var size = renderer.getDrawingBufferSize(new THREE.Vector2());
    return {
      state: d.state,
      loaded: d.loaded,
      failed: d.failed ? String(d.failed).slice(0, 60) : null,
      rigVisible: d.rigVisible,
      fitDist: d.fitDist,
      modelW: d.modelWidth,
      modelH: d.modelHeight,
      aspect: d.aspect,
      fov: d.fov ? +(+d.fov).toFixed(2) : null,
      blur: d.blur,
      rt: d.rt ? d.rt.join("x") : null,
      buffer: Math.round(size.x) + "x" + Math.round(size.y),
      ratio: perf.pixelRatio(),
      // is the card's own geometry actually inside the frame the renderer will
      // show? onScreen false with state OPEN is the signature of a framing
      // failure; onScreen true with nothing visible is the signature of a
      // compositing failure. They need different fixes, so they are separated.
      onScreen: d.screen ? d.screen.onScreen : null,
      rect: d.screen ? d.screen.w + "x" + d.screen.h : null,
    };
  },
  // open/close the CONTACT card directly. The real entry point is a click on
  // the ATM's CONTACT plane, which needs the menu to be unlocked (camera frame
  // 450) and the ray to hit a ~13mm label — neither of which a headless
  // harness can aim reliably, so the card could only ever be inspected by hand.
  openContact: function () { openContactCard(camera); return true; },
  closeContact: function (instant) { closeContactCard(instant); return true; },
  get state() { return active ? active.name : null; },
  get turning() { return turn !== null; },
  get reacquiring() { return reacquire !== null; },
  get reacquireState() {
    return reacquire
      ? {
          from: reacquire.from,
          to: reacquire.to,
          t: +reacquire.t.toFixed(3),
          dur: reacquire.dur,
          p: +Math.min(1, reacquire.t / reacquire.dur).toFixed(3),
        }
      : null;
  },
  get camConfig() { return JSON.parse(JSON.stringify(SCENE_CAM)); },
  get handoff() { return handoffInfo; },
  get returned() { return returnInfo; },
  get turnState() {
    return turn
      ? {
          from: turn.from.name,
          to: turn.to.name,
          t: +turn.t.toFixed(3),
          dur: turn.dur,
          p: +Math.min(1, turn.t / turn.dur).toFixed(3),
          dir: turn.dir,
          swapped: turn.swapped,
        }
      : null;
  },
  get scenes() {
    return Object.keys(scenes).map(function (k) {
      return {
        name: scenes[k].name,
        state: scenes[k].state,
        camNode: scenes[k].camNode ? scenes[k].camNode.name : null,
        hasPos: !!scenes[k].posTrack,
        hasRot: !!scenes[k].rotTrack,
        focal: scenes[k].focal ? [+scenes[k].focal.x.toFixed(3), +scenes[k].focal.y.toFixed(3), +scenes[k].focal.z.toFixed(3)] : null,
      };
    });
  },
  tracks: function (name) {
    const s = scenes[name];
    if (!s || !s.gltf) return [];
    const out = [];
    s.gltf.animations.forEach(function (c) {
      c.tracks.forEach(function (t) { out.push(c.name + " :: " + t.name); });
    });
    return out;
  },
  get camWorld() {
    if (!camera) return null;
    _cwp.setFromMatrixPosition(camera.matrixWorld);
    return { x: _cwp.x, y: _cwp.y, z: _cwp.z };
  },
  get camQuat() {
    if (!camera) return null;
    camera.getWorldQuaternion(_qI);
    return { x: _qI.x, y: _qI.y, z: _qI.z, w: _qI.w };
  },
  get camForward() {
    if (!camera) return null;
    camera.getWorldQuaternion(_qI);
    const q = _qI;
    return {
      x: 2 * (q.x * q.z + q.w * q.y),
      y: 2 * (q.y * q.z - q.w * q.x),
      z: q.w * q.w - q.x * q.x - q.y * q.y + q.z * q.z,
    };
  },
  get camLocal() {
    if (!camera) return null;
    return { x: camera.position.x, y: camera.position.y, z: camera.position.z };
  },
  get horrorLevels() {
    const pick = function (a) {
      return a.length ? { v: +a[0].m.emissiveIntensity.toFixed(4), base: +a[0].base.toFixed(4) } : null;
    };
    return {
      full: pick(horror.full),
      half: pick(horror.half),
      atm: pick(horror.atm),
      bus: pick(horror.bus),
      t: horror.t,
      level: horror.level,
      inDip: horror.inDip,
      inBlip: horror.inBlip,
      until: horror.until,
    };
  },
  get clothesHorrorLevels() {
    if (!clothesHorror.ready || !clothesHorror.list.length) return null;
    const e = clothesHorror.list[0];
    return {
      count: clothesHorror.list.length,
      v: e.emissive ? +e.m.emissiveIntensity.toFixed(4) : +e.m.color.r.toFixed(4),
      base: e.emissive ? +e.base.toFixed(4) : +e.baseColor.r.toFixed(4),
      t: +clothesHorror.t.toFixed(3),
      level: +clothesHorror.level.toFixed(3),
      inDip: clothesHorror.inDip,
      inBlip: clothesHorror.inBlip,
      until: +clothesHorror.until.toFixed(3),
    };
  },
  get hoverLevel() { return +focus.level.toFixed(3); },
  // ADAPTIVE QUALITY: the whole picture in one object — which tier we are on,
  // what the hardware probe said, the measured frame rate, and the levers the
  // watchdog can pull. Read this on the tablet to see WHY it settled where it
  // did; setTier(n) forces a tier by hand for A/B comparison.
  get perfInfo() { return perf.info(); },
  setPerfTier: function (n) { perf.setTier(n); return perf.info(); },
  // force lite mode on/off by hand. The lite branches are only reachable on a
  // device the watchdog has already downgraded, so a harness has to be able to
  // switch them on directly to test them at all.
  __setLite: function (on) {
    const l = !!on;
    setContactCardLite(l);
    setRadioDisplayLite(l);
    setMainDisplayLite(l);
    return l;
  },
  // drive the ATM hover directly. The labels are ~13mm planes in a moving 3D
  // scene, so a headless harness cannot reliably aim a synthetic cursor at
  // one — and this is the entry point the dissolve actually hangs off.
  __hover: function (name) {
    lastHoverName = null;
    setOverlayHover(name);
    return name;
  },
  // the live camera, for a headless harness that has to reason in the camera's
  // own frame (the CONTACT card is composited over the room, so what stands
  // between the lens and the card is what decides whether it is visible)
  get __camera() { return camera; },
  get __THREE() { return THREE; },
  // what the crash reporter believes about this session (see js/crashlog.js)
  get crashLog() { return crashLogState(); },
  // the raw renderer, for a headless diagnostic harness to read resource
  // counts and the live GPU texture list out of (diag.js)
  get __renderer() { return renderer; },
  // the live camera + scene, so a harness can ask what actually stands between
  // the lens and a given distance. The CONTACT card is composited after the
  // room in lite mode, so anything nearer than the card is what hides it.
  get __camera() { return camera; },
  get __scene() { return scene; },
  get __THREE() { return THREE; },
  // PORTRAIT FIT state: the viewport aspect, how portrait it is, and the lens
  // each loaded scene renders with. `fov - baseFov` is the portrait widening
  // and should read 0 on any landscape screen.
  get fitInfo() {
    return {
      aspect: +fit.aspect.toFixed(4),
      level: +fit.level.toFixed(4),
      ref: PORTRAIT_REF_ASPECT,
      fovWiden: PORTRAIT_FOV_WIDEN,
      backMax: PORTRAIT_BACK_MAX,
      shiftRight: PORTRAIT_SHIFT_RIGHT,
      scene: camera && active ? active.name : null,
      fov: camera ? +camera.fov.toFixed(2) : null,
      baseFov: active ? (active.baseFov == null ? null : +active.baseFov.toFixed(2)) : null,
      // horizontal angle actually in effect, and the landscape reference it is
      // measured against — the gap is what the pullback + shift make up for
      hFovDeg: camera
        ? +(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * camera.aspect) * 180 / Math.PI).toFixed(2)
        : null,
      hFovRefDeg: active && active.baseFov != null
        ? +(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(active.baseFov) / 2) * PORTRAIT_REF_ASPECT) * 180 / Math.PI).toFixed(2)
        : null,
    };
  },
  // force a viewport aspect (CDP harness emulating a phone): re-runs syncViewport
  // against a stand-in size so portrait behaviour can be checked on desktop
  setViewportAspect: function (aspect) {
    if (!(aspect > 0)) return fit.aspect;
    const w = 1000, h = w / aspect;
    renderer.setSize(w, h);
    fit.aspect = aspect;
    fit.level = portraitLevel(aspect);
    Object.keys(scenes).forEach(function (k) { applySceneFit(scenes[k]); });
    if (mainZoom.baseFov != null && camera) {
      const fov = restingFov(camera, mainZoom.baseFov);
      if (fov != null) {
        camera.fov = fov;
        camera.updateProjectionMatrix();
      }
    }
    return fit.aspect;
  },
  get camProps() {
    if (!camera) return null;
    return { fov: +camera.fov.toFixed(2), near: camera.near, far: camera.far, aspect: +camera.aspect.toFixed(3) };
  },
  get parallaxInfo() {
    return { yaw: PARALLAX_YAW, pitch: PARALLAX_PITCH, shiftX: PARALLAX_SHIFT_X, shiftY: PARALLAX_SHIFT_Y };
  },
  get camT() { return active && active.camT !== undefined ? +active.camT.toFixed(4) : null; },
  setForceHover: function (v) { forceHover = !!v; },
  get staticLevels() {
    const out = {};
    if (!scenes.MAIN.root) return out;
    scenes.MAIN.root.traverse(function (o) {
      if (!o.isMesh || !STATIC_MESH.test(o.name)) return;
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      out[o.name] = m.emissiveIntensity !== undefined ? +m.emissiveIntensity.toFixed(4) : null;
    });
    return out;
  },
  seek: function (t, dir) {
    if (active && active.posTrack) {
      active.camT = t;
      if (dir === 1 || dir === -1) active.dir = dir;
    }
  },
  // ART timeline debug state. The timeline is driven off the CAMERA frame
  // (camT * CAM_FPS), so `frame` reports that; `clock` is just the entry timer.
  // Lets a harness seek the camera / enter & exit the close-up loop.
  get artState() {
    const s = scenes.ART;
    if (!s || !s.posTrack || !art.targets.length) return null;
    return {
      interacted: art.interacted,
      entering: art.entering ? +art.entering.t.toFixed(3) + "/" + +art.entering.dur.toFixed(3) : null,
      loopNarrowed: art.loopNarrowed,
      clock: +art.clock.toFixed(3),
      frame: +(s.camT * CAM_FPS).toFixed(1),
      loopStart: +(s.loopStart * CAM_FPS).toFixed(1),
      loopEnd: +(s.loopEnd * CAM_FPS).toFixed(1),
      camT: +s.camT.toFixed(4),
      targets: art.targets.map(function (t) { return t.name + "(" + t.meshes.length + ")"; }),
      windows: art.windows.map(function (w) { return (w.shown ? "SHOW:" : "hide:") + w.frame + ":" + w.nodes.map(function (o) { return o.name; }).join("+"); }),
      windowMeshes: art.windowMeshes.map(function (o) { return o.name; }),
      closeMeshes: art.closeMeshes.map(function (o) { return o.name; }),
      closePortfolio: art.closePortfolio ? art.closePortfolio.name : null,
      windowGlow: art.windowGlow.map(function (t) { return t.name + "@" + +t.pulseT.toFixed(1); }),
      popups: artPopupStage ? artPopupStage.querySelectorAll(".art-popup").length : 0,
      modalOpen: artModal ? artModal.classList.contains("open") : false,
      modalName: artPopup.current ? artPopup.current.name : null,
    };
  },
  // per-window showcase glow multiplier (current / base) for the first material
  get artGlowSample() {
    return art.windowGlow.map(function (t) {
      const m = t.mats[0];
      if (!m) return t.name + "=null";
      if (m.emissiveIntensity !== undefined) {
        const b = t.base[m.name];
        return t.name + "=" + (b > 0 ? +(m.emissiveIntensity / b).toFixed(2) : 1);
      }
      const bc = t.baseColor[m.name];
      if (!bc) return t.name + "=null";
      const r = bc.r > 0 ? m.color.r / bc.r : m.color.r;
      return t.name + "=" + +r.toFixed(2);
    });
  },
  setArtClock: function (t) { art.clock = t; },
  enterArt: function () { enterArtInteractive(); },
  exitArt: function () { exitArtInteractive(); },
  // drive a real 180Â° turn to a scene (same entry point a menu plane click
  // uses), so the radio's room mix can be verified across a handover
  goToScene: function (name) {
    if (!scenes[name]) return "no such scene: " + name;
    goToScene(name);
    return "turning -> " + name;
  },
  artPopupOpen: function (name) { artPopupOpen(name); },
  artPopupClear: function () { artPopupClear(); },
  // which desktop object a screen pixel raycasts to (debug / CDP harness),
  // using the exact same priority + inflated hit boxes as handleArtClick
  artPick: function (x, y) {
    screenRaycast(x, y);
    if (art.interacted) {
      const cpEntry = artFindWindowByClose(art.closePortfolio);
      if (art.closePortfolio && cpEntry && cpEntry.shown &&
          !art.closePortfolio.userData.artRemoved &&
          artObjectHit(art.closePortfolio, x, y)) return "CLOSEportfolio";
      let best = null;
      for (let j = 0; j < art.windows.length; j++) {
        const w = art.windows[j];
        if (!w.closeNode || w.closeNode === art.closePortfolio) continue;
        if (!w.shown || w.closeNode.userData.artRemoved) continue;
        if (!artObjectHit(w.closeNode, x, y)) continue;
        const d = artObjectDist(w.closeNode);
        if (!best || d < best.d) best = { w: w, d: d };
      }
      if (best) return best.w.closeNode.name;
      best = null;
      for (let j = 0; j < art.windows.length; j++) {
        const w = art.windows[j];
        if (!w.node || !w.art) continue;
        if (!w.shown || !w.node.visible || w.node.userData.artRemoved) continue;
        if (!artObjectHit(w.node, x, y)) continue;
        const d = artObjectDist(w.node);
        if (!best || d < best.d) best = { w: w, d: d };
      }
      if (best) return best.w.node.name;
    }
    const cm = raycaster.intersectObjects(art.clickMeshes, false);
    return cm.length ? "clickMesh:" + cm[0].object.name : null;
  },
  // run the exact world-click handler at a screen pixel (debug / CDP harness)
  artClickAt: function (x, y) { handleArtClick({ clientX: x, clientY: y }); },
  // project a named desktop window node to screen px (debug / CDP harness)
  windowScreen: function (name) {
    const s = scenes.ART;
    if (!s || !s.root) return null;
    const o = s.root.getObjectByName(name);
    if (!o) return null;
    o.getWorldPosition(_v1);
    _v1.project(camera);
    return {
      x: Math.round((_v1.x * 0.5 + 0.5) * window.innerWidth),
      y: Math.round((-0.5 * _v1.y + 0.5) * window.innerHeight),
      visible: o.visible,
      removed: !!o.userData.artRemoved,
    };
  },
  artForceShow: function (on) { return artForceShow(on); },
  artDump: artDump,
  get artScreens() {
    const s = scenes.ART;
    if (!s || !s.posTrack) return null;
    return {
      loading: art.loading ? art.loading.visible : "notFound",
      loaded: art.loaded ? art.loaded.visible : "notFound",
      shadeRemoved: art.shade ? art.shade.removed : "notFound",
      shadeOpacity: art.shade && art.shade.mats.length ? +art.shade.mats[0].opacity.toFixed(3) : "notFound",
      shadeMeshVisible: art.shade && art.shade.meshes.length ? art.shade.meshes[0].visible : "notFound",
      windows: art.windows.map(function (w) {
        return w.frame + ":" + (w.shown ? "SHOW" : "hide") + ":" +
          w.nodes.map(function (o) { return o.name + (o.visible ? "*" : ""); }).join("+");
      }),
    };
  },
  sceneObjects: function (sceneName, filter) {
    const s = scenes[sceneName];
    if (!s || !s.root) return [];
    const re = new RegExp(filter);
    const out = [];
    s.root.traverse(function (o) {
      if (re.test(o.name)) {
        const kind = o.isMesh ? "mesh" : o.isGroup ? "group" : o.isObject3D ? "obj" : "?";
        out.push(o.name + " [" + kind + " meshes=" + countMeshes(o) + " children=" + o.children.length + " vis=" + o.visible + "]");
      }
    });
    return out;
  },
  frameOffset: function (name) {
    const s = scenes[name];
    if (!s || !s.camNode || !s.root || !s.posTrack) return null;
    const t = s.name === "MAIN" ? s.camT : s.loopStart;
    sampleTrack(s.posTrack, t, _lp);
    sampleQuat(s.rotTrack, t, _lq);
    _vp.copy(_lp).applyMatrix4(s.root.matrixWorld);
    _lq2.copy(s.root.quaternion).multiply(_lq);
    const dist = frameDist(s, _vp);
    const off = sceneFrameOffset(s, _lq2, dist);
    return {
      dist: +dist.toFixed(3),
      offMag: off ? +off.length().toFixed(3) : 0,
      config: frameConfig(s),
      camT: +s.camT.toFixed(4),
      fov: +s.camNode.fov.toFixed(1),
      aspect: +s.camNode.aspect.toFixed(3),
      authoredWorld: { x: +_vp.x.toFixed(3), y: +_vp.y.toFixed(3), z: +_vp.z.toFixed(3) },
    };
  },
  materials: function (sceneName) {
    const s = scenes[sceneName];
    if (!s || !s.root) return [];
    const out = [];
    const seen = new Set();
    s.root.traverse(function (o) {
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach(function (m) {
        if (seen.has(m)) return;
        seen.add(m);
        out.push({
          type: m.type,
          name: m.name,
          hasMap: !!(m.map && m.map.isTexture),
          hasEmissiveMap: !!(m.emissiveMap && m.emissiveMap.isTexture),
          emInt: m.emissiveIntensity,
          emColor: m.emissive ? [+m.emissive.r.toFixed(2), +m.emissive.g.toFixed(2), +m.emissive.b.toFixed(2)] : null,
          color: m.color ? [+m.color.r.toFixed(2), +m.color.g.toFixed(2), +m.color.b.toFixed(2)] : null,
          transparent: m.transparent,
          depthWrite: m.depthWrite,
          alphaMap: !!(m.alphaMap && m.alphaMap.isTexture),
        });
      });
    });
    return out;
  },
  matInfo: function (name) {
    if (!scenes.MAIN.root) return null;
    let out = null;
    scenes.MAIN.root.traverse(function (o) {
      if (out) return;
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach(function (m) {
        if (out) return;
        if (m.name === name) {
          out = {
            transparent: m.transparent,
            depthWrite: m.depthWrite,
            emInt: m.emissiveIntensity,
            emColor: m.emissive ? [m.emissive.r, m.emissive.g, m.emissive.b] : null,
            hasEmissiveMap: !!(m.emissiveMap && m.emissiveMap.isTexture),
            hasMap: !!(m.map && m.map.isTexture),
            type: m.type,
          };
        }
      });
    });
    return out;
  },
  meshInfo: function () {
    if (!scenes.MAIN.root) return [];
    const out = [];
    const box = new THREE.Box3();
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    scenes.MAIN.root.traverse(function (o) {
      if (!o.isMesh) return;
      box.setFromObject(o);
      box.getSize(size);
      box.getCenter(center);
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      out.push({
        name: o.name,
        mat: mats.map(function (m) { return m.name; }).join("|"),
        transparent: mats.some(function (m) { return m.transparent; }),
        depthWrite: mats.every(function (m) { return m.depthWrite; }),
        size: [+size.x.toFixed(4), +size.y.toFixed(4), +size.z.toFixed(4)],
        center: [+center.x.toFixed(3), +center.y.toFixed(3), +center.z.toFixed(3)],
      });
    });
    return out;
  },
  get flyMaterial() {
    if (!scenes.MAIN.root) return null;
    let out = null;
    scenes.MAIN.root.traverse(function (o) {
      if (out) return;
      if (o.isMesh && /^FLIES/.test(o.name)) {
        const m = Array.isArray(o.material) ? o.material[0] : o.material;
        out = {
          mesh: o.name,
          hasMap: !!(m.map && m.map.isTexture),
          emInt: m.emissiveIntensity,
          transparent: m.transparent,
          side: m.side,
          color: m.color ? [m.color.r, m.color.g, m.color.b] : null,
        };
      }
    });
    return out;
  },
  // checksum of the currently-visible fly frame; frame index changes over
  // time => the sprite offset is advancing => the flies animate
  get flyPixels() {
    if (!fly.ready || !fly.ctx) return -1;
    let d;
    if (fly.mode === "atlas") {
      const c = fly.index % fly.cols;
      const r = Math.floor(fly.index / fly.cols);
      d = fly.ctx.getImageData(c * fly.w, r * fly.h, fly.w, fly.h).data;
    } else {
      d = fly.ctx.getImageData(0, 0, fly.w, fly.h).data;
    }
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    let acc = 0;
    for (let i = 0; i < d.length; i += 16) acc = (acc + d[i]) % 1000003;
    return fly.index + "|" + fly.count + "|" + n + "|" + acc;
  },
  get smokeInfo() {
    if (!scenes.CLOTHES.root) return null;
    let out = null;
    scenes.CLOTHES.root.traverse(function (o) {
      if (out) return;
      if (o.isMesh && o.material && o.material.name === "smoke") {
        scenes.CLOTHES.root.updateMatrixWorld(true);
        const wv = o.getWorldPosition(new THREE.Vector3());
        const camN = scenes.CLOTHES.camNode;
        const cv = camN ? camN.getWorldPosition(new THREE.Vector3()) : null;
        let screen = null;
        if (camN) {
          const cq = new THREE.Quaternion().setFromRotationMatrix(camN.matrixWorld);
          const dv = new THREE.Vector3().subVectors(wv, cv);
          const fw = dv.dot(new THREE.Vector3(0, 0, -1).applyQuaternion(cq));
          const halfH = Math.tan(THREE.MathUtils.degToRad(camN.fov) / 2);
          const halfW = halfH * camN.aspect;
          screen = {
            dist: +dv.length().toFixed(1),
            ndc: fw > 0.0001
              ? { x: +(dv.dot(new THREE.Vector3(1, 0, 0).applyQuaternion(cq)) / fw / halfW).toFixed(3),
                  y: +(dv.dot(new THREE.Vector3(0, 1, 0).applyQuaternion(cq)) / fw / halfH).toFixed(3) }
              : null,
            inFront: fw > 0.0001,
          };
        }
        out = {
          mesh: o.name,
          hasUV: !!(o.geometry && o.geometry.attributes.uv && o.geometry.attributes.uv.count > 0),
          hasMap: !!(o.material.map && o.material.map.isTexture),
          type: o.material.type,
          transparent: o.material.transparent,
          opacity: o.material.opacity,
          side: o.material.side,
          color: o.material.color ? [+o.material.color.r.toFixed(3), +o.material.color.g.toFixed(3), +o.material.color.b.toFixed(3)] : null,
          worldPos: wv ? [+wv.x.toFixed(2), +wv.y.toFixed(2), +wv.z.toFixed(2)] : null,
          camPos: cv ? [+cv.x.toFixed(2), +cv.y.toFixed(2), +cv.z.toFixed(2)] : null,
          screen: screen,
        };
      }
    });
    return out;
  },
  get smokePixels() {
    if (!smoke.ready || !smoke.ctx) return -1;
    let d;
    if (smoke.mode === "atlas") {
      const c = smoke.index % smoke.cols;
      const r = Math.floor(smoke.index / smoke.cols);
      d = smoke.ctx.getImageData(c * smoke.w, r * smoke.h, smoke.w, smoke.h).data;
    } else {
      d = smoke.ctx.getImageData(0, 0, smoke.w, smoke.h).data;
    }
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    let acc = 0;
    for (let i = 0; i < d.length; i += 16) acc = (acc + d[i]) % 1000003;
    return smoke.index + "|" + smoke.count + "|" + n + "|" + acc;
  },
  setSmokeTest: function (mode) { // diagnostic: 'hidden' | 'white' | 'gif'
    if (!scenes.CLOTHES.root) return null;
    const smokeMeshes = [];
    scenes.CLOTHES.root.traverse(function (o) {
      if (o.isMesh && o.material && o.material.name === "smoke") smokeMeshes.push(o);
    });
    smokeMeshes.forEach(function (o) {
      if (mode === "hidden") o.visible = false;
      else {
        o.visible = true;
        if (mode === "white") o.material = new THREE.MeshBasicMaterial({ name: "smoke", color: 0xffffff });
        else if (mode === "gif" && smoke.mat) o.material = smoke.mat;
      }
    });
    return smokeMeshes.length;
  },
  get camState() {
    if (!active) return null;
    return {
      name: active.name,
      camT: +active.camT.toFixed(3),
      dir: active.dir,
      local: { x: +camera.position.x.toFixed(4), y: +camera.position.y.toFixed(4), z: +camera.position.z.toFixed(4) },
    };
  },
  get lights() {
    let n = 0;
    const names = [];
    scene.traverse(function (o) {
      if (o.isLight) { n++; names.push(o.name + "(" + o.type + ")"); }
    });
    return { count: n, names: names };
  },
  get mixersInfo() {
    return Object.keys(scenes).map(function (k) {
      const s = scenes[k];
      return {
        name: s.name,
        mixers: s.mixers.length,
        clips: s.gltf ? s.gltf.animations.map(function (c) { return c.name; }) : [],
      };
    });
  },
  bonePose: function (sceneName, boneName) {
    const s = scenes[sceneName];
    if (!s || !s.root) return null;
    let out = null;
    scene.updateMatrixWorld(true);
    s.root.traverse(function (o) {
      if (out) return;
      if (o.isBone && o.name === boneName) {
        out = {
          x: +o.position.x.toFixed(4), y: +o.position.y.toFixed(4), z: +o.position.z.toFixed(4),
          qx: +o.quaternion.x.toFixed(4), qy: +o.quaternion.y.toFixed(4), qz: +o.quaternion.z.toFixed(4), qw: +o.quaternion.w.toFixed(4),
        };
      }
    });
    return out;
  },
  listBones: function (sceneName) {
    const s = scenes[sceneName];
    if (!s || !s.root) return [];
    const out = [];
    s.root.traverse(function (o) {
      if (o.isBone) out.push(o.name);
    });
    return out;
  },
  animDetail: function (sceneName) {
    const s = scenes[sceneName];
    if (!s) return [];
    return s.mixers.map(function (mixer, mi) {
      const bindNames = [];
      const seen = new Set();
      (mixer._bindings || []).forEach(function (b) {
        const pb = b.binding || b;
        if (pb.node && !seen.has(pb.node.name)) { seen.add(pb.node.name); bindNames.push(pb.node.name); }
      });
      const acts = [];
      (mixer._actions || []).forEach(function (a) {
        const c = a._clip || a.clip;
        acts.push({
          clip: c ? c.name : null,
          dur: c ? +c.duration.toFixed(2) : null,
          tracks: c ? c.tracks.length : null,
          loop: a.loop === THREE.LoopRepeat ? "repeat" : "once",
          clamp: !!a.clampWhenFinished,
          running: !a.paused,
        });
      });
      return { mixer: mi, boundNodes: bindNames, actions: acts };
    });
  },
  bindings: function (sceneName) {
    const s = scenes[sceneName];
    if (!s) return [];
    return s.mixers.map(function (mixer, mi) {
      const bs = [];
      (mixer._bindings || []).forEach(function (b) {
        const pb = b.binding || b;
        bs.push({ trackName: pb.name !== undefined ? pb.name : pb.trackName, node: pb.node ? pb.node.name : null });
      });
      return { mixer: mi, bindings: bs };
    });
  },
  findObj: function (sceneName, name) {
    const s = scenes[sceneName];
    if (!s || !s.root) return { found: false };
    const o = s.root.getObjectByName(name);
    if (!o) return { found: false };
    return { found: true, type: o.type, isBone: !!o.isBone, isMesh: !!o.isMesh, parent: o.parent ? o.parent.name : null };
  },
  meshMat: function (sceneName, name) {
    const s = scenes[sceneName];
    if (!s || !s.root) return null;
    let out = null;
    s.root.traverse(function (o) {
      if (out) return;
      if (o.isMesh && o.name === name) {
        const m = Array.isArray(o.material) ? o.material[0] : o.material;
        out = { type: m.type, name: m.name, emInt: m.emissiveIntensity, transparent: m.transparent, hasMap: !!(m.map && m.map.isTexture) };
      }
    });
    return out;
  },
  meshInfo: function (sceneName, name) {
    const s = scenes[sceneName];
    if (!s || !s.root) return null;
    const o = s.root.getObjectByName(name);
    if (!o) return { found: false };
    const out = { found: true, skinned: !!o.isSkinnedMesh, parent: o.parent ? o.parent.name : null, visible: o.visible };
    if (o.isMesh) {
      const geo = o.geometry;
      out.verts = geo && geo.attributes.position ? geo.attributes.position.count : 0;
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      out.mat = m ? {
        name: m.name, type: m.type, transparent: m.transparent, opacity: m.opacity,
        side: m.side, depthTest: m.depthTest, depthWrite: m.depthWrite,
        polygonOffset: m.polygonOffset, polyFactor: m.polygonOffsetFactor, polyUnits: m.polygonOffsetUnits,
        emInt: m.emissiveIntensity !== undefined ? +m.emissiveIntensity.toFixed(3) : null,
        hasMap: !!(m.map && m.map.isTexture),
        hasEmissiveMap: !!(m.emissiveMap && m.emissiveMap.isTexture),
        hasAlphaMap: !!(m.alphaMap && m.alphaMap.isTexture),
        sharedWith: (function () {
          let c = 0;
          s.root.traverse(function (x) {
            if (!x.isMesh) return;
            const xm = Array.isArray(x.material) ? x.material : [x.material];
            if (xm.indexOf(m) >= 0) c++;
          });
          return c;
        })(),
      } : null;
      scene.updateMatrixWorld(true);
      garmentWorldPoint(o, _v3);
      out.world = [+_v3.x.toFixed(2), +_v3.y.toFixed(2), +_v3.z.toFixed(2)];
    }
    const chain = [];
    let c = o;
    while (c) { chain.push(c.name + (c.isBone ? "*" : c.isSkinnedMesh ? "+" : c.isMesh ? "." : "")); c = c.parent; }
    out.chain = chain;
    return out;
  },
  meshNames: function (sceneName) {
    const s = scenes[sceneName];
    if (!s || !s.root) return [];
    const out = [];
    s.root.traverse(function (o) {
      if (o.isMesh) out.push(o.name);
    });
    return out;
  },
  nodeNames: function (sceneName) {
    const s = scenes[sceneName];
    if (!s || !s.root) return [];
    const out = [];
    s.root.traverse(function (o) {
      if (o.name) out.push(o.name);
    });
    return out;
  },
  sampleClipMotion: function (sceneName, clipName, stepSec) {
    const s = scenes[sceneName];
    const clip = s && s.gltf && s.gltf.animations.find(function (c) { return c.name === clipName; });
    if (!clip) return null;
    const track = clip.tracks.find(function (t) {
      return /\.(position|quaternion)$/.test(t.name) && t.values.length >= 3;
    });
    if (!track) return null;
    const isQuat = /\.quaternion$/.test(track.name);
    const out = [];
    for (let t = 0; t <= clip.duration + 1e-6; t += stepSec) {
      const tt = Math.min(t, clip.duration);
      if (isQuat) sampleQuat(track, tt, _lq);
      else sampleTrack(track, tt, _lp);
      out.push(isQuat
        ? [+tt.toFixed(1), +_lq.x.toFixed(2), +_lq.y.toFixed(2), +_lq.z.toFixed(2)]
        : [+tt.toFixed(1), +_lp.x.toFixed(2), +_lp.y.toFixed(2), +_lp.z.toFixed(2)]);
    }
    return { track: track.name, samples: out };
  },
  meshesUsingMaterial: function (sceneName, matName) {
    const s = scenes[sceneName];
    if (!s || !s.root) return [];
    const out = [];
    s.root.traverse(function (o) {
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      if (mats.some(function (m) { return m && m.name === matName; })) out.push(o.name);
    });
    return out;
  },
  get musicInfo() {
    const all = music.interactions.concat(music.buttons);
    return {
      found: all.length > 0,
      interactions: music.interactions.map(function (i) { return { name: i.name, meshes: i.meshes.length }; }),
      buttons: music.buttons.map(function (b) { return { name: b.name, url: MUSIC_LINKS[b.name] || "" }; }),
      hover: music.hoverTarget,
      interacted: music.interacted,
      exiting: music.exiting,
    };
  },
  get radioDisplayInfo() {
    const t = radioPlayer.track;
    const d = radioDisplayDebug();
    return {
      ready: radioDisplay.ready,
      swapped: radioDisplay.swapped,
      meshes: radioDisplay.meshes,
      tex: radioDisplay.tex ? radioDisplay.tex.image.width + "x" + radioDisplay.tex.image.height : null,
      trackIndex: radioPlayer.index,
      trackCount: d.trackCount,
      track: t ? t.title : null,
      artist: t ? t.artist : null,
      src: t ? t.src : null,
      duration: t ? +t.duration.toFixed(2) : 0,
      elapsed: +radioPlayer.currentTime().toFixed(2),
      state: radioPlayer.state,
      // room mix: 0 -> 8% over 7s on language pick, 100% in MUSIC
      ambient: radioPlayer.ambient,
      level: d.level,
      mixTarget: d.mixTo,
      levels: d.levels,
      mp3: d.formatOk,
      bpm: radioPlayer.bpm(),
      pulse: d.pulse,
      // the ambient bed on top of the music, and the whole-site mute
      bed: d.bed,
      muted: d.muted,
      muteVisible: !!(muteEl && !muteEl.hidden),
    };
  },
  get overlayDisplayInfo() {
    return {
      ready: overlayDisplay.ready,
      tex: overlayDisplay.tex ? overlayDisplay.tex.image.width + "x" + overlayDisplay.tex.image.height : null,
      hover: lastHoverName,
    };
  },
  get radioDisplayGeom() {
    const s = scenes.MUSIC;
    if (!s || !s.gltf) return null;
    const out = [];
    s.gltf.scene.traverse(function (o) {
      if (!o.isMesh || o.name !== "RADIOBASE_1" && o.name !== "RADIOBASE_2" && o.name !== "RADIOBASE_3") return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach(function (m, mi) {
        if (!m || !m.userData.radioDisplay) return;
        const g = o.geometry;
        if (!g) return;
        const groups = g.groups || [];
        const grp = groups.filter(function (gr) { return gr.materialIndex === mi; })[0] || { start: 0, count: g.attributes.position.count };
        const uv = g.attributes.uv;
        const pos = g.attributes.position;
        if (!uv || !pos) return;
        const minU = [1e9, 1e9, 1e9], maxU = [-1e9, -1e9, -1e9];
        const minP = [1e9, 1e9, 1e9], maxP = [-1e9, -1e9, -1e9];
        const n = Math.min(uv.count, grp.start + grp.count);
        let dUX = 0, dUZ = 0, dVY = 0, dVZ = 0;
        let refU = null, refV = null, refX = null, refY = null, refZ = null;
        for (let i = grp.start; i < n; i++) {
          const u = uv.getX(i), v = uv.getY(i);
          const px = pos.getX(i), py = pos.getY(i), pz = pos.getZ(i);
          if (u < minU[0]) minU[0] = u; if (u > maxU[0]) maxU[0] = u;
          if (v < minU[1]) minU[1] = v; if (v > maxU[1]) maxU[1] = v;
          if (px < minP[0]) minP[0] = px; if (px > maxP[0]) maxP[0] = px;
          if (py < minP[1]) minP[1] = py; if (py > maxP[1]) maxP[1] = py;
          if (pz < minP[2]) minP[2] = pz; if (pz > maxP[2]) maxP[2] = pz;
          if (refU === null) { refU = u; refV = v; refX = px; refY = py; refZ = pz; }
          else {
            dUX += Math.abs(u - refU) * (px > refX ? 1 : -1);
            dUZ += Math.abs(u - refU) * (pz > refZ ? 1 : -1);
            dVY += Math.abs(v - refV) * (py > refY ? 1 : -1);
            dVZ += Math.abs(v - refV) * (pz > refZ ? 1 : -1);
          }
        }
        out.push({
          materialIndex: mi,
          uvBounds: [minU[0], minU[1], maxU[0], maxU[1]],
          posBounds: [minP[0], minP[1], minP[2], maxP[0], maxP[1], maxP[2]],
          uGrowsWithX: dUX > 0,
          uGrowsWithZ: dUZ > 0,
          vGrowsWithY: dVY > 0,
          vGrowsWithZ: dVZ > 0,
        });
      });
    });
    return out;
  },
  musicEnter: function (name) {
    const all = music.interactions.concat(music.buttons);
    const hit = all.filter(function (t) { return t.name === name; })[0];
    if (!hit) return false;
    enterMusicInteractive();
    return true;
  },
  // buttons-first hit test: which target would a click at (cx,cy) hit?
  pickMusic: function (cx, cy) {
    if (reacquire || music.exiting) return null;
    screenRaycast(cx, cy);
    const all = music.buttons.concat(music.interactions);
    for (let i = 0; i < all.length; i++) {
      if (raycaster.intersectObjects(all[i].meshes, false).length) return all[i].name;
    }
    return null;
  },
  musicTargetNdc: function (name) {
    const all = music.interactions.concat(music.buttons);
    const t = all.filter(function (x) { return x.name === name; })[0];
    if (!t || !t.meshes.length || !scenes.MUSIC.root) return null;
    scene.updateMatrixWorld(true);
    t.meshes[0].getWorldPosition(_v3);
    _v3.project(camera);
    return { x: +_v3.x.toFixed(4), y: +_v3.y.toFixed(4), z: +_v3.z.toFixed(4), behind: _v3.z > 1 || _v3.z < -1 };
  },
  musicExit: exitMusic,
  get musicState() {
    const s = scenes.MUSIC;
    if (!s || !s.camNode || !s.posTrack) return null;
    return {
      interacted: music.interacted,
      exiting: music.exiting,
      camT: +s.camT.toFixed(4),
      dir: s.dir,
      loopStartFrame: +((s.loopStart * CAM_FPS).toFixed(1)),
      loopEndFrame: +((s.loopEnd * CAM_FPS).toFixed(1)),
      jumpFrame: +(SCENE_LOOP.MUSIC.jump * CAM_FPS),
      exitStartFrame: +(SCENE_LOOP.MUSIC.exitStart * CAM_FPS),
      exitEndFrame: +(SCENE_LOOP.MUSIC.exitEnd * CAM_FPS),
    };
  },
  get flashInfo() {
    return {
      ready: musicFlash.ready,
      bpm: musicFlash.bpm,
      track: radioPlayer.track ? radioPlayer.track.title : null,
      // the cue currently driving the show, so it can be verified
      step: musicFlash.cueIdx,
      mask: musicFlash.mask,
      mode: musicFlash.mode,
      lit: musicFlash.lit,
      cueTitle: musicFlash.cueTitle,
      cueCount: musicFlash.cues ? musicFlash.cues.length : 0,
      bounce: musicFlash.bounce,
      raw: musicFlash.raw.map(function (v) { return +v.toFixed(3); }),
      costMs: +musicFlash.cost.toFixed(4),
      boost: MUSIC_FLASH_BOOST,
      env: +musicFlash.envLevel.toFixed(3),
      smallEnv: +musicFlash.smallLevel.toFixed(3),
    mains: musicFlash.mains.map(function (t, i) {
      if (!t) return { slot: i, mesh: null, pending: true }; // texture not loaded yet
      const m = t.mats[0];
      return {
        slot: i, mesh: t.mesh.name, weight: t.weight, lv: +t.level.toFixed(3), injected: t.injected,
        transparent: m ? m.transparent : null, depthWrite: m ? m.depthWrite : null, side: m ? m.side : null,
      };
    }),
      envLights: musicFlash.env.map(function (t) {
        const m = t.mats[0];
        return {
          mesh: t.mesh.name, bias: t.small ? "small" : "size", gain: t.gain, lv: +t.level.toFixed(3), injected: t.injected,
          mapIsDefault: m && t.defaults[0] && m.map === t.defaults[0].map,
          transparent: m ? m.transparent : null, depthWrite: m ? m.depthWrite : null, side: m ? m.side : null,
        };
      }),
    };
  },
  matStats: function (sceneName) {
    const s = scenes[sceneName];
    if (!s || !s.root) return null;
    const out = { standard: 0, lambert: 0, basic: 0, other: 0, meshes: 0 };
    const seen = new Set();
    s.root.traverse(function (o) {
      if (!o.isMesh) return;
      out.meshes++;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach(function (m) {
        if (!m || seen.has(m)) return;
        seen.add(m);
        if (m.isMeshStandardMaterial) out.standard++;
        else if (m.isMeshLambertMaterial) out.lambert++;
        else if (m.isMeshBasicMaterial) out.basic++;
        else out.other++;
      });
    });
    return out;
  },
  get objectLinksInfo() {    return {
      CLOTHES: {
        url: OBJECT_LINKS.CLOTHES.url,
        meshes: linkedMeshes.map(function (o) { return o.name; }),
        count: linkedMeshes.length,
        hiddenStaticGorra: (function () {
          const g = scenes.CLOTHES && scenes.CLOTHES.root && scenes.CLOTHES.root.getObjectByName("GORRA");
          return !!(g && g.userData && g.userData.hiddenByLink);
        })(),
      },
    };
  },
  get glowInfo() {
    const out = {};
    const push = function (t) {
      const period = t.beaconPeriod || GLOW_PERIOD;
      const active = t.beaconMode === "repeat" ||
        (t.beaconMode !== "off" && Math.floor(t.pulseT / period) < (t.beaconPulses || GLOW_BEACON_PULSES));
      let emit = null;
      for (let i = 0; i < t.mats.length && !emit; i++) {
        const m = t.mats[i];
        if (m && m.emissiveIntensity !== undefined) {
          emit = { base: +(t.base[m.name] || 0).toFixed(3), now: +m.emissiveIntensity.toFixed(3) };
        }
      }
      out[t.name] = {
        hover: +t.hover.toFixed(2),
        flashBoost: t.flashBoost || 0,
        mats: t.mats.length,
        emit: emit,
        beaconMode: t.beaconMode,
        beaconActive: active,
        beacon: active ? +beaconLevel(t.pulseT, period).toFixed(2) : 0,
      };
    };
    music.interactions.forEach(push);
    music.buttons.forEach(push);
    clothesTargets.forEach(push);
    return out;
  },
  nearestLinkedOnScreen: function (cx, cy) {
    const hit = nearestLinkedOnScreen(cx, cy);
    return hit ? hit.name : null;
  },
  pickClothes: function (cx, cy) {
    if (!scenes.CLOTHES.root || !linkedMeshes.length || camera !== scenes.CLOTHES.camNode) return null;
    const ndx = (cx / window.innerWidth) * 2 - 1;
    const ndy = -(cy / window.innerHeight) * 2 + 1;
    const hit = pickLinkedMesh(ndx, ndy);
    return hit ? hit.name : null;
  },
  worldToNdc: function (sceneName, name) {
    const s = scenes[sceneName];
    if (!s || !s.root) return null;
    const o = s.root.getObjectByName(name);
    if (!o || !o.isMesh) return null;
    scene.updateMatrixWorld(true);
    garmentWorldPoint(o, _v3);
    _v3.project(camera);
    return { x: +_v3.x.toFixed(4), y: +_v3.y.toFixed(4), z: +_v3.z.toFixed(4), behind: _v3.z > 1 || _v3.z < -1 };
  },
  injectTexture: injectTexture,
  get textureInjectInfo() {
    return {
      ready: textureInject.ready,
      applied: textureInject.applied,
      errors: textureInject.errors,
      assignments: textureInject.assignments.map(function (a) {
        return { mesh: a.mesh, category: a.category, image: a.image, path: a.path, state: a.state };
      }),
      used: Object.keys(textureInject.used).reduce(function (acc, k) {
        acc[k] = Array.from(textureInject.used[k]);
        return acc;
      }, {}),
      // re-roll policy state, so the novelty-then-cache behaviour is
      // observable from the console: __viewer.textureInjectInfo.rolls
      rolls: textureInject.rolls,
      novelRolls: NOVEL_ROLLS,
      repeatChance: REPEAT_CHANCE,
      history: Object.keys(textureInject.history).reduce(function (acc, k) {
        acc[k] = textureInject.history[k].slice();
        return acc;
      }, {}),
    };
  },
  reInjectTextures: function () {
    textureInject.ready = false;
    initMainTextureInjection();
    return textureInject.assignments.length;
  },
  get clothesInjectInfo() {
    return {
      ready: clothesInject.ready,
      applied: clothesInject.applied,
      errors: clothesInject.errors,
      assignments: clothesInject.assignments.map(function (a) {
        return { mesh: a.mesh, image: a.image, path: a.path, state: a.state };
      }),
    };
  },
  reInjectClothesTextures: function () {
    clothesInject.ready = false;
    initClothesTextureInjection();
    return clothesInject.assignments.length;
  },
  get torisInjectInfo() {
    return {
      ready: torisInject.ready,
      sets: { 1: torisInject.sets[1], 2: torisInject.sets[2] },
      pending: torisInject.pending,
      applied: torisInject.applied,
      errors: torisInject.errors,
      figures: { 1: torisInject.meshes[1].length, 2: torisInject.meshes[2].length },
      loading: torisInject.assignments.map(function (a) {
        return { figure: a.fig, mesh: a.mesh, set: a.set, path: a.path, state: a.state };
      }),
    };
  },
  get mainZoomInfo() {
    if (!active || !camera) return null;
    return {
      scene: active.name,
      on: mainZoom.on,
      frames: mainZoom.frames,
      baseFov: mainZoom.baseFov,
      fov: +camera.fov.toFixed(2),
    };
  },
  get torisGui() {
    return {
      label: !!(document.getElementById("toris-nav-label")),
      backIcon: backEl ? backEl.title : null,
      torisArrows: !!(ctrls && ctrls.classList.contains("toris")),
      hudText: !!(document.getElementById("hud-text")),
    };
  },
  get activeName() {
    return active ? active.name : null;
  },
  // the audio debug surface: __viewer.radioDisplayInfo is the human summary,
  // this is the raw one (both levels, both targets, the mute state)
  get mixInfo() {
    return radioDisplayDebug();
  },
  // the language pick is the user gesture that unlocks the AudioContext, so it
  // is the audio entry point for testing too
  chooseLanguage: function (lang) { chooseLanguage(lang); },
  setMuted: function (v) { return radioPlayer.setMuted(v); },
  ambLevelForScene: function (name) { return radioPlayer.ambLevelForScene(name); },
  get zoomOutButton() {
    return {
      label: zoomOutEl ? zoomOutEl.title : null,
      visible: !!(zoomOutEl && !zoomOutEl.hidden),
      icon: zoomOutEl ? zoomOutEl.style.backgroundImage.slice(0, 32) : null,
      artInteracted: !!art.interacted,
      musicInteracted: !!music.interacted,
      musicExiting: !!music.exiting,
    };
  },
  clickZoomOut: function () {
    if (zoomOutEl) zoomOutEl.click();
  },
  probeTorisUVs: function () {
    const want = ["l_leg", "r_leg", "l_thigh", "r_thigh", "chest", "head"];
    const out = [];
    for (const part of want) {
      let entry = null;
      for (const e of torisInject.meshes[1]) {
        if (e.base === part) { entry = e; break; }
      }
      if (!entry) { out.push({ part: part, err: "no mesh" }); continue; }
      ensureUVs(entry.mesh);
      const g = entry.mesh.geometry;
      const uv = g.attributes.uv;
      const pos = g.attributes.position;
      let minX = 1e9, minY = 1e9, minZ = 1e9, maxX = -1e9, maxY = -1e9, maxZ = -1e9;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      }
      let u0 = 2, u1 = -1, v0 = 2, v1 = -1;
      for (let i = 0; i < uv.count; i++) {
        const u = uv.getX(i), v = uv.getY(i);
        if (u < u0) u0 = u; if (u > u1) u1 = u;
        if (v < v0) v0 = v; if (v > v1) v1 = v;
      }
      out.push({
        part: part,
        uvGenerated: g.userData.uvGenerated === true,
        uvCount: uv.count,
        bbox: [+(maxX - minX).toFixed(3), +(maxY - minY).toFixed(3), +(maxZ - minZ).toFixed(3)],
        uvBox: [+u0.toFixed(2), +v0.toFixed(2), +u1.toFixed(2), +v1.toFixed(2)],
      });
    }
    return out;
  },
  torisMarkerInject: function (parts, figures) {
    const list = parts || ["l_leg", "r_leg", "l_thigh", "r_thigh"];
    const figs = figures || [1, 2];
    let injected = 0;
    for (const fig of figs) {
      for (const base of list) {
        const entry = torisInject.meshes[fig].find(function (e) { return e.base === base; });
        if (!entry) continue;
        const cv = document.createElement("canvas");
        cv.width = 512; cv.height = 512;
        const c = cv.getContext("2d");
        c.fillStyle = "#ff1a1a"; c.fillRect(0, 0, 256, 256);
        c.fillStyle = "#1aff1a"; c.fillRect(256, 0, 256, 256);
        c.fillStyle = "#1a1aff"; c.fillRect(0, 256, 256, 256);
        c.fillStyle = "#ffff1a"; c.fillRect(256, 256, 256, 256);
        c.fillStyle = "#000000"; c.fillRect(252, 0, 8, 512);
        c.fillStyle = "#000000"; c.fillRect(0, 252, 512, 8);
        const tex = new THREE.CanvasTexture(cv);
        tex.flipY = false;
        tex.colorSpace = THREE.SRGBColorSpace;
        const mats = Array.isArray(entry.mesh.material) ? entry.mesh.material : [entry.mesh.material];
        mats.forEach(function (m) {
          m.map = tex;
          if (m.emissiveMap !== undefined) { m.emissiveMap = tex; if (m.emissive) m.emissive.setRGB(1, 1, 1); }
          m.needsUpdate = true;
        });
        injected++;
      }
    }
    const canvas = renderer.domElement;
    return { w: canvas.width, h: canvas.height, injected: injected };
  },
  diagnoseTorisOrientation: async function () {
    const want = ["breast", "chest", "stomach", "head", "l_leg", "r_leg", "l_thigh", "r_thigh"];
    const grayOf = function (src, size) {
      const c = document.createElement("canvas");
      c.width = size; c.height = size;
      const x = c.getContext("2d", { willReadFrequently: true });
      x.drawImage(src, 0, 0, size, size);
      const d = x.getImageData(0, 0, size, size).data;
      const g = new Float64Array(size * size);
      for (let i = 0; i < g.length; i++) g[i] = d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114;
      return g;
    };
    const rotCw = function (src) {
      const c = document.createElement("canvas");
      c.width = src.height; c.height = src.width;
      const x = c.getContext("2d", { willReadFrequently: true });
      x.translate(c.width, 0);
      x.rotate(Math.PI / 2);
      x.drawImage(src, 0, 0);
      return c;
    };
    const corr = function (a, b) {
      let ma = 0, mb = 0, n = a.length;
      for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
      ma /= n; mb /= n;
      let num = 0, da = 0, db = 0;
      for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
      return num / Math.sqrt(da * db);
    };
    const res = [];
    let atlasImg = torisInject.bakedImage;
    if (!atlasImg || !(atlasImg.width || atlasImg.videoWidth || atlasImg.naturalWidth)) {
      return { err: "no baked atlas captured", baked: !!atlasImg };
    }
    const atlasW = atlasImg.width || atlasImg.videoWidth || 512;
    const atlasH = atlasImg.height || atlasImg.videoHeight || 512;
    const atlasCanvas = document.createElement("canvas");
    atlasCanvas.width = atlasW; atlasCanvas.height = atlasH;
    const ax = atlasCanvas.getContext("2d", { willReadFrequently: true });
    ax.drawImage(atlasImg, 0, 0);
    for (const part of want) {
      let entry = null;
      for (const e of torisInject.meshes[1]) {
        if (e.base === part) { entry = e; break; }
      }
      if (!entry) { res.push({ part: part, err: "no mesh" }); continue; }
      ensureUVs(entry.mesh);
      const g = entry.mesh.geometry;
      const uv = g.attributes.uv;
      if (!uv) { res.push({ part: part, err: "no uv" }); continue; }
      let u0 = 2, u1 = -1, v0 = 2, v1 = -1;
      const arr = uv.array, n = uv.count;
      for (let i = 0; i < n; i++) {
        const u = arr[i * 2], v = arr[i * 2 + 1];
        if (u < u0) u0 = u; if (u > u1) u1 = u;
        if (v < v0) v0 = v; if (v > v1) v1 = v;
      }
      const pw = Math.max(1, Math.round((u1 - u0) * atlasW));
      const ph = Math.max(1, Math.round((v1 - v0) * atlasH));
      const px = Math.max(0, Math.min(atlasW - pw, Math.round(u0 * atlasW)));
      const pyTop = Math.max(0, Math.min(atlasH - ph, Math.round((1 - v1) * atlasH)));
      const crop = document.createElement("canvas");
      crop.width = pw; crop.height = ph;
      const cx = crop.getContext("2d", { willReadFrequently: true });
      cx.drawImage(atlasCanvas, px, pyTop, pw, ph, 0, 0, pw, ph);
      const bitmap = await fetch(TORIS_SET_DIR + "1/" + part + ".webp")
        .then(function (r) { return r.blob(); })
        .then(function (b) { return createImageBitmap(b); });
      const variants = {
        rot0: crop,
        rot90cw: rotCw(crop),
        rot180: rotCw(rotCw(crop)),
        rot270cw: rotCw(rotCw(rotCw(crop))),
      };
      const S = 64;
      const wg = grayOf(bitmap, S);
      let best = null;
      for (const k in variants) {
        const c = corr(grayOf(variants[k], S), wg);
        if (!best || c > best.c) best = { k: k, c: c };
      }
      const all = {};
      for (const k in variants) all[k] = +corr(grayOf(variants[k], S), wg).toFixed(3);
      res.push({
        part: part,
        uvBox: [+u0.toFixed(3), +v0.toFixed(3), +u1.toFixed(3), +v1.toFixed(3)],
        rect: [px, pyTop, pw, ph],
        webpSize: [bitmap.width, bitmap.height],
        best: best.k,
        bestCorr: +best.c.toFixed(3),
        all: all,
      });
    }
    return res;
  },
  swapToris: function (fig, dir) { return swapTorisFigure(fig, dir); },
  smokeColor: function () {
    if (!scenes.CLOTHES.root) return null;
    let out = null;
    scenes.CLOTHES.root.traverse(function (o) {
      if (out) return;
      if (o.isMesh && o.material && o.material.name === "smoke" && o.material.color) {
        out = [+o.material.color.r.toFixed(3), +o.material.color.g.toFixed(3), +o.material.color.b.toFixed(3)];
      }
    });
    return out;
  },
  get skylightInfo() {
    if (!scenes.CLOTHES.root) return null;
    const meshes = [];
    scenes.CLOTHES.root.traverse(function (o) {
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach(function (m) {
        if (m && /^sky$/i.test(m.name)) {
          meshes.push({ mesh: o.name, emInt: +m.emissiveIntensity.toFixed(3) });
        }
      });
    });
    return {
      skyMatMeshes: meshes,
      pulse: skylight.ready ? {
        mat: skylight.mat.name,
        mesh: skylight.mesh.name,
        emInt: +skylight.mat.emissiveIntensity.toFixed(3),
        t: +skylight.t.toFixed(2),
        side: skylight.mat.side,
        toneMapped: skylight.mat.toneMapped,
      } : null,
    };
  },
  skylightFlash: function () { return flashSkylight(); },
  skinProbe: function (sceneName) {
    const s = scenes[sceneName];
    if (!s || !s.root) return [];
    const out = [];
    s.root.traverse(function (o) {
      if (!o.isSkinnedMesh) return;
      const sk = o.skeleton;
      const b = sk && sk.bones && sk.bones[0];
      out.push({
        mesh: o.name,
        boneCount: sk ? sk.bones.length : 0,
        firstBone: b ? b.name : null,
        firstBonePos: b ? [+b.position.x.toFixed(4), +b.position.y.toFixed(4), +b.position.z.toFixed(4)] : null,
        firstBoneIsSceneBone: b ? (b === o.parent.getObjectByName(b.name)) : false,
      });
    });
    return out;
  },
  nodePose: function (sceneName, nodeName) {
    const s = scenes[sceneName];
    if (!s || !s.root) return null;
    let out = null;
    scene.updateMatrixWorld(true);
    s.root.traverse(function (o) {
      if (out) return;
      if (o.name === nodeName) {
        out = { x: +o.position.x.toFixed(4), y: +o.position.y.toFixed(4), z: +o.position.z.toFixed(4),
                qx: +o.quaternion.x.toFixed(4), qy: +o.quaternion.y.toFixed(4), qz: +o.quaternion.z.toFixed(4), qw: +o.quaternion.w.toFixed(4) };
      }
    });
    return out;
  },
  morphProbe: function (sceneName, meshName) {
    const s = scenes[sceneName];
    if (!s || !s.root) return null;
    let out = null;
    s.root.traverse(function (o) {
      if (out) return;
      if (o.isMesh && o.name === meshName && o.morphTargetInfluences) {
        out = { count: o.morphTargetInfluences.length, inf: Array.from(o.morphTargetInfluences).map(function (x) { return +x.toFixed(3); }) };
      }
    });
    return out;
  },
  meshRot: function (sceneName, meshName) {
    const s = scenes[sceneName];
    if (!s || !s.root) return null;
    let out = null;
    scene.updateMatrixWorld(true);
    s.root.traverse(function (o) {
      if (out) return;
      if (o.isMesh && o.name === meshName) {
        out = { x: +o.rotation.x.toFixed(4), y: +o.rotation.y.toFixed(4), z: +o.rotation.z.toFixed(4) };
      }
    });
    return out;
  },
  stepManual: function (sceneName, dt) {
    const s = scenes[sceneName];
    const m0 = s && s.mixers[0];
    if (!m0) return null;
    const read = function () {
      let o = null;
      s.root.traverse(function (x) { if (!o && x.isBone && x.name === "spine004") o = x; });
      return o ? [+o.position.x.toFixed(5), +o.position.y.toFixed(5), +o.position.z.toFixed(5)] : null;
    };
    const before = read();
    const t0 = m0.time;
    m0.update(dt || 0.5);
    return { before: before, after: read(), mixerTime0: +t0.toFixed(4), mixerTime1: +m0.time.toFixed(4) };
  },
  trackProbe: function (sceneName, boneName, property) {
    const s = scenes[sceneName];
    const m0 = s.mixers[0];
    if (!s || !s.root || !m0) return null;
    let node = null;
    s.root.traverse(function (o) { if (!node && o.isBone && o.name === boneName) node = o; });
    if (!node) return null;
    const bs = (m0._bindings || []).filter(function (b) {
      return b.binding && b.binding.node === node && b.binding.parsedPath && b.binding.parsedPath.propertyName === property;
    });
    return {
      nodeValue: node[property].toArray(),
      buffers: bs.map(function (b) { return Array.from(b.buffer || []).slice(0, 4); }),
      nTarget: bs.length,
      time: +m0.time.toFixed(4),
    };
  },
  poke: function (sceneName, boneName) {    const s = scenes[sceneName];
    let o = null;
    if (!s || !s.root) return null;
    s.root.traverse(function (x) { if (!o && x.isBone && x.name === boneName) o = x; });
    if (!o) return null;
    o.position.z += 0.5;
    return [+o.position.x.toFixed(4), +o.position.y.toFixed(4), +o.position.z.toFixed(4)];
  },
  clipInfo: function (sceneName) {
    const s = scenes[sceneName];
    if (!s || !s.gltf) return [];
    return s.gltf.animations.map(function (c) {
      const first = [];
      const last = [];
      c.tracks.forEach(function (t, i) {
        if (i < 2 && t.times) { first.push(t.name + ":" + t.times[0].toFixed(2)); last.push(t.name + ":" + t.times[t.times.length - 1].toFixed(2)); }
      });
      return { name: c.name, dur: +c.duration.toFixed(2), trackCount: c.tracks.length, firstKeys: first, lastKeys: last };
    });
  },
  trackRange: function (sceneName, clipName) {
    const s = scenes[sceneName];
    if (!s || !s.gltf) return [];
    const clip = s.gltf.animations.find(function (c) { return c.name === clipName; });
    if (!clip) return [];
    return clip.tracks.map(function (t) {
      const v = t.values;
      const nKeys = t.times.length;
      const comps = v.length / nKeys;
      let maxDelta = 0;
      for (let k = 1; k < nKeys; k++) {
        for (let c = 0; c < comps; c++) {
          const d = Math.abs(v[k * comps + c] - v[(k - 1) * comps + c]);
          if (d > maxDelta) maxDelta = d;
        }
      }
      return { name: t.name, keys: nKeys, maxDelta: +maxDelta.toFixed(4), static: maxDelta < 1e-6 };
    });
  },
  deepProbe: function (sceneName) {
    const s = scenes[sceneName];
    if (!s) return null;
    const m0 = s.mixers[0];
    if (!m0) return null;
    const rootName = m0.getRoot ? m0.getRoot().name : null;
    const out = { mixerKeys: Object.keys(m0), rootName: rootName, mixerTime: m0.time, mixerTimeScale: m0.timeScale, nActiveActions: m0._nActiveActions, nActiveBindings: m0._nActiveBindings };
    const act = (m0._actions && m0._actions[0]) || null;
    if (act) {
      out.actionKeys = Object.keys(act);
      out.actionTime = act.time;
      out.actionScale = act.timeScale;
      out.actionPaused = act.paused;
      out.actionEnabled = act.enabled;
      out.actionWeight = act.weight;
      out.actionIsActive = act.isRunning ? act.isRunning() : null;
      const tr = act._clip && act._clip.tracks[0];
      if (tr) {
        out.trackName = tr.name;
        out.trackKeys = Object.keys(tr);
        out.trackBinding = tr.binding ? { node: tr.binding.node && tr.binding.node.name, path: tr.binding.path } : null;
      }
    }
    const b0 = m0._bindings && m0._bindings[0];
    if (b0) {
      const pb = b0.binding || b0;
      out.binding0Keys = Object.keys(b0);
      out.binding0 = {
        name: pb.name,
        nodeName: pb.node ? pb.node.name : null,
        nodeType: pb.node ? pb.node.type : null,
        path: pb.path !== undefined ? pb.path : null,
        useCount: b0.useCount,
        referenceCount: b0.referenceCount,
      };
    }
    return out;
  },
  setMeshVisible: function (sceneName, meshName, visible) {
    const s = scenes[sceneName];
    if (!s || !s.root) return { ok: false, reason: "no scene" };
    let found = 0;
    s.root.traverse(function (o) {
      if (o.isMesh && o.name === meshName) {
        o.visible = !!visible;
        found++;
      }
    });
    return { ok: true, found: found };
  },
  getMeshVisible: function (sceneName, meshName) {
    const s = scenes[sceneName];
    if (!s || !s.root) return null;
    let out = null;
    s.root.traverse(function (o) {
      if (out === null && o.isMesh && o.name === meshName) out = o.visible;
    });
    return out;
  },
  // same but matches ANY object by name (groups included — RADIOBASE is a
  // group whose child meshes are RADIOBASE_1/2/3)
  setVisible: function (sceneName, nodeName, visible) {
    const s = scenes[sceneName];
    if (!s || !s.root) return { ok: false, reason: "no scene" };
    const obj = s.root.getObjectByName(nodeName);
    if (!obj) return { ok: true, found: 0 };
    obj.visible = !!visible;
    return { ok: true, found: 1, type: obj.isMesh ? "mesh" : obj.type };
  },
  getVisible: function (sceneName, nodeName) {
    const s = scenes[sceneName];
    if (!s || !s.root) return null;
    const obj = s.root.getObjectByName(nodeName);
    return obj ? obj.visible : null;
  },
  setPolygonOffset: function (sceneName, meshName, factor, units) {
    const s = scenes[sceneName];
    if (!s || !s.root) return { ok: false, reason: "no scene" };
    let found = 0;
    s.root.traverse(function (o) {
      if (o.isMesh && o.name === meshName) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach(function (m) {
          m.polygonOffset = true;
          m.polygonOffsetFactor = factor || 0;
          m.polygonOffsetUnits = units || 0;
          m.needsUpdate = true;
        });
        found++;
      }
    });
    return { ok: true, found: found };
  },
  pause: function () { debugPaused = true; return true; },
  resume: function () { debugPaused = false; return true; },
  get paused() { return debugPaused; },
  meshWorldInfo: function (sceneName) {
    const s = scenes[sceneName];
    if (!s || !s.root) return null;
    scene.updateMatrixWorld(true);
    const out = [];
    const _bmin = new THREE.Vector3(), _bmax = new THREE.Vector3();
    s.root.traverse(function (o) {
      if (!o.isMesh) return;
      o.geometry.computeBoundingBox();
      _bmin.copy(o.geometry.boundingBox.min).applyMatrix4(o.matrixWorld);
      _bmax.copy(o.geometry.boundingBox.max).applyMatrix4(o.matrixWorld);
      o.getWorldQuaternion(_qI);
      const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(_qI);
      out.push({
        name: o.name,
        type: o.isSkinnedMesh ? "skinned" : "plain",
        tris: o.geometry.index ? o.geometry.index.count / 3 : o.geometry.attributes.position.count / 3,
        pos: [+o.position.x.toFixed(3), +o.position.y.toFixed(3), +o.position.z.toFixed(3)],
        worldMin: [+_bmin.x.toFixed(2), +_bmin.y.toFixed(2), +_bmin.z.toFixed(2)],
        worldMax: [+_bmax.x.toFixed(2), +_bmax.y.toFixed(2), +_bmax.z.toFixed(2)],
        forward: [+fwd.x.toFixed(2), +fwd.y.toFixed(2), +fwd.z.toFixed(2)],
        visible: o.visible,
        parent: o.parent ? o.parent.name : null,
      });
    });
    return out;
  },
  camSet: function (px, py, pz, tx, ty, tz) {
    if (!camera) return false;
    camera.position.set(px, py, pz);
    camera.up.set(0, 1, 0);
    camera.lookAt(new THREE.Vector3(tx, ty, tz));
    camera.updateMatrixWorld(true);
    return true;
  },
  camSetWorld: function (px, py, pz, tx, ty, tz) {
    if (!camera) return false;
    var p = camera.parent || camera;
    if (p.updateWorldMatrix) p.updateWorldMatrix(true, false);
    _w2l.set(px, py, pz);
    if (p.worldToLocal) p.worldToLocal(_w2l);
    _w2lt.set(tx, ty, tz);
    if (p.worldToLocal) p.worldToLocal(_w2lt);
    camera.position.copy(_w2l);
    camera.up.set(0, 1, 0);
    camera.lookAt(_w2lt);
    camera.updateMatrixWorld(true);
    return true;
  },
  setCamNear: function (near, far) {
    if (!camera) return false;
    camera.near = near;
    if (far !== undefined) camera.far = far;
    camera.updateProjectionMatrix();
    return true;
  },
  livePos: function (sceneName, meshName) {
    const s = scenes[sceneName];
    if (!s || !s.root) return null;
    scene.updateMatrixWorld(true);
    let out = null;
    const _lvp = new THREE.Vector3();
    s.root.traverse(function (o) {
      if (out || !o.isMesh || o.name !== meshName) return;
      garmentWorldPoint(o, _lvp);
      out = [_lvp.x, _lvp.y, _lvp.z].map(function (n) { return +n.toFixed(4); });
    });
    return out;
  },
  get camPos() {
    if (!camera) return null;
    camera.updateWorldMatrix(true, false);
    return [camera.position.x, camera.position.y, camera.position.z].map(function (n) { return +n.toFixed(3); });
  },
};

// seed the viewport + PORTRAIT FIT before the first scene is sampled, so the
// very first frame is already composed for the screen it is being shown on
// (a phone needs the fit immediately, not after the first resize event)
syncViewport();

// apply the STARTING tier's cheap-path flags immediately — the probe may have
// decided this device is weak, and we should not spend the first few seconds
// at full cost waiting for the watchdog to notice
setContactCardLite(perf.lite);
setRadioDisplayLite(perf.lite);
setMainDisplayLite(perf.lite);

// start the crash/heartbeat reporter before anything else can throw, so a
// failure during the very first scene load is still captured
initCrashLog();

setLoading("loading " + SCENES.MAIN.file.split("/").pop() + "\u2026");
loadScene("MAIN");

loop(); // start the render loop
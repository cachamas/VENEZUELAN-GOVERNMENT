import * as THREE from "three";
import { v1VideoData } from "./videos/v1.js";
import { v2VideoData } from "./videos/v2.js";
import { v3VideoData } from "./videos/v3.js";
import { v4VideoData } from "./videos/v4.js";
import { v5VideoData } from "./videos/v5.js";
import { v6VideoData } from "./videos/v6.js";
import { v7VideoData } from "./videos/v7.js";

/* ------------------------------------------------------------------ */
/*  dot-matrix LED grid                                                */
/* ------------------------------------------------------------------ */

const COLS = 120;
const ROWS = 24;
const CELL = 4;
const DOT = 1.35;
const CW = COLS * CELL;
const CH = ROWS * CELL;

const FONT_W = 5;
// The 5x7 LED font now lives in its own module so that code needing the font
// does not have to pull in the seven radio clips this file statically imports.
// Re-exported here because half the site already imports it from this path.
export { FONT5x7, FONT_H, FONT_GAP } from "./font5x7.js";
import { FONT5x7, FONT_H, FONT_GAP } from "./font5x7.js";

const GLYPH_TRI = ["....#", "...#.", "..##.", "..#.#", ".##.#", ".#..#", "....."];
const GLYPH_TRIN = ["#....", ".#...", ".##..", "#.#..", "#.##.", "#..#.", "....."];
const GLYPH_TRIH = [".....", ".....", ".....", "..##.", "..#.#", ".#..#", "....."];

function makeGlyph(g, dx, dy) {
  const out = [];
  for (let y = 0; y < 7; y++) {
    const row = g[y];
    for (let x = 0; x < 5; x++) {
      if (row[x] === "#") out.push([x + dx, y + dy]);
    }
  }
  return out;
}

const GLYPH_TRI_RIGHT = makeGlyph(["#...", "#...", ".##.", "#.#.", "#.#.", "....", "...."], 0, 0);
const GLYPH_TRI_LEFT = makeGlyph(["...#", "...#", ".##.", ".#.#", ".#.#", "....", "...."], 0, 0);

/* ------------------------------------------------------------------ */
/*  MP3 playback: the real radio                                       */
/* ------------------------------------------------------------------ */

// Every song lives in media/MUSIC/mp3 as a 192 kbps CBR .mp3, all credited to
// GOB.VE, and the dot-matrix display below scrolls the real titles.
//
// Durations are the DECODED mp3 lengths. `bpm` is the tempo of that track and
// drives the car light show — these are the ARTIST'S values, which corrected the
// automated estimate on four tracks (ME VALORO and UH AH were exactly an octave
// out; BOZZO and MOROKA JIA were not even octave-related). Both are one number
// per line, so either can be edited here and nothing else has to change.
const MUSIC_DIR = "media/MUSIC/mp3/";
const MUSIC_ARTIST = "GOB.VE";

const TRACKS = [
  { title: "AMAN",               artist: MUSIC_ARTIST, src: MUSIC_DIR + "AMAN.mp3",              duration: 61.296, bpm: 152 },   // high
  { title: "ANTEPASADOS",        artist: MUSIC_ARTIST, src: MUSIC_DIR + "ANTEPASADOS.mp3",       duration: 56.247, bpm: 115 },
  { title: "BOKITA",             artist: MUSIC_ARTIST, src: MUSIC_DIR + "BOKITA.mp3",            duration: 60.146, bpm: 110 },
  { title: "BOZZO",              artist: MUSIC_ARTIST, src: MUSIC_DIR + "BOZZO.mp3",             duration: 43.167, bpm: 120 },
  { title: "CORAZON VENEZOLANO", artist: MUSIC_ARTIST, src: MUSIC_DIR + "CORAZON VENEZOLANO.mp3",  duration: 45.6, bpm: 120 },
  { title: "DILO",               artist: MUSIC_ARTIST, src: MUSIC_DIR + "DILO.mp3",              duration: 58.707, bpm: 117 },
  { title: "ELECTROLUX",         artist: MUSIC_ARTIST, src: MUSIC_DIR + "ELECTROLUX.mp3",        duration: 62.04, bpm: 143.55 },   // high
  { title: "INTERVENIR",         artist: MUSIC_ARTIST, src: MUSIC_DIR + "INTERVENIR.mp3",        duration: 60.024, bpm: 112.35 },   // low
  { title: "JUGUETE",            artist: MUSIC_ARTIST, src: MUSIC_DIR + "JUGUETE.mp3",           duration: 44.841, bpm: 107 },
  { title: "LA NOCHE FATAL",     artist: MUSIC_ARTIST, src: MUSIC_DIR + "LA NOCHE FATAL.mp3",    duration: 60.146, bpm: 114 },
  { title: "MANTEQUILLA",        artist: MUSIC_ARTIST, src: MUSIC_DIR + "MANTEQUILLA.mp3",       duration: 135.36, bpm: 92.29 },   // low
  { title: "ME VALORO",          artist: MUSIC_ARTIST, src: MUSIC_DIR + "ME VALORO.mp3",         duration: 58.471, bpm: 130 },
  { title: "MERCAL",             artist: MUSIC_ARTIST, src: MUSIC_DIR + "MERCAL.mp3",            duration: 60.146, bpm: 83 },
  { title: "MOROKA JIA",         artist: MUSIC_ARTIST, src: MUSIC_DIR + "MOROKA JIA.mp3",        duration: 57.189, bpm: 74 },
  { title: "MUCHACHITA",         artist: MUSIC_ARTIST, src: MUSIC_DIR + "MUCHACHITA.mp3",        duration: 61.032, bpm: 136 },   // low
  { title: "PAPITO",             artist: MUSIC_ARTIST, src: MUSIC_DIR + "PAPITO.mp3",            duration: 61.56, bpm: 123.05 },   // low
  { title: "PERDONALOS",         artist: MUSIC_ARTIST, src: MUSIC_DIR + "PERDONALOS.mp3",        duration: 63.792, bpm: 129.2 },   // high
  { title: "SAPOS",              artist: MUSIC_ARTIST, src: MUSIC_DIR + "SAPOS.mp3",             duration: 57.686, bpm: 94 },
  { title: "SILBON",             artist: MUSIC_ARTIST, src: MUSIC_DIR + "SILBON.mp3",            duration: 45.364, bpm: 110 },
  { title: "TARAKO",             artist: MUSIC_ARTIST, src: MUSIC_DIR + "TARAKO.mp3",            duration: 53.317, bpm: 130 },
  { title: "UH AH",              artist: MUSIC_ARTIST, src: MUSIC_DIR + "UH AH.mp3",             duration: 50.623, bpm: 93 },
  { title: "VIGILIA",            artist: MUSIC_ARTIST, src: MUSIC_DIR + "VIGILIA.mp3",           duration: 43.402, bpm: 73 },
];

/* --- room mix --------------------------------------------------------
 * One bed for the whole site, at a different level per room: faint on the MAIN
 * screen, fainter in the other rooms, full inside MUSIC. Every move is an
 * AudioParam ramp on the audio thread, so the fades are sample-accurate and keep
 * running even when the browser throttles timers/rAF in a background tab — a
 * JS-driven ramp would freeze mid-fade.
 */
const VOL_MAIN = 0.08;     // MAIN
const VOL_OTHER = 0.04;    // TORIS / ART / CLOTHES
const VOL_ROOM = 1.0;      // inside MUSIC
const FADE_IN_SEC = 7;     // 0 -> 8% over 7s once a language is picked
const CRESCENDO_SEC = 1.3; // quick, but not instant, on arriving in MUSIC
const DAMPEN_SEC = 1.3;    // ...and back down on the way out
// scales the beat's upward swing into 0..1 for the light show; tuned by
// sampling the delivered masters (see PULSE_GAIN note at pulse())
const PULSE_GAIN = 7.0;
// deliberate silence between songs before the next one starts
const TRACK_GAP_SEC = 2.0;

/* ------------------------------------------------------------------ */
/*  AMBIENT BED - a separate loop that sits UNDER the music everywhere  */
/*  except the MUSIC room, where it is silent                         */
/* ------------------------------------------------------------------ */
/* media/MUSIC/MAIN/ambient-bed.mp3 is a 3:00 excerpt of a phone recording,
   built by tools/make_ambient.py: 5:00-8:00 of the source, crossfaded onto
   itself and de-clicked so the loop point is inaudible, delivered as 64 kbps
   CBR mono (1407 KB - smaller than the 1479 KB opus it came from, and mp3 plays
   everywhere, which the opus did not on Safari/iOS).

   It is deliberately NOT tapped by the analyser. The analyser feeds both the
   dot-matrix visualizer and the MUSIC light show, and a constant broadband
   noise floor would flatten the beat pulse() reads out of the low bins - the
   same reason the visualizer compensates for the room mix. So the bed runs on
   its own element -> its own gain -> the site mute, and never touches the
   signal the light show sees.

   Levels: full in MAIN, a hint in the other rooms, SILENT inside MUSIC - the
   stereo there IS the point, and the bed would fight the car audio. */
const AMB_SRC = "media/MUSIC/MAIN/ambient-bed.mp3";
const AMB_MAIN = 0.4;   // MAIN - the bed is the presence here
const AMB_OTHER = 0.1;  // TORIS / ART / CLOTHES - just a hint of it
const AMB_ROOM = 0.0;   // MUSIC - off
// the bed rises with the music on first load: same 7 s as FADE_IN_SEC, so the
// two come up as one gesture rather than the bed arriving under a fade
const AMB_BOOT_FADE_SEC = FADE_IN_SEC;
// room changes ease more slowly than the music's 1.3 s, so leaving MAIN is a
// gradual thinning out of the air instead of a level step
const AMB_ROOM_FADE_SEC = 2.5;
// the same turn that swings the camera, so the bed is already settling while
// the room turns rather than jumping on arrival
const AMB_TURN_FADE_SEC = 2.0;
// muting is an instant judgement, but not a click
const AMB_MUTE_FADE_SEC = 0.2;

const amb = {
  el: null,        // its own <audio>, looped
  node: null,      // MediaElementAudioSourceNode for it
  gain: null,      // the gain we automate (AMB_MAIN/AMB_OTHER <-> AMB_ROOM)
  mix: { from: 0, to: 0, startT: 0, dur: AMB_BOOT_FADE_SEC },
  started: false,  // has playback been kicked off (needs a user gesture)
  failed: false,   // the browser couldn't decode it, or the fetch 404'd
  muted: false,
};

function ambLevel() {
  const m = amb.mix;
  const p = Math.max(0, Math.min(1, (mixClock() - m.startT) / m.dur));
  return m.from + (m.to - m.from) * p;
}

// which level a given room's bed plays at
function ambLevelForScene(name) {
  if (name === "MUSIC") return AMB_ROOM;
  if (name === "MAIN") return AMB_MAIN;
  return AMB_OTHER;
}

// Same AudioParam ramp as mixTo, so the bed's fades are sample-accurate and
// keep running when the browser throttles timers in a background tab.
function ambMixTo(target, dur) {
  const now = mixClock();
  amb.mix.from = ambLevel();
  amb.mix.to = target;
  amb.mix.startT = now;
  amb.mix.dur = Math.max(0.02, dur);
  if (!amb.gain) return;
  const g = amb.gain.gain;
  g.cancelScheduledValues(now);
  g.setValueAtTime(amb.mix.from, now);
  g.linearRampToValueAtTime(target, now + amb.mix.dur);
}

// kick the bed off. Called inside the language-pick gesture.
function startAmbience() {
  if (amb.started || amb.failed || !amb.el) return;
  amb.started = true;
  const p = amb.el.play();
  if (p && p.catch) {
    p.catch(function (err) {
      if (err && err.name === "AbortError") return;
      console.warn("[amb] play() rejected:", err && err.name, err && err.message);
    });
  }
  whenClockRuns(function () {
    ambMixTo(AMB_MAIN, AMB_BOOT_FADE_SEC);
    console.log("[amb] bed on: 0 -> " + AMB_MAIN + " over " + AMB_BOOT_FADE_SEC + "s (loops every 180 s)");
  });
}

// Move the bed to a room's level. `pre` is the startTurn path (start easing
// during the camera turn); otherwise this is the arrival confirmation.
function setAmbienceScene(scene, pre) {
  if (!amb.started || amb.failed || !amb.gain) return;
  const target = ambLevelForScene(scene);
  const dur = pre ? AMB_TURN_FADE_SEC : AMB_ROOM_FADE_SEC;
  // the music defers its ramp until the audio clock is really ticking; the bed
  // has to be inside that same callback or the two would start at different times
  whenClockRuns(function () {
    ambMixTo(target, dur);
    console.log("[amb] " + (pre ? "turn -> " : "") + scene + " -> " + target + " over " + dur + "s");
  });
}

const audio = {
  el: null,       // the single <audio> every source is routed through
  node: null,     // MediaElementAudioSourceNode
  ctx: null,
  master: null,   // the gain we automate (VOL_MAIN/VOL_OTHER <-> VOL_ROOM)
  mute: null,     // one point in front of the speakers for the whole site
  analyser: null,
  freq: null,
  formatOk: false,
  mix: { from: 0, to: 0, startT: 0, dur: FADE_IN_SEC, wallStart: 0 },
};

function mixClock() {
  return audio.ctx ? audio.ctx.currentTime : performance.now() / 1000;
}

// Where the mix is right now, derived from the last ramp's endpoints. Mirrors
// the AudioParam automation so the spectrum compensation and the debug readouts
// know the level without having to sample the node back.
function currentLevel() {
  const m = audio.mix;
  const p = Math.max(0, Math.min(1, (mixClock() - m.startT) / m.dur));
  return m.from + (m.to - m.from) * p;
}

// A freshly created AudioContext reports state "running" straight away, but its
// render thread spins up asynchronously — currentTime sits still for a moment
// before it starts advancing (a null/headless audio sink is the worst case,
// ~1.5s). A ramp scheduled against that stalled clock is delivered that much
// late: measured a flat 0 for ~1.5s and THEN the full 7s. So wait for the
// clock to actually move before starting a ramp — the fade then really is 7s of
// audible sound, which is what "7 seconds to go from 0 to 20" means. Once the
// clock is moving this resolves within one 16ms tick, so a later
// crescendo/dampen is unaffected, and it re-resumes cleanly if the browser
// suspended the context.
function whenClockRuns(cb) {
  if (!audio.ctx) { cb(); return; }
  const c0 = audio.ctx.currentTime;
  const t0 = performance.now();
  if (audio.ctx.resume) audio.ctx.resume();
  const poll = function () {
    if (audio.ctx.state === "running" && audio.ctx.currentTime > c0) { cb(); return; }
    if (performance.now() - t0 > 5000) { cb(); return; } // never hang the mix
    setTimeout(poll, 16);
  };
  poll();
}

function mixTo(target, dur) {
  const now = mixClock();
  const m = audio.mix;
  m.from = currentLevel();
  m.to = target;
  m.startT = now;
  m.dur = Math.max(0.02, dur);
  m.wallStart = performance.now(); // wall-clock anchor, for verification
  if (!audio.master) return;
  const g = audio.master.gain;
  g.cancelScheduledValues(now);
  g.setValueAtTime(m.from, now);
  g.linearRampToValueAtTime(target, now + m.dur);
}

// The analyser taps the signal BEFORE the room mix, so the spectrum is the real
// audio rather than the 4-8% ambient bed. Outside MUSIC that would flatten the
// bars into stubbles, so scale the readout back up by the inverse of the current
// level and the visualizer reads full in every room.
function freqData() {
  if (!audio.analyser || !audio.freq) return null;
  audio.analyser.getByteFrequencyData(audio.freq);
  const g = 1 / Math.max(0.15, currentLevel());
  for (let i = 0; i < audio.freq.length; i++) {
    const v = audio.freq[i] * g;
    audio.freq[i] = v > 255 ? 255 : v;
  }
  return audio.freq;
}

// Beat-reactive signal, 0..1 — what the car light show breathes with. The low
// bins carry the beat, and because freqData() already divides out the room
// level, this reads the same in the 4% rooms as at full volume in MUSIC.
//
// It reports the UPWARD SWING of the low band (peak-held, decaying between
// hits), not the level. These masters are dense and heavily limited, so the
// absolute level barely moves — measured 0.839-0.870 over eight samples, which
// left the lights looking static. A level-above-baseline measure fared no
// better and simply pegged at 1.0. The rise spikes on each hit and falls away
// between them, which is what actually reads as "in time with the music".
let pulsePrev = 0;
let pulseRise = 0;
let pulseOut = 0;
function pulse() {
  const f = freqData();
  if (!f) return pulseOut;
  const n = Math.min(6, f.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += f[i];
  const v = s / n / 255;
  const rise = v - pulsePrev;
  pulsePrev = v;
  if (rise > pulseRise) pulseRise = rise;
  else pulseRise *= 0.94;                       // decay between hits
  const target = pulseRise * PULSE_GAIN;
  pulseOut += ((target > 1 ? 1 : target) - pulseOut) * 0.5;
  return pulseOut;
}

// A song finished: queue the next one behind a deliberate silence, so the car
// gets a moment of darkness and the handover is a beat rather than a hard cut.
//
// Idempotent, and BOTH the ended and pause events route through it, because the
// browser's ordering around the end of a track is not reliable here: Chromium
// was observed firing `pause` before `ended`, and also firing `pause` with
// `ended` still false. Handling only one of them stranded the radio at the end
// of every song (intermittently, which was worse than a consistent failure).
function beginGap() {
  if (player.userPaused) return;          // deliberate stop: do not auto-advance
  if (player.state === "gap") return;     // already handing over
  // Enter the gap state BEFORE advancing. goto() starts playback whenever the
  // state is "playing", so stepping first meant the incoming song played during
  // the silence and was then restarted from zero by the timeout below.
  player.state = "gap";
  player.suppressPlay = true;
  player.step(1);                         // next song in the shuffled order, loaded not played
  player.suppressPlay = false;
  player.elapsed = 0;
  player.gapLeft = TRACK_GAP_SEC;
  player.emit();
  console.log("[radio] gap " + TRACK_GAP_SEC + "s -> " + player.track.title);
  setTimeout(function () {
    if (player.state !== "gap") return;   // user hit play/pause during the gap
    loadTrack(player.index);
    playEl();
    player.gapLeft = 0;
    player.state = "playing";
    player.emit();
    console.log("[radio] now playing", player.track.title);
  }, TRACK_GAP_SEC * 1000);
}

// sitting at, or within a hair of, the end of the current track?
function atTrackEnd() {
  if (!audio.el) return false;
  if (audio.el.ended) return true;
  const d = audio.el.duration;
  if (!isFinite(d) || d <= 0) return false;
  return d - audio.el.currentTime < 0.3;
}

function bindElement() {
  if (!audio.el || audio.el.__bound) return;
  audio.el.__bound = true;

  // NOTE: deliberately does NOT trust audio.el.duration to overwrite tr.duration.
  // The baked durations were measured from the encoded files, and a browser's
  // reported duration is only as good as its container parsing - during
  // development the ogg versions of these songs came back 8-13s SHORT (56.12
  // reported as 42.97) because the dev server had no HTTP Range support, so the
  // browser never reached the last page. measure-and-correct on encode now
  // guarantees the files themselves, but the display must not depend on the
  // browser agreeing.

  audio.el.addEventListener("ended", beginGap);

  // The browser pauses media for reasons outside our control (autoplay policy
  // re-checks, an OS interruption, the element being evicted under memory
  // pressure). Observed while testing: the element sat paused at ~2s while our
  // own state still read "playing", so the radio looked alive but was silent
  // and the light show's grid froze with it. Follow the element, so the reported
  // state can never disagree with what is actually audible.
  audio.el.addEventListener("pause", function () {
    if (player.state !== "playing") return;   // that was our own pause()
    if (atTrackEnd()) { beginGap(); return; } // a natural end, not a pause
    player.state = "paused";                 // userPaused stays false -> watchdog resumes
    player.elapsed = player.currentTime();
    player.emit();
  });

  // a decode/load failure must not strand the radio on a silent track
  audio.el.addEventListener("error", function () {
    console.warn("[radio] failed to load", audio.el.src);
    if (player.state !== "playing" || player.errGuard) return;
    player.errGuard = true;
    setTimeout(function () {
      player.errGuard = false;
      if (player.state === "playing") player.step(1); // keep the shuffle: recover onto the next song in order
    }, 250);
  });
}

function ensureAudio() {
  if (audio.ctx) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  audio.ctx = new AC();

  audio.el = new Audio();
  audio.el.preload = "auto";
  audio.el.loop = false;
  audio.formatOk = !!audio.el.canPlayType("audio/mpeg");
  if (!audio.formatOk) console.warn("[radio] this browser can't decode mp3 - the radio stays silent");

  audio.node = audio.ctx.createMediaElementSource(audio.el);
  audio.analyser = audio.ctx.createAnalyser();
  audio.analyser.fftSize = 128;
  audio.freq = new Uint8Array(audio.analyser.frequencyBinCount);
  audio.master = audio.ctx.createGain();
  audio.master.gain.value = 0;
  audio.mute = audio.ctx.createGain();
  // honour a mute armed before the graph existed (nothing can mute it before
  // the language pick creates the context, but the state is the source of truth)
  audio.mute.gain.value = amb.muted ? 0 : 1;
  audio.node.connect(audio.analyser);
  audio.analyser.connect(audio.master);
  // the bed joins HERE, past the analyser, so the visualizer and the light show
  // never see it
  setupAmbience();
  audio.master.connect(audio.mute);
  if (amb.gain) amb.gain.connect(audio.mute);
  audio.mute.connect(audio.ctx.destination);
  bindElement();
  // Watchdog: keep the radio alive against whatever the browser does to the
  // media element. One property read a second, so the cost is nil. It skips
  // anything the user asked for (userPaused), so it can never fight PLAYPAUSE.
  setInterval(function () {
    if (!audio.el || player.userPaused) return;
    if (player.state === "gap") return;        // beginGap owns the handover
    if (audio.ctx && audio.ctx.state === "suspended") audio.ctx.resume();
    if (player.state === "playing" && atTrackEnd()) { beginGap(); return; }
    if (audio.el.ended) return;
    if (audio.el.paused) {
      console.warn("[radio] media paused outside our control - resuming");
      playEl();
    }
    if (player.state !== "playing" && !audio.el.paused) {
      player.state = "playing";
      player.emit();
    }
    // the bed has no user control of its own, so if the browser parks it we can
    // just resume - but never while it is deliberately at zero, and never when
    // it hasn't been started (the language pick starts it)
    if (amb.started && !amb.failed && amb.el && amb.el.paused) {
      const p = amb.el.play();
      if (p && p.catch) p.catch(function () { });
    }
  }, 1000);
}

// Build the bed's half of the graph. It stays disconnected from the analyser on
// purpose (see the AMB_* note above) and starts at silence.
function setupAmbience() {
  if (amb.node || !audio.ctx) return;
  if (!audio.formatOk) {
    // the browser can't decode the mp3s, so it can't decode the bed either
    amb.failed = true;
    return;
  }
  try {
    amb.el = new Audio(AMB_SRC);
    amb.el.preload = "auto";
    amb.el.loop = true;                 // the whole point of the crafted loop
    amb.gain = audio.ctx.createGain();
    amb.gain.gain.value = 0;
    amb.node = audio.ctx.createMediaElementSource(amb.el);
    amb.node.connect(amb.gain);
    amb.el.addEventListener("error", function () {
      amb.failed = true;
      console.warn("[amb] could not load", AMB_SRC, "- the bed stays silent");
    });
  } catch (err) {
    amb.failed = true;
    console.warn("[amb] unavailable:", err && err.message);
  }
}

function loadTrack(i) {
  if (!audio.el) return;
  audio.el.src = TRACKS[i].src;
  audio.el.load();
}

function playEl() {
  if (!audio.el) return;
  const p = audio.el.play();
  if (!p || !p.catch) return;
  p.catch(function (err) {
    // AbortError just means a newer load/play superseded this one (e.g. two
    // quick FORWARD presses) - that's normal, not worth logging. Anything else
    // is a genuine autoplay rejection (no user gesture yet).
    if (err && err.name === "AbortError") return;
    console.warn("[radio] play() rejected:", err && err.name, err && err.message);
  });
}

// The playlist is shuffled per session, so a reload does not always open on the
// same song. TRACKS deliberately stays in its own fixed order so a track can
// still be looked up by name (the cue sheets, the debug API and the tooling all
// index by title); `order` holds the shuffled visiting sequence and `pos` the
// cursor into it.
function shuffledOrder() {
  const o = [];
  for (let i = 0; i < TRACKS.length; i++) o.push(i);
  for (let i = o.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = o[i]; o[i] = o[j]; o[j] = t;
  }
  return o;
}

const player = {
  index: 0,
  order: null,     // shuffled [indices into TRACKS]
  pos: 0,          // cursor into order
  state: "paused",
  elapsed: 0,
  hover: null,
  ambient: false, // the bed has been unlocked (a language was picked)
  userPaused: false, // a DELIBERATE stop via PLAYPAUSE, so the watchdog leaves it
  gapLeft: 0,        // seconds left in the inter-track silence
  // set only while beginGap pre-loads the next track, so goto() loads the
  // element but does NOT start it. Without this the next song is audible from
  // its first sample and the "2s gap" is only ever 2s of restarted music.
  suppressPlay: false,
  errGuard: false,
  listeners: [],
  get track() { return TRACKS[player.index]; },

  play() {
    ensureAudio();
    if (!audio.ctx || !audio.el) return;
    if (audio.ctx.state === "suspended") audio.ctx.resume();
    if (player.state === "playing") return;
    // read the state BEFORE overwriting it: during a "gap" the element still
    // holds the previous track at its end, so the new one has to be loaded
    const wasGap = player.state === "gap";
    player.state = "playing";
    player.userPaused = false;
    player.gapLeft = 0;
    if (wasGap || !audio.el.src || audio.el.ended) loadTrack(player.index);
    playEl();
    player.emit();
  },

  pause() {
    if (player.state !== "playing" && player.state !== "gap") return;
    player.state = "paused";
    player.userPaused = true;      // a deliberate stop: the watchdog leaves it alone
    player.gapLeft = 0;            // cancel a pending auto-advance
    if (audio.el) audio.el.pause();
    player.emit();
  },

  toggle() {
    if (player.state === "playing") player.pause();
    else player.play();
  },

  currentTime() {
    // during the inter-track gap there is no position to report - the light
    // show reads this, and 0 would otherwise fire the next track's first cue
    if (player.state === "gap") return 0;
    if (!audio.el) return player.elapsed;
    const t = audio.el.currentTime;
    return isFinite(t) ? t : player.elapsed;
  },

  // The BAKED duration is authoritative - see the note in bindElement about
  // Chromium under-reporting. el.duration is only a fallback for the (never-hit)
  // case of a track with no measured duration.
  duration() {
    const tr = player.track;
    if (tr && tr.duration > 0) return tr.duration;
    if (audio.el && isFinite(audio.el.duration) && audio.el.duration > 0) return audio.el.duration;
    return 0;
  },

  // measured tempo of the current track, for the car light show
  bpm() {
    const tr = player.track;
    return tr && tr.bpm ? tr.bpm : 120;
  },

  // live low-end energy 0..1 — the light show breathes with this
  pulse() { return pulse(); },

  // the live magnitude spectrum, already divided out of the room level, so the
  // light show can map bands to lamps and read the same at 4% as at 100%
  spectrum() { return freqData(); },


  // shuffle the running order and start on a random song
  randomStart() {
    player.order = shuffledOrder();
    player.pos = 0;
    player.index = player.order[0];
    player.elapsed = 0;
    if (audio.el) loadTrack(player.index);
    return player.track.title;
  },

  // load a track by index, keeping whatever the current play/pause state is
  goto(i) {
    player.index = i;
    player.elapsed = 0;
    player.gapLeft = 0;
    if (!player.order) player.order = shuffledOrder();
    const at = player.order.indexOf(i);
    // -1 means this track is not in the shuffled order yet (jumped to directly);
    // splice it in at the cursor so next/prev stay consistent
    if (at >= 0) player.pos = at;
    else { player.order.splice(player.pos + 1, 0, i); }
    // A skip DURING the inter-track gap (a real user action, not beginGap's own
    // handover) leaves the element mid-transition: treat it as not-playing until
    // reload. beginGap sets suppressPlay while it pre-loads, so its own step must
    // not cancel the gap it just started.
    if (player.state === "gap" && !player.suppressPlay) player.state = "paused";
    if (audio.el) {
      loadTrack(i);
      if (player.state === "playing" && !player.suppressPlay) playEl();
    }
    player.emit();
  },

  // step through the shuffled order, wrapping at both ends
  step(delta) {
    if (!player.order) player.order = shuffledOrder();
    const n = player.order.length;
    player.pos = (player.pos + delta + n) % n;
    player.goto(player.order[player.pos]);
  },

  nextTrack() { player.step(1); },
  prevTrack() { player.step(-1); },
  seekNext() { player.nextTrack(); },

  // classic transport behaviour: BACKWARD restarts the current song if you're
  // more than 3s into it, otherwise it steps back one
  seekPrev() {
    if (player.currentTime() > 3) {
      if (audio.el) audio.el.currentTime = 0;
      player.elapsed = 0;
      player.emit();
      return;
    }
    player.prevTrack();
  },

  /* --- the room mix (called from main.js) ---------------------------- */

  // which level a given room plays at
  levelForScene(name) {
    if (name === "MUSIC") return VOL_ROOM;
    if (name === "MAIN") return VOL_MAIN;
    return VOL_OTHER;
  },

  // ...and the same for the ambient bed on top of it
  ambLevelForScene,

  // once, when a language is picked - that click is the user gesture that
  // unlocks the AudioContext. Starts the bed and takes 7s to reach the MAIN level.
  startAmbient() {
    if (player.ambient) return;
    player.ambient = true;
    ensureAudio();
    // open on a random song from a freshly shuffled running order
    const first = player.randomStart();
    player.play();
    // the bed's play() has to be called in this same gesture (not inside the
    // whenClockRuns poll below, which may be a tick or two later), or the
    // browser treats it as an unprompted autoplay and rejects it
    startAmbience();
    whenClockRuns(function () {
      mixTo(VOL_MAIN, FADE_IN_SEC);
      console.log("[radio] ambient bed on: 0 -> " + VOL_MAIN + " over " + FADE_IN_SEC + "s (starting on " + first + ")");
    });
  },

  // follow the room. MUSIC is full; MAIN is faint; the other rooms fainter.
  setScene(scene) {
    if (!player.ambient) return;
    const target = player.levelForScene(scene);
    const dur = scene === "MUSIC" ? CRESCENDO_SEC : DAMPEN_SEC;
    whenClockRuns(function () {
      mixTo(target, dur);
      console.log("[radio] " + scene + " -> " + target + " over " + dur + "s");
    });
    setAmbienceScene(scene, false);
  },

  // Called from startTurn, BEFORE the 1.6s camera swing. The bed starts easing
  // out while the room is still turning, so by the time you arrive it is already
  // at the new room's level instead of stepping on arrival. Arriving at MAIN
  // brings it back up the same way, and the fade in is what reads as "the noise
  // comes back with the room".
  preTurn(scene) {
    if (!player.ambient) return;
    setAmbienceScene(scene, true);
  },

  // One control for the whole site: the music bed and the ambient bed both run
  // through audio.mute, so this is a single ramp. Deliberately separate from
  // the PLAYPAUSE button in the MUSIC room - that one is the car stereo, this is
  // "I want silence", and it holds across every room.
  setMuted(muted) {
    amb.muted = !!muted;
    if (!audio.mute) {
      if (audio.ctx) audio.mute.gain.value = amb.muted ? 0 : 1;
      return amb.muted;
    }
    const now = mixClock();
    const g = audio.mute.gain;
    const to = amb.muted ? 0 : 1;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(to, now + AMB_MUTE_FADE_SEC);
    console.log("[audio] mute " + (amb.muted ? "ON" : "OFF"));
    return amb.muted;
  },

  toggleMuted() {
    return this.setMuted(!amb.muted);
  },

  isMuted() { return amb.muted; },

  on(fn) { player.listeners.push(fn); },
  emit() { player.listeners.forEach(function (fn) { fn(player); }); },
};

/* ------------------------------------------------------------------ */
/*  display renderer + scene system                                    */
/* ------------------------------------------------------------------ */

let animT = 0;
let lastDraw = 0;

const led = new Uint8Array(COLS * ROWS);
const prevLed = new Uint8Array(COLS * ROWS);

function dotSprite() {
  const c = document.createElement("canvas");
  c.width = CELL;
  c.height = CELL;
  const g = c.getContext("2d");
  const grd = g.createRadialGradient(CELL / 2, CELL / 2, DOT * 0.2, CELL / 2, CELL / 2, DOT);
  grd.addColorStop(0, "rgba(255,255,255,1)");
  grd.addColorStop(0.35, "rgba(255,240,190,1)");
  grd.addColorStop(1, "rgba(255,190,80,0)");
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

  const bg = document.createElement("canvas");
  bg.width = CW;
  bg.height = CH;
  const bgc = bg.getContext("2d");
  bgc.fillStyle = "#000";
  bgc.fillRect(0, 0, CW, CH);
  const dot = dotSprite();
  bgc.globalAlpha = 0.18;
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) bgc.drawImage(dot, x * CELL, y * CELL);
  }
  bgc.globalAlpha = 1;

  const tex = new THREE.CanvasTexture(canvas);
  // mag stays Nearest so dots are crisp up close; min uses mipmaps so the
  // grid AVERAGES when far away instead of point-sampling into moire
  // (dark diagonal tearing bands across the panel). Mip regen per blit is
  // trivial at this size.
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.flipY = false;
  tex.needsUpdate = true;

  function setLED(c, r, on) {
    if (c < 0 || c >= COLS || r < 0 || r >= ROWS) return;
    led[r * COLS + c] = on ? 1 : 0;
  }

  function drawGlyph(glyph, col, row, on) {
    for (let i = 0; i < glyph.length; i++) setLED(col + glyph[i][0], row + glyph[i][1], on);
  }

  function drawChar(ch, col, row, on) {
    const g = FONT5x7[ch];
    if (!g) return col + FONT_W;
    for (let y = 0; y < FONT_H; y++) {
      const line = g[y];
      for (let x = 0; x < FONT_W; x++) if (line[x] === "#") setLED(col + x, row + y, on);
    }
    return col + FONT_W + FONT_GAP;
  }

  function drawText(s, col, row, on, bold) {
    const str = String(s).toUpperCase();
    let x = col;
    for (let i = 0; i < str.length; i++) {
      if (x >= COLS) break;
      if (str[i] === " ") x += 3;
      else {
        drawChar(str[i], x, row, on);
        if (bold) drawChar(str[i], x + 1, row, on);
        x += FONT_W + FONT_GAP;
      }
    }
    return x;
  }

  function textWidth(s, bold) {
    const str = String(s).toUpperCase();
    let w = 0;
    for (let i = 0; i < str.length; i++) w += str[i] === " " ? 3 : FONT_W + FONT_GAP + (bold ? 1 : 0);
    return Math.max(0, w - FONT_GAP);
  }

  function rect(c, r, w, h, on) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) setLED(c + x, r + y, on);
  }

  function fmtTime(s) {
    s = Math.max(0, Math.floor(s));
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return m + ":" + (sec < 10 ? "0" : "") + sec;
  }

  /* --- drawing primitives -------------------------------------------- */

  function wrapMod(v, m) {
    return ((v % m) + m) % m;
  }

  function hLine(c, r, w, on) {
    for (let x = 0; x < w; x++) setLED(c + x, r, on);
  }

  function vLine(c, r, h, on) {
    for (let y = 0; y < h; y++) setLED(c, r + y, on);
  }

  function drawLine(c0, r0, c1, r1, on) {
    c0 = Math.round(c0); r0 = Math.round(r0); c1 = Math.round(c1); r1 = Math.round(r1);
    const dx = Math.abs(c1 - c0), sx = c0 < c1 ? 1 : -1;
    const dy = -Math.abs(r1 - r0), sy = r0 < r1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      setLED(c0, r0, on);
      if (c0 === c1 && r0 === r1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; c0 += sx; }
      if (e2 <= dx) { err += dx; r0 += sy; }
    }
  }

  function disc(cx, cy, rad, on) {
    const rr = rad * rad;
    for (let y = -rad; y <= rad; y++)
      for (let x = -rad; x <= rad; x++)
        if (x * x + y * y <= rr) setLED(cx + x, cy + y, on);
  }

  function tri(a, b, c, on) {
    const minY = Math.max(0, Math.min(a[1], b[1], c[1]));
    const maxY = Math.min(ROWS - 1, Math.max(a[1], b[1], c[1]));
    for (let y = minY; y <= maxY; y++) {
      const xs = [];
      const es = [[a, b], [b, c], [c, a]];
      for (let i = 0; i < 3; i++) {
        const p0 = es[i][0], p1 = es[i][1];
        if ((p0[1] <= y && y < p1[1]) || (p1[1] <= y && y < p0[1])) {
          xs.push(p0[0] + (y - p0[1]) * (p1[0] - p0[0]) / (p1[1] - p0[1]));
        }
      }
      if (xs.length === 2) {
        const x0 = Math.round(Math.min(xs[0], xs[1]));
        const x1 = Math.round(Math.max(xs[0], xs[1]));
        for (let x = x0; x <= x1; x++) setLED(x, y, on);
      }
    }
  }

  function sprite(rows, c, r, on) {
    for (let y = 0; y < rows.length; y++) {
      const line = rows[y];
      for (let x = 0; x < line.length; x++) if (line[x] === "#") setLED(c + x, r + y, on);
    }
  }

  function drawCheckered(c, r, w, h) {
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        if ((x + y) % 2 === 0) setLED(c + x, r + y, 1);
  }

  /* classic right-to-left marquee with seamless wrap */
  function scrollTextRTL(s, row, t, speed, bold) {
    const tw = textWidth(s, bold) + 4;
    const span = tw + COLS;
    const off = Math.floor(t * speed) % span;
    let x = COLS - off;
    if (x + tw > 0) drawText(s, x, row, 1, bold);
    if (x + tw <= COLS - 1) drawText(s, x + tw + 4, row, 1, bold);
  }

  /* --- sprites (ASCII pixel art) ------------------------------------- */

  const CAR_BODY = [
    "....#.....#....",
    "..###########..",
    ".############.#",
    ".##############",
  ];

  /* --- scene: NOW PLAYING -------------------------------------------- */

  function drawNowPlaying(t) {
    const tr = player.track;
    const playing = player.state === "playing";
    scrollTextRTL("♪ " + tr.artist + " - " + tr.title, 0, animT / 1000, 7, true);

    const dur = player.duration();
    const cur = Math.min(player.currentTime(), dur);
    const frac = Math.min(1, dur > 0 ? cur / dur : 0);
    const filled = Math.round(COLS * frac);
    for (let y = 0; y < 3; y++) rect(0, 8 + y, filled, 1, 1);

    if (playing) {
      drawGlyph(GLYPH_TRI_RIGHT, 1, 16, 1);
      drawGlyph(GLYPH_TRIH, 6, 16, 1);
      drawGlyph(GLYPH_TRIH, 10, 16, 1);
      drawGlyph(GLYPH_TRI_LEFT, 15, 16, 1);
    } else {
      drawText("PAUSED", 2, 16, 1);
    }

    const tStr = fmtTime(cur) + " " + fmtTime(dur);
    drawText(tStr, COLS - textWidth(tStr) - 1, 16, 1);
    drawText((player.index + 1) + "/" + TRACKS.length, 1, 21, 1);

    const f = playing ? freqData() : null;
    if (f) {
      for (let i = 0; i < 24; i++) {
        const v = f[Math.floor(i * 1.7)] / 255;
        const h = Math.max(0, Math.round(v * 6) - 1);
        for (let y = 0; y < h; y++) rect(2 + i * 4, 20 - y, 2, 1, 1);
      }
    }
  }

  /* --- scene: RACE (side-view speed run) ------------------------------ */

  function drawRace(t) {
    const far = t * 3, mid = t * 6, near = t * 11;

    disc(COLS - 14, 5, 3, 1);

    // mountains (far parallax)
    for (let i = 0; i < 4; i++) {
      const mx = wrapMod(i * 40 - Math.floor(far * 1.5), COLS + 44) - 22;
      tri([mx, 14], [mx + 24, 14], [mx + 12, 7], 1);
    }

    // roadside posts (mid parallax)
    for (let i = 0; i < 6; i++) {
      const px = wrapMod(i * 22 - Math.floor(mid * 2), COLS + 22) - 11;
      vLine(px, 15, 2, 1);
    }

    // road
    hLine(0, 16, COLS, 1);
    hLine(0, 22, COLS, 1);

    // road surface dashes (near parallax)
    for (let i = 0; i < 14; i++) {
      const dx = wrapMod(i * 10 - Math.floor(near), COLS + 10) - 5;
      if (dx < 0 || dx >= COLS) continue;
      vLine(dx, 18, 4, 1);
    }

    // checkered finish block zipping past
    const fx = wrapMod(COLS + 14 - Math.floor(mid * 3), COLS + 24) - 12;
    if (fx > -8 && fx < COLS) drawCheckered(fx, 12, 5, 3);

    // the car (fixed) with bobbing + rotating wheels
    const carX = 34, carY = 16;
    const bob = Math.abs(Math.sin(t * 9)) > 0.75 ? 1 : 0;
    sprite(CAR_BODY, carX, carY + bob, 1);

    const wheelY = carY + 4 + bob;
    [carX + 3, carX + 11].forEach(function (wx) {
      const a = t * 12;
      for (let k = 0; k < 16; k++) {
        const th = k / 16 * Math.PI * 2;
        setLED(wx + Math.round(Math.cos(th) * 2), wheelY + Math.round(Math.sin(th) * 2), 1);
      }
      for (let k = 0; k < 4; k++) {
        const th = a + k * Math.PI / 2;
        drawLine(wx, wheelY, Math.round(wx + Math.cos(th) * 2), Math.round(wheelY + Math.sin(th) * 2), 1);
      }
    });

    // speed lines
    for (let i = 0; i < 4; i++) {
      const lx = carX - 6 - wrapMod(Math.floor(near) + i * 3, 14);
      setLED(lx, carY + 1 + (i % 3), 1);
    }
  }

  /* --- scene: DOLPHINS ------------------------------------------------ */

  function drawDolphin(cx, cy, t, facing, amp) {
    const len = 12, phase = t * 5;
    const bx = function (u) { return cx + (u - 0.5) * 2 * len * facing; };
    const by = function (u) { return cy + Math.sin(u * Math.PI * 2 - phase) * amp; };
    let prev = null;
    for (let i = 0; i <= 12; i++) {
      const u = i / 12;
      const x = Math.round(bx(u)), y = Math.round(by(u));
      if (prev) drawLine(prev[0], prev[1], x, y, 1);
      prev = [x, y];
      disc(x, y, 2, 1);
    }
    // dorsal fin (top of body)
    const du = 0.35, dx = bx(du), dy = by(du);
    tri([dx - 2 * facing, dy - 1], [dx + 2 * facing, dy - 1], [dx + facing, dy - 5], 1);
    // tail flukes flapping
    const flap = Math.sin(t * 10) * 3;
    const t0 = bx(0), t1 = by(0);
    drawLine(t0, t1, t0 - 3 * facing, t1 - 3 - flap, 1);
    drawLine(t0, t1, t0 - 3 * facing, t1 + 3 + flap, 1);
    // snout
    const s0 = bx(1), s1 = by(1);
    tri([s0, s1 - 1], [s0, s1 + 1], [s0 + 3 * facing, s1], 1);
  }

  function drawDolphins(t) {
    // sun
    disc(COLS - 12, 4, 3, 1);
    // water line
    for (let x = 0; x < COLS; x++) {
      setLED(x, 6 + (Math.sin(x * 0.2 + t * 3) > 0.15 ? 1 : 0), 1);
    }
    // two dolphins
    drawDolphin(30 + Math.sin(t * 1.2) * 3, 13 + Math.sin(t * 0.8) * 1, t, 1, 2.2);
    drawDolphin(90 - Math.sin(t * 1.1) * 3, 18 + Math.sin(t * 0.7 + 2) * 1, t + 1.2, -1, 2.0);
    // bubbles
    for (let i = 0; i < 6; i++) {
      const bt = ((t * 1.5 + i * 0.6) % 1);
      const bxp = 42 - i * 5 + Math.round(Math.sin(t + i * 2) * 2);
      setLED(bxp, Math.round(21 - bt * 9), 1);
    }
  }

  /* --- scene: VENEZUELAN FLAG (waving) -------------------------------- */

  function drawFlag(t) {
    const bandH = Math.round(ROWS / 3);
    // pole
    vLine(1, 0, ROWS, 1);
    setLED(1, 0, 1);
    // three bands, waving per-column
    for (let x = 3; x < COLS; x++) {
      const off = Math.round(2 * Math.sin(x * 0.22 - t * 5));
      for (let y = 0; y < ROWS; y++) {
        const ry = y + off;
        if (ry < 0 || ry >= ROWS) continue;
        const band = y < bandH ? 0 : y < bandH * 2 ? 1 : 2;
        if (band === 1 && (x + y) % 2 !== 0) continue;
        setLED(x, ry, 1);
      }
    }
    // 8-star arc on the blue band, riding the wave
    for (let i = 0; i < 8; i++) {
      const a = Math.PI * (0.12 + 0.76 * i / 7);
      const sx = 3 + (COLS - 4) * (0.5 + 0.5 * Math.cos(a));
      const sy = bandH * 1.5 + Math.sin(a) * 2.2;
      const off = Math.round(2 * Math.sin(sx * 0.22 - t * 5));
      setLED(Math.round(sx), Math.round(sy) + off, 1);
    }
  }

  /* --- scene: VISUALIZER ---------------------------------------------- */

  const vizPeaks = new Array(40).fill(0);
  function drawViz(t) {
    const playing = player.state === "playing";
    const NB = 40, baseY = ROWS - 2, maxH = 14;
    const vals = new Array(NB);
    const f = playing ? freqData() : null;
    if (f) {
      const bins = f.length;
      for (let i = 0; i < NB; i++) {
        const lo = Math.floor(Math.pow(i / NB, 2) * bins);
        const hi = Math.max(lo + 1, Math.floor(Math.pow((i + 1) / NB, 2) * bins));
        let s = 0;
        for (let k = lo; k < hi; k++) s += f[k];
        const v = (s / (hi - lo)) / 255;
        vals[i] = Math.min(1, Math.pow(v, 0.55) * 1.15);
      }
    } else {
      for (let i = 0; i < NB; i++) {
        const v = Math.abs(Math.sin(i * 0.35 + t * 3)) * 0.6 + Math.abs(Math.sin(i * 0.13 - t * 2)) * 0.4;
        vals[i] = Math.min(1, v);
      }
    }
    let lvl = 0;
    for (let i = 0; i < NB; i++) lvl += vals[i];
    lvl /= NB;
    const pump = 0.72 + 0.6 * Math.pow(lvl, 1.6);
    hLine(0, ROWS - 1, COLS, 1);
    for (let i = 0; i < NB; i++) {
      const h = Math.max(0, Math.round(vals[i] * maxH * pump));
      vizPeaks[i] = Math.max(h, vizPeaks[i] - 0.4);
      const ph = Math.min(maxH, Math.round(vizPeaks[i]));
      const c = i * 3;
      for (let y = 0; y < h; y++) setLED(c, baseY - y, 1);
      if (h > 0) setLED(c + 1, baseY - h, 1);
      if (ph > h) setLED(c, baseY - ph, 1);
    }
    drawText("VISUALIZER", 2, 1, 1);
  }

  /* --- scene: VIDEO (1-bit LED frames) ------------------------------- */

  function drawVideoScene(t, videoData, fps) {
    if (videoData.frames) {
      const blob = videoData.blob;
      const off = (Math.floor(t * fps) % videoData.frames) * videoData.bytes;
      const n = Math.min(led.length, videoData.w * videoData.h);
      for (let i = 0; i < n; i++) {
        led[i] = (blob[off + (i >> 3)] >> (7 - (i & 7))) & 1;
      }
      return;
    }
    const n = videoData.length;
    if (!n) return;
    const frame = videoData[Math.floor(t * fps) % n];
    const len = Math.min(led.length, frame.length);
    for (let i = 0; i < len; i++) led[i] = frame[i];
  }

  /* --- scheduler ------------------------------------------------------ */

  const SCENES = [
    { name: "nowplaying", dur: 10, draw: drawNowPlaying },
    { name: "video1", dur: 20, draw: function (t) { drawVideoScene(t, v1VideoData, 12); } },
    { name: "nowplaying", dur: 8, draw: drawNowPlaying },
    { name: "video2", dur: 20, draw: function (t) { drawVideoScene(t, v2VideoData, 12); } },
    { name: "nowplaying", dur: 8, draw: drawNowPlaying },
    { name: "video3", dur: 20, draw: function (t) { drawVideoScene(t, v3VideoData, 12); } },
    { name: "nowplaying", dur: 8, draw: drawNowPlaying },
    { name: "video4", dur: 20, draw: function (t) { drawVideoScene(t, v4VideoData, 12); } },
    { name: "nowplaying", dur: 8, draw: drawNowPlaying },
    { name: "video5", dur: 20, draw: function (t) { drawVideoScene(t, v5VideoData, 12); } },
    { name: "nowplaying", dur: 8, draw: drawNowPlaying },
    { name: "video6", dur: 20, draw: function (t) { drawVideoScene(t, v6VideoData, 12); } },
    { name: "nowplaying", dur: 8, draw: drawNowPlaying },
    { name: "video7", dur: 20, draw: function (t) { drawVideoScene(t, v7VideoData, 12); } },
    { name: "nowplaying", dur: 8, draw: drawNowPlaying },
    { name: "viz", dur: 12, draw: drawViz },
  ];
  const SCENE_TOTAL = SCENES.reduce(function (a, s) { return a + s.dur; }, 0);

  function sceneAt(t) {
    const ct = wrapMod(t, SCENE_TOTAL);
    let acc = 0;
    for (let i = 0; i < SCENES.length; i++) {
      if (ct < acc + SCENES[i].dur) {
        return { scene: SCENES[i], local: ct - acc };
      }
      acc += SCENES[i].dur;
    }
    return { scene: SCENES[0], local: 0 };
  }

  /* --- overlay: button hover label ----------------------------------- */

  const HOVER_LABELS = {
    PLAYPAUSE: "PLAY/PAUSE",
    INSTAGRAM: "INSTAGRAM",
    FORWARD: "FORWARD ►",
    BACKWARD: "BACKWARD ◄",
    SPOTIFY: "SPOTIFY",
    YOUTUBE: "YOUTUBE",
  };

  const HOVER_LABELS_ES = {
    PLAYPAUSE: "PLAY/PAUSA",
    INSTAGRAM: "INSTAGRAM",
    FORWARD: "PROXIMA ►",
    BACKWARD: "ANTERIOR ◄",
    SPOTIFY: "SPOTIFY",
    YOUTUBE: "YOUTUBE",
  };

  function hoverLabelFor(name) {
    const lang = (typeof window !== "undefined" && window.__PORTFOLIO_LANG__) || "es";
    return (lang === "es" ? HOVER_LABELS_ES : HOVER_LABELS)[name];
  }

  function drawHoverLabel() {
    const label = hoverLabelFor(player.hover);
    if (!label) return;
    const pad = 3, bh = 10;
    const bw = textWidth(label) + pad * 2;
    const bx = COLS - bw - 2;
    const by = Math.round((ROWS - bh) / 2);
    for (let y = 0; y < bh; y++)
      for (let x = 0; x < bw; x++) setLED(bx + x, by + y, 0);
    for (let x = 0; x < bw; x++) { setLED(bx + x, by, 1); setLED(bx + x, by + bh - 1, 1); }
    for (let y = 0; y < bh; y++) { setLED(bx, by + y, 1); setLED(bx + bw - 1, by + y, 1); }
    drawText(label, bx + Math.round((bw - textWidth(label)) / 2), by + 2, 1);
  }

  function render() {
    led.fill(0);
    const s = sceneAt(animT / 1000);
    s.scene.draw(s.local);
    drawHoverLabel();
  }

  function blit() {
    ctx.drawImage(bg, 0, 0);
    let changed = 0;
    for (let i = 0; i < led.length; i++) {
      if (led[i] === prevLed[i]) continue;
      prevLed[i] = led[i];
      changed++;
    }
    for (let i = 0; i < led.length; i++) {
      if (led[i]) ctx.drawImage(dot, (i % COLS) * CELL, Math.floor(i / COLS) * CELL);
    }
    tex.needsUpdate = true;
    return changed;
  }

  // The panel animates (blinking cursor, progress bar), so the canvas is
  // genuinely dirty most frames — which means a CPU repaint AND a full
  // texture upload EVERY frame, for as long as this module exists. That loop
  // starts when the MUSIC scene preloads and never stops, so it is a permanent
  // tax on the whole site, not just the MUSIC room. It is capped at every
  // quality level: 30fps is indistinguishable on a 480x96 LED panel and halves
  // the cost outright, and lite mode drops it to 12fps for another 2.5x.
  let lastPaint = 0;
  function tick(now) {
    if (lastDraw === 0) lastDraw = now;
    animT += now - lastDraw;
    lastDraw = now;
    const interval = lite ? LITE_PAINT_MS : PAINT_MS;
    if (now - lastPaint < interval) return;
    lastPaint = now;
    render();
    blit();
  }

  return { canvas: canvas, tex: tex, tick: tick, render: render, blit: blit };
}

let display = null;

// The panel only exists inside the MUSIC room, but its repaint loop used to run
// from the moment the room first loaded until the page closed — burning CPU and
// uploading a texture for a panel that is behind a hidden scene root and cannot
// be seen. That is pure waste, and it is worst at exactly the wrong moment: the
// room EXITS are the busiest frames in the build (a 1.6s camera turn, the audio
// bed ramping, the incoming room's textures going live), and a repaint loop
// competing for the main thread there is the sort of thing a memory-starved
// device does not survive. Gated on the room actually being on screen.
let panelActive = false;
export function setRadioDisplayActive(on) { panelActive = !!on; }

function ensureDisplay() {
  if (display) return display;
  display = createDisplay();
  display.render();
  display.blit();
  requestAnimationFrame(function loop(now) {
    requestAnimationFrame(loop);
    if (document.hidden || !panelActive) return;
    display.tick(now);
  });
  return display;
}

export function getDisplay() {
  return ensureDisplay();
}

// LITE MODE, driven by js/perf.js from main.js. Set on the module (not on the
// display instance) so it can be flipped at any time — including after the
// display already exists and its animation loop is running.
let lite = false;
const PAINT_MS = 1000 / 30;      // cap at every quality level
const LITE_PAINT_MS = 1000 / 12; // and lower again on a constrained device
export function setRadioDisplayLite(v) { lite = !!v; }

// lightweight playback/mix snapshot for the debug API (no LED allocation)
export function mixInfo() {
  return {
    trackCount: TRACKS.length,
    level: +currentLevel().toFixed(3),
    mixTo: +audio.mix.to.toFixed(3),
    mixDur: +audio.mix.dur.toFixed(2),
    mixWallStart: Math.round(audio.mix.wallStart),
    formatOk: audio.formatOk,
    ambient: player.ambient,
    hasCtx: !!audio.ctx,
    ctxState: audio.ctx ? audio.ctx.state : null,
    ctxTime: audio.ctx ? +audio.ctx.currentTime.toFixed(2) : null,
    elPaused: audio.el ? audio.el.paused : null,
    elEnded: audio.el ? audio.el.ended : null,
    elReady: audio.el ? audio.el.readyState : null,
    elNet: audio.el ? audio.el.networkState : null,
    muted: amb.muted,
    bed: {
      src: amb.el ? amb.el.src : null,
      level: +ambLevel().toFixed(3),
      to: +amb.mix.to.toFixed(3),
      dur: +amb.mix.dur.toFixed(2),
      started: amb.started,
      failed: amb.failed,
      loop: amb.el ? amb.el.loop : null,
      paused: amb.el ? amb.el.paused : null,
      readyState: amb.el ? amb.el.readyState : null,
      time: amb.el ? +amb.el.currentTime.toFixed(1) : null,
      duration: amb.el ? +amb.el.duration.toFixed(1) : null,
    },
    pulse: +pulse().toFixed(3),
    levels: { main: VOL_MAIN, other: VOL_OTHER, room: VOL_ROOM },
    src: audio.el ? audio.el.src : null,
    elTime: audio.el ? +audio.el.currentTime.toFixed(2) : null,
    elDur: audio.el && isFinite(audio.el.duration) ? +audio.el.duration.toFixed(2) : null,
    titles: TRACKS.map(function (t) { return t.title; }),
    bpms: TRACKS.map(function (t) { return t.bpm; }),
  };
}

export function __debug(c, r, w, h) {
  let lit = 0;
  if (w === undefined) {
    for (let i = 0; i < led.length; i++) if (led[i]) lit++;
  } else {
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        if (led[(r + y) * COLS + (c + x)]) lit++;
  }
  return {
    animT: animT,
    lastDraw: lastDraw,
    ledLit: lit,
    led0: led.slice(0, 20),
    playerState: player.state,
    playerIndex: player.index,
    playerTrack: player.track ? player.track.title : null,
    playerArtist: player.track ? player.track.artist : null,
    trackCount: TRACKS.length,
    hasCtx: !!audio.ctx,
    formatOk: audio.formatOk,
    ambient: player.ambient,
    level: +currentLevel().toFixed(3),
    mixTo: +audio.mix.to.toFixed(3),
    elapsed: +player.currentTime().toFixed(2),
    duration: +player.duration().toFixed(2),
    hover: player.hover,
  };
}

// FONT5x7 is re-exported at the top of this file (it now lives in
// ./font5x7.js), so it is deliberately absent from this list.
export { player, TRACKS };

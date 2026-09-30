/* fixmojibake.js — repair UTF-8 text that was decoded as Windows-1252.
 *
 * Symptom: an em-dash (U+2014, UTF-8 bytes E2 80 94) that went through a
 * cp1252 decode becomes three characters: â (U+00E2) € (U+20AC) " (U+201D).
 * It is invisible in code behaviour — it only ever lands in comments — but it
 * makes the source unreadable and hides real text.
 *
 * Fix: recognise the three-character sequences cp1252 produces from UTF-8
 * continuation bytes, map each character back to the byte it came from, then
 * re-decode that byte trio as UTF-8. Only touches comment text, but it is run
 * over the whole file so the check is uniform.
 *
 * Usage:  node fixmojibake.js [file ...]      (defaults to the files we edit)
 *         node fixmojibake.js --check          (report only, change nothing)
 */
const fs = require("fs");
const path = require("path");

// cp1252 code point -> the byte it stands for. Only the high range matters:
// cp1252 maps 0x80-0x9F to typographic characters, and those are exactly the
// bytes that appear as the 2nd/3rd byte of a multi-byte UTF-8 sequence.
const CP1252_HIGH = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85,
  0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a,
  0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92,
  0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
  0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c,
  0x017e: 0x9e, 0x0178: 0x9f,
};

// A mangled multi-byte sequence always starts with a lead byte in
// 0xC2-0xF4, which cp1252 renders as one of these Latin-1 letters.
const LEADS = { 0xc2: 0xc2, 0xc3: 0xc3, 0xe2: 0xe2, 0xc5: 0xc5, 0xe3: 0xe3 };

function fix(text) {
  let out = "";
  let changed = 0;
  const bytes = [];
  let i = 0;
  const flushBytes = () => {
    if (bytes.length) {
      const buf = Buffer.from(bytes);
      const dec = buf.toString("utf8");
      // only accept it if it round-trips as valid UTF-8 and is not itself
      // replacement characters
      if (dec.indexOf("\uFFFD") === -1) {
        out += dec;
        changed += bytes.length;
        bytes.length = 0;
        return;
      }
      // not valid UTF-8 — emit the original characters
      out += String.fromCodePoint(...bytes);
      bytes.length = 0;
    }
  };
  while (i < text.length) {
    const cp = text.codePointAt(i);
    const chLen = cp > 0xffff ? 2 : 1;
    const lead = LEADS[cp];
    if (lead !== undefined) {
      // try to assemble lead + 1 or 2 continuation characters
      let assembled = [lead];
      let j = i + chLen;
      for (let k = 0; k < 2 && j < text.length; k++) {
        const ncp = text.codePointAt(j);
        const byte = CP1252_HIGH[ncp];
        if (byte === undefined) break;
        assembled.push(byte);
        j += ncp > 0xffff ? 2 : 1;
      }
      const need = assembled[0] < 0xe0 ? 2 : assembled[0] < 0xf0 ? 3 : 4;
      if (assembled.length === need) {
        for (const b of assembled) bytes.push(b);
        i = j;
        continue;
      }
    }
    flushBytes();
    out += text.substr(i, chLen);
    i += chLen;
  }
  flushBytes();
  return { text: out, changed: changed };
}

const args = process.argv.slice(2);
const checkOnly = args.indexOf("--check") !== -1;
const files = args.filter((a) => a !== "--check");
const list = files.length
  ? files
  : ["js/main.js", "js/perf.js", "js/contactCard.js", "js/crashlog.js",
     "js/mainDisplay.js", "js/radioDisplay.js", "js/aboutBrowser.js",
     "js/lightCues.js", "index.html", "css/style.css", "serve.py"];

let total = 0;
for (const f of list) {
  if (!fs.existsSync(f)) { console.log("skip  " + f); continue; }
  const original = fs.readFileSync(f, "utf8");
  const { text, changed } = fix(original);
  if (changed === 0) { console.log("clean " + f); continue; }
  total += changed;
  console.log((checkOnly ? "WOULD FIX " : "fixed    ") + f + "  (" + changed + " chars)");
  if (!checkOnly) fs.writeFileSync(f, text, "utf8");
}
console.log(checkOnly ? "\n" + total + " chars would be repaired" : "\n" + total + " chars repaired");

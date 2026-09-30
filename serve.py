from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import os
import re
import json
import time
import threading
import gzip
import hashlib
import io

try:
    import brotli
except ImportError:
    brotli = None

os.chdir(os.path.dirname(os.path.abspath(__file__)))

# The custom 404 document. Served with a real 404 status for any path that does
# not exist, so crawlers and clients see the truth while a human gets the art.
NOT_FOUND_PAGE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "404.html")

# Where the client's crash/heartbeat log is written, and how much of it to
# keep. Appended as one JSON object per line so it can be tailed, grepped and
# read by anything. Bounded so a long session cannot fill the disk.
LOG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "crashlog.jsonl")
LOG_MAX_BYTES = 2 * 1024 * 1024
_log_lock = threading.Lock()


def append_log(entry):
    """Append one JSON line, trimming the file if it has grown too big."""
    with _log_lock:
        try:
            if os.path.exists(LOG_PATH) and os.path.getsize(LOG_PATH) > LOG_MAX_BYTES:
                # keep the newest half
                with open(LOG_PATH, "r", encoding="utf-8", errors="replace") as f:
                    lines = f.readlines()
                keep = lines[len(lines) // 2:]
                with open(LOG_PATH, "w", encoding="utf-8") as f:
                    f.writelines(keep)
        except OSError:
            pass
        try:
            with open(LOG_PATH, "a", encoding="utf-8") as f:
                f.write(json.dumps(entry, ensure_ascii=False) + "\n")
        except OSError as err:
            print("  [crashlog] could not write: %s" % err)


def read_log(limit=200):
    try:
        with open(LOG_PATH, "r", encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
    except OSError:
        return []
    return lines[-limit:]


def summarise(entry):
    """One readable line, printed live so a crash is visible without a browser."""
    kind = entry.get("kind")
    room = entry.get("room") or (entry.get("prev") or {}).get("room")
    sid = (entry.get("sid") or "")[:10]
    if kind in ("open",):
        dev = entry.get("dev") or {}
        return "[%s] open  %s  dpr=%s  cores=%s  %s" % (
            sid, dev.get("screen"), dev.get("dpr"), dev.get("cores"),
            (dev.get("gl") or "")[:52])
    if kind == "beat":
        return None  # far too chatty to print
    if kind == "room":
        return "[%s] -> %s  (t+%ss)" % (sid, room, int((entry.get("ms") or 0) / 1000))
    if kind == "bye":
        return "[%s] clean exit from %s after %ss (%s beats)" % (
            sid, room, int((entry.get("ms") or 0) / 1000), entry.get("beats"))
    if kind in ("crash", "crash+js"):
        p = entry.get("prev") or {}
        dev = entry.get("reportedBy") or {}
        at = entry.get("atDeath") or {}
        errs = p.get("errors") or []
        fg = entry.get("wasForeground")
        # a session that ended while hidden is usually just an app switch, but
        # it is reported anyway rather than discarded
        conf = ("PROBABLE" if fg else "ambiguous - page was hidden, may just be an app switch")
        return ("\n" + "!" * 70 + "\n"
                "! CRASH (%s)  %s\n"
                "!   died in room : %s  (after %ss in that room)\n"
                "!   survived     : %ss of page life, %s heartbeats\n"
                "!   silence      : %ss before the site was next opened\n"
                "!   device       : %s  iOS %s  dpr %s  cores %s  mem %s\n"
                "!   gpu          : %s\n"
                "!   quality at   : tier %s, pixel ratio %s, lite %s, fps %s\n"
                "!   viewer said  : scene %s, music interacted %s\n"
                "!   js errors    : %s\n"
                "%s\n" % (
                    conf,
                    p.get("sid"),
                    p.get("room"),
                    p.get("inRoomSec"),
                    int(((p.get("lastBeat") or 0) - (p.get("started") or 0)) / 1000),
                    p.get("beats"),
                    int((entry.get("silentMs") or 0) / 1000),
                    dev.get("screen"), dev.get("iosVersion") or "n/a",
                    dev.get("dpr"), dev.get("cores"), dev.get("memoryGb") or "n/a",
                    dev.get("gl"),
                    at.get("tier"), at.get("pixelRatio"), at.get("lite"), at.get("fps"),
                    at.get("scene"), at.get("musicInteracted"),
                    ("\n!                 ".join(errs) if errs else "none captured"),
                    "!" * 70))
    if kind == "jserror":
        return "[%s] JS ERROR in %s: %s" % (sid, room, entry.get("message"))
    return "[%s] %s" % (sid, kind)


# ---------------------------------------------------------------------------
# Transport compression + caching.
#
# The site's own payload is very compressible and was being shipped raw: the
# 18 js/videos modules are base64 text (8.3 MB on its own) and the whole
# first-paint payload is ~8.9 MB. Measured on this tree, brotli takes that to
# ~1.7 MB and gzip to ~1.9 MB, so this is the single largest win available and
# it costs the client nothing but a header.
#
# Two rules keep it safe:
#   * never compress a Range response, and never compress audio/video/model
#     types at all. Byte offsets have to address the stored bytes for seeking
#     and streaming to work; re-encoding them breaks both.
#   * never compress on top of a cache hit we cannot trust, so the payload
#     cache is keyed by mtime AND size and re-checks both.
# ---------------------------------------------------------------------------

COMPRESSIBLE = {
    ".html", ".htm", ".js", ".mjs", ".css", ".json", ".svg", ".xml",
    ".map", ".txt", ".webmanifest",
}

# Media is served as-is but is worth caching hard: it is 250 MB of the repo and
# it does not change between deploys. One day is long enough to make repeat
# visits free and short enough that a re-exported texture shows up tomorrow
# rather than never. SERVE_CACHE=aggressive switches media to a year immutable
# for a real deploy.
CACHE_DAY = 86400
CACHE_YEAR = 31536000
AGGRESSIVE = os.environ.get("SERVE_CACHE", "").lower() == "aggressive"

# Compressed payloads, keyed by (path, mtime, size, encoding). These files are
# immutable between edits, so re-hashing a 900 KB module on every request is
# pure waste. Bounded by total bytes held, and dropped wholesale past the cap:
# a partial eviction would need an LRU, and a full flush costs nothing here
# because the next request just recompresses.
_payload_cache = {}
_payload_bytes = 0
_payload_lock = threading.Lock()
_PAYLOAD_CACHE_MAX = 64 * 1024 * 1024


def _cache_control(path):
    ext = os.path.splitext(path)[1].lower()
    # The entry document must never be served stale: it is what points at the
    # hashed/named assets, and it is 4 KB, so revalidating it costs nothing.
    if ext in (".html", ".htm"):
        return "no-cache"
    if ext in COMPRESSIBLE:
        # Long-lived, but revalidated every time: an ETag match costs one 304
        # with an empty body, so edits are picked up immediately while a repeat
        # visit transfers no payload at all.
        return "public, max-age=0, must-revalidate"
    return "public, max-age=%d%s" % (
        CACHE_YEAR if AGGRESSIVE else CACHE_DAY, ", immutable" if AGGRESSIVE else ""
    )


def _etag(st):
    # Weak, because the validator only has to notice "this file changed".
    return '"%s"' % hashlib.sha256(st.encode("utf-8", "replace")).hexdigest()[:20]


def _pick_encoding(path, accept):
    """Best encoding this client accepts and we can produce, or None."""
    ext = os.path.splitext(path)[1].lower()
    if ext not in COMPRESSIBLE:
        return None
    # Parse Accept-Encoding with q-values rather than a substring test, so a
    # client that writes "gzip;q=0" is not served gzip. q decides; the br-over-
    # gzip rank only breaks a tie, since a client that weights them equally
    # wants whichever encoding is smaller.
    best, best_q, best_rank = None, -1.0, 0
    for part in accept.split(","):
        bits = part.strip().split(";")
        name = bits[0].strip().lower()
        q = 1.0
        for p in bits[1:]:
            p = p.strip()
            if p.startswith("q="):
                try:
                    q = float(p[2:])
                except ValueError:
                    q = 0.0
        if q <= 0:
            continue
        if name == "br" and brotli is not None:
            rank, enc = 2, "br"
        elif name == "gzip":
            rank, enc = 1, "gzip"
        else:
            continue
        if q > best_q or (q == best_q and rank > best_rank):
            best, best_q, best_rank = enc, q, rank
    return best


def _compress(data, enc):
    if enc == "br":
        return brotli.compress(data, quality=5)
    buf = io.BytesIO()
    # mtime=0 keeps the gzip header byte-identical across runs, which keeps the
    # ETag stable and stops pointless revalidation.
    with gzip.GzipFile(fileobj=buf, mode="wb", compresslevel=6, mtime=0) as f:
        f.write(data)
    return buf.getvalue()


def _payload(path, enc):
    """(body, etag) for a file, compressed if asked. Cached by mtime+size."""
    global _payload_bytes
    st = os.stat(path)
    key = (path, st.st_mtime, st.st_size, enc)
    with _payload_lock:
        hit = _payload_cache.get(key)
    if hit is not None:
        return hit
    with open(path, "rb") as f:
        raw = f.read()
    # The ETag describes the STORED bytes. That is deliberate: a client that
    # cached the identity version and a client that cached the brotli version
    # then disagree, and Vary: Accept-Encoding keeps them in separate cache
    # entries, so neither is ever handed the wrong body.
    etag = _etag("%s|%d|%d" % (path, st.st_mtime, st.st_size))
    body = _compress(raw, enc) if enc else raw
    with _payload_lock:
        if _payload_bytes + len(body) > _PAYLOAD_CACHE_MAX:
            _payload_cache.clear()
            _payload_bytes = 0
        _payload_cache[key] = (body, etag)
        _payload_bytes += len(body)
    return body, etag


class Handler(SimpleHTTPRequestHandler):
    extensions_map = dict(SimpleHTTPRequestHandler.extensions_map)
    extensions_map.update(
        {
            ".webp": "image/webp",
            ".avif": "image/avif",
            ".glb": "model/gltf-binary",
            ".woff2": "font/woff2",
            ".mjs": "text/javascript",
            ".js": "text/javascript",
            ".json": "application/json",
            ".ogg": "audio/ogg",
            # pinned rather than left to the system MIME database: a manifest
            # served as the wrong type is silently ignored by the browser
            ".webmanifest": "application/manifest+json",
            ".png": "image/png",
            ".mp3": "audio/mp3",
        }
    )

    # Byte-range support. Without it a browser streaming media never fetches the
    # tail, so it derives a container's duration from a mid-file page and
    # reports the file short (measured ~10 s under on these songs). Real hosts
    # send Accept-Ranges, so this keeps local playback and seeking behaving like
    # the deployed site.
    def do_POST(self):
        """Crash/heartbeat sink for js/crashlog.js.

        Kept deliberately dull: read the body, append it as a JSON line, answer
        204. It never blocks the client and never throws back at the page, so a
        broken or missing log can never affect whether the site works.
        """
        if self.path.split("?")[0] != "/__log":
            self.send_error(404)
            return
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = 0
        n = max(0, min(n, 64 * 1024))  # cap it; nothing legitimate is huge
        raw = self.rfile.read(n) if n else b""
        try:
            entry = json.loads(raw.decode("utf-8", "replace") or "{}")
        except ValueError:
            entry = {"kind": "malformed", "raw": raw[:200].decode("utf-8", "replace")}
        if not isinstance(entry, dict):
            entry = {"kind": "malformed", "raw": str(entry)[:200]}
        entry.setdefault("kind", "?")
        entry["receivedAt"] = time.time()
        append_log(entry)
        line = summarise(entry)
        if line:
            print(line, flush=True)
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        """GET /__log dumps the log as text; /__log?clear=1 empties it."""
        if self.path.split("?")[0] != "/__log":
            return SimpleHTTPRequestHandler.do_GET(self)
        if "clear=1" in self.path:
            with _log_lock:
                try:
                    open(LOG_PATH, "w").close()
                except OSError:
                    pass
            body = b"cleared\n"
        else:
            limit = 200
            m = re.search(r"limit=(\d+)", self.path)
            if m:
                limit = max(1, min(int(m.group(1)), 5000))
            raw = "".join(read_log(limit)).encode("utf-8", "replace")
            body = raw if raw else b"(no entries yet)\n"
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_error(self, code, message=None, explain=None):
        """Answer a 404 with the site's own 404 page, keeping the 404 status.

        The status code is the important part: a pretty page served as 200
        would tell a search engine the URL is fine, and would break any client
        checking for a 404. Everything else (416 on a bad range, 501, a real
        internal error) is left to the base class untouched.
        """
        if code == 404 and self._serve_not_found_page():
            return
        SimpleHTTPRequestHandler.send_error(self, code, message, explain)

    def _serve_not_found_page(self):
        """Emit 404.html for the current path. False if it is unusable."""
        if self.command not in ("GET", "HEAD"):
            return False  # a POST to a bad path wants an empty 404, not a page
        try:
            with open(NOT_FOUND_PAGE, "rb") as f:
                body = f.read()
        except OSError:
            return False
        self.send_response(404)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        # The page is a fixed document at a fixed URL: cache it, but let it
        # revalidate so editing 404.html is picked up on the next miss.
        self.send_header("Cache-Control", "public, max-age=0, must-revalidate")
        self.end_headers()
        if self.command == "GET":
            self.wfile.write(body)
        return True

    def send_head(self):
        path = self.translate_path(self.path)
        # Directory (redirect/listing) and anything missing: let the base class
        # emit its 301/404 exactly as before.
        if os.path.isdir(path) or not os.path.isfile(path):
            return SimpleHTTPRequestHandler.send_head(self)

        if self.headers.get("Range"):
            return self._send_range(path, self.headers.get("Range"))

        enc = _pick_encoding(path, self.headers.get("Accept-Encoding", ""))
        if not enc:
            return self._send_identity(path)
        return self._send_encoded(path, enc)

    def _send_identity(self, path):
        """Uncompressed 200 with an ETag."""
        body, etag = _payload(path, None)
        if self._not_modified(etag):
            return None
        self.send_response(200)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Last-Modified", self.date_time_string(os.stat(path).st_mtime))
        self.send_header("ETag", etag)
        self.send_header("Vary", "Accept-Encoding")
        self.end_headers()
        return io.BytesIO(body)

    def _send_encoded(self, path, enc):
        """Compressed 200, or a 304 when the client's ETag is still good."""
        body, etag = _payload(path, enc)
        if self._not_modified(etag):
            return None
        self._no_accept_ranges = True  # byte offsets no longer address the file
        self.send_response(200)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Encoding", enc)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Last-Modified", self.date_time_string(os.stat(path).st_mtime))
        self.send_header("ETag", etag)
        self.send_header("Vary", "Accept-Encoding")
        self.end_headers()
        return io.BytesIO(body)

    def _not_modified(self, etag):
        got = self.headers.get("If-None-Match")
        if not got:
            return False
        # Weak comparison: W/"x" and "x" are equivalent for a cache validator.
        bare = etag.strip('W/').strip('"')
        for cand in got.split(","):
            if cand.strip().strip("W/").strip('"') == bare:
                self.send_response(304)
                self.send_header("ETag", etag)
                self.send_header("Vary", "Accept-Encoding")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return True
        return False

    def _send_range(self, path, rng):
        # Byte-range: Byte ranges are served from the STORED bytes, uncompressed
        # and unvalidated, exactly as before. A Range request never gets a
        # 304 (the client asked for specific bytes) and never gets compression.
        m = re.match(r"bytes=(\d*)-(\d*)$", rng.strip())
        if not m:
            return SimpleHTTPRequestHandler.send_head(self)

        size = os.path.getsize(path)
        start_s, end_s = m.group(1), m.group(2)
        if start_s == "" and end_s == "":
            return SimpleHTTPRequestHandler.send_head(self)
        if start_s == "":  # suffix range: last N bytes
            start = max(0, size - int(end_s))
            end = size - 1
        else:
            start = int(start_s)
            end = int(end_s) if end_s else size - 1
        if start >= size or start > end:
            self.send_response(416)
            self.send_header("Content-Range", "bytes */%d" % size)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return None
        end = min(end, size - 1)

        f = open(path, "rb")
        f.seek(start)
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("ETag", _etag("%s|%d|%d" % (path, os.stat(path).st_mtime, size)))
        self.end_headers()
        return _RangeWrapper(f, end - start + 1)

    def end_headers(self):
        names = self._headers_buffer_names()
        if "accept-ranges" not in names and not getattr(self, "_no_accept_ranges", False):
            self.send_header("Accept-Ranges", "bytes")
        # Only add a default if this response has not already chosen one:
        # _send_encoded / _send_identity / _send_range all set it deliberately,
        # and the crash endpoints want no-cache.
        if "cache-control" not in names:
            path = self.translate_path(self.path.split("?")[0])
            self.send_header("Cache-Control", _cache_control(path))
        super().end_headers()

    def _headers_buffer_names(self):
        # SimpleHTTPRequestHandler buffers headers until end_headers(); peek at
        # what we've already queued so we don't emit Accept-Ranges twice.
        buf = getattr(self, "_headers_buffer", None)
        if buf is None:
            return []
        return [line.split(b":", 1)[0].strip().lower() for line in buf if b":" in line]


class _RangeWrapper:
    """File-like that stops after `remaining` bytes so copyfile stops cleanly."""

    def __init__(self, f, remaining):
        self.f = f
        self.remaining = remaining

    def read(self, n=-1):
        if self.remaining <= 0:
            return b""
        if n is None or n < 0 or n > self.remaining:
            n = self.remaining
        data = self.f.read(n)
        self.remaining -= len(data)
        return data

    def close(self):
        self.f.close()


if __name__ == "__main__":
    import socket

    PORT = 8000

    def lan_ip():
        # The address other devices on the same network actually use. Asking the
        # DNS resolver for our own name gives the primary adapter's address
        # without sending a packet, which is what we want: a phone on the same
        # Wi-Fi has to reach this host by IP, not by "localhost".
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
        except OSError:
            return None
        finally:
            s.close()

    ip = lan_ip()
    print("serving portfolio on http://localhost:%d" % PORT)
    if ip:
        print("  on your network:  http://%s:%d   <- open this on your phone" % (ip, PORT))
        print("  (phone must be on the SAME wifi; if it won't load, allow python")
        print("   through the firewall:  netsh advfirewall firewall add rule")
        print("   name=\"portfolio 8000\" dir=in action=allow protocol=TCP localport=%d" % PORT)
    else:
        print("  no LAN address found (offline?) - localhost only")
    print("Ctrl+C to stop.")
    print("crash log -> %s   (browser view: http://localhost:%d/__log)" % (LOG_PATH, PORT))
    print("  the site posts a heartbeat here every 2s; if a session stops")
    print("  while in the foreground, the next page load reports it as a CRASH.")
    ThreadingHTTPServer(("", PORT), Handler).serve_forever()

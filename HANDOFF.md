# HANDOFF

State of the site as of this session. Read the **BLOCKED** section first — the
work is finished, but it cannot be pushed anywhere until three things come back
from you.

**The server is running** at http://localhost:8000 (and
http://192.168.1.179:8000 on wifi) if you want to look at anything.

---

## BLOCKED — need these to push to GitHub

### 1. Git identity (nothing works without it)

```powershell
git config --global user.name  "Alejandro Enrique"
git config --global user.email "<your github email>"
```

Both are currently unset. The repo is initialised on branch `master` with
**1,472 files staged but zero commits** — `git commit` will fail without this.

### 2. Repo name + whether you own `gov.info.ve`

Your GitHub username is `cachamas`. That alone doesn't tell me the URL, and the
URL decides real code changes, not just config:

| If you host at | Then |
|---|---|
| `cachamas.github.io/cachamas.github.io` (user site) | root-absolute paths work as-is |
| `cachamas.github.io/<anything-else>` (project site) | **the 404 page breaks** — see §3 |
| a custom domain on `gov.info.ve` | keep the SEO URLs as they are |

**I hardcoded `https://gov.info.ve/`** into the canonical link, `og:url`,
`og:image`, `og:image:secure_url`, `twitter:image`, every JSON-LD `@id`, the
`robots.txt` sitemap line and `sitemap.xml`. Those are only correct if
`gov.info.ve` actually resolves to the host. If you deploy to
`cachamas.github.io/...` instead, all of it has to change.

You have `dm@gov.info.ve`, so you probably own the domain — but confirm.

### 3. `media/og.png` — you need to re-drop it

**I overwrote your image.** You had replaced my generated 1200×630 card with your
own 397 KB one. I saw the size change, wrongly concluded the file had been
truncated by one of the killed processes, and regenerated over the top of it.
No copy survived. Sorry — that was my mistake.

Drop your file back at `media/og.png` and **do not let me run
`mkcards.py` again** (it writes that path).

---

## THE ACTUAL PROBLEM: GitHub Pages bandwidth

This matters more than any SEO work, and it is the thing to decide before
pushing.

GitHub Pages free tier has a **1 GB/month bandwidth limit**. Measured cost of
one first visit on this site:

| | bytes |
|---|---|
| critical path (brotli JS + CSS + HTML) | 1.73 MB |
| `MAIN_compressed.glb` | 10.7 MB |
| three.js + DRACO decoder (CDN) | 1.27 MB |
| MAIN decal re-roll (19 webps) | 5.8 MB |
| desktop background preload (4 more rooms) | 19.6 MB |
| **desktop total** | **~39 MB** |
| **mobile total** (preload off) | **~19 MB** |

**1 GB ÷ 39 MB ≈ 27 desktop visitors a month.** After that GitHub stops serving
the models and textures and the site breaks for everybody.

For a portfolio for an established artist that is the single most damaging
thing that could happen. Options, cheapest first:

1. **Cloudflare Pages** — free, no bandwidth cap. Best fit for a 285 MB static site.
2. **Netlify** — free, 100 GB/month.
3. **GitHub Pages Pro** — $4/month, 100 GB.
4. GitHub Pages free, but only after cutting the payload hard.

Verify the current limits before deciding — they may have changed.

---

## What is done and verified

### Debloat
306 MB / 1,498 files → **285 MB / 1,473 files**. Removed: `crashlog.jsonl`,
`__pycache__`, 7 `*.mp3.orig`, 15 `*.ogg`, 2 empty dirs, 3 stale root-level
Python duplicates, the orphan `pantallitarelieve.webp`, 6 undocumented
Playwright harnesses, and `README.md` / the old `HANDOFF.md` (you didn't want
them). `.gitignore` covers all of it, including the 30.9 MB master clip.

### Transport (`serve.py`)
| | before | after |
|---|---|---|
| first-paint JS + CSS + HTML | 8.89 MB | **1.73 MB** brotli (−81%) |
| repeat visit | 8.89 MB | **~0** (ETag 304s) |

Brotli + gzip with real q-value negotiation, ETag + `Vary: Accept-Encoding`,
per-type `Cache-Control`, and a brotli-aware payload cache. Media and models are
**never** compressed so byte-range seeking still works. `404.html` is served for
any missing path **with a real 404 status**.

### Loading screen
`js/loadingScreen.js` — separate entry point, dynamically imports the clip so
the 300 KB payload never blocks `main.js`. Black field, square blue plate,
120×120 12 fps 1-bit clip (53 KB brotli, 592× smaller than the 30.9 MB master),
`NOT A GOVERNMENT WEBSITE` above it and a scrolling `LOADING PORTFOLIO...` belt
below, both in the same 5×7 LED face as the LENGUAJE/LANGUAGE badge.

### Dot-matrix tooling
`tools/video_to_dotmatrix.py` — replaces the converter you lost. Full spec in
`LOADING.md`. **Use `--mode fixed`** (hard threshold); that is what your shipped
clips use, proven by a bimodal block histogram of the real modules.

### SEO
`Person` + `WebSite` JSON-LD, absolute OG/Twitter URLs, canonical, manifest,
`robots.txt`, `sitemap.xml`, and a **580-word semantic `<article>`** — the site
had *zero* indexable text before, because everything is painted into a canvas.
No `GovernmentOrganization` schema and no government keyword-stuffing; both would
contradict the site's own "NOT A GOVERNMENT WEBSITE" premise.

### Other
404 page with a way back, dot-matrix `RETRY`/`REINTENTAR` on load failure,
`<noscript>`, OG card, web manifest, preload hints.

### Test suites (all green, all run against the live server)
| script | proves |
|---|---|
| `verify_loading` | module shape, wire size, **bit-exact** round trip, density inside the shipped band, wiring, not-cloaking |
| `verify_serve` | compression, q-values, ETag/304, byte-exact ranges, cache policy, 45 checks |
| `verify_404` + path resolution | art page at a real 404 status, assets resolve at any depth |
| `verify_seo` | JSON-LD validity, absolute URLs, robots/sitemap, heading structure |
| `reach` | all 48 runtime assets reachable and correctly typed |

---

## Gotchas that will cost you time if you forget them

- **The `prefers-reduced-motion` belt bug is fixed, do not reintroduce it.** The
  `LOADING PORTFOLIO` belt was frozen on your desktop (animation effects off),
  stranding a fragment of the message mid-sentence. The belt now has **no**
  reduced-motion override at all — it scrolls unconditionally. It is also
  declared in longhand, because with the `animation` shorthand one unparseable
  custom property kills the whole declaration silently.
- **`js/loadingScreen.js` — the rAF loop must survive a missing clip.** The
  first frame fires before the dynamic import resolves. Returning early *without*
  re-requesting a frame kills the loop permanently and the panel never appears.
  `kick()` exists for exactly this.
- **Do not use `playwright-core` to screenshot the site.** It hung twice and had
  to be killed. The harnesses at the repo root need it; everything else is
  verified statically. If you do run them, headless Chrome throttles
  `requestAnimationFrame` unless you pass
  `--disable-backgrounding-occluded-windows --disable-renderer-backgrounding
  --disable-background-timer-throttling --disable-features=CalculateNativeWinOcclusion`,
  or every rAF loop silently stops and the suite reports "no errors" on a broken page.
- **`404.html` asset paths are root-absolute on purpose** (`/ico.webp`,
  `/media/404/404.webp`). A relative path in a 404 resolves against whatever
  directory the visitor actually asked for, so at `/a/b/c` the image 404s again.
  **But root-absolute breaks on a subpath host** — if you deploy to
  `cachamas.github.io/<repo>/`, inline the image as a data URI instead.
- **`FONT5x7` now lives in `js/font5x7.js`**, re-exported by
  `js/radioDisplay.js` so every existing importer still works. Do not import it
  from `radioDisplay.js` in anything on the critical path — that module
  statically imports seven radio clips (~800 KB).
- **The decal re-roll policy** (`NOVEL_ROLLS = 3`, `REPEAT_CHANCE = 0.4`,
  `HISTORY_MAX = 24` in `js/main.js`): first 3 rolls are all-new, after that
  ~52% of decals come from cache. Simulated over 2,000 sessions; invariants hold
  (never repeats the current image, never duplicates a number within a category).
- **`node_modules/` is gitignored** and there is still **no `package.json`**, so
  the four harnesses are not reproducible for anyone else. Worth adding.
- **No `LICENSE` file.** A public repo with artwork and music in it shows as
  "Unlicensed".
- Regenerate the clip with the exact command recorded in the module header
  (`// gen: ...`). `verify_loading` parses that line and re-derives the pixels,
  so the check follows your settings instead of going stale.

---

## To pick up

```powershell
# 1. identity
git config --global user.name  "Alejandro Enrique"
git config --global user.email "<your github email>"

# 2. re-drop your media/og.png

# 3. serve and look
python serve.py

# 4. once the host/URL question is settled, replace the domain. It appears in:
#      index.html    14 lines (canonical, og:url, og:image, og:image:secure_url,
#                    twitter:image, and the JSON-LD @id/url/image fields)
#      robots.txt     2 lines
#      sitemap.xml    2 lines
#    then:
git commit -m "Initial commit: WebGL portfolio"
git remote add origin https://github.com/cachamas/<repo>.git
git push -u origin master
```

`git status` will show everything already staged. Nothing is committed yet.

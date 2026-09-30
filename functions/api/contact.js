/* ------------------------------------------------------------------ */
/*  POST /api/contact — first-party mail relay for the contact form.   */
/*                                                                       */
/*  WHY THIS EXISTS                                                       */
/*                                                                       */
/*  The form used to POST straight from the browser to a third-party      */
/*  form host (FormSubmit, then Web3Forms). That means every delivery    */
/*  depended on someone else's CORS policy and bot protection: a         */
/*  cross-origin POST needs an Access-Control-Allow-Origin header, and    */
/*  if that host stops sending one — or starts fingerprinting the        */
/*  request — the form dies with nothing to fix in this repo.             */
/*                                                                       */
/*  Probing the endpoints directly from a non-browser origin returned    */
/*  Cloudflare "Error 1010: Access denied" before CORS was even           */
/*  evaluated, which is exactly the fragility being complained about.    */
/*                                                                       */
/*  A Pages Function sits on the SAME origin as the site, so the browser  */
/*  never performs a cross-origin request and CORS is not involved at     */
/*  all. The relay happens server-side, where no preflight exists.        */
/*                                                                       */
/*  It also keeps credentials out of the client. The access keys live in */
/*  Cloudflare environment variables, so nothing secret is shipped to a  */
/*  visitor's browser.                                                    */
/*                                                                       */
/*  TRANSPORTS, tried in order. First one that confirms delivery wins.    */
/*                                                                       */
/*    1. MAIL binding          Cloudflare's own send_email binding, via     */
/*                              Email Routing. Recommended when the domain  */
/*                              is already on Cloudflare: native, no third  */
/*                              party email company, no per-message cost.   */
/*                              Setup steps are in viaBinding below.        */
/*    2. RESEND_API_KEY        Resend. A real transactional provider with   */
/*                              a real success/failure response. Free tier  */
/*                              ~3000/month.                               */
/*    3. WEB3FORMS_KEY         Browser-oriented free plan. NOTE: Web3Forms */
/*                              rejects server-side POSTs on the free      */
/*                              plan, so this only works on Pro. Left in    */
/*                              for completeness, not relied on.            */
/*    4. FormSubmit            Last resort. Its bot protection has been   */
/*                              observed returning 1010 to non-browser    */
/*                              origins.                                  */
/*                                                                       */
/*  Configure at least one. With none set, the endpoint says so plainly   */
/*  instead of pretending, and the client falls back to the address.     */
/* ------------------------------------------------------------------ */

const MAX_NAME = 120;
const MAX_EMAIL = 200;
const MAX_MESSAGE = 8000;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 5;

// Best-effort per-isolate throttle. Not a security boundary — it exists to
// stop a bored person hammering the endpoint. Anything stricter wants KV.
const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_MAX) {
    hits.set(ip, recent);
    return true;
  }
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear(); // don't grow without bound
  return false;
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      // the form is same-origin, so this is belt and braces
      "X-Content-Type-Options": "nosniff",
    },
  });

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function validate(body) {
  const name = String(body.name || "").trim();
  const email = String(body.email || "").trim();
  const message = String(body.message || "").trim();
  if (!name || !email || !message) return { error: "name, email and message are all required" };
  if (name.length > MAX_NAME || email.length > MAX_EMAIL || message.length > MAX_MESSAGE) {
    return { error: "one of the fields is too long" };
  }
  // deliberately permissive: we only need something that can receive a reply
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: "that email address looks invalid" };
  return { name, email, message };
}

/* ------------------------------ transports ------------------------------ */

/* Every transport gets its OWN deadline.
 *
 * This is not optional. Measured: with an unbounded chain, a single provider
 * that hangs burned Cloudflare's entire 20 s edge budget and the request came
 * back as Cloudflare's own 502 page - the function never got to answer, so the
 * diagnostics it builds could not be read either. One slow provider was
 * destroying the whole endpoint's ability to report anything.
 *
 * Budgets are deliberately uneven. Resend is a real transactional API and is
 * expected to answer in well under a second, so it gets the most room.
 * FormSubmit is last-resort and has been observed returning 522 and hanging
 * outright, so it gets the least: it can never dominate the response.
 *
 * The numbers must also add up. The per-transport budgets total 14 s, and the
 * GLOBAL_BUDGET below is checked between attempts so the function ALWAYS
 * returns a body. Cloudflare kills an unresponded request at 20 s and replaces
 * it with its own 502 page, which destroys the diagnostics as well as the
 * result - a 502 from this endpoint means "the function never finished", not
 * "delivery failed", and the two need to be told apart.                        */
const BUDGET = { binding: 3500, resend: 5000, web3forms: 3000, formsubmit: 2500 };
const GLOBAL_BUDGET_MS = 15000;

// Takes a TRANSPORT NAME, not a delay, and looks the budget up itself. It
// originally took milliseconds and every call site passed a name instead, so
// AbortSignal.timeout received "resend" and threw TypeError on every real
// send. Bounded by the three validation paths returning before any transport
// runs, which is why the health check stayed green while nothing could send.
function withDeadline(name) {
  const ms = BUDGET[name] || 3000;
  try {
    if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
      return { signal: AbortSignal.timeout(ms) };
    }
  } catch (e) { /* fall through */ }
  const c = new AbortController();
  setTimeout(() => { try { c.abort(); } catch (e) {} }, ms);
  return { signal: c.signal };
}

// Runs one transport and never lets it exceed its budget. Returns null when
// the transport is not configured, which is different from failing.
async function bounded(name, fn) {
  try {
    const r = await Promise.race([
      fn(),
      new Promise((_, rej) => setTimeout(() => {
        const e = new Error("timed out after " + BUDGET[name] + "ms");
        e.name = "TransportTimeout";
        rej(e);
      }, BUDGET[name] + 500)),
    ]);
    return r;
  } catch (e) {
    // An aborted fetch reports "The operation was aborted", which says nothing
    // useful when you are trying to work out why a send failed. Both timeout
    // paths - the AbortSignal and the race below - land here, so normalise.
    const aborted = e && (e.name === "TimeoutError" || e.name === "AbortError");
    return {
      ok: false,
      via: name,
      detail: aborted
        ? `timed out after ${BUDGET[name] || 3000}ms`
        : String((e && e.message) || e).slice(0, 120),
    };
  }
}

async function viaResend(env, m) {
  if (!env.RESEND_API_KEY) return null;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + env.RESEND_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.MAIL_FROM || "Portfolio <onboarding@resend.dev>",
      to: [env.MAIL_TO || "dm@gov.info.ve"],
      reply_to: m.email,
      subject: "Portfolio enquiry from " + m.name,
      text: `From: ${m.name} <${m.email}>\n\n${m.message}`,
      html:
        `<p><strong>${esc(m.name)}</strong> &lt;${esc(m.email)}&gt;</p>` +
        `<p style="white-space:pre-wrap">${esc(m.message)}</p>`,
    }),
    ...withDeadline("resend"),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, via: "resend", detail: body?.message || "HTTP " + r.status };
  return { ok: true, via: "resend", id: body?.id || null };
}

/* Cloudflare's own send_email binding, via Email Routing.
 *
 * Setup, all in the Cloudflare dashboard for gov.info.ve:
 *
 *   1. Email -> Email Routing -> Get started. This needs the zone on
 *      Cloudflare's nameservers, which it already is for Pages.
 *   2. Routing rules -> Destination addresses -> Add. Add dm@gov.info.ve and
 *      click the verification link that lands in that mailbox. Until this is
 *      verified the binding below will not be able to send.
 *   3. Routing rules -> Routes -> Create. Custom address `dm`, action
 *      "Send to a verified email address", destination dm@gov.info.ve.
 *      This makes ordinary mail to the address keep working, which matters
 *      because it is the address the site advertises.
 *   4. Workers & Pages -> your project -> Settings -> Functions -> Bindings.
 *      Variable name `MAIL`, type "Send email", destination dm@gov.info.ve.
 *
 * The binding takes a full RFC 5322 message rather than a field bag, so the
 * message is assembled here. From is pinned to the zone's own domain because
 * Cloudflare rejects a From outside it, and Reply-To carries the visitor's
 * address so hitting Reply on the delivered mail still works.            */
async function viaBinding(env, m) {
  if (!env.MAIL || typeof env.MAIL.send !== "function") return null;

  const from = env.MAIL_FROM || "Portfolio <noreply@gov.info.ve>";
  const to = env.MAIL_TO || "dm@gov.info.ve";

  // Header values must not contain raw newlines (injection), so fold to spaces.
  const safe = (s) => String(s).replace(/[\r\n]+/g, " ").trim();
  const boundary = "----pf" + Math.random().toString(36).slice(2, 12);

  const mime = [
    "From: " + from,
    "To: " + to,
    "Reply-To: " + safe(m.name) + " <" + safe(m.email) + ">",
    "Subject: " + safe("Portfolio enquiry from " + m.name),
    "MIME-Version: 1.0",
    'Content-Type: multipart/alternative; boundary="' + boundary + '"',
    "",
    "--" + boundary,
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: base64",
    "",
    btoa(unescape(encodeURIComponent(
      `From: ${m.name} <${m.email}>\n\n${m.message}\n`
    ))),
    "",
    "--" + boundary,
    'Content-Type: text/html; charset="utf-8"',
    "Content-Transfer-Encoding: base64",
    "",
    btoa(unescape(encodeURIComponent(
      `<p><strong>${esc(m.name)}</strong> &lt;${esc(m.email)}&gt;</p>` +
      `<p style="white-space:pre-wrap">${esc(m.message)}</p>`
    ))),
    "",
    "--" + boundary + "--",
    "",
  ].join("\r\n");

  await env.MAIL.send(mime);
  return { ok: true, via: "cloudflare-email" };
}

async function viaWeb3Forms(env, m) {
  if (!env.WEB3FORMS_KEY) return null;
  const r = await fetch("https://api.web3forms.com/submit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      access_key: env.WEB3FORMS_KEY,
      name: m.name,
      email: m.email,
      replyto: m.email,
      subject: "Portfolio enquiry from " + m.name,
      message: m.message,
    }),
    ...withDeadline("web3forms"),
  });
  const body = await r.json().catch(() => ({}));
  const ok = body && (body.success === true || body.success === "true");
  return ok ? { ok: true, via: "web3forms" }
            : { ok: false, via: "web3forms", detail: body?.message || "rejected" };
}

async function viaFormSubmit(m) {
  const r = await fetch("https://formsubmit.co/ajax/dm@gov.info.ve", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      name: m.name, email: m.email, message: m.message,
      _subject: "Portfolio enquiry", _template: "table",
    }),
    ...withDeadline("formsubmit"),
  });
  const body = await r.json().catch(() => ({}));
  const ok = body && (body.success === true || body.success === "true");
  return ok ? { ok: true, via: "formsubmit" }
            : { ok: false, via: "formsubmit", detail: body?.message || "rejected" };
}

/* -------------------------------- handler ------------------------------- */

export async function onRequestPost(ctx) {
  try {
    return await handlePost(ctx);
  } catch (err) {
    // Any unexpected throw used to escape as Cloudflare's own 502 page, which
    // is indistinguishable from a delivery failure and carries none of the
    // detail. Answer with a real body and log it to the Pages log instead, so
    // a bug here is visible rather than mysterious.
    console.error("[contact] unhandled", err && (err.stack || err.message || err));
    return json(
      { success: false, message: "relay error", detail: String((err && err.message) || err).slice(0, 200) },
      500
    );
  }
}

async function handlePost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, message: "malformed request" }, 400);
  }

  // honeypot: a real person never fills a hidden field. Answer as if it worked
  // so a bot gets no signal that it was caught.
  if (body && typeof body.company === "string" && body.company.trim() !== "") {
    return json({ success: true });
  }

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (rateLimited(ip)) {
    return json({ success: false, message: "Too many messages from this address. Try again shortly." }, 429);
  }

  const v = validate(body || {});
  if (v.error) return json({ success: false, message: v.error }, 400);

  const transports = [
    ["binding",   () => viaBinding(env, v)],   // Cloudflare Email Routing: native, free
    ["resend",    () => viaResend(env, v)],
    ["web3forms", () => viaWeb3Forms(env, v)],
    ["formsubmit", () => viaFormSubmit(v)],
  ];

  const attempted = [];
  const startedAt = Date.now();
  for (const [name, run] of transports) {
    // Stop trying the moment the global budget is spent. Whatever has been
    // learned so far still gets reported.
    const spent = Date.now() - startedAt;
    if (spent > GLOBAL_BUDGET_MS) {
      attempted.push({ via: name, detail: "skipped: global time budget spent" });
      break;
    }
    const result = await bounded(name, run);
    if (result === null) continue;                 // not configured, skip silently
    if (result.ok) return json({ success: true, via: result.via });
    attempted.push({ via: result.via, detail: result.detail });
  }

  // Nothing confirmed delivery. Say so — never a fake success. The client
  // keeps the message in its outbox and shows the visitor the address.
  return json(
    {
      success: false,
      message: "No delivery route accepted the message.",
      configured: !!(env.RESEND_API_KEY || env.WEB3FORMS_KEY || env.MAIL),
      attempted,
    },
    502
  );
}

// GET reports which transports are CONFIGURED - names only, never values or
// any part of a key. The relay was undebuggable while it could only fail: the
// 502 edge error replaced the function's own answer, so the attempted[] list it
// builds was never readable. This is the read-only way to answer "is the key
// actually set?" without sending mail.
export async function onRequestGet({ env }) {
  return json({
    ok: true,
    transports: {
      "cloudflare-email": !!(env.MAIL && typeof env.MAIL.send === "function"),
      resend: !!env.RESEND_API_KEY,
      web3forms: !!env.WEB3FORMS_KEY,
      formsubmit: true, // always available, which is why it is last
    },
    mail_to: env.MAIL_TO || "dm@gov.info.ve (default)",
    mail_from: env.MAIL_FROM || "noreply@gov.info.ve (default)",
  });
}

export async function onRequest() {
  return json({ success: false, message: "GET returns config status; POST sends" }, 405);
}

/* ============================================================
   POST /api/notify-visit   (Cloudflare Pages Function)

   Sends a push notification to your phone when someone opens the
   website — even when your phone is locked / the app is closed.

   HOW IT WORKS
   - Every page runs a tiny script that quietly calls this endpoint.
   - This function works out the visitor's rough location (from
     Cloudflare's edge — country / city / region) and sends a push
     via ntfy.sh to your phone's free "ntfy" app.
   - A per-visitor cooldown means one person browsing several pages
     only pings you ONCE (so you're not spammed).

   SETUP (one-off — see NTFY-PHONE-ALERTS.md):
     1. Install the free "ntfy" app on your phone.
     2. Subscribe to a secret topic name of your choosing.
     3. In Cloudflare → Pages → Settings → Variables, add:
          NTFY_TOPIC   = that exact topic name   (required)
        Optional:
          NTFY_SERVER  = https://ntfy.sh         (default)
          VISIT_COOLDOWN_MIN = 30                 (minutes; default 30)

   No cost, no accounts, no keys.
   ============================================================ */
// Deploy marker: v2 — refreshed variables (topic + admin password).

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });

// Skip obvious bots / crawlers so you're only pinged about real people.
const BOT_RE = /(bot|crawl|spider|slurp|bingpreview|facebookexternalhit|preview|monitor|pingdom|uptime|headless|lighthouse|gtmetrix|curl|wget|python-requests)/i;

export async function onRequestPost({ request, env }) {
  const ua = request.headers.get("user-agent") || "";
  if (BOT_RE.test(ua)) return json({ ok: true, skipped: "bot" });

  let body = {};
  try { body = await request.json(); } catch { /* ignore */ }
  const vid = (body.vid || "").toString().slice(0, 80) || "anon";
  const path = (body.path || "/").toString().slice(0, 120);

  // Rough location from Cloudflare's edge (free, no IP stored).
  const cf = request.cf || {};
  const city = cf.city || "";
  const region = cf.region || "";
  const country = cf.country || "";
  const place = [city, region, country].filter(Boolean).join(", ") || "an unknown location";

  // ---- Record activity for the Owner Dashboard (live view + daily counts) ----
  // Done on EVERY page load (unlike the ping, which is throttled below).
  if (env.WD_KV) {
    try {
      const now = Date.now();
      const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
      // "Live now": one key per visitor, auto-expiring after 3 minutes.
      await env.WD_KV.put(
        "live:" + vid,
        JSON.stringify({ place, path, ts: now }),
        { expirationTtl: 180 }
      );
      // Total page views (every load), kept ~20 days for the chart.
      const pvKey = "count:pv:" + day;
      const pv = parseInt((await env.WD_KV.get(pvKey)) || "0", 10) || 0;
      await env.WD_KV.put(pvKey, String(pv + 1), { expirationTtl: 60 * 60 * 24 * 20 });
      // Unique visitors per day: only count each visitor once.
      const uvKey = "uv:" + day + ":" + vid;
      const already = await env.WD_KV.get(uvKey);
      if (!already) {
        await env.WD_KV.put(uvKey, "1", { expirationTtl: 60 * 60 * 26 });
        const cKey = "count:uv:" + day;
        const cur = parseInt((await env.WD_KV.get(cKey)) || "0", 10) || 0;
        await env.WD_KV.put(cKey, String(cur + 1), { expirationTtl: 60 * 60 * 24 * 20 });
      }
    } catch { /* stats are best-effort */ }
  }

  // ---- Phone ping (throttled: one person browsing = one ping) ----
  // If the topic isn't configured yet, we've still recorded the visit above.
  if (!env.NTFY_TOPIC) return json({ ok: true, configured: false });

  const cooldownMin = parseInt(env.VISIT_COOLDOWN_MIN || "30", 10) || 30;
  if (env.WD_KV) {
    try {
      const seen = await env.WD_KV.get("ping:" + vid);
      if (seen) return json({ ok: true, skipped: "cooldown" });
      await env.WD_KV.put("ping:" + vid, "1", { expirationTtl: cooldownMin * 60 });
    } catch { /* if KV hiccups, still send */ }
  }

  const pageName = path === "/" || path === "/index.html" ? "the home page" : path;
  const message = `Someone from ${place} just opened ${pageName}.`;

  const server = (env.NTFY_SERVER || "https://ntfy.sh").replace(/\/+$/, "");
  const headers = {
    // Headers must be ASCII; keep the human location in the body only.
    "Title": "New visitor on Wake District",
    "Tags": "ocean,eyes",
    "Priority": "default",
    "Click": "https://www.wakedistrict.co.uk/",
  };
  // Authenticate the publish so ntfy.sh doesn't rate-limit / drop pings sent
  // from Cloudflare's shared egress IPs (anonymous publishing gets throttled).
  if (env.NTFY_TOKEN) headers["Authorization"] = `Bearer ${env.NTFY_TOKEN}`;
  try {
    const res = await fetch(`${server}/${env.NTFY_TOPIC}`, {
      method: "POST",
      headers,
      body: message,
    });
    // Don't fail silently: surface the real status if ntfy rejected it.
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return json({ ok: false, error: "ntfy rejected", status: res.status, detail: detail.slice(0, 200) }, 502);
    }
  } catch (e) {
    return json({ ok: false, error: "notify failed" }, 502);
  }

  return json({ ok: true, sent: true });
}

export async function onRequestGet() {
  return json({ ok: true, info: "POST here to send a visit ping." });
}

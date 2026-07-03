/* ============================================================
   POST /api/dashboard-data   (Cloudflare Pages Function)

   Powers the private Owner Dashboard (dashboard.html):
     - who is on the site right now (live) + rough location
     - visitors today and over the last 7 days
     - recent bookings WITH contact details

   Protected by the same password as the holiday admin page.

   Required:
     env.ADMIN_PASSWORD   your dashboard password (Settings → Variables)
     env.WD_KV            the KV namespace binding

   Request JSON:  { password }
   ============================================================ */

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function dayString(offset = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - offset);
  return d.toISOString().slice(0, 10);
}

export async function onRequestPost({ request, env }) {
  if (!env.ADMIN_PASSWORD) return json({ error: "Dashboard password is not set up yet." }, 500);
  if (!env.WD_KV) return json({ error: "Storage (WD_KV) is not set up yet." }, 500);

  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid request." }, 400); }
  if (!safeEqual(body.password || "", env.ADMIN_PASSWORD)) {
    return json({ error: "Incorrect password." }, 401);
  }

  // ---- Live visitors (keys auto-expire after 3 minutes) ----
  const live = [];
  try {
    const listed = await env.WD_KV.list({ prefix: "live:" });
    const now = Date.now();
    for (const k of listed.keys) {
      const raw = await env.WD_KV.get(k.name);
      if (!raw) continue;
      try {
        const v = JSON.parse(raw);
        live.push({
          place: v.place || "Unknown",
          path: v.path || "/",
          agoSec: Math.max(0, Math.round((now - (v.ts || now)) / 1000)),
        });
      } catch { /* skip */ }
    }
  } catch { /* best effort */ }
  live.sort((a, b) => a.agoSec - b.agoSec);

  // ---- Visitor counts ----
  let visitorsToday = 0;
  let visitors7d = 0;
  try {
    visitorsToday = parseInt((await env.WD_KV.get("count:uv:" + dayString(0))) || "0", 10) || 0;
    for (let i = 0; i < 7; i++) {
      visitors7d += parseInt((await env.WD_KV.get("count:uv:" + dayString(i))) || "0", 10) || 0;
    }
  } catch { /* best effort */ }

  // ---- Bookings with contact details ----
  let bookings = [];
  try {
    const raw = await env.WD_KV.get("booking_records");
    bookings = raw ? JSON.parse(raw) : [];
  } catch { /* best effort */ }

  return json({
    ok: true,
    live,
    liveCount: live.length,
    visitorsToday,
    visitors7d,
    bookings: bookings.slice(0, 100),
    serverTime: Date.now(),
  });
}

export async function onRequestGet() {
  return json({ error: "POST with your password to load the dashboard." }, 405);
}

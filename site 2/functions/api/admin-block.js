/* ============================================================
   POST /api/admin-block   (Cloudflare Pages Function)

   The admin page (admin.html) uses this to view and change:
     • whole closed days      -> KV key "blocked_dates"  ["YYYY-MM-DD", ...]
     • blocked hours in a day -> KV key "blocked_slots"  { "YYYY-MM-DD": ["HH:MM", ...] }
   Protected by a password.

   Required to work:
     env.ADMIN_PASSWORD   a password you choose (Settings → Variables)
     env.WD_KV            a KV namespace binding (stores the dates)

   Optional (enables Zoho calendar sync — see _zoho note below):
     env.ZOHO_CLIENT_ID, env.ZOHO_CLIENT_SECRET,
     env.ZOHO_REFRESH_TOKEN, env.ZOHO_CALENDAR_UID, env.ZOHO_ACCOUNTS_HOST,
     env.ZOHO_CALENDAR_HOST

   Actions (JSON body):
     { password, action: "list" }
       -> { dates:[...], slots:{date:[times]} }
     { password, action: "apply",      block:[days], unblock:[days] }
     { password, action: "applyHours", date, block:[times], unblock:[times] }
     { password, action: "add" | "remove", date }        (legacy single-day)
   ============================================================ */

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

// Constant-time-ish string compare to avoid leaking the password by timing.
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || "");
const isTime = (t) => /^\d{2}:\d{2}$/.test(t || "");

async function readDates(env) {
  const raw = await env.WD_KV.get("blocked_dates");
  return raw ? JSON.parse(raw) : [];
}
async function writeDates(env, dates) {
  const clean = [...new Set(dates)].filter(isDate).sort();
  await env.WD_KV.put("blocked_dates", JSON.stringify(clean));
  return clean;
}
async function readSlots(env) {
  const raw = await env.WD_KV.get("blocked_slots");
  return raw ? JSON.parse(raw) : {};
}
async function writeSlots(env, slots) {
  const clean = {};
  for (const [d, times] of Object.entries(slots || {})) {
    if (!isDate(d)) continue;
    const t = [...new Set((times || []).filter(isTime))].sort();
    if (t.length) clean[d] = t;
  }
  await env.WD_KV.put("blocked_slots", JSON.stringify(clean));
  return clean;
}

export async function onRequestPost({ request, env }) {
  if (!env.ADMIN_PASSWORD) return json({ error: "Admin password is not set up yet." }, 500);
  if (!env.WD_KV) return json({ error: "Date storage (WD_KV) is not set up yet." }, 500);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid request." }, 400);
  }

  if (!safeEqual(body.password || "", env.ADMIN_PASSWORD)) {
    return json({ error: "Incorrect password." }, 401);
  }

  const action = body.action;

  if (action === "list") {
    return json({ dates: await readDates(env), slots: await readSlots(env) });
  }

  // Batch whole-day block / unblock
  if (action === "apply") {
    const set = new Set(await readDates(env));
    (Array.isArray(body.block) ? body.block : []).filter(isDate).forEach((d) => set.add(d));
    (Array.isArray(body.unblock) ? body.unblock : []).filter(isDate).forEach((d) => set.delete(d));
    const dates = await writeDates(env, [...set]);
    // Keep Zoho calendar in step with the whole-day closures (no-op unless configured).
    try { await syncZohoDays(env, dates); } catch (e) { /* never fail the block on Zoho */ }
    return json({ dates, slots: await readSlots(env) });
  }

  // Block / unblock specific 30-min start times on one day
  if (action === "applyHours") {
    const date = body.date;
    if (!isDate(date)) return json({ error: "Invalid date." }, 400);
    const slots = await readSlots(env);
    const set = new Set(slots[date] || []);
    (Array.isArray(body.block) ? body.block : []).filter(isTime).forEach((t) => set.add(t));
    (Array.isArray(body.unblock) ? body.unblock : []).filter(isTime).forEach((t) => set.delete(t));
    if (set.size) slots[date] = [...set];
    else delete slots[date];
    const cleaned = await writeSlots(env, slots);
    return json({ dates: await readDates(env), slots: cleaned });
  }

  // Legacy single-day add / remove (kept for safety)
  if (action === "add" || action === "remove") {
    if (!isDate(body.date)) return json({ error: "Invalid date." }, 400);
    let dates = await readDates(env);
    if (action === "add") dates.push(body.date);
    else dates = dates.filter((d) => d !== body.date);
    const out = await writeDates(env, dates);
    try { await syncZohoDays(env, out); } catch (e) { /* best effort */ }
    return json({ dates: out, slots: await readSlots(env) });
  }

  return json({ error: "Unknown action." }, 400);
}

/* ------------------------------------------------------------
   Zoho Calendar sync — added in phase 2.
   Currently a safe no-op unless the ZOHO_* variables are set.
   ------------------------------------------------------------ */
async function syncZohoDays(env, blockedDates) {
  if (!env.ZOHO_CLIENT_ID || !env.ZOHO_CLIENT_SECRET || !env.ZOHO_REFRESH_TOKEN || !env.ZOHO_CALENDAR_UID) {
    return; // Zoho not connected yet — nothing to do.
  }
  // (Reconciliation of contiguous blocked-day ranges to Zoho all-day events
  //  is implemented in phase 2 once the connection is set up.)
}

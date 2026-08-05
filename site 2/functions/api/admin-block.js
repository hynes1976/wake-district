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
    // Keep Zoho calendar in step with the blocked hours (no-op unless configured).
    try { await syncZohoHours(env, cleaned); } catch (e) { /* never fail the block on Zoho */ }
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
   Zoho Calendar sync.

   Keeps the Zoho calendar in step with the whole-day closures:
   one all-day "Closed" event per contiguous blocked range. Runs
   only when the connection is set up (client id/secret in env,
   refresh token + calendar uid in KV — stored by /api/zoho-setup).
   Best-effort: never throws back to the caller.
   ------------------------------------------------------------ */
function ymd(iso) { return iso.replace(/-/g, ""); }
function addDay(iso) {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
// Group sorted YYYY-MM-DD dates into contiguous [{start,end}] ranges.
function contiguousRuns(sorted) {
  const runs = [];
  let start = null, prev = null;
  for (const d of sorted) {
    if (!start) { start = d; prev = d; continue; }
    if (d === addDay(prev)) { prev = d; }
    else { runs.push({ start, end: prev }); start = d; prev = d; }
  }
  if (start) runs.push({ start, end: prev });
  return runs;
}

async function syncZohoDays(env, blockedDates) {
  // Diagnostics: record the last sync outcome to KV "zoho_last_sync" (no secrets).
  const log = { at: new Date().toISOString(), steps: [] };
  const save = async () => { try { await env.WD_KV.put("zoho_last_sync", JSON.stringify(log)); } catch {} };

  if (!env.WD_KV || !env.ZOHO_CLIENT_ID || !env.ZOHO_CLIENT_SECRET) { log.stop = "no env"; return save(); }
  const calUid = await env.WD_KV.get("zoho_calendar_uid");
  const refresh = await env.WD_KV.get("zoho_refresh_token");
  if (!calUid || !refresh) { log.stop = "not connected (no KV token/uid)"; return save(); }

  const accountsHost = (env.ZOHO_ACCOUNTS_HOST || "https://accounts.zoho.eu").replace(/\/+$/, "");
  const calHost = (env.ZOHO_CALENDAR_HOST || "https://calendar.zoho.eu").replace(/\/+$/, "");
  const TZ = env.ZOHO_TIMEZONE || "Europe/London";
  const TITLE = env.ZOHO_EVENT_TITLE || "Wake District — Closed";

  // 1. Refresh token -> access token
  const tf = new URLSearchParams();
  tf.set("grant_type", "refresh_token");
  tf.set("client_id", env.ZOHO_CLIENT_ID.trim());
  tf.set("client_secret", env.ZOHO_CLIENT_SECRET.trim());
  tf.set("refresh_token", refresh);
  const tr = await fetch(`${accountsHost}/oauth/v2/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: tf.toString(),
  });
  const tok = await tr.json().catch(() => ({}));
  const access = tok.access_token;
  if (!access) { log.stop = "no access token"; log.tokenResp = tok; return save(); }
  const authHeaders = { Authorization: `Zoho-oauthtoken ${access}` };

  // 2. Work out the ranges we want, and the events we already made
  const runs = contiguousRuns([...new Set(blockedDates)].filter(isDate).sort());
  const want = new Set(runs.map((r) => `${r.start}~${r.end}`));
  const raw = await env.WD_KV.get("zoho_events");
  const map = raw ? JSON.parse(raw) : {}; // { "start~end": { uid, etag } }
  log.runs = runs.map((r) => `${r.start}~${r.end}`);

  // 3. Delete events for ranges that are no longer blocked
  for (const key of Object.keys(map)) {
    if (want.has(key)) continue;
    const ev = map[key] || {};
    try {
      const dr = await fetch(`${calHost}/api/v1/calendars/${calUid}/events/${ev.uid}?etag=${encodeURIComponent(ev.etag || "")}`,
        { method: "DELETE", headers: authHeaders });
      log.steps.push({ delete: key, status: dr.status });
    } catch (e) { log.steps.push({ delete: key, error: String(e) }); }
    delete map[key];
  }

  // 4. Create an all-day event for each new range (end is exclusive for all-day)
  for (const r of runs) {
    const key = `${r.start}~${r.end}`;
    if (map[key]) continue;
    const eventdata = JSON.stringify({
      title: TITLE,
      isallday: true,
      dateandtime: { timezone: TZ, start: ymd(r.start), end: ymd(addDay(r.end)) },
    });
    try {
      const cr = await fetch(`${calHost}/api/v1/calendars/${calUid}/events?eventdata=${encodeURIComponent(eventdata)}`,
        { method: "POST", headers: authHeaders });
      const cj = await cr.json().catch(() => ({}));
      const ev = (cj.events && cj.events[0]) || {};
      if (ev.uid) map[key] = { uid: ev.uid, etag: ev.etag || "" };
      log.steps.push({ create: key, status: cr.status, gotUid: !!ev.uid, resp: cj });
    } catch (e) { log.steps.push({ create: key, error: String(e) }); }
  }

  await env.WD_KV.put("zoho_events", JSON.stringify(map));
  log.eventMap = Object.keys(map);
  return save();
}

/* ------------------------------------------------------------
   Zoho Calendar sync for BLOCKED HOURS.

   Each contiguous run of 30-min blocked slots on a day becomes one
   timed "Closed" event (e.g. 11:30–13:30). Reconciles against a
   stored map so re-saving is idempotent. Best-effort.
   ------------------------------------------------------------ */
// Sorted ["HH:MM"] 30-min starts -> [{start,end}] with end exclusive (last + 30m).
function slotsToRuns(times) {
  const toMin = (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
  const toHM = (mn) => `${String(Math.floor(mn / 60)).padStart(2, "0")}:${String(mn % 60).padStart(2, "0")}`;
  const sorted = [...new Set(times.filter(isTime))].sort();
  const runs = [];
  let start = null, prev = null;
  for (const t of sorted) {
    const mn = toMin(t);
    if (start === null) { start = mn; prev = mn; continue; }
    if (mn === prev + 30) { prev = mn; }
    else { runs.push({ start: toHM(start), end: toHM(prev + 30) }); start = mn; prev = mn; }
  }
  if (start !== null) runs.push({ start: toHM(start), end: toHM(prev + 30) });
  return runs;
}

async function syncZohoHours(env, slotsByDate) {
  const log = { at: new Date().toISOString(), steps: [] };
  const save = async () => { try { await env.WD_KV.put("zoho_last_sync_hours", JSON.stringify(log)); } catch {} };

  if (!env.WD_KV || !env.ZOHO_CLIENT_ID || !env.ZOHO_CLIENT_SECRET) { log.stop = "no env"; return save(); }
  const calUid = await env.WD_KV.get("zoho_calendar_uid");
  const refresh = await env.WD_KV.get("zoho_refresh_token");
  if (!calUid || !refresh) { log.stop = "not connected"; return save(); }

  const accountsHost = (env.ZOHO_ACCOUNTS_HOST || "https://accounts.zoho.eu").replace(/\/+$/, "");
  const calHost = (env.ZOHO_CALENDAR_HOST || "https://calendar.zoho.eu").replace(/\/+$/, "");
  const TZ = env.ZOHO_TIMEZONE || "Europe/London";
  const TITLE = env.ZOHO_EVENT_TITLE || "Wake District — Closed";

  const tf = new URLSearchParams();
  tf.set("grant_type", "refresh_token");
  tf.set("client_id", env.ZOHO_CLIENT_ID.trim());
  tf.set("client_secret", env.ZOHO_CLIENT_SECRET.trim());
  tf.set("refresh_token", refresh);
  const tr = await fetch(`${accountsHost}/oauth/v2/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: tf.toString(),
  });
  const tok = await tr.json().catch(() => ({}));
  const access = tok.access_token;
  if (!access) { log.stop = "no access token"; log.tokenResp = tok; return save(); }
  const authHeaders = { Authorization: `Zoho-oauthtoken ${access}` };

  // Desired timed events from every blocked-hour run.
  const want = new Set();
  const desired = []; // { key, date, start, end }
  for (const [date, times] of Object.entries(slotsByDate || {})) {
    if (!isDate(date)) continue;
    for (const run of slotsToRuns(times || [])) {
      const key = `h:${date}:${run.start}~${run.end}`;
      want.add(key);
      desired.push({ key, date, start: run.start, end: run.end });
    }
  }
  log.want = [...want];

  const raw = await env.WD_KV.get("zoho_hour_events");
  const map = raw ? JSON.parse(raw) : {}; // { key: { uid, etag } }

  // Delete events no longer wanted.
  for (const key of Object.keys(map)) {
    if (want.has(key)) continue;
    const ev = map[key] || {};
    try {
      const dr = await fetch(`${calHost}/api/v1/calendars/${calUid}/events/${ev.uid}?etag=${encodeURIComponent(ev.etag || "")}`,
        { method: "DELETE", headers: authHeaders });
      log.steps.push({ delete: key, status: dr.status });
    } catch (e) { log.steps.push({ delete: key, error: String(e) }); }
    delete map[key];
  }

  // Create new timed events (local time + timezone field, no offset).
  for (const d of desired) {
    if (map[d.key]) continue;
    const eventdata = JSON.stringify({
      title: TITLE,
      dateandtime: {
        timezone: TZ,
        start: `${ymd(d.date)}T${d.start.replace(":", "")}00`,
        end: `${ymd(d.date)}T${d.end.replace(":", "")}00`,
      },
    });
    try {
      const cr = await fetch(`${calHost}/api/v1/calendars/${calUid}/events?eventdata=${encodeURIComponent(eventdata)}`,
        { method: "POST", headers: authHeaders });
      const cj = await cr.json().catch(() => ({}));
      const ev = (cj.events && cj.events[0]) || {};
      if (ev.uid) map[d.key] = { uid: ev.uid, etag: ev.etag || "" };
      log.steps.push({ create: d.key, status: cr.status, gotUid: !!ev.uid, resp: cj });
    } catch (e) { log.steps.push({ create: d.key, error: String(e) }); }
  }

  await env.WD_KV.put("zoho_hour_events", JSON.stringify(map));
  log.eventMap = Object.keys(map);
  return save();
}

/* ============================================================
   /api/zoho-setup   (TEMPORARY one-time setup helper)

   Connects Zoho Calendar without ever exposing secrets:
     POST { code: "GRANT_CODE" }
        1. Exchanges the Zoho grant code for a long-lived refresh token
           (using ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET from Cloudflare).
        2. Stores the refresh token in KV (never shown on screen).
        3. Lists your Zoho calendars, stores the default one's UID in KV.
        4. Returns the calendar list so you can confirm / pick another.
     POST { uid: "CALENDAR_UID" }   -> store a different calendar UID.

   Delete this file once the connection is confirmed working.

   Env needed:  ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, WD_KV
   Optional:    ZOHO_ACCOUNTS_HOST (default https://accounts.zoho.eu)
                ZOHO_CALENDAR_HOST (default https://calendar.zoho.eu)
   ============================================================ */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS },
  });

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

async function core(env, code, pickUid) {
  if (!env.WD_KV) return json({ ok: false, error: "WD_KV binding missing." });

  const accountsHost = (env.ZOHO_ACCOUNTS_HOST || "https://accounts.zoho.eu").replace(/\/+$/, "");
  const calHost = (env.ZOHO_CALENDAR_HOST || "https://calendar.zoho.eu").replace(/\/+$/, "");

  // Just store a chosen calendar UID (second run)
  if (!code && pickUid) {
    await env.WD_KV.put("zoho_calendar_uid", pickUid);
    return json({ ok: true, storedCalendarUid: pickUid });
  }
  if (!code) return json({ error: "POST { code: 'YOUR_GRANT_CODE' } (or { uid: '...' } to pick a calendar)." }, 400);

  if (!env.ZOHO_CLIENT_ID || !env.ZOHO_CLIENT_SECRET) {
    // NOTE: use 200 for all outcomes — Cloudflare hides the body of any 5xx.
    return json({ ok: false, error: "ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET not found. Add them in Cloudflare and redeploy first." });
  }

  // 1. Grant code -> refresh token
  const form = new URLSearchParams();
  form.set("grant_type", "authorization_code");
  form.set("client_id", env.ZOHO_CLIENT_ID.trim());
  form.set("client_secret", env.ZOHO_CLIENT_SECRET.trim());
  form.set("code", code.trim());
  const tRes = await fetch(`${accountsHost}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const tok = await tRes.json().catch(() => ({}));
  if (!tok.refresh_token) {
    return json({ step: "token-exchange", ok: false, hint: "Grant code expired or scopes wrong — regenerate it.", zohoResponse: tok });
  }
  await env.WD_KV.put("zoho_refresh_token", tok.refresh_token);

  // 2. List calendars, store the default UID
  let calendars = [];
  try {
    const cRes = await fetch(`${calHost}/api/v1/calendars`, {
      headers: { Authorization: `Zoho-oauthtoken ${tok.access_token}` },
    });
    const cj = await cRes.json().catch(() => ({}));
    calendars = (cj.calendars || []).map((c) => ({
      name: c.name || c.title || "(unnamed)",
      uid: c.uid,
      isdefault: !!c.isdefault,
    }));
  } catch (e) {
    return json({ ok: true, storedRefreshToken: true, calendarsError: String(e) });
  }

  const chosen = calendars.find((c) => c.isdefault) || calendars[0];
  if (chosen && chosen.uid) await env.WD_KV.put("zoho_calendar_uid", chosen.uid);

  return json({
    ok: true,
    storedRefreshToken: true,
    chosenCalendar: chosen || null,
    note: "Refresh token + calendar stored in KV. To use a different calendar, POST { uid: 'THE_UID' } from the list.",
    allCalendars: calendars,
  });
}

export async function onRequestPost({ request, env }) {
  const b = await request.json().catch(() => ({}));
  return core(env, (b.code || "").trim(), (b.uid || "").trim());
}

// Get a fresh access token from the stored refresh token.
async function accessToken(env) {
  const accountsHost = (env.ZOHO_ACCOUNTS_HOST || "https://accounts.zoho.eu").replace(/\/+$/, "");
  const refresh = await env.WD_KV.get("zoho_refresh_token");
  if (!refresh || !env.ZOHO_CLIENT_ID || !env.ZOHO_CLIENT_SECRET) return null;
  const f = new URLSearchParams();
  f.set("grant_type", "refresh_token");
  f.set("client_id", env.ZOHO_CLIENT_ID.trim());
  f.set("client_secret", env.ZOHO_CLIENT_SECRET.trim());
  f.set("refresh_token", refresh);
  const r = await fetch(`${accountsHost}/oauth/v2/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: f.toString(),
  });
  const j = await r.json().catch(() => ({}));
  return j.access_token || null;
}

// GET:
//   ?debug=1        -> show the last sync outcome + stored event map (no secrets)
//   ?test=create    -> create a throwaway all-day event, return the raw Zoho response
//   ?test=cleanup   -> delete the throwaway event
//   ?uid=...        -> quick calendar-UID override
export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);

  if (url.searchParams.get("debug")) {
    const last = await env.WD_KV.get("zoho_last_sync");
    const lastH = await env.WD_KV.get("zoho_last_sync_hours");
    const events = await env.WD_KV.get("zoho_events");
    const hourEvents = await env.WD_KV.get("zoho_hour_events");
    const calUid = await env.WD_KV.get("zoho_calendar_uid");
    return json({
      ok: true,
      connected: !!(await env.WD_KV.get("zoho_refresh_token")),
      calendarUid: calUid || null,
      eventMap: events ? JSON.parse(events) : {},
      hourEventMap: hourEvents ? JSON.parse(hourEvents) : {},
      lastSync: last ? JSON.parse(last) : null,
      lastSyncHours: lastH ? JSON.parse(lastH) : null,
    });
  }

  const test = url.searchParams.get("test");
  if (test) {
    const calHost = (env.ZOHO_CALENDAR_HOST || "https://calendar.zoho.eu").replace(/\/+$/, "");
    const calUid = await env.WD_KV.get("zoho_calendar_uid");
    const access = await accessToken(env);
    if (!access || !calUid) return json({ ok: false, error: "No access token or calendar uid." });
    const auth = { Authorization: `Zoho-oauthtoken ${access}` };

    if (test === "create") {
      const eventdata = JSON.stringify({
        title: "Wake District — TEST (safe to delete)",
        isallday: true,
        dateandtime: { timezone: "Europe/London", start: "20261225", end: "20261227" },
      });
      const cr = await fetch(`${calHost}/api/v1/calendars/${calUid}/events?eventdata=${encodeURIComponent(eventdata)}`,
        { method: "POST", headers: auth });
      const cj = await cr.json().catch(() => ({}));
      const ev = (cj.events && cj.events[0]) || {};
      if (ev.uid) await env.WD_KV.put("zoho_test_event", JSON.stringify({ uid: ev.uid, etag: ev.etag || "" }));
      return json({ ok: cr.ok, status: cr.status, gotUid: !!ev.uid, zohoResponse: cj });
    }

    if (test === "cleanup") {
      // Find every TEST event in the Dec 2026 window and delete it (etag in header).
      const range = JSON.stringify({ start: "20261201", end: "20270101" });
      const lr = await fetch(`${calHost}/api/v1/calendars/${calUid}/events?range=${encodeURIComponent(range)}`, { headers: auth });
      const lj = await lr.json().catch(() => ({}));
      const evts = (lj.events || []).filter((e) => (e.title || "").includes("TEST"));
      const results = [];
      for (const e of evts) {
        const dr = await fetch(`${calHost}/api/v1/calendars/${calUid}/events/${e.uid}`,
          { method: "DELETE", headers: { ...auth, etag: String(e.etag || "") } });
        results.push({ uid: e.uid, status: dr.status });
      }
      await env.WD_KV.delete("zoho_test_event");
      return json({ ok: true, listStatus: lr.status, deleted: results });
    }
  }

  const uid = (url.searchParams.get("uid") || "").trim();
  return core(env, "", uid);
}

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
  if (!env.WD_KV) return json({ error: "WD_KV binding missing." }, 500);

  const accountsHost = (env.ZOHO_ACCOUNTS_HOST || "https://accounts.zoho.eu").replace(/\/+$/, "");
  const calHost = (env.ZOHO_CALENDAR_HOST || "https://calendar.zoho.eu").replace(/\/+$/, "");

  // Just store a chosen calendar UID (second run)
  if (!code && pickUid) {
    await env.WD_KV.put("zoho_calendar_uid", pickUid);
    return json({ ok: true, storedCalendarUid: pickUid });
  }
  if (!code) return json({ error: "POST { code: 'YOUR_GRANT_CODE' } (or { uid: '...' } to pick a calendar)." }, 400);

  if (!env.ZOHO_CLIENT_ID || !env.ZOHO_CLIENT_SECRET) {
    return json({ error: "ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET not found. Add them in Cloudflare and redeploy first." }, 500);
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
    return json({ step: "token-exchange", ok: false, hint: "Grant code expired or scopes wrong — regenerate it.", zohoResponse: tok }, 502);
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

// GET is only for a quick calendar-UID override (no sensitive data): ?uid=...
export async function onRequestGet({ request, env }) {
  const uid = (new URL(request.url).searchParams.get("uid") || "").trim();
  return core(env, "", uid);
}

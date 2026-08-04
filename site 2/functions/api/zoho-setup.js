/* ============================================================
   GET /api/zoho-setup?code=GRANT_CODE   (TEMPORARY setup helper)

   One-time use to connect Zoho Calendar. It:
     1. Exchanges the Zoho grant code for a long-lived refresh token
        (using ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET from Cloudflare).
     2. Stores the refresh token in KV (never shown on screen).
     3. Lists your Zoho calendars and stores the default one's UID in KV.
     4. Returns the calendar list so you can confirm / pick another.

   Delete this file again once the connection is confirmed working.

   Env needed:  ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, WD_KV
   Optional:    ZOHO_ACCOUNTS_HOST (default https://accounts.zoho.eu)
                ZOHO_CALENDAR_HOST (default https://calendar.zoho.eu)
   ============================================================ */

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const code = (url.searchParams.get("code") || "").trim();
  const pickUid = (url.searchParams.get("uid") || "").trim(); // optional override

  if (!env.WD_KV) return json({ error: "WD_KV binding missing." }, 500);
  if (!env.ZOHO_CLIENT_ID || !env.ZOHO_CLIENT_SECRET) {
    return json({ error: "Add ZOHO_CLIENT_ID and ZOHO_CLIENT_SECRET in Cloudflare, then redeploy, then open this again." }, 500);
  }

  const accountsHost = (env.ZOHO_ACCOUNTS_HOST || "https://accounts.zoho.eu").replace(/\/+$/, "");
  const calHost = (env.ZOHO_CALENDAR_HOST || "https://calendar.zoho.eu").replace(/\/+$/, "");

  // If only picking a calendar UID (second run), just store it.
  if (!code && pickUid) {
    await env.WD_KV.put("zoho_calendar_uid", pickUid);
    return json({ ok: true, storedCalendarUid: pickUid });
  }
  if (!code) {
    return json({ error: "Add ?code=YOUR_GRANT_CODE to the URL (generate it in the Zoho API console)." }, 400);
  }

  // 1. Grant code -> refresh token
  const form = new URLSearchParams();
  form.set("grant_type", "authorization_code");
  form.set("client_id", env.ZOHO_CLIENT_ID.trim());
  form.set("client_secret", env.ZOHO_CLIENT_SECRET.trim());
  form.set("code", code);
  const tRes = await fetch(`${accountsHost}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const tok = await tRes.json().catch(() => ({}));
  if (!tok.refresh_token) {
    return json({ step: "token-exchange", ok: false, hint: "Grant code may be expired or scopes wrong. Regenerate it.", zohoResponse: tok }, 502);
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
    note: "Refresh token + calendar stored. If you'd rather use a different calendar, re-open this URL with ?uid=THE_UID from the list below.",
    allCalendars: calendars,
  });
}

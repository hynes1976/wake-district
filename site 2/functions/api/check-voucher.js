/* ============================================================
   GET /api/check-voucher?code=WD-XXXX-XXXX

   Public, read-only. Tells the booking page whether a voucher
   code is valid and which session it covers, so the customer can
   redeem it for a free booking. Reveals only the session + expiry
   (no buyer/recipient personal data).
   ============================================================ */

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

const todayISO = () => new Date().toISOString().slice(0, 10);

export async function onRequestGet({ request, env }) {
  const code = (new URL(request.url).searchParams.get("code") || "").trim().toUpperCase();
  if (!code) return json({ ok: true, valid: false, reason: "empty" });
  if (!env.WD_KV) return json({ ok: true, valid: false, reason: "unavailable" });

  const raw = await env.WD_KV.get(`voucher:${code}`);
  if (!raw) return json({ ok: true, valid: false, reason: "not_found" });

  let v;
  try { v = JSON.parse(raw); } catch { return json({ ok: true, valid: false, reason: "not_found" }); }

  if (v.status === "redeemed") return json({ ok: true, valid: false, reason: "redeemed" });
  if (v.expires && v.expires < todayISO()) return json({ ok: true, valid: false, reason: "expired", expires: v.expires });

  return json({
    ok: true,
    valid: true,
    code,
    experienceId: v.experienceId,
    experienceName: v.experienceName,
    hours: v.hours,
    expires: v.expires,
  });
}

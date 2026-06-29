/* ============================================================
   GET /api/blocked-dates   (Cloudflare Pages Function)

   Returns the list of holiday / closed dates so the booking page
   can stop customers picking them.

   Binding (set in Cloudflare → your Pages project → Settings →
   Functions → KV namespace bindings):
     WD_KV   a KV namespace. We store one key, "blocked_dates",
             holding a JSON array of "YYYY-MM-DD" strings.

   If WD_KV isn't set up yet, this safely returns an empty list so
   the site keeps working (no dates blocked).
   ============================================================ */

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

export async function onRequestGet({ env }) {
  try {
    if (!env.WD_KV) return json({ dates: [] });
    const raw = await env.WD_KV.get("blocked_dates");
    const dates = raw ? JSON.parse(raw) : [];
    return json({ dates });
  } catch {
    return json({ dates: [] });
  }
}

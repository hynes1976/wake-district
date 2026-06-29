/* ============================================================
   GET /api/availability   (Cloudflare Pages Function)

   Public. Tells the booking calendar what's unavailable:
     {
       blocked: ["YYYY-MM-DD", ...],          // your holidays (admin)
       booked:  { "YYYY-MM-DD": ["10:00", ...] }  // taken 30-min start slots
     }

   Reads from the WD_KV namespace (keys "blocked_dates" and
   "booked_slots"). If KV isn't set up yet, returns empty — so the
   calendar simply shows every day as available.
   ============================================================ */

const json = (obj) =>
  new Response(JSON.stringify(obj), {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

export async function onRequestGet({ env }) {
  let blocked = [];
  let booked = {};
  try {
    if (env.WD_KV) {
      const b = await env.WD_KV.get("blocked_dates");
      if (b) blocked = JSON.parse(b);
      const k = await env.WD_KV.get("booked_slots");
      if (k) booked = JSON.parse(k);
    }
  } catch {
    /* fall through to empty */
  }
  return json({ blocked, booked });
}

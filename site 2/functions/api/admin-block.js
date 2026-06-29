/* ============================================================
   POST /api/admin-block   (Cloudflare Pages Function)

   The admin page (admin.html) uses this to view, add and remove
   holiday / closed dates. Protected by a password.

   Required to work:
     env.ADMIN_PASSWORD   a password you choose (Settings → Variables)
     env.WD_KV            a KV namespace binding (stores the dates)

   Request JSON:
     { password, action: "list" | "add" | "remove", date? }
   Response JSON:
     { dates: [...] }   or   { error: "..." }
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

async function readDates(env) {
  const raw = await env.WD_KV.get("blocked_dates");
  return raw ? JSON.parse(raw) : [];
}
async function writeDates(env, dates) {
  const clean = [...new Set(dates)].filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  await env.WD_KV.put("blocked_dates", JSON.stringify(clean));
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
    return json({ dates: await readDates(env) });
  }

  if (action === "add" || action === "remove") {
    const date = body.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) return json({ error: "Invalid date." }, 400);
    let dates = await readDates(env);
    if (action === "add") dates.push(date);
    else dates = dates.filter((d) => d !== date);
    return json({ dates: await writeDates(env, dates) });
  }

  return json({ error: "Unknown action." }, 400);
}

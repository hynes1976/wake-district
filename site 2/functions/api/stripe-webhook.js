/* ============================================================
   POST /api/stripe-webhook   (Cloudflare Pages Function)

   When a payment completes, Stripe calls this endpoint. We:
     1. Verify it really came from Stripe,
     2. Mark the booked time slot(s) as taken (so the calendar
        shows them and no one can double-book), and
     3. Optionally email you the booking details.

   Environment variables (Cloudflare → Settings):
     STRIPE_WEBHOOK_SECRET   whsec_...   (required to accept events)
     WD_KV (binding)         records booked slots for the calendar
     RESEND_API_KEY          re_...      (optional — email alerts)
     BOOKINGS_EMAIL          where alerts go, e.g. info@wakedistrict.co.uk
     FROM_EMAIL              a verified sender, e.g. bookings@wakedistrict.co.uk

   See HOLIDAY-BLOCKING-SETUP.md / DEPLOYMENT-GUIDE.md.
   ============================================================ */

const enc = new TextEncoder();

async function verifyStripeSignature(rawBody, sigHeader, secret) {
  if (!sigHeader) return false;
  const parts = Object.fromEntries(sigHeader.split(",").map((p) => p.split("=")));
  const t = parts.t, v1 = parts.v1;
  if (!t || !v1) return false;
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${rawBody}`));
  const expected = [...new Uint8Array(sigBuf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (expected.length !== v1.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ v1.charCodeAt(i);
  return diff === 0;
}

// All 30-minute start slots occupied by a session, e.g. 10:00 for 2h -> 10:00,10:30,11:00,11:30
function occupiedSlots(time, hours) {
  const [h, m] = time.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return [];
  const start = h * 60 + m;
  const count = Math.max(1, Math.round(hours * 2)); // number of 30-min slots
  const out = [];
  for (let i = 0; i < count; i++) {
    const t = start + i * 30;
    out.push(`${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`);
  }
  return out;
}

async function recordBooking(env, m) {
  if (!env.WD_KV || !m.date || !m.time) return;
  const hours = parseInt(m.hours || "1", 10) || 1;
  const slots = occupiedSlots(m.time, hours);
  const raw = await env.WD_KV.get("booked_slots");
  const obj = raw ? JSON.parse(raw) : {};
  const set = new Set(obj[m.date] || []);
  slots.forEach((s) => set.add(s));
  obj[m.date] = [...set].sort();
  await env.WD_KV.put("booked_slots", JSON.stringify(obj));
}

export async function onRequestPost({ request, env }) {
  const raw = await request.text();
  const ok = await verifyStripeSignature(
    raw, request.headers.get("stripe-signature"), env.STRIPE_WEBHOOK_SECRET
  );
  if (!ok) return new Response("Invalid signature", { status: 400 });

  const event = JSON.parse(raw);
  if (event.type !== "checkout.session.completed") {
    return new Response("ignored", { status: 200 });
  }

  const s = event.data.object;
  const m = s.metadata || {};

  // 1. Mark the slot booked (for the availability calendar)
  try { await recordBooking(env, m); } catch (e) { /* don't fail the webhook on this */ }

  // 2. Optional email alert
  if (env.RESEND_API_KEY && env.BOOKINGS_EMAIL && env.FROM_EMAIL) {
    const amount = (s.amount_total / 100).toLocaleString("en-GB", { style: "currency", currency: "GBP" });
    const html = `
      <h2>New booking — Wake District</h2>
      <table cellpadding="6" style="border-collapse:collapse;font-family:Arial,sans-serif">
        <tr><td><b>Experience</b></td><td>${m.experience || "—"}</td></tr>
        <tr><td><b>Date</b></td><td>${m.date || "—"}</td></tr>
        <tr><td><b>Start time</b></td><td>${m.time || "—"}</td></tr>
        <tr><td><b>Pick-up</b></td><td>${m.pickup_location || "—"}</td></tr>
        <tr><td><b>People</b></td><td>${m.people || "—"}</td></tr>
        <tr><td><b>Paid</b></td><td>${amount}</td></tr>
        <tr><td><b>Name</b></td><td>${m.customer_name || "—"}</td></tr>
        <tr><td><b>Email</b></td><td>${m.customer_email || s.customer_email || "—"}</td></tr>
        <tr><td><b>Phone</b></td><td>${m.customer_phone || "—"}</td></tr>
        <tr><td><b>Notes</b></td><td>${m.notes || "—"}</td></tr>
      </table>`;
    try {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: env.FROM_EMAIL,
          to: env.BOOKINGS_EMAIL,
          subject: `New booking: ${m.experience} on ${m.date} at ${m.time}`,
          html,
        }),
      });
    } catch (e) { /* email is best-effort */ }
  }

  return new Response("ok", { status: 200 });
}

/* ============================================================
   POST /api/stripe-webhook   (Cloudflare Pages Function)

   When a payment completes, Stripe calls this endpoint. We:
     1. Verify it really came from Stripe,
     2. Mark the booked time slot(s) as taken — PLUS a 30-minute
        buffer after the session for drop-off/pick-up — so the
        calendar shows them and no one can double-book,
     3. Email the customer a booking confirmation, and
     4. Email you (the business) an alert.

   Environment variables (Cloudflare → Settings):
     STRIPE_WEBHOOK_SECRET   whsec_...   (required to accept events)
     WD_KV (binding)         records booked slots for the calendar
     RESEND_API_KEY          re_...      (enables the emails)
     FROM_EMAIL              a verified sender, e.g. bookings@wakedistrict.co.uk
     BOOKINGS_EMAIL          where business alerts go, e.g. info@wakedistrict.co.uk

   See HOLIDAY-BLOCKING-SETUP.md / DEPLOYMENT-GUIDE.md.
   ============================================================ */

const enc = new TextEncoder();

// 30-minute drop-off / pick-up buffer added after every session.
const BUFFER_SLOTS = 1; // 1 x 30 minutes

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

// 30-minute start slots taken by a session, INCLUDING a 30-min buffer afterwards.
// e.g. 10:00 for 2h -> 10:00,10:30,11:00,11:30  + buffer 12:00  (next start can be 12:30)
function occupiedSlots(time, hours) {
  const [h, m] = time.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return [];
  const start = h * 60 + m;
  const count = Math.max(1, Math.round(hours * 2)) + BUFFER_SLOTS;
  const out = [];
  for (let i = 0; i < count; i++) {
    const t = start + i * 30;
    if (t >= 24 * 60) break;
    out.push(`${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`);
  }
  return out;
}

async function recordBooking(env, m) {
  if (!env.WD_KV || !m.date || !m.time) return;
  const hours = parseInt(m.hours || "1", 10) || 1;
  // 1. Occupied 30-min slots (incl. buffer) — used to filter times & block double-booking
  const slots = occupiedSlots(m.time, hours);
  const raw = await env.WD_KV.get("booked_slots");
  const obj = raw ? JSON.parse(raw) : {};
  const set = new Set(obj[m.date] || []);
  slots.forEach((s) => set.add(s));
  obj[m.date] = [...set].sort();
  await env.WD_KV.put("booked_slots", JSON.stringify(obj));

  // 2. Human-friendly booking list for display on the calendar.
  //    NO personal data is stored here — only the time, length and session type.
  const label = (m.experience || "Session").replace(/\s*—\s*Wake District\s*$/, "");
  const rawB = await env.WD_KV.get("bookings");
  const bObj = rawB ? JSON.parse(rawB) : {};
  const list = bObj[m.date] || [];
  if (!list.some((b) => b.time === m.time)) {
    list.push({ time: m.time, hours, experience: label });
    list.sort((a, b) => a.time.localeCompare(b.time));
    bObj[m.date] = list;
    await env.WD_KV.put("bookings", JSON.stringify(bObj));
  }
}

function prettyDate(iso) {
  try {
    return new Date(iso + "T00:00:00").toLocaleDateString("en-GB", {
      weekday: "long", day: "numeric", month: "long", year: "numeric",
    });
  } catch { return iso; }
}

async function sendEmail(env, to, subject, html) {
  return fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env.FROM_EMAIL, to, subject, html }),
  });
}

function customerEmailHtml(m) {
  return `
  <div style="font-family:Arial,Helvetica,sans-serif;color:#11242f;max-width:560px">
    <h2 style="color:#082f49">You're booked in! 🌊</h2>
    <p>Hi ${m.customer_name || "there"}, thanks for booking with <strong>Wake District</strong>. Your payment was successful and your session is confirmed.</p>
    <table cellpadding="8" style="border-collapse:collapse;background:#f6fafb;border-radius:8px;width:100%">
      <tr><td style="color:#5b7682">Experience</td><td><strong>${m.experience || "—"}</strong></td></tr>
      <tr><td style="color:#5b7682">Date</td><td><strong>${prettyDate(m.date)}</strong></td></tr>
      <tr><td style="color:#5b7682">Start time</td><td><strong>${m.time || "—"}</strong></td></tr>
      <tr><td style="color:#5b7682">Pick-up</td><td><strong>${m.pickup_location || "—"}</strong></td></tr>
      <tr><td style="color:#5b7682">Group size</td><td><strong>${m.people || "—"}</strong></td></tr>
    </table>
    <p style="margin-top:18px"><strong>What to bring:</strong> a swimsuit, a towel, and weather-appropriate items (sun cream, sunglasses, or warm layers). Wetsuits can be provided if needed.</p>
    <p>Please arrive a few minutes early at your pick-up point. We'll be in touch if conditions change.</p>
    <p>Any questions? Call us on <a href="tel:07826551503">07826 551 503</a> or reply to this email.</p>
    <p style="color:#5b7682;font-size:13px;margin-top:24px">Wake District · Lake Windermere · See you on the water!</p>
  </div>`;
}

function businessEmailHtml(m, amount) {
  return `
    <h2>New booking — Wake District</h2>
    <table cellpadding="6" style="border-collapse:collapse;font-family:Arial,sans-serif">
      <tr><td><b>Experience</b></td><td>${m.experience || "—"}</td></tr>
      <tr><td><b>Date</b></td><td>${prettyDate(m.date)}</td></tr>
      <tr><td><b>Start time</b></td><td>${m.time || "—"}</td></tr>
      <tr><td><b>Pick-up</b></td><td>${m.pickup_location || "—"}</td></tr>
      <tr><td><b>People</b></td><td>${m.people || "—"}</td></tr>
      <tr><td><b>Paid</b></td><td>${amount}</td></tr>
      <tr><td><b>Name</b></td><td>${m.customer_name || "—"}</td></tr>
      <tr><td><b>Email</b></td><td>${m.customer_email || "—"}</td></tr>
      <tr><td><b>Phone</b></td><td>${m.customer_phone || "—"}</td></tr>
      <tr><td><b>Notes</b></td><td>${m.notes || "—"}</td></tr>
    </table>`;
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
  if (!m.customer_email) m.customer_email = s.customer_email || "";

  // 1. Mark the slot (+ buffer) booked, for the availability calendar
  try { await recordBooking(env, m); } catch (e) { /* don't fail the webhook on this */ }

  // 2. Emails (only if Resend is configured)
  if (env.RESEND_API_KEY && env.FROM_EMAIL) {
    // Confirmation to the customer
    if (m.customer_email) {
      try {
        await sendEmail(env, m.customer_email, "Your Wake District booking is confirmed 🌊", customerEmailHtml(m));
      } catch (e) { /* best effort */ }
    }
    // Alert to the business
    if (env.BOOKINGS_EMAIL) {
      const amount = (s.amount_total / 100).toLocaleString("en-GB", { style: "currency", currency: "GBP" });
      try {
        await sendEmail(env, env.BOOKINGS_EMAIL, `New booking: ${m.experience} on ${m.date} at ${m.time}`, businessEmailHtml(m, amount));
      } catch (e) { /* best effort */ }
    }
  }

  return new Response("ok", { status: 200 });
}

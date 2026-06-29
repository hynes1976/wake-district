/* ============================================================
   POST /api/stripe-webhook   (Cloudflare Pages Function) — OPTIONAL

   When a payment completes, Stripe calls this endpoint. We verify
   it really came from Stripe, then email you the booking details so
   a new booking lands in your inbox automatically.

   This file is OPTIONAL. Without it you'll still see every paid
   booking in your Stripe Dashboard (with all the details in the
   payment's metadata). Set it up when you want email alerts too.

   Environment variables (Cloudflare dashboard):
     STRIPE_WEBHOOK_SECRET   whsec_...   (from the Stripe webhook you create)
     RESEND_API_KEY          re_...      (free email API — resend.com)
     BOOKINGS_EMAIL          where alerts go, e.g. info@wakedistrict.co.uk
     FROM_EMAIL              a verified sender, e.g. bookings@wakedistrict.co.uk

   See DEPLOYMENT-GUIDE.md, step 8.
   ============================================================ */

const enc = new TextEncoder();

async function verifyStripeSignature(rawBody, sigHeader, secret) {
  if (!sigHeader) return false;
  const parts = Object.fromEntries(sigHeader.split(",").map((p) => p.split("=")));
  const t = parts.t;
  const v1 = parts.v1;
  if (!t || !v1) return false;

  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${rawBody}`));
  const expected = [...new Uint8Array(sigBuf)].map((b) => b.toString(16).padStart(2, "0")).join("");

  // constant-time-ish comparison
  if (expected.length !== v1.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ v1.charCodeAt(i);
  return diff === 0;
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
  const amount = (s.amount_total / 100).toLocaleString("en-GB", { style: "currency", currency: "GBP" });

  const html = `
    <h2>New booking — Wake District</h2>
    <table cellpadding="6" style="border-collapse:collapse;font-family:Arial,sans-serif">
      <tr><td><b>Experience</b></td><td>${m.experience || "—"}</td></tr>
      <tr><td><b>Date</b></td><td>${m.date || "—"}</td></tr>
      <tr><td><b>Start time</b></td><td>${m.time || "—"}</td></tr>
      <tr><td><b>People</b></td><td>${m.people || "—"}</td></tr>
      <tr><td><b>Paid</b></td><td>${amount}</td></tr>
      <tr><td><b>Name</b></td><td>${m.customer_name || "—"}</td></tr>
      <tr><td><b>Email</b></td><td>${m.customer_email || s.customer_email || "—"}</td></tr>
      <tr><td><b>Phone</b></td><td>${m.customer_phone || "—"}</td></tr>
      <tr><td><b>Notes</b></td><td>${m.notes || "—"}</td></tr>
    </table>`;

  // Only attempt the email if email is configured
  if (env.RESEND_API_KEY && env.BOOKINGS_EMAIL && env.FROM_EMAIL) {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: env.FROM_EMAIL,
        to: env.BOOKINGS_EMAIL,
        subject: `New booking: ${m.experience} on ${m.date} at ${m.time}`,
        html,
      }),
    });
  }

  return new Response("ok", { status: 200 });
}

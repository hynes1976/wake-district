/* ============================================================
   POST /api/create-voucher-checkout   (Cloudflare Pages Function)

   Creates a Stripe Checkout Session for a GIFT VOUCHER purchase.
   No date/time — the recipient chooses that later when they redeem
   the voucher code on the booking page.

   On successful payment, stripe-webhook.js generates the voucher
   code, stores it, builds the PDF and emails it out.

   Required env: STRIPE_SECRET_KEY
   ============================================================ */

// Source of truth for voucher prices (GBP pence) — keep in sync with
// create-checkout.js and assets/js/vouchers.js.
const PRICES = {
  "1-hour":   { name: "1 Hour Time Slot", amount: 14000, hours: 1 },
  "2-hour":   { name: "2 Hour Time Slot", amount: 26000, hours: 2 },
  "3-hour":   { name: "3 Hour Time Slot", amount: 36000, hours: 3 },
  "half-day": { name: "Half Day (4 hours)", amount: 45000, hours: 4 },
  "full-day": { name: "Full Day (8 hours)", amount: 80000, hours: 8 },
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

export async function onRequestPost({ request, env }) {
  if (!env.STRIPE_SECRET_KEY) return json({ error: "Payments are not configured yet." }, 500);

  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid request." }, 400); }

  const {
    experienceId, buyerName, buyerEmail,
    isGift, recipientName, recipientEmail, message, deliverTo,
  } = body || {};

  const item = PRICES[experienceId];
  if (!item) return json({ error: "Unknown session type." }, 400);
  if (!buyerName || !buyerName.trim()) return json({ error: "Please enter your name." }, 400);
  if (!buyerEmail || !/^\S+@\S+\.\S+$/.test(buyerEmail)) return json({ error: "Please enter a valid email address." }, 400);

  const gift = !!isGift;
  const deliver = gift && deliverTo === "recipient" ? "recipient" : "buyer";
  if (gift && (!recipientName || !recipientName.trim()))
    return json({ error: "Please enter the recipient's name." }, 400);
  if (deliver === "recipient" && (!recipientEmail || !/^\S+@\S+\.\S+$/.test(recipientEmail)))
    return json({ error: "Please enter a valid email for the recipient." }, 400);

  const origin = new URL(request.url).origin;

  const form = new URLSearchParams();
  form.set("mode", "payment");
  form.set("success_url", `${origin}/voucher-success.html?session_id={CHECKOUT_SESSION_ID}`);
  form.set("cancel_url", `${origin}/vouchers?cancelled=1`);
  form.set("customer_email", buyerEmail);

  form.set("line_items[0][quantity]", "1");
  form.set("line_items[0][price_data][currency]", "gbp");
  form.set("line_items[0][price_data][unit_amount]", String(item.amount));
  form.set("line_items[0][price_data][product_data][name]", `Gift Voucher — ${item.name} — Wake District`);
  form.set(
    "line_items[0][price_data][product_data][description]",
    `Wake District gift voucher for a ${item.name}. Valid 12 months. Redeemable online — recipient chooses their date & time.`
  );

  // Everything the webhook needs to build & send the voucher.
  const meta = {
    type: "voucher",
    experienceId,
    experienceName: item.name,
    hours: String(item.hours),
    buyer_name: buyerName.trim(),
    buyer_email: buyerEmail.trim(),
    recipient_name: gift ? (recipientName || "").trim() : "",
    recipient_email: gift ? (recipientEmail || "").trim() : "",
    gift_message: gift ? (message || "").trim().slice(0, 200) : "",
    deliver_to: deliver,
    amount: (item.amount / 100).toFixed(2),
  };
  Object.entries(meta).forEach(([k, v]) => {
    form.set(`metadata[${k}]`, v);
    form.set(`payment_intent_data[metadata][${k}]`, v);
  });

  const stripeRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  });

  const session = await stripeRes.json();
  if (!stripeRes.ok) {
    return json({ error: session?.error?.message || "Stripe could not create the checkout." }, 502);
  }
  return json({ url: session.url });
}

export async function onRequestGet() {
  return json({ error: "Send a POST request to buy a voucher." }, 405);
}

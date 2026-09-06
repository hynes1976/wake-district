/* ============================================================
   POST /api/create-topup-checkout   (Cloudflare Pages Function)

   Open-amount payment ("Top up") — for balances owed on the water.
   The customer enters the amount, their name and a short note, and
   pays by card via Stripe Checkout. No booking / slot is involved.

   On payment, stripe-webhook.js pings the owner + emails info@.

   Required env: STRIPE_SECRET_KEY
   ============================================================ */

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

export async function onRequestPost({ request, env }) {
  if (!env.STRIPE_SECRET_KEY) return json({ error: "Payments are not configured yet." }, 500);

  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid request." }, 400); }

  const { amount, name, note } = body || {};

  // Amount: pounds -> pence. Minimum £1 (avoids £0). No upper cap by request.
  const pounds = Number(amount);
  if (!Number.isFinite(pounds) || pounds < 1) {
    return json({ error: "Please enter a valid amount of at least £1." }, 400);
  }
  const unitAmount = Math.round(pounds * 100);
  if (!Number.isInteger(unitAmount) || unitAmount < 100) {
    return json({ error: "Please enter a valid amount of at least £1." }, 400);
  }

  if (!name || !name.trim()) return json({ error: "Please enter your name." }, 400);
  const cleanName = name.trim().slice(0, 120);
  const cleanNote = (note || "").trim().slice(0, 200);

  const origin = new URL(request.url).origin;

  const form = new URLSearchParams();
  form.set("mode", "payment");
  form.set("success_url", `${origin}/topup-success.html?session_id={CHECKOUT_SESSION_ID}`);
  form.set("cancel_url", `${origin}/pay?cancelled=1`);

  form.set("line_items[0][quantity]", "1");
  form.set("line_items[0][price_data][currency]", "gbp");
  form.set("line_items[0][price_data][unit_amount]", String(unitAmount));
  form.set("line_items[0][price_data][product_data][name]", "On-the-water Top-up — Wake District");
  form.set(
    "line_items[0][price_data][product_data][description]",
    `Balance payment for ${cleanName}` + (cleanNote ? ` · ${cleanNote}` : "")
  );

  const meta = {
    type: "topup",
    topup_name: cleanName,
    topup_note: cleanNote,
    amount: (unitAmount / 100).toFixed(2),
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
  return json({ error: "Send a POST request to make a top-up payment." }, 405);
}

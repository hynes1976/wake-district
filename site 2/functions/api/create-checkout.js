/* ============================================================
   POST /api/create-checkout   (Cloudflare Pages Function)

   Creates a Stripe Checkout Session and returns its URL.
   The browser then redirects the customer to Stripe to pay.

   WHY SERVER-SIDE: prices are defined here, not trusted from the
   browser, so the amount charged can never be tampered with.

   Required environment variable (set in Cloudflare dashboard):
     STRIPE_SECRET_KEY   e.g. sk_live_... (use sk_test_... while testing)

   Optional binding (for holiday blocking + availability):
     WD_KV   a KV namespace ("blocked_dates" + "booked_slots")

   No npm packages or build step needed — talks to Stripe over HTTPS.
   ============================================================ */

// Source of truth for prices (GBP) and session length (hours).
// Keep prices in sync with assets/js/booking.js.
const PRICES = {
  "1-hour":   { name: "1 Hour Time Slot — Wake District", amount: 12000, hours: 1 },
  "2-hour":   { name: "2 Hour Time Slot — Wake District", amount: 22000, hours: 2 },
  "3-hour":   { name: "3 Hour Time Slot — Wake District", amount: 30000, hours: 3 },
  "half-day": { name: "Half Day (4 hours) — Wake District", amount: 38000, hours: 4 },
  "full-day": { name: "Full Day (8 hours) — Wake District", amount: 70000, hours: 8 },
};

const VALID_LOCATIONS = [
  "The Swan Hotel & Spa, Lakeside",
  "Fell Foot",
  "Lakeside Hotel & Spa",
];
const SWAN_LAKESIDE_ONLY = ["half-day", "full-day"];

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });

async function kvJson(env, key) {
  try {
    if (!env.WD_KV) return null;
    const raw = await env.WD_KV.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function onRequestPost({ request, env }) {
  if (!env.STRIPE_SECRET_KEY) {
    return json({ error: "Payments are not configured yet." }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid request." }, 400);
  }

  const { experienceId, date, time, location, people, name, email, phone, notes } = body || {};

  // --- Server-side validation ---
  const item = PRICES[experienceId];
  if (!item) return json({ error: "Unknown session type." }, 400);
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "Invalid date." }, 400);
  if (!time || !/^\d{2}:\d{2}$/.test(time)) return json({ error: "Invalid time." }, 400);
  if (!VALID_LOCATIONS.includes(location)) return json({ error: "Please choose a valid pick-up location." }, 400);
  if (SWAN_LAKESIDE_ONLY.includes(experienceId) && location === "Fell Foot")
    return json({ error: "Half-day and full-day sessions run from The Swan Hotel & Spa / Lakeside only." }, 400);
  const ppl = parseInt(people, 10);
  if (!(ppl >= 1 && ppl <= 6)) return json({ error: "Group size must be 1–6." }, 400);
  if (!name || !email || !/^\S+@\S+\.\S+$/.test(email)) return json({ error: "Invalid contact details." }, 400);

  // Don't allow booking in the past
  if (new Date(`${date}T${time}:00`) < new Date()) {
    return json({ error: "That date and time has already passed." }, 400);
  }

  // Holiday / closed-day check
  const blocked = (await kvJson(env, "blocked_dates")) || [];
  if (blocked.includes(date)) {
    return json({ error: "Sorry, we're closed on that date — please pick another day." }, 400);
  }

  // Double-booking guard: is this start slot already taken?
  const bookedSlots = (await kvJson(env, "booked_slots")) || {};
  if (Array.isArray(bookedSlots[date]) && bookedSlots[date].includes(time)) {
    return json({ error: "Sorry, that start time has just been booked — please choose another." }, 409);
  }

  const origin = new URL(request.url).origin;
  const niceDate = new Date(`${date}T00:00:00`).toLocaleDateString("en-GB", {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
  });

  // --- Build the Stripe Checkout Session (form-encoded) ---
  const form = new URLSearchParams();
  form.set("mode", "payment");
  form.set("success_url", `${origin}/booking-success.html?session_id={CHECKOUT_SESSION_ID}`);
  form.set("cancel_url", `${origin}/book.html?cancelled=1`);
  form.set("customer_email", email);

  form.set("line_items[0][quantity]", "1");
  form.set("line_items[0][price_data][currency]", "gbp");
  form.set("line_items[0][price_data][unit_amount]", String(item.amount));
  form.set("line_items[0][price_data][product_data][name]", item.name);
  form.set(
    "line_items[0][price_data][product_data][description]",
    `${niceDate} at ${time} · ${ppl} ${ppl === 1 ? "person" : "people"} · Pick-up: ${location}`
  );

  // Saved against the payment, and used by the webhook to mark the slot booked
  const meta = {
    experience: item.name,
    date,
    time,
    hours: String(item.hours),
    pickup_location: location,
    people: String(ppl),
    customer_name: name,
    customer_email: email,
    customer_phone: phone || "",
    notes: notes || "",
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
    return json(
      { error: session?.error?.message || "Stripe could not create the checkout." },
      502
    );
  }

  return json({ url: session.url });
}

export async function onRequestGet() {
  return json({ error: "Send a POST request to create a checkout." }, 405);
}

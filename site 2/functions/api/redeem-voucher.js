/* ============================================================
   POST /api/redeem-voucher   (Cloudflare Pages Function)

   Redeems a gift voucher as a FREE booking. Validates the code,
   runs the same availability + 30-minute turnaround checks as a
   paid booking, records the booking, marks the voucher redeemed,
   and sends the confirmation emails. No payment is taken.

   Env: WD_KV (required), RESEND_API_KEY/FROM_EMAIL/BOOKINGS_EMAIL
        (emails), PUSHOVER_TOKEN/PUSHOVER_USER (owner alert).
   ============================================================ */

const PRICES = {
  "1-hour":   { name: "1 Hour Time Slot", hours: 1 },
  "2-hour":   { name: "2 Hour Time Slot", hours: 2 },
  "3-hour":   { name: "3 Hour Time Slot", hours: 3 },
  "half-day": { name: "Half Day (4 hours)", hours: 4 },
  "full-day": { name: "Full Day (8 hours)", hours: 8 },
};
const LOC_SWAN = "The Swan Hotel & Spa, Newby Bridge";
const LOC_FELL = "Fell Foot";
const LOC_LAKE = "Lakeside Hotel & Spa";
const LONG_SESSIONS = ["half-day", "full-day"];
function allowedLocations(experienceId) {
  return LONG_SESSIONS.includes(experienceId) ? [LOC_SWAN, LOC_LAKE] : [LOC_FELL, LOC_LAKE];
}
const BUFFER_SLOTS = 1; // 30-minute turnaround after each session

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

async function kvJson(env, key) {
  try { if (!env.WD_KV) return null; const raw = await env.WD_KV.get(key); return raw ? JSON.parse(raw) : null; }
  catch { return null; }
}

// 30-min start slots a session occupies. Add 0.5h for the trailing turnaround buffer.
function slotsFor(time, hours) {
  const [h, m] = time.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return [];
  const start = h * 60 + m;
  const count = Math.max(1, Math.round(hours * 2));
  const out = [];
  for (let i = 0; i < count; i++) {
    const t = start + i * 30;
    if (t >= 24 * 60) break;
    out.push(`${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`);
  }
  return out;
}
function occupiedSlots(time, hours) {
  return slotsFor(time, hours + BUFFER_SLOTS * 0.5);
}
function prettyDate(iso) {
  try { return new Date(iso + "T00:00:00").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" }); }
  catch { return iso; }
}
const todayISO = () => new Date().toISOString().slice(0, 10);

export async function onRequestPost({ request, env }) {
  if (!env.WD_KV) return json({ error: "Vouchers are not available right now." }, 500);

  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid request." }, 400); }

  const code = (body.code || "").trim().toUpperCase();
  const { date, time, location, people, name, email, phone, notes } = body || {};

  if (!code) return json({ error: "Please enter your voucher code." }, 400);

  // --- Voucher validation ---
  const v = await kvJson(env, `voucher:${code}`);
  if (!v) return json({ error: "That voucher code wasn't found. Please check and try again." }, 404);
  if (v.status === "redeemed") return json({ error: "That voucher has already been redeemed." }, 409);
  if (v.expires && v.expires < todayISO()) return json({ error: "That voucher has expired." }, 410);

  const item = PRICES[v.experienceId];
  if (!item) return json({ error: "This voucher's session type is no longer available — please call us." }, 400);

  // --- Booking field validation ---
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "Invalid date." }, 400);
  if (!time || !/^\d{2}:\d{2}$/.test(time)) return json({ error: "Invalid time." }, 400);
  if (!allowedLocations(v.experienceId).includes(location))
    return json({ error: LONG_SESSIONS.includes(v.experienceId)
      ? "Half-day and full-day sessions run from The Swan Hotel & Spa or Lakeside only."
      : "1, 2 and 3-hour sessions run from Fell Foot or Lakeside only." }, 400);
  const ppl = parseInt(people, 10);
  if (!(ppl >= 1 && ppl <= 6)) return json({ error: "Group size must be 1–6." }, 400);
  if (!name || !email || !/^\S+@\S+\.\S+$/.test(email)) return json({ error: "Invalid contact details." }, 400);

  // Require at least 1 hour's notice
  if (new Date(`${date}T${time}:00`).getTime() < Date.now() + 60 * 60 * 1000)
    return json({ error: "Bookings need at least 1 hour's notice — please choose a later time." }, 400);

  // --- Availability ---
  const blocked = (await kvJson(env, "blocked_dates")) || [];
  if (blocked.includes(date)) return json({ error: "Sorry, we're closed on that date — please pick another day." }, 400);

  const bookedSlots = (await kvJson(env, "booked_slots")) || {};
  if (Array.isArray(bookedSlots[date]) && bookedSlots[date].length) {
    const dayBooked = new Set(bookedSlots[date]);
    if (slotsFor(time, item.hours + 0.5).some((sl) => dayBooked.has(sl)))
      return json({ error: "Sorry, that time overlaps another booking — we need 30 minutes between sessions to turn the boat around. Please choose another time." }, 409);
  }
  const blockedSlots = (await kvJson(env, "blocked_slots")) || {};
  if (Array.isArray(blockedSlots[date]) && blockedSlots[date].length) {
    const dayBlocked = new Set(blockedSlots[date]);
    if (slotsFor(time, item.hours).some((sl) => dayBlocked.has(sl)))
      return json({ error: "Sorry, some of that time is unavailable — please choose another time or day." }, 409);
  }

  // --- Mark voucher redeemed (guard against double-use) ---
  const fresh = await kvJson(env, `voucher:${code}`);
  if (!fresh || fresh.status === "redeemed") return json({ error: "That voucher has already been redeemed." }, 409);
  fresh.status = "redeemed";
  fresh.redeemedAt = new Date().toISOString();
  fresh.redeemedDate = date;
  fresh.redeemedTime = time;
  fresh.redeemedBy = name;
  await env.WD_KV.put(`voucher:${code}`, JSON.stringify(fresh));
  // update the sales list status too (best effort)
  try {
    const raw = await env.WD_KV.get("voucher_records");
    if (raw) {
      const arr = JSON.parse(raw);
      const row = arr.find((r) => r.code === code);
      if (row) { row.status = "redeemed"; await env.WD_KV.put("voucher_records", JSON.stringify(arr)); }
    }
  } catch (e) { /* best effort */ }

  // --- Record the booking (slots + buffer, calendar list, private record) ---
  try {
    const slots = occupiedSlots(time, item.hours);
    const bs = (await kvJson(env, "booked_slots")) || {};
    const set = new Set(bs[date] || []);
    slots.forEach((sl) => set.add(sl));
    bs[date] = [...set].sort();
    await env.WD_KV.put("booked_slots", JSON.stringify(bs));

    const bObj = (await kvJson(env, "bookings")) || {};
    const list = bObj[date] || [];
    if (!list.some((b) => b.time === time)) {
      list.push({ time, hours: item.hours, experience: item.name });
      list.sort((a, b) => a.time.localeCompare(b.time));
      bObj[date] = list;
      await env.WD_KV.put("bookings", JSON.stringify(bObj));
    }

    const recRaw = await env.WD_KV.get("booking_records");
    const recArr = recRaw ? JSON.parse(recRaw) : [];
    recArr.unshift({
      created: new Date().toISOString(),
      experience: item.name, date, time, people: String(ppl),
      pickup: location, name, email, phone: phone || "", notes: notes || "",
      discount: "", paid: `Voucher ${code}`,
    });
    await env.WD_KV.put("booking_records", JSON.stringify(recArr.slice(0, 300)));
  } catch (e) { /* best effort — voucher already marked redeemed */ }

  // --- Emails + owner ping (best effort) ---
  const meta = { experience: item.name, date, time, pickup_location: location, people: String(ppl), customer_name: name, customer_email: email, customer_phone: phone || "", notes: notes || "", code };
  try { await sendConfirmations(env, meta); } catch (e) {}
  try { await sendOwnerPing(env, meta); } catch (e) {}

  return json({ ok: true, redirect: "/booking-success.html?voucher=1" });
}

async function sendEmail(env, to, subject, html) {
  return fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env.FROM_EMAIL, to, subject, html }),
  });
}
function esc(s) { return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

async function sendConfirmations(env, m) {
  if (!env.RESEND_API_KEY || !env.FROM_EMAIL) return;
  const custHtml = `
  <div style="font-family:Arial,Helvetica,sans-serif;color:#11242f;max-width:560px">
    <h2 style="color:#082f49">You're booked in! 🌊</h2>
    <p>Hi ${esc(m.customer_name) || "there"}, your Wake District voucher booking is confirmed — no payment needed.</p>
    <table cellpadding="8" style="border-collapse:collapse;background:#f6fafb;border-radius:8px;width:100%">
      <tr><td style="color:#5b7682">Experience</td><td><strong>${esc(m.experience)}</strong></td></tr>
      <tr><td style="color:#5b7682">Date</td><td><strong>${prettyDate(m.date)}</strong></td></tr>
      <tr><td style="color:#5b7682">Start time</td><td><strong>${esc(m.time)}</strong></td></tr>
      <tr><td style="color:#5b7682">Pick-up</td><td><strong>${esc(m.pickup_location)}</strong></td></tr>
      <tr><td style="color:#5b7682">Group size</td><td><strong>${esc(m.people)}</strong></td></tr>
      <tr><td style="color:#5b7682">Voucher</td><td><strong>${esc(m.code)}</strong></td></tr>
    </table>
    <p style="margin-top:18px"><strong>What to bring:</strong> a swimsuit, a towel and weather-appropriate items. Wetsuits can be provided if needed.</p>
    <p>Please arrive a few minutes early at your pick-up point. Questions? Call <a href="tel:07826551503">07826 551 503</a>.</p>
    <p style="color:#5b7682;font-size:13px;margin-top:24px">Wake District · Lake Windermere · See you on the water!</p>
  </div>`;
  if (m.customer_email) { try { await sendEmail(env, m.customer_email, "Your Wake District booking is confirmed 🌊", custHtml); } catch (e) {} }
  if (env.BOOKINGS_EMAIL) {
    const biz = `<h2>Voucher redeemed — booking confirmed</h2>
      <table cellpadding="6" style="border-collapse:collapse;font-family:Arial,sans-serif">
        <tr><td><b>Experience</b></td><td>${esc(m.experience)}</td></tr>
        <tr><td><b>Date</b></td><td>${prettyDate(m.date)}</td></tr>
        <tr><td><b>Start time</b></td><td>${esc(m.time)}</td></tr>
        <tr><td><b>Pick-up</b></td><td>${esc(m.pickup_location)}</td></tr>
        <tr><td><b>People</b></td><td>${esc(m.people)}</td></tr>
        <tr><td><b>Voucher</b></td><td>${esc(m.code)}</td></tr>
        <tr><td><b>Name</b></td><td>${esc(m.customer_name)}</td></tr>
        <tr><td><b>Email</b></td><td>${esc(m.customer_email)}</td></tr>
        <tr><td><b>Phone</b></td><td>${esc(m.customer_phone)}</td></tr>
        <tr><td><b>Notes</b></td><td>${esc(m.notes) || "—"}</td></tr>
      </table>`;
    try { await sendEmail(env, env.BOOKINGS_EMAIL, `Voucher booking: ${m.experience} on ${m.date} at ${m.time}`, biz); } catch (e) {}
  }
}

async function sendOwnerPing(env, m) {
  const PT = (env.PUSHOVER_TOKEN || "").trim();
  const PU = (env.PUSHOVER_USER || "").trim();
  if (!PT || !PU) return;
  const body =
    `${m.customer_name || "Someone"} — ${m.experience} (VOUCHER ${m.code})\n` +
    `${prettyDate(m.date)} at ${m.time}\n` +
    `${m.people} people · Pick-up: ${m.pickup_location}\n` +
    `Phone: ${m.customer_phone || "—"}\nEmail: ${m.customer_email || "—"}`;
  const form = new URLSearchParams();
  form.set("token", PT); form.set("user", PU);
  form.set("title", "Voucher booking - Wake District");
  form.set("message", body); form.set("priority", "1");
  form.set("url", "https://www.wakedistrict.co.uk/dashboard.html");
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try { await fetch("https://api.pushover.net/1/messages.json", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString(), signal: ctrl.signal }); }
    finally { clearTimeout(timer); }
  } catch (e) { /* best effort */ }
}

export async function onRequestGet() {
  return json({ error: "Send a POST request to redeem a voucher." }, 405);
}

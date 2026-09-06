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

// Full booking record (incl. contact details) for the Owner Dashboard.
// Kept private — only visible via the password-protected dashboard.
async function recordBookingContact(env, m, amount) {
  if (!env.WD_KV) return;
  const raw = await env.WD_KV.get("booking_records");
  const arr = raw ? JSON.parse(raw) : [];
  arr.unshift({
    created: new Date().toISOString(),
    experience: (m.experience || "").replace(/\s*—\s*Wake District\s*$/, ""),
    date: m.date || "",
    time: m.time || "",
    people: m.people || "",
    pickup: m.pickup_location || "",
    name: m.customer_name || "",
    email: m.customer_email || "",
    phone: m.customer_phone || "",
    notes: m.notes || "",
    discount: m.discount_code ? `${m.discount_code} (-${m.discount_percent}%)` : "",
    paid: amount || "",
  });
  // Keep the most recent 300 to stay well within storage limits.
  await env.WD_KV.put("booking_records", JSON.stringify(arr.slice(0, 300)));
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

// Instant booking alert to the owner's phone via Pushover.
async function sendBookingPing(env, m, amount) {
  const PT = (env.PUSHOVER_TOKEN || "").trim();
  const PU = (env.PUSHOVER_USER || "").trim();
  if (!PT || !PU) return;
  const exp = (m.experience || "Session").replace(/\s*—\s*Wake District\s*$/, "");
  const discountLine = m.discount_code ? `Discount: ${m.discount_code} (-${m.discount_percent}%)\n` : "";
  const notesLine = m.notes ? `Notes: ${m.notes}\n` : "";
  const body =
    `${m.customer_name || "Someone"} — ${exp}\n` +
    `${prettyDate(m.date)} at ${m.time || "?"}\n` +
    `${m.people || "?"} people · Pick-up: ${m.pickup_location || "—"}\n` +
    `Phone: ${m.customer_phone || "—"}\n` +
    `Email: ${m.customer_email || "—"}\n` +
    discountLine +
    notesLine +
    `Paid: ${amount}`;
  const form = new URLSearchParams();
  form.set("token", PT);
  form.set("user", PU);
  form.set("title", "New booking - Wake District");
  form.set("message", body);
  form.set("priority", "1"); // high priority
  form.set("url", "https://www.wakedistrict.co.uk/dashboard.html");
  form.set("url_title", "Open dashboard");
  try {
    // Hard timeout so a slow/hung request can never stall the webhook.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      await fetch("https://api.pushover.net/1/messages.json", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (e) { /* best effort */ }
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
      ${m.discount_code ? `<tr><td><b>Discount</b></td><td>${m.discount_code} (−${m.discount_percent}%)</td></tr>` : ""}
      <tr><td><b>Paid</b></td><td>${amount}</td></tr>
      <tr><td><b>Name</b></td><td>${m.customer_name || "—"}</td></tr>
      <tr><td><b>Email</b></td><td>${m.customer_email || "—"}</td></tr>
      <tr><td><b>Phone</b></td><td>${m.customer_phone || "—"}</td></tr>
      <tr><td><b>Notes</b></td><td>${m.notes || "—"}</td></tr>
    </table>`;
}

/* ============================================================
   On-the-water top-up / balance payment: notify the owner only.
   ============================================================ */
async function handleTopup(env, s, m, paidAmount) {
  const name = m.topup_name || "Someone";
  const note = m.topup_note || "";
  const amount = (s.amount_total / 100).toFixed(2);

  // Instant phone alert
  const PT = (env.PUSHOVER_TOKEN || "").trim();
  const PU = (env.PUSHOVER_USER || "").trim();
  if (PT && PU) {
    const body = `Top-up paid — £${amount}\nFrom: ${name}` + (note ? `\nNote: ${note}` : "");
    const form = new URLSearchParams();
    form.set("token", PT); form.set("user", PU);
    form.set("title", "Top-up paid - Wake District");
    form.set("message", body); form.set("priority", "1");
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      try {
        await fetch("https://api.pushover.net/1/messages.json", {
          method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: form.toString(), signal: ctrl.signal,
        });
      } finally { clearTimeout(timer); }
    } catch (e) { /* best effort */ }
  }

  // Email to the business
  if (env.RESEND_API_KEY && env.FROM_EMAIL && env.BOOKINGS_EMAIL) {
    const html = `<h2>Top-up payment received — Wake District</h2>
      <table cellpadding="6" style="border-collapse:collapse;font-family:Arial,sans-serif">
        <tr><td><b>Amount</b></td><td>£${amount}</td></tr>
        <tr><td><b>From</b></td><td>${escapeHtml(name)}</td></tr>
        <tr><td><b>Note</b></td><td>${escapeHtml(note) || "—"}</td></tr>
        <tr><td><b>Paid</b></td><td>${paidAmount}</td></tr>
      </table>`;
    try { await sendEmail(env, env.BOOKINGS_EMAIL, `Top-up paid: £${amount} from ${name}`, html); } catch (e) { /* best effort */ }
  }
}

/* ============================================================
   Gift vouchers: unique code, storage, branded PDF, emails.
   ============================================================ */
function genVoucherCode() {
  const A = "ACDEFGHJKLMNPQRSTUVWXYZ2345679"; // no ambiguous chars
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  const ch = (i) => A[buf[i] % A.length];
  return `WD-${ch(0)}${ch(1)}${ch(2)}${ch(3)}-${ch(4)}${ch(5)}${ch(6)}${ch(7)}`;
}

async function uniqueVoucherCode(env) {
  for (let i = 0; i < 5; i++) {
    const code = genVoucherCode();
    if (!env.WD_KV) return code;
    if (!(await env.WD_KV.get(`voucher:${code}`))) return code;
  }
  return genVoucherCode();
}

function escapeHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function handleVoucherPurchase(env, s, m) {
  const code = await uniqueVoucherCode(env);
  const now = new Date();
  const exp = new Date(now); exp.setMonth(exp.getMonth() + 12);
  const expiresISO = exp.toISOString().slice(0, 10);
  const amount = (s.amount_total / 100).toFixed(2);

  const rec = {
    code,
    experienceId: m.experienceId || "",
    experienceName: m.experienceName || "Session",
    hours: parseInt(m.hours || "1", 10) || 1,
    status: "active",
    amount,
    created: now.toISOString(),
    expires: expiresISO,
    buyerName: m.buyer_name || "",
    buyerEmail: m.buyer_email || s.customer_email || "",
    recipientName: m.recipient_name || "",
    recipientEmail: m.recipient_email || "",
    message: m.gift_message || "",
    isGift: !!(m.recipient_name || m.deliver_to === "recipient"),
  };

  if (env.WD_KV) {
    await env.WD_KV.put(`voucher:${code}`, JSON.stringify(rec));
    try {
      const raw = await env.WD_KV.get("voucher_records");
      const arr = raw ? JSON.parse(raw) : [];
      arr.unshift({ created: rec.created, code, experience: rec.experienceName, amount, buyer: rec.buyerName, buyerEmail: rec.buyerEmail, recipient: rec.recipientName, expires: expiresISO, status: "active" });
      await env.WD_KV.put("voucher_records", JSON.stringify(arr.slice(0, 300)));
    } catch (e) { /* best effort */ }
  }

  const pdfB64 = buildVoucherPdf(rec, prettyDate(expiresISO));
  const att = [{ filename: `WakeDistrict-Voucher-${code}.pdf`, content: pdfB64 }];

  const toRecipient = m.deliver_to === "recipient" && rec.recipientEmail ? rec.recipientEmail : "";
  const primaryTo = toRecipient || rec.buyerEmail;

  if (env.RESEND_API_KEY && env.FROM_EMAIL) {
    if (primaryTo) {
      try { await sendEmailWithAttachment(env, primaryTo, "Your Wake District Gift Voucher 🎁", voucherEmailHtml(rec, toRecipient ? "recipient" : "buyer"), att); } catch (e) {}
    }
    if (toRecipient && rec.buyerEmail && rec.buyerEmail !== toRecipient) {
      try { await sendEmailWithAttachment(env, rec.buyerEmail, "Your Wake District gift voucher (your copy) 🎁", voucherEmailHtml(rec, "buyercopy"), att); } catch (e) {}
    }
    if (env.BOOKINGS_EMAIL) {
      try { await sendEmailWithAttachment(env, env.BOOKINGS_EMAIL, `Voucher sold: ${rec.experienceName} (${code})`, voucherBusinessHtml(rec, amount), []); } catch (e) {}
    }
  }
  try { await sendVoucherPing(env, rec, amount); } catch (e) {}
}

async function sendEmailWithAttachment(env, to, subject, html, attachments) {
  const payload = { from: env.FROM_EMAIL, to, subject, html };
  if (attachments && attachments.length) payload.attachments = attachments;
  return fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function voucherEmailHtml(rec, mode) {
  const greetingName = mode === "recipient" ? (rec.recipientName || "there") : (rec.buyerName || "there");
  const intro =
    mode === "recipient"
      ? `${escapeHtml(rec.buyerName || "Someone")} has treated you to a Wake District experience! 🌊`
      : mode === "buyercopy"
      ? `Here's your copy of the gift voucher — we've also emailed it to ${escapeHtml(rec.recipientName || "the recipient")}.`
      : rec.isGift
      ? `Thanks for your purchase! Here's the gift voucher for ${escapeHtml(rec.recipientName || "your recipient")} — the PDF is attached to print or forward.`
      : `Thanks for your purchase! Your voucher PDF is attached.`;
  const msgBlock = rec.message
    ? `<tr><td style="color:#5b7682">Message</td><td><em>“${escapeHtml(rec.message)}”</em></td></tr>`
    : "";
  return `
  <div style="font-family:Arial,Helvetica,sans-serif;color:#11242f;max-width:560px">
    <h2 style="color:#082f49">Wake District Gift Voucher 🎁</h2>
    <p>Hi ${escapeHtml(greetingName)}, ${intro}</p>
    <table cellpadding="8" style="border-collapse:collapse;background:#f6fafb;border-radius:8px;width:100%">
      <tr><td style="color:#5b7682">Session</td><td><strong>${escapeHtml(rec.experienceName)}</strong> — the whole boat, up to 6 people</td></tr>
      <tr><td style="color:#5b7682">Voucher code</td><td><strong style="font-size:18px;letter-spacing:1px">${rec.code}</strong></td></tr>
      <tr><td style="color:#5b7682">Valid until</td><td><strong>${prettyDate(rec.expires)}</strong></td></tr>
      ${msgBlock}
    </table>
    <p style="margin-top:18px"><strong>How to redeem:</strong> go to <a href="https://www.wakedistrict.co.uk/book">wakedistrict.co.uk/book</a>, choose the <strong>${escapeHtml(rec.experienceName)}</strong>, pick a date &amp; time, and enter your voucher code — no card needed.</p>
    <p>The full voucher is attached as a PDF you can print or forward.</p>
    <p>Questions? Call <a href="tel:07826551503">07826 551 503</a> or reply to this email.</p>
    <p style="color:#5b7682;font-size:13px;margin-top:24px">Wake District · Lake Windermere · See you on the water!</p>
  </div>`;
}

function voucherBusinessHtml(rec, amount) {
  return `
    <h2>Gift voucher sold — Wake District</h2>
    <table cellpadding="6" style="border-collapse:collapse;font-family:Arial,sans-serif">
      <tr><td><b>Session</b></td><td>${escapeHtml(rec.experienceName)}</td></tr>
      <tr><td><b>Code</b></td><td>${rec.code}</td></tr>
      <tr><td><b>Amount</b></td><td>£${amount}</td></tr>
      <tr><td><b>Valid until</b></td><td>${prettyDate(rec.expires)}</td></tr>
      <tr><td><b>Buyer</b></td><td>${escapeHtml(rec.buyerName)} (${escapeHtml(rec.buyerEmail)})</td></tr>
      <tr><td><b>Gift for</b></td><td>${escapeHtml(rec.recipientName || "—")} ${rec.recipientEmail ? "(" + escapeHtml(rec.recipientEmail) + ")" : ""}</td></tr>
      ${rec.message ? `<tr><td><b>Message</b></td><td>${escapeHtml(rec.message)}</td></tr>` : ""}
    </table>`;
}

async function sendVoucherPing(env, rec, amount) {
  const PT = (env.PUSHOVER_TOKEN || "").trim();
  const PU = (env.PUSHOVER_USER || "").trim();
  if (!PT || !PU) return;
  const body =
    `${rec.experienceName} voucher — £${amount}\n` +
    `Code: ${rec.code}\n` +
    `Buyer: ${rec.buyerName || "—"}\n` +
    (rec.recipientName ? `Gift for: ${rec.recipientName}\n` : "") +
    `Valid until ${prettyDate(rec.expires)}`;
  const form = new URLSearchParams();
  form.set("token", PT); form.set("user", PU);
  form.set("title", "Voucher sold - Wake District");
  form.set("message", body);
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      await fetch("https://api.pushover.net/1/messages.json", {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(), signal: ctrl.signal,
      });
    } finally { clearTimeout(timer); }
  } catch (e) { /* best effort */ }
}

/* ---- Minimal self-contained PDF builder for the branded voucher ---- */
function buildVoucherPdf(rec, expiryPretty) {
  const W = 842, H = 595; // A4 landscape (points)
  const NAVY = "#082f49", TEAL = "#12a5b8", INK = "#11242f", MUTED = "#5b7682", LIGHT = "#eaf4f6";

  const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const latin1 = (s) => String(s).split("").map((c) => (c.charCodeAt(0) > 255 ? "?" : c)).join("");
  const rgb = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    return ((n >> 16 & 255) / 255).toFixed(3) + " " + ((n >> 8 & 255) / 255).toFixed(3) + " " + ((n & 255) / 255).toFixed(3);
  };
  const T = (x, y, size, font, color, str) =>
    `BT /${font} ${size} Tf ${rgb(color)} rg ${x} ${y} Td (${esc(latin1(str))}) Tj ET\n`;
  const RECT = (x, y, w, h, color) => `${rgb(color)} rg ${x} ${y} ${w} ${h} re f\n`;
  const wrap = (str, maxChars) => {
    const words = String(str).split(/\s+/);
    const lines = []; let line = "";
    for (const w2 of words) {
      if ((line + " " + w2).trim().length > maxChars) { if (line) lines.push(line); line = w2; }
      else line = (line ? line + " " : "") + w2;
    }
    if (line) lines.push(line);
    return lines.slice(0, 4);
  };

  let c = "";
  c += RECT(0, 0, W, H, "#ffffff");
  c += `${rgb(TEAL)} RG 3 w 22 22 ${W - 44} ${H - 44} re S\n`;
  c += RECT(0, H - 132, W, 132, NAVY);
  c += RECT(0, H - 140, W, 8, TEAL);
  c += T(60, H - 78, 30, "F2", "#ffffff", "WAKE DISTRICT");
  c += T(62, H - 104, 11, "F1", "#bfe3ea", "WATER & WAKE SPORTS   ·   LAKE WINDERMERE");
  c += T(W - 250, H - 78, 15, "F2", "#12a5b8", "GIFT VOUCHER");

  c += T(60, 410, 40, "F2", TEAL, "Gift Voucher");
  c += T(60, 366, 24, "F2", NAVY, rec.experienceName);
  c += T(60, 342, 13, "F1", MUTED, "The whole boat   ·   up to 6 people   ·   Lake Windermere");

  c += RECT(60, 250, 430, 60, LIGHT);
  c += T(74, 288, 10, "F1", MUTED, "VOUCHER CODE");
  c += T(74, 262, 26, "F2", NAVY, rec.code);

  c += T(60, 222, 12, "F1", INK, "Valid until: " + expiryPretty);
  c += T(60, 202, 12, "F1", MUTED, "Value: £" + rec.amount + "   (" + rec.experienceName + ")");

  if (rec.isGift && (rec.recipientName || rec.message)) {
    let gy = 366;
    if (rec.recipientName) { c += T(540, gy, 15, "F2", NAVY, "To: " + rec.recipientName); gy -= 26; }
    if (rec.message) {
      c += T(540, gy, 11, "F1", MUTED, "Message:"); gy -= 18;
      for (const ln of wrap(rec.message, 34)) { c += T(540, gy, 12, "F3", INK, ln); gy -= 16; }
      gy -= 4;
    }
    if (rec.buyerName) c += T(540, gy, 12, "F1", MUTED, "From: " + rec.buyerName);
  }

  c += RECT(60, 118, W - 120, 2, "#dbe7ea");
  c += T(60, 92, 13, "F2", NAVY, "How to redeem");
  c += T(60, 72, 11, "F1", INK, "Visit wakedistrict.co.uk/book, choose the " + rec.experienceName + ", pick your date & time,");
  c += T(60, 56, 11, "F1", INK, "and enter the voucher code above at the summary - no card needed.");
  c += T(60, 34, 9.5, "F1", MUTED, "Wake District  ·  info@wakedistrict.co.uk  ·  07826 551 503  ·  wakedistrict.co.uk");

  const objs = [];
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = "<< /Type /Pages /Kids [3 0 R] /Count 1 >>";
  objs[3] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 5 0 R /F2 6 0 R /F3 7 0 R >> >> /Contents 4 0 R >>`;
  objs[4] = `<< /Length ${c.length} >>\nstream\n${c}endstream`;
  objs[5] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objs[6] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";
  objs[7] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>";

  let pdf = "%PDF-1.4\n";
  const offsets = [];
  for (let i = 1; i < objs.length; i++) { offsets[i] = pdf.length; pdf += `${i} 0 obj\n${objs[i]}\nendobj\n`; }
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) pdf += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
  pdf += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;

  return btoa(pdf);
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

  const paidAmount = (s.amount_total / 100).toLocaleString("en-GB", { style: "currency", currency: "GBP" });

  // Gift voucher purchase — a completely separate flow (no slot is booked).
  if (m.type === "voucher") {
    try { await handleVoucherPurchase(env, s, m); } catch (e) { /* best effort */ }
    return new Response("ok", { status: 200 });
  }

  // On-the-water top-up / balance payment — notify only, no booking.
  if (m.type === "topup") {
    try { await handleTopup(env, s, m, paidAmount); } catch (e) { /* best effort */ }
    return new Response("ok", { status: 200 });
  }

  // 1. Mark the slot (+ buffer) booked, for the availability calendar
  try { await recordBooking(env, m); } catch (e) { /* don't fail the webhook on this */ }

  // 1b. Save the full booking (with contact details) for the Owner Dashboard
  try { await recordBookingContact(env, m, paidAmount); } catch (e) { /* best effort */ }

  // 1c. Instant booking alert to the owner's phone (ntfy)
  try { await sendBookingPing(env, m, paidAmount); } catch (e) { /* best effort */ }

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

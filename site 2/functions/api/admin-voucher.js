/* ============================================================
   POST /api/admin-voucher   (Cloudflare Pages Function)

   Staff tool (password protected) to issue a gift voucher to a
   customer — e.g. a goodwill gesture for a cancelled or delayed
   session. Generates a unique code, stores it (valid 12 months),
   builds the branded photo voucher PDF and emails it to them.

   Body: { password, experienceId, name, email, message }
   Env: WD_KV, ADMIN_PASSWORD, RESEND_API_KEY, FROM_EMAIL, BOOKINGS_EMAIL
   ============================================================ */

const PRICES = {
  "1-hour":   { name: "1 Hour Time Slot", hours: 1, amount: "140.00" },
  "2-hour":   { name: "2 Hour Time Slot", hours: 2, amount: "260.00" },
  "3-hour":   { name: "3 Hour Time Slot", hours: 3, amount: "360.00" },
  "half-day": { name: "Half Day (4 hours)", hours: 4, amount: "450.00" },
  "full-day": { name: "Full Day (8 hours)", hours: 8, amount: "800.00" },
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function escapeHtml(s) { return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function prettyDate(iso) { try { return new Date(iso + "T00:00:00").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" }); } catch { return iso; } }

function genVoucherCode() {
  const A = "ACDEFGHJKLMNPQRSTUVWXYZ2345679";
  const buf = new Uint8Array(8); crypto.getRandomValues(buf);
  const ch = (i) => A[buf[i] % A.length];
  return `WD-${ch(0)}${ch(1)}${ch(2)}${ch(3)}-${ch(4)}${ch(5)}${ch(6)}${ch(7)}`;
}
async function uniqueCode(env) {
  for (let i = 0; i < 5; i++) { const c = genVoucherCode(); if (!env.WD_KV) return c; if (!(await env.WD_KV.get(`voucher:${c}`))) return c; }
  return genVoucherCode();
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

function voucherEmailHtml(rec) {
  const msgBlock = rec.message ? `<tr><td style="color:#5b7682">Message</td><td><em>“${escapeHtml(rec.message)}”</em></td></tr>` : "";
  return `
  <div style="font-family:Arial,Helvetica,sans-serif;color:#11242f;max-width:560px">
    <h2 style="color:#082f49">Your Wake District Voucher 🎁</h2>
    <p>Hi ${escapeHtml(rec.recipientName || "there")}, please find your Wake District voucher attached — we hope to see you on the water soon!</p>
    <table cellpadding="8" style="border-collapse:collapse;background:#f6fafb;border-radius:8px;width:100%">
      <tr><td style="color:#5b7682">Session</td><td><strong>${escapeHtml(rec.experienceName)}</strong> — the whole boat, up to 6 people</td></tr>
      <tr><td style="color:#5b7682">Voucher code</td><td><strong style="font-size:18px;letter-spacing:1px">${rec.code}</strong></td></tr>
      <tr><td style="color:#5b7682">Valid until</td><td><strong>${prettyDate(rec.expires)}</strong></td></tr>
      ${msgBlock}
    </table>
    <p style="margin-top:18px"><strong>How to redeem:</strong> go to <a href="https://www.wakedistrict.co.uk/book">wakedistrict.co.uk/book</a>, choose the <strong>${escapeHtml(rec.experienceName)}</strong>, pick a date &amp; time, and enter your voucher code — no card needed.</p>
    <p>The full voucher is attached as a PDF you can print or keep on your phone.</p>
    <p>Questions? Call <a href="tel:07826551503">07826 551 503</a> or reply to this email.</p>
    <p style="color:#5b7682;font-size:13px;margin-top:24px">Wake District · Lake Windermere · See you on the water!</p>
  </div>`;
}

function voucherBusinessCopyHtml(rec, amount) {
  return `
    <h2>Voucher issued — Wake District</h2>
    <p>A voucher was issued from the admin page and emailed to the customer. Your copy of the PDF is attached.</p>
    <table cellpadding="6" style="border-collapse:collapse;font-family:Arial,sans-serif">
      <tr><td><b>Session</b></td><td>${escapeHtml(rec.experienceName)}</td></tr>
      <tr><td><b>Code</b></td><td>${rec.code}</td></tr>
      <tr><td><b>Value</b></td><td>£${amount}</td></tr>
      <tr><td><b>Valid until</b></td><td>${prettyDate(rec.expires)}</td></tr>
      <tr><td><b>Issued to</b></td><td>${escapeHtml(rec.recipientName)} (${escapeHtml(rec.recipientEmail)})</td></tr>
      ${rec.message ? `<tr><td><b>Message</b></td><td>${escapeHtml(rec.message)}</td></tr>` : ""}
    </table>`;
}

/* ---- Photo voucher PDF (same generator as the purchase flow) ---- */
const HELV_W = {" ":278,"!":278,'"':355,"#":556,"$":556,"%":889,"&":667,"'":191,"(":333,")":333,"*":389,"+":584,",":278,"-":333,".":278,"/":278,"0":556,"1":556,"2":556,"3":556,"4":556,"5":556,"6":556,"7":556,"8":556,"9":556,":":278,";":278,"<":584,"=":584,">":584,"?":556,"@":1015,"A":667,"B":667,"C":722,"D":722,"E":667,"F":611,"G":778,"H":722,"I":278,"J":500,"K":667,"L":556,"M":833,"N":722,"O":778,"P":667,"Q":778,"R":722,"S":667,"T":611,"U":722,"V":667,"W":944,"X":667,"Y":667,"Z":611,"a":556,"b":556,"c":500,"d":556,"e":556,"f":278,"g":556,"h":556,"i":222,"j":222,"k":500,"l":222,"m":833,"n":556,"o":556,"p":556,"q":556,"r":333,"s":500,"t":278,"u":556,"v":500,"w":722,"x":500,"y":500,"z":500};
const HELVB_W = {" ":278,"A":722,"B":722,"C":722,"D":722,"E":667,"F":611,"G":778,"H":722,"I":278,"J":556,"K":722,"L":611,"M":833,"N":722,"O":778,"P":667,"Q":778,"R":722,"S":667,"T":611,"U":722,"V":667,"W":944,"X":667,"Y":667,"Z":611,"a":556,"b":611,"c":556,"d":611,"e":556,"f":333,"g":611,"h":611,"i":278,"j":278,"k":556,"l":278,"m":889,"n":611,"o":611,"p":611,"q":611,"r":389,"s":556,"t":333,"u":611,"v":556,"w":778,"x":556,"y":556,"z":500,"0":556,"1":556,"2":556,"3":556,"4":556,"5":556,"6":556,"7":556,"8":556,"9":556,":":333,"-":333,".":278,",":278,"'":238};

function buildVoucherPdf(rec, imgBytes) {
  const tw = (str, size, tc, bold) => { const t = bold ? HELVB_W : HELV_W; let w = 0; for (const ch of String(str)) { w += ((t[ch] || 556) / 1000) * size + tc; } return w - tc; };
  const jpegSize = (b) => { let i = 2; while (i < b.length) { if (b[i] !== 0xFF) { i++; continue; } const m = b[i + 1]; if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) { return { h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8] }; } const len = (b[i + 2] << 8) | b[i + 3]; i += 2 + len; } return { w: 1800, h: 848 }; };
  const PUNC = { "’": "\x92", "‘": "\x91", "“": "\x93", "”": "\x94", "–": "\x96", "—": "\x97", "…": "\x85", "•": "\x95" };
  const win = (s) => String(s).split("").map((c) => PUNC[c] || (c.charCodeAt(0) <= 255 ? c : "?")).join("");
  const esc = (s) => win(s).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const { w: IMGW, h: IMGH } = jpegSize(imgBytes);
  const W = 1000, H = Math.round(W * IMGH / IMGW);
  const WHITE = "1 1 1", TEAL = "0.090 0.722 0.800", GREY = "0.82 0.88 0.90";
  const T = (x, y, size, font, color, str, tc) => { tc = tc || 0; return `BT /${font} ${size} Tf ${tc} Tc ${color} rg 1 0 0 1 ${x.toFixed(1)} ${y.toFixed(1)} Tm (${esc(str)}) Tj ET\n`; };
  const ctr = (cx, y, size, font, color, str, tc, bold) => T(cx - tw(str, size, tc, bold) / 2, y, size, font, color, str, tc);
  const wrap = (str, size, tc, bold, maxw) => { const words = String(str).split(/\s+/); const lines = []; let line = ""; for (const w of words) { const test = (line ? line + " " : "") + w; if (tw(test, size, tc, bold) > maxw && line) { lines.push(line); line = w; } else line = test; } if (line) lines.push(line); return lines.slice(0, 4); };
  const wave = (x, y) => `${TEAL} RG 3 w ${x} ${y} m ${x + 11} ${y + 7} ${x + 23} ${y - 7} ${x + 34} ${y} c S\n`;

  const SESS = { "1-hour": "1 HOUR SESSION", "2-hour": "2 HOUR SESSION", "3-hour": "3 HOUR SESSION", "half-day": "HALF DAY SESSION", "full-day": "FULL DAY SESSION" };
  const sessLabel = SESS[rec.experienceId] || String(rec.experienceName || "").toUpperCase();
  const forName = ("FOR " + String(rec.recipientName || rec.buyerName || "YOU")).toUpperCase();
  const cx = 300;

  let c = `q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q\n`;
  c += T(52, H - 70, 54, "F2", WHITE, "GIFT VOUCHER", 11);
  c += ctr(cx, H - 120, 30, "F2", WHITE, forName, 7, true);
  const fw = tw(forName, 30, 7, true);
  c += wave(cx - fw / 2 - 52, H - 130); c += wave(cx + fw / 2 + 18, H - 130);
  c += ctr(cx, H - 152, 12.5, "F1", GREY, "WAKE DISTRICT  ·  LAKE WINDERMERE", 4);
  c += ctr(cx, H - 188, 22, "F2", TEAL, sessLabel, 6, true);
  c += T(52, H - 235, 17, "F2", WHITE, "CODE:", 0);
  c += T(52 + tw("CODE: ", 17, 0, true), H - 235, 17, "F1", WHITE, rec.code, 0);
  if (rec.message) {
    c += T(52, H - 270, 15, "F2", WHITE, "MESSAGE:", 0);
    let my = H - 292; for (const ln of wrap(rec.message, 14, 0, false, 430)) { c += T(52, my, 14, "F1", WHITE, ln, 0); my -= 19; }
  }

  const strB = (s) => { const a = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i) & 0xff; return a; };
  const parts = []; let pos = 0; const off = [];
  const put = (x) => { const a = (x instanceof Uint8Array) ? x : strB(x); parts.push(a); pos += a.length; };
  put("%PDF-1.4\n");
  const obj = (n, body) => { off[n] = pos; put(`${n} 0 obj\n`); put(body); put("\nendobj\n"); };
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 5 0 R /F2 6 0 R /F3 7 0 R >> /XObject << /Im0 8 0 R >> >> /Contents 4 0 R >>`);
  off[4] = pos; put(`4 0 obj\n<< /Length ${c.length} >>\nstream\n`); put(c); put("\nendstream\nendobj\n");
  obj(5, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  obj(6, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  obj(7, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>");
  off[8] = pos; put(`8 0 obj\n<< /Type /XObject /Subtype /Image /Width ${IMGW} /Height ${IMGH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${imgBytes.length} >>\nstream\n`); put(imgBytes); put("\nendstream\nendobj\n");
  const xref = pos;
  let xr = `xref\n0 9\n0000000000 65535 f \n`; for (let i = 1; i <= 8; i++) xr += String(off[i]).padStart(10, "0") + " 00000 n \n";
  put(xr); put(`trailer\n<< /Size 9 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
  let total = 0; for (const p of parts) total += p.length; const all = new Uint8Array(total); let o = 0; for (const p of parts) { all.set(p, o); o += p.length; }
  let bin = ""; const chk = 0x8000; for (let i = 0; i < all.length; i += chk) bin += String.fromCharCode.apply(null, all.subarray(i, i + chk));
  return btoa(bin);
}

export async function onRequestPost({ request, env }) {
  if (!env.ADMIN_PASSWORD) return json({ error: "Admin password is not set up yet." }, 500);
  if (!env.WD_KV) return json({ error: "Voucher storage is not set up yet." }, 500);

  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid request." }, 400); }
  if (!safeEqual(body.password || "", env.ADMIN_PASSWORD)) return json({ error: "Incorrect password." }, 401);

  const item = PRICES[body.experienceId];
  if (!item) return json({ error: "Please choose a valid session." }, 400);
  const name = (body.name || "").trim().slice(0, 120);
  const email = (body.email || "").trim();
  const message = (body.message || "").trim().slice(0, 200);
  if (!name) return json({ error: "Please enter the recipient's name." }, 400);
  if (!/^\S+@\S+\.\S+$/.test(email)) return json({ error: "Please enter a valid email address." }, 400);

  const code = await uniqueCode(env);
  const now = new Date();
  const exp = new Date(now); exp.setMonth(exp.getMonth() + 12);
  const expiresISO = exp.toISOString().slice(0, 10);

  const rec = {
    code,
    experienceId: body.experienceId,
    experienceName: item.name,
    hours: item.hours,
    status: "active",
    amount: item.amount,
    created: now.toISOString(),
    expires: expiresISO,
    buyerName: "Wake District",
    buyerEmail: "",
    recipientName: name,
    recipientEmail: email,
    message,
    isGift: true,
    source: "admin",
  };

  await env.WD_KV.put(`voucher:${code}`, JSON.stringify(rec));
  try {
    const raw = await env.WD_KV.get("voucher_records");
    const arr = raw ? JSON.parse(raw) : [];
    arr.unshift({ created: rec.created, code, experience: item.name, amount: item.amount, buyer: "Wake District (issued)", buyerEmail: "", recipient: name, expires: expiresISO, status: "active", source: "admin" });
    await env.WD_KV.put("voucher_records", JSON.stringify(arr.slice(0, 300)));
  } catch (e) { /* best effort */ }

  if (!env.RESEND_API_KEY || !env.FROM_EMAIL) {
    return json({ ok: true, code, sent: false, note: "Voucher created but email is not configured." });
  }

  // Build PDF (fetch background image) and email the customer.
  let att = [];
  try {
    const imgRes = await fetch("https://www.wakedistrict.co.uk/assets/img/voucher-bg.jpg", { cf: { cacheTtl: 86400 } });
    if (imgRes.ok) {
      const imgBytes = new Uint8Array(await imgRes.arrayBuffer());
      att = [{ filename: `WakeDistrict-Voucher-${code}.pdf`, content: buildVoucherPdf(rec, imgBytes) }];
    }
  } catch (e) { /* fall back to email without attachment */ }

  let sent = false;
  try {
    const res = await sendEmailWithAttachment(env, email, "Your Wake District Voucher 🎁", voucherEmailHtml(rec), att);
    sent = res.ok;
  } catch (e) { sent = false; }

  // Send a copy to the business so there's a record of what was issued.
  const copyTo = env.BOOKINGS_EMAIL || "info@wakedistrict.co.uk";
  try {
    await sendEmailWithAttachment(
      env,
      copyTo,
      `Voucher issued: ${item.name} for ${name} (${code})`,
      voucherBusinessCopyHtml(rec, item.amount),
      att
    );
  } catch (e) { /* best effort — never block the customer send */ }

  return json({ ok: true, code, sent });
}

export async function onRequestGet() {
  return json({ error: "Send a POST request to issue a voucher." }, 405);
}

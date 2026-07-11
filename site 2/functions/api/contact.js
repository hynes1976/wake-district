/* ============================================================
   POST /api/contact   (Cloudflare Pages Function)

   Handles the website contact form. Emails the enquiry to the
   business inbox via Resend (reusing the same env vars as the
   booking emails), with the sender's address set as reply-to so
   you can reply directly.

   Env vars (already configured in Cloudflare):
     RESEND_API_KEY  re_...      (enables the email)
     FROM_EMAIL      onboarding@resend.dev (or a verified sender)
     BOOKINGS_EMAIL  info@wakedistrict.co.uk (where enquiries go)
   ============================================================ */

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function esc(s) {
  return String(s || "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
  );
}

export async function onRequestPost({ request, env }) {
  try {
    let data = {};
    const ct = request.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      data = await request.json();
    } else {
      const fd = await request.formData();
      fd.forEach((v, k) => (data[k] = v));
    }

    const name = `${data.first_name || ""} ${data.last_name || ""}`.trim() || "Website enquiry";
    const email = String(data.email || "").trim();
    const message = String(data.message || "").trim();

    if (!email || !message) {
      return json({ ok: false, error: "Please include your email and a message." }, 400);
    }

    const to = env.BOOKINGS_EMAIL || "info@wakedistrict.co.uk";

    if (env.RESEND_API_KEY && env.FROM_EMAIL) {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: env.FROM_EMAIL,
          to,
          reply_to: email,
          subject: `New website enquiry — ${name}`,
          html:
            `<h2>New enquiry via wakedistrict.co.uk</h2>` +
            `<p><b>Name:</b> ${esc(name)}</p>` +
            `<p><b>Email:</b> ${esc(email)}</p>` +
            `<p><b>Message:</b><br>${esc(message).replace(/\n/g, "<br>")}</p>`,
        }),
      });
      if (!res.ok) {
        return json({ ok: false, error: "Could not send right now." }, 502);
      }
    } else {
      return json({ ok: false, error: "Email is not configured." }, 500);
    }

    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, error: "Something went wrong." }, 500);
  }
}

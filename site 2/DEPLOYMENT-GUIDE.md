# Wake District — Going Live Guide

Everything you need to put this site online cheaply and move
`wakedistrict.co.uk` off Wix. No coding required — just following steps.

---

## 1. What costs what

| Item | Now (Wix) | New setup |
|---|---|---|
| Hosting | part of ~£35/mo | **£0** (Cloudflare Pages free tier) |
| Booking + payments backend | part of ~£35/mo | **£0** (runs on the same free tier) |
| Domain `wakedistrict.co.uk` | renews via Wix | ~**£8–12/year** (keep it where it is, or move it) |
| Card processing fees | Wix takes a cut | Stripe: **1.5% + 20p** per UK card payment |
| Booking email alerts (optional) | — | **£0** (Resend free tier) |
| Contact form (optional) | — | **£0** (Formspree free tier) |

**Bottom line:** roughly **£420/year → near £0/year** plus the domain. You only
pay Stripe's per-transaction fee, which you effectively pay on Wix too.

---

## 2. Preview it on your own computer first

You don't need anything installed to look at it — just **double-click `index.html`**
inside the `site` folder and it opens in your browser. Click around all the pages.

> Note: the **booking payment step** won't work from a double-clicked file —
> it needs the server function, which only runs once deployed (step 5) or when
> previewed with the tool in step 9. Everything else works.

---

## 3. Add your own photos and logo (5 minutes)

Open `site/assets/img/` and read `IMAGES-READ-ME.txt`. Download your photos from
Wix and drop them in with the exact filenames listed. Until you do, the site
shows tidy blue gradients — nothing looks broken.

---

## 4. Create a free Stripe account (for taking payment)

1. Go to **stripe.com** and sign up (it's free; they take a per-transaction fee).
2. Add your business + bank details so payouts reach you.
3. In the Stripe Dashboard, go to **Developers → API keys**.
4. Copy your **Secret key** (starts `sk_live_...`). Keep it private — it's like a password.
   - While testing, use the **test** secret key (`sk_test_...`) and Stripe's test card `4242 4242 4242 4242`.

You'll paste this key into Cloudflare in step 6.

---

## 5. Put the site online — free — with Cloudflare Pages

The simplest route (no GitHub needed):

1. Sign up at **dash.cloudflare.com** (free).
2. Left menu → **Workers & Pages → Create → Pages → Upload assets**.
3. Give it a name, e.g. `wake-district`.
4. **Drag the entire `site` folder's contents** into the upload box
   (the `functions` folder must be included — it holds the booking backend).
5. Click **Deploy**. In ~30 seconds you get a live URL like
   `wake-district.pages.dev`. Open it and test.

> Prefer auto-updates when you edit files? Instead of uploading, push the `site`
> folder to a free GitHub repo and "Connect to Git" in Cloudflare — then every
> change you save goes live automatically. Optional.

---

## 6. Switch the payment backend on

In Cloudflare → your Pages project → **Settings → Environment variables → Production**:

| Variable name | Value |
|---|---|
| `STRIPE_SECRET_KEY` | your `sk_live_...` key from step 4 |

Save, then **redeploy** (Deployments → ⋯ → Retry deployment) so it takes effect.

Now go to your live site's **Book Now** page and run a real (or test) booking all
the way through. You should land on the Stripe checkout, pay, and return to the
"You're booked in!" page. Paid bookings appear in your **Stripe Dashboard →
Payments**, each with the date, time, group size and customer details attached.

---

## 7. Turn on the contact form (optional, free)

1. Sign up at **formspree.io** (free tier).
2. Create a form; it gives you a URL like `https://formspree.io/f/abcdwxyz`.
3. Open `site/contact.html`, find `action="https://formspree.io/f/your-form-id"`
   and replace it with your URL.
4. Re-upload / redeploy. Enquiries now arrive in your inbox.

---

## 8. Get an email for every booking (optional, free)

Bookings already show in Stripe, but if you want an email alert too:

1. Sign up at **resend.com** (free tier) and verify your domain to send from
   `bookings@wakedistrict.co.uk`. Copy the API key (`re_...`).
2. In Stripe → **Developers → Webhooks → Add endpoint**:
   - URL: `https://YOUR-SITE/api/stripe-webhook`
   - Event: `checkout.session.completed`
   - Copy the **Signing secret** (`whsec_...`).
3. In Cloudflare environment variables, add:
   - `STRIPE_WEBHOOK_SECRET` = `whsec_...`
   - `RESEND_API_KEY` = `re_...`
   - `BOOKINGS_EMAIL` = `info@wakedistrict.co.uk`
   - `FROM_EMAIL` = `bookings@wakedistrict.co.uk`
4. Redeploy. You'll now get an email the moment someone books.

---

## 9. Point `wakedistrict.co.uk` at the new site

Your domain is yours regardless of leaving Wix. Two ways:

**A. Keep the domain registered where it is (simplest)**
In Cloudflare Pages → your project → **Custom domains → Set up a domain** →
enter `wakedistrict.co.uk`. Cloudflare shows you the DNS records to add. Add them
wherever your domain is currently managed (Wix or your registrar). Done.

**B. Move the domain to Cloudflare** (often cheapest renewals)
Add the domain in Cloudflare, follow the transfer steps, then attach it to Pages.

> Do this step **last**, once you're happy the new site and bookings work on the
> `.pages.dev` URL. Switching DNS is what makes the public see the new site.

**Don't cancel Wix until** the new site is live on your domain and you've taken a
test booking successfully. Then downgrade/cancel the Wix plan to stop the £35/mo.

---

## 10. Changing things later

- **Text & pages:** edit the `.html` files — they're plain text, very readable.
- **Prices:** change them in **two** places so they always match:
  `site/assets/js/booking.js` (what the customer sees) **and**
  `site/functions/api/create-checkout.js` (what they're actually charged).
- **Opening times for bookings:** `OPEN_HOUR` / `LAST_START_HOUR` near the top of
  `site/assets/js/booking.js`.
- After any edit, re-upload to Cloudflare (or just `git push` if you used the
  GitHub route).

---

## A note on double-bookings

This system takes payments and records every booking, but it does **not yet block
a slot once it's taken** (that needs a small database). For a single boat that's
usually fine to manage by eye from your Stripe dashboard / calendar. If you'd like
true live availability that greys out booked slots, that's a worthwhile next
upgrade — Cloudflare's free KV/D1 storage can do it. Just ask and I'll add it.

---

### Quick reference — file structure

```
site/
├─ index.html, about.html, experiences.html, contact.html, faqs.html
├─ book.html, booking-success.html, terms.html, privacy.html
├─ assets/
│  ├─ css/styles.css
│  ├─ js/main.js          (shared header/footer)
│  ├─ js/booking.js       (booking form + prices shown)
│  └─ img/                (your photos go here)
└─ functions/api/
   ├─ create-checkout.js  (creates the Stripe payment — needs STRIPE_SECRET_KEY)
   └─ stripe-webhook.js   (optional booking email alerts)
```

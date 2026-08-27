/* ============================================================
   Wake District — gift voucher purchase page
   Choose a session, optionally make it a gift, pay via Stripe.
   Prices here are DISPLAY ONLY — the real price is set again on
   the server in create-voucher-checkout.js. Keep them in sync.
   ============================================================ */

const EXPERIENCES = [
  { id: "1-hour",  name: "1 Hour Time Slot", duration: "1 hour",  price: 140 },
  { id: "2-hour",  name: "2 Hour Time Slot", duration: "2 hours", price: 260 },
  { id: "3-hour",  name: "3 Hour Time Slot", duration: "3 hours", price: 360, popular: true },
  { id: "half-day", name: "Half Day",        duration: "4 hours", price: 450 },
  { id: "full-day", name: "Full Day",        duration: "8 hours", price: 800 },
];

const gbp = (n) => "£" + n.toLocaleString("en-GB");
const $ = (id) => document.getElementById(id);
const state = { exp: null };

function renderExperiences() {
  $("expSelect").innerHTML = EXPERIENCES.map(
    (e) => `
    <label class="exp-option" data-id="${e.id}">
      <input type="radio" name="experience" value="${e.id}" required>
      <span class="meta">
        <strong>${e.name}${e.popular ? " ⭐" : ""}</strong>
        <small>${e.duration} on the water · the whole boat · up to 6 people</small>
      </span>
      <span class="price">${gbp(e.price)}</span>
    </label>`
  ).join("");
  document.querySelectorAll(".exp-option[data-id]").forEach((el) => {
    el.addEventListener("click", () => {
      document.querySelectorAll(".exp-option[data-id]").forEach((o) => o.classList.remove("selected"));
      el.classList.add("selected");
      el.querySelector("input").checked = true;
      state.exp = EXPERIENCES.find((x) => x.id === el.dataset.id);
      updateSummary();
    });
  });
}

function expiryLabel() {
  const d = new Date();
  d.setMonth(d.getMonth() + 12);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

function updateSummary() {
  $("sExp").textContent = state.exp ? `${state.exp.name} (${state.exp.duration})` : "—";
  const gift = $("isGift").checked;
  const rName = $("recipientName").value.trim();
  $("sFor").textContent = gift ? (rName || "A gift") : "You";
  $("sExpiry").textContent = expiryLabel();
  $("sTotal").textContent = state.exp ? gbp(state.exp.price) : "£0";
}

function syncGift() {
  const gift = $("isGift").checked;
  $("giftFields").style.display = gift ? "" : "none";
  syncDeliver();
  updateSummary();
}

function syncDeliver() {
  const toThem = $("isGift").checked && $("deliverTo").value === "recipient";
  $("recipientEmailRow").style.display = toThem ? "" : "none";
}

function showError(msg) {
  const box = $("formError");
  if (!msg) { box.classList.remove("show"); return; }
  box.textContent = msg;
  box.classList.add("show");
  box.scrollIntoView({ behavior: "smooth", block: "center" });
}

function validate() {
  if (!state.exp) return "Please choose a session for the voucher.";
  const gift = $("isGift").checked;
  if (gift && !$("recipientName").value.trim()) return "Please enter the recipient's name.";
  if (gift && $("deliverTo").value === "recipient") {
    const re = $("recipientEmail").value.trim();
    if (!/^\S+@\S+\.\S+$/.test(re)) return "Please enter a valid email for the recipient.";
  }
  if (!$("buyerName").value.trim()) return "Please enter your name.";
  if (!/^\S+@\S+\.\S+$/.test($("buyerEmail").value.trim())) return "Please enter a valid email address.";
  if (!$("agree").checked) return "Please accept the Terms & Conditions to continue.";
  return null;
}

async function handleSubmit(e) {
  e.preventDefault();
  showError(null);
  const err = validate();
  if (err) return showError(err);

  const btn = $("buyBtn");
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Redirecting to secure checkout…";

  const gift = $("isGift").checked;
  const payload = {
    experienceId: state.exp.id,
    buyerName: $("buyerName").value.trim(),
    buyerEmail: $("buyerEmail").value.trim(),
    isGift: gift,
    recipientName: gift ? $("recipientName").value.trim() : "",
    recipientEmail: gift ? $("recipientEmail").value.trim() : "",
    message: gift ? $("message").value.trim() : "",
    deliverTo: gift ? $("deliverTo").value : "buyer",
  };

  try {
    const res = await fetch("/api/create-voucher-checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok || !data.url) throw new Error(data.error || "Could not start checkout.");
    window.location.href = data.url;
  } catch (e2) {
    showError(e2.message + " If this keeps happening, please call us on 07826 551 503.");
    btn.disabled = false;
    btn.textContent = original;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  renderExperiences();
  updateSummary();
  $("isGift").addEventListener("change", syncGift);
  $("deliverTo").addEventListener("change", () => { syncDeliver(); updateSummary(); });
  $("recipientName").addEventListener("input", updateSummary);
  $("voucherForm").addEventListener("submit", handleSubmit);

  const wanted = new URLSearchParams(location.search).get("exp");
  if (wanted) {
    const el = document.querySelector(`.exp-option[data-id="${wanted}"]`);
    if (el) el.click();
  }
});

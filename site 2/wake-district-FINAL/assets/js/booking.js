/* ============================================================
   Wake District — booking page logic
   - Renders the session options
   - Keeps the live summary in sync
   - Validates, then asks the server (/api/create-checkout) to
     create a Stripe Checkout session and redirects to it.

   IMPORTANT: prices here are for DISPLAY ONLY. The real price is
   set again on the server (functions/api/create-checkout.js) so a
   visitor can never tamper with the amount they pay. If you change
   a price, change it in BOTH files.
   ============================================================ */

const EXPERIENCES = [
  { id: "1-hour",  name: "1 Hour Time Slot", duration: "1 hour",  price: 120 },
  { id: "2-hour",  name: "2 Hour Time Slot", duration: "2 hours", price: 220 },
  { id: "3-hour",  name: "3 Hour Time Slot", duration: "3 hours", price: 300, popular: true },
  { id: "half-day", name: "Half Day",        duration: "4 hours", price: 380 },
  { id: "full-day", name: "Full Day",        duration: "8 hours", price: 700 },
];

// Operating window for start times (24h). Adjust to suit the season.
const OPEN_HOUR = 8;
const LAST_START_HOUR = 18;

const gbp = (n) => "£" + n.toLocaleString("en-GB");
const $ = (id) => document.getElementById(id);

const state = { exp: null, date: "", time: "", people: "" };

/* ---- Render session options ---- */
function renderExperiences() {
  $("expSelect").innerHTML = EXPERIENCES.map(
    (e) => `
    <label class="exp-option" data-id="${e.id}">
      <input type="radio" name="experience" value="${e.id}" required>
      <span class="meta">
        <strong>${e.name}${e.popular ? " ⭐" : ""}</strong>
        <small>${e.duration} on the water · up to 6 people</small>
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

/* ---- Populate start-time options ---- */
function renderTimes() {
  const sel = $("time");
  sel.innerHTML = '<option value="">Select a time…</option>';
  for (let h = OPEN_HOUR; h <= LAST_START_HOUR; h++) {
    ["00", "30"].forEach((m) => {
      if (h === LAST_START_HOUR && m === "30") return;
      const v = `${String(h).padStart(2, "0")}:${m}`;
      sel.insertAdjacentHTML("beforeend", `<option value="${v}">${v}</option>`);
    });
  }
}

/* ---- Date constraints: no past dates, up to 12 months ahead ---- */
function setDateLimits() {
  const d = $("date");
  const today = new Date();
  const max = new Date(); max.setFullYear(max.getFullYear() + 1);
  d.min = today.toISOString().split("T")[0];
  d.max = max.toISOString().split("T")[0];
}

function prettyDate(iso) {
  if (!iso) return "—";
  return new Date(iso + "T00:00:00").toLocaleDateString("en-GB", {
    weekday: "short", day: "numeric", month: "long", year: "numeric",
  });
}

/* ---- Live summary ---- */
function updateSummary() {
  $("sExp").textContent = state.exp ? `${state.exp.name}` : "—";
  $("sDate").textContent = prettyDate(state.date);
  $("sTime").textContent = state.time || "—";
  $("sPeople").textContent = state.people ? `${state.people} ${state.people === "1" ? "person" : "people"}` : "—";
  $("sTotal").textContent = state.exp ? gbp(state.exp.price) : "£0";
}

/* ---- Validation ---- */
function validate() {
  if (!state.exp) return "Please choose a session.";
  if (!state.date) return "Please choose a date.";
  if (!state.time) return "Please choose a start time.";
  if (!state.people) return "Please tell us how many people are coming.";
  const name = $("name").value.trim();
  const email = $("email").value.trim();
  const phone = $("phone").value.trim();
  if (!name) return "Please enter your name.";
  if (!/^\S+@\S+\.\S+$/.test(email)) return "Please enter a valid email address.";
  if (phone.replace(/\D/g, "").length < 10) return "Please enter a valid mobile number.";
  if (!$("agree").checked) return "Please accept the Terms & Conditions to continue.";
  return null;
}

function showError(msg) {
  const box = $("formError");
  if (!msg) { box.classList.remove("show"); return; }
  box.textContent = msg;
  box.classList.add("show");
  box.scrollIntoView({ behavior: "smooth", block: "center" });
}

/* ---- Submit -> create Stripe Checkout session -> redirect ---- */
async function handleSubmit(e) {
  e.preventDefault();
  showError(null);
  const err = validate();
  if (err) return showError(err);

  const btn = $("payBtn");
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Redirecting to secure checkout…";

  const payload = {
    experienceId: state.exp.id,
    date: state.date,
    time: state.time,
    people: state.people,
    name: $("name").value.trim(),
    email: $("email").value.trim(),
    phone: $("phone").value.trim(),
    notes: $("notes").value.trim(),
  };

  try {
    const res = await fetch("/api/create-checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok || !data.url) throw new Error(data.error || "Could not start checkout.");
    window.location.href = data.url; // Stripe-hosted checkout
  } catch (e2) {
    showError(
      e2.message +
        " If this keeps happening, please call us on 07826 551 503 and we'll book you in directly."
    );
    btn.disabled = false;
    btn.textContent = original;
  }
}

/* ---- Wire up ---- */
document.addEventListener("DOMContentLoaded", () => {
  renderExperiences();
  renderTimes();
  setDateLimits();

  $("date").addEventListener("change", (e) => { state.date = e.target.value; updateSummary(); });
  $("time").addEventListener("change", (e) => { state.time = e.target.value; updateSummary(); });
  $("people").addEventListener("change", (e) => { state.people = e.target.value; updateSummary(); });
  $("bookingForm").addEventListener("submit", handleSubmit);

  // Deep link e.g. book.html?exp=3-hour preselects a session
  const wanted = new URLSearchParams(location.search).get("exp");
  if (wanted) {
    const el = document.querySelector(`.exp-option[data-id="${wanted}"]`);
    if (el) el.click();
  }
});

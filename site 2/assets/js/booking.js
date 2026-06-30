/* ============================================================
   Wake District — booking page logic + availability calendar
   - Renders the session options
   - Month calendar showing Closed (holiday) and partly-booked days
   - Selecting a day offers only the start times still free
   - Pick-up location + group + customer details
   - Validates, then asks /api/create-checkout to make a Stripe
     Checkout session and redirects to it.

   Availability comes from /api/availability:
     { blocked: ["YYYY-MM-DD"], booked: { "YYYY-MM-DD": ["10:00","10:30",...] } }
   where "booked" lists the 30-minute start slots already taken.

   PRICES here are for DISPLAY ONLY — the real price is set again on
   the server. If you change a price, change it in BOTH files.
   ============================================================ */

const EXPERIENCES = [
  { id: "1-hour",  name: "1 Hour Time Slot", duration: "1 hour",  price: 120 },
  { id: "2-hour",  name: "2 Hour Time Slot", duration: "2 hours", price: 220 },
  { id: "3-hour",  name: "3 Hour Time Slot", duration: "3 hours", price: 300, popular: true },
  { id: "half-day", name: "Half Day",        duration: "4 hours", price: 380 },
  { id: "full-day", name: "Full Day",        duration: "8 hours", price: 700 },
];

const SWAN_LAKESIDE_ONLY = ["half-day", "full-day"];
const OPEN_HOUR = 8;
const LAST_START_HOUR = 18;
const MONTHS_AHEAD = 12;
const LEAD_MINUTES = 60; // bookings must be at least this far ahead (gives us time to get to you)

const gbp = (n) => "£" + n.toLocaleString("en-GB");
const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, "0");
const isoOf = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;

const state = { exp: null, date: "", time: "", location: "", people: "" };
let BLOCKED = new Set();         // holiday / closed dates "YYYY-MM-DD"
let BOOKED = {};                 // { "YYYY-MM-DD": Set("HH:MM" occupied start slots) }
let BOOKINGS = {};               // { "YYYY-MM-DD": [ {time, hours, experience} ] } for display

const today = new Date(); today.setHours(0, 0, 0, 0);
const todayISO = isoOf(today.getFullYear(), today.getMonth(), today.getDate());
const maxDate = new Date(today); maxDate.setMonth(maxDate.getMonth() + MONTHS_AHEAD);
let view = { y: today.getFullYear(), m: today.getMonth() }; // month being shown

/* ---- Sessions ---- */
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

/* ---- Load availability (holidays + booked slots) ---- */
async function loadAvailability() {
  try {
    const res = await fetch("/api/availability");
    if (!res.ok) return;
    const data = await res.json();
    if (Array.isArray(data.blocked)) BLOCKED = new Set(data.blocked);
    if (data.booked && typeof data.booked === "object") {
      BOOKED = {};
      for (const [d, slots] of Object.entries(data.booked)) BOOKED[d] = new Set(slots);
    }
    if (data.bookings && typeof data.bookings === "object") BOOKINGS = data.bookings;
  } catch {
    /* If the endpoint isn't set up yet, everything just shows as available. */
  }
  renderCalendar();
}

/* ---- Calendar ---- */
const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function dayStatus(iso) {
  if (iso < todayISO) return "past";
  if (BLOCKED.has(iso)) return "closed";
  if (BOOKED[iso] && BOOKED[iso].size) return "booked";
  return "available";
}

function renderCalendar() {
  const { y, m } = view;
  const first = new Date(y, m, 1);
  const lead = (first.getDay() + 6) % 7; // Monday-first
  const days = new Date(y, m + 1, 0).getDate();
  const monthName = first.toLocaleDateString("en-GB", { month: "long", year: "numeric" });

  const atMin = y === today.getFullYear() && m === today.getMonth();
  const atMax = y === maxDate.getFullYear() && m === maxDate.getMonth();

  let cells = "";
  DOW.forEach((d) => (cells += `<div class="cal-dow">${d}</div>`));
  for (let i = 0; i < lead; i++) cells += `<div class="cal-day is-empty"></div>`;

  for (let d = 1; d <= days; d++) {
    const iso = isoOf(y, m, d);
    const st = dayStatus(iso);
    const cls = ["cal-day"];
    if (st === "past") cls.push("is-disabled");
    else if (st === "closed") cls.push("is-closed");
    else if (st === "booked") cls.push("is-booked");
    const selectable = st === "available" || st === "booked";
    if (!selectable && st !== "closed") cls.push("is-disabled");
    if (iso === state.date) cls.push("is-selected");
    const attr = selectable ? `data-iso="${iso}"` : "";
    cells += `<div class="${cls.join(" ")}" ${attr}>${d}</div>`;
  }

  $("calendar").innerHTML = `
    <div class="cal-head">
      <button type="button" class="cal-nav" id="calPrev" ${atMin ? "disabled" : ""} aria-label="Previous month">‹</button>
      <div class="cal-title">${monthName}</div>
      <button type="button" class="cal-nav" id="calNext" ${atMax ? "disabled" : ""} aria-label="Next month">›</button>
    </div>
    <div class="cal-grid">${cells}</div>`;

  $("calPrev").addEventListener("click", () => { shiftMonth(-1); });
  $("calNext").addEventListener("click", () => { shiftMonth(1); });
  document.querySelectorAll(".cal-day[data-iso]").forEach((el) =>
    el.addEventListener("click", () => selectDate(el.dataset.iso))
  );
}

function shiftMonth(delta) {
  let m = view.m + delta, y = view.y;
  if (m < 0) { m = 11; y--; }
  if (m > 11) { m = 0; y++; }
  view = { y, m };
  renderCalendar();
}

function prettyDate(iso) {
  return new Date(iso + "T00:00:00").toLocaleDateString("en-GB", {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
  });
}

function selectDate(iso) {
  state.date = iso;
  state.time = "";
  $("selectedDate").textContent = "Selected: " + prettyDate(iso);
  $("selectedDate").classList.remove("empty");
  renderTimes(iso);
  renderDayBookings(iso);
  renderCalendar();
  updateSummary();
}

/* ---- Add hours to a HH:MM time -> HH:MM ---- */
function addTime(time, hours) {
  const [h, m] = time.split(":").map(Number);
  const t = h * 60 + m + Math.round(hours * 60);
  return `${String(Math.floor(t / 60) % 24).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

/* ---- Show the existing bookings for the chosen day (no personal data) ---- */
function renderDayBookings(iso) {
  const el = $("dayBookings");
  const list = BOOKINGS[iso] || [];
  if (!list.length) {
    el.innerHTML = '<p class="db-empty">No bookings yet on this day — all start times are available.</p>';
    return;
  }
  el.innerHTML =
    '<p class="db-title">Already booked on this day:</p><ul class="db-list">' +
    list
      .map(
        (b) =>
          `<li><span class="db-time">${b.time}–${addTime(b.time, b.hours)}</span><span class="db-exp">${b.experience}</span></li>`
      )
      .join("") +
    "</ul>";
}

/* ---- Start times for the chosen day (minus what's taken) ---- */
function renderTimes(iso) {
  const sel = $("time");
  const taken = BOOKED[iso] || new Set();
  const nowMins = new Date().getHours() * 60 + new Date().getMinutes();
  const isToday = iso === todayISO;

  const opts = [];
  for (let h = OPEN_HOUR; h <= LAST_START_HOUR; h++) {
    for (const mm of ["00", "30"]) {
      if (h === LAST_START_HOUR && mm === "30") continue;
      const v = `${pad(h)}:${mm}`;
      if (taken.has(v)) continue;                       // already booked
      if (isToday && h * 60 + Number(mm) < nowMins + LEAD_MINUTES) continue; // need 1 hour's notice
      opts.push(v);
    }
  }

  if (!opts.length) {
    sel.innerHTML = '<option value="">No times left on this day</option>';
    sel.disabled = true;
    $("timeHint").textContent = "That day is fully booked — please choose another date.";
    return;
  }
  sel.disabled = false;
  sel.innerHTML =
    '<option value="">Select a time…</option>' +
    opts.map((v) => `<option value="${v}">${v}</option>`).join("");
  $("timeHint").textContent = "Times already booked, or less than an hour away, won't appear here.";
}

/* ---- Live summary ---- */
function updateSummary() {
  $("sExp").textContent = state.exp ? state.exp.name : "—";
  $("sDate").textContent = state.date ? prettyDate(state.date) : "—";
  $("sTime").textContent = state.time || "—";
  $("sLoc").textContent = state.location || "—";
  $("sPeople").textContent = state.people ? `${state.people} ${state.people === "1" ? "person" : "people"}` : "—";
  $("sTotal").textContent = state.exp ? gbp(state.exp.price) : "£0";
}

/* ---- Validation ---- */
function validate() {
  if (!state.exp) return "Please choose a session.";
  if (!state.date) return "Please choose a date from the calendar.";
  if (BLOCKED.has(state.date)) return "Sorry, we're closed on that date — please pick another day.";
  if (!state.time) return "Please choose a start time.";
  if (BOOKED[state.date] && BOOKED[state.date].has(state.time)) return "Sorry, that start time has just been taken — please choose another.";
  if (!state.location) return "Please choose a pick-up location.";
  if (SWAN_LAKESIDE_ONLY.includes(state.exp.id) && state.location === "Fell Foot")
    return "Half-day and full-day sessions run from The Swan Hotel & Spa / Lakeside only. Please choose one of those pick-up points.";
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

/* ---- Submit -> Stripe Checkout ---- */
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
    location: state.location,
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
    window.location.href = data.url;
  } catch (e2) {
    showError(e2.message + " If this keeps happening, please call us on 07826 551 503 and we'll book you in directly.");
    btn.disabled = false;
    btn.textContent = original;
  }
}

/* ---- Wire up ---- */
document.addEventListener("DOMContentLoaded", () => {
  renderExperiences();
  renderCalendar();
  loadAvailability();

  $("time").addEventListener("change", (e) => { state.time = e.target.value; updateSummary(); });
  $("location").addEventListener("change", (e) => { state.location = e.target.value; updateSummary(); });
  $("people").addEventListener("change", (e) => { state.people = e.target.value; updateSummary(); });
  $("bookingForm").addEventListener("submit", handleSubmit);

  const wanted = new URLSearchParams(location.search).get("exp");
  if (wanted) {
    const el = document.querySelector(`.exp-option[data-id="${wanted}"]`);
    if (el) el.click();
  }
});

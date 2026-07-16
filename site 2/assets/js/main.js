/* ============================================================
   Wake District — shared header/footer + nav behaviour
   Header & footer are injected so you only edit them once here.
   ============================================================ */

const NAV = [
  { href: "index.html", label: "Home" },
  { href: "about.html", label: "About" },
  { href: "experiences.html", label: "Experiences" },
  { href: "contact.html", label: "Contact" },
  { href: "faqs.html", label: "FAQs" },
];

// If you add your logo file at assets/img/logo-horizontal.png it will be used
// automatically; until then a clean text logo shows instead.
const LOGO_SRC = "assets/img/logo-horizontal.png";

// Cloudflare Web Analytics (free): paste the token from your Cloudflare
// dashboard (Web Analytics → your site → the value after "token":) between
// the quotes below. Leave blank to disable. See MONITORING-APP-SETUP.md.
const CF_ANALYTICS_TOKEN = "";
function loadCloudflareAnalytics() {
  if (!CF_ANALYTICS_TOKEN) return;
  const s = document.createElement("script");
  s.defer = true;
  s.src = "https://static.cloudflareinsights.com/beacon.min.js";
  s.setAttribute("data-cf-beacon", JSON.stringify({ token: CF_ANALYTICS_TOKEN }));
  document.head.appendChild(s);
}

function brandMarkup() {
  return `
    <a class="brand" href="index.html" aria-label="Wake District — Water & Wake Sports, Teaching, Groups">
      <img class="brand-mark-img" src="assets/img/logo-mark.png" alt="" onerror="this.style.display='none';">
      <span class="brand-word">
        <span class="brand-name">WAKE DISTRICT</span>
        <span class="brand-tag">Water &amp; Wake Sports <span class="sep">|</span> Teaching <span class="sep">|</span> Groups</span>
      </span>
    </a>`;
}

function buildHeader() {
  const active = document.body.dataset.page || "";
  const links = NAV.map(
    (n) => `<li><a href="${n.href}" class="${active === n.label.toLowerCase() ? "active" : ""}">${n.label}</a></li>`
  ).join("");

  const header = document.createElement("header");
  header.className = "site-header";
  header.innerHTML = `
    <div class="container">
      <nav class="nav" id="nav">
        ${brandMarkup()}
        <ul class="nav-links">${links}</ul>
        <div class="nav-cta">
          <a href="book.html" class="btn btn--primary">Book Now</a>
          <button class="nav-toggle" id="navToggle" aria-label="Menu" aria-expanded="false">
            <span></span><span></span><span></span>
          </button>
        </div>
      </nav>
    </div>`;
  document.body.prepend(header);

  const toggle = header.querySelector("#navToggle");
  const nav = header.querySelector("#nav");
  toggle.addEventListener("click", () => {
    const open = nav.classList.toggle("open");
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
  });
}

function buildFooter() {
  const footer = document.createElement("footer");
  footer.className = "site-footer";
  footer.innerHTML = `
    <div class="container">
      <div class="footer-grid">
        <div class="footer-brand">
          <img class="footer-logo" src="assets/img/logo-white.png" alt="Wake District" onerror="this.style.display='none';this.nextElementSibling.style.display='inline-flex';">
          <span class="brand-fallback" style="display:none"><span class="brand-mark">WD</span> WAKE DISTRICT</span>
          <p>Family-run watersports on Lake Windermere. Wakeboarding, wakesurfing, wake foiling, kneeboarding, groups &amp; parties.</p>
          <div class="footer-social">
            <a href="https://www.instagram.com/wakedistrict_/" target="_blank" rel="noopener" aria-label="Wake District on Instagram"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1" fill="currentColor" stroke="none"/></svg> Instagram</a>
            <a href="https://www.tripadvisor.co.uk/Attraction_Review-g1539401-d34108609-Reviews-Wake_District-Lakeside_Lake_District_Cumbria_England.html" target="_blank" rel="noopener" aria-label="Wake District on Tripadvisor"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 2l2.9 6.3 6.9.6-5.2 4.6 1.6 6.8L12 17.3 5.8 20.9l1.6-6.8L2.2 8.9l6.9-.6z"/></svg> Tripadvisor</a>
          </div>
        </div>
        <div>
          <h4>Explore</h4>
          <ul class="footer-list">
            ${NAV.map((n) => `<li><a href="${n.href}">${n.label}</a></li>`).join("")}
            <li><a href="book.html">Book Now</a></li>
          </ul>
        </div>
        <div>
          <h4>Get in touch</h4>
          <ul class="footer-list">
            <li><a href="mailto:info@wakedistrict.co.uk">info@wakedistrict.co.uk</a></li>
            <li><a href="tel:07826551503">07826 551 503</a></li>
            <li><a href="tel:07758892222">07758 892222</a></li>
            <li style="margin-top:10px;color:#8fb6c2">Pick-up points:
              <ul style="list-style:disc;margin:6px 0 0 18px;padding:0">
                <li style="margin:2px 0">The Swan Hotel &amp; Spa, Newby Bridge</li>
                <li style="margin:2px 0">Fell Foot</li>
                <li style="margin:2px 0">Lakeside Hotel &amp; Spa</li>
              </ul>
            </li>
          </ul>
        </div>
      </div>
      <div class="footer-bottom">
        <span>&copy; ${new Date().getFullYear()} Wake District. All rights reserved.</span>
        <span><a href="terms.html">Terms &amp; Conditions</a> &nbsp;·&nbsp; <a href="privacy.html">Privacy Policy</a></span>
      </div>
    </div>`;
  document.body.appendChild(footer);
}

// Rotating reviews carousel (only runs on pages that have it)
function initReviews() {
  const wrap = document.getElementById("reviews");
  if (!wrap) return;
  const slides = [...wrap.querySelectorAll(".rev-slide")];
  const dotsWrap = document.getElementById("revDots");
  const prev = document.getElementById("revPrev");
  const next = document.getElementById("revNext");
  if (slides.length <= 1) {
    if (prev) prev.style.display = "none";
    if (next) next.style.display = "none";
    return;
  }
  let i = 0, timer;
  const dots = slides.map((_, idx) => {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("aria-label", "Go to review " + (idx + 1));
    b.addEventListener("click", () => { go(idx); restart(); });
    dotsWrap.appendChild(b);
    return b;
  });
  function go(n) {
    i = (n + slides.length) % slides.length;
    slides.forEach((s, idx) => s.classList.toggle("is-active", idx === i));
    dots.forEach((d, idx) => d.classList.toggle("is-active", idx === i));
  }
  function restart() { clearInterval(timer); timer = setInterval(() => go(i + 1), 6000); }
  if (prev) prev.addEventListener("click", () => { go(i - 1); restart(); });
  if (next) next.addEventListener("click", () => { go(i + 1); restart(); });
  go(0); restart();
}

// Quietly tell the site when a page is opened, so the owner's phone can
// be pinged (see functions/api/notify-visit.js). Fails silently and never
// blocks the page.
function trackVisit() {
  try {
    let vid = localStorage.getItem("wd_vid");
    if (!vid) {
      vid = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
      localStorage.setItem("wd_vid", vid);
    }
    fetch("/api/notify-visit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      keepalive: true,
      body: JSON.stringify({ vid, path: location.pathname }),
    }).catch(() => {});
  } catch (e) { /* ignore */ }
}

document.addEventListener("DOMContentLoaded", () => {
  buildHeader();
  buildFooter();
  initReviews();
  trackVisit();
  loadCloudflareAnalytics();
});

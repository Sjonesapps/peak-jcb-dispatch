/* Peak JCB Dispatch — command interface
   API contract, auth and storage behaviour are unchanged from v1. */

const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));

const API = "/.netlify/functions/api/";
const TOKEN_KEY = "peakToken";

let token = localStorage.getItem(TOKEN_KEY);
let isSignup = false;
let trips = [];
let filter = "all";
let noticeTimer = null;

/* ---------- api ---------- */
function api(path, options = {}) {
  options.headers = {
    "content-type": "application/json",
    ...(token ? { authorization: "Bearer " + token } : {}),
    ...(options.headers || {})
  };
  return fetch(API + path, options).then(async r => {
    const b = await r.json().catch(() => ({}));
    if (!r.ok) throw Error(b.error || "Request failed");
    return b;
  });
}

/* ---------- helpers ---------- */
const esc = (s = "") => String(s).replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const today = () => new Date().toISOString().slice(0, 10);
const slug = s => String(s || "").toLowerCase();

function setLoading(btn, on) {
  if (!btn) return;
  btn.classList.toggle("loading", on);
  btn.disabled = on;
}

function notice(text, bad = false) {
  const el = $("#notice");
  el.textContent = text;
  el.classList.toggle("bad", bad);
  el.classList.toggle("hidden", !text);
  clearTimeout(noticeTimer);
  if (text) noticeTimer = setTimeout(() => el.classList.add("hidden"), 3800);
}

/* ---------- session clock ---------- */
function tickClock() {
  const now = new Date();
  const t = $("#clockTime"), d = $("#clockDate");
  if (t) t.textContent = now.toLocaleTimeString("en-US", { hour12: false });
  if (d) d.textContent = now.toLocaleDateString("en-US", { month: "short", day: "2-digit" }).toUpperCase();
}
setInterval(tickClock, 1000);
tickClock();

/* ---------- auth view ---------- */
function showApp() {
  $("#auth").classList.toggle("hidden", !!token);
  $("#app").classList.toggle("hidden", !token);
  $("#logout").classList.toggle("hidden", !token);
  $("#userchip").classList.toggle("hidden", !token);
  if (token) {
    requestAnimationFrame(moveGlider);
    skeletons();
    api("me")
      .then(b => setUser(b.email))
      .catch(() => {});
    loadTrips();
  }
}

function setUser(email) {
  $("#userEmail").textContent = email || "";
  $("#userInitial").textContent = (email || "·").trim().charAt(0) || "·";
}

$("#toggleAuth").onclick = () => {
  isSignup = !isSignup;
  $("#authTitle").textContent = isSignup ? "Request access" : "Dispatch sign-in";
  $("#authSubmit").querySelector(".btn-label").textContent = isSignup ? "Create account" : "Sign in";
  $("#toggleAuth").textContent = isSignup ? "Already have an account? Sign in" : "Need an account? Create one";
  $("#password").setAttribute("autocomplete", isSignup ? "new-password" : "current-password");
  $("#authMsg").textContent = "";
};

$("#authForm").onsubmit = async e => {
  e.preventDefault();
  const btn = $("#authSubmit");
  $("#authMsg").textContent = "";
  setLoading(btn, true);
  try {
    const b = await api("auth/" + (isSignup ? "signup" : "login"), {
      method: "POST",
      body: JSON.stringify({ email: $("#email").value, password: $("#password").value })
    });
    token = b.token;
    localStorage.setItem(TOKEN_KEY, token);
    setUser(b.email);
    $("#password").value = "";
    showApp();
  } catch (x) {
    $("#authMsg").textContent = x.message;
  } finally {
    setLoading(btn, false);
  }
};

$("#logout").onclick = () => {
  token = null;
  localStorage.removeItem(TOKEN_KEY);
  setUser("");
  showApp();
};

/* ---------- data ---------- */
function skeletons(n = 3) {
  $("#tripList").innerHTML = Array.from({ length: n }, () => '<div class="skeleton"></div>').join("");
}

async function loadTrips(quiet = true) {
  try {
    trips = (await api("trips")).trips;
    render();
  } catch (e) {
    if (/Authentication/i.test(e.message)) $("#logout").click();
    else if (!quiet) notice(e.message, true);
    else { trips = []; render(); notice(e.message, true); }
  }
}

$("#refresh").onclick = async e => {
  const btn = e.currentTarget;
  btn.classList.add("spin");
  setTimeout(() => btn.classList.remove("spin"), 700);
  await loadTrips(false);
  notice("Board refreshed.");
};

/* ---------- stats ---------- */
function countUp(el, target) {
  const from = Number(el.dataset.v || 0);
  if (from === target) { el.textContent = target; return; }
  el.dataset.v = target;
  const dur = 550, start = performance.now();
  const step = now => {
    const p = Math.min(1, (now - start) / dur);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = Math.round(from + (target - from) * eased);
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function renderStats() {
  const t = today();
  countUp($("#statTotal"), trips.length);
  countUp($("#statUpcoming"), trips.filter(x => x.date >= t).length);
  countUp($("#statActive"), trips.filter(x => x.status === "In progress").length);
  countUp($("#statComplete"), trips.filter(x => x.status === "Complete").length);
}

/* ---------- board ---------- */
const ICON_EQUIP = '<svg viewBox="0 0 24 24"><path d="M3 18h13M5 18v-4h6l2-5h4l2 5h2v4"/><circle cx="7" cy="20" r="2"/><circle cx="18" cy="20" r="2"/></svg>';
const ICON_DRIVER = '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="3.4"/><path d="M5 20a7 7 0 0 1 14 0"/></svg>';
const ICON_EMPTY = '<svg viewBox="0 0 24 24"><path d="M3 7h11v7H3zM14 10h4l3 4v0h-7z"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/></svg>';

function dateParts(iso) {
  const d = new Date(iso + "T12:00");
  if (isNaN(d)) return { dow: "", day: iso || "", year: "" };
  return {
    dow: d.toLocaleDateString("en-US", { weekday: "short" }).toUpperCase(),
    day: d.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
    year: d.getFullYear()
  };
}

function tripCard(t, i) {
  const d = dateParts(t.date);
  const status = slug(t.status);
  return `
  <article class="trip" data-status="${esc(status)}" style="animation-delay:${Math.min(i * 45, 360)}ms">
    <div class="trip-date">
      <span class="trip-dow">${esc(d.dow)}</span>
      <span class="trip-day">${esc(d.day)}</span>
      <span class="trip-year">${esc(d.year)}</span>
    </div>
    <div>
      <div class="trip-customer">${esc(t.customer)}</div>
      <div class="route">
        <div class="route-row from"><span class="route-node"></span><span class="route-tag">FROM</span><span class="route-val">${esc(t.pickup)}</span></div>
        <div class="route-row to"><span class="route-node"></span><span class="route-tag">TO</span><span class="route-val">${esc(t.delivery)}</span></div>
      </div>
    </div>
    <div class="meta">
      <div class="meta-row">${ICON_EQUIP}<span>${esc(t.equipment || "Equipment TBD")}</span></div>
      <div class="meta-row">${ICON_DRIVER}<span>${esc(t.driver || "Driver TBD")}</span></div>
    </div>
    <span class="badge ${esc(status.replace(/\s+/g, "-"))}"><span class="led"></span>${esc(t.status)}</span>
    <div class="trip-actions">
      <button class="edit" type="button" data-edit="${esc(t.id)}">Edit</button>
      <button class="del" type="button" data-del="${esc(t.id)}">Delete</button>
    </div>
    ${t.notes ? `<p class="trip-notes"><b>Notes</b>${esc(t.notes)}</p>` : ""}
  </article>`;
}

function render() {
  const t = today();
  const list = trips.filter(x =>
    filter === "all" ||
    (filter === "upcoming" && x.date >= t) ||
    (filter === "past" && x.date < t));

  $("#tripList").innerHTML = list.length
    ? list.map(tripCard).join("")
    : `<div class="empty">
         <div class="empty-ico">${ICON_EMPTY}</div>
         <strong>No hauls in this view</strong>
         <p>Log a haul to put it on the shared dispatch board.</p>
       </div>`;
  renderStats();
}

/* ---------- filters ---------- */
function moveGlider() {
  const active = $(".filter.active"), glider = $("#filterGlider");
  if (!active || !glider) return;
  glider.style.width = active.offsetWidth + "px";
  glider.style.transform = `translateX(${active.offsetLeft - 5}px)`;
}

$$(".filter").forEach(b => {
  b.onclick = () => {
    filter = b.dataset.filter;
    $$(".filter").forEach(x => {
      const on = x === b;
      x.classList.toggle("active", on);
      x.setAttribute("aria-selected", String(on));
    });
    moveGlider();
    render();
  };
});
window.addEventListener("resize", moveGlider);

/* ---------- editor ---------- */
const FIELDS = ["date", "customer", "pickup", "delivery", "equipment", "driver", "status", "notes"];
const inputId = k => (k === "date" ? "tripDate" : k);

function openEditor(t = {}) {
  $("#editor").classList.remove("hidden");
  $("#editorTitle").textContent = t.id ? "Edit haul" : "New haul";
  $("#tripId").value = t.id || "";
  FIELDS.forEach(k => { $("#" + inputId(k)).value = t[k] || (k === "status" ? "Scheduled" : ""); });
  $("#tripDate").value = t.date || today();
  $("#editor").scrollIntoView({ behavior: "smooth", block: "nearest" });
  setTimeout(() => $("#customer").focus({ preventScroll: true }), 320);
}

$("#newTrip").onclick = () => openEditor();
$("#cancelEdit").onclick = () => $("#editor").classList.add("hidden");

$("#tripForm").onsubmit = async e => {
  e.preventDefault();
  const btn = e.target.querySelector('button[type=submit]');
  const id = $("#tripId").value;
  const data = Object.fromEntries(FIELDS.map(k => [k, $("#" + inputId(k)).value]));
  setLoading(btn, true);
  try {
    await api(id ? "trips/" + id : "trips", {
      method: id ? "PUT" : "POST",
      body: JSON.stringify(data)
    });
    $("#editor").classList.add("hidden");
    notice(id ? "Haul updated." : "Haul added to the board.");
    await loadTrips(false);
  } catch (x) {
    notice(x.message, true);
  } finally {
    setLoading(btn, false);
  }
};

/* ---------- row actions (delegated) ---------- */
$("#tripList").addEventListener("click", async e => {
  const editBtn = e.target.closest("[data-edit]");
  if (editBtn) return openEditor(trips.find(t => t.id === editBtn.dataset.edit));

  const delBtn = e.target.closest("[data-del]");
  if (!delBtn) return;
  const id = delBtn.dataset.del;
  const t = trips.find(x => x.id === id);
  if (!confirm(`Delete the haul for ${t ? t.customer : "this record"}?`)) return;
  const card = delBtn.closest(".trip");
  try {
    await api("trips/" + id, { method: "DELETE" });
    if (card) { card.classList.add("removing"); await new Promise(r => setTimeout(r, 300)); }
    notice("Haul deleted.");
    await loadTrips(false);
  } catch (x) {
    if (card) card.classList.remove("removing");
    notice(x.message, true);
  }
});

/* legacy global hooks kept for compatibility */
window.editTrip = id => openEditor(trips.find(t => t.id === id));
window.deleteTrip = id => document.querySelector(`[data-del="${id}"]`)?.click();

/* ---------- boot ---------- */
showApp();
moveGlider();
window.addEventListener("load", moveGlider);

/* Peak JCB Dispatch — command interface
   Auth, storage and the API contract are unchanged; the schema gained
   start/end times and an optional return date for multi-day hauls, and then a
   rate card plus per-haul route distance and pricing.

   Loaded as an ES module so the quote maths can be imported from the same file
   the API uses — the editor preview and the stored quote cannot disagree. */

import { computeQuote, cleanSettings, DEFAULT_SETTINGS, isConfigured, fmtMoney, fmtMiles } from "/quote-model.mjs";

const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));

const API = "/.netlify/functions/api/";
const TOKEN_KEY = "peakToken";

/* The yard works a 06:00–18:00 day; free-slot maths stays inside it. */
const DAY_OPEN = "06:00";
const DAY_CLOSE = "18:00";
const SLOT_STEP = 15;

let token = localStorage.getItem(TOKEN_KEY);
let isSignup = false;
let trips = [];
let filter = "calendar";
let calCursor = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let selectedDay = null;    // ISO date string
let noticeTimer = null;
let settings = { ...DEFAULT_SETTINGS };
let canEditSettings = true;
let settingsRestricted = false;
let routeConfigured = false;  // live route lookup available server-side?
let routeProvider = { id: null, label: "route provider", limitations: "" };

/* ---------- api ---------- */
function api(path, options = {}) {
  options.headers = {
    "content-type": "application/json",
    ...(token ? { authorization: "Bearer " + token } : {}),
    ...(options.headers || {})
  };
  return fetch(API + path, options).then(async r => {
    const b = await r.json().catch(() => ({}));
    if (!r.ok) { const e = Error(b.error || "Request failed"); e.conflict = b.conflict; throw e; }
    return b;
  });
}

/* ---------- helpers ---------- */
const esc = (s = "") => String(s).replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const pad = n => String(n).padStart(2, "0");
const isoOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => isoOf(new Date());
const slug = s => String(s || "").toLowerCase();

/* Every stored date/time is naive dealership-local, so it is read back into a
   local Date with no zone conversion anywhere. */
function toDate(dateISO, time = "00:00") {
  const [y, m, d] = String(dateISO).split("-").map(Number);
  const [hh, mm] = String(time).split(":").map(Number);
  return new Date(y, (m || 1) - 1, d || 1, hh || 0, mm || 0);
}
const startAt = t => toDate(t.date, t.start);
const endAt = t => toDate(t.endDate || t.date, t.end);
const overlaps = (a, b) => startAt(a) < endAt(b) && startAt(b) < endAt(a);
const durMin = t => Math.max(0, Math.round((endAt(t) - startAt(t)) / 60000));

const addMin = (d, m) => new Date(d.getTime() + m * 60000);
const minutesOf = hhmm => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
const hhmmOf = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

function fmtTime(hhmm) {
  if (!/^\d{2}:\d{2}$/.test(hhmm || "")) return "";
  let [h, m] = hhmm.split(":").map(Number);
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${pad(m)} ${ap}`;
}

function fmtDur(mins) {
  const h = Math.floor(mins / 60), m = mins % 60;
  return h && m ? `${h}h ${m}m` : h ? `${h}h` : `${m}m`;
}

function fmtDayLong(iso) {
  return toDate(iso).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
}

/* Time-aware relative label — this is what makes past vs future obvious. */
function relLabel(t) {
  const now = new Date(), s = startAt(t), e = endAt(t);
  if (now >= s && now < e) return { text: "On the road now", tone: "live" };
  const diff = (s - now) / 60000;
  if (diff > 0) {
    if (diff < 60) return { text: `Departs in ${Math.round(diff)}m`, tone: "soon" };
    if (diff < 1440) return { text: `Departs in ${Math.round(diff / 60)}h`, tone: "soon" };
    const d = Math.round(diff / 1440);
    return { text: `Departs in ${d} day${d === 1 ? "" : "s"}`, tone: "future" };
  }
  const ago = (now - e) / 60000;
  if (ago < 60) return { text: `Finished ${Math.max(1, Math.round(ago))}m ago`, tone: "past" };
  if (ago < 1440) return { text: `Finished ${Math.round(ago / 60)}h ago`, tone: "past" };
  const d = Math.round(ago / 1440);
  return { text: `Finished ${d} day${d === 1 ? "" : "s"} ago`, tone: "past" };
}

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
  if (text) noticeTimer = setTimeout(() => el.classList.add("hidden"), 5200);
}

/* ---------- google maps links ----------
   These are plain URLs into the consumer Maps site. They carry no API key, cost
   nothing, and work for free-text place names as readily as postal addresses,
   so every haul gets a working map link whether or not route lookup is wired
   up. */
const mapSearchUrl = q => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
const mapDirUrl = (from, to) =>
  `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(from)}&destination=${encodeURIComponent(to)}&travelmode=driving`;

const distanceSource = source => {
  if (source === "osm-osrm") return { name: "OpenStreetMap + OSRM", tag: "osm/osrm" };
  if (source === "maps") return { name: "Google Routes (legacy)", tag: "google" };
  return { name: "Distance entered by hand", tag: "manual" };
};

/* ---------- rate card ---------- */
async function loadSettings() {
  try {
    const b = await api("settings");
    settings = { ...DEFAULT_SETTINGS, ...b.settings };
    canEditSettings = b.canEdit !== false;
    settingsRestricted = !!b.restricted;
  } catch {
    /* A missing rate card must never take the board down — quoting simply stays
       switched off until it loads. */
    settings = { ...DEFAULT_SETTINGS };
  }
}

async function loadConfig() {
  try {
    const b = await api("config");
    /* Accept the older Google-shaped response during a rolling upgrade. */
    const route = b.route || b.maps || {};
    routeConfigured = !!route.configured;
    routeProvider = {
      id: route.provider || null,
      label: route.label || (route.provider === "google-routes" ? "Google Routes" : "route provider"),
      limitations: route.limitations || ""
    };
  } catch {
    routeConfigured = false;
    routeProvider = { id: null, label: "route provider", limitations: "" };
  }
}

/* live rate card straight off the settings form, for the inline preview */
const formSettings = () => cleanSettings({
  baseCost: $("#setBaseCost").value,
  costPerMile: $("#setCostPerMile").value,
  operatingCostPerMile: $("#setOperatingCostPerMile").value,
  marginMode: $("#setMarginMode").value,
  marginPercent: $("#setMarginPercent").value,
  marginFixed: $("#setMarginFixed").value,
  minimumCharge: $("#setMinimumCharge").value,
  roundTripDefault: $("#setRoundTripDefault").checked
}, settings);

function fillSettingsForm() {
  $("#setBaseCost").value = settings.baseCost || "";
  $("#setCostPerMile").value = settings.costPerMile || "";
  $("#setOperatingCostPerMile").value = settings.operatingCostPerMile || "";
  $("#setMarginMode").value = settings.marginMode || "percent";
  $("#setMarginPercent").value = settings.marginPercent || "";
  $("#setMarginFixed").value = settings.marginFixed || "";
  $("#setMinimumCharge").value = settings.minimumCharge || "";
  $("#setRoundTripDefault").checked = !!settings.roundTripDefault;

  const lock = $("#settingsLock");
  $$("#settingsForm input, #settingsForm select, #settingsForm button").forEach(el => { el.disabled = !canEditSettings; });
  if (!canEditSettings) {
    lock.className = "settings-lock bad";
    lock.innerHTML = `<b>Read-only</b> Your account is not on the pricing admin list, so you can see the rate card but not change it.`;
  } else if (!settingsRestricted) {
    lock.className = "settings-lock warn";
    lock.innerHTML = `<b>Open to every signed-in user</b> No pricing admin list is configured, so anyone who can sign in can change these rates. Set the <code>PRICING_ADMINS</code> environment variable to restrict it.`;
  } else {
    lock.className = "settings-lock hidden";
    lock.innerHTML = "";
  }

  $("#settingsMeta").textContent = settings.updatedAt
    ? `Last changed ${new Date(settings.updatedAt).toLocaleString("en-US")}${settings.updatedBy ? " by " + settings.updatedBy : ""}.`
    : "This rate card has not been saved yet.";
  syncMarginMode();
  renderSettingsPreview();
}

function syncMarginMode() {
  const fixed = $("#setMarginMode").value === "fixed";
  $("#setMarginPercentWrap").classList.toggle("hidden", fixed);
  $("#setMarginFixedWrap").classList.toggle("hidden", !fixed);
}

/* A worked example makes an abstract rate card concrete before it is saved. */
function renderSettingsPreview() {
  const s = formSettings();
  $("#setPerMileTotal").innerHTML =
    `Total internal cost per mile — <b>${esc(fmtMoney(s.costPerMile + s.operatingCostPerMile))}</b>`;

  const el = $("#settingsPreview");
  if (!isConfigured(s)) {
    el.innerHTML = `<div class="preview empty">Enter your costs above to see a worked example.</div>`;
    return;
  }
  const rows = [50, 150, 300].map(mi => {
    const q = computeQuote({ miles: mi, roundTrip: s.roundTripDefault }, s);
    return `<tr><td>${fmtMiles(mi)} mi${s.roundTripDefault ? " <i>rt</i>" : ""}</td>
      <td>${esc(fmtMoney(q.internalCost))}</td>
      <td>${esc(fmtMoney(q.marginTarget))}</td>
      <td class="price">${esc(fmtMoney(q.customerTotal))}${q.minimumApplied ? ` <i title="Minimum charge applied">min</i>` : ""}</td></tr>`;
  }).join("");
  el.innerHTML = `<div class="preview">
    <p class="preview-tag">WORKED EXAMPLE${s.roundTripDefault ? " · ROUND TRIP" : " · ONE WAY"}</p>
    <table class="preview-table">
      <thead><tr><th>Distance</th><th>Your cost</th><th>Margin</th><th>Customer pays</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
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

/* The board is time-sensitive, so it re-renders itself every minute. */
setInterval(() => { if (token && trips.length) render(); }, 60000);

/* ---------- auth view ---------- */
function showApp() {
  $("#auth").classList.toggle("hidden", !!token);
  $("#app").classList.toggle("hidden", !token);
  $("#logout").classList.toggle("hidden", !token);
  $("#userchip").classList.toggle("hidden", !token);
  if (token) {
    requestAnimationFrame(moveGlider);
    skeletons();
    api("me").then(b => setUser(b.email)).catch(() => {});
    /* Rate card and capability probe land before the board so the first render
       already knows how to price and whether route lookup exists. */
    Promise.all([loadSettings(), loadConfig()]).then(() => { loadTrips(); renderDistSource(); });
  } else {
    $("#settings").classList.add("hidden");
    $("#editor").classList.add("hidden");
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

/* ---------- rate card panel ---------- */
$("#openSettings").onclick = () => {
  const panel = $("#settings");
  const opening = panel.classList.contains("hidden");
  panel.classList.toggle("hidden", !opening);
  if (opening) { fillSettingsForm(); panel.scrollIntoView({ behavior: "smooth", block: "nearest" }); }
};
$("#closeSettings").onclick = () => $("#settings").classList.add("hidden");
$("#setMarginMode").addEventListener("change", () => { syncMarginMode(); renderSettingsPreview(); });
["setBaseCost", "setCostPerMile", "setOperatingCostPerMile", "setMarginPercent", "setMarginFixed", "setMinimumCharge", "setRoundTripDefault"]
  .forEach(id => $("#" + id).addEventListener("input", renderSettingsPreview));
$("#setRoundTripDefault").addEventListener("change", renderSettingsPreview);

$("#settingsForm").onsubmit = async e => {
  e.preventDefault();
  const btn = e.target.querySelector('button[type=submit]');
  setLoading(btn, true);
  try {
    const b = await api("settings", { method: "PUT", body: JSON.stringify(formSettings()) });
    settings = { ...DEFAULT_SETTINGS, ...b.settings };
    canEditSettings = b.canEdit !== false;
    settingsRestricted = !!b.restricted;
    fillSettingsForm();
    notice("Rate card saved. New quotes use these figures.");
    /* Existing hauls keep the rate card they were priced under, so the board
       does not silently reprice work already quoted to a customer. */
    renderQuote();
  } catch (x) {
    notice(x.message, true);
  } finally {
    setLoading(btn, false);
  }
};

/* ---------- data ---------- */
function skeletons(n = 3) {
  $("#tripList").innerHTML = Array.from({ length: n }, () => '<div class="skeleton"></div>').join("");
}

async function loadTrips(quiet = true) {
  try {
    trips = (await api("trips")).trips;
    refreshPlaces();
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

/* ---------- conflict scan ----------
   One truck means any two live bookings that overlap are a data problem the
   crew needs to see, including ones that predate validation. */
function clashingIds() {
  const live = trips.filter(t => t.status !== "Cancelled");
  const bad = new Set();
  for (let i = 0; i < live.length; i++)
    for (let j = i + 1; j < live.length; j++)
      if (overlaps(live[i], live[j])) { bad.add(live[i].id); bad.add(live[j].id); }
  return bad;
}

/* ---------- stats ---------- */
function countUp(el, target, suffix = "") {
  const from = Number(el.dataset.v || 0);
  if (from === target) { el.textContent = target + suffix; return; }
  el.dataset.v = target;
  const dur = 550, start = performance.now();
  const step = now => {
    const p = Math.min(1, (now - start) / dur);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = Math.round(from + (target - from) * eased) + suffix;
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function renderStats() {
  const now = new Date();
  const live = trips.filter(t => t.status !== "Cancelled");
  const weekEnd = addMin(now, 7 * 1440);
  const booked = live
    .filter(t => startAt(t) < weekEnd && endAt(t) > now)
    .reduce((sum, t) => {
      const s = Math.max(startAt(t), now), e = Math.min(endAt(t), weekEnd);
      return sum + Math.max(0, (e - s) / 3600000);
    }, 0);

  countUp($("#statTotal"), trips.length);
  countUp($("#statUpcoming"), live.filter(t => endAt(t) >= now).length);
  countUp($("#statActive"), live.filter(t => startAt(t) <= now && endAt(t) > now).length);
  countUp($("#statHours"), Math.round(booked));
}

function renderTruckRail() {
  const now = new Date();
  const live = trips.filter(t => t.status !== "Cancelled");
  const current = live.find(t => startAt(t) <= now && endAt(t) > now);
  const next = live.filter(t => startAt(t) > now).sort((a, b) => startAt(a) - startAt(b))[0];

  const state = $("#truckState"), text = $("#truckStateText"), nextEl = $("#truckNext");
  if (current) {
    state.dataset.state = "busy";
    text.textContent = `Committed — ${current.customer}`;
    nextEl.innerHTML = `<span class="tn-label">UNTIL</span><span class="tn-val">${esc(fmtTime(current.end))}${current.endDate !== current.date ? " · " + esc(toDate(current.endDate).toLocaleDateString("en-US", { month: "short", day: "numeric" })) : ""}</span>`;
  } else {
    state.dataset.state = "free";
    text.textContent = "Available";
    nextEl.innerHTML = next
      ? `<span class="tn-label">NEXT OUT</span><span class="tn-val">${esc(toDate(next.date).toLocaleDateString("en-US", { month: "short", day: "numeric" }))} · ${esc(fmtTime(next.start))} · ${esc(next.customer)}</span>`
      : `<span class="tn-label">NEXT OUT</span><span class="tn-val dim">Nothing booked</span>`;
  }
}

/* ---------- trip cards ---------- */
const ICON_EQUIP = '<svg viewBox="0 0 24 24"><path d="M3 18h13M5 18v-4h6l2-5h4l2 5h2v4"/><circle cx="7" cy="20" r="2"/><circle cx="18" cy="20" r="2"/></svg>';
const ICON_DRIVER = '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="3.4"/><path d="M5 20a7 7 0 0 1 14 0"/></svg>';
const ICON_EMPTY = '<svg viewBox="0 0 24 24"><path d="M3 7h11v7H3zM14 10h4l3 4v0h-7z"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/></svg>';

function dateParts(iso) {
  const d = toDate(iso);
  if (isNaN(d)) return { dow: "", day: iso || "", year: "" };
  return {
    dow: d.toLocaleDateString("en-US", { weekday: "short" }).toUpperCase(),
    day: d.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
    year: d.getFullYear()
  };
}

/* Route distance, the map link, and the priced total — the three things the
   yard wants off a card without opening it. */
function routeFoot(t) {
  const p = t.pricing || {};
  const q = t.quote || computeQuote(p, t.rateCard || DEFAULT_SETTINGS);
  const bits = [];
  if (t.pickup && t.delivery)
    bits.push(`<a class="maplink sm" href="${esc(mapDirUrl(t.pickup, t.delivery))}" target="_blank" rel="noopener noreferrer">Directions</a>`);
  if (p.miles !== null && p.miles !== undefined) {
    const source = distanceSource(p.milesSource);
    bits.push(`<span class="rf-mi" title="${esc(source.name)}">${esc(fmtMiles(q.billableMiles))} mi${p.roundTrip ? " rt" : ""}<i>${esc(source.tag)}</i></span>`);
  }
  if (q.ready)
    bits.push(`<span class="rf-price${q.belowCost ? " bad" : ""}" title="Customer total${q.overridden ? " (price overridden)" : ""}">${esc(fmtMoney(q.customerTotal))}${q.overridden ? "<i>set</i>" : ""}</span>`);
  return bits.length ? `<div class="routefoot">${bits.join("")}</div>` : "";
}

function tripCard(t, i, bad) {
  const d = dateParts(t.date);
  const status = slug(t.status);
  const rel = relLabel(t);
  const multi = t.endDate && t.endDate !== t.date;
  return `
  <article class="trip${bad.has(t.id) ? " clash" : ""}" data-status="${esc(status)}" style="animation-delay:${Math.min(i * 45, 360)}ms">
    <div class="trip-date">
      <span class="trip-dow">${esc(d.dow)}</span>
      <span class="trip-day">${esc(d.day)}</span>
      <span class="trip-year">${esc(d.year)}</span>
      <span class="trip-window">${esc(fmtTime(t.start))} – ${esc(fmtTime(t.end))}</span>
      ${multi ? `<span class="trip-multi">thru ${esc(dateParts(t.endDate).day)}</span>` : ""}
      ${t.timesAssumed ? `<span class="trip-assumed" title="Logged before times were tracked; shown with the standard 08:00–16:00 window.">assumed window</span>` : ""}
    </div>
    <div>
      <div class="trip-customer">${esc(t.customer)}</div>
      <div class="route">
        <div class="route-row from"><span class="route-node"></span><span class="route-tag">FROM</span><span class="route-val">${esc(t.pickup)}</span></div>
        <div class="route-row to"><span class="route-node"></span><span class="route-tag">TO</span><span class="route-val">${esc(t.delivery)}</span></div>
      </div>
      ${routeFoot(t)}
    </div>
    <div class="meta">
      <div class="meta-row">${ICON_EQUIP}<span>${esc(t.equipment || "Equipment TBD")}</span></div>
      <div class="meta-row">${ICON_DRIVER}<span>${esc(t.driver || "Driver TBD")}</span></div>
      <div class="meta-row rel ${esc(rel.tone)}"><span>${esc(rel.text)} · ${esc(fmtDur(durMin(t)))}</span></div>
    </div>
    <span class="badge ${esc(status.replace(/\s+/g, "-"))}"><span class="led"></span>${esc(t.status)}</span>
    <div class="trip-actions">
      <button class="edit" type="button" data-edit="${esc(t.id)}">Edit</button>
      <button class="del" type="button" data-del="${esc(t.id)}">Delete</button>
    </div>
    ${bad.has(t.id) ? `<p class="trip-clash">⚠ Double-booked — this window overlaps another live haul. Adjust the times.</p>` : ""}
    ${t.notes ? `<p class="trip-notes"><b>Notes</b>${esc(t.notes)}</p>` : ""}
  </article>`;
}

/* ---------- calendar ---------- */
function tripsByDay() {
  const map = {};
  trips.forEach(t => {
    if (!t.date) return;
    let d = toDate(t.date);
    const last = toDate(t.endDate || t.date);
    for (let guard = 0; d <= last && guard < 400; guard++) {
      (map[isoOf(d)] ||= []).push(t);
      d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
    }
  });
  Object.values(map).forEach(list => list.sort((a, b) => minutesOf(a.start) - minutesOf(b.start)));
  return map;
}

function renderCalendar() {
  const grid = $("#calGrid");
  const map = tripsByDay();
  const bad = clashingIds();
  const cur = calCursor;
  $("#calTitle").textContent = cur.toLocaleDateString("en-US", { month: "long", year: "numeric" });

  const first = new Date(cur.getFullYear(), cur.getMonth(), 1);
  const startCell = new Date(first.getFullYear(), first.getMonth(), 1 - first.getDay());
  const todayIso = today();

  let html = "";
  for (let i = 0; i < 42; i++) {
    const d = new Date(startCell.getFullYear(), startCell.getMonth(), startCell.getDate() + i);
    const iso = isoOf(d);
    const list = map[iso] || [];
    const live = list.filter(t => t.status !== "Cancelled");
    const out = d.getMonth() !== cur.getMonth();
    const cls = [
      "cell",
      out ? "out" : "",
      iso === todayIso ? "today" : "",
      iso === selectedDay ? "sel" : "",
      live.length ? "has" : "",
      list.some(t => bad.has(t.id)) ? "clash" : ""
    ].filter(Boolean).join(" ");

    const chips = list.slice(0, 3).map(t => {
      const cont = t.endDate !== t.date && iso !== t.date;
      return `<span class="chip ${esc(slug(t.status).replace(/\s+/g, "-"))}"><i></i>${cont ? "↳ " : esc(fmtTime(t.start)).replace(/:00 /, " ") + " "}${esc(t.customer)}</span>`;
    }).join("");
    const more = list.length > 3 ? `<span class="chip more">+${list.length - 3} more</span>` : "";
    const dots = list.slice(0, 4).map(t => `<i class="dot ${esc(slug(t.status).replace(/\s+/g, "-"))}"></i>`).join("");

    html += `<button type="button" class="${cls}" data-day="${iso}" aria-label="${esc(fmtDayLong(iso))}, ${live.length} haul${live.length === 1 ? "" : "s"}">
      <span class="cell-num">${d.getDate()}</span>
      <span class="cell-chips">${chips}${more}</span>
      <span class="cell-dots">${dots}${list.length > 4 ? `<i class="dot more">+</i>` : ""}</span>
    </button>`;
  }
  grid.innerHTML = html;
  renderDayPanel();
}

/* Free windows inside the working day, so booking does not need guesswork. */
function freeWindows(iso) {
  const open = toDate(iso, DAY_OPEN), close = toDate(iso, DAY_CLOSE);
  const busy = trips
    .filter(t => t.status !== "Cancelled" && startAt(t) < close && endAt(t) > open)
    .map(t => [new Date(Math.max(startAt(t), open)), new Date(Math.min(endAt(t), close))])
    .sort((a, b) => a[0] - b[0]);

  const gaps = [];
  let cursor = open;
  busy.forEach(([s, e]) => {
    if (s > cursor) gaps.push([cursor, s]);
    if (e > cursor) cursor = e;
  });
  if (cursor < close) gaps.push([cursor, close]);
  return gaps.filter(([s, e]) => (e - s) / 60000 >= 30);
}

function renderDayPanel() {
  const panel = $("#dayPanel");
  if (!selectedDay) { panel.classList.add("hidden"); return; }
  panel.classList.remove("hidden");
  $("#dayTitle").textContent = fmtDayLong(selectedDay);

  const map = tripsByDay();
  const list = map[selectedDay] || [];
  const bad = clashingIds();

  const rows = list.map(t => {
    const cont = t.endDate !== t.date;
    return `<div class="dayrow ${esc(slug(t.status).replace(/\s+/g, "-"))}${bad.has(t.id) ? " clash" : ""}">
      <span class="dayrow-time">${esc(fmtTime(t.start))}<i>–</i>${esc(fmtTime(t.end))}${cont ? `<b>multi-day</b>` : ""}</span>
      <span class="dayrow-body">
        <strong>${esc(t.customer)}</strong>
        <span>${esc(t.pickup)} → ${esc(t.delivery)}${t.pickup && t.delivery ? ` <a class="maplink xs" href="${esc(mapDirUrl(t.pickup, t.delivery))}" target="_blank" rel="noopener noreferrer" title="Directions in Google Maps">map</a>` : ""}</span>
        <span class="dayrow-meta">${esc(t.equipment || "Equipment TBD")} · ${esc(t.driver || "Driver TBD")} · ${esc(t.status)}${t.quote?.ready ? ` · <b>${esc(fmtMoney(t.quote.customerTotal))}</b>` : ""}</span>
      </span>
      <button class="dayrow-edit" type="button" data-edit="${esc(t.id)}">Edit</button>
    </div>`;
  }).join("");

  const gaps = freeWindows(selectedDay);
  const gapHtml = gaps.length
    ? `<div class="freewins"><span class="freewins-tag">TRUCK FREE</span>${gaps.map(([s, e]) =>
        `<button type="button" class="freewin" data-free-s="${hhmmOf(s)}" data-free-e="${hhmmOf(e)}">${esc(fmtTime(hhmmOf(s)))} – ${esc(fmtTime(hhmmOf(e)))}</button>`).join("")}</div>`
    : `<div class="freewins"><span class="freewins-tag booked">FULLY COMMITTED ${DAY_OPEN}–${DAY_CLOSE}</span></div>`;

  $("#dayBody").innerHTML = (rows || `<p class="dayempty">No hauls booked. The truck is open all day.</p>`) + gapHtml;
}

$("#calPrev").onclick = () => { calCursor = new Date(calCursor.getFullYear(), calCursor.getMonth() - 1, 1); renderCalendar(); };
$("#calNext").onclick = () => { calCursor = new Date(calCursor.getFullYear(), calCursor.getMonth() + 1, 1); renderCalendar(); };
$("#calToday").onclick = () => {
  const n = new Date();
  calCursor = new Date(n.getFullYear(), n.getMonth(), 1);
  selectedDay = today();
  renderCalendar();
};
$("#dayClose").onclick = () => { selectedDay = null; renderDayPanel(); renderCalendar(); };
$("#dayAdd").onclick = () => {
  const gaps = freeWindows(selectedDay);
  const g = gaps[0];
  openEditor({ date: selectedDay, start: g ? hhmmOf(g[0]) : "07:00", end: g ? hhmmOf(new Date(Math.min(g[1], addMin(g[0], 120)))) : "12:00" });
};

$("#calGrid").addEventListener("click", e => {
  const cell = e.target.closest("[data-day]");
  if (!cell) return;
  selectedDay = cell.dataset.day === selectedDay ? null : cell.dataset.day;
  renderCalendar();
  if (selectedDay) $("#dayPanel").scrollIntoView({ behavior: "smooth", block: "nearest" });
});

$("#dayBody").addEventListener("click", e => {
  const edit = e.target.closest("[data-edit]");
  if (edit) return openEditor(trips.find(t => t.id === edit.dataset.edit));
  const free = e.target.closest("[data-free-s]");
  if (free) openEditor({ date: selectedDay, start: free.dataset.freeS, end: free.dataset.freeE });
});

/* ---------- render ---------- */
function render() {
  const now = new Date();
  const bad = clashingIds();
  const isCal = filter === "calendar";

  $("#calendar").classList.toggle("hidden", !isCal);
  $("#tripList").classList.toggle("hidden", isCal);

  $("#clashWarn").classList.toggle("hidden", !bad.size);
  if (bad.size) $("#clashWarn").innerHTML = `⚠ <b>${bad.size} booking${bad.size === 1 ? "" : "s"} overlap</b> — the truck cannot be in two places at once. Open the flagged hauls and correct their windows.`;

  renderStats();
  renderTruckRail();

  if (isCal) { renderCalendar(); return; }

  const list = trips.filter(t =>
    filter === "all" ||
    (filter === "upcoming" && endAt(t) >= now) ||
    (filter === "past" && endAt(t) < now));

  if (filter === "past") list.sort((a, b) => startAt(b) - startAt(a));

  $("#tripList").innerHTML = list.length
    ? list.map((t, i) => tripCard(t, i, bad)).join("")
    : `<div class="empty">
         <div class="empty-ico">${ICON_EMPTY}</div>
         <strong>No hauls in this view</strong>
         <p>Book the truck to put a haul on the shared dispatch board.</p>
       </div>`;
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
let milesSource = "";          // "manual" | "osm-osrm" | legacy "maps" | ""
let editingRateCard = null;    // rate card the open haul was originally quoted under

/* ---------- route + quote ---------- */
const formPricing = () => {
  const miles = $("#tripMiles").value;
  const override = $("#tripPriceOverride").value;
  return {
    miles: miles === "" ? null : Number(miles),
    milesSource,
    roundTrip: $("#tripRoundTrip").checked,
    discount: Number($("#tripDiscount").value) || 0,
    surcharge: Number($("#tripSurcharge").value) || 0,
    priceOverride: override === "" ? null : Number(override)
  };
};

/* Previously-used places become autocomplete suggestions. Free, and it keeps
   the same yard spelled the same way across hauls. */
function refreshPlaces() {
  const seen = new Set();
  trips.forEach(t => { [t.pickup, t.delivery].forEach(v => { if (v && v.trim()) seen.add(v.trim()); }); });
  $("#knownPlaces").innerHTML = Array.from(seen).sort()
    .map(v => `<option value="${esc(v)}"></option>`).join("");
}

function syncMapLinks() {
  const from = $("#pickup").value.trim(), to = $("#delivery").value.trim();
  const dir = $("#mapDirections"), mp = $("#mapPickup"), md = $("#mapDelivery");
  mp.hidden = !from; if (from) mp.href = mapSearchUrl(from);
  md.hidden = !to;   if (to)   md.href = mapSearchUrl(to);
  dir.hidden = !(from && to); if (from && to) dir.href = mapDirUrl(from, to);
}

/* States the mileage field can be in, said plainly. A provider result and a
   figure somebody typed are never blurred. */
function renderDistSource(msg) {
  const el = $("#distSource");
  if (!el) return;
  if (msg) { el.className = "distsource " + msg.tone; el.innerHTML = msg.html; return; }
  if (milesSource === "osm-osrm") {
    el.className = "distsource ok";
    el.innerHTML = `<b>OpenStreetMap + OSRM</b> Best-effort driving distance returned by the free server-side route service. Edit the field to override it.`;
  } else if (milesSource === "maps") {
    el.className = "distsource ok";
    el.innerHTML = `<b>Google Routes · legacy</b> This saved distance came from the former Google route provider. Edit it or look it up again to replace it.`;
  } else if (!routeConfigured) {
    el.className = "distsource manual";
    el.innerHTML = `<b>Manual distance</b> Live route lookup is not enabled on this site, so mileage is entered by hand — nothing here is measured automatically. Use <em>Directions in Google Maps</em> above to read the distance, then type it in.`;
  } else {
    el.className = "distsource manual";
    el.innerHTML = `<b>Manual distance</b> Typed by hand. Use <em>Look up distance</em> for a best-effort ${esc(routeProvider.label)} driving distance. Google Maps opens separately for directions.`;
  }
}

$("#lookupRoute").onclick = async e => {
  const btn = e.currentTarget;
  const origin = $("#pickup").value.trim(), destination = $("#delivery").value.trim();
  if (!origin || !destination) {
    renderDistSource({ tone: "bad", html: `<b>Need both ends</b> Fill in pickup and delivery before looking up a distance.` });
    return;
  }
  setLoading(btn, true);
  renderDistSource({ tone: "busy", html: `<b>Looking up…</b> Asking ${esc(routeProvider.label)} for the driving distance.` });
  try {
    const r = await api("route", { method: "POST", body: JSON.stringify({ origin, destination }) });
    $("#tripMiles").value = r.miles;
    milesSource = r.source || routeProvider.id || "manual";
    renderDistSource({
      tone: "ok",
      html: `<b>${esc(r.provider || routeProvider.label)}</b> ${esc(fmtMiles(r.miles))} mi driving${r.minutes ? ` · about ${esc(fmtDur(r.minutes))} behind the wheel` : ""}. Best-effort public routing; edit the field to override it.`
    });
    renderQuote();
  } catch (x) {
    milesSource = $("#tripMiles").value === "" ? "" : "manual";
    renderDistSource({
      tone: "bad",
      html: `<b>Manual fallback</b> ${esc(x.message)} Open the Google Maps directions link above to verify the route, then enter mileage by hand.`
    });
  } finally {
    setLoading(btn, false);
  }
};

function renderQuote() {
  const p = formPricing();
  const q = computeQuote(p, settings);
  const state = $("#quoteState"), bd = $("#quoteBreakdown"), tot = $("#quoteTotal");
  if (!state) return;

  if (!q.configured) {
    state.className = "quote-state warn";
    state.textContent = "No rate card";
    bd.innerHTML = `<p class="quote-blank">Pricing is not configured yet. Open <b>Rate card</b> to enter your costs and margin, and quotes will calculate here.</p>`;
    tot.innerHTML = "";
    return;
  }
  if (!q.hasMiles) {
    state.className = "quote-state warn";
    state.textContent = "Needs distance";
    bd.innerHTML = `<p class="quote-blank">Enter the route distance above to calculate a quote.</p>`;
    tot.innerHTML = "";
    return;
  }

  state.className = "quote-state ok";
  state.textContent = milesSource === "osm-osrm"
    ? "Priced · OSM/OSRM distance"
    : milesSource === "maps" ? "Priced · legacy Google distance" : "Priced · manual distance";

  const stale = editingRateCard && JSON.stringify(computeQuote(p, editingRateCard).customerTotal) !== JSON.stringify(q.customerTotal);
  const row = (label, val, cls = "") => `<div class="qrow ${cls}"><span>${label}</span><b>${esc(val)}</b></div>`;

  bd.innerHTML =
    row(`Billable miles${q.roundTrip ? ` <i>${fmtMiles(q.oneWayMiles)} mi each way, round trip</i>` : ` <i>one way</i>`}`, fmtMiles(q.billableMiles) + " mi") +
    row(`Base charge <i>per haul</i>`, fmtMoney(q.baseCost)) +
    row(`Direct cost <i>${fmtMoney(settings.costPerMile)}/mi</i>`, fmtMoney(q.directCost)) +
    row(`Operating / fuel <i>${fmtMoney(settings.operatingCostPerMile)}/mi</i>`, fmtMoney(q.operatingCost)) +
    row(`<b>Your cost</b>`, fmtMoney(q.internalCost), "sub") +
    row(`Target margin <i>${q.marginMode === "fixed" ? "fixed" : settings.marginPercent + "% markup on cost"}</i>`, fmtMoney(q.marginTarget)) +
    row(`Calculated price${q.minimumApplied ? ` <i>minimum charge applied</i>` : ""}`, fmtMoney(q.suggested), "sub") +
    (q.discount ? row(`Discount`, "-" + fmtMoney(q.discount), "neg") : "") +
    (q.surcharge ? row(`Surcharge`, "+" + fmtMoney(q.surcharge), "pos") : "") +
    (q.overridden ? row(`Price overridden <i>calculated ${fmtMoney(q.suggested)}</i>`, fmtMoney(q.customerTotal), "override") : "");

  const marginCls = q.belowCost ? "bad" : q.realizedMarginPct !== null && q.realizedMarginPct < 10 ? "thin" : "ok";
  tot.innerHTML = `
    <div class="qtotal">
      <span class="qtotal-label">Customer total</span>
      <span class="qtotal-val">${esc(fmtMoney(q.customerTotal))}</span>
    </div>
    <div class="qmargin ${marginCls}">
      <span>Margin <b>${esc(fmtMoney(q.realizedMargin))}</b></span>
      <span>${q.realizedMarginPct === null ? "—" : esc(q.realizedMarginPct.toFixed(1)) + "% of price"}</span>
      <span>${q.realizedMarkupPct === null ? "—" : esc(q.realizedMarkupPct.toFixed(1)) + "% on cost"}</span>
    </div>
    ${q.belowCost ? `<p class="qwarn">⚠ This price is below what the haul costs you — you lose ${esc(fmtMoney(Math.abs(q.realizedMargin)))} on it.</p>` : ""}
    ${stale ? `<p class="qnote">This haul was originally quoted under an older rate card. Saving reprices it at current rates.</p>` : ""}`;
}

const FIELDS = ["date", "endDate", "start", "end", "customer", "pickup", "delivery", "equipment", "driver", "status", "notes"];
const INPUT = { date: "tripDate", endDate: "tripEndDate", start: "tripStart", end: "tripEnd" };
const inputId = k => INPUT[k] || k;
const formTrip = () => ({
  id: $("#tripId").value || "__new__",
  date: $("#tripDate").value,
  endDate: $("#multiDay").checked && $("#tripEndDate").value ? $("#tripEndDate").value : $("#tripDate").value,
  start: $("#tripStart").value,
  end: $("#tripEnd").value,
  status: $("#status").value
});

function openEditor(t = {}) {
  $("#editor").classList.remove("hidden");
  $("#editorTitle").textContent = t.id ? "Edit booking" : "Book the truck";
  $("#tripId").value = t.id || "";
  FIELDS.forEach(k => { $("#" + inputId(k)).value = t[k] || (k === "status" ? "Scheduled" : ""); });
  $("#tripDate").value = t.date || selectedDay || today();
  $("#tripStart").value = t.start || "07:00";
  $("#tripEnd").value = t.end || "12:00";

  const multi = !!(t.endDate && t.date && t.endDate !== t.date);
  $("#multiDay").checked = multi;
  $("#endDateWrap").classList.toggle("hidden", !multi);
  $("#tripEndDate").value = t.endDate || t.date || $("#tripDate").value;

  /* pricing inputs — a haul that was never priced starts blank rather than at
     zero, so "not quoted yet" stays distinguishable from "quoted at nothing". */
  const p = t.pricing || {};
  $("#tripMiles").value = p.miles === null || p.miles === undefined ? "" : p.miles;
  $("#tripRoundTrip").checked = p.roundTrip === undefined ? !!settings.roundTripDefault : !!p.roundTrip;
  $("#tripDiscount").value = p.discount || "";
  $("#tripSurcharge").value = p.surcharge || "";
  $("#tripPriceOverride").value = p.priceOverride === null || p.priceOverride === undefined ? "" : p.priceOverride;
  milesSource = p.milesSource || "";
  /* An edit reprices against the current rate card; the card the haul was
     originally quoted under is shown alongside if it has since changed. */
  editingRateCard = t.rateCard || null;

  refreshPlaces();
  syncMapLinks();
  renderDistSource();
  renderQuote();
  checkAvailability();
  $("#editor").scrollIntoView({ behavior: "smooth", block: "nearest" });
  setTimeout(() => $("#customer").focus({ preventScroll: true }), 320);
}

$("#newTrip").onclick = () => openEditor();
$("#cancelEdit").onclick = () => $("#editor").classList.add("hidden");

$("#multiDay").onchange = e => {
  $("#endDateWrap").classList.toggle("hidden", !e.target.checked);
  if (e.target.checked && !$("#tripEndDate").value) $("#tripEndDate").value = $("#tripDate").value;
  checkAvailability();
};

$("#presets").addEventListener("click", e => {
  const b = e.target.closest("button[data-s]");
  if (!b) return;
  $("#tripStart").value = b.dataset.s;
  $("#tripEnd").value = b.dataset.e;
  checkAvailability();
});

/* Earliest window of the same length that clears every other booking. */
function suggestSlot(candidate) {
  const want = Math.max(15, (toDate(candidate.endDate, candidate.end) - toDate(candidate.date, candidate.start)) / 60000);
  const now = new Date();
  for (let dayOffset = 0; dayOffset < 30; dayOffset++) {
    const base = toDate(candidate.date);
    const day = new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayOffset);
    const iso = isoOf(day);
    for (let m = minutesOf(DAY_OPEN); m + want <= minutesOf(DAY_CLOSE); m += SLOT_STEP) {
      const s = addMin(toDate(iso), m), e = addMin(s, want);
      if (s < now) continue;
      const probe = { id: candidate.id, date: iso, endDate: isoOf(e), start: hhmmOf(s), end: hhmmOf(e), status: "Scheduled" };
      const hit = trips.some(o => o.id !== candidate.id && o.status !== "Cancelled" && overlaps(probe, o));
      if (!hit) return probe;
    }
  }
  return null;
}

function checkAvailability() {
  const el = $("#avail");
  const c = formTrip();
  if (!c.date || !c.start || !c.end) { el.className = "avail"; el.innerHTML = ""; return; }

  if (toDate(c.endDate, c.end) <= toDate(c.date, c.start)) {
    el.className = "avail bad";
    el.innerHTML = `<b>Invalid window</b> The haul has to end after it starts.`;
    return;
  }
  if (c.status === "Cancelled") {
    el.className = "avail neutral";
    el.innerHTML = `<b>Cancelled</b> A cancelled haul releases the truck and is not checked for conflicts.`;
    return;
  }

  const clash = trips.find(o => o.id !== c.id && o.status !== "Cancelled" && overlaps(c, o));
  if (!clash) {
    el.className = "avail ok";
    el.innerHTML = `<b>Truck available</b> ${esc(fmtTime(c.start))} – ${esc(fmtTime(c.end))} · ${esc(fmtDur((toDate(c.endDate, c.end) - toDate(c.date, c.start)) / 60000))} is clear.`;
    return;
  }

  const s = suggestSlot(c);
  el.className = "avail bad";
  el.innerHTML = `<b>Double-booked</b> The truck is already out for ${esc(clash.customer)} ` +
    `${esc(toDate(clash.date).toLocaleDateString("en-US", { month: "short", day: "numeric" }))} ` +
    `${esc(fmtTime(clash.start))} – ${esc(fmtTime(clash.end))}.` +
    (s ? ` <button type="button" class="avail-fix" data-s="${s.start}" data-e="${s.end}" data-d="${s.date}" data-ed="${s.endDate}">Use next free: ${esc(toDate(s.date).toLocaleDateString("en-US", { month: "short", day: "numeric" }))} ${esc(fmtTime(s.start))}</button>` : "");
}

$("#avail").addEventListener("click", e => {
  const b = e.target.closest(".avail-fix");
  if (!b) return;
  $("#tripDate").value = b.dataset.d;
  $("#tripStart").value = b.dataset.s;
  $("#tripEnd").value = b.dataset.e;
  if (b.dataset.ed !== b.dataset.d) { $("#multiDay").checked = true; $("#endDateWrap").classList.remove("hidden"); $("#tripEndDate").value = b.dataset.ed; }
  checkAvailability();
});

["tripDate", "tripStart", "tripEnd", "tripEndDate", "status"].forEach(id => {
  $("#" + id).addEventListener("change", checkAvailability);
});

/* Address edits refresh the map links; pricing edits reprice live so the
   salesperson sees the margin move as they discount. */
["pickup", "delivery"].forEach(id => {
  $("#" + id).addEventListener("input", () => {
    syncMapLinks();
    /* The stored distance belongs to the old pair of addresses, so a changed
       endpoint demotes a provider figure back to a typed one rather than leaving
       a stale number looking authoritative. */
    if (milesSource && milesSource !== "manual") { milesSource = "manual"; renderDistSource({ tone: "warn", html: `<b>Route changed</b> The distance below was looked up for the previous addresses. Look it up again or edit it by hand.` }); }
  });
});

$("#tripMiles").addEventListener("input", () => {
  milesSource = $("#tripMiles").value === "" ? "" : "manual";
  renderDistSource();
  renderQuote();
});

["tripRoundTrip", "tripDiscount", "tripSurcharge", "tripPriceOverride"].forEach(id => {
  $("#" + id).addEventListener("input", renderQuote);
  $("#" + id).addEventListener("change", renderQuote);
});

$("#tripForm").onsubmit = async e => {
  e.preventDefault();
  const btn = e.target.querySelector('button[type=submit]');
  const id = $("#tripId").value;
  const data = Object.fromEntries(FIELDS.map(k => [k, $("#" + inputId(k)).value]));
  if (!$("#multiDay").checked) data.endDate = data.date;
  data.pricing = formPricing();
  setLoading(btn, true);
  try {
    await api(id ? "trips/" + id : "trips", {
      method: id ? "PUT" : "POST",
      body: JSON.stringify(data)
    });
    $("#editor").classList.add("hidden");
    notice(id ? "Booking updated." : "Truck booked.");
    await loadTrips(false);
  } catch (x) {
    notice(x.message, true);
    if (x.conflict) checkAvailability();
    $("#avail").scrollIntoView({ behavior: "smooth", block: "nearest" });
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

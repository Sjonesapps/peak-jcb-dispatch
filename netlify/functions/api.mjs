import crypto from "node:crypto";
import { getStore } from "@netlify/blobs";
import { DEFAULT_SETTINGS, cleanSettings, cleanPricing, computeQuote } from "../../public/quote-model.mjs";
import { ROUTE_PROVIDER, lookupRoute } from "../lib/route-provider.mjs";
const store = getStore({ name: "peak-jcb-dispatch", consistency: "strong" });
const secret = process.env.SESSION_SECRET || "local-development-secret-change-me";
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const b64 = v => Buffer.from(v).toString("base64url");
function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) { return salt + "." + crypto.pbkdf2Sync(password, salt, 120000, 32, "sha256").toString("hex"); }
function checkPassword(password, stored) { const [salt, hash] = stored.split("."); const actual = crypto.pbkdf2Sync(password, salt, 120000, 32, "sha256").toString("hex"); return hash.length === actual.length && crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(actual)); }
function token(email) { const payload = b64(JSON.stringify({ email, exp: Date.now() + 1209600000 })); return payload + "." + b64(crypto.createHmac("sha256", secret).update(payload).digest()); }
function userFrom(req) { const raw = req.headers.get("authorization")?.replace(/^Bearer\s+/i, ""); if (!raw) return null; const [payload, sig] = raw.split("."); try { const expected = b64(crypto.createHmac("sha256", secret).update(payload).digest()); if (!sig || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null; const p = JSON.parse(Buffer.from(payload, "base64url")); return p.exp > Date.now() ? p.email : null; } catch { return null; } }
async function users() { return (await store.get("users", { type: "json" })) || {}; }

/* ---------- pricing settings ----------
   Rate card lives in the same blob store as everything else. Reading it needs a
   session (quotes are priced client-side in the editor); writing it is gated on
   PRICING_ADMINS when that env var is set. Left unset, every signed-in user can
   edit — the app's existing trust model — and the UI says so out loud rather
   than implying a boundary that is not there. */
const adminList = () => String(process.env.PRICING_ADMINS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
const restricted = () => adminList().length > 0;
const canEditSettings = email => !restricted() || adminList().includes(String(email).toLowerCase());

async function settings() { return { ...DEFAULT_SETTINGS, ...((await store.get("settings", { type: "json" })) || {}) }; }

/* ---------- scheduling ----------
   Peak JCB runs ONE transport truck, so every haul is an exclusive booking on a
   single shared resource. Times are naive dealership-local values; comparing
   them as a YYYYMMDDHHMM number keeps the maths timezone-free and total. */
const DEFAULT_START = "08:00";
const DEFAULT_END = "16:00";
const STATUSES = ["Scheduled", "In progress", "Complete", "Cancelled"];

const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(v);
const isTime = v => /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
const stamp = (date, time) => Number(date.replace(/-/g, "") + time.replace(":", ""));
const startKey = t => stamp(t.date, t.start);
const endKey = t => stamp(t.endDate, t.end);
const overlaps = (a, b) => startKey(a) < endKey(b) && startKey(b) < endKey(a);

/* Records created before the app had time fields get a standard day window so
   they still sort, render and collide like every other booking. */
function normalize(t) {
  const date = isDate(t.date) ? t.date : "";
  const start = isTime(t.start) ? t.start : DEFAULT_START;
  const end = isTime(t.end) ? t.end : DEFAULT_END;
  /* pickup/delivery ARE the origin and destination of the haul. They keep their
     original names on disk so no existing record has to be migrated, and are
     mirrored as origin/destination so the routing and quoting code can read in
     the vocabulary it actually uses. */
  const pickup = String(t.pickup ?? t.origin ?? "");
  const delivery = String(t.delivery ?? t.destination ?? "");
  const pricing = cleanPricing(t.pricing || {}, DEFAULT_SETTINGS, t.pricing || null);
  return {
    ...t,
    date,
    endDate: isDate(t.endDate) && t.endDate >= date ? t.endDate : date,
    start,
    end,
    pickup,
    delivery,
    origin: pickup,
    destination: delivery,
    pricing,
    rateCard: t.rateCard || null,
    /* Recomputed from the rate card snapshotted on the record, so a stored quote
       reads the same on every load even after the live rate card moves on. */
    quote: computeQuote(pricing, t.rateCard || DEFAULT_SETTINGS),
    timesAssumed: !isTime(t.start) || !isTime(t.end)
  };
}

async function trips() { return ((await store.get("trips", { type: "json" })) || []).map(normalize); }

function cleanTrip(input, existing = null, rateCard = DEFAULT_SETTINGS) {
  const date = String(input.date || "").slice(0, 10);
  const endDate = String(input.endDate || "").slice(0, 10) || date;
  /* Addresses are free text on purpose: the yard types "Miller's pit off Hwy 6"
     as readily as a street address, and both work as a Maps search term. The
     longer cap accommodates a full postal address. */
  const pickup = String(input.pickup ?? input.origin ?? "").trim().slice(0, 240);
  const delivery = String(input.delivery ?? input.destination ?? "").trim().slice(0, 240);
  const pricing = cleanPricing(input.pricing || {}, rateCard, existing?.pricing || null);
  return {
    id: existing?.id || crypto.randomUUID(),
    date,
    endDate,
    start: String(input.start || "").slice(0, 5),
    end: String(input.end || "").slice(0, 5),
    customer: String(input.customer || "").trim().slice(0, 120),
    pickup,
    delivery,
    equipment: String(input.equipment || "").trim().slice(0, 80),
    driver: String(input.driver || "").trim().slice(0, 80),
    status: STATUSES.includes(input.status) ? input.status : "Scheduled",
    notes: String(input.notes || "").trim().slice(0, 500),
    pricing,
    /* The rate card in force when the haul was priced is snapshotted onto the
       record, so editing the rate card never silently rewrites a quote the
       customer has already been given. */
    rateCard: pricing.miles === null ? (existing?.rateCard || null) : rateCardSnapshot(rateCard),
    quote: computeQuote(pricing, pricing.miles === null && existing?.rateCard ? existing.rateCard : rateCard),
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

const rateCardSnapshot = s => ({
  baseCost: s.baseCost,
  costPerMile: s.costPerMile,
  operatingCostPerMile: s.operatingCostPerMile,
  marginMode: s.marginMode,
  marginPercent: s.marginPercent,
  marginFixed: s.marginFixed,
  minimumCharge: s.minimumCharge
});

function validate(t) {
  if (!isDate(t.date)) return "A valid haul date is required.";
  if (!t.customer || !t.pickup || !t.delivery) return "Customer, pickup, and delivery are required.";
  if (!isTime(t.start) || !isTime(t.end)) return "Start and end times are required, in 24-hour HH:MM format.";
  if (!isDate(t.endDate) || t.endDate < t.date) return "The return date cannot fall before the departure date.";
  if (endKey(t) <= startKey(t)) return "The haul must end after it starts.";
  return null;
}

const window_ = t => t.date === t.endDate ? `${t.date} ${t.start}–${t.end}` : `${t.date} ${t.start} → ${t.endDate} ${t.end}`;

/* Cancelled hauls release the truck, so they neither block nor get blocked. */
function conflictWith(candidate, all) {
  if (candidate.status === "Cancelled") return null;
  return all.find(o => o.id !== candidate.id && o.status !== "Cancelled" && overlaps(candidate, o)) || null;
}

export default async req => {
  const path = new URL(req.url).pathname.replace(/^\/+/, "").replace(/^\.netlify\/functions\/api\/?/, "").replace(/^api\/?/, "");
  const body = req.method === "GET" ? {} : await req.json().catch(() => ({}));
  if (path === "auth/signup" && req.method === "POST") { const email = String(body.email || "").trim().toLowerCase(); if (!/^\S+@\S+\.\S+$/.test(email) || String(body.password || "").length < 8) return json({ error: "Use a valid email and a password of at least 8 characters." }, 400); const all = await users(); if (all[email]) return json({ error: "An account with that email already exists." }, 409); all[email] = { password: hashPassword(body.password), createdAt: new Date().toISOString() }; await store.setJSON("users", all); return json({ token: token(email), email }); }
  if (path === "auth/login" && req.method === "POST") { const email = String(body.email || "").trim().toLowerCase(); const record = (await users())[email]; if (!record || !checkPassword(String(body.password || ""), record.password)) return json({ error: "Invalid email or password." }, 401); return json({ token: token(email), email }); }
  const email = userFrom(req); if (!email) return json({ error: "Authentication required." }, 401);
  if (path === "me" && req.method === "GET") return json({ email });
  if (path === "trips" && req.method === "GET") return json({ trips: (await trips()).sort((a, b) => startKey(a) - startKey(b)) });

  /* Capability probe tells the UI which server-side route provider is active
     and whether settings are write-gated. No credentials or private values are
     returned. Google Maps is used only for ordinary no-key directions links. */
  if (path === "config" && req.method === "GET")
    return json({
      route: {
        configured: true,
        provider: ROUTE_PROVIDER.id,
        label: ROUTE_PROVIDER.label,
        limitations: ROUTE_PROVIDER.limitations
      },
      settings: { restricted: restricted(), canEdit: canEditSettings(email) }
    });

  if (path === "settings" && req.method === "GET")
    return json({ settings: await settings(), canEdit: canEditSettings(email), restricted: restricted() });

  if (path === "settings" && req.method === "PUT") {
    if (!canEditSettings(email)) return json({ error: "Your account is not authorized to change pricing settings." }, 403);
    const next = cleanSettings(body, await settings());
    next.updatedAt = new Date().toISOString();
    next.updatedBy = email;
    await store.setJSON("settings", next);
    return json({ settings: next, canEdit: true, restricted: restricted() });
  }

  if (path === "route" && req.method === "POST") {
    const origin = String(body.origin || "").trim().slice(0, 240);
    const destination = String(body.destination || "").trim().slice(0, 240);
    if (!origin || !destination) return json({ error: "An origin and a destination are both required." }, 400);
    try {
      const r = await lookupRoute(origin, destination);
      return json({ ...r, configured: true, source: ROUTE_PROVIDER.id, provider: ROUTE_PROVIDER.label });
    } catch (e) {
      return json({
        error: e.message,
        configured: true,
        source: ROUTE_PROVIDER.id,
        provider: ROUTE_PROVIDER.label,
        fallback: "manual"
      }, 502);
    }
  }

  if (path === "trips" && req.method === "POST") {
    const trip = cleanTrip(body, null, await settings());
    const invalid = validate(trip);
    if (invalid) return json({ error: invalid }, 400);
    const all = await trips();
    const clash = conflictWith(trip, all);
    if (clash) return json({ error: `The transport truck is already committed ${window_(clash)} for ${clash.customer}. Pick a window that does not overlap.`, conflict: clash }, 409);
    all.push(trip);
    await store.setJSON("trips", all);
    return json({ trip }, 201);
  }

  const match = path.match(/^trips\/([^/]+)$/);
  if (match && req.method === "PUT") {
    const all = await trips();
    const i = all.findIndex(t => t.id === match[1]);
    if (i < 0) return json({ error: "Trip not found." }, 404);
    const trip = cleanTrip(body, all[i], await settings());
    const invalid = validate(trip);
    if (invalid) return json({ error: invalid }, 400);
    const clash = conflictWith(trip, all);
    if (clash) return json({ error: `The transport truck is already committed ${window_(clash)} for ${clash.customer}. Pick a window that does not overlap.`, conflict: clash }, 409);
    all[i] = trip;
    await store.setJSON("trips", all);
    return json({ trip });
  }

  if (match && req.method === "DELETE") { const all = (await trips()).filter(t => t.id !== match[1]); await store.setJSON("trips", all); return json({ ok: true }); }
  return json({ error: "Not found." }, 404);
};

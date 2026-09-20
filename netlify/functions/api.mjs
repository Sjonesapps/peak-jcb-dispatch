import crypto from "node:crypto";
import { getStore } from "@netlify/blobs";
const store = getStore({ name: "peak-jcb-dispatch", consistency: "strong" });
const secret = process.env.SESSION_SECRET || "local-development-secret-change-me";
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const b64 = v => Buffer.from(v).toString("base64url");
function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) { return salt + "." + crypto.pbkdf2Sync(password, salt, 120000, 32, "sha256").toString("hex"); }
function checkPassword(password, stored) { const [salt, hash] = stored.split("."); const actual = crypto.pbkdf2Sync(password, salt, 120000, 32, "sha256").toString("hex"); return hash.length === actual.length && crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(actual)); }
function token(email) { const payload = b64(JSON.stringify({ email, exp: Date.now() + 1209600000 })); return payload + "." + b64(crypto.createHmac("sha256", secret).update(payload).digest()); }
function userFrom(req) { const raw = req.headers.get("authorization")?.replace(/^Bearer\s+/i, ""); if (!raw) return null; const [payload, sig] = raw.split("."); try { const expected = b64(crypto.createHmac("sha256", secret).update(payload).digest()); if (!sig || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null; const p = JSON.parse(Buffer.from(payload, "base64url")); return p.exp > Date.now() ? p.email : null; } catch { return null; } }
async function users() { return (await store.get("users", { type: "json" })) || {}; }

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
  return { ...t, date, endDate: isDate(t.endDate) && t.endDate >= date ? t.endDate : date, start, end, timesAssumed: !isTime(t.start) || !isTime(t.end) };
}

async function trips() { return ((await store.get("trips", { type: "json" })) || []).map(normalize); }

function cleanTrip(input, existing = null) {
  const date = String(input.date || "").slice(0, 10);
  const endDate = String(input.endDate || "").slice(0, 10) || date;
  return {
    id: existing?.id || crypto.randomUUID(),
    date,
    endDate,
    start: String(input.start || "").slice(0, 5),
    end: String(input.end || "").slice(0, 5),
    customer: String(input.customer || "").trim().slice(0, 120),
    pickup: String(input.pickup || "").trim().slice(0, 180),
    delivery: String(input.delivery || "").trim().slice(0, 180),
    equipment: String(input.equipment || "").trim().slice(0, 80),
    driver: String(input.driver || "").trim().slice(0, 80),
    status: STATUSES.includes(input.status) ? input.status : "Scheduled",
    notes: String(input.notes || "").trim().slice(0, 500),
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

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

  if (path === "trips" && req.method === "POST") {
    const trip = cleanTrip(body);
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
    const trip = cleanTrip(body, all[i]);
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

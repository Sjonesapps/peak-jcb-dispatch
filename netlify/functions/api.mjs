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
async function trips() { return (await store.get("trips", { type: "json" })) || []; }
function cleanTrip(input, id = crypto.randomUUID()) { return { id, date: String(input.date || "").slice(0, 10), customer: String(input.customer || "").trim().slice(0, 120), pickup: String(input.pickup || "").trim().slice(0, 180), delivery: String(input.delivery || "").trim().slice(0, 180), equipment: String(input.equipment || "").trim().slice(0, 80), driver: String(input.driver || "").trim().slice(0, 80), status: ["Scheduled", "In progress", "Complete", "Cancelled"].includes(input.status) ? input.status : "Scheduled", notes: String(input.notes || "").trim().slice(0, 500), updatedAt: new Date().toISOString() }; }
export default async req => {
  const path = new URL(req.url).pathname.replace(/^\/+/, "").replace(/^\.netlify\/functions\/api\/?/, "").replace(/^api\/?/, "");
  const body = req.method === "GET" ? {} : await req.json().catch(() => ({}));
  if (path === "auth/signup" && req.method === "POST") { const email = String(body.email || "").trim().toLowerCase(); if (!/^\S+@\S+\.\S+$/.test(email) || String(body.password || "").length < 8) return json({ error: "Use a valid email and a password of at least 8 characters." }, 400); const all = await users(); if (all[email]) return json({ error: "An account with that email already exists." }, 409); all[email] = { password: hashPassword(body.password), createdAt: new Date().toISOString() }; await store.setJSON("users", all); return json({ token: token(email), email }); }
  if (path === "auth/login" && req.method === "POST") { const email = String(body.email || "").trim().toLowerCase(); const record = (await users())[email]; if (!record || !checkPassword(String(body.password || ""), record.password)) return json({ error: "Invalid email or password." }, 401); return json({ token: token(email), email }); }
  const email = userFrom(req); if (!email) return json({ error: "Authentication required." }, 401);
  if (path === "me" && req.method === "GET") return json({ email });
  if (path === "trips" && req.method === "GET") return json({ trips: (await trips()).sort((a, b) => a.date.localeCompare(b.date)) });
  if (path === "trips" && req.method === "POST") { const trip = cleanTrip(body); if (!trip.date || !trip.customer || !trip.pickup || !trip.delivery) return json({ error: "Date, customer, pickup, and delivery are required." }, 400); const all = await trips(); all.push(trip); await store.setJSON("trips", all); return json({ trip }, 201); }
  const match = path.match(/^trips\/([^/]+)$/); if (match && req.method === "PUT") { const all = await trips(); const i = all.findIndex(t => t.id === match[1]); if (i < 0) return json({ error: "Trip not found." }, 404); all[i] = cleanTrip(body, match[1]); await store.setJSON("trips", all); return json({ trip: all[i] }); }
  if (match && req.method === "DELETE") { const all = (await trips()).filter(t => t.id !== match[1]); await store.setJSON("trips", all); return json({ ok: true }); }
  return json({ error: "Not found." }, 404);
};

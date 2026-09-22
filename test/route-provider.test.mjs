import assert from "node:assert/strict";
import test from "node:test";
import { ROUTE_PROVIDER, lookupRoute } from "../netlify/lib/route-provider.mjs";

const response = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body
});

test("free route provider geocodes sequentially and converts OSRM meters to miles", async () => {
  const seen = [];
  const bodies = [
    [{ lat: "40.7608", lon: "-111.8910", display_name: "Salt Lake City, Utah" }],
    [{ lat: "40.5069", lon: "-111.4132", display_name: "Heber City, Utah" }],
    { code: "Ok", routes: [{ distance: 80467.2, duration: 3600 }] }
  ];
  const fetchImpl = async url => { seen.push(String(url)); return response(bodies.shift()); };
  const q = await lookupRoute("Salt Lake City, UT", "Heber City, UT", { fetchImpl, waitImpl: async () => {} });

  assert.equal(ROUTE_PROVIDER.id, "osm-osrm");
  assert.equal(q.miles, 50);
  assert.equal(q.minutes, 60);
  assert.equal(q.resolvedOrigin, "Salt Lake City, Utah");
  assert.equal(q.resolvedDestination, "Heber City, Utah");
  assert.match(seen[0], /^https:\/\/nominatim\.openstreetmap\.org\/search/);
  assert.match(seen[2], /^https:\/\/router\.project-osrm\.org\/route\/v1\/driving\//);
});

test("unresolved plain-English place produces a manual-fallback message", async () => {
  await assert.rejects(
    lookupRoute("not a real place", "Heber City, UT", {
      fetchImpl: async () => response([]),
      waitImpl: async () => {}
    }),
    /enter mileage manually/i
  );
});

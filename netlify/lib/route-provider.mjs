/* Zero-cost server-side route lookup.

   Nominatim geocodes the two plain-English places against OpenStreetMap data;
   OSRM then returns a driving route. Both are public community services, so
   this is deliberately a low-volume, on-demand lookup with a manual-mileage
   fallback. No API key, browser secret, Google API, or paid billing is used. */

export const ROUTE_PROVIDER = {
  id: "osm-osrm",
  label: "OpenStreetMap + OSRM",
  limitations: "Best-effort public routing; unusual yard names or temporary provider limits may require manual mileage."
};

const METERS_PER_MILE = 1609.344;
const USER_AGENT = "PeakJCBDispatch/1.0 (https://peak-jcb-dispatch.netlify.app)";
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const checkedJson = async (response, service) => {
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${service} is temporarily unavailable (${response.status}).`);
  return body;
};

export async function geocodePlace(query, { fetchImpl = fetch } = {}) {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "1");
  url.searchParams.set("countrycodes", "us");

  const body = await checkedJson(await fetchImpl(url, {
    headers: { "user-agent": USER_AGENT, "accept-language": "en-US,en;q=0.8" },
    signal: AbortSignal.timeout(7000)
  }), "OpenStreetMap geocoding");
  const hit = Array.isArray(body) ? body[0] : null;
  const lat = Number(hit?.lat), lon = Number(hit?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon))
    throw new Error(`OpenStreetMap could not locate “${query}”. Try a fuller address or enter mileage manually.`);
  return { lat, lon, label: String(hit.display_name || query) };
}

export async function lookupRoute(origin, destination, { fetchImpl = fetch, waitImpl = wait } = {}) {
  const from = await geocodePlace(origin, { fetchImpl });
  /* Nominatim's public policy caps applications at one request per second. */
  await waitImpl(1050);
  const to = await geocodePlace(destination, { fetchImpl });

  const coords = `${from.lon},${from.lat};${to.lon},${to.lat}`;
  const url = new URL(`https://router.project-osrm.org/route/v1/driving/${coords}`);
  url.searchParams.set("overview", "false");
  url.searchParams.set("steps", "false");
  const body = await checkedJson(await fetchImpl(url, {
    headers: { "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(7000)
  }), "OSRM routing");
  const route = body?.routes?.[0];
  if (body?.code !== "Ok" || !route || !Number.isFinite(Number(route.distance)))
    throw new Error("OSRM could not find a drivable route between those places. Enter mileage manually.");

  return {
    miles: Math.round((Number(route.distance) / METERS_PER_MILE) * 10) / 10,
    minutes: Number.isFinite(Number(route.duration)) ? Math.round(Number(route.duration) / 60) : null,
    resolvedOrigin: from.label,
    resolvedDestination: to.label
  };
}

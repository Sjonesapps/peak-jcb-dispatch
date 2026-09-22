# Peak JCB Dispatch

Shared transportation scheduling and quoting app for Peak JCB. Static frontend plus a Netlify Function API for email/password authentication and CRUD backed by Netlify Blobs.

Peak JCB runs **one transport truck**, so every haul is an exclusive booking on a single shared resource. The API rejects any booking that overlaps a live haul.

## Scheduling model

Each haul stores `date`, `start`, `end` and an optional `endDate` for multi-day long hauls. Times are naive dealership-local values — there is no timezone conversion anywhere, so what the yard types is what the yard sees.

- **Overlap is rejected** on create and update with HTTP 409, naming the conflicting customer and window.
- **Cancelled hauls release the truck** — they neither block nor get blocked.
- **Records created before times existed** normalize to an 08:00–16:00 window on read and are flagged `timesAssumed` so the crew knows the window was inferred rather than entered.
- The working day for free-slot maths is 06:00–18:00.

## Views

- **Calendar** — month grid with per-day booking chips, day detail, and free-window buttons that prefill the booking form. Chips collapse to status dots on mobile.
- **Upcoming / Past** — split on the haul's *end time*, not its date, so a haul running right now reads as current rather than past.
- Any pre-existing overlapping bookings are surfaced as warnings so legacy data can be cleaned up.

## Routing and quotes

- An authenticated, editable rate card persists in the same strongly consistent Netlify Blob store as trips. Existing trip records remain backward-compatible.
- Pickup and delivery remain the persisted origin/destination fields. Every route has a no-key Google Maps directions link.
- Live mileage is calculated server-side by geocoding with OpenStreetMap Nominatim, then routing with the public OSRM service. It uses no API key or paid billing. Public-service or geocoding failures fall back to clearly labeled manual mileage.
- Each priced trip snapshots the rate card used for that quote. A salesperson can add a discount, surcharge, or final price override and see effective dollar margin, margin percentage, and markup immediately.
- Quote arithmetic lives in `public/quote-model.mjs`, imported by both the browser and API. The free route adapter lives in `netlify/lib/route-provider.mjs`; provider credentials cannot reach the browser because route lookup is exposed only through the authenticated API.

## Local

    npm install
    npm test          # syntax checks plus quote and route-adapter tests
    npx netlify dev

## Deployment

The Netlify site `peak-jcb-dispatch` (ID `d3f8f90f-fdad-47d1-9979-9809bb19c0f0`) is **not** git-linked; it is deployed from this directory with the Netlify CLI.

    netlify deploy --prod --site d3f8f90f-fdad-47d1-9979-9809bb19c0f0

`.netlify/state.json` pins the site ID locally. Keep it. The Netlify CLI walks up the directory tree looking for a link, and a parent directory in this workspace pins a different site — without the local pin a deploy from here can land on the wrong site.

`SESSION_SECRET` is set in the Netlify production environment. Changing it invalidates every issued token and signs everyone out.

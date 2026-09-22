/* Quote maths. Run with: npm test */
import assert from "node:assert/strict";
import test from "node:test";
import { computeQuote, cleanSettings, cleanPricing, DEFAULT_SETTINGS, isConfigured } from "../public/quote-model.mjs";

/* A realistic rate card: $150 to hook up, $2.10/mi direct, $1.40/mi fuel,
   25% markup on cost, $250 floor. */
const CARD = cleanSettings({
  baseCost: 150,
  costPerMile: 2.1,
  operatingCostPerMile: 1.4,
  marginMode: "percent",
  marginPercent: 25,
  minimumCharge: 250,
  roundTripDefault: false
});

test("rate card is recognised as configured", () => {
  assert.equal(isConfigured(CARD), true);
  assert.equal(isConfigured(DEFAULT_SETTINGS), false);
});

test("one-way quote adds base, direct and operating cost, then marks up", () => {
  const q = computeQuote({ miles: 100, roundTrip: false }, CARD);
  assert.equal(q.billableMiles, 100);
  assert.equal(q.directCost, 210);        // 100 * 2.10
  assert.equal(q.operatingCost, 140);     // 100 * 1.40
  assert.equal(q.internalCost, 500);      // 150 + 210 + 140
  assert.equal(q.marginTarget, 125);      // 25% of 500
  assert.equal(q.suggested, 625);
  assert.equal(q.customerTotal, 625);
  assert.equal(q.realizedMargin, 125);
  assert.equal(q.realizedMarkupPct, 25);  // margin over cost
  assert.equal(q.realizedMarginPct, 20);  // margin over price
  assert.equal(q.ready, true);
});

test("round trip doubles billable miles but not the base cost", () => {
  const q = computeQuote({ miles: 100, roundTrip: true }, CARD);
  assert.equal(q.oneWayMiles, 100);
  assert.equal(q.billableMiles, 200);
  assert.equal(q.internalCost, 850);      // 150 + 420 + 280
  assert.equal(q.suggested, 1062.5);
});

test("minimum charge floors a short haul and is flagged", () => {
  const q = computeQuote({ miles: 1, roundTrip: false }, CARD);
  assert.equal(q.internalCost, 153.5);
  assert.equal(q.minimumApplied, true);
  assert.equal(q.suggested, 250);
});

test("fixed margin mode ignores the percentage", () => {
  const card = cleanSettings({ ...CARD, marginMode: "fixed", marginFixed: 300, minimumCharge: 0 });
  const q = computeQuote({ miles: 100 }, card);
  assert.equal(q.internalCost, 500);
  assert.equal(q.marginTarget, 300);
  assert.equal(q.suggested, 800);
});

test("discount and surcharge move the customer total and the realized margin", () => {
  const q = computeQuote({ miles: 100, discount: 75, surcharge: 50 }, CARD);
  assert.equal(q.customerTotal, 600);     // 625 + 50 - 75
  assert.equal(q.realizedMargin, 100);
  assert.equal(q.overridden, false);
});

test("an explicit override wins over discount and surcharge", () => {
  const q = computeQuote({ miles: 100, discount: 75, surcharge: 50, priceOverride: 700 }, CARD);
  assert.equal(q.overridden, true);
  assert.equal(q.customerTotal, 700);
  assert.equal(q.realizedMargin, 200);
});

test("an override below cost is flagged rather than silently accepted", () => {
  const q = computeQuote({ miles: 100, priceOverride: 400 }, CARD);
  assert.equal(q.customerTotal, 400);
  assert.equal(q.realizedMargin, -100);
  assert.equal(q.belowCost, true);
  assert.equal(q.realizedMarginPct, -25);
});

test("a zero override is honoured and is not treated as absent", () => {
  const q = computeQuote({ miles: 100, priceOverride: 0 }, CARD);
  assert.equal(q.overridden, true);
  assert.equal(q.customerTotal, 0);
  assert.equal(q.realizedMarginPct, null);   // no price to take a share of
});

test("no distance means the quote is not presentable", () => {
  const q = computeQuote({ miles: null }, CARD);
  assert.equal(q.hasMiles, false);
  assert.equal(q.ready, false);
});

test("no rate card means the quote is not presentable even with distance", () => {
  const q = computeQuote({ miles: 100 }, DEFAULT_SETTINGS);
  assert.equal(q.configured, false);
  assert.equal(q.ready, false);
});

test("the breakdown always adds up to the total it displays", () => {
  for (const miles of [0.5, 7, 33.3, 250, 1012.7]) {
    const q = computeQuote({ miles, roundTrip: true, surcharge: 12.34 }, CARD);
    assert.equal(q.baseCost + q.directCost + q.operatingCost, q.internalCost, `cost parts at ${miles}mi`);
    const expected = Math.round(Math.max(q.internalCost + q.marginTarget, CARD.minimumCharge) * 100) / 100;
    assert.equal(q.suggested, expected, `suggested at ${miles}mi`);
  }
});

/* ---------- input hardening ---------- */

test("negative and junk money inputs clamp to zero rather than inverting a quote", () => {
  const card = cleanSettings({ baseCost: -50, costPerMile: "abc", operatingCostPerMile: 1, marginPercent: -10 });
  assert.equal(card.baseCost, 0);
  assert.equal(card.costPerMile, 0);
  assert.equal(card.marginPercent, 0);
  const p = cleanPricing({ miles: -20, discount: "xx", surcharge: -5 }, card);
  assert.equal(p.miles, 0);
  assert.equal(p.discount, 0);
  assert.equal(p.surcharge, 0);
});

test("blank mileage stays null instead of becoming a confident zero", () => {
  assert.equal(cleanPricing({ miles: "" }, CARD).miles, null);
  assert.equal(cleanPricing({ miles: null }, CARD).miles, null);
  assert.equal(cleanPricing({}, CARD).miles, null);
  assert.equal(cleanPricing({ miles: 0 }, CARD).miles, 0);
});

test("mileage source is recorded and defaults to manual", () => {
  assert.equal(cleanPricing({ miles: 10 }, CARD).milesSource, "manual");
  assert.equal(cleanPricing({ miles: 10, milesSource: "maps" }, CARD).milesSource, "maps");
  assert.equal(cleanPricing({ miles: 10, milesSource: "osm-osrm" }, CARD).milesSource, "osm-osrm");
  assert.equal(cleanPricing({ miles: 10, milesSource: "psychic" }, CARD).milesSource, "manual");
  assert.equal(cleanPricing({ miles: "" }, CARD).milesSource, "");
});

test("round trip falls back to the rate card default only for new records", () => {
  assert.equal(cleanPricing({}, cleanSettings({ ...CARD, roundTripDefault: true })).roundTrip, true);
  assert.equal(cleanPricing({}, CARD, { roundTrip: true }).roundTrip, true);
  assert.equal(cleanPricing({ roundTrip: false }, cleanSettings({ ...CARD, roundTripDefault: true })).roundTrip, false);
});

test("settings round-trip through cleanSettings without drifting", () => {
  assert.deepEqual(cleanSettings(CARD), CARD);
});

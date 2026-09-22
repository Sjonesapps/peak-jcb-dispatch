/* Peak JCB Dispatch — pricing model.

   This file is the single source of truth for quote maths. The browser loads it
   as an ES module and the Netlify Function imports it relatively, so the editor
   preview and the stored quote can never drift apart.

   Cost model, in the order the yard thinks about it:

     billable miles = one-way miles, doubled when the haul is a round trip
     direct cost    = costPerMile            x billable miles   (driver, wear)
     operating cost = operatingCostPerMile   x billable miles   (fuel, DEF)
     internal cost  = baseCost + direct + operating
     margin         = markup % of internal cost, or a flat dollar figure
     suggested      = internal cost + margin, floored at minimumCharge
     customer total = override, else suggested + surcharge - discount

   "Margin %" in the settings is a MARKUP ON COST. The breakdown also reports
   margin as a share of the customer price, because those two numbers differ and
   a salesperson quoting off the wrong one loses money. */

export const MARGIN_MODES = ["percent", "fixed"];

export const DEFAULT_SETTINGS = {
  baseCost: 0,
  costPerMile: 0,
  operatingCostPerMile: 0,
  marginMode: "percent",
  marginPercent: 0,
  marginFixed: 0,
  minimumCharge: 0,
  roundTripDefault: true,
  updatedAt: null,
  updatedBy: null
};

/* Money is rounded to cents at every boundary so the displayed figures always
   add up to the displayed total. */
export const money = n => Math.round((Number(n) || 0) * 100) / 100;
export const num = (v, max = 1e9) => {
  const n = Number(v);
  if (!isFinite(n) || n < 0) return 0;
  return Math.min(n, max);
};

export function cleanSettings(input = {}, existing = {}) {
  const base = { ...DEFAULT_SETTINGS, ...existing };
  const mode = MARGIN_MODES.includes(input.marginMode) ? input.marginMode : base.marginMode;
  return {
    baseCost: money(num(input.baseCost ?? base.baseCost, 1e6)),
    costPerMile: money(num(input.costPerMile ?? base.costPerMile, 1e4)),
    operatingCostPerMile: money(num(input.operatingCostPerMile ?? base.operatingCostPerMile, 1e4)),
    marginMode: mode,
    marginPercent: money(num(input.marginPercent ?? base.marginPercent, 1000)),
    marginFixed: money(num(input.marginFixed ?? base.marginFixed, 1e6)),
    minimumCharge: money(num(input.minimumCharge ?? base.minimumCharge, 1e6)),
    roundTripDefault: input.roundTripDefault === undefined ? !!base.roundTripDefault : !!input.roundTripDefault,
    updatedAt: base.updatedAt,
    updatedBy: base.updatedBy
  };
}

/* A rate card is considered unconfigured until someone has actually saved one.
   Quotes stay blank rather than confidently reporting $0. */
export const isConfigured = s =>
  !!s && (s.baseCost > 0 || s.costPerMile > 0 || s.operatingCostPerMile > 0 || s.minimumCharge > 0);

/* pricing inputs carried on each haul */
export function cleanPricing(input = {}, settings = DEFAULT_SETTINGS, existing = null) {
  const rawMiles = input.miles;
  const hasMiles = rawMiles !== "" && rawMiles !== null && rawMiles !== undefined && isFinite(Number(rawMiles));
  const source = ["manual", "maps", "osm-osrm"].includes(input.milesSource) ? input.milesSource : (hasMiles ? "manual" : "");
  const override = input.priceOverride;
  const hasOverride = override !== "" && override !== null && override !== undefined && isFinite(Number(override));
  return {
    miles: hasMiles ? money(num(rawMiles, 100000)) : null,
    milesSource: hasMiles ? source : "",
    milesNote: String(input.milesNote || "").trim().slice(0, 160),
    roundTrip: input.roundTrip === undefined
      ? (existing ? !!existing.roundTrip : !!settings.roundTripDefault)
      : !!input.roundTrip,
    discount: money(num(input.discount, 1e6)),
    surcharge: money(num(input.surcharge, 1e6)),
    priceOverride: hasOverride ? money(num(override, 1e7)) : null
  };
}

/* The whole quote, from rate card + haul pricing inputs. Pure: no clock, no IO. */
export function computeQuote(pricing = {}, settings = DEFAULT_SETTINGS) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const p = { miles: null, roundTrip: false, discount: 0, surcharge: 0, priceOverride: null, ...pricing };

  const configured = isConfigured(s);
  const hasMiles = p.miles !== null && p.miles !== undefined && isFinite(Number(p.miles));
  const oneWayMiles = hasMiles ? money(p.miles) : 0;
  const billableMiles = money(p.roundTrip ? oneWayMiles * 2 : oneWayMiles);

  const directCost = money(billableMiles * s.costPerMile);
  const operatingCost = money(billableMiles * s.operatingCostPerMile);
  const perMileCost = money(s.costPerMile + s.operatingCostPerMile);
  const internalCost = money(s.baseCost + directCost + operatingCost);

  const margin = s.marginMode === "fixed"
    ? money(s.marginFixed)
    : money(internalCost * (s.marginPercent / 100));

  const beforeMinimum = money(internalCost + margin);
  const suggested = money(Math.max(beforeMinimum, s.minimumCharge));
  const minimumApplied = suggested > beforeMinimum;

  const adjusted = money(suggested + p.surcharge - p.discount);
  const overridden = p.priceOverride !== null && p.priceOverride !== undefined;
  const customerTotal = money(Math.max(0, overridden ? p.priceOverride : adjusted));

  const realizedMargin = money(customerTotal - internalCost);
  /* Markup is margin over cost; marginPct is margin over price. Both are shown
     because they are routinely confused and only one of them is the profit
     share of what the customer actually pays. */
  const realizedMarkupPct = internalCost > 0 ? money((realizedMargin / internalCost) * 100) : null;
  const realizedMarginPct = customerTotal > 0 ? money((realizedMargin / customerTotal) * 100) : null;

  return {
    configured,
    hasMiles,
    oneWayMiles,
    billableMiles,
    roundTrip: !!p.roundTrip,
    perMileCost,
    directCost,
    operatingCost,
    baseCost: money(s.baseCost),
    internalCost,
    marginMode: s.marginMode,
    marginTarget: margin,
    suggested,
    minimumApplied,
    discount: money(p.discount),
    surcharge: money(p.surcharge),
    overridden,
    customerTotal,
    realizedMargin,
    realizedMarkupPct,
    realizedMarginPct,
    belowCost: customerTotal > 0 && realizedMargin < 0,
    /* A quote is only presentable once there is a rate card AND a distance. */
    ready: configured && hasMiles
  };
}

export const fmtMoney = n =>
  (Number(n) < 0 ? "-$" : "$") + Math.abs(money(n)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const fmtMiles = n =>
  (Math.round((Number(n) || 0) * 10) / 10).toLocaleString("en-US", { maximumFractionDigits: 1 });

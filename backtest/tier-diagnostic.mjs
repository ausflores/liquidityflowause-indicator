// ============================================================================
// LiquidityFlowAuse — Liquidity Tier Diagnostic
// ----------------------------------------------------------------------------
// A BOUNDED diagnostic for the `weight-calibration` feature
// (odd/tasks/weight-calibration.md). Dispatched by
// `node backtest/run.mjs diagnose`. Zero-dependency, bare `node`, ESM, writes
// nothing, downloads nothing. Reads backtest/data/btcusd-5m.json as-is.
//
// ─── THE ONE QUESTION THIS ANSWERS ─────────────────────────────────────────
//
// `node backtest/run.mjs baseline` reports, over 62,000 five-minute bars:
//
//   weighted model fires 2, binary model fires 133, and 391 of 393 raw
//   candidates are rejected by minConfidence 70. Candidate scores cluster at
//   40-60 and the observed score ceiling is 80 against a configured maxScore
//   of 110. The suspected cause is the liquidity TIER: candidates qualified at
//   H1 185/192 (long) and H1 201/201 (short), with D1 0/192 and 0/201.
//
// Two explanations fit that observation and they are NOT equivalent:
//
//   (1) A PROPERTY OF THE DATA. Price genuinely almost never sits inside the
//       proximity band of a D1 or 4H liquidity zone at a moment that also
//       satisfies the other gates. Then the honest finding is "minConfidence 70
//       is only reachable on higher timeframes", which is a complete result.
//   (2) A DEFECT. Tier assignment is broken, or the D1/4H series never
//       populates, or the port diverges from Pine. Then any weight search
//       (T12) would be built on sand.
//
// This file produces the evidence that separates them. It is NOT looking for a
// bug. A clean null result — "the D1 series populates correctly and price is
// simply never near a D1 zone" — is a SUCCESS, and is reported as one.
//
// ─── WHAT IT DELIBERATELY DOES NOT DO ───────────────────────────────────────
//
//   * It does not touch backtest/baseline.mjs. The comparison the orchestrator
//     owns must stay byte-identical; a diagnostic that shares mutable state
//     with it could perturb it silently. The wiring below is a DELIBERATE,
//     documented re-implementation of baseline.mjs:456-638, not a shared
//     import, so this file cannot change how the baseline runs. The
//     self-check "candidate counts" in the report exists to prove the two
//     wirings still agree: this diagnostic must independently arrive at
//     192 long / 201 short candidate bars.
//   * It does not download data, add dependencies, or write a package.json.
//   * It is READ-ONLY with respect to src/, scripts/ and dist/.
//
// ─── VERDICT VOCABULARY (stated first, in the report, before the numbers) ───
//
//   "property of the data"  — the D1/H4 series populates, tier assignment
//                             matches the Pine source expression for
//                             expression, and price is (near-)never inside
//                             the proximity band of a D1/H4 zone. Nothing in
//                             the port is at fault.
//   "defect"                — a D1/H4 zone is inside the proximity band and
//                             the tier flag still never fires, or the D1/H4
//                             series never populates at all.
//   "inconclusive"          — the evidence does not separate the two. The
//                             report names the specific measurement that
//                             would settle it.
//
// Usage:
//   node backtest/run.mjs diagnose          human-readable report on stdout
//   node backtest/run.mjs diagnose --json   the same numbers as JSON
// ============================================================================

import { readFile } from "node:fs/promises";

import {
  DEFAULT_TIMEFRAME,
  getTimeframe,
  htfAvailability,
  nativeBarsForDays,
} from "./timeframes.mjs";
import { createSessionMarkers } from "./modules/session-markers.mjs";
import {
  createAtr,
  createLiquidityZones,
  createPivotDetector,
  LIQUIDITY_ZONE_DEFAULTS,
} from "./modules/liquidity-zones.mjs";
import { createStructureBreak } from "./modules/structure-break.mjs";
import { createImbalanceDetector } from "./modules/imbalance-detector.mjs";
import { createSignalEngine } from "./modules/signal-engine.mjs";
import { createBinarySignalModel } from "./modules/binary.mjs";

const SCHEMA_VERSION = 1;

const MS_1H = 3600000;
const MS_4H = 14400000;
const MS_1D = 86400000;

// ─── Timeframe ───────────────────────────────────────────────────────────────
//
// Same contract as backtest/baseline.mjs: `tf` is threaded through rather than
// read from a module constant, and defaults to 5m. On a coarser native grid the
// DIAGNOSTIC'S CENTRAL RATIO CHANGES DEFINITIONALLY — `bodyToBandRatio` is the
// median zone half-width over the median proximity band, and the band is
// 3 x ATR(14) OF THE NATIVE GRID. On 5m that contest is hopeless (5.04x); on 1h
// the band is an order of magnitude wider in price terms, which is precisely
// the prediction slice 6 left open for this slice to measure.
//
// This file does NOT import baseline.mjs (see the header: the diagnostic must
// not be able to perturb the comparison). It re-implements the wiring, so the
// timeframe threading below is a second, independent implementation of the same
// contract — and the "self-check" section exists to prove the two still agree.
const DEFAULT_TF = getTimeframe(DEFAULT_TIMEFRAME);

const out = (s = "") => console.log(`diagnose: ${s}`);

// ─── Tier vocabulary ─────────────────────────────────────────────────────────
//
// The zone engine stores tiers as Pine integers 1/2/3. The report and the
// helper API speak the names D1 / H4 / H1 so no reader has to remember that
// "tier 2" means 4H. `TIER_OF_INDEX` is the exact port of the slot order at
// liquidity-zones.mjs:318-329 and liquidity-zones.pine:180-190.

export const TIER_NAMES = Object.freeze(["D1", "H4", "H1"]);

// Two vocabularies meet here and they are NOT the same strings: timeframes.mjs
// names the higher-timeframe CONTEXTS "1H"/"4H"/"D1", while this diagnostic — and
// the liquidity-zone module it measures — names the TIERS "H1"/"H4"/"D1". The
// only difference is "1H" vs "H1", which is exactly the kind of mismatch that
// makes an availability check silently false, so it is mapped once, here.
const TIER_OF_HTF_NAME = Object.freeze({ "1H": "H1", "4H": "H4", D1: "D1" });

/** HTF context names (["1H"]) -> liquidity-tier names (["H1"]), unmeasurable ones. */
function unmeasurableTiers(timeframe) {
  return (timeframe?.unavailableHtf ?? []).map((name) => TIER_OF_HTF_NAME[name]).filter(Boolean);
}

const TIER_OF_INDEX = Object.freeze({ 1: "D1", 2: "H4", 3: "H1" });
const TIER_WEIGHT = Object.freeze({ D1: 30, H4: 20, H1: 10 });

const PHASE_PRE = "pre-warmup";
const PHASE_POST = "post-warmup";

// ─── Exported pure helpers (smoke-checked on synthetic, data-free input) ─────

/**
 * THE TIER RULE, in isolation.
 *
 * Reduces the three coexisting per-side tier booleans to the ONE tier whose
 * weight the Signal Engine credits. First match wins, highest tier first, and
 * tiers NEVER add up: a bar with both a D1 and an H1 zone nearby qualifies as
 * D1 and scores 30, not 40. This is `f_liquidityWeight`
 * (src/modules/signal-engine.pine:64-66) expressed without the weights, and
 * the same precedence as signal-engine.mjs:355-362 and binary.mjs:330-347.
 *
 * @param {{d1: boolean, h4: boolean, h1: boolean}} flags — one SIDE's tier flags.
 * @returns {"D1"|"H4"|"H1"|null} the qualifying tier, or null if none.
 */
export function qualifyingTier({ d1, h4, h1 }) {
  if (d1) return "D1";
  if (h4) return "H4";
  if (h1) return "H1";
  return null;
}

/**
 * Which side of the first-bar-where-a-D1-zone-exists boundary a bar falls on.
 *
 * `firstD1ZoneBar === null` (no D1 zone ever exists in this run) puts every
 * bar on the PRE side, because a split with no post side reports nothing. The
 * report prints that degeneracy rather than hiding it.
 */
export function phaseOf(barIndex, firstD1ZoneBar) {
  if (firstD1ZoneBar === null || barIndex < firstD1ZoneBar) return PHASE_PRE;
  return PHASE_POST;
}

/** A zeroed qualifying-tier tally. Keys are fixed so JSON key order is stable. */
export function newTally() {
  return {
    bars: 0,
    anyFlag: 0,
    D1: 0,
    H4: 0,
    H1: 0,
    none: 0,
    // Contradiction counters. Both are structurally impossible in a correct
    // port (the side flag and the tier flags are assigned in the same branch
    // of liquidity-zones.mjs:463-473), so a non-zero value here IS the defect.
    flagWithoutTier: 0,
    tierWithoutFlag: 0,
  };
}

/**
 * Records ONE bar's tier observation into a tally.
 *
 * Both the qualifying tier and the two structural contradictions are counted
 * here rather than at the call site, so the invariants are enforced by the one
 * code path every measurement in the report goes through.
 */
export function recordTier(tally, { anyFlag, d1, h4, h1 }) {
  tally.bars += 1;
  if (anyFlag) tally.anyFlag += 1;
  else tally.none += 1;

  const tier = qualifyingTier({ d1, h4, h1 });
  if (tier !== null) tally[tier] += 1;

  if (anyFlag && tier === null) tally.flagWithoutTier += 1;
  if (!anyFlag && tier !== null) tally.tierWithoutFlag += 1;
  return tier;
}

/** A two-phase tally pair, for the warm-up boundary split (section F). */
export function newSplit() {
  return {
    [PHASE_PRE]: { long: newTally(), short: newTally() },
    [PHASE_POST]: { long: newTally(), short: newTally() },
  };
}

/** Records one bar into the matching phase of a split. */
export function recordSplit(split, barIndex, firstD1ZoneBar, sides) {
  recordTier(split[phaseOf(barIndex, firstD1ZoneBar)].long, sides.long);
  recordTier(split[phaseOf(barIndex, firstD1ZoneBar)].short, sides.short);
}

/** Zeroed per-side near-tier counters (section E: proximity, gates ignored). */
export function newNearTally() {
  return { bars: 0, D1: 0, H4: 0, H1: 0, any: 0, none: 0 };
}

export function recordNear(tally, { d1, h4, h1 }) {
  tally.bars += 1;
  if (d1) tally.D1 += 1;
  if (h4) tally.H4 += 1;
  if (h1) tally.H1 += 1;
  if (d1 || h4 || h1) tally.any += 1;
  else tally.none += 1;
}

// ─── Formatting helpers ──────────────────────────────────────────────────────

const iso = (ms) => new Date(ms).toISOString();
const int = (v) => Number(v).toLocaleString("en-US");
const round = (v, dp) => (v === null || v === undefined ? null : Number(v.toFixed(dp)));
const padL = (s, w) => String(s).padEnd(w);
const padR = (s, w) => String(s).padStart(w);

/** Percent with an explicit "n/a" for a zero denominator — never a silent 0%. */
function pct(num, den, dp = 2) {
  if (!den) return "n/a";
  return `${((num / den) * 100).toFixed(dp)}%`;
}

function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function summarise(values) {
  if (values.length === 0) {
    return { count: 0, min: null, p50: null, p90: null, max: null, mean: null };
  }
  const sorted = [...values].sort((a, b) => a - b);
  let sum = 0;
  for (const v of sorted) sum += v;
  return {
    count: sorted.length,
    min: round(sorted[0], 4),
    p50: round(quantile(sorted, 0.5), 4),
    p90: round(quantile(sorted, 0.9), 4),
    max: round(sorted[sorted.length - 1], 4),
    mean: round(sum / sorted.length, 4),
  };
}

// ─── Dataset ─────────────────────────────────────────────────────────────────

async function loadDataset(tf) {
  let candles;
  try {
    candles = JSON.parse(await readFile(tf.datasetPath, "utf8")).candles;
  } catch (err) {
    throw new Error(
      `dataset unavailable (${err.message}) at ${tf.datasetRel} — backtest/data/ is ` +
        `gitignored; run \`node backtest/run.mjs fetch --timeframe ${tf.id}\` first`,
    );
  }
  if (!Array.isArray(candles) || candles.length === 0) {
    throw new Error(`dataset at ${tf.datasetRel} has no candles`);
  }
  let meta = null;
  try {
    meta = JSON.parse(await readFile(tf.metaPath, "utf8"));
  } catch {
    meta = null;
  }
  return { candles, meta };
}

// ─── HTF aggregation (identical contract to baseline.mjs:224-268) ────────────
//
// Re-implemented rather than imported on purpose: importing baseline.mjs and
// calling its internals would couple this diagnostic to the file the
// orchestrator must not have perturbed. The shape is the one Pine's
// request.security(..., lookahead_off) implies — a completed HTF bar becomes
// visible on the chart bar where its last 5m candle closes, then holds.

function createHtfSeries(tfMs, nativeStepMs) {
  let bucket = null;
  let acc = null;
  let droppedBuckets = 0;
  return {
    get droppedBuckets() {
      return droppedBuckets;
    },
    feed(c) {
      const b = Math.floor(c.t / tfMs) * tfMs;
      if (b !== bucket) {
        if (bucket !== null) droppedBuckets += 1;
        bucket = b;
        acc = { t: b + tfMs, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v };
      } else {
        acc.h = Math.max(acc.h, c.h);
        acc.l = Math.min(acc.l, c.l);
        acc.c = c.c;
        acc.v += c.v;
      }
      // Completion is tested against the NATIVE step. Hard-coding 5m here would
      // complete no bucket at all on a 1h or 4h dataset, silently emptying the
      // D1 series — the exact failure this diagnostic exists to detect, so it
      // must not be introduced by the measurement harness itself.
      if (c.t + nativeStepMs === bucket + tfMs) {
        const done = acc;
        bucket = null;
        acc = null;
        return done;
      }
      return null;
    },
  };
}

/**
 * A context this native grid CANNOT produce is marked unavailable rather than
 * fed. Pine's request.security(syminfo.tickerid, "60", ...) returns 1h bars even
 * on a 4h chart; this harness aggregates only the dataset it was given, so a 4h
 * dataset has no 1h candles to aggregate. Reporting that as an empty tier would
 * read as a finding rather than as the limitation it is.
 */
function createHtfContext(tfMs, tf, available) {
  return {
    available,
    series: available ? createHtfSeries(tfMs, tf.stepMs) : null,
    atr: createAtr({ length: 14 }),
    atrValue: null,
    liqPivot: createPivotDetector({ pivotLenHigh: 10, pivotLenLow: 10 }),
    liq: { high: null, low: null },
  };
}

// ─── Accumulator scaffolding ─────────────────────────────────────────────────

function newZoneProximity() {
  return {
    // Bar-zone pairs observed (a zone live on a bar is one pair).
    pairs: 0,
    // Pairs whose centre is within the proximity band, |close - center| <=
    // atrChart * proxATRMult. Side-agnostic on purpose: this measures "is
    // price AT the zone", not "does the LONG score see it".
    near: 0,
    // Of those, how many the port refuses to report as near because the bar's
    // range overlaps the zone body (liquidity-zones.mjs:458). This is the
    // single most important split in the whole diagnostic.
    nearInBody: 0,
    nearNotInBody: 0,
    nearLongSide: 0,
    nearShortSide: 0,
    // |close - center| expressed in PROXIMITY BANDS. 1.0 is the edge of the
    // band; >1.0 is outside it. Collected for D1 and H4 only (see the note at
    // the collection site) — H1 zones are too numerous to retain per bar.
    distanceBands: [],
    minDistanceBands: null,
    // Zone half-widths, retained for every tier. The MECHANISM behind the whole
    // finding lives here: a zone body is 0.5 x its own timeframe's ATR, while
    // the proximity band is 3 x the 5m chart ATR. The larger the timeframe,
    // the wider the body the bar has already crossed before it can be "near".
    halfWidths: [],
    // Chart proximity band width on every bar this tier had a live zone, so
    // halfWidth can be read as a fraction of it rather than in absolute terms.
    bandWidths: [],
  };
}

function newPhaseAcc() {
  return {
    bars: 0,
    tier: { long: newTally(), short: newTally() },
    near: { long: newNearTally(), short: newNearTally() },
    candidates: { long: 0, short: 0 },
    candidateTier: { long: newTally(), short: newTally() },
    liveZoneBars: { D1: 0, H4: 0, H1: 0 },
    created: { D1: 0, H4: 0, H1: 0 },
  };
}

// ─── The diagnostic ──────────────────────────────────────────────────────────

function runDiagnostic(candles, meta, tf) {
  const n = candles.length;
  const proxBand = LIQUIDITY_ZONE_DEFAULTS.proxATRMult;
  const barsPerDay = MS_1D / tf.stepMs;

  // ── Module instances: shipped defaults everywhere, exactly as baseline ────
  const session = createSessionMarkers();
  const chartAtr = createAtr({ length: 14 });
  const avail = htfAvailability(tf.stepMs);
  const ctx = {
    h1: createHtfContext(MS_1H, tf, avail.available.h1),
    h4: createHtfContext(MS_4H, tf, avail.available.h4),
    d1: createHtfContext(MS_1D, tf, avail.available.d1),
  };
  const structPivot = createPivotDetector({ pivotLenHigh: 5, pivotLenLow: 5 });
  const zones = createLiquidityZones();
  const structure = createStructureBreak();
  const imbalance = createImbalanceDetector();
  const weighted = createSignalEngine();
  const binary = createBinarySignalModel();

  // ── Accumulators ──────────────────────────────────────────────────────────
  const acc = {
    bars: n,
    tier: { long: newTally(), short: newTally() },
    near: { long: newNearTally(), short: newNearTally() },
    candidateTier: { long: newTally(), short: newTally() },
    candidates: { long: 0, short: 0 },

    zones: {
      livePairs: { D1: 0, H4: 0, H1: 0 },
      liveBars: { D1: 0, H4: 0, H1: 0 },
      created: { D1: 0, H4: 0, H1: 0 },
      firstCreation: { D1: null, H4: null, H1: null },
      lastCreation: { D1: null, H4: null, H1: null },
      firstLive: { D1: null, H4: null, H1: null },
      lastLive: { D1: null, H4: null, H1: null },
      peakLive: { D1: 0, H4: 0, H1: 0 },
      proximity: { D1: newZoneProximity(), H4: newZoneProximity(), H1: newZoneProximity() },
    },

    // Section D2 — what the tier costs in points, measured not assumed.
    candidateScoreByTier: { D1: [], H4: [], H1: [] },
    candidateNonTierPoints: { D1: [], H4: [], H1: [] },
    candidateScoreAtOrAboveThreshold: { D1: 0, H4: 0, H1: 0 },

    phase: { [PHASE_PRE]: newPhaseAcc(), [PHASE_POST]: newPhaseAcc() },

    firstD1ZoneBar: null,
    firstD1PivotBar: null,
    droppedBuckets: { h1: 0, h4: 0, d1: 0 },
  };

  let structPivots = { high: null, low: null };

  for (let i = 0; i < n; i++) {
    const c = candles[i];

    const sm = session.evaluate({ t: c.t });
    const atrChart = chartAtr.update({ high: c.h, low: c.l, close: c.c });

    const h1Bar = ctx.h1.available ? ctx.h1.series.feed(c) : null;
    if (h1Bar) {
      const p = ctx.h1.liqPivot.update({ high: h1Bar.h, low: h1Bar.l });
      ctx.h1.liq = { high: p.pivotHigh, low: p.pivotLow };
      ctx.h1.atrValue = ctx.h1.atr.update({ high: h1Bar.h, low: h1Bar.l, close: h1Bar.c });
      const sp = structPivot.update({ high: h1Bar.h, low: h1Bar.l });
      structPivots = { high: sp.pivotHigh, low: sp.pivotLow };
    }
    const h4Bar = ctx.h4.available ? ctx.h4.series.feed(c) : null;
    if (h4Bar) {
      const p = ctx.h4.liqPivot.update({ high: h4Bar.h, low: h4Bar.l });
      ctx.h4.liq = { high: p.pivotHigh, low: p.pivotLow };
      ctx.h4.atrValue = ctx.h4.atr.update({ high: h4Bar.h, low: h4Bar.l, close: h4Bar.c });
    }
    const d1Bar = ctx.d1.available ? ctx.d1.series.feed(c) : null;
    if (d1Bar) {
      const p = ctx.d1.liqPivot.update({ high: d1Bar.h, low: d1Bar.l });
      ctx.d1.liq = { high: p.pivotHigh, low: p.pivotLow };
      ctx.d1.atrValue = ctx.d1.atr.update({ high: d1Bar.h, low: d1Bar.l, close: d1Bar.c });
      if (
        acc.firstD1PivotBar === null &&
        (ctx.d1.liq.high !== null || ctx.d1.liq.low !== null)
      ) {
        acc.firstD1PivotBar = i;
      }
    }

    const lz = zones.evaluate({
      barIndex: i,
      high: c.h,
      low: c.l,
      close: c.c,
      atrChart,
      atrH4: ctx.h4.atrValue,
      atrD1: ctx.d1.atrValue,
      atrH1: ctx.h1.atrValue,
      pivots: {
        d1High: ctx.d1.liq.high,
        d1Low: ctx.d1.liq.low,
        h4High: ctx.h4.liq.high,
        h4Low: ctx.h4.liq.low,
        h1High: ctx.h1.liq.high,
        h1Low: ctx.h1.liq.low,
      },
    });

    const sb = structure.evaluate({
      barIndex: i,
      close: c.c,
      pivots: { high: structPivots.high, low: structPivots.low },
    });
    const im = imbalance.evaluate({
      barIndex: i,
      high: c.h,
      low: c.l,
      close: c.c,
      volume: c.v,
      atrChart,
    });

    const engineBar = {
      barIndex: i,
      sessionStrength: sm.sessionStrength,
      inOverlap: sm.inOverlap,
      inLondon: sm.inLondon,
      inNY: sm.inNY,
      inAsia: sm.inAsia,
      nearLiquidityLong: lz.nearLiquidityLong,
      nearLiquidityShort: lz.nearLiquidityShort,
      nearD1LiquidityLong: lz.nearD1LiquidityLong,
      nearH4LiquidityLong: lz.nearH4LiquidityLong,
      nearH1LiquidityLong: lz.nearH1LiquidityLong,
      nearD1LiquidityShort: lz.nearD1LiquidityShort,
      nearH4LiquidityShort: lz.nearH4LiquidityShort,
      nearH1LiquidityShort: lz.nearH1LiquidityShort,
      breakUp: sb.breakUp,
      breakDown: sb.breakDown,
      structureFlipped: sb.structureFlipped,
      marketStructure: sb.marketStructure,
      nearImbalanceLong: im.nearImbalanceLong,
      nearImbalanceShort: im.nearImbalanceShort,
      inImbalanceLong: im.inImbalanceLong,
      inImbalanceShort: im.inImbalanceShort,
      volumeConfirmed: im.volumeConfirmed,
    };

    const w = weighted.evaluate(engineBar);
    const b = binary.evaluate(engineBar);

    // ── Section B: the qualifying tier on EVERY bar ─────────────────────────
    const sides = {
      long: {
        anyFlag: Boolean(lz.nearLiquidityLong),
        d1: Boolean(lz.nearD1LiquidityLong),
        h4: Boolean(lz.nearH4LiquidityLong),
        h1: Boolean(lz.nearH1LiquidityLong),
      },
      short: {
        anyFlag: Boolean(lz.nearLiquidityShort),
        d1: Boolean(lz.nearD1LiquidityShort),
        h4: Boolean(lz.nearH4LiquidityShort),
        h1: Boolean(lz.nearH1LiquidityShort),
      },
    };
    const longTier = recordTier(acc.tier.long, sides.long);
    const shortTier = recordTier(acc.tier.short, sides.short);

    // ── Section E: proximity isolated from every other gate ─────────────────
    recordNear(acc.near.long, sides.long);
    recordNear(acc.near.short, sides.short);

    // ── Section C: the zone array itself, and per-zone geometry ─────────────
    const livePerTier = { D1: 0, H4: 0, H1: 0 };
    const createdPerTier = { D1: 0, H4: 0, H1: 0 };
    const proxUsable = atrChart !== null && atrChart !== undefined;
    const proxWidth = proxUsable ? atrChart * proxBand : null;

    for (const z of lz.zones) {
      const name = TIER_OF_INDEX[z.tier];
      if (name === undefined) continue;
      livePerTier[name] += 1;
      acc.zones.livePairs[name] += 1;
      if (acc.zones.peakLive[name] < livePerTier[name]) acc.zones.peakLive[name] = livePerTier[name];
      if (z.bornBar === i) {
        createdPerTier[name] += 1;
        acc.zones.created[name] += 1;
        if (acc.zones.firstCreation[name] === null) acc.zones.firstCreation[name] = i;
        acc.zones.lastCreation[name] = i;
      }

      const p = acc.zones.proximity[name];
      p.pairs += 1;
      p.halfWidths.push(z.halfWidth);
      if (proxUsable) {
        const inBody = c.h >= z.center - z.halfWidth && c.l <= z.center + z.halfWidth;
        const distance = Math.abs(c.c - z.center);
        const near = distance <= proxWidth;
        if (near) {
          p.near += 1;
          if (inBody) p.nearInBody += 1;
          else p.nearNotInBody += 1;
          if (z.center < c.c) p.nearLongSide += 1;
          else p.nearShortSide += 1;
        }
        // Distance is retained in PROXIMITY BANDS for D1 and H4 only. H1 zones
        // would contribute on the order of two million pairs over this run and
        // they are not what is under investigation; their counters above are
        // exact and the omission is stated in the report.
        if (name !== "H1" && proxWidth > 0) {
          const bands = distance / proxWidth;
          p.distanceBands.push(bands);
          if (p.minDistanceBands === null || bands < p.minDistanceBands) {
            p.minDistanceBands = bands;
          }
        }
      }
    }

    for (const name of TIER_NAMES) {
      if (livePerTier[name] > 0) {
        acc.zones.liveBars[name] += 1;
        if (acc.zones.firstLive[name] === null) acc.zones.firstLive[name] = i;
        acc.zones.lastLive[name] = i;
        if (proxUsable) acc.zones.proximity[name].bandWidths.push(proxWidth);
      }
    }
    if (acc.zones.liveBars.D1 > 0 && acc.firstD1ZoneBar === null) acc.firstD1ZoneBar = i;

    // ── Section D: candidates, and the tier they qualified at ───────────────
    if (b.longSignalStrict) {
      acc.candidates.long += 1;
      recordTier(acc.candidateTier.long, sides.long);
      if (longTier !== null) {
        acc.candidateScoreByTier[longTier].push(w.longScore);
        if (w.longScore >= weighted.defaults.minConfidence) {
          acc.candidateScoreAtOrAboveThreshold[longTier] += 1;
        }
        const f = w.longFactors;
        acc.candidateNonTierPoints[longTier].push(
          f.session + f.structure + f.imbalance + f.volume,
        );
      }
    }
    if (b.shortSignalStrict) {
      acc.candidates.short += 1;
      recordTier(acc.candidateTier.short, sides.short);
      if (shortTier !== null) {
        acc.candidateScoreByTier[shortTier].push(w.shortScore);
        if (w.shortScore >= weighted.defaults.minConfidence) {
          acc.candidateScoreAtOrAboveThreshold[shortTier] += 1;
        }
        const f = w.shortFactors;
        acc.candidateNonTierPoints[shortTier].push(
          f.session + f.structure + f.imbalance + f.volume,
        );
      }
    }

    // ── Section F: the same numbers, split at the D1 warm-up boundary ───────
    // Resolved EVERY bar so a D1 zone born mid-run cannot be attributed to the
    // post phase retroactively.
    const phase = acc.phase[phaseOf(i, acc.firstD1ZoneBar)];
    phase.bars += 1;
    recordTier(phase.tier.long, sides.long);
    recordTier(phase.tier.short, sides.short);
    recordNear(phase.near.long, sides.long);
    recordNear(phase.near.short, sides.short);
    if (b.longSignalStrict) {
      phase.candidates.long += 1;
      recordTier(phase.candidateTier.long, sides.long);
    }
    if (b.shortSignalStrict) {
      phase.candidates.short += 1;
      recordTier(phase.candidateTier.short, sides.short);
    }
    for (const name of TIER_NAMES) {
      if (livePerTier[name] > 0) phase.liveZoneBars[name] += 1;
      phase.created[name] += createdPerTier[name];
    }
  }

  acc.droppedBuckets = {
    h1: ctx.h1.available ? ctx.h1.series.droppedBuckets : null,
    h4: ctx.h4.available ? ctx.h4.series.droppedBuckets : null,
    d1: ctx.d1.available ? ctx.d1.series.droppedBuckets : null,
  };

  // ── Derive the comparison figures the report prints ───────────────────────

  for (const name of TIER_NAMES) {
    const p = acc.zones.proximity[name];
    p.distanceSummary = summarise(p.distanceBands);
    p.halfWidthSummary = summarise(p.halfWidths);
    p.bandWidthSummary = summarise(p.bandWidths);
    // How wide a zone body is relative to the proximity band it sits inside. A
    // ratio >= 1 means the band is entirely swallowed by the body: any bar whose
    // close is inside the band is also inside the body, so the port can never
    // report the zone as near. This ratio IS the mechanism.
    p.bodyToBandRatio =
      p.bandWidthSummary.p50 && p.halfWidthSummary.p50 !== null
        ? round(p.halfWidthSummary.p50 / p.bandWidthSummary.p50, 3)
        : null;
    // The retained arrays are diagnostic detail, not payload.
    delete p.distanceBands;
    delete p.halfWidths;
    delete p.bandWidths;
  }

  const mix = (tally) => {
    const denom = tally.D1 + tally.H4 + tally.H1;
    return {
      bars: tally.bars,
      anyFlag: tally.anyFlag,
      none: tally.none,
      counts: { D1: tally.D1, H4: tally.H4, H1: tally.H1, total: denom },
      percentOfFlagged: {
        D1: pct(tally.D1, denom),
        H4: pct(tally.H4, denom),
        H1: pct(tally.H1, denom),
      },
      share: {
        D1: denom ? tally.D1 / denom : null,
        H4: denom ? tally.H4 / denom : null,
        H1: denom ? tally.H1 / denom : null,
      },
      contradictions: { flagWithoutTier: tally.flagWithoutTier, tierWithoutFlag: tally.tierWithoutFlag },
    };
  };

  // Lift = candidate share of a tier / global share of that tier. 1.00 means
  // candidates are drawn from the tier mix at random; >1 means something is
  // selecting FOR that tier at signal moments; <1 means selecting against it.
  const lift = (candidateShare, globalShare) =>
    globalShare && globalShare > 0 ? round(candidateShare / globalShare, 3) : null;

  const comparison = {};
  for (const side of ["long", "short"]) {
    const globalMix = mix(acc.tier[side]);
    const candMix = mix(acc.candidateTier[side]);
    comparison[side] = {
      global: globalMix,
      candidates: candMix,
      lift: {
        D1: lift(candMix.share.D1, globalMix.share.D1),
        H4: lift(candMix.share.H4, globalMix.share.H4),
        H1: lift(candMix.share.H1, globalMix.share.H1),
      },
    };
  }

  // ── The verdict, derived — never hard-coded ───────────────────────────────

  const nearFlagsTotal = {
    D1: acc.near.long.D1 + acc.near.short.D1,
    H4: acc.near.long.H4 + acc.near.short.H4,
    H1: acc.near.long.H1 + acc.near.short.H1,
  };
  const d1Built = acc.zones.created.D1 > 0 && acc.zones.liveBars.D1 > 0;
  const h4Built = acc.zones.created.H4 > 0 && acc.zones.liveBars.H4 > 0;

  /** "1.677x" for a measured ratio, "n/a" for an unmeasurable one — never "n/ax". */
const ratioCell = (v) => (v === null || v === undefined ? "n/a" : `${v.toFixed(3)}x`);

  // ── THE DISCRIMINATOR ─────────────────────────────────────────────────────
  //
  // A D1/H4 tier flag CAN fire on a bar only if some live zone of that tier was
  // within the proximity band AND the bar's range did not overlap the zone body
  // (liquidity-zones.mjs:458, liquidity-zones.pine:305). So:
  //
  //   notInBody pairs > 0  and  tier flag == 0   ->  DEFECT. The eligibility
  //                                                  condition held and the
  //                                                  flag did not follow.
  //   notInBody pairs == 0 and  tier flag == 0   ->  NOT a defect. Price never
  //                                                  reached the zone from
  //                                                  outside its own body, so
  //                                                  there was nothing for the
  //                                                  flag to report.
  //
  // Reading a non-zero `near` count as a defect WITHOUT the in-body split is
  // exactly the mistake this diagnostic exists to avoid: a bar deep inside a
  // D1 zone body is in the proximity band and is deliberately not reported.

  const availHere = htfAvailability(tf.stepMs);
  const eligibility = {};
  let defects = 0;
  for (const name of TIER_NAMES) {
    const notInBody = acc.zones.proximity[name].nearNotInBody;
    const flag = nearFlagsTotal[name];
    const consistent = (notInBody > 0) === (flag > 0);
    // A tier the native grid cannot produce is NOT a defect: there was never a
    // series to populate. Counting it as one would report the harness's data
    // choice as a bug in the port.
    const producible = availHere.available[name.toLowerCase()];
    if (producible && !consistent) defects += 1;
    eligibility[name] = {
      // "built" = this grid can produce the tier at all. Distinct from
      // "populated" (d1Built), which asks whether zones actually appeared.
      producible,
      built: name === "D1" ? d1Built : name === "H4" ? h4Built : true,
      barZonePairs: acc.zones.proximity[name].pairs,
      withinBand: acc.zones.proximity[name].near,
      withinBandInBody: acc.zones.proximity[name].nearInBody,
      withinBandNotInBody: notInBody,
      tierFlagFires: flag,
      consistent,
      bodyToBandRatio: acc.zones.proximity[name].bodyToBandRatio,
    };
  }

  const d1 = eligibility.D1;
  const d1Eligible = d1.withinBandNotInBody;

  let verdictLabel;
  let verdictLine;
  let verdictSupport = [];

  if (defects > 0) {
    verdictLabel = "defect";
    const broken = TIER_NAMES.filter((name) => !eligibility[name].consistent);
    verdictLine =
      `the tier flag does not follow the eligibility condition for: ${broken.join(", ")}`;
    for (const name of broken) {
      const e = eligibility[name];
      verdictSupport.push(
        `${name}: ${int(e.withinBandNotInBody)} bar-zone pairs were within the band and NOT ` +
          `in-body — eligible to fire the flag — yet the flag fired ${int(e.tierFlagFires)} times.`,
      );
    }
  } else if (!d1Built) {
    verdictLabel = "inconclusive";
    verdictLine =
      "the D1 series never populates a live zone, so the D1 tier cannot be tested at all";
    verdictSupport.push(
      "D1 zones created: 0. Nothing downstream of zone creation can be inferred from this run.",
    );
  } else if (d1Eligible === 0) {
    verdictLabel = "property of the data";
    verdictLine =
      "the D1 series populates correctly, and price is never within the proximity band of a D1 " +
      "zone while outside its body — so the D1 tier is unreachable on this dataset by geometry";
    verdictSupport.push(
      `D1 zones created ${int(acc.zones.created.D1)}, live on ${int(acc.zones.liveBars.D1)} of ` +
        `${int(n)} bars. Within the ${proxBand} x chart-ATR band on ` +
        `${int(d1.withinBand)} bar-zone pairs, of which ${int(d1.withinBandInBody)} were in-body ` +
        `and ${int(d1.withinBandNotInBody)} were eligible to fire the flag. The flag fired ` +
        `${int(d1.tierFlagFires)} times — consistent with zero eligibility, not a broken flag.`,
    );
    verdictSupport.push(
      `mechanism: a D1 zone body is half a D1 ATR wide, the proximity band is ${proxBand} ` +
        `x the CHART (${tf.id}) ATR. Median D1 body / median band = ` +
        `${d1.bodyToBandRatio ?? "n/a"}x — the body is ` +
        `${d1.bodyToBandRatio !== null && d1.bodyToBandRatio >= 1 ? "wider" : "narrower"} ` +
        "than the band, so price is " +
        `${d1.bodyToBandRatio !== null && d1.bodyToBandRatio >= 1 ? "already inside the zone before it is ever near it" : "near the zone from outside its body"}.`,
    );
  } else {
    verdictLabel = "property of the data";
    verdictLine = `the D1 tier does qualify, on ${int(nearFlagsTotal.D1)} bars across both sides`;
    verdictSupport.push(
      `D1 zones within the band on ${int(d1.withinBand)} bar-zone pairs, ` +
        `${int(d1.withinBandNotInBody)} of them eligible; the flag fired ` +
        `${int(d1.tierFlagFires)} times.`,
    );
  }

  if (verdictLabel === "property of the data") {
    // Every tier is reported, INCLUDING the ones this grid cannot produce — a
    // 4h run has no 1h candles, so "H1 fired 0 times" must not be mistaken for a
    // finding about the H1 tier.
    const availNames = htfAvailability(tf.stepMs).unavailable.map((t) => t.name);
    if (availNames.length > 0) {
      verdictSupport.push(
        `NOT MEASURED ON THIS GRID: ${availNames.join(", ")} is finer than the native ` +
          `${tf.id} grid, so it has no candles to aggregate. Pine's request.security ` +
          "would still fetch it from the exchange on a coarser chart; this harness " +
          "cannot. Any zero for that tier below is a LIMITATION OF THE DATA, not a " +
          "finding about the tier.",
      );
    }
    verdictSupport.push(
      `4H zones created ${int(acc.zones.created.H4)}, live on ${int(acc.zones.liveBars.H4)} bars; ` +
        `within the band on ${int(eligibility.H4.withinBand)} pairs ` +
        `(${int(eligibility.H4.withinBandInBody)} in-body, ${int(eligibility.H4.withinBandNotInBody)} ` +
        `eligible); nearH4 fired ${int(nearFlagsTotal.H4)} times; median body/band ratio ` +
        `${ratioCell(eligibility.H4.bodyToBandRatio)}. ` +
        (eligibility.H1.producible
          ? `H1: ${int(eligibility.H1.withinBandNotInBody)} eligible pairs, nearH1 fired ` +
            `${int(nearFlagsTotal.H1)} times, ratio ${ratioCell(eligibility.H1.bodyToBandRatio)}.`
          : "H1: not measured on this grid (see above)."),
    );
    for (const side of ["long", "short"]) {
      const g = comparison[side].global;
      const c = comparison[side].candidates;
      const share = (mix2, name) =>
        mix2.share[name] === null ? "n/a" : `${(mix2.share[name] * 100).toFixed(2)}%`;
      verdictSupport.push(
        `${side}: candidate tier lift vs global — D1 ${comparison[side].lift.D1 ?? "n/a"}, ` +
          `H4 ${comparison[side].lift.H4 ?? "n/a"}, H1 ${comparison[side].lift.H1 ?? "n/a"} ` +
          `(1.00 = candidates drawn from the global mix unchanged). ` +
          `H1 share: global ${share(g, "H1")}, candidates ${share(c, "H1")}.`,
      );
    }
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    ok: true,
    question:
      "Is the H1-only tier mix at candidate bars a property of the data or a defect in the port?",
    verdict: {
      label: verdictLabel,
      oneLine: verdictLine,
      support: verdictSupport,
    },
    rule: {
      port: {
        tierStamp: "backtest/modules/liquidity-zones.mjs:329",
        slotOrder: "backtest/modules/liquidity-zones.mjs:318-325",
        perSideTierFlags: "backtest/modules/liquidity-zones.mjs:458-473",
        reduction: "backtest/modules/signal-engine.mjs:355-362",
        reductionTwin: "backtest/modules/binary.mjs:330-347",
      },
      pine: {
        tierStamp: "src/modules/liquidity-zones.pine:189",
        slotOrder: "src/modules/liquidity-zones.pine:180-185",
        perSideTierFlags: "src/modules/liquidity-zones.pine:305-321",
        reduction: "src/modules/signal-engine.pine:64-66",
        reductionCall: "src/modules/signal-engine.pine:102-103",
      },
      matchesPine: true,
      notes: [
        "The port does not put the reduction in liquidity-zones.mjs. That module stamps a tier " +
          "onto each zone and emits six COEXISTING per-side per-tier booleans; the single " +
          "qualifying tier is a first-match-wins ternary in signal-engine.mjs (and its identical " +
          "shadow copy in binary.mjs). Pine splits it the same way: liquidity-zones.pine emits " +
          "the six booleans and signal-engine.pine:64-66 reduces them.",
        "The only intentional divergence is WHERE the weight literals live. Pine hard-codes " +
          "30/20/10 inside f_liquidityWeight; the port lifts them into SIGNAL_ENGINE_DEFAULTS " +
          "so T12 can search them. A plain createSignalEngine() reproduces the shipped values.",
      ],
    },
    dataset: {
      path: tf.datasetRel,
      bars: n,
      firstIso: candles.length ? iso(candles[0].t) : null,
      lastIso: candles.length ? iso(candles[n - 1].t) : null,
      spanDays: meta?.spanDays ?? null,
      status: meta?.status ?? null,
    },
    timeframe: {
      id: tf.id,
      nativeStepMs: tf.stepMs,
      minutesPerBar: tf.minutesPerBar,
      barsPerDailyBar: barsPerDay,
      // RECOMPUTED per grid, never copied from the 5m run.
      d1PivotWarmupNativeBars: nativeBarsForDays(21, tf.stepMs),
      d1AtrWarmupNativeBars: nativeBarsForDays(14, tf.stepMs),
      unavailableHtf: htfAvailability(tf.stepMs).unavailable.map((t) => t.name),
      note:
        `the proximity band is ${proxBand} x ATR(14) of the NATIVE ${tf.id} series, so ` +
        "bodyToBandRatio below is a property of this grid as much as of the geometry.",
    },
    config: {
      proximityBandAtrMult: proxBand,
      maxZones: LIQUIDITY_ZONE_DEFAULTS.maxZones,
      minConfidence: weighted.defaults.minConfidence,
      maxScore: weighted.maxScore,
      liquidityWeights: { D1: TIER_WEIGHT.D1, H4: TIER_WEIGHT.H4, H1: TIER_WEIGHT.H1 },
    },
    sectionB_globalTierMix: {
      long: mix(acc.tier.long),
      short: mix(acc.tier.short),
    },
    sectionC_zonePopulation: {
      d1Built,
      h4Built,
      droppedBuckets: acc.droppedBuckets,
      tierEligibility: eligibility,
      eligibilityRule:
        "a tier flag can fire only on a bar where a live zone of that tier was within the " +
        "proximity band AND the bar's range did not overlap the zone body " +
        "(liquidity-zones.mjs:458). 'consistent' means (eligible pairs > 0) === (flag fires > 0); " +
        "an inconsistency is a defect, and zero eligibility is not one.",
      perTier: Object.fromEntries(
        TIER_NAMES.map((name) => [
          name,
          {
            created: acc.zones.created[name],
            liveBars: acc.zones.liveBars[name],
            livePairs: acc.zones.livePairs[name],
            peakLiveOnOneBar: acc.zones.peakLive[name],
            firstCreationBar: acc.zones.firstCreation[name],
            lastCreationBar: acc.zones.lastCreation[name],
            firstCreationIso:
              acc.zones.firstCreation[name] === null
                ? null
                : iso(candles[acc.zones.firstCreation[name]].t),
            lastCreationIso:
              acc.zones.lastCreation[name] === null
                ? null
                : iso(candles[acc.zones.lastCreation[name]].t),
            firstLiveBar: acc.zones.firstLive[name],
            lastLiveBar: acc.zones.lastLive[name],
            proximity: {
              barZonePairs: acc.zones.proximity[name].pairs,
              withinBand: acc.zones.proximity[name].near,
              withinBandButInBody: acc.zones.proximity[name].nearInBody,
              withinBandAndNotInBody: acc.zones.proximity[name].nearNotInBody,
              withinBandLongSide: acc.zones.proximity[name].nearLongSide,
              withinBandShortSide: acc.zones.proximity[name].nearShortSide,
              distanceBands: acc.zones.proximity[name].distanceSummary,
              halfWidth: acc.zones.proximity[name].halfWidthSummary,
              proximityBandWidth: acc.zones.proximity[name].bandWidthSummary,
              bodyToBandRatio: acc.zones.proximity[name].bodyToBandRatio,
            },
          },
        ]),
      ),
      firstD1ZoneBar: acc.firstD1ZoneBar,
      firstD1ZoneIso: acc.firstD1ZoneBar === null ? null : iso(candles[acc.firstD1ZoneBar].t),
      firstD1PivotBar: acc.firstD1PivotBar,
      firstD1PivotIso: acc.firstD1PivotBar === null ? null : iso(candles[acc.firstD1PivotBar].t),
    },
    sectionD_candidateVsGlobal: {
      candidates: { long: acc.candidates.long, short: acc.candidates.short },
      comparison,
      selfCheck: {
        // The expected pair is the 5m baseline's 192 long / 201 short. It holds
        // ONLY on 5m: the two wirings must agree on the same dataset and grid, so
        // quoting it on a 1h run would be asserting a number that was never
        // measured. On other timeframes the cross-check is reported as
        // unavailable and the reader is pointed at `baseline --timeframe <id>`.
        note:
          tf.id === "5m"
            ? "this diagnostic re-implements the baseline wiring rather than importing it; " +
              "these counts must match the baseline's 192 long / 201 short raw candidates"
            : `this diagnostic re-implements the baseline wiring rather than importing it; ` +
              `run \`node backtest/run.mjs baseline --timeframe ${tf.id}\` and confirm these ` +
              "counts match THAT run's raw candidates",
        expectedLong: tf.id === "5m" ? 192 : null,
        expectedShort: tf.id === "5m" ? 201 : null,
        long: acc.candidates.long,
        short: acc.candidates.short,
      },
    },
    sectionD2_scoreByTier: Object.fromEntries(
      TIER_NAMES.map((name) => [
        name,
        {
          candidates: acc.candidateScoreByTier[name].length,
          tierWeight: TIER_WEIGHT[name],
          observedScore: summarise(acc.candidateScoreByTier[name]),
          nonTierPoints: summarise(acc.candidateNonTierPoints[name]),
          atOrAboveMinConfidence: acc.candidateScoreAtOrAboveThreshold[name],
          attainableCeiling:
            acc.candidateNonTierPoints[name].length === 0
              ? null
              : TIER_WEIGHT[name] + Math.max(...acc.candidateNonTierPoints[name]),
        },
      ]),
    ),
    sectionE_proximityIsolated: {
      note:
        "counted on every bar, ignoring sessionOK, structure and imbalance entirely — this is " +
        "the raw per-side tier flag, nothing else",
      long: acc.near.long,
      short: acc.near.short,
      combined: nearFlagsTotal,
    },
    sectionF_warmUpSplit: {
      boundaryBar: acc.firstD1ZoneBar,
      boundaryIso: acc.firstD1ZoneBar === null ? null : iso(candles[acc.firstD1ZoneBar].t),
      // 8205 is the bar index the 5m BASELINE reports for the first D1 pivot.
      // It is a property of the 5m grid, not a constant: on 1h the same warm-up
      // arrives at a different index because the native bars are 12x wider.
      // Quoting 8205 against a 1h run would fabricate a disagreement.
      baselineReportedD1PivotBar: tf.id === "5m" ? 8205 : null,
      expectedD1PivotNativeBars: nativeBarsForDays(21, tf.stepMs),
      firstD1PivotBar: acc.firstD1PivotBar,
      phases: acc.phase,
    },
  };
}

// ─── Human-readable report ───────────────────────────────────────────────────
//
// Shape follows cognitive-doc-design: the verdict is the FIRST line, then the
// rule the reader must see before any number can be interpreted (A), then the
// evidence A-F, then what a reader must not over-read.

function printReport(r) {
  // ── Verdict, first ────────────────────────────────────────────────────────
  out(`VERDICT: ${r.verdict.label.toUpperCase()} — ${r.verdict.oneLine}`);
  for (const line of r.verdict.support) out(`  ${line}`);
  out("");
  out(
    `dataset  ${r.dataset.path} — ${int(r.dataset.bars)} bars, ${r.dataset.firstIso} .. ` +
      `${r.dataset.lastIso}, ${r.dataset.spanDays} days`,
  );
  out(
    `config   proximity band = ${r.config.proximityBandAtrMult} x ATR(14) on the ` +
      `${r.timeframe.id} chart, ` +
      `maxZones ${r.config.maxZones}, minConfidence ${r.config.minConfidence}, ` +
      `maxScore ${r.config.maxScore}, tier weights D1 ${r.config.liquidityWeights.D1} / ` +
      `H4 ${r.config.liquidityWeights.H4} / H1 ${r.config.liquidityWeights.H1}`,
  );
  out(
    `grid     NATIVE ${r.timeframe.id} — ${int(r.timeframe.barsPerDailyBar)} bars per D1 ` +
      `bar; D1 pivot warm-up = 21 daily bars = ` +
      `${int(r.timeframe.d1PivotWarmupNativeBars)} native bars. The proximity band above ` +
      "is an ATR of THIS grid, so body/band ratios are not comparable across grids " +
      "without saying so.",
  );
  if (r.timeframe.unavailableHtf.length > 0) {
    out(
      `grid     NOT MEASURABLE HERE: ${r.timeframe.unavailableHtf.join(", ")} — finer ` +
        "than the native grid, so it has no candles to aggregate. Pine's " +
        "request.security would fetch it anyway; this harness cannot. Zeros for that " +
        "tier are a data limitation, not a finding.",
    );
  }
  out("");

  // ── A. The rule ───────────────────────────────────────────────────────────
  out("A. THE TIER RULE, AS IT ACTUALLY EXISTS");
  out("");
  out("  Read this before any number below. Every percentage is an interpretation of it.");
  out("");
  out("  Step 1 — a tier is STAMPED onto each zone at creation, from the slot it came from.");
  out(
    "    The six confirmed-pivot slots are pushed in tier order: D1 high, D1 low, 4H high, 4H low,",
  );
  out("    1H high, 1H low. The index alone picks the tier: k<2 -> tier 1, k<4 -> tier 2, else 3.");
  out(`    port  ${r.rule.port.slotOrder}  (order), ${r.rule.port.tierStamp}  (mapping)`);
  out(`    pine  ${r.rule.pine.slotOrder}  (order), ${r.rule.pine.tierStamp}  (mapping)`);
  out("");
  out("  Step 2 — on every bar, each LIVE zone is tested for proximity and attributed to a SIDE.");
  out(
    "    A zone counts as near when |close - center| <= atrChart x proxATRMult, and near is",
  );
  out(
    "    refused when the bar's range overlaps the zone body (in-body bars report through swept*,",
  );
  out("    never through near*). The side comes from the sign of (close - center):");
  out("    center < close -> LONG side (demand below price), otherwise SHORT side (supply above).");
  out("    The zone's tier is then OR-ed into that side's tier flag, and nothing is overwritten.");
  out(`    port  ${r.rule.port.perSideTierFlags}`);
  out(`    pine  ${r.rule.pine.perSideTierFlags}`);
  out("");
  out("  Step 3 — SIX coexisting booleans are reduced to ONE qualifying tier, highest wins.");
  out("    First match wins, in the order D1, then 4H, then 1H, else none. Tiers NEVER add up:");
  out("    a bar with both a D1 and a 1H zone nearby qualifies as D1 and scores 30, not 40.");
  out(
    "    The reduction is NOT in the liquidity-zones module on either side of the port — it is a",
  );
  out("    direction-blind helper applied per side at the scoring site.");
  out(`    port  ${r.rule.port.reduction}  (weights from SIGNAL_ENGINE_DEFAULTS)`);
  out(`          ${r.rule.port.reductionTwin}  (binary model's identical shadow copy)`);
  out(`    pine  ${r.rule.pine.reduction}  (weights are literals 30/20/10)`);
  out(`          ${r.rule.pine.reductionCall}  (one call per side)`);
  out("");
  out(`  DOES THE PORT MATCH THE PINE?  ${r.rule.matchesPine ? "YES" : "NO"}`);
  for (const note of r.rule.notes) out(`    - ${note}`);
  out("");

  // ── B. Global tier distribution ───────────────────────────────────────────
  out(`B. GLOBAL TIER DISTRIBUTION — all ${int(r.dataset.bars)} bars, not just candidates`);
  out("");
  for (const side of ["long", "short"]) {
    const m = r.sectionB_globalTierMix[side];
    out(
      `  ${side.toUpperCase()} side — nearLiquidity${side === "long" ? "Long" : "Short"} true on ` +
        `${int(m.anyFlag)} of ${int(m.bars)} bars (${pct(m.anyFlag, m.bars)}); ` +
        `no liquidity flag on ${int(m.none)} bars (${pct(m.none, m.bars)})`,
    );
    out(
      `    qualifying tier, of the ${int(m.counts.total)} bars with a flag:  ` +
        `D1 ${int(m.counts.D1)} (${m.percentOfFlagged.D1})   ` +
        `H4 ${int(m.counts.H4)} (${m.percentOfFlagged.H4})   ` +
        `H1 ${int(m.counts.H1)} (${m.percentOfFlagged.H1})`,
    );
    out(
      `    structural contradictions: flag set with no tier ${m.contradictions.flagWithoutTier}, ` +
        `tier set with no flag ${m.contradictions.tierWithoutFlag} (both impossible in a correct port)`,
    );
  }
  out("");

  // ── C. Do D1 and H4 zones exist? ──────────────────────────────────────────
  out("C. DO D1 AND H4 ZONES EVEN EXIST? — 'never built' and 'never near' are different findings");
  out("");
  out(
    `  ${padL("tier", 6)}${padR("created", 10)}${padR("bars live", 11)}${padR("peak/1 bar", 12)}` +
      `${padR("first creation", 16)}${padR("last creation", 16)}`,
  );
  for (const name of TIER_NAMES) {
    const t = r.sectionC_zonePopulation.perTier[name];
    out(
      `  ${padL(name, 6)}${padR(int(t.created), 10)}${padR(int(t.liveBars), 11)}` +
        `${padR(int(t.peakLiveOnOneBar), 12)}` +
        `${padR(t.firstCreationBar === null ? "never" : int(t.firstCreationBar), 16)}` +
        `${padR(t.lastCreationBar === null ? "never" : int(t.lastCreationBar), 16)}`,
    );
  }
  out(
    `  D1 zones exist: ${r.sectionC_zonePopulation.d1Built ? "YES" : "NO"}.  ` +
      `4H zones exist: ${r.sectionC_zonePopulation.h4Built ? "YES" : "NO"}.`,
  );
  out(
    `  first bar with a live D1 zone: ` +
      `${r.sectionC_zonePopulation.firstD1ZoneBar === null ? "never" : int(r.sectionC_zonePopulation.firstD1ZoneBar)}` +
      ` (${r.sectionC_zonePopulation.firstD1ZoneIso ?? "n/a"});  ` +
      `first confirmed D1 pivot: ` +
      `${r.sectionC_zonePopulation.firstD1PivotBar === null ? "never" : int(r.sectionC_zonePopulation.firstD1PivotBar)}` +
      ` (${r.sectionC_zonePopulation.firstD1PivotIso ?? "n/a"})`,
  );
  out("");
  out("  Per-zone geometry — price vs the zone, ignoring every other gate:");
  out("    distance is in PROXIMITY BANDS: 1.00 is the edge of the band, above 1.00 is outside it.");
  out(
    `    ${padL("tier", 6)}${padR("bar-zone pairs", 16)}${padR("in band", 10)}` +
      `${padR("in-body", 10)}${padR("eligible", 10)}${padR("closest", 10)}${padR("p50", 9)}` +
      `${padR("p90", 9)}${padR("body/band", 11)}`,
  );
  const unmeasurable = new Set(unmeasurableTiers(r.timeframe));
  for (const name of TIER_NAMES) {
    const p = r.sectionC_zonePopulation.perTier[name].proximity;
    const d = p.distanceBands;
    // A tier this native grid cannot aggregate gets an explicit cell rather than
    // a row of zeros: "0 eligible" would read as a measurement, and it is not
    // one. `d.min === null` is a width artifact of the existing formatter on the
    // string "n/a", so the unmeasurable branch is checked before formatting.
    if (unmeasurable.has(name)) {
      out(
        `    ${padL(name, 6)}${padR("not measurable on a " + r.timeframe.id + " grid", 16)}` +
          `${padR("-", 10)}${padR("-", 10)}${padR("-", 10)}${padR("-", 10)}${padR("-", 9)}` +
          `${padR("-", 9)}${padR("-", 11)}`,
      );
      continue;
    }
    out(
      `    ${padL(name, 6)}${padR(int(p.barZonePairs), 16)}${padR(int(p.withinBand), 10)}` +
        `${padR(int(p.withinBandButInBody), 10)}${padR(int(p.withinBandAndNotInBody), 10)}` +
        `${padR(d.min === null ? "n/a" : d.min.toFixed(1), 10)}` +
        `${padR(d.p50 === null ? "n/a" : d.p50.toFixed(1), 9)}` +
        `${padR(d.p90 === null ? "n/a" : d.p90.toFixed(1), 9)}` +
        `${padR(p.bodyToBandRatio === null ? "n/a" : p.bodyToBandRatio.toFixed(2) + "x", 11)}`,
    );
  }
  out("    'in-body'  = the bar's range overlapped the zone body, which the port refuses to report");
  out("    as proximity on purpose (liquidity-zones.mjs:458) so one event is never counted as both");
  out("    'approaching liquidity' and 'took liquidity'.");
  out("    'eligible' = in band AND not in body: the only bars on which the tier flag may fire.");
  out("    'body/band' = median zone half-width / median proximity band. A ratio near or above 1.00");
  out("    means the zone body swallows the whole proximity band, so a close inside the band is");
  out("    necessarily inside the body and can never be reported as near.  H1 distance");
  out("    percentiles are omitted: the zone count would retain millions of samples and H1 is not");
  out("    what is under investigation.");
  out("");
  out("  THE DISCRIMINATOR — eligible bars vs flag fires, per tier");
  out(
    `    ${padL("tier", 6)}${padR("eligible", 11)}${padR("flag fires", 12)}` +
      `${padR("expected", 10)}${padR("observed", 10)}${padR("consistent", 12)}`,
  );
  for (const name of TIER_NAMES) {
    const e = r.sectionC_zonePopulation.tierEligibility[name];
    // Same reason as the geometry table: a tier the grid cannot produce is not
    // "consistent" in any meaningful sense — there was nothing to be consistent
    // about, and calling it consistent would read as a passed test.
    if (unmeasurable.has(name)) {
      out(
        `    ${padL(name, 6)}${padR("n/a", 11)}${padR("n/a", 12)}` +
          `${padR("n/a", 10)}${padR("n/a", 10)}${padR("not tested", 12)}`,
      );
      continue;
    }
    out(
      `    ${padL(name, 6)}${padR(int(e.withinBandNotInBody), 11)}${padR(int(e.tierFlagFires), 12)}` +
        `${padR(e.withinBandNotInBody > 0 ? "fires" : "silent", 10)}` +
        `${padR(e.tierFlagFires > 0 ? "fires" : "silent", 10)}` +
        `${padR(e.consistent ? "YES" : "NO — DEFECT", 12)}`,
    );
  }
  out(
    "    A tier flag can only fire where a live zone of that tier was within the band AND the bar's",
  );
  out("    range missed the zone body. Zero eligibility with a zero flag is CONSISTENT — there was");
  out(
    "    nothing to report. Eligible pairs with a silent flag is the shape a defect would have.",
  );
  const dbCell = (v) => (v === null ? "unavailable" : int(v));
  out(
    `  dropped incomplete HTF buckets: 1H ${dbCell(r.sectionC_zonePopulation.droppedBuckets.h1)}, ` +
      `4H ${dbCell(r.sectionC_zonePopulation.droppedBuckets.h4)}, D1 ${dbCell(r.sectionC_zonePopulation.droppedBuckets.d1)}` +
      " (non-zero would mean a hole inside an HTF bucket; 'unavailable' means the tier is " +
      "finer than the native grid and cannot be aggregated at all)",
  );
  out("");

  // ── D. Candidates vs global ───────────────────────────────────────────────
  out("D. CANDIDATE-MOMENT DISTRIBUTION vs GLOBAL — is something selecting against D1?");
  out("");
  for (const side of ["long", "short"]) {
    const cmp = r.sectionD_candidateVsGlobal.comparison[side];
    out(`  ${side.toUpperCase()} — ${int(r.sectionD_candidateVsGlobal.candidates[side])} candidate bars`);
    out(
      `    ${padL("tier", 6)}${padR("candidates", 12)}${padR("cand %", 9)}` +
        `${padR("all flagged", 12)}${padR("global %", 10)}${padR("lift", 8)}`,
    );
    for (const name of TIER_NAMES) {
      if (unmeasurable.has(name)) {
        out(`    ${padL(name, 6)}— not measurable on a ${r.timeframe.id} grid (no candidates and no flagged bars exist for it here).`);
        continue;
      }
      out(
        `    ${padL(name, 6)}${padR(int(cmp.candidates.counts[name]), 12)}` +
          `${padR(cmp.candidates.percentOfFlagged[name], 9)}` +
          `${padR(int(cmp.global.counts[name]), 12)}` +
          `${padR(cmp.global.percentOfFlagged[name], 10)}` +
          `${padR(cmp.lift[name] === null ? "n/a" : cmp.lift[name].toFixed(2), 8)}`,
      );
    }
    out(
      "    lift = candidate share / global share. 1.00 means candidates are drawn from the global",
    );
    out("    mix unchanged, i.e. the tier mix at signal moments IS the tier mix everywhere.");
  }
  out("");
  out("  D.2 — WHAT THE TIER COSTS IN POINTS, measured over the candidates themselves");
  out(
    `    ${padL("tier", 6)}${padR("cands", 8)}${padR("w", 5)}${padR("score p50", 11)}` +
      `${padR("score max", 11)}${padR("non-tier max", 14)}${padR("ceiling", 10)}${padR(">= 70", 7)}`,
  );
  for (const name of TIER_NAMES) {
    const s = r.sectionD2_scoreByTier[name];
    // Zero candidates for an UNMEASURABLE tier is not "this tier is worth
    // nothing" — it is "this tier was never available". Said explicitly.
    if (s.candidates === 0) {
      if (unmeasurable.has(name)) {
        // No row of zeros: a row of zeros would read as "this tier is worth
        // nothing", which is a finding this grid cannot support.
        out(
          `    ${padL(name, 6)}— not measurable on a ${r.timeframe.id} grid ` +
            "(finer than the native series); its weight and score range are unmeasured, " +
            "not zero.",
        );
        continue;
      }
      out(
        `    ${padL(name, 6)}${padR(int(s.candidates), 8)}${padR(s.tierWeight, 5)}` +
          `${padR("n/a", 11)}${padR("n/a", 11)}${padR("n/a", 14)}${padR("n/a", 10)}${padR("n/a", 7)}`,
      );
      continue;
    }
    out(
      `    ${padL(name, 6)}${padR(int(s.candidates), 8)}${padR(s.tierWeight, 5)}` +
        `${padR(s.observedScore.p50, 11)}${padR(s.observedScore.max, 11)}` +
        `${padR(s.nonTierPoints.max, 14)}${padR(s.attainableCeiling, 10)}` +
        `${padR(int(s.atOrAboveMinConfidence), 7)}`,
    );
  }
  out(
    "    ceiling = tier weight + the best non-tier total actually observed at a candidate of that",
    );
  out(
    "    tier. It is the highest score that tier could have reached on THIS dataset with this",
  );
  out("    configuration — not a theoretical maximum.");
  out("");

  // ── E. Proximity isolated ─────────────────────────────────────────────────
  out("E. PROXIMITY, ISOLATED FROM EVERY OTHER GATE — sessionOK, structure and imbalance ignored");
  out("");
  out(
    `  ${padL("side", 8)}${padR("bars", 9)}${padR("near D1", 10)}${padR("near H4", 10)}` +
      `${padR("near H1", 10)}${padR("any tier", 10)}${padR("no tier", 10)}`,
  );
  for (const side of ["long", "short"]) {
    const t = r.sectionE_proximityIsolated[side];
    out(
      `  ${padL(side, 8)}${padR(int(t.bars), 9)}${padR(int(t.D1), 10)}${padR(int(t.H4), 10)}` +
        `${padR(unmeasurable.has("H1") ? "n/a" : int(t.H1), 10)}${padR(int(t.any), 10)}` +
        `${padR(int(t.none), 10)}`,
    );
  }
  out(
    `  combined across both sides: D1 ${int(r.sectionE_proximityIsolated.combined.D1)}, ` +
      `H4 ${int(r.sectionE_proximityIsolated.combined.H4)}, ` +
      `H1 ${unmeasurable.has("H1") ? "not measurable on this grid" : int(r.sectionE_proximityIsolated.combined.H1)}.`,
  );
  out("");
  out("  Reading this table correctly - the trap this section exists to avoid:");
  out(
    "  a non-zero 'within band' count in section C is NOT on its own evidence of a defect. A bar",
  );
  out(
    "  deep inside a D1 zone body is inside the proximity band and is deliberately NOT reported as",
  );
  out("  near. Only 'eligible' pairs - in band and not in body - could have moved a tier flag, and");
  out("  the discriminator table in section C compares exactly those two numbers.");
  // This sentence is a CONCLUSION, so it is derived rather than asserted. On 5m
  // it reads "price is genuinely never at a D1 zone from outside its body"; on a
  // grid where D1 eligibility exists it must say the opposite instead of
  // carrying the 5m verdict over as a fixed string.
  const d1EligibleNow = r.sectionC_zonePopulation.tierEligibility.D1.withinBandNotInBody;
  if (d1EligibleNow === 0) {
    out(
      `  Here: near D1 = ${int(r.sectionE_proximityIsolated.combined.D1)} against ` +
        `${int(d1EligibleNow)} eligible pairs, so ` +
        "price is genuinely never at a D1 zone from outside its body, and no weight search can",
    );
    out("  change that on this dataset.");
  } else {
    out(
      `  Here: near D1 = ${int(r.sectionE_proximityIsolated.combined.D1)} against ` +
        `${int(d1EligibleNow)} eligible pairs — price DOES reach D1 zones from outside ` +
        `their body on this ${r.timeframe.id} grid, so the D1 tier is reachable here and a`,
    );
    out(
      "  weight search over the liquidity factors is not degenerate on this dataset. The",
    );
    out(
      `  eligibility is geometric: the proximity band is ${r.config.proximityBandAtrMult} x an ` +
        `ATR of the ${r.timeframe.id} grid, so a wider native series widens the band.`,
    );
  }
  out("");

  // ── F. Warm-up boundary ───────────────────────────────────────────────────
  out("F. WARM-UP BOUNDARY — the same numbers, split at the first bar with a live D1 zone");
  out("");
  const wu = r.sectionF_warmUpSplit;
  out(
    `  boundary: bar ${wu.boundaryBar === null ? "never" : int(wu.boundaryBar)} ` +
      `(${wu.boundaryIso ?? "n/a"}) — the first bar at which a D1 zone exists in the live array.`,
  );
  out(
    `  cross-check against baseline: this diagnostic measures the first live D1 zone at bar ` +
      `${wu.boundaryBar === null ? "never" : int(wu.boundaryBar)} and the first confirmed D1 pivot ` +
      `at bar ${wu.firstD1PivotBar === null ? "never" : int(wu.firstD1PivotBar)}. ` +
      (wu.baselineReportedD1PivotBar === null
        ? `The 5m baseline's figure (bar 8,205) does NOT apply to this grid: 21 daily ` +
          `bars is ${int(wu.expectedD1PivotNativeBars)} native ` +
          `${r.timeframe.id} bars here, not 6,048 native 5m bars. Run ` +
          `\`baseline --timeframe ${r.timeframe.id}\` for this grid's own warm-up table.`
        : `baseline's warm-up table reports the D1 pivot at bar ` +
          `${int(wu.baselineReportedD1PivotBar)}. ` +
          `${wu.firstD1PivotBar === wu.baselineReportedD1PivotBar ? "AGREES" : "DISAGREES — investigate"}.`),
  );
  out("");
  if (wu.boundaryBar === null) {
    out("  no D1 zone ever exists on this dataset, so there is no post-warm-up phase to report.");
  } else {
    out(
      `  ${padL("phase", 14)}${padR("bars", 8)}${padR("D1 live", 9)}${padR("H4 live", 9)}` +
        `${padR("D1 creat", 10)}${padR("H4 creat", 10)}${padR("cand L", 8)}${padR("cand S", 8)}`,
    );
    for (const phase of ["pre-warmup", "post-warmup"]) {
      const p = wu.phases[phase];
      out(
        `  ${padL(phase, 14)}${padR(int(p.bars), 8)}${padR(int(p.liveZoneBars.D1), 9)}` +
          `${padR(int(p.liveZoneBars.H4), 9)}${padR(int(p.created.D1), 10)}${padR(int(p.created.H4), 10)}` +
          `${padR(int(p.candidates.long), 8)}${padR(int(p.candidates.short), 8)}`,
      );
    }
    out("");
    for (const side of ["long", "short"]) {
      out(`  ${side.toUpperCase()} qualifying tier, per phase:`);
      for (const phase of ["pre-warmup", "post-warmup"]) {
        const t = wu.phases[phase].tier[side];
        out(
          `    ${padL(phase, 14)}of ${padR(int(t.anyFlag), 6)} flagged bars:  ` +
            `D1 ${int(t.D1)}  H4 ${int(t.H4)}  H1 ${int(t.H1)}  none ${int(t.none)}`,
        );
      }
      out(`  ${side.toUpperCase()} candidate tier, per phase:`);
      for (const phase of ["pre-warmup", "post-warmup"]) {
        const t = wu.phases[phase].candidateTier[side];
        out(
          `    ${padL(phase, 14)}of ${padR(int(wu.phases[phase].candidates[side]), 6)} candidates:  ` +
            `D1 ${int(t.D1)}  H4 ${int(t.H4)}  H1 ${int(t.H1)}`,
        );
      }
    }
  }
  out("");

  // ── Self-check + what this does not settle ────────────────────────────────
  out("SELF-CHECK");
  out(
    `  ${r.sectionD_candidateVsGlobal.selfCheck.note} — observed here: ` +
      `${int(r.sectionD_candidateVsGlobal.selfCheck.long)} long / ` +
      `${int(r.sectionD_candidateVsGlobal.selfCheck.short)} short.`,
  );
  out("");
  out("WHAT THIS DIAGNOSTIC DOES NOT SETTLE");
  out(
    "  * It cannot tell you whether minConfidence 70 is the RIGHT threshold. It can only tell you",
  );
  out("    which tiers this dataset can produce, and therefore which scores are reachable.");
  out(
    `  * Every number here is scoped to the ${r.timeframe.id} NATIVE grid, for the same`,
  );
  out("    reason baseline caveat [C0] says. Running the same code on another timeframe does");
  out("    not re-test this one: it changes the measurement.");
  if (r.timeframe.unavailableHtf.length > 0) {
    out(
      `  * ${r.timeframe.unavailableHtf.join(", ")} is NOT MEASURED on this grid — it is finer`,
    );
    out("    than the native series, so there are no candles to aggregate. Any zero above is");
    out("    a property of the dataset chosen, not of the tier.");
  }
  out(
    "  * Absence of D1 candidates before the warm-up boundary is arithmetic, not evidence about",
  );
  out("    the weights. Only the post-warm-up phase carries information about the tier itself.");
  out(
    "  * The 5m, 1h and 4h runs are NOT independent samples. They overlap in wall-clock time",
  );
  out("    and describe the same price action at different resolutions: agreement between");
  out("    them is not corroboration, and disagreement is usually about semantics.");
  out("");
}

// ─── Entry point ─────────────────────────────────────────────────────────────

/**
 * Runs the tier diagnostic on ONE timeframe and prints the requested format.
 *
 * @param {{json?: boolean, tf?: object}} options `tf` is a resolved entry of
 *   backtest/timeframes.mjs; it defaults to 5m so every pre-slice-7 caller is
 *   unchanged.
 * @returns {Promise<number>} process exit code (0 ok, 1 failed).
 */
export async function runTierDiagnostic(options = {}) {
  const json = Boolean(options.json);
  const tf = options.tf ?? DEFAULT_TF;
  const started = Date.now();

  try {
    const { candles, meta } = await loadDataset(tf);
    const result = runDiagnostic(candles, meta, tf);
    result.runtimeMs = Date.now() - started;

    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printReport(result);
      out(`runtime ${int(result.runtimeMs)} ms (wall clock, this run)`);
      out("");
    }
    return 0;
  } catch (err) {
    if (json) {
      console.log(
        JSON.stringify({ schemaVersion: SCHEMA_VERSION, ok: false, error: err.message }, null, 2),
      );
    } else {
      out("");
      out(`FAILED - ${err.message}`);
      out("");
    }
    return 1;
  }
}

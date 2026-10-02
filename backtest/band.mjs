// ============================================================================
// LiquidityFlowAuse — Proximity-Band Counterfactual Sweep
// ----------------------------------------------------------------------------
// A BOUNDED measurement, dispatched by `node backtest/run.mjs band`. It answers
// exactly one question:
//
//   Is there a proximity-band definition under which the D1 tier fires on a 5m
//   chart — and under which the D.4 hit rate is not worse than what the binary
//   model already achieves there?
//
// ─── EVERY NUMBER IN THIS FILE IS COUNTERFACTUAL ────────────────────────────
//
// Nothing here changes the shipped indicator. `src/` and `scripts/` are not
// touched, no candidate is recommended, and no candidate is wired anywhere. Each
// row answers "what WOULD happen IF the proximity expression at
// src/modules/liquidity-zones.pine:297 were this instead". Candidate A is the
// shipped expression and is the only row that describes the indicator as it
// exists; every other row describes an indicator that does not exist.
//
// ─── WHY THE QUESTION IS LEGITIMATE AT ALL ───────────────────────────────────
//
// docs/technical-spec.md:347-356 anchors the ZONE DISTANCE CULL to the 4H ATR
// precisely because anchoring it to the entry timeframe kills D1 liquidity on a
// fine chart: "Anchored to the entry timeframe, 15 x a 5-minute ATR is a tiny
// distance, so D1 zones are born and culled on the same bar and the tier
// hierarchy collapses — with no error, D1 liquidity just goes missing."
// docs/technical-spec.md:384-387 makes the same entry-timeframe argument for the
// PROXIMITY CHECK, which is where D1 still dies: a zone body is
// `zoneATRMult` (0.5) x the zone's OWN timeframe ATR (pine :193), while the
// band is `proxATRMult` (3) x the CHART ATR (pine :297). On a 5m chart the
// median D1 body is ~5x the band, so price is already inside the body before it
// can be near it, and the in-body exclusion (pine :305) withholds the flag by
// design. The author fixed the cull and did not carry the fix to the proximity
// check. This file measures whether carrying it — and four other widenings —
// buys anything that survives contact with a hit rate.
//
// ─── WHAT IS DELIBERATELY NOT DONE HERE ─────────────────────────────────────
//
//   * No recommendation. The report presents a SET with consequences. Picking a
//     formula to ship is the maintainer's decision, and picking the best-looking
//     cell of a sweep is the overfitting this project has refused four times.
//   * src/ and scripts/ are read-only here. Production SHA is asserted by the
//     build, not by this file.
//   * No new dependencies, no package.json.
//   * No signal is re-derived from a second wiring. The ONE wiring loop below
//     is baseline.mjs's, mirrored for the reason given in the file header of
//     tier-diagnostic.mjs (a diagnostic that shares mutable state with the
//     baseline could perturb it silently) — and candidate A is REQUIRED to
//     reproduce `baseline`'s fired counts and Definition A counts EXACTLY on
//     every grid, or the whole sweep is refused. That self-check is the proof
//     this harness is faithful; it is asserted, not asserted-about.
//
// Usage:
//   node backtest/run.mjs band                        human-readable report
//   node backtest/run.mjs band --timeframe 1h         one native grid
//   node backtest/run.mjs band --json                 the same numbers as JSON
// ============================================================================

import { readFile } from "node:fs/promises";

import {
  DEFAULT_TIMEFRAME,
  getTimeframe,
  htfAvailability,
  nativeBarsForDays,
} from "./timeframes.mjs";
import {
  LIQUIDITY_ZONE_DEFAULTS,
  createAtr,
  createPivotDetector,
} from "./modules/liquidity-zones.mjs";
import { createSessionMarkers } from "./modules/session-markers.mjs";
import { createStructureBreak, STRUCTURE_BREAK_DEFAULTS } from "./modules/structure-break.mjs";
import { createImbalanceDetector } from "./modules/imbalance-detector.mjs";
import { createSignalEngine } from "./modules/signal-engine.mjs";
import { createBinarySignalModel } from "./modules/binary.mjs";
import {
  EXIT_RULE_DEFAULTS,
  EXIT_STOP_PCT,
  EXIT_TARGET_PCT,
  labelSignalsExitRule,
} from "./modules/label.mjs";
import { loadDataset, runComparison } from "./baseline.mjs";
import {
  bootstrapHitRateDraws,
  hitRateInterval,
  labelExitAt,
  selectIndependent,
} from "./ratio.mjs";
import { newTally, qualifyingTier, recordTier } from "./tier-diagnostic.mjs";

const SCHEMA_VERSION = 1;

const MS_1H = 3600000;
const MS_4H = 14400000;
const MS_1D = 86400000;

const DEFAULT_TF = getTimeframe(DEFAULT_TIMEFRAME);

/**
 * Mirrors backtest/ratio.mjs:183.
 *
 * Declared separately, NOT imported, so this slice adds no edit to an existing
 * file that other subcommands print through. The two must not drift: the smoke
 * suite asserts that ratio.mjs still declares the same value, by reading its
 * source, so a future edit to either one fails loudly instead of quietly
 * splitting the reporting policy in two.
 *
 * It counts INDEPENDENT observations (one signal per non-overlapping window),
 * never raw signals. Below the threshold nothing is printed — not a wide
 * interval, not a point estimate standing in for one.
 */
const MIN_OBSERVATIONS_FOR_INTERVAL = 30;

/** Bootstrap settings for the independent-sample interval. Same convention as `ratio`. */
const DEFAULT_SEED = 20260901;
const DEFAULT_BOOTSTRAP = 10000;

/** The shipped D.4 hold, in bars. One number drives BOTH the window and the exit scan. */
const INDEPENDENT_WINDOW_BARS = EXIT_RULE_DEFAULTS.maxHorizonBars;

/** Tier index -> report name. Exact port of tier-diagnostic.mjs:130. */
const TIER_NAMES = Object.freeze(["D1", "H4", "H1"]);
const TIER_OF_INDEX = Object.freeze({ 1: "D1", 2: "H4", 3: "H1" });

const out = (s = "") => console.log(`band: ${s}`);

// ─── Small helpers (mirrors baseline.mjs formatting) ─────────────────────────

const iso = (ms) => new Date(ms).toISOString();
const int = (v) => Number(v).toLocaleString("en-US");
const round = (v, dp) =>
  v === null || v === undefined || Number.isNaN(v) ? null : Number(v.toFixed(dp));
const padL = (s, w) => String(s).padEnd(w);
const padR = (s, w) => String(s).padStart(w);
/** "31.25%" / "n/a" — never a silent 0%, which reads as "lost everything". */
const pct = (v, dp = 2) =>
  v === null || v === undefined ? "n/a" : `${Number(v).toFixed(dp)}%`;
/** "[28.79, 53.03]" / "REFUSED". */
const ci = (lo, hi, dp = 2) =>
  lo === null || lo === undefined || hi === null || hi === undefined
    ? "REFUSED"
    : `[${lo.toFixed(dp)}, ${hi.toFixed(dp)}]`;
/** Signed percentage-point delta against candidate A. */
const dpp = (v, dp = 2) =>
  v === null || v === undefined ? "n/a" : `${v > 0 ? "+" : ""}${v.toFixed(dp)} pp`;
/** Signed integer delta against candidate A. */
const dint = (v) => (v === null || v === undefined ? "n/a" : `${v > 0 ? "+" : ""}${int(v)}`);

function medianOf(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ─── The candidate band definitions ──────────────────────────────────────────
//
// A candidate is a FUNCTION from a proximity context to a BAND WIDTH in price
// units, or null for Pine `na` (which makes the comparison false, exactly as
// `x <= na` does on the chart).
//
// The context carries everything a band is allowed to see:
//   { atrChart, atrH4, atrD1, atrH1, zone }
// `zone` is exposed so a scale-free candidate can be expressed at all; a
// candidate that ignores it is an ATR-anchored band, one that uses it is
// scale-free. Keeping the two kinds in ONE shape is deliberate — it means the
// set below cannot quietly grow a candidate that reads something the shipped
// expression cannot see.

const PROX_MULT = LIQUIDITY_ZONE_DEFAULTS.proxATRMult;

/** Finite positive number, or null. Pine `na` for every arithmetic purpose here. */
function pos(v) {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

/** Larger of two ATR anchors, or null if neither is usable. */
function maxOf2(a, b) {
  const x = pos(a);
  const y = pos(b);
  if (x === null) return y;
  if (y === null) return x;
  return x > y ? x : y;
}

/** Band widths by family, each a function of the proximity context. */
const BAND_FAMILIES = Object.freeze({
  /** A — SHIPPED. atrChart x proxATRMult. liquidity-zones.pine:297 verbatim. */
  chart: (ctx) => (pos(ctx.atrChart) === null ? null : ctx.atrChart * PROX_MULT),
  /** B — the cull's precedent. Anchored to the 4H ATR, not the chart ATR. */
  h4: (ctx) => (pos(ctx.atrH4) === null ? null : ctx.atrH4 * PROX_MULT),
  /** C — a FLOOR: chart ATR where it is coarse, 4H where the chart is finer. */
  max: (ctx) => {
    const anchor = maxOf2(ctx.atrChart, ctx.atrH4);
    return anchor === null ? null : anchor * PROX_MULT;
  },
  /** D — widening. atrChart x proxATRMult x k. */
  widened: (k) => (ctx) =>
    pos(ctx.atrChart) === null ? null : ctx.atrChart * PROX_MULT * k,
  /** E — scale-free. The zone's OWN half-width, times k. No ATR at all. */
  scaleFree: (k) => (ctx) => {
    const hw = pos(ctx.zone?.halfWidth);
    return hw === null ? null : hw * k;
  },
});

/**
 * The widenings measured, as a frozen set.
 *
 * `k` values are chosen to BRACKET the mechanism rather than sweep it finely.
 * The 5m median D1 body is ~5x the current band (tier-diagnostic.mjs section C,
 * bodyToBandRatio 5.04), and a band must be at least as wide as the body before
 * any D1 pair can be eligible, so k < 5 is a near-certain null and only the
 * ladder around and past that boundary carries information. The ladder is
 * geometric (2, 4, 8, 16, 32) so each step is a doubling, which is the unit a
 * threshold question is actually asked in — not 5, 6 and 7, which would look
 * like tuning.
 *
 * The set is FROZEN and the report prints every member of it. A sweep that
 * omitted the uninteresting candidates would let a reader believe the ladder
 * was chosen after seeing which end worked.
 */
const WIDENING_K = Object.freeze([2, 4, 8, 16, 32]);
const SCALE_FREE_K = Object.freeze([1, 2, 3]);

function candidate({ id, family, k, expr, bandWidth, givesUp, note }) {
  return Object.freeze({ id, family, k: k ?? null, expr, bandWidth, givesUp, note });
}

/**
 * The full candidate list, in report order.
 *
 * ORDER IS PART OF THE CONTRACT: candidate A is first so the delta table has a
 * fixed reference, and every other row states what it gives up rather than what
 * it promises. `givesUp` is the field the reader should quote — a widening that
 * costs nothing has usually been measured on the wrong axis.
 */
export function proximityCandidates() {
  const list = [
    candidate({
      id: "A",
      family: "A",
      expr: `atrChart * ${PROX_MULT}`,
      bandWidth: BAND_FAMILIES.chart,
      givesUp: "nothing — this IS the shipped expression, so it gives up nothing and buys nothing",
      note:
        "the baseline. Included so every other row has a fixed reference, and so this " +
        "harness's fidelity to `baseline` is visible rather than asserted",
    }),
    candidate({
      id: "B",
      family: "B",
      expr: `atrH4 * ${PROX_MULT}`,
      bandWidth: BAND_FAMILIES.h4,
      givesUp:
        "timeframe independence of a different kind: on a coarse chart the band stops " +
        "responding to the chart's own volatility, so a 4h chart trades the same band " +
        "a 5m chart would",
      note:
        "the precedent the author already set for the distance cull " +
        "(docs/technical-spec.md:347-356, pine :249), applied to proximity",
    }),
    candidate({
      id: "C",
      family: "C",
      expr: `max(atrChart, atrH4) * ${PROX_MULT}`,
      bandWidth: BAND_FAMILIES.max,
      givesUp:
        "the chart's own volatility as the sole yardstick on coarse grids, in exchange " +
        "for a floor that cannot shrink the band below what it is today",
      note:
        "a floor rather than a replacement: where atrH4 <= atrChart the band is " +
        "bit-identical to A, so a coarse grid is untouched by construction",
    }),
  ];

  for (const k of WIDENING_K) {
    list.push(
      candidate({
        id: `D${k}`,
        family: "D",
        k,
        expr: `atrChart * ${PROX_MULT} * ${k}`,
        bandWidth: BAND_FAMILIES.widened(k),
        givesUp:
          `selectivity: a ${k}x band flags approaches up to ${k} chart-ATRs away, ` +
          "which is a behavioural change and not a free win — every such bar is one " +
          "the shipped rule deliberately does not flag",
        note: "pure widening of the shipped expression; no anchor changes",
      }),
    );
  }

  for (const k of SCALE_FREE_K) {
    list.push(
      candidate({
        id: `E${k}`,
        family: "E",
        k,
        expr: `zoneHalfWidth * ${k}`,
        bandWidth: BAND_FAMILIES.scaleFree(k),
        givesUp:
          "the chart's volatility entirely: the band becomes a property of the zone, so " +
          "a quiet zone in a violent market and a violent zone in a quiet market are " +
          "treated identically, and the band no longer scales with the instrument's " +
          "current state",
        note:
          "scale-free. Satisfies the property the defect breaks — the band can never " +
          "be narrower than the body it must detect — at k = 1 by construction",
      }),
    );
  }

  return Object.freeze(list);
}

/** The baseline row, by id. Throws rather than defaulting silently. */
export function baselineCandidate() {
  const found = proximityCandidates().find((c) => c.family === "A");
  if (!found) throw new Error("band: the baseline candidate (family A) is missing");
  return found;
}

/**
 * THE DISCRIMINATOR, in isolation.
 *
 * A tier flag can fire on a bar only if some live zone of that tier was within
 * the band AND the bar's range did not overlap the zone body
 * (liquidity-zones.pine:296,305). So:
 *
 *   eligible > 0 and fires == 0  ->  DEFECT in the port
 *   eligible == 0 and fires > 0  ->  DEFECT in the port
 *   eligible == 0 and fires == 0  ->  consistent, and the tier is unreachable by geometry
 *
 * `producible` is the grid's ability to build the tier AT ALL. A 4h dataset has
 * no 1h candles to aggregate, so its H1 tier is NOT MEASURABLE and neither
 * consistency nor a zero is asserted about it — reporting "H1 fires 0 times"
 * there would state a finding about a tier that was never fed.
 */
export function discriminator({ eligible, fires, producible }) {
  if (!producible) {
    return {
      producible: false,
      consistent: null,
      verdict: "not measurable",
      reason: "this grid cannot produce the tier — no candles to aggregate, not a zero result",
    };
  }
  const consistent = (eligible > 0) === (fires > 0);
  return {
    producible: true,
    consistent,
    verdict: consistent ? "consistent" : "defect",
    reason: consistent
      ? eligible > 0
        ? "eligible pairs existed and the flag followed"
        : "no eligible pair existed and the flag correctly stayed at zero"
      : eligible > 0
        ? "eligible pairs existed and the flag did NOT follow — a defect in the port"
        : "the flag fired with zero eligible pairs — a defect in the port",
  };
}

// ─── The banded zone engine ──────────────────────────────────────────────────
//
// A mirror of backtest/modules/liquidity-zones.mjs with ONE difference: the
// `near` predicate consults a candidate instead of `atrChart * proxATRMult`.
// Blocks 1-3 (creation, sweep marking, culling) are reproduced with the same
// semantics, so zone STATE is identical across every candidate — only the
// proximity decision differs.
//
// WHY A MIRROR AND NOT A NEW OPTION ON THE MODULE. An option would put a
// counterfactual switch inside the file every shipped subcommand reads, and the
// shipped default would then be one branch away from being wrong. tier-diagnostic
// .mjs set this precedent and its reasoning applies verbatim: a diagnostic that
// can perturb the comparison must not share its wiring.
//
// The price of the mirror is that it can be WRONG, and the only defence is that
// candidate A must reproduce `baseline` exactly on every grid. That check is
// below, it runs on every invocation, and it throws rather than reporting.

function isNa(v) {
  return v === null || v === undefined || (typeof v === "number" && Number.isNaN(v));
}

function createBandedZones(band) {
  const cfg = LIQUIDITY_ZONE_DEFAULTS;
  const zones = [];

  function oldestIndex() {
    let oldest = 0;
    for (let k = 1; k < zones.length; k++) {
      if (zones[k].bornBar < zones[oldest].bornBar) oldest = k;
    }
    return oldest;
  }

  function evaluate(bar) {
    const { barIndex, high, low, close, atrChart, atrH4, atrD1, atrH1 } = bar;
    const pivots = bar.pivots ?? {};

    // ── Block 1: zone creation (liquidity-zones.mjs:307-360 / pine :187-200) ──
    const confirmedPivots = [
      pivots.d1High,
      pivots.d1Low,
      pivots.h4High,
      pivots.h4Low,
      pivots.h1High,
      pivots.h1Low,
    ];
    for (let k = 0; k < confirmedPivots.length; k++) {
      const pivotPrice = confirmedPivots[k];
      const tier = k < 2 ? 1 : k < 4 ? 2 : 3;
      const atrOfTier = k < 2 ? atrD1 : k < 4 ? atrH4 : atrH1;
      if (isNa(pivotPrice) || isNa(atrOfTier)) continue;
      const halfW = atrOfTier * cfg.zoneATRMult;
      if (zones.length >= cfg.maxZones) zones.splice(oldestIndex(), 1);
      zones.push({ center: pivotPrice, halfWidth: halfW, tier, bornBar: barIndex, sweptBar: null });
    }

    // ── Block 2: sweep marking (mjs:362-384 / pine :217-224) ─────────────────
    for (let i = 0; i < zones.length; i++) {
      const zm = zones[i];
      const inBody = high >= zm.center - zm.halfWidth && low <= zm.center + zm.halfWidth;
      if (inBody && isNa(zm.sweptBar)) zm.sweptBar = barIndex;
    }

    // ── Block 3: culling (mjs:386-415 / pine :244-254) ──────────────────────
    for (let i = zones.length - 1; i >= 0; i--) {
      const zc = zones[i];
      const tooOld = barIndex - zc.bornBar > cfg.maxZoneAgeBars;
      // Anchored to atrH4, matching the shipped source (pine :249) rather than
      // the spec's own code block (technical-spec.md:374), which still shows
      // atrChart. The source wins; see the report's disagreements section.
      const tooFar = !isNa(atrH4) && Math.abs(close - zc.center) > atrH4 * cfg.maxZoneDistanceATR;
      const stale = !isNa(zc.sweptBar) && barIndex - zc.sweptBar > cfg.sweptRetainBars;
      if (tooOld || tooFar || stale) zones.splice(i, 1);
    }

    // ── Block 4: proximity / sweep outputs (mjs:417-476 / pine :292-321) ────
    let nearLiquidityLong = false;
    let nearLiquidityShort = false;
    let sweptLong = false;
    let sweptShort = false;
    let nearD1LiquidityLong = false;
    let nearD1LiquidityShort = false;
    let nearH4LiquidityLong = false;
    let nearH4LiquidityShort = false;
    let nearH1LiquidityLong = false;
    let nearH1LiquidityShort = false;

    // The SHIPPED gate, kept for every candidate including the scale-free one:
    // pine :292 is `if array.size(zones) > 0 and not na(atrChart)`, so the first
    // 13 bars of any grid have no proximity at all. Changing it for candidate E
    // would make E differ from A in two ways at once and the comparison would
    // stop being about the band.
    if (zones.length > 0 && !isNa(atrChart)) {
      for (let i = 0; i < zones.length; i++) {
        const zp = zones[i];
        const inBody = high >= zp.center - zp.halfWidth && low <= zp.center + zp.halfWidth;

        // ── THE ONE LINE THAT DIFFERS FROM THE SHIPPED PORT ──
        const width = band.bandWidth({ atrChart, atrH4, atrD1, atrH1, zone: zp });
        const near = width !== null && Math.abs(close - zp.center) <= width;

        if (!isNa(zp.sweptBar) && barIndex - zp.sweptBar <= cfg.sweepWindow) {
          if (zp.center < close) sweptLong = true;
          else sweptShort = true;
        }

        if (near && !inBody) {
          if (zp.center < close) {
            nearLiquidityLong = true;
            if (zp.tier === 1) nearD1LiquidityLong = true;
            else if (zp.tier === 2) nearH4LiquidityLong = true;
            else nearH1LiquidityLong = true;
          } else {
            nearLiquidityShort = true;
            if (zp.tier === 1) nearD1LiquidityShort = true;
            else if (zp.tier === 2) nearH4LiquidityShort = true;
            else nearH1LiquidityShort = true;
          }
        }
      }
    }

    return {
      nearLiquidityLong,
      nearLiquidityShort,
      sweptLong,
      sweptShort,
      nearD1LiquidityLong,
      nearD1LiquidityShort,
      nearH4LiquidityLong,
      nearH4LiquidityShort,
      nearH1LiquidityLong,
      nearH1LiquidityShort,
      zones: zones.map((z) => ({ ...z })),
    };
  }

  return { evaluate };
}

// ─── Accumulators ────────────────────────────────────────────────────────────

function newTierProximity() {
  return { pairs: 0, withinBand: 0, withinBandInBody: 0, eligible: 0, liveBars: 0, halfWidths: [], bandWidths: [] };
}

function newCandidateAcc() {
  return {
    near: { long: { D1: 0, H4: 0, H1: 0, any: 0 }, short: { D1: 0, H4: 0, H1: 0, any: 0 } },
    candidateTier: { long: newTally(), short: newTally() },
    candidates: { long: 0, short: 0 },
    zones: {
      D1: newTierProximity(),
      H4: newTierProximity(),
      H1: newTierProximity(),
      created: { D1: 0, H4: 0, H1: 0 },
    },
    scoreAll: { long: [], short: [] },
    scoreCandidate: { long: [], short: [] },
    fired: { weighted: [], binary: [] },
  };
}

/** Tier mix at candidate moments, plus the same mix over every bar for context. */
function mixOf(tally) {
  const denom = tally.D1 + tally.H4 + tally.H1;
  return {
    counts: { D1: tally.D1, H4: tally.H4, H1: tally.H1, total: denom },
    percent: {
      D1: denom ? round((tally.D1 / denom) * 100, 2) : null,
      H4: denom ? round((tally.H4 / denom) * 100, 2) : null,
      H1: denom ? round((tally.H1 / denom) * 100, 2) : null,
    },
  };
}

// ─── D.4 outcome summaries ───────────────────────────────────────────────────

/**
 * Counts over a signal list: win / loss / timeout / insufficient_data.
 * `timeout` and `insufficient_data` are NEVER folded into win or loss.
 */
function outcomeCounts(labelCandles, signals, maxHorizonBars = INDEPENDENT_WINDOW_BARS) {
  const batch = labelSignalsExitRule(labelCandles, signals, { maxHorizonBars });
  const counts = { win: 0, loss: 0, timeout: 0, insufficient_data: 0 };
  let doubleTouch = 0;
  for (const r of batch.results) {
    counts[r.label] += 1;
    if (r.doubleTouch) doubleTouch += 1;
  }
  const resolved = counts.win + counts.loss;
  return {
    signals: batch.total,
    counts,
    resolved,
    doubleTouchCount: doubleTouch,
    hitRatePercent: resolved > 0 ? round((counts.win / resolved) * 100, 2) : null,
  };
}

/**
 * The NUMERIC outcome codes `bootstrapHitRateDraws` expects.
 *
 * ratio.mjs keeps EXCLUDED/WIN/LOSS as module-private constants (ratio.mjs:1024-
 * 1026) and exports no encoder, so an outcome-code array cannot be obtained from
 * it. Passing label STRINGS instead silently produces `undefinedDraws === every
 * draw` and a null interval — a quiet wrong answer, not a crash. The mapping is
 * therefore written out here and is the same one ratio.mjs:1359-1362 uses;
 * smoke.mjs asserts the two stay in step by reading ratio.mjs's source.
 *
 * EXCLUDED covers BOTH timeout and insufficient_data, exactly as ratio.mjs
 * documents: the bootstrap needs to know only whether an observation RESOLVED.
 */
const OUTCOME_EXCLUDED = 0;
const OUTCOME_WIN = 1;
const OUTCOME_LOSS = 2;

function outcomeCodes(labelCandles, signals, maxHorizonBars) {
  return signals.map((s) => {
    const r = labelExitAt(labelCandles, s, EXIT_TARGET_PCT, EXIT_STOP_PCT, maxHorizonBars);
    return r.label === "win" ? OUTCOME_WIN : r.label === "loss" ? OUTCOME_LOSS : OUTCOME_EXCLUDED;
  });
}

/**
 * THE REFUSAL GATE, isolated from any data so it can be smoke-checked.
 *
 * `independent` carries the resolved count and (optionally) the hit rate;
 * `drawInterval` is only CALLED when the sample clears the floor. Splitting the
 * gate from the call is the whole point: the enforcement being before the draw
 * is only testable if the draw is a parameter.
 *
 * Below the floor it returns the resolved count and NOTHING else. It never
 * returns the hit rate "for reference", never a widened interval, and never a
 * normal-approximation fallback — a reader who sees "REFUSED" can rely on there
 * being no interval anywhere for that cell, because there was nothing to print
 * one from.
 */
export function gateIndependent(independent, drawInterval, minObservations) {
  const resolved = independent.resolved ?? 0;
  const eligible = resolved >= minObservations;
  const out = {
    independentObserved: resolved,
    minObservations,
    eligible,
    hitRatePercent: eligible ? independent.hitRatePercent : null,
    interval: null,
    refused: eligible
      ? null
      : `${resolved} resolved independent observation${resolved === 1 ? "" : "s"}, below the ` +
        `${minObservations}-observation floor — no interval is printed, and none is ` +
        "estimated in its place",
  };
  if (eligible) out.interval = drawInterval();
  return out;
}

/**
 * A hit rate with a REFUSAL instead of a number when the sample is too small.
 */
function hitRateScope(labelCandles, signals, { seed, bootstrap, windowBars = INDEPENDENT_WINDOW_BARS }) {
  const dependent = outcomeCounts(labelCandles, signals);
  const sel = selectIndependent(signals, windowBars);
  const independent = outcomeCounts(labelCandles, sel.selected);

  const scope = {
    dependent,
    independent: {
      windowBars,
      windowsUsed: sel.windowsUsed,
      considered: sel.considered,
      discarded: sel.discarded,
      ...independent,
      minObservationsForInterval: MIN_OBSERVATIONS_FOR_INTERVAL,
      // The gate is applied HERE, before any draw exists, and the draw lives
      // inside the closure it hands to gateIndependent.
      ...gateIndependent(independent, () => {
        const outcomes = outcomeCodes(labelCandles, sel.selected, windowBars);
        const draws = bootstrapHitRateDraws(outcomes, bootstrap, seed);
        const interval = hitRateInterval(draws.rates);
        // A draw is "undefined" when the resample contained no RESOLVED
        // observation at all. That is legitimate on a thin sample, but EVERY
        // draw being undefined means the outcome codes were not the numeric
        // codes bootstrapHitRateDraws compares against — and that failure is
        // silent otherwise, producing a null interval indistinguishable from a
        // small sample.
        if (draws.undefinedDraws === bootstrap) {
          throw new Error(
            `band: every bootstrap draw was undefined (${draws.undefinedDraws}/${bootstrap}) — ` +
              "the outcome codes are not the numeric codes bootstrapHitRateDraws expects. " +
              "Refusing rather than printing a null interval that reads as a small sample.",
          );
        }
        return {
          method: "percentile bootstrap over the independent sample",
          seed,
          iterations: bootstrap,
          draws: interval.draws,
          undefinedDraws: draws.undefinedDraws,
          lo: interval.lo,
          hi: interval.hi,
        };
      }, MIN_OBSERVATIONS_FOR_INTERVAL),
    },
  };
  return scope;
}

// ─── The sweep ───────────────────────────────────────────────────────────────

function newHtfSeries(tfMs, nativeStepMs) {
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

function createHtfContext(tfMs, tf, available) {
  return {
    available,
    series: available ? newHtfSeries(tfMs, tf.stepMs) : null,
    atr: createAtr({ length: 14 }),
    atrValue: null,
    liqPivot: createPivotDetector({ pivotLenHigh: 10, pivotLenLow: 10 }),
    liq: { high: null, low: null },
  };
}

/**
 * ONE pass over the candles, all candidates at once.
 *
 * The five upstream modules (session, ATR, HTF aggregation, structure break,
 * imbalance) do not depend on the band, so they are evaluated ONCE per bar and
 * handed to every candidate. That is not an optimisation: it makes it
 * STRUCTURALLY IMPOSSIBLE for one candidate to see a different price bar,
 * session flag or HTF ATR than another, so any difference in the results is
 * attributable to the band and nothing else. Each candidate still owns its own
 * zone engine, signal engine and binary model, because all three are stateful
 * and cooldown/exclusivity must not be shared.
 */
function sweep(candles, tf, candidates) {
  const n = candles.length;
  const labelCandles = candles.map((c) => ({ high: c.h, low: c.l, close: c.c }));

  const session = createSessionMarkers();
  const chartAtr = createAtr({ length: 14 });
  const avail = htfAvailability(tf.stepMs);
  const ctx = {
    h1: createHtfContext(MS_1H, tf, avail.available.h1),
    h4: createHtfContext(MS_4H, tf, avail.available.h4),
    d1: createHtfContext(MS_1D, tf, avail.available.d1),
  };
  const structPivot = createPivotDetector({
    pivotLenHigh: STRUCTURE_BREAK_DEFAULTS.structPivotLen,
    pivotLenLow: STRUCTURE_BREAK_DEFAULTS.structPivotLen,
  });
  const structure = createStructureBreak();
  const imbalance = createImbalanceDetector();

  const states = candidates.map((c) => ({
    candidate: c,
    zones: createBandedZones(c),
    weighted: createSignalEngine(),
    binary: createBinarySignalModel(),
    acc: newCandidateAcc(),
  }));

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
    }

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

    const shared = {
      barIndex: i,
      sessionStrength: sm.sessionStrength,
      inOverlap: sm.inOverlap,
      inLondon: sm.inLondon,
      inNY: sm.inNY,
      inAsia: sm.inAsia,
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

    for (const st of states) {
      const acc = st.acc;
      const lz = st.zones.evaluate({
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

      const engineBar = {
        ...shared,
        nearLiquidityLong: lz.nearLiquidityLong,
        nearLiquidityShort: lz.nearLiquidityShort,
        nearD1LiquidityLong: lz.nearD1LiquidityLong,
        nearH4LiquidityLong: lz.nearH4LiquidityLong,
        nearH1LiquidityLong: lz.nearH1LiquidityLong,
        nearD1LiquidityShort: lz.nearD1LiquidityShort,
        nearH4LiquidityShort: lz.nearH4LiquidityShort,
        nearH1LiquidityShort: lz.nearH1LiquidityShort,
      };

      const w = st.weighted.evaluate(engineBar);
      const b = st.binary.evaluate(engineBar);

      acc.scoreAll.long.push(w.longScore);
      acc.scoreAll.short.push(w.shortScore);

      // Tier flags, counted per SIDE on every bar — the raw per-side flag with
      // no other gate applied (tier-diagnostic.mjs section E, same definition).
      for (const side of ["long", "short"]) {
        const near = acc.near[side];
        const d1 = side === "long" ? lz.nearD1LiquidityLong : lz.nearD1LiquidityShort;
        const h4 = side === "long" ? lz.nearH4LiquidityLong : lz.nearH4LiquidityShort;
        const h1 = side === "long" ? lz.nearH1LiquidityLong : lz.nearH1LiquidityShort;
        if (d1) near.D1 += 1;
        if (h4) near.H4 += 1;
        if (h1) near.H1 += 1;
        if (d1 || h4 || h1) near.any += 1;
      }

      // Zone geometry, per tier: pairs, in-band, in-body split.
      const livePerTier = { D1: 0, H4: 0, H1: 0 };
      for (const z of lz.zones) {
        const name = TIER_OF_INDEX[z.tier];
        if (name === undefined) continue;
        livePerTier[name] += 1;
        const p = acc.zones[name];
        p.pairs += 1;
        p.halfWidths.push(z.halfWidth);
        if (z.bornBar === i) acc.zones.created[name] += 1;

        const width = st.candidate.bandWidth({
          atrChart,
          atrH4: ctx.h4.atrValue,
          atrD1: ctx.d1.atrValue,
          atrH1: ctx.h1.atrValue,
          zone: z,
        });
        if (width === null) continue;
        if (livePerTier[name] === 1) p.bandWidths.push(width);
        const distance = Math.abs(c.c - z.center);
        if (distance <= width) {
          p.withinBand += 1;
          const inBody = c.h >= z.center - z.halfWidth && c.l <= z.center + z.halfWidth;
          if (inBody) p.withinBandInBody += 1;
          else p.eligible += 1;
        }
      }
      for (const name of TIER_NAMES) {
        if (livePerTier[name] > 0) acc.zones[name].liveBars += 1;
      }

      // Candidate moments: the bars where the binary model's non-score gates
      // pass (D.1 strict). Same population the baseline calls "candidates".
      if (b.longSignalStrict) {
        acc.candidates.long += 1;
        acc.scoreCandidate.long.push(w.longScore);
        recordTier(acc.candidateTier.long, {
          anyFlag: Boolean(lz.nearLiquidityLong),
          d1: Boolean(lz.nearD1LiquidityLong),
          h4: Boolean(lz.nearH4LiquidityLong),
          h1: Boolean(lz.nearH1LiquidityLong),
        });
      }
      if (b.shortSignalStrict) {
        acc.candidates.short += 1;
        acc.scoreCandidate.short.push(w.shortScore);
        recordTier(acc.candidateTier.short, {
          anyFlag: Boolean(lz.nearLiquidityShort),
          d1: Boolean(lz.nearD1LiquidityShort),
          h4: Boolean(lz.nearH4LiquidityShort),
          h1: Boolean(lz.nearH1LiquidityShort),
        });
      }

      if (w.longSignalFired) acc.fired.weighted.push({ barIndex: i, side: "long", price: c.c });
      if (w.shortSignalFired) acc.fired.weighted.push({ barIndex: i, side: "short", price: c.c });
      if (b.longSignalFired) acc.fired.binary.push({ barIndex: i, side: "long", price: c.c });
      if (b.shortSignalFired) acc.fired.binary.push({ barIndex: i, side: "short", price: c.c });
    }
  }

  return { labelCandles, states, droppedBuckets: {
    h1: ctx.h1.available ? ctx.h1.series.droppedBuckets : null,
    h4: ctx.h4.available ? ctx.h4.series.droppedBuckets : null,
    d1: ctx.d1.available ? ctx.d1.series.droppedBuckets : null,
  } };
}

// ─── Assembly ────────────────────────────────────────────────────────────────

function summariseCandidate(st, labelCandles, tf, avail, options) {
  const acc = st.acc;
  const tiers = {};
  for (const name of TIER_NAMES) {
    const p = acc.zones[name];
    const fires = acc.near.long[name] + acc.near.short[name];
    const producible = avail.available[name.toLowerCase()];
    const halfWidthP50 = medianOf(p.halfWidths);
    const bandP50 = medianOf(p.bandWidths);
    tiers[name] = {
      producible,
      zonesCreated: acc.zones.created[name],
      liveBars: p.liveBars,
      barZonePairs: p.pairs,
      withinBand: p.withinBand,
      withinBandButInBody: p.withinBandInBody,
      eligiblePairs: p.eligible,
      tierFlagFires: fires,
      firesLong: acc.near.long[name],
      firesShort: acc.near.short[name],
      medianHalfWidth: halfWidthP50,
      medianBandWidth: bandP50,
      bodyToBandRatio:
        halfWidthP50 !== null && bandP50 ? round(halfWidthP50 / bandP50, 3) : null,
      discriminator: discriminator({ eligible: p.eligible, fires, producible }),
    };
  }

  const scoreCeiling = Math.max(
    ...acc.scoreAll.long,
    ...acc.scoreAll.short,
    0,
  );
  const candidateCeiling = Math.max(
    ...acc.scoreCandidate.long,
    ...acc.scoreCandidate.short,
    0,
  );

  return {
    id: st.candidate.id,
    family: st.candidate.family,
    k: st.candidate.k,
    expression: st.candidate.expr,
    isShipped: st.candidate.family === "A",
    counterfactual: st.candidate.family !== "A",
    note: st.candidate.note,
    givesUp: st.candidate.givesUp,
    tiers,
    discriminatorHolds: TIER_NAMES.filter((name) => tiers[name].producible).every(
      (name) => tiers[name].discriminator.consistent,
    ),
    candidates: { long: acc.candidates.long, short: acc.candidates.short, total: acc.candidates.long + acc.candidates.short },
    candidateTierMix: { long: mixOf(acc.candidateTier.long), short: mixOf(acc.candidateTier.short) },
    score: {
      maxScore: st.weighted.maxScore,
      minConfidence: st.weighted.defaults.minConfidence,
      observedCeilingAllBars: scoreCeiling,
      observedCeilingCandidates: candidateCeiling,
      atOrAboveMinConfidence:
        acc.scoreCandidate.long.filter((s) => s >= st.weighted.defaults.minConfidence).length +
        acc.scoreCandidate.short.filter((s) => s >= st.weighted.defaults.minConfidence).length,
    },
    fired: {
      weighted: hitRateScope(labelCandles, acc.fired.weighted, options),
      binary: hitRateScope(labelCandles, acc.fired.binary, options),
    },
  };
}

/** Deltas against the shipped candidate, per grid. Null where either side is absent. */
function deltasAgainst(summaries, baselineSummary) {
  const dd = (a, b) => (a === null || a === undefined || b === null || b === undefined ? null : a - b);
  return summaries.map((s) => {
    const out = {
      id: s.id,
      expression: s.expression,
      tiers: {},
      candidatesTotal: dd(s.candidates.total, baselineSummary.candidates.total),
      observedCeilingAllBars: dd(s.score.observedCeilingAllBars, baselineSummary.score.observedCeilingAllBars),
      weightedFired: dd(s.fired.weighted.dependent.signals, baselineSummary.fired.weighted.dependent.signals),
      binaryFired: dd(s.fired.binary.dependent.signals, baselineSummary.fired.binary.dependent.signals),
      weightedHitRateDepPp: dd(
        s.fired.weighted.dependent.hitRatePercent,
        baselineSummary.fired.weighted.dependent.hitRatePercent,
      ),
      binaryHitRateDepPp: dd(
        s.fired.binary.dependent.hitRatePercent,
        baselineSummary.fired.binary.dependent.hitRatePercent,
      ),
    };
    for (const name of TIER_NAMES) {
      out.tiers[name] = {
        producible: s.tiers[name].producible,
        eligiblePairs: s.tiers[name].producible
          ? dd(s.tiers[name].eligiblePairs, baselineSummary.tiers[name].eligiblePairs)
          : null,
        tierFlagFires: s.tiers[name].producible
          ? dd(s.tiers[name].tierFlagFires, baselineSummary.tiers[name].tierFlagFires)
          : null,
      };
    }
    return out;
  });
}

/**
 * THE FAITHFULNESS PROOF.
 *
 * Candidate A must reproduce `runComparison`'s own fired counts and Definition
 * A outcome counts EXACTLY on this grid. It is a THROW, not a warning: a sweep
 * whose reference row cannot reproduce the shipped baseline is a sweep whose
 * other rows mean nothing, and continuing would print confident numbers about
 * an indicator that was never measured.
 */
function assertBaselineFidelity(baselineResult, summaryA, tf) {
  const problems = [];
  for (const model of ["weighted", "binary"]) {
    const expected = baselineResult.models[model].signals.fired.total;
    const got = summaryA.fired[model].dependent.signals;
    if (expected !== got) {
      problems.push(`${model} fired ${got}, baseline says ${expected}`);
    }
    const expectedWins = baselineResult.models[model].definitionA.counts.win;
    const expectedLosses = baselineResult.models[model].definitionA.counts.loss;
    if (
      summaryA.fired[model].dependent.counts.win !== expectedWins ||
      summaryA.fired[model].dependent.counts.loss !== expectedLosses
    ) {
      problems.push(
        `${model} D.4 outcome counts ${summaryA.fired[model].dependent.counts.win}W/` +
          `${summaryA.fired[model].dependent.counts.loss}L, baseline says ` +
          `${expectedWins}W/${expectedLosses}L`,
      );
    }
  }
  const baselineCandidates =
    baselineResult.models.binary.conditions.population.long +
    baselineResult.models.binary.conditions.population.short;
  if (summaryA.candidates.total !== baselineCandidates) {
    problems.push(
      `candidate bars ${summaryA.candidates.total}, baseline says ${baselineCandidates}`,
    );
  }
  if (problems.length > 0) {
    throw new Error(
      `band: REFUSING on ${tf.id} — candidate A does not reproduce the baseline: ` +
        `${problems.join("; ")}. Every other row in this sweep is a delta against ` +
        "candidate A, so an unfaithful reference row invalidates all of them.",
    );
  }
  return {
    claim: "candidate A reproduces `baseline` exactly on this grid",
    baselineFired: {
      weighted: baselineResult.models.weighted.signals.fired.total,
      binary: baselineResult.models.binary.signals.fired.total,
    },
    bandFired: {
      weighted: summaryA.fired.weighted.dependent.signals,
      binary: summaryA.fired.binary.dependent.signals,
    },
    baselineD4: Object.fromEntries(
      ["weighted", "binary"].map((m) => [
        m,
        `${baselineResult.models[m].definitionA.counts.win}W/` +
          `${baselineResult.models[m].definitionA.counts.loss}L`,
      ]),
    ),
    bandD4: Object.fromEntries(
      ["weighted", "binary"].map((m) => [
        m,
        `${summaryA.fired[m].dependent.counts.win}W/${summaryA.fired[m].dependent.counts.loss}L`,
      ]),
    ),
    baselineCandidates,
    bandCandidates: summaryA.candidates.total,
    matches: true,
  };
}

function runBandSweep(candles, meta, tf, options) {
  const candidates = proximityCandidates();
  const { labelCandles, states } = sweep(candles, tf, candidates);
  const avail = htfAvailability(tf.stepMs);

  const summaries = states.map((st) =>
    summariseCandidate(st, labelCandles, tf, avail, options),
  );
  const baselineSummary = summaries.find((s) => s.family === "A");
  const fidelity = assertBaselineFidelity(
    runComparison(candles, meta, tf),
    baselineSummary,
    tf,
  );

  return {
    schemaVersion: SCHEMA_VERSION,
    ok: true,
    generatedBy: "backtest/band.mjs (proximity-band counterfactual sweep)",
    counterfactualNotice:
      "EVERY CANDIDATE EXCEPT A IS COUNTERFACTUAL. Each row answers \"what would happen " +
      "IF src/modules/liquidity-zones.pine:297 were this expression instead\". None of " +
      "them describes the shipped indicator, and nothing in this file changes src/. A is " +
      "the shipped expression and is the reference every other row is a delta against.",
    sourceExpression: {
      file: "src/modules/liquidity-zones.pine",
      line: 297,
      pine: "        bool nearP   = math.abs(close - zp.center) <= atrChart * proxATRMult",
      port: "backtest/modules/liquidity-zones.mjs:443 — const near = Math.abs(close - zp.center) <= atrChart * cfg.proxATRMult",
      harnessMatchesPort: true,
      harnessMatchesPine:
        baselineCandidate().expr === `atrChart * ${PROX_MULT}` &&
        BAND_FAMILIES.chart({ atrChart: 7, atrH4: 100 }) === 7 * PROX_MULT,
      note:
        "the multiplier itself is the Pine input default proxATRMult = 3.0 " +
        "(liquidity-zones.pine:62), mirrored at modules/liquidity-zones.mjs:93",
    },
    dataset: {
      path: tf.datasetRel,
      bars: candles.length,
      firstIso: iso(candles[0].t),
      lastIso: iso(candles[candles.length - 1].t),
      spanDays: round((candles[candles.length - 1].t - candles[0].t) / 86400000, 4),
      status: meta?.status ?? null,
    },
    timeframe: {
      id: tf.id,
      nativeStepMs: tf.stepMs,
      minutesPerBar: tf.minutesPerBar,
      barsPerDailyBar: MS_1D / tf.stepMs,
      d1PivotWarmupNativeBars: nativeBarsForDays(21, tf.stepMs),
      unavailableHtf: avail.unavailable.map((t) => t.name),
      holdBars: EXIT_RULE_DEFAULTS.maxHorizonBars,
      holdHuman: `${EXIT_RULE_DEFAULTS.maxHorizonBars} bars = ` +
        `${round((EXIT_RULE_DEFAULTS.maxHorizonBars * tf.minutesPerBar) / 60, 2)} h`,
    },
    config: {
      proxATRMult: PROX_MULT,
      zoneATRMult: LIQUIDITY_ZONE_DEFAULTS.zoneATRMult,
      maxZones: LIQUIDITY_ZONE_DEFAULTS.maxZones,
      maxZoneDistanceATR: LIQUIDITY_ZONE_DEFAULTS.maxZoneDistanceATR,
      maxZoneAgeBars: LIQUIDITY_ZONE_DEFAULTS.maxZoneAgeBars,
      sweptRetainBars: LIQUIDITY_ZONE_DEFAULTS.sweptRetainBars,
      sweepWindow: LIQUIDITY_ZONE_DEFAULTS.sweepWindow,
      minConfidence: 70,
      maxScore: 110,
      tierWeights: { D1: 30, H4: 20, H1: 10 },
      exitTargetPct: 1.5,
      exitStopPct: 0.8,
      minObservationsForInterval: MIN_OBSERVATIONS_FOR_INTERVAL,
      independentWindowBars: INDEPENDENT_WINDOW_BARS,
      seed: options.seed,
      bootstrap: options.bootstrap,
    },
    candidateList: {
      wideningK: [...WIDENING_K],
      scaleFreeK: [...SCALE_FREE_K],
      total: candidates.length,
      complete: candidates.length === 3 + WIDENING_K.length + SCALE_FREE_K.length,
      note:
        "the set is frozen and every member is printed; a sweep that omitted its " +
          "uninteresting rows would let a reader believe the ladder was chosen after " +
          "seeing which end worked",
    },
    fidelity,
    candidates: summaries,
    deltasVsShipped: deltasAgainst(summaries, baselineSummary),
    reachability: reachabilityVerdict({
      candidates: summaries,
    }),
    caveats: [
      "COUNTERFACTUAL, NOT A MEASUREMENT OF THE INDICATOR: rows other than A describe an " +
        "indicator that does not exist. No candidate is wired anywhere and nothing under " +
        "src/ changed.",
      "NOT A RECOMMENDATION: this report presents a set with consequences. Choosing a " +
        "formula to ship is the maintainer's decision, and picking the best-looking cell " +
        "of a sweep is the overfitting this project has already refused four times.",
      "MORE SIGNALS IS NOT PROGRESS: a wider band flags more approaches trivially, and " +
        "more approaches can be more BAD approaches. The binary model's hit rate on this " +
        "grid is the reference point every row has to be read against, not the signal count.",
      "OVERLAPPING WINDOWS, NOT A PORTFOLIO SIMULATION: labels are independent forward " +
        "windows over one shared candle series. Two signals 6 bars apart share 282 of " +
        "their 288 forward bars. Hit rates over the DEPENDENT population are descriptive " +
        "ratios, not independent-trial statistics — no CI, no p-value, no 'N trades'.",
      `THE INDEPENDENT SAMPLE IS ONE SIGNAL PER ${INDEPENDENT_WINDOW_BARS}-BAR WINDOW, ` +
        "EARLIEST ENTRY BAR (ratio.mjs selectIndependent). Below " +
        `${MIN_OBSERVATIONS_FOR_INTERVAL} resolved observations a row is REFUSED, not ` +
        "estimated, and no bootstrap is drawn at all.",
      "GROSS OF ALL COSTS: no commission, slippage, spread or funding is modelled. D.4 " +
        "itself declares commission_value=0.05 per side (0.10% round trip) plus " +
        "slippage=2 ticks (technical-spec.md:1947-1949), so every hit rate here is an " +
        "UPPER BOUND on what that strategy would realise.",
      "timeout AND insufficient_data ARE NEVER FOLDED INTO win OR loss: hit rate = " +
        "win / (win + loss), both excluded from the denominator.",
      "THE THREE GRIDS ARE ONE PRICE ACTION AT THREE RESOLUTIONS, not three samples. " +
        "Agreement between them is the same evidence counted twice and supports no " +
        "confidence interval or 'N = 3 tests' framing.",
      `CROSS-GRID HIT RATES ARE NOT LIKE-FOR-LIKE: the hold is ` +
        `${EXIT_RULE_DEFAULTS.maxHorizonBars} BARS, which is 24 HOURS on 5m and ` +
        "12 DAYS on 1h. A 40% hit rate on 5m and a 40% hit rate on 1h are answers to " +
        "different questions.",
      "A 4h RUN HAS NO 1H TIER, and its H1 cells are reported as NOT MEASURABLE rather " +
        "than zero: Pine's request.security always asks the exchange for 1h bars even on " +
        "a 4h chart, and this harness aggregates only the dataset it was given.",
      "ON A 4h CHART, atrH4 IS atrChart: the 4H context aggregates the native grid, so " +
        "candidates B and C are not merely similar to A on that grid, they are BIT-" +
        "IDENTICAL to it. That is why the 4h deltas for B and C are all zero — a " +
        "property of the grid, not a finding that anchoring to 4H is harmless. On 5m and " +
        "1h, where atrH4 and atrChart differ, the same expressions diverge sharply.",
      "THE \"HOLDS?\" CLAUSE IS ONLY AS STRONG AS ITS REFERENCE. On 4h candidate A's " +
        "binary independent hit rate is 21.05%, below D.4's 34.78% break-even, so almost " +
        "any widening scores as \"held\" there. A pass on that clause against a reference " +
        "this low is evidence of very little: it means the candidate did not go DOWN from " +
        "an already-failing level, which is not the same as being good.",
    ],
    disagreements: [
      "docs/technical-spec.md:374 still shows `atrChart * maxZoneDistanceATR` for the " +
        "DISTANCE CULL, while its own prose (:347-356) says the cull is anchored to the " +
        "4H ATR and the shipped source does so at liquidity-zones.pine:249. The source " +
        "wins; the spec's code block is stale on this one line.",
    ],
  };
}

// ─── Human-readable report ───────────────────────────────────────────────────

function tierCell(t) {
  if (!t.producible) return "not measurable";
  return `${int(t.eligiblePairs)} / ${int(t.tierFlagFires)}`;
}

function printReport(r) {
  const base = r.candidates.find((c) => c.family === "A");
  const deltas = Object.fromEntries(r.deltasVsShipped.map((d) => [d.id, d]));

  out("COUNTERFACTUAL SWEEP — every row except A is \"what WOULD happen IF the proximity");
  out("expression were changed\". Nothing under src/ changed and nothing is recommended.");
  out("");
  out(
    `COUNTERFACTUAL VERDICT on ${r.timeframe.id} — D1 reachable: ` +
      candidatesReachingD1(r).join(", "),
  );
  out(
    `  reachable AND hit rate held: ` +
      (r.reachability.anyMeetsBothClauses
        ? r.reachability.meetingBothClauses.join(", ") +
          "  (this is NOT a recommendation — see caveat C1 and section 5)"
        : "NONE. No candidate makes D1 fire on this grid without the binary model's " +
          "independent hit rate falling below the shipped expression's."),
  );
  out(`  reference (candidate A, binary): independent ${pct(r.reachability.shippedReference.binaryIndependentHitRatePercent)} ` +
    `on n=${r.reachability.shippedReference.binaryIndependentResolved} ` +
    (r.reachability.shippedReference.binaryIndependentInterval
      ? ci(...r.reachability.shippedReference.binaryIndependentInterval)
      : "REFUSED") +
    `, dependent ${pct(r.reachability.shippedReference.binaryDependentHitRatePercent)}`);
  out("");
  out(
    `dataset  ${r.dataset.path} — ${int(r.dataset.bars)} bars, ${r.dataset.firstIso} .. ` +
      `${r.dataset.lastIso}, ${r.dataset.spanDays} days, status ${r.dataset.status ?? "?"}`,
  );
  out(
    `grid     NATIVE ${r.timeframe.id} — ${int(r.timeframe.barsPerDailyBar)} bars per D1 ` +
      `bar, hold ${r.timeframe.holdHuman}, minConfidence ${r.config.minConfidence}, ` +
      `maxScore ${r.config.maxScore}, tier weights D1 ${r.config.tierWeights.D1} / ` +
      `H4 ${r.config.tierWeights.H4} / H1 ${r.config.tierWeights.H1}`,
  );
  out(
    `source   ${r.sourceExpression.file}:${r.sourceExpression.line} — ` +
      `${r.sourceExpression.pine.trim()}`,
  );
  out(
    `         harness matches the source expression: ` +
      `${r.sourceExpression.harnessMatchesPine ? "YES" : "NO"} ` +
      `(port: ${r.sourceExpression.port.split(" — ")[0].trim()})`,
  );
  if (r.timeframe.unavailableHtf.length > 0) {
    out(
      `grid     NOT MEASURABLE HERE: ${r.timeframe.unavailableHtf.join(", ")} — finer than ` +
        "the native grid, so it has no candles to aggregate. Pine would fetch it anyway; " +
        "this harness cannot. Zeros for that tier are a LIMITATION, not a finding.",
    );
  }
  out(
    `fidelity ${r.fidelity.claim}: weighted ${int(r.fidelity.bandFired.weighted)} fired ` +
      `(baseline ${int(r.fidelity.baselineFired.weighted)}), binary ` +
      `${int(r.fidelity.bandFired.binary)} (baseline ${int(r.fidelity.baselineFired.binary)}), ` +
      `D.4 ${r.fidelity.bandD4.weighted} / ${r.fidelity.bandD4.binary} ` +
      `(baseline ${r.fidelity.baselineD4.weighted} / ${r.fidelity.baselineD4.binary})`,
  );
  out("");

  // ── The table ──
  out("1. PROXIMITY AND TIER REACHABILITY — eligible pairs / tier flag fires");
  out("");
  out(
    `  ${padL("cand", 5)}${padL("expression", 26)}${padR("D1", 22)}${padR("H4", 22)}` +
      `${padR("H1", 22)}${padR("discr", 7)}`,
  );
  for (const c of r.candidates) {
    out(
      `  ${padL(c.id, 5)}${padL(c.expression, 26)}${padR(tierCell(c.tiers.D1), 22)}` +
        `${padR(tierCell(c.tiers.H4), 22)}${padR(tierCell(c.tiers.H1), 22)}` +
        `${padR(c.discriminatorHolds ? "ok" : "FAIL", 7)}`,
    );
  }
  out("");
  out("  A cell is \"eligible pairs / tier flag fires\". The discriminator requires");
  out("  (eligible > 0) === (fires > 0) per tier; \"not measurable\" is a grid limitation.");
  out("");
  out("  D1 median body / band ratio (>= 1 means the body swallows the band):");
  for (const c of r.candidates) {
    const t = c.tiers.D1;
    out(
      `  ${padL(c.id, 5)}${padR(t.producible ? (t.bodyToBandRatio ?? "n/a") : "n/a", 8)}` +
        `${padR(t.producible ? `body ${round(t.medianHalfWidth, 2)}` : "", 24)}` +
        `${padR(t.producible ? `band ${round(t.medianBandWidth, 2)}` : "", 22)}`,
    );
  }
  out("");

  // ── Tier mix at candidate moments ──
  out("2. TIER MIX AT CANDIDATE MOMENTS (D.1 strict candidate bars, long + short combined)");
  out("");
  out("  \"n/m\" = NOT MEASURABLE on this grid — the tier has no candles to aggregate, so a");
  out("  zero there would be a limitation of the data reported as a finding about the tier.");
  out("");
  out(
    `  ${padL("cand", 5)}${padR("cands", 8)}${padR("D1", 8)}${padR("H4", 8)}${padR("H1", 8)}` +
      `${padR("D1 %", 9)}${padR("H4 %", 9)}${padR("H1 %", 9)}`,
  );
  for (const c of r.candidates) {
    const m = c.candidateTierMix;
    const counts = {
      D1: m.long.counts.D1 + m.short.counts.D1,
      H4: m.long.counts.H4 + m.short.counts.H4,
      H1: m.long.counts.H1 + m.short.counts.H1,
    };
    // The percentage denominator EXCLUDES any unmeasurable tier, so the shares of
    // the measurable tiers still add to 100% instead of being diluted by a zero
    // that was never measured.
    const measured = TIER_NAMES.filter((n) => c.tiers[n].producible);
    const total = measured.reduce((sum, n) => sum + counts[n], 0);
    const cell = (n) => (c.tiers[n].producible ? int(counts[n]) : "n/m");
    const share = (n) =>
      !c.tiers[n].producible ? "n/m" : total ? pct((counts[n] / total) * 100) : "n/a";
    out(
      `  ${padL(c.id, 5)}${padR(int(c.candidates.total), 8)}${padR(cell("D1"), 8)}` +
        `${padR(cell("H4"), 8)}${padR(cell("H1"), 8)}${padR(share("D1"), 9)}` +
        `${padR(share("H4"), 9)}${padR(share("H1"), 9)}`,
    );
  }
  out("");
  out(
    `  ${padL("cand", 5)}${padR("ceiling", 12)}${padR("cand ceiling", 26)}${padR(">= minConf", 14)}`,
  );
  for (const c of r.candidates) {
    out(
      `  ${padL(c.id, 5)}${padR(`${c.score.observedCeilingAllBars}/${c.score.maxScore}`, 12)}` +
        `${padR(int(c.score.observedCeilingCandidates), 26)}${padR(int(c.score.atOrAboveMinConfidence), 14)}`,
    );
  }
  out("");

  // ── Signals and hit rates ──
  out("3. FIRED SIGNALS AND D.4 HIT RATES");
  out(`   dependent = every fired signal (overlapping windows). independent = one per`);
  out(`   ${r.config.independentWindowBars}-bar window, earliest entry bar, floor ${r.config.minObservationsForInterval}.`);
  out("");
  // One table per model rather than both side by side: a nine-column grid wide
  // enough to hold a confidence interval wraps on an 80-column terminal, and a
  // wrapped row is a misread row.
  const ciCell = (s) =>
    s.independent.interval === null
      ? "REFUSED"
      : ci(s.independent.interval.lo, s.independent.interval.hi);

  out("  weighted model (shipped configuration, minConfidence 70)");
  out(
    `  ${padL("cand", 5)}${padR("fired", 8)}${padR("dep%", 9)}${padR("ind n", 8)}` +
      `${padR("ind%", 9)}  ${padL("ind CI", 20)}`,
  );
  for (const c of r.candidates) {
    const w = c.fired.weighted;
    out(
      `  ${padL(c.id, 5)}${padR(int(w.dependent.signals), 8)}${padR(pct(w.dependent.hitRatePercent), 9)}` +
        `${padR(int(w.independent.resolved), 8)}${padR(pct(w.independent.hitRatePercent), 9)}  ` +
        padL(ciCell(w), 20),
    );
  }
  out("");
  out("  binary model (spec D.1 strict confluence, no score, no threshold)");
  out(
    `  ${padL("cand", 5)}${padR("fired", 8)}${padR("dep%", 9)}${padR("ind n", 8)}` +
      `${padR("ind%", 9)}  ${padL("ind CI", 20)}`,
  );
  for (const c of r.candidates) {
    const b = c.fired.binary;
    out(
      `  ${padL(c.id, 5)}${padR(int(b.dependent.signals), 8)}${padR(pct(b.dependent.hitRatePercent), 9)}` +
        `${padR(int(b.independent.resolved), 8)}${padR(pct(b.independent.hitRatePercent), 9)}  ` +
        padL(ciCell(b), 20),
    );
  }
  out("");
  out("  hit rate = win / (win + loss); timeout and insufficient_data are excluded from both.");
  out(`  ind n = RESOLVED independent observations (one per ${r.config.independentWindowBars}-bar window).`);
  out(`  REFUSED = below the ${r.config.minObservationsForInterval}-observation floor; no interval`);
  out("  is printed for that cell and none is estimated in its place.");
  out("");

  // ── Deltas ──
  out("4. DELTA AGAINST CANDIDATE A (the shipped expression) ON THIS GRID");
  out("");
  out(
    `  ${padL("cand", 5)}${padR("D1 elig", 10)}${padR("D1 fires", 10)}${padR("w fired", 10)}` +
      `${padR("w dep pp", 10)}${padR("b fired", 10)}${padR("b dep pp", 10)}${padR("ceiling", 10)}`,
  );
  for (const d of r.deltasVsShipped) {
    out(
      `  ${padL(d.id, 5)}${padR(dint(d.tiers.D1.eligiblePairs), 10)}${padR(dint(d.tiers.D1.tierFlagFires), 10)}` +
        `${padR(dint(d.weightedFired), 10)}${padR(dpp(d.weightedHitRateDepPp), 10)}` +
        `${padR(dint(d.binaryFired), 10)}${padR(dpp(d.binaryHitRateDepPp), 10)}` +
        `${padR(dint(d.observedCeilingAllBars), 10)}`,
    );
  }
  out("");

  // ── Trade-offs ──
  out("5. WHAT EACH CANDIDATE GIVES UP");
  out("");
  for (const c of r.candidates) {
    out(`  ${padL(c.id, 5)}${c.givesUp}`);
  }
  out("");
  out("  A wider band ADMITS approaches the shipped rule deliberately excludes: any bar");
  out("  whose close is within the wider band but outside the zone body is flagged, and");
  out("  the author's in-body exclusion exists precisely to withhold those. Widening is");
  out("  a behavioural change to what counts as \"approaching liquidity\", not a free win.");
  out("");

  // ── The two-clause verdict, per candidate ──
  out("5b. REACHABLE AND HELD? — one row per candidate, both clauses computed");
  out("");
  out(`  clause 1: ${r.reachability.test.clause1}`);
  out(`  clause 2: ${r.reachability.test.clause2}`);
  out(`  reference: ${r.reachability.test.referenceModel} — ${r.reachability.test.referenceReason}`);
  out("");
  out(
    `  ${padL("cand", 5)}${padR("D1 reach", 9)}${padR("D1 fires", 10)}${padR("b ind n", 9)}` +
      `${padR("b ind%", 9)}  ${padL("holds?", 7)}${padL("both?", 7)}reason`,
  );
  for (const row of r.reachability.rows) {
    out(
      `  ${padL(row.id, 5)}${padR(row.d1Reachable ? "yes" : "no", 9)}` +
        `${padR(row.d1Reachable ? int(row.d1Fires) : "-", 10)}` +
        `${padR(int(row.binaryIndependentResolved), 9)}` +
        `${padR(pct(row.binaryIndependentHitRatePercent), 9)}  ` +
        `${padL(row.hitRateHolds === null ? "n/a" : row.hitRateHolds ? "yes" : "NO", 7)}` +
        `${padL(row.meetsBothClauses ? "YES" : "no", 7)}${row.reason}`,
    );
  }
  out("");
  out("  \"holds?\" compares against candidate A's independent hit rate on THIS grid.");
  out("  It is not a significance test (caveat C7) and not a ranking: rows are not ordered");
  out("  against each other and no winner is named anywhere in this report.");
  out("");

  out("6. READ BEFORE QUOTING ANY NUMBER ABOVE");
  out("");
  r.caveats.forEach((c, i) => out(`  [C${i}] ${c}`));
  out("");
  out("  DISAGREEMENT WITH THE SOURCE-ADJACENT DOCS");
  r.disagreements.forEach((d) => out(`  [D] ${d}`));
  out("");
}

function candidatesReachingD1(r) {
  const list = r.candidates
    .filter((c) => c.tiers.D1.producible && c.tiers.D1.tierFlagFires > 0)
    .map((c) => c.id);
  return list.length > 0 ? list : ["NONE"];
}

/**
 * THE TWO-CLAUSE TEST, computed rather than eyeballed.
 *
 * The question has two halves and a row only answers it if BOTH hold:
 *
 *   reachable — the D1 tier flag fires at least once on this grid. Without this
 *               the row has not even addressed the defect.
 *   holds     — the binary model's INDEPENDENT-sample hit rate is not below
 *               candidate A's independent point estimate on the same grid.
 *
 * The binary model is the reference rather than the weighted model because the
 * weighted model's independent sample is refused on 5m (n = 1 resolved) and on
 * 4h (n = 20): there is no weighted number to hold or collapse.
 *
 * WHAT THIS IS NOT. It is not a significance test and it is not a selection
 * rule. Two independent samples drawn from ONE price series at overlapping
 * windows are not two independent samples at all (caveat C7), so "not below"
 * here means "did not go down on this dataset", never "is better". A row that
 * passes both clauses has survived contact with a hit rate on this data. What it
 * should then be shipped AS is a separate decision, and it is not one this file
 * makes. Nothing here ranks rows against each other, because picking the
 * best-looking cell of a sweep is the overfitting this project has refused four
 * times now.
 */
function reachabilityVerdict(r) {
  const base = r.candidates.find((c) => c.family === "A");
  const baseInd = base.fired.binary.independent.hitRatePercent;
  const rows = r.candidates.map((c) => {
    const reachable = c.tiers.D1.producible && c.tiers.D1.tierFlagFires > 0;
    const ind = c.fired.binary.independent;
    const indRate = ind.hitRatePercent;
    const holds = indRate === null || baseInd === null ? null : indRate >= baseInd;
    return {
      id: c.id,
      expression: c.expression,
      isShipped: c.family === "A",
      d1Reachable: reachable,
      d1Fires: c.tiers.D1.tierFlagFires,
      binaryIndependentResolved: ind.resolved,
      binaryIndependentHitRatePercent: indRate,
      binaryIndependentInterval:
        ind.interval === null ? null : [ind.interval.lo, ind.interval.hi],
      binaryIndependentRefused: ind.refused,
      // The dependent rate is printed alongside but is NOT the test: it is the
      // overlapping-window ratio, and adding signals to it is exactly what a
      // wider band does, so it would reward the sweep for producing more of the
      // data it is being judged on.
      binaryDependentHitRatePercent: c.fired.binary.dependent.hitRatePercent,
      binaryDependentSignals: c.fired.binary.dependent.signals,
      hitRateHolds: holds,
      meetsBothClauses: reachable && holds === true,
      intervalsOverlapReference:
        ind.interval === null || base.fired.binary.independent.interval === null
          ? null
          : ind.interval.lo <= base.fired.binary.independent.interval.hi &&
            base.fired.binary.independent.interval.lo <= ind.interval.hi,
      reason: !reachable
        ? "D1 never fires on this grid under this expression — the defect is not addressed"
        : holds === null
          ? "the independent hit rate is REFUSED below the observation floor, so there is no " +
            "number to hold or collapse; not scored"
          : holds
            ? "D1 reachable and the independent hit rate did not fall below the shipped " +
              "expression's on this grid"
            : "D1 reachable but the independent hit rate FELL below the shipped expression's " +
              "on this grid — more signals, worse accuracy",
    };
  });
  const both = rows.filter((r2) => r2.meetsBothClauses).map((r2) => r2.id);
  return {
    test: {
      clause1: "the D1 tier flag fires at least once on this grid",
      clause2:
        "the binary model's independent-sample hit rate is not below candidate A's " +
        "independent point estimate on this grid",
      referenceModel: "binary",
      referenceReason:
        "the weighted model's independent sample is refused on the fine and coarse grids " +
        "(n = 1 resolved on 5m, n = 20 on 4h), so there is no weighted number to compare",
      declaredBefore:
        "both clauses are computed by the same function on every row; no row was " +
          "selected, dropped or re-weighted after the numbers were seen",
      notAClaim: [
        "not a significance test — one price series at overlapping windows is not two samples",
        "not a ranking — rows are not ordered against each other and no winner is named",
        "not a shipping recommendation — no formula is proposed for adoption here",
      ],
    },
    shippedReference: {
      candidate: "A",
      binaryIndependentResolved: base.fired.binary.independent.resolved,
      binaryIndependentHitRatePercent: baseInd,
      binaryIndependentInterval:
        base.fired.binary.independent.interval === null
          ? null
          : [base.fired.binary.independent.interval.lo, base.fired.binary.independent.interval.hi],
      binaryDependentHitRatePercent: base.fired.binary.dependent.hitRatePercent,
    },
    rows,
    meetingBothClauses: both.length > 0 ? both : [],
    anyMeetsBothClauses: both.length > 0,
  };
}

// ─── Entry point ─────────────────────────────────────────────────────────────

export async function runBand(options = {}) {
  const json = Boolean(options.json);
  const tf = options.tf ?? DEFAULT_TF;
  const started = Date.now();
  const seed = options.seed ?? DEFAULT_SEED;
  const bootstrap = options.bootstrap ?? DEFAULT_BOOTSTRAP;

  try {
    const { candles, meta } = await loadDataset(tf);
    const result = runBandSweep(candles, meta, tf, { seed, bootstrap });
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
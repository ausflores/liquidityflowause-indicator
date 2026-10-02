// ============================================================================
// LiquidityFlowAuse — Exit-ratio analysis on an INDEPENDENT sample
// ----------------------------------------------------------------------------
// The number docs/WEIGHT-CALIBRATION.md section 7 asked for and did not have:
// is the EXIT RATIO, rather than the weight vector, the binding constraint?
//
// ─── WHY A NEW SAMPLE EXISTS AT ALL ──────────────────────────────────────────
//
// `compare` already proved that on 1h the binary model's 1,701 signals are ONE
// cluster — max consecutive gap 261 bars against a 288-bar horizon — so no
// interval on the D.4 hit rate is computable there. A ratio sweep run over those
// dependent observations would be fitting noise: the sweep would produce a
// surface whose shape is decided by how many overlapping windows happen to sit
// in each stretch of price.
//
// So this file does NOT sweep over the existing signals. It BUILDS a sample
// whose observations are independent BY CONSTRUCTION (see SELECTION below) and
// then asks the ratio question on that sample. The sample is small and the
// trade is deliberate: a small honest sample beats a large dependent one, and
// this project's entire reason for existing is that it will not trade the
// first for the second.
//
// ─── THE SELECTION RULE, STATED BECAUSE IT IS A CHOICE ───────────────────────
//
// PARTITION. The bar axis is cut into non-overlapping windows of `windowBars`
// (= 288, the Definition A horizon): window(b) = floor(b / 288). Two signals in
// the same window share forward bars by construction, so at most one may count.
//
// SELECTION. Inside each window, per model and per side, the signal with the
// EARLIEST ENTRY BAR is kept and the rest are discarded.
//
// WHY earliest-entry-bar and not something smarter:
//   * it is the only rule that cannot see the outcome. "Highest score" is
//     computable at entry but is a proxy for signal quality — it selects on the
//     very thing under test. "Closest to a level" needs the zone state at entry
//     and, worse, silently biases toward setups that graze a band.
//   * it is arbitrary, which is the POINT. The reader can check it. A cleverer
//     rule would produce a narrower interval and a less honest one.
//   * the cost is stated, not hidden: this is still a SELECTION EFFECT. The
//     sample is the model's behaviour at one arbitrary point per window, not a
//     random draw of the model's behaviour. A different arbitrary point per
//     window would give a different answer, and the spread between such choices
//     is not measured here.
//
// ─── WHAT THIS DOES NOT DO ───────────────────────────────────────────────────
//
// It does not recommend a ratio. It does not report a best cell. Reporting the
// maximum of a 143-cell sweep evaluated on one sample is the overfitting this
// project exists to avoid, and a recommendation would be worse than no answer.
// The surface is printed as a surface and its ZERO CROSSING is the output; where
// that crossing is inside the sampled noise, this file says so and stops.
//
// It is not a portfolio simulation, models no costs, and applies no spread
// filter (D.3's `spreadOK` is absent from src/). Every expectancy here is GROSS
// and therefore an UPPER BOUND on what D.4's own `strategy()` declaration —
// commission_value=0.05 per side, slippage=2 — would realize.
//
// ─── REUSE, NOT RE-DERIVATION ────────────────────────────────────────────────
//
// Signals come from baseline.mjs's own runComparison() through its `sink` side
// channel, and the seeded RNG and flag grammar come from compare.mjs. The
// D.4 hit rates are produced by modules/label.mjs ITSELF — and because that
// module deliberately hard-codes the 1.5/0.8 levels and REJECTS a targetPct or
// stopPct option, the parameterised labeller used for the surface is a separate
// function which is PROVEN EQUAL to label.mjs at the shipped levels by
// verifyParametricLabeller() below, over every real signal of both models. If
// the two ever disagree the run throws instead of printing a surface.
//
// Usage:
//   node backtest/run.mjs ratio [--timeframe <5m|1h|4h>] [--seed <n>]
//                               [--bootstrap <n>] [--json]
// ============================================================================

import { DEFAULT_TIMEFRAME, getTimeframe } from "./timeframes.mjs";
import { loadDataset, runComparison } from "./baseline.mjs";
import {
  EXIT_RULE_DEFAULTS,
  EXIT_STOP_PCT,
  EXIT_TARGET_PCT,
  FORWARD_RETURN_DEFAULTS,
  labelSignalsExitRule,
  labelSignalsForwardReturn,
} from "./modules/label.mjs";
import { makeRng, parseCompareFlags, percentileOfSorted } from "./compare.mjs";

const SCHEMA_VERSION = 1;

/**
 * Fixed default seed, and the SAME value compare.mjs prints. One convention for
 * every bootstrap in the harness, so a number quoted from either report can be
 * reproduced with the same command shape. `--seed` overrides it.
 */
const DEFAULT_SEED = 20260901;

/**
 * Draws for the HEADLINE statistics (the per-scope hit-rate intervals and the
 * break-even arithmetic built on them).
 *
 * 10,000 is compare.mjs's own default and is kept so the two reports are
 * directly comparable. Over ~150 resampling units a binomial SE of ~0.04 at
 * p~0.5 means the 2.5th percentile is stable to well under a tenth of a
 * percentage point at this draw count.
 */
const DEFAULT_BOOTSTRAP = 10000;

/**
 * Draws for the EXPECTANCY SURFACE's per-cell intervals.
 *
 * Lower than the headline on purpose, and the number is PRINTED so the reader
 * is never guessing. The surface is TARGET_GRID.length * STOP_GRID.length cells
 * (143) times two models, each cell resampling every observation on every draw:
 * 10,000 draws would be ~4.3e8 resampling steps per grid. 2,000 draws still put
 * the 2.5th percentile past Monte-Carlo noise for the cell intervals (percentile
 * resolution 0.05 pp of the draw order), and the surface's purpose is to locate
 * a SIGN CHANGE, not to resolve a cell to three decimals.
 */
const DEFAULT_SURFACE_BOOTSTRAP = 2000;

/**
 * Below this many INDEPENDENT observations, no interval is printed.
 *
 * This is a reporting POLICY applied BEFORE any number is looked at, and it is
 * the same policy compare.mjs applies to clusters: a percentile interval over a
 * handful of units would print a precision the data cannot support. Note what it
 * is counting — independent observations, never signals — because that is the
 * whole point of this file.
 */
const MIN_OBSERVATIONS_FOR_INTERVAL = 30;

/**
 * D.4's own declared round-trip cost, BEFORE slippage:
 * commission_type=percent, commission_value=0.05 per side (spec :1947-1949).
 * 0.05 * 2 = 0.10. Slippage=2 ticks is NOT converted here — a tick is not a
 * fixed percentage of price, and inventing one would be exactly the kind of
 * unfounded number this harness refuses to print.
 */
const D4_ROUND_TRIP_COMMISSION_PCT = 0.10;

/**
 * Surface axes. D.4 declares targetPct minval=0.5 (spec :1961) and stopPct
 * minval=0.3 (spec :1962); this sweeps a sub-range of D.4's own bounds around
 * the shipped 1.5 / 0.8 — the shipped D.4 maxvals are 5.0 and 2.0, which reach
 * far enough past the crossing that including them would only add cells whose
 * hit rate is near zero.
 *
 * Built by integer arithmetic so the shipped levels land on exact grid
 * indices: targets[4] === 1.5 and stops[5] === 0.8.
 */
const TARGET_STEP_QUARTERS = 1; // 0.25%
const TARGET_START_QUARTERS = 2; // 0.50%
const TARGET_END_QUARTERS = 12; // 3.00%
const STOP_START_TENTHS = 3; // 0.30%
const STOP_END_TENTHS = 15; // 1.50%

const out = (s = "") => console.log(`ratio: ${s}`);

// ─── Small helpers (mirrors baseline.mjs / compare.mjs formatting) ───────────

const iso = (ms) => new Date(ms).toISOString();
const int = (v) => Number(v).toLocaleString("en-US");
const round = (v, dp) =>
  v === null || v === undefined || Number.isNaN(v) ? null : Number(v.toFixed(dp));
const padL = (s, w) => String(s).padEnd(w);
const padR = (s, w) => String(s).padStart(w);

/** "31.25%" / "n/a" — unsigned rate. */
const pct = (v, dp = 2) => (v === null || v === undefined ? "n/a" : `${v.toFixed(dp)}%`);
/** "1.875" / "n/a" — an unsigned ratio. */
const rat = (v, dp = 3) => (v === null || v === undefined ? "n/a" : v.toFixed(dp));
/** "-0.0813 pp"-style signed percentage value. */
const spct = (v, dp = 4) =>
  v === null || v === undefined ? "n/a" : `${v > 0 ? "+" : ""}${v.toFixed(dp)}%`;

/** "[12.34%, 45.67%]" / "not reported". */
const ci = (lo, hi, dp = 2) =>
  lo === null || hi === null || lo === undefined || hi === undefined
    ? "not reported"
    : `[${lo.toFixed(dp)}%, ${hi.toFixed(dp)}%]`;
/** Signed percentage-point difference: "+15.22 pp" / "n/a". */
const pp = (v, dp = 2) => (v === null || v === undefined ? "n/a" : `${v > 0 ? "+" : ""}${v.toFixed(dp)} pp`);

// ─── The independent sample ──────────────────────────────────────────────────

/**
 * The window a bar belongs to: non-overlapping blocks of `windowBars`.
 *
 * Alignment is absolute (bar 0 is a window boundary), not anchored to the first
 * signal, so the partition is a property of the DATA and not of where the
 * model's first signal happened to fire. Re-anchoring per run would move every
 * observation and make two runs incomparable.
 */
export function windowIndexOf(barIndex, windowBars) {
  if (!Number.isInteger(barIndex) || barIndex < 0) {
    throw new RangeError(`windowIndexOf: barIndex must be a non-negative integer, got ${String(barIndex)}`);
  }
  if (!Number.isInteger(windowBars) || windowBars < 1) {
    throw new RangeError(`windowIndexOf: windowBars must be an integer >= 1, got ${String(windowBars)}`);
  }
  return Math.floor(barIndex / windowBars);
}

/**
 * At most ONE signal per window, per scope: the earliest by entry bar.
 *
 * `signals` is one model's list for one scope (`all` = both sides, or a single
 * side). Returns the kept signals, how many windows they occupy, how many
 * signals were considered, and how many were DISCARDED — the discard count is
 * returned rather than inferred, because "how much did the honest sample cost"
 * is a number the reader is entitled to.
 *
 * The sort is total (barIndex, then side) so the answer cannot depend on the
 * order the engine happened to fire in.
 */
export function selectIndependent(signals, windowBars) {
  if (!Array.isArray(signals)) throw new TypeError("selectIndependent: signals must be an array");
  if (!Number.isInteger(windowBars) || windowBars < 1) {
    throw new RangeError(`selectIndependent: windowBars must be an integer >= 1, got ${String(windowBars)}`);
  }

  const ordered = [...signals].sort((a, b) => {
    if (a.barIndex !== b.barIndex) return a.barIndex - b.barIndex;
    return a.side < b.side ? -1 : a.side > b.side ? 1 : 0;
  });

  const used = new Set();
  const selected = [];
  for (const signal of ordered) {
    const w = windowIndexOf(signal.barIndex, windowBars);
    if (used.has(w)) continue;
    used.add(w);
    selected.push(signal);
  }

  return {
    selected,
    windowsUsed: used.size,
    considered: signals.length,
    discarded: signals.length - selected.length,
    windowBars,
  };
}

// ─── Break-even algebra ──────────────────────────────────────────────────────

/**
 * The hit rate at which `expectancyPercent` is exactly zero: h = S / (T + S).
 *
 * Pure arithmetic, no data: with D.4's own 1.5 / 0.8 this is
 * 0.8 / 2.3 = 0.347826..., i.e. 34.78%.
 */
export function breakevenHitRate(targetPct, stopPct) {
  if (!(targetPct > 0) || !(stopPct > 0)) {
    throw new RangeError(
      `breakevenHitRate: targetPct and stopPct must both be > 0, got ${String(targetPct)} / ${String(stopPct)}`,
    );
  }
  return stopPct / (targetPct + stopPct);
}

/**
 * Expectancy per RESOLVED trade, in percent of entry price: h*T - (1-h)*S.
 *
 * `hitRate` is a FRACTION in [0, 1]. GROSS: no commission, no slippage, no
 * spread — see the file header.
 */
export function expectancyPercent(hitRate, targetPct, stopPct) {
  if (hitRate === null || hitRate === undefined) return null;
  if (!(hitRate >= 0 && hitRate <= 1)) {
    throw new RangeError(`expectancyPercent: hitRate must be a fraction in [0, 1], got ${String(hitRate)}`);
  }
  return hitRate * targetPct - (1 - hitRate) * stopPct;
}

/**
 * The target/stop ratio the OBSERVED hit rate would need in order to break even.
 *
 * Solving h*T = (1-h)*S for T/S gives T/S = (1-h)/h. Inverse of the break-even
 * rate: the reader who has h in hand asks "how much of a ratio does that buy?".
 *
 * Direction, which is easy to get backwards and is why it is asserted in
 * smoke.mjs: a LARGER ratio demands a HIGHER hit rate, so T/S below this value
 * means the current ratio is TOO SMALL for the accuracy actually observed.
 */
export function requiredRatio(hitRate) {
  if (hitRate === null || hitRate === undefined) return null;
  if (!(hitRate > 0 && hitRate <= 1)) {
    throw new RangeError(`requiredRatio: hitRate must be a fraction in (0, 1], got ${String(hitRate)}`);
  }
  return (1 - hitRate) / hitRate;
}

/** The shipped D.4 ratio, as a number. */
export function currentRatio() {
  return EXIT_TARGET_PCT / EXIT_STOP_PCT;
}

/**
 * requiredRatio() that reports UNDEFINED rather than throwing.
 *
 * At h = 0 the required ratio is infinite — no ratio at all breaks even — so
 * there is no finite number to print and none should be invented. A scope whose
 * independent sample never won returns null here, and the report says the ratio
 * requirement is unbounded instead of crashing the whole run on a grid that is
 * merely small.
 */
export function safeRequiredRatio(hitRate) {
  if (hitRate === null || hitRate === undefined) return null;
  if (!(hitRate > 0)) return null;
  return requiredRatio(hitRate);
}

// ─── Parameterised labelling (for the surface) ───────────────────────────────

/**
 * The D.4 exit rule with PARAMETERISED target and stop.
 *
 * modules/label.mjs deliberately hard-codes EXIT_TARGET_PCT / EXIT_STOP_PCT and
 * REJECTS those options ("the D.4 levels are spec, not knobs"), which is the
 * right call for a definition that claims to BE the spec. A surface over (T, S)
 * is a different question and needs a different function — but it must not be a
 * re-derivation, so every semantic below is mirrored from label.mjs and
 * equality at the shipped levels is asserted over all real signals by
 * verifyParametricLabeller().
 *
 * Mirrored semantics, all load-bearing:
 *   * levels measured from the signal close, mirrored for the short side;
 *   * availability BEFORE the scan — a truncated window is insufficient_data,
 *     never a win, however early it touched;
 *   * the scan starts on the bar AFTER the signal bar;
 *   * a bar touching BOTH levels is a LOSS (intra-bar order unknowable) and
 *     raises doubleTouch.
 */
export function labelExitAt(candles, signal, targetPct, stopPct, maxHorizonBars) {
  if (!Array.isArray(candles)) throw new TypeError("labelExitAt: candles must be an array");
  if (!signal || typeof signal !== "object") throw new TypeError("labelExitAt: signal must be an object");
  const { barIndex, side, price } = signal;
  if (!Number.isInteger(barIndex) || barIndex < 0) {
    throw new RangeError(`labelExitAt: barIndex must be a non-negative integer, got ${String(barIndex)}`);
  }
  if (barIndex >= candles.length) {
    throw new RangeError(`labelExitAt: barIndex ${barIndex} is beyond the last candle`);
  }
  if (side !== "long" && side !== "short") {
    throw new TypeError(`labelExitAt: side must be "long" or "short", got ${String(side)}`);
  }
  if (!(targetPct > 0) || !(stopPct > 0)) {
    throw new RangeError(
      `labelExitAt: targetPct and stopPct must be > 0, got ${String(targetPct)} / ${String(stopPct)}`,
    );
  }
  if (!Number.isInteger(maxHorizonBars) || maxHorizonBars < 1) {
    throw new RangeError(`labelExitAt: maxHorizonBars must be an integer >= 1, got ${String(maxHorizonBars)}`);
  }
  const bar0 = candles[barIndex];
  if (bar0 === null || typeof bar0 !== "object") {
    throw new TypeError(`labelExitAt: candles[${barIndex}] must be a candle object`);
  }
  // The anti-miswire invariant from label.mjs: price IS the signal bar's close.
  if (bar0.close !== price) {
    throw new TypeError(
      `labelExitAt: signal.price (${String(price)}) must be the signal bar's close ` +
        `(${String(bar0.close)}) — check barIndex and the candle field shape`,
    );
  }

  const targetPrice = side === "long" ? price * (1 + targetPct / 100) : price * (1 - targetPct / 100);
  const stopPrice = side === "long" ? price * (1 - stopPct / 100) : price * (1 + stopPct / 100);
  const barsAvailable = candles.length - barIndex - 1;

  const result = {
    label: "insufficient_data",
    side,
    barIndex,
    price,
    targetPrice,
    stopPrice,
    horizonLimit: maxHorizonBars,
    horizonBars: 0,
    barsAvailable,
    doubleTouch: false,
  };

  if (barsAvailable < maxHorizonBars) return result;

  for (let offset = 1; offset <= maxHorizonBars; offset++) {
    const index = barIndex + offset;
    const bar = candles[index];
    if (bar === null || typeof bar !== "object") {
      throw new TypeError(`labelExitAt: candles[${index}] must be a candle object`);
    }
    const hitTarget = side === "long" ? bar.high >= targetPrice : bar.low <= targetPrice;
    const hitStop = side === "long" ? bar.low <= stopPrice : bar.high >= stopPrice;
    if (hitTarget || hitStop) {
      result.horizonBars = offset;
      result.doubleTouch = hitTarget && hitStop;
      result.label = hitStop ? "loss" : "win";
      return result;
    }
  }

  result.label = "timeout";
  result.horizonBars = maxHorizonBars;
  return result;
}

/**
 * Proves labelExitAt() == modules/label.mjs at the shipped D.4 levels, over
 * every real signal of every model, comparing label, resolution bar AND the
 * double-touch flag.
 *
 * This is the guard that makes the surface trustworthy. If the parameterised
 * labeller ever drifted — a mirrored level, a scan that started on the wrong
 * bar, availability checked after the scan — the surface would still print
 * plausible numbers, computed over labels the baseline report never had. The run
 * throws instead.
 */
export function verifyParametricLabeller(labelCandles, signalsByModel, maxHorizonBars) {
  // The reference MUST be labelled at the SAME horizon this function is asked
  // to match. Passing no options here would compare against label.mjs's own
  // 288-bar default, which on a short synthetic fixture reports
  // insufficient_data everywhere and would make the check pass for the wrong
  // reason — or fail on a horizon that was never under test.
  const reference = {
    weighted: labelSignalsExitRule(labelCandles, signalsByModel.weighted, { maxHorizonBars }),
    binary: labelSignalsExitRule(labelCandles, signalsByModel.binary, { maxHorizonBars }),
  };
  const referenceIndex = {
    weighted: new Map(reference.weighted.results.map((r) => [r.barIndex, r])),
    binary: new Map(reference.binary.results.map((r) => [r.barIndex, r])),
  };

  const mismatches = [];
  let checks = 0;
  for (const model of ["weighted", "binary"]) {
    for (const signal of signalsByModel[model]) {
      const mine = labelExitAt(labelCandles, signal, EXIT_TARGET_PCT, EXIT_STOP_PCT, maxHorizonBars);
      const theirs = referenceIndex[model].get(signal.barIndex);
      checks += 1;
      if (
        mine.label !== theirs.label ||
        mine.horizonBars !== theirs.horizonBars ||
        mine.doubleTouch !== theirs.doubleTouch
      ) {
        mismatches.push(
          `${model}@${signal.barIndex}: ${mine.label}/${mine.horizonBars}/${mine.doubleTouch} ` +
            `vs label.mjs ${theirs.label}/${theirs.horizonBars}/${theirs.doubleTouch}`,
        );
      }
    }
  }
  return { ok: mismatches.length === 0, checks, mismatches };
}

// ─── The surface grid ────────────────────────────────────────────────────────

/** Target axis in percent: 0.50 .. 3.00 step 0.25 (11 values). */
export function targetGridPct() {
  const out2 = [];
  for (let q = TARGET_START_QUARTERS; q <= TARGET_END_QUARTERS; q += TARGET_STEP_QUARTERS) {
    out2.push(q / 4);
  }
  return out2;
}

/** Stop axis in percent: 0.30 .. 1.50 step 0.10 (13 values). */
export function stopGridPct() {
  const out2 = [];
  for (let t = STOP_START_TENTHS; t <= STOP_END_TENTHS; t++) {
    out2.push(t / 10);
  }
  return out2;
}

/** The cartesian (target, stop) cells, target-major so a row sweep is a stride. */
export function surfaceCells(targets = targetGridPct(), stops = stopGridPct()) {
  const cells = [];
  for (const targetPct of targets) {
    for (const stopPct of stops) {
      cells.push({ targetPct, stopPct, ratio: targetPct / stopPct });
    }
  }
  return cells;
}

// ─── Independent-sample statistics ───────────────────────────────────────────

/**
 * Outcome codes. `EXCLUDED` covers BOTH timeout and insufficient_data, which
 * are counted separately in the summaries but share one code here because the
 * bootstrap needs to know only one thing: was this observation RESOLVED.
 */
const EXCLUDED = 0;
const WIN = 1;
const LOSS = 2;

/**
 * win / loss / timeout / insufficient over the SELECTED (independent)
 * observations, plus the derived rate. timeout and insufficient_data are counted
 * and EXCLUDED from every denominator — folding them in is the easiest way to
 * make a hit rate lie, and it changes no count, only the rate.
 */
export function summariseIndependent(labelCandles, selected, maxHorizonBars, targetPct, stopPct) {
  const counts = { win: 0, loss: 0, timeout: 0, insufficient_data: 0 };
  let doubleTouch = 0;
  for (const signal of selected) {
    const r = labelExitAt(labelCandles, signal, targetPct, stopPct, maxHorizonBars);
    counts[r.label] += 1;
    if (r.doubleTouch) doubleTouch += 1;
  }
  const resolved = counts.win + counts.loss;
  return {
    ...counts,
    resolved,
    doubleTouch,
    hitRateFraction: resolved > 0 ? counts.win / resolved : null,
    hitRatePercent: resolved > 0 ? round((counts.win / resolved) * 100, 4) : null,
  };
}

/**
 * The bootstrap DRAWS of the hit rate, as fractions in [0, 1].
 *
 * The resampling unit is the OBSERVATION, and every observation is one window's
 * single kept signal — so there is no overlapping-forward-window dependence left
 * to account for. That is the entire difference from compare.mjs's cluster
 * bootstrap, and it is why an interval is computable here at all.
 *
 * A draw whose denominator is zero has no defined rate; such draws are COUNTED
 * in `undefinedDraws` and excluded rather than coerced to 0 or 1.
 *
 * The draw array is returned, not just its percentiles, because the derived
 * quantities below (the required ratio, the per-cell expectancy) must propagate
 * THEIR OWN uncertainty from the same draws.
 */
export function bootstrapHitRateDraws(outcomes, iterations, seed) {
  const n = outcomes.length;
  if (n === 0) return { rates: [], undefinedDraws: 0 };
  const rng = makeRng(seed);
  const rates = [];
  let undefinedDraws = 0;
  for (let it = 0; it < iterations; it++) {
    let w = 0;
    let l = 0;
    for (let k = 0; k < n; k++) {
      const o = outcomes[Math.floor(rng() * n)];
      if (o === WIN) w += 1;
      else if (o === LOSS) l += 1;
    }
    if (w + l === 0) {
      undefinedDraws += 1;
      continue;
    }
    rates.push(w / (w + l));
  }
  return { rates, undefinedDraws };
}

/** Percentile interval of a bootstrap distribution, in PERCENT. */
export function hitRateInterval(ratesFraction) {
  if (ratesFraction.length === 0) {
    return { draws: 0, lo: null, hi: null, mean: null };
  }
  const sorted = [...ratesFraction].sort((a, b) => a - b);
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  return {
    draws: sorted.length,
    lo: round(percentileOfSorted(sorted, 0.025) * 100, 4),
    hi: round(percentileOfSorted(sorted, 0.975) * 100, 4),
    mean: round(mean * 100, 4),
  };
}

/**
 * Percentile interval of a TRANSFORM of a bootstrap distribution.
 *
 * `f` is applied to every kept draw and the percentiles are taken on the
 * transformed values. Doing it this way — transform the draws, then take the
 * interval — rather than transforming the interval endpoints is what makes the
 * required-ratio range correct: requiredRatio(h) = (1-h)/h is strongly convex
 * in h, so an endpoint-wise transform understates the width.
 */
export function bootstrapTransformed(ratesFraction, f) {
  // A transform can be UNDEFINED on a draw that is perfectly well defined: at
  // h = 0 the required ratio (1-h)/h has no finite value, and requiredRatio
  // rejects it. Such draws are dropped rather than allowed to throw out of the
  // middle of a report, and their absence shows up as a null bound — which is
  // the honest answer, since an all-loss sample supports no finite ratio.
  const values = ratesFraction
    .map((h) => {
      try {
        return f(h);
      } catch {
        return null;
      }
    })
    .filter((v) => Number.isFinite(v));
  if (values.length === 0) {
    return { lo: null, hi: null, mean: null, draws: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  return {
    lo: round(percentileOfSorted(sorted, 0.025), 4),
    hi: round(percentileOfSorted(sorted, 0.975), 4),
    mean: round(mean, 4),
    draws: values.length,
  };
}

// ─── Expectancy surface ──────────────────────────────────────────────────────

/**
 * Per-cell outcome codes for every observation, as one flat Int8Array.
 *
 * `observations` is the independent sample; `cells` the grid. Index
 * `cellIndex * observations.length + j` is observation j's outcome in that cell.
 * One draw index list is reused across every cell, so the cells are evaluated
 * on the SAME resampled data and their differences are paired by construction —
 * two cells that differ only because they saw different bars is a bug this
 * structure makes impossible.
 */
export function cellOutcomes(labelCandles, observations, cells, maxHorizonBars) {
  const n = observations.length;
  const out2 = new Int8Array(cells.length * n);
  for (let c = 0; c < cells.length; c++) {
    const base = c * n;
    for (let j = 0; j < n; j++) {
      const r = labelExitAt(
        labelCandles,
        observations[j],
        cells[c].targetPct,
        cells[c].stopPct,
        maxHorizonBars,
      );
      out2[base + j] = r.label === "win" ? WIN : r.label === "loss" ? LOSS : EXCLUDED;
    }
  }
  return out2;
}

/**
 * Point estimates and bootstrap intervals for every surface cell.
 *
 * One pass over the draws, one shared index list per draw, all cells filled per
 * draw. Every cell's CI comes from the SAME distribution of resamples, so a
 * crossing found between two cells is a paired statement about those two cells
 * and not a comparison of two independent bootstraps.
 */
export function bootstrapSurface(outcomes, n, cells, iterations, seed) {
  const cellCount = cells.length;
  const drawsByCell = Array.from({ length: cellCount }, () => []);
  const undefinedByCell = new Int32Array(cellCount);
  const rng = makeRng(seed);
  const idx = new Int32Array(n);

  for (let it = 0; it < iterations; it++) {
    for (let k = 0; k < n; k++) idx[k] = Math.floor(rng() * n);
    for (let c = 0; c < cellCount; c++) {
      const base = c * n;
      let w = 0;
      let l = 0;
      for (let k = 0; k < n; k++) {
        const o = outcomes[base + idx[k]];
        if (o === WIN) w += 1;
        else if (o === LOSS) l += 1;
      }
      if (w + l === 0) {
        undefinedByCell[c] += 1;
        continue;
      }
      drawsByCell[c].push(w / (w + l));
    }
  }

  return cells.map((cell, c) => {
    let win = 0;
    let loss = 0;
    for (let j = 0; j < n; j++) {
      const o = outcomes[c * n + j];
      if (o === WIN) win += 1;
      else if (o === LOSS) loss += 1;
    }
    const resolved = win + loss;
    const point = resolved > 0 ? win / resolved : null;
    const sorted = drawsByCell[c].sort((a, b) => a - b);
    const lo = sorted.length > 0 ? percentileOfSorted(sorted, 0.025) : null;
    const hi = sorted.length > 0 ? percentileOfSorted(sorted, 0.975) : null;
    const expectancy = point === null ? null : expectancyPercent(point, cell.targetPct, cell.stopPct);
    const expectancyLo = lo === null ? null : expectancyPercent(lo, cell.targetPct, cell.stopPct);
    const expectancyHi = hi === null ? null : expectancyPercent(hi, cell.targetPct, cell.stopPct);
    return {
      targetPct: cell.targetPct,
      stopPct: cell.stopPct,
      ratio: round(cell.ratio, 4),
      win,
      loss,
      resolved,
      timeoutOrExcluded: n - resolved,
      hitRatePercent: point === null ? null : round(point * 100, 4),
      hitRateCiLoPercent: lo === null ? null : round(lo * 100, 4),
      hitRateCiHiPercent: hi === null ? null : round(hi * 100, 4),
      expectancyPercent: expectancy === null ? null : round(expectancy, 4),
      expectancyCiLoPercent: expectancyLo === null ? null : round(expectancyLo, 4),
      expectancyCiHiPercent: expectancyHi === null ? null : round(expectancyHi, 4),
      // Strict: an interval that merely TOUCHES zero does not establish a sign.
      significantlyPositive:
        expectancyLo === null ? null : expectancyLo > 0,
      significantlyNegative:
        expectancyHi === null ? null : expectancyHi < 0,
      undefinedDraws: undefinedByCell[c],
    };
  });
}

/**
 * Locates where expectancy crosses zero along ONE sweep, and — the part that
 * decides whether the answer exists — whether that crossing is identified.
 *
 * `sweep` is an ordered run of cells along a single axis (target rising at fixed
 * stop, or stop rising at fixed target), each with point estimate and CI.
 *
 * A crossing is IDENTIFIED only when the whole interval on the last negative
 * cell is below zero and the whole interval on the first positive cell is above
 * it. Anything else means the sign change sits inside the sampled noise, which
 * is reported as `identified: false` with a reason rather than dressed up with
 * an interpolated point.
 *
 * The interpolation is linear between the two bracketing point estimates and is
 * only returned when the crossing is identified; an un-identified crossing
 * returns `crossingAxisValue: null` because a location would imply a precision
 * the sample does not have.
 */
export function findZeroCrossing(sweep) {
  const anyPositive = sweep.some((c) => c.significantlyPositive === true);
  const anyNegative = sweep.some((c) => c.significantlyNegative === true);

  if (!anyPositive) {
    // Two genuinely different situations must not share one explanation: a
    // surface that is established NEGATIVE throughout (the crossing lies above
    // the sampled range) is a different statement from one where every cell's
    // interval straddles zero (there is nothing to locate at all).
    return {
      identified: false,
      situation: anyNegative ? "entirely-negative" : "inside-noise",
      reason: anyNegative
        ? "no cell on this sweep is significantly positive, and some are significantly negative — " +
          "the crossing lies ABOVE the sampled range of this axis, so this sweep does not locate it"
        : "no cell on this sweep is significantly positive at the 95% level, and none is " +
          "significantly negative either — the whole sweep lies inside the sampled noise",
      bracket: null,
      crossingAxisValue: null,
      crossingRatio: null,
    };
  }

  const firstPos = sweep.findIndex((c) => c.significantlyPositive === true);
  if (firstPos === 0) {
    return {
      identified: false,
      situation: "entirely-positive",
      reason:
        "the FIRST cell of this sweep is already significantly positive, so the crossing lies " +
        "below the sampled range of this axis — it is not located by this sweep",
      bracket: null,
      crossingAxisValue: null,
      crossingRatio: null,
    };
  }
  const below = sweep[firstPos - 1];
  const above = sweep[firstPos];
  if (below.significantlyNegative !== true) {
    return {
      identified: false,
      situation: "inside-noise",
      reason:
        `the cell just below the crossing (${below.expectancyPercent}%, CI ` +
        `${ci(below.expectancyCiLoPercent, below.expectancyCiHiPercent, 4)}) is not ` +
        "significantly negative, so the sign change is inside the sampled noise",
      bracket: { below: below.axisValue, above: above.axisValue },
      crossingAxisValue: null,
      crossingRatio: null,
    };
  }

  // Linear interpolation between the two bracketing POINT estimates, on the
  // axis that is being swept.
  const e0 = below.expectancyPercent;
  const e1 = above.expectancyPercent;
  const a0 = below.axisValue;
  const a1 = above.axisValue;
  const crossing = e1 === e0 ? a1 : a0 + (0 - e0) * (a1 - a0) / (e1 - e0);
  const ratioAtCrossing = below.fixedAxisValue === null || below.fixedAxisValue === undefined
    ? a1 / crossing // stop rising, target fixed -> ratio = target / stop
    : crossing / below.fixedAxisValue; // target rising, stop fixed

  return {
    identified: true,
    situation: "identified",
    reason: null,
    bracket: { below: below.axisValue, above: above.axisValue },
    crossingAxisValue: round(crossing, 4),
    crossingRatio: round(ratioAtCrossing, 4),
  };
}

// ─── One scope ───────────────────────────────────────────────────────────────

function scopeOf(signals, side) {
  return side === "all" ? signals : signals.filter((s) => s.side === side);
}

/**
 * Hit rate with an interval, the break-even arithmetic built on it, and the
 * interval REFUSED below the observation threshold.
 *
 * Every required-ratio figure carries its propagated interval, and the
 * break-even comparison is reported as an INTERVAL TEST — "is the whole hit-rate
 * interval below the required rate?" — rather than as a comparison of two point
 * estimates. That test is the robust statement: it survives a point estimate
 * that moves when the seed moves.
 */
function analyseScope(labelCandles, signals, side, maxHorizonBars, iterations, seed) {
  const scoped = scopeOf(signals, side);
  const pick = selectIndependent(scoped, maxHorizonBars);
  const atD4 = summariseIndependent(labelCandles, pick.selected, maxHorizonBars, EXIT_TARGET_PCT, EXIT_STOP_PCT);

  const outcomes = pick.selected.map((s) => {
    const r = labelExitAt(labelCandles, s, EXIT_TARGET_PCT, EXIT_STOP_PCT, maxHorizonBars);
    return r.label === "win" ? WIN : r.label === "loss" ? LOSS : EXCLUDED;
  });

  const resolved = atD4.resolved;
  const eligible = resolved >= MIN_OBSERVATIONS_FOR_INTERVAL;

  // The raw draw distribution is kept so the required-ratio interval can be
  // propagated from the DRAWS rather than from the endpoints of h's interval.
  // Below the observation threshold NO draws are made at all: the gate is applied
  // before the computation, not after it, so an ineligible scope never produces
  // a number it then declines to print.
  const draws = eligible
    ? bootstrapHitRateDraws(outcomes, iterations, seed)
    : { rates: [], undefinedDraws: 0 };
  const boot = { ...hitRateInterval(draws.rates), undefinedDraws: draws.undefinedDraws };

  const hPoint = atD4.hitRateFraction;
  const breakEven = breakevenHitRate(EXIT_TARGET_PCT, EXIT_STOP_PCT);
  const reqPoint = safeRequiredRatio(hPoint);
  const reqCi = eligible
    ? bootstrapTransformed(draws.rates, requiredRatio)
    : { lo: null, hi: null, mean: null, draws: 0 };
  const expPoint = expectancyPercent(hPoint, EXIT_TARGET_PCT, EXIT_STOP_PCT);

  // Interval test, in percentage points: the highest hit rate the sample admits
  // is still below the required rate?
  const belowBreakEven =
    boot.hi === null ? null : boot.hi < breakEven * 100;
  const aboveBreakEven = boot.lo === null ? null : boot.lo > breakEven * 100;

  const gap = reqPoint === null ? null : reqPoint - currentRatio();

  return {
    side,
    selection: {
      rule:
        "earliest entry bar within each non-overlapping window of " +
        `${maxHorizonBars} bars; one signal per window per model per side`,
      windowBars: pick.windowBars,
      signalsConsidered: pick.considered,
      windowsUsed: pick.windowsUsed,
      signalsDiscarded: pick.discarded,
      discardPercent: pick.considered > 0 ? round((pick.discarded / pick.considered) * 100, 2) : null,
      selectionEffect:
        "an arbitrary point per window, not a random draw of the model's behaviour",
    },
    independentObservations: pick.windowsUsed,
    resolved,
    counts: { win: atD4.win, loss: atD4.loss, timeout: atD4.timeout, insufficient_data: atD4.insufficient_data },
    doubleTouch: atD4.doubleTouch,
    hitRatePercent: atD4.hitRatePercent,
    eligible,
    ineligibleReason: eligible
      ? null
      : `${resolved} resolved independent observations, below the ${MIN_OBSERVATIONS_FOR_INTERVAL} ` +
        "required to print an interval — counts are reported, no interval is",
    bootstrap: boot,
    breakeven: {
      targetPct: EXIT_TARGET_PCT,
      stopPct: EXIT_STOP_PCT,
      requiredHitRatePercent: round(breakEven * 100, 4),
      observedHitRatePercent: atD4.hitRatePercent,
      hitRateGapPp: atD4.hitRatePercent === null ? null : round(atD4.hitRatePercent - breakEven * 100, 4),
      wholeIntervalBelowRequired: belowBreakEven,
      wholeIntervalAboveRequired: aboveBreakEven,
      expectancyPercentPerTrade: expPoint === null ? null : round(expPoint, 4),
      expectancyAfterCommissionPercent: expPoint === null ? null : round(expPoint - D4_ROUND_TRIP_COMMISSION_PCT, 4),
    },
    requiredRatio: {
      point: reqPoint === null ? null : round(reqPoint, 4),
      // Explicit UNBOUNDED rather than a null the reader has to interpret: at
      // h = 0 no finite ratio breaks even.
      unbounded: hPoint === 0,
      unboundedNote:
        hPoint === 0
          ? "no win in this sample: no finite ratio breaks even, so the requirement is unbounded"
          : null,
      ciLo: reqCi.lo,
      ciHi: reqCi.hi,
      mean: reqCi.mean,
      draws: reqCi.draws,
      currentRatio: round(currentRatio(), 4),
      // Negative gap: the current ratio is SMALLER than the observed accuracy
      // can carry, i.e. too small a reward for the risk taken.
      gap: gap === null ? null : round(gap, 4),
      direction:
        gap === null
          ? hPoint === 0
            ? "UNBOUNDED — no finite ratio breaks even at h = 0"
            : "n/a"
          : gap > 0
            ? "current ratio EXCEEDS the required ratio (surplus)"
            : "current ratio is BELOW the required ratio (deficit)",
      intervalEntirelyBelowCurrentRatio: reqCi.hi === null ? null : reqCi.hi < currentRatio(),
      intervalEntirelyAboveCurrentRatio: reqCi.lo === null ? null : reqCi.lo > currentRatio(),
    },
  };
}

// ─── The ratio/hold interaction ──────────────────────────────────────────────

/**
 * Expectancy and required ratio at each hold horizon, on the SAME independent
 * sample (the partition is built at the D.4 horizon, so it stays valid — and
 * stays conservative — at every shorter one).
 *
 * D.4's `strategy.exit` carries NO time limit; the 288-bar cap is this harness's
 * Definition A, not the spec's. The hold below is therefore a property of the
 * HARNESS, and a different hold is a different trade: the same 1.5% over 30
 * minutes and over 12 days are not the same bet.
 *
 * The resolved population CHANGES with the horizon — a shorter cap turns trades
 * into `timeout`, which is excluded rather than counted as a loss — so the n is
 * printed per horizon and the rows are NOT nested samples of one another.
 */
function analyseHorizons(labelCandles, signalsByModel, maxHorizonBars, horizons, seed, iterations) {
  const rows = [];
  for (const model of ["weighted", "binary"]) {
    const pick = selectIndependent(signalsByModel[model], maxHorizonBars);
    for (const horizon of horizons) {
      const at = summariseIndependent(labelCandles, pick.selected, horizon, EXIT_TARGET_PCT, EXIT_STOP_PCT);
      const outcomes = pick.selected.map((s) => {
        const r = labelExitAt(labelCandles, s, EXIT_TARGET_PCT, EXIT_STOP_PCT, horizon);
        return r.label === "win" ? WIN : r.label === "loss" ? LOSS : EXCLUDED;
      });
      const eligible = at.resolved >= MIN_OBSERVATIONS_FOR_INTERVAL;
      const draws = eligible
        ? bootstrapHitRateDraws(outcomes, iterations, seed)
        : { rates: [], undefinedDraws: 0 };
      const boot = hitRateInterval(draws.rates);
      const reqCi = eligible ? bootstrapTransformed(draws.rates, requiredRatio) : { lo: null, hi: null };
      const h = at.hitRateFraction;
      const exp = expectancyPercent(h, EXIT_TARGET_PCT, EXIT_STOP_PCT);
      const req = safeRequiredRatio(h);
      rows.push({
        model,
        horizonBars: horizon,
        observations: pick.windowsUsed,
        resolved: at.resolved,
        hitRatePercent: at.hitRatePercent,
        eligible,
        hitRateCi: [boot.lo, boot.hi],
        expectancyPercent: exp === null ? null : round(exp, 4),
        expectancyAfterCommissionPercent: exp === null ? null : round(exp - D4_ROUND_TRIP_COMMISSION_PCT, 4),
        requiredRatio: req === null ? null : round(req, 4),
        requiredRatioCi: [reqCi.lo, reqCi.hi],
      });
    }
  }
  return rows;
}

// ─── The run ─────────────────────────────────────────────────────────────────

async function runAnalysis(options = {}) {
  const tf = options.tf ?? getTimeframe(DEFAULT_TIMEFRAME);
  const seed = options.seed ?? DEFAULT_SEED;
  const iterations = options.bootstrap ?? DEFAULT_BOOTSTRAP;
  const surfaceIterations = options.surfaceBootstrap ?? Math.min(iterations, DEFAULT_SURFACE_BOOTSTRAP);
  const json = Boolean(options.json);
  const started = Date.now();

  try {
    if (!Number.isInteger(iterations) || iterations < 1) {
      throw new RangeError(`--bootstrap must be an integer >= 1, got ${String(iterations)}`);
    }
    if (!Number.isInteger(seed) || seed < 0) {
      throw new RangeError(`--seed must be an integer >= 0, got ${String(seed)}`);
    }

    const { candles, meta } = await loadDataset(tf);

    let sink = null;
    runComparison(candles, meta, tf, (payload) => {
      sink = payload;
    });
    if (sink === null) {
      throw new Error("baseline.mjs did not invoke the sink — its wiring changed, refusing to report");
    }

    const labelCandles = sink.labelCandles;
    const signals = sink.signals;
    const horizon = EXIT_RULE_DEFAULTS.maxHorizonBars;

    // The parameterised labeller must equal modules/label.mjs at the shipped
    // levels, over every real signal, BEFORE any surface cell is computed.
    const labellerMatch = verifyParametricLabeller(labelCandles, signals, horizon);
    if (!labellerMatch.ok) {
      throw new Error(
        "the parameterised exit labeller disagrees with modules/label.mjs at the shipped " +
          `1.5/0.8 levels on ${labellerMatch.mismatches.length} signal(s) — refusing to print a ` +
          `surface computed over labels the baseline report never had: ${labellerMatch.mismatches.slice(0, 5).join("; ")}`,
      );
    }

    // ── 1. The independent sample, per model and per side ───────────────────
    const scopes = {};
    for (const side of ["all", "long", "short"]) {
      scopes[side] = {
        weighted: analyseScope(labelCandles, signals.weighted, side, horizon, iterations, seed),
        binary: analyseScope(labelCandles, signals.binary, side, horizon, iterations, seed),
      };
    }

    // ── 3. The expectancy surface (both models, `all` scope) ────────────────
    const targets = targetGridPct();
    const stops = stopGridPct();
    const cells = surfaceCells(targets, stops);
    const surfaces = {};
    const crossings = { weighted: [], binary: [] };
    for (const model of ["weighted", "binary"]) {
      const pick = selectIndependent(signals[model], horizon);
      const outcomes = cellOutcomes(labelCandles, pick.selected, cells, horizon);
      const grid = bootstrapSurface(outcomes, pick.selected.length, cells, surfaceIterations, seed);

      // Column sweeps: fixed stop, target rising.
      const rows = [];
      for (const stopPct of stops) {
        const sweep = cells
          .map((_, c) => ({ ...grid[c], axisValue: grid[c].targetPct, fixedAxisValue: stopPct }))
          .filter((c) => Math.abs(c.stopPct - stopPct) < 1e-9);
        crossings[model].push({
          sweep: "target rising",
          fixedStopPct: stopPct,
          ...findZeroCrossing(sweep),
        });
      }
      for (const targetPct of targets) {
        const sweep = cells
          .map((_, c) => ({ ...grid[c], axisValue: grid[c].stopPct, fixedAxisValue: targetPct }))
          .filter((c) => Math.abs(c.targetPct - targetPct) < 1e-9);
        crossings[model].push({
          sweep: "stop rising",
          fixedTargetPct: targetPct,
          ...findZeroCrossing(sweep),
        });
      }

      surfaces[model] = {
        observations: pick.windowsUsed,
        signalsConsidered: pick.considered,
        signalsDiscarded: pick.discarded,
        targets,
        stops,
        cells: grid,
        // How the whole surface behaves, which is what a reader needs before
        // looking for a crossing in it. A surface that is uniformly positive is
        // NOT a surface with a crossing in it, and saying so is more useful than
        // printing one "no crossing found" line per sweep.
        signStructure: {
          significantlyPositive: grid.filter((c) => c.significantlyPositive === true).length,
          significantlyNegative: grid.filter((c) => c.significantlyNegative === true).length,
          insideNoise: grid.filter((c) => c.significantlyPositive === null).length,
          minExpectancy: round(Math.min(...grid.map((c) => c.expectancyPercent ?? Infinity)), 4),
          maxExpectancy: round(Math.max(...grid.map((c) => c.expectancyPercent ?? -Infinity)), 4),
          note:
            "min/max are the SPAN of the surface, not a recommendation: no best cell is reported " +
            "and no ratio is proposed",
        },
      };
    }

    const identifiedCrossings = {
      weighted: crossings.weighted.filter((c) => c.identified),
      binary: crossings.binary.filter((c) => c.identified),
    };

    // ── 4. The ratio/hold interaction ────────────────────────────────────────
    const byHorizon = analyseHorizons(
      labelCandles,
      signals,
      horizon,
      FORWARD_RETURN_DEFAULTS.horizons,
      seed,
      iterations,
    );

    // Definition B on the independent sample: assumption-light context for the
    // horizon table, since it carries no target/stop at all.
    const forward = {
      weighted: labelSignalsForwardReturn(labelCandles, selectIndependent(signals.weighted, horizon).selected),
      binary: labelSignalsForwardReturn(labelCandles, selectIndependent(signals.binary, horizon).selected),
    };
    const independentMeanReturn = {};
    for (const model of ["weighted", "binary"]) {
      independentMeanReturn[model] = {};
      for (const h of FORWARD_RETURN_DEFAULTS.horizons) {
        let sum = 0;
        let count = 0;
        for (const r of forward[model].results) {
          const v = r.returns[h];
          if (v === null || v === undefined) continue;
          sum += v;
          count += 1;
        }
        independentMeanReturn[model][String(h)] = {
          observed: count,
          meanPercent: count > 0 ? round(sum / count, 4) : null,
        };
      }
    }

    const result = {
      schemaVersion: SCHEMA_VERSION,
      ok: true,
      generatedBy: "backtest/ratio.mjs (exit-ratio analysis on an independent sample)",
      verdict: buildVerdict(scopes, identifiedCrossings, byHorizon),
      dataset: {
        path: tf.datasetRel,
        bars: candles.length,
        firstIso: iso(candles[0].t),
        lastIso: iso(candles[candles.length - 1].t),
        spanDays: round((candles[candles.length - 1].t - candles[0].t) / 86400000, 4),
        gapCount: meta?.gapCount ?? null,
      },
      timeframe: { id: tf.id, scopeWord: tf.scopeWord, nativeStepMs: tf.stepMs, minutesPerBar: tf.minutesPerBar },
      config: {
        seed,
        bootstrapIterations: iterations,
        surfaceBootstrapIterations: surfaceIterations,
        windowBars: horizon,
        horizons: [...FORWARD_RETURN_DEFAULTS.horizons],
        hitRateDefinition: "win / (win + loss) over the independent sample; timeout and insufficient_data excluded",
        selectionRule:
          `at most one signal per model per side per non-overlapping window of ${horizon} bars; ` +
          "the earliest entry bar wins",
        minObservationsForInterval: MIN_OBSERVATIONS_FOR_INTERVAL,
        targetAxis: targets,
        stopAxis: stops,
        d4: {
          targetPct: EXIT_TARGET_PCT,
          stopPct: EXIT_STOP_PCT,
          ratio: round(currentRatio(), 4),
          requiredHitRatePercent: round(breakevenHitRate(EXIT_TARGET_PCT, EXIT_STOP_PCT) * 100, 4),
          commissionPerSidePct: 0.05,
          roundTripCommissionPct: D4_ROUND_TRIP_COMMISSION_PCT,
          slippageTicks: 2,
          slippageNote:
            "slippage=2 is declared in TICKS and is NOT converted to a percentage here — a tick " +
            "is not a fixed fraction of price, and every expectancy here is gross before it",
        },
        rng: "mulberry32, seeded; identical seed gives byte-identical output",
      },
      labellerMatch: {
        ok: labellerMatch.ok,
        checksRun: labellerMatch.checks,
        note:
          "the parameterised (target, stop) labeller equals modules/label.mjs at the shipped " +
          "1.5/0.8 on every real signal of both models",
      },
      scopes,
      surfaces,
      crossings,
      identifiedCrossings,
      byHorizon,
      independentMeanForwardReturn: independentMeanReturn,
      caveats: [
        "THE SAMPLE IS INDEPENDENT BY CONSTRUCTION, AND IT IS SMALL. One signal per 288-bar " +
          "window per model per side removes the overlapping-forward-window dependence that " +
          `makes \`compare\` refuse an interval on 1h. It also throws away most of the signal ` +
          "count. A small honest sample is worth more here than a large dependent one, and the " +
          "discard count is printed per scope so the price is visible.",
        "SELECTING ONE SIGNAL PER WINDOW IS ITSELF A SELECTION EFFECT. Keeping the earliest " +
          "entry bar is the model's behaviour at ONE ARBITRARY POINT per window, not a random " +
          "draw of its behaviour over that window. A different rule — highest score, closest " +
          "to a level, or a random pick — would give a different sample and a different " +
          "interval, and the spread between such choices is NOT measured here. Only the " +
          "earliest-entry-bar sample is on the record.",
        "SURFACE CELLS RE-LABEL, THEY DO NOT RE-WEIGHT. Each (target, stop) cell re-runs the " +
          "exit rule, so the hit rate IN THE CELL is that ratio's own hit rate and differs " +
          "cell to cell. The surface is therefore not a plane through a fixed h and must not " +
          "be read as one. It is also NOT a backtest: no fills, no costs, no portfolio.",
        "NO BEST CELL IS REPORTED AND NO RATIO IS RECOMMENDED. The maximum of a 143-cell " +
          "sweep evaluated on one sample is the overfitting this project exists to avoid. The " +
          "only output claimed here is where the surface crosses zero, and only where that " +
          "crossing is identified rather than inside the sampled noise.",
        "GROSS OF COSTS. D.4's own strategy declaration sets commission_value=0.05 per side " +
          `(0.10 round trip) and slippage=2 in ticks. Neither is modelled by the labeller, and ` +
          "no spread filter exists (D.3's spreadOK is absent from src/), so every expectancy " +
          "here is an UPPER BOUND on realised performance. The after-commission column exists " +
          "only to show the size of the offset, not to make it the headline.",
        "NOT A PORTFOLIO SIMULATION. Each observation is one forward window over one shared " +
          "series: no cash, no sizing, no compounding, no interaction between signals.",
        "THE THREE GRIDS ARE NOT INDEPENDENT SAMPLES. Same BTC/USD price action at three " +
          "resolutions; agreement across them would not be corroboration and supports no " +
          "combined n.",
        "THE 4h RUN HAS NO 1H TIER. Pine's request.security always requests 1h, so a 4h " +
          "dataset cannot supply it; that tier is reported as not measurable, never as zero.",
        "288 BARS IS NOT THE SAME HOLD ON EVERY GRID: 24h on 5m, 288h on 1h, 1,152h on 4h. " +
          "Cross-grid hit rates are not like-for-like, and the horizon table is the in-grid " +
          "version of the same problem.",
        "THE HORIZON TABLE CHANGES ITS OWN POPULATION. A shorter cap turns trades into " +
          "timeout, which is excluded rather than counted as a loss, so the rows are not " +
          "nested samples of one another and the n is printed per row.",
        "NO INTERVAL IS REFUSED-THEN-APPROXIMATED. Below " +
          `${MIN_OBSERVATIONS_FOR_INTERVAL} resolved independent observations a scope reports ` +
          "counts and no interval. Refusing is a policy applied before any number is looked " +
          "at, and it is not relaxed for a scope that happens to look favourable.",
      ],
      runtimeMs: Date.now() - started,
    };

    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printReport(result);
      out("");
      out(`runtime ${int(result.runtimeMs)} ms (wall clock, this run)`);
      out("");
    }
    return 0;
  } catch (err) {
    if (json) {
      console.log(JSON.stringify({ schemaVersion: SCHEMA_VERSION, ok: false, error: err.message }, null, 2));
    } else {
      out("");
      out(`FAILED - ${err.message}`);
      out("");
    }
    return 1;
  }
}

function buildVerdict(scopes, identifiedCrossings, byHorizon) {
  const lines = [];
  const a = scopes.all;
  const be = a.weighted.breakeven.requiredHitRatePercent;

  lines.push(
    `D.4's shipped 1.5% / 0.8% ratio requires a ${be.toFixed(2)}% hit rate. On this grid the ` +
      `INDEPENDENT sample measured weighted ${pct(a.weighted.hitRatePercent)} ` +
      `${ci(a.weighted.bootstrap.lo, a.weighted.bootstrap.hi)} from ` +
      `${int(a.weighted.resolved)} observations and binary ${pct(a.binary.hitRatePercent)} ` +
      `${ci(a.binary.bootstrap.lo, a.binary.bootstrap.hi)} from ${int(a.binary.resolved)} ` +
      "observations.",
  );

  for (const model of ["weighted", "binary"]) {
    const s = a[model];
    if (!s.eligible) {
      lines.push(
        `${model}: ${s.ineligibleReason}. No break-even verdict is computable for this scope, and ` +
          "none is claimed.",
      );
      continue;
    }
    const below = s.breakeven.wholeIntervalBelowRequired;
    const req = s.requiredRatio;
    const reqSentence = req.unbounded
      ? "This sample never won, so NO finite ratio breaks even and the requirement is unbounded."
      : `The observed accuracy would carry a ratio of ${rat(req.point)} ` +
        `[${rat(req.ciLo)}, ${rat(req.ciHi)}] against the shipped ${rat(req.currentRatio)} — ` +
        `${req.direction.toLowerCase()} of ${rat(Math.abs(req.gap))}.`;
    lines.push(
      `${model}: expectancy ${spct(s.breakeven.expectancyPercentPerTrade)} per resolved trade gross ` +
        `(${spct(s.breakeven.expectancyAfterCommissionPercent)} after D.4's declared commission). ` +
        (below === true
          ? `The whole 95% hit-rate interval lies BELOW the required ${be.toFixed(2)}%, so the deficit is ` +
            "established independently of the point estimate. "
          : below === false
            ? `The hit-rate interval OVERLAPS the required ${be.toFixed(2)}%, so the deficit is NOT ` +
              "established at 95%. "
            : "No interval is available, so no deficit verdict is claimed. ") +
        reqSentence,
    );
  }

  const wCross = identifiedCrossings.weighted.length;
  const bCross = identifiedCrossings.binary.length;
  if (wCross === 0 && bCross === 0) {
    lines.push(
      "Surface: NO identified zero crossing on any sweep, for either model. A crossing is reported " +
        "only where the whole interval on one cell is below zero and the whole interval on the " +
        "next is above it; where that test fails the crossing is inside the sampled noise. No best " +
        "cell is reported and no ratio is recommended.",
    );
  } else {
    lines.push(
      `Surface: ${wCross} identified crossing sweep(s) for weighted and ${bCross} for binary; the ` +
        "per-sweep detail is in the crossings block. No best cell is reported and no ratio is " +
        "recommended — a sweep maximum evaluated on one sample is not evidence.",
    );
  }

  const reqByHorizon = new Map();
  for (const row of byHorizon) {
    if (!reqByHorizon.has(row.model)) reqByHorizon.set(row.model, []);
    if (row.requiredRatio !== null) reqByHorizon.get(row.model).push(row);
  }
  for (const [model, rowsForModel] of reqByHorizon) {
    if (rowsForModel.length < 2) continue;
    const min = rowsForModel.reduce((a, b) => (a.requiredRatio < b.requiredRatio ? a : b));
    const max = rowsForModel.reduce((a, b) => (a.requiredRatio > b.requiredRatio ? a : b));
    lines.push(
      `Hold: on ${model} the required ratio ranges from ${rat(min.requiredRatio)} at ` +
        `${int(min.horizonBars)} bars to ${rat(max.requiredRatio)} at ${int(max.horizonBars)} bars ` +
        `across the horizons sampled, against a shipped ${rat(currentRatio())}. One fixed ratio is ` +
        "being applied to holds that differ by an order of magnitude.",
    );
  }

  return lines.join("\n");
}

// ─── Human-readable report ──────────────────────────────────────────────────

function printReport(r) {
  out(r.verdict);
  out("");

  out(
    `dataset  ${r.dataset.path} — ${int(r.dataset.bars)} bars, ${r.dataset.firstIso} .. ` +
      `${r.dataset.lastIso}, ${r.dataset.spanDays} days, gaps ${r.dataset.gapCount ?? "?"}`,
  );
  out(
    `config   seed ${r.config.seed}, headline bootstrap ${int(r.config.bootstrapIterations)} draws, ` +
      `surface bootstrap ${int(r.config.surfaceBootstrapIterations)} draws, window ` +
      `${r.config.windowBars} bars, horizons ${r.config.horizons.join("/")}`,
  );
  out(`         ${r.config.selectionRule}`);
  out(
    `         D.4 shipped target ${r.config.d4.targetPct}% / stop ${r.config.d4.stopPct}% = ratio ` +
      `${r.config.d4.ratio}, which requires a ${r.config.d4.requiredHitRatePercent.toFixed(2)}% hit rate`,
  );
  out(
    `         costs NOT modelled: commission ${r.config.d4.commissionPerSidePct}% per side ` +
      `(${r.config.d4.roundTripCommissionPct}% round trip) and slippage ${r.config.d4.slippageTicks} ` +
      "ticks; every expectancy below is gross",
  );
  out(
    `check    the parameterised (target, stop) labeller equals modules/label.mjs at 1.5/0.8 on ` +
      `${int(r.labellerMatch.checksRun)} real signals: ${r.labellerMatch.ok ? "yes" : "NO"}`,
  );
  out("");

  // ── 1. The independent sample ─────────────────────────────────────────────
  out(`1. THE INDEPENDENT SAMPLE — what it cost, and what it cannot say`);
  out("");
  out(
    `  ${padL("scope", 8)}${padL("model", 10)}${padR("signals", 9)}${padR("kept", 7)}` +
      `${padR("discarded", 11)}${padR("discard %", 11)}${padR("resolved", 10)}${padR("timeout", 9)}` +
      `${padR("insuff.", 8)}${padR("hit rate", 10)}${padR("95% CI", 20)}`,
  );
  for (const [scopeName, key] of [["all", "all"], ["long", "long"], ["short", "short"]]) {
    for (const model of ["weighted", "binary"]) {
      const s = r.scopes[key][model];
      out(
        `  ${padL(scopeName, 8)}${padL(model, 10)}${padR(int(s.selection.signalsConsidered), 9)}` +
          `${padR(int(s.selection.windowsUsed), 7)}${padR(int(s.selection.signalsDiscarded), 11)}` +
          `${padR(s.selection.discardPercent === null ? "n/a" : `${s.selection.discardPercent}%`, 11)}` +
          `${padR(int(s.resolved), 10)}${padR(int(s.counts.timeout), 9)}` +
          `${padR(int(s.counts.insufficient_data), 8)}${padR(pct(s.hitRatePercent), 10)}` +
          `${padR(s.eligible ? ci(s.bootstrap.lo, s.bootstrap.hi) : "not reported", 20)}`,
      );
    }
  }
  out("");
  out(`  selection rule: ${r.scopes.all.weighted.selection.rule}`);
  out(
    `  ceiling check — on ${r.timeframe.id} the partition cannot yield more than ` +
      `${int(r.dataset.bars)}/${r.config.windowBars} ~ ` +
      `${int(Math.ceil(r.dataset.bars / r.config.windowBars))} observations per model per side, ` +
      "regardless of how many signals fired. That ceiling is the reason the interval below is wide.",
  );
  out(
    `  THE SELECTION EFFECT, stated once more: keeping the earliest entry bar samples the model at ` +
      "one ARBITRARY",
  );
  out(
    "  point per window. It is not a random draw of the model's behaviour over that window, and a " +
      "different",
  );
  out(
    "  rule would give a different sample and a different interval. That spread is not measured " +
      "here; only this",
  );
  out("  sample is on the record.");

  // ── 2. Break-even ─────────────────────────────────────────────────────────
  out("");
  out(`2. BREAK-EVEN — the robust part. D.4's shipped 1.5 / 0.8 = ratio ${r.config.d4.ratio}`);
  out("");
  out(
    `  expectancy per RESOLVED trade is h*T - (1-h)*S and break-even needs h >= S/(T+S) = ` +
      `${r.config.d4.requiredHitRatePercent.toFixed(4)}% for this ratio.`,
  );
  out(
    `  ${padL("scope", 8)}${padL("model", 10)}${padR("h %", 9)}${padR("95% CI of h", 20)}` +
      `${padR("req h %", 10)}${padR("gap pp", 11)}${padR("entire CI below?", 18)}${padR("E/trade", 11)}` +
      `${padR("net comm.", 11)}`,
  );
  for (const scopeName of ["all", "long", "short"]) {
    for (const model of ["weighted", "binary"]) {
      const s = r.scopes[scopeName][model];
      const be = s.breakeven;
      out(
        `  ${padL(scopeName, 8)}${padL(model, 10)}${padR(pct(s.hitRatePercent), 9)}` +
          `${padR(s.eligible ? ci(s.bootstrap.lo, s.bootstrap.hi) : "not reported", 20)}` +
          `${padR(`${be.requiredHitRatePercent.toFixed(2)}%`, 10)}` +
          `${padR(pp(be.hitRateGapPp), 11)}` +
          `${padR(s.eligible ? yesNo(be.wholeIntervalBelowRequired) : "n/a", 18)}` +
          `${padR(spct(be.expectancyPercentPerTrade), 11)}` +
          `${padR(spct(be.expectancyAfterCommissionPercent), 11)}`,
      );
    }
  }
  out("");
  out(
    "  \"entire CI below?\" is the interval TEST: it asks whether the highest hit rate the sample " +
      "admits",
  );
  out(
    "  still sits under the rate this ratio demands. That survives the point estimate moving with " +
      "the seed;",
  );
  out(
    "  a point-estimate comparison would not. \"net comm.\" subtracts only D.4's declared " +
      `${r.config.d4.roundTripCommissionPct}% commission`,
  );
  out(
    "  round trip and still omits the two slippage ticks — so it is NOT a net figure, only a " +
      "size of offset.",
  );

  out("");
  out(`  Required ratio each model's observed accuracy would carry — T/S = (1-h)/h, CI propagated`);
  out("");
  out(
    `  ${padL("scope", 8)}${padL("model", 10)}${padR("T/S needed", 11)}${padR("95% CI", 24)}` +
      `${padR("shipped", 9)}  ${padR("gap", 11)}  ${padR("CI below shipped?", 17)}  direction`,
  );
  for (const scopeName of ["all", "long", "short"]) {
    for (const model of ["weighted", "binary"]) {
      const req = r.scopes[scopeName][model].requiredRatio;
      out(
        `  ${padL(scopeName, 8)}${padL(model, 10)}${padR(req.unbounded ? "unbounded" : rat(req.point), 11)}` +
          `${padR(req.ciLo === null ? "not reported" : `[${rat(req.ciLo)}, ${rat(req.ciHi)}]`, 24)}` +
          `${padR(rat(req.currentRatio), 9)}  ` +
          `${padR(req.gap === null ? "n/a" : req.gap.toFixed(3), 11)}  ` +
          `${padR(req.ciHi === null ? "n/a" : yesNo(req.intervalEntirelyBelowCurrentRatio), 17)}  ` +
          `${req.direction ?? "n/a"}`,
      );
    }
  }
  out("");
  out(
    "  Direction matters and is easy to invert: a LARGER target/stop ratio demands a HIGHER hit " +
      "rate, so",
  );
  out(
    "  a required ratio ABOVE the shipped 1.875 means the shipped ratio is TOO SMALL for the " +
      "accuracy",
  );
  out(
    "  actually observed. The CI is propagated from the bootstrap DRAWS, not from the endpoints " +
      "of h's",
  );
  out(
    "  interval: (1-h)/h is strongly convex in h, so an endpoint-wise transform would understate " +
      "the width.",
  );

  // ── 3. The expectancy surface ─────────────────────────────────────────────
  out("");
  out(`3. THE EXPECTANCY SURFACE — a surface, not a table of candidates`);
  out("");
  out(
    `  Grid: ${r.config.targetAxis.length} targets x ${r.config.stopAxis.length} stops = ` +
      `${int(r.config.targetAxis.length * r.config.stopAxis.length)} cells per model, re-labelled ` +
      "per cell.",
  );
  out(
    "  Each cell RE-RUNS the exit rule at its own (target, stop), so the hit rate inside a cell is " +
      "that",
  );
  out(
    "  ratio's own hit rate and moves across the grid. This is therefore NOT a plane through one " +
      "fixed h,",
  );
  out(
    "  and it is NOT a backtest — no fills, no costs, no portfolio. Values are expectancy per " +
      "resolved trade, GROSS.",
  );
  out("");
  for (const model of ["weighted", "binary"]) {
    const surface = r.surfaces[model];
    out(
      `  ${model} — ${int(surface.observations)} independent observations ` +
        `(${int(surface.signalsConsidered)} signals considered, ${int(surface.signalsDiscarded)} ` +
        "discarded)",
    );
    out("");
    out(`  ${padL("T\\S", 7)}${r.config.stopAxis.map((s) => padR(s.toFixed(1), 8)).join("")}`);
    for (const targetPct of surface.targets) {
      const row = surface.cells.filter((c) => Math.abs(c.targetPct - targetPct) < 1e-9);
      const cellsText = row
        .map((c) =>
          padR(
            c.expectancyPercent === null ? "n/a" : `${c.expectancyPercent > 0 ? "+" : ""}${c.expectancyPercent.toFixed(2)}`,
            8,
          ),
        )
        .join("");
      out(`  ${padL(`${targetPct.toFixed(2)}%`, 7)}${cellsText}`);
    }
    out(`  ${padL("", 7)}${r.config.stopAxis.map((s) => padR(`${s.toFixed(1)}%`, 8)).join("")}`);
    out("");
  }
  out(
    "  The useful output is where this surface crosses zero, not where it peaks. NO best cell is " +
      "reported",
  );
  out(
    "  and NO ratio is recommended: the maximum of a 143-cell sweep evaluated on one sample is " +
      "exactly the",
  );
  out("  overfitting this project exists to avoid.");

  out("");
  out(`  Zero crossing — located only where it is IDENTIFIED, i.e. where the whole 95% interval`);
  out(
    `  on the cell below is below zero and the whole interval on the cell above is above it. ` +
      `${int(r.config.surfaceBootstrapIterations)} draws per cell.`,
  );
  out("");
  for (const model of ["weighted", "binary"]) {
    const identified = r.identifiedCrossings[model];
    const sign = r.surfaces[model].signStructure;
    const tally = { identified: 0, "entirely-positive": 0, "entirely-negative": 0, "inside-noise": 0 };
    for (const c of r.crossings[model]) tally[c.situation] += 1;
    out(`  ${model}: ${int(r.crossings[model].length)} sweeps`);
    out(
      `    surface sign structure: ${int(sign.significantlyPositive)} of ` +
        `${int(r.surfaces[model].cells.length)} cells significantly POSITIVE, ` +
        `${int(sign.significantlyNegative)} significantly NEGATIVE, ${int(sign.insideNoise)} inside ` +
        `the noise; expectancy spans ${spct(sign.minExpectancy, 2)} to ${spct(sign.maxExpectancy, 2)}.`,
    );
    out(
      `    sweep outcomes: ${int(tally.identified)} crossing identified, ` +
        `${int(tally["entirely-positive"])} established positive throughout, ` +
        `${int(tally["entirely-negative"])} established negative throughout, ` +
        `${int(tally["inside-noise"])} entirely inside the noise.`,
    );
    if (identified.length === 0) {
      out(
        "    -> NO crossing is identified on any sweep. Where a sweep is established on one sign " +
          "throughout,",
      );
      out(
        "       the crossing lies OUTSIDE that sweep's sampled axis range; where a sweep is inside " +
          "the noise",
      );
      out(
        "       throughout, the sign change sits INSIDE the noise. Either way there is no location " +
          "to report,",
      );
      out("       and NO ratio is proposed in its place.");
    } else {
      for (const c of identified) {
        const axis =
          c.sweep === "target rising"
            ? `stop fixed at ${c.fixedStopPct.toFixed(2)}%`
            : `target fixed at ${c.fixedTargetPct.toFixed(2)}%`;
        out(
          `    ${c.sweep}, ${axis}: crosses zero between ${c.bracket.below} and ${c.bracket.above}, ` +
            `T/S at the crossing ~ ${rat(c.crossingRatio)}`,
        );
      }
      out(
        "    -> this is a LOCATION of a sign change, not a recommendation. Each bracket must be " +
          "read as a",
      );
      out("       pair; neither endpoint is itself an answer.");
    }
  }

  // ── 4. Ratio / hold interaction ───────────────────────────────────────────
  out("");
  out(`4. THE RATIO / HOLD INTERACTION — one ratio, five different trades`);
  out("");
  out(
    `  D.4 applies ONE fixed ratio to whatever hold the label uses, but the same ${r.config.windowBars} ` +
      "bars is",
  );
  out(
    `  ${(r.config.windowBars * r.timeframe.minutesPerBar / 60).toFixed(1)}h on ${r.timeframe.id}, and the ` +
      "shortest",
  );
  out(
    `  horizon here is ${r.config.horizons[0]} bars (${(r.config.horizons[0] * r.timeframe.minutesPerBar / 60).toFixed(1)}h). ` +
      "Expectancy per horizon:",
  );
  out("");
  out(
    `  ${padL("model", 10)}${padR("horizon", 9)}${padR("hold h", 9)}${padR("obs", 6)}${padR("resolved", 10)}` +
      `${padR("h %", 9)}${padR("95% CI", 20)}${padR("E/trade", 11)}${padR("net comm.", 11)}${padR("T/S needed", 11)}${padR("CI", 22)}`,
  );
  for (const row of r.byHorizon) {
    const holdHours = (row.horizonBars * r.timeframe.minutesPerBar) / 60;
    out(
      `  ${padL(row.model, 10)}${padR(int(row.horizonBars), 9)}${padR(holdHours.toFixed(1), 9)}` +
        `${padR(int(row.observations), 6)}${padR(int(row.resolved), 10)}` +
        `${padR(pct(row.hitRatePercent), 9)}` +
        `${padR(row.eligible ? ci(row.hitRateCi[0], row.hitRateCi[1]) : "not reported", 20)}` +
        `${padR(spct(row.expectancyPercent), 11)}${padR(spct(row.expectancyAfterCommissionPercent), 11)}` +
        `${padR(rat(row.requiredRatio), 11)}` +
        `${padR(row.requiredRatioCi[0] === null ? "not reported" : `[${rat(row.requiredRatioCi[0])}, ${rat(row.requiredRatioCi[1])}]`, 22)}`,
    );
  }
  out("");
  out(
    "  Each row re-labels at its own cap, so the resolved population CHANGES with the horizon: a " +
      "shorter",
  );
  out(
    "  cap turns trades into timeout, which is excluded rather than counted as a loss. The rows " +
      "are NOT",
  );
  out("  nested samples of one another, and the n per row is the honest denominator.");
  out("");
  out(
    `  D.4's \`strategy.exit\` declares no time limit at all — the ${r.config.windowBars}-bar cap is ` +
      "this harness's",
  );
  out(
    "  Definition A. The hold above is a property of the harness, so these rows describe the " +
      "harness's",
  );
  out("  labelling choice as much as they describe the indicator.");

  out("");
  out(`5. WHAT A READER MUST NOT CONCLUDE FROM THESE NUMBERS`);
  out("");
  r.caveats.forEach((cv, i) => out(`  [C${i}] ${cv}`));
}

function yesNo(v) {
  if (v === null || v === undefined) return "n/a";
  return v ? "YES" : "NO";
}

// ─── Entry point ─────────────────────────────────────────────────────────────

export async function runRatio(options = {}) {
  return runAnalysis(options);
}

export { parseCompareFlags as parseRatioFlags };
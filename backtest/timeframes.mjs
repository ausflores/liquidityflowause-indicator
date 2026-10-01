// ============================================================================
// LiquidityFlowAuse — Backtest harness timeframe table
// ----------------------------------------------------------------------------
// Zero-dependency, bare `node`, ESM. Imported by backtest/run.mjs,
// backtest/baseline.mjs and backtest/tier-diagnostic.mjs so that ONE table
// decides the step size, the dataset path, the coverage target and the label
// used in every report — and so the same table can be smoke-checked without
// touching the network or the filesystem.
//
// WHY A TABLE AND NOT A FLAG
//
// Slice 7 runs the whole harness on a second and third timeframe. That is only
// honest if the NATIVE grid changes, not just a label: feeding 1h candles makes
// 1h the engine's native series, so `ta.atr(14)` is 14 hours instead of
// 14 x 5min, and the H4/D1 tiers aggregate on a different grid. That is exactly
// what TradingView does on a 1h chart, and it is the point of the slice — but it
// is also the reason nothing here may be read as "the same weights, more data".
// Every report says so in its own header (see baseline caveat [C0]).
//
// WHAT THE NATIVE GRID CHANGES, ARITHMETICALLY
//
//   Native step      bars per D1 bar   bars a D1 pivot needs (21 daily bars)
//   5m   (300s)              288                        6,048
//   1h  (3600s)               24                          504
//   4h (14400s)                6                          126
//
// Those warm-up numbers are RECOMPUTED per timeframe from the measured series
// (baseline section 7), never copied from the 5m run. `nativeBarsForDays()`
// is the pure form of that arithmetic and is smoke-checked.
//
// A HIGHER TIMEFRAME FINER THAN THE NATIVE GRID IS NOT SYNTHESISABLE
//
// Pine's `request.security(syminfo.tickerid, "60", ...)` returns 1h bars on a
// 4h chart — Pine asks the exchange for 1h data regardless of the chart's own
// resolution. This harness cannot: it aggregates the ONE dataset it was given,
// so on a 4h dataset the 1H tier has no candles to aggregate and the 1H
// liquidity tier and structure pivots are simply ABSENT rather than wrong.
// `htfAvailability()` reports that as unavailable, and every report that is
// affected says so out loud rather than reporting a thinner tier mix as if it
// were a finding. On 1h the 1H context is not absent — it IS the native series,
// which is precisely what Pine would return.
//
// Usage:
//   import { DEFAULT_TIMEFRAME, parseTimeframeFlag } from "./timeframes.mjs";
// ============================================================================

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ─── Timeframe constants ─────────────────────────────────────────────────────

export const MS_5M = 300000;
export const MS_1H = 3600000;
export const MS_4H = 14400000;
export const MS_1D = 86400000;

/**
 * The three higher-timeframe contexts the zone engine consumes, in the order
 * Pine pushes the confirmed-pivot slots (liquidity-zones.pine:180-185): D1 high,
 * D1 low, 4H high, 4H low, 1H high, 1H low.
 */
export const HTF_TIERS = Object.freeze([
  Object.freeze({ key: "h1", name: "1H", ms: MS_1H }),
  Object.freeze({ key: "h4", name: "4H", ms: MS_4H }),
  Object.freeze({ key: "d1", name: "D1", ms: MS_1D }),
]);

// ─── The table ───────────────────────────────────────────────────────────────
//
// Every entry is data, not policy: what the step is, where the file lives, and
// how much history counts as enough. Adding a timeframe here is the ONLY way to
// make `fetch --timeframe <x>` legal — a flag value that is not a key here is
// rejected loudly rather than silently defaulted to 5m.

const MARKET = "btcusd";

function define(id, fields) {
  const label = id;
  const datasetRel = `backtest/data/${MARKET}-${id}.json`;
  return Object.freeze({
    id,
    label,
    /** Human-facing spelling used in reports, e.g. "5-MINUTE" in caveat [C0]. */
    scopeWord: fields.scopeWord,
    /** Bitstamp `step` parameter, seconds. */
    stepSec: fields.stepSec,
    stepMs: fields.stepSec * 1000,
    /** Native minutes per bar — used for horizon labels (288 bars = X minutes). */
    minutesPerBar: fields.stepSec / 60,
    /**
     * Coverage target. BOTH conditions must hold before a fetch reports
     * "complete", and the verdict is RECOMPUTED from the candles on disk every
     * run (the T2 defect: a cached `status` must never short-circuit the
     * constants in effect). A completed 5m fetch therefore cannot make a 1h
     * fetch report itself complete — the two never share a meta file.
     */
    targetBars: fields.targetBars,
    targetDays: fields.targetDays,
    datasetRel,
    datasetPath: join(ROOT, "backtest", "data", `${MARKET}-${id}.json`),
    metaPath: join(ROOT, "backtest", "data", `${MARKET}-${id}.meta.json`),
  });
}

/**
 * 5m is the DEFAULT and the only timeframe the T8 fidelity gate may run on:
 * docs/VALIDATION.md's Class A readings were captured on a 5m grid, so a 4H
 * grid cannot reproduce the legend series at all (gate disagreement D1).
 */
export const TIMEFRAMES = Object.freeze({
  // Six-month target, both conditions. Fidelity-gate coverage target (T8), not
  // merely a "six months" target: docs/VALIDATION.md's earliest confirmed
  // crosshair reading is 7 Mar 2026 (DST transitions, L56). 215 days back from
  // the last bar reaches ~27 Feb 2026, which covers 7 and 10 Mar 2026 with
  // margin. 62,000 bars == 215.3 days at 288 five-minute bars per day, so the
  // two constants stay consistent. Do not "simplify" this back to 182.6:
  // doing so silently drops the DST gate readings, and nothing in the fetch
  // output would say so.
  "5m": define("5m", { scopeWord: "5-MINUTE", stepSec: 300, targetBars: 62000, targetDays: 215.0 }),

  // Five years. A D1 liquidity pivot needs 21 completed daily bars, and on a 1h
  // grid that is 504 native bars — the whole point of this timeframe is that
  // the D1 tier is derivable and reachable at all. 43,800 bars == 1825 days at
  // 24 bars per day, which clears both halves of the target.
  "1h": define("1h", { scopeWord: "1-HOUR", stepSec: 3600, targetBars: 43000, targetDays: 1825.0 }),

  // Five years. Same wall-clock coverage as 1h on a 4x coarser grid: 10,950
  // bars == 1825 days at 6 bars per day.
  "4h": define("4h", { scopeWord: "4-HOUR", stepSec: 14400, targetBars: 10900, targetDays: 1825.0 }),
});

/** Ordered so error messages and `--help` output are deterministic. */
export const TIMEFRAME_IDS = Object.freeze(["5m", "1h", "4h"]);

export const DEFAULT_TIMEFRAME = "5m";

/** Thrown for any `--timeframe` value that is not a key of TIMEFRAMES. */
export class TimeframeError extends Error {
  constructor(message) {
    super(message);
    this.name = "TimeframeError";
  }
}

/**
 * Resolves a timeframe id. Throws TimeframeError rather than falling back to
 * 5m: a typo that silently ran the default timeframe would produce a plausible
 * report about the wrong dataset, which is the one failure mode a measurement
 * harness must never have.
 */
export function getTimeframe(id) {
  const tf = TIMEFRAMES[id];
  if (tf === undefined) {
    throw new TimeframeError(
      `unknown timeframe "${id}" - known timeframes are ` +
        `${TIMEFRAME_IDS.map((k) => `"${k}"`).join(", ")} (default "${DEFAULT_TIMEFRAME}")`,
    );
  }
  return tf;
}

/** Argument form of getTimeframe. Rejects empty/whitespace values too. */
export function parseTimeframe(raw) {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new TimeframeError(
      "missing timeframe - pass --timeframe <" +
        `${TIMEFRAME_IDS.join("|")}> (default "${DEFAULT_TIMEFRAME}")`,
    );
  }
  return getTimeframe(raw.trim());
}

/**
 * Reads `--timeframe <id>` and `--timeframe=<id>` out of an argv array.
 * Returns DEFAULT_TIMEFRAME when the flag is absent, so every pre-slice-7
 * command line keeps working with no flag at all. Throws TimeframeError when
 * the flag is present but unusable — including a missing value, which would
 * otherwise swallow the next argument.
 */
export function parseTimeframeFlag(argv) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--timeframe") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new TimeframeError(
          `--timeframe requires a value - known timeframes are ` +
            `${TIMEFRAME_IDS.map((k) => `"${k}"`).join(", ")}`,
        );
      }
      return parseTimeframe(next);
    }
    if (arg.startsWith("--timeframe=")) {
      return parseTimeframe(arg.slice("--timeframe=".length));
    }
  }
  return getTimeframe(DEFAULT_TIMEFRAME);
}

/**
 * Native bars that `days` of D1 history occupies on a given native grid.
 * Pure, so the warm-up arithmetic is smoke-checkable without a dataset:
 *   nativeBarsForDays(21, MS_1H) === 504   (21 x 24)
 *   nativeBarsForDays(21, MS_4H) === 126   (21 x 6)
 */
export function nativeBarsForDays(days, stepMs) {
  return days * (MS_1D / stepMs);
}

/**
 * Which HTF tiers can be aggregated from a dataset of this native step.
 *
 * A tier FINER than the native grid has no candles to aggregate and is
 * reported as unavailable rather than as an empty result — the two mean
 * different things and conflating them would read as "the H1 tier produced
 * nothing" (a finding) when the truth is "a 4h dataset cannot contain 1h bars"
 * (a limitation of the data chosen).
 */
export function htfAvailability(stepMs) {
  const available = {};
  const unavailable = [];
  for (const tier of HTF_TIERS) {
    if (tier.ms >= stepMs) available[tier.key] = true;
    else {
      available[tier.key] = false;
      unavailable.push(tier);
    }
  }
  return { available, unavailable };
}

/**
 * The coverage verdict, RECOMPUTED from the candles on disk rather than read
 * out of stored metadata. Pure, and used per timeframe: two timeframes never
 * share a meta file, so a complete 5m fetch cannot mark a 1h fetch complete.
 */
export function targetVerdict(barCount, spanDays, tf) {
  const barsOk = barCount >= tf.targetBars;
  const daysOk = spanDays >= tf.targetDays;
  return { barsOk, daysOk, met: barsOk && daysOk };
}

/**
 * Status resolution. "shortfall" is preserved from disk because it records
 * something recomputation cannot un-know (the exchange has no older candles);
 * only a false "complete" is downgraded.
 */
export function resolveStatus(storedStatus, met) {
  if (storedStatus === "shortfall" && !met) return "shortfall";
  return met ? "complete" : "partial";
}

/** Bars per D1 bar on this grid — the divisor behind every warm-up number. */
export function barsPerDailyBar(tf) {
  return MS_1D / tf.stepMs;
}
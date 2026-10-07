// ============================================================================
// LiquidityFlowAuse - Local equity-curve simulator (odd/tasks/equity-simulator.md, T3)
// ----------------------------------------------------------------------------
// EVERY OTHER MEASUREMENT IN backtest/ IS A DESCRIPTIVE RATIO OVER OVERLAPPING
// FORWARD WINDOWS. This module is the first thing in the harness that keeps a
// BOOK: cash, one open position at a time, sizing, compounding and a curve.
//
// It answers the question the ratios cannot: does either entry model make money?
//
// â”€â”€â”€ WHY IT IS SPLIT IN TWO â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
//   A. simulateEquity(candles, outcomes, options) - the PURE CORE. No dataset,
//      no signal engine, no labels, no I/O. It consumes outcomes that are
//      ALREADY labelled and returns the equity curve plus every metric. This is
//      the only part with tests, and every test in smoke.mjs drives it on tiny
//      hand-computable synthetic bars.
//
//   B. runEquity(options) - the thin wiring. It calls baseline.mjs's
//      runComparison() for the signals, modules/label.mjs for the labels, and
//      then hands label results to the pure core.
//
// The split exists because the signal engine needs hundreds of bars before
// anything fires at all: an end-to-end-only design could not be tested at all,
// and this harness does not ship untested code.
//
// â”€â”€â”€ THE REUSE CONTRACT (do not re-derive any of this) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
//   Signals        baseline.mjs runComparison(candles, meta, tf, sink) - the
//                  SAME sink compare.mjs and ratio.mjs consume. Zero re-wiring.
//                  If the sink does not fire, THROW (ratio.mjs:1546's rule):
//                  a result reported after a silent wiring change is a fiction.
//   Labels         modules/label.mjs labelSignalsExitRule(labelCandles,
//                  signals, { maxHorizonBars }). The target and stop levels are
//                  EXIT_TARGET_PCT / EXIT_STOP_PCT and nothing else.
//   Break-even     breakevenHitRate / expectancyPercent / requiredRatio from
//                  ratio.mjs. Re-deriving h = S / (T + S) here would create a
//                  second answer to a question that already has one.
//   Commission     D4_ROUND_TRIP_COMMISSION_PCT, D.4's own 0.05 per side.
//
// â”€â”€â”€ WHAT IS DECLARED AND WHAT IS ASSUMED â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// Sizing is 10% of CURRENT equity (D.4 default_qty_value=10), so the curve
// COMPOUNDS and every notional differs from the one before it. Commission is
// 0.10% round trip, charged EXACTLY ONCE per COMPLETED trade. Slippage is 0 and
// is declared as 0: D.4 declares slippage=2 in TICKS and Bitstamp's BTC/USD
// tick size is recorded in no meta file, so converting it would mean inventing
// a number. Every one of these is printed as a caveat, not buried here.
//
// A LONG position is entered at the signal close and is marked by the SIGN of
// the price move; a SHORT profits when price FALLS. That mirrors modules/
// label.mjs, which places the short's win level BELOW the entry.
//
// â”€â”€â”€ Pure-core contract (the part under test) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
//   candles   DATASET bars `{ t, c }` - the on-disk shape, NOT the labeller's
//             `{ high, low, close }`. Only `t` (curve timestamps) and `c` (the
//             mark-to-market price of a timeout) are read.
//   outcomes  Array of PRE-LABELLED outcomes, in any order; the core sorts a
//             copy by entryIndex so a caller cannot get the fill order wrong.
//
//             { label, side, entryIndex, exitIndex, entryPrice, exitPrice,
//               altExitPrice, doubleTouch }
//
//             label         "win" | "loss" | "timeout" | "insufficient_data"
//             side          "long" | "short"
//             exitIndex     entryIndex + horizonBars. null ONLY for
//                           insufficient_data, which was never observed.
//             exitPrice     the target (win) or the stop (loss). null for
//                           timeout, which is marked to market at
//                           candles[exitIndex].c instead - a timeout is a real
//                           trade with a real close, not a discard.
//             altExitPrice  the OTHER level, required only when doubleTouch is
//                           true: it is the target, and reading it is how the
//                           optimistic double-touch sensitivity is computed
//                           without the core knowing what a target is.
//
//   Nothing here reads the dataset, generates a signal, or computes a label.
// ============================================================================

import {
  breakevenHitRate,
  D4_ROUND_TRIP_COMMISSION_PCT,
  expectancyPercent,
  horizonHoldHours,
  requiredRatio,
} from "./ratio.mjs";
import { EXIT_TARGET_PCT, EXIT_STOP_PCT } from "./modules/label.mjs";

const MS_1D = 86400000;
const DAYS_PER_YEAR = 365.25;

/**
 * The declared configuration of the simulated account, in one place so a
 * reader never has to infer it from the arithmetic.
 *
 * `riskFractionPct` is D.4's own `default_qty_value=10`: 10% of the equity in
 * force AT ENTRY, which is what makes the curve compound.
 * `commissionPct` is imported, never retyped - see the file header.
 * `slippageTicks: 0` is a DECLARED ZERO, not an omission. It is reported as
 * such because D.4 declares slippage=2 in ticks and no tick size is on record.
 */
export const EQUITY_DEFAULTS = Object.freeze({
  initialEquity: 10000,
  riskFractionPct: 10,
  commissionPct: D4_ROUND_TRIP_COMMISSION_PCT,
  slippageTicks: 0,
});

/** Options the caller may set, mirroring label.mjs's discipline. */
const EQUITY_OPTIONS = [
  "initialEquity",
  "riskFractionPct",
  "commissionPct",
  "slippageTicks",
  "doubleTouchResolution",
];

/** The two readings of a double-touch bar. See the report's caveat [C2]. */
export const DOUBLE_TOUCH_RESOLUTIONS = Object.freeze(["pessimistic", "optimistic"]);

/**
 * Merges the caller's options over the declared defaults and REJECTS unknown
 * keys, exactly as modules/label.mjs does: silently ignoring a misspelt option
 * would let a caller believe they had changed the account when they had not.
 */
function resolveOptions(options, where) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError(`${where}: options must be an object`);
  }
  for (const key of Object.keys(options)) {
    if (!EQUITY_OPTIONS.includes(key)) {
      throw new TypeError(`${where}: unknown option "${key}" (accepted: ${EQUITY_OPTIONS.join(", ")})`);
    }
  }
  const cfg = { ...EQUITY_DEFAULTS, doubleTouchResolution: "pessimistic", ...options };
  if (!DOUBLE_TOUCH_RESOLUTIONS.includes(cfg.doubleTouchResolution)) {
    throw new RangeError(
      `${where}: doubleTouchResolution must be one of ${DOUBLE_TOUCH_RESOLUTIONS.join(" / ")}, ` +
        `got ${String(cfg.doubleTouchResolution)}`,
    );
  }
  return cfg;
}

/**
 * The signed return of one trade, in fraction of entry price.
 *
 * Long: (exit - entry) / entry. Short: (entry - exit) / entry - a short
 * profits when price falls, exactly as modules/label.mjs places the short's
 * target BELOW the entry. Getting this sign backwards would turn every stop
 * into a win, which is why the smoke section asserts it directly.
 */
function signedMovePct(side, entryPrice, exitPrice) {
  return side === "long" ? (exitPrice - entryPrice) / entryPrice : (entryPrice - exitPrice) / entryPrice;
}

/**
 * Simulates one account over pre-labelled outcomes and returns the curve and
 * every metric the report prints.
 *
 * PURE: no I/O, no dataset, no signal engine, no label computation. Everything
 * it needs arrives in the arguments, which is what makes the hand-computed
 * fixtures in smoke.mjs possible.
 *
 * @param {Array<{t: number, c: number}>} candles dataset bars, indexed as the
 *   labeller indexed them (`entryIndex` and `exitIndex` are positions in this
 *   SAME array, not in the `{high, low, close}` copy the labeller was handed).
 * @param {Array<object>} outcomes pre-labelled outcomes, any order.
 * @param {{initialEquity?: number, riskFractionPct?: number,
 *          commissionPct?: number}} options
 * @returns {object} curve, trades, counts and metrics.
 */
export function simulateEquity(candles, outcomes, options = {}) {
  const where = "simulateEquity";
  const cfg = resolveOptions(options, where);
  const riskFraction = cfg.riskFractionPct / 100;
  const commissionRate = cfg.commissionPct / 100;
  const optimistic = cfg.doubleTouchResolution === "optimistic";

  // Sorted by entry bar, so a caller that hands the list in labelling order,
  // signal order or reverse still fills in the same sequence. Ties keep their
  // input order (Array.prototype.sort is stable), which is the only defensible
  // answer for two signals on the SAME bar.
  const book = [...outcomes].sort((a, b) => a.entryIndex - b.entryIndex);

  const trades = [];
  const curve = [];
  const counts = {
    signals: book.length,
    trades: 0,
    wins: 0,
    losses: 0,
    timeouts: 0,
    resolved: 0,
    skippedFlat: 0,
    insufficientData: 0,
    doubleTouch: 0,
    long: 0,
    short: 0,
  };

  let equity = cfg.initialEquity;
  let grossPnl = 0;
  let commissionPaid = 0;
  let openExitIndex = -1; // -1 == flat

  for (const outcome of book) {
    // An insufficient_data outcome was never observed, so it was never taken:
    // it is reported and it does NOT occupy the book, and it does not consume
    // the flat rule either - a position that was never opened cannot block a
    // later entry.
    if (outcome.label === "insufficient_data") {
      counts.insufficientData += 1;
      continue;
    }

    // ONLY-ENTER-WHEN-FLAT. A signal inside an open position is SKIPPED AND
    // COUNTED, never silently dropped. The book is flat again at the CLOSE of
    // the exit bar (the exit fills intrabar at the target or stop), so a signal
    // on the exit bar itself may re-enter: the test is `<`, not `<=`.
    if (outcome.entryIndex < openExitIndex) {
      counts.skippedFlat += 1;
      continue;
    }

    const { entryPrice, side } = outcome;

    // Three validations that exist because their absence is SILENT rather than
    // loud. A bad side falls through signedMovePct's short branch and turns
    // every stop into a win; a null exit price propagates NaN through the whole
    // curve; a zero entry price divides by nothing. Each would print a
    // confident, wrong number, which is the failure mode this harness exists to
    // prevent - label.mjs validates the same three facts on its own inputs.
    if (side !== "long" && side !== "short") {
      throw new TypeError(
        `${where}: side must be "long" or "short", got ${String(side)} at bar ${String(outcome.entryIndex)}`,
      );
    }
    if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
      throw new RangeError(
        `${where}: entryPrice must be a finite number > 0, got ${String(entryPrice)} ` +
          `at bar ${String(outcome.entryIndex)}`,
      );
    }

    // ANTI-MISWIRE INVARIANT, the same shape as label.mjs's own. A double
    // touch sets label "loss" by construction (both levels were touched, so
    // hitStop was true); an outcome claiming otherwise did not come from
    // modules/label.mjs, and simulating it would put an impossible trade on
    // the curve.
    if (outcome.doubleTouch && outcome.label !== "loss") {
      throw new TypeError(
        `${where}: a doubleTouch outcome must be labelled "loss" (label.mjs sets that label whenever ` +
          `both levels were touched); got ${String(outcome.label)} at bar ${String(outcome.entryIndex)}`,
      );
    }

    // The pessimistic reading (the default) keeps the supplied exitPrice - the
    // stop. The optimistic reading takes the OTHER level, so it is only
    // available when the caller supplied altExitPrice; asking for it without
    // one throws instead of quietly simulating the pessimistic result under an
    // optimistic label.
    const useAlt = outcome.doubleTouch && optimistic;

    // The core reads candles[exitIndex] for the curve's timestamp and for a
    // timeout's mark. An index past the end is a wiring error, and saying WHICH
    // bar is wrong is the whole value of throwing - label.mjs takes the same
    // view in its own anti-miswire invariant.
    if (outcome.exitIndex === null || !Number.isInteger(outcome.exitIndex)) {
      throw new TypeError(
        `${where}: exitIndex must be an integer for a labelled outcome, got ${String(outcome.exitIndex)} ` +
          `at bar ${String(outcome.entryIndex)}`,
      );
    }
    if (outcome.exitIndex >= candles.length) {
      throw new RangeError(
        `${where}: exitIndex ${outcome.exitIndex} is beyond the last candle ` +
          `(${candles.length} bars) at bar ${String(outcome.entryIndex)}`,
      );
    }

    if (useAlt && outcome.altExitPrice === null) {
      throw new TypeError(
        `${where}: the optimistic double-touch reading needs altExitPrice (the target level); ` +
          `bar ${String(outcome.entryIndex)} carries none`,
      );
    }

    const exitPrice =
      outcome.label === "timeout" ? candles[outcome.exitIndex].c : useAlt ? outcome.altExitPrice : outcome.exitPrice;

    // A resolved label arrives with the level the labeller resolved to. If it
    // does not, the arithmetic below yields NaN and the whole curve becomes
    // NaN silently - the one outcome that must never reach a report.
    if (!Number.isFinite(exitPrice)) {
      throw new TypeError(
        `${where}: a "${outcome.label}" outcome needs a finite exit price, got ${String(exitPrice)} ` +
          `at bar ${String(outcome.entryIndex)}`,
      );
    }

    const notional = equity * riskFraction;
    const move = signedMovePct(side, entryPrice, exitPrice);
    const tradeGross = notional * move;
    const commission = notional * commissionRate;
    const tradeNet = tradeGross - commission;

    const equityBefore = equity;
    equity = equityBefore + tradeNet;
    grossPnl += tradeGross;
    commissionPaid += commission;
    openExitIndex = outcome.exitIndex;

    counts.trades += 1;
    // `side` is validated to be exactly "long" or "short" above, so it is safe
    // to key the split off it rather than re-testing it.
    counts[side] += 1;
    if (outcome.label === "win") counts.wins += 1;
    else if (outcome.label === "loss") counts.losses += 1;
    else counts.timeouts += 1;
    // insufficient_data already continued above, so the three labels left here
    // are win / loss / timeout, and only the first two are RESOLVED. A timeout
    // is a trade but never a resolution, which is why it must not enter the
    // hit rate - see the report's caveat on timeouts.
    if (outcome.label !== "timeout") counts.resolved += 1;
    if (outcome.doubleTouch) counts.doubleTouch += 1;

    const row = {
      label: outcome.label,
      side,
      entryIndex: outcome.entryIndex,
      exitIndex: outcome.exitIndex,
      entryPrice,
      exitPrice,
      holdBars: outcome.exitIndex - outcome.entryIndex,
      doubleTouch: outcome.doubleTouch,
      exitBasis:
        outcome.label === "timeout"
          ? "mark-to-market at horizon close"
          : useAlt
            ? "target (optimistic double-touch reading)"
            : outcome.doubleTouch
              ? "stop (pessimistic double-touch reading)"
              : "target or stop",
      notional,
      grossPct: move * 100,
      grossPnl: tradeGross,
      commission,
      netPnl: tradeNet,
      equityBefore,
      equityAfter: equity,
    };
    trades.push(row);
    curve.push({ barIndex: outcome.exitIndex, t: candles[outcome.exitIndex].t, equity, tradeIndex: trades.length - 1 });
  }

  const netPnl = grossPnl - commissionPaid;
  const netWins = trades.filter((x) => x.netPnl > 0).reduce((sum, x) => sum + x.netPnl, 0);
  const netLosses = trades.filter((x) => x.netPnl < 0).reduce((sum, x) => sum - x.netPnl, 0);

  // Drawdown on the CLOSED-TRADE curve, with the opening balance as the first
  // peak. It is not a mark-to-market drawdown: an open position's floating P&L
  // is never on this curve, so this is a LOWER BOUND on the realised path.
  let peak = cfg.initialEquity;
  let maxDrawdown = 0;
  let maxDrawdownAbs = 0;
  for (const point of curve) {
    if (point.equity > peak) peak = point.equity;
    const drop = peak - point.equity;
    if (drop > maxDrawdownAbs) {
      maxDrawdownAbs = drop;
      maxDrawdown = peak === 0 ? 0 : (drop / peak) * 100;
    }
  }

  // Annualised over the TRADED span: first entry bar to last exit bar, not the
  // dataset's span, so a curve that idled for months is not flattered into
  // looking like it compounded.
  let spanDays = null;
  let annualizedReturnPct = null;
  if (trades.length > 0) {
    const first = candles[trades[0].entryIndex].t;
    const last = candles[trades[trades.length - 1].exitIndex].t;
    spanDays = (last - first) / MS_1D;
    if (spanDays > 0 && equity > 0 && cfg.initialEquity > 0) {
      annualizedReturnPct =
        (Math.pow(equity / cfg.initialEquity, DAYS_PER_YEAR / spanDays) - 1) * 100;
    }
  }

  let winStreak = 0;
  let lossStreak = 0;
  let longestWinStreak = 0;
  let longestLossStreak = 0;
  for (const row of trades) {
    if (row.label === "win") {
      winStreak += 1;
      lossStreak = 0;
      if (winStreak > longestWinStreak) longestWinStreak = winStreak;
    } else if (row.label === "loss") {
      lossStreak += 1;
      winStreak = 0;
      if (lossStreak > longestLossStreak) longestLossStreak = lossStreak;
    } else {
      winStreak = 0;
      lossStreak = 0;
    }
  }

  const hitRate = counts.resolved === 0 ? null : counts.wins / counts.resolved;

  // GROSS expectancy per RESOLVED trade, straight out of ratio.mjs's
  // expectancyPercent(h, T, S) with label.mjs's own levels - so this report and
  // the ratio report cannot disagree about what 1.5/0.8 buys.
  const expectancyGrossPct = expectancyPercent(hitRate, EXIT_TARGET_PCT, EXIT_STOP_PCT);

  // NET expectancy per COMPLETED trade: the realised mean of every trade that
  // was actually taken, commission included and timeouts included. It is a
  // different denominator from expectancyGrossPct on purpose - the gross one
  // answers "what would the target/stop pair pay at this accuracy", this one
  // answers "what did the account make per trade it opened".
  const expectancyNetPctAllTrades =
    trades.length === 0 ? null : trades.reduce((sum, x) => sum + (x.netPnl / x.notional) * 100, 0) / trades.length;

  return {
    initialEquity: cfg.initialEquity,
    finalEquity: equity,
    returnPct: cfg.initialEquity === 0 ? null : (netPnl / cfg.initialEquity) * 100,
    config: {
      riskFractionPct: cfg.riskFractionPct,
      commissionPct: cfg.commissionPct,
      slippageTicks: cfg.slippageTicks,
    },
    curve,
    trades,
    counts,
    grossPnl,
    commissionPaid,
    netPnl,
    hitRate,
    expectancyGrossPct,
    expectancyNetPctAllTrades,
    profitFactor: netLosses === 0 ? null : netWins / netLosses,
    maxDrawdownPct: maxDrawdown,
    maxDrawdownAbsolute: maxDrawdownAbs,
    annualizedReturnPct,
    spanDays,
    longestWinStreak,
    longestLossStreak,
  };
}
// ============================================================================
// PART B - the wiring. simulateEquity() above is the whole of what the smoke
// suite drives; nothing below it is reachable from a synthetic fixture, which
// is exactly why it exists as a separate concern.
// ============================================================================

import { loadDataset, runComparison } from "./baseline.mjs";
import { labelSignalsExitRule } from "./modules/label.mjs";
import { DEFAULT_TIMEFRAME, getTimeframe } from "./timeframes.mjs";

const SCHEMA_VERSION = 1;

/**
 * THE TWO HORIZONS, DECLARED IN THE SOURCE AND BOTH RUN EVERY TIME.
 *
 * `EXIT_RULE_DEFAULTS.maxHorizonBars` is 288 and its own comment calls that
 * "24 hours of 5-minute bars". modules/label.mjs has NO timeframe awareness, so
 * 288 bars is 24h on 5m, ~12 DAYS on 1h and ~2 months on 4h. Silently running
 * 288 bars on a 1h dataset and calling it "the harness exit rule" would be a
 * category error, so both are run and both are named:
 *
 *   primary    8,760 bars, roughly a year on 1h. TradingView's strategy() has
 *              NO horizon at all - it holds until the target or the stop is
 *              touched - so a long horizon is what makes this curve comparable
 *              to that measurement. A trade that reaches neither level inside
 *              it is a `timeout`, and the timeout count is reported.
 *   companion  288 bars, the shipped Definition A, for continuity with the
 *              existing harness numbers. It is a DIFFERENT TRADE, not a
 *              refinement of the primary one.
 */
export const EQUITY_HORIZONS = Object.freeze({
  primaryHorizonBars: 8760,
  companionHorizonBars: 288,
});

/** Both entry models, reported symmetrically and with the same metric set. */
const MODELS = ["weighted", "binary"];

const out = (s = "") => console.log(`equity: ${s}`);

// -- Small helpers (mirrors ratio.mjs:214-219) ------------------------------

const iso = (ms) => new Date(ms).toISOString();
const int = (v) => Number(v).toLocaleString("en-US");
const round = (v, dp) =>
  v === null || v === undefined || Number.isNaN(v) ? null : Number(v.toFixed(dp));
const padL = (s, w) => String(s).padEnd(w);
const padR = (s, w) => String(s).padStart(w);

/** "34.78%" / "n/a" - an observed rate, or an explicit absence. */
const pct = (v, dp = 2) => (v === null || v === undefined ? "n/a" : `${v.toFixed(dp)}%`);

/** "+1,234.56" / "-1,234.56" / "n/a" - signed money, grouped. */
const money = (v, dp = 2) => {
  if (v === null || v === undefined) return "n/a";
  return `${v < 0 ? "-" : ""}${int(round(Math.abs(v), dp))}`;
};

/** "+0.35 pp" / "n/a" - a signed difference in percentage points. */
const pp = (v, dp = 2) => {
  if (v === null || v === undefined) return "n/a";
  return `${v > 0 ? "+" : ""}${round(v, dp)} pp`;
};

/**
 * Turns ONE modules/label.mjs result into a pure-core outcome.
 *
 * The only thing label.mjs does not store is `exitIndex`, and it is
 * `barIndex + horizonBars` by that file's own convention (entry at the signal
 * close, the scan starts on the next bar).
 *
 * `exitPrice` is the level the labeller resolved to - target on a win, stop on
 * a loss - and null on a timeout, which the core marks to market instead.
 * `altExitPrice` is the OTHER level, carried only so the optimistic
 * double-touch reading can be computed without the core knowing what a target
 * is.
 */
function outcomeFromLabel(result) {
  const labelled = result.label !== "insufficient_data";
  const resolvedWin = result.label === "win";
  const resolvedLoss = result.label === "loss";
  return {
    label: result.label,
    side: result.side,
    entryIndex: result.barIndex,
    // insufficient_data never ran a scan (horizonBars is 0), so there is no
    // exit bar to point at. null says "never observed", which is a different
    // statement from "closed here".
    exitIndex: labelled ? result.barIndex + result.horizonBars : null,
    entryPrice: result.price,
    exitPrice: resolvedWin ? result.targetPrice : resolvedLoss ? result.stopPrice : null,
    altExitPrice: result.doubleTouch ? result.targetPrice : null,
    doubleTouch: result.doubleTouch,
  };
}

/**
 * Labels one model's signals at one horizon and simulates the book.
 *
 * TWO candle arrays, on purpose, because they are not the same array and
 * conflating them is the exact mistake this signature exists to prevent:
 *
 *   labelCandles  `{high, low, close}` - what modules/label.mjs reads. It has
 *                 NO timestamps, which is why the core cannot use it for the
 *                 curve.
 *   candles       the dataset `{t, o, h, l, c, v}` - what the core reads, for
 *                 `t` (curve timestamps) and `c` (a timeout's mark).
 *
 * The indices are the same positions in both, because runComparison derives one
 * from the other rather than resampling.
 */
function runModel(candles, labelCandles, signals, maxHorizonBars, resolution) {
  const labelled = labelSignalsExitRule(labelCandles, signals, { maxHorizonBars });
  const outcomes = labelled.results.map(outcomeFromLabel);
  const sim = simulateEquity(candles, outcomes, { doubleTouchResolution: resolution });
  return { labelled, sim };
}

/**
 * The scope statement, printed before any number a reader could quote.
 *
 * What is genuinely NEW here, against every ratio in backtest/: the trades do
 * not overlap. Only-enter-when-flat means one position at a time, so each trade
 * owns its window and the "97.9% shared forward data" objection that
 * invalidates the ratios does not apply to the CURVE. It does not make the
 * trades independent draws - serial regime correlation is untouched by
 * position accounting - so no interval is attached here either.
 */
const SCOPE_CAVEAT =
  "THIS IS THE FIRST HARNESS OUTPUT WITH POSITION ACCOUNTING, AND THAT CHANGES WHAT MAY BE SAID " +
  "ABOUT IT. Every other report in backtest/ is a ratio over OVERLAPPING forward windows: two " +
  "signals six bars apart share 282 of their 288 forward bars, so their labels are not independent " +
  "observations and no interval, p-value or 'N trades' framing belongs on them. Only-enter-when-" +
  "flat means one position at a time, so the trades in this curve DO NOT OVERLAP and 'N trades' is " +
  "finally a legitimate count. It does NOT make them independent draws: serial regime correlation " +
  "is untouched by position accounting, so no confidence interval is attached here either and a hit " +
  "rate on this curve remains descriptive.";

// -- The report --------------------------------------------------------------

function printReport(r) {
  const { dataset, timeframe, config } = r;
  out("Local equity curve - weighted (shipped) vs binary (spec D.1), one position at a time");
  out(
    `dataset  ${dataset.path} - ${int(dataset.bars)} bars, ${dataset.firstIso} .. ` +
      `${dataset.lastIso}, ${dataset.spanDays} days, gaps ${dataset.gapCount ?? "?"} ` +
      `(${int(dataset.missingBars ?? 0)} missing bars), off-grid ${dataset.offGridBars ?? "?"}`,
  );
  out(
    `account  ${int(config.initialEquity)} opening equity, sizing ${config.riskFractionPct}% of ` +
      `CURRENT equity (compounding), commission ${config.commissionPct}% round trip charged once ` +
      `per completed trade, SLIPPAGE ${config.slippageTicks} (declared zero, NOT modelled)`,
  );
  out(
    `grid     ${timeframe.id} bars (${timeframe.minutesPerBar} min/bar). The primary horizon of ` +
      `${int(r.horizons.primaryHorizonBars)} bars is ` +
      `${horizonHoldHours(r.horizons.primaryHorizonBars, timeframe.minutesPerBar)}h here; the ` +
      `${int(r.horizons.companionHorizonBars)}-bar companion is ` +
      `${horizonHoldHours(r.horizons.companionHorizonBars, timeframe.minutesPerBar)}h. A bar count ` +
      "is not a duration - see caveat C1.",
  );
  out(
    `signals  weighted ${int(r.signalCounts.weighted)} / binary ${int(r.signalCounts.binary)} ` +
      "(fired signals, straight from baseline.mjs's sink)",
  );
  out("");

  // -- 1. Per model, per horizon, symmetric -------------------------------
  out("1. EQUITY CURVE BY MODEL - the same metrics for BOTH models, no exceptions");
  out("");
  for (const run of r.runs) {
    const head = `  ${padL(run.model, 10)}${padL(`${int(run.maxHorizonBars)} bars`, 14)}`;
    out(
      `${head}${padR("trades", 9)}${padR("hit", 9)}${padR("PF", 9)}${padR("exp/trade", 11)}` +
        `${padR("maxDD", 9)}${padR("CAGR", 11)}${padR("long", 7)}${padR("short", 7)}`,
    );
    for (const resolution of ["pessimistic", "optimistic"]) {
      const sim = run[resolution];
      const c = sim.counts;
      out(
        `${head}${padR(int(c.trades), 9)}` +
          `${padR(pct(c.resolved === 0 ? null : sim.hitRate * 100), 9)}` +
          `${padR(sim.profitFactor === null ? "n/a" : String(round(sim.profitFactor, 2)), 9)}` +
          `${padR(pct(sim.expectancyNetPctAllTrades), 11)}` +
          `${padR(pct(-sim.maxDrawdownPct), 9)}` +
          `${padR(pct(sim.annualizedReturnPct), 11)}` +
          `${padR(int(c.long), 7)}${padR(int(c.short), 7)}` +
          `${resolution === "optimistic" ? " <- doubleTouch sensitivity, NOT the headline" : ""}`,
      );
    }
    out("");
    // The curve's own endpoints, timestamped from the dataset rather than from
    // the report's clock, so a reader can find those bars on a chart.
    const curve = run.pessimistic.curve;
    if (curve.length > 0) {
      out(
        `  ${padL("", 24)}curve ${padL(iso(curve[0].t), 26)}..${iso(curve[curve.length - 1].t)}` +
          `  traded span ${round(run.pessimistic.spanDays, 2)} days`,
      );
    }
  }

  // -- 2. Where the money went, and what never became a trade --------------
  out("2. ACCOUNTING - gross, commission, net, and everything that was NOT traded");
  out("");
  const acctHead = `  ${padL("model", 10)}${padL("horizon", 14)}`;
  out(
    `${acctHead}${padR("final eq", 13)}${padR("return", 10)}${padR("gross", 11)}${padR("comm", 9)}` +
      `${padR("net", 11)}${padR("skipped", 10)}${padR("unobs", 8)}`,
  );
  for (const run of r.runs) {
    const s = run.pessimistic;
    const c = s.counts;
    out(
      `  ${padL(run.model, 10)}${padL(`${int(run.maxHorizonBars)} bars`, 14)}` +
        `${padR(money(s.finalEquity), 13)}${padR(pct(s.returnPct), 10)}` +
        `${padR(money(s.grossPnl), 11)}${padR(money(s.commissionPaid), 9)}` +
        `${padR(money(s.netPnl), 11)}${padR(int(c.skippedFlat), 10)}` +
        `${padR(int(c.insufficientData), 8)}`,
    );
  }
  out("");
  out("  Label counts, over fired signals and BEFORE the flat rule:");
  for (const run of r.runs) {
    const l = run.labelCounts;
    out(
      `  ${padL(run.model, 10)}${padL(`${int(run.maxHorizonBars)} bars`, 14)}` +
        `win ${int(l.win)} / loss ${int(l.loss)} / timeout ${int(l.timeout)} / ` +
        `insufficient_data ${int(l.insufficient_data)} / ` +
        `doubleTouch ${int(run.doubleTouchCount)}`,
    );
  }
  out("");

  // -- 3. Break-even: REPORTED, never selected on -------------------------
  out("3. BREAK-EVEN - the shipped pair against what this sample delivered");
  out("");
  const be = breakevenHitRate(EXIT_TARGET_PCT, EXIT_STOP_PCT);
  out(
    `  shipped D.4 pair: target ${EXIT_TARGET_PCT}% / stop ${EXIT_STOP_PCT}%, ratio ` +
      `${round(EXIT_TARGET_PCT / EXIT_STOP_PCT, 4)}, break-even hit rate ${pct(be * 100)}`,
  );
  for (const run of r.runs) {
    const s = run.pessimistic;
    if (s.hitRate === null) {
      out(`  ${padL(run.model, 10)}${padL(`${int(run.maxHorizonBars)} bars`, 14)}no resolved trade - nothing to compare`);
      continue;
    }
    out(
      `  ${padL(run.model, 10)}${padL(`${int(run.maxHorizonBars)} bars`, 14)}` +
        `hit ${pct(s.hitRate * 100)} vs break-even ${pct(be * 100)} (${pp((s.hitRate - be) * 100)}) - ` +
        `gross expectancy ${pct(expectancyPercent(s.hitRate, EXIT_TARGET_PCT, EXIT_STOP_PCT))} per ` +
        `resolved trade, ratio REQUIRED by that hit rate ${round(requiredRatio(s.hitRate), 4)}`,
    );
  }
  out("");
  out("  NO RATIO IS SELECTED ON ANYWHERE IN THIS REPORT. The 1.5 / 0.8 pair is D.4's own");
  out("  declaration, carried through untouched, so this curve measures the shipped strategy");
  out("  and not a search over it.");
  out("");

  // -- 4. Double-touch sensitivity, made visible --------------------------
  out("4. DOUBLE-TOUCH SENSITIVITY - the one modelling choice that can move a number");
  out("");
  for (const run of r.runs) {
    const p = run.pessimistic;
    const o = run.optimistic;
    out(
      `  ${padL(run.model, 10)}${padL(`${int(run.maxHorizonBars)} bars`, 14)}` +
        `${padR(int(p.counts.doubleTouch), 4)} bar(s) touched both levels - pessimistic ` +
        `(the headline, a loss) ${money(p.finalEquity)} vs optimistic (a win) ` +
        `${money(o.finalEquity)}; swing ${money(o.finalEquity - p.finalEquity)}`,
    );
  }
  out("");
  out("5. WHAT A READER MUST NOT CONCLUDE FROM THESE NUMBERS");
  out("");
  r.caveats.forEach((cv, i) => out(`  [C${i}] ${cv}`));
}

/**
 * Runs both models on one timeframe at both declared horizons and returns the
 * process exit code, in the runBaseline / runRatio shape.
 *
 * @param {{json?: boolean, tf?: object}} options `tf` is a resolved entry of
 *   backtest/timeframes.mjs and defaults to 5m like every other runner.
 * @returns {Promise<number>} process exit code (0 ok, 1 failed).
 */
export async function runEquity(options = {}) {
  const json = Boolean(options.json);
  const tf = options.tf ?? getTimeframe(DEFAULT_TIMEFRAME);
  const started = Date.now();

  try {
    const { candles, meta } = await loadDataset(tf);

    let sink = null;
    runComparison(candles, meta, tf, (payload) => {
      sink = payload;
    });
    // House pattern, ratio.mjs:1546. A wiring change that stopped the sink
    // firing would otherwise produce a confident curve computed over no
    // signals at all.
    if (sink === null) {
      throw new Error("baseline.mjs did not invoke the sink - its wiring changed, refusing to report");
    }

    const labelCandles = sink.labelCandles;
    const runs = [];
    for (const maxHorizonBars of [
      EQUITY_HORIZONS.primaryHorizonBars,
      EQUITY_HORIZONS.companionHorizonBars,
    ]) {
      for (const model of MODELS) {
        const pessimistic = runModel(candles, labelCandles, sink.signals[model], maxHorizonBars, "pessimistic");
        const optimistic = runModel(candles, labelCandles, sink.signals[model], maxHorizonBars, "optimistic");
        runs.push({
          model,
          maxHorizonBars,
          pessimistic,
          optimistic,
          byResolution: { pessimistic: pessimistic.sim, optimistic: optimistic.sim },
        });
      }
    }

    const reportedRuns = runs.map((run) => ({
      model: run.model,
      maxHorizonBars: run.maxHorizonBars,
      pessimistic: run.byResolution.pessimistic,
      optimistic: run.byResolution.optimistic,
      labelCounts: run.pessimistic.labelled.counts,
      doubleTouchCount: run.pessimistic.labelled.doubleTouchCount,
    }));

    const payload = {
      schemaVersion: SCHEMA_VERSION,
      ok: true,
      timeframe: { id: tf.id, minutesPerBar: tf.minutesPerBar },
      dataset: {
        path: tf.datasetRel,
        bars: candles.length,
        firstIso: meta === null ? null : meta.firstTimestampIso,
        lastIso: meta === null ? null : meta.lastTimestampIso,
        spanDays: meta === null ? null : meta.spanDays,
        gapCount: meta === null ? null : meta.gapCount,
        missingBars: meta === null ? 0 : meta.missingBars,
        offGridBars: meta === null ? null : meta.offGridBars,
      },
      config: {
        initialEquity: EQUITY_DEFAULTS.initialEquity,
        riskFractionPct: EQUITY_DEFAULTS.riskFractionPct,
        commissionPct: EQUITY_DEFAULTS.commissionPct,
        slippageTicks: EQUITY_DEFAULTS.slippageTicks,
        doubleTouchResolution: "pessimistic",
        onlyEnterWhenFlat: true,
      },
      horizons: {
        primaryHorizonBars: EQUITY_HORIZONS.primaryHorizonBars,
        companionHorizonBars: EQUITY_HORIZONS.companionHorizonBars,
      },
      signalCounts: {
        weighted: sink.signals.weighted.length,
        binary: sink.signals.binary.length,
      },
      scoreCandidateCounts: sink.scoreCandidateCounts,
      runs: reportedRuns,
      caveats: buildCaveats(reportedRuns, tf),
      runtimeMs: Date.now() - started,
    };

    if (json) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      printReport(payload);
      out("");
      out(`runtime ${int(payload.runtimeMs)} ms (wall clock, this run)`);
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

/**
 * The caveats. Every declared simulation decision plus this project's standing
 * objections, printed on EVERY run in both output modes - a caveat that only
 * appears when asked for is not a caveat.
 */
function buildCaveats(runs, tf) {
  const companion = EQUITY_HORIZONS.companionHorizonBars;
  const primary = EQUITY_HORIZONS.primaryHorizonBars;
  const primaryRuns = runs.filter((run) => run.maxHorizonBars === primary);
  const doubleTouchTotal = primaryRuns.reduce((sum, run) => sum + run.doubleTouchCount, 0);
  const unobsTotal = primaryRuns.reduce((sum, run) => sum + run.pessimistic.counts.insufficientData, 0);

  return [
    SCOPE_CAVEAT,
    `HORIZON IS DECLARED, NOT DEFAULTED SILENTLY, AND A BAR COUNT IS NOT A DURATION. ` +
      `EXIT_RULE_DEFAULTS.maxHorizonBars is 288 and modules/label.mjs has NO timeframe awareness ` +
      `at all, so 288 bars is 24 hours on 5m, ${horizonHoldHours(companion, tf.minutesPerBar)} hours on ` +
      `${tf.id} and ${horizonHoldHours(companion, 240)} hours on 4h - the "24 hours" in that file's ` +
      `comment is an annotation, not a conversion. This run therefore reports TWO horizons: ` +
      `${int(primary)} bars (${horizonHoldHours(primary, tf.minutesPerBar)}h on ${tf.id}), roughly a ` +
      `year here and comparable to TradingView's strategy(), which has NO horizon and simply holds ` +
      `until the target or the stop is touched; and the ${companion}-bar companion, for continuity ` +
      `with the existing harness numbers. A trade that reaches neither level inside a horizon is a ` +
      `TIMEOUT, reported as such in section 2 - never hidden, never folded into win or loss. The two ` +
      `horizons are DIFFERENT TRADES, not two estimates of one quantity.`,
    `DOUBLE TOUCH RESOLVES PESSIMISTICALLY TO A LOSS, MATCHING TRADINGVIEW'S INTRABAR CONVENTION, ` +
      `AND THE OPTIMISTIC READING IS REPORTED BESIDE IT. When one bar touches BOTH the target and ` +
      `the stop, intra-bar order is unknowable from OHLC data. ${doubleTouchTotal} such label(s) ` +
      `exist at the primary horizon across both models; the headline charges each one the stop, which ` +
      `is the reading that cannot flatter the result, and section 4 prints what the optimistic ` +
      `reading would pay instead. The gap between the two IS the size of this modelling choice.`,
    `ONLY-ENTER-WHEN-FLAT IS ON, MATCHING THE TRADINGVIEW DEFAULT THAT PRODUCED THE 56 / 191-TRADE ` +
      `COMPARISON, AND EVERY SKIPPED SIGNAL IS COUNTED. A signal arriving while a position is open is ` +
      `SKIPPED - not queued, not averaged into, not taken - and it is reported in the "skipped" ` +
      `column of section 2 rather than dropped, because a silently discarded signal is ` +
      `indistinguishable from one that never fired. The book is flat again at the CLOSE of the exit ` +
      `bar, so a signal on that same bar may re-enter. Every figure here is therefore a property of ` +
      `this entry rule: a pyramid or averaging-in variant would produce a different curve from the ` +
      `same signals, and that variant is not measured.`,
    `SIZING IS 10% OF CURRENT EQUITY AND COMPOUNDS, PER D.4 (default_qty_value=10). This is ` +
      `decisive and it is not cosmetic: every notional differs from the one before it, so a run of ` +
      `losses shrinks the position and a run of wins grows it. A 10%-of-INITIAL reading of the same ` +
      `rule would end at a different number. The curve is a property of the COMPOUNDING as much as of ` +
      `the signals, and no leverage, no drawdown-based sizing and no risk cap is modelled.`,
    `COMMISSION IS 0.10% ROUND TRIP, EXACTLY ONCE PER COMPLETED TRADE, FROM ` +
      `D4_ROUND_TRIP_COMMISSION_PCT (D.4's own commission_value=0.05 per side). It is charged on ` +
      `WINNERS AND LOSERS ALIKE - charging it only on exits, or only on losers, would flatter every ` +
      `trade count - and a signal skipped by the flat rule pays nothing because it was never opened.`,
    `SLIPPAGE IS DECLARED ZERO AND THAT IS AN EXCLUSION, NOT A MEASUREMENT. D.4 declares ` +
      `slippage=2 in TICKS, and Bitstamp's BTC/USD tick size is recorded in no meta file in this ` +
      `repository, so converting it to a percentage would mean inventing a number. This run models NO ` +
      `slippage, and every figure here is an UPPER BOUND on realised performance. That D.4's value is ` +
      `tick-dependent rather than price-dependent is exactly why it cannot be assumed small: on an ` +
      `instrument whose tick is a large fraction of a percent it is not a rounding error. Separately ` +
      `unexplained: on the TradingView run the observed per-trade figures were exactly target minus ` +
      `0.10%, implying slippage contributed nothing measurable there, and nothing in this repository ` +
      `resolves that. No spread filter is modelled either - D.3's spreadOK is absent from src/, so ` +
      `neither entry model gets it.`,
    `INSUFFICIENT_DATA IS REPORTED, NEVER SILENTLY DISCARDED, AND THE LONG HORIZON MAKES IT HUGE. ` +
      `modules/label.mjs checks availability BEFORE the exit scan, so the last maxHorizonBars bars of ` +
      `the dataset cannot be labelled at all - a touch inside a truncated window is insufficient_data, ` +
      `never a win. Those outcomes were never taken, so they move no money and do not occupy the book, ` +
      `and they are counted in the "unobs" column of section 2: ${unobsTotal} of them at the primary ` +
      `horizon across both models. At ${int(primary)} bars on ${tf.id} the unobservable tail is ` +
      `${horizonHoldHours(primary, tf.minutesPerBar)}h of history, which is why this column is much ` +
      `LARGER here than any default-horizon run in this harness would show.`,
    `TIMEOUTS ARE MARKED TO MARKET AT THE HORIZON CLOSE, WHICH IS NOT THE TARGET/STOP DISTRIBUTION. ` +
      `A timeout is a real trade with real capital at risk for the whole horizon and is counted as one ` +
      `in "trades" and in the net expectancy per completed trade. It is NOT a win and NOT a loss, so ` +
      `it never enters the hit rate. Its P&L is whatever that close happened to be, an unbounded ` +
      `quantity where the other two labels are bounded by 1.5% and 0.8% - so a run with many timeouts ` +
      `has a wider outcome distribution than its hit rate suggests.`,
    `MAX DRAWDOWN IS MEASURED ON THE CLOSED-TRADE CURVE, SO IT IS A LOWER BOUND. Equity moves on ` +
      `this curve only at an exit; an open position's floating P&L is never on it. The real path dips ` +
      `below every figure printed here between two closes, and at this grid with a long horizon those ` +
      `excursions last a long time.`,
    `ANNUALISED RETURN IS COMPOUNDED OVER THE TRADED SPAN (FIRST ENTRY TO LAST EXIT), NOT OVER THE ` +
      `DATASET'S SPAN. Both spans are printed per run. Annualising an idling curve over five years of ` +
      `history would understate it and annualising a one-week curve over a week would overstate it; the ` +
      `traded span is the only one of the two that describes the period the account was exposed. It ` +
      `is still an extrapolation of one five-year sample and it assumes the exposure continues.`,
    `EVERY DECISION ABOVE IS A HARNESS CHOICE, AND THIS CURVE MEASURES IT RATHER THAN THE INDICATOR. ` +
      `Changing any one of them - the horizon, the double-touch reading, the entry rule, the sizing ` +
      `rule - changes the answer. That is not a defect to be tuned away; it is the reason all of them ` +
      `are printed. NO PARAMETER WAS SELECTED AGAINST THESE RESULTS: target and stop are D.4's own ` +
      `1.5 / 0.8, carried through untouched, and no sweep is offered anywhere in this report.`,
    `THIS IS ONE DATASET, IN SAMPLE, AND IT IS NOT TRADINGVIEW'S DATA. Bitstamp BTC/USD, one ` +
      `continuous ${tf.id} series, no out-of-sample split and no walk-forward. A curve that ends above ` +
      `its opening balance on one in-sample path is not evidence about the next path. The TradingView ` +
      `run that motivated this slice covered a DIFFERENT window entirely (31 dic 2025 - 7 oct 2026) ` +
      `on a different feed, so the two are not comparable measurements, and agreement between them ` +
      `would not be corroboration.`,
    `THE REPLAY IS A COLD START. It begins at the first candle with no higher-timeframe history before ` +
      `it, so the D1 ATR needs 14 completed daily bars and a D1 pivot needs 21 before that tier exists ` +
      `at all. A chart with prior history loaded holds those values from bar 0, so the earliest part of ` +
      `this curve was traded under less information than the rest of it.`,
  ];
}

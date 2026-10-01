// ============================================================================
// LiquidityFlowAuse — Outcome Labelling (T9)
// ----------------------------------------------------------------------------
// WHAT HAPPENED AFTER THE SIGNAL FIRED? This module answers that question
// once per signal, under TWO independent label definitions, so the
// weight-calibration conclusion never depends on one arbitrary exit rule
// (odd/tasks/weight-calibration.md, T9: "report results under both so the
// conclusion does not depend on one arbitrary exit rule").
//
// Pure module: no I/O, no dataset access, no mutable state. The caller owns
// the candles and the signal list; every export is a pure function.
//
// ─── Signal event shape (consumed here) ─────────────────────────────────────
//
//   { barIndex, side: "long" | "short", price }
//
//   barIndex  index of the signal bar inside the `candles` array.
//   side      direction of the trade the signal implies.
//   price     the CLOSE of the signal bar — the entry reference every level
//             and every forward return is measured from.
//
// ─── Candle shape ───────────────────────────────────────────────────────────
//
// Candles are read as { high, low, close }, the same field names the other
// five modules in backtest/modules/ take. The dataset on disk is
// { t, o, h, l, c, v }; the CALLER maps one to the other at the call site
// (backtest/gate.mjs:332-338 shows the established mapping), e.g.
// `{ high: c.h, low: c.l, close: c.c }`.
//
// ANTI-MISWIRE INVARIANT: signal.price must be EXACTLY candles[barIndex]
// .close. A stale price or an off-by-one barIndex is the kind of wiring bug
// that produces plausible labels for the wrong bars, so this throws instead
// of labelling — the same discipline as the signal engine's same-side
// attribution invariant.
//
// ─── Definition A — D.4 exit rule (primary) ─────────────────────────────────
//
// The levels are taken VERBATIM from docs/technical-spec.md §D.4 "Strategy
// Version for Backtesting", lines 1961-1965 (checked against that file):
//
//     float targetPct = input.float(1.5, "Target (%)", ...)              // :1961
//     float stopPct   = input.float(0.8, "Stop Loss (%)", ...)           // :1962
//     strategy.exit("Exit Long",  "LONG",  profit=targetPct, loss=stopPct) // :1964
//     strategy.exit("Exit Short", "SHORT", profit=targetPct, loss=stopPct) // :1965
//
//   LONG : win at +1.5% from the signal close, loss at -0.8%.
//   SHORT: win at -1.5%, loss at +0.8%. TradingView's profit=/loss= are in
//          terms of the POSITION's P&L — a short profits when price FALLS —
//          so the levels are mirrored around the entry, not swapped.
//
// The scan starts on the bar AFTER the signal bar: the position is entered
// at the signal close, and the signal bar's own high/low happened before
// that close. Each forward candle's high/low is tested against the two
// levels; whichever level is touched first BY BAR INDEX decides the label.
//
// Labels:
//   win               the first touch is the target level.
//   loss              the first touch is the stop level (or the double-touch
//                     rule below).
//   timeout           maxHorizonBars scanned (default 288 = 24h of 5m bars)
//                     with neither level touched.
//   insufficient_data fewer than maxHorizonBars candles exist after the
//                     signal, so the horizon could not be observed.
//
// AVAILABILITY IS CHECKED BEFORE THE SCAN. The two rules above — "not touched
// within the horizon -> timeout" and "fewer than maxHorizonBars candles left
// after the signal -> insufficient_data" — only both hold literally when the
// availability test comes first: "not touched within the horizon" can be
// asserted only when a WHOLE horizon was observable. Consequences, all
// deliberate:
//   * a touch inside a truncated window is still insufficient_data, never a
//     win: the population of win/loss labels is homogeneous — every one of
//     them had a full horizon available;
//   * insufficient_data is never counted as win, loss or timeout, and is
//     never folded into them silently;
//   * candles after the last resolved bar are not read at all — for
//     insufficient_data the scan does not run (horizonBars is 0) and
//     barsAvailable reports how many candles existed instead.
//
// DOUBLE-TOUCH RULE (conservative). If ONE bar touches BOTH levels, the
// intra-bar order is unknowable from OHLC data, so the label is a loss — the
// pessimistic reading. Every such signal is flagged (doubleTouch: true) and
// counted separately (doubleTouchCount on the batch function), because that
// count is exactly how many labels the optimistic reading would move from
// the loss column to the win column.
//
// ─── Definition B — raw forward return (secondary, assumption-light) ────────
//
// No exit rule, no horizon censoring: the signed percentage change from the
// signal close to the close `n` bars later, at every horizon of a
// parameterized list (default [6, 12, 24, 48, 96, 288] = 30m/1h/2h/4h/8h/24h
// on 5m). The sign is normalized so a POSITIVE value always means "the trade
// would have made money": the raw price change is negated for shorts.
// A horizon whose close does not exist returns null — deliberately NOT 0,
// because 0 means "price did not move" and null means "never observed".
//
// ─── OVERLAPPING WINDOWS — NOT A PORTFOLIO SIMULATION ───────────────────────
//
// READ THIS BEFORE PUBLISHING ANY NUMBER DERIVED FROM THESE LABELS.
//
// Each label is an independent WINDOW over the shared candle series, not a
// trade in a portfolio. There is no position accounting, no cash, no equity
// curve, no compounding, no sizing, and no interaction between signals: two
// signals 6 bars apart each look 288 bars forward and therefore share 282 of
// those 288 bars — 97.9% of their forward data is THE SAME DATA. Their
// labels are consequently NOT statistically independent, and neither is any
// hit rate computed over them:
//
//   * a run of wins can be ONE trending stretch seen by many signals rather
//     than many independent successes;
//   * a hit rate over these labels is a descriptive ratio over dependent
//     observations — it is not a binomial proportion. Confidence intervals,
//     "N trades" framing, or p-values that treat each signal as an
//     independent trial would be WRONG.
//
// A later report that presents a hit rate MUST carry this caveat with it.
// The warning is repeated at labelSignalsExitRule(), where the counts a
// report would actually quote are produced.
//
// ─── Deliberately out of scope ──────────────────────────────────────────────
//
// Labels are GROSS and ignore execution reality. None of the following is
// modelled: slippage, commission, exchange fees, funding, borrow costs,
// spread, partial fills, order latency, or position sizing. Note that the
// D.4 strategy declaration itself DOES set commission_value=0.05 and
// slippage=2 (docs/technical-spec.md:1947-1949); this module models NEITHER,
// so a hit rate from these labels is an UPPER BOUND on what that strategy
// would realize after costs. Signal generation (score, gates, cooldown,
// spread filter) is out of scope too: this module labels the signals it is
// handed, and it never reads backtest/data/.
//
// ─── Wiring ─────────────────────────────────────────────────────────────────
//
//   const exits = labelSignalsExitRule(candles, signals);
//   // exits.counts -> { win, loss, timeout, insufficient_data }
//   // exits.doubleTouchCount -> report it next to any hit rate
//   const fwd = labelSignalsForwardReturn(candles, signals);
//   // fwd.results[i].returns[288] -> percentage, or null when unobserved
// ============================================================================

/** Exit target in percent — docs/technical-spec.md §D.4, line 1961. */
export const EXIT_TARGET_PCT = 1.5;

/** Exit stop in percent — docs/technical-spec.md §D.4, line 1962. */
export const EXIT_STOP_PCT = 0.8;

/** Definition A parameters. The 1.5/0.8 levels are spec, not knobs: see above. */
export const EXIT_RULE_DEFAULTS = Object.freeze({
  // 24 hours of 5-minute bars.
  maxHorizonBars: 288,
});

/** Definition B parameters. */
export const FORWARD_RETURN_DEFAULTS = Object.freeze({
  // 30m, 1h, 2h, 4h, 8h, 24h on a 5m chart.
  horizons: Object.freeze([6, 12, 24, 48, 96, 288]),
});

const EXIT_RULE_OPTIONS = ["maxHorizonBars"];
const FORWARD_RETURN_OPTIONS = ["horizons"];

// ─── Validation ─────────────────────────────────────────────────────────────

function assertCandles(candles, where) {
  if (!Array.isArray(candles)) {
    throw new TypeError(`${where}: candles must be an array`);
  }
}

function assertSignals(signals, where) {
  if (!Array.isArray(signals)) {
    throw new TypeError(`${where}: signals must be an array`);
  }
}

/**
 * Merges the caller's options over the definition's defaults and REJECTS
 * unknown keys. Silently ignoring `targetPct` would let a caller believe they
 * had parameterized the spec's exit rule when they had not.
 */
function resolveOptions(options, allowed, defaults, where) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError(`${where}: options must be an object`);
  }
  for (const key of Object.keys(options)) {
    if (!allowed.includes(key)) {
      throw new TypeError(`${where}: unknown option "${key}" (accepted: ${allowed.join(", ")})`);
    }
  }
  return { ...defaults, ...options };
}

function assertHorizonLimit(value, where) {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${where}: maxHorizonBars must be an integer >= 1, got ${String(value)}`);
  }
}

function assertHorizons(horizons, where) {
  if (!Array.isArray(horizons) || horizons.length === 0) {
    throw new TypeError(`${where}: horizons must be a non-empty array of integers`);
  }
  for (const horizon of horizons) {
    if (!Number.isInteger(horizon) || horizon < 1) {
      throw new RangeError(`${where}: every horizon must be an integer >= 1, got ${String(horizon)}`);
    }
  }
}

function assertCandle(bar, index, where) {
  if (bar === null || typeof bar !== "object") {
    throw new TypeError(`${where}: candles[${index}] must be a candle object { high, low, close }`);
  }
}

/**
 * Validates one signal event and returns its parts. Enforces the
 * anti-miswire invariant documented in the file header: price IS the signal
 * bar's close, so a disagreement here means the caller wired the wrong bar
 * or carried a stale price.
 */
function resolveSignal(candles, signal, where) {
  if (signal === null || typeof signal !== "object" || Array.isArray(signal)) {
    throw new TypeError(`${where}: signal must be an object { barIndex, side, price }`);
  }

  const { barIndex, side, price } = signal;

  if (!Number.isInteger(barIndex) || barIndex < 0) {
    throw new TypeError(`${where}: barIndex must be a non-negative integer, got ${String(barIndex)}`);
  }
  if (barIndex >= candles.length) {
    throw new RangeError(`${where}: barIndex ${barIndex} is beyond the last candle (${candles.length} bars)`);
  }
  if (side !== "long" && side !== "short") {
    throw new TypeError(`${where}: side must be "long" or "short", got ${String(side)}`);
  }
  if (!Number.isFinite(price) || price <= 0) {
    throw new TypeError(`${where}: price must be a finite number > 0, got ${String(price)}`);
  }

  const bar = candles[barIndex];
  assertCandle(bar, barIndex, where);
  if (bar.close !== price) {
    throw new TypeError(
      `${where}: signal.price (${String(price)}) must be the signal bar's close ` +
        `(${String(bar.close)}) — check barIndex and the candle field shape ` +
        `({ high, low, close }; see the file header)`,
    );
  }

  return { barIndex, side, price };
}

// ─── Definition A — D.4 exit rule ───────────────────────────────────────────

/**
 * Labels one signal under the D.4 target/stop rule (primary definition).
 *
 * @param {Array<{high, low, close}>} candles — the shared candle series.
 * @param {{barIndex: number, side: "long"|"short", price: number}} signal.
 * @param {{maxHorizonBars?: number}} options — defaults EXIT_RULE_DEFAULTS.
 * @returns {{
 *   label: "win"|"loss"|"timeout"|"insufficient_data",
 *   side: "long"|"short", barIndex: number, price: number,
 *   targetPrice: number, stopPrice: number,
 *   horizonLimit: number, horizonBars: number, barsAvailable: number,
 *   doubleTouch: boolean
 * }}
 *   horizonLimit — the maxHorizonBars in force.
 *   horizonBars   — bars actually scanned after the signal bar (0 when
 *                   insufficient_data: no scan runs).
 *   barsAvailable — candles that exist after the signal bar.
 *   doubleTouch   — both levels touched on the resolving bar; the label is
 *                   "loss" under the conservative rule.
 */
export function labelExitRule(candles, signal, options = {}) {
  const where = "labelExitRule";
  assertCandles(candles, where);
  const cfg = resolveOptions(options, EXIT_RULE_OPTIONS, EXIT_RULE_DEFAULTS, where);
  assertHorizonLimit(cfg.maxHorizonBars, where);

  const { barIndex, side, price } = resolveSignal(candles, signal, where);

  // D.4 levels measured from the signal close. profit=/loss= are in terms of
  // the POSITION's P&L, so the short's win level sits BELOW the entry and
  // its stop ABOVE it.
  const targetPrice =
    side === "long" ? price * (1 + EXIT_TARGET_PCT / 100) : price * (1 - EXIT_TARGET_PCT / 100);
  const stopPrice =
    side === "long" ? price * (1 - EXIT_STOP_PCT / 100) : price * (1 + EXIT_STOP_PCT / 100);

  const barsAvailable = candles.length - barIndex - 1;

  const result = {
    label: "insufficient_data",
    side,
    barIndex,
    price,
    targetPrice,
    stopPrice,
    horizonLimit: cfg.maxHorizonBars,
    horizonBars: 0,
    barsAvailable,
    doubleTouch: false,
  };

  // Availability BEFORE the scan — see the file header. Fewer than
  // maxHorizonBars of data left means the horizon is unobservable, so the
  // label is insufficient_data and nothing below runs: no touch, however
  // early, may turn a truncated window into a win or a loss.
  if (barsAvailable < cfg.maxHorizonBars) return result;

  for (let offset = 1; offset <= cfg.maxHorizonBars; offset++) {
    const index = barIndex + offset;
    const bar = candles[index];
    assertCandle(bar, index, where);
    if (!Number.isFinite(bar.high) || !Number.isFinite(bar.low)) {
      throw new TypeError(
        `${where}: candles[${index}].high/.low must be finite numbers ` +
          `(high=${String(bar.high)}, low=${String(bar.low)})`,
      );
    }

    const hitTarget = side === "long" ? bar.high >= targetPrice : bar.low <= targetPrice;
    const hitStop = side === "long" ? bar.low <= stopPrice : bar.high >= stopPrice;

    if (hitTarget || hitStop) {
      result.horizonBars = offset;
      // Both touched on this one bar -> hitStop is true -> loss, the
      // conservative reading (intra-bar order is unknowable from OHLC).
      result.doubleTouch = hitTarget && hitStop;
      result.label = hitStop ? "loss" : "win";
      return result;
    }
  }

  result.label = "timeout";
  result.horizonBars = cfg.maxHorizonBars;
  return result;
}

/**
 * Labels a list of signals under Definition A and reports the aggregate the
 * brief asks for: the RAW double-touch count, separate from the label counts.
 *
 * ─── OVERLAPPING WINDOWS (repeated here on purpose) ───────────────────────
 * `counts` and `doubleTouchCount` are LABEL COUNTS OVER OVERLAPPING FORWARD
 * WINDOWS, not portfolio results: no cash, no positions, no compounding, and
 * signals 6 bars apart share 97.9% of a 288-bar window. `hitRate =
 * counts.win / (counts.win + counts.loss)` is a descriptive ratio over
 * DEPENDENT observations — never present it as a proportion over independent
 * trials, and never attach confidence intervals to it. See the file header.
 *
 * doubleTouchCount is the number of signals whose label the conservative
 * rule set to "loss"; counting them as wins instead would move exactly that
 * many from the loss column to the win column.
 */
export function labelSignalsExitRule(candles, signals, options = {}) {
  const where = "labelSignalsExitRule";
  assertCandles(candles, where);
  // Resolved once up-front so an empty `signals` array cannot smuggle an
  // invalid option past validation.
  resolveOptions(options, EXIT_RULE_OPTIONS, EXIT_RULE_DEFAULTS, where);
  assertSignals(signals, where);

  const results = signals.map((signal) => labelExitRule(candles, signal, options));

  const counts = { win: 0, loss: 0, timeout: 0, insufficient_data: 0 };
  let doubleTouchCount = 0;
  for (const result of results) {
    counts[result.label] += 1;
    if (result.doubleTouch) doubleTouchCount += 1;
  }

  return { total: results.length, counts, doubleTouchCount, results };
}

// ─── Definition B — raw forward return ──────────────────────────────────────

/**
 * Labels one signal with the raw forward return (secondary, assumption-light
 * definition): the signed percentage change from the signal close to the
 * close `n` bars later, for each horizon in `options.horizons`.
 *
 * A positive number always means "the trade would have made money" — the raw
 * price change is negated for shorts. `returns[horizon]` is null when that
 * close is not in the dataset (out of range), never 0: 0 is a real answer
 * that means "price did not move".
 *
 * @param {Array<{close}>} candles — the shared candle series.
 * @param {{barIndex: number, side: "long"|"short", price: number}} signal.
 * @param {{horizons?: number[]}} options — defaults FORWARD_RETURN_DEFAULTS.
 * @returns {{side: string, barIndex: number, price: number,
 *            horizons: number[], returns: Object<number, number|null>}}
 *   `returns` is keyed by horizon and every requested horizon is present;
 *   iterate `horizons` (in order) rather than Object.keys, whose entries are
 *   strings.
 */
export function labelForwardReturn(candles, signal, options = {}) {
  const where = "labelForwardReturn";
  assertCandles(candles, where);
  const cfg = resolveOptions(options, FORWARD_RETURN_OPTIONS, FORWARD_RETURN_DEFAULTS, where);
  assertHorizons(cfg.horizons, where);

  const { barIndex, side, price } = resolveSignal(candles, signal, where);

  const returns = {};
  for (const horizon of cfg.horizons) {
    const index = barIndex + horizon;
    if (index >= candles.length) {
      // Out of range -> null, deliberately NOT 0: this close was never
      // observed, which is a different statement from "it did not move".
      returns[horizon] = null;
      continue;
    }

    const bar = candles[index];
    assertCandle(bar, index, where);
    if (!Number.isFinite(bar.close)) {
      throw new TypeError(`${where}: candles[${index}].close must be a finite number, got ${String(bar.close)}`);
    }

    const pct = ((bar.close - price) / price) * 100;
    returns[horizon] = side === "long" ? pct : -pct;
  }

  return { side, barIndex, price, horizons: [...cfg.horizons], returns };
}

/**
 * Labels a list of signals under Definition B. Same overlap caveat as the
 * Definition A batch: each entry is an independent WINDOW over one shared
 * series, so the labels are not statistically independent observations
 * (file header, "OVERLAPPING WINDOWS").
 */
export function labelSignalsForwardReturn(candles, signals, options = {}) {
  const where = "labelSignalsForwardReturn";
  assertCandles(candles, where);
  const cfg = resolveOptions(options, FORWARD_RETURN_OPTIONS, FORWARD_RETURN_DEFAULTS, where);
  assertHorizons(cfg.horizons, where);
  assertSignals(signals, where);

  const results = signals.map((signal) => labelForwardReturn(candles, signal, options));

  return { total: results.length, horizons: [...cfg.horizons], results };
}

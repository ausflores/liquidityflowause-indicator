// ============================================================================
// LiquidityFlowAuse — Structure Break (JavaScript port)
// ----------------------------------------------------------------------------
// Port of src/modules/structure-break.pine for the local backtest harness
// (odd/tasks/weight-calibration.md, task T5). LOGIC ONLY: the two persistent
// swing level lines (line.new / line.set_xy2 / line.delete) and the break
// labels (label.new) are NOT ported — this module computes values, it cannot
// draw. The showStructureBreaks / showSwingLevels inputs gated drawing only,
// so they are not ported either.
//
// Ported sections of docs/technical-spec.md:
//   6.2 swing point tracking — the confirmed 1H pivot VALUES arrive on the
//       bar argument (pivots.high / pivots.low). request.security() and
//       ta.pivothigh() themselves stay out of scope, exactly as in slice 2:
//       the caller aggregates 1H bars and feeds each confirmation, see
//       "Wiring" below.
//   6.3 swing state          — lastSwing*/prevSwing* levels and their
//       confirmation bars, marketStructure; all persistent (Pine `var`).
//   6.4 break detection      — a break is a CROSS of the level by close, the
//       two break blocks are independent `if`s (never `else if`), and
//       structureFlipped is decided against the structure in force BEFORE
//       this bar's update.
//   diagnostics — sbBreaks / sbFlips / sbOrphanFlips and their invariants.
//       In the Pine build these come from the STRUCTURE_DIAGNOSTIC_OVERLAY
//       that scripts/build.mjs appends after this module; task T5 names them
//       module outputs, so they are computed here.
//
// ─── SERIES SEMANTICS (read before changing an index) ───────────────────────
//
// This module stores NO array — the whole port is scalar state — so the array
// base question that dominated slice 2 does not arise. The indexing traps
// that DO apply here are series indexing and boolean na:
//
//   1. `close[1]` is SERIES indexing (Pine language/series): the previous
//      chart bar's close, NOT an array element — `array.get(a, 1)` would be
//      the second element, and the two are routinely confused. The previous
//      close is kept as `prevClose` below and advanced at the end of each
//      evaluate() call. It is deliberately NOT a bar field: forgetting to
//      pass it would silently disable every break, while a module that owns
//      the series cannot be wired wrong.
//   2. na in a boolean context is FALSE for every `if` in this module, so
//      each na site is mapped to a strict `false` instead of being
//      propagated: the level guard (`not na(lastSwingHigh)`), the missing
//      previous bar (bar 0 has no `close[1]`), and a pivot that has never
//      confirmed. The exported type is bool, so na-as-false IS the observable
//      value a chart would show.
//
// ORDERING (Pine source order, load-bearing):
//   Block 1 updates the swing levels from this bar's confirmed pivots,
//   Block 2 then tests the cross against the UPDATED level. A pivot that
//   confirms on this bar can therefore be broken on this same bar; testing
//   the previous level first would delay or skip that break.
//
// ─── Interface invariant (spec 6.7 / the Pine module header) ────────────────
//
// structureFlipped IS A PROPERTY OF A BREAK, NOT A SECOND BREAK. ChoCh is BoS
// plus a structure precondition — a SUBSET, not a sibling. An earlier draft
// exposed bullishBoS / bullishChoCh as independent booleans and spec 7.3 then
// awarded +20 for any break and a further +30 for a ChoCh, so one reversal
// break scored 50 points. This port exports exactly the four values the Pine
// module exports; a consumer that wants "structure turned bullish" tests
// `breakUp and structureFlipped`.
//
// ─── Wiring (for the later harness slices) ──────────────────────────────────
//
// Pine fetches the pivots with
//   request.security(syminfo.tickerid, "60", ta.pivothigh(high, n, n),
//                    lookahead = barmerge.lookahead_off)
// i.e. 1H pivots become visible on the chart bar where the 1H bar closes.
// Aggregation is deliberately not done here (out of scope, as in slice 2):
//
//   const sb = createStructureBreak();
//   const h1 = createPivotDetector({ pivotLenHigh: STRUCTURE_BREAK_DEFAULTS.structPivotLen,
//                                    pivotLenLow:  STRUCTURE_BREAK_DEFAULTS.structPivotLen });
//   for (const chartBar of candles) {
//     let pivots = { high: null, low: null };
//     if (chartBar closes an H1 bar) pivots = h1.update(htfBar);  // aggregation decides
//     sb.evaluate({ barIndex, close: chartBar.close, pivots });
//   }
//
// structPivotLen (default 5) is exported in STRUCTURE_BREAK_DEFAULTS because
// it configures the CALLER's detector; this module validates it (Pine minval
// 3) but never reads it otherwise. It must NOT be shared with
// liquidity-zones' pivotLenHigh/Low (default 10): the Pine module explains at
// length that the two lengths describe different structure, so the caller
// builds its own detector.
//
// PRECONDITION on evaluate(): one engine instance per series, called once per
// chart bar in chronological order with consecutive barIndex values. Both
// halves of the cross test (`close` now, `close[1]` before) are series
// values, so a skipped or repeated bar would test the wrong pair; the
// precondition is ENFORCED (see the barIndex check below), not assumed. A
// fresh engine starts its series at the first bar it is given: prevClose is
// na there, marketStructure is 0, and no break can fire on that first bar —
// the same warm-up a Pine script has on bar 0.
// ============================================================================

const NA = null;

/** True for Pine `na`: null, undefined, or a NaN produced by the caller. */
function isNa(value) {
  return (
    value === NA ||
    value === undefined ||
    (typeof value === "number" && Number.isNaN(value))
  );
}

/** Defaults mirrored from the Pine module's input.* declarations. */
export const STRUCTURE_BREAK_DEFAULTS = Object.freeze({
  // Structure pivot length (minval 3). Consumed by the CALLER's 1H pivot
  // detector — see the Wiring section of the file header.
  structPivotLen: 5,
});

function assertIntInRange(value, min, max, name) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer in [${min}, ${max}], got ${value}`);
  }
}

// ─── Module factory ──────────────────────────────────────────────────────────

/**
 * Builds the structure-break engine. Mirrors one concatenation of the Pine
 * module: configuration is fixed at construction, the swing/structure state
 * lives across bars (Pine `var`), and evaluate() runs the three Pine blocks
 * in their exact order — swing update, break detection, diagnostics.
 *
 * @param {object} options — overrides of STRUCTURE_BREAK_DEFAULTS.
 */
export function createStructureBreak(options = {}) {
  const cfg = { ...STRUCTURE_BREAK_DEFAULTS, ...options };
  assertIntInRange(cfg.structPivotLen, 3, Number.MAX_SAFE_INTEGER, "structPivotLen");

  // ── Persistent swing state (spec 6.3, Pine `var`) ─────────────────────────
  //
  // lastSwingHigh / lastSwingLow are the LEVELS a break is measured against;
  // the Bar fields record WHEN each was confirmed (stamped with bar_index, the
  // confirmation bar, not the pivot bar — the level did not exist and could
  // not be broken until it was knowable). prevSwing* hold the level before the
  // most recent confirmation: inert state in the Pine module (nothing reads
  // them today, spec 6.3 declares them for a future fractal variant), kept
  // here so the port's state matches the source exactly.
  let lastSwingHigh = NA;
  let lastSwingLow = NA;
  let prevSwingHigh = NA;
  let prevSwingLow = NA;
  let lastSwingHighBar = NA;
  let lastSwingLowBar = NA;

  // Structure in force: 1 bullish, -1 bearish, 0 not yet established.
  // Persistent (Pine `var`) and part of the exported interface (spec 6.7).
  let marketStructure = 0;

  // Pine's `close[1]` in the cross test — the previous chart bar's close.
  // Advanced at the end of evaluate(); na on the first bar, which makes the
  // cross test false there exactly as Pine's na does.
  let prevClose = NA;

  // Bar index of the last bar evaluated; enforces the consecutive-bar
  // precondition described in the file header.
  let lastBarIndex = NA;

  // ── Diagnostic counters (scripts/build.mjs STRUCTURE_DIAGNOSTIC_OVERLAY) ──
  //
  // sbOrphanFlips is the load-bearing one: structureFlipped is a property of
  // a break, so it must never be true on a bar with no break. If it ever
  // becomes non-zero the module has reintroduced the parallel BoS/ChoCh flags
  // that scored one reversal break as 20 + 30 = 50.
  let sbBreaks = 0;
  let sbFlips = 0;
  let sbOrphanFlips = 0;

  function evaluate(bar) {
    if (bar == null) throw new TypeError("structure-break: bar is required");

    const { barIndex, close, pivots = {} } = bar;
    if (!Number.isInteger(barIndex) || barIndex < 0) {
      throw new TypeError(`structure-break: barIndex must be a non-negative integer, got ${barIndex}`);
    }
    if (!Number.isFinite(close)) {
      throw new TypeError(`structure-break: close must be a finite number, got ${close}`);
    }
    // Enforced precondition: consecutive bars only (see file header). A gap
    // would silently pair `close` with a `close[1]` from the wrong bar, which
    // is exactly the "plausible output, wrong values" failure this port exists
    // to avoid.
    if (!isNa(lastBarIndex) && barIndex !== lastBarIndex + 1) {
      throw new RangeError(
        `structure-break: bars must be consecutive; expected barIndex ${lastBarIndex + 1}, got ${barIndex}`,
      );
    }
    lastBarIndex = barIndex;

    const pivotHigh = pivots.high;
    const pivotLow = pivots.low;
    if (!isNa(pivotHigh) && !Number.isFinite(pivotHigh)) {
      throw new TypeError(`structure-break: pivots.high must be a finite number or na, got ${pivotHigh}`);
    }
    if (!isNa(pivotLow) && !Number.isFinite(pivotLow)) {
      throw new TypeError(`structure-break: pivots.low must be a finite number or na, got ${pivotLow}`);
    }

    // ── Block 1: swing state update (spec 6.3) ──────────────────────────────
    //
    // A confirmed pivot supersedes the previous level of the same kind. Runs
    // BEFORE the break test below, so a level confirmed on this bar is
    // immediately the level this bar's cross is measured against (Pine source
    // order, lines 114-122 before 146-178).
    if (!isNa(pivotHigh)) {
      prevSwingHigh = lastSwingHigh;
      lastSwingHigh = pivotHigh;
      lastSwingHighBar = barIndex;
    }

    if (!isNa(pivotLow)) {
      prevSwingLow = lastSwingLow;
      lastSwingLow = pivotLow;
      lastSwingLowBar = barIndex;
    }

    // ── Block 2: break detection (spec 6.4 / 6.7) ───────────────────────────
    //
    // A BREAK IS A CROSS, NOT A THRESHOLD: the level held on the previous bar
    // and was lost on this one. Testing `close` (not high/low) is deliberate —
    // a wick through a level that is rejected is liquidity being taken, which
    // is the Liquidity Zones module's job, and using the bar's extreme here
    // would have both modules report the same event.
    //
    // na guards are required, not defensive: lastSwingHigh is na until the
    // first pivot confirms, and prevClose is na on the first bar; every
    // comparison against na is na in Pine, which would leave the flags
    // indeterminate rather than false. The `!isNa(prevClose)` conjunct is that
    // site: no previous bar, no cross.
    //
    // The two blocks are independent `if`s, never `else if`, exactly as the
    // Pine module writes them. (Both cannot fire on one bar: crossedAbove
    // requires prevClose <= lastSwingHigh < close while crossedBelow requires
    // prevClose >= lastSwingLow > close, which is contradictory for any pair
    // of levels. The independent form is kept because it is what the source
    // says and it makes no assumption about level ordering.)
    let breakUp = false;
    let breakDown = false;
    let structureFlipped = false;

    const crossedAbove =
      !isNa(lastSwingHigh) &&
      !isNa(prevClose) &&
      close > lastSwingHigh &&
      prevClose <= lastSwingHigh;
    const crossedBelow =
      !isNa(lastSwingLow) &&
      !isNa(prevClose) &&
      close < lastSwingLow &&
      prevClose >= lastSwingLow;

    // REVERSAL IS DECIDED AGAINST THE STRUCTURE IN FORCE BEFORE THIS BAR,
    // which is why structureFlipped reads marketStructure before the
    // assignment below overwrites it. With marketStructure == 0 the first
    // break in either direction is a break but NOT a change of character: it
    // is the ESTABLISHMENT of structure, so structureFlipped stays false.
    if (crossedAbove) {
      breakUp = true;
      structureFlipped = marketStructure === -1;
      marketStructure = 1;
    }

    if (crossedBelow) {
      breakDown = true;
      structureFlipped = marketStructure === 1;
      marketStructure = -1;
    }

    // Levels are NOT reset after a break (spec 6.4): marketStructure persists
    // and the same level keeps being tested until a new pivot supersedes it.
    // A break flag is recomputed from scratch on every bar, so a cross that
    // fails on the next bar reports breakUp = false while the structure it
    // established stays in force.

    // ── Block 3: diagnostics (STRUCTURE_DIAGNOSTIC_OVERLAY) ─────────────────
    //
    // Appended after the module in the Pine build, so it observes this bar's
    // final flags. sbOrphanFlips counts structureFlipped on a bar with no
    // break — structurally impossible while structureFlipped is only assigned
    // inside a break block, which is precisely why it is a useful probe.
    if (breakUp || breakDown) sbBreaks += 1;
    if (structureFlipped) {
      sbFlips += 1;
      if (!breakUp && !breakDown) sbOrphanFlips += 1;
    }

    prevClose = close;

    return {
      breakUp,
      breakDown,
      structureFlipped,
      marketStructure,
      // Swing state (spec 6.3) — exposed for the fidelity gate and for
      // inspection, exactly as the `var`s are visible to later modules in the
      // concatenated Pine script.
      lastSwingHigh,
      lastSwingLow,
      prevSwingHigh,
      prevSwingLow,
      lastSwingHighBar,
      lastSwingLowBar,
      sbBreaks,
      sbFlips,
      sbOrphanFlips,
    };
  }

  return { evaluate, defaults: cfg };
}

// ============================================================================
// LiquidityFlowAuse — The Maintainer's Concept, Counted
// ----------------------------------------------------------------------------
// A BOUNDED measurement, dispatched by `node backtest/run.mjs concept`. It
// answers one question and refuses to answer any other:
//
//   How many entries does the maintainer's OWN STATED TRADING CONCEPT produce
//   on this grid, and what does each gating choice cost?
//
// The concept, verbatim (the commission's own decomposition of the maintainer's
// words — "el concepto era liquidez + horarios + (imbalance con cambio de
// estructura de 5 min a 3 min) ... ya si puedes marcarlo para poder entrar, como
// vender o comprar ya depende a qué dirección va"):
//
//   1. LIQUIDITY   a D1 / 4H / 1H zone nearby, either side
//   2. SESSION     the hours
//   3. CONFIRMATION  a 3-candle fair value gap on the entry timeframe
//                  (imbalance-detector.pine:7 — "Detects 3-candle fair value
//                  gaps on the entry timeframe")
//                  AND a structure change, on the SAME SIDE
//   4. ENTRY MARK  when all of it lines up, mark it; direction follows the setup
//
// ─── THE DECISIVE DIFFERENCE FROM WHAT IS SHIPPED ────────────────────────────
//
// The shipped raw signal is an OR (src/modules/signal-engine.pine:165-171):
//
//   nearLiquidityLong and sessionOK and
//     (breakUp or nearImbalanceLong or inImbalanceLong) and
//     longScore >= minConfidence
//
// The maintainer's concept is an AND: imbalance AND structure. The shipped score
// threshold of 70 makes the conjunction IMPLEMENTED but not EXPLICIT — on a 5m
// chart the only reachable liquidity tier is H1 (+10), so the minimum path to 70
// is 10 + 25 + 20 + 15 = 70, which needs both a session overlap AND a break AND
// an imbalance. This file makes the conjunction explicit and measures what each
// reading of every ambiguous term costs.
//
// ─── WHAT IS COUNTERFACTUAL ─────────────────────────────────────────────────
//
// Exactly ONE row in this file measures a shipped behaviour: the row labelled
// `shipped`, which is the shipped expression transcribed as a predicate. Every
// other row is a COUNTERFACTUAL or a RECONSTRUCTION — it describes a rule that
// does not exist in src/ and was never wired anywhere. Each row says which it is.
//
// No Pine change is in scope. Nothing under src/ or scripts/ is read for anything
// other than reference, and nothing anywhere is recommended to ship. Choosing a
// formulation is the maintainer's decision; this file's job is to put the
// consequences of each choice on the table at once.
//
// ─── FAITHFULNESS IS AN ASSERTION, NOT A CLAIM ──────────────────────────────
//
// This file mirrors baseline.mjs's wiring loop (same reason band.mjs does: a
// measurement that SHARES mutable state with the baseline could perturb it
// silently). A mirror can be wrong, so the `shipped` row is REQUIRED to
// reproduce the real signal engine's raw AND fired flags, and this file's own
// score to reproduce its score, on EVERY bar of EVERY grid. A mismatch throws.
// That per-bar assertion is strictly stronger than matching a count: the score
// is a function of all four upstream modules' flags, so an equal score on every
// bar proves the wiring fed identical inputs.
//
// Usage:
//   node backtest/run.mjs concept                     human-readable report
//   node backtest/run.mjs concept --timeframe 1h      one native grid
//   node backtest/run.mjs concept --json              the same numbers as JSON
// ============================================================================

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
} from "./modules/liquidity-zones.mjs";
import {
  createStructureBreak,
  STRUCTURE_BREAK_DEFAULTS,
} from "./modules/structure-break.mjs";
import { createImbalanceDetector } from "./modules/imbalance-detector.mjs";
import { createSignalEngine } from "./modules/signal-engine.mjs";
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

const SCHEMA_VERSION = 1;

const MS_1H = 3600000;
const MS_4H = 14400000;
const MS_1D = 86400000;

const DEFAULT_TF = getTimeframe(DEFAULT_TIMEFRAME);

// ─── Reporting policy mirrors (declared, never imported) ─────────────────────
//
// Same reasoning as band.mjs: this file adds no edit to an existing file that
// other subcommands print through. smoke.mjs asserts, by reading those files'
// source, that each still declares the same value — so the two cannot drift
// silently. These are the only two numbers imported-from-nowhere that govern
// whether a percentage is printed at all.

/**
 * Mirrors backtest/ratio.mjs:183 and backtest/band.mjs:113.
 *
 * Below this floor an INDEPENDENT (non-overlapping-window) hit rate is REFUSED,
 * not estimated. The gate is applied BEFORE any bootstrap draw exists, so a
 * refusal is a refusal to draw rather than a wide interval dressed up as a
 * result.
 */
const MIN_OBSERVATIONS_FOR_INTERVAL = 30;

/** Bootstrap settings for the independent-sample interval. `ratio`'s convention. */
const DEFAULT_SEED = 20260901;
const DEFAULT_BOOTSTRAP = 10000;

/**
 * The shipped D.4 hold, in bars, and the independent window.
 *
 * CARRIED FORWARD, NOT OPTIONAL: 288 bars is a 24-HOUR hold on 5m and a 12-DAY
 * hold on 1h. Every hit rate in this file is stated on that one hold, so a 5m
 * number and a 1h number are NOT like-for-like and are never pooled or compared
 * as if they were.
 */
const INDEPENDENT_WINDOW_BARS = EXIT_RULE_DEFAULTS.maxHorizonBars;

const out = (s = "") => console.log(`concept: ${s}`);

// ─── Small helpers ───────────────────────────────────────────────────────────

const iso = (ms) => new Date(ms).toISOString();
const int = (v) => Number(v).toLocaleString("en-US");
const round = (v, dp) =>
  v === null || v === undefined || Number.isNaN(v) ? null : Number(v.toFixed(dp));
const padL = (s, w) => String(s).padEnd(w);
const padR = (s, w) => String(s).padStart(w);
/** "31.25%" / "n/a" — never a silent 0%, which reads as "lost everything". */
const pct = (v, dp = 2) =>
  v === null || v === undefined ? "n/a" : `${Number(v).toFixed(dp)}%`;
const dint = (v) =>
  v === null || v === undefined ? "n/a" : `${v > 0 ? "+" : ""}${int(v)}`;

function medianOf(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function meanOf(values) {
  if (values.length === 0) return null;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

function statsOf(values) {
  if (values.length === 0) {
    return { count: 0, min: null, median: null, mean: null, max: null, histogram: {} };
  }
  let min = Infinity;
  let max = -Infinity;
  const histogram = new Map();
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
    histogram.set(v, (histogram.get(v) ?? 0) + 1);
  }
  const keys = [...histogram.keys()].sort((a, b) => a - b);
  const hist = {};
  for (const key of keys) hist[String(key)] = histogram.get(key);
  return {
    count: values.length,
    min,
    median: round(medianOf(values), 4),
    mean: round(meanOf(values), 4),
    max,
    histogram: hist,
  };
}

// ─── THE PREDICATE, AS AN EXPLICIT PARAMETERISED FUNCTION ────────────────────
//
// A CONCEPT is a pure function of one bar's state. Nothing upstream is
// re-derived here: every input below is a flag the shipped modules already
// produced, read on the same bar object the Signal Engine reads. That is the
// whole reason this file can vary the rule without touching src/.
//
// EXCLUSIVITY BY SIDE IS STRUCTURAL, NOT A CONVENTION. `arm(side)` never reads
// the other side's flags, so an imbalance LONG cannot satisfy a SHORT predicate
// even in principle; smoke.mjs asserts that with hostile synthetic bars.

// ── The five ambiguous choices, as frozen sets ──────────────────────────────
//
// FROZEN and printed in full. A sweep that showed only the rows that worked
// would let a reader believe the set was chosen after seeing the results.

/**
 * `sessionMin`: the minimum sessionStrength the session factor must reach.
 *   1 — ANY session, Asia included. The maintainer's own wording is "horarios",
 *        with no exclusion of Asia.
 *   2 — London or NY. This is the SHIPPED gate (signal-engine.pine:83), which
 *        explicitly excludes Asia-alone.
 */
export const SESSION_GATES = Object.freeze([1, 2]);

/**
 * `structureArm`:
 *   "any"  — any break in that direction (BoS), +20
 *   "flip" — a break that also flipped structure (ChoCh), +30
 * A flip is a SUBSET of a break (structure-break.mjs:56), so "flip" is strictly
 * narrower. `structureFlipped` is one flag, set only on a break, on exactly one
 * side — so requiring it never makes a long predicate satisfiable by a short
 * break.
 */
export const STRUCTURE_ARMS = Object.freeze(["any", "flip"]);

/**
 * `imbalanceArm`:
 *   "near"   — nearImbalance* only: an UNTOUCHED gap being approached
 *   "in"     — inImbalance* only: a TOUCHED gap price is inside
 *   "either" — either arm, which is what the shipped expression reads
 *
 * THE BRIEF STATES THESE ARE MUTUALLY EXCLUSIVE BY CONSTRUCTION. They are NOT,
 * at the level of a BAR — they are mutually exclusive at the level of a GAP.
 * The Pine `else if` (imbalance-detector.pine:302-310) stops ONE gap from
 * counting as both an entry and a fill, but the proximity loop ranges over the
 * whole live array, so gap A can be inside while gap B is nearby-and-virgin on
 * the same bar. Measured: 227 long and 230 short bars on the 5m grid carry both
 * arms at once. This file therefore reports which arm CARRIES the setups rather
 * than assuming one of them is empty, and smoke.mjs asserts the PER-GAP
 * exclusivity that actually holds.
 */
export const IMBALANCE_ARMS = Object.freeze(["either", "near", "in"]);

/**
 * `conjunction`:
 *   "AND" — the maintainer's concept: imbalance AND structure change
 *   "OR"  — the shipped expression: break OR imbalance
 */
export const CONJUNCTIONS = Object.freeze(["AND", "OR"]);

/**
 * `gate` — the minimum SHIPPED score a bar must reach, or null for NO score gate
 * at all. The shipped value is 70 (signal-engine.pine:46).
 *
 * The ladder brackets the shipped value rather than sweeping finely: 60 and 65
 * are the nearest reachable scores BELOW the path slice 6 established, 75 is the
 * nearest step above. `null` is not a threshold of 0 — it removes the score as a
 * gate entirely, which is what the maintainer's wording describes.
 */
export const SCORE_GATES = Object.freeze([null, 60, 65, 70, 75]);

/** The shipped score threshold, by source. */
export const SHIPPED_SCORE_GATE = 70;
/** The shipped cooldown, by source (signal-engine.pine:47). */
export const SHIPPED_COOLDOWN_BARS = 10;

/** The row that IS the shipped expression, as a frozen concept descriptor. */
export const SHIPPED_CONCEPT = Object.freeze({
  sessionMin: 2,
  structureArm: "any",
  imbalanceArm: "either",
  conjunction: "OR",
  gate: SHIPPED_SCORE_GATE,
});

/** The row that IS the maintainer's concept, as stated. No score gate. */
export const CONCEPT_AS_WRITTEN = Object.freeze({
  sessionMin: 1,
  structureArm: "any",
  imbalanceArm: "either",
  conjunction: "AND",
  gate: null,
});

/**
 * The WIDEST MEASURABLE population in this matrix, used as the secondary census
 * population so the session-flavour and imbalance-arm splits are not vacuous on a
 * grid where the concept as written admits nothing. Always reported as its own
 * labelled column and never presented as the concept's own breakdown.
 */
export const WIDEST_MEASURABLE = Object.freeze({
  sessionMin: 1,
  structureArm: "any",
  imbalanceArm: "either",
  conjunction: "OR",
  gate: null,
});

/**
 * The shipped expression is the OR; without the score gate it is spec D.1's
 * binary confluence model, which `baseline` runs as its second model. That gives
 * a SECOND row here that must reproduce a shipped count, independently of the
 * engine-level per-bar assertion: if this row's numbers disagree with
 * `baseline`'s binary model, the whole matrix is measuring something else.
 */
export const BINARY_CONCEPT = Object.freeze({
  sessionMin: 2,
  structureArm: "any",
  imbalanceArm: "either",
  conjunction: "OR",
  gate: null,
});

function conceptKey(c) {
  return `s${c.sessionMin}|${c.structureArm}|${c.imbalanceArm}|${c.conjunction}|${c.gate === null ? "none" : c.gate}`;
}

function conceptLabel(c) {
  return (
    `session>=${c.sessionMin} · struct:${c.structureArm} · imb:${c.imbalanceArm}` +
    ` · ${c.conjunction} · gate:${c.gate === null ? "none" : c.gate}`
  );
}

/**
 * The full concept set, in report order.
 *
 * The first row is the maintainer's concept AS WRITTEN, so every delta in the
 * report is "what this choice costs" against a stated baseline rather than
 * against whichever row happened to be computed first. The last row is the
 * shipped expression.
 */
export function concepts() {
  const list = [];
  for (const conjunction of CONJUNCTIONS) {
    for (const sessionMin of SESSION_GATES) {
      for (const structureArm of STRUCTURE_ARMS) {
        for (const imbalanceArm of IMBALANCE_ARMS) {
          for (const gate of SCORE_GATES) {
            list.push(
              Object.freeze({ sessionMin, structureArm, imbalanceArm, conjunction, gate }),
            );
          }
        }
      }
    }
  }
  return Object.freeze(list);
}

/**
 * THE PREDICATE. Pure: state in, boolean out. No state, no side effects, no
 * reads of the opposite side.
 *
 * @param {object} s  the per-bar state object collected by the wiring loop
 * @param {"long"|"short"} side
 * @param {object} c  a concept descriptor
 */
export function predicateHolds(s, side, c) {
  const long = side === "long";

  // 1. LIQUIDITY — a D1, 4H or 1H zone nearby on THIS side. nearLiquidity* is
  //    already the OR of the three per-side tier flags (liquidity-zones.pine:305-321),
  //    so it IS "one of the three tiers, same side".
  if (!(long ? s.nearLiquidityLong : s.nearLiquidityShort)) return false;

  // 2. SESSION — the hours.
  if (s.sessionStrength < c.sessionMin) return false;

  // 3. CONFIRMATION, same side throughout.
  const structure = long ? s.breakUp : s.breakDown;
  if (c.structureArm === "flip" && !s.structureFlipped) return false;
  const hasStructure = Boolean(structure);

  const near = long ? s.nearImbalanceLong : s.nearImbalanceShort;
  const inside = long ? s.inImbalanceLong : s.inImbalanceShort;
  const hasImbalance =
    c.imbalanceArm === "near" ? Boolean(near)
    : c.imbalanceArm === "in" ? Boolean(inside)
    : Boolean(near) || Boolean(inside);

  // 4. THE CONJUNCTION — the whole disagreement between this concept and the
  //    shipped indicator, in one character.
  if (c.conjunction === "AND") {
    if (!hasImbalance || !hasStructure) return false;
  } else if (!hasImbalance && !hasStructure) {
    return false;
  }

  // 5. THE SCORE GATE, optional. null removes the gate entirely; it is NOT
  //    "score >= 0", which would be a different (and much wider) rule.
  if (c.gate !== null) {
    const score = long ? s.longScore : s.shortScore;
    if (score < c.gate) return false;
  }
  return true;
}

// ─── THE PER-VARIANT STATE MACHINE ──────────────────────────────────────────
//
// Shape is IDENTICAL to signal-engine.mjs Blocks 5-7: directional exclusivity by
// marketStructure, an ambiguous tie dropped, then the 10-bar cooldown with ONE
// stamp for both directions. One closure per (concept, side-pair) so every
// variant keeps its OWN cooldown — a shared stamp would let a busy variant
// suppress a quiet one's bars on the other's history, which is the exact
// distortion baseline.mjs's fairness contract 3 exists to prevent.

/**
 * One variant's series state. A factory, not a bare object literal, so a caller
 * cannot accidentally hand two variants the SAME object and share a cooldown.
 */
export function createVariantState() {
  return { lastSignalBar: null };
}

/**
 * Runs one bar of one variant and returns its fired flags.
 *
 * `state` is a PARAMETER, never module scope — that is what makes the cooldown
 * per-variant, and it is what smoke.mjs drives with two independent states to
 * prove a busy variant cannot suppress a quiet one.
 *
 * `lastSignalBar` is read BEFORE it is written, so a signal that fires on this
 * bar is emitted on this bar — the same snapshot Pine takes.
 */
export function stepVariant(state, barIndex, rawLong, rawShort, marketStructure) {
  const longSignal = rawLong && !(rawShort && marketStructure !== 1);
  const shortSignal = rawShort && !(rawLong && marketStructure !== -1);
  const ambiguousTie = rawLong && rawShort && marketStructure === 0;
  const inCooldown =
    state.lastSignalBar !== null && barIndex - state.lastSignalBar < SHIPPED_COOLDOWN_BARS;
  const longSignalFired = longSignal && !inCooldown;
  const shortSignalFired = shortSignal && !inCooldown;
  if (longSignalFired || shortSignalFired) state.lastSignalBar = barIndex;
  return { longSignal, shortSignal, longSignalFired, shortSignalFired, ambiguousTie, inCooldown };
}

// ─── HTF aggregation + wiring (mirrors baseline.mjs) ────────────────────────

function createHtfSeries(tfMs, nativeStepMs) {
  let bucket = null;
  let acc = null;
  return {
    feed(c) {
      const b = Math.floor(c.t / tfMs) * tfMs;
      if (b !== bucket) {
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
    series: available ? createHtfSeries(tfMs, tf.stepMs) : null,
    atr: createAtr({ length: 14 }),
    atrValue: null,
    liqPivot: createPivotDetector({ pivotLenHigh: 10, pivotLenLow: 10 }),
    liq: { high: null, low: null },
  };
}

/**
 * ONE pass, the concept matrix AND the real Signal Engine, on one bar object.
 *
 * The engine is evaluated on every bar purely so the fidelity assertion below
 * has something to compare against — it is not one of the concepts. Every
 * concept reads the SAME state object, which makes it structurally impossible
 * for two concepts to see different price, different session flags or different
 * HTF pivots: any difference in their results is attributable to the CONCEPT and
 * nothing else.
 *
 * Collected per bar:
 *   - every flag the predicate reads
 *   - the shipped score per side (from the real engine, never re-derived)
 *   - the per-variant fired flags, with per-variant cooldown state
 *   - the real engine's raw/fired flags and score, for the fidelity assertion
 *   - the near/in arm split, and the session flavour bucket
 */
function collect(candles, tf) {
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
  const zones = createLiquidityZones();
  const structure = createStructureBreak();
  const imbalance = createImbalanceDetector();
  const engine = createSignalEngine();

  const list = concepts();
  const states = list.map(() => createVariantState());
  const tally = list.map(() => ({
    predicateBars: { long: 0, short: 0 },
    rawAfterGate: { long: 0, short: 0 },
    fired: { long: 0, short: 0 },
    exclusivitySuppressed: { long: 0, short: 0 },
    cooldownSuppressed: { long: 0, short: 0 },
    ambiguousTies: 0,
    predicateScores: { long: [], short: [] },
    firedScores: { long: [], short: [] },
    signals: { long: [], short: [] },
  }));

  let structPivots = { high: null, low: null };
  let structPivotObserved = false;

  // Per-arm census and session flavour, over TWO populations:
  //   primary — the bars the maintainer's concept as written admits. Vacuous on a
  //            grid where that concept admits nothing, and that vacuity is itself
  //            the finding, so it is reported rather than replaced.
  //   widest  — the WIDEST measurable population in this matrix (OR, any session,
  //            no score gate), so the reader still gets the flavour and arm split
  //            on a grid where the primary is empty. Always labelled, never
  //            presented as the concept's own breakdown.
  const emptyCensus = () => ({ overlap: 0, londonOnly: 0, nyOnly: 0, asiaOnly: 0, none: 0 });
  const flavour = { primary: emptyCensus(), widest: emptyCensus() };
  const arm = {
    primary: { nearLong: 0, nearShort: 0, inLong: 0, inShort: 0, bothLong: 0, bothShort: 0 },
    widest: { nearLong: 0, nearShort: 0, inLong: 0, inShort: 0, bothLong: 0, bothShort: 0 },
  };
  // Dataset-wide, UNCONDITIONED: how often do the two arms fire on the same bar
  // at all? This is the measurement that decides whether "mutually exclusive by
  // construction" is true at BAR level or only at GAP level. No predicate filter.
  const armAll = { nearLong: 0, nearShort: 0, inLong: 0, inShort: 0, bothLong: 0, bothShort: 0 };

  // The disagreement census, measured rather than argued.
  const disagree = {
    liquidityAndStructure: { long: 0, short: 0 },
    liquidityOnly: { long: 0, short: 0 },
    structureOnly: { long: 0, short: 0 },
    imbalanceAndStructure: { long: 0, short: 0 },
    conjunctionBars: { long: 0, short: 0 },
  };

  const fidelity = {
    checks: 0,
    scoreMismatches: 0,
    rawMismatches: 0,
    firedMismatches: 0,
    firstFailure: null,
  };

  const fail = (i, kind, expected, got) => {
    if (fidelity.firstFailure === null) {
      fidelity.firstFailure = { barIndex: i, kind, expected, got };
    }
  };

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
      if (sp.pivotHigh !== null || sp.pivotLow !== null) structPivotObserved = true;
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

    const w = engine.evaluate(engineBar);

    const state = {
      barIndex: i,
      sessionStrength: sm.sessionStrength,
      inOverlap: sm.inOverlap,
      inLondon: sm.inLondon,
      inNY: sm.inNY,
      inAsia: sm.inAsia,
      nearLiquidityLong: Boolean(lz.nearLiquidityLong),
      nearLiquidityShort: Boolean(lz.nearLiquidityShort),
      nearD1LiquidityLong: Boolean(lz.nearD1LiquidityLong),
      nearH4LiquidityLong: Boolean(lz.nearH4LiquidityLong),
      nearH1LiquidityLong: Boolean(lz.nearH1LiquidityLong),
      nearD1LiquidityShort: Boolean(lz.nearD1LiquidityShort),
      nearH4LiquidityShort: Boolean(lz.nearH4LiquidityShort),
      nearH1LiquidityShort: Boolean(lz.nearH1LiquidityShort),
      breakUp: Boolean(sb.breakUp),
      breakDown: Boolean(sb.breakDown),
      structureFlipped: Boolean(sb.structureFlipped),
      marketStructure: sb.marketStructure,
      nearImbalanceLong: Boolean(im.nearImbalanceLong),
      nearImbalanceShort: Boolean(im.nearImbalanceShort),
      inImbalanceLong: Boolean(im.inImbalanceLong),
      inImbalanceShort: Boolean(im.inImbalanceShort),
      longScore: w.longScore,
      shortScore: w.shortScore,
      close: c.c,
    };

    // ── Arm census + session flavour, over both populations ────────────────
    for (const side of ["long", "short"]) {
      const long = side === "long";
      const near = long ? state.nearImbalanceLong : state.nearImbalanceShort;
      const inside = long ? state.inImbalanceLong : state.inImbalanceShort;
      const bucket = (which) => {
        if (which === "primary" && !predicateHolds(state, side, CONCEPT_AS_WRITTEN)) return;
        if (which === "widest" && !predicateHolds(state, side, WIDEST_MEASURABLE)) return;
        if (near) arm[which][long ? "nearLong" : "nearShort"] += 1;
        if (inside) arm[which][long ? "inLong" : "inShort"] += 1;
        if (near && inside) arm[which][long ? "bothLong" : "bothShort"] += 1;
        if (long) {
          if (sm.inOverlap) flavour[which].overlap += 1;
          else if (sm.inLondon && !sm.inNY) flavour[which].londonOnly += 1;
          else if (sm.inNY && !sm.inLondon) flavour[which].nyOnly += 1;
          else if (sm.inAsia && !sm.inLondon && !sm.inNY) flavour[which].asiaOnly += 1;
          else flavour[which].none += 1;
        }
      };
      bucket("primary");
      bucket("widest");

      // Dataset-wide, unconditional arm census.
      if (near) armAll[long ? "nearLong" : "nearShort"] += 1;
      if (inside) armAll[long ? "inLong" : "inShort"] += 1;
      if (near && inside) armAll[long ? "bothLong" : "bothShort"] += 1;
    }

    // ── Why the conjunction is the shape it is (measured, not argued) ──────
    for (const side of ["long", "short"]) {
      const long = side === "long";
      const liq = long ? state.nearLiquidityLong : state.nearLiquidityShort;
      const st = long ? state.breakUp : state.breakDown;
      const imb = long
        ? state.nearImbalanceLong || state.inImbalanceLong
        : state.nearImbalanceShort || state.inImbalanceShort;
      if (liq && st) disagree.liquidityAndStructure[side] += 1;
      else if (liq) disagree.liquidityOnly[side] += 1;
      else if (st) disagree.structureOnly[side] += 1;
      if (liq && st) disagree.conjunctionBars[side] += 1;
      if (imb && st) disagree.imbalanceAndStructure[side] += 1;
    }

    // ── Every concept, this bar ────────────────────────────────────────────
    // (`concept`, not `c`: `c` is the candle above, and a shadowed `c` here would
    // silently put `undefined` into every signal price — which the labeller
    // rejects loudly, at least.)
    for (let v = 0; v < list.length; v++) {
      const concept = list[v];
      const rawLong = predicateHolds(state, "long", concept);
      const rawShort = predicateHolds(state, "short", concept);
      const t = tally[v];
      if (rawLong) {
        t.predicateBars.long += 1;
        t.predicateScores.long.push(state.longScore);
      }
      if (rawShort) {
        t.predicateBars.short += 1;
        t.predicateScores.short.push(state.shortScore);
      }
      const st = stepVariant(states[v], i, rawLong, rawShort, state.marketStructure);
      if (rawLong && !st.longSignal) t.exclusivitySuppressed.long += 1;
      if (rawShort && !st.shortSignal) t.exclusivitySuppressed.short += 1;
      if (st.longSignal && st.inCooldown) t.cooldownSuppressed.long += 1;
      if (st.shortSignal && st.inCooldown) t.cooldownSuppressed.short += 1;
      if (st.ambiguousTie) t.ambiguousTies += 1;
      if (st.longSignal) t.rawAfterGate.long += 1;
      if (st.shortSignal) t.rawAfterGate.short += 1;
      if (st.longSignalFired) {
        t.fired.long += 1;
        t.firedScores.long.push(state.longScore);
        t.signals.long.push({ barIndex: i, side: "long", price: state.close });
      }
      if (st.shortSignalFired) {
        t.fired.short += 1;
        t.firedScores.short.push(state.shortScore);
        t.signals.short.push({ barIndex: i, side: "short", price: state.close });
      }

      // ── FIDELITY: the shipped concept must reproduce the real engine ──────
      if (conceptKey(concept) === conceptKey(SHIPPED_CONCEPT)) {
        fidelity.checks += 3;
        if (w.longScore !== state.longScore || w.shortScore !== state.shortScore) {
          fidelity.scoreMismatches += 1;
          fail(i, "score", [w.longScore, w.shortScore], [state.longScore, state.shortScore]);
        }
        if (w.longSignalRaw !== rawLong) {
          fidelity.rawMismatches += 1;
          fail(i, `raw long (engine ${w.longSignalRaw})`, w.longSignalRaw, rawLong);
        }
        if (w.shortSignalRaw !== rawShort) {
          fidelity.rawMismatches += 1;
          fail(i, `raw short (engine ${w.shortSignalRaw})`, w.shortSignalRaw, rawShort);
        }
        if (w.longSignalFired !== st.longSignalFired) {
          fidelity.firedMismatches += 1;
          fail(i, `fired long (engine ${w.longSignalFired})`, w.longSignalFired, st.longSignalFired);
        }
        if (w.shortSignalFired !== st.shortSignalFired) {
          fidelity.firedMismatches += 1;
          fail(i, `fired short (engine ${w.shortSignalFired})`, w.shortSignalFired, st.shortSignalFired);
        }
      }
    }
  }

  return {
    labelCandles,
    list,
    tally,
    arm,
    armAll,
    flavour,
    disagree,
    fidelity,
    structureObservable: structPivotObserved,
    h1Available: ctx.h1.available,
    h4Available: ctx.h4.available,
    d1Available: ctx.d1.available,
    bars: n,
  };
}

// ─── D.4 outcome summaries ──────────────────────────────────────────────────

/**
 * Counts over a signal list: win / loss / timeout / insufficient_data.
 *
 * `timeout` and `insufficient_data` are NEVER folded into win or loss, and both
 * are carried alongside every rate so a reader can see how much of the
 * population resolved at all.
 */
function outcomeCounts(labelCandles, signals, maxHorizonBars = INDEPENDENT_WINDOW_BARS) {
  const batch = labelSignalsExitRule(labelCandles, signals, { maxHorizonBars });
  const counts = { win: 0, loss: 0, timeout: 0, insufficient_data: 0 };
  let doubleTouchCount = 0;
  for (const r of batch.results) {
    counts[r.label] += 1;
    if (r.doubleTouch) doubleTouchCount += 1;
  }
  const resolved = counts.win + counts.loss;
  return {
    signals: batch.total,
    counts,
    resolved,
    doubleTouchCount,
    hitRatePercent: resolved > 0 ? round((counts.win / resolved) * 100, 2) : null,
  };
}

/**
 * THE REFUSAL GATE, isolated from any data so it can be smoke-checked.
 *
 * Mirrors backtest/band.mjs's `gateIndependent` in shape and in intent: the
 * draw is a CALLBACK, so the gate provably runs before any draw exists. Below
 * the floor it returns the resolved count and NOTHING else — no hit rate "for
 * reference", no widened interval, no normal approximation.
 */
export function gateIndependent(independent, drawInterval, minObservations) {
  const resolved = independent.resolved ?? 0;
  const eligible = resolved >= minObservations;
  const result = {
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
  if (eligible) result.interval = drawInterval();
  return result;
}

/**
 * The numeric outcome codes `bootstrapHitRateDraws` expects.
 *
 * ratio.mjs keeps WIN/LOSS/EXCLUDED module-private and exports no encoder, so
 * passing label STRINGS would produce undefinedDraws === every draw and a null
 * interval — a quiet wrong answer, not a crash. Same mapping band.mjs documents.
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
 * The dependent (overlapping-window) and independent (non-overlapping) hit
 * rates for one side of one concept.
 *
 * `dependent` is descriptive only: two signals six bars apart each look 288 bars
 * forward and share 282 of them, so those are not independent trials.
 * `independent` takes the EARLIEST entry bar per non-overlapping window per side
 * and REFUSES below 30 resolved observations.
 */
function hitRateScope(labelCandles, signals, options) {
  const { seed, bootstrap, windowBars = INDEPENDENT_WINDOW_BARS } = options;
  const dependent = outcomeCounts(labelCandles, signals, windowBars);
  const sel = selectIndependent(signals, windowBars);
  const independent = outcomeCounts(labelCandles, sel.selected, windowBars);
  return {
    dependent: {
      population: "fired signals, overlapping forward windows",
      ...dependent,
    },
    independent: {
      windowBars,
      windowsUsed: sel.windowsUsed,
      considered: sel.considered,
      discarded: sel.discarded,
      ...independent,
      minObservations: MIN_OBSERVATIONS_FOR_INTERVAL,
      minObservationsForInterval: MIN_OBSERVATIONS_FOR_INTERVAL,
      eligible: sel.windowsUsed > 0 && independent.resolved >= MIN_OBSERVATIONS_FOR_INTERVAL,
      ...gateIndependent(independent, () => {
        const codes = outcomeCodes(labelCandles, sel.selected, windowBars);
        const draws = bootstrapHitRateDraws(codes, bootstrap, seed);
        const interval = hitRateInterval(draws.rates);
        if (draws.undefinedDraws === bootstrap) {
          throw new Error(
            `concept: every bootstrap draw was undefined (${draws.undefinedDraws}/${bootstrap}) — ` +
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
    // The kept signals, so a COMBINED scope can pool the two sides' independent
    // samples instead of re-deriving them. Exposed for that reason only.
    independentSelected: sel.selected,
  };
}

/**
 * The combined (both sides) scope, pooled from the two sides' INDEPENDENT
 * samples — never from their dependent populations, and never by averaging two
 * per-side rates (which would weight a 3-observation side like a 300-observation
 * one). The floor is applied to the POOLED resolved count, so a side below the
 * floor cannot be laundered into an interval by the other side's volume.
 */
function combinedScope(labelCandles, longScope, shortScope, options) {
  const { seed, bootstrap, windowBars = INDEPENDENT_WINDOW_BARS } = options;
  const pooled = [...longScope.independentSelected, ...shortScope.independentSelected].sort(
    (a, b) => a.barIndex - b.barIndex || (a.side < b.side ? -1 : 1),
  );
  const dependent = combined(longScope.dependent, shortScope.dependent);
  const independent = outcomeCounts(labelCandles, pooled, windowBars);
  return {
    dependent,
    independent: {
      windowBars,
      windowsUsed: longScope.independent.windowsUsed + shortScope.independent.windowsUsed,
      considered: longScope.independent.considered + shortScope.independent.considered,
      discarded: longScope.independent.discarded + shortScope.independent.discarded,
      ...independent,
      minObservations: MIN_OBSERVATIONS_FOR_INTERVAL,
      minObservationsForInterval: MIN_OBSERVATIONS_FOR_INTERVAL,
      poolOf:
        "the two sides' INDEPENDENT samples pooled, not their dependent populations and not " +
        "an average of two per-side rates",
      ...gateIndependent(independent, () => {
        const codes = outcomeCodes(labelCandles, pooled, windowBars);
        const draws = bootstrapHitRateDraws(codes, bootstrap, seed);
        const interval = hitRateInterval(draws.rates);
        if (draws.undefinedDraws === bootstrap) {
          throw new Error(
            `concept: every combined bootstrap draw was undefined ` +
              `(${draws.undefinedDraws}/${bootstrap}) — refusing rather than printing a null ` +
              "interval that reads as a small sample.",
          );
        }
        return {
          method: "percentile bootstrap over the pooled independent sample",
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
}

const combined = (a, b) => ({
  signals: a.signals + b.signals,
  counts: {
    win: a.counts.win + b.counts.win,
    loss: a.counts.loss + b.counts.loss,
    timeout: a.counts.timeout + b.counts.timeout,
    insufficient_data: a.counts.insufficient_data + b.counts.insufficient_data,
  },
  resolved: a.resolved + b.resolved,
  doubleTouchCount: a.doubleTouchCount + b.doubleTouchCount,
  hitRatePercent:
    a.resolved + b.resolved > 0
      ? round(((a.counts.win + b.counts.win) / (a.resolved + b.resolved)) * 100, 2)
      : null,
});

// ─── The report ──────────────────────────────────────────────────────────────

function summarise(list, tally, labelCandles, tf, options, notMeasurable) {
  return list.map((c, v) => {
    const t = tally[v];
    const long = hitRateScope(labelCandles, t.signals.long, options);
    const short = hitRateScope(labelCandles, t.signals.short, options);
    const both = combinedScope(labelCandles, long, short, options);
    return {
      key: conceptKey(c),
      label:
        conceptKey(c) === conceptKey(SHIPPED_CONCEPT)
          ? "SHIPPED — " + conceptLabel(c)
          : "CONCEPT AS WRITTEN — " + conceptLabel(c),
      predicate: conceptLabel(c),
      kind:
        conceptKey(c) === conceptKey(SHIPPED_CONCEPT)
          ? "shipped — reproduces the Signal Engine's own expression"
          : conceptKey(c) === conceptKey(BINARY_CONCEPT)
            ? "shipped — the shipped OR with NO score gate, which IS spec D.1's binary model"
            : conceptKey(c) === conceptKey(CONCEPT_AS_WRITTEN)
              ? "the maintainer's concept as written — a RECONSTRUCTION, not a shipped behaviour"
              : "COUNTERFACTUAL — describes a rule that does not exist in src/",
      ...c,
      notMeasurable: notMeasurable(c) ?? null,
      bars: {
        long: t.predicateBars.long,
        short: t.predicateBars.short,
        total: t.predicateBars.long + t.predicateBars.short,
      },
      afterExclusivity: {
        long: t.rawAfterGate.long,
        short: t.rawAfterGate.short,
        total: t.rawAfterGate.long + t.rawAfterGate.short,
      },
      fired: {
        long: t.fired.long,
        short: t.fired.short,
        total: t.fired.long + t.fired.short,
      },
      exclusivitySuppressed: {
        long: t.exclusivitySuppressed.long,
        short: t.exclusivitySuppressed.short,
      },
      cooldownSuppressed: {
        long: t.cooldownSuppressed.long,
        short: t.cooldownSuppressed.short,
      },
      ambiguousTies: t.ambiguousTies,
      scoreDistribution: {
        predicateBars: {
          long: statsOf(t.predicateScores.long),
          short: statsOf(t.predicateScores.short),
        },
        firedBars: {
          long: statsOf(t.firedScores.long),
          short: statsOf(t.firedScores.short),
        },
      },
      d4: { long, short, combined: both },
    };
  });
}

function notMeasurableFor(structureObservable, structureArmRequired) {
  return (c) => {
    if (structureArmRequired(c) && !structureObservable) {
      return (
        "NOT MEASURABLE: the structure arm is never evaluated on this grid. Structure Break " +
        "reads 1H pivots, and this dataset has no 1H candles to aggregate, so breakUp/breakDown " +
        "are false on every bar by DATA AVAILABILITY, not by the market. A zero here is not a " +
        "finding about the concept."
      );
    }
    return null;
  };
}

/** Does this concept REQUIRE the structure arm to be satisfiable? */
function requiresStructure(c) {
  return c.conjunction === "AND" || c.structureArm === "flip";
}

function printReport(r) {
  const ag0 = r.orVsAnd.combined;
  out("the maintainer's stated trading concept, counted — liquidity + hours + (imbalance AND structure change)");
  out(
    `dataset  ${r.dataset.path} — ${int(r.dataset.bars)} bars, ${r.dataset.firstIso} .. ` +
      `${r.dataset.lastIso}, ${r.dataset.spanDays} days`,
  );
  out(
    `grid     NATIVE ${r.timeframe.id} — atrChart is ATR(14) of ${r.timeframe.id} bars, ` +
      `${int(r.timeframe.barsPerDailyBar)} bars per D1 bar. ${r.timeframe.note}`,
  );
  if (r.timeframe.unavailableHtf.length > 0) {
    out(
      `grid     UNAVAILABLE ON ${r.timeframe.id}: ${r.timeframe.unavailableHtf.join(", ")} — finer ` +
        "than the native grid. Pine's request.security would still fetch it from the exchange on a " +
        "coarser chart; this harness cannot.",
    );
  }
  if (!r.structure.observable) {
    out(
      `grid     STRUCTURE ARM NOT MEASURABLE on ${r.timeframe.id} — breakUp/breakDown never fire ` +
        "because Structure Break's 1H pivot series was never fed. Every row that REQUIRES a " +
        "structure break is reported as not measurable, never as zero.",
    );
  }
  out(
    `hold     ${r.config.exitHorizonBars} bars = ${r.timeframe.holdHuman} — a 24-hour hold on 5m, ` +
      "a 12-day hold on 1h. Hit rates are NOT comparable across grids.",
  );
  out("");

  // ── HEADLINE ──────────────────────────────────────────────────────────────
  out("HEADLINE");
  out("");
  out(
    `  ${padL("grid", 6)}${padL("concept as written", 26)}${padL("shipped indicator", 26)}${padL("gap", 14)}status`,
  );
  for (const h of r.headline) {
    out(
      `  ${padL(h.timeframe, 6)}${padL(h.conceptAsWritten, 26)}${padL(h.shipped, 26)}` +
        `${padL(h.gap, 14)}${h.status}`,
    );
  }
  out("");
  out(`  ${r.headlineSentence}`);
  out("");

  // ── 1. WHAT THIS IS ───────────────────────────────────────────────────────
  out("1. WHAT THIS FILE IS — AND WHAT IT IS NOT");
  out("");
  out(`  ${r.notice}`);
  out("");

  // ── 2. THE PREDICATE ──────────────────────────────────────────────────────
  out("2. THE PREDICATE, in the maintainer's own decomposition");
  out("");
  out(`  ${r.predicateText}`);
  out("");

  // ── 3. FAITHFULNESS ───────────────────────────────────────────────────────
  out("3. FAITHFULNESS — the one row that reproduces a shipped behaviour");
  out("");
  out(`  ${r.fidelity.claim}`);
  out(
    `  ${int(r.fidelity.checks)} per-bar assertions on ${int(r.fidelity.bars)} bars: ` +
      `${int(r.fidelity.scoreMismatches)} score mismatches, ${int(r.fidelity.rawMismatches)} raw ` +
      `mismatches, ${int(r.fidelity.firedMismatches)} fired mismatches.`,
  );
  out(
    "  the score is a function of all four upstream modules' flags, so an equal score on EVERY bar " +
      "proves the mirrored wiring fed identical inputs — this is stronger than matching a count.",
  );
  out(
    `  reproduction of the shipped row: ${int(r.fidelity.shippedFired)} fired entries, ` +
      `${r.fidelity.shippedD4} under D.4 — which is by construction what \`baseline\` reports ` +
      `for its weighted model on this grid (${r.fidelity.baselineFired} and ${r.fidelity.baselineD4}).`,
  );
  out(
    `  second anchor: ${r.fidelity.secondAnchor.row} is spec D.1's binary model — ` +
      `${int(r.fidelity.secondAnchor.conceptFired)} fired, ${r.fidelity.secondAnchor.conceptD4} ` +
      `against \`baseline\`'s ${int(r.fidelity.secondAnchor.baselineFired)} and ` +
      `${r.fidelity.secondAnchor.baselineD4}. Two independent shipped anchors agree.`,
  );
  out("");

  // ── 4. HEADLINE ROWS IN FULL ──────────────────────────────────────────────
  out("4. THE TWO ROWS THAT DECIDE IT — full detail");
  out("");
  for (const row of r.headlineRows) {
    out(`  ${row.label}`);
    out(`    ${row.kind}`);
    if (row.notMeasurable) {
      out(`    ${row.notMeasurable}`);
      out("");
      continue;
    }
    out(
      `    ${padL("stage", 26)}${padR("long", 8)}${padR("short", 8)}${padR("combined", 10)}`,
    );
    const st = (name, a, b, tt) =>
      out(`    ${padL(name, 26)}${padR(int(a), 8)}${padR(int(b), 8)}${padR(int(tt), 10)}`);
    st("bars satisfying predicate", row.bars.long, row.bars.short, row.bars.total);
    st("after exclusivity", row.afterExclusivity.long, row.afterExclusivity.short, row.afterExclusivity.total);
    st("fired (after 10-bar cooldown)", row.fired.long, row.fired.short, row.fired.total);
    out(
      `    ${padL("suppressed: exclusivity", 26)}${padR(int(row.exclusivitySuppressed.long), 8)}` +
        `${padR(int(row.exclusivitySuppressed.short), 8)}${padR("", 10)}`,
    );
    out(
      `    ${padL("suppressed: cooldown", 26)}${padR(int(row.cooldownSuppressed.long), 8)}` +
        `${padR(int(row.cooldownSuppressed.short), 8)}${padR("", 10)}`,
    );
    out(
      `    score of the predicate bars — long  min ${row.scoreDistribution.predicateBars.long.min ?? "n/a"} ` +
        `median ${row.scoreDistribution.predicateBars.long.median ?? "n/a"} ` +
        `mean ${row.scoreDistribution.predicateBars.long.mean ?? "n/a"} ` +
        `max ${row.scoreDistribution.predicateBars.long.max ?? "n/a"} | ` +
        `short min ${row.scoreDistribution.predicateBars.short.min ?? "n/a"} ` +
        `median ${row.scoreDistribution.predicateBars.short.median ?? "n/a"} ` +
        `mean ${row.scoreDistribution.predicateBars.short.mean ?? "n/a"} ` +
        `max ${row.scoreDistribution.predicateBars.short.max ?? "n/a"}`,
    );
    out(`    D.4 dependent  long ${fmtScope(row.d4.long)}`);
    out(`                  short ${fmtScope(row.d4.short)}`);
    out(`                  combined ${fmtScope(row.d4.combined)}`);
    out(`    D.4 independent (${row.d4.long.independent.windowBars}-bar windows, <=1 per side per window)`);
    out(`                  long      ${fmtIndep(row.d4.long)}`);
    out(`                  short     ${fmtIndep(row.d4.short)}`);
    out(`                  combined  ${fmtIndep(row.d4.combined)}`);
    out("");
  }

  // ── 5. WHY ────────────────────────────────────────────────────────────────
  out(`5. WHERE THE ${r.timeframe.id.toUpperCase()} CONJUNCTION ${r.timeframe.id === "5m" ? "GOES" : "STANDS"} — measured, not argued`);
  out("");
  out(
    `  ${padL("on the same bar", 34)}${padR("long", 10)}${padR("short", 10)}   reading`,
  );
  const dm = (label, key, note) =>
    out(
      `  ${padL(label, 34)}${padR(int(r.disagree[key].long), 10)}` +
        `${padR(int(r.disagree[key].short), 10)}   ${note}`,
    );
  dm("liquidity AND structure break", "liquidityAndStructure", "the maintainer's first AND");
  dm("liquidity only (no break)", "liquidityOnly", "the zone was near, nothing broke");
  dm("structure break only (no zone)", "structureOnly", "a break with no liquidity nearby");
  dm("imbalance AND structure break", "imbalanceAndStructure", "the second AND, also required");
  out("");
  out(`  ${r.disagree.verdict}`);
  out("");

  // ── 6. SESSION FLAVOUR ────────────────────────────────────────────────────
  out("6. SESSION FLAVOUR — of the bars the setup admits, per session population");
  out("");
  out(
    `  ${padL("flavour", 26)}${padR("concept as written", 22)}  ${padR("widest measurable", 18)}  meaning`,
  );
  for (const f of r.sessionFlavour) {
    out(
      `  ${padL(f.name, 26)}${padR(int(f.primaryBars), 22)}  ${padR(int(f.widestBars), 18)}  ${f.meaning}`,
    );
  }
  out("");
  out(
    `  session gate: "any session" (strength >= 1) admits ${int(r.sessionGate.any)} bars; the ` +
      `shipped gate (strength >= 2, London or NY) admits ${int(r.sessionGate.shipped)}. The ` +
      "difference between the two columns is exactly the Asia-only row and nothing else, " +
      "because strength is +1 Asia, +2 London, +2 NY, +3 overlap — a ladder with one rung below " +
      "the gate.",
  );
  out("");

  // ── 7. THE IMBALANCE ARMS ─────────────────────────────────────────────────
  out("7. WHICH IMBALANCE ARM CARRIES THE SETUPS");
  out("");
  out(
    `  ${padL("arm", 30)}${padR("concept L", 12)}${padR("concept S", 12)}` +
      `${padR("widest L", 11)}${padR("widest S", 11)}  note`,
  );
  const armRow = (label, key, note) =>
    out(
      `  ${padL(label, 30)}${padR(int(r.armCensus.primary[key + "Long"]), 12)}` +
        `${padR(int(r.armCensus.primary[key + "Short"]), 12)}` +
        `${padR(int(r.armCensus.widest[key + "Long"]), 11)}` +
        `${padR(int(r.armCensus.widest[key + "Short"]), 11)}  ${note}`,
    );
  armRow("near* (untouched gap)", "near", "an entry approach");
  armRow("in* (touched gap)", "in", "a fill — price is inside the gap");
  armRow("BOTH arms on one bar", "both", "two DIFFERENT gaps, not one gap twice");
  out("");
  out(`  ${r.armVerdict}`);
  out("");

  // ── 8. THRESHOLD CURVE ────────────────────────────────────────────────────
  out("8. THE SCORE GATE — the decision in front of the maintainer");
  out("");
  out(
    `  held at the concept as written (${r.thresholdCurve.predicate}), FIRED entries and the D.4 ` +
      "dependent hit rate:",
  );
  out("");
  out(
    `  ${padL("gate", 14)}${padR("fired L", 9)}${padR("fired S", 9)}${padR("fired all", 11)}` +
      `${padR("D.4 W/L", 12)}${padR("hit rate", 12)}  independent`,
  );
  for (const row of r.thresholdCurve.rows) {
    out(
      `  ${padL(row.gateLabel, 14)}${padR(int(row.fired.long), 9)}${padR(int(row.fired.short), 9)}` +
        `${padR(int(row.fired.total), 11)}${padR(row.d4Label, 12)}${padR(row.hitRate, 12)}  ` +
        `${row.independent}`,
    );
  }
  out("");
  out(`  ${r.thresholdCurve.note}`);
  out("");

  // ── 9. OR vs AND ──────────────────────────────────────────────────────────
  out("9. THE ACTUAL DISAGREEMENT — imbalance AND structure, beside imbalance OR structure");
  out("");
  out(`  ${padL("side", 12)}${padR("AND bars", 11)}${padR("OR bars", 10)}${padR("AND fired", 12)}${padR("OR fired", 11)}`);
  for (const side of ["long", "short", "combined"]) {
    const a = side === "combined" ? ag0.andNoGate : r.orVsAnd[side].andNoGate;
    const o = side === "combined" ? ag0.orNoGate : r.orVsAnd[side].orNoGate;
    out(
      `  ${padL(side, 12)}${padR(int(a.bars), 11)}${padR(int(o.bars), 10)}` +
        `${padR(int(a.fired), 12)}${padR(int(o.fired), 11)}`,
    );
  }
  out("");
  out("  with the SHIPPED score gate of 70 restored:");
  out(
    `  ${padL("side", 12)}${padR("AND fired", 12)}${padR("OR fired", 11)}${padR("D.4 hit AND", 16)}` +
      `  ${padL("D.4 hit OR", 24)}`,
  );
  for (const side of ["long", "short", "combined"]) {
    const row = r.orVsAnd.gated[side];
    out(
      `  ${padL(side, 12)}${padR(int(row.andFired), 12)}${padR(int(row.orFired), 11)}` +
        `${padR(row.andHit, 16)}  ${padL(row.orHit, 24)}`,
    );
  }
  out("");
  out(`  ${r.orVsAnd.note}`);
  out("");

  // ── 10. THE MATRIX ────────────────────────────────────────────────────────
  out("10. THE MATRIX — every concept x every score gate (fired entries; nm = not measurable)");
  out("");
  out(
    `  ${padL("session", 9)}${padL("struct", 8)}${padL("imb", 8)}${padL("AND/OR", 8)}` +
      `${padR("bars", 8)}${padR("none", 7)}${padR("60", 7)}${padR("65", 7)}${padR("70", 7)}` +
      `${padR("75", 7)}${padL("  hit rate @ no gate (D.4 dependent)", 40)}`,
  );
  for (const row of r.matrix) {
    const g = row.gateFired;
    out(
      `  ${padL(`>=${row.sessionMin}`, 9)}${padL(row.structureArm, 8)}${padL(row.imbalanceArm, 8)}` +
        `${padL(row.conjunction, 8)}${padR(int(row.bars), 8)}` +
        `${padR(row.gateFired.none ?? "nm", 7)}${padR(row.gateFired[60] ?? "nm", 7)}` +
        `${padR(row.gateFired[65] ?? "nm", 7)}${padR(row.gateFired[70] ?? "nm", 7)}` +
        `${padR(row.gateFired[75] ?? "nm", 7)}` +
        `${padL(`  ${row.hitAtNoGate} (${row.d4AtNoGate})`, 40)}`,
    );
  }
  out("");
  out("  every one of these rows is a COUNTERFACTUAL or a RECONSTRUCTION except the OR/>=2/either");
  out(`  row at gate ${r.config.minConfidence}, which reproduces the shipped indicator exactly.`);
  out("");

  // ── 11. CAVEATS ───────────────────────────────────────────────────────────
  out("11. READ BEFORE QUOTING ANY NUMBER ABOVE");
  out("");
  r.caveats.forEach((c, i) => out(`  [C${i}] ${c}`));
  out("");
  r.observations.forEach((o, i) => out(`  [O${i + 1}] ${o}`));
  out("");
}

function fmtScope(scope) {
  const d = scope.dependent;
  return (
    `${int(d.signals)} signals, ${int(d.counts.win)}W/${int(d.counts.loss)}L ` +
    `(${int(d.counts.timeout)} timeout, ${int(d.counts.insufficient_data)} insufficient), ` +
    `hit ${pct(d.hitRatePercent)}, double-touch ${int(d.doubleTouchCount)}`
  );
}

function fmtIndep(scope) {
  const d = scope.independent;
  if (!d.eligible) {
    return `REFUSED — ${d.independentObserved} resolved of ${int(d.considered)} considered ` +
      `(${int(d.discarded)} discarded), below the ${d.minObservations}-observation floor`;
  }
  return (
    `${int(d.independentObserved)} resolved (of ${int(d.considered)} considered, ` +
    `${int(d.discarded)} discarded), hit ${pct(d.hitRatePercent)}, ` +
    `95% CI [${round(d.interval.lo, 2)}%, ${round(d.interval.hi, 2)}%]`
  );
}

// ─── Entry point ────────────────────────────────────────────────────────────

/**
 * Runs the concept matrix on ONE timeframe.
 *
 * @param {{json?: boolean, tf?: object, seed?: number, bootstrap?: number}} options
 * @returns {Promise<number>} process exit code (0 ok, 1 failed).
 */
export async function runConcept(options = {}) {
  const json = Boolean(options.json);
  const tf = options.tf ?? DEFAULT_TF;
  const seed = options.seed ?? DEFAULT_SEED;
  const bootstrap = options.bootstrap ?? DEFAULT_BOOTSTRAP;
  const started = Date.now();

  try {
    const { candles, meta } = await loadDataset(tf);
    const data = collect(candles, tf);

    // ── THE FAITHFULNESS PROOF, before a single concept is summarised ────────
    const shippedIndex = data.list.findIndex(
      (c) => conceptKey(c) === conceptKey(SHIPPED_CONCEPT),
    );
    if (shippedIndex < 0) throw new Error("concept: the shipped concept is missing from the set");
    const shippedTally = data.tally[shippedIndex];
    const shippedScope = hitRateScope(
      data.labelCandles,
      [...shippedTally.signals.long, ...shippedTally.signals.short].sort((a, b) =>
        a.barIndex - b.barIndex || (a.side < b.side ? -1 : 1),
      ),
      { seed, bootstrap },
    );

    if (
      data.fidelity.scoreMismatches > 0 ||
      data.fidelity.rawMismatches > 0 ||
      data.fidelity.firedMismatches > 0
    ) {
      const f = data.fidelity.firstFailure;
      throw new Error(
        `concept: REFUSING on ${tf.id} — the shipped concept does not reproduce the Signal ` +
          `Engine's own output: ${data.fidelity.scoreMismatches} score, ` +
          `${data.fidelity.rawMismatches} raw and ${data.fidelity.firedMismatches} fired mismatches ` +
          `over ${int(data.fidelity.checks)} per-bar assertions. First failure at bar ` +
          `${f.barIndex} (${f.kind}): expected ${JSON.stringify(f.expected)}, got ` +
          `${JSON.stringify(f.got)}. Every other row is a delta against this one, so an ` +
          "unfaithful reference invalidates all of them.",
      );
    }

    const rows = summarise(
      data.list,
      data.tally,
      data.labelCandles,
      tf,
      { seed, bootstrap },
      notMeasurableFor(data.structureObservable, requiresStructure),
    );
    const byKey = new Map(rows.map((r) => [r.key, r]));

    // ── SECOND FIDELITY ANCHOR: the binary row against `baseline`'s binary ─
    const baselineResult = runComparison(candles, meta, tf);
    const binaryRow = byKey.get(conceptKey(BINARY_CONCEPT));
    const binaryBaseline = baselineResult.models.binary;
    const binaryFired =
      binaryRow.fired.long + binaryRow.fired.short;
    const binaryProblems = [];
    if (binaryFired !== binaryBaseline.signals.fired.total) {
      binaryProblems.push(
        `binary fired ${binaryFired}, baseline says ${binaryBaseline.signals.fired.total}`,
      );
    }
    if (
      binaryRow.d4.combined.dependent.counts.win !== binaryBaseline.definitionA.counts.win ||
      binaryRow.d4.combined.dependent.counts.loss !== binaryBaseline.definitionA.counts.loss ||
      binaryRow.d4.combined.dependent.counts.timeout !== binaryBaseline.definitionA.counts.timeout ||
      binaryRow.d4.combined.dependent.counts.insufficient_data !==
        binaryBaseline.definitionA.counts.insufficient_data
    ) {
      binaryProblems.push(
        `binary D.4 ${binaryRow.d4.combined.dependent.counts.win}W/` +
          `${binaryRow.d4.combined.dependent.counts.loss}L/` +
          `${binaryRow.d4.combined.dependent.counts.timeout}T/` +
          `${binaryRow.d4.combined.dependent.counts.insufficient_data}insuff, baseline says ` +
          `${binaryBaseline.definitionA.counts.win}W/${binaryBaseline.definitionA.counts.loss}L/` +
          `${binaryBaseline.definitionA.counts.timeout}T/` +
          `${binaryBaseline.definitionA.counts.insufficient_data}insuff`,
      );
    }
    if (binaryProblems.length > 0) {
      throw new Error(
        `concept: REFUSING on ${tf.id} — the binary row (the shipped OR with no score gate, ` +
          `which IS spec D.1) does not reproduce \`baseline\`'s binary model: ` +
          `${binaryProblems.join("; ")}. Two independent shipped anchors disagreeing with this ` +
          "harness means the matrix is not measuring the indicator it claims to measure.",
      );
    }

    const writtenRow = byKey.get(conceptKey(CONCEPT_AS_WRITTEN));
    const shippedRow = byKey.get(conceptKey(SHIPPED_CONCEPT));

    // ── The headline ────────────────────────────────────────────────────────
    const headline = [{
      timeframe: tf.id,
      conceptAsWritten: writtenRow.notMeasurable
        ? "not measurable"
        : `${int(writtenRow.fired.total)} entries`,
      shipped: `${int(shippedRow.fired.total)} entries`,
      gap: writtenRow.notMeasurable ? "n/a" : dint(writtenRow.fired.total - shippedRow.fired.total),
      status: writtenRow.notMeasurable
        ? "structure arm unavailable on this grid"
        : writtenRow.fired.total === 0
          ? "the concept as written produces NOTHING here"
          : writtenRow.fired.total > shippedRow.fired.total
            ? "the concept produces MORE than the shipped indicator"
            : "the concept produces FEWER than the shipped indicator",
    }];

    const headlineSentence = writtenRow.notMeasurable
      ? `On ${tf.id} the structure arm of the concept was never evaluated, so the concept as ` +
        "written cannot be measured here at all. The shipped indicator's own count is unaffected."
      : writtenRow.fired.total === 0
        ? `On ${tf.id} the concept as written produces ${int(writtenRow.fired.total)} entries ` +
          `against the shipped indicator's ${int(shippedRow.fired.total)} — a gap of ` +
          `${dint(writtenRow.fired.total - shippedRow.fired.total)}. The gap is not a threshold ` +
          "problem: it is a GEOMETRY problem, and section 5 shows where."
        : `On ${tf.id} the concept as written produces ${int(writtenRow.fired.total)} entries ` +
          `against the shipped indicator's ${int(shippedRow.fired.total)} — a gap of ` +
          `${dint(writtenRow.fired.total - shippedRow.fired.total)}. Read section 5 before ` +
          "reading this as either better or worse.";

    // ── The threshold curve, held at the concept as written ──────────────────
    const curveRows = [];
    for (const gate of SCORE_GATES) {
      const key = conceptKey({ ...CONCEPT_AS_WRITTEN, gate });
      const row = byKey.get(key);
      const label = gate === null ? "none" : String(gate);
      if (row.notMeasurable) {
        curveRows.push({
          gate: null,
          gateLabel: label,
          notMeasurable: row.notMeasurable,
          fired: { long: null, short: null, total: null },
          d4Label: "n/a",
          hitRate: "nm",
          independent: "not measurable",
        });
        continue;
      }
      const d = row.d4.combined.dependent;
      curveRows.push({
        gate,
        gateLabel: label,
        notMeasurable: null,
        fired: row.fired,
        d4Label: d.resolved > 0 ? `${int(d.counts.win)}/${int(d.counts.loss)}` : "n/a",
        hitRate: pct(d.hitRatePercent),
        independent: fmtIndep(row.d4.combined),
      });
    }

    // ── OR vs AND ───────────────────────────────────────────────────────────
    const gateKey = (conj, gate) =>
      conceptKey({ ...CONCEPT_AS_WRITTEN, conjunction: conj, gate });
    const orVsAnd = { long: null, short: null, combined: null, gated: {}, note: null };
    for (const side of ["long", "short"]) {
      orVsAnd[side] = {
        andNoGate: pick(byKey.get(gateKey("AND", null)), side),
        orNoGate: pick(byKey.get(gateKey("OR", null)), side),
      };
    }
    orVsAnd.combined = {
      andNoGate: {
        bars: orVsAnd.long.andNoGate.bars + orVsAnd.short.andNoGate.bars,
        fired: orVsAnd.long.andNoGate.fired + orVsAnd.short.andNoGate.fired,
      },
      orNoGate: {
        bars: orVsAnd.long.orNoGate.bars + orVsAnd.short.orNoGate.bars,
        fired: orVsAnd.long.orNoGate.fired + orVsAnd.short.orNoGate.fired,
      },
    };
    const orRowNoGate = byKey.get(gateKey("OR", null));
    const orD4NoGate = orRowNoGate.d4.combined.dependent;
    const andD4NoGate = byKey.get(gateKey("AND", null)).d4.combined.dependent;
    orVsAnd.note =
      "the shipped expression is the OR. The maintainer's concept is the AND. Every other term " +
      "is held at the concept as written, so the only thing that differs between these two " +
      "rows is the character AND versus OR — not a hidden second variable. `bars` is the " +
      "pre-cooldown population, `fired` is after the 10-bar cooldown. Read the OR row WITH its " +
      `hit rate: on this grid the OR fires ${int(orRowNoGate.fired.total)} entries at a ` +
      `${pct(orD4NoGate.hitRatePercent)} dependent hit rate ` +
      `(${int(orD4NoGate.counts.win)}W/${int(orD4NoGate.counts.loss)}L over ` +
      `${int(orD4NoGate.signals)} signals). The AND fires ` +
      `${int(byKey.get(gateKey("AND", null)).fired.total)} at ` +
      `${pct(andD4NoGate.hitRatePercent)}. ` +
      (byKey.get(gateKey("AND", null)).fired.total === 0
        ? "So on this grid the AND is EMPTY rather than stricter, and 'more selective' is not " +
          "available as an explanation for it — section 5 is where the emptiness comes from."
        : "So on this grid the AND is genuinely narrower rather than empty; section 5 shows " +
          "which of its two conjuncts binds first.");
    for (const side of ["long", "short", "combined"]) {
      const andGated = byKey.get(gateKey("AND", SHIPPED_SCORE_GATE));
      const orGated = byKey.get(gateKey("OR", SHIPPED_SCORE_GATE));
      const scopeOf = (row) => (side === "combined" ? row.d4.combined : row.d4[side]);
      const hit = (row) => {
        const s = scopeOf(row);
        return s.dependent.hitRatePercent === null ? "n/a" : pct(s.dependent.hitRatePercent);
      };
      const firedOf = (row) => (side === "combined" ? row.fired.total : row.fired[side]);
      orVsAnd.gated[side] = {
        andFired: firedOf(andGated),
        orFired: firedOf(orGated),
        andHit: hit(andGated),
        orHit: hit(orGated),
        andNotMeasurable: andGated.notMeasurable,
        orNotMeasurable: orGated.notMeasurable,
      };
    }

    // ── The matrix, one row per concept (score gate as columns) ─────────────
    const matrix = [];
    for (const c of data.list) {
      if (c.gate !== null) continue;
      const base = byKey.get(conceptKey(c));
      const gateFired = {};
      let nm = null;
      for (const g of SCORE_GATES) {
        const row = byKey.get(conceptKey({ ...c, gate: g }));
        if (row.notMeasurable) {
          nm = row.notMeasurable;
          gateFired[g === null ? "none" : g] = null;
        } else {
          gateFired[g === null ? "none" : g] = row.fired.total;
        }
      }
      const d = base.d4.combined.dependent;
      matrix.push({
        key: base.key,
        kind: base.kind,
        sessionMin: c.sessionMin,
        structureArm: c.structureArm,
        imbalanceArm: c.imbalanceArm,
        conjunction: c.conjunction,
        bars: base.bars.total,
        gateFired,
        hitAtNoGate: pct(d.hitRatePercent),
        d4AtNoGate:
          d.resolved > 0
            ? `${int(d.counts.win)}W/${int(d.counts.loss)}L`
            : `no resolved signal of ${int(d.signals)}`,
        notMeasurable: nm,
        rows: SCORE_GATES.map((g) => byKey.get(conceptKey({ ...c, gate: g }))),
      });
    }

    const result = {
      schemaVersion: SCHEMA_VERSION,
      ok: true,
      generatedBy: "backtest/concept.mjs (the maintainer's stated concept, counted)",
      notice:
        "EVERY ROW EXCEPT THE TWO LABELLED `shipped` IS A COUNTERFACTUAL OR A " +
        "RECONSTRUCTION — it describes a rule that does not exist in src/ and was wired " +
        "nowhere. The two shipped rows are the Signal Engine's own expression (OR, session>=2, " +
        "score>=70) and the same OR with the score gate removed, which is exactly spec D.1's " +
        "binary confluence model; both are asserted against `baseline` before anything else is " +
        "reported. Nothing under src/ or scripts/ is changed by this file, no Pine change is in " +
        "scope, and NO FORMULATION IS RECOMMENDED. Picking one is the maintainer's decision; " +
        "this file's job is to put every choice's consequence on the table at once.",
      predicateText:
        "liquidity(D1|H4|H1, same side) AND session(sessionStrength >= N) AND " +
        "imbalance(3-candle FVG on the entry timeframe, same side) AND " +
        "structureChange(breakUp for long, breakDown for short, same side) -> mark an entry; " +
        "direction follows the setup. The score gate is a SEPARATE, OPTIONAL final term " +
        "(absent by default), because the maintainer's wording describes a conjunction of " +
        "named factors and says nothing about a confidence score.",
      headline,
      headlineSentence,
      headlineRows: [writtenRow, shippedRow],
      fidelity: {
        claim:
          "the concept row transcribed from src/modules/signal-engine.pine:165-171 reproduces " +
          "the real Signal Engine's raw and fired flags AND its score on every bar of this grid",
        bars: data.fidelity.checks / 3,
        checks: data.fidelity.checks,
        scoreMismatches: data.fidelity.scoreMismatches,
        rawMismatches: data.fidelity.rawMismatches,
        firedMismatches: data.fidelity.firedMismatches,
        shippedFired: shippedTally.fired.long + shippedTally.fired.short,
        shippedD4:
          `${shippedScope.dependent.counts.win}W/${shippedScope.dependent.counts.loss}L`,
        baselineFired: shippedTally.fired.long + shippedTally.fired.short,
        baselineD4:
          `${shippedScope.dependent.counts.win}W/${shippedScope.dependent.counts.loss}L`,
        matches: true,
        secondAnchor: {
          row: conceptLabel(BINARY_CONCEPT),
          claim:
            "the shipped OR with NO score gate is spec D.1's binary confluence model, so this " +
            "row must reproduce `baseline`'s binary model independently of the engine-level " +
            "assertion above",
          conceptFired: binaryFired,
          baselineFired: binaryBaseline.signals.fired.total,
          conceptD4:
            `${binaryRow.d4.combined.dependent.counts.win}W/` +
            `${binaryRow.d4.combined.dependent.counts.loss}L/` +
            `${binaryRow.d4.combined.dependent.counts.timeout}T/` +
            `${binaryRow.d4.combined.dependent.counts.insufficient_data}insuff`,
          baselineD4:
            `${binaryBaseline.definitionA.counts.win}W/${binaryBaseline.definitionA.counts.loss}L/` +
            `${binaryBaseline.definitionA.counts.timeout}T/` +
            `${binaryBaseline.definitionA.counts.insufficient_data}insuff`,
          matches: true,
        },
        note:
          "`baseline`'s own weighted fired count and D.4 counts are reproduced BY CONSTRUCTION " +
          "here: the shipped row IS `weighted`'s raw signal, and the per-bar assertion above is " +
          "against the same createSignalEngine() instance baseline.mjs drives. The numbers are " +
          "cross-checked against `node backtest/run.mjs baseline` in the verification log.",
      },
      dataset: {
        path: tf.datasetRel,
        bars: data.bars,
        firstIso: iso(candles[0].t),
        lastIso: iso(candles[data.bars - 1].t),
        spanDays: round((candles[data.bars - 1].t - candles[0].t) / 86400000, 4),
        status: meta?.status ?? null,
      },
      timeframe: {
        id: tf.id,
        scopeWord: tf.scopeWord,
        nativeStepMs: tf.stepMs,
        minutesPerBar: tf.minutesPerBar,
        barsPerDailyBar: MS_1D / tf.stepMs,
        d1PivotWarmupNativeBars: nativeBarsForDays(21, tf.stepMs),
        unavailableHtf: htfAvailability(tf.stepMs).unavailable.map((t) => t.name),
        holdHuman: `${round((INDEPENDENT_WINDOW_BARS * tf.minutesPerBar) / 60, 2)} h`,
        note:
          `atrChart is ATR(14) of ${tf.id} bars, so the proximity band is 3 x a ${tf.id} ` +
          "ATR and the zone half-widths scale with the zone's own timeframe. This is a " +
          "DIFFERENT MEASUREMENT per grid, not more of the same one.",
      },
      config: {
        minConfidence: SHIPPED_SCORE_GATE,
        signalCooldownBars: SHIPPED_COOLDOWN_BARS,
        exitTargetPct: EXIT_TARGET_PCT,
        exitStopPct: EXIT_STOP_PCT,
        exitHorizonBars: EXIT_RULE_DEFAULTS.maxHorizonBars,
        minObservationsForInterval: MIN_OBSERVATIONS_FOR_INTERVAL,
        independentWindowBars: INDEPENDENT_WINDOW_BARS,
        seed,
        bootstrap,
        scoreGates: [...SCORE_GATES],
        sessionGates: [...SESSION_GATES],
        structureArms: [...STRUCTURE_ARMS],
        imbalanceArms: [...IMBALANCE_ARMS],
        conjunctions: [...CONJUNCTIONS],
        variants: data.list.length,
        eachVariantOwnsCooldownState: true,
      },
      structure: {
        observable: data.structureObservable,
        h1Available: data.h1Available,
        note: data.structureObservable
          ? "Structure Break's 1H pivot series was fed on this grid, so breakUp/breakDown are " +
            "real measurements here"
          : "Structure Break reads 1H pivots. This dataset has no 1H candles to aggregate, so " +
            "the series was never fed and every break is false by DATA AVAILABILITY. Concepts " +
            "that REQUIRE a break are reported as not measurable, never as zero.",
      },
      thresholdCurve: {
        predicate: conceptLabel(CONCEPT_AS_WRITTEN),
        rows: curveRows,
        note:
          "the curve is monotone by construction — a bar reaching a higher gate also reaches " +
          "every lower one — so a non-monotone column would be a bug in the predicate, and " +
          "smoke.mjs asserts monotonicity. Note that monotonicity in COUNTS says nothing " +
          "about monotonicity in hit rate: fewer signals is not a better signal until the hit " +
          "rate is read next to it.",
      },
      orVsAnd,
      matrix,
      disagree: {
        ...data.disagree,
        verdict:
          tf.id === "5m"
            ? "THE CONJUNCTION IS EMPTY BECAUSE LIQUIDITY AND STRUCTURE NEVER CO-OCCUR ON " +
              "THE SAME 5-MINUTE BAR. The proximity expression requires the bar's range to be " +
              "OUTSIDE the zone body (src/modules/liquidity-zones.pine:305), while a break means " +
              "close has crossed the 1H pivot the zone was built from — so at the moment of a " +
              "break the zone is inside the bar and `near*` is withheld by design. This is not " +
              "a threshold and not a rarity: it is the two rules cancelling, and no score gate " +
              "can bring it back."
            : data.structureObservable
              ? "Read the three rows together: a concept needing BOTH liquidity and a break is " +
                "bounded above by the smaller of the two, not by their sum."
              : "The structure rows are not measurable on this grid — see the STRUCTURE ARM note " +
                "in the header. Only the liquidity and imbalance rows carry findings.",
      },
      sessionFlavour: [
        { name: "overlap", primaryBars: data.flavour.primary.overlap, widestBars: data.flavour.widest.overlap, meaning: "London AND NY, strength 7" },
        { name: "London only", primaryBars: data.flavour.primary.londonOnly, widestBars: data.flavour.widest.londonOnly, meaning: "strength 2 — clears the shipped gate" },
        { name: "NY only", primaryBars: data.flavour.primary.nyOnly, widestBars: data.flavour.widest.nyOnly, meaning: "strength 2 — clears the shipped gate" },
        { name: "Asia only", primaryBars: data.flavour.primary.asiaOnly, widestBars: data.flavour.widest.asiaOnly, meaning: "strength 1 — the shipped gate EXCLUDES this" },
        { name: "no session", primaryBars: data.flavour.primary.none, widestBars: data.flavour.widest.none, meaning: "strength 0" },
      ],
      sessionGate: {
        any: rows.find(
          (x) =>
            x.sessionMin === CONCEPT_AS_WRITTEN.sessionMin &&
            x.structureArm === CONCEPT_AS_WRITTEN.structureArm &&
            x.imbalanceArm === CONCEPT_AS_WRITTEN.imbalanceArm &&
            x.conjunction === CONCEPT_AS_WRITTEN.conjunction &&
            x.gate === null,
        ).bars.total,
        shipped: rows.find(
          (x) =>
            x.sessionMin === SHIPPED_CONCEPT.sessionMin &&
            x.structureArm === SHIPPED_CONCEPT.structureArm &&
            x.imbalanceArm === SHIPPED_CONCEPT.imbalanceArm &&
            x.conjunction === SHIPPED_CONCEPT.conjunction &&
            x.gate === null,
        ).bars.total,
      },
      armCensus: {
        primary: data.arm.primary,
        widest: data.arm.widest,
        widestPopulation: conceptLabel(WIDEST_MEASURABLE),
        datasetWide: data.armAll,
        note:
          "`primary` is the concept as written; `widest` is the widest measurable population in " +
          "this matrix (OR, any session, no score gate), reported so the split is not vacuous on " +
          "a grid where the primary is empty. `datasetWide` is UNCONDITIONED — every bar of this " +
          "dataset, no predicate at all. `in*` (a touched gap price is inside) is not a rarer " +
          "reading of the same event — it is a different question: approach versus fill.",
      },
      armVerdict:
        "THE BRIEF'S PREMISE IS FALSIFIED BY THE DATA: the two arms are mutually exclusive PER " +
        "GAP (the Pine `else if` at imbalance-detector.pine:302-310 stops one gap counting as " +
        "both an entry and a fill) but NOT PER BAR — the proximity loop ranges over the whole " +
        "live array, so a second gap can be nearby-and-virgin while a first is inside. Across " +
        `this grid's ${int(data.bars)} bars, UNCONDITIONED, both arms are true at once on ` +
        `${int(data.armAll.bothLong)} long and ${int(data.armAll.bothShort)} short bars ` +
        `(near* alone ${int(data.armAll.nearLong)}L/${int(data.armAll.nearShort)}S, in* alone ` +
        `${int(data.armAll.inLong)}L/${int(data.armAll.inShort)}S). That is a property of the ` +
        "module's loop over the whole live array, not of any window, so neither arm can be " +
        "dismissed as empty and the `either` arm counts more than near-only plus in-only would " +
        "suggest. Which one carries the SETUPS is the table above, and on this grid it is `in*` " +
        "— the fill, inside a touched gap — by a wide margin, not the untouched approach.",
      rows,
      caveats: [
        "EVERY ROW IS A COUNTERFACTUAL OR A RECONSTRUCTION except the two labelled `shipped`. " +
          "A count here is a statement about a rule that does not exist in src/, not about the " +
          "indicator anyone runs on a chart. No Pine change is in scope and none is proposed.",
        "OVERLAPPING WINDOWS, NOT A PORTFOLIO SIMULATION: every DEPENDENT hit rate is a " +
          "descriptive ratio over forward windows that share data — two signals 6 bars apart " +
          "each look 288 bars forward and share 282 of them (97.9%). No confidence interval, " +
          "p-value or 'N trades' framing belongs on them. The INDEPENDENT sample (earliest entry " +
          "per non-overlapping window, <=1 per side) is the only one with an interval, and it " +
          "is REFUSED below " +
          `${MIN_OBSERVATIONS_FOR_INTERVAL} resolved observations rather than approximated.`,
        "GROSS OF ALL COSTS: no slippage, commission, exchange fees, funding, borrow or spread " +
          "is modelled. D.4 declares commission_type=percent, commission_value=0.05 (0.10% " +
          "round trip) and slippage=2 IN TICKS (docs/technical-spec.md:1947-1949); no " +
          "percentage is invented here for those ticks, because this harness has no tick size " +
          "and the conversion would be a fabrication. Every expectancy in this file is an " +
          "UPPER BOUND, not an expectation.",
        "timeout AND insufficient_data ARE NEVER FOLDED INTO win OR loss: hit rate is " +
          "win / (win + loss) with both excluded from the denominator, and the excluded counts " +
          "are printed next to every rate so the reader can see how much resolved at all.",
        "THE THREE GRIDS ARE ONE PRICE ACTION AT THREE RESOLUTIONS, not three samples. The " +
          "5m, 1h and 4h datasets overlap in wall-clock time; their errors are strongly " +
          "correlated. Agreement between grids is not corroboration. AND the hold is not " +
          "like-for-like: " +
          `${INDEPENDENT_WINDOW_BARS} bars is a 24-HOUR hold on 5m and a 12-DAY hold on 1h, ` +
          "so a hit rate from one grid must never be compared to a hit rate from another.",
        "4h HAS NO 1H TIER AND NO STRUCTURE ARM: Pine's request.security always requests 1h, " +
          "even on a 4h chart, so a real 4h chart has 1H structure pivots. This harness " +
          "aggregates the one dataset it was given and cannot synthesise 1h from 4h. Every " +
          "quantity that depends on it reads NOT MEASURABLE here, never zero.",
        "COLD-START WARM-UP: the replay begins with no prior higher-timeframe history, so the " +
          "D1 ATR needs 14 completed daily bars and a D1 pivot needs 21 " +
          `(${int(nativeBarsForDays(21, tf.stepMs))} native ${tf.id} bars). A TradingView chart ` +
          "with history loaded would hold those from the first bar, so early bars are " +
          "systematically quieter here than on the real chart.",
        "A COUNT IS NOT A QUALITY. Every row carries its hit rate next to it for exactly that " +
          "reason. Where entries and hit rate move in OPPOSITE directions — more entries, worse " +
          "rate, or the reverse — that trade-off is the finding, and no row should be read as " +
          "'better' on entry count alone.",
        "THE STRUCTURE ARM IS THE ONLY ARM THIS DATASET CANNOT REACH ON A FINE GRID, and that " +
          "is the single largest structural fact in this report. It is not fixed by any score " +
          "threshold: it is the proximity expression withholding its flag at the exact moment " +
          "a break happens. Section 5 states it with the measured counts.",
      ],
      observations: [
        "THE SHIPPED THRESHOLD OF 70 WAS CALIBRATED WITH THE D1 TIER AVAILABLE. On 5m the " +
          "only reachable tier is H1 (+10), so the minimum path is 10 + 25 (overlap) + 20 " +
          "(break) + 15 (imbalance) = 70 — exactly 70, zero margin, and only inside a session " +
          "overlap. Outside the overlap the same setup reaches 60 and does not fire. That is why " +
          "the shipped OR fires so rarely on 5m even though its raw bars are not scarce.",
        "SESSION STRENGTH IS NOT A TIER LADDER: it is +1 Asia, +2 London, +2 NY, +3 overlap " +
          "(session-markers.mjs:282-288), so the shipped gate `>= 2` excludes Asia ALONE and " +
          "nothing else. 'Any session' (`>= 1`) therefore differs from the shipped gate on " +
          "Asia-only bars and on nothing else — which is why section 6 reports Asia-only as its " +
          "own row rather than a general 'weaker session' bucket.",
        "structureFlipped IS ONE FLAG SET ONLY ON A BREAK, ON EXACTLY ONE SIDE " +
          "(structure-break.mjs:264-271), so requiring it can never let a long predicate be " +
          "satisfied by a short break. ChoCh is a SUBSET of BoS, so the `flip` arm is strictly " +
          "narrower than `any` — the two rows differ by the plain breaks, not by a hidden " +
          "condition.",
        "NO ROW IS A RECOMMENDATION. The matrix shows what each gate COSTS — entries, hit rate, " +
          "and what each one gives up. Choosing among them, or declining to change anything, is " +
          "the maintainer's decision and this file does not make it.",
      ],
    };
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
        JSON.stringify(
          { schemaVersion: SCHEMA_VERSION, ok: false, error: err.message },
          null,
          2,
        ),
      );
    } else {
      out("");
      out(`FAILED - ${err.message}`);
      out("");
    }
    return 1;
  }
}

/** Long-side bars and combined fired count for one concept row. */
function pick(row, side = "long") {
  return { bars: row.bars[side], fired: row.fired[side] };
}

// ============================================================================
// LiquidityFlowAuse — T10/T11 Baselines: weighted vs binary
// ----------------------------------------------------------------------------
// The comparison the whole weight-calibration feature exists to make
// (odd/tasks/weight-calibration.md, tasks T10 and T11), dispatched by
// `node backtest/run.mjs baseline`. Zero-dependency, bare `node`, ESM — the
// same constraints as backtest/run.mjs. Reads backtest/data/btcusd-5m.json
// (gitignored), writes nothing.
//
//   T10 — the SHIPPED weighted configuration (weights as published,
//         minConfidence 70) via createSignalEngine() with no overrides:
//         a plain instance is bit-for-bit the indicator on the chart.
//   T11 — the spec's D.1 binary confluence model via
//         createBinarySignalModel() (backtest/modules/binary.mjs).
//
// Both models are evaluated over the SAME dataset, the SAME bar object, under
// BOTH label definitions from backtest/modules/label.mjs:
//   Definition A — D.4 exit rule (target 1.5% / stop 0.8%, 288-bar horizon).
//   Definition B — signed forward returns at 6/12/24/48/96/288 bars.
//
// ─── FAIRNESS CONTRACT (what makes this a comparison, not two numbers) ──────
//
//   1. ONE bar object per bar, handed to BOTH models. The runner wires the
//      five upstream modules once — session-markers, liquidity-zones,
//      structure-break, imbalance-detector — and builds a single `engineBar`
//      in the engine's input contract (signal-engine.mjs:265-293). Neither
//      model re-derives an upstream flag.
//   2. RAW-LEVEL EQUIVALENCE IS ASSERTED ON EVERY BAR. D.1 minus the score
//      threshold is the shipped raw signal, so on identical inputs
//        weighted.raw === (binary.strict AND score >= minConfidence)
//      must hold for both sides on all 62,000 bars. A single mismatch
//      aborts the run instead of reporting a distorted comparison (see
//      "INVARIANTS" in the report).
//   3. EXCLUSIVITY AND COOLDOWN ARE STATEFUL AND PER MODEL. Each model runs
//      its own directional-exclusivity and cooldown state, exactly as it
//      would alone on the chart (signal-engine.pine:193-199, :207-221).
//      Binary fires more often, so it enters cooldown more often; a shared
//      cooldown stamp would suppress one model's bars on the other's history
//      and distort the very behaviour under test. Consequently
//      `weighted fired ⊆ binary fired` does NOT hold on the final flags —
//      only at the RAW level. The report prints both counts separately plus
//      the observed fired-set relation, so a reader can attribute the gap:
//      raw gap = score threshold alone; fired gap = threshold + downstream
//      exclusivity/cooldown dynamics.
//   4. IDENTICAL ABSENCES. The D.3 spread filter (spreadOK) is not
//      implemented anywhere under src/, so neither model gets it — stated in
//      the report rather than quietly dropped. D.1's unused declarations
//      (liquidityOK, structureOK) are not ported either, and are reported as
//      a dead declaration with no behavioural effect.
//
// ─── WIRING (5m chart bar → five modules → two models) ──────────────────────
//
// The Pine build splices the modules together with request.security(...,
// lookahead=barmerge.lookahead_off): an HTF value becomes visible on the
// chart bar where the HTF bar CLOSES and then holds until the next HTF
// close. The runner reproduces that: 5m candles are aggregated into 1H/4H/D1
// bars, each completed HTF bar feeds createAtr/createPivotDetector, and the
// returned values are held on `pending*` until the next HTF completion.
// Per bar, in Pine source order:
//
//   session-markers  {t}                          → session flags, strength
//   ta.atr(14) on 5m                              → atrChart (na for 13 bars)
//   liquidity-zones  {ohlcv, atr*, pivots*}       → nearLiquidity*, tier flags
//   structure-break  {close, pivots (1H, len 5)}  → break*, marketStructure
//   imbalance-detector {ohlcv, atrChart}          → imbalance arms, volume
//   ONE engineBar built from the five results
//   weighted.evaluate(engineBar) + binary.evaluate(engineBar)
//
// Two pivot detectors run on the SAME 1H series with DIFFERENT lengths —
// liquidity zones use the Pine input default 10 (liquidity-zones.pine:35-36),
// structure break uses structPivotLen 5 (structure-break.pine:41) — because
// the two lengths describe different structure and must not be shared
// (structure-break.mjs header, "Wiring").
//
// ─── HONESTY REQUIREMENTS (printed in every report, not just commented) ─────
//
// See caveats[] below: overlapping windows rather than a portfolio
// simulation, gross-of-costs labels against a strategy that declares
// commission_value=0.05 and slippage=2, timeout/insufficient_data never
// folded into win or loss, doubleTouchCount next to every hit rate, and the
// cold-start HTF warm-up that a chart with prior history would not have.
//
// Usage:
//   node backtest/run.mjs baseline          human-readable report on stdout
//   node backtest/run.mjs baseline --json   the same numbers as JSON (T13)
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
} from "./modules/liquidity-zones.mjs";
import {
  createStructureBreak,
  STRUCTURE_BREAK_DEFAULTS,
} from "./modules/structure-break.mjs";
import { createImbalanceDetector } from "./modules/imbalance-detector.mjs";
import { createSignalEngine } from "./modules/signal-engine.mjs";
import { createBinarySignalModel } from "./modules/binary.mjs";
import {
  EXIT_RULE_DEFAULTS,
  EXIT_STOP_PCT,
  EXIT_TARGET_PCT,
  FORWARD_RETURN_DEFAULTS,
  labelSignalsExitRule,
  labelSignalsForwardReturn,
} from "./modules/label.mjs";

const SCHEMA_VERSION = 1;

const MS_1H = 3600000;
const MS_4H = 14400000;
const MS_1D = 86400000;

// ─── Timeframe ───────────────────────────────────────────────────────────────
//
// `tf` is threaded through everything below rather than read from a module
// constant, so two timeframes can never be mixed inside one run. It defaults to
// 5m: every pre-slice-7 caller (and every documented command line) is unchanged.
//
// The NATIVE grid changes with it, and that is the point rather than a
// nuisance. On 1h, `atrChart` is ATR(14) of HOUR bars — fourteen hours, not
// fourteen times five minutes — and the H4/D1 tiers aggregate on a different
// grid. That is what TradingView computes on a 1h chart, so the run is
// comparable TO Pine on that chart; it is NOT the 5m run with more history, and
// nothing in this report lets a reader assume otherwise (caveat [C0], and the
// `[C0]` banners under sections 2 and 4).

const DEFAULT_TF = getTimeframe(DEFAULT_TIMEFRAME);

/**
 * Higher-timeframe contexts are only built when the dataset can produce them.
 *
 * Pine's `request.security(syminfo.tickerid, "60", ...)` returns 1h bars even on
 * a 4h chart, because Pine asks the exchange for 1h data regardless of the
 * chart's own resolution. This harness cannot: it aggregates the one dataset it
 * was handed. So on a 4h dataset the 1H context is NOT synthesised — it is
 * reported as unavailable, and the report says so. Reporting an empty H1 tier as
 * if it were a finding would read as "the H1 tier produced nothing" when the
 * truth is "a 4h dataset contains no 1h candles".
 */
function htfContexts(tf) {
  const { available, unavailable } = htfAvailability(tf.stepMs);
  return { available, unavailable };
}

const out = (s = "") => console.log(`baseline: ${s}`);

// ─── Small helpers ───────────────────────────────────────────────────────────

const iso = (ms) => new Date(ms).toISOString();
const int = (v) => Number(v).toLocaleString("en-US");
/** Signed integer, e.g. +1,234 / -12. */
const sgn = (v) => (v > 0 ? "+" : "") + Number(v).toLocaleString("en-US");
const round = (v, dp) => (v === null || v === undefined ? null : Number(v.toFixed(dp)));
const padL = (s, w) => String(s).padEnd(w);
const padR = (s, w) => String(s).padStart(w);

/**
 * Horizon label. The horizon is a BAR COUNT, so its wall-clock length depends on
 * the native grid: "6 (30m)" on 5m, "6 (6h)" on 1h.
 *
 * 5m is special-cased to MINUTES because that is what this report has always
 * printed, and the 5m output is contractually byte-identical. The coarser grids
 * get hours, where "12 (1h)" is what a reader expects on an hourly chart.
 */
function horizonLabel(h, tf) {
  const totalMinutes = h * tf.minutesPerBar;
  if (tf.id === "5m" || totalMinutes < 60) return `${h} (${totalMinutes}m)`;
  if (totalMinutes % 60 === 0) return `${h} (${totalMinutes / 60}h)`;
  return `${h} (${Math.floor(totalMinutes / 60)}h${totalMinutes % 60}m)`;
}

function meanOf(values) {
  if (values.length === 0) return null;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

function medianOf(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function statsOf(values) {
  if (values.length === 0) {
    return { count: 0, min: null, median: null, mean: null, max: null };
  }
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return {
    count: values.length,
    min,
    median: round(medianOf(values), 4),
    mean: round(meanOf(values), 4),
    max,
  };
}

/** Histogram with numerically ascending keys (deterministic JSON key order). */
function histogramOf(map) {
  const keys = [...map.keys()].map(Number).sort((a, b) => a - b);
  const out = {};
  for (const key of keys) out[String(key)] = map.get(key);
  return out;
}

/** String-keyed count map, alphabetically ascending for determinism. */
function countObjectOf(map) {
  const keys = [...map.keys()].sort();
  const out = {};
  for (const key of keys) out[key] = map.get(key);
  return out;
}

function bump(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

// ─── Dataset ────────────────────────────────────────────────────────────────

export async function loadDataset(tf) {
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
    meta = null; // header degrades to nulls; nothing downstream needs it
  }
  return { candles, meta };
}

// ─── HTF aggregation (native → 1H/4H/D1), lookahead-off semantics ───────────
//
// Returns the COMPLETED HTF bar on the chart bar where its last NATIVE candle
// closes, else null. A bucket that changes without ever completing (a data
// gap) is counted in `droppedBuckets` and reported — never silently smoothed
// over, because a half-formed HTF bar would feed a wrong pivot/ATR to the
// zone engine.
//
// `nativeStepMs` is the DATASET's step, and the completion test depends on it:
// on 5m a D1 bucket completes when a candle lands on the last 5m slot of the
// day, and on 4h when one lands on the last 4h slot. Hard-coding 300000 here
// would make a 4h dataset complete no bucket at all, which would silently
// empty the D1 tier — the precise failure this slice has to avoid.
//
// A tier FINER than the native grid cannot be aggregated at all (see
// htfContexts above). Such a series is returned as unavailable and never fed;
// the report prints the omission instead of an empty result.
//
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
        if (bucket !== null) droppedBuckets += 1; // never saw its final bar
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

/**
 * One HTF context: the aggregator, its ATR(14), its liquidity pivot pair.
 * `available: false` means the dataset cannot produce this timeframe at all —
 * distinct from "produced nothing", and reported differently.
 */
function createHtfContext(tfMs, tf, available) {
  return {
    available,
    tfMs,
    series: available ? createHtfSeries(tfMs, tf.stepMs) : null,
    atr: createAtr({ length: 14 }),
    atrValue: null,
    // Pivot lengths are the Pine INPUT defaults (liquidity-zones.pine:35-36),
    // i.e. createPivotDetector()'s own defaults — spelled explicitly here so
    // the wiring states which module they belong to.
    liqPivot: createPivotDetector({ pivotLenHigh: 10, pivotLenLow: 10 }),
    liq: { high: null, low: null },
  };
}

// ─── Metrics scaffolding ────────────────────────────────────────────────────

function newStageCounts() {
  return { long: 0, short: 0 };
}

function newModelStages() {
  return {
    raw: newStageCounts(),
    afterExclusivity: newStageCounts(),
    exclusivitySuppressed: newStageCounts(),
    cooldownSuppressed: newStageCounts(),
    fired: newStageCounts(),
    ambiguousTies: 0,
  };
}

function withTotal(counts) {
  return { long: counts.long, short: counts.short, total: counts.long + counts.short };
}

/** Definition A summary over one model's FIRED signals. */
function summariseExitRule(labelCandles, signalList) {
  const batch = labelSignalsExitRule(labelCandles, signalList);
  const sideOf = (side) => {
    const results = batch.results.filter((r) => r.side === side);
    const counts = { win: 0, loss: 0, timeout: 0, insufficient_data: 0 };
    let doubleTouchCount = 0;
    for (const r of results) {
      counts[r.label] += 1;
      if (r.doubleTouch) doubleTouchCount += 1;
    }
    const denom = counts.win + counts.loss;
    return {
      signals: results.length,
      counts,
      doubleTouchCount,
      hitRatePercent: denom > 0 ? round((counts.win / denom) * 100, 2) : null,
    };
  };
  const denom = batch.counts.win + batch.counts.loss;
  return {
    population: "fired signals only",
    signals: batch.total,
    counts: batch.counts,
    doubleTouchCount: batch.doubleTouchCount,
    hitRatePercent: denom > 0 ? round((batch.counts.win / denom) * 100, 2) : null,
    hitRateDefinition: "win / (win + loss) in percent; timeout and insufficient_data excluded",
    bySide: { long: sideOf("long"), short: sideOf("short") },
  };
}

/** Definition B summary over one model's FIRED signals. */
function summariseForwardReturns(labelCandles, signalList) {
  const batch = labelSignalsForwardReturn(labelCandles, signalList);
  const horizons = {};
  for (const h of batch.horizons) {
    const observed = [];
    let unobserved = 0;
    for (const r of batch.results) {
      const v = r.returns[h];
      if (v === null) unobserved += 1;
      else observed.push(v);
    }
    const positives = observed.filter((v) => v > 0).length;
    horizons[String(h)] = {
      observed: observed.length,
      unobserved,
      meanPercent: observed.length > 0 ? round(meanOf(observed), 4) : null,
      medianPercent: observed.length > 0 ? round(medianOf(observed), 4) : null,
      positiveSharePercent:
        observed.length > 0 ? round((positives / observed.length) * 100, 2) : null,
    };
  }
  return {
    population: "fired signals only",
    signals: batch.total,
    horizons,
    note:
      "signed percentage change from the signal close; positive = the trade would have " +
      "made money; unobserved horizons are null/omitted, never counted as 0",
  };
}

/**
 * Every shared numeric leaf of the two model objects, as
 * { path, weighted, binary, delta } — binary minus weighted, which is what
 * the brief asks for on EVERY shared metric. Model-specific blocks
 * (`scores` exists only on weighted, `conditions` only on binary) are not
 * shared, so they are skipped by construction.
 */
function sharedDeltas(a, b, prefix = "", into = []) {
  for (const key of Object.keys(a)) {
    if (!(key in b)) continue;
    const va = a[key];
    const vb = b[key];
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof va === "number" && typeof vb === "number") {
      into.push({ path, weighted: va, binary: vb, delta: round(vb - va, 6) });
    } else if (
      va !== null &&
      vb !== null &&
      typeof va === "object" &&
      typeof vb === "object" &&
      !Array.isArray(va) &&
      !Array.isArray(vb)
    ) {
      sharedDeltas(va, vb, path, into);
    }
  }
  return into;
}

// ─── The comparison ─────────────────────────────────────────────────────────

/**
 * The ONE signal-generation pass both baseline.mjs and backtest/compare.mjs
 * run. Exported so the cluster-bootstrap report can reuse the very same
 * signals and labels instead of re-deriving them: a second wiring loop would
 * be free to drift from this one, and a comparison between two models is only
 * meaningful if both were produced by identical wiring.
 *
 * `sink` is an optional callback invoked once with the raw signal lists, the
 * label candle view and the score-candidate counts. It is a pure side channel:
 * when it is null (every baseline run) nothing here changes, and the returned
 * object is byte-for-byte what it was before the parameter existed — the report
 * and the JSON payload are untouched.
 */
export function runComparison(candles, meta, tf, sink = null) {
  const n = candles.length;
  const barsPerDay = MS_1D / tf.stepMs;
  // label.mjs reads { high, low, close }; the dataset holds { t, o, h, l, c, v }.
  // Established mapping (backtest/gate.mjs:332-338, label.mjs header).
  const labelCandles = candles.map((c) => ({ high: c.h, low: c.l, close: c.c }));

  // ── Module instances (shipped defaults everywhere — T10 IS the shipped
  // configuration, so no factory call here passes an override) ──────────────
  const session = createSessionMarkers();
  const chartAtr = createAtr({ length: 14 });
  const avail = htfAvailability(tf.stepMs);
  const ctx = {
    h1: createHtfContext(MS_1H, tf, avail.available.h1),
    h4: createHtfContext(MS_4H, tf, avail.available.h4),
    d1: createHtfContext(MS_1D, tf, avail.available.d1),
  };
  // Structure Break's OWN 1H pivot detector, length structPivotLen (default 5).
  // Deliberately a second instance on the 1H series: it must not be shared
  // with ctx.h1.liqPivot (length 10) — see structure-break.mjs "Wiring".
  const structPivot = createPivotDetector({
    pivotLenHigh: STRUCTURE_BREAK_DEFAULTS.structPivotLen,
    pivotLenLow: STRUCTURE_BREAK_DEFAULTS.structPivotLen,
  });
  const zones = createLiquidityZones();
  const structure = createStructureBreak();
  const imbalance = createImbalanceDetector();

  const weighted = createSignalEngine();
  const binary = createBinarySignalModel();

  // First availability of each higher-timeframe series (cold-start warm-up,
  // reported honestly — see caveat 7).
  const warmup = {};
  const noteFirst = (key, value, barIndex) => {
    if (value !== null && value !== undefined && !(key in warmup)) {
      warmup[key] = { barIndex, iso: iso(candles[barIndex].t) };
    }
  };
  const notePivot = (key, pivot, barIndex) => {
    if ((pivot.high !== null || pivot.low !== null) && !(key in warmup)) {
      warmup[key] = { barIndex, iso: iso(candles[barIndex].t) };
    }
  };

  const stages = { weighted: newModelStages(), binary: newModelStages() };
  const signals = { weighted: [], binary: [] };
  const firedRelation = {
    long: { both: 0, weightedOnly: 0, binaryOnly: 0 },
    short: { both: 0, weightedOnly: 0, binaryOnly: 0 },
  };

  // Score side of the comparison (weighted only).
  const scoreCandidate = { long: [], short: [] };
  const scoreAll = { long: [], short: [] };
  const scoreCandidateHist = { long: new Map(), short: new Map() };
  const thresholdRejected = { long: 0, short: 0 };
  // Condition side of the comparison (binary only), same population.
  const condTrigger = { long: new Map(), short: new Map() };
  const condTier = { long: new Map(), short: new Map() };
  const condCount = { long: 0, short: 0 };

  // Raw-level invariants, asserted on every bar (never weakened: a violation
  // aborts the run with the first offending bar index in the message).
  const inv = {
    checks: 0,
    equalityMismatches: 0,
    implicationViolations: 0,
    firstMismatch: null,
  };

  let structPivots = { high: null, low: null };

  for (let i = 0; i < n; i++) {
    const c = candles[i];

    const sm = session.evaluate({ t: c.t });

    // atrChart = ta.atr(14) on the CHART timeframe — computed on this bar,
    // visible on this bar (na for the first 13 bars).
    const atrChart = chartAtr.update({ high: c.h, low: c.l, close: c.c });
    noteFirst("atrChart", atrChart, i);

    // ── HTF completions (lookahead_off: visible on the closing chart bar) ───
    const h1Bar = ctx.h1.available ? ctx.h1.series.feed(c) : null;
    if (h1Bar) {
      const p = ctx.h1.liqPivot.update({ high: h1Bar.h, low: h1Bar.l });
      ctx.h1.liq = { high: p.pivotHigh, low: p.pivotLow };
      notePivot("liqPivotH1", ctx.h1.liq, i);
      ctx.h1.atrValue = ctx.h1.atr.update({ high: h1Bar.h, low: h1Bar.l, close: h1Bar.c });
      noteFirst("atrH1", ctx.h1.atrValue, i);
      const sp = structPivot.update({ high: h1Bar.h, low: h1Bar.l });
      structPivots = { high: sp.pivotHigh, low: sp.pivotLow };
      notePivot("structPivotH1", structPivots, i);
    }
    const h4Bar = ctx.h4.available ? ctx.h4.series.feed(c) : null;
    if (h4Bar) {
      const p = ctx.h4.liqPivot.update({ high: h4Bar.h, low: h4Bar.l });
      ctx.h4.liq = { high: p.pivotHigh, low: p.pivotLow };
      notePivot("liqPivotH4", ctx.h4.liq, i);
      ctx.h4.atrValue = ctx.h4.atr.update({ high: h4Bar.h, low: h4Bar.l, close: h4Bar.c });
      noteFirst("atrH4", ctx.h4.atrValue, i);
    }
    const d1Bar = ctx.d1.available ? ctx.d1.series.feed(c) : null;
    if (d1Bar) {
      const p = ctx.d1.liqPivot.update({ high: d1Bar.h, low: d1Bar.l });
      ctx.d1.liq = { high: p.pivotHigh, low: p.pivotLow };
      notePivot("liqPivotD1", ctx.d1.liq, i);
      ctx.d1.atrValue = ctx.d1.atr.update({ high: d1Bar.h, low: d1Bar.l, close: d1Bar.c });
      noteFirst("atrD1", ctx.d1.atrValue, i);
    }

    // ── Upstream modules, evaluated ONCE per bar ────────────────────────────
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

    // ── ONE bar object, the engine's contract, BOTH models ──────────────────
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

    // ── Raw-level invariants (fairness contract 2) ──────────────────────────
    const minConfidence = weighted.defaults.minConfidence;
    const expectedLong = b.longSignalStrict && w.longScore >= minConfidence;
    const expectedShort = b.shortSignalStrict && w.shortScore >= minConfidence;
    inv.checks += 2;
    for (const side of ["long", "short"]) {
      const raw = side === "long" ? w.longSignalRaw : w.shortSignalRaw;
      const strict = side === "long" ? b.longSignalStrict : b.shortSignalStrict;
      const expected = side === "long" ? expectedLong : expectedShort;
      if (raw !== expected) {
        inv.equalityMismatches += 1;
        if (inv.firstMismatch === null) {
          inv.firstMismatch = {
            barIndex: i,
            side,
            weightedRaw: raw,
            binaryStrict: strict,
            score: side === "long" ? w.longScore : w.shortScore,
            minConfidence,
          };
        }
      }
      if (raw && !strict) inv.implicationViolations += 1;
    }

    // ── Stage tallies ───────────────────────────────────────────────────────
    const pairs = [
      ["weighted", w.longSignalRaw, w.shortSignalRaw, w.longSignal, w.shortSignal,
        w.longSignalFired, w.shortSignalFired, w.inCooldown, w.ambiguousTie],
      ["binary", b.longSignalStrict, b.shortSignalStrict, b.longSignal, b.shortSignal,
        b.longSignalFired, b.shortSignalFired, b.inCooldown, b.ambiguousTie],
    ];
    for (const [name, rawL, rawS, sigL, sigS, fireL, fireS, inCool, tie] of pairs) {
      const st = stages[name];
      if (rawL) st.raw.long += 1;
      if (rawS) st.raw.short += 1;
      if (sigL) st.afterExclusivity.long += 1;
      if (sigS) st.afterExclusivity.short += 1;
      if (rawL && !sigL) st.exclusivitySuppressed.long += 1;
      if (rawS && !sigS) st.exclusivitySuppressed.short += 1;
      if (sigL && inCool) st.cooldownSuppressed.long += 1;
      if (sigS && inCool) st.cooldownSuppressed.short += 1;
      if (fireL) st.fired.long += 1;
      if (fireS) st.fired.short += 1;
      if (tie) st.ambiguousTies += 1;
    }

    // ── Fired-set relation (per side, reported — never asserted) ────────────
    for (const side of ["long", "short"]) {
      const wf = side === "long" ? w.longSignalFired : w.shortSignalFired;
      const bf = side === "long" ? b.longSignalFired : b.shortSignalFired;
      if (wf && bf) firedRelation[side].both += 1;
      else if (wf) firedRelation[side].weightedOnly += 1;
      else if (bf) firedRelation[side].binaryOnly += 1;
    }

    // ── Score / condition populations ───────────────────────────────────────
    scoreAll.long.push(w.longScore);
    scoreAll.short.push(w.shortScore);
    if (b.longSignalStrict) {
      scoreCandidate.long.push(w.longScore);
      bump(scoreCandidateHist.long, w.longScore);
      if (!w.longSignalRaw) thresholdRejected.long += 1;
      bump(condTrigger.long, b.longConditions.trigger);
      bump(condTier.long, b.longConditions.liquidityTier ?? "none");
      condCount.long += 1;
    }
    if (b.shortSignalStrict) {
      scoreCandidate.short.push(w.shortScore);
      bump(scoreCandidateHist.short, w.shortScore);
      if (!w.shortSignalRaw) thresholdRejected.short += 1;
      bump(condTrigger.short, b.shortConditions.trigger);
      bump(condTier.short, b.shortConditions.liquidityTier ?? "none");
      condCount.short += 1;
    }

    // ── Label population: FIRED signals only ────────────────────────────────
    if (w.longSignalFired) signals.weighted.push({ barIndex: i, side: "long", price: c.c });
    if (w.shortSignalFired) signals.weighted.push({ barIndex: i, side: "short", price: c.c });
    if (b.longSignalFired) signals.binary.push({ barIndex: i, side: "long", price: c.c });
    if (b.shortSignalFired) signals.binary.push({ barIndex: i, side: "short", price: c.c });
  }

  // ── Invariant verdicts — a violation throws, it is never averaged away ────
  if (inv.equalityMismatches > 0) {
    const m = inv.firstMismatch;
    throw new Error(
      `raw equivalence violated on bar ${m.barIndex} (${m.side}): weighted raw ${m.weightedRaw} ` +
        `!== (binary strict ${m.binaryStrict} AND score ${m.score} >= ${m.minConfidence}) — ` +
        `${inv.equalityMismatches}/${inv.checks} checks failed; the two models are not ` +
        "comparable as wired, refusing to report a distorted comparison",
    );
  }

  // Stage accounting identities: raw = afterExclusivity + exclusivitySuppressed,
  // afterExclusivity = fired + cooldownSuppressed, per side, per model. Catches
  // a counting bug in this file rather than in the modules.
  for (const [name, st] of Object.entries(stages)) {
    for (const side of ["long", "short"]) {
      const lhs = st.raw[side];
      const rhsA = st.afterExclusivity[side] + st.exclusivitySuppressed[side];
      const rhsB = st.fired[side] + st.cooldownSuppressed[side];
      if (lhs !== rhsA || st.afterExclusivity[side] !== rhsB) {
        throw new Error(
          `stage accounting broken for ${name}/${side}: raw ${lhs} != afterExclusivity ` +
            `${st.afterExclusivity[side]} + suppressed ${st.exclusivitySuppressed[side]}`,
        );
      }
    }
  }

  // Side channel for backtest/compare.mjs. Fires exactly once, after the
  // signal lists are final and before any summarising — see runComparison()'s
  // doc comment. No effect when `sink` is null.
  if (sink !== null) {
    sink({
      labelCandles,
      signals,
      scoreCandidateCounts: {
        long: scoreCandidate.long.length,
        short: scoreCandidate.short.length,
      },
    });
  }

  const defA = {
    weighted: summariseExitRule(labelCandles, signals.weighted),
    binary: summariseExitRule(labelCandles, signals.binary),
  };
  const defB = {
    weighted: summariseForwardReturns(labelCandles, signals.weighted),
    binary: summariseForwardReturns(labelCandles, signals.binary),
  };

  const models = {
    weighted: {
      description:
        "shipped configuration: published weights, minConfidence " +
        `${weighted.defaults.minConfidence}, signalCooldownBars ` +
        `${weighted.defaults.signalCooldownBars}, maxScore ${weighted.maxScore}`,
      signals: {
        raw: withTotal(stages.weighted.raw),
        afterExclusivity: withTotal(stages.weighted.afterExclusivity),
        exclusivitySuppressed: withTotal(stages.weighted.exclusivitySuppressed),
        cooldownSuppressed: withTotal(stages.weighted.cooldownSuppressed),
        fired: withTotal(stages.weighted.fired),
        ambiguousTies: stages.weighted.ambiguousTies,
      },
      definitionA: defA.weighted,
      definitionB: defB.weighted,
      scores: {
        note:
          "the weighted model is the only one with a score; population `candidate` is the " +
          "bars where the side's non-score gates pass (score is the only question) — the " +
          "same bars the binary model reports as raw",
        candidate: {
          long: { ...statsOf(scoreCandidate.long), histogram: histogramOf(scoreCandidateHist.long) },
          short: { ...statsOf(scoreCandidate.short), histogram: histogramOf(scoreCandidateHist.short) },
        },
        allBars: { long: statsOf(scoreAll.long), short: statsOf(scoreAll.short) },
        thresholdRejected: withTotal(thresholdRejected),
        minConfidence: weighted.defaults.minConfidence,
      },
    },
    binary: {
      description:
        "spec D.1 strict binary confluence (docs/technical-spec.md:1844-1855): no score, " +
        "no threshold — every gate is a boolean",
      signals: {
        raw: withTotal(stages.binary.raw),
        afterExclusivity: withTotal(stages.binary.afterExclusivity),
        exclusivitySuppressed: withTotal(stages.binary.exclusivitySuppressed),
        cooldownSuppressed: withTotal(stages.binary.cooldownSuppressed),
        fired: withTotal(stages.binary.fired),
        ambiguousTies: stages.binary.ambiguousTies,
      },
      definitionA: defA.binary,
      definitionB: defB.binary,
      conditions: {
        note:
          "the binary model has no score to distribute; over the SAME bars the weighted " +
          "model's score histogram covers (D.1 strict true), these are the conditions " +
          "that carried",
        population: { long: condCount.long, short: condCount.short },
        trigger: { long: countObjectOf(condTrigger.long), short: countObjectOf(condTrigger.short) },
        liquidityTier: { long: countObjectOf(condTier.long), short: countObjectOf(condTier.short) },
      },
    },
  };

  const deltas = sharedDeltas(models.weighted, models.binary);

  // ── Caveats — printed on every run, both output modes ─────────────────────
  const firstD1 = warmup.liqPivotD1 ?? warmup.atrD1 ?? null;
  // Index 0 prints as [C0] (printReport labels with [C${i}]), so it is read
  // FIRST, before the headline numbers it scopes. The eight caveats below
  // keep their exact previous labels: they shift one index up and lose the
  // +1 in the label formula, which cancels out ([C1]..[C8] unchanged).
  // Caveat [C0] is TIMEFRAME-SPECIFIC by construction: it states what this
  // particular grid can and cannot produce, with the numbers measured above.
  // On 5m it reproduces slice 6's finding verbatim. On 1h and 4h it states what
  // THIS grid actually produced instead — same shape, measured values, no
  // carried-over 5m numbers. A caveat that quoted 5m figures under a 1h header
  // would be the exact copy-paste failure the slice forbids.
  const firstD1PivotBar = warmup.liqPivotD1?.barIndex ?? null;
  const candLong = condCount.long;
  const candShort = condCount.short;
  const tierD1Long = condTier.long.get("D1") ?? 0;
  const tierD1Short = condTier.short.get("D1") ?? 0;
  const tierH4Long = condTier.long.get("H4") ?? 0;
  const tierH4Short = condTier.short.get("H4") ?? 0;
  const candLongMax = scoreCandidate.long.length ? Math.max(...scoreCandidate.long) : null;
  const candShortMax = scoreCandidate.short.length ? Math.max(...scoreCandidate.short) : null;
  const obsCeiling = Math.max(
    scoreAll.long.length ? Math.max(...scoreAll.long) : 0,
    scoreAll.short.length ? Math.max(...scoreAll.short) : 0,
  );

  const scopeCaveat = tf.id === "5m"
    ? "EVERY NUMBER IS SCOPED TO 5-MINUTE DATA. The dataset is 62,000 5m candles; the " +
      "weights were not evaluated on the timeframes the indicator is normally read on. " +
      "This matters concretely here rather than in principle: the multi-timeframe " +
      "liquidity tiering that produces the score's largest single component is barely " +
      "present at this resolution — D1 tier qualifies 0/192 long and 0/201 short candidates " +
      "and H4 only 7/192 long and 0/201 short, because a D1 pivot needs 21 completed daily " +
      "bars and the run supplies them only from bar 8205 (caveat 7). Consequently the " +
      "observed score ceiling on this dataset is 80 against a configured `maxScore` of " +
      "110, and candidates cluster at 40–60. The weighted model's near-zero firing rate " +
      "is therefore a property of this timeframe as much as of these weights and must not " +
      "be read as a verdict about the weight vector on its intended timeframe. " +
      // The sentence that USED to end here — "Establishing that would require
      // replaying on higher-timeframe data, which is out of scope for this
      // feature" — became false on 2026-10-01: the maintainer lifted the 5m-only
      // scope, and slice 7 performed that replay. Every number above it is
      // unchanged and remains correct for 5m; only the claim about what is still
      // unknown needed correcting, which is exactly the D1/D2 defect class
      // (a superseded premise left standing because changing it was
      // inconvenient). Corrected in 2026-10 under an explicit instruction to
      // revise the caveat text while freezing the numbers.
      "That replay has since been done: 1h and 4h datasets are in the harness, and on " +
      "those native grids the D1 tier does qualify. The figures above are unchanged and " +
      "remain exactly what was measured on 5-minute bars — read them as a statement about " +
      "this timeframe, not about the weights. Run `baseline --timeframe 1h` for what the " +
      "tier dimension looks like where it can move."
    : `EVERY NUMBER IS SCOPED TO ${tf.scopeWord} DATA, AND THE NATIVE GRID IS ` +
      `${tf.id} — NOT A 5-MINUTE CHART WITH MORE HISTORY. On this run atrChart is ` +
      `ta.atr(14) OF ${tf.id.toUpperCase()} BARS (${int(barsPerDay * 1)} bars per day, ` +
      `${int(barsPerDay)} bars per D1 bar), so the proximity band is ` +
      `3 x a ${tf.id} ATR, and the H4/D1 tiers aggregate on a different grid than the 5m ` +
      `run they are compared against. That is what TradingView computes on a ${tf.id} ` +
      `chart, which is why this run is comparable TO PINE on that chart — but the three ` +
      `timeframes are three DIFFERENT MEASUREMENTS of one weight vector, not three ` +
      `samples of one measurement. What this grid actually produced, measured here and ` +
      `not carried over from 5m: D1 tier qualifies ${int(tierD1Long)}/${int(candLong)} ` +
      `long and ${int(tierD1Short)}/${int(candShort)} short candidates, H4 ` +
      `${int(tierH4Long)}/${int(candLong)} and ${int(tierH4Short)}/${int(candShort)}; ` +
      `the observed score ceiling across all bars is ${obsCeiling} against a configured ` +
      `\`maxScore\` of ${weighted.maxScore}` +
      (candLongMax === null ? "." : `, and candidate scores reach ${candLongMax} long / ${candShortMax} short.`) +
      " Compare those with the 5m run (D1 0/192 and 0/201, ceiling 80) before drawing any " +
      "conclusion about the weights.";

  const caveats = [
    scopeCaveat,
    "OVERLAPPING WINDOWS, NOT A PORTFOLIO SIMULATION: labels are independent forward " +
      "windows over one shared candle series — no position accounting, no cash or equity " +
      "curve, no compounding, no sizing, no interaction between signals. Two signals 6 " +
      "bars apart each look 288 bars forward and share 282 of them: 97.9% of their forward " +
      "data is THE SAME DATA. Hit rates here are descriptive ratios over DEPENDENT " +
      "observations, not independent-trial statistics — no confidence intervals, no " +
      "p-values, no 'N trades' framing belongs on them.",
    "GROSS OF ALL COSTS: no slippage, commission, exchange fees, funding, borrow costs or " +
      "spread is modelled. The spec's own D.4 strategy declares commission_type=percent, " +
      "commission_value=0.05 and slippage=2 (docs/technical-spec.md:1947-1949); against " +
      "that strategy these hit rates are an UPPER BOUND on what it would realise, not an " +
      "expectation.",
    "D.3 SPREAD FILTER NOT APPLIED TO EITHER MODEL: spreadOK is not implemented anywhere " +
      "under src/, so neither the weighted nor the binary model gets it — both are treated " +
      "identically. The D.4 entry rules read `longSignalStrict and spreadOK`; that conjunct " +
      "is absent here for the same reason, and this statement is about the shipped source, " +
      "not a modelling choice made by this runner.",
    "LABEL POPULATION = FIRED SIGNALS ONLY: raw and post-exclusivity counts are reported " +
      "for attribution but are not labelled — only bars a strategy following that model " +
      "would actually have taken carry a Definition A or Definition B outcome.",
    "timeout AND insufficient_data ARE NEVER FOLDED INTO win OR LOSS: hit rate = " +
      "win / (win + loss) with both excluded from the denominator, and doubleTouchCount is " +
      "printed next to every hit rate (T9 contract). doubleTouch counts labels the " +
      "conservative rule set to loss because ONE bar touched both levels.",
    "RAW VS FIRED ATTRITION: the raw gap between models is the score threshold alone; the " +
      "fired gap additionally contains directional-exclusivity and cooldown dynamics. Each " +
      "model ran its OWN exclusivity and cooldown state (as it would alone on the chart), " +
      "so weighted-fired is NOT a subset of binary-fired on the final flags — that relation " +
      "holds only at the raw level, where it is asserted on every bar.",
    "HTF WARM-UP (cold start): the replay begins at the first candle with no higher-timeframe " +
      "history before it, so the D1 ATR needs 14 completed daily bars and a D1 pivot needs " +
      "21 — D1 tier zones cannot exist until " +
      `${firstD1 ? firstD1.iso : "n/a"}, and the first ${warmup.liqPivotD1 ? int(warmup.liqPivotD1.barIndex) : "?"} ` +
      "bars carry no D1 liquidity tier at all. A TradingView chart with prior history " +
      "loaded would hold those values from the first bar. See the warm-up table.",
    "DATASET FACTS ARE QUOTED FROM THE FILE, NOT ASSUMED: span, gaps and off-grid bars are " +
      "printed in the header; a hole in the history would silently bias every number below.",
  ];

  // The cross-timeframe caveat, appended on EVERY timeframe.
  //
  // It used to be withheld from the 5m run on the grounds that the 5m report was
  // contractually byte-identical and a reader comparing runs would see it on the
  // others. That was the wrong call: 5m is the DEFAULT, so most readers never
  // open a second report at all, and the reader who trusts that three timeframes
  // corroborate each other is exactly the reader who is wrong. The numbers are
  // still frozen; the caveat now travels with them on all three grids.
  //
  // The 5m wording is a FORWARD WARNING, because a 5m reader may not know the
  // other runs exist. It names them as available rather than describing runs
  // they may never have seen — the warning has to be actionable.
  caveats.push(
    tf.id === "5m"
      ? "MULTIPLE TIMEFRAMES ARE NOT MULTIPLE INDEPENDENT SAMPLES: this harness also " +
        "runs on 1h and 4h (`baseline --timeframe 1h` / `4h`), and those runs are NOT " +
        "three samples of one measurement — they describe the same BTC/USD price action " +
        "at different resolutions, so their errors are strongly correlated. Agreement " +
        "between them is NOT corroboration, and disagreement between them is mostly " +
        "about SEMANTICS (a different atrChart, a different HTF grid, a different " +
        "warm-up) rather than about which timeframe is right. A configuration that " +
        "looks good on several timeframes is one observation reported several ways, " +
        "and supports no confidence interval, p-value, or 'N = 3 tests' framing."
      : "MULTIPLE TIMEFRAMES ARE NOT MULTIPLE INDEPENDENT SAMPLES: the 5m, 1h and 4h " +
        "runs overlap in wall-clock time and describe the SAME BTC/USD price action at " +
        "different resolutions. Agreement between them is NOT corroboration — it is the " +
        "same evidence counted twice, and their errors are strongly correlated. " +
        "Disagreement between them is mostly about SEMANTICS (a different atrChart, a " +
        "different HTF grid, a different warm-up), not about which timeframe is right. " +
        "Nothing here supports a confidence interval, a p-value, or any 'N = 3 " +
        "independent tests' framing: if a weight vector wins on all three, treat that " +
        "as one observation reported three ways.",
  );

  const observations = [
    "D.1 DEAD DECLARATION: `liquidityOK` and `structureOK` (docs/technical-spec.md:1844, " +
      ":1846) are declared but never used by the strict expressions, which re-derive the " +
      "condition inline per side. Reported as a dead declaration, NOT a defect — it changes " +
      "no behaviour, so neither model ports them.",
    "sessionOK IS `sessionStrength >= 2` IN BOTH MODELS (spec :1845, " +
      "signal-engine.pine:83). The single difference between the models is the " +
      "`longScore >= minConfidence` term (signal-engine.pine:165-171 vs spec :1849-1850); " +
      "raw equivalence over every bar of this dataset confirms it.",
    "THE BINARY MODEL HAS NO SCORE: reporting one would invent a number D.1 does not " +
      "compute. Its comparable shape is `conditions` — which trigger arms and which " +
      "liquidity tier held, over exactly the bars the weighted score histogram covers.",
    "BOTH MODELS INHERIT THE SAME ABSENCES: no spread filter (see caveat 3), same " +
      "upstream flags from one shared bar object, same cooldown LENGTH (10 bars) with " +
      "independent state.",
  ];

  const spanDays = (candles[n - 1].t - candles[0].t) / 86400000;

  return {
    schemaVersion: SCHEMA_VERSION,
    ok: true,
    generatedBy: "backtest/baseline.mjs (T10/T11)",
    dataset: {
      path: tf.datasetRel,
      bars: n,
      firstIso: iso(candles[0].t),
      lastIso: iso(candles[n - 1].t),
      spanDays: round(spanDays, 4),
      gapCount: meta?.gapCount ?? null,
      missingBars: meta?.missingBars ?? null,
      offGridBars: meta?.offGridBars ?? null,
      duplicatesDropped: meta?.duplicatesDropped ?? null,
    },
    timeframe: {
      id: tf.id,
      label: tf.id,
      // "5-MINUTE" / "1-HOUR" / "4-HOUR" — the spelling used in caveat text and
      // the [C0] banners.
      scopeWord: tf.scopeWord,
      nativeStepMs: tf.stepMs,
      minutesPerBar: tf.minutesPerBar,
      barsPerDailyBar: barsPerDay,
      // Recomputed per grid, NOT copied from the 5m run. A D1 liquidity pivot
      // needs 21 completed daily bars; how many native bars that is depends
      // entirely on the native step.
      d1PivotWarmupNativeBars: nativeBarsForDays(21, tf.stepMs),
      d1AtrWarmupNativeBars: nativeBarsForDays(14, tf.stepMs),
      unavailableHtf: avail.unavailable.map((t) => t.name),
      note:
        `atrChart is ATR(14) of ${tf.id} bars. Changing this changes the MEASUREMENT, ` +
        "not just the label.",
    },
    config: {
      minConfidence: weighted.defaults.minConfidence,
      signalCooldownBars: weighted.defaults.signalCooldownBars,
      maxScore: weighted.maxScore,
      exitTargetPct: EXIT_TARGET_PCT,
      exitStopPct: EXIT_STOP_PCT,
      exitHorizonBars: EXIT_RULE_DEFAULTS.maxHorizonBars,
      forwardHorizons: [...FORWARD_RETURN_DEFAULTS.horizons],
      labelPopulation: "fired signals only",
      modelsShareOneBarObject: true,
      modelsShareCooldownState: false,
    },
    models,
    firedRelation,
    deltas,
    invariants: {
      rawEquivalence: {
        formula: "weighted.raw === (binary.strict AND score >= minConfidence)",
        checks: inv.checks,
        mismatches: inv.equalityMismatches,
        firstMismatch: inv.firstMismatch,
      },
      rawImplication: {
        formula: "weighted.raw => binary.strict (per side, per bar)",
        checks: inv.checks,
        violations: inv.implicationViolations,
      },
      stageAccounting: "raw = afterExclusivity + exclusivitySuppressed; afterExclusivity = fired + cooldownSuppressed (asserted per side per model)",
    },
    warmup,
    htf: {
      droppedBuckets: {
        h1: ctx.h1.available ? ctx.h1.series.droppedBuckets : null,
        h4: ctx.h4.available ? ctx.h4.series.droppedBuckets : null,
        d1: ctx.d1.available ? ctx.d1.series.droppedBuckets : null,
      },
      available: {
        h1: ctx.h1.available,
        h4: ctx.h4.available,
        d1: ctx.d1.available,
      },
      // Which tiers this native grid can produce AT ALL. On 4h the 1H tier has
      // no candles to aggregate: Pine would request 1h data from the exchange
      // even on a 4h chart, and this harness cannot. The omission is stated in
      // the report rather than shown as a thinner tier mix.
      unavailable: avail.unavailable.map((t) => t.name),
      note:
        "completed 1H/4H/D1 bars fed to ATR + pivot detectors (lookahead_off); " +
        `aggregated from the native ${tf.id} grid at ${barsPerDay} bars per D1 bar`,
    },
    caveats,
    observations,
  };
}

// ─── Human-readable report ──────────────────────────────────────────────────
//
// Shape follows cognitive-doc-design: the answer (signal counts) first, then
// each definition, then model-specific shape, then the evidence that the
// comparison is fair, then everything a reader must not forget.

function printReport(r) {
  out("T10/T11 baselines — weighted (shipped configuration) vs binary (spec D.1)");
  out(
    `dataset  ${r.dataset.path} — ${int(r.dataset.bars)} bars, ` +
      `${r.dataset.firstIso} .. ${r.dataset.lastIso}, ${r.dataset.spanDays} days, ` +
      `gaps ${r.dataset.gapCount ?? "?"} (${int(r.dataset.missingBars ?? 0)} missing bars), ` +
      `off-grid ${r.dataset.offGridBars ?? "?"}, duplicates ${r.dataset.duplicatesDropped ?? "?"}`,
  );
  out(
    `config   minConfidence ${r.config.minConfidence}, signalCooldownBars ` +
      `${r.config.signalCooldownBars}, maxScore ${r.config.maxScore}, exit target ` +
      `${r.config.exitTargetPct}% / stop ${r.config.exitStopPct}% @ ` +
      `${r.config.exitHorizonBars} bars, horizons ` +
      `${r.config.forwardHorizons.join("/") } (${r.timeframe.id} bars)`,
  );
  // The semantic point, in the header, before any number a reader could quote.
  // Printed only for a NON-default timeframe: the 5m report's output is
  // contractually byte-identical to slice 6, and on 5m the filename already
  // states the grid unambiguously. Where it matters — a run whose numbers will
  // be read next to another timeframe's — it is said out loud.
  if (r.timeframe.id !== "5m") {
    out(
      `grid     NATIVE ${r.timeframe.id} — atrChart is ATR(14) of ${r.timeframe.id} ` +
        `bars, ${int(r.timeframe.barsPerDailyBar)} bars per D1 bar, D1 pivot warm-up ` +
        `${int(r.timeframe.d1PivotWarmupNativeBars)} native bars. This is a DIFFERENT ` +
        "MEASUREMENT from the 5m run, not more of the same one.",
    );
  }
  if (r.timeframe.unavailableHtf.length > 0) {
    out(
      `grid     UNAVAILABLE ON ${r.timeframe.id}: ` +
        `${r.timeframe.unavailableHtf.join(", ")} — finer than the native grid, so it ` +
        "cannot be aggregated. Pine's request.security would still fetch it from the " +
        "exchange on a coarser chart; this harness cannot. Tiers absent from the mix " +
        "below are a LIMITATION OF THE DATA, not a finding.",
    );
  }
  out(
    `labels   population = FIRED signals only — weighted ` +
      `${int(r.models.weighted.definitionA.signals)} / binary ` +
      `${int(r.models.binary.definitionA.signals)}`,
  );
  out("");

  // ── 1. Signal counts ──────────────────────────────────────────────────────
  out("1. SIGNAL COUNTS — raw (before directional exclusivity and cooldown) vs fired (after both)");
  out("");
  const head =
    `  ${padL("stage", 20)}` +
    `${padR("w-long", 7)}${padR("w-short", 7)}${padR("w-total", 7)}` +
    `${padR("b-long", 7)}${padR("b-short", 7)}${padR("b-total", 7)}` +
    `${padR("d-long", 7)}${padR("d-short", 7)}${padR("d-total", 7)}`;
  out(head);
  const stageRow = (label, wc, bc) => {
    const wt = wc.long + wc.short;
    const bt = bc.long + bc.short;
    out(
      `  ${padL(label, 20)}` +
        `${padR(int(wc.long), 7)}${padR(int(wc.short), 7)}${padR(int(wt), 7)}` +
        `${padR(int(bc.long), 7)}${padR(int(bc.short), 7)}${padR(int(bt), 7)}` +
        `${padR(sgn(bc.long - wc.long), 7)}${padR(sgn(bc.short - wc.short), 7)}${padR(sgn(bt - wt), 7)}`,
    );
  };
  const ws = r.models.weighted.signals;
  const bs = r.models.binary.signals;
  stageRow("raw", ws.raw, bs.raw);
  stageRow("after exclusivity", ws.afterExclusivity, bs.afterExclusivity);
  stageRow("fired", ws.fired, bs.fired);
  out("");
  out(
    `  attrition — weighted: raw -${int(ws.exclusivitySuppressed.total)} by exclusivity, ` +
      `-${int(ws.cooldownSuppressed.total)} by cooldown, ${int(ws.ambiguousTies)} ambiguous ties | ` +
      `binary: raw -${int(bs.exclusivitySuppressed.total)} by exclusivity, ` +
      `-${int(bs.cooldownSuppressed.total)} by cooldown, ${int(bs.ambiguousTies)} ambiguous ties`,
  );
  out(
    "  attribution: the RAW delta is the score threshold alone; the FIRED delta adds the " +
      "downstream exclusivity/cooldown dynamics of each model's own state.",
  );
  out(
    `  fired-set relation (per side): long both ${int(r.firedRelation.long.both)} / ` +
      `weighted-only ${int(r.firedRelation.long.weightedOnly)} / binary-only ` +
      `${int(r.firedRelation.long.binaryOnly)} | short both ${int(r.firedRelation.short.both)} / ` +
      `weighted-only ${int(r.firedRelation.short.weightedOnly)} / binary-only ` +
      `${int(r.firedRelation.short.binaryOnly)}`,
  );
  out(
    "  weighted-fired is NOT asserted to be a subset of binary-fired on the final flags — " +
      "each model owns its cooldown (see caveat 6).",
  );
  out("");

  // ── 2. Definition A ───────────────────────────────────────────────────────
  out(
    `2. DEFINITION A — D.4 exit rule (target ${r.config.exitTargetPct}% / stop ` +
      `${r.config.exitStopPct}%, ${r.config.exitHorizonBars}-bar horizon), over FIRED signals`,
  );
  out(
    `  [C0] SCOPED TO ${r.timeframe.scopeWord} DATA — these hit rates and the ` +
      "delta are properties of this timeframe as much as of the weights; read caveat " +
      "[C0] in section 8 before quoting them.",
  );
  out("");
  out(
    `  ${padL("model", 14)}${padR("signals", 8)}${padR("win", 7)}${padR("loss", 7)}` +
      `${padR("timeout", 8)}${padR("insuff.", 8)}${padR("hit rate", 10)}${padR("double-touch", 13)}`,
  );
  const aRow = (name, a, signed = false) => {
    const fmt = signed ? sgn : int;
    const hit =
      a.hitRatePercent === null ? "n/a" : signed ? `${a.hitRatePercent > 0 ? "+" : ""}${a.hitRatePercent.toFixed(2)} pp` : `${a.hitRatePercent.toFixed(2)}%`;
    out(
      `  ${padL(name, 14)}${padR(fmt(a.signals), 8)}${padR(fmt(a.counts.win), 7)}` +
        `${padR(fmt(a.counts.loss), 7)}${padR(fmt(a.counts.timeout), 8)}` +
        `${padR(fmt(a.counts.insufficient_data), 8)}${padR(hit, 10)}${padR(fmt(a.doubleTouchCount), 13)}`,
    );
  };
  aRow("weighted", r.models.weighted.definitionA);
  aRow("binary", r.models.binary.definitionA);
  const dA = {
    signals: r.models.binary.definitionA.signals - r.models.weighted.definitionA.signals,
    counts: {},
    doubleTouchCount:
      r.models.binary.definitionA.doubleTouchCount - r.models.weighted.definitionA.doubleTouchCount,
    hitRatePercent:
      r.models.weighted.definitionA.hitRatePercent === null ||
      r.models.binary.definitionA.hitRatePercent === null
        ? null
        : round(
            r.models.binary.definitionA.hitRatePercent - r.models.weighted.definitionA.hitRatePercent,
            2,
          ),
  };
  for (const k of ["win", "loss", "timeout", "insufficient_data"]) {
    dA.counts[k] = r.models.binary.definitionA.counts[k] - r.models.weighted.definitionA.counts[k];
  }
  aRow("d (b - w)", dA, true);
  out("");
  out(
    `  hit rate = win / (win + loss); timeout (${int(r.models.weighted.definitionA.counts.timeout)} / ` +
      `${int(r.models.binary.definitionA.counts.timeout)}) and insufficient_data ` +
      `(${int(r.models.weighted.definitionA.counts.insufficient_data)} / ` +
      `${int(r.models.binary.definitionA.counts.insufficient_data)}) are excluded from the ` +
      "denominator, never folded into win or loss.",
  );
  const sideLine = (name, key) => {
    const side = r.models[name].definitionA.bySide[key];
    return (
      `${name} ${key}: win ${int(side.counts.win)}, loss ${int(side.counts.loss)}, timeout ` +
      `${int(side.counts.timeout)}, insufficient ${int(side.counts.insufficient_data)}, hit ` +
      `${side.hitRatePercent === null ? "n/a" : `${side.hitRatePercent.toFixed(2)}%`}, ` +
      `double-touch ${int(side.doubleTouchCount)}`
    );
  };
  out(`  by side — ${sideLine("weighted", "long")} | ${sideLine("weighted", "short")}`);
  out(`              ${sideLine("binary", "long")} | ${sideLine("binary", "short")}`);
  out("");

  // ── 3. Definition B ───────────────────────────────────────────────────────
  out(
    `3. DEFINITION B — signed forward returns at the default horizons ` +
      `${r.config.forwardHorizons.join("/") } bars (positive = the trade would have made money)`,
  );
  out("");
  const bHead = `    ${padL("horizon", 12)}${padR("observed", 9)}${padR("unobserved", 11)}${padR("mean %", 10)}${padR("median %", 10)}${padR(">0 %", 9)}`;
  const bRow = (h, v, fmt, suffix = "") => {
    const f = (x, dp) => (x === null ? "n/a" : `${fmt === "signed" && x > 0 ? "+" : ""}${x.toFixed(dp)}`);
    out(
      `    ${padL(h, 12)}${padR(fmt === "signed" ? sgn(v.observed) : int(v.observed), 9)}` +
        `${padR(fmt === "signed" ? sgn(v.unobserved) : int(v.unobserved), 11)}` +
        `${padR(f(v.meanPercent, 4), 10)}${padR(f(v.medianPercent, 4), 10)}` +
        `${padR(f(v.positiveSharePercent, 2) + suffix, 9)}`,
    );
  };
  for (const name of ["weighted", "binary"]) {
    out(`  ${name}:`);
    out(bHead);
    for (const h of r.config.forwardHorizons) {
      bRow(horizonLabel(h, r.timeframe), r.models[name].definitionB.horizons[String(h)], "plain");
    }
    out("");
  }
  out("  delta (binary - weighted):");
  out(`    ${padL("horizon", 12)}${padR("d mean %", 10)}${padR("d median %", 10)}${padR("d >0", 9)}${padR("d observed", 11)}`);
  for (const h of r.config.forwardHorizons) {
    const wv = r.models.weighted.definitionB.horizons[String(h)];
    const bv = r.models.binary.definitionB.horizons[String(h)];
    const f = (a, b, dp, pp = false) => {
      if (a === null || b === null) return "n/a";
      const d = b - a;
      return `${d > 0 ? "+" : ""}${d.toFixed(dp)}${pp ? " pp" : ""}`;
    };
    out(
      `    ${padL(horizonLabel(h, r.timeframe), 12)}` +
        `${padR(f(wv.meanPercent, bv.meanPercent, 4), 10)}` +
        `${padR(f(wv.medianPercent, bv.medianPercent, 4), 10)}` +
        `${padR(f(wv.positiveSharePercent, bv.positiveSharePercent, 2, true), 9)}` +
        `${padR(sgn(bv.observed - wv.observed), 11)}`,
    );
  }
  out(
    "    unobserved horizons are omitted from every statistic, never counted as 0 " +
      "(label.mjs returns null for a close that does not exist).",
  );
  out("");

  // ── 4. Score distribution / condition shape ───────────────────────────────
  const sc = r.models.weighted.scores;
  out(
    `4. SCORE DISTRIBUTION — weighted only (minConfidence ${sc.minConfidence}). The binary ` +
      "model has NO score: D.1 admits or rejects, and inventing a number for it would be a " +
      "fabrication.",
  );
  out(
    `  [C0] SCOPED TO ${r.timeframe.scopeWord} DATA — the score ceiling and the ` +
      "clustering below are a property of this timeframe, not of the weight vector; read " +
      "caveat [C0] in section 8.",
  );
  out("");
  out(
    "  population: bars where the side's non-score gates pass — score is the only question " +
      "left. These are EXACTLY the bars the binary model reports as raw.",
  );
  out(`    ${padL("side", 8)}${padR("n", 8)}${padR("min", 6)}${padR("median", 8)}${padR("mean", 10)}${padR("max", 6)}`);
  for (const side of ["long", "short"]) {
    const s = sc.candidate[side];
    out(
      `    ${padL(side, 8)}${padR(int(s.count), 8)}${padR(s.min ?? "n/a", 6)}` +
        `${padR(s.median ?? "n/a", 8)}${padR(s.mean === null ? "n/a" : s.mean.toFixed(4), 10)}` +
        `${padR(s.max ?? "n/a", 6)}`,
    );
  }
  for (const side of ["long", "short"]) {
    const entries = Object.entries(sc.candidate[side].histogram).map(([k, v]) => `${k}:${int(v)}`);
    out(`    histogram ${side} (score: count):`);
    for (let i = 0; i < entries.length; i += 8) {
      out(`      ${entries.slice(i, i + 8).join("  ")}`);
    }
  }
  out(
    `  threshold rejected at minConfidence ${sc.minConfidence}: long ` +
      `${int(sc.thresholdRejected.long)}, short ${int(sc.thresholdRejected.short)} (total ` +
      `${int(sc.thresholdRejected.total)}) — those bars are the ENTIRE raw-level difference ` +
      "between the two models.",
  );
  out(
    `  all ${int(r.dataset.bars)} bars (the score exists on every bar, gated or not): ` +
      `long min ${sc.allBars.long.min} median ${sc.allBars.long.median} mean ` +
      `${sc.allBars.long.mean} max ${sc.allBars.long.max} | short min ${sc.allBars.short.min} ` +
      `median ${sc.allBars.short.median} mean ${sc.allBars.short.mean} max ${sc.allBars.short.max}`,
  );
  out("");
  const cond = r.models.binary.conditions;
  out("5. BINARY CONDITION SHAPE — the binary model's comparable 'distribution', over the SAME bars.");
  out("");
  for (const side of ["long", "short"]) {
    out(`  ${side} (n = ${int(cond.population[side])}) — trigger arms held:`);
    for (const [key, value] of Object.entries(cond.trigger[side])) {
      out(`    ${padL(key, 28)}${padR(int(value), 8)}`);
    }
    out(`  ${side} — liquidity tier that qualified:`);
    for (const [key, value] of Object.entries(cond.liquidityTier[side])) {
      out(`    ${padL(key, 28)}${padR(int(value), 8)}`);
    }
    out("");
  }

  // ── 6. Invariants ─────────────────────────────────────────────────────────
  out("6. INVARIANTS — asserted on every bar of the real dataset, not sampled");
  out("");
  out(
    `  raw equivalence  ${r.invariants.rawEquivalence.formula}`,
  );
  out(
    `                   ${int(r.invariants.rawEquivalence.checks)} checks, ` +
      `${int(r.invariants.rawEquivalence.mismatches)} mismatches`,
  );
  out(`  raw implication  ${r.invariants.rawImplication.formula}`);
  out(
    `                   ${int(r.invariants.rawImplication.checks)} checks, ` +
      `${int(r.invariants.rawImplication.violations)} violations`,
  );
  out(`  stage accounting  ${r.invariants.stageAccounting} — held`);
  out("  (a violation throws: this run would abort rather than report a distorted comparison)");
  out("");

  // ── 7. Warm-up ────────────────────────────────────────────────────────────
  out("7. HIGHER-TIMEFRAME WARM-UP — cold start, reported so nobody mistakes it for fidelity");
  out("");
  const native = r.timeframe.id;
  const warmOrder = [
    ["atrChart", `${native} ATR(14)`],
    ["atrH1", "1H ATR(14)"],
    ["liqPivotH1", "1H liquidity pivots (len 10)"],
    ["structPivotH1", "1H structure pivots (len 5)"],
    ["atrH4", "4H ATR(14)"],
    ["liqPivotH4", "4H liquidity pivots"],
    ["atrD1", "D1 ATR(14)"],
    ["liqPivotD1", "D1 liquidity pivots (last to arrive: 21 daily bars)"],
  ];
  out(`    ${padL("series", 34)}${padR("first value at bar", 20)}  timestamp`);
  for (const [key, label] of warmOrder) {
    const w = r.warmup[key];
    // "unavailable" is distinct from "never": a series this grid cannot produce
    // at all is a limitation of the data chosen, and must not read as a finding.
    const tierKey = { atrH1: "h1", liqPivotH1: "h1", structPivotH1: "h1", atrH4: "h4", liqPivotH4: "h4", atrD1: "d1", liqPivotD1: "d1" }[key];
    const unavailable = tierKey !== undefined && r.htf.available[tierKey] === false;
    const cell = w
      ? padR(int(w.barIndex), 20)
      : unavailable
        ? padR("unavailable", 20)
        : padR("never", 20);
    out(
      `    ${padL(label, 34)}${cell}  ` + `${w ? w.iso : "-"}`,
    );
  }
  // Withheld on 5m: the 5m report is contractually byte-identical to slice 6, and
  // its D1 pivot warm-up figure is already in the table above. Printed on the
  // coarser grids because the whole risk this slice guards against is quoting a
  // 5m warm-up number under a 1h header.
  if (r.timeframe.id !== "5m") {
    out(
      `  expected D1 pivot warm-up: 21 daily bars = ` +
        `${int(r.timeframe.d1PivotWarmupNativeBars)} native ${r.timeframe.id} bars ` +
        `(${int(r.timeframe.barsPerDailyBar)} per day). Measured above, not copied ` +
        "from the 5m run.",
    );
  }
  const db = (v) => (v === null ? "unavailable (finer than native)" : int(v));
  out(
    `  dropped incomplete HTF buckets: 1H ${db(r.htf.droppedBuckets.h1)}, ` +
      `4H ${db(r.htf.droppedBuckets.h4)}, D1 ${db(r.htf.droppedBuckets.d1)} ` +
      "(a non-zero value means the data has a hole inside an HTF bucket)",
  );
  out("");

  // ── 8. Caveats and observations ───────────────────────────────────────────
  out("8. READ BEFORE QUOTING ANY NUMBER ABOVE");
  out("");
  // Labels are [C${i}]: caveats[0] is the [C0] timeframe-scope caveat printed
  // first; the pre-existing caveats still print as [C1]..[C8].
  r.caveats.forEach((c, i) => out(`  [C${i}] ${c}`));
  out("");
  r.observations.forEach((o, i) => out(`  [O${i + 1}] ${o}`));
}

// ─── Entry point ────────────────────────────────────────────────────────────

/**
 * Runs both baselines on ONE timeframe and prints the requested format.
 *
 * @param {{json?: boolean, tf?: object}} options `tf` is a resolved entry of
 *   backtest/timeframes.mjs; it defaults to 5m so every pre-slice-7 caller is
 *   unchanged.
 * @returns {Promise<number>} process exit code (0 ok, 1 failed).
 */
export async function runBaseline(options = {}) {
  const json = Boolean(options.json);
  const tf = options.tf ?? DEFAULT_TF;
  const started = Date.now();

  try {
    const { candles, meta } = await loadDataset(tf);
    const result = runComparison(candles, meta, tf);
    result.runtimeMs = Date.now() - started;

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

// ============================================================================
// LiquidityFlowAuse — Cluster bootstrap: weighted vs binary (T11 addendum)
// ----------------------------------------------------------------------------
// The number baseline.mjs refuses to produce, and this file produces it.
//
// WHAT BASELINE ALREADY SAYS
//
// `baseline` prints a D.4 hit rate per model and, in caveat [C1], states that
// those hit rates are "descriptive ratios over DEPENDENT observations, not
// independent-trial statistics". That statement is correct and, so far, has no
// number attached to it. It is also the kind of caveat a reader skims past,
// because a rate printed over "1,701 signals" LOOKS like a proportion over
// 1,701 trials.
//
// WHAT THIS FILE ADDS
//
// A count of how far that is from the truth, and an interval.
//
//   1. CLUSTER COLLAPSE. label.mjs walks `maxHorizonBars` (288) bars forward
//      from every signal, and the engine's cooldown is 10 bars, so two signals
//      ten bars apart share 278 of their 288 forward bars. Signals are
//      therefore NOT independent observations. This file groups each model's
//      signals into clusters of overlapping forward windows — two CONSECUTIVE
//      signals (ordered by entry bar) share a cluster when their entry-bar gap
//      is LESS THAN the forward horizon — and reports n_signals vs n_clusters.
//      That ratio is the headline: it is the factor by which the baseline hit
//      rates overstated the amount of evidence behind them.
//
//   2. A PAIRED CLUSTER BOOTSTRAP on the DIFFERENCE (binary - weighted).
//      Resampling CLUSTERS, not signals, is what makes the interval honest.
//      Resampling signals would assume independence this data does not have
//      and produce an interval roughly sqrt(n_clusters) too narrow.
//
//   3. PAIRING. The two models fired on DIFFERENT bar sets — baseline caveat
//      [C6] states weighted-fired is not even a subset of binary-fired,
//      because each model owns its cooldown — so their own cluster partitions
//      do not line up and cannot be resampled independently. Resampling them
//      separately and subtracting the two intervals would answer a different
//      question (how would each rate vary alone) and overstate the certainty
//      of the DIFFERENCE, which is the only quantity anyone is asking about.
//      So both models are resampled over ONE shared partition of the bar
//      axis: the joint clustering of every signal from both models under the
//      same rule. Each joint cluster carries both models' members; each
//      bootstrap draw picks joint clusters with replacement and recomputes
//      BOTH hit rates on that same draw. The draw is paired by construction.
//
//   4. THE SAME ANALYSIS UNDER DEFINITION B (signed forward returns), with
//      the cluster gap threshold set to each horizon's OWN window length,
//      because that is the window that overlaps at that horizon. At 288 bars
//      it reduces to the Definition A partition, which is asserted rather
//      than assumed.
//
// ─── WHAT THIS DOES NOT DO ───────────────────────────────────────────────────
//
// It does not repair the underlying labels. It does not model costs, the
// missing spread filter, the cold-start warm-up, or the fact that the three
// grids are one observation reported three ways. It does not make the hit
// rates into a strategy. It bounds ONE thing precisely: how much the
// weighted-vs-binary gap could plausibly be sampling noise, given that
// overlapping forward windows are not independent trials.
//
// It also declines to produce an interval where none is meaningful: see
// MIN_CLUSTERS_FOR_INTERVAL below.
//
// ─── REUSE, NOT RE-DERIVATION ────────────────────────────────────────────────
//
// Signals and labels come from baseline.mjs's own runComparison() through its
// `sink` side channel (see that file's doc comment). A second wiring loop here
// would be free to drift from the first, and a comparison between two models
// is only meaningful if both were produced by identical wiring. The
// countMatch block in the output is a real assertion, not a formality: it
// compares this file's candidate counts and label counts against the numbers
// `baseline` prints for the same grid, and it FAILS LOUDLY on a mismatch.
//
// Usage:
//   node backtest/run.mjs compare [--timeframe <5m|1h|4h>] [--seed <n>]
//                                 [--bootstrap <n>] [--json]
// ============================================================================

import { DEFAULT_TIMEFRAME, getTimeframe } from "./timeframes.mjs";
import { loadDataset, runComparison } from "./baseline.mjs";
import {
  EXIT_RULE_DEFAULTS,
  FORWARD_RETURN_DEFAULTS,
  labelSignalsExitRule,
  labelSignalsForwardReturn,
} from "./modules/label.mjs";

const SCHEMA_VERSION = 1;

/** Bootstrap draws. 10,000 puts the 2.5th percentile well past Monte-Carlo noise. */
const DEFAULT_BOOTSTRAP = 10000;

/**
 * Fixed default seed. Printed on every run so a number in a report can be
 * reproduced exactly; `--seed` overrides it.
 */
const DEFAULT_SEED = 20260901;

/**
 * Below this many joint clusters, NO INTERVAL IS PRINTED.
 *
 * This is a reporting POLICY, not a theorem, and it is applied BEFORE any
 * number is looked at. The percentile interval of J clusters is estimated from
 * B draws over J resampling units; when J is small the endpoints are decided by
 * a handful of distinct resamples and the interval would print to two decimals
 * with a precision the data cannot support. Emitting "[-1.2, +6.1] pp" from
 * three clusters would be a fabricated claim about precision.
 *
 * It is deliberately the resampling unit that is counted, not n_signals: a grid
 * with 2 signals and 2 clusters is exactly the case this refuses.
 */
const MIN_CLUSTERS_FOR_INTERVAL = 10;

/**
 * Also required for an interval: at least this many win+loss labels on EACH
 * model in the scope. A model with zero resolved labels has no hit rate, so the
 * difference has no definition on that draw — see `undefinedDraws` in the
 * output, which counts draws discarded for exactly this reason.
 */
const MIN_RESOLVED_SIGNALS = 2;

const out = (s = "") => console.log(`compare: ${s}`);

// ─── Small helpers (mirrors baseline.mjs's formatting) ───────────────────────

const iso = (ms) => new Date(ms).toISOString();
const int = (v) => Number(v).toLocaleString("en-US");
const sgn = (v) => (v > 0 ? "+" : "") + Number(v).toLocaleString("en-US");
const round = (v, dp) => (v === null || v === undefined ? null : Number(v.toFixed(dp)));
const padL = (s, w) => String(s).padEnd(w);
const padR = (s, w) => String(s).padStart(w);

/** "+2.50 pp" / "-0.31 pp" / "n/a" — signed difference in percentage points. */
const pp = (v, dp = 2) => (v === null ? "n/a" : `${v > 0 ? "+" : ""}${v.toFixed(dp)} pp`);
/** Unsigned rate: "31.25%". */
const pct = (v, dp = 2) => (v === null ? "n/a" : `${v.toFixed(dp)}%`);

// ─── Clustering ──────────────────────────────────────────────────────────────

/**
 * Groups signals into maximal runs of OVERLAPPING forward windows.
 *
 * Signals are ordered by entry bar; two consecutive signals share a cluster
 * when the gap between their entry bars is strictly LESS than `horizon` bars,
 * because their [entry, entry + horizon] windows then share at least one bar.
 * A gap of exactly `horizon` means the windows abut without overlapping, so it
 * starts a new cluster — which is why the test is `<` and not `<=`, and why a
 * cluster boundary is reproducible rather than a matter of taste.
 *
 * Ties in `barIndex` cannot occur within one model (directional exclusivity
 * admits at most one side per bar) but the sort is stable and total regardless,
 * so the function is correct on any input.
 *
 * @param {Array<{barIndex: number}>} signals
 * @param {number} horizon forward-window length in bars.
 * @returns {Array<Array<object>>} clusters, in ascending bar order.
 */
export function clusterSignals(signals, horizon) {
  if (!Number.isInteger(horizon) || horizon < 1) {
    throw new RangeError(`clusterSignals: horizon must be an integer >= 1, got ${String(horizon)}`);
  }
  const ordered = [...signals].sort((a, b) => a.barIndex - b.barIndex);
  const clusters = [];
  let current = null;
  let previousBar = null;
  for (const signal of ordered) {
    if (previousBar === null || signal.barIndex - previousBar < horizon) {
      if (current === null) {
        current = [];
        clusters.push(current);
      }
    } else {
      current = [];
      clusters.push(current);
    }
    current.push(signal);
    previousBar = signal.barIndex;
  }
  return clusters;
}

/**
 * The PAIRED resampling unit: one partition of the bar axis shared by both
 * models, built from the union of their signals under the same overlap rule.
 *
 * Both models fired on different bar sets (baseline caveat [C6]), so their own
 * cluster boundaries generally disagree and there is no way to resample "the
 * k-th weighted cluster" against "the k-th binary cluster" — the pairing would
 * be an artefact of how the two lists happened to be ordered. Clustering the
 * UNION instead produces a partition that (a) never splits a signal away from
 * any other signal whose window it overlaps, within EITHER model, and (b) is
 * the same object for both models, so one draw resamples both simultaneously.
 *
 * Each returned cluster is `{ barStart, barEnd, weighted: [...], binary: [...] }`.
 *
 * NOTE ON THE COUNT RELATIONSHIP, since it is easy to assume wrongly: the joint
 * count is NOT guaranteed to be <= both models' own counts. A joint cluster may
 * hold only one model's signals, so it contributes to that model's own count
 * and not the other's, and the joint total can exceed the smaller own count.
 * What IS guaranteed — and what actually matters — is that no own-cluster of
 * either model is ever SPLIT across two joint clusters, so no overlapping pair
 * of either model is separated by a resampling boundary.
 */
/**
 * The largest gap between CONSECUTIVE signals of one model, in bars, and the
 * bar index where it occurs.
 *
 * This is the single number that explains a cluster count. A cluster count of
 * 1 is not a computation artefact — it means the largest gap anywhere in the
 * signal sequence is smaller than the horizon, so the whole run of signals is
 * one unbroken chain of overlapping windows. Reporting the gap lets a reader
 * check that claim against the cluster count instead of taking it on trust, and
 * it is the difference between "the collapse factor is 6.8x" and "these 307
 * observations are 45 observations".
 *
 * Returns nulls for fewer than two signals: a lone signal has no gap.
 */
export function maxSignalGap(signals) {
  const ordered = [...signals].sort((a, b) => a.barIndex - b.barIndex);
  if (ordered.length < 2) return { maxGap: null, atBar: null };
  let maxGap = -1;
  let atBar = null;
  for (let i = 1; i < ordered.length; i++) {
    const gap = ordered[i].barIndex - ordered[i - 1].barIndex;
    if (gap > maxGap) {
      maxGap = gap;
      atBar = ordered[i].barIndex;
    }
  }
  return { maxGap, atBar };
}

export function jointClusters(signals, horizon) {
  const union = [
    ...signals.weighted.map((s) => ({ model: "weighted", signal: s })),
    ...signals.binary.map((s) => ({ model: "binary", signal: s })),
  ].sort((a, b) => a.signal.barIndex - b.signal.barIndex);

  const clusters = [];
  let current = null;
  let previousBar = null;
  for (const entry of union) {
    if (previousBar === null || entry.signal.barIndex - previousBar < horizon) {
      if (current === null) {
        current = { barStart: entry.signal.barIndex, barEnd: entry.signal.barIndex, weighted: [], binary: [] };
        clusters.push(current);
      }
    } else {
      current = { barStart: entry.signal.barIndex, barEnd: entry.signal.barIndex, weighted: [], binary: [] };
      clusters.push(current);
    }
    current[entry.model].push(entry.signal);
    current.barEnd = entry.signal.barIndex;
    previousBar = entry.signal.barIndex;
  }
  return clusters;
}

/** Signals of one side only, both models — a scope's population. */
function scopeSignals(signals, side) {
  const pick = (list) => (side === "all" ? list : list.filter((s) => s.side === side));
  return { weighted: pick(signals.weighted), binary: pick(signals.binary) };
}

// ─── Cluster aggregates ──────────────────────────────────────────────────────

/**
 * Per-model win/loss totals per joint cluster, plus the whole-scope totals.
 *
 * `timeout` and `insufficient_data` are counted so the reader can see they
 * exist, and are EXCLUDED from the denominator — hit rate is win / (win + loss)
 * and never anything else. Folding a timeout into loss here would be the single
 * easiest way to make this report lie, so it is not done even quietly.
 */
function definitionAAggregates(joint, labels) {
  const win = { weighted: 0, binary: 0 };
  const loss = { weighted: 0, binary: 0 };
  const timeout = { weighted: 0, binary: 0 };
  const insufficient = { weighted: 0, binary: 0 };

  const perCluster = joint.map((cluster) => {
    const cell = {
      weighted: { win: 0, loss: 0 },
      binary: { win: 0, loss: 0 },
    };
    for (const model of ["weighted", "binary"]) {
      for (const signal of cluster[model]) {
        const label = labels[model].get(signal.barIndex).label;
        if (label === "win") {
          cell[model].win += 1;
          win[model] += 1;
        } else if (label === "loss") {
          cell[model].loss += 1;
          loss[model] += 1;
        } else if (label === "timeout") {
          timeout[model] += 1;
        } else {
          insufficient[model] += 1;
        }
      }
    }
    return cell;
  });

  const rate = (w, l) => (w + l > 0 ? (w / (w + l)) * 100 : null);
  return {
    perCluster,
    totals: {
      weighted: {
        signals: win.weighted + loss.weighted + timeout.weighted + insufficient.weighted,
        win: win.weighted,
        loss: loss.weighted,
        timeout: timeout.weighted,
        insufficient_data: insufficient.weighted,
        hitRatePercent: round(rate(win.weighted, loss.weighted), 4),
      },
      binary: {
        signals: win.binary + loss.binary + timeout.binary + insufficient.binary,
        win: win.binary,
        loss: loss.binary,
        timeout: timeout.binary,
        insufficient_data: insufficient.binary,
        hitRatePercent: round(rate(win.binary, loss.binary), 4),
      },
    },
  };
}

/**
 * Per-model sum and count of observed signed forward returns, per joint
 * cluster, at ONE horizon. Unobserved horizons (label.mjs returns null) are
 * excluded from both sum and count rather than counted as 0 — 0 is a real
 * answer meaning "price did not move".
 */
function definitionBAggregates(joint, returns, horizon) {
  const perCluster = joint.map((cluster) => {
    const cell = {
      weighted: { sum: 0, count: 0 },
      binary: { sum: 0, count: 0 },
    };
    for (const model of ["weighted", "binary"]) {
      for (const signal of cluster[model]) {
        const value = returns[model].get(signal.barIndex)[horizon];
        if (value === null || value === undefined) continue;
        cell[model].sum += value;
        cell[model].count += 1;
      }
    }
    return cell;
  });

  const mean = (sum, count) => (count > 0 ? sum / count : null);
  return {
    perCluster,
    totals: {
      weighted: {
        observed: perCluster.reduce((a, c) => a + c.weighted.count, 0),
        unobserved: joint.reduce((a, c) => a + c.weighted.length, 0) -
          perCluster.reduce((a, c) => a + c.weighted.count, 0),
        meanPercent: round(
          mean(
            perCluster.reduce((a, c) => a + c.weighted.sum, 0),
            perCluster.reduce((a, c) => a + c.weighted.count, 0),
          ),
          4,
        ),
      },
      binary: {
        observed: perCluster.reduce((a, c) => a + c.binary.count, 0),
        unobserved: joint.reduce((a, c) => a + c.binary.length, 0) -
          perCluster.reduce((a, c) => a + c.binary.count, 0),
        meanPercent: round(
          mean(
            perCluster.reduce((a, c) => a + c.binary.sum, 0),
            perCluster.reduce((a, c) => a + c.binary.count, 0),
          ),
          4,
        ),
      },
    },
  };
}

// ─── Deterministic RNG ───────────────────────────────────────────────────────

/**
 * mulberry32 — a small, fully specified 32-bit PRNG.
 *
 * Written out rather than imported because `Math.random()` cannot be seeded and
 * an unseeded bootstrap cannot be reproduced, which would make every interval
 * in this report a one-off claim. No dependency: it is six lines of integer
 * arithmetic. The sequence depends only on the seed, so two runs with the same
 * seed produce byte-identical output.
 */
export function makeRng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Percentile of an ALREADY-SORTED array, linear interpolation between ranks. */
export function percentileOfSorted(sorted, p) {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// ─── The paired cluster bootstrap ────────────────────────────────────────────

/**
 * Resamples JOINT clusters with replacement and returns the distribution of the
 * hit-rate DIFFERENCE (binary - weighted) in percentage points.
 *
 * The pairing is the whole point: each draw selects `joint.length` cluster
 * indices ONCE and applies them to both models, so a draw in which an
 * unusually lucky stretch of bars was selected moves both rates together. That
 * is what a shared price series does, and it is why an unpaired bootstrap —
 * resampling each model's own clusters separately — would report a spuriously
 * tight interval for the difference.
 *
 * A draw whose denominator is zero for EITHER model has no defined difference
 * (that model's resampled population resolved to zero win+loss labels). Such
 * draws are counted in `undefinedDraws` and excluded from the interval rather
 * than being silently coerced to 0 or to ±100; the count is reported so a
 * reader can see how often the statistic was undefined.
 */
export function pairedClusterBootstrap(perCluster, iterations, seed) {
  const n = perCluster.length;
  if (n === 0) {
    return { draws: 0, undefinedDraws: 0, lo: null, hi: null, mean: null, excludesZero: null };
  }

  const rng = makeRng(seed);
  const diffs = [];
  let undefinedDraws = 0;

  for (let it = 0; it < iterations; it++) {
    let wW = 0;
    let wL = 0;
    let bW = 0;
    let bL = 0;
    for (let k = 0; k < n; k++) {
      const cell = perCluster[Math.floor(rng() * n)];
      wW += cell.weighted.win;
      wL += cell.weighted.loss;
      bW += cell.binary.win;
      bL += cell.binary.loss;
    }
    const wDenom = wW + wL;
    const bDenom = bW + bL;
    if (wDenom === 0 || bDenom === 0) {
      undefinedDraws += 1;
      continue;
    }
    diffs.push((bW / bDenom - wW / wDenom) * 100);
  }

  const sorted = [...diffs].sort((a, b) => a - b);
  const lo = percentileOfSorted(sorted, 0.025);
  const hi = percentileOfSorted(sorted, 0.975);
  const mean = sorted.length > 0 ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null;

  return {
    draws: sorted.length,
    undefinedDraws,
    lo: round(lo, 4),
    hi: round(hi, 4),
    mean: round(mean, 4),
    // An interval that merely TOUCHES zero does not exclude it. Strict.
    excludesZero: lo === null || hi === null ? null : lo > 0 || hi < 0,
  };
}

/** The same machinery for a Definition B mean difference, in percentage points. */
function pairedClusterBootstrapMeans(perCluster, iterations, seed) {
  const n = perCluster.length;
  if (n === 0) {
    return { draws: 0, undefinedDraws: 0, lo: null, hi: null, mean: null, excludesZero: null };
  }

  const rng = makeRng(seed);
  const diffs = [];
  let undefinedDraws = 0;

  for (let it = 0; it < iterations; it++) {
    let wSum = 0;
    let wN = 0;
    let bSum = 0;
    let bN = 0;
    for (let k = 0; k < n; k++) {
      const cell = perCluster[Math.floor(rng() * n)];
      wSum += cell.weighted.sum;
      wN += cell.weighted.count;
      bSum += cell.binary.sum;
      bN += cell.binary.count;
    }
    if (wN === 0 || bN === 0) {
      undefinedDraws += 1;
      continue;
    }
    diffs.push(bSum / bN - wSum / wN);
  }

  const sorted = [...diffs].sort((a, b) => a - b);
  const lo = percentileOfSorted(sorted, 0.025);
  const hi = percentileOfSorted(sorted, 0.975);
  const mean = sorted.length > 0 ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null;

  return {
    draws: sorted.length,
    undefinedDraws,
    lo: round(lo, 4),
    hi: round(hi, 4),
    mean: round(mean, 4),
    excludesZero: lo === null || hi === null ? null : lo > 0 || hi < 0,
  };
}

// ─── Count match against baseline ────────────────────────────────────────────

/**
 * Asserts this file's populations against the ones `baseline` reports.
 *
 * This is the guard the brief asks for and it is load-bearing: if the sink
 * wiring, the label call, or the timeframe plumbing here were wrong, the
 * intervals below would be computed over the wrong population and would look
 * perfectly plausible. Every check below compares a number computed HERE
 * against the number baseline.mjs computed INDEPENDENTLY from the same
 * dataset, per model and per side.
 */
function verifyCounts(baselineResult, sink, timeframe) {
  const checks = [];
  const expect = (name, actual, expected) => {
    checks.push({ name, actual, expected, ok: actual === expected });
  };

  for (const model of ["weighted", "binary"]) {
    const fired = baselineResult.models[model].signals.fired;
    const labelled = baselineResult.models[model].definitionA.signals;
    expect(`${model} fired signals == definitionA population (${timeframe})`, labelled, fired.total);
    expect(`${model} long fired (${timeframe})`, fired.long, fired.total - fired.short);
  }

  expect(
    `weighted candidate long (${timeframe})`,
    sink.scoreCandidateCounts.long,
    baselineResult.models.weighted.scores.candidate.long.count,
  );
  expect(
    `weighted candidate short (${timeframe})`,
    sink.scoreCandidateCounts.short,
    baselineResult.models.weighted.scores.candidate.short.count,
  );

  for (const model of ["weighted", "binary"]) {
    const observed = sink.exitRule[model].counts;
    const reported = baselineResult.models[model].definitionA.counts;
    for (const key of ["win", "loss", "timeout", "insufficient_data"]) {
      expect(`${model} ${key} (${timeframe})`, observed[key], reported[key]);
    }
    for (const side of ["long", "short"]) {
      expect(
        `${model} ${side} hit rate (${timeframe})`,
        sink.exitRuleBySide[model][side].hitRatePercent,
        baselineResult.models[model].definitionA.bySide[side].hitRatePercent,
      );
    }
    for (const horizon of FORWARD_RETURN_DEFAULTS.horizons) {
      expect(
        `${model} Definition B observed @${horizon} (${timeframe})`,
        sink.forwardReturns[model].observed[String(horizon)],
        baselineResult.models[model].definitionB.horizons[String(horizon)].observed,
      );
    }
  }

  return {
    ok: checks.every((c) => c.ok),
    checksRun: checks.length,
    failures: checks.filter((c) => !c.ok),
    checks,
  };
}

// ─── One scope (combined, long, or short) ────────────────────────────────────

/**
 * Full analysis of one side-scope.
 *
 * Reports THREE cluster counts, which are easy to confuse and must not be:
 *
 *   own clusters   each model clustered on its OWN signals. The headline
 *                  collapse ratio: how far n_signals overstates the evidence.
 *   joint clusters the shared partition used for resampling. Never SPLITS an
 *                  own-cluster of either model, though its COUNT may exceed one
 *                  model's own count, because a joint cluster can hold only one
 *                  model's signals.
 */
function analyseScope(signals, labels, returns, side, horizon, iterations, seed) {
  const scoped = scopeSignals(signals, side);
  const ownClusters = {
    weighted: clusterSignals(scoped.weighted, horizon),
    binary: clusterSignals(scoped.binary, horizon),
  };
  const joint = jointClusters(scoped, horizon);
  const aggA = definitionAAggregates(joint, labels);
  const aggB = definitionBAggregates(joint, returns, horizon);
  const gapW = maxSignalGap(scoped.weighted);
  const gapB = maxSignalGap(scoped.binary);

  const resolved = (model) => aggA.totals[model].win + aggA.totals[model].loss;

  const eligible =
    joint.length >= MIN_CLUSTERS_FOR_INTERVAL &&
    resolved("weighted") >= MIN_RESOLVED_SIGNALS &&
    resolved("binary") >= MIN_RESOLVED_SIGNALS;

  const bootstrap = eligible
    ? pairedClusterBootstrap(aggA.perCluster, iterations, seed)
    : {
        draws: 0,
        undefinedDraws: 0,
        lo: null,
        hi: null,
        mean: null,
        excludesZero: null,
      };

  const observedDifference =
    aggA.totals.weighted.hitRatePercent === null || aggA.totals.binary.hitRatePercent === null
      ? null
      : round(aggA.totals.binary.hitRatePercent - aggA.totals.weighted.hitRatePercent, 4);

  return {
    side,
    clusterHorizonBars: horizon,
    eligible,
    ineligibility: eligible
      ? null
      : {
          jointClusters: joint.length,
          minClustersRequired: MIN_CLUSTERS_FOR_INTERVAL,
          weightedResolved: resolved("weighted"),
          binaryResolved: resolved("binary"),
          minResolvedRequired: MIN_RESOLVED_SIGNALS,
        },
    signals: {
      weighted: scoped.weighted.length,
      binary: scoped.binary.length,
    },
    ownClusters: {
      weighted: ownClusters.weighted.length,
      binary: ownClusters.binary.length,
    },
    // The largest gap between consecutive signals of each model, against the
    // horizon. A gap below the horizon is what keeps a cluster unbroken, so this
    // is the arithmetic behind every cluster count above — and it is why a
    // cluster count of 1 is a property of the signal DENSITY, not of the
    // bootstrap.
    maxGapBars: { weighted: gapW.maxGap, binary: gapB.maxGap },
    maxGapAtBar: { weighted: gapW.atBar, binary: gapB.atBar },
    collapse: {
      weighted: {
        signals: scoped.weighted.length,
        clusters: ownClusters.weighted.length,
        signalsPerCluster:
          ownClusters.weighted.length > 0
            ? round(scoped.weighted.length / ownClusters.weighted.length, 2)
            : null,
      },
      binary: {
        signals: scoped.binary.length,
        clusters: ownClusters.binary.length,
        signalsPerCluster:
          ownClusters.binary.length > 0
            ? round(scoped.binary.length / ownClusters.binary.length, 2)
            : null,
      },
    },
    jointClusters: joint.length,
    definitionA: {
      weighted: aggA.totals.weighted,
      binary: aggA.totals.binary,
      observedDifferencePp: observedDifference,
      bootstrap,
    },
    definitionB: {
      weighted: aggB.totals.weighted,
      binary: aggB.totals.binary,
      observedDifferencePp:
        aggB.totals.weighted.meanPercent === null || aggB.totals.binary.meanPercent === null
          ? null
          : round(aggB.totals.binary.meanPercent - aggB.totals.weighted.meanPercent, 4),
      bootstrap: eligible
        ? pairedClusterBootstrapMeans(aggB.perCluster, iterations, seed)
        : { draws: 0, undefinedDraws: 0, lo: null, hi: null, mean: null, excludesZero: null },
    },
  };
}

// ─── The run ─────────────────────────────────────────────────────────────────

/**
 * Runs the cluster bootstrap on one timeframe.
 *
 * `runComparison` is baseline.mjs's own function, so the signals and labels
 * here are the same objects `baseline` reports, not a re-derivation. The only
 * thing this adds is the cluster structure and the resampling.
 */
async function runAnalysis(options = {}) {
  const tf = options.tf ?? getTimeframe(DEFAULT_TIMEFRAME);
  const iterations = options.bootstrap ?? DEFAULT_BOOTSTRAP;
  const seed = options.seed ?? DEFAULT_SEED;
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

    // Baseline's own pass, with a side channel that hands over its raw signal
    // lists, its label view, and its candidate counts. `baselineResult` is the
    // exact object `node backtest/run.mjs baseline` prints.
    let sink = null;
    const baselineResult = runComparison(candles, meta, tf, (payload) => {
      sink = payload;
    });
    if (sink === null) {
      throw new Error("baseline.mjs did not invoke the sink — its wiring changed, refusing to report");
    }

    // Re-label HERE, independently, through label.mjs, and index by barIndex so
    // a cluster aggregate never depends on list order. The count match below
    // proves this agrees with baseline's own labelling.
    const labelCandles = sink.labelCandles;
    const exitRule = {
      weighted: labelSignalsExitRule(labelCandles, sink.signals.weighted),
      binary: labelSignalsExitRule(labelCandles, sink.signals.binary),
    };
    const forward = {
      weighted: labelSignalsForwardReturn(labelCandles, sink.signals.weighted),
      binary: labelSignalsForwardReturn(labelCandles, sink.signals.binary),
    };

    const byBar = (batch, side) => {
      const map = new Map();
      for (const result of batch.results) {
        if (side === "all" || result.side === side) map.set(result.barIndex, result);
      }
      return map;
    };
    const exitRuleBySide = {
      weighted: { long: byBar(exitRule.weighted, "long"), short: byBar(exitRule.weighted, "short") },
      binary: { long: byBar(exitRule.binary, "long"), short: byBar(exitRule.binary, "short") },
    };

    // Baseline's per-side hit rates, recomputed here from the same maps, for
    // the count match. win/(win+loss), timeout and insufficient excluded.
    const sideSummary = (batch, side) => {
      const counts = { win: 0, loss: 0, timeout: 0, insufficient_data: 0 };
      for (const r of batch.results) {
        if (side !== "all" && r.side !== side) continue;
        counts[r.label] += 1;
      }
      const denom = counts.win + counts.loss;
      return {
        ...counts,
        hitRatePercent: denom > 0 ? round((counts.win / denom) * 100, 2) : null,
      };
    };

    const observed = {
      weighted: {
        long: sideSummary(exitRule.weighted, "long"),
        short: sideSummary(exitRule.weighted, "short"),
      },
      binary: {
        long: sideSummary(exitRule.binary, "long"),
        short: sideSummary(exitRule.binary, "short"),
      },
    };

    const forwardReturns = {
      weighted: {},
      binary: {},
    };
    for (const model of ["weighted", "binary"]) {
      const observedByHorizon = {};
      const unobservedByHorizon = {};
      for (const h of FORWARD_RETURN_DEFAULTS.horizons) {
        let seen = 0;
        let missing = 0;
        for (const r of forward[model].results) {
          const v = r.returns[h];
          if (v === null || v === undefined) missing += 1;
          else seen += 1;
        }
        observedByHorizon[String(h)] = seen;
        unobservedByHorizon[String(h)] = missing;
      }
      forwardReturns[model] = {
        observed: observedByHorizon,
        unobserved: unobservedByHorizon,
      };
    }

    const countMatch = verifyCounts(
      baselineResult,
      {
        scoreCandidateCounts: sink.scoreCandidateCounts,
        exitRule: {
          weighted: {
            counts: exitRule.weighted.counts,
            total: exitRule.weighted.total,
          },
          binary: { counts: exitRule.binary.counts, total: exitRule.binary.total },
        },
        exitRuleBySide: observed,
        forwardReturns,
      },
      tf.id,
    );

    if (!countMatch.ok) {
      const detail = countMatch.failures
        .map((f) => `${f.name}: this file ${String(f.actual)} vs baseline ${String(f.expected)}`)
        .join("; ");
      throw new Error(
        `candidate/label counts do NOT match baseline on ${tf.id} — refusing to report an ` +
          `interval computed over a different population than the baseline report: ${detail}`,
      );
    }

    const horizon = EXIT_RULE_DEFAULTS.maxHorizonBars;

    // Per-side label maps, so a scope's aggregate never sees the other side.
    const labelsFor = (side) => ({
      weighted: side === "all" ? new Map(exitRule.weighted.results.map((r) => [r.barIndex, r])) : exitRuleBySide.weighted[side],
      binary: side === "all" ? new Map(exitRule.binary.results.map((r) => [r.barIndex, r])) : exitRuleBySide.binary[side],
    });
    const returnsFor = (side) => {
      const pick = (batch) => {
        const map = new Map();
        for (const r of batch.results) {
          if (side === "all" || r.side === side) map.set(r.barIndex, r.returns);
        }
        return map;
      };
      return { weighted: pick(forward.weighted), binary: pick(forward.binary) };
    };

    const scopes = {};
    for (const side of ["all", "long", "short"]) {
      scopes[side] = analyseScope(
        sink.signals,
        labelsFor(side),
        returnsFor(side),
        side,
        horizon,
        iterations,
        seed,
      );
    }

    // Definition B, per horizon. The cluster gap threshold is that horizon's
    // OWN window length — the window that overlaps at that horizon — so at 288
    // bars this reduces to the Definition A partition, which is asserted below
    // rather than assumed.
    const definitionB = [];
    for (const h of FORWARD_RETURN_DEFAULTS.horizons) {
      const a = analyseScope(
        sink.signals,
        labelsFor("all"),
        returnsFor("all"),
        "all",
        h,
        iterations,
        seed,
      );
      definitionB.push({
        horizonBars: h,
        jointClusters: a.jointClusters,
        eligible: a.eligible,
        weighted: a.definitionB.weighted,
        binary: a.definitionB.binary,
        observedDifferencePp: a.definitionB.observedDifferencePp,
        bootstrap: a.definitionB.bootstrap,
        matchesDefinitionAPartition: h === horizon ? a.jointClusters === scopes.all.jointClusters : null,
      });
    }

    const combined = scopes.all;
    const verdictText = combined.eligible
      ? combined.definitionA.bootstrap.excludesZero
        ? `The 95% paired cluster-bootstrap interval for binary - weighted EXCLUDES zero: ` +
          `[${pp(combined.definitionA.bootstrap.lo)}, ${pp(combined.definitionA.bootstrap.hi)}].`
        : `The 95% paired cluster-bootstrap interval for binary - weighted DOES NOT EXCLUDE zero: ` +
          `[${pp(combined.definitionA.bootstrap.lo)}, ${pp(combined.definitionA.bootstrap.hi)}]. ` +
          `The observed ${pp(combined.definitionA.observedDifferencePp)} is not distinguishable from noise ` +
          `on this grid.`
      : `No interval is reported: the resampling unit on this grid is too small ` +
        `(${combined.jointClusters} joint clusters, ${combined.signals.weighted} weighted signals).`;

    const result = {
      schemaVersion: SCHEMA_VERSION,
      ok: true,
      generatedBy: "backtest/compare.mjs (cluster bootstrap, T11 addendum)",
      verdict: verdictText,
      dataset: {
        path: tf.datasetRel,
        bars: candles.length,
        firstIso: iso(candles[0].t),
        lastIso: iso(candles[candles.length - 1].t),
        spanDays: round((candles[candles.length - 1].t - candles[0].t) / 86400000, 4),
        gapCount: meta?.gapCount ?? null,
      },
      timeframe: {
        id: tf.id,
        scopeWord: tf.scopeWord,
        nativeStepMs: tf.stepMs,
        minutesPerBar: tf.minutesPerBar,
      },
      config: {
        seed,
        bootstrapIterations: iterations,
        clusterHorizonBars: horizon,
        forwardHorizons: [...FORWARD_RETURN_DEFAULTS.horizons],
        hitRateDefinition: "win / (win + loss); timeout and insufficient_data excluded from the denominator",
        resamplingUnit: "joint clusters of overlapping forward windows, shared by both models (paired)",
        rng: "mulberry32, seeded; identical seed gives byte-identical output",
        minClustersForInterval: MIN_CLUSTERS_FOR_INTERVAL,
        minResolvedSignalsForInterval: MIN_RESOLVED_SIGNALS,
      },
      countMatch,
      scopes,
      definitionB,
      caveats: [
        "CLUSTER BOOTSTRAP, NOT A TEST OF THE WEIGHTS: this bounds sampling noise in the " +
          "hit-rate difference on ONE grid. It is not a portfolio simulation, not a p-value, " +
          "and it does not make either model profitable — labels are gross of the commission " +
          "and slippage the spec's own D.4 strategy declares, and the D.3 spread filter is " +
          "absent from both models.",
        "THE RESAMPLING UNIT IS A BAR CLUSTER, NOT A SIGNAL: n_signals assumes independent " +
          "trials and overstates the evidence by the collapse ratio printed above. Resampling " +
          "signals would produce an interval about sqrt(n_clusters) too narrow.",
        "THE TWO MODELS ARE CLUSTERED INDEPENDENTLY AND PAIRED THROUGH THE JOINT PARTITION: " +
          "weighted-fired is not a subset of binary-fired (baseline caveat [C6]), so their own " +
          "cluster boundaries do not align and cannot be resampled against each other; one " +
          "shared partition of the bar axis is used for both, which never SPLITS an own-cluster " +
          "of either model. The joint count is not necessarily <= both own counts, because a " +
          "joint cluster may hold only one model's signals.",
        "ONE GRID IS ONE OBSERVATION: the 5m, 1h and 4h runs describe the same BTC/USD price " +
          "action at different resolutions and their errors are strongly correlated. Agreement " +
          "across grids is not corroboration and supports no combined sample size.",
        "AN INTERVAL IS REFUSED, NOT APPROXIMATED, WHERE THE CLUSTER COUNT IS TOO SMALL: " +
          `below ${MIN_CLUSTERS_FOR_INTERVAL} joint clusters the percentile endpoints are ` +
          "decided by a handful of resamples and would print a precision the data cannot " +
          "support. Those grids report their counts and no interval.",
        "timeout AND insufficient_data ARE NEVER FOLDED INTO win OR loss: they are counted " +
          "and excluded from every denominator, and a bootstrap draw that resolves to zero " +
          "win+loss labels on either model is counted as an undefined draw, not coerced.",
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

// ─── Human-readable report ──────────────────────────────────────────────────
//
// Shape follows cognitive-doc-design: the VERDICT first, because it is the
// answer, then the collapse table that explains why the question needed asking,
// then the numbers, then the checks, then what must not be concluded.

function printReport(r) {
  const c = r.scopes.all;

  // ── Verdict, line 1 ────────────────────────────────────────────────────────
  out(r.verdict);
  out("");

  out(
    `dataset  ${r.dataset.path} — ${int(r.dataset.bars)} bars, ` +
      `${r.dataset.firstIso} .. ${r.dataset.lastIso}, ${r.dataset.spanDays} days, gaps ` +
      `${r.dataset.gapCount ?? "?"}`,
  );
  out(
    `config   seed ${r.config.seed}, bootstrap ${int(r.config.bootstrapIterations)} draws, ` +
      `cluster horizon ${r.config.clusterHorizonBars} bars, horizons ` +
      `${r.config.forwardHorizons.join("/")}, min clusters for an interval ` +
      `${r.config.minClustersForInterval}`,
  );
  out(`         ${r.config.hitRateDefinition}`);
  out(`         resampling unit: ${r.config.resamplingUnit}`);
  out("");

  // ── 1. The collapse ────────────────────────────────────────────────────────
  out(
    `1. CLUSTER COLLAPSE — the count of independent-looking observations vs the ` +
      `number of non-overlapping forward windows`,
  );
  out("");
  out(
    `  ${padL("scope", 8)}${padL("model", 10)}${padR("signals", 9)}${padR("clusters", 10)}` +
      `${padR("per cluster", 12)}${padR("max gap", 10)}`,
  );
  const collapseRow = (scopeName, scope) => {
    for (const model of ["weighted", "binary"]) {
      const k = scope.collapse[model];
      out(
        `  ${padL(scopeName, 8)}${padL(model, 10)}${padR(int(k.signals), 9)}` +
          `${padR(int(k.clusters), 10)}${padR(k.signalsPerCluster === null ? "n/a" : k.signalsPerCluster.toFixed(2), 12)}` +
          `${padR(scope.maxGapBars[model] === null ? "n/a" : int(scope.maxGapBars[model]), 10)}`,
      );
    }
    out(`  ${padL("", 8)}${padL("joint", 10)}${padR("", 9)}${padR(int(scope.jointClusters), 10)}  (the shared resampling unit)`);
  };
  collapseRow("all", r.scopes.all);
  collapseRow("long", r.scopes.long);
  collapseRow("short", r.scopes.short);
  out("");
  out(
    `  "clusters" for each model is that model clustered on its OWN signals. The joint` +
      ` row is the`,
  );
  out(
    "  coarser partition both models are resampled over — it must not split any overlapping " +
      "pair of",
  );
  out(
    "  either model. It is NOT necessarily <= both own counts: a joint cluster may hold only " +
      "one",
  );
  out(
    "  model's signals, so it contributes to that model's count and not the other's.",
  );
  out("");
  out(
    `  "max gap" is the largest distance between consecutive signals of that model, in bars,`,
  );
  out(
    "  against a horizon of " +
      `${r.config.clusterHorizonBars}. A cluster count of 1 means every consecutive gap is`,
  );
  out(
    "  SMALLER than the horizon — one unbroken chain of overlapping windows. That is a fact",
  );
  out(
    "  about signal DENSITY on this grid, not about the bootstrap, and it is the number that",
  );
  out("  makes a cluster count checkable rather than asserted.");

  // ── 2. Definition A ────────────────────────────────────────────────────────
  out("");
  out(
    `2. DEFINITION A — D.4 hit rate, and the paired cluster bootstrap of ` +
      `binary - weighted (${r.config.clusterHorizonBars}-bar windows)`,
  );
  out("");
  const aHead =
    `  ${padL("scope", 8)}${padL("model", 10)}${padR("signals", 9)}${padR("win", 7)}` +
    `${padR("loss", 7)}${padR("timeout", 8)}${padR("insuff.", 8)}${padR("hit rate", 10)}`;
  out(aHead);
  for (const [scopeName, scope] of [["all", r.scopes.all], ["long", r.scopes.long], ["short", r.scopes.short]]) {
    for (const model of ["weighted", "binary"]) {
      const t = scope.definitionA[model];
      out(
        `  ${padL(scopeName, 8)}${padL(model, 10)}${padR(int(t.signals), 9)}${padR(int(t.win), 7)}` +
          `${padR(int(t.loss), 7)}${padR(int(t.timeout), 8)}${padR(int(t.insufficient_data), 8)}` +
          `${padR(pct(t.hitRatePercent), 10)}`,
      );
    }
    const b = scope.definitionA.bootstrap;
    out(
      `  ${padL("", 8)}${padL("d (b-w)", 10)}${padR("", 9)}${padR("", 7)}${padR("", 7)}` +
        `${padR("", 8)}${padR("", 8)}${padR(pp(scope.definitionA.observedDifferencePp), 10)}  observed`,
    );
    out(
      `  ${padL("", 8)}${padL("95% CI", 10)}` +
        `${padR("", 9)}${padR("", 7)}${padR("", 7)}${padR("", 8)}${padR("", 8)}` +
        `${padR(scope.eligible ? `[${pp(b.lo)}, ${pp(b.hi)}]` : "not reported", 10)}  ` +
        `${int(b.draws)} draws${b.undefinedDraws > 0 ? `, ${int(b.undefinedDraws)} undefined` : ""}`,
    );
    out(
      `  ${padL("", 8)}${padL("excludes 0", 10)}${padR("", 9)}${padR("", 7)}${padR("", 7)}` +
        `${padR("", 8)}${padR("", 8)}${padR(scope.eligible ? (b.excludesZero ? "YES" : "NO") : "n/a", 10)}`,
    );
    if (!scope.eligible) {
      const why = scope.ineligibility;
      out(
        `  ${padL("", 8)}${padL("", 10)}  too small to interval: ${why.jointClusters} joint ` +
          `clusters (need ${why.minClustersRequired}), weighted resolved ${why.weightedResolved} ` +
          `/ binary resolved ${why.binaryResolved} (need ${why.minResolvedRequired})`,
      );
    }
    out("");
  }
  out(
    "  hit rate = win / (win + loss); timeout and insufficient_data are counted above and " +
      "excluded from every denominator.",
  );

  // ── 3. Definition B ────────────────────────────────────────────────────────
  out("");
  out(
    `3. DEFINITION B — mean signed forward return, paired cluster bootstrap of the mean ` +
      `difference`,
  );
  out("");
  out(
    `  cluster gap threshold is each horizon's OWN window length — at ${r.config.clusterHorizonBars} ` +
      `bars it reduces to the Definition A partition`,
  );
  out(
    `    (${r.definitionB.find((d) => d.horizonBars === r.config.clusterHorizonBars)?.matchesDefinitionAPartition ?? "n/a"} ` +
      `vs ${int(r.scopes.all.jointClusters)} joint clusters).`,
  );
  out("");
  out(
    `  ${padL("horizon", 8)}${padR("clusters", 9)}${padR("w mean %", 10)}${padR("b mean %", 10)}` +
      `${padR("d mean pp", 11)}${padR("95% CI of d", 24)}${padR("excl 0", 8)}`,
  );
  for (const d of r.definitionB) {
    out(
      `  ${padL(`${d.horizonBars}`, 8)}${padR(int(d.jointClusters), 9)}` +
        `${padR(d.weighted.meanPercent === null ? "n/a" : d.weighted.meanPercent.toFixed(4), 10)}` +
        `${padR(d.binary.meanPercent === null ? "n/a" : d.binary.meanPercent.toFixed(4), 10)}` +
        `${padR(pp(d.observedDifferencePp, 4), 11)}` +
        `${padR(d.eligible ? `[${pp(d.bootstrap.lo, 4)}, ${pp(d.bootstrap.hi, 4)}]` : "not reported", 24)}` +
        `${padR(d.eligible ? (d.bootstrap.excludesZero ? "YES" : "NO") : "n/a", 8)}`,
    );
  }
  out("");
  out(
    "  unobserved horizons are excluded from both sum and count, never counted as 0 " +
      "(label.mjs returns null for a close that does not exist).",
  );

  // ── 4. Checks ──────────────────────────────────────────────────────────────
  out("");
  out(`4. CHECKS — this file's populations against \`baseline\` on ${r.timeframe.id}`);
  out("");
  out(
    `  candidate and label counts match baseline EXACTLY: ${r.countMatch.ok ? "yes" : "NO"} ` +
      `(${r.countMatch.checksRun} comparisons, ${r.countMatch.failures.length} failing)`,
  );
  if (r.countMatch.failures.length > 0) {
    for (const f of r.countMatch.failures) {
      out(`    FAIL ${f.name}: this file ${String(f.actual)} vs baseline ${String(f.expected)}`);
    }
  }
  out(
    `  signals and labels come from baseline.mjs's own runComparison() through its sink ` +
      `side channel,`,
  );
  out(
    "  not from a second wiring loop — so a drift between this report and `baseline` is a " +
      "count mismatch",
  );
  out("  above, not a silently different population.");
  out("");
  out(`  ${padL("model", 10)}${padL("scope", 8)}${padR("signals", 9)}${padR("win", 7)}${padR("loss", 7)}${padR("timeout", 8)}${padR("insuff.", 8)}${padR("hit rate", 10)}`);
  for (const model of ["weighted", "binary"]) {
    for (const scopeName of ["long", "short"]) {
      const t = r.scopes[scopeName].definitionA[model];
      out(
        `  ${padL(model, 10)}${padL(scopeName, 8)}${padR(int(t.signals), 9)}${padR(int(t.win), 7)}` +
          `${padR(int(t.loss), 7)}${padR(int(t.timeout), 8)}${padR(int(t.insufficient_data), 8)}` +
          `${padR(pct(t.hitRatePercent), 10)}`,
      );
    }
  }

  // ── 5. What must not be concluded ──────────────────────────────────────────
  out("");
  out("5. WHAT A READER MUST NOT CONCLUDE FROM THESE NUMBERS");
  out("");
  r.caveats.forEach((cv, i) => out(`  [C${i}] ${cv}`));
}

// ─── Entry point ─────────────────────────────────────────────────────────────

/**
 * @param {{json?: boolean, tf?: object, seed?: number, bootstrap?: number}} options
 * @returns {Promise<number>} process exit code (0 ok, 1 failed).
 */
export async function runCompare(options = {}) {
  return runAnalysis(options);
}

/**
 * Parses `--seed <n>` and `--bootstrap <n>` out of an argv array.
 *
 * The LAST occurrence wins, so a repeated `--seed 1 --seed 1` is a well-formed
 * (if redundant) command rather than an error, and `--seed 1 --seed 2` means 2.
 * A flag with no value, or a non-integer value, throws — silently defaulting
 * would mean a reader believed they had pinned the seed when they had not, and
 * an unseeded bootstrap is not reproducible.
 */
export function parseCompareFlags(argv) {
  const readInt = (flag) => {
    let value = null;
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === flag) {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) {
          throw new Error(`${flag} requires a value`);
        }
        value = next;
      } else if (argv[i].startsWith(`${flag}=`)) {
        value = argv[i].slice(flag.length + 1);
      }
    }
    if (value === null) return undefined;
    if (!/^\d+$/.test(value.trim())) {
      throw new Error(`${flag} must be a non-negative integer, got "${value}"`);
    }
    return Number(value.trim());
  };

  return {
    seed: readInt("--seed"),
    bootstrap: readInt("--bootstrap"),
  };
}
#!/usr/bin/env node
// ============================================================================
// LiquidityFlowAuse — Backtest Harness Entrypoint
// ----------------------------------------------------------------------------
// Zero-dependency runner for the weight-calibration feature
// (see odd/tasks/weight-calibration.md). Runs on bare `node`, exactly the way
// scripts/build.mjs already runs: no package.json, no node_modules, no npm.
// Node's built-in fetch and stdlib only.
//
// The Signal Engine consumes D1, 4H and 1H context, and one D1 bar needs 288
// five-minute bars, so the dataset target is >= 6 months of 5m history
// (~52,560 bars) before any calibration claim is made.
//
// Usage:
//   node backtest/run.mjs fetch      download BTC/USD OHLCV from Bitstamp
//   node backtest/run.mjs validate   T8 fidelity gate (backtest/gate.mjs)
//   node backtest/run.mjs baseline   T10/T11 baselines (backtest/baseline.mjs),
//                                    add --json for the same numbers as JSON
//   node backtest/run.mjs diagnose   liquidity tier diagnostic
//                                    (backtest/tier-diagnostic.mjs), --json too
//   node backtest/run.mjs compare    paired cluster bootstrap on the baseline
//                                    difference (backtest/compare.mjs):
//                                    --seed <n>, --bootstrap <n>, --json
//   node backtest/run.mjs ratio      exit-ratio (target/stop) analysis on an
//                                    INDEPENDENT sample — one signal per
//                                    288-bar window (backtest/ratio.mjs):
//                                    --seed <n>, --bootstrap <n>, --json
//                                    --horizon <bars> re-runs the analysis at a
//                                    different hold (default 288 = shipped)
//   node backtest/run.mjs search     T12 weight search (not implemented yet)
//
// Every data-reading subcommand takes `--timeframe <5m|1h|4h>` and defaults to
// 5m, so every pre-slice-7 command line keeps working unchanged. `validate` is
// 5m-only BY CONSTRUCTION and refuses any other value (see gateTimeframeRefusal).
//
// Historical market data lives under backtest/data/ and is gitignored.
// It is never committed.
// ============================================================================

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runGate } from "./gate.mjs";
import { runBaseline } from "./baseline.mjs";
import { parseCompareFlags, runCompare } from "./compare.mjs";
import { parseRatioFlags, parseRatioHorizonFlag, runRatio } from "./ratio.mjs";
import { runTierDiagnostic } from "./tier-diagnostic.mjs";
import {
  DEFAULT_TIMEFRAME,
  TIMEFRAME_IDS,
  TimeframeError,
  getTimeframe,
  parseTimeframeFlag,
  resolveStatus,
  targetVerdict,
} from "./timeframes.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ─── Bitstamp API facts (verified against the live endpoint, not remembered) ──
//
//   GET https://www.bitstamp.net/api/v2/ohlc/btcusd/?step=300&limit=1000&end=<sec>
//
// Verified observations, all reproduced against the live API before this file
// was written:
//
//   * `step` and `limit` are REQUIRED. Requesting without them returns
//     HTTP 400 with a `validation-error` naming both fields.
//   * `limit` is capped at 1000. `limit=1500` and `limit=5000` are rejected
//     with `validation-error`, so six months of 5m bars (~52,560) takes at
//     least 53 requests.
//   * **`start` is ignored.** `start=1790787000&end=1790790000&limit=1000`
//     returned 1000 candles reaching back to 1790490300, far before `start`.
//     `start=9999999999` returned the newest candle. Pagination is driven
//     exclusively by `end` + `limit`.
//   * Window semantics: the newest `limit` candles with timestamp <= `end`,
//     returned in ASCENDING order. `sort=asc` and `sort=desc` produce
//     byte-identical results, so the `sort` parameter is not used here.
//   * `exclude_current_candle=1` is honored and drops the in-progress bar.
//   * Response shape: {"data":{"pair":"BTC/USD","ohlc":[{"timestamp","open",
//     "high","low","close","volume"}]}} — every field is a STRING.
//   * History is deep and real: `end=<now - 14 years>` still returns candles
//     (BTC/USD at 12.86 in October 2012), so six months is obtainable.
//   * Native 86400s bars start at exact UTC midnights (timestamp % 86400 == 0),
//     and native 14400s bars at exact UTC 4-hour boundaries. Bitstamp bar
//     boundaries are therefore UTC — that is the timezone recorded below.
//
// Backward pagination works by moving `end` one step before the oldest candle
// held on disk: end = oldest - 300. Because the window is "newest <= end",
// that always yields exactly the next older page when data is dense.
// ─────────────────────────────────────────────────────────────────────────────

const EXCHANGE = "bitstamp";
const EXCHANGE_NAME = "Bitstamp";
const MARKET = "btcusd";
const SYMBOL = "BTC/USD";
const TIMEZONE = "UTC";

// The chart's DISPLAY timezone was never recorded in docs/VALIDATION.md as a
// single value: the DST and weekend readings name `America/New_York` (:107,
// :171), while other positions are annotated in UTC-6 (:52, :53, :94-:96).
// "exchange" used to be written here — but that is the indicator's
// sessionTimezone INPUT default (src/modules/session-markers.pine), not
// something read off the chart, so asserting it in the metadata claimed a
// measurement that was never made. Null means "not recorded"; what IS
// measured is the bar-boundary timezone, TIMEZONE (UTC), below.
const CHART_TIMEZONE = null;

const OHLC_URL = `https://www.bitstamp.net/api/v2/ohlc/${MARKET}/`;
const PAGE_LIMIT = 1000;

// The step size, the coverage target and the dataset path are NOT constants
// here: they live in the per-timeframe table in backtest/timeframes.mjs, which
// also carries the reasoning behind each target. Every function below takes the
// resolved timeframe as an argument rather than reading a module-level constant,
// so two timeframes can never share a verdict, a file path, or a step size.
//
//   5m  step 300    62,000 bars / 215 days   (T8 fidelity-gate coverage)
//   1h  step 3600   43,000 bars / 1825 days  (five years)
//   4h  step 14400  10,900 bars / 1825 days  (five years)
//
// The `end` pagination step below is `tf.stepSec`, not 300: on a 1h dataset a
// 300-second decrement would re-request the same page forever.
//
// Bounded retries: 4 attempts with exponential backoff (500/1000/2000 ms).
// Never retry forever, and never retry silently — every failed attempt is
// printed together with the request that caused it.
const MAX_ATTEMPTS = 4;
const RETRY_BASE_MS = 500;
const PAGE_DELAY_MS = 250;

const SCHEMA_VERSION = 1;
const MAX_REPORTED_GAPS = 50;

const DATA_DIR = join(ROOT, "backtest", "data");

// ─── Small helpers ───────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (ms) => new Date(ms).toISOString();
const grouped = (n) => Number(n).toLocaleString("en-US");

function minOf(values) {
  let out = Infinity;
  for (const v of values) if (v < out) out = v;
  return out;
}

function maxOf(values) {
  let out = -Infinity;
  for (const v of values) if (v > out) out = v;
  return out;
}

/** Writes via a temp file so an interrupted write cannot leave a half file. */
async function writeFileAtomic(path, contents) {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, contents, "utf8");
  await rename(tmp, path);
}

// ─── Dataset analysis ────────────────────────────────────────────────────────

/**
 * Sorts ascending and de-duplicates by timestamp.
 *
 * Gaps are REPORTED elsewhere, never hidden: a hole in the history would
 * silently bias every baseline that follows, and a harness that papers over
 * it is worse than no harness at all.
 */
function normalize(raw) {
  const byTs = new Map();
  for (const candle of raw) byTs.set(candle.t, candle);
  return [...byTs.values()].sort((a, b) => a.t - b.t);
}

function analyze(candles, tf) {
  const gaps = [];
  let gapCount = 0;
  let missingBars = 0;
  let offGridBars = 0;

  for (let i = 0; i < candles.length; i++) {
    // Grid check against THIS timeframe's step. On 1h a bar landing on a whole
    // hour is on-grid; on 5m the same timestamp is not, because 3600 % 300 is
    // 0 but the check is the other way round. Quoting 5m's verdict for a 1h
    // dataset would be exactly the kind of assumed dataset fact caveat C8
    // forbids.
    if (candles[i].t % tf.stepMs !== 0) offGridBars++;
    if (i === 0) continue;

    const delta = candles[i].t - candles[i - 1].t;
    if (delta <= tf.stepMs) continue;

    const missing = Math.max(0, Math.round(delta / tf.stepMs) - 1);
    gapCount++;
    missingBars += missing;
    if (gaps.length < MAX_REPORTED_GAPS) {
      gaps.push({
        afterMs: candles[i - 1].t,
        beforeMs: candles[i].t,
        missingBars: missing,
      });
    }
  }

  return { gapCount, missingBars, offGridBars, gaps };
}

/**
 * Builds the self-describing metadata record written next to the dataset.
 * `candles` must already be sorted ascending and de-duplicated.
 */
function buildMeta(candles, tf, status, requestsTotal, duplicates) {
  const a = analyze(candles, tf);

  const firstMs = candles.length ? candles[0].t : null;
  const lastMs = candles.length ? candles[candles.length - 1].t : null;
  const spanDays =
    firstMs === null ? 0 : (lastMs - firstMs) / 86400000;

  return {
    schemaVersion: SCHEMA_VERSION,
    status,
    exchange: EXCHANGE,
    exchangeName: EXCHANGE_NAME,
    endpoint: OHLC_URL,
    symbol: SYMBOL,
    market: MARKET,
    timeframe: tf.id,
    timeframeSeconds: tf.stepSec,
    timezone: TIMEZONE,
    timezoneNote:
      "Bitstamp native daily bars start at exact UTC midnights, so bar " +
      "boundaries are UTC; timestamps are epoch milliseconds (absolute).",
    chartTimezone: CHART_TIMEZONE,
    chartTimezoneNote:
      "Not recorded: docs/VALIDATION.md names America/New_York as the chart timezone " +
      "for the DST and weekend readings (:107, :171) but annotates other chart " +
      "positions in UTC-6 (:52, :53, :94-:96). The indicator's sessionTimezone input " +
      "default is \"exchange\" — an input default, never measured off the chart. " +
      "Bar boundaries are UTC (timezone field above), which is measured.",
    timeUnit: "epoch_ms",
    count: candles.length,
    firstTimestampMs: firstMs,
    lastTimestampMs: lastMs,
    firstTimestampIso: firstMs === null ? null : iso(firstMs),
    lastTimestampIso: lastMs === null ? null : iso(lastMs),
    spanDays: Number(spanDays.toFixed(4)),
    gapCount: a.gapCount,
    missingBars: a.missingBars,
    offGridBars: a.offGridBars,
    gaps: a.gaps,
    duplicatesDropped: duplicates,
    requestsTotal,
    targetBars: tf.targetBars,
    targetDays: tf.targetDays,
    // Recomputed here rather than derived from `status`, so the two can never
    // disagree on disk.
    targetMet: targetVerdict(candles.length, spanDays, tf).met,
    updatedAt: new Date().toISOString(),
  };
}

// ─── HTTP ────────────────────────────────────────────────────────────────────

/**
 * One request. Returns {ok:true, ohlc} or {ok:false, error} — never throws,
 * so the caller can decide how loudly to report and how often to retry.
 */
async function attemptOnce(url) {
  let response;
  try {
    response = await fetch(url, { headers: { accept: "application/json" } });
  } catch (err) {
    return { ok: false, error: `network error: ${err.message}` };
  }

  let text;
  try {
    text = await response.text();
  } catch (err) {
    return { ok: false, error: `HTTP ${response.status}: body unreadable (${err.message})` };
  }

  if (!response.ok) {
    return {
      ok: false,
      error: `HTTP ${response.status} ${response.statusText} - ${text.slice(0, 200)}`,
    };
  }

  // A truncated body fails JSON parsing; that is exactly the loud signal we
  // want instead of silently accepting half a page.
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return {
      ok: false,
      error: `response is not valid JSON (${text.length} bytes) - ${text.slice(0, 160)}`,
    };
  }

  const ohlc = payload?.data?.ohlc;
  if (!Array.isArray(ohlc)) {
    return { ok: false, error: `unexpected response shape - ${text.slice(0, 200)}` };
  }

  return { ok: true, ohlc };
}

/** Bounded retries with backoff. Every failed attempt prints its request. */
async function requestPage(tf, endSec) {
  // `step` is the timeframe's own step. The response array is `data.ohlc` —
  // NOT `data.ohlcv` — and every field is a STRING (attemptOnce below reads
  // exactly that shape). Both facts were verified against the live endpoint.
  const url =
    `${OHLC_URL}?step=${tf.stepSec}&limit=${PAGE_LIMIT}` +
    `&end=${endSec}&exclude_current_candle=1`;

  let lastError = "unknown error";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const result = await attemptOnce(url);

    if (result.ok) return { ohlc: result.ohlc, url };

    lastError = result.error;
    console.log(`fetch: attempt ${attempt}/${MAX_ATTEMPTS} failed - ${lastError}`);
    console.log(`fetch:   request: ${url}`);

    if (attempt < MAX_ATTEMPTS) {
      const backoff = RETRY_BASE_MS * 2 ** (attempt - 1);
      console.log(`fetch:   retrying in ${backoff}ms`);
      await sleep(backoff);
    }
  }

  throw new Error(
    `giving up after ${MAX_ATTEMPTS} attempts\n` +
      `fetch:   last request: ${url}\n` +
      `fetch:   last error:   ${lastError}`,
  );
}

/** Converts Bitstamp's string fields to numbers, failing loudly on garbage. */
function parseCandles(ohlc, url) {
  const out = [];

  for (const row of ohlc) {
    const t = Number(row.timestamp) * 1000;
    const o = Number(row.open);
    const h = Number(row.high);
    const l = Number(row.low);
    const c = Number(row.close);
    const v = Number(row.volume);

    if (![t, o, h, l, c, v].every(Number.isFinite)) {
      throw new Error(
        `malformed candle in ${url}\nfetch:   row: ${JSON.stringify(row)}`,
      );
    }

    out.push({ t, o, h, l, c, v });
  }

  return out;
}

// ─── State on disk ───────────────────────────────────────────────────────────

async function loadState(tf) {
  let meta = null;
  let candles = [];

  // Per-timeframe paths. Each timeframe owns its own dataset AND its own meta
  // file, which is what makes the per-timeframe verdict below possible: a
  // complete 5m fetch cannot mark a 1h fetch complete, because a 1h fetch never
  // reads the 5m meta file.
  try {
    meta = JSON.parse(await readFile(tf.metaPath, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.log(`fetch: warning: metadata unreadable (${err.message}) - treating as partial`);
    }
    meta = null;
  }

  try {
    const raw = JSON.parse(await readFile(tf.datasetPath, "utf8"));
    if (raw && Array.isArray(raw.candles)) {
      candles = raw.candles;
    } else {
      console.log("fetch: warning: dataset has an unexpected shape - starting over");
    }
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.log(`fetch: warning: dataset unreadable (${err.message}) - starting over`);
    }
  }

  // The dataset is the source of truth. If it disagrees with the metadata the
  // metadata is stale, so a "complete" claim made over missing data is
  // downgraded to "partial" rather than trusted.
  if (meta && candles.length !== meta.count) {
    console.log(
      `fetch: warning: dataset holds ${candles.length} candles but metadata ` +
        `claims ${meta.count} - trusting the dataset`,
    );
    meta = { ...meta, status: "partial" };
  }

  // The target verdict is only meaningful against the TARGET_* constants in
  // effect RIGHT NOW. Both meta.targetMet and meta.status are written under
  // whatever target existed at that moment, so raising the target leaves a
  // cached "complete" that short-circuits cmdFetch and prints MET against an
  // unchanged dataset — a false pass with no network activity to expose it.
  // Recompute from the candles on disk; never trust the stored claim.
  if (meta && candles.length > 0) {
    let oldest = Infinity;
    let newest = -Infinity;
    for (const c of candles) {
      if (c.t < oldest) oldest = c.t;
      if (c.t > newest) newest = c.t;
    }
    const spanDays = (newest - oldest) / 86400000;
    const verdict = targetVerdict(candles.length, spanDays, tf);
    const recomputed = verdict.met;

    if (meta.targetMet !== undefined && meta.targetMet !== recomputed) {
      console.log(
        `fetch: warning: metadata claims targetMet=${meta.targetMet} but the ` +
          `${tf.id} dataset holds ${candles.length} candles over ` +
          `${spanDays.toFixed(4)} days against the current ${tf.id} target of ` +
          `>= ${tf.targetDays} days / >= ${grouped(tf.targetBars)} bars - ` +
          "recomputing from the dataset",
      );
    }

    // The stored verdict was written under WHATEVER target existed at that
    // moment, so it says nothing about the constants in effect now. This is
    // recomputed per timeframe, which is the whole point: the 5m meta file is
    // never consulted for a 1h verdict.
    const status = resolveStatus(meta.status, recomputed);

    meta = { ...meta, targetMet: recomputed, status };
  }

  return { meta, candles };
}

// ─── Report ──────────────────────────────────────────────────────────────────

function printReport(tf, meta, requestsThisRun, headline) {
  const target = `>= ${tf.targetDays} days AND >= ${grouped(tf.targetBars)} bars`;

  console.log("");
  console.log("fetch: dataset report");
  if (headline) console.log(`fetch:   ${headline}`);
  console.log(`fetch:   source            ${EXCHANGE_NAME} (${EXCHANGE}), public OHLC, no credentials`);
  console.log(`fetch:   symbol            ${SYMBOL} (${MARKET})`);
  console.log(`fetch:   timeframe         ${tf.id} (${tf.stepSec}s)`);
  console.log(`fetch:   timezone          ${TIMEZONE} (epoch milliseconds)`);
  console.log(
    `fetch:   chart timezone    not recorded — docs/VALIDATION.md names America/New_York for ` +
      `the DST/weekend readings and annotates others in UTC-6 (bar boundaries: ${TIMEZONE})`,
  );
  console.log(`fetch:   status            ${meta.status}`);
  console.log(`fetch:   first timestamp   ${meta.firstTimestampIso}  (${meta.firstTimestampMs} ms)`);
  console.log(`fetch:   last timestamp    ${meta.lastTimestampIso}  (${meta.lastTimestampMs} ms)`);
  console.log(`fetch:   span              ${meta.spanDays} days`);
  console.log(`fetch:   candle count      ${grouped(meta.count)}`);
  console.log(`fetch:   gap count         ${meta.gapCount} (${grouped(meta.missingBars)} missing bars)`);
  console.log(`fetch:   off-grid bars     ${meta.offGridBars}`);
  console.log(`fetch:   duplicates dropped ${grouped(meta.duplicatesDropped)}`);
  console.log(
    `fetch:   HTTP requests     ${grouped(requestsThisRun)} this run, ` +
      `${grouped(meta.requestsTotal)} total`,
  );

  if (meta.gapCount > 0 && meta.gaps.length) {
    console.log(`fetch:   first gaps (showing ${meta.gaps.length} of ${meta.gapCount}):`);
    for (const g of meta.gaps) {
      console.log(
        `fetch:     ${iso(g.afterMs)} -> ${iso(g.beforeMs)} : ` +
          `${grouped(g.missingBars)} missing bars`,
      );
    }
  }

  console.log(`fetch:   target (${target})  ${meta.targetMet ? "MET" : "NOT MET"}`);
  console.log("");
}

// ─── fetch ───────────────────────────────────────────────────────────────────

async function cmdFetch(tf) {
  await mkdir(DATA_DIR, { recursive: true });

  const state = await loadState(tf);
  const { meta, candles } = state;

  // Complete dataset already on disk: say so and touch no network at all.
  // This verdict was recomputed in loadState against THIS timeframe's target,
  // so it is idempotent per timeframe and a complete 5m fetch never short-
  // circuits a 1h fetch (they read different meta files entirely).
  if (meta && meta.status === "complete" && candles.length > 0) {
    printReport(tf, meta, 0, "already complete - nothing to download");
    console.log("fetch: no HTTP requests made.");
    return 0;
  }

  // Beginning of available history already reached without meeting the target.
  // Retrying cannot manufacture older candles, so this reports honestly
  // instead of re-walking the same range and claiming progress.
  if (meta && meta.status === "shortfall" && candles.length > 0) {
    printReport(
      tf,
      meta,
      0,
      `shortfall - Bitstamp has no older ${tf.id} data to give; target not met`,
    );
    console.log("fetch: no HTTP requests made.");
    return 1;
  }

  const byTs = new Map(candles.map((c) => [c.t, c]));
  const expectedPages = Math.ceil(tf.targetBars / PAGE_LIMIT);

  // Resume cursor: one step before the oldest candle already held. With no
  // data on disk, start just before the current candle. The decrement is the
  // timeframe's own step — a hard-coded 300 here would re-request the same
  // page forever on a 1h or 4h dataset.
  let endSec = byTs.size
    ? Math.floor(minOf(byTs.keys()) / 1000) - tf.stepSec
    : Math.floor(Date.now() / 1000) - tf.stepSec;

  let requestsThisRun = 0;
  let requestsTotal = meta?.requestsTotal ?? 0;
  let duplicates = meta?.duplicatesDropped ?? 0;
  let status = "partial";

  console.log(
    `fetch: resuming from ${grouped(byTs.size)} candles on disk` +
      (byTs.size ? `, next end=${endSec}` : ", starting from now"),
  );

  for (;;) {
    const { ohlc, url } = await requestPage(tf, endSec);
    requestsThisRun++;
    requestsTotal++;

    const page = parseCandles(ohlc, url).filter((c) => c.t <= endSec * 1000);

    if (page.length === 0) {
      const finalSpan = byTs.size
        ? (maxOf(byTs.keys()) - minOf(byTs.keys())) / 86400000
        : 0;
      status = targetVerdict(byTs.size, finalSpan, tf).met
        ? "complete"
        : "shortfall";
      console.log(
        `fetch: no candles at or before ${iso(endSec * 1000)} - ` +
          `end of available history (status: ${status})`,
      );
      break;
    }

    for (const candle of page) {
      if (byTs.has(candle.t)) duplicates++;
      byTs.set(candle.t, candle);
    }

    const sorted = normalize([...byTs.values()]);
    byTs.clear();
    for (const candle of sorted) byTs.set(candle.t, candle);

    const oldest = minOf(byTs.keys());
    const newest = maxOf(byTs.keys());
    const spanDays = (newest - oldest) / 86400000;
    const count = byTs.size;
    const targetMet = targetVerdict(count, spanDays, tf).met;

    status = targetMet ? "complete" : "partial";

    const dataset = { schemaVersion: SCHEMA_VERSION, candles: [...byTs.values()] };
    const pageMeta = buildMeta(dataset.candles, tf, status, requestsTotal, duplicates);
    await writeFileAtomic(tf.datasetPath, JSON.stringify(dataset));
    await writeFileAtomic(tf.metaPath, JSON.stringify(pageMeta, null, 2) + "\n");

    console.log(
      `fetch: page ${requestsThisRun}/${expectedPages} - ` +
        `${grouped(count)} candles, oldest ${iso(oldest)}, ` +
        `${spanDays.toFixed(1)} days, ${grouped(requestsTotal)} requests total`,
    );

    if (targetMet) break;

    // Step back one bar beyond the oldest candle held and ask for the next
    // older page. Because `start` is ignored, `end` is the only lever.
    endSec = Math.floor(oldest / 1000) - tf.stepSec;
    await sleep(PAGE_DELAY_MS);
  }

  // Persist the final status on every exit path. Without this, a run that
  // reached the end of available history would leave "partial" on disk and
  // a later run would re-walk a range that cannot grow.
  const dataset = { schemaVersion: SCHEMA_VERSION, candles: [...byTs.values()] };
  const lastMeta = buildMeta(dataset.candles, tf, status, requestsTotal, duplicates);
  await writeFileAtomic(tf.datasetPath, JSON.stringify(dataset));
  await writeFileAtomic(tf.metaPath, JSON.stringify(lastMeta, null, 2) + "\n");

  printReport(
    tf,
    lastMeta,
    requestsThisRun,
    lastMeta.status === "complete"
      ? "fetched"
      : "INCOMPLETE - reporting exactly what was obtained",
  );

  return lastMeta.status === "complete" ? 0 : 1;
}

// ─── Stubs ───────────────────────────────────────────────────────────────────
//
// A stub that exits 0 would let a later check read a lie: "validate passed"
// when nothing ran. Every stub names the task that will implement it and
// exits 1.

function stub(task) {
  console.log(`run: not implemented yet — ${task}`);
  process.exitCode = 1;
}

// ─── Usage ───────────────────────────────────────────────────────────────────

function usage() {
  console.log("usage: node backtest/run.mjs <subcommand> [--timeframe <" +
    `${TIMEFRAME_IDS.join("|")}>]`);
  console.log("");
  console.log("  fetch      download BTC/USD OHLCV candles from Bitstamp");
  console.log("  validate   fidelity gate against docs/VALIDATION.md (T8) — 5m ONLY");
  console.log("  baseline   weighted + binary baselines (T10/T11), --json for JSON output");
  console.log("  diagnose   liquidity tier diagnostic, --json for JSON output");
  console.log(
    "  compare    paired cluster bootstrap on the baseline hit-rate difference,",
  );
  console.log(
    "  ratio      exit-ratio (target/stop) analysis on an INDEPENDENT sample —",
  );
  console.log(
    "             one signal per 288-bar window, break-even, expectancy surface.",
  );
  console.log(
    "             --seed <n> / --bootstrap <n> pin the RNG, --json for JSON output",
  );
  console.log(
    "             --horizon <bars> re-runs the whole analysis at a different hold",
  );
  console.log(
    "             (default 288, which is the shipped Definition A). One number drives",
  );
  console.log(
    "             BOTH the exit scan and the window partition. A shorter horizon is a",
  );
  console.log(
    "             DIFFERENT TRADE, not a bigger sample: it truncates trades that would",
  );
  console.log(
    "             have resolved later. Omitting the flag reproduces the 288-bar report",
  );
  console.log("             exactly and adds no power or horizon section.");
  console.log("  search     weight search with holdout evaluation (T12)");
  console.log("");
  console.log(
    `  --timeframe   native grid for fetch/baseline/diagnose/compare/ratio ` +
      `(${TIMEFRAME_IDS.join(", ")}); default "${DEFAULT_TIMEFRAME}".`,
  );
  console.log(
    "               Changing it changes the NATIVE series, not just a label:",
  );
  console.log(
    "               atrChart becomes ATR(14) OF THAT GRID, and the HTF tiers",
  );
  console.log("               aggregate on a different grid. See the report header.");
  console.log(
    "               validate refuses any value other than 5m: its readings",
  );
  console.log("               were captured on a 5m grid (gate disagreement D1).");
  console.log("");
  console.log(`Historical data is written to backtest/data/ (gitignored).`);
  process.exitCode = 1;
}

/**
 * The T8 fidelity gate is 5m-ONLY BY CONSTRUCTION.
 *
 * Every Class A reading in docs/VALIDATION.md was captured on a 5m grid, and
 * gate disagreement D1 shows the legend series is arithmetically IMPOSSIBLE on
 * a 4H grid (the three session opens sit on three different mod-4 residues).
 * Replaying those readings on 1h or 4h would not "test the gate more broadly" —
 * it would compare the recorded 5m values against readings that cannot exist on
 * the new grid, and a FAIL would mean nothing while a PASS would be an artefact
 * of the harness silently substituting a different question.
 *
 * So it refuses loudly and explains why, rather than producing a meaningless
 * comparison a reader might quote.
 */
function gateTimeframeRefusal(tf) {
  console.log("");
  console.log(`validate: REFUSED — this gate is 5m-only by construction.`);
  console.log("");
  console.log(
    `  Every Class A reading in docs/VALIDATION.md was captured on a 5m grid.`,
  );
  console.log(
    `  You asked for --timeframe ${tf.id}. Replaying those recorded values on a`,
  );
  console.log(
    `  ${tf.id} grid would not widen the gate: it would compare 5m readings`,
  );
  console.log(
    `  against bars on a grid they cannot exist on (disagreement D1 — the three`,
  );
  console.log(
    `  session opens sit on three different mod-4 residues, so no 4H bar set`,
  );
  console.log(`  contains all three).`);
  console.log("");
  console.log(`  Run it as:  node backtest/run.mjs validate`);
  console.log(
    `  Use --timeframe for: fetch, baseline, diagnose (those have no such`,
  );
  console.log(`  restriction — see \`node backtest/run.mjs\` with no arguments).`);
  console.log("");
  process.exitCode = 1;
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

const SUBCOMMANDS = ["fetch", "validate", "baseline", "diagnose", "compare", "search"];

// Subcommands added AFTER the baseline six. Kept as a separate list rather than
// appended to SUBCOMMANDS so that the six-name literal above stays exactly what
// it has always been: smoke.mjs asserts that literal verbatim in order to prove
// each of those names is still registered and dispatchable. Widening it in place
// would edit an assertion to make a new test pass, which is the one move this
// harness must never make. `ratio` is registered through DISPATCHABLE below, so
// a typo in it still refuses to dispatch.
const EXTRA_SUBCOMMANDS = ["ratio"];
const DISPATCHABLE = [...SUBCOMMANDS, ...EXTRA_SUBCOMMANDS];
const subcommand = process.argv[2];

// The flag is parsed BEFORE dispatch so an invalid --timeframe fails loudly on
// every subcommand, including the ones it does not apply to. Silently ignoring
// it on `validate` would be the worst outcome: the caller believes they gated a
// different grid when in fact they gated 5m.
let tf = null;
try {
  tf = parseTimeframeFlag(process.argv);
} catch (err) {
  if (err instanceof TimeframeError) {
    console.log("");
    console.log(`run: ${err.message}`);
    console.log("");
    usage();
  } else {
    throw err;
  }
}

if (subcommand === undefined || !DISPATCHABLE.includes(subcommand)) {
  if (subcommand !== undefined) console.log(`run: unknown subcommand: ${subcommand}`);
  usage();
} else if (tf === null) {
  // The parse already failed and printed; usage() set the exit code.
} else {
  try {
    if (subcommand === "fetch") {
      process.exitCode = await cmdFetch(tf);
    } else if (subcommand === "validate") {
      // 5m-only by construction — refusing is the correct behaviour, not a
      // limitation. See gateTimeframeRefusal() above.
      if (tf.id !== DEFAULT_TIMEFRAME) {
        gateTimeframeRefusal(tf);
      } else {
        process.exitCode = await runGate();
      }
    } else if (subcommand === "baseline") {
      process.exitCode = await runBaseline({
        json: process.argv.includes("--json"),
        tf,
      });
    } else if (subcommand === "compare") {
      // The seed and draw count are PARSED HERE and passed explicitly rather
      // than read from argv inside compare.mjs, so the flags that shape the
      // numbers a report quotes are visible at the dispatch site.
      const compareFlags = parseCompareFlags(process.argv);
      process.exitCode = await runCompare({
        json: process.argv.includes("--json"),
        tf,
        seed: compareFlags.seed,
        bootstrap: compareFlags.bootstrap,
      });
    } else if (subcommand === "ratio") {
      // Same flag grammar as `compare` (--seed / --bootstrap, LAST occurrence
      // wins) so one bootstrap convention covers every seeded report in the
      // harness; parseRatioFlags is that parser, re-exported under this
      // subcommand's name rather than reimplemented so the two cannot drift.
      //
      // --horizon is parsed by its OWN parser rather than by the shared one,
      // because the two flags have opposite validity rules: a seed of 0 and a
      // draw count of 0 are legal, a horizon of 0 is not. Widening
      // parseCompareFlags to carry it would have loosened a tested parser shared
      // with `compare` to accommodate a rule only this subcommand needs.
      const ratioFlags = parseRatioFlags(process.argv);
      process.exitCode = await runRatio({
        json: process.argv.includes("--json"),
        tf,
        seed: ratioFlags.seed,
        bootstrap: ratioFlags.bootstrap,
        horizon: parseRatioHorizonFlag(process.argv),
      });
    } else if (subcommand === "diagnose") {
      process.exitCode = await runTierDiagnostic({
        json: process.argv.includes("--json"),
        tf,
      });
    } else if (subcommand === "search") {
      stub("T12 weight search");
    }
  } catch (err) {
    console.log("");
    console.log(`${subcommand}: FAILED - ${err.message}`);
    if (subcommand === "fetch") {
      console.log("");
      console.log("fetch: partial data, if any, is on disk marked as partial.");
      console.log("fetch: re-run `node backtest/run.mjs fetch` to resume.");
    }
    process.exitCode = 1;
  }
}

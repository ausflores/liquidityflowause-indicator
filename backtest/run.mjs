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
//   node backtest/run.mjs fetch      download BTC/USD 5m OHLCV from Bitstamp
//   node backtest/run.mjs validate   T8 fidelity gate (backtest/gate.mjs)
//   node backtest/run.mjs baseline   T10/T11 baselines (backtest/baseline.mjs),
//                                    add --json for the same numbers as JSON
//   node backtest/run.mjs search     T12 weight search (not implemented yet)
//
// Historical market data lives under backtest/data/ and is gitignored.
// It is never committed.
// ============================================================================

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runGate } from "./gate.mjs";
import { runBaseline } from "./baseline.mjs";

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
const TIMEFRAME = "5m";
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
const STEP_SEC = 300;
const STEP_MS = STEP_SEC * 1000;
const PAGE_LIMIT = 1000;

// Six-month target. Both conditions must hold before any calibration claim.
// Fidelity-gate coverage target (T8), not merely a "six months" target.
// docs/VALIDATION.md's earliest confirmed crosshair reading is 7 Mar 2026
// (DST transitions, L56), and the Signal Engine's D1 context needs the day
// before it too. 215 days back from the last bar reaches ~27 Feb 2026, which
// covers 7 Mar 2026 and 10 Mar 2026 with margin. 62,000 bars == 215.3 days
// at 288 five-minute bars per day, so the two constants stay consistent.
// Do not "simplify" this back to 182.6: doing so silently drops the DST
// gate readings, and nothing in the fetch output would say so.
const TARGET_BARS = 62000;
const TARGET_DAYS = 215.0;

// Bounded retries: 4 attempts with exponential backoff (500/1000/2000 ms).
// Never retry forever, and never retry silently — every failed attempt is
// printed together with the request that caused it.
const MAX_ATTEMPTS = 4;
const RETRY_BASE_MS = 500;
const PAGE_DELAY_MS = 250;

const SCHEMA_VERSION = 1;
const MAX_REPORTED_GAPS = 50;

const DATA_DIR = join(ROOT, "backtest", "data");
const DATASET_PATH = join(DATA_DIR, `${MARKET}-${TIMEFRAME}.json`);
const META_PATH = join(DATA_DIR, `${MARKET}-${TIMEFRAME}.meta.json`);

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

function analyze(candles) {
  const gaps = [];
  let gapCount = 0;
  let missingBars = 0;
  let offGridBars = 0;

  for (let i = 0; i < candles.length; i++) {
    if (candles[i].t % STEP_MS !== 0) offGridBars++;
    if (i === 0) continue;

    const delta = candles[i].t - candles[i - 1].t;
    if (delta <= STEP_MS) continue;

    const missing = Math.max(0, Math.round(delta / STEP_MS) - 1);
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
function buildMeta(candles, status, requestsTotal, duplicates) {
  const a = analyze(candles);

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
    timeframe: TIMEFRAME,
    timeframeSeconds: STEP_SEC,
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
    targetBars: TARGET_BARS,
    targetDays: TARGET_DAYS,
    targetMet:
      candles.length >= TARGET_BARS && spanDays >= TARGET_DAYS,
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
async function requestPage(endSec) {
  const url =
    `${OHLC_URL}?step=${STEP_SEC}&limit=${PAGE_LIMIT}` +
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

async function loadState() {
  let meta = null;
  let candles = [];

  try {
    meta = JSON.parse(await readFile(META_PATH, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.log(`fetch: warning: metadata unreadable (${err.message}) - treating as partial`);
    }
    meta = null;
  }

  try {
    const raw = JSON.parse(await readFile(DATASET_PATH, "utf8"));
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
    const recomputed = candles.length >= TARGET_BARS && spanDays >= TARGET_DAYS;

    if (meta.targetMet !== undefined && meta.targetMet !== recomputed) {
      console.log(
        `fetch: warning: metadata claims targetMet=${meta.targetMet} but the ` +
          `dataset holds ${candles.length} candles over ${spanDays.toFixed(4)} days ` +
          `against the current target of >= ${TARGET_DAYS} days / ` +
          `>= ${grouped(TARGET_BARS)} bars - recomputing from the dataset`,
      );
    }

    // "shortfall" is preserved: it records that Bitstamp has no older candles
    // to give, which recomputing the verdict cannot un-know. Only the
    // false "complete" needs downgrading.
    const status =
      meta.status === "shortfall" && !recomputed
        ? "shortfall"
        : recomputed
          ? "complete"
          : "partial";

    meta = { ...meta, targetMet: recomputed, status };
  }

  return { meta, candles };
}

// ─── Report ──────────────────────────────────────────────────────────────────

function printReport(meta, requestsThisRun, headline) {
  const target = `>= ${TARGET_DAYS} days AND >= ${grouped(TARGET_BARS)} bars`;

  console.log("");
  console.log("fetch: dataset report");
  if (headline) console.log(`fetch:   ${headline}`);
  console.log(`fetch:   source            ${EXCHANGE_NAME} (${EXCHANGE}), public OHLC, no credentials`);
  console.log(`fetch:   symbol            ${SYMBOL} (${MARKET})`);
  console.log(`fetch:   timeframe         ${TIMEFRAME} (${STEP_SEC}s)`);
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

async function cmdFetch() {
  await mkdir(DATA_DIR, { recursive: true });

  const state = await loadState();
  const { meta, candles } = state;

  // Complete dataset already on disk: say so and touch no network at all.
  if (meta && meta.status === "complete" && candles.length > 0) {
    printReport(meta, 0, "already complete - nothing to download");
    console.log("fetch: no HTTP requests made.");
    return 0;
  }

  // Beginning of available history already reached without meeting the target.
  // Retrying cannot manufacture older candles, so this reports honestly
  // instead of re-walking the same range and claiming progress.
  if (meta && meta.status === "shortfall" && candles.length > 0) {
    printReport(
      meta,
      0,
      "shortfall - Bitstamp has no older 5m data to give; target not met",
    );
    console.log("fetch: no HTTP requests made.");
    return 1;
  }

  const byTs = new Map(candles.map((c) => [c.t, c]));
  const expectedPages = Math.ceil(TARGET_BARS / PAGE_LIMIT);

  // Resume cursor: one step before the oldest candle already held. With no
  // data on disk, start just before the current candle.
  let endSec = byTs.size
    ? Math.floor(minOf(byTs.keys()) / 1000) - STEP_SEC
    : Math.floor(Date.now() / 1000) - STEP_SEC;

  let requestsThisRun = 0;
  let requestsTotal = meta?.requestsTotal ?? 0;
  let duplicates = meta?.duplicatesDropped ?? 0;
  let status = "partial";

  console.log(
    `fetch: resuming from ${grouped(byTs.size)} candles on disk` +
      (byTs.size ? `, next end=${endSec}` : ", starting from now"),
  );

  for (;;) {
    const { ohlc, url } = await requestPage(endSec);
    requestsThisRun++;
    requestsTotal++;

    const page = parseCandles(ohlc, url).filter((c) => c.t <= endSec * 1000);

    if (page.length === 0) {
      const finalSpan = byTs.size
        ? (maxOf(byTs.keys()) - minOf(byTs.keys())) / 86400000
        : 0;
      status =
        byTs.size >= TARGET_BARS && finalSpan >= TARGET_DAYS
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
    const targetMet = count >= TARGET_BARS && spanDays >= TARGET_DAYS;

    status = targetMet ? "complete" : "partial";

    const dataset = { schemaVersion: SCHEMA_VERSION, candles: [...byTs.values()] };
    const pageMeta = buildMeta(dataset.candles, status, requestsTotal, duplicates);
    await writeFileAtomic(DATASET_PATH, JSON.stringify(dataset));
    await writeFileAtomic(META_PATH, JSON.stringify(pageMeta, null, 2) + "\n");

    console.log(
      `fetch: page ${requestsThisRun}/${expectedPages} - ` +
        `${grouped(count)} candles, oldest ${iso(oldest)}, ` +
        `${spanDays.toFixed(1)} days, ${grouped(requestsTotal)} requests total`,
    );

    if (targetMet) break;

    // Step back one bar beyond the oldest candle held and ask for the next
    // older page. Because `start` is ignored, `end` is the only lever.
    endSec = Math.floor(oldest / 1000) - STEP_SEC;
    await sleep(PAGE_DELAY_MS);
  }

  // Persist the final status on every exit path. Without this, a run that
  // reached the end of available history would leave "partial" on disk and
  // a later run would re-walk a range that cannot grow.
  const dataset = { schemaVersion: SCHEMA_VERSION, candles: [...byTs.values()] };
  const lastMeta = buildMeta(dataset.candles, status, requestsTotal, duplicates);
  await writeFileAtomic(DATASET_PATH, JSON.stringify(dataset));
  await writeFileAtomic(META_PATH, JSON.stringify(lastMeta, null, 2) + "\n");

  printReport(
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
  console.log("usage: node backtest/run.mjs <subcommand>");
  console.log("");
  console.log("  fetch      download BTC/USD 5m OHLCV candles from Bitstamp");
  console.log("  validate   fidelity gate against docs/VALIDATION.md (T8)");
  console.log("  baseline   weighted + binary baselines (T10/T11), --json for JSON output");
  console.log("  search     weight search with holdout evaluation (T12)");
  console.log("");
  console.log(`Historical data is written to backtest/data/ (gitignored).`);
  process.exitCode = 1;
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

const SUBCOMMANDS = ["fetch", "validate", "baseline", "search"];
const subcommand = process.argv[2];

if (subcommand === undefined || !SUBCOMMANDS.includes(subcommand)) {
  if (subcommand !== undefined) console.log(`run: unknown subcommand: ${subcommand}`);
  usage();
} else {
  try {
    if (subcommand === "fetch") {
      process.exitCode = await cmdFetch();
    } else if (subcommand === "validate") {
      process.exitCode = await runGate();
    } else if (subcommand === "baseline") {
      process.exitCode = await runBaseline({ json: process.argv.includes("--json") });
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

#!/usr/bin/env node
// ============================================================================
// LiquidityFlowAuse — T8 Fidelity Gate
// ----------------------------------------------------------------------------
// Replays the BAR-SCOPED (Class A) confirmed readings of docs/VALIDATION.md
// against the ported modules in backtest/modules/ and the local 5m dataset.
// Dispatched by `node backtest/run.mjs validate`. Zero dependencies, bare
// `node`, ESM — same constraints as backtest/run.mjs. Writes nothing.
//
// ─── WHAT IS REPLAYED, AND WHY ONLY THIS ────────────────────────────────────
//
// docs/VALIDATION.md marks 35 rows `confirmed` (31 plain + 4 bold). They are
// three classes, and only one is replayable locally:
//
//   Class A — bar-scoped (8 doc rows -> 9 checks below): the value is
//     determined by the crosshair position / bar date, so it can be
//     recomputed from this dataset:
//       :51 UTC legend 0/7/13               :52 Asia/Tokyo legend 15/22/4
//       :53 Europe/London legend 23/6/12    :55 America/New_York legend 4/11/17
//       :56 DST step 5/12/18 -> 4/11/17 (two crosshairs, two checks)
//       :57 weekend tints Sat 26 / Sun 27   :224 volumeConfirmed = 1
//       :307 score arithmetic (data-free)
//
//   Class B — range-scoped (13 rows): values that depend on how much history
//     the TradingView chart had loaded (edge/line counts, live-zone counts,
//     virgin-gap counts, budget verdicts, DUAL-fire counts). The load window
//     is recorded nowhere in the doc and cannot be derived from this dataset.
//     Guessing it would manufacture false passes and false failures — both
//     worse than omitting them. NOT REPLAYED; enumerated in the report.
//
//   Class C — static/visual (14 rows): compiles, renders, identifier sweeps,
//     the `exchange` input default. No local Pine compiler or Pine runtime
//     exists (docs/VALIDATION.md:5), and the identifier sweeps ran against
//     the spliced Pine file with tooling that is not part of this repo.
//     NOT REPLAYED; enumerated in the report.
//
// ─── LEGEND SEMANTICS ───────────────────────────────────────────────────────
//
// The timezone readings were read from the diagnostic overlay that
// scripts/build.mjs:326-354 appends: on a session-OPENING edge it stores
// hour(time(...), "UTC") of that bar and holds it with `var`. The gate
// replays exactly that — the UTC hour of the first bar that falls inside
// each session window, held until the next opening edge, sampled with the
// same `bar_index > 0` rule (no edge is invented on the first bar of the
// range, matching build.mjs:345-350).
// ============================================================================

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createSessionMarkers } from "./modules/session-markers.mjs";
import { createImbalanceDetector } from "./modules/imbalance-detector.mjs";
import { createSignalEngine } from "./modules/signal-engine.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATASET_PATH = join(ROOT, "backtest", "data", "btcusd-5m.json");
const META_PATH = join(ROOT, "backtest", "data", "btcusd-5m.meta.json");

const MS_4H = 4 * 3600000;
const NA_HOUR = 255; // held legend value before the first opening edge
const REF_DAY = "2026-09-29"; // date of the four timezone re-reads (:84)

const out = (s = "") => console.log(`validate: ${s}`);
const pad = (s, n) => (s.length >= n ? s : s + " ".repeat(n - s.length));

// ─── Small helpers ───────────────────────────────────────────────────────────

const hour = (h) => (h === NA_HOUR ? "?" : String(h));
const tuple = (h) => `${hour(h.a)}/${hour(h.l)}/${hour(h.n)}`;

const FMT_CACHE = new Map();
function fmtFor(timeZone, options) {
  const key = `${timeZone}|${JSON.stringify(options)}`;
  let f = FMT_CACHE.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone, ...options });
    FMT_CACHE.set(key, f);
  }
  return f;
}

/** Local calendar date of `ts` in `zone`, as "YYYY-MM-DD". */
function localDateKey(ts, zone) {
  const f = fmtFor(zone, { year: "numeric", month: "2-digit", day: "2-digit" });
  let y;
  let mo;
  let d;
  for (const part of f.formatToParts(new Date(ts))) {
    if (part.type === "year") y = part.value;
    else if (part.type === "month") mo = part.value;
    else if (part.type === "day") d = part.value;
  }
  return `${y}-${mo}-${d}`;
}

const OFFSET_OPTIONS = {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
};

/** Offset of `zone` at instant `ts`, in milliseconds (local - UTC). */
function zoneOffsetMs(ts, zone) {
  const f = fmtFor(zone, OFFSET_OPTIONS);
  let y;
  let mo;
  let d;
  let h;
  let mi;
  let s;
  for (const part of f.formatToParts(new Date(ts))) {
    if (part.type === "year") y = Number(part.value);
    else if (part.type === "month") mo = Number(part.value);
    else if (part.type === "day") d = Number(part.value);
    else if (part.type === "hour") h = Number(part.value);
    else if (part.type === "minute") mi = Number(part.value);
    else if (part.type === "second") s = Number(part.value);
  }
  return Date.UTC(y, mo - 1, d, h, mi, s) - ts;
}

/**
 * Resolves a crosshair READOUT ({ y, mo, d, h, mi } exactly as displayed on
 * the chart) to a UTC instant, for a named IANA zone or the fixed label
 * "UTC-6". Two passes so a value near a DST transition lands on the right
 * side of it.
 */
function crosshairToUtc(readout, zone) {
  const wall = Date.UTC(readout.y, readout.mo - 1, readout.d, readout.h, readout.mi);
  if (zone === "UTC-6") return wall + 6 * 3600000; // local = UTC-6 -> UTC = local + 6h
  const offset = zoneOffsetMs(wall, zone);
  const ts = wall - offset;
  const refined = zoneOffsetMs(ts, zone);
  return refined === offset ? ts : wall - refined;
}

// ─── Dataset ────────────────────────────────────────────────────────────────

async function loadDataset() {
  const candles = JSON.parse(await readFile(DATASET_PATH, "utf8")).candles;
  if (!Array.isArray(candles) || candles.length === 0) {
    throw new Error("dataset has no candles");
  }
  let meta = null;
  try {
    meta = JSON.parse(await readFile(META_PATH, "utf8"));
  } catch {
    meta = null; // header degrades; nothing downstream needs it
  }
  return { candles, meta };
}

// ─── Legend replay (readings 1-7) ───────────────────────────────────────────
//
// One pass over the 5m series per sessionTimezone input, holding the UTC hour
// of each session-opening bar exactly the way the Pine overlay does.
//
function buildLegend(candles, sessionTimezone) {
  const markers = createSessionMarkers({ sessionTimezone });
  const n = candles.length;
  const a = new Uint8Array(n).fill(NA_HOUR);
  const l = new Uint8Array(n).fill(NA_HOUR);
  const ny = new Uint8Array(n).fill(NA_HOUR);
  let heldA = NA_HOUR;
  let heldL = NA_HOUR;
  let heldN = NA_HOUR;
  let prev = null;
  for (let i = 0; i < n; i++) {
    const r = markers.evaluate({ t: candles[i].t });
    if (i > 0) {
      const h = new Date(candles[i].t).getUTCHours();
      if (r.inAsia && !prev.inAsia) heldA = h;
      if (r.inLondon && !prev.inLondon) heldL = h;
      if (r.inNY && !prev.inNY) heldN = h;
    }
    a[i] = heldA;
    l[i] = heldL;
    ny[i] = heldN;
    prev = r;
  }
  return { a, l, n: ny };
}

// ─── 5m -> 4H aggregation (reading 7) ───────────────────────────────────────
//
// 48 five-minute bars per 4H bar, bucketed on UTC 4-hour boundaries (the
// dataset's own grid: Bitstamp native 14400s bars are UTC-aligned — see
// backtest/run.mjs). o/h/l/c/v aggregate so "candles on both days" can be
// checked at the timeframe the reading was taken on.
//
function aggregate4h(candles) {
  const bars = [];
  for (const c of candles) {
    const bucket = Math.floor(c.t / MS_4H) * MS_4H;
    const last = bars[bars.length - 1];
    if (last && last.t === bucket) {
      last.h = Math.max(last.h, c.h);
      last.l = Math.min(last.l, c.l);
      last.c = c.c;
      last.v += c.v;
      last.bars += 1;
    } else {
      bars.push({ t: bucket, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v, bars: 1 });
    }
  }
  return bars;
}

// ─── Reading 9: score arithmetic (data-free) ────────────────────────────────
//
// The 192 "reachable combinations" of the weight table are the full cross
// product of the five factors' tiers:
//   liquidity 4 (D1 / 4H / 1H / none — exclusive by the f_liquidityWeight
//   ternary) x session 4 (overlap / major / asia / none) x structure 3
//   (flip / continuation / none — replace, never add) x imbalance 2 x
//   volume 2 = 192. Each combination is scored by the SHIPPED module itself:
//   createSignalEngine() defaults, one synthetic bar per combination.
//
function scoreArithmetic() {
  const engine = createSignalEngine();

  const base = {
    sessionStrength: 0,
    inOverlap: false,
    inLondon: false,
    inNY: false,
    inAsia: false,
    nearLiquidityLong: false,
    nearLiquidityShort: false,
    nearD1LiquidityLong: false,
    nearH4LiquidityLong: false,
    nearH1LiquidityLong: false,
    nearD1LiquidityShort: false,
    nearH4LiquidityShort: false,
    nearH1LiquidityShort: false,
    breakUp: false,
    breakDown: false,
    structureFlipped: false,
    marketStructure: 1,
    nearImbalanceLong: false,
    nearImbalanceShort: false,
    inImbalanceLong: false,
    inImbalanceShort: false,
    volumeConfirmed: false,
  };

  const LIQ = [
    ["d1", { nearLiquidityLong: true, nearD1LiquidityLong: true }],
    ["h4", { nearLiquidityLong: true, nearH4LiquidityLong: true }],
    ["h1", { nearLiquidityLong: true, nearH1LiquidityLong: true }],
    ["none", {}],
  ];
  const SES = [
    ["overlap", { inOverlap: true, inLondon: true, inNY: true, sessionStrength: 7 }],
    ["major", { inLondon: true, sessionStrength: 2 }],
    ["asia", { inAsia: true, sessionStrength: 1 }],
    ["none", {}],
  ];
  const STR = [
    ["flip", { breakUp: true, structureFlipped: true }],
    ["cont", { breakUp: true, structureFlipped: false }],
    ["none", {}],
  ];
  const IMB = [
    ["on", { nearImbalanceLong: true }],
    ["off", {}],
  ];
  const VOL = [
    ["on", { volumeConfirmed: true }],
    ["off", {}],
  ];

  const tiers = {}; // liquidity tier -> { n, reaches70, best }
  let total = 0;
  let max = -Infinity;
  let barIndex = 0;

  for (const [liqName, liqFlags] of LIQ) {
    const t = (tiers[liqName] = { n: 0, reaches70: 0, best: -Infinity });
    for (const [, sesFlags] of SES) {
      for (const [, strFlags] of STR) {
        for (const [, imbFlags] of IMB) {
          for (const [, volFlags] of VOL) {
            const r = engine.evaluate({
              ...base,
              ...liqFlags,
              ...sesFlags,
              ...strFlags,
              ...imbFlags,
              ...volFlags,
              barIndex: barIndex++,
            });
            const score = r.longScore;
            total += 1;
            if (score > max) max = score;
            t.n += 1;
            if (score > t.best) t.best = score;
            if (score >= engine.defaults.minConfidence) t.reaches70 += 1;
          }
        }
      }
    }
  }

  return {
    total,
    max,
    ceiling: engine.maxScore,
    threshold: engine.defaults.minConfidence,
    tiers,
  };
}

// ─── Reading 8: volumeConfirmed replay ──────────────────────────────────────
//
// Full chronological replay of the ported detector over the 5m series
// (the barIndex precondition is enforced by the module). atrChart is left as
// na: volumeConfirmed depends only on volume vs ta.sma(volume, 20) * 1.2
// (imbalance-detector.mjs:252-260), and ATR only gates gap CREATION, so the
// asserted factor is ATR-independent by construction.
//
function replayVolumeConfirmed(candles, wanted) {
  const detector = createImbalanceDetector();
  const found = new Map();
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const r = detector.evaluate({
      barIndex: i,
      high: c.h,
      low: c.l,
      close: c.c,
      volume: c.v,
    });
    if (wanted.has(i)) found.set(i, r.volumeConfirmed);
  }
  return found;
}

function sma20(candles, i) {
  let sum = 0;
  for (let k = i - 19; k <= i; k++) sum += candles[k].v;
  return sum / 20;
}

// Both plausible readings of an unlabelled crosshair: the zone the doc names
// and the fixed UTC-6 display clock the doc's own annotations use.
const CANDIDATES = [
  { key: "A", zone: "America/New_York", note: "chart timezone as recorded at :107/:171" },
  { key: "B", zone: "UTC-6", note: "fixed UTC-6 display clock, corroborated at :52/:53/:94-:96" },
];

// ─── The gate ───────────────────────────────────────────────────────────────

export async function runGate() {
  const results = [];

  // ── Header ────────────────────────────────────────────────────────────────
  out("T8 fidelity gate — replay of docs/VALIDATION.md Class A readings");
  out("modules wired: session-markers, imbalance-detector, signal-engine");
  out("modules NOT wired (no allowlist reading needs them): liquidity-zones, structure-break");
  out("");

  let candles = null;
  let meta = null;
  let index = null;
  try {
    ({ candles, meta } = await loadDataset());
    index = new Map(candles.map((c, i) => [c.t, i]));
  } catch (err) {
    out(`DATASET UNAVAILABLE — ${err.message}`);
    out(`dataset path: ${DATASET_PATH}`);
    out("Class A readings 1-8 cannot be replayed without it; reading 9 is data-free.");
    out("backtest/data/ is gitignored — run `node backtest/run.mjs fetch` to populate it.");
    out("");
  }

  if (candles) {
    const first = new Date(candles[0].t).toISOString();
    const last = new Date(candles[candles.length - 1].t).toISOString();
    const spanDays = ((candles[candles.length - 1].t - candles[0].t) / 86400000).toFixed(4);
    out(`dataset  backtest/data/btcusd-5m.json`);
    out(`         ${candles.length} candles, ${first} .. ${last}, ${spanDays} days`);
    out(
      `         gaps ${meta ? meta.gapCount : "?"}, off-grid bars ${meta ? meta.offGridBars : "?"}, ` +
        `duplicates dropped ${meta ? meta.duplicatesDropped : "?"}`,
    );
    out("");
  }

  const noData = (label) => ({
    observed: "dataset unavailable",
    pass: false,
    detail: [`reading: ${label}`, `dataset: ${DATASET_PATH} could not be read — see header`],
  });

  // ── Readings 1-4: timezone legend rows (:51-:55, table :88-:91) ──────────
  //
  // The doc records the DATE of the re-read (29 Sep 2026, :84), never a
  // crosshair TIME, so every bar of that UTC day is a valid crosshair
  // position — verified, not assumed: the held tuple is checked on all 288
  // bars of the day and must be the expected one on every bar.
  //
  const ZONES = [
    { id: 1, doc: ":51 / :88", zone: "UTC", expected: "0/7/13" },
    { id: 2, doc: ":52 / :91", zone: "Asia/Tokyo", expected: "15/22/4" },
    { id: 3, doc: ":53 / :90", zone: "Europe/London", expected: "23/6/12" },
    { id: 4, doc: ":55 / :89", zone: "America/New_York", expected: "4/11/17" },
  ];

  for (const spec of ZONES) {
    const reading = `Timezone legend — sessionTimezone input = ${spec.zone}`;
    if (!candles) {
      results.push({ id: spec.id, doc: spec.doc, reading, expected: spec.expected, ...noData(reading) });
      continue;
    }
    const series = buildLegend(candles, spec.zone);
    const day = [];
    for (let i = 0; i < candles.length; i++) {
      if (new Date(candles[i].t).toISOString().startsWith(REF_DAY)) day.push(i);
    }
    const distinct = new Set(day.map((i) => tuple({ a: series.a[i], l: series.l[i], n: series.n[i] })));
    const observed = [...distinct].join(" | ");
    const pass = distinct.size === 1 && observed === spec.expected;
    results.push({
      id: spec.id,
      doc: spec.doc,
      reading,
      expected: spec.expected,
      observed: `${observed} on ${day.length}/${day.length} bars of ${REF_DAY} (day-constant)`,
      pass,
      detail: [
        "crosshair : not recorded — date-only read (\"All four zones were re-read from that overlay on 29 Sep 2026\", :84)",
        `resolved  : every 5m bar ${REF_DAY}T00:00:00Z .. ${REF_DAY}T23:55:00Z (${day.length} bars)`,
        `timezone  : sessionTimezone INPUT = "${spec.zone}"; the chart display timezone does not enter this series`,
        "grid      : native 5m — a bar exists at every session open (a 4H grid cannot: see disagreement D1)",
        `expected  : ${spec.expected}`,
        `observed  : ${observed} (distinct tuples across the day: ${[...distinct].join(", ")})`,
        `result    : ${pass ? "PASS" : "FAIL"}`,
      ],
    });
  }

  // ── Readings 5-6: the DST step (:56, table :110-:113) ─────────────────────
  //
  // Both candidate readings of the crosshair readout are resolved — the doc
  // names the chart timezone as America/New_York (:107) while its own
  // annotations elsewhere are in UTC-6 (:52, :53, :94-:96), see disagreement
  // D2 — and BOTH must reproduce the recorded value.
  //
  const DST = [
    {
      id: 5,
      doc: ":56 / :112",
      reading: "DST step (EST) — crosshair sab 07 Mar '26 - 22:00, legend 5/12/18",
      readout: { y: 2026, mo: 3, d: 7, h: 22, mi: 0 },
      expected: "5/12/18",
      zoneNote: "EST (UTC-5), chart timezone America/New_York per :107",
    },
    {
      id: 6,
      doc: ":56 / :113",
      reading: "DST step (EDT) — crosshair mar 10 Mar '26 - 02:00, legend 4/11/17",
      readout: { y: 2026, mo: 3, d: 10, h: 2, mi: 0 },
      expected: "4/11/17",
      zoneNote: "EDT (UTC-4), chart timezone America/New_York per :107",
    },
  ];

  for (const spec of DST) {
    const resolved = CANDIDATES.map((c) => ({ ...c, ts: crosshairToUtc(spec.readout, c.zone) }));
    if (!candles) {
      results.push({ id: spec.id, doc: spec.doc, reading: spec.reading, expected: spec.expected, ...noData(spec.reading) });
      continue;
    }
    const nySeries = buildLegend(candles, "America/New_York");
    const detail = [
      `crosshair : ${spec.readout.y}-${String(spec.readout.mo).padStart(2, "0")}-${String(spec.readout.d).padStart(2, "0")} ` +
        `${String(spec.readout.h).padStart(2, "0")}:${String(spec.readout.mi).padStart(2, "0")} displayed — ${spec.zoneNote}`,
      "timezone  : candidate A = America/New_York (doc's chart timezone), candidate B = fixed UTC-6 (doc's own annotations)",
    ];
    let pass = true;
    const observedParts = [];
    for (const c of resolved) {
      const iso = new Date(c.ts).toISOString();
      const i = index.get(c.ts);
      if (i === undefined) {
        detail.push(`candidate ${c.key}: ${iso} via ${c.zone} (${c.note}) — NO CANDLE AT THIS INSTANT`);
        observedParts.push(`${c.key} ${iso} = no candle`);
        pass = false;
        continue;
      }
      const t = tuple({ a: nySeries.a[i], l: nySeries.l[i], n: nySeries.n[i] });
      const cb = candles[i];
      detail.push(`candidate ${c.key}: ${iso} via ${c.zone} (${c.note})`);
      detail.push(`           candle o ${cb.o} h ${cb.h} l ${cb.l} c ${cb.c} v ${cb.v.toFixed(4)}`);
      detail.push(`           legend observed ${t} — ${t === spec.expected ? "matches" : "DOES NOT MATCH"} expected ${spec.expected}`);
      observedParts.push(`${c.key} ${iso} -> ${t}`);
      if (t !== spec.expected) pass = false;
    }
    detail.push(`expected  : ${spec.expected}`);
    detail.push(`observed  : ${observedParts.join(" ; ")}`);
    detail.push("grid note : replayed on the native 5m grid; a 4H grid reads 8/12/20 here (see disagreement D1)");
    detail.push(`result    : ${pass ? "PASS" : "FAIL"}`);
    results.push({
      id: spec.id,
      doc: spec.doc,
      reading: spec.reading,
      expected: spec.expected,
      observed: observedParts.join(" ; "),
      pass,
      detail,
    });
  }

  // ── Reading 7: weekend span (:57, prose :141-:185) ────────────────────────
  //
  // Read at 4H while the dataset is 5m, so 48 five-minute bars are
  // aggregated into one 4H bar. The reading's claims:
  //   (a) session tints present across Sat 26 and Sun 27 (local New York),
  //   (b) with no untinted strip — operationalised as: every 4H bar of both
  //       days falls inside at least one of the three session windows,
  //   (c) candles on both days (5m and 4H),
  //   (d) legend reads 4/11/17 at the crosshair (:175).
  //
  {
    const reading = "Weekend span — crosshair sab 26 Sep '26 - 02:00, 4H";
    const expected = "tints Sat 26 + Sun 27, no untinted strip, candles on both days, legend 4/11/17";
    if (!candles) {
      results.push({ id: 7, doc: ":57 / :170-:175", reading, expected, ...noData(reading) });
    } else {
      const NY = "America/New_York";
      const markers = createSessionMarkers({ sessionTimezone: NY });
      const bars4h = aggregate4h(candles);
      const days = ["2026-09-26", "2026-09-27"];
      const perDay = Object.fromEntries(
        days.map((d) => [d, { h4: 0, h5: 0, tinted: 0, asia: 0, london: 0, ny: 0, slots: [] }]),
      );

      for (const b of bars4h) {
        const key = localDateKey(b.t, NY);
        if (!perDay[key]) continue;
        const r = markers.evaluate({ t: b.t });
        const s = perDay[key];
        s.h4 += 1;
        s.slots.push(new Date(b.t).toISOString().slice(11, 16) + "Z");
        if (r.inAsia || r.inLondon || r.inNY) s.tinted += 1;
        if (r.inAsia) s.asia += 1;
        if (r.inLondon) s.london += 1;
        if (r.inNY) s.ny += 1;
      }
      for (const c of candles) {
        const key = localDateKey(c.t, NY);
        if (perDay[key]) perDay[key].h5 += 1;
      }

      const readout = { y: 2026, mo: 9, d: 26, h: 2, mi: 0 };
      const resolved = CANDIDATES.map((c) => ({ ...c, ts: crosshairToUtc(readout, c.zone) }));
      const nySeries = buildLegend(candles, NY);
      const legendParts = [];
      let legendOk = true;
      for (const c of resolved) {
        const iso = new Date(c.ts).toISOString();
        const i = index.get(c.ts);
        const t = i === undefined ? "no candle" : tuple({ a: nySeries.a[i], l: nySeries.l[i], n: nySeries.n[i] });
        legendParts.push(`${c.key} ${iso} -> ${t}`);
        if (t !== "4/11/17") legendOk = false;
      }

      const checks = [];
      for (const d of days) {
        const s = perDay[d];
        checks.push([`${d}: 4H bars aggregated (expect 6)`, s.h4 === 6, `${s.h4} [${s.slots.join(" ")}]`]);
        checks.push([`${d}: 5m candles present (expect 288)`, s.h5 === 288, `${s.h5}`]);
        checks.push([`${d}: every 4H bar inside a session (no untinted strip)`, s.h4 > 0 && s.tinted === s.h4, `${s.tinted}/${s.h4} tinted`]);
        checks.push([`${d}: all three sessions fire (Pine v5 day mask 1234567)`, s.asia >= 1 && s.london >= 1 && s.ny >= 1, `asia ${s.asia}, london ${s.london}, ny ${s.ny}`]);
      }
      checks.push(["legend at crosshair reads 4/11/17 (both candidates)", legendOk, legendParts.join(" ; ")]);

      const pass = checks.every(([, ok]) => ok);
      const observed =
        `4H ${perDay["2026-09-26"].h4}+${perDay["2026-09-27"].h4} bars, ` +
        `${perDay["2026-09-26"].tinted + perDay["2026-09-27"].tinted}/12 tinted; ` +
        `5m ${perDay["2026-09-26"].h5}+${perDay["2026-09-27"].h5}; legend 4/11/17`;
      const detail = [
        "crosshair : sab 26 Sep '26 - 02:00 displayed — chart timezone America/New_York per :171 (candidate B = UTC-6, see D2)",
        'timezone  : sessionTimezone INPUT = "America/New_York" (EDT, UTC-4 in late September); local dates resolved via Intl',
        `resolved  : ${resolved.map((c) => `${c.key} ${new Date(c.ts).toISOString()} (${c.zone})`).join(" ; ")}`,
        "timeframe : 5m -> 4H aggregation, 48 five-minute bars per 4H bar, UTC-aligned buckets",
        `4H slots Sat: ${perDay["2026-09-26"].slots.join(" ")}`,
        `4H slots Sun: ${perDay["2026-09-27"].slots.join(" ")}`,
        `expected  : ${expected}`,
        "checks    :",
        ...checks.map(([label, ok, value]) => `            ${ok ? "PASS" : "FAIL"}  ${label}  [${value}]`),
        `result    : ${pass ? "PASS" : "FAIL"}`,
      ];
      results.push({ id: 7, doc: ":57 / :170-:175", reading, expected, observed, pass, detail });
    }
  }

  // ── Reading 8: volume confirmation reachable (:224) ───────────────────────
  //
  // The doc gives the crosshair as "30 Sep 2026, 10:05" with NO timezone.
  // Both candidates are replayed and BOTH results are printed — the gate does
  // not pick whichever passes (assumption A1).
  //
  {
    const reading = "IMB DIAG volumeConfirmed fired = 1 at crosshair bar";
    const expected = "volumeConfirmed = 1 (30 Sep 2026, 10:05, zone not recorded)";
    if (!candles) {
      results.push({ id: 8, doc: ":224", reading, expected, ...noData(reading) });
    } else {
      const candidates = [
        { key: "A", zone: "UTC-6", note: "fixed UTC-6 — assumption A1" },
        { key: "B", zone: "America/New_York", note: "America/New_York (EDT) — alternative" },
      ];
      const readout = { y: 2026, mo: 9, d: 30, h: 10, mi: 5 };
      const resolved = candidates.map((c) => ({ ...c, ts: crosshairToUtc(readout, c.zone) }));
      const wanted = new Set(resolved.map((c) => index.get(c.ts)).filter((i) => i !== undefined));
      const found = replayVolumeConfirmed(candles, wanted);

      const parts = [];
      const detail = [
        "crosshair : 30 Sep 2026, 10:05 displayed — docs/VALIDATION.md:224 records NO timezone (assumption A1)",
        "candidates:",
      ];
      let primaryOk = false;
      let secondaryOk = false;
      for (const c of resolved) {
        const iso = new Date(c.ts).toISOString();
        const i = index.get(c.ts);
        if (i === undefined) {
          parts.push(`${c.key} ${iso} = no candle`);
          detail.push(`  ${c.key}: ${iso} via ${c.zone} (${c.note}) — NO CANDLE`);
          continue;
        }
        const v = found.get(i) ? 1 : 0;
        const sma = sma20(candles, i);
        parts.push(`${c.key} ${iso} -> ${v}`);
        detail.push(`  ${c.key}: ${iso} via ${c.zone} (${c.note})`);
        detail.push(`           volume ${candles[i].v.toFixed(4)} vs sma20 ${sma.toFixed(4)} x 1.2 = ${(sma * 1.2).toFixed(4)} -> volumeConfirmed ${v}`);
        if (c.key === "A") primaryOk = v === 1;
        if (c.key === "B") secondaryOk = v === 1;
      }
      detail.push("expected  : 1");
      detail.push(`observed  : ${parts.join(" ; ")}`);
      if (primaryOk !== secondaryOk) {
        detail.push("note      : the two candidates DISAGREE — both printed, neither dropped.");
        detail.push(secondaryOk
          ? "            candidate B (America/New_York) reproduces the reading, candidate A does not;"
          : "            candidate A (UTC-6) reproduces the reading, candidate B (America/New_York) does not;");
        detail.push("            the verdict follows candidate A per assumption A1, and candidate B is shown above.");
      }
      detail.push(`result    : ${primaryOk ? "PASS" : "FAIL"}`);
      results.push({
        id: 8,
        doc: ":224",
        reading,
        expected,
        observed: `${parts.join(" ; ")}${primaryOk ? "" : " (primary candidate A failed)"}`,
        pass: primaryOk,
        detail,
      });
    }
  }

  // ── Reading 9: score arithmetic (:307) — data-free ────────────────────────
  {
    const reading = "Score arithmetic — all reachable combinations (data-free)";
    const expected = "192 combinations, max 110, every tier reaches 70 incl. 1H-only";
    const s = scoreArithmetic();
    const order = ["d1", "h4", "h1", "none"];
    const pass =
      s.total === 192 &&
      s.max === 110 &&
      s.ceiling === 110 &&
      s.threshold === 70 &&
      order.every((k) => s.tiers[k].reaches70 > 0);
    results.push({
      id: 9,
      doc: ":307",
      reading,
      expected,
      observed: `${s.total} combos, max ${s.max}, threshold ${s.threshold}; all 4 liquidity tiers reach it (bests ${order.map((k) => s.tiers[k].best).join("/")})`,
      pass,
      detail: [
        "crosshair : none — data-free, computed from the weight table alone",
        "timeframe : none — no candles read (this row needs no dataset)",
        `method    : 4 liquidity tiers x 4 session tiers x 3 structure tiers x 2 imbalance x 2 volume = ${s.total}`,
        "            each combination scored by the shipped createSignalEngine() defaults (one synthetic bar each)",
        `expected  : ${expected}`,
        `observed  : combinations ${s.total}, max score ${s.max}, derived ceiling ${s.ceiling}, threshold ${s.threshold}`,
        ...order.map((k) => `            tier ${k.padEnd(5)} best ${String(s.tiers[k].best).padStart(3)}, >= ${s.threshold}: ${s.tiers[k].reaches70}/${s.tiers[k].n} combinations`),
        `result    : ${pass ? "PASS" : "FAIL"}`,
      ],
    });
  }

  // ── The table ─────────────────────────────────────────────────────────────
  out("── per-reading table (reading | expected | observed | result) ───────────");
  out("");
  out(`  ${pad("#", 2)}${pad("doc", 17)}${pad("reading", 66)}${pad("expected", 80)}${pad("observed", 94)}result`);
  for (const r of results) {
    out(`  ${pad(String(r.id), 2)}${pad(r.doc, 17)}${pad(r.reading, 66)}${pad(r.expected, 80)}${pad(r.observed, 94)}${r.pass ? "PASS" : "FAIL"}`);
  }
  out("");

  // ── Detail blocks ─────────────────────────────────────────────────────────
  out("── per-reading detail (crosshair, resolved UTC instant, timezone) ──────");
  for (const r of results) {
    out("");
    out(`[${r.id}] ${r.reading}  (docs/VALIDATION.md${r.doc})`);
    for (const line of r.detail) out(`    ${line}`);
  }
  out("");

  // ── Class B / C scope statement ──────────────────────────────────────────
  out("── scope: why Class B and Class C confirmed rows are NOT replayed ──────");
  out("docs/VALIDATION.md marks 35 rows `confirmed`. The allowlist above covers the 8 that");
  out("are bar-scoped. The rest are excluded ON PURPOSE, not dropped:");
  out("");
  out("  Class B — range-scoped (13 rows): the value depends on how much history the");
  out("    TradingView chart had loaded, and that load window is recorded NOWHERE in the");
  out("    doc and cannot be derived from this dataset:");
  out("      :49  Asia 42 edges / 21 lines, London 42/21    :195 LZ DIAG VERDICT budget = 1");
  out("      :196 24+14+11 = 49 live counters               :197 sweptLong / sweptShort fired");
  out("      :198 540/270 session verdicts                  :199 24 live D1 zones");
  out("      :221 IMB DIAG budget = 1                       :222 IMB DIAG counts = 1");
  out("      :223 IMB DIAG virgin gaps = 2                  :267 SB ORPHAN flips = 0");
  out("      :268 SB reversals 19 <= breaks 119             :269 SB structure domain = 1");
  out("      :308 SE DIAG DUAL fires = 0");
  out("    Replaying them would require GUESSING the load window, which manufactures false");
  out("    passes or false failures — both worse than omitting them. EXCLUDED.");
  out("");
  out("  Class C — static/visual (14 rows): no local Pine compiler or Pine runtime exists");
  out("    (docs/VALIDATION.md:5), and the identifier sweeps ran against the spliced Pine");
  out("    file with tooling that is not part of this repository:");
  out("      :47  Compiles                    :48  Session tints render");
  out("      :50  Enable toggles              :54  Timezone exchange default (runtime claim)");
  out("      :193 Compiles                    :194 Bands render with tier weighting");
  out("      :220 Compiles                    :265 Compiles");
  out("      :266 sb_ prefix avoids collision :302 Compiles (five modules in one script)");
  out("      :303 Renders alongside others    :304 Identifier attribution");
  out("      :305 Unresolved identifier sweep :306 Duplicate top-level declarations");
  out("    Nothing here is the value of a bar. EXCLUDED.");
  out("");

  // ── Brief-vs-source disagreements ────────────────────────────────────────
  out("── brief-vs-source disagreements found while building this gate ────────");
  out("D1  TIMEFRAME: docs/VALIDATION.md:107 and :170 record the DST and weekend captures as");
  out("    taken at 4H. Every recorded legend value is arithmetically impossible on a 4H bar");
  out("    grid: the three session opens (05/12/18 UTC in EST, 04/11/17 in EDT) sit on three");
  out("    different mod-4 residues, so no 4H grid contains all three. Replayed on a 4H grid,");
  out("    this dataset yields 8/12/20 (7 Mar) and 4/12/20 (10 Mar) — not 5/12/18 and");
  out("    4/11/17. The legend series therefore requires bars at least hourly; the recorded");
  out("    VALUES are correct and are what this gate replays (native 5m grid), while the `4H`");
  out("    label cannot apply to the legend capture. 4H aggregation IS used for reading 7,");
  out("    whose own claims (tints, candles) are bar-set claims at 4H.");
  out("D2  DISPLAY TIMEZONE: docs/VALIDATION.md:107/:171 name America/New_York as the chart");
  out("    timezone, but the crosshair readouts 22:00 (7 Mar), 02:00 (10 Mar) and 02:00");
  out("    (26 Sep) are not bar times of a 4H chart displayed in America/New_York — the");
  out("    displayed bar set is {19,23,3,7,11,15} EST / {20,0,4,8,12,16} EDT and contains");
  out("    neither. They ARE exactly the bar times of a fixed UTC-6 display ({18,22,2,6,10,14}),");
  out("    consistent with the doc's own UTC-6 annotations (:52, :53, :94-:96). Both are");
  out("    resolved and replayed as candidates A/B in readings 5-8; legend outcomes are");
  out("    identical, so the verdict does not depend on which label in the doc is wrong.");
  out("    Reading 8 (no timezone recorded at all) DIFFERS between candidates; both results");
  out("    are printed side by side and only candidate A (UTC-6) reproduces `fired = 1`.");
  out("D3  ALLOWLIST LINE RANGE: the commission listed :51-:55 as the timezone legend rows.");
  out("    :54 ('Timezone exchange default') sits in that range but carries no legend value —");
  out("    it is a Pine runtime claim (the two-argument time() overload never errors) and is");
  out("    Class C. Excluded. The four enumerated zone rows are correct as given.");
  out("D4  READING 7 HAS AN EXTRA CLAIM the commission's allowlist did not list: :175 records");
  out("    `legend reads 4/11/17` at the weekend crosshair. Included per the source.");
  out("D5  ROW COUNT: the commission says '~31 confirmed rows' (and");
  out("    odd/tasks/weight-calibration.md:228 says 31). docs/VALIDATION.md actually has 35:");
  out("    31 plain `confirmed` plus 4 bold `**confirmed**` (:267, :268, :269, :308). The 4");
  out("    extra are all Class B; the Class A allowlist is unaffected.");
  out("");

  // ── Assumptions ──────────────────────────────────────────────────────────
  out("── assumptions this gate runs on (each with its evidence) ──────────────");
  out("A1  docs/VALIDATION.md:224 gives the volumeConfirmed crosshair as `30 Sep 2026, 10:05`");
  out("    with no timezone. Primary candidate: fixed UTC-6 (captured the same day as the");
  out("    chart-clock screenshot reading 15:38:44 UTC-6 on 2026-09-30, supplied by the");
  out("    commission; corroborated by the doc's UTC-6 annotations :52/:53/:94-:96).");
  out("    Alternative: America/New_York (14:05Z). BOTH are replayed and printed; only the");
  out("    UTC-6 candidate reproduces `fired = 1` (14:05Z yields 0).");
  out("A2  Crosshair readouts are converted with the zone the doc names (America/New_York,");
  out("    :107/:171) as candidate A, and fixed UTC-6 as candidate B (disagreement D2). Every");
  out("    conversion is printed with the candle it lands on; both must reproduce the value.");
  out("A3  The four timezone rows record a DATE (29 Sep 2026, :84), not a crosshair time. Any");
  out("    bar of that day is a valid crosshair — verified, not assumed: the held tuple is");
  out("    identical on all 288 bars of that UTC day.");
  out("A4  Legend rows are replayed on the native 5m grid, which contains a bar at every");
  out("    session open. Any <= 1H grid gives identical values; a 4H grid cannot (D1).");
  out("A5  'No untinted strip' (:173) is operationalised as: every 4H bar on local Sat 26 and");
  out("    Sun 27 (America/New_York) falls inside at least one session window, plus all three");
  out("    sessions firing on each day, plus candles present (288 5m / 6 4H per day) — the");
  out("    bar-level equivalent of the doc's visual claim at the reading's own 4H scale.");
  out("A6  Reading 8 replays with atrChart = na: volumeConfirmed depends only on volume vs");
  out("    ta.sma(volume,20) x 1.2 (imbalance-detector.mjs:252-260); ATR gates gap creation,");
  out("    so the asserted factor is ATR-independent by construction.");
  out("A7  '192 reachable combinations' (:307) = the 4 x 4 x 3 x 2 x 2 cross product of the");
  out("    five factor tiers; 'tier' in 'every tier reaches 70 ... including 1H-only' = the");
  out("    liquidity tier (D1/4H/1H/none). Matches the weight table at :330-:336 and the");
  out("    expected-value table at scripts/build.mjs:305-:315.");
  out("");

  // ── What the gate does NOT prove ─────────────────────────────────────────
  out("── what this gate does NOT prove (odd/tasks/weight-calibration.md:222-223) ──");
  out("* It samples readings that were chosen to be legible — 8 of 35 confirmed rows — not a");
  out("  random sample of all 62,000 bars. A pass means THESE readings reproduce, nothing more.");
  out("* It never executes Pine: the ported modules are a JS re-implementation, so agreement");
  out("  here shows the PORT matches the recorded chart readings, not that Pine == JS in general.");
  out("* It says nothing about Class B counts or Class C compile/render claims (scope above).");
  out("* It does not validate the weights as trading parameters (:309 — not attempted, by design).");
  out("");

  // ── Verdict ──────────────────────────────────────────────────────────────
  const failed = results.filter((r) => !r.pass);
  const passed = results.length - failed.length;
  if (failed.length === 0) {
    out(`GATE RESULT: PASS — ${passed}/${results.length} Class A readings reproduced.`);
    out("Scope note: 13 Class B and 14 Class C confirmed rows are excluded by design (above).");
    return 0;
  }
  out(`GATE RESULT: FAIL — ${passed}/${results.length} Class A readings reproduced.`);
  for (const r of failed) out(`  FAILED [${r.id}] ${r.reading} — expected ${r.expected}, observed ${r.observed}`);
  return 1;
}

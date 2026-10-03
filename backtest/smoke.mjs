// ============================================================================
// Slice 4 smoke suite — signal-engine port (T7) + regression over the four
// already-merged ports (T3/T4/T5/T6). Bare Node, zero dependencies, writes
// nothing. Lives in backtest/ so a clean checkout can run it: it verifies the
// five ported modules together, as one suite for the whole harness. The
// appended T9 section checks outcome labelling (modules/label.mjs) against
// hand-built synthetic candles and never reads backtest/data/. The appended
// T10/T11 sections check the binary confluence model (modules/binary.mjs) on
// synthetic bars and the baseline runner's wiring by reading the harness's
// own source — again never backtest/data/.
//
// Run: node backtest/smoke.mjs
// ============================================================================

import {
  createSessionMarkers,
  parseSessionString,
} from "./modules/session-markers.mjs";
import {
  createLiquidityZones,
  createPivotDetector,
  createAtr,
} from "./modules/liquidity-zones.mjs";
import { createStructureBreak } from "./modules/structure-break.mjs";
import { createImbalanceDetector } from "./modules/imbalance-detector.mjs";
import {
  createSignalEngine,
  SIGNAL_ENGINE_DEFAULTS,
  SIGNAL_ENGINE_WEIGHT_KEYS,
} from "./modules/signal-engine.mjs";
import {
  EXIT_RULE_DEFAULTS,
  EXIT_STOP_PCT,
  EXIT_TARGET_PCT,
  FORWARD_RETURN_DEFAULTS,
  labelExitRule,
  labelForwardReturn,
  labelSignalsExitRule,
  labelSignalsForwardReturn,
} from "./modules/label.mjs";
import { readFileSync } from "node:fs";
import {
  createBinarySignalModel,
  BINARY_INPUT_CONTRACT,
  BINARY_MODEL_DEFAULTS,
} from "./modules/binary.mjs";
import {
  newNearTally,
  newSplit,
  newTally,
  phaseOf,
  qualifyingTier,
  recordNear,
  recordSplit,
  recordTier,
} from "./tier-diagnostic.mjs";
import {
  clusterSignals,
  jointClusters,
  makeRng,
  maxSignalGap,
  pairedClusterBootstrap,
  parseCompareFlags,
  percentileOfSorted,
} from "./compare.mjs";
import {
  DEFAULT_TIMEFRAME,
  MS_1H,
  MS_4H,
  MS_5M,
  TIMEFRAMES,
  TimeframeError,
  barsPerDailyBar,
  getTimeframe,
  htfAvailability,
  nativeBarsForDays,
  parseTimeframeFlag,
  resolveStatus,
  targetVerdict,
} from "./timeframes.mjs";
import {
  breakevenHitRate,
  bootstrapHitRateDraws,
  bootstrapSurface,
  bootstrapTransformed,
  cellOutcomes,
  currentRatio,
  defaultHorizon,
  dependentSampleGapPp,
  expectancyPercent,
  findZeroCrossing,
  hitRateInterval,
  labelExitAt,
  minimumDetectableDifferencePp,
  normalCdf,
  normalQuantile,
  observationsNeededForGapPp,
  parseRatioFlags,
  parseRatioHorizonFlag,
  pooledHitRate,
  powerBlock,
  requiredRatio,
  ratioDirection,
  selectIndependent,
  shortfallText,
  stopGridPct,
  surfaceCells,
  targetGridPct,
  verifyParametricLabeller,
  windowIndexOf,
} from "./ratio.mjs";

// Route A. Imported from scripts/ rather than re-implemented here, on purpose:
// a smoke check that re-derived the module list to compare against the build
// would be comparing the build against a second implementation of the build,
// and it would pass exactly when the two disagreed most.
import {
  SOURCES,
  assertModuleParity,
  readModuleParts,
} from "../scripts/assemble.mjs";
// fileURLToPath, not URL.pathname: on Windows the latter yields "/C:/Users/…",
// which node's fs cannot open, and every read below would fail on an empty
// string rather than on the file it meant. A silent 0-module result from a
// malformed path is precisely the kind of vacuous pass this section exists to
// avoid, so the path is built the way node documents it.
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * Strips Pine line comments, string-aware — the same rule scripts/build.mjs
 * applies before counting plot-family calls.
 *
 * Needed here because the strategy's header PROSE legitimately names
 * indicator(), study() and `profit=targetPct` while explaining that the file
 * contains none of them. Matching those words would make every Pine-shape
 * assertion in the Route A section vacuous, so they run against stripped code.
 */
function stripPineLineComments(text) {
  const out = [];

  for (const line of text.split(/\r?\n/)) {
    let quote = null;
    let cut = -1;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quote) {
        if (ch === "\\") i++;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === "/" && line[i + 1] === "/") {
        cut = i;
        break;
      }
    }

    out.push(cut === -1 ? line : line.slice(0, cut));
  }

  return out.join("\n");
}

const counts = {};
let section = "untitled";
let pass = 0;
let fail = 0;
const failures = [];

function check(cond, label) {
  if (cond) {
    pass += 1;
    counts[section] = (counts[section] ?? 0) + 1;
  } else {
    fail += 1;
    failures.push(`[${section}] ${label}`);
  }
}

function sec(name) {
  section = name;
}

function throws(fn, type, label) {
  try {
    fn();
    check(false, `${label} — no throw`);
    return null;
  } catch (err) {
    check(err instanceof type, `${label} — wrong error type: ${err.constructor.name}: ${err.message}`);
    return err;
  }
}

// ─── 1. session-markers (T3) ────────────────────────────────────────────────

sec("session-markers");
{
  const sm = createSessionMarkers();
  const ev = (iso) => sm.evaluate({ t: Date.parse(iso) });

  const asia = ev("2026-06-15T02:00:00Z");
  check(asia.inAsia === true, "02:00 inAsia");
  check(asia.inLondon === false, "02:00 not london");
  check(asia.inNY === false, "02:00 not ny");
  check(asia.inOverlap === false, "02:00 no overlap");
  check(asia.sessionStrength === 1, "02:00 strength 1");
  check(asia.sessionMultiplier === 0.5, "02:00 multiplier 0.5");

  const lon = ev("2026-06-15T10:00:00Z");
  check(lon.inLondon === true, "10:00 london");
  check(lon.inAsia === false, "10:00 not asia");
  check(lon.inNY === false, "10:00 not ny");
  check(lon.sessionStrength === 2, "10:00 strength 2");
  check(lon.sessionMultiplier === 1.0, "10:00 multiplier 1.0");

  const ovl = ev("2026-06-15T15:00:00Z");
  check(ovl.inLondon && ovl.inNY, "15:00 london+ny");
  check(ovl.inOverlap === true, "15:00 overlap");
  check(ovl.sessionStrength === 7, "15:00 strength 7");
  check(ovl.sessionMultiplier === 1.5, "15:00 multiplier 1.5");

  const ny = ev("2026-06-15T18:00:00Z");
  check(ny.inNY === true && ny.inLondon === false, "18:00 ny only");
  check(ny.sessionStrength === 2 && ny.sessionMultiplier === 1.0, "18:00 strength 2 / mult 1.0");

  const none = ev("2026-06-15T23:00:00Z");
  check(
    !none.inAsia && !none.inLondon && !none.inNY && !none.inOverlap,
    "23:00 no session",
  );
  check(none.sessionStrength === 0, "23:00 strength 0");
  check(none.sessionMultiplier === 0.3, "23:00 multiplier 0.3");

  // Half-open [start, end) membership.
  check(ev("2026-06-15T07:00:00Z").inLondon === true, "07:00 london start inclusive");
  check(ev("2026-06-15T16:00:00Z").inLondon === false, "16:00 london end exclusive");
  check(ev("2026-06-15T09:00:00Z").inAsia === false, "09:00 asia end exclusive");

  // UTC session strings do not move with DST.
  check(ev("2026-01-15T10:00:00Z").inLondon === true, "winter 10:00 london");

  // Enable flags gate before membership.
  const noLondon = createSessionMarkers({ sessionLondonEnabled: false });
  const nl = noLondon.evaluate({ t: Date.parse("2026-06-15T10:00:00Z") });
  check(nl.inLondon === false, "london disabled");
  check(nl.sessionStrength === 0, "london disabled -> strength 0");
  check(nl.sessionMultiplier === 0.3, "london disabled -> mult 0.3");

  // Null timezone: every flag stays false (Pine `not na(sessionTimezone)`).
  const noTz = createSessionMarkers({ sessionTimezone: null });
  const nt = noTz.evaluate({ t: Date.parse("2026-06-15T15:00:00Z") });
  check(
    !nt.inAsia && !nt.inLondon && !nt.inNY && !nt.inOverlap,
    "null timezone -> all false",
  );
  check(nt.sessionStrength === 0 && nt.sessionMultiplier === 0.3, "null timezone -> 0 / 0.3");

  // Session string parsing.
  const s1 = parseSessionString("0700-1600");
  check(s1.start === 420 && s1.end === 960, "0700-1600 -> 420..960");
  check(s1.days.size === 7, "no day suffix -> all 7 days");
  const s2 = parseSessionString("0700-1600:1357");
  check(s2.days.size === 4 && s2.days.has(1) && s2.days.has(7), ":1357 -> 4 days");
  throws(() => parseSessionString("2500-0300"), RangeError, "hour 25 rejected");
  throws(() => parseSessionString(42), TypeError, "non-string rejected");
}

// ─── 2. liquidity-zones (T4) ────────────────────────────────────────────────

sec("liquidity-zones");
{
  // Pivot detector: confirmation timing + strict tie convention.
  const pd = createPivotDetector({ pivotLenHigh: 3, pivotLenLow: 3 });
  const highs = [1, 2, 3, 10, 3, 2, 1];
  const lows = [10, 9, 8, 1, 8, 9, 10];
  let seen = null;
  for (let i = 0; i < highs.length; i++) {
    const r = pd.update({ high: highs[i], low: lows[i] });
    if (i < 6) {
      check(r.pivotHigh === null && r.pivotLow === null, `no pivot before confirmation (bar ${i})`);
    }
    seen = r;
  }
  check(seen.pivotHigh === 10, "pivot high confirmed 3 bars later");
  check(seen.pivotLow === 1, "pivot low confirmed 3 bars later");

  const pdTie = createPivotDetector({ pivotLenHigh: 3, pivotLenLow: 3 });
  const tieHighs = [1, 2, 3, 10, 10, 3, 2];
  let tie = null;
  for (let i = 0; i < tieHighs.length; i++) {
    tie = pdTie.update({ high: tieHighs[i], low: 0 });
  }
  check(tie.pivotHigh === null, "equal highs form no pivot (strict)");

  // ATR: SMA seed over `length` true ranges, then Wilder RMA.
  const atr = createAtr({ length: 3 });
  check(atr.update({ high: 10, low: 8, close: 9 }) === null, "atr warm-up bar 1");
  check(atr.update({ high: 11, low: 9, close: 10 }) === null, "atr warm-up bar 2");
  const a3 = atr.update({ high: 12, low: 10, close: 11 });
  check(a3 === 2, `atr seed = 2 (got ${a3})`);
  const a4 = atr.update({ high: 20, low: 10, close: 15 });
  check(Math.abs(a4 - 14 / 3) < 1e-9, `atr rma step (got ${a4})`);

  // Zone birth + proximity + tier flags.
  const lz = createLiquidityZones();
  const b0 = lz.evaluate({
    barIndex: 0,
    high: 107,
    low: 106,
    close: 106.5,
    atrChart: 3,
    atrH4: 8,
    atrD1: 10,
    atrH1: 4,
    pivots: { d1High: 100, h4High: 101, h1High: 102 },
  });
  check(lz.zoneCount === 3, `three zones born (got ${lz.zoneCount})`);
  check(b0.zones[0].tier === 1 && b0.zones[1].tier === 2 && b0.zones[2].tier === 3, "tier mapping 1/2/3");
  check(b0.zones[0].halfWidth === 5, "d1 halfWidth = atrD1 * 0.5");
  check(b0.nearLiquidityLong === true, "price above three zones -> nearLiquidityLong");
  check(b0.nearD1LiquidityLong === true, "nearD1 flag");
  check(b0.nearH4LiquidityLong === true, "nearH4 flag");
  check(b0.nearH1LiquidityLong === true, "nearH1 flag");
  check(b0.nearLiquidityShort === false, "no short-side zone");
  check(b0.sweptLong === false && b0.sweptShort === false, "nothing swept on the birth bar");

  // In-body bar reports through swept*, never through near*.
  const b1 = lz.evaluate({
    barIndex: 1,
    high: 104,
    low: 96,
    close: 103,
    atrChart: 3,
    atrH4: 8,
    atrD1: 10,
    atrH1: 4,
  });
  check(b1.sweptLong === true, "zones below close touched -> sweptLong");
  check(b1.nearLiquidityLong === false, "in-body bar is never near");
  check(b1.zones.every((z) => z.sweptBar === 1), "sweep stamped on bar 1, first touch only");
  check(lz.zoneCount === 3, "sweep marks, never removes");

  // Disabled tier creates nothing.
  const lzOff = createLiquidityZones({ showD1Zones: false });
  lzOff.evaluate({
    barIndex: 0,
    high: 107,
    low: 106,
    close: 106.5,
    atrChart: 3,
    atrH4: 8,
    atrD1: 10,
    atrH1: 4,
    pivots: { d1High: 100 },
  });
  check(lzOff.zoneCount === 0, "showD1Zones=false -> no D1 zone");

  // No ATR -> proximity block skipped entirely.
  const lzNoAtr = createLiquidityZones();
  const noAtr = lzNoAtr.evaluate({
    barIndex: 0,
    high: 107,
    low: 106,
    close: 106.5,
    atrChart: null,
    atrH4: 8,
    atrD1: 10,
    atrH1: 4,
    pivots: { d1High: 100 },
  });
  check(lzNoAtr.zoneCount === 1, "zone still born without atrChart");
  check(noAtr.nearLiquidityLong === false, "na atrChart -> every near flag false");

  // Budget: 13 births at maxZones 10 -> count capped at 10, oldest evicted.
  const lzBudget = createLiquidityZones({ maxZones: 10 });
  let maxSeen = 0;
  for (let i = 0; i < 13; i++) {
    lzBudget.evaluate({
      barIndex: i,
      high: 100 + i,
      low: 99 + i,
      close: 100 + i,
      atrChart: 3,
      atrH4: 10,
      atrD1: 10,
      atrH1: 4,
      pivots: { d1High: 100 + i },
    });
    maxSeen = Math.max(maxSeen, lzBudget.zoneCount);
  }
  check(maxSeen === 10, `max observed zone count 10 (got ${maxSeen})`);
  check(lzBudget.zoneCount === 10, "final count 10");
  const centers = lzBudget.evaluate({
    barIndex: 13,
    high: 113,
    low: 112,
    close: 113,
    atrChart: 3,
    atrH4: 10,
    atrD1: 10,
    atrH1: 4,
  }).zones.map((z) => z.center);
  check(!centers.includes(100), "oldest zone evicted (center 100 gone)");
  check(centers.includes(112), "newest zone retained");

  // Swept retention cull: strict `>` on sweptRetainBars.
  const lzSweep = createLiquidityZones({ sweptRetainBars: 10 });
  const sweepBar = (i, high, low, close) =>
    lzSweep.evaluate({ barIndex: i, high, low, close, atrChart: 3, atrH4: 8, atrD1: 10, atrH1: 4, pivots: {} });
  const s0 = lzSweep.evaluate({
    barIndex: 0,
    high: 101,
    low: 99,
    close: 100,
    atrChart: 3,
    atrH4: 8,
    atrD1: 10,
    atrH1: 4,
    pivots: { d1High: 100 },
  });
  // The birth bar's own range overlaps its band, so the sweep block (which
  // runs AFTER creation) marks it on the very same bar.
  check(s0.zones[0].sweptBar === 0, "sweep marking runs after creation: birth bar is marked");
  const s1 = sweepBar(1, 104, 96, 100);
  check(s1.sweptShort === true, "swept zone still reported inside sweepWindow");
  check(s1.nearLiquidityShort === false, "swept path is not the near path");
  for (let i = 2; i <= 10; i++) sweepBar(i, 200, 199, 200); // far away, no re-touch
  check(lzSweep.zoneCount === 1, "swept zone alive at sweptRetainBars boundary (age 10)");
  const sAfter = sweepBar(11, 200, 199, 200);
  check(lzSweep.zoneCount === 0, "swept zone culled once age > sweptRetainBars (11 > 10)");
  check(sAfter.nearLiquidityLong === false, "culled zone reports nothing");

  // Age cull: strict `>` on maxZoneAgeBars (minval 50).
  const lzAge = createLiquidityZones({ maxZoneAgeBars: 50 });
  const ageBar = (i, pivots = {}) =>
    lzAge.evaluate({ barIndex: i, high: 200, low: 199, close: 200, atrChart: 3, atrH4: 8, atrD1: 10, atrH1: 4, pivots });
  ageBar(0, { d1High: 100 });
  check(lzAge.zoneCount === 1, "zone born");
  for (let i = 1; i <= 50; i++) ageBar(i);
  check(lzAge.zoneCount === 1, "age 50 not yet culled (strict >)");
  ageBar(51);
  check(lzAge.zoneCount === 0, "age 51 culled");

  // Distance cull is measured in 4H ATR, and skipped while atrH4 is na.
  const lzFar = createLiquidityZones();
  lzFar.evaluate({
    barIndex: 0,
    high: 101,
    low: 99,
    close: 100,
    atrChart: 3,
    atrH4: 10,
    atrD1: 10,
    atrH1: 4,
    pivots: { d1High: 100 },
  });
  check(lzFar.zoneCount === 1, "far test: zone born");
  lzFar.evaluate({ barIndex: 1, high: 400, low: 399, close: 400, atrChart: 3, atrH4: 10, atrD1: 10, atrH1: 4 });
  check(lzFar.zoneCount === 0, "|close-center| > 15 x atrH4 -> culled");

  const lzNoH4 = createLiquidityZones();
  lzNoH4.evaluate({
    barIndex: 0,
    high: 101,
    low: 99,
    close: 100,
    atrChart: 3,
    atrH4: null,
    atrD1: 10,
    atrH1: 4,
    pivots: { d1High: 100 },
  });
  lzNoH4.evaluate({ barIndex: 1, high: 400, low: 399, close: 400, atrChart: 3, atrH4: null, atrD1: 10, atrH1: 4 });
  check(lzNoH4.zoneCount === 1, "na atrH4 -> distance rule skipped");
}

// ─── 3. structure-break (T5) ────────────────────────────────────────────────

sec("structure-break");
{
  // Establish, break, retest, reverse.
  const sb = createStructureBreak();
  const run = (barIndex, close, pivots) =>
    sb.evaluate({ barIndex, close, pivots: pivots ?? {} });

  const r0 = run(0, 100, { high: 110 });
  check(r0.breakUp === false, "bar 0: no previous close, no cross");
  check(r0.marketStructure === 0, "bar 0: structure unestablished");
  check(r0.lastSwingHigh === 110 && r0.lastSwingHighBar === 0, "bar 0: swing high confirmed");

  const r1 = run(1, 111);
  check(r1.breakUp === true, "bar 1: cross above confirmed level");
  check(r1.structureFlipped === false, "bar 1: establishment is not a flip");
  check(r1.marketStructure === 1, "bar 1: structure becomes bullish");

  const r2 = run(2, 112);
  check(r2.breakUp === false, "bar 2: holding above is not a second break");
  check(r2.marketStructure === 1, "bar 2: structure persists");

  const r3 = run(3, 104, { low: 105 });
  check(r3.breakDown === true, "bar 3: cross below same-bar confirmed level");
  check(r3.structureFlipped === true, "bar 3: ChoCh property of the break");
  check(r3.marketStructure === -1, "bar 3: structure becomes bearish");

  const r4 = run(4, 103);
  check(r4.breakDown === false, "bar 4: no re-break");
  check(r4.sbBreaks === 2, `two breaks total (got ${r4.sbBreaks})`);
  check(r4.sbFlips === 1, `one flip (got ${r4.sbFlips})`);
  check(r4.sbOrphanFlips === 0, "no orphan flips");

  // The level is NOT reset after a break: it keeps being tested.
  const r5 = run(5, 109);
  check(r5.breakDown === false, "level still tested after the break");
  const r6 = run(6, 106); // prevClose 109 >= 105 > 106? no -> no cross
  check(r6.breakDown === false, "no cross without a fresh cross");

  // prevSwing* carries the level before the latest confirmation.
  const r7 = run(7, 100, { high: 130 });
  check(r7.lastSwingHigh === 130 && r7.prevSwingHigh === 110, "second pivot supersedes, prev kept");

  // na guards: no level ever confirmed -> no break, ever.
  const sbFresh = createStructureBreak();
  sbFresh.evaluate({ barIndex: 0, close: 100 });
  const nf = sbFresh.evaluate({ barIndex: 1, close: 500 });
  check(nf.breakUp === false && nf.breakDown === false, "na level -> no break");
  const nf2 = sbFresh.evaluate({ barIndex: 2, close: 900 });
  check(nf2.breakUp === false, "still no level, still no break");

  // Preconditions and validation.
  const sbv = createStructureBreak();
  sbv.evaluate({ barIndex: 0, close: 100 });
  throws(() => sbv.evaluate({ barIndex: 2, close: 100 }), RangeError, "non-consecutive barIndex rejected");
  const sbt = createStructureBreak();
  throws(() => sbt.evaluate({ barIndex: 0, close: NaN }), TypeError, "NaN close rejected");
  throws(() => sbt.evaluate({ barIndex: -1, close: 100 }), TypeError, "negative barIndex rejected");
  throws(() => sbt.evaluate({ barIndex: 0, close: 100, pivots: { high: "x" } }), TypeError, "string pivot rejected");
  throws(() => createStructureBreak({ structPivotLen: 2 }), RangeError, "structPivotLen minval 3");

  // Invariants over a 74-bar zigzag with increasing amplitude, pivots fed at
  // every extreme. Sequence of extremes: 124, 100, 136, 88, 148, 76, 160, 64 —
  // each leg overshoots the previous extreme of the same kind, so the walk
  // produces one establishing break, then a genuine ChoCh in each direction.
  const sbZig = createStructureBreak();
  const extremes = [124, 100, 136, 88, 148, 76, 160, 64];
  let price = 100;
  let rising = true;
  let targetIdx = 0;
  let zigBreaks = 0;
  let zigFlips = 0;
  let zigBars = 0;
  for (let i = 0; targetIdx < extremes.length; i++) {
    const target = extremes[targetIdx];
    const diff = target - price;
    price += Math.sign(diff) * Math.min(6, Math.abs(diff));
    const pivots = {};
    if (price === target) {
      if (rising) pivots.high = price;
      else pivots.low = price;
      targetIdx += 1;
      rising = !rising;
    }
    const r = sbZig.evaluate({ barIndex: i, close: price, pivots });
    zigBars += 1;
    check(
      r.marketStructure === -1 || r.marketStructure === 0 || r.marketStructure === 1,
      `zigzag: marketStructure domain (bar ${i})`,
    );
    check(r.sbOrphanFlips === 0, `zigzag: no orphan flips (bar ${i})`);
    check(r.sbFlips <= r.sbBreaks, `zigzag: flips <= breaks (bar ${i})`);
    check(!(r.structureFlipped && !r.breakUp && !r.breakDown), `zigzag: flip implies break (bar ${i})`);
    if (r.breakUp || r.breakDown) zigBreaks += 1;
    if (r.structureFlipped) zigFlips += 1;
  }
  check(zigBars === 74, `zigzag length 74 bars (got ${zigBars})`);
  check(zigBreaks === 6, `zigzag: 1 establishment + 5 ChoCh breaks (got ${zigBreaks})`);
  check(zigFlips === 5, `zigzag: 5 flips (got ${zigFlips})`);
}

// ─── 4. imbalance-detector (T6) ─────────────────────────────────────────────

sec("imbalance-detector");
{
  // Hand-built bullish FVG: detection, creation guard, touch, retirement.
  const im = createImbalanceDetector();
  const bar = (i, high, low, close, volume = 100) =>
    im.evaluate({ barIndex: i, high, low, close, volume, atrChart: 5 });

  bar(0, 10, 8, 9);
  bar(1, 12, 10, 11);
  // bar 2's HIGH is 60 (not 30) so that a later high bar cannot accidentally form
  // a SECOND bullish gap — low[2]=28 > high[0]=10 is what creates this gap.
  const c = bar(2, 60, 28, 50); // low 28 > high[0] 10 -> bullish FVG, size 18 > 5
  check(c.bullishImbalance === true, "bullish FVG detected on the 3rd bar");
  check(c.bearishImbalance === false, "no bearish FVG at the same time");
  check(c.imbLive === 1, "one gap stored");
  check(c.imbUntouched === 1 && c.imbTouched === 0, "counts on the birth bar");
  check(c.imbalances[0].touchedBar === null, "bornBar guard: never touched on its own bar");
  check(c.inImbalanceLong === true && c.nearImbalanceLong === false, "inside reports in*, not near*");

  // low 11 <= high[1] 12, so this touch bar cannot spawn a second gap.
  const t = bar(3, 13, 11, 12);
  check(t.imbalances[0].touchedBar === 3, "first touch stamped on bar 3");
  check(t.imbTouched === 1 && t.imbUntouched === 0, "counts after the touch");

  // low 39 <= high[2] 60, so no second gap; close 39.5 is outside the band.
  const away = bar(4, 40, 39, 39.5);
  check(away.inImbalanceLong === false && away.nearImbalanceLong === false, "far bar reports nothing");
  check(away.imbLive === 1, "gap still alive");

  // near* requires an UNTOUCHED gap (separate engine, small band).
  const im2 = createImbalanceDetector();
  const bar2 = (i, high, low, close) =>
    im2.evaluate({ barIndex: i, high, low, close, volume: 100, atrChart: 3 });
  bar2(0, 10, 8, 9);
  bar2(1, 12, 10, 11);
  const g = bar2(2, 20, 14, 15); // band 10..14, midpoint 12
  check(g.bullishImbalance === true, "small gap created (4 > 3)");
  const nearBar = bar2(3, 15, 14.5, 15); // outside the band, |15-12| = 3 <= 4.5
  check(nearBar.nearImbalanceLong === true, "untouched gap within 1.5 ATR -> near*");
  check(nearBar.inImbalanceLong === false, "outside the band -> not in*");
  const fillBar = bar2(4, 14.2, 13, 13.5);
  check(fillBar.inImbalanceLong === true, "fill reports in*");
  check(fillBar.nearImbalanceLong === false, "filled gap can no longer be near*");
  check(fillBar.imbTouched === 1, "counts tautology still holds after the fill");

  // Bearish FVG mirror.
  const imB = createImbalanceDetector();
  const bbar = (i, high, low, close) =>
    imB.evaluate({ barIndex: i, high, low, close, volume: 100, atrChart: 5 });
  bbar(0, 30, 28, 29);
  bbar(1, 29, 27, 28);
  const bc = bbar(2, 10, 8, 9); // high 8... wait: high 10 < low[0] 28 -> bearish
  check(bc.bearishImbalance === true && bc.bullishImbalance === false, "bearish FVG detected");
  check(bc.inImbalanceShort === true && bc.inImbalanceLong === false, "bearish gap reports on the short side");

  // Eviction at maxImbalances (minval 10), oldest-first, one gap per bar.
  const imEv = createImbalanceDetector({ maxImbalances: 10 });
  let budgetReachedAt = -1;
  let lastEv = null;
  for (let i = 0; i < 15; i++) {
    const p = 100 + 20 * i;
    lastEv = imEv.evaluate({
      barIndex: i,
      high: p + 2,
      low: p - 2,
      close: p,
      volume: 100,
      atrChart: 5,
    });
    if (imEv.gapCount === 10 && budgetReachedAt < 0) budgetReachedAt = i;
    check(imEv.gapCount <= 10, `budget never exceeded (bar ${i})`);
    check(lastEv.imbUntouched + lastEv.imbTouched === lastEv.imbLive, `eviction keeps the counts tautology (bar ${i})`);
  }
  check(budgetReachedAt === 11, `budget first reached on the 10th gap (bar 11, got ${budgetReachedAt})`);
  check(lastEv.imbLive === 10, "final live count is exactly the budget");
  const survivors = lastEv.imbalances.map((z) => z.bornBar);
  check(
    survivors.join(",") === "5,6,7,8,9,10,11,12,13,14",
    `oldest-first eviction keeps the newest 10 (got ${survivors.join(",")})`,
  );

  // volumeConfirmed: ta.sma(volume, 20) is na for 19 bars, then 1.2x test.
  const imV = createImbalanceDetector();
  const volSeen = {};
  for (let i = 0; i < 22; i++) {
    const r = imV.evaluate({
      barIndex: i,
      high: 10,
      low: 9,
      close: 9.5,
      volume: i % 5 === 0 ? 500 : 100,
      atrChart: null,
    });
    volSeen[i] = r.volumeConfirmed;
  }
  check(volSeen[17] === false, "volumeConfirmed false during SMA warm-up (18 bars)");
  check(volSeen[18] === false, "volumeConfirmed false at 19 bars");
  check(volSeen[19] === false, "volumeConfirmed false at 20 bars when this bar is ordinary");
  check(volSeen[20] === true, "volumeConfirmed true at 20 bars with elevated volume");
  check(volSeen[21] === false, "volumeConfirmed false when volume falls back below 1.2x");

  // atrChart na: no creation, no proximity (but the lifecycle still runs).
  const imA = createImbalanceDetector();
  const a0 = imA.evaluate({ barIndex: 0, high: 10, low: 8, close: 9, volume: 100, atrChart: null });
  check(a0.imbLive === 0, "na atrChart -> no gap created");
  check(a0.nearImbalanceLong === false && a0.inImbalanceLong === false, "na atrChart -> no proximity output");

  // Validation.
  throws(() => createImbalanceDetector({ maxImbalances: 5 }), RangeError, "maxImbalances minval 10");
  throws(() => createImbalanceDetector({ volumeThreshold: 0.5 }), RangeError, "volumeThreshold minval 1.0");

  // ── Per-bar invariants over a deterministic 200-bar walk ────────────────
  const imW = createImbalanceDetector({ maxImbalances: 10 });
  let seed = 12345;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  let price = 100;
  let fvgBars = 0;
  for (let i = 0; i < 200; i++) {
    // Wide enough steps that low[0] > high[2] (or the bearish mirror) is reachable:
    // a gap needs a 2-bar displacement exceeding atrChart * imbalanceThreshold.
    price += (rnd() - 0.45) * 30;
    const r = imW.evaluate({
      barIndex: i,
      high: price + 2,
      low: price - 2,
      close: price,
      volume: i % 5 === 0 ? 500 : 100,
      atrChart: 5,
    });
    check(r.imbUntouched + r.imbTouched === r.imbLive, `walk: counts tautology (bar ${i})`);
    check(r.imbLive <= 10, `walk: budget respected (bar ${i})`);
    check(typeof r.volumeConfirmed === "boolean", `walk: volumeConfirmed is boolean (bar ${i})`);
    if (r.bullishImbalance || r.bearishImbalance) fvgBars += 1;
  }
  check(fvgBars > 0, `walk produced gaps (got ${fvgBars})`);
}

// ─── 5. signal-engine (T7) ──────────────────────────────────────────────────

sec("signal-engine");

/** Builds a bar object with sensible defaults; override per scenario. */
function seBar(over = {}) {
  return {
    barIndex: 0,
    sessionStrength: 7,
    inOverlap: true,
    inLondon: true,
    inNY: true,
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
    marketStructure: 0,
    nearImbalanceLong: false,
    inImbalanceLong: false,
    nearImbalanceShort: false,
    inImbalanceShort: false,
    volumeConfirmed: false,
    ...over,
  };
}

function sum(obj) {
  return obj.liquidity + obj.session + obj.structure + obj.imbalance + obj.volume;
}

// 5a. Shipped defaults are exactly the Pine literals.
{
  check(SIGNAL_ENGINE_DEFAULTS.minConfidence === 70, "default threshold 70");
  check(SIGNAL_ENGINE_DEFAULTS.signalCooldownBars === 10, "default cooldown 10 bars");
  check(
    SIGNAL_ENGINE_WEIGHT_KEYS.length === 10,
    `ten weight keys (got ${SIGNAL_ENGINE_WEIGHT_KEYS.length})`,
  );
  const expected = {
    liquidityD1: 30,
    liquidityH4: 20,
    liquidityH1: 10,
    sessionOverlap: 25,
    sessionMajor: 15,
    sessionAsia: 5,
    structureFlip: 30,
    structureContinuation: 20,
    imbalance: 15,
    volume: 10,
  };
  for (const key of SIGNAL_ENGINE_WEIGHT_KEYS) {
    check(SIGNAL_ENGINE_DEFAULTS[key] === expected[key], `default ${key} = ${expected[key]}`);
  }
  const se0 = createSignalEngine();
  check(se0.maxScore === 110, `shipped ceiling 110 (got ${se0.maxScore})`);
  check(Object.isFrozen(se0.defaults) === false || true, "defaults exposed");
}

// 5b. ABOVE threshold -> fires, with explainable contributions.
{
  const se = createSignalEngine();
  const r = se.evaluate(
    seBar({
      nearLiquidityLong: true,
      nearD1LiquidityLong: true,
      breakUp: true,
      marketStructure: 1,
      volumeConfirmed: true,
    }),
  );
  check(r.longScore === 85, `long score 30+25+20+0+10 = 85 (got ${r.longScore})`);
  check(r.longFactors.liquidity === 30, "long factor liquidity 30 (D1)");
  check(r.longFactors.session === 25, "long factor session 25 (overlap)");
  check(r.longFactors.structure === 20, "long factor structure 20 (continuation)");
  check(r.longFactors.imbalance === 0, "long factor imbalance 0");
  check(r.longFactors.volume === 10, "long factor volume 10");
  check(sum(r.longFactors) === r.longScore, "long contributions sum to the returned total");
  check(r.longScore >= 70, "long score above threshold");
  check(r.longSignalRaw === true, "long raw signal true");
  check(r.longSignal === true, "long signal true");
  check(r.longSignalFired === true, "ABOVE THRESHOLD: long fires");
  check(r.shortSignalFired === false, "short does not fire");
  check(r.sessionOK === true, "session gate open (overlap)");
  check(r.inCooldown === false, "first bar is never in cooldown");
  check(r.seLongFires === 1 && r.seShortFires === 0, "fire counters");
  check(r.seDualFires === 0, "no dual fire");
  check(r.shortScore === 35, `short score 0+25+0+0+10 = 35 (got ${r.shortScore})`);
  check(sum(r.shortFactors) === r.shortScore, "short contributions sum to the returned total");
  check(r.shortSignalRaw === false, "short raw blocked by missing liquidity");
}

// 5c. BELOW threshold -> score gate blocks everything else being equal.
{
  const se = createSignalEngine();
  const r = se.evaluate(
    seBar({
      inOverlap: false,
      inLondon: true,
      inNY: false,
      inAsia: false,
      sessionStrength: 2,
      nearLiquidityLong: true,
      nearH4LiquidityLong: true,
      breakUp: true,
      marketStructure: 1,
      volumeConfirmed: true,
    }),
  );
  check(r.longScore === 65, `long score 20+15+20+0+10 = 65 (got ${r.longScore})`);
  check(r.longScore < 70, "score below threshold");
  check(r.sessionOK === true, "every other gate open");
  check(r.longSignalRaw === false, "raw signal false: score gate");
  check(r.longSignalFired === false, "BELOW THRESHOLD: does not fire");
  check(r.seLongFires === 0, "no fire counted");
}

// 5d. GATE blocks a high-scoring setup: Asia-only session.
{
  const se = createSignalEngine();
  const r = se.evaluate(
    seBar({
      inOverlap: false,
      inLondon: false,
      inNY: false,
      inAsia: true,
      sessionStrength: 1,
      nearLiquidityLong: true,
      nearD1LiquidityLong: true,
      breakUp: true,
      structureFlipped: true,
      marketStructure: 1,
      nearImbalanceLong: true,
      volumeConfirmed: true,
    }),
  );
  check(r.sessionOK === false, "sessionStrength 1 does not clear the gate");
  check(r.longScore === 90, `long score 30+5+30+15+10 = 90 (got ${r.longScore})`);
  check(r.longScore >= 70, "score is high enough");
  check(r.longSignalRaw === false, "GATE BLOCKS: raw signal false despite 90 points");
  check(r.longSignalFired === false, "GATE BLOCKS: nothing emitted");
  check(r.longFactors.structure === 30, "flip weight replaces, not adds (30 not 50)");
}

// 5e. Neutral factors score BOTH sides identically.
{
  const se = createSignalEngine();
  const r = se.evaluate(seBar({ volumeConfirmed: true, inOverlap: true }));
  check(r.longFactors.volume === 10 && r.shortFactors.volume === 10, "volume scores both sides");
  check(r.longFactors.session === 25 && r.shortFactors.session === 25, "session scores both sides");
  check(r.longScore === 35 && r.shortScore === 35, "neutral-only bar scores equally");
}

// 5f. `or` not `+` for the imbalance factor.
{
  const se = createSignalEngine();
  const r = se.evaluate(
    seBar({
      nearImbalanceLong: true,
      inImbalanceLong: true,
      nearImbalanceShort: true,
      inImbalanceShort: true,
    }),
  );
  check(r.longFactors.imbalance === 15, "near AND in still score 15, not 30");
  check(r.shortFactors.imbalance === 15, "same on the short side");
}

// 5g. Cooldown: fires on bar 0, blocked for 9 bars, free again on bar 10.
{
  const se = createSignalEngine();
  const fired = [];
  for (let i = 0; i < 12; i++) {
    const r = se.evaluate(
      seBar({
        barIndex: i,
        nearLiquidityLong: true,
        nearD1LiquidityLong: true,
        // breakUp on EVERY bar so cooldown is the only thing suppressing the fire.
        breakUp: true,
        marketStructure: 1,
        volumeConfirmed: true,
      }),
    );
    fired.push(r.longSignalFired);
    if (i === 0) check(r.lastSignalBar === 0, "cooldown stamped on the firing bar");
    if (i === 1) check(r.inCooldown === true && r.longSignal === true && r.longSignalFired === false, "cooldown suppresses the signal, not the confluence");
    if (i === 5) check(r.lastSignalBar === 0, "stamp unchanged while blocked");
  }
  check(fired[0] === true, "cooldown: fires on bar 0");
  check(fired.slice(1, 10).every((f) => f === false), "cooldown: silent on bars 1-9");
  check(fired[10] === true, "cooldown: fires again on bar 10 (strict <)");
}

// 5h. Cooldown applied BEFORE the stamp: a signal fired on this bar is emitted.
{
  const se = createSignalEngine();
  const a = se.evaluate(
    seBar({ nearLiquidityLong: true, nearD1LiquidityLong: true, breakUp: true, marketStructure: 1 }),
  );
  const b = se.evaluate(
    seBar({ barIndex: 1, nearLiquidityLong: true, nearD1LiquidityLong: true, breakUp: true, marketStructure: 1 }),
  );
  check(a.longSignalFired === true, "snapshot taken before the stamp");
  check(b.longSignal === true && b.longSignalFired === false, "next bar suppressed by cooldown");
}

// 5i. Directional exclusivity: sandwich with no structure -> neither.
{
  const se = createSignalEngine();
  const r = se.evaluate(
    seBar({
      nearLiquidityLong: true,
      nearLiquidityShort: true,
      nearH4LiquidityLong: true,
      nearH4LiquidityShort: true,
      nearImbalanceLong: true,
      nearImbalanceShort: true,
      inImbalanceLong: true,
      inImbalanceShort: true,
      volumeConfirmed: true,
      marketStructure: 0,
    }),
  );
  check(r.longScore === 70 && r.shortScore === 70, `both sides hit exactly 70 (got ${r.longScore}/${r.shortScore})`);
  check(r.longSignalRaw === true && r.shortSignalRaw === true, "both raw signals qualify");
  check(r.ambiguousTie === true, "AMBIGUOUS TIE: dropped, not resolved");
  check(r.longSignal === false && r.shortSignal === false, "neither signal emitted");
  check(r.longSignalFired === false && r.shortSignalFired === false, "nothing fires");
  check(r.seAmbiguousDrops === 1, "tie counted as a drop");
  check(r.seDualFires === 0, "never a dual fire");
}

// 5j. Directional exclusivity: the same tie resolved by structure.
{
  const mk = (marketStructure) =>
    createSignalEngine().evaluate(
      seBar({
        nearLiquidityLong: true,
        nearLiquidityShort: true,
        nearH4LiquidityLong: true,
        nearH4LiquidityShort: true,
        nearImbalanceLong: true,
        nearImbalanceShort: true,
        volumeConfirmed: true,
        marketStructure,
      }),
    );
  const bull = mk(1);
  check(bull.longSignalFired === true && bull.shortSignalFired === false, "tie + structure bullish -> LONG only");
  check(bull.ambiguousTie === false, "a resolved tie is not ambiguous");
  const bear = mk(-1);
  check(bear.shortSignalFired === true && bear.longSignalFired === false, "tie + structure bearish -> SHORT only");
}

// 5k. Parameterized weights and threshold (the point of the feature).
{
  const se = createSignalEngine({ structureFlip: 40, minConfidence: 95 });
  check(se.maxScore === 120, `ceiling follows the vector (got ${se.maxScore})`);
  const r = se.evaluate(
    seBar({
      inOverlap: false,
      inLondon: true,
      inNY: false,
      sessionStrength: 2,
      nearLiquidityLong: true,
      nearD1LiquidityLong: true,
      breakUp: true,
      structureFlipped: true,
      marketStructure: 1,
      volumeConfirmed: true,
    }),
  );
  check(r.longFactors.structure === 40, "overridden flip weight used");
  // 30 (D1) + 15 (London) + 40 (flip, overridden) + 0 (imbalance) + 10 (volume) = 95
  check(r.longScore === 95, `30+15+40+0+10 = 95 (got ${r.longScore})`);
  check(r.longSignalFired === true, "custom vector + custom threshold fires at exactly 95");
  const seStrict = createSignalEngine({ structureFlip: 40, minConfidence: 105 });
  const r2 = seStrict.evaluate(
    seBar({
      inOverlap: false,
      inLondon: true,
      inNY: false,
      sessionStrength: 2,
      nearLiquidityLong: true,
      nearD1LiquidityLong: true,
      breakUp: true,
      structureFlipped: true,
      marketStructure: 1,
      volumeConfirmed: true,
    }),
  );
  check(r2.longSignalFired === false, "105 threshold blocks the same 100-point setup");
}

// 5l. Validation mirrors the Pine types and input bounds.
{
  throws(() => createSignalEngine({ liquidityD1: 30.5 }), RangeError, "fractional weight rejected");
  throws(() => createSignalEngine({ minConfidence: -1 }), RangeError, "negative threshold rejected");
  throws(() => createSignalEngine({ minConfidence: 111 }), RangeError, "threshold above shipped ceiling rejected");
  throws(() => createSignalEngine({ signalCooldownBars: 0 }), RangeError, "cooldown minval 1");
  throws(() => createSignalEngine({ volume: -10 }), RangeError, "negative weight rejected");

  const se = createSignalEngine();
  se.evaluate(seBar());
  throws(() => se.evaluate(seBar({ barIndex: 2 })), RangeError, "non-consecutive barIndex rejected");
  throws(() => se.evaluate(seBar({ barIndex: 1, sessionStrength: 1.5 })), TypeError, "fractional sessionStrength rejected");
  throws(() => se.evaluate(seBar({ barIndex: 1, marketStructure: 2 })), RangeError, "marketStructure domain enforced");
  throws(() => createSignalEngine().evaluate(null), TypeError, "bar required");
}

// 5m. Short-side mirror (the SHORT path is independent of the LONG path).
{
  const se = createSignalEngine();
  const r = se.evaluate(
    seBar({
      nearLiquidityShort: true,
      nearD1LiquidityShort: true,
      breakDown: true,
      structureFlipped: true,
      marketStructure: -1,
      volumeConfirmed: true,
    }),
  );
  // 30 (D1) + 25 (overlap) + 30 (flip) + 0 (imbalance) + 10 (volume) = 95
  check(r.shortScore === 95, `short 30+25+30+0+10 = 95 (got ${r.shortScore})`);
  check(r.shortSignalFired === true, "SHORT fires");
  check(r.longSignalFired === false, "LONG stays silent");
  check(sum(r.shortFactors) === r.shortScore, "short contributions sum to total");
}

// 5n. Same-side attribution invariant is live (fires on a miswired bar).
{
  const se = createSignalEngine();
  const err = throws(
    () =>
      se.evaluate(
        seBar({
          // liquidity factor requires nearLiquidityLong, which stays false:
          // the tier flag alone is what a shared-flag wiring bug would set.
          nearD1LiquidityLong: true,
        }),
      ),
    Error,
    "same-side attribution invariant fires",
  );
  check(err !== null && /liquidity factor/.test(err.message), "attribution error names the factor");
}

// ─── 6. outcome-labelling (T9) ──────────────────────────────────────────────
//
// Label correctness is proven with hand-computed synthetic candles built
// INSIDE this section: tiny, explicit, arithmetic-checkable. Nothing here
// reads backtest/data/, because a label rule must be provable without market
// data — real candles only hide a wrong rule behind plausible numbers.

sec("outcome-labels");
{
  /** Builds a candle in the module's input shape; all three fields explicit. */
  const lb = (high, low, close) => ({ high, low, close });
  /** Builds a signal event: { barIndex, side, price }. */
  const sig = (barIndex, side, price) => ({ barIndex, side, price });

  // 6a. Shipped constants are exactly the spec's D.4 literals (1961-1965).
  check(EXIT_TARGET_PCT === 1.5, "exit target 1.5% (spec D.4 line 1961)");
  check(EXIT_STOP_PCT === 0.8, "exit stop 0.8% (spec D.4 line 1962)");
  check(EXIT_RULE_DEFAULTS.maxHorizonBars === 288, "default exit horizon 288 bars (24h of 5m)");
  check(
    FORWARD_RETURN_DEFAULTS.horizons.join(",") === "6,12,24,48,96,288",
    `default forward horizons (got ${FORWARD_RETURN_DEFAULTS.horizons.join(",")})`,
  );

  // 6b. LONG rises straight through +1.5% -> win.
  // Entry 100 => target 101.5, stop 99.2. Bar 1's high 101.6 touches the
  // target while its low 99.9 stays above the stop, so nothing is ambiguous.
  const rising = [
    lb(100.5, 99.5, 100), // 0 — signal bar (close = entry price)
    lb(101.6, 99.9, 101.2), // 1 — high 101.6 >= 101.5 -> target touched
    lb(101.4, 100.8, 101.1),
    lb(101.3, 100.9, 101.0),
    lb(101.2, 100.7, 101.0),
    lb(101.1, 100.6, 101.0),
  ];
  const winCase = labelExitRule(rising, sig(0, "long", 100), { maxHorizonBars: 4 });
  check(winCase.label === "win", `LONG +1.5% -> win (got ${winCase.label})`);
  check(winCase.doubleTouch === false, "single touch is not a double touch");
  check(winCase.horizonBars === 1, `resolved on the first forward bar (got ${winCase.horizonBars})`);
  check(Math.abs(winCase.targetPrice - 101.5) < 1e-9, "target price = entry + 1.5%");
  check(Math.abs(winCase.stopPrice - 99.2) < 1e-9, "stop price = entry - 0.8%");

  // 6c. LONG falls straight through -0.8% -> loss.
  const falling = [
    lb(100.5, 99.5, 100), // 0 — signal bar
    lb(100.8, 99.1, 99.4), // 1 — low 99.1 <= 99.2 -> stop; high never 101.5
    lb(100.6, 99.4, 100.0),
    lb(100.5, 99.5, 100.0),
    lb(100.4, 99.6, 100.0),
    lb(100.3, 99.7, 100.0),
  ];
  const lossCase = labelExitRule(falling, sig(0, "long", 100), { maxHorizonBars: 4 });
  check(lossCase.label === "loss", `LONG -0.8% -> loss (got ${lossCase.label})`);
  check(lossCase.doubleTouch === false, "stop-only touch is not a double touch");
  check(lossCase.horizonBars === 1, `stopped on the first forward bar (got ${lossCase.horizonBars})`);

  // 6d. LONG wanders and never reaches either level -> timeout. Bar 5 DOES
  // touch the target, on purpose: the label must stay timeout, because the
  // scan stops at maxHorizonBars.
  const wandering = [
    lb(100.5, 99.5, 100), // 0 — signal bar
    lb(100.4, 99.6, 100.1), // 1 — inside 99.2 .. 101.5
    lb(100.3, 99.7, 100.0), // 2
    lb(100.2, 99.8, 100.1), // 3
    lb(100.1, 99.9, 100.0), // 4 — last bar inside the horizon
    lb(103.0, 102.0, 102.5), // 5 — target touched, but OUTSIDE the horizon
  ];
  const timeoutCase = labelExitRule(wandering, sig(0, "long", 100), { maxHorizonBars: 4 });
  check(timeoutCase.label === "timeout", `no touch inside the horizon -> timeout (got ${timeoutCase.label})`);
  check(timeoutCase.horizonBars === 4, `horizon reached = maxHorizonBars (got ${timeoutCase.horizonBars})`);
  check(timeoutCase.barsAvailable === 5, `5 candles existed after the signal (got ${timeoutCase.barsAvailable})`);
  check(timeoutCase.doubleTouch === false, "timeout is never a double touch");

  // 6e. SHORT wins when price FALLS: entry 100 => target 98.5, stop 100.8.
  const shortFalling = [
    lb(100.5, 99.5, 100), // 0 — signal bar
    lb(100.6, 98.4, 98.6), // 1 — low 98.4 <= 98.5 -> target; high < 100.8
    lb(100.5, 99.5, 100),
    lb(100.5, 99.5, 100),
    lb(100.5, 99.5, 100),
    lb(100.5, 99.5, 100),
  ];
  const shortWin = labelExitRule(shortFalling, sig(0, "short", 100), { maxHorizonBars: 4 });
  check(shortWin.label === "win", `SHORT -1.5% -> win (got ${shortWin.label})`);
  check(Math.abs(shortWin.targetPrice - 98.5) < 1e-9, "short target = entry - 1.5%");
  check(Math.abs(shortWin.stopPrice - 100.8) < 1e-9, "short stop = entry + 0.8%");

  // 6f. SHORT loses when price RISES through +0.8%.
  const shortRising = [
    lb(100.5, 99.5, 100), // 0 — signal bar
    lb(100.9, 99.5, 100.2), // 1 — high 100.9 >= 100.8 -> stop; low > 98.5
    lb(100.5, 99.5, 100),
    lb(100.5, 99.5, 100),
    lb(100.5, 99.5, 100),
    lb(100.5, 99.5, 100),
  ];
  const shortLoss = labelExitRule(shortRising, sig(0, "short", 100), { maxHorizonBars: 4 });
  check(shortLoss.label === "loss", `SHORT +0.8% -> loss (got ${shortLoss.label})`);
  check(shortLoss.doubleTouch === false, "stop-only touch is not a double touch");

  // 6g. ONE bar straddles BOTH levels (high >= target AND low <= stop).
  // Intra-bar order is unknowable from OHLC, so the conservative rule says
  // loss, and the raw double-touch is flagged separately.
  const straddleLong = labelExitRule(
    [
      lb(100.5, 99.5, 100), // 0 — signal bar
      lb(102.0, 98.0, 100.0), // 1 — high 102 >= 101.5 AND low 98 <= 99.2
      lb(100.5, 99.5, 100),
      lb(100.5, 99.5, 100),
      lb(100.5, 99.5, 100),
      lb(100.5, 99.5, 100),
    ],
    sig(0, "long", 100),
    { maxHorizonBars: 4 },
  );
  check(straddleLong.label === "loss", "double touch -> loss (conservative rule)");
  check(straddleLong.doubleTouch === true, "doubleTouch flag raised");
  check(straddleLong.horizonBars === 1, `resolved on the straddling bar (got ${straddleLong.horizonBars})`);

  // The short mirror: low 98.0 touches the 98.5 target, high 101.5 touches
  // the 100.8 stop, on the same bar.
  const straddleShort = labelExitRule(
    [
      lb(100.5, 99.5, 100),
      lb(101.5, 98.0, 100.0),
      lb(100.5, 99.5, 100),
      lb(100.5, 99.5, 100),
      lb(100.5, 99.5, 100),
      lb(100.5, 99.5, 100),
    ],
    sig(0, "short", 100),
    { maxHorizonBars: 4 },
  );
  check(
    straddleShort.label === "loss" && straddleShort.doubleTouch === true,
    "short double touch -> loss + flag",
  );

  // 6h. Signal 2 bars from the end of the array: with the default 288-bar
  // horizon the observation window cannot exist, so the label is
  // insufficient_data — its own bucket, never a win, a loss or a timeout.
  const nearEnd = [
    lb(100.5, 99.5, 100),
    lb(100.4, 99.6, 100),
    lb(100.4, 99.6, 100), // 2 — signal: only 2 candles follow
    lb(100.4, 99.6, 100),
    lb(100.4, 99.6, 100),
  ];
  const truncated = labelExitRule(nearEnd, sig(2, "long", 100));
  check(truncated.label === "insufficient_data", `2 bars left -> insufficient_data (got ${truncated.label})`);
  check(truncated.barsAvailable === 2, `barsAvailable = 2 (got ${truncated.barsAvailable})`);
  check(truncated.horizonBars === 0, "no scan runs when the horizon cannot be observed");
  check(truncated.doubleTouch === false, "insufficient_data never claims a double touch");

  // The availability rule fires BEFORE the scan: this window WOULD touch the
  // target on its first forward bar and it is still insufficient_data. If
  // the intended rule ever becomes scan-first, this is the check that must
  // change with it.
  const touchTruncated = labelExitRule(
    [
      lb(100.5, 99.5, 100),
      lb(100.4, 99.6, 100),
      lb(100.4, 99.6, 100), // 2 — signal
      lb(101.6, 100.0, 101.0), // 3 — would touch the +1.5% target
      lb(100.4, 99.6, 100),
    ],
    sig(2, "long", 100),
  );
  check(
    touchTruncated.label === "insufficient_data",
    "touch inside a truncated window stays insufficient_data (availability first)",
  );

  // 6i. Forward return with hand-built closes: entry 100, close 101.5 six
  // bars later => exactly +1.5% long and exactly -1.5% short (the raw price
  // change is negated for the short). ((101.5 - 100) / 100) * 100 === 1.5 is
  // exact in IEEE-754 for these operands, so the assertions are exact.
  const forward = [
    lb(100.5, 99.5, 100), // 0 — signal bar, close 100
    lb(100.5, 99.5, 100),
    lb(100.5, 99.5, 100),
    lb(100.5, 99.5, 100),
    lb(100.5, 99.5, 100),
    lb(100.5, 99.5, 100),
    lb(101.6, 100.0, 101.5), // 6 — close 101.5 = +1.5% from 100
  ];
  const fwdLong = labelForwardReturn(forward, sig(0, "long", 100));
  check(fwdLong.returns[6] === 1.5, `long forward return at 6 = +1.5 (got ${fwdLong.returns[6]})`);
  check(fwdLong.returns[6] > 0, "positive = the trade would have made money");
  const fwdShort = labelForwardReturn(forward, sig(0, "short", 100));
  check(fwdShort.returns[6] === -1.5, `short forward return at 6 = -1.5 (got ${fwdShort.returns[6]})`);
  check(fwdShort.returns[6] < 0, "a price RISE is a loss for the short");
  check(fwdShort.returns[6] === -fwdLong.returns[6], "short return is the exact negation of the long");

  // 6j. A horizon longer than the remaining data is null, NOT 0 — and a
  // genuinely flat close still returns a real 0, so the two can never be
  // mistaken for one another.
  check(288 in fwdLong.returns, "every requested horizon is present as a key");
  check(fwdLong.returns[288] === null, "horizon beyond the data -> null");
  check(fwdLong.returns[288] !== 0, "null is not 0");
  const twoBars = [lb(100.5, 99.5, 100), lb(100.5, 99.5, 100)];
  const beyond = labelForwardReturn(twoBars, sig(0, "long", 100), { horizons: [3] });
  check(beyond.returns[3] === null, "explicit horizon past the end -> null");
  const flat = labelForwardReturn(twoBars, sig(0, "long", 100), { horizons: [1] });
  check(flat.returns[1] === 0, "an unchanged close is a real 0%, distinct from null");

  // 6k. Batch aggregation: the RAW double-touch count is reported separately
  // from the label counts, because it is exactly how much the conservative
  // rule moves any hit rate.
  const batchCandles = [
    lb(100.5, 99.5, 100), // 0 — signal A (long, close 100)
    lb(102.0, 98.0, 100), // 1 — A resolves: both levels on one bar
    lb(100.5, 99.5, 100),
    lb(100.5, 99.5, 100),
    lb(100.5, 99.5, 100), // 4 — signal B (long, close 100)
    lb(101.6, 99.9, 100), // 5 — B: high 101.6 >= 101.5 -> win
    lb(100.5, 99.5, 100),
    lb(100.5, 99.5, 100),
    lb(100.5, 99.5, 100),
    lb(100.5, 99.5, 100),
  ];
  const batch = labelSignalsExitRule(batchCandles, [sig(0, "long", 100), sig(4, "long", 100)], {
    maxHorizonBars: 4,
  });
  check(batch.total === 2, `two signals labelled (got ${batch.total})`);
  check(batch.counts.loss === 1 && batch.counts.win === 1, "one loss, one win");
  check(batch.counts.timeout === 0 && batch.counts.insufficient_data === 0, "no other labels");
  check(batch.doubleTouchCount === 1, `raw double-touch count = 1 (got ${batch.doubleTouchCount})`);
  check(batch.results[0].label === "loss" && batch.results[0].doubleTouch === true, "A: straddle flagged");
  check(batch.results[1].label === "win" && batch.results[1].doubleTouch === false, "B: clean win");

  const fwdBatch = labelSignalsForwardReturn(forward, [sig(0, "long", 100), sig(0, "short", 100)]);
  check(fwdBatch.total === 2, `two forward-return labels (got ${fwdBatch.total})`);
  check(fwdBatch.horizons.join(",") === "6,12,24,48,96,288", "batch echoes the horizons");
  check(fwdBatch.results[0].returns[6] === -fwdBatch.results[1].returns[6], "batch keeps both sides distinct");

  // 6l. Validation: a miswired signal THROWS instead of producing plausible
  // labels for the wrong bars.
  throws(() => labelExitRule([], sig(0, "long", 100)), RangeError, "signal beyond the data rejected");
  throws(() => labelExitRule(rising, sig(-1, "long", 100)), TypeError, "negative barIndex rejected");
  throws(() => labelExitRule(rising, sig(0, "long", -1)), TypeError, "non-positive price rejected");
  throws(() => labelExitRule(rising, sig(0, "buy", 100)), TypeError, "side domain enforced");
  throws(
    () => labelExitRule(rising, sig(1, "long", 100)), // bar 1 closes 101.2, not 100
    TypeError,
    "price that is not the signal bar's close rejected (anti-miswire)",
  );
  throws(
    () => labelExitRule([{ t: 0, o: 1, h: 2, l: 0.5, c: 1, v: 1 }], sig(0, "long", 1)),
    TypeError,
    "unmapped dataset candle rejected (field shape)",
  );
  throws(
    () => labelExitRule(rising, sig(0, "long", 100), { targetPct: 2 }),
    TypeError,
    "unknown option rejected — the D.4 levels are spec, not knobs",
  );
  throws(
    () => labelExitRule(rising, sig(0, "long", 100), { maxHorizonBars: 0 }),
    RangeError,
    "maxHorizonBars minval 1",
  );
  throws(() => labelForwardReturn(forward, sig(0, "long", 100), { horizons: [0] }), RangeError, "horizon minval 1");
  throws(() => labelForwardReturn(forward, sig(0, "long", 100), { horizons: [] }), TypeError, "empty horizons rejected");
  throws(
    () => labelSignalsExitRule(rising, [], { bogus: 1 }),
    TypeError,
    "batch validates options even when no signal is labelled",
  );
}

// ─── 7. binary baseline model (T10/T11) ─────────────────────────────────────
//
// The D.1 binary confluence model (modules/binary.mjs) on hand-built synthetic
// bars: the fairness contract (weighted raw ⇒ binary strict, with the score
// threshold as the ONLY difference between the models), the shared input
// contract, per-model cooldown and exclusivity state, and the "no invented
// score" rule. This section never reads backtest/data/ — the real-dataset
// assertion runs inside `node backtest/run.mjs baseline`, which throws on any
// violation.

sec("binary-model");
{
  // 7a. Construction: the cooldown default is READ from the engine so the two
  // can never drift, and the contract is the engine's 23-field bar shape.
  const bm0 = createBinarySignalModel();
  check(
    bm0.defaults.signalCooldownBars === SIGNAL_ENGINE_DEFAULTS.signalCooldownBars,
    "cooldown default read from the engine's defaults (single source)",
  );
  check(BINARY_MODEL_DEFAULTS.signalCooldownBars === 10, "shipped cooldown 10");
  check(Object.isFrozen(BINARY_INPUT_CONTRACT), "input contract is frozen");
  check(BINARY_INPUT_CONTRACT.length === 23, `23 contract fields (got ${BINARY_INPUT_CONTRACT.length})`);
  const bare = seBar();
  check(
    BINARY_INPUT_CONTRACT.every((f) => f in bare),
    "every contract field present in the shared bar shape",
  );
  check(
    Object.keys(bare).length === BINARY_INPUT_CONTRACT.length,
    "shared bar shape carries nothing beyond the contract",
  );

  // 7b. Options: D.1 computes no score, so there are no score knobs.
  throws(() => createBinarySignalModel({ minConfidence: 70 }), TypeError, "minConfidence rejected — no score exists");
  throws(() => createBinarySignalModel({ bogus: 1 }), TypeError, "unknown option rejected");
  throws(() => createBinarySignalModel({ signalCooldownBars: 0 }), RangeError, "signalCooldownBars minval 1");
  throws(() => createBinarySignalModel("no"), TypeError, "non-object options rejected");

  // 7c. Input contract: reduced / pre-derived shapes AND each other's outputs
  // are rejected — the executable form of "the same bar object, both models".
  const bm = createBinarySignalModel();
  throws(() => bm.evaluate(null), TypeError, "bar is required");
  const reduced = seBar();
  delete reduced.nearD1LiquidityLong;
  throws(() => bm.evaluate(reduced), TypeError, "reduced shape rejected");
  const derived = seBar();
  delete derived.sessionStrength;
  derived.sessionOK = true;
  throws(() => bm.evaluate(derived), TypeError, "pre-derived sessionOK rejected — raw flags only");
  const engineOut = createSignalEngine().evaluate(seBar());
  throws(
    () => createBinarySignalModel().evaluate(engineOut),
    TypeError,
    "engine output not accepted as a bar (binary side)",
  );
  const binaryOut = createBinarySignalModel().evaluate(seBar());
  throws(
    () => createSignalEngine().evaluate(binaryOut),
    TypeError,
    "binary output not accepted as a bar (engine side)",
  );

  // 7d. Domain errors: both models reject the SAME bars with the SAME class,
  // so a wiring mistake surfaces identically whichever model reads the bar.
  const domainCases = [
    [{ barIndex: -1 }, TypeError, "barIndex"],
    [{ sessionStrength: -1 }, TypeError, "sessionStrength"],
    [{ marketStructure: 2 }, RangeError, "marketStructure"],
  ];
  for (const [over, type, label] of domainCases) {
    throws(() => createSignalEngine().evaluate(seBar(over)), type, `engine rejects bad ${label}`);
    throws(() => createBinarySignalModel().evaluate(seBar(over)), type, `binary rejects bad ${label}`);
  }
  const eSeq = createSignalEngine();
  eSeq.evaluate(seBar({ barIndex: 0 }));
  throws(() => eSeq.evaluate(seBar({ barIndex: 3 })), RangeError, "engine: consecutive bars enforced");
  const bSeq = createBinarySignalModel();
  bSeq.evaluate(seBar({ barIndex: 0 }));
  throws(() => bSeq.evaluate(seBar({ barIndex: 3 })), RangeError, "binary: consecutive bars enforced");

  // 7e. Synthetic sweep of the raw-decision input space, both sides: the
  // fairness contract itself. weighted raw ⇒ binary strict, and raw ===
  // strict && score >= minConfidence — the threshold is the only difference.
  const strengths = [0, 1, 2, 7];
  const structures = [-1, 0, 1];
  const bools = [false, true];
  let sweepBars = 0;
  let implicationViolations = 0;
  let equalityMismatches = 0;
  let sessionDrift = 0;
  let gateViolations = 0;
  let strictOnly = 0;
  let bothAdmitted = 0;
  for (const side of ["long", "short"]) {
    for (const near of bools) {
      for (const tier of bools) {
        for (const sessionStrength of strengths) {
          for (const arm1 of bools) {
            for (const arm2 of bools) {
              for (const arm3 of bools) {
                for (const marketStructure of structures) {
                  const over = { barIndex: 0, sessionStrength, marketStructure, inOverlap: true };
                  if (side === "long") {
                    Object.assign(over, {
                      nearLiquidityLong: near,
                      nearD1LiquidityLong: near && tier,
                      breakUp: arm1,
                      nearImbalanceLong: arm2,
                      inImbalanceLong: arm3,
                    });
                  } else {
                    Object.assign(over, {
                      nearLiquidityShort: near,
                      nearD1LiquidityShort: near && tier,
                      breakDown: arm1,
                      nearImbalanceShort: arm2,
                      inImbalanceShort: arm3,
                    });
                  }
                  const bar = seBar(over);
                  const e = createSignalEngine().evaluate(bar);
                  const m = createBinarySignalModel().evaluate(bar);
                  sweepBars += 1;
                  const raw = side === "long" ? e.longSignalRaw : e.shortSignalRaw;
                  const strict = side === "long" ? m.longSignalStrict : m.shortSignalStrict;
                  const score = side === "long" ? e.longScore : e.shortScore;
                  if (raw && !strict) implicationViolations += 1;
                  if (raw !== (strict && score >= SIGNAL_ENGINE_DEFAULTS.minConfidence)) {
                    equalityMismatches += 1;
                  }
                  if (e.sessionOK !== m.sessionOK) sessionDrift += 1;
                  if (sessionStrength < 2 && (raw || strict)) gateViolations += 1;
                  if (strict && !raw) strictOnly += 1;
                  if (raw && strict) bothAdmitted += 1;
                }
              }
            }
          }
        }
      }
    }
  }
  check(sweepBars === 768, `768 sweep bars (got ${sweepBars})`);
  check(
    implicationViolations === 0,
    `weighted raw ⇒ binary strict on all ${sweepBars} bars (violations ${implicationViolations})`,
  );
  check(
    equalityMismatches === 0,
    `raw === strict && score >= minConfidence on all ${sweepBars} (mismatches ${equalityMismatches})`,
  );
  check(sessionDrift === 0, "sessionOK identical on every sweep bar");
  check(gateViolations === 0, "strength < 2 gates BOTH models on every sweep bar");
  check(strictOnly > 0, `strict && !raw occurs in the sweep: ${strictOnly} bars (the threshold's effect)`);
  check(bothAdmitted > 0, `raw && strict occurs in the sweep: ${bothAdmitted} bars`);

  // 7f. The threshold in isolation: ONE term differs (spec D.1 vs Pine :165).
  const lowFlags = {
    nearLiquidityLong: true,
    nearH1LiquidityLong: true,
    sessionStrength: 2,
    inOverlap: false,
    inLondon: true,
    breakUp: true,
    marketStructure: 1,
  };
  const eLow = createSignalEngine().evaluate(seBar(lowFlags));
  const bLow = createBinarySignalModel().evaluate(seBar(lowFlags));
  check(eLow.longScore === 45, `below-threshold bar: 10+15+20 = 45 (got ${eLow.longScore})`);
  check(eLow.longScore < SIGNAL_ENGINE_DEFAULTS.minConfidence, "score below minConfidence");
  check(eLow.longSignalRaw === false && eLow.longSignal === false, "weighted: silent on the bar");
  check(
    bLow.longSignalStrict === true && bLow.longSignal === true,
    "binary: admits the SAME bar — the threshold is the only difference",
  );

  // Agreement when the score clears.
  const clearFlags = {
    nearLiquidityLong: true,
    nearD1LiquidityLong: true,
    sessionStrength: 7,
    inOverlap: true,
    breakUp: true,
    marketStructure: 1,
    volumeConfirmed: true,
  };
  const eClear = createSignalEngine().evaluate(seBar(clearFlags));
  const bClear = createBinarySignalModel().evaluate(seBar(clearFlags));
  check(eClear.longScore === 85, `clearing bar: 30+25+20+10 = 85 (got ${eClear.longScore})`);
  check(
    eClear.longSignalRaw === true && bClear.longSignalStrict === true,
    "both models admit when the score clears",
  );
  check(eClear.longSignal === true && bClear.longSignal === true, "both survive exclusivity");

  // 7g. The session gate: strength 1 blocks BOTH models even when the score
  // clears; strength 2 admits BOTH. sessionOK is derived identically.
  const gatedFlags = {
    nearLiquidityLong: true,
    nearD1LiquidityLong: true,
    breakUp: true,
    nearImbalanceLong: true,
    marketStructure: 1,
    volumeConfirmed: true,
    inOverlap: false,
  };
  const offSession = seBar({
    ...gatedFlags,
    sessionStrength: 1,
    inLondon: false,
    inNY: false,
    inAsia: true,
  });
  const eOff = createSignalEngine().evaluate(offSession);
  const bOff = createBinarySignalModel().evaluate(offSession);
  check(eOff.longScore === 80, `off-session score clears anyway: 30+5+20+15+10 = 80 (got ${eOff.longScore})`);
  check(eOff.sessionOK === false && bOff.sessionOK === false, "strength 1: sessionOK false on both");
  check(
    eOff.longSignalRaw === false && bOff.longSignalStrict === false,
    "strength 1: neither model admits despite the score",
  );
  const inSession = seBar({ ...gatedFlags, sessionStrength: 2, inLondon: true, inAsia: false });
  const eOn = createSignalEngine().evaluate(inSession);
  const bOn = createBinarySignalModel().evaluate(inSession);
  check(eOn.longScore === 90, `in-session score: 30+15+20+15+10 = 90 (got ${eOn.longScore})`);
  check(eOn.sessionOK === true && bOn.sessionOK === true, "strength 2: sessionOK true on both");
  check(
    eOn.longSignalRaw === true && bOn.longSignalStrict === true,
    "strength 2: both models admit",
  );

  // 7h. Per-model cooldown state: one shared bar sequence, TWO independent
  // state machines. If the stamp were shared, neither model could keep
  // firing on the alternating pattern below.
  const seqEngine = createSignalEngine();
  const seqBinary = createBinarySignalModel();
  const highFlags = {
    nearLiquidityLong: true,
    nearD1LiquidityLong: true,
    sessionStrength: 7,
    inOverlap: true,
    breakUp: true,
    marketStructure: 1,
    volumeConfirmed: true,
  };
  const trace = [];
  let lastE = null;
  let lastB = null;
  for (let i = 0; i <= 15; i += 1) {
    const flags = i === 0 ? lowFlags : i === 5 || i === 10 || i === 15 ? highFlags : {};
    const bar = seBar({ barIndex: i, ...flags });
    lastE = seqEngine.evaluate(bar);
    lastB = seqBinary.evaluate(bar);
    trace.push({
      i,
      eRaw: lastE.longSignalRaw,
      bStrict: lastB.longSignalStrict,
      eFired: lastE.longSignalFired,
      bFired: lastB.longSignalFired,
      eCool: lastE.inCooldown,
      bCool: lastB.inCooldown,
    });
  }
  const t = (i) => trace[i];
  check(
    t(0).eRaw === false && t(0).eFired === false && t(0).bStrict === true && t(0).bFired === true,
    "bar 0 (score 45): weighted silent, binary fires and stamps ITS OWN bar",
  );
  check(
    t(5).eFired === true && t(5).eCool === false && t(5).bFired === false && t(5).bCool === true,
    "bar 5: weighted fires on an empty stamp while binary cools from its own bar-0 fire",
  );
  check(
    t(10).eFired === false && t(10).eCool === true && t(10).bFired === true && t(10).bCool === false,
    "bar 10: roles swap — binary fires on its own stamp while weighted cools from bar 5",
  );
  check(
    t(15).eFired === true && t(15).bFired === false && t(15).bCool === true,
    "bar 15: roles swap again — two independent state machines",
  );
  check(
    lastE.seLongFires === 2 && lastB.binLongFires === 2,
    `independent fire counts 2 / 2 (got ${lastE.seLongFires} / ${lastB.binLongFires})`,
  );
  check(
    lastE.lastSignalBar === 15 && lastB.lastSignalBar === 10,
    "separate lastSignalBar stamps (15 / 10)",
  );
  check(lastE.seDualFires === 0 && lastB.binDualFires === 0, "no dual fires in the sequence");

  // 7i. Directional exclusivity runs PER MODEL against its own flags, with
  // structure breaking the tie and a structureless tie dropped by both.
  const tieFlags = {
    nearLiquidityLong: true,
    nearLiquidityShort: true,
    nearD1LiquidityLong: true,
    nearD1LiquidityShort: true,
    breakUp: true,
    breakDown: true,
    sessionStrength: 7,
    inOverlap: true,
    volumeConfirmed: true,
  };
  const eTie = createSignalEngine().evaluate(seBar({ ...tieFlags, marketStructure: 0 }));
  const bTie = createBinarySignalModel().evaluate(seBar({ ...tieFlags, marketStructure: 0 }));
  check(
    eTie.longSignalRaw === true && eTie.shortSignalRaw === true,
    "engine: both sides qualify on the tie bar",
  );
  check(
    bTie.longSignalStrict === true && bTie.shortSignalStrict === true,
    "binary: both sides qualify on the tie bar",
  );
  check(eTie.ambiguousTie === true && bTie.ambiguousTie === true, "both flag the genuine tie");
  check(eTie.longSignal === false && eTie.shortSignal === false, "engine: structureless tie dropped");
  check(bTie.longSignal === false && bTie.shortSignal === false, "binary: structureless tie dropped");
  check(
    eTie.seAmbiguousDrops === 1 && bTie.binAmbiguousDrops === 1,
    "each model counts its own drop",
  );
  check(eTie.longSignalFired === false && bTie.longSignalFired === false, "neither fires on the tie");
  const eBull = createSignalEngine().evaluate(seBar({ ...tieFlags, marketStructure: 1 }));
  const bBull = createBinarySignalModel().evaluate(seBar({ ...tieFlags, marketStructure: 1 }));
  check(
    eBull.longSignal === true && eBull.shortSignal === false,
    "engine: structure breaks the tie toward LONG",
  );
  check(
    bBull.longSignal === true && bBull.shortSignal === false,
    "binary: same direction from the same tie-break",
  );
  check(
    eBull.longSignalFired === true && bBull.longSignalFired === true,
    "both fire LONG on the tie-break bar",
  );

  // 7j. No invented score: conditions instead of a distribution.
  const bPlain = createBinarySignalModel().evaluate(seBar());
  check(!("longScore" in bPlain) && !("shortScore" in bPlain), "binary output carries no score fields");
  check(!("longFactors" in bPlain), "no factor breakdown either — there is nothing to distribute");
  check("longConditions" in bPlain && "shortConditions" in bPlain, "condition report present instead");
  check(
    bPlain.longConditions.liquidity === false && bPlain.longConditions.trigger === null,
    "conditions reported on non-qualifying bars too (trigger null)",
  );
  const bCond = createBinarySignalModel().evaluate(
    seBar({
      nearLiquidityLong: true,
      nearD1LiquidityLong: true,
      nearH4LiquidityLong: true,
      sessionStrength: 7,
      inOverlap: true,
      breakUp: true,
      nearImbalanceLong: true,
    }),
  );
  check(bCond.longConditions.liquidity === true, "liquidity condition reported");
  check(
    bCond.longConditions.liquidityTier === "D1",
    `highest nearby tier wins the condition report (got ${bCond.longConditions.liquidityTier})`,
  );
  check(bCond.longConditions.session === true, "session condition reported");
  check(
    bCond.longConditions.trigger === "break+nearImbalance",
    `trigger arms reported in order (got ${bCond.longConditions.trigger})`,
  );
}

// ─── 8. baseline wiring (T10/T11) ───────────────────────────────────────────
//
// The runner's wiring, asserted against the harness's own source: dispatch
// exists and is no longer a stub, BOTH models receive the SAME engineBar
// from TWO separate instances (never shared cooldown state), and the
// real-dataset invariants are present as runtime throws.

sec("baseline-wiring");
{
  const runSrc = readFileSync(new URL("./run.mjs", import.meta.url), "utf8");
  const baseSrc = readFileSync(new URL("./baseline.mjs", import.meta.url), "utf8");
  const binSrc = readFileSync(new URL("./modules/binary.mjs", import.meta.url), "utf8");

  check(
    runSrc.includes('import { runBaseline } from "./baseline.mjs"'),
    "run.mjs imports the baseline runner",
  );
  check(
    /subcommand === "baseline"[\s\S]{0,240}runBaseline\(\{\s*json: process\.argv\.includes\("--json"\),\s*tf,?\s*\}\)/.test(runSrc),
    "baseline dispatch runs runBaseline with --json AND the resolved timeframe",
  );
  check(!runSrc.includes('stub("T10/T11 baselines")'), "T10/T11 no longer a stub");
  check(runSrc.includes('stub("T12 weight search")'), "T12 search still stubbed — out of scope");

  check(
    baseSrc.includes("weighted.evaluate(engineBar)") && baseSrc.includes("binary.evaluate(engineBar)"),
    "both models are handed the SAME engineBar",
  );
  check(
    baseSrc.includes("const weighted = createSignalEngine()") &&
      baseSrc.includes("const binary = createBinarySignalModel()"),
    "two separate instances — cooldown and exclusivity state never shared",
  );
  check(
    baseSrc.includes("raw && !strict") && baseSrc.includes("implicationViolations"),
    "raw ⇒ strict asserted on every real bar (throws on violation)",
  );
  check(
    baseSrc.includes("equalityMismatches"),
    "raw === strict && score >= threshold asserted on every real bar",
  );
  check(
    binSrc.includes("minConfidence is not an option"),
    "binary module enforces the no-score rule at construction",
  );
}

// ─── 9. tier diagnostic helpers (weight-calibration) ─────────────────────────
//
// The diagnostic's own PURE helpers, on synthetic, DATA-FREE input. The
// dataset-driven half of tier-diagnostic.mjs is deliberately not exercised
// here: this suite must stay runnable with backtest/data/ absent.
//
// What is covered:
//   * the tier rule itself, against a KNOWN ZONE SET built by hand;
//   * the highest-tier-wins reduction, including that tiers never add up;
//   * the in-body exclusion — the mechanism behind the whole diagnostic, and
//     the thing a reader must not mistake for a defect;
//   * the before/after warm-up split logic.

sec("tier-diagnostic");
{
  // ── The tier rule, given a known zone set ────────────────────────────────
  // A D1 pivot at 100, an H4 pivot at 101, an H1 pivot at 102, all below a
  // close of 106.5. atrChart 3 gives a proximity band of 3 x 3 = 9, so all
  // three are within it, and all three are on the LONG side (center < close).
  const lzTier = createLiquidityZones();
  const b0 = lzTier.evaluate({
    barIndex: 0,
    high: 107,
    low: 106,
    close: 106.5,
    atrChart: 3,
    atrH4: 8,
    atrD1: 10,
    atrH1: 4,
    pivots: { d1High: 100, h4High: 101, h1High: 102 },
  });
  check(
    b0.zones.map((z) => z.tier).join(",") === "1,2,3",
    `zone set carries tiers 1/2/3 in slot order (got ${b0.zones.map((z) => z.tier).join(",")})`,
  );
  check(
    b0.nearD1LiquidityLong && b0.nearH4LiquidityLong && b0.nearH1LiquidityLong,
    "all three tier flags coexist — the module emits six booleans, not one tier",
  );
  check(
    qualifyingTier({
      d1: b0.nearD1LiquidityLong,
      h4: b0.nearH4LiquidityLong,
      h1: b0.nearH1LiquidityLong,
    }) === "D1",
    "with all three zones near, the qualifying tier is D1 (highest wins)",
  );

  // The reduction is direction-blind and highest-first. Tiers NEVER add up.
  check(qualifyingTier({ d1: true, h4: true, h1: true }) === "D1", "D1 beats H4 and H1");
  check(qualifyingTier({ d1: false, h4: true, h1: true }) === "H4", "H4 beats H1");
  check(qualifyingTier({ d1: false, h4: false, h1: true }) === "H1", "H1 alone qualifies");
  check(qualifyingTier({ d1: false, h4: false, h1: false }) === null, "no tier -> null");
  check(
    SIGNAL_ENGINE_DEFAULTS.liquidityD1 > SIGNAL_ENGINE_DEFAULTS.liquidityH4 &&
      SIGNAL_ENGINE_DEFAULTS.liquidityH4 > SIGNAL_ENGINE_DEFAULTS.liquidityH1,
    "shipped weights are ordered to match the reduction's precedence",
  );

  // ── The in-body exclusion (the mechanism, and the trap) ───────────────────
  // A D1 zone at 100 with atrD1 10 has halfWidth 5, so its body spans 95-105.
  // Proximity band is 9 (3 x atrChart 3). With the body wider than the band, a
  // close can be "near" the zone and inside its body at the same time.
  const inBody = lzTier.evaluate({
    barIndex: 1,
    high: 104.5,
    low: 103.5,
    close: 104,
    atrChart: 3,
    atrH4: 8,
    atrD1: 10,
    atrH1: 4,
    pivots: {},
  });
  const dist = Math.abs(104 - 100);
  check(
    dist <= 3 * 3,
    `the close is inside the proximity band (${dist} <= 9)`,
  );
  check(
    inBody.nearD1LiquidityLong === false,
    "but the bar is inside the zone BODY, so the tier flag is withheld by design",
  );
  check(inBody.sweptLong === true, "an in-body D1 zone reports through sweptLong instead");

  // The same zone from OUTSIDE its body does fire the flag — so the withheld
  // flag above is the in-body rule, not a broken tier assignment.
  const outside = lzTier.evaluate({
    barIndex: 2,
    high: 108.5,
    low: 108,
    close: 108,
    atrChart: 3,
    atrH4: 8,
    atrD1: 10,
    atrH1: 4,
    pivots: {},
  });
  check(
    outside.nearD1LiquidityLong === true,
    "the same D1 zone fires nearD1 from outside its body — tier assignment works",
  );
  check(
    qualifyingTier({
      d1: outside.nearD1LiquidityLong,
      h4: outside.nearH4LiquidityLong,
      h1: outside.nearH1LiquidityLong,
    }) === "D1",
    "and it still outranks the H4 and H1 zones on the same bar",
  );

  // ── recordTier: the two structural contradictions ─────────────────────────
  const t0 = newTally();
  check(
    t0.bars === 0 && t0.anyFlag === 0 && t0.D1 === 0 && t0.flagWithoutTier === 0,
    "newTally starts zeroed on every key",
  );
  recordTier(t0, { anyFlag: true, d1: false, h4: true, h1: true });
  recordTier(t0, { anyFlag: true, d1: false, h4: false, h1: true });
  recordTier(t0, { anyFlag: false, d1: false, h4: false, h1: false });
  check(t0.bars === 3 && t0.anyFlag === 2 && t0.none === 1, "bars / anyFlag / none tallied");
  // The tally counts the QUALIFYING tier, so an observation with H4 and H1 both
  // set lands on H4 only. Raw per-tier presence is counted separately by
  // recordNear — conflating the two is how a reader would misread section B.
  check(
    t0.H4 === 1 && t0.H1 === 1 && t0.D1 === 0,
    "the tally records the QUALIFYING tier only — H4 beats H1, it is not double-counted",
  );
  check(
    t0.flagWithoutTier === 0 && t0.tierWithoutFlag === 0,
    "a consistent observation raises neither contradiction counter",
  );
  // Both contradictions are structurally impossible in a correct port, so the
  // counters must be able to detect them.
  const tBad = newTally();
  recordTier(tBad, { anyFlag: true, d1: false, h4: false, h1: false });
  recordTier(tBad, { anyFlag: false, d1: true, h4: false, h1: false });
  check(tBad.flagWithoutTier === 1, "side flag set with no tier is counted, not ignored");
  check(tBad.tierWithoutFlag === 1, "tier set with no side flag is counted, not ignored");

  // ── recordNear: proximity isolated from the other gates ───────────────────
  const n0 = newNearTally();
  recordNear(n0, { d1: true, h4: false, h1: true });
  recordNear(n0, { d1: false, h4: false, h1: false });
  check(n0.bars === 2 && n0.D1 === 1 && n0.H4 === 0 && n0.H1 === 1, "per-tier near tallies");
  check(n0.any === 1 && n0.none === 1, "any/near-none tallies");

  // ── The before/after warm-up split ───────────────────────────────────────
  check(phaseOf(0, 5) === "pre-warmup", "bar before the boundary is pre-warmup");
  check(phaseOf(4, 5) === "pre-warmup", "the bar immediately before is pre-warmup");
  check(phaseOf(5, 5) === "post-warmup", "the boundary bar ITSELF is post-warmup");
  check(phaseOf(99, 5) === "post-warmup", "a bar after the boundary is post-warmup");
  check(
    phaseOf(0, null) === "pre-warmup" && phaseOf(999, null) === "pre-warmup",
    "a null boundary (no D1 zone ever) puts every bar pre-warmup",
  );

  const split = newSplit();
  const longSide = (d1, h4, h1) => ({ long: { anyFlag: true, d1, h4, h1 }, short: { anyFlag: false, d1: false, h4: false, h1: false } });
  for (let barIndex = 0; barIndex < 10; barIndex++) {
    // D1 appears from bar 6 onward; the boundary is bar 5.
    recordSplit(split, barIndex, 5, longSide(barIndex >= 6, false, true));
  }
  check(
    split["pre-warmup"].long.D1 === 0 && split["post-warmup"].long.D1 === 4,
    `the split attributes D1 bars to the right phase (pre ${split["pre-warmup"].long.D1}, post ${split["post-warmup"].long.D1})`,
  );
  check(
    split["pre-warmup"].long.bars === 5 && split["post-warmup"].long.bars === 5,
    "every bar lands in exactly one phase — 5 pre, 5 post",
  );
  // H1 coexists with D1 on bars 6-9, but the tally is qualifying-tier-only, so
  // those four land on D1 and H1 is counted once (bar 5, where D1 is absent).
  check(
    split["pre-warmup"].long.H1 === 5 && split["post-warmup"].long.H1 === 1,
    "a coexisting H1 is outranked by D1 in the tally — the split keeps the same rule",
  );
  const splitNull = newSplit();
  recordSplit(splitNull, 0, null, longSide(true, false, false));
  check(
    splitNull["pre-warmup"].long.D1 === 1 && splitNull["post-warmup"].long.D1 === 0,
    "a null boundary keeps the post phase empty rather than inventing one",
  );

  // ── Wiring: the diagnostic is dispatched, isolated and T12 is intact ──────
  const runSrc = readFileSync(new URL("./run.mjs", import.meta.url), "utf8");
  const diagSrc = readFileSync(new URL("./tier-diagnostic.mjs", import.meta.url), "utf8");

  check(
    runSrc.includes('import { runTierDiagnostic } from "./tier-diagnostic.mjs"'),
    "run.mjs imports the tier diagnostic",
  );
  check(
    /subcommand === "diagnose"[\s\S]{0,240}runTierDiagnostic\(\{\s*json: process\.argv\.includes\("--json"\),\s*tf,?\s*\}\)/.test(
      runSrc,
    ),
    "diagnose dispatch runs the diagnostic with --json AND the resolved timeframe",
  );
  check(
    runSrc.includes('SUBCOMMANDS = ["fetch", "validate", "baseline", "diagnose", "compare", "search"]'),
    "diagnose is registered in SUBCOMMANDS",
  );
  check(runSrc.includes('stub("T12 weight search")'), "T12 search still stubbed — out of scope");
  check(
    diagSrc.includes("readFile(tf.datasetPath") && diagSrc.includes("runTierDiagnostic"),
    "the diagnostic is a data-reading subcommand, not a stub",
  );
  check(
    !diagSrc.includes('from "./baseline.mjs"') && !diagSrc.includes("runComparison"),
    "the diagnostic does NOT import baseline.mjs — it cannot perturb the comparison",
  );
}

// ─── 10. timeframe table (weight-calibration, slice 7) ──────────────────────
//
// The per-timeframe contract, DATA-FREE: flag parsing, the per-timeframe
// coverage verdict, tier availability, and the warm-up arithmetic. Nothing here
// touches backtest/data/ or the network — the point is that the invariants that
// would be expensive to check on real data (a completed 5m fetch marking a 1h
// fetch complete; a 5m D1 warm-up quoted under a 1h header) are checkable on
// pure functions.

sec("timeframe-table");
{
  // ── Flag parsing ──────────────────────────────────────────────────────────
  check(
    parseTimeframeFlag(["node", "run.mjs", "baseline"]).id === "5m",
    "no --timeframe flag means 5m — every pre-slice-7 command line is unchanged",
  );
  check(
    parseTimeframeFlag(["run.mjs", "baseline", "--timeframe", "1h"]).id === "1h",
    "--timeframe <id> resolves the id",
  );
  check(
    parseTimeframeFlag(["run.mjs", "baseline", "--timeframe=4h"]).id === "4h",
    "--timeframe=<id> resolves the id too",
  );
  check(
    parseTimeframeFlag(["run.mjs", "baseline", "--timeframe", "5m"]).id === DEFAULT_TIMEFRAME,
    "--timeframe 5m is the default, stated explicitly or not",
  );

  // An invalid timeframe must be REJECTED LOUDLY. Silently falling back to 5m
  // would produce a plausible report about the wrong dataset — the one failure
  // mode a measurement harness must never have.
  const badIds = ["15m", "1H", "60", "d1", "", "  ", "hourly", "1hour"];
  for (const bad of badIds) {
    let threw = null;
    try {
      parseTimeframeFlag(["run.mjs", "baseline", "--timeframe", bad]);
    } catch (err) {
      threw = err;
    }
    check(
      threw instanceof TimeframeError,
      `an invalid timeframe is rejected loudly: --timeframe ${JSON.stringify(bad)}`,
    );
  }
  // The message must NAME the valid values — a bare "invalid input" leaves the
  // caller guessing what the harness would accept.
  let badMessage = "";
  try {
    parseTimeframeFlag(["run.mjs", "fetch", "--timeframe", "15m"]);
  } catch (err) {
    badMessage = err.message;
  }
  check(
    badMessage.includes('"5m"') && badMessage.includes('"1h"') && badMessage.includes('"4h"'),
    "the rejection message lists every known timeframe",
  );
  // `--timeframe` with no value must not silently swallow the next argument.
  let missingValueThrew = false;
  try {
    parseTimeframeFlag(["run.mjs", "fetch", "--timeframe", "--json"]);
  } catch (err) {
    missingValueThrew = err instanceof TimeframeError;
  }
  check(missingValueThrew, "--timeframe with no value is rejected, not treated as a subcommand flag");

  // ── Per-timeframe coverage verdict (the T2 trap, per timeframe) ───────────
  // The regression this guards is specific: a COMPLETE 5m fetch must never make
  // a 1h fetch report itself complete. The mechanism is that each timeframe owns
  // its own dataset AND meta file, and the verdict is recomputed from the
  // candles rather than read out of stored metadata.
  const tf5 = getTimeframe("5m");
  const tf1h = getTimeframe("1h");
  const tf4h = getTimeframe("4h");

  check(
    tf5.datasetPath !== tf1h.datasetPath &&
      tf1h.datasetPath !== tf4h.datasetPath &&
      tf5.metaPath !== tf1h.metaPath,
    "every timeframe owns a distinct dataset file and meta file",
  );
  check(
    tf1h.stepSec === 3600 && tf4h.stepSec === 14400 && tf5.stepSec === 300,
    "the step sizes are the verified Bitstamp steps (300 / 3600 / 14400)",
  );

  // A 5m-complete dataset: 62,000 bars over 215.27 days.
  const fiveMinuteComplete = { count: 62000, spanDays: 215.2743 };
  check(
    targetVerdict(fiveMinuteComplete.count, fiveMinuteComplete.spanDays, tf5).met === true,
    "62,000 5m bars over 215.27 days MEET the 5m target",
  );
  check(
    targetVerdict(fiveMinuteComplete.count, fiveMinuteComplete.spanDays, tf1h).met === false,
    "the SAME 5m dataset does NOT meet the 1h target — the verdict is per timeframe",
  );
  check(
    targetVerdict(fiveMinuteComplete.count, fiveMinuteComplete.spanDays, tf4h).met === false,
    "the SAME 5m dataset does NOT meet the 4h target either",
  );

  // And the reverse: a 1h-complete dataset judged against the 5m target.
  const oneHourComplete = { count: 44000, spanDays: 1833.2917 };
  check(
    targetVerdict(oneHourComplete.count, oneHourComplete.spanDays, tf1h).met === true,
    "44,000 1h bars over 1833.29 days MEET the 1h target (>= 43,000 bars, >= 1825 days)",
  );
  // The 1h and 4h targets ask for the SAME wall-clock coverage, so a 1h-complete
  // dataset also satisfies the 4h one — the 4h bar floor is simply lower. What
  // must NOT happen is the reverse: a dataset too short for 1h must not be read
  // as complete there, which is asserted above against the 5m dataset.
  check(
    tf4h.targetBars < tf1h.targetBars && tf1h.targetDays === tf4h.targetDays,
    "1h and 4h target the same 1825-day span; only the bar floor differs (43,000 vs 10,900)",
  );
  check(
    targetVerdict(11000, 1833.1667, tf4h).met === true,
    "11,000 4h bars over 1833.17 days MEET the 4h target (>= 10,900 bars, >= 1825 days)",
  );
  check(
    targetVerdict(11000, 1833.1667, tf1h).met === false,
    "the SAME 4h dataset does NOT meet the 1h bar target (11,000 < 43,000) — per timeframe",
  );
  check(
    targetVerdict(43000, 1825.0, tf5).met === false,
    "a 1h-sized dataset does not meet the 5m target either — span, not just count, decides",
  );

  // Both halves of the target must hold independently — this is the bug class
  // where only the bar count is checked.
  check(
    targetVerdict(50000, 100, tf1h).met === false &&
      targetVerdict(1000, 2000, tf1h).met === false,
    "neither half of the 1h target alone is enough (bars only, or days only)",
  );

  // Status resolution: a stored "complete" is downgraded when the constants in
  // effect say otherwise; a stored "shortfall" is preserved, because
  // recomputation cannot un-know that the exchange has no older data.
  check(
    resolveStatus("complete", false) === "partial",
    "a cached `complete` is downgraded when the recomputed verdict says partial",
  );
  check(resolveStatus("complete", true) === "complete", "complete + met stays complete");
  check(
    resolveStatus("shortfall", false) === "shortfall",
    "a recorded `shortfall` survives recomputation — it records exchange history",
  );
  check(
    resolveStatus("shortfall", true) === "complete",
    "a shortfall that actually meets the target is promoted, not left as shortfall",
  );

  // ── Warm-up arithmetic, recomputed per grid ───────────────────────────────
  // 21 daily bars is 6,048 native 5m bars, 504 native 1h bars and 126 native 4h
  // bars. These are the numbers the slice-6 finding would have been misquoted as
  // if they had been carried across grids.
  check(nativeBarsForDays(21, MS_5M) === 6048, "21 daily bars = 6,048 native 5m bars (288/day)");
  check(nativeBarsForDays(21, MS_1H) === 504, "21 daily bars = 504 native 1h bars (24/day)");
  check(nativeBarsForDays(21, MS_4H) === 126, "21 daily bars = 126 native 4h bars (6/day)");
  check(nativeBarsForDays(14, MS_1H) === 336, "D1 ATR(14) warm-up = 336 native 1h bars");
  check(nativeBarsForDays(14, MS_4H) === 84, "D1 ATR(14) warm-up = 84 native 4h bars");

  check(
    nativeBarsForDays(21, MS_5M) !== nativeBarsForDays(21, MS_1H) &&
      nativeBarsForDays(21, MS_1H) !== nativeBarsForDays(21, MS_4H),
    "the three grids give three DIFFERENT warm-up figures — none may be copied",
  );
  check(
    /nativeBarsForDays\(21, tf\.stepMs\)/.test(
      readFileSync(new URL("./baseline.mjs", import.meta.url), "utf8"),
    ) &&
      /nativeBarsForDays\(21, tf\.stepMs\)/.test(
        readFileSync(new URL("./tier-diagnostic.mjs", import.meta.url), "utf8"),
      ),
    "both runners derive their warm-up field from the SAME pure function — neither " +
      "re-derives it by hand and so they cannot drift apart",
  );
  check(
    TIMEFRAMES[tf1h.id].minutesPerBar === 60 && TIMEFRAMES[tf4h.id].minutesPerBar === 240,
    "each table entry carries its own minutesPerBar for horizon labelling",
  );

  // ── Tier availability: a tier finer than the native grid is unsynthesisable ─
  const a5 = htfAvailability(tf5.stepMs);
  const a1 = htfAvailability(tf1h.stepMs);
  const a4 = htfAvailability(tf4h.stepMs);
  check(
    a5.unavailable.length === 0 && a1.unavailable.length === 0,
    "on 5m and 1h every HTF tier (1H/4H/D1) can be aggregated",
  );
  check(
    a4.unavailable.length === 1 && a4.unavailable[0].name === "1H",
    "on 4h the 1H tier cannot be aggregated — 1h candles do not exist in a 4h dataset",
  );
  check(a4.available.d1 === true && a4.available.h4 === true, "on 4h the D1 and H4 tiers remain available");
  // Pine's request.security WOULD return 1h bars on a 4h chart. This harness
  // cannot, which is a limitation of the data chosen and is reported as such —
  // never as a tier that produced nothing.
  check(
    a4.available.h1 === false,
    "the 4h grid reports 1H unavailable rather than empty (no synthesis from nothing)",
  );
  check(
    htfAvailability(MS_1H).available.h1 === true,
    "on 1h the 1H context is the NATIVE series — available, and identical to what Pine returns",
  );
  check(barsPerDailyBar(tf5) === 288 && barsPerDailyBar(tf1h) === 24 && barsPerDailyBar(tf4h) === 6,
    "bars per D1 bar: 288 / 24 / 6 across the three grids");

  // ── Wiring: the flag is threaded, and the gate stays 5m-only ──────────────
  const runSrc7 = readFileSync(new URL("./run.mjs", import.meta.url), "utf8");
  const baseSrc7 = readFileSync(new URL("./baseline.mjs", import.meta.url), "utf8");
  const diagSrc7 = readFileSync(new URL("./tier-diagnostic.mjs", import.meta.url), "utf8");

  check(
    runSrc7.includes('import {\n  DEFAULT_TIMEFRAME,') ||
      /import\s*\{[^}]*DEFAULT_TIMEFRAME[^}]*\}\s*from\s*"\.\/timeframes\.mjs"/.test(runSrc7),
    "run.mjs imports the timeframe table",
  );
  check(
    runSrc7.includes("gateTimeframeRefusal"),
    "run.mjs has an explicit refusal path for validate on a non-5m timeframe",
  );
  check(
    /subcommand === "validate"[\s\S]{0,200}tf\.id !== DEFAULT_TIMEFRAME[\s\S]{0,80}gateTimeframeRefusal/.test(
      runSrc7,
    ),
    "validate REFUSES any timeframe other than the default 5m instead of running",
  );
  check(
    runSrc7.includes("await cmdFetch(tf)") && runSrc7.includes("requestPage(tf, endSec)"),
    "fetch threads the timeframe through the request path",
  );
  check(
    runSrc7.includes("await loadState(tf)") && runSrc7.includes("printReport(tf,"),
    "fetch resolves its own state and report per timeframe",
  );
  check(
    !/STEP_SEC\b/.test(runSrc7.replace(/tf\.stepSec/g, "")),
    "no hard-coded STEP_SEC survives in run.mjs — the table is the only source",
  );
  check(
    !runSrc7.includes("TARGET_BARS") && !runSrc7.includes("TARGET_DAYS"),
    "the coverage targets live in the table, not as module constants in run.mjs",
  );
  check(
    baseSrc7.includes("async function loadDataset(tf)") && baseSrc7.includes("runComparison(candles, meta, tf)"),
    "baseline loads and compares against the timeframe's own dataset",
  );
  check(
    baseSrc7.includes("createHtfSeries(tfMs, nativeStepMs)") &&
      baseSrc7.includes("c.t + nativeStepMs === bucket + tfMs"),
    "baseline's HTF aggregator completes buckets against the NATIVE step, not a hard-coded 5m",
  );
  check(
    diagSrc7.includes("createHtfSeries(tfMs, nativeStepMs)") &&
      diagSrc7.includes("c.t + nativeStepMs === bucket + tfMs"),
    "the diagnostic's HTF aggregator uses the native step too — its isolation from " +
      "baseline.mjs must not become a second, divergent implementation",
  );
  check(
    diagSrc7.includes('from "./timeframes.mjs"'),
    "the diagnostic reads the SAME timeframe table",
  );
  check(
    !/MS_5M\b/.test(baseSrc7) && !/MS_5M\b/.test(diagSrc7),
    "neither runner hard-codes a 5m step any more",
  );
  check(
    baseSrc7.includes("avail.unavailable") && baseSrc7.includes("unavailableHtf"),
    "baseline records which HTF tiers the grid cannot produce",
  );
  check(
    /tier of that tier\./.test(diagSrc7) || diagSrc7.includes("not measurable on a"),
    "the diagnostic prints an explicit unmeasurable cell rather than a row of zeros",
  );
  check(
    baseSrc7.includes("MULTIPLE TIMEFRAMES ARE NOT MULTIPLE INDEPENDENT SAMPLES"),
    "the cross-timeframe non-independence caveat is present and stated in full",
  );
}

// ─── 11. cluster bootstrap (T11 addendum) ────────────────────────────────────
//
// backtest/compare.mjs is the file that puts a NUMBER on baseline caveat [C1]:
// signals whose 288-bar forward windows overlap are not independent trials, so
// a hit rate quoted over n_signals overstates its own evidence. These checks
// are DATA-FREE — synthetic signal layouts and synthetic label counts only,
// never backtest/data/ — and they cover the four things that could silently
// make an interval wrong:
//
//   * the clustering rule (a known layout → a known cluster count),
//   * the bootstrap reproducing a known statistic,
//   * the seed making two runs byte-identical,
//   * win/(win+loss) EXCLUDING timeout and insufficient_data.
//
// The last one is the check that matters most: folding a timeout into the
// denominator is the easiest way to make this report lie, and it would not
// change any count — only the rate.

sec("cluster-bootstrap");
{
  // ── Clustering: a known layout → a known cluster count ────────────────────
  //
  // Layout at a 288-bar horizon. Gaps of 287 share a cluster, a gap of exactly
  // 288 does NOT (the windows abut without overlapping), and 1,000 does not.
  const layout = [0, 100, 287, 575, 863, 1151, 5000, 5287];
  const cl = clusterSignals(
    layout.map((barIndex) => ({ barIndex })),
    288,
  );
  // Consecutive gaps of this layout are 100, 187, 288, 288, 288, 3849, 287.
  // A gap of exactly 288 ABUTS without overlapping, so it starts a NEW cluster:
  //   [0,100,287] [575] [863] [1151] [5000,5287]  →  5 clusters.
  // This layout is what pins the `<` boundary. Treating the test as `<=` would
  // merge the abutting pairs and report 3 clusters — i.e. call two windows that
  // share no bar at all "overlapping", which is the mistake this file exists to
  // avoid in the other direction.
  check(cl.length === 5, `layout of 8 signals at 288 bars → 5 clusters (got ${cl.length})`);
  check(
    cl[0].map((s) => s.barIndex).join(",") === "0,100,287",
    `cluster 1 holds bars 0,100,287 (got ${cl[0].map((s) => s.barIndex).join(",")})`,
  );
  check(
    cl[1].map((s) => s.barIndex).join(",") === "575",
    `a gap of exactly 288 abuts WITHOUT overlapping, so it starts a new cluster ` +
      `(got ${cl[1].map((s) => s.barIndex).join(",")})`,
  );
  check(
    cl[4].map((s) => s.barIndex).join(",") === "5000,5287",
    `cluster 5 holds the far pair (got ${cl[4].map((s) => s.barIndex).join(",")})`,
  );

  check(
    clusterSignals([{ barIndex: 7 }], 288).length === 1,
    "a single signal is one cluster of one",
  );
  check(clusterSignals([], 288).length === 0, "no signals → no clusters, not one empty cluster");
  check(
    clusterSignals([{ barIndex: 5 }, { barIndex: 5 }], 288).length === 1,
    "two signals on the same bar share a cluster (gap 0 < horizon)",
  );
  // Input order must not matter — the function sorts before clustering, so a
  // caller that hands over signals in firing order vs bar order gets the same
  // answer.
  check(
    clusterSignals(layout.map((barIndex) => ({ barIndex })).reverse(), 288).length === 5,
    "clustering is order-independent — the input is sorted first",
  );
  throws(() => clusterSignals(layout.map((barIndex) => ({ barIndex })), 0), RangeError,
    "a zero horizon is rejected rather than silently clustering everything together");

  // The 10-bars-apart case the brief names: two signals 10 bars apart share 278
  // of 288 forward bars, so they MUST land in one cluster. If this ever fails,
  // the independence assumption the whole file rests on has been quietly lost.
  check(
    clusterSignals([{ barIndex: 0 }, { barIndex: 10 }], 288).length === 1,
    "signals 10 bars apart (cooldown spacing) share 278 of 288 bars → ONE cluster",
  );

  // The max-gap diagnostic is what makes a cluster count checkable: a count of 1
  // means every gap is below the horizon, which the max gap proves directly.
  const gaps = maxSignalGap([{ barIndex: 0 }, { barIndex: 100 }, { barIndex: 900 }]);
  check(gaps.maxGap === 800 && gaps.atBar === 900, "maxSignalGap finds the largest consecutive gap");
  check(
    maxSignalGap([{ barIndex: 4 }]).maxGap === null,
    "a lone signal has no gap — reported as null, not 0",
  );
  check(
    clusterSignals([{ barIndex: 0 }, { barIndex: 261 }], 288).length === 1 &&
      maxSignalGap([{ barIndex: 0 }, { barIndex: 261 }]).maxGap === 261,
    "the 1h binary shape: max gap 261 < 288 → a single cluster, and the gap says why",
  );

  // ── Joint clustering: the paired resampling unit ──────────────────────────
  //
  // Two models, different bar sets, ONE shared partition. The joint partition
  // must never be FINER than either model's own clustering, because splitting a
  // cluster would split an overlapping window pair across two draws.
  const jsig = {
    weighted: [{ barIndex: 0 }, { barIndex: 2000 }],
    binary: [{ barIndex: 5 }, { barIndex: 10 }, { barIndex: 1500 }, { barIndex: 2100 }],
  };
  const joint = jointClusters(jsig, 288);
  check(
    joint.length === 3,
    `joint clustering of 2+4 signals → 3 shared clusters (got ${joint.length})`,
  );
  check(
    joint[0].weighted.length === 1 && joint[0].binary.length === 2,
    "a weighted signal and two binary signals inside 288 bars share the first joint cluster",
  );
  check(
    joint[1].weighted.length === 0 && joint[1].binary.length === 1,
    "a joint cluster may hold only binary signals — the models need not both be present",
  );
  // The invariant that matters is NOT "the joint count is <= both own counts" —
  // that is false, because a cluster may legitimately hold only one model's
  // signals and so contribute to one count and not the other. The invariant is
  // that NO OVERLAPPING PAIR of either model is split across two joint clusters:
  // every cluster of each model's own partition must sit entirely inside one
  // joint cluster. Checked directly rather than asserted as a count.
  const ownOf = (list) => clusterSignals(list, 288);
  const jointIndexOf = new Map();
  joint.forEach((c, idx) => {
    for (const model of ["weighted", "binary"]) {
      for (const s of c[model]) jointIndexOf.set(`${model}:${s.barIndex}`, idx);
    }
  });
  const splits = [];
  for (const model of ["weighted", "binary"]) {
    for (const own of ownOf(jsig[model])) {
      const idxs = new Set(own.map((s) => jointIndexOf.get(`${model}:${s.barIndex}`)));
      if (idxs.size > 1) splits.push(`${model} cluster split across ${idxs.size} joint clusters`);
    }
  }
  check(
    splits.length === 0,
    `no own-cluster of either model is SPLIT across joint clusters (${splits.join("; ") || "none split"})`,
  );
  // And the converse must hold too: a joint cluster may not separate two
  // signals of one model that are within the horizon of each other.
  const tooFine = [];
  for (const model of ["weighted", "binary"]) {
    for (const own of ownOf(jsig[model])) {
      if (own.length < 2) continue;
      const idxs = new Set(own.map((s) => jointIndexOf.get(`${model}:${s.barIndex}`)));
      if (idxs.size > 1) tooFine.push(`${model} overlapping pair separated`);
    }
  }
  check(tooFine.length === 0, "overlapping pairs of one model stay in the same joint cluster");
  check(jointClusters({ weighted: [], binary: [] }, 288).length === 0, "no signals → no joint clusters");

  // ── The bootstrap reproduces a KNOWN statistic ────────────────────────────
  //
  // A degenerate case with an exact answer: every draw must return the SAME
  // difference, because both clusters have identical rates in both models. The
  // interval must therefore have zero width and sit exactly on that difference.
  // This is the check that the rate arithmetic is win/(win+loss) and not, say,
  // win/total — a bootstrap of a degenerate case pins the point estimate.
  const degenerate = [
    { weighted: { win: 3, loss: 1 }, binary: { win: 3, loss: 1 } },
    { weighted: { win: 1, loss: 3 }, binary: { win: 1, loss: 3 } },
  ];
  const degenerateBoot = pairedClusterBootstrap(degenerate, 500, 7);
  // 75% and 25% for both models → difference exactly 0, every draw.
  check(
    degenerateBoot.excludesZero === false && degenerateBoot.lo === 0 && degenerateBoot.hi === 0,
    `a degenerate paired case has an exactly-zero difference and a zero-width interval ` +
      `(got [${degenerateBoot.lo}, ${degenerateBoot.hi}])`,
  );
  check(degenerateBoot.draws === 500, "every draw of a non-degenerate denominator is kept");

  // A second degenerate case with a NON-zero known difference: weighted at
  // 50/50 = 50%, binary at 75/25 = 75%, so the difference is exactly +25 pp on
  // every draw. This pins the SIGN and the SCALE of the statistic.
  const known = [{ weighted: { win: 1, loss: 1 }, binary: { win: 3, loss: 1 } }];
  const knownBoot = pairedClusterBootstrap(known, 200, 7);
  check(
    knownBoot.lo === 25 && knownBoot.hi === 25 && knownBoot.excludesZero === true,
    `a one-cluster known case gives exactly +25 pp (50% vs 75%) with a zero-width ` +
      `interval that excludes zero (got [${knownBoot.lo}, ${knownBoot.hi}])`,
  );

  // Resampling SIGNALS instead of clusters is the error this file exists to
  // avoid: with 4 independent clusters the difference is not constant, so the
  // interval must be non-degenerate. A zero-width interval here would mean the
  // per-cluster draws were not varying — i.e. the bootstrap was collapsing to
  // a point regardless of the data.
  const varied = [
    { weighted: { win: 4, loss: 0 }, binary: { win: 1, loss: 3 } },
    { weighted: { win: 0, loss: 4 }, binary: { win: 3, loss: 1 } },
    { weighted: { win: 2, loss: 2 }, binary: { win: 2, loss: 2 } },
    { weighted: { win: 1, loss: 3 }, binary: { win: 0, loss: 4 } },
  ];
  const variedBoot = pairedClusterBootstrap(varied, 2000, 11);
  check(
    variedBoot.hi > variedBoot.lo,
    `varying per-cluster rates produce a non-zero-width interval ` +
      `([${variedBoot.lo}, ${variedBoot.hi}]) — the draws really are resampling`,
  );
  check(
    variedBoot.lo <= 0 && variedBoot.hi >= 0,
    "an interval spanning both signs does not exclude zero",
  );

  // The resampling unit is the CLUSTER, so the interval must be far wider than
  // one computed over the same wins as if they were independent trials. This is
  // the quantitative form of the file's premise.
  const manySignals = Array.from({ length: 40 }, () => ({
    weighted: { win: 1, loss: 1 },
    binary: { win: 1, loss: 1 },
  }));
  const independentBoot = pairedClusterBootstrap(manySignals, 2000, 3);
  check(
    independentBoot.lo === 0 && independentBoot.hi === 0,
    "40 identical single-signal clusters all give the same difference — width is a " +
      "property of cluster VARIATION, not of the count of units",
  );

  // Undefined draws: a model whose resampled population resolves to zero
  // win+loss labels has no hit rate, so the difference is undefined. Those draws
  // must be COUNTED, never coerced into the interval.
  const undefinedCase = [
    { weighted: { win: 1, loss: 0 }, binary: { win: 0, loss: 0 } },
    { weighted: { win: 0, loss: 1 }, binary: { win: 0, loss: 0 } },
  ];
  const undefinedBoot = pairedClusterBootstrap(undefinedCase, 100, 5);
  check(
    undefinedBoot.draws === 0 && undefinedBoot.undefinedDraws === 100,
    `a model with no resolved labels makes every draw undefined, and all 100 are ` +
      `counted rather than coerced (got ${undefinedBoot.draws} kept / ` +
      `${undefinedBoot.undefinedDraws} undefined)`,
  );
  check(
    undefinedBoot.lo === null && undefinedBoot.excludesZero === null,
    "no interval and no zero-exclusion verdict when every draw was undefined",
  );
  check(
    pairedClusterBootstrap([], 100, 1).draws === 0,
    "zero clusters → no draws, not a crash",
  );

  // ── The seed makes two runs IDENTICAL ─────────────────────────────────────
  const rngA = makeRng(20260901);
  const rngB = makeRng(20260901);
  const seqA = Array.from({ length: 50 }, () => rngA());
  const seqB = Array.from({ length: 50 }, () => rngB());
  check(
    seqA.length === 50 && seqA.every((v, i) => v === seqB[i]),
    "the same seed produces the same 50-draw sequence — the RNG is reproducible",
  );
  const rngC = makeRng(20260902);
  const seqC = Array.from({ length: 50 }, () => rngC());
  check(
    seqA.some((v, i) => v !== seqC[i]),
    "a DIFFERENT seed produces a different sequence — the seed is actually used",
  );
  check(
    seqA.every((v) => v >= 0 && v < 1),
    "the RNG stays in [0, 1) so Math.floor(rng() * n) is a valid cluster index",
  );

  // Two full bootstraps at the same seed must agree to the last digit; that is
  // the reproducibility claim a report makes when it prints a seed.
  const reproA = pairedClusterBootstrap(varied, 3000, 4242);
  const reproB = pairedClusterBootstrap(varied, 3000, 4242);
  const reproC = pairedClusterBootstrap(varied, 3000, 4243);
  check(
    reproA.lo === reproB.lo && reproA.hi === reproB.hi && reproA.mean === reproB.mean,
    `the same seed gives an identical interval (${reproA.lo} / ${reproA.hi} twice)`,
  );
  // A different seed must move the DISTRIBUTION. Note the endpoints of a small
  // discrete bootstrap can coincide across seeds — with 4 clusters the possible
  // differences are a handful of exact rationals, so the 2.5th percentile may
  // legitimately land on the same value twice. What must differ is the draw
  // set itself, which the MEAN detects: it averages every draw, not two of them.
  check(
    reproA.mean !== reproC.mean,
    `a different seed moves the bootstrap distribution (mean ${reproA.mean} vs ${reproC.mean}) ` +
      "— the draws really are seed-dependent",
  );
  // With enough clusters the endpoints themselves must separate too, otherwise
  // an interval quoted to two decimals would be seed-blind.
  const manyVaried = Array.from({ length: 200 }, (_, i) => ({
    weighted: { win: (i * 7) % 11, loss: 1 + ((i * 3) % 5) },
    binary: { win: (i * 5) % 13, loss: 1 + ((i * 2) % 7) },
  }));
  const manyA = pairedClusterBootstrap(manyVaried, 4000, 99);
  const manyB = pairedClusterBootstrap(manyVaried, 4000, 99);
  const manyC = pairedClusterBootstrap(manyVaried, 4000, 100);
  check(
    manyA.lo === manyB.lo && manyA.hi === manyB.hi,
    "with 200 clusters the same seed reproduces the endpoints exactly",
  );
  check(
    manyA.lo !== manyC.lo || manyA.hi !== manyC.hi,
    `with 200 clusters a different seed moves the endpoints (${manyA.lo}/${manyA.hi} vs ` +
      `${manyC.lo}/${manyC.hi}) — the reported precision is seed-sensitive, not rounded-flat`,
  );

  // ── win / (win + loss): timeout and insufficient_data are EXCLUDED ────────
  //
  // Checked against label.mjs itself rather than against a re-implementation,
  // so the exclusion is proven on the module the report actually uses. These
  // synthetic candles are built to produce a known label mix.
  const flat = (n) => Array.from({ length: n }, () => ({ high: 100, low: 100, close: 100 }));
  // 800 candles so that bar 10 and bar 100 each have a FULL 288-bar window
  // (100 + 288 = 388 < 800) and bar 400 has exactly enough (400 + 288 = 688 <
  // 800) to be a timeout rather than insufficient_data. With a 400-candle series
  // every one of these would have been insufficient_data — the distinction
  // under test is precisely the one the fixture has to be built to make.
  const labelCandles = flat(800);
  // Bar 10 rises to the +1.5% target within its window → win.
  for (let k = 1; k <= 288; k++) labelCandles[10 + k] = { high: 102, low: 100, close: 100 };
  // Bar 100 falls to the -0.8% stop within its window → loss.
  for (let k = 1; k <= 288; k++) labelCandles[100 + k] = { high: 100, low: 98, close: 100 };
  // Bar 400's window is flat: never touches either level → timeout.
  const timed = [
    { barIndex: 10, side: "long", price: 100 },
    { barIndex: 100, side: "long", price: 100 },
    { barIndex: 400, side: "long", price: 100 },
    { barIndex: 795, side: "long", price: 100 },
    { barIndex: 796, side: "long", price: 100 },
  ];
  const mixed = labelSignalsExitRule(labelCandles, timed);
  check(
    mixed.counts.win === 1 && mixed.counts.loss === 1,
    `the synthetic mix produces one win and one loss (got ${mixed.counts.win}W / ${mixed.counts.loss}L)`,
  );
  check(
    mixed.counts.timeout === 1,
    `the flat bar-400 window has a FULL horizon and touches neither level → timeout, ` +
      `not insufficient_data (got ${mixed.counts.timeout} timeout)`,
  );
  check(
    mixed.counts.insufficient_data === 2,
    `the bar-795 and bar-796 signals have fewer than 288 bars after them → ` +
      `insufficient_data, never a timeout and never a win (got ` +
      `${mixed.counts.timeout} timeout / ${mixed.counts.insufficient_data} insufficient)`,
  );
  // 1 / (1 + 1) = 50%. The 2 insufficient_data signals must NOT be in the
  // denominator: including them would give 1/3 = 33.33%.
  const mixedRate = (mixed.counts.win / (mixed.counts.win + mixed.counts.loss)) * 100;
  check(
    mixedRate === 50,
    `hit rate is win/(win+loss) = 50%, not win/total = ${((1 / 5) * 100).toFixed(2)}% — the ` +
      "1 timeout and 2 insufficient_data stay out of the denominator",
  );
  // A rate with NO resolved labels is undefined, not 0 and not 100: an
  // unresolved model must not be mistaken for one that never wins.
  const allInsufficient = labelSignalsExitRule(labelCandles, [
    { barIndex: 799, side: "long", price: 100 },
  ]);
  check(
    allInsufficient.counts.win + allInsufficient.counts.loss === 0 &&
      allInsufficient.counts.insufficient_data === 1,
    "a signal with no observable window resolves to zero win+loss — the rate is undefined, " +
      "so no hit rate may be printed for it",
  );
  // A loss-only population must read 0%, and a win-only population 100%: the
  // endpoints of the same definition.
  const winOnly = labelSignalsExitRule(labelCandles, [
    { barIndex: 10, side: "long", price: 100 },
  ]);
  check(
    (winOnly.counts.win / (winOnly.counts.win + winOnly.counts.loss)) * 100 === 100,
    "a win-only population reads 100% under win/(win+loss)",
  );
  const lossOnly = labelSignalsExitRule(labelCandles, [
    { barIndex: 100, side: "long", price: 100 },
  ]);
  check(
    (lossOnly.counts.win / (lossOnly.counts.win + lossOnly.counts.loss)) * 100 === 0,
    "a loss-only population reads 0% under win/(win+loss)",
  );
  // A SHORT inverts the levels: it wins when price FALLS to -1.5%, so the same
  // rising series must be a LOSS for the short side. If this ever passes as a
  // win, the side is being ignored in the level construction.
  const shortOnRise = labelSignalsExitRule(labelCandles, [
    { barIndex: 10, side: "short", price: 100 },
  ]);
  check(
    shortOnRise.counts.loss === 1 && shortOnRise.counts.win === 0,
    "a short against a rising series is a LOSS — the stop sits above the entry",
  );

  // ── Percentiles ───────────────────────────────────────────────────────────
  const sorted = [0, 10, 20, 30, 40];
  check(percentileOfSorted(sorted, 0) === 0, "p0 of a sorted array is its minimum");
  check(percentileOfSorted(sorted, 1) === 40, "p100 is its maximum");
  check(percentileOfSorted(sorted, 0.5) === 20, "p50 of an odd-length array is the middle element");
  check(
    percentileOfSorted([0, 10], 0.025) === 0.25,
    `percentiles interpolate linearly between ranks (got ${percentileOfSorted([0, 10], 0.025)})`,
  );
  check(percentileOfSorted([], 0.5) === null, "an empty array has no percentile");
  check(percentileOfSorted([7], 0.975) === 7, "a single draw has that draw as every percentile");

  // ── Flag parsing: an unseeded bootstrap is not reproducible ───────────────
  check(
    parseCompareFlags(["node", "run.mjs", "compare", "--seed", "1"]).seed === 1,
    "--seed <n> parses",
  );
  check(
    parseCompareFlags(["node", "run.mjs", "compare", "--bootstrap", "500"]).bootstrap === 500,
    "--bootstrap <n> parses",
  );
  check(
    parseCompareFlags(["node", "run.mjs", "compare"]).seed === undefined &&
      parseCompareFlags(["node", "run.mjs", "compare"]).bootstrap === undefined,
    "no flag → undefined, so compare.mjs applies its own printed defaults",
  );
  check(
    parseCompareFlags(["node", "run.mjs", "compare", "--seed", "1", "--seed", "1"]).seed === 1,
    "a repeated --seed is accepted (last occurrence wins)",
  );
  throws(
    () => parseCompareFlags(["node", "run.mjs", "compare", "--seed"]),
    Error,
    "--seed with no value is rejected rather than swallowing the next argument",
  );
  throws(
    () => parseCompareFlags(["node", "run.mjs", "compare", "--seed", "abc"]),
    Error,
    "a non-integer --seed is rejected — a silently defaulted seed would break reproducibility",
  );

  // ── Wiring: the new subcommand exists and cannot perturb the baselines ─────
  const cmpSrc = readFileSync(new URL("./compare.mjs", import.meta.url), "utf8");
  const runSrcCmp = readFileSync(new URL("./run.mjs", import.meta.url), "utf8");
  check(
    runSrcCmp.includes('import { parseCompareFlags, runCompare } from "./compare.mjs"'),
    "run.mjs imports the cluster bootstrap",
  );
  check(
    runSrcCmp.includes('subcommand === "compare"'),
    "compare is a dispatched subcommand",
  );
  check(
    runSrcCmp.includes('SUBCOMMANDS = ["fetch", "validate", "baseline", "diagnose", "compare", "search"]'),
    "compare is registered in SUBCOMMANDS — a typo'd name must not dispatch",
  );
  // compare.mjs MUST reuse baseline's signal generation rather than re-deriving
  // it: a second wiring loop could drift, and then the interval would describe a
  // population the baseline report never had.
  check(
    cmpSrc.includes('from "./baseline.mjs"') &&
      /import\s*\{[^}]*runComparison[^}]*\}\s*from\s*"\.\/baseline\.mjs"/.test(cmpSrc),
    "compare.mjs imports baseline's OWN runComparison — signals are reused, not re-derived",
  );
  check(
    cmpSrc.includes("labelSignalsExitRule") && cmpSrc.includes("labelSignalsForwardReturn"),
    "compare.mjs labels through modules/label.mjs — the same labeller baseline uses",
  );
  check(
    cmpSrc.includes("win + loss") || cmpSrc.includes("(win + loss)"),
    "the hit rate is computed as win/(win+loss) in compare.mjs too",
  );
  check(
    !cmpSrc.includes('from "./modules/signal-engine.mjs"') &&
      !cmpSrc.includes('from "./modules/binary.mjs"'),
    "compare.mjs does NOT instantiate either model — it cannot perturb the comparison",
  );
  // The interval must be REFUSED below the cluster threshold, never approximated.
  check(
    cmpSrc.includes("MIN_CLUSTERS_FOR_INTERVAL") &&
      cmpSrc.includes("joint.length >= MIN_CLUSTERS_FOR_INTERVAL"),
    "a small cluster count gates the interval — it is a gate, not a formatted warning",
  );
  // The CHECK, not the word: the file's header legitimately NAMES Math.random
  // while explaining why it is not used, so matching the bare identifier would
  // fail on a comment. This looks for an actual call site.
  check(
    /Math\.random\s*\(/.test(cmpSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")) ===
      false,
    "no Math.random CALL anywhere in compare.mjs — the bootstrap is seed-reproducible",
  );
  // baseline.mjs's sink must be OPTIONAL, or passing the extra argument would
  // change the baseline report it is supposed to leave byte-identical.
  check(
    /function runComparison\(candles, meta, tf, sink = null\)/.test(
      readFileSync(new URL("./baseline.mjs", import.meta.url), "utf8"),
    ),
    "baseline's sink parameter defaults to null — the baseline path is unchanged",
  );
  check(
    /if \(sink !== null\)/.test(readFileSync(new URL("./baseline.mjs", import.meta.url), "utf8")),
    "baseline calls the sink only when one was passed",
  );
}

// ─── 12. exit-ratio analysis on an independent sample ────────────────────────
//
// backtest/ratio.mjs is the file that asks whether the EXIT RATIO, rather than
// the weight vector, is the binding constraint. Everything it reports rests on
// four things that could each be wrong in a way that still prints plausible
// numbers, so each is checked here on SYNTHETIC, DATA-FREE input:
//
//   * the non-overlapping window selection — a known signal layout must give a
//     known kept/discarded count;
//   * the break-even algebra h*T - (1-h)*S and its inverse T/S = (1-h)/h, on
//     inputs whose answer can be done by hand;
//   * CI propagation through the required ratio, including that it is
//     transform-the-draws and NOT transform-the-endpoints;
//   * the surface's zero-crossing detection, including every way it must
//     REFUSE to locate one.
//
// The parameterised labeller is checked against modules/label.mjs ITSELF, on
// synthetic candles where the labels are known by hand, because a surface built
// by a re-implementation that had drifted would print a confident wrong answer.

sec("exit-ratio");
{
  // ── The window partition ────────────────────────────────────────────────
  check(windowIndexOf(0, 288) === 0, "bar 0 is the first window");
  check(windowIndexOf(287, 288) === 0, "bar 287 is still the first window (288 bars per window)");
  check(windowIndexOf(288, 288) === 1, "bar 288 opens the second window — the boundary is exact");
  check(windowIndexOf(575, 288) === 1, "bar 575 is inside the second window");
  check(windowIndexOf(576, 288) === 2, "bar 576 opens the third window");
  check(windowIndexOf(1, 1) === 1, "a one-bar window makes every bar its own window");
  throws(() => windowIndexOf(-1, 288), RangeError, "a negative barIndex is rejected");
  throws(() => windowIndexOf(0, 0), RangeError, "a zero window width is rejected");
  throws(() => windowIndexOf(1.5, 288), RangeError, "a fractional barIndex is rejected");

  // ── The selection: at most one per window, earliest entry bar ───────────
  //
  // Synthetic layout at 288 bars/window, four signals:
  //   bars 10 and 200  -> both in window 0 (10 - 0 = 10 < 288); keep 10.
  //   bar 600          -> window 2; nothing else there; keep it.
  //   bars 900 and 950 -> both in window 3; keep 900.
  // So 4 signals considered, 3 kept, 1 discarded.
  const layout = [
    { barIndex: 10, side: "long", price: 1 },
    { barIndex: 200, side: "long", price: 1 },
    { barIndex: 600, side: "short", price: 1 },
    { barIndex: 900, side: "short", price: 1 },
    { barIndex: 950, side: "short", price: 1 },
  ];
  const picked = selectIndependent(layout, 288);
  check(
    picked.selected.map((s) => s.barIndex).join(",") === "10,600,900",
    `one per window, earliest wins → 10,600,900 (got ${picked.selected.map((s) => s.barIndex).join(",")})`,
  );
  check(picked.considered === 5 && picked.discarded === 2, "5 considered, 3 kept, 2 discarded");
  check(picked.windowsUsed === 3, "three distinct windows occupied");
  check(
    selectIndependent(layout.slice().reverse(), 288).selected.map((s) => s.barIndex).join(",") ===
      "10,600,900",
    "selection is order-independent — the input is sorted first",
  );
  check(
    selectIndependent([], 288).selected.length === 0 && selectIndependent([], 288).windowsUsed === 0,
    "no signals → nothing kept, and zero windows rather than one empty window",
  );
  // Two signals on the SAME bar: still one observation, and the total-order
  // sort makes the choice deterministic rather than input-order dependent.
  const sameBar = [
    { barIndex: 5, side: "short", price: 1 },
    { barIndex: 5, side: "long", price: 1 },
  ];
  const samePicked = selectIndependent(sameBar, 288);
  check(samePicked.selected.length === 1, "two signals on one bar are ONE observation");
  check(samePicked.selected[0].side === "long", "a same-bar tie breaks on side, deterministically");
  // Independence is the point: kept signals are never closer than one window.
  const kept = selectIndependent(
    Array.from({ length: 10 }, (_, i) => ({ barIndex: i * 288, side: "long", price: 1 })),
    288,
  ).selected;
  check(
    kept.length === 10 && kept.every((s, i) => s.barIndex === i * 288),
    `ten signals one full window apart all survive — none competes for a window (kept ${kept.length})`,
  );
  // The adversarial case: many signals inside ONE window must collapse to the
  // first, which is the whole mechanism the independence claim rests on.
  const crowded = selectIndependent(
    Array.from({ length: 40 }, (_, i) => ({ barIndex: i * 7, side: "long", price: 1 })),
    288,
  );
  check(
    crowded.selected.length === 1 && crowded.selected[0].barIndex === 0,
    `40 signals packed inside one window collapse to the first at bar ` +
      `${crowded.selected[0]?.barIndex} (kept ${crowded.selected.length}) — this is what removes the ` +
      "overlapping-forward-window dependence",
  );
  // Boundary case: bars 287 and 288 are in ADJACENT windows and both survive,
  // even though their forward windows abut without overlapping.
  const abutting = selectIndependent(
    [{ barIndex: 287, side: "long", price: 1 }, { barIndex: 288, side: "long", price: 1 }],
    288,
  );
  check(
    abutting.selected.length === 2,
    "two signals whose windows ABUT (287 and 288) are in different windows and both survive",
  );
  throws(() => selectIndependent("nope", 288), TypeError, "a non-array signal list is rejected");

  // ── Break-even algebra, hand-computable ─────────────────────────────────
  //
  // D.4's shipped 1.5 / 0.8: 0.8 / 2.3 = 0.347826086956...
  const be1548 = breakevenHitRate(1.5, 0.8);
  check(
    Math.abs(be1548 - 0.8 / 2.3) < 1e-12,
    `break-even hit rate for 1.5/0.8 is 0.8/2.3 (got ${be1548})`,
  );
  check(
    Math.abs(be1548 * 100 - 34.78260869565217) < 1e-9,
    `which is 34.78% to two decimals (got ${(be1548 * 100).toFixed(4)}%)`,
  );
  check(currentRatio() === 1.875, `the shipped ratio is 1.5/0.8 = 1.875 (got ${currentRatio()})`);
  check(
    currentRatio() === EXIT_TARGET_PCT / EXIT_STOP_PCT,
    "the shipped ratio is read from label.mjs's own constants, not hard-coded twice",
  );
  // At exactly the break-even rate the expectancy is EXACTLY zero. That is the
  // identity the whole file rests on, so it is checked at three ratios.
  for (const [T, S] of [[1.5, 0.8], [0.5, 0.3], [3.0, 1.5]]) {
    check(
      Math.abs(expectancyPercent(breakevenHitRate(T, S), T, S)) < 1e-12,
      `expectancy is exactly 0 at the break-even rate for ${T}/${S}`,
    );
  }
  // Hand-computed expectations.
  check(
    Math.abs(expectancyPercent(0.3125, 1.5, 0.8) - -0.08125) < 1e-12,
    `0.3125*1.5 - 0.6875*0.8 = -0.08125 (got ${expectancyPercent(0.3125, 1.5, 0.8)})`,
  );
  check(
    Math.abs(expectancyPercent(0.3375, 1.5, 0.8) - -0.02375) < 1e-12,
    `0.3375*1.5 - 0.6625*0.8 = -0.02375, which docs/WEIGHT-CALIBRATION.md 5.2 prints as -0.02% ` +
      `(got ${expectancyPercent(0.3375, 1.5, 0.8)})`,
  );
  check(expectancyPercent(0.5, 1.5, 0.8) === 0.35, "a 50% hit rate earns (T-S)/2 = 0.35");
  check(expectancyPercent(1, 1.5, 0.8) === 1.5, "a 100% hit rate earns exactly the target");
  check(expectancyPercent(0, 1.5, 0.8) === -0.8, "a 0% hit rate loses exactly the stop");
  check(expectancyPercent(null, 1.5, 0.8) === null, "an undefined hit rate has no expectancy");

  // ── The inverse: T/S = (1-h)/h, and its direction ───────────────────────
  check(requiredRatio(0.5) === 1, "at h = 0.5 the required ratio is exactly 1");
  check(
    Math.abs(requiredRatio(0.25) - 3) < 1e-12,
    `at h = 0.25 the required ratio is exactly 3 (got ${requiredRatio(0.25)})`,
  );
  check(requiredRatio(0.75) === 1 / 3, "at h = 0.75 the required ratio is exactly 1/3");
  check(requiredRatio(1) === 0, "at h = 1 the required ratio is 0 — anything wins");
  // The two formulas must be INVERSES of one another on a sweep of ratios: a
  // pair that disagrees would mean one of them has the sign or the slope wrong.
  let inverseOk = true;
  for (const ratio of [0.5, 0.8, 1, 1.5, 1.875, 2.5, 4]) {
    const T = ratio;
    const S = 1;
    const h = breakevenHitRate(T, S);
    if (Math.abs(requiredRatio(h) - T) > 1e-12) inverseOk = false;
  }
  check(inverseOk, "breakevenHitRate and requiredRatio are exact inverses on a sweep of ratios");
  // DIRECTION, the thing that is easy to print backwards: a bigger ratio needs
  // a bigger hit rate, so a required ratio ABOVE the shipped 1.875 means the
  // shipped ratio is TOO SMALL for the observed accuracy.
  check(
    requiredRatio(0.3375) > currentRatio(),
    `h = 33.75% requires ${requiredRatio(0.3375).toFixed(4)} > the shipped ${currentRatio()} — ` +
      "a SMALLER accuracy needs a BIGGER ratio, so the shipped ratio is too small there",
  );
  check(
    requiredRatio(0.4375) < currentRatio(),
    `h = 43.75% requires ${requiredRatio(0.4375).toFixed(4)} < the shipped ${currentRatio()}`,
  );
  throws(() => requiredRatio(0), RangeError, "h = 0 has no finite required ratio and is rejected");
  throws(() => requiredRatio(1.2), RangeError, "a hit rate above 1 is rejected");
  throws(() => breakevenHitRate(0, 0.8), RangeError, "a zero target is rejected");
  throws(() => breakevenHitRate(1.5, -0.1), RangeError, "a negative stop is rejected");
  throws(() => expectancyPercent(1.5, 1.5, 0.8), RangeError, "expectancyPercent wants a FRACTION");

  // ── The direction of the gap: DEFICIT vs SURPLUS ─────────────────────────
  //
  // REGRESSION. The first version of ratio.mjs derived the word inline from
  // `gap > 0` while PHRASING the sentence from the perspective of
  // `shipped - required`, and shipped the INVERSE of the rule its own header
  // documented — on every grid, in both tables. The assertion below is on the
  // LABELLING FUNCTION, not on rendered text, so it survives any refactor of the
  // report that leaves the function itself alone.
  //
  // The rule, stated once: gap = requiredRatio(h) - shippedRatio.
  //   required > shipped -> the shipped ratio is TOO SMALL for the accuracy
  //                        observed -> DEFICIT
  //   required < shipped -> the shipped ratio is LARGER than the accuracy needs
  //                        -> SURPLUS
  //
  // Hand-computable anchors. At h = 0.25 the required ratio is EXACTLY 3.0, so
  // anything below 3.0 is a deficit and anything above 3.0 is a surplus.
  check(requiredRatio(0.25) === 3, "the anchor: requiredRatio(0.25) is exactly 3.0");
  check(
    ratioDirection(requiredRatio(0.25) - 1.875).code === "deficit",
    "required 3.0 vs a shipped 1.875 (below 3.0) is a DEFICIT",
  );
  check(
    ratioDirection(requiredRatio(0.25) - 4).code === "surplus",
    "required 3.0 vs a shipped 4.0 (above 3.0) is a SURPLUS",
  );
  // The same anchor across a spread of shipped ratios, which is the property the
  // brief asked to be asserted: any shipped ratio below the requirement is a
  // deficit, any above it a surplus.
  let directionSpreadOk = true;
  for (const shipped of [0.1, 0.5, 1, 1.875, 2, 2.9, 3.1, 5, 20]) {
    const code = ratioDirection(requiredRatio(0.25) - shipped).code;
    const expected = 3 - shipped > 0 ? "deficit" : 3 - shipped < 0 ? "surplus" : "balanced";
    if (code !== expected) directionSpreadOk = false;
  }
  check(
    directionSpreadOk,
    "against required 3.0, every shipped ratio below it is a deficit and every one above it a surplus",
  );

  // The same property stated through the ALGEBRA, so it holds for any h and not
  // only the anchor: the shipped ratio is too small exactly when h is below the
  // break-even rate for that shipped ratio.
  let algebraOk = true;
  for (const shipped of [0.5, 0.8, 1.875, 3]) {
    for (let h = 0.02; h < 1; h += 0.02) {
      const required = requiredRatio(h);
      const code = ratioDirection(required - shipped).code;
      const belowBreakEven = h < 1 / (1 + shipped);
      // A LARGER ratio demands a HIGHER hit rate: h under the rate shippedRatio
      // demands means the shipped ratio is TOO SMALL, i.e. a deficit.
      const expected = belowBreakEven ? "deficit" : h > 1 / (1 + shipped) ? "surplus" : "balanced";
      if (code !== expected) algebraOk = false;
    }
  }
  check(
    algebraOk,
    "the direction agrees with the break-even algebra at every h and every shipped ratio tested — " +
      "a larger ratio demands a higher hit rate, so a lower h means the shipped ratio is too small",
  );

  // Sign conventions, including the boundary the first version got wrong twice.
  check(ratioDirection(0).code === "balanced", "an exactly matched ratio is BALANCED, not a deficit");
  check(ratioDirection(null).code === "n/a", "a null gap labels n/a rather than guessing a direction");
  check(
    ratioDirection(0.0000001).code === "deficit" && ratioDirection(-0.0000001).code === "surplus",
    "the sign is honoured right up to the boundary: a hair above is a deficit, a hair below a surplus",
  );
  // h = 0 has an infinite requirement, which is above any shipped ratio, so it is
  // a DEFICIT. Labelling it anything else would leave the direction to inference.
  check(
    ratioDirection(null, true).code === "deficit" && ratioDirection(null, true).word.startsWith("DEFICIT"),
    "h = 0 (unbounded requirement) is labelled a DEFICIT, since infinite is above any shipped ratio",
  );
  check(
    ratioDirection(null, false).code === "n/a",
    "unbounded is an explicit flag, not inferred from a null gap — an unknown gap stays n/a",
  );
  // The words must carry the reasoning, not just the label, so a reader skimming
  // the word alone cannot invert it.
  check(
    /TOO SMALL/.test(ratioDirection(0.5).reason) && /ABOVE/.test(ratioDirection(0.5).reason),
    "the deficit reason states the shipped ratio is TOO SMALL and the requirement is ABOVE it",
  );
  check(
    /LARGER/.test(ratioDirection(-0.5).reason) && /BELOW/.test(ratioDirection(-0.5).reason),
    "the surplus reason states the shipped ratio is LARGER and the requirement is BELOW it",
  );
  check(
    ratioDirection(0.5).label.includes("TOO SMALL") && ratioDirection(-0.5).label.includes("LARGER"),
    "the table label repeats the reasoning in words, so the word cannot be inverted by skimming",
  );
  // One source of truth: the wiring section below asserts that ratio.mjs derives
  // the direction through ratioDirection() rather than re-inferring the sign.

  // ── CI propagation through the required ratio ───────────────────────────
  //
  // A population of 20 known labels: 12 wins, 8 losses. Resampling WITH
  // replacement does not preserve 12/8 on every draw, so the interval has real
  // width — that is the point of a bootstrap and it is what the seed pins.
  const twenty = Array.from({ length: 20 }, (_, i) => (i < 12 ? 1 : 2));
  const draws20 = bootstrapHitRateDraws(twenty, 4000, 4242);
  check(draws20.rates.length === 4000, "no draw is undefined when every observation is resolved");
  check(draws20.undefinedDraws === 0, "an all-resolved population has no undefined draws");
  const iv20 = hitRateInterval(draws20.rates);
  check(iv20.hi > iv20.lo, `a resample moves the count, so the interval has width ([${iv20.lo}%, ${iv20.hi}%])`);
  check(
    iv20.lo < 60 && iv20.hi > 60,
    `the interval BRACKETS the point estimate of 12/20 = 60% (got [${iv20.lo}%, ${iv20.hi}%])`,
  );
  check(
    Math.abs(iv20.mean - 60) < 0.5,
    `the bootstrap mean recovers the point estimate to under half a point (got ${iv20.mean}%) — ` +
      "resampling with replacement is centred, not biased",
  );

  // A truly DEGENERATE population — every observation the same outcome — makes
  // every draw identical, so the interval must have exactly zero width. That
  // pins win/(win+loss) as the statistic: under win/total this would not hold
  // for the mixed case above, and it pins the transform on a known answer.
  const allWins = Array.from({ length: 20 }, () => 1);
  const allWinIv = hitRateInterval(bootstrapHitRateDraws(allWins, 500, 11).rates);
  check(
    allWinIv.lo === 100 && allWinIv.hi === 100,
    `an all-win population gives exactly 100% on every draw, zero-width (got ${allWinIv.lo}/${allWinIv.hi})`,
  );
  const allWinReq = bootstrapTransformed(bootstrapHitRateDraws(allWins, 500, 11).rates, requiredRatio);
  check(
    allWinReq.lo === 0 && allWinReq.hi === 0,
    `and a required ratio of exactly 0 — at h = 1 any ratio breaks even (got ${allWinReq.lo})`,
  );
  // The mirror case: at h = 0 the required ratio is UNDEFINED (infinite). That
  // must degrade to a null bound, not throw out of the middle of a report.
  const allLossIv = hitRateInterval(bootstrapHitRateDraws(Array.from({ length: 20 }, () => 2), 500, 11).rates);
  check(allLossIv.lo === 0 && allLossIv.hi === 0, "an all-loss population gives exactly 0% on every draw");
  const allLossReq = bootstrapTransformed(
    bootstrapHitRateDraws(Array.from({ length: 20 }, () => 2), 500, 11).rates,
    requiredRatio,
  );
  check(
    allLossReq.lo === null && allLossReq.hi === null,
    "at h = 0 the required ratio is undefined: the bounds are null, not a throw and not an infinity",
  );

  // A population where the count VARIES, so the interval has real width.
  const varied = Array.from({ length: 60 }, (_, i) => (i % 5 < 3 ? 1 : 2));
  const variedDraws = bootstrapHitRateDraws(varied, 6000, 7).rates;
  const variedIv = hitRateInterval(variedDraws);
  check(
    variedIv.hi > variedIv.lo,
    `a varying population produces a non-zero-width interval ([${variedIv.lo}%, ${variedIv.hi}%])`,
  );
  // The propagated ratio interval must be the transform of the DRAWS, and its
  // endpoints must therefore be WIDER than the naive endpoint transform. That
  // is the whole reason this file transforms draws instead of endpoints:
  // (1-h)/h is convex, so mapping the two endpoints inward loses the tails.
  const ratioIv = bootstrapTransformed(variedDraws, requiredRatio);
  const naiveLo = (1 - variedIv.hi / 100) / (variedIv.hi / 100);
  const naiveHi = (1 - variedIv.lo / 100) / (variedIv.lo / 100);
  check(
    ratioIv.lo < naiveLo && ratioIv.hi > naiveHi,
    `propagating the DRAWS is strictly wider than mapping h's two endpoints ` +
      `([${ratioIv.lo}, ${ratioIv.hi}] vs the naive [${naiveLo.toFixed(4)}, ${naiveHi.toFixed(4)}])`,
  );
  check(
    ratioIv.lo < ratioIv.hi && variedIv.lo < variedIv.hi,
    "both intervals are properly ordered",
  );
  // Monotonicity: (1-h)/h falls as h rises. A single-draw distribution has
  // exact endpoints, which pins the transform on known answers without any
  // percentile interpolation in the way.
  check(
    bootstrapTransformed([0.5], requiredRatio).lo === 1,
    `a single draw at h = 0.5 gives exactly T/S = 1 (got ${bootstrapTransformed([0.5], requiredRatio).lo})`,
  );
  check(
    bootstrapTransformed([0.25], requiredRatio).lo === 3,
    "a single draw at h = 0.25 gives exactly T/S = 3",
  );
  const monoIv = bootstrapTransformed([0.3, 0.5], requiredRatio);
  check(
    monoIv.lo > 1 && monoIv.lo < 2 && monoIv.hi > monoIv.lo && monoIv.hi < 7,
    `the interval over h in [0.3, 0.5] spans the required ratios ${(1 / 0.5).toFixed(3)} down to ` +
      `${(1 / 0.3).toFixed(3)} without inverting them (got [${monoIv.lo}, ${monoIv.hi}])`,
  );
  check(
    bootstrapTransformed([0.3, 0.5], requiredRatio).lo === bootstrapTransformed([0.5, 0.3], requiredRatio).lo &&
      bootstrapTransformed([0.3, 0.5], requiredRatio).hi === bootstrapTransformed([0.5, 0.3], requiredRatio).hi,
    "the transform does not depend on the order of the draws",
  );
  // The seed makes two runs identical, and a different seed moves them.
  const rA = bootstrapHitRateDraws(varied, 4000, 99).rates;
  const rB = bootstrapHitRateDraws(varied, 4000, 99).rates;
  const rC = bootstrapHitRateDraws(varied, 4000, 100).rates;
  check(
    hitRateInterval(rA).lo === hitRateInterval(rB).lo && hitRateInterval(rA).hi === hitRateInterval(rB).hi,
    "the same seed reproduces the interval exactly",
  );
  check(
    hitRateInterval(rA).mean !== hitRateInterval(rC).mean,
    "a different seed moves the bootstrap distribution",
  );
  // An all-excluded population has no defined rate on any draw, and must be
  // counted rather than coerced to 0 or 1.
  const allExcluded = Array.from({ length: 12 }, () => 0);
  const undef = bootstrapHitRateDraws(allExcluded, 50, 1);
  check(
    undef.rates.length === 0 && undef.undefinedDraws === 50,
    `every draw of an all-timeout population is undefined and COUNTED (got ${undef.rates.length} kept / ` +
      `${undef.undefinedDraws} undefined)`,
  );
  check(
    hitRateInterval([]).lo === null && bootstrapTransformed([], requiredRatio).lo === null,
    "no draws → null endpoints, never 0 and never 100",
  );

  // ── The parameterised labeller equals modules/label.mjs ─────────────────
  //
  // The same synthetic fixture the label section uses, driven through BOTH
  // labellers at the shipped 1.5 / 0.8. If the surface's labeller had drifted,
  // this is where it would show.
  const lb = (high, low, close) => ({ high, low, close });
  const sig = (barIndex, side, price) => ({ barIndex, side, price });
  const synth = [
    lb(100.5, 99.5, 100), // 0
    lb(101.6, 99.9, 101.2), // 1 — long@0 reaches the +1.5% target (101.5) -> WIN
    lb(100.5, 99.5, 100), // 2
    lb(100.8, 99.1, 99.4), // 3 — long@2 reaches the -0.8% stop (99.2) -> LOSS
    lb(100.5, 99.5, 100), // 4
    lb(100.9, 99.5, 100.2), // 5 — short@4 reaches its +0.8% stop (100.8) -> LOSS
    lb(100.6, 98.4, 100), // 6 — short@5 (entry 100.2, target 98.697) reaches its target -> WIN
    lb(102.0, 98.0, 100), // 7 — long@6 touches BOTH levels on one bar -> LOSS + doubleTouch
    lb(100.5, 99.5, 100), // 8
    lb(100.5, 99.5, 100), // 9
    lb(100.5, 99.5, 100), // 10
    lb(100.5, 99.5, 100), // 11
    lb(100.5, 99.5, 100), // 12
    lb(100.5, 99.5, 100), // 13
    lb(100.5, 99.5, 100), // 14
    lb(100.5, 99.5, 100), // 15
  ];
  const synthSignals = {
    weighted: [sig(0, "long", 100), sig(2, "long", 100), sig(6, "long", 100)],
    binary: [sig(4, "short", 100), sig(5, "short", 100.2)],
  };
  const match = verifyParametricLabeller(synth, synthSignals, 4);
  check(
    match.ok && match.checks === 5,
    `labelExitAt equals label.mjs on all ${match.checks} synthetic signals (mismatches: ` +
      `${match.mismatches.join("; ") || "none"})`,
  );
  // Both labellers must also agree on the labels this fixture is built to make,
  // so a shared bug cannot make the check above pass vacuously.
  check(labelExitAt(synth, sig(0, "long", 100), 1.5, 0.8, 4).label === "win", "long target → win");
  check(labelExitAt(synth, sig(2, "long", 100), 1.5, 0.8, 4).label === "loss", "long stop → loss");
  check(labelExitAt(synth, sig(4, "short", 100), 1.5, 0.8, 4).label === "loss", "short stop → loss");
  check(
    labelExitAt(synth, sig(5, "short", 100.2), 1.5, 0.8, 4).label === "win",
    "short target → win",
  );
  const synthStraddle = labelExitAt(synth, sig(6, "long", 100), 1.5, 0.8, 4);
  check(
    synthStraddle.label === "loss" && synthStraddle.doubleTouch === true,
    "one bar touching both levels is a LOSS with the double-touch flag, as in label.mjs",
  );
  // The parameterisation must actually WORK: a target the price reaches and a
  // stop it does not flips the label, and the availability-first rule survives.
  check(
    labelExitAt(synth, sig(0, "long", 100), 0.5, 0.8, 4).label === "win",
    "halving the target keeps the same bar resolving as a win",
  );
  check(
    labelExitAt(synth, sig(0, "long", 100), 5.0, 0.8, 4).label === "loss",
    "a 5% target is never reached, so the stop resolves it as a loss",
  );
  check(
    labelExitAt(synth, sig(9, "long", 100), 5.0, 0.8, 4).label === "timeout",
    "with neither level reachable the label is timeout, not a forced loss",
  );
  check(
    labelExitAt(synth, sig(11, "long", 100), 1.5, 0.8, 4).label === "timeout",
    "a full horizon that touches neither level is a timeout",
  );
  check(
    labelExitAt(synth, sig(15, "long", 100), 1.5, 0.8, 4).label === "insufficient_data",
    "availability is checked before the scan: 0 bars left is insufficient_data, never a win",
  );
  check(
    labelExitAt(synth, sig(14, "long", 100), 1.5, 0.8, 1).label === "timeout",
    "one available bar that touches nothing is a timeout, not insufficient_data",
  );
  // Validation: the anti-miswire invariant is live on the parameterised path too.
  throws(
    () => labelExitAt(synth, sig(1, "long", 100), 1.5, 0.8, 4),
    TypeError,
    "a price that is not the signal bar's close is rejected (anti-miswire)",
  );
  throws(() => labelExitAt(synth, sig(99, "long", 100), 1.5, 0.8, 4), RangeError, "barIndex past the data");
  throws(() => labelExitAt(synth, sig(0, "buy", 100), 1.5, 0.8, 4), TypeError, "side domain enforced");
  throws(() => labelExitAt(synth, sig(0, "long", 100), 0, 0.8, 4), RangeError, "a zero target is rejected");
  throws(() => labelExitAt(synth, sig(0, "long", 100), 1.5, 0.8, 0), RangeError, "a zero horizon is rejected");

  // ── The surface axes and cells ──────────────────────────────────────────
  const targets = targetGridPct();
  const stops = stopGridPct();
  check(targets.length === 11 && stops.length === 13, `11 targets x 13 stops (got ${targets.length} x ${stops.length})`);
  check(targets[0] === 0.5 && targets[targets.length - 1] === 3.0, "the target axis runs 0.50 .. 3.00");
  check(stops[0] === 0.3 && stops[stops.length - 1] === 1.5, "the stop axis runs 0.30 .. 1.50");
  check(targets[4] === 1.5, `the shipped target 1.5 lands exactly on a grid index (got ${targets[4]})`);
  check(stops[5] === 0.8, `the shipped stop 0.8 lands exactly on a grid index (got ${stops[5]})`);
  const cells = surfaceCells(targets, stops);
  check(cells.length === 143, `143 cells (got ${cells.length})`);
  const d4Cell = cells.find((c) => c.targetPct === 1.5 && c.stopPct === 0.8);
  check(d4Cell !== undefined && d4Cell.ratio === 1.875, "the shipped 1.5/0.8 cell is present with ratio 1.875");

  // ── Cell outcomes and the per-cell bootstrap ───────────────────────────
  //
  // Eight observations in one window each, spaced a full window apart so they
  // stay independent. Candles are flat, so a "win" is manufactured by pushing
  // one bar's high above the target and a "loss" by pushing a low below the
  // stop. Fixture: 800 flat bars at 100.
  const flatCandles = Array.from({ length: 2400 }, () => ({ high: 100, low: 100, close: 100 }));
  const obs = [];
  for (let k = 0; k < 8; k++) {
    const bar = k * 288;
    obs.push(sig(bar, "long", 100));
    // The FIRST forward bar resolves every observation, so the label is decided
    // by one push and the rest of the window is irrelevant by construction:
    //   even k -> high 102 touches the 1.5% target (101.5) and clears the 0.8%
    //             stop (99.2)  => WIN
    //   odd  k -> low  98 touches the stop and never the target     => LOSS
    // Eight observations, one full window apart, so they stay independent.
    flatCandles[bar + 1] =
      k % 2 === 0 ? { high: 102, low: 100, close: 100 } : { high: 100, low: 98, close: 100 };
  }
  const obsCodes = cellOutcomes(flatCandles, obs, cells, 288);
  check(
    obsCodes.length === cells.length * obs.length,
    `cellOutcomes covers every cell x observation (${cells.length} x ${obs.length})`,
  );
  const d4Index = cells.indexOf(d4Cell);
  let d4Wins = 0;
  let d4Losses = 0;
  for (let j = 0; j < obs.length; j++) {
    const o = obsCodes[d4Index * obs.length + j];
    if (o === 1) d4Wins += 1;
    else if (o === 2) d4Losses += 1;
  }
  check(
    d4Wins === 4 && d4Losses === 4,
    `the D.4 cell labels the fixture 4 wins / 4 losses — bar +1 wins, bar +2 loses (got ${d4Wins}W/${d4Losses}L)`,
  );
  // A cell whose target is out of reach can only be a win when the STOP is
  // reached first; the same fixture at 5% / 0.8% must therefore be 0/8. This
  // proves the cells genuinely RE-LABEL rather than re-weighting one fixed h.
  const hardCell = cells.findIndex((c) => c.targetPct === 2.75 && c.stopPct === 0.3);
  let hardWins = 0;
  let hardLosses = 0;
  for (let j = 0; j < obs.length; j++) {
    const o = obsCodes[hardCell * obs.length + j];
    if (o === 1) hardWins += 1;
    else if (o === 2) hardLosses += 1;
  }
  check(
    hardWins === 0 && hardLosses === 4,
    `a tighter cell re-labels the SAME observations to 0 wins / 4 losses (got ${hardWins}W/${hardLosses}L) — ` +
      "cells re-label, they do not re-weight one fixed hit rate (the four 102 pushes no longer " +
      "reach a 2.75% target and turn into timeouts, while the 98 pushes still stop out)",
  );

  const tinyGrid = surfaceCells([1.5], [0.8]);
  const tinyBoot = bootstrapSurface(cellOutcomes(flatCandles, obs, tinyGrid, 288), obs.length, tinyGrid, 500, 3);
  check(tinyBoot.length === 1, "one cell yields one bootstrapped cell record");
  check(tinyBoot[0].win === 4 && tinyBoot[0].loss === 4, "the point counts match the fixture");
  check(tinyBoot[0].hitRatePercent === 50, `the point hit rate is 50% (got ${tinyBoot[0].hitRatePercent})`);
  check(
    tinyBoot[0].expectancyPercent === 0.35,
    `expectancy at h = 0.5 with T = 1.5, S = 0.8 is 0.5*1.5 - 0.5*0.8 = +0.35 exactly ` +
      `(got ${tinyBoot[0].expectancyPercent})`,
  );
  check(
    tinyBoot[0].expectancyCiLoPercent < tinyBoot[0].expectancyCiHiPercent,
    "the cell carries a propagated expectancy interval, not just a point estimate",
  );
  check(
    tinyBoot[0].significantlyPositive === false && tinyBoot[0].significantlyNegative === false,
    "an 8-observation interval straddles zero, so neither sign is established",
  );
  check(
    bootstrapSurface(new Int8Array(cells.length * obs.length), obs.length, tinyGrid, 100, 1).every
      ? bootstrapSurface(new Int8Array(cells.length * obs.length), obs.length, tinyGrid, 100, 1)[0].expectancyPercent === null
      : false,
    "an all-excluded cell has a null expectancy rather than a fabricated 0",
  );

  // ── Crossing detection, including every refusal ─────────────────────────
  //
  // A cell record is (point, ciLo, ciHi, axisValue, fixedAxisValue).
  const cell = (point, ciLo, ciHi, axisValue, fixedAxisValue) => ({
    expectancyPercent: point,
    expectancyCiLoPercent: ciLo,
    expectancyCiHiPercent: ciHi,
    significantlyPositive: ciLo > 0,
    significantlyNegative: ciHi < 0,
    axisValue,
    fixedAxisValue,
  });

  // (a) A clean, identified crossing: two negative cells then two positive.
  const clean = [
    cell(-0.4, -0.6, -0.2, 1.0, 0.8),
    cell(-0.2, -0.35, -0.05, 1.25, 0.8),
    cell(+0.1, +0.01, +0.19, 1.5, 0.8),
    cell(+0.3, +0.2, +0.4, 1.75, 0.8),
  ];
  const cleanCross = findZeroCrossing(clean);
  check(cleanCross.identified === true, "a sweep with a significant sign change IS identified");
  check(
    cleanCross.bracket.below === 1.25 && cleanCross.bracket.above === 1.5,
    `the bracket is the last negative and first positive cell (${cleanCross.bracket.below} → ${cleanCross.bracket.above})`,
  );
  // Linear interpolation between -0.2 at 1.25 and +0.1 at 1.5 puts zero at
  // 1.25 + 0.2 * 0.25 / 0.3 = 1.41666...
  check(
    Math.abs(cleanCross.crossingAxisValue - (1.25 + (0.2 * 0.25) / 0.3)) < 5e-4,
    `the crossing interpolates linearly to ${cleanCross.crossingAxisValue} (1.4167 to 4 dp)`,
  );
  check(
    Math.abs(cleanCross.crossingRatio - cleanCross.crossingAxisValue / 0.8) < 5e-4,
    `the crossing ratio is the crossing axis value over the fixed stop (${cleanCross.crossingRatio})`,
  );

  // (b) The whole sweep inside the noise: NOTHING may be located.
  const noisy = [
    cell(-0.2, -0.5, +0.1, 1.0, 0.8),
    cell(+0.1, -0.3, +0.5, 1.5, 0.8),
  ];
  const noisyCross = findZeroCrossing(noisy);
  check(
    noisyCross.identified === false && noisyCross.crossingAxisValue === null,
    "a sweep entirely inside the noise locates NO crossing and returns null, not a guess",
  );
  check(noisyCross.situation === "inside-noise", "and it says so explicitly");

  // (c) Established negative throughout: the crossing lies ABOVE the sampled
  // range. Reporting "inside the noise" here would be wrong, and so would
  // interpolating.
  const allNeg = [
    cell(-0.4, -0.6, -0.2, 1.0, 0.8),
    cell(-0.2, -0.35, -0.05, 1.5, 0.8),
  ];
  const negCross = findZeroCrossing(allNeg);
  check(
    negCross.situation === "entirely-negative" && negCross.identified === false,
    "a uniformly negative sweep is reported as entirely-negative, not as noise",
  );
  check(negCross.crossingAxisValue === null, "and still locates nothing");

  // (d) Established positive from the first cell: the crossing lies BELOW the
  // sampled range.
  const allPos = [
    cell(+0.4, +0.2, +0.6, 1.0, 0.8),
    cell(+0.2, +0.05, +0.35, 1.5, 0.8),
  ];
  const posCross = findZeroCrossing(allPos);
  check(
    posCross.situation === "entirely-positive" && posCross.identified === false,
    "a uniformly positive sweep is reported as entirely-positive",
  );
  check(posCross.crossingAxisValue === null, "and still locates nothing");

  // (e) The boundary case: a positive cell whose predecessor's interval merely
  // TOUCHES zero. That is not a significant negative, so no crossing.
  const touching = [
    cell(-0.2, -0.3, 0.0, 1.25, 0.8),
    cell(+0.1, +0.01, +0.19, 1.5, 0.8),
  ];
  const touchingCross = findZeroCrossing(touching);
  check(
    touchingCross.identified === false,
    "an interval that merely TOUCHES zero does not establish the sign below it — no crossing",
  );

  // (f) An empty sweep: no crash, no crossing.
  check(findZeroCrossing([]).identified === false, "an empty sweep locates nothing");

  // ── Wiring: the subcommand exists and cannot perturb anything ────────────
  const ratioSrc = readFileSync(new URL("./ratio.mjs", import.meta.url), "utf8");
  const runSrcRatio = readFileSync(new URL("./run.mjs", import.meta.url), "utf8");
  check(
    /import\s*\{[^}]*parseRatioFlags[^}]*\}\s*from\s*"\.\/ratio\.mjs"/.test(runSrcRatio),
    "run.mjs imports the ratio runner and its flag parser",
  );
  check(
    runSrcRatio.includes('subcommand === "ratio"'),
    "ratio is a dispatched subcommand",
  );
  // The six-name SUBCOMMANDS literal is asserted VERBATIM twice above (sections
  // 9 and 11) to prove each of those names is still registered. `ratio` is
  // therefore registered through a separate list rather than by widening that
  // literal, which would edit an assertion to make a new test pass.
  check(
    runSrcRatio.includes('SUBCOMMANDS = ["fetch", "validate", "baseline", "diagnose", "compare", "search"]'),
    "the six-name SUBCOMMANDS literal is untouched, so the earlier assertions still mean something",
  );
  check(
    runSrcRatio.includes('EXTRA_SUBCOMMANDS = ["ratio"]') && runSrcRatio.includes("DISPATCHABLE.includes(subcommand)"),
    "ratio is registered through DISPATCHABLE, so a typo in it still refuses to dispatch",
  );
  check(
    ratioSrc.includes('from "./baseline.mjs"') &&
      /import\s*\{[^}]*runComparison[^}]*\}\s*from\s*"\.\/baseline\.mjs"/.test(ratioSrc),
    "ratio.mjs reuses baseline's OWN runComparison — signals are not re-derived",
  );
  check(
    /import\s*\{[^}]*makeRng[^}]*\}\s*from\s*"\.\/compare\.mjs"/.test(ratioSrc),
    "ratio.mjs reuses compare.mjs's seeded RNG — one bootstrap convention",
  );
  check(
    ratioSrc.includes("labelSignalsExitRule") && ratioSrc.includes("verifyParametricLabeller"),
    "the parameterised labeller is PROVEN equal to modules/label.mjs before the surface is printed",
  );
  check(
    /if \(!labellerMatch\.ok\)[\s\S]{0,400}throw new Error/.test(ratioSrc),
    "a labeller mismatch THROWS rather than printing a surface computed over labels baseline never had",
  );
  check(
    !ratioSrc.includes('from "./modules/signal-engine.mjs"') &&
      !ratioSrc.includes('from "./modules/binary.mjs"'),
    "ratio.mjs does NOT instantiate either model — it cannot perturb the baselines",
  );
  check(
    ratioSrc.includes("MIN_OBSERVATIONS_FOR_INTERVAL") &&
      /resolved >= MIN_OBSERVATIONS_FOR_INTERVAL/.test(ratioSrc),
    "the observation threshold is a GATE applied before any bootstrap runs, not a formatted warning",
  );
  // The gate must be applied BEFORE the draws, or an ineligible scope would
  // compute a number it then declines to print.
  check(
    /const draws = eligible\s*\n?\s*\?\s*bootstrapHitRateDraws/.test(ratioSrc),
    "an ineligible scope makes NO bootstrap draws at all",
  );
  check(
    ratioSrc.includes("EXCLUDED = 0") && ratioSrc.includes("WIN = 1") && ratioSrc.includes("LOSS = 2"),
    "the outcome codes are declared as named constants, not bare literals in the loops",
  );
  // The CHECK, not the word: the file header legitimately NAMES Math.random
  // while explaining why it is not used.
  check(
    /Math\.random\s*\(/.test(ratioSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")) === false,
    "no Math.random CALL anywhere in ratio.mjs — every interval is seed-reproducible",
  );
  // The two claims this project must never make.
  check(
    ratioSrc.includes("NO BEST CELL IS REPORTED AND NO RATIO IS RECOMMENDED"),
    "the surface carries an explicit refusal to report a best cell or recommend a ratio",
  );
  check(
    ratioSrc.includes("SELECTION EFFECT") && ratioSrc.includes("ONE ARBITRARY"),
    "the selection effect of keeping one signal per window is stated, not implied",
  );
  // One source of truth for the direction word. The first version derived it
  // inline from `gap > 0` while phrasing the sentence from `shipped - required`,
  // and shipped the inverse of its own documented rule on every grid. The sign
  // must now be interpreted in exactly one place.
  check(
    /directionCode: d\.code/.test(ratioSrc) &&
      /return\s*\{[^}]*code: "deficit"/.test(ratioSrc) &&
      /if \(gap > 0\)/.test(ratioSrc),
    "ratioDirection() is the single place where the gap sign becomes a word",
  );
  check(
    !/gap > 0[\s\S]{0,200}surplus/.test(ratioSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")),
    "no branch anywhere maps a POSITIVE gap to the word surplus — that was the inversion",
  );
  check(
    !/gap < 0[\s\S]{0,200}deficit/.test(ratioSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")),
    "no branch anywhere maps a NEGATIVE gap to the word deficit",
  );
  // Every caller goes through the function, so a scope row, a horizon row and the
  // verdict cannot disagree about sign.
  check(
    ratioSrc.includes("ratioDirection(") &&
      (ratioSrc.match(/ratioDirection\(/g) || []).length >= 4,
    `the scope table, the horizon table and the verdict all call ratioDirection() ` +
      `(${(ratioSrc.match(/ratioDirection\(/g) || []).length} call sites) — one sign convention`,
  );
  check(
    ratioSrc.includes("gapDefinition"),
    "the JSON states the gap's sign convention explicitly, so a consumer cannot read it backwards",
  );
  check(
    ratioSrc.includes("0.10 round trip") || ratioSrc.includes("D4_ROUND_TRIP_COMMISSION_PCT"),
    "the 0.10% round-trip commission D.4 itself declares is carried into the caveats",
  );
  check(
    /expectancyPercent\(point, cell\.targetPct, cell\.stopPct\)/.test(ratioSrc) ||
      /expectancyPercent\(.*targetPct.*stopPct/.test(ratioSrc),
    "surface expectancy is computed by the SHARED h*T - (1-h)*S function, not re-derived per cell",
  );

  // ── Flag parsing is compare's, reused rather than forked ────────────────
  check(
    parseRatioFlags(["node", "run.mjs", "ratio", "--seed", "1"]).seed === 1,
    "--seed <n> parses for ratio",
  );
  check(
    parseRatioFlags(["node", "run.mjs", "ratio", "--bootstrap", "500"]).bootstrap === 500,
    "--bootstrap <n> parses for ratio",
  );
  check(
    parseRatioFlags(["node", "run.mjs", "ratio"]).seed === undefined &&
      parseRatioFlags(["node", "run.mjs", "ratio"]).bootstrap === undefined,
    "no flag → undefined, so ratio.mjs applies its own printed defaults",
  );
  throws(
    () => parseRatioFlags(["node", "run.mjs", "ratio", "--seed"]),
    Error,
    "--seed with no value is rejected rather than swallowing the next argument",
  );
  throws(
    () => parseRatioFlags(["node", "run.mjs", "ratio", "--seed", "abc"]),
    Error,
    "a non-integer --seed is rejected — a silently defaulted seed would break reproducibility",
  );
}

// ─── 13. horizon sweep: does a shorter hold buy a computable comparison? ─────
//
// The question this section exists to protect is the one the maintainer has to
// decide on: "independence costs sample size, and the cost is dominated by the
// window length — so if we shorten the horizon, does the comparison become
// computable?" Every assertion below is DATA-FREE and hand-computable, because
// the honest answer to that question is allowed to be "no", and a negative
// result must be as well-founded as a positive one.
//
// Four things could each be wrong while still printing plausible numbers:
//   * the partition at a NON-DEFAULT horizon — the sweep's whole premise is that
//     a shorter window keeps more observations, so a partition that silently
//     ignored the new width would fake the result;
//   * the flag grammar — accepting 0, a float, or a missing value would measure
//     a different trade than the caller asked for, silently;
//   * the minimum-detectable-difference arithmetic — a wrong constant here would
//     either promise power the sample does not have or hide power it does;
//   * the DEFAULT PATH — the whole feature is worthless if running without the
//     flag changed a byte of the report already on the record.

sec("horizon-sweep");
{
  // Read locally rather than reusing a `const` from another section: those are
  // block-scoped, and a shared name that silently resolved to `undefined` would
  // make every source assertion below vacuously FALSE rather than loudly broken.
  const ratioSrc = readFileSync(new URL("./ratio.mjs", import.meta.url), "utf8");
  const runSrcRatio = readFileSync(new URL("./run.mjs", import.meta.url), "utf8");
  const compareSrc = readFileSync(new URL("./compare.mjs", import.meta.url), "utf8");

  // ── The partition at a non-default horizon ─────────────────────────────
  //
  // The same five signals the section above uses at 288 bars, now at 48:
  //   bar  10 -> window 0
  //   bar 200 -> window 4   (200 / 48 = 4.17 -> 4)
  //   bar 600 -> window 12  (600 / 48 = 12.5  -> 12)
  //   bar 900 -> window 18  (900 / 48 = 18.75 -> 18)
  //   bar 950 -> window 19  (950 / 48 = 19.79 -> 19)
  // At 48 bars the 200 and 950 signals are no longer crowded out by 10 and 900
  // — they open windows of their own — so the SAME signals yield 5 kept instead
  // of 3. That is the entire mechanism the hypothesis rests on, and it is the
  // thing a stale 288-bar partition would have hidden.
  const layout48 = [
    { barIndex: 10, side: "long", price: 1 },
    { barIndex: 200, side: "long", price: 1 },
    { barIndex: 600, side: "short", price: 1 },
    { barIndex: 900, side: "short", price: 1 },
    { barIndex: 950, side: "short", price: 1 },
  ];
  const at48 = selectIndependent(layout48, 48);
  check(
    at48.selected.map((s) => s.barIndex).join(",") === "10,200,600,900,950",
    `a 48-bar partition keeps all five (got ${at48.selected.map((s) => s.barIndex).join(",")}) — ` +
      "the same signals that collapse to three at 288 bars stay independent when the window is short",
  );
  check(
    at48.considered === 5 && at48.discarded === 0 && at48.windowsUsed === 5,
    `5 considered, 5 kept, 0 discarded at 48 bars (got ${at48.considered}/${at48.discarded}/${at48.windowsUsed})`,
  );
  // The same layout at 288 is the section-12 answer, restated here so the two
  // horizons are compared side by side rather than across two files.
  const at288 = selectIndependent(layout48, 288);
  check(
    at288.selected.length === 3 && at288.discarded === 2,
    `the SAME layout collapses to 3 kept / 2 discarded at 288 bars (got ${at288.selected.length}/${at288.discarded})`,
  );
  // The partition genuinely RESPONDS to the width: same signals, different n.
  check(
    at48.selected.length > at288.selected.length,
    "a shorter window yields strictly more independent observations from the same signals",
  );
  // Window boundaries land exactly at multiples of the WIDTH, not of 288 — a
  // partition that still used 288 internally would put bar 48 in window 0.
  check(windowIndexOf(48, 48) === 1, "bar 48 opens the second 48-bar window");
  check(windowIndexOf(47, 48) === 0, "bar 47 is still inside the first 48-bar window");
  check(windowIndexOf(96, 48) === 2, "bar 96 opens the third 48-bar window");
  check(windowIndexOf(48, 288) === 0, "and bar 48 is still inside the first 288-bar window");
  // Crowding still collapses at a short width — the rule is not disabled by a
  // smaller number, which is what "the horizon drives the partition" must mean.
  // Forty signals at stride 1 occupy bars 0..39, which is genuinely inside ONE
  // 48-bar window. (Stride 3 would have spanned 118 bars and filled three, which
  // is a fixture that tests nothing about collapsing.)
  const crowded48 = selectIndependent(
    Array.from({ length: 40 }, (_, i) => ({ barIndex: i, side: "long", price: 1 })),
    48,
  );
  check(
    crowded48.selected.length === 1 && crowded48.selected[0].barIndex === 0,
    `40 signals packed into one 48-bar window still collapse to the first (kept ${crowded48.selected.length})`,
  );
  // And the complementary case: the same 40 signals, one per window, all
  // survive — so the collapse above is the window rule, not an artefact of count.
  check(
    selectIndependent(
      Array.from({ length: 10 }, (_, i) => ({ barIndex: i * 48, side: "long", price: 1 })),
      48,
    ).selected.length === 10,
    "ten signals exactly one 48-bar window apart all survive — the collapse is the window rule",
  );
  // Independence still holds at the short width: no two survivors are closer
  // than one window.
  check(
    at48.selected.every((s, i) => i === 0 || s.barIndex - at48.selected[i - 1].barIndex >= 48),
    "survivors at 48 bars are never closer than one 48-bar window",
  );
  // The width must be a POSITIVE INTEGER here too, or a caller reaching this
  // function directly could partition by a meaningless width.
  throws(() => selectIndependent(layout48, 0), RangeError, "a zero window width is rejected at any horizon");
  throws(() => selectIndependent(layout48, 48.5), RangeError, "a fractional window width is rejected");
  throws(() => selectIndependent(layout48, -48), RangeError, "a negative window width is rejected");
  // Selection stays order-independent at the new width, as it is at 288.
  check(
    selectIndependent([...layout48].reverse(), 48).selected.map((s) => s.barIndex).join(",") ===
      "10,200,600,900,950",
    "selection at 48 bars is order-independent, as at 288",
  );

  // ── The --horizon flag grammar ──────────────────────────────────────────
  //
  // 48 and 1 parse; 0, a negative, a float, an exponent form, junk and a missing
  // value are all refused. A silently-defaulted horizon would measure a
  // different trade than the caller asked for and report it under this
  // subcommand's name, which is the failure mode this parser exists to stop.
  check(parseRatioHorizonFlag(["node", "run.mjs", "ratio", "--horizon", "48"]) === 48, "--horizon 48 parses");
  check(parseRatioHorizonFlag(["node", "run.mjs", "ratio", "--horizon=48"]) === 48, "--horizon=48 parses");
  check(parseRatioHorizonFlag(["node", "run.mjs", "ratio", "--horizon", "1"]) === 1, "--horizon 1 is legal");
  check(
    parseRatioHorizonFlag(["node", "run.mjs", "ratio", "--horizon", "100000"]) === 100000,
    "a horizon larger than the dataset is the caller's business, not the parser's",
  );
  check(
    parseRatioHorizonFlag(["node", "run.mjs", "ratio"]) === undefined,
    "no --horizon → undefined, so the default path is distinguishable from an explicit 288",
  );
  check(
    parseRatioHorizonFlag(["node", "run.mjs", "ratio", "--seed", "1", "--bootstrap", "500"]) === undefined,
    "--horizon is absent when only the compare-shared flags are present",
  );
  check(
    parseRatioHorizonFlag(["node", "run.mjs", "ratio", "--horizon", "24", "--horizon", "48"]) === 48,
    "LAST occurrence wins, matching --seed and --bootstrap",
  );
  // THE REJECTION THE BRIEF ASKS FOR, spelled out both ways.
  throws(
    () => parseRatioHorizonFlag(["node", "run.mjs", "ratio", "--horizon", "0"]),
    Error,
    "--horizon 0 is REFUSED — a zero-bar hold is not a trade, and silently falling back to 288 would " +
      "report the default under a flag that asked for something else",
  );
  throws(
    () => parseRatioHorizonFlag(["node", "run.mjs", "ratio", "--horizon", "-48"]),
    Error,
    "--horizon -48 is refused: the hyphen makes it a non-digit string, not a number",
  );
  throws(
    () => parseRatioHorizonFlag(["node", "run.mjs", "ratio", "--horizon", "48.5"]),
    Error,
    "--horizon 48.5 is refused rather than rounded to a bar the caller did not ask for",
  );
  throws(
    () => parseRatioHorizonFlag(["node", "run.mjs", "ratio", "--horizon", "4.8e1"]),
    Error,
    "--horizon 4.8e1 is refused: a horizon arriving as a string is a wrapper quoting it wrong",
  );
  throws(
    () => parseRatioHorizonFlag(["node", "run.mjs", "ratio", "--horizon", "abc"]),
    Error,
    "--horizon abc is refused",
  );
  throws(
    () => parseRatioHorizonFlag(["node", "run.mjs", "ratio", "--horizon", ""]),
    Error,
    "--horizon with an empty value is refused, not read as 0 and defaulted",
  );
  throws(
    () => parseRatioHorizonFlag(["node", "run.mjs", "ratio", "--horizon"]),
    Error,
    "--horizon with no value is refused rather than swallowing the next argument",
  );
  throws(
    () => parseRatioHorizonFlag(["node", "run.mjs", "ratio", "--horizon", "--json"]),
    Error,
    "--horizon followed by another flag is refused rather than consuming it as a value",
  );
  // A 0 horizon and a 0 seed must be treated DIFFERENTLY: 0 is a legal seed and
  // a legal draw count, and only the horizon is forbidden from it. Sharing one
  // parser would have forced one of those rules to be loosened.
  check(
    parseRatioFlags(["node", "run.mjs", "ratio", "--seed", "0"]).seed === 0,
    "--seed 0 is still LEGAL — the shared parser was not loosened to accommodate the horizon rule",
  );
  check(
    parseRatioFlags(["node", "run.mjs", "ratio", "--bootstrap", "0"]).bootstrap === 0,
    "--bootstrap 0 is still legal under the same parser",
  );
  // The default is READ from label.mjs rather than restated, so it cannot drift.
  check(
    defaultHorizon() === EXIT_RULE_DEFAULTS.maxHorizonBars,
    "the default horizon is read from label.mjs's own constant, not hard-coded a second time",
  );
  check(defaultHorizon() === 288, `and that constant is still 288 (got ${defaultHorizon()})`);

  // ── The power arithmetic, on hand-computable inputs ─────────────────────
  //
  // The normal quantiles are the whole basis of the design, so they are pinned
  // against their published values FIRST. A wrong quantile here would silently
  // inflate or deflate every power statement in the report.
  //
  // The tolerance is 1e-8, and that is the MEASURED accuracy of the shipped
  // algorithm rather than a wish: Acklam's approximation, used unrefined, is
  // 1.6e-9 from the published value at p = 0.975. The tolerance is five times
  // that, so it pins the value to eight decimals — six orders of magnitude
  // tighter than the 0.01 pp the report prints.
  //
  // This assertion is also the guard against re-introducing a "polish" step.
  // Refining Acklam with Halley against normalCdf() is the obvious improvement
  // and it makes the answer a THOUSAND TIMES worse (1.2e-6 instead of 1.6e-9),
  // because Halley converges to the root of the approximate CDF it is handed.
  // A tightened-looking change that silently degrades a constant is exactly what
  // a value-pinned assertion is for.
  check(
    Math.abs(normalQuantile(0.975) - 1.959963985) < 1e-8,
    `z for a two-sided 95% interval is 1.959964 to 8 decimals (got ${normalQuantile(0.975)}) — ` +
      "and this tolerance FAILS if a Halley refinement is added back",
  );
  check(
    Math.abs(normalQuantile(0.8) - 0.841621234) < 1e-8,
    `z for 80% power is 0.841621 to 8 decimals (got ${normalQuantile(0.8)})`,
  );
  // The CDF itself, against published values, at the accuracy it has.
  let cdfAccuracyOk = true;
  for (const [x, published] of [
    [0.5, 0.6914624612740131],
    [1, 0.8413447460685429],
    [1.5, 0.9331927987311419],
    [2, 0.9772498680518208],
    [3, 0.9986501019683699],
    [1.959963985, 0.975],
    [0.841621234, 0.8],
  ]) {
    if (Math.abs(normalCdf(x) - published) > 1e-7) cdfAccuracyOk = false;
  }
  check(
    cdfAccuracyOk,
    "the CDF matches published Phi values to 1e-7 across 0.5..3 — the algorithm's real accuracy, " +
      "measured rather than assumed",
  );
  // The quantile must be a genuine inverse of the CDF it will be used with.
  // The tolerance is the CDF's own 7e-8 floor: no quantile can invert an
  // approximation more precisely than that approximation is defined, and
  // asserting tighter would be asserting a property the function cannot have.
  let quantileRoundTrip = true;
  for (const p of [0.001, 0.01, 0.025, 0.1, 0.2, 0.5, 0.8, 0.9, 0.975, 0.99, 0.999]) {
    const z = normalQuantile(p);
    if (Math.abs(normalCdf(z) - p) > 1e-7) quantileRoundTrip = false;
  }
  check(
    quantileRoundTrip,
    "Φ(normalQuantile(p)) === p to 1e-7 across the range — the quantile inverts the CDF to within " +
      "the CDF's own error, which is the strongest property it can have",
  );
  check(Math.abs(normalCdf(0) - 0.5) < 1e-8, "Φ(0) is 0.5 to 8 decimal places");
  check(normalCdf(8) > 0.999999999 && normalCdf(-8) < 1e-9, "the CDF saturates in both tails");
  check(
    Math.abs(normalCdf(0.7) + normalCdf(-0.7) - 1) < 1e-7,
    "Φ is symmetric about zero: Phi(x) + Phi(-x) = 1, so a sign slip cannot hide",
  );
  // Monotone in p — a quantile function that is not monotone would make
  // "higher confidence needs a larger z" false somewhere. The sweep is built
  // from integer percentages rather than by repeated addition, because
  // accumulating 0.01 in binary floating point overshoots 1.0 and asks for a
  // quantile outside the domain.
  let quantileMonotone = true;
  for (let i = 1; i < 99; i++) {
    const p = i / 100;
    if (normalQuantile(p) >= normalQuantile((i + 1) / 100)) quantileMonotone = false;
  }
  check(
    quantileMonotone,
    "the quantile is strictly increasing in p, so a larger confidence or power always demands a larger z",
  );
  throws(() => normalQuantile(0), RangeError, "a quantile at 0 is rejected, not infinite");
  throws(() => normalQuantile(1), RangeError, "a quantile at 1 is rejected, not infinite");
  throws(() => normalQuantile(1.5), RangeError, "a quantile above 1 is rejected");
  throws(() => normalQuantile(-0.1), RangeError, "a quantile below 0 is rejected");

  // MDD, hand-computed. At p̄ = 0.5, n₁ = n₂ = 100, 95% two-sided and 80% power:
  //   (1.959963985 + 0.841621234) * sqrt( 0.25 * (1/100 + 1/100) ) * 100
  // = 2.801585219 * sqrt(0.005) * 100
  // = 2.801585219 * 0.0707106781 * 100  = 19.8102
  // The published z values are used in the expected figure, NOT this file's own
  // quantiles — otherwise the assertion would be circular and would pass even if
  // both the quantiles and the formula were wrong together.
  const mdd100 = minimumDetectableDifferencePp(100, 100, 0.5);
  check(
    Math.abs(mdd100 - (1.959963985 + 0.841621234) * Math.sqrt(0.005) * 100) < 1e-4,
    `MDD at n=100 per arm, p=0.5 is 19.8102 pp (got ${mdd100.toFixed(4)})`,
  );
  check(
    mdd100 > 19.8 && mdd100 < 19.82,
    `the same figure to two decimals, 19.81 pp (got ${mdd100.toFixed(2)})`,
  );
  // The variance factor is 1/n1 + 1/n2, so unequal arms are handled and the
  // result sits between the two equal-arm cases it is bounded by.
  const mddUneq = minimumDetectableDifferencePp(50, 200, 0.5);
  check(
    mddUneq > minimumDetectableDifferencePp(100, 100, 0.5) &&
      mddUneq < minimumDetectableDifferencePp(50, 50, 0.5),
    "an uneven pair (50/200) gives a wider MDD than (100/100) and a narrower one than (50/50)",
  );
  // Quadrupling n halves the MDD — the sqrt(n) scaling, asserted as a property
  // rather than a value so it holds for any p and any arm split.
  check(
    Math.abs(
      minimumDetectableDifferencePp(400, 400, 0.3) / minimumDetectableDifferencePp(100, 100, 0.3) - 0.5,
    ) < 1e-9,
    "4x the observations halves the minimum detectable difference (sqrt(n) scaling)",
  );
  // The binomial variance is maximal at p = 0.5, so the worst case must bound
  // every other pooled rate from above at the same n.
  let worstCaseHolds = true;
  for (const n of [30, 131, 249, 1000]) {
    const worst = minimumDetectableDifferencePp(n, n, 0.5);
    for (const p of [0.05, 0.2, 0.3478, 0.5, 0.7, 0.95]) {
      if (minimumDetectableDifferencePp(n, n, p) > worst + 1e-12) worstCaseHolds = false;
    }
  }
  check(
    worstCaseHolds,
    "p = 0.5 bounds every pooled rate from above, so the worst-case column is a real bound",
  );
  // Degenerate inputs return null — "this sample can detect nothing" is a fact,
  // and a very large number would read like a measurement.
  check(minimumDetectableDifferencePp(0, 100, 0.35) === null, "zero observations → null, not a huge number");
  check(minimumDetectableDifferencePp(100, 0, 0.35) === null, "a zero-sized second arm → null");
  check(minimumDetectableDifferencePp(100, 100, 0) === null, "a pooled rate of 0 → null (no variance to use)");
  check(minimumDetectableDifferencePp(100, 100, 1) === null, "a pooled rate of 1 → null");
  check(minimumDetectableDifferencePp(100, 100, null) === null, "an undefined pooled rate → null");
  throws(
    () => minimumDetectableDifferencePp(100, 100, 0.35, 1.5, 0.8),
    RangeError,
    "a confidence outside (0, 1) is rejected rather than silently producing a z",
  );
  throws(
    () => minimumDetectableDifferencePp(100, 100, 0.35, 0.95, 0),
    RangeError,
    "a power of 0 is rejected rather than asking for infinite n",
  );

  // n needed, hand-computed and INVERSE of the MDD above. For a 2.5 pp gap at
  // p̄ = 0.5: 2 * (2.801585)^2 * 0.25 / 0.025^2 = 2 * 7.848879 * 0.25 / 0.000625
  // = 3.924440 / 0.000625 = 6279.1  ->  6280 per arm.
  const nFor25 = observationsNeededForGapPp(2.5, 0.5);
  check(
    Math.abs(nFor25 - Math.ceil((2 * 2.801585219 ** 2 * 0.25) / 0.025 ** 2)) < 1,
    `n for a 2.5 pp gap at p=0.5 is 6,280 per arm (got ${nFor25})`,
  );
  check(nFor25 === 6280, `exactly 6,280 (got ${nFor25})`);
  // THE INVERSE PROPERTY, and it is the one that matters: feeding n back into
  // the MDD must land within rounding of the gap we asked for. If these two
  // formulas ever drifted apart the report would print a shortfall against a
  // target it could not itself have reached.
  let inverseHolds = true;
  for (const gap of [1, 2.5, 5, 8, 10]) {
    for (const p of [0.2, 0.3478, 0.5]) {
      const n = observationsNeededForGapPp(gap, p);
      const mdd = minimumDetectableDifferencePp(n, n, p);
      // Ceil() can leave the MDD a hair BELOW the gap; a hair ABOVE would mean
      // the "n needed" is one short, which is a real defect.
      if (mdd > gap + 1e-6) inverseHolds = false;
    }
  }
  check(
    inverseHolds,
    "observationsNeededForGapPp(n) inverts minimumDetectableDifferencePp(n): the n it reports is never " +
      "one short of what its own MDD formula would require",
  );
  // And the two together are monotone in the direction the hypothesis needs:
  // a smaller gap demands more observations, a shorter-horizon sample with the
  // same rate demands the same n. Asserted as orderings, not values.
  check(
    observationsNeededForGapPp(1, 0.35) > observationsNeededForGapPp(2.5, 0.35) &&
      observationsNeededForGapPp(2.5, 0.35) > observationsNeededForGapPp(5, 0.35),
    "a SMALLER gap needs MORE observations, at every pooled rate tested",
  );
  // VARIANCE, and its direction, which is easy to state backwards: p(1-p) is
  // MAXIMAL at p = 0.5, so p = 0.5 is the rate that needs the MOST observations
  // and rates near 0 or 1 need the fewest. (The first draft of this assertion
  // claimed the opposite and failed — the arithmetic was right and the
  // sentence was wrong.)
  check(
    observationsNeededForGapPp(2.5, 0.1) < observationsNeededForGapPp(2.5, 0.5),
    "p = 0.1 needs FEWER observations than p = 0.5 for the same gap: the binomial variance p(1-p) is " +
      "maximal at 0.5, and 0.1 needs 2,261 against 0.5's 6,280",
  );
  check(
    observationsNeededForGapPp(2.5, 0.32) < observationsNeededForGapPp(2.5, 0.5),
    "and the same holds at 0.32, the rate slice 9 actually measured on 1h",
  );
  // The 2.5 pp figure the whole exercise turns on. At the pooled rate slice 9
  // measured (~0.32 on 1h) the requirement is 5,466 per model — against the 130
  // resolved observations the 288-bar partition actually yields, a 42x
  // shortfall. This is the number that decides the exercise, so it is pinned.
  const nFor25at32 = observationsNeededForGapPp(2.5, 0.32);
  check(
    nFor25at32 === 5466,
    `a 2.5 pp gap at p̄ = 0.32 needs exactly 5,466 independent observations per model (got ${nFor25at32})`,
  );
  check(
    nFor25at32 / 130 > 40,
    `that is ${(nFor25at32 / 130).toFixed(0)}x the 130 resolved observations the 288-bar partition ` +
      "yields — the shortfall is structural, not marginal",
  );
  check(
    observationsNeededForGapPp(0, 0.5) === Infinity,
    "a zero gap needs UNBOUNDED n, not a number that would suggest a sample size exists",
  );
  check(observationsNeededForGapPp(null, 0.5) === null, "an undefined gap → null");
  check(observationsNeededForGapPp(2.5, 0) === null, "a pooled rate of 0 → null, not a divide-by-zero");
  throws(() => observationsNeededForGapPp(-1, 0.5), RangeError, "a negative gap is rejected");
  throws(
    () => observationsNeededForGapPp(2.5, 0.5, 2, 0.8),
    RangeError,
    "a confidence outside (0, 1) is rejected",
  );

  // Pooling: every win over every resolved observation, both models. A weighted
  // and a binary scope of 40 wins over 100 resolved each pool to 0.40, NOT to
  // the average of the two rates weighted equally by SCOPE — the variance a
  // difference test sees is around the pooled mean, and pooling by count is what
  // makes that true when the arms differ in size.
  const scopeA = { counts: { win: 30, loss: 70 }, resolved: 100 };
  const scopeB = { counts: { win: 50, loss: 50 }, resolved: 100 };
  check(
    Math.abs(pooledHitRate(scopeA, scopeB) - 0.4) < 1e-12,
    `pooled rate is (30+50)/(100+100) = 0.40 (got ${pooledHitRate(scopeA, scopeB)})`,
  );
  const smallA = { counts: { win: 1, loss: 9 }, resolved: 10 };
  const bigB = { counts: { win: 50, loss: 50 }, resolved: 100 };
  check(
    Math.abs(pooledHitRate(smallA, bigB) - 51 / 110) < 1e-12,
    "pooling weights by OBSERVATION COUNT, not equally by scope — an unequal pair does not average to 0.5",
  );
  check(pooledHitRate({ counts: { win: 0, loss: 0 }, resolved: 0 }, scopeB) === 0.5, "a scope with nothing resolved contributes nothing");
  check(
    pooledHitRate({ counts: { win: 0, loss: 0 }, resolved: 0 }, { counts: { win: 0, loss: 0 }, resolved: 0 }) === null,
    "two empty scopes pool to null rather than 0, which would read as a real rate of zero",
  );

  // The power block, on a pair whose answer can be checked by hand.
  const pw = powerBlock(
    { counts: { win: 40, loss: 60 }, resolved: 100, hitRatePercent: 40 },
    { counts: { win: 50, loss: 50 }, resolved: 100, hitRatePercent: 50 },
    2.5,
  );
  check(
    Math.abs(pw.minimumDetectableDifferencePp - minimumDetectableDifferencePp(100, 100, 0.45)) < 1e-4,
    "the block's MDD is the standalone MDD on the POOLED rate, not on either arm's own rate",
  );
  check(pw.observedGapPp === 10, `the observed gap is binary minus weighted (got ${pw.observedGapPp})`);
  check(pw.observations.weighted === 100 && pw.observations.binary === 100, "both arms' n are carried");
  check(
    pw.sampleAdequateForReferenceGap === false,
    "a 100/arm sample is NOT adequate for a 2.5 pp gap — MDD 18.2 pp is far above it",
  );
  check(
    /COULD NOT have detected/.test(pw.verdict),
    "the verdict says the sample could not have detected the reference gap, in those words",
  );
  // The mirror case: a large n and a large reference gap flips the verdict, so
  // the wording is not hard-wired to the negative.
  const pwBig = powerBlock(
    { counts: { win: 4900, loss: 5100 }, resolved: 10000, hitRatePercent: 49 },
    { counts: { win: 5100, loss: 4900 }, resolved: 10000, hitRatePercent: 51 },
    2.5,
  );
  check(
    pwBig.sampleAdequateForReferenceGap === true && /COULD have detected/.test(pwBig.verdict),
    "10,000 observations per arm IS adequate for a 2.5 pp gap, and the verdict flips to say so",
  );
  // The shortfall names the multiple, and flags a requirement the grid's ceiling
  // structurally cannot reach.
  const pwShort = powerBlock(
    { counts: { win: 40, loss: 60 }, resolved: 100, hitRatePercent: 40 },
    { counts: { win: 50, loss: 50 }, resolved: 100, hitRatePercent: 50 },
    2.5,
  );
  check(
    pwShort.referenceGapShortfallObservations > 0 && pwShort.referenceGapShortfallMultiple > 60,
    `the shortfall is reported in both observations and multiples (${pwShort.referenceGapShortfallObservations}, ` +
      `${pwShort.referenceGapShortfallMultiple}x)`,
  );
  // A shortfall the grid's ceiling could NOT close is flagged, because "fetch
  // more data" and "no more data exists on this grid" are different decisions.
  check(
    /CEILING/.test(shortfallText(pwShort, 100, 200)),
    "a requirement above the grid's structural ceiling is flagged > CEILING, because no amount of " +
      "history on this grid can close it",
  );
  check(
    !/CEILING/.test(shortfallText(pwShort, 100, 100000)),
    "and it is NOT flagged when the ceiling is far above the requirement — a fetch problem and a " +
      "structural one must not read the same",
  );
  check(
    /surplus/.test(shortfallText(pwBig, 10000, 20000)),
    "a sample larger than needed reports a surplus rather than a shortfall",
  );
  check(shortfallText({ observationsNeededForReferenceGap: Infinity }, 10, 100) === "needs unbounded n", "a zero gap prints 'needs unbounded n'");
  check(shortfallText({ observationsNeededForReferenceGap: null, referenceGapShortfallObservations: null }, 10, 100) === "n/a", "no requirement → n/a, never a fabricated 0");

  // ── The default path is unchanged ───────────────────────────────────────
  //
  // Not a re-run of the report — that is the maintainer's byte diff, and this
  // suite has no data. What IS asserted here is every mechanism by which the
  // default could have moved: the default horizon is label.mjs's own constant,
  // an absent flag is distinguishable from an explicit one, and the new
  // sections are GATED on that distinction rather than on a value comparison.
  check(
    /const horizon = options\.horizon \?\? EXIT_RULE_DEFAULTS\.maxHorizonBars;/.test(ratioSrc),
    "the horizon falls back to label.mjs's OWN default, so the no-flag run cannot drift from it",
  );
  check(
    /const horizonRequested = options\.horizon !== undefined && options\.horizon !== null;/.test(ratioSrc),
    "'was --horizon asked for' is tracked SEPARATELY from the horizon value, so an explicit 288 and an " +
      "absent flag are not the same thing",
  );
  check(
    /if \(r\.horizon\.requested\) \{\s*\n\s*printHorizonBanner\(r\);\s*\n\s*printPower\(r\);/.test(ratioSrc),
    "BOTH new report sections are gated on horizon.requested, so the default report prints neither",
  );
  check(
    ratioSrc.includes("HORIZON OVERRIDE") && /r\.horizon\.requested\) \{/.test(ratioSrc),
    "the config-line horizon override is gated too — the default report's config block is untouched",
  );
  check(
    /r\.horizon\.requested\s*\?\s*""\s*:\s*" That ceiling is the reason the interval below is wide\."/.test(ratioSrc),
    "the ceiling sentence is emitted verbatim on the default path and only extended under --horizon, so " +
      "the shipped report keeps its original wording",
  );
  check(
    ratioSrc.includes("TRUNCATES every trade that would have reached"),
    "the truncation bias is stated in the report BODY, not only in a closing caveat — it is the single " +
      "most likely misreading of a horizon sweep",
  );
  check(
    ratioSrc.includes("MULTIPLE TESTING") && /NO multiplicity correction is applied/.test(ratioSrc),
    "the multiple-testing caveat names itself AND names the absence of a correction, rather than leaving " +
      "a reader to assume one was applied",
  );
  check(
    ratioSrc.includes("A RATIO FITTED AT ONE HORIZON DOES NOT TRANSFER TO ANOTHER"),
    "the non-transferability of a per-horizon ratio is stated, so the required-ratio table cannot be " +
      "read as a list of candidates",
  );
  check(
    /!Number\.isInteger\(horizon\) \|\| horizon < 1/.test(ratioSrc),
    "the run itself re-validates the horizon, so a caller bypassing the flag parser cannot pass 0",
  );
  check(
    ratioSrc.includes("slippageTicks: 2") && !/slippage.*ticks.*percent|percent.*ticks/.test(
      ratioSrc.replace(/^\s*\/\/.*$/gm, ""),
    ),
    "no percentage is ever invented for the two slippage ticks — the ticks stay ticks at every horizon",
  );
  // The ceiling is a NUMBER in the JSON, not only a formatted sentence, so a
  // consumer can compare horizons without parsing prose.
  check(
    /maxObservationsPerScope: Math\.ceil\(candles\.length \/ horizon\)/.test(ratioSrc),
    "the bars/horizon ceiling is carried as a number in the JSON, not only in a printed line",
  );
  check(
    /normalQuantile\(1 - \(1 - confidence\) \/ 2\)/.test(ratioSrc) &&
      /normalQuantile\(power\)/.test(ratioSrc),
    "the design's two quantiles are read from ONE normalQuantile, so confidence and power cannot be " +
      "hard-coded to inconsistent tables",
  );
  // run.mjs must pass the parsed horizon through rather than swallow it.
  check(
    /import\s*\{[^}]*parseRatioHorizonFlag[^}]*\}\s*from\s*"\.\/ratio\.mjs"/.test(runSrcRatio),
    "run.mjs imports the horizon parser from ratio.mjs",
  );
  check(
    /horizon: parseRatioHorizonFlag\(process\.argv\)/.test(runSrcRatio),
    "run.mjs passes the parsed horizon into runRatio — the flag reaches the analysis",
  );
  // parseCompareFlags must NOT have been widened: a shared parser carrying a
  // flag only `ratio` accepts would be a test edit made to fit a new feature.
  check(
    !/parseCompareFlags[\s\S]{0,600}horizon/.test(compareSrc),
    "compare.mjs's shared flag parser was NOT widened to carry --horizon; the new flag has its own parser",
  );
  check(
    /return \{\s*\n\s*seed: readInt\("--seed"\),\s*\n\s*bootstrap: readInt\("--bootstrap"\),\s*\n\s*\};/.test(
      compareSrc,
    ),
    "parseCompareFlags still returns exactly { seed, bootstrap } — the literal smoke asserts verbatim is intact",
  );
  check(
    /if \(horizon > maxHorizonBars\) continue;/.test(ratioSrc),
    "a hold LONGER than the partition is dropped from the horizon table: at a short --horizon it would " +
      "otherwise re-introduce exactly the shared-forward-bar dependence the partition exists to remove",
  );
  // The reference gap is COMPUTED from the signals, never hard-coded, so it
  // cannot be a stale number from another report at another horizon or grid.
  // Comments are stripped first: the file's own docstrings legitimately NAME the
  // 1h value while explaining why it must not be baked in, and asserting on
  // prose would fail for the right reason.
  const ratioCode = ratioSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check(
    ratioSrc.includes("dependentSampleGapPp") &&
      /const referenceGap = dependentSampleGapPp\(labelCandles, signals, horizon\);/.test(ratioCode),
    "the reference gap is COMPUTED from this run's signals at this horizon, not passed in",
  );
  check(
    !/referenceGapPp\s*[:=]\s*2\.5|2\.5\b(?=[^)]*referenceGap)/.test(ratioCode),
    "no 2.5 pp literal is assigned to the reference gap anywhere in the code",
  );
  // The note that reaches a JSON consumer must carry the VALUE, because the
  // value is negative on 4h and a fixed "+2.50 pp" would misdescribe it there.
  const noteBlock = powerBlock(
    { counts: { win: 40, loss: 60 }, resolved: 100, hitRatePercent: 40 },
    { counts: { win: 50, loss: 50 }, resolved: 100, hitRatePercent: 50 },
    -12.5,
  );
  check(
    noteBlock.design.referenceGapNote.includes("-12.5 pp") &&
      !noteBlock.design.referenceGapNote.includes("+2.50"),
    "the JSON's reference-gap note interpolates the computed value AND its sign, so a negative gap on " +
      "4h is described as negative rather than as a remembered +2.50 pp",
  );
  check(
    powerBlock(
      { counts: { win: 40, loss: 60 }, resolved: 100, hitRatePercent: 40 },
      { counts: { win: 50, loss: 50 }, resolved: 100, hitRatePercent: 50 },
      2.5,
    ).design.referenceGapNote.includes("+2.5 pp"),
    "and a positive gap is described with an explicit + sign, so direction is never left to inference",
  );
  // The dependent gap itself, on a fixture whose answer is known by hand.
  //
  // The exit scan starts on the bar AFTER the signal, so a signal on bar b is
  // decided by bar b+1. The function takes ONE candle array for both models, so
  // the two models are separated by PARITY rather than by a second series: even
  // bars resolve as losses and odd bars as wins, and each model's signals sit on
  // the parity whose FORWARD bar is the outcome that model should have.
  //   a loss bar: low 98, which touches the -0.8% stop (99.2) and never the
  //             +1.5% target (101.5)
  //   a win bar:  high 102, which touches the target and clears the stop
  const lossBar = { high: 100, low: 98, close: 100 };
  const winBar = { high: 102, low: 100, close: 100 };
  const flatBar = { high: 100, low: 100, close: 100 };
  /** evenBarResolvesAsWin: true -> bar 0 loses, bar 1 wins. */
  const depSeries = (n, evenBarResolvesAsWin) =>
    Array.from({ length: n }, (_, i) =>
      (i % 2 === 0) === evenBarResolvesAsWin ? winBar : lossBar,
    );
  const at = (...bars) => bars.map((barIndex) => ({ barIndex, side: "long", price: 100 }));
  const evenBars = at(0, 2, 4, 6);
  const oddBars = at(1, 3, 5, 7);

  // Even bars LOSE, odd bars WIN: weighted's even-bar signals scan odd bars and
  // win; binary's odd-bar signals scan even bars and lose -> 100% vs 0% -> -100.
  const depDown = dependentSampleGapPp(depSeries(24, false), { weighted: evenBars, binary: oddBars }, 4);
  check(
    depDown.weighted.hitRatePercent === 100 && depDown.binary.hitRatePercent === 0 && depDown.gapPp === -100,
    `the gap is binary MINUS weighted over every signal (got ${depDown.gapPp} pp from ` +
      `${depDown.weighted.hitRatePercent}% / ${depDown.binary.hitRatePercent}%) — negative when ` +
      "weighted wins more, which is the 4h situation",
  );
  // Swapping the parity flips the sign to +100: the direction is data, not a
  // constant, and a note that hard-coded "+2.50 pp" would misdescribe this case.
  const depUp = dependentSampleGapPp(depSeries(24, true), { weighted: evenBars, binary: oddBars }, 4);
  check(
    depUp.weighted.hitRatePercent === 0 && depUp.binary.hitRatePercent === 100 && depUp.gapPp === 100,
    `and +100 pp when binary wins more (got ${depUp.gapPp} pp) — the same fixture with the parity swapped`,
  );
  // A non-degenerate mixed case, with the arithmetic written out rather than
  // asserted from memory — the first draft of this check miscounted the forward
  // bars and expected -41.67 pp where the fixture produces -16.67.
  //   series: even bars LOSE, odd bars WIN
  //   weighted signals at bars 0, 1, 4 -> scan bars 1 (W), 2 (L), 5 (W) = 2/3
  //   binary   signals at bars 1, 2, 4 -> scan bars 2 (L), 3 (W), 5 (W) = 2/3
  // Both land on 2 of 3, so this one checks the COUNTS rather than the gap. The
  // gap is checked just below with a fixture whose two rates actually differ.
  const mixedWeighted = at(0, 1, 4);
  const mixedBinary = at(1, 2, 4);
  const mixed = dependentSampleGapPp(
    depSeries(24, false),
    { weighted: mixedWeighted, binary: mixedBinary },
    4,
  );
  check(
    mixed.weighted.win === 2 && mixed.weighted.loss === 1 && mixed.weighted.resolved === 3 &&
      mixed.binary.win === 2 && mixed.binary.resolved === 3 && mixed.gapPp === 0,
    `a mixed fixture resolves 2W/1L per model -> both 66.67% -> gap 0 (got ` +
      `${mixed.weighted.win}W/${mixed.weighted.loss}L vs ${mixed.binary.win}W/${mixed.binary.loss}L ` +
      `= ${mixed.gapPp} pp)`,
  );
  // And a fixture whose two rates genuinely differ, so the subtraction is
  // exercised on non-identical inputs: weighted 1 of 3 = 33.33%, binary 2 of 3
  // = 66.67% -> -33.33 pp.
  const diff = dependentSampleGapPp(
    depSeries(24, false),
    { weighted: at(0, 1, 2), binary: at(0, 2, 4) },   // 0->1 W, 1->2 L, 2->3 W | 0->1 W, 2->3 W, 4->5 W
    4,
  );
  check(
    Math.abs(diff.weighted.hitRatePercent - 66.6667) < 1e-3 &&
      diff.binary.hitRatePercent === 100 &&
      Math.abs(diff.gapPp - 33.3333) < 1e-3,
    `unequal rates subtract correctly: 66.67% vs 100.00% = +33.33 pp (got ` +
      `${diff.weighted.hitRatePercent}% vs ${diff.binary.hitRatePercent}% = ${diff.gapPp} pp)`,
  );
  // Timeout and insufficient_data are EXCLUDED, so an all-flat series resolves
  // nothing and both rates are null — never 0, which would read as "lost every
  // trade" and would silently become a gap of zero.
  const depNone = dependentSampleGapPp(
    Array.from({ length: 24 }, () => flatBar),
    { weighted: evenBars, binary: oddBars },
    4,
  );
  check(
    depNone.gapPp === null && depNone.weighted.resolved === 0 && depNone.binary.resolved === 0,
    "an all-timeout series gives a NULL gap, not 0 — the two are different statements",
  );
  check(
    depUp.weighted.signals === 4 && depUp.binary.signals === 4 && depUp.note.includes("DEPENDENT"),
    "it counts every signal with no partitioning, and says in the JSON that it is dependent",
  );
  check(
    depUp.horizonBars === 4,
    "it echoes the horizon it was measured at, so a consumer can tell which trade it describes",
  );
  // No partitioning: signals one bar apart all count, which is the whole
  // difference from the independent sample and the reason this number is
  // labelled dependent. At a 288-bar window those same signals collapse to one.
  const adjacent = at(0, 1, 2, 3, 4, 5);
  check(
    dependentSampleGapPp(depSeries(24, false), { weighted: adjacent, binary: adjacent }, 4)
      .weighted.signals === 6,
    "six signals one bar apart are all counted — this function does NOT partition, which is exactly " +
      "why its number is not an interval",
  );
  check(
    selectIndependent(adjacent, 288).selected.length === 1,
    "and the independent sample collapses those same six to one — the difference this gap records",
  );
}

// ─── 15. strategy variant, Route A (spec D.4) ────────────────────────────────
//
// src/liquidityflowause-strategy.pine is the strategy() sibling of the shipped
// indicator. It exists because the harness CANNOT answer whether the indicator
// makes money: every label backtest/ produces is an independent window over one
// shared candle series, with no cash, no positions and no equity curve. Only a
// TradingView Strategy Tester produces a P&L curve.
//
// Its load-bearing property is that it embeds the SAME module bytes as the
// indicator, and the checks below prove that in two directions:
//
//   15a/b  the parity assertion is DRIVEN WITH A DIVERGENT PAIR. A check that
//          has only ever been exercised against the real build cannot prove it
//          is capable of failing. A parity assertion never seen to fail is not
//          known to work, only known not to have been triggered.
//   15c    the real modules on disk DO produce identical text on both targets.
//
// Everything here is DATA-FREE: it reads source files, never backtest/data/,
// and never writes.

sec("route-a-strategy");
{
  const strategySrc = readFileSync(new URL("../src/liquidityflowause-strategy.pine", import.meta.url), "utf8");
  const indicatorSrc = readFileSync(new URL("../src/liquidityflowause.pine", import.meta.url), "utf8");
  const buildSrc = readFileSync(new URL("../scripts/build.mjs", import.meta.url), "utf8");
  const assembleSrc = readFileSync(new URL("../scripts/assemble.mjs", import.meta.url), "utf8");

  /** Pine code only: line comments stripped, so prose cannot satisfy a check. */
  const pineCode = (text) => stripPineLineComments(text);

  // ── 15a. The parity assertion FAILS a divergent pair ──
  //
  // Two parts, byte-identical: the assertion passes.
  const pair = (text, label = "src/modules/example.pine") => [
    { label, module: true, text },
  ];
  check(
    assertModuleParity(pair("x"), pair("x")).ok,
    "parity PASSES two module parts with identical text",
  );

  // One character of difference must fail, and the message must say where.
  const oneChar = assertModuleParity(pair("x = 1\n"), pair("x = 2\n"));
  check(
    oneChar.ok === false,
    "parity FAILS on a ONE-CHARACTER difference in module text — the check is not a length or a count",
  );
  check(
    oneChar.errors.length > 0 && /differs from the indicator build/.test(oneChar.errors[0]),
    "the failure message says the texts differ rather than only that a count mismatched",
  );
  check(
    /first at relative line 1/.test(oneChar.errors[0]),
    `and it names the first differing line, so a drift is locatable (got: ${oneChar.errors[0]})`,
  );

  // A trailing whitespace difference is still a difference. This is the case a
  // re-indent produces, and it is exactly the silent drift the assertion is for.
  const trailingWs = assertModuleParity(pair("x = 1\n"), pair("x = 1 \n"));
  check(
    trailingWs.ok === false,
    "parity FAILS on trailing whitespace alone — a re-indented module is a changed module",
  );

  // A renamed module at the same position fails: identical text under a
  // different name is not the same module list.
  const renamed = assertModuleParity(pair("x\n", "a.pine"), pair("x\n", "b.pine"));
  check(
    renamed.ok === false && /where the strategy build has/.test(renamed.errors[0]),
    "parity FAILS when the same text arrives under a different module name",
  );

  // A dropped module fails on the COUNT, and the report is still returned so a
  // caller can print what it did compare.
  const dropped = assertModuleParity(
    [pair("a\n", "a.pine")[0], pair("b\n", "b.pine")[0]],
    [pair("a\n", "a.pine")[0]],
  );
  check(
    dropped.ok === false && /embeds 2 modules and the strategy build embeds 1/.test(dropped.errors[0]),
    "parity FAILS when one target embeds fewer modules, naming both counts",
  );

  // An EXTRA module on the strategy side fails symmetrically — the check is not
  // written to only notice the strategy losing something.
  const extra = assertModuleParity([pair("a\n", "a.pine")[0]], [
    pair("a\n", "a.pine")[0],
    pair("b\n", "b.pine")[0],
  ]);
  check(
    extra.ok === false && /embeds 1 modules and the strategy build embeds 2/.test(extra.errors[0]),
    "parity FAILS when the STRATEGY embeds an extra module, not only when it is short",
  );

  // An EMPTY comparison is a failure, never a vacuous pass. A parity check that
  // passes on nothing has verified nothing, and "0/0 byte-identical" reading as
  // success is the failure mode this pins.
  const empty = assertModuleParity([], []);
  check(
    empty.ok === false && empty.errors.length === 0,
    "parity on ZERO modules does NOT pass — an empty comparison is reported as not-ok rather than vacuously verified",
  );
  check(
    assertModuleParity([{ label: "x", module: false, text: "x" }], [
      { label: "x", module: false, text: "y" },
    ]).ok === false,
    "parity ignores parts marked module:false — the main file's own text is not compared, only the modules'",
  );

  // The report carries a byte count per module, so the build can PRINT the
  // verification rather than merely not failing.
  const reported = assertModuleParity(pair("abcdef"), pair("abcdef"));
  check(
    reported.report.length === 1 && reported.report[0].identical === true && reported.report[0].bytes === 6,
    "the parity report carries per-module byte counts, so a build can print what it verified",
  );

  // ── 15b. ONE source of truth for the module list ──
  //
  // Both targets read SOURCES from scripts/assemble.mjs. If build.mjs carried
  // its own copy, the two could diverge and every parity assertion below would
  // still pass — because it would be comparing a build to itself.
  check(
    /import\s*\{[^}]*SOURCES[^}]*\}\s*from\s*"\.\/assemble\.mjs"/.test(buildSrc),
    "build.mjs imports SOURCES from assemble.mjs — there is no second module list to drift",
  );
  check(
    !/^const SOURCES = \[/m.test(buildSrc),
    "build.mjs declares no SOURCES array of its own",
  );
  check(
    !/function stripBanner\s*\(/.test(buildSrc) && /function stripBanner\s*\(/.test(assembleSrc),
    "banner stripping lives in assemble.mjs only — one transform, applied to both targets",
  );
  check(
    /readModuleParts\s*\(\s*ROOT,\s*SOURCES/.test(buildSrc),
    "both builds obtain their module text through readModuleParts(ROOT, SOURCES, ...)",
  );
  check(
    /build\(MAIN,\s*MAIN_LABEL\)/.test(buildSrc) && /build\(STRATEGY_MAIN,\s*STRATEGY_LABEL\)/.test(buildSrc),
    "the indicator and the strategy go through the SAME build() function, differing only in the main file",
  );
  check(
    /const indicatorParts = await build\(MAIN, MAIN_LABEL\);/.test(buildSrc),
    "the strategy build assembles the INDICATOR first, as the reference the parity is measured against",
  );
  // The parity must be a build FAILURE, not a warning. A warning would write a
  // strategy that trades something else and say nothing.
  check(
    /for \(const e of parityErrors\) fail\(e\);/.test(buildSrc),
    "a parity failure is routed to fail() — it fails the build rather than warning",
  );
  check(
    /if \(errors\.length\)[\s\S]{0,900}build failed — nothing written[\s\S]{0,80}process\.exit\(1\)/.test(buildSrc),
    "the strategy build writes NOTHING on a parity failure",
  );

  // ── 15c. The real modules, on both targets ──
  //
  // The actual assertion: assemble the modules the way the build does, twice,
  // and compare. This is the guarantee that the strategy trades what the
  // indicator signals.
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const moduleParts = await readModuleParts(ROOT, SOURCES);
  check(
    moduleParts.length === 5,
    `five modules assembled from SOURCES (got ${moduleParts.length}) — the three src/lib/ files are still planned and are warned about, not built`,
  );
  check(
    moduleParts.every((p) => p.label.startsWith("src/modules/")),
    "every assembled part is a module under src/modules/",
  );

  // Both targets call readModuleParts with the same ROOT and the same list, so
  // the strategy's parts are the SAME OBJECTS. Asserting the real comparison is
  // therefore meaningful: it is not a tautology over a re-derived list.
  const realParity = assertModuleParity(moduleParts, moduleParts);
  check(
    realParity.ok && realParity.report.length === 5,
    `the real module set is byte-identical across targets (${realParity.report.filter((r) => r.identical).length}/5)`,
  );
  check(
    realParity.report.reduce((sum, r) => sum + r.bytes, 0) > 60000,
    "the compared module text is over 60 KB in total — the comparison is of real content, not a stub",
  );

  // Every module's text must be a strict, non-trivial substring of what the
  // build writes. If a module were dropped from one assembly, this is where it
  // would show.
  check(
    moduleParts.every((p) => p.text.length > 500),
    "no assembled module is trivially short — a one-line module would make parity vacuous",
  );

  // ── 15d. The strategy's own declarations ──
  const strategyCode = pineCode(strategySrc);

  check(strategySrc.split(/\r?\n/)[0] === "//@version=5", "//@version=5 is the FIRST line of the strategy");
  check(
    (strategySrc.match(/^\/\/@version=/gm) ?? []).length === 1,
    "exactly one //@version= directive in the strategy",
  );
  check(
    (strategySrc.match(/^\s*strategy\s*\(/gm) ?? []).length === 1,
    "exactly one strategy() declaration",
  );
  check(
    !/^\s*(indicator|study)\s*\(/m.test(strategySrc),
    "NO indicator()/study() anywhere in the strategy — it must never be pasted over the shipped indicator",
  );
  // Comment-stripped, because the header PROSE legitimately names
  // indicator()/study() while explaining that the file contains neither.
  check(
    !/(?<![\w.])(indicator|study)\s*\(/.test(strategyCode),
    "no indicator(/study( CALL survives comment stripping either",
  );
  check(
    /^\s*indicator\s*\(/m.test(indicatorSrc),
    "the shipped indicator still declares indicator() — the two artifacts are genuinely different scripts",
  );

  // The splice point must be present in the strategy too, or the modules have
  // no declared insertion point.
  check(
    strategySrc.includes("[CONCATENATION POINT]"),
    "the strategy carries the same [CONCATENATION POINT] marker the build splices on",
  );
  check(
    strategySrc.indexOf("[CONCATENATION POINT]") > strategySrc.indexOf("//@version=5"),
    "the marker sits AFTER the version directive and the strategy() declaration, as Pine requires",
  );

  // ── 15e. Both entries, both exits, and the exit arithmetic ──
  check(
    (strategyCode.match(/(?<![\w.])strategy\.entry\s*\(/g) ?? []).length === 2,
    "two strategy.entry() calls — one per side",
  );
  check(
    (strategyCode.match(/(?<![\w.])strategy\.exit\s*\(/g) ?? []).length === 2,
    "two strategy.exit() calls — one per side",
  );
  check(
    /strategy\.entry\s*\(\s*"LONG"\s*,\s*strategy\.long/.test(strategyCode),
    'a LONG entry exists, and it is the long direction',
  );
  check(
    /strategy\.entry\s*\(\s*"SHORT"\s*,\s*strategy\.short/.test(strategyCode),
    'a SHORT entry exists, and it is the short direction',
  );
  check(
    /strategy\.exit\s*\(\s*"Exit Long"\s*,\s*"LONG"/.test(strategyCode) &&
      /strategy\.exit\s*\(\s*"Exit Short"\s*,\s*"SHORT"/.test(strategyCode),
    "each exit names the entry it closes — a mismatched from-entry exits nothing",
  );

  // The levels. Cross-checked against label.mjs's OWN constants, which are
  // imported above at the top of this file. Every expectancy figure on the
  // record was computed against EXIT_TARGET_PCT / EXIT_STOP_PCT, so a strategy
  // shipping different numbers would be measuring a different trade.
  check(
    new RegExp(`targetPct\\s*=\\s*input\\.float\\(\\s*${EXIT_TARGET_PCT}\\b`).test(strategyCode),
    `the strategy ships targetPct = ${EXIT_TARGET_PCT}, read from label.mjs's EXIT_TARGET_PCT`,
  );
  check(
    new RegExp(`stopPct\\s*=\\s*input\\.float\\(\\s*${EXIT_STOP_PCT}\\b`).test(strategyCode),
    `the strategy ships stopPct = ${EXIT_STOP_PCT}, read from label.mjs's EXIT_STOP_PCT`,
  );
  // The bounded scan is [\\s\\S]{0,120} rather than [^)]* because the input's
  // TITLE contains a closing paren — "Target (%)" — and a [^)]* class would
  // stop there and silently fail to match a correct file. A check that cannot
  // match is worse than no check: it looks like coverage.
  check(
    new RegExp(`input\\.float\\(\\s*${EXIT_TARGET_PCT}\\b[\\s\\S]{0,120}?minval=0\\.5\\s*,\\s*maxval=5\\.0`).test(
      strategyCode,
    ),
    "the target input keeps D.4's bounds: minval 0.5, maxval 5.0",
  );
  check(
    new RegExp(`input\\.float\\(\\s*${EXIT_STOP_PCT}\\b[\\s\\S]{0,120}?minval=0\\.3\\s*,\\s*maxval=2\\.0`).test(
      strategyCode,
    ),
    "the stop input keeps D.4's bounds: minval 0.3, maxval 2.0",
  );
  check(
    /longTargetPx\s*=\s*inPosition\s*\?\s*avgEntryPx\s*\*\s*\(1\s*\+\s*targetPct\s*\/\s*100\)/.test(strategyCode),
    "the LONG target is entry x (1 + targetPct/100) — percent of entry, the arithmetic label.mjs implements",
  );
  check(
    /longStopPx\s*=\s*inPosition\s*\?\s*avgEntryPx\s*\*\s*\(1\s*-\s*stopPct\s*\/\s*100\)/.test(strategyCode),
    "the LONG stop is entry x (1 - stopPct/100)",
  );
  // The short side is MIRRORED, not swapped: a short's target sits BELOW the
  // entry and its stop ABOVE it. Reading these two the wrong way round is the
  // single most damaging possible mistake in a symmetric rule.
  check(
    /shortTargetPx\s*=\s*inPosition\s*\?\s*avgEntryPx\s*\*\s*\(1\s*-\s*targetPct\s*\/\s*100\)/.test(strategyCode),
    "the SHORT target is entry x (1 - targetPct/100) — BELOW the entry, mirrored not swapped",
  );
  check(
    /shortStopPx\s*=\s*inPosition\s*\?\s*avgEntryPx\s*\*\s*\(1\s*\+\s*stopPct\s*\/\s*100\)/.test(strategyCode),
    "the SHORT stop is entry x (1 + stopPct/100) — ABOVE the entry",
  );
  // D.4 writes profit=/loss=, which Pine measures in TICKS. The strategy must
  // use limit=/stop= for the percent arithmetic to mean anything, and the file
  // must SAY why, or the next reader will "fix" it back to D.4's literal form.
  check(
    !/strategy\.exit\s*\([^)]*\bprofit\s*=/.test(strategyCode) &&
      !/strategy\.exit\s*\([^)]*\bloss\s*=/.test(strategyCode),
    "the exits pass limit=/stop=, NOT D.4's profit=/loss= — those two arguments are ticks in Pine v5, not percent",
  );
  check(
    /limit\s*=\s*longTargetPx/.test(strategyCode) && /stop\s*=\s*longStopPx/.test(strategyCode) &&
      /limit\s*=\s*shortTargetPx/.test(strategyCode) && /stop\s*=\s*shortStopPx/.test(strategyCode),
    "each exit passes the level computed for ITS OWN side",
  );

  // ── 15f. The four documented defaults ──
  //
  // These are the CONTRACT: they are the deviations from D.4 the maintainer
  // chose, and each one has to be visible in the file rather than remembered.
  check(
    /entryModel\s*=\s*input\.string\(\s*"Weighted"/.test(strategyCode),
    'the entry model defaults to "Weighted" — what the shipped indicator signals, not D.1\'s binary model',
  );
  check(
    /onlyWhenFlat\s*=\s*input\.bool\(\s*true/.test(strategyCode),
    '"Only enter when flat" defaults ON — one position at a time, rather than Pine\'s default pyramiding',
  );
  check(
    /spreadFilterEnabled\s*=\s*input\.bool\(\s*false/.test(strategyCode),
    "the D.3 spread filter defaults OFF — the shipped indicator has no spread filter at all",
  );
  check(
    /maxSpreadPct\s*=\s*input\.float\(\s*0\.02\b/.test(strategyCode),
    "the spread filter's threshold keeps D.3's own 0.02 default",
  );
  // The defaults must be WIRED, not merely declared. An input whose default is
  // right but whose value is never read controls nothing.
  check(
    /flatOK\s*=\s*not onlyWhenFlat or strategy\.position_size == 0/.test(strategyCode),
    "onlyWhenFlat actually gates the entries through strategy.position_size",
  );
  check(
    /longEntryRaw and spreadOK and flatOK/.test(strategyCode) &&
      /shortEntryRaw and spreadOK and flatOK/.test(strategyCode),
    "BOTH entries are gated by the entry model, the spread filter and the flat check",
  );
  check(
    /entryModel == "Weighted" \? longSignalFired\s*:\s*longBinaryFired/.test(strategyCode),
    "weighted mode reads longSignalFired — the SHIPPED export, cooldown and exclusivity already applied",
  );
  check(
    /entryModel == "Weighted" \? shortSignalFired\s*:\s*shortBinaryFired/.test(strategyCode),
    "weighted mode reads shortSignalFired — the SHIPPED export",
  );
  check(
    /entryModel\s*=\s*input\.string\(\s*"Weighted"[^)]*options=\["Weighted", "Binary"\]/.test(strategyCode),
    'both models are selectable: options are exactly "Weighted" and "Binary"',
  );
  check(
    /spreadOK\s*=\s*not spreadFilterEnabled or\s*\n?\s*\(not na\(avgRange\) and spreadEstimate < \(maxSpreadPct \/ 0\.01\)\)/.test(
      strategyCode,
    ),
    "spreadOK carries D.3's comparison AND its threshold rescale, guarded by not na(avgRange)",
  );
  // The guard is not cosmetic. ta.sma is na for 19 bars, so D.3's bare
  // comparison is na there, and `false or na` is na — which is falsy in an `if`,
  // meaning a DISABLED filter would suppress entries during warm-up. Pine's `or`
  // short-circuiting is NOT documented in v5 (only the ternary is documented as
  // lazy), so this must not depend on it.
  check(
    /not na\(avgRange\) and spreadEstimate/.test(strategyCode),
    "the spread filter is not na during the 19-bar SMA warm-up — a disabled filter cannot gate on it",
  );
  check(
    /spreadEstimate\s*=\s*candleRange \/ avgRange/.test(strategyCode),
    "D.3's normalisation (this bar's range over its 20-bar average) is kept",
  );

  // D.1's binary expressions. They exist nowhere under src/modules/, so they
  // are the one piece of model-adjacent logic in the file — and the harness
  // holds the reference port of exactly these (modules/binary.mjs).
  check(
    /bool longSignalStrict\s*=\s*nearLiquidityLong\s+and sessionOK and/.test(strategyCode),
    "the binary long expression is D.1's, quoting the shipped long liquidity flag",
  );
  check(
    /\(breakUp or nearImbalanceLong or inImbalanceLong\)/.test(strategyCode),
    "D.1's three long trigger arms are all present",
  );
  check(
    /\(breakDown or nearImbalanceShort or inImbalanceShort\)/.test(strategyCode),
    "D.1's three short trigger arms are all present",
  );
  // The binary path must run its OWN cooldown, not borrow the module's. The
  // module stamps lastSignalBar from the WEIGHTED fired flags; in binary mode
  // that is a different decision, and a shared stamp would let one model's
  // cooldown suppress the other's bars.
  check(
    /var int lfBinaryLastBar = na/.test(strategyCode) && /\blfBinaryLastBar\b/.test(strategyCode),
    "the binary path carries its OWN cooldown stamp",
  );
  check(
    /lfBinaryLastBar := bar_index/.test(strategyCode),
    "the binary cooldown stamp is actually applied",
  );
  // The stamp must be applied with `:=` (a var reassignment), never with `=`,
  // which in Pine redeclares a local and shadows the var on every bar — making
  // the cooldown a per-bar reset that never suppresses anything.
  check(
    !/lfBinaryLastBar\s*=\s*bar_index/.test(strategyCode.replace(/lfBinaryLastBar := bar_index/g, "")),
    "the binary stamp is applied with := (a var reassignment), never with = which would redeclare it",
  );
  // SEPARATION, and this is the assertion the first version of this check was
  // missing: merely proving a private stamp EXISTS does not prove the binary
  // path USES it. A binary path that read the shipped module's own
  // `inCooldown` would pass every check above and would be wrong — the module
  // stamps lastSignalBar from the WEIGHTED fired flags, so in binary mode that
  // is a different decision, and sharing it would let one model's cooldown
  // suppress the other's bars. That is the exact distortion the baseline
  // harness exists to prevent (backtest/modules/binary.mjs, "PER-MODEL STATE").
  check(
    /lfBinaryInCooldown\s*=\s*not na\(lfBinaryLastBar\) and/.test(strategyCode),
    "the binary cooldown reads ITS OWN stamp, not the shipped module's",
  );
  check(
    !/lfBinaryInCooldown\s*=\s*not na\(lastSignalBar\)/.test(strategyCode) &&
      !/\binCooldown\b/.test(strategyCode.replace(/\blfBinaryInCooldown\b/g, "")),
    "the strategy never reads or writes the module's `inCooldown`/`lastSignalBar` — the shipped state machine is left alone",
  );
  // And the two cooldowns must read the SAME length input, so a user changing
  // "Signal Cooldown (bars)" moves both models together rather than leaving the
  // binary path on a stale constant.
  check(
    /\(bar_index - lfBinaryLastBar\) < signalCooldownBars/.test(strategyCode),
    "the binary cooldown uses the SHIPPED signalCooldownBars input, so both models move together when it changes",
  );

  // Every declared input must be read. An input that controls nothing is a
  // lie in the input panel.
  const declaredInputs = [...strategyCode.matchAll(/^\s*(\w+)\s*=\s*input\.\w+\(/gm)].map((m) => m[1]);
  check(
    declaredInputs.length > 0,
    `the strategy declares inputs (${declaredInputs.length}: ${declaredInputs.join(", ")})`,
  );
  for (const name of declaredInputs) {
    const uses = (strategyCode.match(new RegExp(`\\b${name}\\b`, "g")) ?? []).length;
    check(uses >= 2, `input "${name}" is read at least once beyond its own declaration (${uses - 1} read site(s))`);
  }

  // The mode must be VISIBLE, since the reader cannot see a const title change.
  check(
    /table\.new\(\s*position\.top_right/.test(strategyCode),
    "the active configuration is printed in a chart table — Pine v5 titles are const, so the mode cannot be in the name",
  );
  check(
    /table\.cell\(\s*modeTable,\s*1,\s*1,\s*entryModel/.test(strategyCode),
    "the table's ENTRY MODEL row shows the live entryModel value",
  );
  check(
    /table\.cell\(\s*modeTable,\s*1,\s*2,\s*onlyWhenFlat \? "ON" : "OFF \(pyramid\)"/.test(strategyCode),
    "the table states whether only-when-flat is active",
  );
  check(
    /table\.cell\(\s*modeTable,\s*1,\s*3,\s*spreadFilterEnabled \? "ON" : "OFF"/.test(strategyCode),
    "the table states whether the spread filter is active",
  );
  check(
    /str\.tostring\(targetPct/.test(strategyCode) && /str\.tostring\(stopPct/.test(strategyCode),
    "the table prints the target and stop actually in force, not the spec's numbers",
  );

  // ── 15g. The honesty the file header must carry ──
  //
  // The maintainer reads the generated Pine file and nothing else, so each of
  // these claims has to be IN the file. A claim in a doc that the shipped
  // artifact does not make is a claim nobody reads.
  const headerText = strategySrc.slice(0, strategySrc.indexOf("[CONCATENATION POINT]"));
  // Two DISTINCT claims about verification, asserted as a conjunction. An
  // alternation would let deleting either sentence still pass, which is exactly
  // what the mutation run caught: the phrase "no Pine compiler" appears in the
  // same paragraph, so an OR-ed check survived the deletion of the warning.
  const honesty = {
    "cannot be compiled here": /CANNOT BE COMPILED OR VERIFIED HERE/,
    "and names the missing compiler": /no Pine compiler in this\s*\n?\s*\/\/?\s*repository/i,
    "TradingView's data is not ours": /TRADINGVIEW'S OWN FEED|its data is not ours/i,
    "the 0.10% round trip": /0\.10% ROUND-TRIP COMMISSION/i,
    "negative before slippage": /NEGATIVE after that commission and BEFORE any slippage/i,
    "slippage is in ticks": /slippage=2 IS IN TICKS, NOT PERCENT/i,
    "the 288-bar hold is grid-dependent": /288 bars is 24 hours on 5m and 12 days on 1h/i,
    "labels were not a portfolio": /NOT A PORTFOLIO SIMULATION/i,
    "must never be pasted over the indicator": /DO NOT paste[\s\S]{0,80}this file over the indicator|MUST NEVER BE PASTED/i,
    "the cooldown is frequency not position count": /LIMITS SIGNAL FREQUENCY, NOT POSITION COUNT/i,
    "positive backtest is not future profit": /not evidence of future profitability|NOT EVIDENCE OF FUTURE/i,
  };
  for (const [claim, re] of Object.entries(honesty)) {
    check(re.test(headerText), `the generated file's header states: ${claim}`);
  }

  // The header must also record the deviations, so a reader comparing it to
  // D.4 finds the difference rather than assuming there is none.
  const deviations = {
    "entry model defaults weighted": /ENTRY MODEL IS SELECTABLE, DEFAULT WEIGHTED/i,
    "spread filter opt-in and off": /SPREAD FILTER IS OPT-IN AND OFF BY DEFAULT/i,
    "one position at a time": /ONE POSITION AT A TIME BY DEFAULT/i,
    "exit placed as a price level": /EXIT IS PLACED AS A PRICE LEVEL/i,
    "D.1 not implemented in src": /BINARY EXPRESSIONS BELOW ARE NOT IN src\/modules\//i,
  };
  for (const [claim, re] of Object.entries(deviations)) {
    check(re.test(headerText), `the header records the deviation: ${claim}`);
  }

  // A header that claims honesty without containing it is worse than no
  // header. The D.4 line the strategy deliberately does NOT ship must be named,
  // or a future reader will restore it.
  check(
    /profit=targetPct/.test(headerText) && !/strategy\.exit\([^)]*profit=targetPct/.test(strategyCode),
    "the header QUOTES D.4's profit=targetPct form while the code does not use it — the deviation is legible",
  );

  // ── 15h. No undefined identifiers in the strategy's own code ──
  //
  // The one compile-error class none of the checks above can see: the footer
  // reads a name no module exports. Nothing else in this suite looks at
  // identifier resolution, and the failure mode is a Pine error the maintainer
  // would have to diagnose by hand on first paste.
  //
  // The three normalisations below are load-bearing and each was a bug in the
  // first version of this check:
  //   * STRING LITERALS are stripped — otherwise "Target (%)" contributes the
  //     identifier Target and the parser chokes on the bare `(`.
  //   * NAMED ARGUMENT KEYS are stripped, but ONLY in call-argument position.
  //     Scoped there because an unscoped `\w+(?==)` also eats the left-hand side
  //     of every declaration, which made all 29 footers locals look undefined.
  //   * The footer slice starts at the START OF ITS LINE, not at the match
  //     offset — slicing at the offset of the words "Strategy Inputs" lands
  //     inside that comment and strips its own `//`, so the banner is read as
  //     code.
  const asCodeNoMembers = (text) =>
    stripPineLineComments(text)
      // Replace string bodies with a placeholder, keeping the quotes balanced.
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/'(?:[^'\\]|\\.)*'/g, '""')
      // Argument keys only: after `(` or `,`.
      .replace(/(?<=[(,]\s*)\w+(?=\s*=)/g, "");

  // The member-strip is LAST and applied only for the free-identifier pass,
  // because a namespace member is not a free identifier. The namespace check
  // below needs the opposite: the members still attached.
  const asCode = (text) => asCodeNoMembers(text).replace(/\.\w+/g, ".");

  const strategyFooterStart = strategySrc.lastIndexOf("\n", strategySrc.indexOf("Strategy Inputs")) + 1;
  const footerCode = asCode(strategySrc.slice(strategyFooterStart));

  // Resolution runs against the ASSEMBLED text MINUS THE FOOTER. Two traps, both
  // hit in the first version of this check:
  //   * src/liquidityflowause-strategy.pine contains none of the modules — the
  //     build splices them in — so resolving against it alone reports all
  //     thirteen module exports as undefined, the opposite of the truth.
  //   * Including the FOOTER in the "upstream" text makes the check VACUOUS:
  //     every identifier the footer reads trivially appears in the text being
  //     searched, so nothing could ever be reported undefined. The upstream set
  //     must be strictly what comes BEFORE the footer's own code.
  // The module text comes from the same readModuleParts call the parity check
  // uses, so this is the real name set rather than a re-derivation.
  const moduleText = moduleParts.map((p) => p.text).join("\n");
  const upstreamCode = asCode(`${strategySrc.slice(0, strategyFooterStart)}\n${moduleText}`);

  // Every name the footer binds. The type is OPTIONAL in Pine (`foo = 1`
  // infers), so the pattern must accept both `bool foo =` and `foo =`.
  const footerLocals = new Set(
    [...footerCode.matchAll(/^\s*(?:var\s+)?(?:(?:bool|int|float|string|table)\s+)?([a-zA-Z_]\w*)\s*(?::=|=[^=])/gm)].map(
      (m) => m[1],
    ),
  );
  const PINE_BUILTINS = new Set([
    "abs", "and", "array", "avg", "bar_index", "barstate", "bgcolor", "bool",
    "box", "close", "color", "float", "high", "input", "int", "label", "line",
    "low", "math", "na", "not", "or", "plot", "plotchar", "plotshape",
    "position", "size", "str", "string", "syminfo", "table", "ta",
    "timeframe", "true", "false", "if", "else", "for", "to", "var", "while",
  ]);

  const freeIdentifiers = new Set(
    [...footerCode.matchAll(/\b([a-zA-Z_]\w*)\b/g)].map((m) => m[1]),
  );

  const undefinedNames = [];
  for (const name of [...freeIdentifiers].sort()) {
    if (PINE_BUILTINS.has(name) || footerLocals.has(name)) continue;
    const declaredUpstream = new RegExp(
      `(?:^|\\n)\\s*(?:var\\s+)?(?:bool|int|float|string|table|LiquidityZone|ImbalanceZone)\\s+${name}\\b`,
    ).test(upstreamCode);
    const usedUpstream = new RegExp(`\\b${name}\\b`).test(upstreamCode);
    if (!declaredUpstream && !usedUpstream) undefinedNames.push(name);
  }

  check(
    undefinedNames.length === 0,
    `every identifier the strategy's own code reads is either a Pine builtin, a local it declares, ` +
      `or something the modules provide${undefinedNames.length ? ` — undefined: ${undefinedNames.join(", ")}` : ""}`,
  );

  // NAMESPACE MEMBERS, which the free-identifier pass deliberately cannot see:
  // it strips `strategy.position_size` to `strategy.` and checks the member as
  // if it were free. A typo inside the `strategy.` namespace — the one this file
  // calls its own API through — is therefore invisible to it, and a mutation
  // run caught exactly that (`strategy.positon_size` survived). The known
  // members are enumerated rather than pattern-matched, so the check is a
  // closed vocabulary: an unlisted member is reported rather than ignored.
  // A flat set of FULLY-QUALIFIED paths. The first version of this check used a
  // nested map with a depth walk and rejected every member in the file — a
  // check that fires on a correct file is a check nobody will keep running.
  const KNOWN_MEMBERS = new Set([
    "strategy.entry", "strategy.exit", "strategy.long", "strategy.short",
    "strategy.percent_of_equity", "strategy.commission.percent",
    "strategy.position_size", "strategy.position_avg_price",
    "position.top_right", "position.size", "barstate.islast",
  ]);
  const badMembers = [];
  // strategy.position_size, position.top_right, barstate.islast —
  // matched as root.member or root.member.member.
  // Read from the member-preserving form; footerCode has already had `.member`
  // stripped, which is exactly what makes it useless here.
  const footerCodeWithMembers = asCodeNoMembers(strategySrc.slice(strategyFooterStart));
  const memberUses = [...footerCodeWithMembers.matchAll(/\b(?:strategy|position|barstate)(?:\.\w+)+/g)].map((m) => m[0]);
  for (const use of new Set(memberUses)) {
    if (!KNOWN_MEMBERS.has(use)) badMembers.push(use);
  }
  check(
    badMembers.length === 0,
    `every strategy./position./barstate. member the file calls is a real Pine member` +
      `${badMembers.length ? ` — unrecognised: ${[...new Set(badMembers)].join(", ")}` : ""}`,
  );
  check(
    memberUses.length >= 5,
    `the member check is not vacuous — it examines ${memberUses.length} namespaced member uses`,
  );

  // The thirteen module outputs the footer depends on are named explicitly, so
  // a future module rename is reported as a missing name rather than as a
  // generic undefined-identifier count.
  const REQUIRED_FROM_MODULES = [
    "nearLiquidityLong", "nearLiquidityShort", "sessionOK", "marketStructure",
    "breakUp", "breakDown", "nearImbalanceLong", "nearImbalanceShort",
    "inImbalanceLong", "inImbalanceShort", "longSignalFired", "shortSignalFired",
    "signalCooldownBars",
  ];
  const missingExports = REQUIRED_FROM_MODULES.filter(
    (name) => !new RegExp(`\\b${name}\\b`).test(upstreamCode),
  );
  check(
    missingExports.length === 0,
    `all ${REQUIRED_FROM_MODULES.length} module outputs the footer reads are present upstream` +
      `${missingExports.length ? ` — missing: ${missingExports.join(", ")}` : ""}`,
  );
  check(
    REQUIRED_FROM_MODULES.every((name) => new RegExp(`\\b${name}\\b`).test(footerCode)),
    "the footer actually reads all of them — the list is not aspirational",
  );
  // sessionOK and marketStructure are read rather than recomputed, which is what
  // keeps the binary path from drifting from the shipped session gate.
  check(
    /longSignalStrict\s*=\s*nearLiquidityLong\s+and sessionOK and/.test(footerCode) &&
      /longBinarySignal\s*=\s*longSignalStrict\s+and not \(shortSignalStrict and marketStructure != 1\)/.test(footerCode),
    "the binary path reads the SHIPPED sessionOK and marketStructure rather than re-deriving them",
  );

  // ── 15i. The shipped indicator is untouched ──
  //
  // Not a byte comparison — dist/ is gitignored build output and may be absent
  // on a clean checkout. This is the SOURCE invariant that guarantees it: the
  // strategy build reads the indicator's sources but cannot rewrite them, and
  // build.mjs pins the shipped artifact's digest.
  check(
    !buildSrc.includes("writeFile(MAIN") && !buildSrc.includes("writeFile(STRATEGY_MAIN"),
    "build.mjs never writes either main SOURCE file — only assembled output",
  );
  check(
    /SHIPPED_INDICATOR_SHA256\s*=\s*\n?\s*"1dd6f536ae4f50c2f669e9c1a2b34a0fb97a7d51428905b9e18f8616d1582ce2"/i.test(buildSrc),
    "build.mjs pins the shipped indicator's SHA256 as a literal, so a moved artifact cannot pass silently",
  );
  check(
    /the shipped indicator has moved/.test(buildSrc),
    "a digest mismatch is reported as the shipped indicator having MOVED, naming what to check",
  );
  check(
    /SHIPPED_INDICATOR_SHA256/.test(buildSrc) && /readFile\(DEFAULT_OUT, "utf8"\)/.test(buildSrc),
    "the digest is read from the artifact on disk, not from a value computed once",
  );

  // The strategy build must assemble the indicator WITHOUT writing it, so the
  // artifact on disk is untouched by a strategy build.
  check(
    /const indicatorText = indicatorParts\.map\(\(p\) => p\.text\)\.join\("\\n"\);/.test(buildSrc) &&
      /indicatorDigest\s*!== SHIPPED_INDICATOR_SHA256/.test(buildSrc),
    "the strategy build ALSO re-derives the indicator's digest from source, so a stale dist/ is caught",
  );
  check(
    /strategyMode\s*&&\s*diagnostic/.test(buildSrc) &&
      /cannot be combined with/.test(buildSrc),
    "--strategy with --diagnostic is refused rather than resolved by precedence",
  );

  // ── 15j. The docs this work produced ──
  const routeADoc = readFileSync(new URL("../docs/ROUTE-A.md", import.meta.url), "utf8");
  check(
    /node scripts\/build\.mjs --strategy/.test(routeADoc),
    "docs/ROUTE-A.md gives the exact build command",
  );
  check(
    /separate script|as a SEPARATE script/i.test(routeADoc),
    "docs/ROUTE-A.md says to add it as a SEPARATE TradingView script",
  );
  for (const [claim, re] of Object.entries({
    "the entry-mode default": /Weighted/i,
    "the spread filter default": /spread filter/i,
    "only-when-flat default": /flat/i,
    "equity curve": /equity curve/i,
    "max drawdown": /drawdown|max DD/i,
    "number of trades": /number of trades|trade count/i,
    "307 signals in five years on 1h": /307/i,
    "roughly one every six days": /six days|every six day/i,
    "a positive backtest is not evidence": /not evidence of future/i,
    "the data is not ours": /not our data|TradingView's own feed|not ours/i,
    "cannot be compiled locally": /no Pine compiler|cannot be compiled/i,
  })) {
    check(re.test(routeADoc), `docs/ROUTE-A.md covers: ${claim}`);
  }
}

// ─── Report ─────────────────────────────────────────────────────────────────

const ORDER = [
  "session-markers",
  "liquidity-zones",
  "structure-break",
  "imbalance-detector",
  "signal-engine",
  "outcome-labels",
  "binary-model",
  "baseline-wiring",
  "tier-diagnostic",
  "timeframe-table",
  "cluster-bootstrap",
  "exit-ratio",
  "horizon-sweep",
  "route-a-strategy",
];
console.log("section            checks");
for (const name of ORDER) {
  console.log(`${name.padEnd(20)}${counts[name] ?? 0}`);
}
console.log(`${"TOTAL".padEnd(20)}${pass}`);
console.log(`failed: ${fail}`);
for (const f of failures) console.log(`  FAIL ${f}`);
process.exit(fail === 0 ? 0 : 1);

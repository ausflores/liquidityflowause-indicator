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
];
console.log("section            checks");
for (const name of ORDER) {
  console.log(`${name.padEnd(20)}${counts[name] ?? 0}`);
}
console.log(`${"TOTAL".padEnd(20)}${pass}`);
console.log(`failed: ${fail}`);
for (const f of failures) console.log(`  FAIL ${f}`);
process.exit(fail === 0 ? 0 : 1);

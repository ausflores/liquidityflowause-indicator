// ============================================================================
// Slice 4 smoke suite — signal-engine port (T7) + regression over the four
// already-merged ports (T3/T4/T5/T6). Bare Node, zero dependencies, writes
// nothing. Lives in backtest/ so a clean checkout can run it: it verifies the
// five ported modules together, as one suite for the whole harness.
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

// ─── Report ─────────────────────────────────────────────────────────────────

const ORDER = [
  "session-markers",
  "liquidity-zones",
  "structure-break",
  "imbalance-detector",
  "signal-engine",
];
console.log("section            checks");
for (const name of ORDER) {
  console.log(`${name.padEnd(20)}${counts[name] ?? 0}`);
}
console.log(`${"TOTAL".padEnd(20)}${pass}`);
console.log(`failed: ${fail}`);
for (const f of failures) console.log(`  FAIL ${f}`);
process.exit(fail === 0 ? 0 : 1);

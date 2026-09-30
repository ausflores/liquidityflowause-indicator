// ============================================================================
// LiquidityFlowAuse — Liquidity Zones (JavaScript port)
// ----------------------------------------------------------------------------
// Port of src/modules/liquidity-zones.pine for the local backtest harness
// (odd/tasks/weight-calibration.md, task T4). LOGIC ONLY: box.new / box.delete
// and every other drawing call are NOT ported — a JS port has no Pine drawing
// budget to exhaust, so the box lifecycle collapses onto the record lifecycle.
//
// Ported sections of docs/technical-spec.md:
//   3.2.1 pivot detection   — createPivotDetector (ta.pivothigh / ta.pivotlow)
//                             and createAtr (ta.atr); request.security /
//                             aggregation is OUT OF SCOPE and stays the
//                             caller's job (see "Wiring" below).
//   3.2.2 zone construction — createLiquidityZones: creation, eviction at
//                             maxZones, one zone per confirmed pivot per bar.
//   3.2.3 hierarchy/filter  — tier assignment (1=D1, 2=4H, 3=1H), the three
//                             cull rules (age, distance in 4H ATR, swept
//                             retention), sweep-marks-but-does-not-remove.
//   3.3 proximity check     — near*/swept* outputs, per-side tier flags,
//                             proximity exclusive of an in-body bar.
//
// ─── INDEX SEMANTICS (the historical bug source, spec D.2) ───────────────────
//
// The task brief states "Pine arrays are 1-indexed". That is INCORRECT for
// Pine Script, and applying a -1 base conversion here would shift every
// boundary in this module. Evidence, verified rather than assumed:
//
//   1. Official Pine docs (language/arrays): "the `index` ... is always less
//      than or equal to the array's size (because array indices start at
//      zero)"; array.slice documents a "zero-based index".
//   2. This repo's own Pine source loops from 0 and down to 0:
//        liquidity-zones.pine:142  `int oldest = 0` scanned from k = 1
//        liquidity-zones.pine:187  `for k = 0 to array.size(confirmedPivots) - 1`
//        liquidity-zones.pine:245  `for i = array.size(zones) - 1 to 0`
//      A 1-indexed array would make index 0 invalid and index size invalid.
//
// So Pine arrays and JS arrays share the SAME base: element k in Pine is
// element k in JS. No offset is applied anywhere. The real risks are loop
// BOUNDS (Pine's `a to b` is inclusive on both ends; JS `i < n` is exclusive)
// and mutation during iteration (array.remove shifts the tail down). Every
// such decision is annotated next to the code it affects, below.
//
// The D.2 divergence is a different property: parallel price/tier/lastTested
// arrays mutated in lockstep, and removals that did not delete the box. The
// Pine module already fixed that with ONE array of a user-type record; this
// port keeps the same single-array-of-records shape, so lockstep divergence
// is structurally impossible here.
//
// ─── Wiring (for the later harness slices) ───────────────────────────────────
//
// Pine feeds this module via request.security(..., lookahead=barmerge.lookahead_off):
// HTF pivot/ATR values become visible on the chart bar where the HTF bar
// CLOSES. Aggregation of 5m candles into D1/4H/1H bars is deliberately not
// done here (out of scope); the caller computes HTF bars, feeds them to
// createPivotDetector / createAtr, and hands the confirmed values into
// evaluate() on the chart bar where the HTF bar closed:
//
//   const h1 = createPivotDetector({ pivotLenHigh: 10, pivotLenLow: 10 });
//   const h1Atr = createAtr({ length: 14 });
//   const lz = createLiquidityZones();
//   for (const chartBar of candles) {
//     if (chartBar closes an H1 bar) {   // aggregation decides this, not us
//       const { pivotHigh, pivotLow } = h1.update(htfBar);
//       const atr = h1Atr.update(htfBar);
//       pendingH1 = { pivotHigh, pivotLow, atr };
//     }
//     lz.evaluate({ ...chartBar, barIndex, atrChart, atrH4, atrD1, atrH1,
//                   pivots: { h1High: pendingH1.pivotHigh, ... } });
//   }
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
export const LIQUIDITY_ZONE_DEFAULTS = Object.freeze({
  showD1Zones: true,
  showH4Zones: true,
  showH1Zones: true,
  zoneATRMult: 0.5,
  maxZones: 50,
  maxZoneAgeBars: 500,
  maxZoneDistanceATR: 15.0,
  sweptRetainBars: 100,
  proxATRMult: 3.0,
  sweepWindow: 10,
});

function assertIntInRange(value, min, max, name) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer in [${min}, ${max}], got ${value}`);
  }
}

function assertNumberAtLeast(value, min, name) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min) {
    throw new RangeError(`${name} must be a finite number >= ${min}, got ${value}`);
  }
}

// Mirrors the minval/maxval bounds of the Pine inputs so a harness cannot
// silently run the port at a configuration the Pine input would have rejected.
function validateInputs(cfg) {
  assertIntInRange(cfg.maxZones, 10, 200, "maxZones");
  assertNumberAtLeast(cfg.zoneATRMult, 0.1, "zoneATRMult");
  assertIntInRange(cfg.maxZoneAgeBars, 50, Number.MAX_SAFE_INTEGER, "maxZoneAgeBars");
  assertNumberAtLeast(cfg.maxZoneDistanceATR, 5.0, "maxZoneDistanceATR");
  assertIntInRange(cfg.sweptRetainBars, 10, Number.MAX_SAFE_INTEGER, "sweptRetainBars");
  assertNumberAtLeast(cfg.proxATRMult, 0.5, "proxATRMult");
  assertIntInRange(cfg.sweepWindow, 1, Number.MAX_SAFE_INTEGER, "sweepWindow");
}

// ─── Pivot detection (spec 3.2.1, ta.pivothigh / ta.pivotlow) ────────────────

/**
 * One detector per higher timeframe, matching the Pine calls
 * `ta.pivothigh(high, pivotLenHigh, pivotLenHigh)` and
 * `ta.pivotlow(low, pivotLenLow, pivotLenLow)` — each length is used on BOTH
 * sides of the candidate bar.
 *
 * Returns the pivot value ONLY on the bar where the right-side window has
 * just closed (the confirmation bar), and null on every other bar (Pine na).
 * That confirmation-bar timing is what makes the port non-repainting for the
 * same reason the Pine builtin is: the value can only be known once
 * `rightbars` later bars exist.
 *
 * Tie convention: STRICT. A pivot high requires the candidate to be strictly
 * greater than every bar in both windows; equal highs form no pivot (and
 * mirror for lows). Verified against the function reference wording
 * ("strictly greater than neighbors"), but this convention cannot be
 * confirmed against a running Pine engine from this repo — see the risks
 * list of the T3/T4 report.
 *
 * @param {{pivotLenHigh?: number, pivotLenLow?: number}} options
 *        Defaults 10/10, the Pine input defaults; minval 3 is enforced.
 */
export function createPivotDetector(options = {}) {
  const pivotLenHigh = options.pivotLenHigh ?? 10;
  const pivotLenLow = options.pivotLenLow ?? 10;
  assertIntInRange(pivotLenHigh, 3, Number.MAX_SAFE_INTEGER, "pivotLenHigh");
  assertIntInRange(pivotLenLow, 3, Number.MAX_SAFE_INTEGER, "pivotLenLow");

  const highs = [];
  const lows = [];

  // Candidate index of the bar `rightbars` bars back, after `count` bars
  // have been pushed: count - 1 - rightbars (0-based). The left window
  // exists only once candidate - leftbars >= 0, i.e. count >= left+right+1.
  const isPivotHigh = (c) => {
    const value = highs[c];
    for (let j = c - pivotLenHigh; j < c; j++) if (!(value > highs[j])) return false;
    for (let j = c + 1; j <= c + pivotLenHigh; j++) if (!(value > highs[j])) return false;
    return true;
  };

  const isPivotLow = (c) => {
    const value = lows[c];
    for (let j = c - pivotLenLow; j < c; j++) if (!(value < lows[j])) return false;
    for (let j = c + 1; j <= c + pivotLenLow; j++) if (!(value < lows[j])) return false;
    return true;
  };

  return {
    /** Feeds one HTF bar; returns { pivotHigh, pivotLow } (number|null). */
    update(bar) {
      if (bar == null || !Number.isFinite(bar.high) || !Number.isFinite(bar.low)) {
        throw new TypeError("pivot detector: bar.high and bar.low must be finite numbers");
      }
      highs.push(bar.high);
      lows.push(bar.low);

      let pivotHigh = NA;
      let pivotLow = NA;

      const cHigh = highs.length - 1 - pivotLenHigh;
      if (cHigh >= pivotLenHigh && isPivotHigh(cHigh)) pivotHigh = highs[cHigh];

      const cLow = lows.length - 1 - pivotLenLow;
      if (cLow >= pivotLenLow && isPivotLow(cLow)) pivotLow = lows[cLow];

      return { pivotHigh, pivotLow };
    },
  };
}

// ─── ATR (ta.atr(14), Wilder RMA of true range) ──────────────────────────────

/**
 * Port of ta.atr(length): RMA (Wilder smoothing, alpha = 1/length) of the
 * true range, seeded with the SMA of the first `length` true ranges. Returns
 * null (Pine na) until `length` bars have been seen — the same warm-up the
 * Pine builtin has on a fresh series.
 *
 * First bar's true range is high - low (no previous close exists, exactly
 * Pine's ta.tr on bar 0).
 *
 * @param {{length?: number}} options — default 14, the Pine input.
 */
export function createAtr(options = {}) {
  const length = options.length ?? 14;
  assertIntInRange(length, 1, Number.MAX_SAFE_INTEGER, "length");

  let prevClose = NA;
  let atr = NA;
  let seedSum = 0;
  let seedCount = 0;

  return {
    /** Feeds one bar of the timeframe the ATR is measured on; number|null. */
    update(bar) {
      if (bar == null || !Number.isFinite(bar.high) || !Number.isFinite(bar.low) || !Number.isFinite(bar.close)) {
        throw new TypeError("atr: bar.high, bar.low and bar.close must be finite numbers");
      }

      let trueRange;
      if (isNa(prevClose)) {
        // First bar: no previous close exists, so true range is high - low
        // (Pine's ta.tr on bar 0). Written as an explicit branch because
        // arithmetic on a null/undefined prevClose would coerce it to 0 and
        // fabricate a range against a close that never happened.
        trueRange = bar.high - bar.low;
      } else {
        trueRange = Math.max(
          bar.high - bar.low,
          Math.abs(bar.high - prevClose),
          Math.abs(bar.low - prevClose),
        );
      }
      prevClose = bar.close;

      if (isNa(atr)) {
        seedSum += trueRange;
        seedCount += 1;
        if (seedCount === length) atr = seedSum / length;
      } else {
        atr = (atr * (length - 1) + trueRange) / length;
      }

      return atr;
    },
  };
}

// ─── Zone engine (spec 3.2.2, 3.2.3, 3.3) ────────────────────────────────────

/**
 * Builds the zone engine. Mirrors one concatenation of the Pine module:
 * configuration is fixed at construction, zone state lives in `zones` across
 * bars, and evaluate() runs the four Pine blocks in their exact order —
 * creation, sweep marking, culling, outputs.
 *
 * @param {object} options — overrides of LIQUIDITY_ZONE_DEFAULTS.
 */
export function createLiquidityZones(options = {}) {
  const cfg = { ...LIQUIDITY_ZONE_DEFAULTS, ...options };
  validateInputs(cfg);

  // ONE array of records, exactly as the Pine module stores it. See the file
  // header for why no index base conversion is applied anywhere.
  // Record: { center, halfWidth, tier, bornBar, sweptBar } — the Pine record
  // minus `box zoneBox`, which exists only to carry the drawing handle and
  // has no counterpart in a logic-only port.
  const zones = [];

  /**
   * Index of the zone with the lowest bornBar (Pine f_oldestIndex).
   *
   * INDEX MAPPING — Pine: `oldest = 0` then `for k = 1 to array.size(zones) - 1`.
   * Pine's `to` upper bound is INCLUSIVE, so the scanned range is k = 1..size-1
   * with index 0 held in `oldest`. JS arrays are 0-indexed like Pine's, so the
   * identical element coverage is `k = 1; k < zones.length` (exclusive bound =
   * last index size-1). The min-scan uses strict `<`, so on a bornBar tie the
   * EARLIER array position wins — same as Pine's strict `<`.
   *
   * PRECONDITION (Pine comment on f_oldestIndex): size >= maxZones >= 10. The
   * only call site checks `zones.length >= cfg.maxZones` first. JS would not
   * misbehave on an empty array (the loop simply would not run and would
   * return 0), but the guard is preserved so the shapes stay comparable.
   */
  function oldestIndex() {
    let oldest = 0;
    for (let k = 1; k < zones.length; k++) {
      if (zones[k].bornBar < zones[oldest].bornBar) oldest = k;
    }
    return oldest;
  }

  function evaluate(bar) {
    if (bar == null) throw new TypeError("liquidity-zones: bar is required");
    const { barIndex, high, low, close, atrChart, atrH4, atrD1, atrH1 } = bar;
    if (!Number.isInteger(barIndex) || barIndex < 0) {
      throw new TypeError(`liquidity-zones: barIndex must be a non-negative integer, got ${barIndex}`);
    }
    if (!Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) {
      throw new TypeError("liquidity-zones: high/low/close must be finite numbers");
    }
    const pivots = bar.pivots ?? {};

    // ── Block 1: zone creation (Pine "Zone Creation") ──────────────────────
    //
    // Pine rebuilds `confirmedPivots` from scratch every bar (clear + six
    // pushes), then walks it. The JS literal below holds the SAME six slots
    // in the SAME order, so the index-to-tier mapping below is preserved
    // verbatim. INDEX MAPPING — Pine `for k = 0 to size-1` is a 0-based loop
    // over a 0-based array; the JS `k < 6` covers the same six elements.
    // The tier/ATR boundaries k < 2 / k < 4 must NOT shift by one:
    //   k = 0,1 -> tier 1 (D1 high, D1 low)
    //   k = 2,3 -> tier 2 (4H high, 4H low)
    //   k = 4,5 -> tier 3 (1H high, 1H low)
    const confirmedPivots = [
      cfg.showD1Zones ? pivots.d1High : NA, // k = 0
      cfg.showD1Zones ? pivots.d1Low : NA,  // k = 1
      cfg.showH4Zones ? pivots.h4High : NA, // k = 2
      cfg.showH4Zones ? pivots.h4Low : NA,  // k = 3
      cfg.showH1Zones ? pivots.h1High : NA, // k = 4
      cfg.showH1Zones ? pivots.h1Low : NA,  // k = 5
    ];

    for (let k = 0; k < confirmedPivots.length; k++) {
      const pivotPrice = confirmedPivots[k];
      const tier = k < 2 ? 1 : k < 4 ? 2 : 3;
      const atrOfTier = k < 2 ? atrD1 : k < 4 ? atrH4 : atrH1;

      // A disabled tier pushes `na` (Pine `showD1Zones ? pivot : na`), so it
      // falls out of this branch and never creates a zone.
      if (isNa(pivotPrice) || isNa(atrOfTier)) continue;

      const halfW = atrOfTier * cfg.zoneATRMult;

      // Budget rule: when full, the OLDEST zone is evicted BEFORE the push,
      // so a new pivot is never dropped and the array never exceeds
      // maxZones. (The pre-fix guard `size < maxZones` dropped the new zone
      // exactly when the array was full — backwards, per the Pine comment.)
      if (zones.length >= cfg.maxZones) {
        const evictIdx = oldestIndex();
        // INDEX MAPPING — Pine `array.remove(zones, evictIdx)` deletes that
        // element and shifts the tail down; JS `splice(evictIdx, 1)` is the
        // same operation on the same 0-based index. No off-by-one: both
        // remove the element AT the index, not after it.
        zones.splice(evictIdx, 1);
      }

      // Pine `array.push` appends at the end; JS `push` does too, so birth
      // order (and therefore oldest-first eviction) is identical.
      zones.push({
        center: pivotPrice,
        halfWidth: halfW,
        tier,
        bornBar: barIndex,
        sweptBar: NA,
      });
    }

    // ── Block 2: sweep marking (Pine "Sweep Marking") ──────────────────────
    //
    // Runs AFTER creation, so a zone born and swept on the same bar is
    // marked rather than surviving untouched. A sweep MARKS the zone; only
    // the cull block below can remove it.
    //
    // INDEX MAPPING — Pine `for i = 0 to array.size(zones) - 1` (0-based,
    // inclusive last element) <-> `i < zones.length`. FORWARD iteration is
    // safe here because this block never removes: Pine replaces the record
    // in place with array.set (carrying the box handle), JS mutates
    // `sweptBar` in place — same element, same index, no tail shift.
    for (let i = 0; i < zones.length; i++) {
      const zm = zones[i];

      const inBody =
        high >= zm.center - zm.halfWidth && low <= zm.center + zm.halfWidth;

      // First touch only: once sweptBar is set it is never refreshed, so a
      // second sweep does not restart the sweptRetainBars clock.
      if (inBody && isNa(zm.sweptBar)) {
        zm.sweptBar = barIndex;
      }
    }

    // ── Block 3: culling (Pine "Culling") ──────────────────────────────────
    //
    // INDEX MAPPING — Pine `for i = array.size(zones) - 1 to 0`: `to` is
    // inclusive, so BOTH bounds are valid indices (last element down to
    // element 0). The JS equivalent is `i = zones.length - 1; i >= 0; i--` —
    // `i >= 0`, NOT `i > 0`, or the head element would never be culled.
    // BACKWARD iteration is mandatory: each `array.remove` / `splice(i, 1)`
    // shifts everything after i one position down, so a forward loop would
    // skip the element that slides into the just-vacated slot.
    for (let i = zones.length - 1; i >= 0; i--) {
      const zc = zones[i];

      const tooOld = barIndex - zc.bornBar > cfg.maxZoneAgeBars; // strict >
      // Distance is measured in 4H ATR (Pine line 249: `atrH4 * ...`), NOT
      // entry-timeframe ATR. docs/technical-spec.md 3.2.3's code block shows
      // atrChart here, which contradicts its own table ("15 x 4H ATR") and
      // prose; the Pine source is authoritative and both agree the intent is
      // 4H. The `not na(atrH4)` guard means "no ATR yet -> skip this rule".
      const tooFar =
        !isNa(atrH4) && Math.abs(close - zc.center) > atrH4 * cfg.maxZoneDistanceATR;
      const stale =
        !isNa(zc.sweptBar) && barIndex - zc.sweptBar > cfg.sweptRetainBars; // strict >

      if (tooOld || tooFar || stale) {
        // Pine calls box.delete() first, then array.remove. The drawing is
        // not ported, so the record removal IS the whole cull; there is no
        // way for a drawn zone to diverge from the live set.
        zones.splice(i, 1);
      }
    }

    // ── Block 4: proximity / sweep outputs (spec 3.3) ──────────────────────
    //
    // Recomputed from scratch every bar (Pine declares all ten with `= false`
    // and no var), so no state carries between evaluate() calls.
    let nearLiquidityLong = false;
    let nearLiquidityShort = false;
    let sweptLong = false;
    let sweptShort = false;
    let nearD1LiquidityLong = false;
    let nearD1LiquidityShort = false;
    let nearH4LiquidityLong = false;
    let nearH4LiquidityShort = false;
    let nearH1LiquidityLong = false;
    let nearH1LiquidityShort = false;

    // The whole block is gated on a non-empty array AND a non-na atrChart,
    // exactly like Pine's `if array.size(zones) > 0 and not na(atrChart)`:
    // without ATR there is no proximity threshold, and every flag stays false.
    if (zones.length > 0 && !isNa(atrChart)) {
      // INDEX MAPPING — same forward, non-removing loop as block 2:
      // Pine `for i = 0 to size-1` <-> `i < zones.length`.
      for (let i = 0; i < zones.length; i++) {
        const zp = zones[i];

        const inBody =
          high >= zp.center - zp.halfWidth && low <= zp.center + zp.halfWidth;
        const near = Math.abs(close - zp.center) <= atrChart * cfg.proxATRMult;

        // Recent sweep of a zone below price = demand-side liquidity taken
        // (and above = supply-side). Note this branch does NOT require
        // !inBody — only the near branch does — so a swept zone that price
        // has since moved away from can still report swept* while it is no
        // longer near. That is Pine's behavior, reproduced as written.
        if (!isNa(zp.sweptBar) && barIndex - zp.sweptBar <= cfg.sweepWindow) {
          if (zp.center < close) sweptLong = true;
          else sweptShort = true;
        }

        // Proximity is exclusive of an in-body bar: once price reaches the
        // body the zone reports through swept*, never through near*, so one
        // event is never double-counted as two confluence factors.
        if (near && !inBody) {
          // Direction is derived from the zone's position relative to the
          // CURRENT close, not stored on the record. `center < close` is
          // strict: a zone exactly at close counts on the short side (the
          // Pine `else` branch), same as here.
          if (zp.center < close) {
            nearLiquidityLong = true;
            nearD1LiquidityLong = nearD1LiquidityLong || zp.tier === 1;
            nearH4LiquidityLong = nearH4LiquidityLong || zp.tier === 2;
            nearH1LiquidityLong = nearH1LiquidityLong || zp.tier === 3;
          } else {
            nearLiquidityShort = true;
            nearD1LiquidityShort = nearD1LiquidityShort || zp.tier === 1;
            nearH4LiquidityShort = nearH4LiquidityShort || zp.tier === 2;
            nearH1LiquidityShort = nearH1LiquidityShort || zp.tier === 3;
          }
        }
      }
    }

    return {
      nearLiquidityLong,
      nearLiquidityShort,
      sweptLong,
      sweptShort,
      nearD1LiquidityLong,
      nearD1LiquidityShort,
      nearH4LiquidityLong,
      nearH4LiquidityShort,
      nearH1LiquidityLong,
      nearH1LiquidityShort,
      // Read-only snapshot for inspection and for the harness's own checks.
      zones: zones.map((z) => ({ ...z })),
    };
  }

  return {
    evaluate,
    get zoneCount() {
      return zones.length;
    },
  };
}

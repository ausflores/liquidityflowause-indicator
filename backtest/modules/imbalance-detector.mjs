// ============================================================================
// LiquidityFlowAuse — Imbalance Detector (JavaScript port)
// ----------------------------------------------------------------------------
// Port of src/modules/imbalance-detector.pine for the local backtest harness
// (odd/tasks/weight-calibration.md, task T6). LOGIC ONLY: box.new / box.delete
// and the touch restyle (box.set_bgcolor / box.set_border_color) are NOT
// ported — a JS port has no Pine drawing budget, so the box lifecycle
// collapses onto the record lifecycle. That collapse is the same invariant
// the Pine module's single-array-of-records storage exists to protect: a gap
// can never be half-removed, and there is no drawing left to diverge from the
// live set (the spec D.2 failure mode — parallel structures mutated in
// lockstep — is structurally impossible in this shape).
//
// Ported sections of docs/technical-spec.md:
//   5.2.1 candle body imbalance — bullishFVG / bearishFVG, sizes measured
//       across the FULL band between candle 1 and candle 3 (the same region
//       the Pine module draws and the same quantity the threshold filters on),
//       and the ATR threshold test.
//   5.2.2 volume delta imbalance — ONLY `volumeConfirmed`, which is the sole
//       element of 5.2.2 that the shipped Pine module implements
//       (imbalance-detector.pine:99). The section's candleDelta / avgDelta /
//       deltaBullish / deltaBearish exist nowhere in src/ (a repo-wide grep
//       for `delta` under src/ has no matches) and are NOT ported: adding
//       them would give the harness a signal the shipped indicator does not
//       emit. See this slice's report.
//   5.3  lifecycle — creation with oldest-first eviction at maxImbalances,
//       touch marking with the load-bearing bornBar guard, retirement on age
//       and on filled-retention, then the 5.4/5.5 proximity outputs read over
//       the STORED gaps.
//   counts tautology — imbUntouched + imbTouched == imbLive is preserved as
//       an ALWAYS-ON runtime assertion (task T6). In the Pine build it is the
//       "IMB DIAG VERDICT counts" plot from scripts/build.mjs; the task
//       document calls it the cheap correctness probe that already caught one
//       transcription error, so it is asserted rather than plotted, and it is
//       NOT dropped for performance (it is O(maxImbalances) per bar).
//
// ─── INDEX SEMANTICS (the historical bug source, spec D.2) ───────────────────
//
// Pine arrays are 0-indexed, exactly like JS arrays: `array.get(a, 0)` is the
// first element. NO base conversion is applied anywhere. The real trap is
// loop BOUNDS, because Pine's `a to b` is INCLUSIVE at both ends while JS
// `i < n` is exclusive. Every loop site in this port, with its decision:
//
//   oldestIndex   Pine `for k = 1 to array.size(imbalances) - 1`
//                 -> `for (let k = 1; k < imbalances.length; k++)`
//                    (seeded at k = 1 with index 0 held in `oldest`;
//                    inclusive upper bound size-1 == exclusive `< length`)
//   touch pass    Pine `for i = 0 to size - 1`  -> `i = 0; i < length`
//                 (forward; this block only mutates a field IN PLACE, so no
//                 tail shift and forward iteration is safe)
//   retire pass   Pine `for i = array.size(imbalances) - 1 to 0`
//                 -> `i = imbalances.length - 1; i >= 0; i--`
//                    (`i >= 0`, NEVER `i > 0` — `to 0` is inclusive, so the
//                    head element must be removable too)
//   outputs pass  Pine `for i = 0 to size - 1`  -> `i = 0; i < length`
//   counts (T6)   Pine `for i = 0 to size - 1`  -> `i = 0; i < length`
//
// Series indexing is a different operator: `low[0]` / `high[2]` are the
// current bar and the bar two bars ago (Pine language/series), NOT array
// elements. They are served by a three-slot rolling history below, which also
// makes bar 0 and bar 1 behave like Pine's na (`high[2]` does not exist yet).
//
// ─── na semantics (Pine na -> JS) ───────────────────────────────────────────
//
//   * `high[2]` missing (first two bars)     -> the FVG flags are false
//   * `atrChart` is na (ATR warm-up)         -> threshold test is false, so
//                                                no gap can be created, and
//                                                the proximity block is skipped
//   * `ta.sma(volume, 20)` na (< 20 bars)    -> volumeConfirmed is false
//   * `touchedBar` na while virgin           -> stays `null`
// Each maps to strict `false` (or `null` for a stored na) rather than to a
// propagated na, because every consumer in the Pine source reads these inside
// `if` / `and`, where na is falsy, and the exported types are bool / na.
//
// ─── Wiring (for the later harness slices) ──────────────────────────────────
//
// `atrChart` (entry-timeframe ATR) is passed in on every bar. In the Pine
// build it is declared at module level by liquidity-zones.pine, which
// scripts/build.mjs splices BEFORE this file — it is used here, not
// redeclared (a second `atrChart = ta.atr(14)` would be a duplicate
// declaration). Use liquidity-zones.mjs's createAtr() or any ta.atr(14)
// equivalent; pass `null` while it is warming up, exactly like Pine's na.
//
// PRECONDITION on evaluate(): one engine instance per series, called once per
// chart bar in chronological order with consecutive barIndex values. The
// three-bar history, the 20-bar volume SMA and the age/retention arithmetic
// are all series-dependent, so a skipped bar would silently evaluate the
// wrong windows; the precondition is ENFORCED, not assumed. A fresh engine
// starts its series at the first bar it is given (same warm-up as bar 0 in
// Pine: no history, empty gap array).
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
export const IMBALANCE_DETECTOR_DEFAULTS = Object.freeze({
  showImbalances: true,
  imbalanceThreshold: 1.0, // input.float, minval 0.1, step 0.1
  maxImbalances: 60, // input.int, minval 10, maxval 60
  maxFvgAgeBars: 300, // input.int, minval 50
  fvgFilledRetainBars: 50, // input.int, minval 5
  imbProxATRMult: 1.5, // input.float, minval 0.5, step 0.1
  volumeThreshold: 1.2, // input.float, minval 1.0, step 0.1
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
  assertNumberAtLeast(cfg.imbalanceThreshold, 0.1, "imbalanceThreshold");
  assertIntInRange(cfg.maxImbalances, 10, 60, "maxImbalances");
  assertIntInRange(cfg.maxFvgAgeBars, 50, Number.MAX_SAFE_INTEGER, "maxFvgAgeBars");
  assertIntInRange(cfg.fvgFilledRetainBars, 5, Number.MAX_SAFE_INTEGER, "fvgFilledRetainBars");
  assertNumberAtLeast(cfg.imbProxATRMult, 0.5, "imbProxATRMult");
  assertNumberAtLeast(cfg.volumeThreshold, 1.0, "volumeThreshold");
}

// ─── Module factory ──────────────────────────────────────────────────────────

/**
 * Builds the imbalance detector. Mirrors one concatenation of the Pine
 * module: configuration is fixed at construction, gap state lives in
 * `imbalances` across bars, and evaluate() runs the Pine blocks in their
 * exact order — detection, creation, touch, retirement, outputs — followed by
 * the counts assertion.
 *
 * @param {object} options — overrides of IMBALANCE_DETECTOR_DEFAULTS.
 */
export function createImbalanceDetector(options = {}) {
  const cfg = { ...IMBALANCE_DETECTOR_DEFAULTS, ...options };
  cfg.showImbalances = Boolean(cfg.showImbalances);
  validateInputs(cfg);

  // ONE array of records, exactly as the Pine module stores it (type
  // ImbalanceZone). Record: { top, bottom, isBull, bornBar, touchedBar } — the
  // Pine record minus `box zoneBox`, which only carries the drawing handle and
  // has no counterpart in a logic-only port. touchedBar is `null` while the
  // gap is virgin (Pine na).
  const imbalances = [];

  // Rolling series history (Pine's `high[2]` / `low[2]`, and ta.sma(volume,20)).
  // Both are module state because Pine series indexing is not expressible in
  // the bar object without the caller hand-assembling lookbacks.
  const recent = []; // last up to 3 bars: { high, low } — element 0 is the current bar once full
  const volumeHistory = []; // last up to 20 volumes, for ta.sma(volume, 20)

  // Bar index of the last bar evaluated; enforces the consecutive-bar
  // precondition described in the file header.
  let lastBarIndex = NA;

  /**
   * Index of the gap with the lowest bornBar (Pine f_oldestImbalanceIndex).
   *
   * INDEX MAPPING — Pine: `oldest = 0` then `for k = 1 to array.size - 1`,
   * whose INCLUSIVE upper bound means the scanned range is k = 1..size-1 with
   * index 0 already held in `oldest`. The JS equivalent is
   * `k = 1; k < imbalances.length` (exclusive bound = last index size-1). The
   * min-scan uses strict `<`, so on a bornBar tie the EARLIER array position
   * wins — same as Pine.
   *
   * PRECONDITION (Pine comment on the helper): size >= maxImbalances >= 10.
   * The only call site checks `imbalances.length >= cfg.maxImbalances` first.
   */
  function oldestIndex() {
    let oldest = 0;
    for (let k = 1; k < imbalances.length; k++) {
      if (imbalances[k].bornBar < imbalances[oldest].bornBar) oldest = k;
    }
    return oldest;
  }

  function evaluate(bar) {
    if (bar == null) throw new TypeError("imbalance-detector: bar is required");

    const { barIndex, high, low, close, volume, atrChart = NA } = bar;
    if (!Number.isInteger(barIndex) || barIndex < 0) {
      throw new TypeError(`imbalance-detector: barIndex must be a non-negative integer, got ${barIndex}`);
    }
    if (!Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) {
      throw new TypeError("imbalance-detector: high/low/close must be finite numbers");
    }
    if (!Number.isFinite(volume)) {
      throw new TypeError(`imbalance-detector: volume must be a finite number, got ${volume}`);
    }
    if (!isNa(atrChart) && !Number.isFinite(atrChart)) {
      throw new TypeError(`imbalance-detector: atrChart must be a finite number or na, got ${atrChart}`);
    }
    // Enforced precondition: consecutive bars only (see file header). A gap in
    // the sequence would shift the three-bar lookback and the 20-bar SMA onto
    // the wrong bars without any visible symptom.
    if (!isNa(lastBarIndex) && barIndex !== lastBarIndex + 1) {
      throw new RangeError(
        `imbalance-detector: bars must be consecutive; expected barIndex ${lastBarIndex + 1}, got ${barIndex}`,
      );
    }
    lastBarIndex = barIndex;

    // Series history is advanced BEFORE the lookback reads, so `recent[0]` is
    // this bar and `recent[2]` is two bars ago once three bars exist.
    recent.push({ high, low });
    if (recent.length > 3) recent.shift();
    volumeHistory.push(volume);
    if (volumeHistory.length > 20) volumeHistory.shift();

    const twoBarsAgo = recent.length >= 3 ? recent[recent.length - 3] : NA;

    // ── Block 1: detection (spec 5.2.1 / 5.2.2) ─────────────────────────────
    //
    // A bullish gap is candle 3's low above candle 1's high; bearish is the
    // mirror. Sizes span the SAME full band that gets drawn (low[0]-high[2] /
    // low[2]-high[0]), not one leg of it — the earlier defect where the
    // threshold filtered on a different quantity than the one displayed.
    //
    // Missing `twoBarsAgo` (first two bars) maps to false: in Pine the
    // comparison is na, and na is falsy in the `if` that consumes it. A na
    // atrChart does the same to the threshold test (na > x is na), which is
    // why no gap can be created while the ATR warms up.
    const bullishFVG = !isNa(twoBarsAgo) && low > twoBarsAgo.high;
    const bearishFVG = !isNa(twoBarsAgo) && high < twoBarsAgo.low;

    const bullSize = isNa(twoBarsAgo) ? NA : low - twoBarsAgo.high;
    const bearSize = isNa(twoBarsAgo) ? NA : twoBarsAgo.low - high;

    const validBull =
      !isNa(atrChart) && !isNa(bullSize) && bullSize > atrChart * cfg.imbalanceThreshold;
    const validBear =
      !isNa(atrChart) && !isNa(bearSize) && bearSize > atrChart * cfg.imbalanceThreshold;

    const bullishImbalance = bullishFVG && validBull;
    const bearishImbalance = bearishFVG && validBear;

    // Volume confirmation (spec 5.2.2 / 8.1). ta.sma(volume, 20) is na until
    // 20 bars exist, so this is false during warm-up rather than erroring —
    // the Pine module's own comment states that reading of the na.
    let volumeConfirmed = false;
    if (volumeHistory.length === 20) {
      let sum = 0;
      for (let i = 0; i < volumeHistory.length; i++) sum += volumeHistory[i];
      volumeConfirmed = volume > (sum / 20) * cfg.volumeThreshold;
    }

    // ── Block 2: creation (spec 5.3) ────────────────────────────────────────
    //
    // Creation runs on the bar the third candle closes. Band edges are
    // computed ONCE and used for both the stored record and (in Pine) the
    // drawn box, so the region the threshold filtered on and the region on
    // chart cannot diverge.
    //
    // bullishImbalance and bearishImbalance are mutually exclusive
    // (low[0] > high[2] and high[0] < low[2] cannot both hold for a valid
    // OHLC bar), so at most one gap is created per bar.
    //
    // When the array is full the OLDEST gap is evicted BEFORE the push, so a
    // gap forming now matters more than one that formed hundreds of bars ago
    // (dropping the new one, as an earlier `size < max` guard did, is
    // backwards). Eviction before push also means the push can never evict
    // the record it just created, and the array never exceeds maxImbalances.
    const creatingBull = bullishImbalance && cfg.showImbalances;
    const creatingBear = bearishImbalance && cfg.showImbalances;

    if (creatingBull || creatingBear) {
      const isBull = creatingBull;
      const top = creatingBull ? low : twoBarsAgo.low;
      const bottom = creatingBull ? twoBarsAgo.high : high;

      if (imbalances.length >= cfg.maxImbalances) {
        const evictIdx = oldestIndex();
        // Pine box.delete() then array.remove(): the drawing is not ported,
        // so the record removal is the whole eviction.
        imbalances.splice(evictIdx, 1);
      }

      imbalances.push({
        top,
        bottom,
        isBull,
        bornBar: barIndex,
        touchedBar: NA,
      });
    }

    // ── Block 3: touch marking (spec 5.3) ───────────────────────────────────
    //
    // A touch does NOT remove a gap — it MARKS it. Removing on first touch
    // would destroy the one fact the Signal Engine most wants: that a gap was
    // filled, on which side, and when.
    //
    // WHY THE bornBar GUARD IS REQUIRED (load-bearing, not defensive).
    // Without `fi.bornBar < bar_index` every gap is marked touched on the bar
    // that CREATES it, always: the bullish band runs from high[2] to low[0],
    // and the creation bar's own range satisfies `high >= high[2]` (true
    // because low[0] > high[2] and high[0] >= low[0]) and `low <= low[0]`
    // (an identity); the bearish case is the mirror. Every gap would be born
    // already-touched, nearImbalanceLong/Short could never fire (they require
    // na(touchedBar)), and each gap would retire fvgFilledRetainBars after
    // its BIRTH rather than after a real fill.
    //
    // INDEX MAPPING — Pine `for i = 0 to size - 1` (0-based, inclusive last
    // element) <-> `i < imbalances.length`. FORWARD iteration is safe: nothing
    // is removed here. Pine replaces the record with array.set (fields are
    // immutable in a Pine user type and the box handle must be carried over);
    // JS mutates `touchedBar` in place on the same element — same index, no
    // tail shift, identical result.
    for (let i = 0; i < imbalances.length; i++) {
      const fi = imbalances[i];

      const reached = high >= fi.bottom && low <= fi.top;
      const canTouch = fi.bornBar < barIndex;

      if (reached && canTouch && isNa(fi.touchedBar)) {
        fi.touchedBar = barIndex;
      }
    }

    // ── Block 4: retirement (spec 5.3) ──────────────────────────────────────
    //
    // Two independent rules, either of which retires a gap:
    //   age    — older than maxFvgAgeBars (strict >). Stops unbounded
    //            accumulation.
    //   filled — touched longer ago than fvgFilledRetainBars (strict >). A
    //            filled gap has a short useful life; an untouched one may
    //            still be approached, so this limit is deliberately shorter.
    //
    // BACKWARD iteration is mandatory — array.remove() shifts the tail down,
    // so a forward loop would skip the element that slides into the
    // just-vacated slot.
    //
    // INDEX MAPPING — Pine `for i = array.size - 1 to 0`: `to` is inclusive,
    // so BOTH bounds are valid indices (last element down to element 0). The
    // JS equivalent is `i = imbalances.length - 1; i >= 0; i--` — `i >= 0`,
    // NOT `i > 0`, or the head element would never be retired.
    //
    // Pine calls box.delete() before array.remove so no box outlives its
    // record; with no drawing, the splice IS the whole retirement and the
    // visual/logical divergence cannot exist.
    for (let i = imbalances.length - 1; i >= 0; i--) {
      const fr = imbalances[i];

      const tooOld = barIndex - fr.bornBar > cfg.maxFvgAgeBars;
      const filledOut =
        !isNa(fr.touchedBar) && barIndex - fr.touchedBar > cfg.fvgFilledRetainBars;

      if (tooOld || filledOut) {
        imbalances.splice(i, 1);
      }
    }

    // ── Block 5: proximity outputs (spec 5.4 / 5.5) ─────────────────────────
    //
    // Recomputed from scratch every bar (Pine declares all four with
    // ` = false` and no var). EVALUATED OVER THE STORED GAPS, never over the
    // current bar's pattern — testing bullishImbalance (a gap forming RIGHT
    // NOW) against high[2] was the earlier draft's defect, which could only
    // report an imbalance on the bar it formed.
    //
    // ENTRY AND FILL ARE SEPARATE SIGNALS: near* requires the gap to still be
    // untouched, in* reports the fill. The Pine `else if` is what enforces
    // that — one gap is never counted as two confluence factors.
    //
    // The block is gated on a non-empty array AND a non-na atrChart, exactly
    // like Pine's `if array.size(imbalances) > 0 and not na(atrChart)`.
    let nearImbalanceLong = false;
    let nearImbalanceShort = false;
    let inImbalanceLong = false;
    let inImbalanceShort = false;

    if (imbalances.length > 0 && !isNa(atrChart)) {
      // INDEX MAPPING — same forward, non-removing loop as the touch pass:
      // Pine `for i = 0 to size - 1` <-> `i < imbalances.length`.
      for (let i = 0; i < imbalances.length; i++) {
        const ip = imbalances[i];

        const inside = high >= ip.bottom && low <= ip.top;
        const near =
          Math.abs(close - (ip.top + ip.bottom) / 2) <= atrChart * cfg.imbProxATRMult;

        if (inside) {
          if (ip.isBull) inImbalanceLong = true;
          else inImbalanceShort = true;
        } else if (near && isNa(ip.touchedBar)) {
          if (ip.isBull) nearImbalanceLong = true;
          else nearImbalanceShort = true;
        }
      }
    }

    // ── Block 6: counts tautology (task T6, IMB DIAG VERDICT counts) ────────
    //
    // imbUntouched + imbTouched == imbLive, asserted on EVERY bar. The loop
    // mirrors the Pine diagnostic overlay's `for i = 0 to size - 1`, so a
    // loop-bound transcription error (the historical 1-indexed-belief class)
    // or an inconsistent na test on touchedBar makes the sum miss an element
    // and the assertion fires. Kept always-on by instruction: it is the cheap
    // probe that already caught one transcription error.
    let imbUntouched = 0;
    let imbTouched = 0;
    for (let i = 0; i < imbalances.length; i++) {
      if (isNa(imbalances[i].touchedBar)) imbUntouched += 1;
      else imbTouched += 1;
    }
    const imbLive = imbalances.length;
    if (imbUntouched + imbTouched !== imbLive) {
      throw new Error(
        `imbalance-detector: counts tautology violated on bar ${barIndex}: ` +
          `${imbUntouched} untouched + ${imbTouched} touched != ${imbLive} live`,
      );
    }

    return {
      bullishImbalance,
      bearishImbalance,
      nearImbalanceLong,
      nearImbalanceShort,
      inImbalanceLong,
      inImbalanceShort,
      volumeConfirmed,
      // Diagnostic counts, the series the Pine build plots as IMB DIAG
      // live / virgin / filled. imbLive <= maxImbalances (budget) is the
      // second Pine verdict; it follows from eviction-before-push and is
      // reported rather than asserted here.
      imbLive,
      imbUntouched,
      imbTouched,
      // Read-only snapshot for inspection and for the harness's own checks.
      imbalances: imbalances.map((z) => ({ ...z })),
    };
  }

  return {
    evaluate,
    defaults: cfg,
    get gapCount() {
      return imbalances.length;
    },
  };
}

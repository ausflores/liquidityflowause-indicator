// ============================================================================
// LiquidityFlowAuse — Signal Engine (JavaScript port)
// ----------------------------------------------------------------------------
// Port of src/modules/signal-engine.pine for the local backtest harness
// (odd/tasks/weight-calibration.md, task T7). LOGIC ONLY: label.new, alert()
// and alertcondition() are NOT ported — this module computes values, it cannot
// draw or notify. The showSignals input gated drawing only (Pine lines 232-234
// state it explicitly), so it is not ported either.
//
// Ported sections of docs/technical-spec.md / the Pine module:
//   7.6 confidence scoring — the five factors, ten point values, one score per
//       direction, max 110, compared against minConfidence (default 70).
//   the session gate      — sessionOK = sessionStrength >= 2 (binary; the
//       sessionMultiplier is deliberately NOT read, see "Inputs" below).
//   7.5 cooldown          — signalCooldownBars, one shared stamp for both
//       directions, evaluated BEFORE the signals are stamped.
//   directional exclusivity — the raw signals are NOT mutually exclusive by
//       construction; marketStructure breaks a both-qualify tie and a genuine
//       tie with no structure is dropped (ambiguousTie).
//   module outputs 7.7    — longSignalFired / shortSignalFired / longScore /
//       shortScore, plus the per-factor contributions this port ADDS so a
//       backtest result is explainable rather than a bare number.
//   SIGNAL_DIAGNOSTIC_OVERLAY (scripts/build.mjs:568-591, appended only under
//       --diagnostic) — the se* counters and the two verdicts, ported as
//       ALWAYS-ON throwing assertions. Same provenance decision as T5: task
//       T7 calls for an invariant throw, and in the Pine build those verdicts
//       are the only executable check this root module has.
//
// ─── WHY THE WEIGHTS ARE PARAMETERS (task T7, the point of the feature) ─────
//
// In Pine the ten point values are LITERALS inside the scoring block; only
// minConfidence and signalCooldownBars are input.* declarations. T12 searches
// over weight vectors and thresholds, so here every one of them lives in
// SIGNAL_ENGINE_DEFAULTS and can be overridden per factory call:
//
//   createSignalEngine({ liquidityD1: 25, minConfidence: 65 })
//
// The DEFAULTS reproduce the shipped literals exactly. A search therefore
// changes nothing about the shipped configuration until it deliberately passes
// a different vector, and a plain createSignalEngine() is bit-for-bit the
// indicator on the chart.
//
// SIGNAL_ENGINE_WEIGHT_KEYS is exported in Pine scoring order so a search can
// build a 10-element vector without hard-coding the key names a second time
// (the same way a duplicated list of factor names silently drifts).
//
// ─── INPUTS: computed upstream, never re-derived here (spec 7.6 wiring) ─────
//
// In the Pine build this module READS GLOBALS that scripts/build.mjs splices
// in front of it: session-markers.pine, liquidity-zones.pine,
// structure-break.pine and imbalance-detector.pine. Nothing is redeclared, and
// nothing is recomputed — request.security(), ta.sma(), the pivot detector and
// the gap lifecycle all stay where they are. This port keeps that boundary:
// every flag below arrives on the bar object from the corresponding
// backtest/modules/*.mjs evaluate() return value.
//
// SESSION MULTIPLIER IS NOT AN INPUT, and the brief that commissioned this
// slice said it was. The Pine source is authoritative and it disagrees:
// lines 76-81 explain that the gate reads sessionStrength (>= 2 clears it)
// while sessionMultiplier would only SCALE a weak out-of-session setup down
// and let it through at a reduced score, which is why "crypto runs 24/7, so
// the multiplier is deliberately NOT used here". sessionMultiplier is
// therefore not read, not accepted, and not ported — see this slice's report.
// The four membership flags ARE read: they are what sessionPoints scores.
//
// ─── Series / state semantics (Pine → JS) ──────────────────────────────────
//
//   `var int lastSignalBar = na`  → the ONE piece of module state: a closure
//       variable that persists across evaluate() calls (Pine `var` initializes
//       once and keeps its value bar to bar; a plain `let` inside evaluate()
//       would reinitialize every bar and the cooldown would never trigger).
//       na until the first signal fires.
//   `not na(lastSignalBar)`       → REQUIRED, not defensive: `bar_index - na`
//       is na, `na < n` is na, so without the guard inCooldown would be na
//       (falsy) by accident rather than by test. The port writes the same
//       guard as `!isNa(lastSignalBar) && …` — JS `&&` short-circuits, which
//       is exactly the guard's job.
//   na in a boolean `if`          → every remaining flag is a real boolean
//       from an upstream port, so no na path exists; the bar object's booleans
//       are coerced with Boolean() so a stray null/undefined reads FALSE,
//       matching how Pine's `if` treats na.
//   Loops (`for a = b to c`, inclusive bounds)  → NONE: this module contains
//       no loop and no array. The loop-bound traps documented at length in
//       liquidity-zones/imbalance-detector have no site here; there is nothing
//       to convert and no index base to shift.
//   Array indexing                → NONE for logic. The only indexing in the
//       source is series `[1]` inside the four liquidityTest/liquiditySweep
//       alertconditions (lines 318-326), which fire on the TRANSITION INTO a
//       state. Those are alerts, not signals, and are NOT ported; if a later
//       task wants them it needs a one-bar rolling history exactly like
//       imbalance-detector's `recent` array (bar 0 has no [1], so both read
//       false there — no bar-0 artifact).
//   request.security()            → NONE in this module. The D1/4H/1H context
//       it would fetch has already been resolved into tier flags upstream
//       (liquidity-zones owns the HTF aggregation).
//   barstate.*                    → NONE. The source has no barstate test; the
//       once-per-bar-close behaviour of the alerts comes from
//       alert.freq_once_per_bar_close, which belongs to alert() and is not
//       ported.
//
// PRECONDITION on evaluate(): one engine instance per series, called once per
// chart bar in chronological order with consecutive barIndex values. The
// cooldown arithmetic (`barIndex - lastSignalBar`) is series-dependent, so a
// skipped bar would lengthen or shorten the cooldown window without any
// visible symptom; the precondition is ENFORCED, not assumed (same check the
// other four ports make).
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

/**
 * The ten weight keys in Pine scoring order (liquidity tier, session tier,
 * structure, imbalance, volume). Exported so a weight search (T12) can build
 * its vector from one canonical list instead of re-spelling the names.
 */
export const SIGNAL_ENGINE_WEIGHT_KEYS = Object.freeze([
  "liquidityD1",
  "liquidityH4",
  "liquidityH1",
  "sessionOverlap",
  "sessionMajor",
  "sessionAsia",
  "structureFlip",
  "structureContinuation",
  "imbalance",
  "volume",
]);

/**
 * Defaults mirrored from the Pine module. The two input.* values (lines 46-47)
 * are marked; the other ten are LITERALS in the scoring block that this port
 * lifts into configuration so a search can vary them — the shipped values are
 * unchanged.
 *
 * Score ceiling, for reference: only the highest nearby liquidity tier counts
 * (f_liquidityWeight), so max = 30 + 25 + 30 + 15 + 10 = 110 and the score is
 * NOT a percentage — hence Pine's minConfidence maxval=110 rather than 100.
 */
export const SIGNAL_ENGINE_DEFAULTS = Object.freeze({
  // input.int(70, minval 0, maxval 110) — the threshold T12 searches over.
  minConfidence: 70,
  // input.int(10, minval 1).
  signalCooldownBars: 10,

  // f_liquidityWeight — highest nearby tier wins, tiers never add up.
  liquidityD1: 30,
  liquidityH4: 20,
  liquidityH1: 10,

  // sessionPoints — overlap beats a single major session beats Asia.
  sessionOverlap: 25,
  sessionMajor: 15, // inLondon or inNY
  sessionAsia: 5,

  // Structure — the flip weight REPLACES the continuation weight (Pine lines
  // 113-122); they are never added together.
  structureFlip: 30,
  structureContinuation: 20,

  // Imbalance (near OR in, one factor) and volume (direction-neutral).
  imbalance: 15,
  volume: 10,
});

function assertIntInRange(value, min, max, name) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer in [${min}, ${max}], got ${value}`);
  }
}

/**
 * Mirrors the Pine TYPES and input bounds so a harness cannot silently run the
 * port somewhere the shipped script could never go:
 *
 *   * every score term in the Pine module is declared `int` (pts,
 *     sessionPoints, longScore, shortScore), so a fractional weight would
 *     produce a score type the indicator cannot express — a search that wants
 *     12.5 points first has to decide to change the Pine model, which is a
 *     separate, user-authorized decision (see the task doc's out-of-scope
 *     list). Integer weights are rejected as RangeError, not rounded.
 *   * minConfidence mirrors input.int minval 0 / maxval 110; maxval is bound
 *     to the COMPUTED ceiling (maxScore) so a heavier custom vector does not
 *     freeze the threshold at the shipped 110.
 *   * signalCooldownBars mirrors input.int minval 1.
 */
function validateInputs(cfg, maxScore) {
  for (const key of SIGNAL_ENGINE_WEIGHT_KEYS) {
    assertIntInRange(cfg[key], 0, Number.MAX_SAFE_INTEGER, key);
  }
  assertIntInRange(cfg.minConfidence, 0, maxScore, "minConfidence");
  assertIntInRange(cfg.signalCooldownBars, 1, Number.MAX_SAFE_INTEGER, "signalCooldownBars");
}

/** Sum of one side's five factor contributions — the score itself. */
function sumFactors(factors) {
  return (
    factors.liquidity +
    factors.session +
    factors.structure +
    factors.imbalance +
    factors.volume
  );
}

// ─── Module factory ──────────────────────────────────────────────────────────

/**
 * Builds the signal engine. Mirrors one concatenation of the Pine module:
 * configuration is fixed at construction (Pine's input.* values and weight
 * literals), `lastSignalBar` persists across bars (Pine `var`), and
 * evaluate() runs the Pine blocks in their exact order — session gate,
 * scores, cooldown test, raw signals, directional exclusivity, fired
 * snapshot, cooldown stamp, diagnostics.
 *
 * @param {object} options — overrides of SIGNAL_ENGINE_DEFAULTS.
 */
export function createSignalEngine(options = {}) {
  const cfg = { ...SIGNAL_ENGINE_DEFAULTS, ...options };

  // The score ceiling is DERIVED from the configured weights, not hard-coded
  // to 110: 110 is only the ceiling of the shipped vector (30 + 25 + 30 + 15
  // + 10). The score-domain assertion below therefore checks the real ceiling
  // of whatever vector this instance runs with.
  const maxScore =
    cfg.liquidityD1 + cfg.sessionOverlap + cfg.structureFlip + cfg.imbalance + cfg.volume;
  validateInputs(cfg, maxScore);

  // ── Persistent state (Pine `var int lastSignalBar = na`, line 147) ────────
  //
  // One variable, deliberately not two: Pine stamps ONE bar index for both
  // directions (line 220-221), so if a bar somehow satisfied both, the
  // cooldown starts once, not twice.
  let lastSignalBar = NA;

  // ── Diagnostic counters (scripts/build.mjs SIGNAL_DIAGNOSTIC_OVERLAY) ─────
  //
  // seDualFires is the load-bearing one: LONG and SHORT are not mutually
  // exclusive by construction (the module's own worked example: a sandwiched
  // setup scores 70 on BOTH sides), so a dual fire means the exclusivity block
  // is absent or ineffective. These four are `var` in the overlay and persist.
  let seLongFires = 0;
  let seShortFires = 0;
  let seDualFires = 0;
  let seAmbiguousDrops = 0;

  // Bar index of the last bar evaluated; enforces the consecutive-bar
  // precondition described in the file header. Like every other piece of
  // series state it lives in the FACTORY closure, never at module scope:
  // module scope would be shared by every engine instance, and a search (T12)
  // runs many instances against one bar series.
  let lastBarIndex = NA;

  function evaluate(bar) {
    if (bar == null) throw new TypeError("signal-engine: bar is required");

    const {
      barIndex,
      // Session Markers (gate + session factor)
      sessionStrength,
      inOverlap,
      inLondon,
      inNY,
      inAsia,
      // Liquidity Zones (liquidity factor + the raw-signal near test)
      nearLiquidityLong,
      nearLiquidityShort,
      nearD1LiquidityLong,
      nearH4LiquidityLong,
      nearH1LiquidityLong,
      nearD1LiquidityShort,
      nearH4LiquidityShort,
      nearH1LiquidityShort,
      // Structure Break (structure factor + the tie-break)
      breakUp,
      breakDown,
      structureFlipped,
      marketStructure,
      // Imbalance Detector (imbalance factor + the raw-signal imbalance arm)
      nearImbalanceLong,
      nearImbalanceShort,
      inImbalanceLong,
      inImbalanceShort,
      volumeConfirmed,
    } = bar;

    if (!Number.isInteger(barIndex) || barIndex < 0) {
      throw new TypeError(`signal-engine: barIndex must be a non-negative integer, got ${barIndex}`);
    }
    // sessionStrength is an int 0-8 produced by session-markers.mjs on every
    // bar (0 even with a null timezone), so there is no na path to guard
    // against here — the Pine `sessionStrength >= 2` comparison therefore has
    // no na site in this port, unlike the cooldown guard below.
    if (!Number.isInteger(sessionStrength) || sessionStrength < 0) {
      throw new TypeError(
        `signal-engine: sessionStrength must be a non-negative integer, got ${sessionStrength}`,
      );
    }
    // marketStructure is Structure Break's exported domain {-1, 0, 1}. It
    // decides which side wins a both-qualify tie, so a wiring mistake here
    // (passing, say, a score or a boolean) would silently pick a direction:
    // reject it loudly instead.
    if (marketStructure !== -1 && marketStructure !== 0 && marketStructure !== 1) {
      throw new RangeError(
        `signal-engine: marketStructure must be -1, 0 or 1, got ${marketStructure}`,
      );
    }
    // Enforced precondition: consecutive bars only (see file header). The
    // cooldown subtracts two bar indexes; a gap would silently lengthen the
    // window with no visible symptom. Recorded LAST, after every validation
    // above, so a rejected bar cannot advance the series pointer and make the
    // NEXT good bar look non-consecutive.
    if (!isNa(lastBarIndex) && barIndex !== lastBarIndex + 1) {
      throw new RangeError(
        `signal-engine: bars must be consecutive; expected barIndex ${lastBarIndex + 1}, got ${barIndex}`,
      );
    }
    lastBarIndex = barIndex;

    // Every other input is a flag. Boolean() maps a stray null/undefined to
    // false, which is what Pine's `if` does with na; the upstream ports all
    // emit real booleans, so this is a wiring-safety net rather than a
    // semantic branch.

    // ── Block 1: session gate (Pine line 83) ─────────────────────────────────
    //
    // BINARY test on the strength, not the multiplier: >= 2 means at least one
    // major session (London or NY) is active. Asia alone scores 1 and does not
    // clear it — the gate suppresses out-of-session signals outright rather
    // than scaling them, which is exactly why the multiplier is not read.
    const sessionOK = sessionStrength >= 2;

    // ── Block 2: confidence scoring (Pine lines 95-138) ──────────────────────
    //
    // TWO SCORES, ONE PER DIRECTION, each built only from same-side inputs.
    // The contributions are recorded as five named factors per side and the
    // score IS their sum (single source of truth), so the explainable parts a
    // consumer reads can never drift from the number being thresholded. The
    // Pine module writes the same thing as five `+=` statements; summing the
    // named parts is arithmetically identical and is what makes T10/T12
    // results explainable instead of opaque (task T7).

    // Liquidity — per side, from the per-side tier flags. The helper is
    // direction-BLIND (Pine f_liquidityWeight, lines 64-66): it knows a tier,
    // not a side, and "first match wins" means only the HIGHEST nearby tier
    // counts — a price between a D1 and a 4H zone scores 30, not 50.
    const liquidityLong =
      nearD1LiquidityLong ? cfg.liquidityD1 :
      nearH4LiquidityLong ? cfg.liquidityH4 :
      nearH1LiquidityLong ? cfg.liquidityH1 : 0;
    const liquidityShort =
      nearD1LiquidityShort ? cfg.liquidityD1 :
      nearH4LiquidityShort ? cfg.liquidityH4 :
      nearH1LiquidityShort ? cfg.liquidityH1 : 0;

    // Session — direction-neutral, so both scores see the same points: a
    // session says nothing about which way price goes, only whether it is
    // worth trading. Pine line 109, ternary chain preserved (first match
    // wins, overlap first).
    const sessionPoints = inOverlap
      ? cfg.sessionOverlap
      : inLondon || inNY
        ? cfg.sessionMajor
        : inAsia
          ? cfg.sessionAsia
          : 0;

    // Structure — the reversal weight REPLACES the continuation weight, it
    // does not add to it (Pine lines 113-122; the earlier +20 AND +30 draft
    // scored one reversal 50 because ChoCh is a SUBSET of BoS). Parentheses
    // are explicit around the ternary for the same reason Pine writes them:
    // `+= cond ? a : b` relies on precedence in the one place a misread would
    // corrupt the score.
    const structureLong = breakUp
      ? (structureFlipped ? cfg.structureFlip : cfg.structureContinuation)
      : 0;
    const structureShort = breakDown
      ? (structureFlipped ? cfg.structureFlip : cfg.structureContinuation)
      : 0;

    // Imbalance — same side only, and `or` not `+`: approach and fill are
    // mutually exclusive by construction in imbalance-detector.pine (near*
    // requires an untouched gap, in* a touched one), so at most one arm is
    // ever true and summing could only double-count a single gap.
    const imbalanceLong = nearImbalanceLong || inImbalanceLong ? cfg.imbalance : 0;
    const imbalanceShort = nearImbalanceShort || inImbalanceShort ? cfg.imbalance : 0;

    // Volume — confirms activity without implying a direction, so it scores
    // both sides equally (Pine lines 136-138).
    const volumeLong = volumeConfirmed ? cfg.volume : 0;
    const volumeShort = volumeConfirmed ? cfg.volume : 0;

    const longFactors = {
      liquidity: liquidityLong,
      session: sessionPoints,
      structure: structureLong,
      imbalance: imbalanceLong,
      volume: volumeLong,
    };
    const shortFactors = {
      liquidity: liquidityShort,
      session: sessionPoints,
      structure: structureShort,
      imbalance: imbalanceShort,
      volume: volumeShort,
    };
    const longScore = sumFactors(longFactors);
    const shortScore = sumFactors(shortFactors);

    // ── Block 3: cooldown test (Pine lines 147-152) ─────────────────────────
    //
    // Declared BEFORE the signals even though it is only USED by the fired
    // flags: in Pine a term referencing inCooldown above its own declaration
    // is an undefined identifier, so the source order is load-bearing and is
    // reproduced here. The na guard on lastSignalBar is required, not
    // defensive — see the file header.
    const inCooldown =
      !isNa(lastSignalBar) && barIndex - lastSignalBar < cfg.signalCooldownBars;

    // ── Block 4: raw signals (Pine lines 165-171) ────────────────────────────
    //
    // Each signal is gated by its OWN score — never a shared confidence
    // number, so a setup can never be admitted by the strength of the
    // opposite direction. `breakUp` alone, not `breakUp or structureFlipped`:
    // Structure Break exposes one break flag plus structureFlipped precisely
    // so a single structural event cannot satisfy two terms of the same
    // factor. nearLiquidityLong (any tier) gates entry; the tier flag only
    // decides HOW MANY points it earned.
    const longSignalRaw =
      Boolean(nearLiquidityLong) &&
      sessionOK &&
      (Boolean(breakUp) || Boolean(nearImbalanceLong) || Boolean(inImbalanceLong)) &&
      longScore >= cfg.minConfidence;
    const shortSignalRaw =
      Boolean(nearLiquidityShort) &&
      sessionOK &&
      (Boolean(breakDown) || Boolean(nearImbalanceShort) || Boolean(inImbalanceShort)) &&
      shortScore >= cfg.minConfidence;

    // ── Block 5: directional exclusivity (Pine lines 193-199) ────────────────
    //
    // LONG and SHORT are NOT mutually exclusive by construction — the
    // sandwiched setup scores 70 on both sides at once — so without this block
    // the indicator prints a LONG and a SHORT on the same bar. Structure is
    // the tiebreaker, not the score:
    //   both qualify + structure bullish (1)  → LONG only
    //   both qualify + structure bearish (-1) → SHORT only
    //   both qualify + structure unestablished → NEITHER (dropped)
    //   one qualifies → that one, structure irrelevant
    // `marketStructure !== 1` / `!== -1` reproduce Pine's `!=` on an int.
    const longSignal = longSignalRaw && !(shortSignalRaw && marketStructure !== 1);
    const shortSignal = shortSignalRaw && !(longSignalRaw && marketStructure !== -1);

    // A genuine tie with no structure carries no directional information, so
    // it is dropped rather than resolved arbitrarily (Pine line 199).
    const ambiguousTie = longSignalRaw && shortSignalRaw && marketStructure === 0;

    // ── Block 6: fired snapshot (Pine lines 207-208) ─────────────────────────
    //
    // The cooldown term lives HERE rather than inside the signal expressions,
    // and these two flags are what the labels and alerts consume in Pine. One
    // snapshot taken BEFORE lastSignalBar is stamped below, so a signal that
    // fires on this bar is still emitted on this bar.
    const longSignalFired = longSignal && !inCooldown;
    const shortSignalFired = shortSignal && !inCooldown;

    // ── Block 7: cooldown application (Pine lines 220-221) ───────────────────
    //
    // AFTER the signals are evaluated, one stamp for both directions.
    if (longSignalFired || shortSignalFired) {
      lastSignalBar = barIndex;
    }

    // ── Block 8: diagnostics + invariants (SIGNAL_DIAGNOSTIC_OVERLAY) ────────
    //
    // In the Pine build these counters are appended AFTER this module (only
    // under --diagnostic); here they are always-on, and the two verdicts
    // become throwing assertions. This is the root module — nothing consumes
    // its output, so no downstream check exists to catch a mistake in it, and
    // the overlay's own header calls these series "that missing check".
    if (longSignalFired) seLongFires += 1;
    if (shortSignalFired) seShortFires += 1;
    if (longSignalFired && shortSignalFired) seDualFires += 1;
    if (ambiguousTie) seAmbiguousDrops += 1;

    // INVARIANT 1 — "SE DIAG DUAL fires (must be 0)". Impossible while the
    // exclusivity block is correct (both directions cannot survive Block 5 at
    // once), which is precisely why it is a useful probe: it fires the moment
    // that block is deleted or its condition inverted.
    if (longSignalFired && shortSignalFired) {
      throw new Error(
        `signal-engine: dual fire on bar ${barIndex} — LONG and SHORT emitted on the same bar ` +
          `(longScore ${longScore}, shortScore ${shortScore}, marketStructure ${marketStructure})`,
      );
    }

    // INVARIANT 2 — "SE DIAG VERDICT score domain". A score can only exceed
    // the ceiling if a factor counted twice: the liquidity tiers are mutually
    // exclusive by construction of the ternary, the structure weights replace
    // rather than add, and imbalance uses `or`. Any of those three broken and
    // this fires.
    if (longScore > maxScore || shortScore > maxScore) {
      throw new Error(
        `signal-engine: score domain violated on bar ${barIndex}: ` +
          `long ${longScore} / short ${shortScore} > max ${maxScore}`,
      );
    }

    // INVARIANT 3 — "TWO SCORES, NEVER ONE" (the module header's central
    // invariant, lines 12-18), made executable: every non-zero direction-
    // specific factor must trace to that side's OWN input. Session and volume
    // are exempt because they are genuinely direction-neutral by construction
    // and are added to both sides on purpose.
    assertSameSide("long", longFactors, {
      nearLiquidity: Boolean(nearLiquidityLong),
      broke: Boolean(breakUp),
      imbalance: Boolean(nearImbalanceLong) || Boolean(inImbalanceLong),
    });
    assertSameSide("short", shortFactors, {
      nearLiquidity: Boolean(nearLiquidityShort),
      broke: Boolean(breakDown),
      imbalance: Boolean(nearImbalanceShort) || Boolean(inImbalanceShort),
    });

    return {
      // ── Module outputs (spec 7.7) ────────────────────────────────────────
      longSignalFired,
      shortSignalFired,
      longScore,
      shortScore,

      // ── Per-factor contributions (task T7: explainable, not opaque) ──────
      // Five named factors per side; longScore / shortScore are exactly
      // sumFactors(longFactors) / sumFactors(shortFactors), so
      //   liquidity + session + structure + imbalance + volume === score
      // holds by construction on every bar.
      longFactors,
      shortFactors,

      // ── Decision intermediates, for replay and debugging ─────────────────
      sessionOK,
      inCooldown,
      longSignalRaw,
      shortSignalRaw,
      longSignal,
      shortSignal,
      ambiguousTie,
      // Post-stamp value: equals barIndex when a signal fired on this bar.
      lastSignalBar,

      // ── Diagnostic counters (SIGNAL_DIAGNOSTIC_OVERLAY) ──────────────────
      seLongFires,
      seShortFires,
      seDualFires,
      seAmbiguousDrops,
      // The computed ceiling for THIS weight vector (110 for the shipped one).
      maxScore,
    };
  }

  return { evaluate, defaults: cfg, maxScore };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Same-side attribution invariant. A direction-specific factor that scored
 * points while its own input was false means the score read the OTHER side's
 * flag — the exact defect the module header describes (a LONG earning points
 * for a D1 zone ABOVE price). Session and volume are not checked: they are
 * neutral by design.
 */
function assertSameSide(side, factors, own) {
  if (factors.liquidity > 0 && !own.nearLiquidity) {
    throw new Error(
      `signal-engine: ${side} liquidity factor ${factors.liquidity} without nearLiquidity on that side`,
    );
  }
  if (factors.structure > 0 && !own.broke) {
    throw new Error(
      `signal-engine: ${side} structure factor ${factors.structure} without a break on that side`,
    );
  }
  if (factors.imbalance > 0 && !own.imbalance) {
    throw new Error(
      `signal-engine: ${side} imbalance factor ${factors.imbalance} without an imbalance on that side`,
    );
  }
}

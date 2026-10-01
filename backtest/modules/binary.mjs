// ============================================================================
// LiquidityFlowAuse — Binary Confluence Model, spec D.1 (JavaScript port)
// ----------------------------------------------------------------------------
// T11 of odd/tasks/weight-calibration.md: the BASELINE the whole
// weight-calibration feature exists to compare against —
// docs/technical-spec.md D.1 "Binary Confluence Scoring (No Percentages)",
// lines 1844-1855, the strict boolean model the spec argues for ("a missing
// factor means the setup is incomplete").
//
// This module is LOGIC ONLY, like the other five ports: it computes flags, it
// draws nothing, it alerts nothing, it reads no data.
//
// ─── WHAT MAKES THE COMPARISON FAIR ─────────────────────────────────────────
//
// D.1's strict expressions and the SHIPPED weighted raw signals
// (src/modules/signal-engine.pine:165-171) are the SAME expression minus one
// term:
//
//   spec D.1 (:1849-1850)
//     longSignalStrict  = nearLiquidityLong and sessionOK and
//                         (breakUp or nearImbalanceLong or inImbalanceLong)
//
//   shipped Pine (:165-167)
//     longSignalRaw     = <byte-identical to the term above> and
//                         longScore >= minConfidence
//
// The single difference is the `longScore >= minConfidence` threshold. Both
// sides derive sessionOK the same way — `sessionStrength >= 2`
// (signal-engine.pine:83, spec :1845) — so binary is literally "the weighted
// model minus the score threshold", not a second, different system. That is
// the property backtest/baseline.mjs asserts on every bar of the real dataset
// (raw equivalence), because without it the T10/T11 comparison would be a
// comparison of two designs instead of one design's one decision.
//
// The spec's D.1 block ALSO declares `liquidityOK` and `structureOK`
// (:1844, :1846) and never uses either inside the strict expressions — they
// re-derive the same condition inline, per side. Reported as a DEAD
// DECLARATION, not a defect: both models are built from the strict
// expressions as written, so the unused declarations change no behaviour and
// are not ported.
//
// ─── THE SPREAD FILTER (D.3) IS NOT IN THIS MODEL EITHER ────────────────────
//
// docs/technical-spec.md D.3 (:1909-1931) gates the strict signals with
// `spreadOK`, and the D.4 strategy entry rules read `longSignalStrict and
// spreadOK`. `spreadOK` is NOT implemented anywhere under src/ (grep for
// `spreadOK` under src/ returns nothing) and it is not implemented here.
// Neither the weighted model nor the binary model gets it, so the comparison
// treats both identically. It is restated in the baseline report because a
// reader who knows D.3 will otherwise wonder where the filter went.
//
// ─── INPUT CONTRACT: the engine's, not a derived subset ─────────────────────
//
// The bar object consumed here is EXACTLY the one backtest/modules/
// signal-engine.mjs destructures (signal-engine.mjs:265-293), field for
// field, in the same order — BINARY_INPUT_CONTRACT below is that list. Both
// models are handed the SAME object per bar by the baseline runner, so the
// two can only differ by their own logic.
//
// Two differences from the engine's validation, both deliberate:
//   * every contract field must be PRESENT (the engine coerces a missing
//     flag to false). D.1 consumes raw upstream flags, never precomputed
//     booleans such as `sessionOK` or the engine's outputs, so a reduced,
//     pre-derived shape is rejected loudly instead of silently reading
//     undefined as false. This is the executable form of "same inputs".
//   * `minConfidence` is REJECTED as an option. This model has no score, so
//     a threshold would be a number the model does not compute; accepting
//     one would invite a fake binary-with-threshold baseline.
// Domain checks (barIndex, sessionStrength, marketStructure, consecutive
// bars) match the engine exactly, so the two models fail on the same bars.
//
// ─── PER-MODEL STATE: directional exclusivity and cooldown ──────────────────
//
// Like the engine, this factory owns its OWN `lastSignalBar` (Pine `var`) and
// runs the engine's exclusivity (signal-engine.pine:193-199) and cooldown
// (:152, :207-221) blocks against ITS OWN flags. The baseline runner creates
// one weighted engine and one binary model and NEVER shares cooldown state
// between them: binary fires more often, so it enters cooldown more often,
// and a shared stamp would suppress one model's bars on the other's history —
// distorting exactly the behaviour under test. Each model therefore behaves
// as it would alone on the chart.
//
// Consequence, stated here so nobody asserts the wrong subset relation: the
// raw-level implication `weighted raw => binary strict` holds by construction
// (asserted on every bar), but `weighted fired ⊆ binary fired` does NOT hold
// on the final flags — and must not be forced to hold. Only the raw level is
// comparable as a subset; the fired level is two independent state machines
// responding to the same market.
// ============================================================================

import { SIGNAL_ENGINE_DEFAULTS } from "./signal-engine.mjs";

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
 * The engine's input contract, field for field (signal-engine.mjs:265-293).
 * Exported so a wiring check can assert the two models are fed the same
 * object instead of trusting a comment that says they are.
 */
export const BINARY_INPUT_CONTRACT = Object.freeze([
  "barIndex",
  "sessionStrength",
  "inOverlap",
  "inLondon",
  "inNY",
  "inAsia",
  "nearLiquidityLong",
  "nearLiquidityShort",
  "nearD1LiquidityLong",
  "nearH4LiquidityLong",
  "nearH1LiquidityLong",
  "nearD1LiquidityShort",
  "nearH4LiquidityShort",
  "nearH1LiquidityShort",
  "breakUp",
  "breakDown",
  "structureFlipped",
  "marketStructure",
  "nearImbalanceLong",
  "nearImbalanceShort",
  "inImbalanceLong",
  "inImbalanceShort",
  "volumeConfirmed",
]);

/**
 * The one configurable value D.1 shares with the shipped indicator: the
 * cooldown length. It is a property of the INDICATOR (Pine input,
 * signal-engine.pine:47), not of the scoring model, so the default is READ
 * from the engine's defaults rather than re-spelled — a drift between the two
 * would silently change what is being compared. The STATE that enforces the
 * cooldown is per model instance (see the factory).
 */
export const BINARY_MODEL_DEFAULTS = Object.freeze({
  signalCooldownBars: SIGNAL_ENGINE_DEFAULTS.signalCooldownBars,
});

const BINARY_OPTION_KEYS = ["signalCooldownBars"];

function assertIntInRange(value, min, max, name) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer in [${min}, ${max}], got ${value}`);
  }
}

function validateOptions(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("binary-model: options must be an object");
  }
  for (const key of Object.keys(options)) {
    if (key === "minConfidence") {
      throw new TypeError(
        "binary-model: minConfidence is not an option — D.1 computes no score, so a " +
          "threshold would be a number this model never produces; run the weighted " +
          "engine (signal-engine.mjs) for the thresholded variant",
      );
    }
    if (!BINARY_OPTION_KEYS.includes(key)) {
      throw new TypeError(
        `binary-model: unknown option "${key}" (accepted: ${BINARY_OPTION_KEYS.join(", ")})`,
      );
    }
  }
  return { ...BINARY_MODEL_DEFAULTS, ...options };
}

/**
 * Builds the D.1 binary confluence model. Mirrors one concatenation of the
 * spec's strict expressions plus the engine's two downstream stateful blocks:
 * configuration is fixed at construction, `lastSignalBar` persists across
 * bars (Pine `var`), and evaluate() runs in the engine's exact order —
 * session gate, strict expressions, directional exclusivity, fired snapshot,
 * cooldown stamp, diagnostics.
 *
 * @param {object} options — { signalCooldownBars }. No score options exist.
 * @returns {{evaluate: Function, defaults: object}}
 */
export function createBinarySignalModel(options = {}) {
  const cfg = validateOptions(options);
  assertIntInRange(
    cfg.signalCooldownBars,
    1,
    Number.MAX_SAFE_INTEGER,
    "signalCooldownBars",
  );

  // ── Persistent state (Pine `var int lastSignalBar = na`, engine :147) ─────
  //
  // ONE stamp for both directions, exactly like the engine: a bar that
  // somehow qualified both sides starts the cooldown once. This variable is
  // private to THIS instance — the baseline runner's weighted engine holds a
  // separate one, and neither can see the other (file header, "PER-MODEL
  // STATE").
  let lastSignalBar = NA;

  // Diagnostic counters, mirroring the engine's se* block: dual fires must
  // stay 0 (the exclusivity block is working), ambiguous drops count dropped
  // ties. Persist across bars, one instance each.
  let binLongFires = 0;
  let binShortFires = 0;
  let binDualFires = 0;
  let binAmbiguousDrops = 0;

  let lastBarIndex = NA;

  function evaluate(bar) {
    if (bar == null) throw new TypeError("binary-model: bar is required");

    // Executable form of "the engine's input contract, not a derived subset".
    // The engine tolerates a missing flag (Boolean(undefined) === false);
    // this module does not, because a missing field here means the caller
    // assembled a REDUCED shape — e.g. precomputed sessionOK instead of
    // sessionStrength — and D.1 must re-derive every condition from the same
    // raw flags the weighted model reads.
    const missing = [];
    for (const field of BINARY_INPUT_CONTRACT) {
      if (!(field in bar)) missing.push(field);
    }
    if (missing.length > 0) {
      throw new TypeError(
        `binary-model: bar is missing engine input contract field(s): ${missing.join(", ")} — ` +
          "D.1 consumes the SAME bar object the signal engine does; a reduced or " +
          "pre-derived shape is not accepted",
      );
    }

    // Same destructuring as signal-engine.mjs:265-293, same order.
    const {
      barIndex,
      sessionStrength,
      inOverlap,
      inLondon,
      inNY,
      inAsia,
      nearLiquidityLong,
      nearLiquidityShort,
      nearD1LiquidityLong,
      nearH4LiquidityLong,
      nearH1LiquidityLong,
      nearD1LiquidityShort,
      nearH4LiquidityShort,
      nearH1LiquidityShort,
      breakUp,
      breakDown,
      structureFlipped,
      marketStructure,
      nearImbalanceLong,
      nearImbalanceShort,
      inImbalanceLong,
      inImbalanceShort,
      volumeConfirmed,
    } = bar;

    // Fields D.1 never reads. They are destructured (and presence-checked
    // above) because they ARE part of the shared contract: inOverlap /
    // inLondon / inNY / inAsia / volumeConfirmed / the tier flags feed the
    // weighted SCORE, structureFlipped marks a reversal break — none of them
    // appears in a strict boolean expression. The tier flags are reported
    // back under `liquidityTier` so the binary model still has a comparable
    // "shape" to the weighted score distribution.
    void inOverlap;
    void inLondon;
    void inNY;
    void inAsia;
    void structureFlipped;
    void volumeConfirmed;

    // Domain checks — byte-identical to the engine's, so the two models
    // accept and reject the same bars (see file header).
    if (!Number.isInteger(barIndex) || barIndex < 0) {
      throw new TypeError(`binary-model: barIndex must be a non-negative integer, got ${barIndex}`);
    }
    if (!Number.isInteger(sessionStrength) || sessionStrength < 0) {
      throw new TypeError(
        `binary-model: sessionStrength must be a non-negative integer, got ${sessionStrength}`,
      );
    }
    if (marketStructure !== -1 && marketStructure !== 0 && marketStructure !== 1) {
      throw new RangeError(
        `binary-model: marketStructure must be -1, 0 or 1, got ${marketStructure}`,
      );
    }
    if (!isNa(lastBarIndex) && barIndex !== lastBarIndex + 1) {
      throw new RangeError(
        `binary-model: bars must be consecutive; expected barIndex ${lastBarIndex + 1}, got ${barIndex}`,
      );
    }
    lastBarIndex = barIndex;

    // ── Block 1: session gate (spec :1845, engine :83) ──────────────────────
    //
    // sessionOK = sessionStrength >= 2 — BINARY on the strength, identical on
    // both models. sessionMultiplier is not read (source wins; see the engine
    // header's "SESSION MULTIPLIER IS NOT AN INPUT").
    const sessionOK = sessionStrength >= 2;

    // ── Block 2: the D.1 strict expressions (:1849-1854) ────────────────────
    //
    // Each side is gated by its OWN liquidity and its OWN trigger arm, exactly
    // as written; Boolean() maps a stray null/undefined to false, matching how
    // Pine's `and` treats na — the upstream ports emit real booleans, so this
    // is a wiring safety net, not a semantic branch.
    const longSignalStrict =
      Boolean(nearLiquidityLong) &&
      sessionOK &&
      (Boolean(breakUp) || Boolean(nearImbalanceLong) || Boolean(inImbalanceLong));
    const shortSignalStrict =
      Boolean(nearLiquidityShort) &&
      sessionOK &&
      (Boolean(breakDown) || Boolean(nearImbalanceShort) || Boolean(inImbalanceShort));

    // ── Condition report (the binary model's "score shape") ─────────────────
    //
    // D.1 admits or rejects; there is no number to distribute. To keep the
    // baseline comparable, each side reports WHICH conditions it satisfied on
    // this bar: the liquidity tier that qualified (highest nearby tier wins,
    // same precedence as the engine's f_liquidityWeight ternary) and which of
    // the three trigger arms held. The baseline aggregates these over the
    // bars where strict is true — the same population the weighted model
    // shows its score histogram over.
    const liquidityTier = !nearLiquidityLong
      ? null
      : nearD1LiquidityLong
        ? "D1"
        : nearH4LiquidityLong
          ? "H4"
          : nearH1LiquidityLong
            ? "H1"
            : null;
    const shortLiquidityTier = !nearLiquidityShort
      ? null
      : nearD1LiquidityShort
        ? "D1"
        : nearH4LiquidityShort
          ? "H4"
          : nearH1LiquidityShort
            ? "H1"
            : null;

    const longArms = [];
    if (breakUp) longArms.push("break");
    if (nearImbalanceLong) longArms.push("nearImbalance");
    if (inImbalanceLong) longArms.push("inImbalance");
    const shortArms = [];
    if (breakDown) shortArms.push("break");
    if (nearImbalanceShort) shortArms.push("nearImbalance");
    if (inImbalanceShort) shortArms.push("inImbalance");

    const longConditions = {
      liquidity: Boolean(nearLiquidityLong),
      liquidityTier,
      session: sessionOK,
      trigger: longArms.length > 0 ? longArms.join("+") : null,
    };
    const shortConditions = {
      liquidity: Boolean(nearLiquidityShort),
      liquidityTier: shortLiquidityTier,
      session: sessionOK,
      trigger: shortArms.length > 0 ? shortArms.join("+") : null,
    };

    // ── Block 3: directional exclusivity (engine :193-199) ──────────────────
    //
    // Identical block, run against THIS model's flags. Structure breaks the
    // tie, a genuine tie with no structure is dropped (ambiguousTie).
    const longSignal = longSignalStrict && !(shortSignalStrict && marketStructure !== 1);
    const shortSignal = shortSignalStrict && !(longSignalStrict && marketStructure !== -1);
    const ambiguousTie = longSignalStrict && shortSignalStrict && marketStructure === 0;

    // ── Block 4: cooldown test (engine :152) ────────────────────────────────
    //
    // na guard on lastSignalBar is required, not defensive: bar_index - na is
    // na in Pine, which would leave inCooldown na (falsy) by accident.
    const inCooldown =
      !isNa(lastSignalBar) && barIndex - lastSignalBar < cfg.signalCooldownBars;

    // ── Block 5: fired snapshot (engine :207-208) ───────────────────────────
    //
    // Taken BEFORE the stamp below, so a signal firing on this bar is
    // emitted on this bar.
    const longSignalFired = longSignal && !inCooldown;
    const shortSignalFired = shortSignal && !inCooldown;

    // ── Block 6: cooldown application (engine :220-221) ─────────────────────
    if (longSignalFired || shortSignalFired) {
      lastSignalBar = barIndex;
    }

    // ── Diagnostics (mirrors the engine's se* block) ────────────────────────
    if (longSignalFired) binLongFires += 1;
    if (shortSignalFired) binShortFires += 1;
    if (longSignalFired && shortSignalFired) binDualFires += 1;
    if (ambiguousTie) binAmbiguousDrops += 1;

    if (longSignalFired && shortSignalFired) {
      throw new Error(
        `binary-model: dual fire on bar ${barIndex} — LONG and SHORT emitted on the same bar ` +
          `(marketStructure ${marketStructure})`,
      );
    }

    return {
      // ── D.1 module outputs (spec :1849-1854) ────────────────────────────
      longSignalStrict,
      shortSignalStrict,
      longConditions,
      shortConditions,

      // ── Same downstream stages as the engine ────────────────────────────
      sessionOK,
      longSignal,
      shortSignal,
      ambiguousTie,
      inCooldown,
      longSignalFired,
      shortSignalFired,
      lastSignalBar,

      // ── Diagnostic counters ─────────────────────────────────────────────
      binLongFires,
      binShortFires,
      binDualFires,
      binAmbiguousDrops,
    };
  }

  return { evaluate, defaults: cfg };
}

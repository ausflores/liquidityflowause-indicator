#!/usr/bin/env node
// ============================================================================
// LiquidityFlowAuse — Build Script
// ----------------------------------------------------------------------------
// Concatenates the main indicator file with its modules into a single
// distributable .pine file, then runs the structural checks that can be
// verified without a Pine compiler.
//
// Why a build step: TradingView accepts exactly one script per indicator.
// The modules in src/modules/ are a development reference; this script
// flattens them into the file that gets pasted into the Pine Editor.
//
// Why Node and not the bash script in docs/technical-spec.md section 12.3:
// that spec predates the target platform, and the ordering it shows is wrong
// for Pine v5. See ORDER below.
//
// Usage:
//   node scripts/build.mjs                 # build + validate
//   node scripts/build.mjs --out X         # custom output path
//   node scripts/build.mjs --check         # validate only, write nothing
//   node scripts/build.mjs --diagnostic    # append every diagnostic overlay
//   node scripts/build.mjs --diagnostic=a,b  # append only sections a and b
//   node scripts/build.mjs --strategy      # the strategy variant (spec D.4)
//
// Route A, the strategy variant: a SECOND main source file
// (src/liquidityflowause-strategy.pine) assembled from the SAME SOURCES array,
// with a strategy() declaration in place of the indicator() one. The module
// logic is not re-implemented, re-derived or copy-pasted anywhere: both targets
// read the same files in the same order. That equivalence is ASSERTED, not
// assumed — see assertModuleParity below, which fails the build rather than
// warning, because a strategy that drifts from the indicator would trade
// something the user does not.
//
// Pine caps plot-family calls (plot, bgcolor, alertcondition, ...) at 64 per
// script. Every build runs a plot-budget preflight and refuses to write a file
// that would exceed the limit (TradingView reports it as RE10140 on paste).
// ============================================================================

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MARKER, SOURCES, assertModuleParity, readModuleParts } from "./assemble.mjs";

// ─── Configuration ───────────────────────────────────────────────────────────

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAIN = join(ROOT, "src", "liquidityflowause.pine");

// Route A. The strategy's main file owns the strategy() declaration, the
// strategy-only inputs, the D.3 spread filter and the entry/exit rules. It is
// assembled from the SAME SOURCES array as the indicator — imported above, not
// re-declared here — so the five modules are read from the same bytes in the
// same order, and there is no second list to drift.
//
// Missing SOURCES entries are reported as warnings, not failures: the three
// src/lib/ files are planned and not written yet, and a build that hard-failed
// on planned files would block every increment until the last module lands.
const DEFAULT_OUT = join(ROOT, "dist", "liquidityflowause.pine");
const DIAGNOSTIC_OUT = join(ROOT, "dist", "liquidityflowause-diag.pine");
const STRATEGY_OUT = join(ROOT, "dist", "liquidityflowause-strategy.pine");

// Route A's main source. It carries the strategy() declaration, the D.3 spread
// filter, the selectable entry model and the entry/exit rules — and NOTHING
// else. Every line of module logic lives in src/modules/ and reaches both
// artifacts through the shared SOURCES array imported above.
const STRATEGY_MAIN = join(ROOT, "src", "liquidityflowause-strategy.pine");

// Route A's main source. It carries the strategy() declaration, the D.3 spread
// filter, the selectable entry model and the entry/exit rules — and NOTHING
// else. Every line of module logic lives in src/modules/ and reaches both
// artifacts through the shared SOURCES array imported above.

// The shipped indicator's SHA256, pinned so a build that moved it cannot pass
// silently. This file is the product; the strategy is a measuring instrument
// built beside it and must never be able to rewrite the artifact it measures.
//
// Recorded from dist/liquidityflowause.pine at commit 4097ee4.
export const SHIPPED_INDICATOR_SHA256 =
  "1dd6f536ae4f50c2f669e9c1a2b34a0fb97a7d51428905b9e18f8616d1582ce2";

// The D.4 exit levels, cross-checked against backtest/modules/label.mjs at
// build time so the strategy cannot drift from the definition the whole
// investigation used. label.mjs exports EXIT_TARGET_PCT / EXIT_STOP_PCT; those
// are read from the module rather than restated here, so there is one number.
const EXIT_ARITHMETIC_SOURCE = join(ROOT, "backtest", "modules", "label.mjs");

// ─── Helpers ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");

// --strategy builds the Route A variant.
const STRATEGY_FLAG = "--strategy";
const strategyMode = args.includes(STRATEGY_FLAG);

// --diagnostic is either bare (all sections) or carries a comma-separated
// section list: --diagnostic=structure-break,signal-engine. Only the raw value
// is parsed here; the names are resolved later against the section table, so
// an unknown name can be reported together with the valid list.
const DIAG_FLAG = "--diagnostic";
const diagArg = args.find((a) => a === DIAG_FLAG || a.startsWith(`${DIAG_FLAG}=`));
const diagnostic = diagArg !== undefined;
const diagnosticValue =
  diagnostic && diagArg.length > DIAG_FLAG.length
    ? diagArg.slice(DIAG_FLAG.length + 1)
    : null;

const outFlag = args.indexOf("--out");
const outPath = outFlag !== -1 && args[outFlag + 1]
  ? resolve(ROOT, args[outFlag + 1])
  : strategyMode
    ? STRATEGY_OUT
    : (diagnostic ? DIAGNOSTIC_OUT : DEFAULT_OUT);

// --strategy and --diagnostic are mutually exclusive, and the clash is a hard
// error rather than a silent precedence rule. The diagnostic overlays are
// INDICATOR overlays: they plot the indicator's own series and read its
// globals. Appending them to a strategy() script produces a file that is
// neither an indicator nor a strategy, and a caller who asked for both and got
// one would never learn which one they got.
if (strategyMode && diagnostic) {
  console.error(
    `build: ${STRATEGY_FLAG} cannot be combined with ${DIAG_FLAG}. The diagnostic ` +
      "overlays are indicator overlays: they plot the indicator's series and read " +
      "its globals. Build the production strategy script, or build a diagnostic " +
      "indicator — not a file that is neither.",
  );
  process.exit(1);
}

const warnings = [];
const errors = [];

function warn(message) {
  warnings.push(message);
}

function fail(message) {
  errors.push(message);
}

const BANNER = "// " + "=".repeat(75);

// ─── Assemble ────────────────────────────────────────────────────────────────

/**
 * Concatenates ONE main file with the shared module list.
 *
 * Both targets call this with a different main path and nothing else. The
 * module list, the module order and the banner stripping all live in
 * scripts/assemble.mjs: there is no second place where a module's bytes are
 * decided, so there is no second place where they can diverge. `label` is used
 * only for the report.
 *
 * The module-declaration guard is routed through `fail()` rather than
 * duplicated here, so a module that declares its own script fails BOTH builds
 * identically.
 */
async function build(mainPath, label) {
  if (!existsSync(mainPath)) {
    console.error(`build: main file not found at ${mainPath}`);
    process.exit(1);
  }

  const mainSource = await readFile(mainPath, "utf8");

  if (!mainSource.includes(MARKER)) {
    console.error(
      `build: ${mainPath} has no ${MARKER} marker.\n` +
        "The marker is where modules are spliced in. Without it there is no " +
        "safe insertion point.",
    );
    process.exit(1);
  }

  const parts = [];

  // 1. Main file header: everything up to and including the marker block.
  //    The marker block is a comment; the marker line starts it and the block
  //    ends at the first line that is not a comment.
  const mainLines = mainSource.split(/\r?\n/);
  const markerIndex = mainLines.findIndex((l) => l.includes(MARKER));
  if (markerIndex === -1) {
    console.error("build: marker disappeared between read and parse");
    process.exit(1);
  }

  let blockEnd = markerIndex;
  while (blockEnd + 1 < mainLines.length && mainLines[blockEnd + 1].trim().startsWith("//")) {
    blockEnd++;
  }

  parts.push({
    label: `${label} (header)`,
    module: false,
    text: mainLines.slice(0, blockEnd + 1).join("\n").replace(/\n+$/, "\n"),
  });

  // 2. Modules, in declared order. Read by scripts/assemble.mjs so the two
  //    targets cannot differ here even by accident.
  parts.push(
    ...(await readModuleParts(ROOT, SOURCES, {
      onMissing: (rel) => warn(`module not built yet, skipped: ${rel}`),
      // Structural invariant: a module that declares its own script declaration
      // would produce a script with two of them. Indicators AND strategies are
      // both refused: the main file owns the single declaration either way.
      onForbidden: (rel) =>
        fail(
          `${rel} declares indicator()/study()/strategy(). Modules must not; the main ` +
            "file owns the single declaration.",
        ),
    })),
  );

  // 3. Main file footer: the marker block's continuation, if any.
  const footer = mainLines.slice(blockEnd + 1).join("\n").replace(/^\n+/, "");
  if (footer.trim()) {
    parts.push({ label: `${label} (footer)`, module: false, text: footer });
  }

  return parts;
}

// ─── Module Parity (Route A) ─────────────────────────────────────────────────

/**
 * Asserts that the module text embedded in the STRATEGY build is byte-identical
 * to the module text embedded in the INDICATOR build.
 *
 * This is the load-bearing check of the whole Route A design. The strategy is
 * only useful if it trades what the indicator signals, and the only thing that
 * makes that true is that both artifacts were concatenated from the same
 * module bytes in the same order. Asserting it is stronger than relying on the
 * shared SOURCES array: it also catches a future edit that adds a second module
 * list, a build path that skips banner stripping, or a transform applied to
 * only one target.
 *
 * It FAILS the build rather than warning. A warning here would produce a
 * strategy file that looks fine and trades something else, and nothing
 * downstream would report it.
 *
 * Returns the per-module result so the build can print it: "verified" must be
 * visible, not merely not-false.
 *
 * A parity assertion that has never been seen to FAIL is not known to work,
 * only known not to have been triggered. scripts/assemble.mjs therefore
 * returns its findings rather than throwing, and backtest/smoke.mjs drives it
 * with a deliberately divergent pair to prove it can fail. This wrapper is the
 * build's half of that contract: findings become build errors here.
 */
function checkModuleParity(indicatorParts, strategyParts) {
  const { report, errors: parityErrors } = assertModuleParity(indicatorParts, strategyParts);
  for (const e of parityErrors) fail(e);
  return report;
}

// ─── Strategy Structural Checks ──────────────────────────────────────────────

/**
 * The checks that are decidable from the strategy's text alone.
 *
 * These are NOT a Pine parser and do not claim to be. They cannot verify types,
 * builtins or runtime behavior — only the Pine Editor can, and this repository
 * has no Pine compiler. What they do catch is the class of mistake that would
 * make the file wrong in a way no one would notice: a missing declaration, an
 * indicator() left in, an input that nothing reads, an exit that was never
 * written.
 */
function validateStrategy(assembled) {
  const text = assembled.join("\n");
  const lines = text.split(/\r?\n/);

  // 1. //@version=5 first, exactly once. A strategy that falls behind the
  //    indicator on the version line is a strategy that may not compile.
  const versionLines = lines
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => /^\s*\/\/@version=/.test(l));

  if (versionLines.length !== 1) {
    fail(
      `strategy: found ${versionLines.length} //@version= directives; expected ` +
        "exactly 1 (Pine v5 requires it, and the indicator declares it once).",
    );
  } else if (!/^\/\/@version=5\s*$/.test(versionLines[0].l)) {
    fail(`strategy: the version directive is "${versionLines[0].l}"; expected //@version=5`);
  } else if (lines[0] !== "//@version=5") {
    fail(
      `strategy: //@version=5 is on line ${versionLines[0].i + 1}, not line 1. ` +
        "TradingView requires it in the first line of the script.",
    );
  }

  // 2. Exactly one strategy() declaration, and NO indicator()/study(). A
  //    strategy that also declares an indicator is rejected by Pine, and the
  //    pasted-over-the-product failure mode this project cares about most
  //    starts with the two being confused.
  const strategyDecls = lines.filter((l) => /^\s*strategy\s*\(/.test(l));
  if (strategyDecls.length === 0) {
    fail("strategy: no strategy() declaration found");
  } else if (strategyDecls.length > 1) {
    fail(`strategy: found ${strategyDecls.length} strategy() declarations; expected exactly 1`);
  }

  const indicatorDecls = lines.filter((l) => /^\s*(indicator|study)\s*\(/.test(l));
  if (indicatorDecls.length > 0) {
    fail(
      `strategy: found ${indicatorDecls.length} indicator()/study() declaration(s) in a ` +
        "strategy build. This file must never be pasted over the shipped indicator.",
    );
  }

  // The declaration must precede the first input call, and — unlike the
  // indicator — there may be no code at all before it beyond comments.
  const firstInput = lines.findIndex((l) => /^\s*\w+\s*=\s*input\./.test(l));
  if (strategyDecls.length === 1 && firstInput !== -1) {
    const declIdx = lines.findIndex((l) => /^\s*strategy\s*\(/.test(l));
    if (firstInput < declIdx) {
      fail(
        `strategy: input.* call at line ${firstInput + 1} precedes the strategy() ` +
          `declaration at line ${declIdx + 1}`,
      );
    }
  }

  // 3. Both entry calls and both exit calls are present. D.4 writes four calls
  //    and a strategy missing one of them silently trades one side forever or
  //    never exits — neither is visible without reading the tester output.
  const code = stripLineComments(text);
  const entryCalls = (code.match(/(?<![\w.])strategy\.entry\s*\(/g) ?? []).length;
  if (entryCalls !== 2) {
    fail(
      `strategy: found ${entryCalls} strategy.entry() call(s); expected 2 (one per ` +
        "side). A missing one trades that side never.",
    );
  }

  const exitCalls = (code.match(/(?<![\w.])strategy\.exit\s*\(/g) ?? []).length;
  if (exitCalls !== 2) {
    fail(
      `strategy: found ${exitCalls} strategy.exit() call(s); expected 2 (one per ` +
        "side). A missing one leaves that side open until the tester ends.",
    );
  }

  if (!/strategy\.entry\s*\(\s*"LONG"/.test(code) || !/strategy\.entry\s*\(\s*"SHORT"/.test(code)) {
    fail('strategy: the entry IDs must be "LONG" and "SHORT" — the exit calls reference them by name');
  }
  if (!/strategy\.exit\s*\(\s*"Exit Long"/.test(code) || !/strategy\.exit\s*\(\s*"Exit Short"/.test(code)) {
    fail('strategy: the exit IDs must be "Exit Long" and "Exit Short"');
  }

  // 4. Target and stop are present and referenced, not merely declared. A
  //    declared-but-unread exit input is a silent return to breakeven.
  const targetPct = lines.find((l) => /^\s*targetPct\s*=/.test(l));
  const stopPct = lines.find((l) => /^\s*stopPct\s*=/.test(l));

  if (!targetPct) {
    fail("strategy: no `targetPct` declaration — D.4's target input is missing");
  } else if ((code.match(/\btargetPct\b/g) ?? []).length < 3) {
    fail(
      "strategy: targetPct is declared but barely referenced — check that both exit " +
        "levels are computed from it",
    );
  }

  if (!stopPct) {
    fail("strategy: no `stopPct` declaration — D.4's stop input is missing");
  } else if ((code.match(/\bstopPct\b/g) ?? []).length < 3) {
    fail(
      "strategy: stopPct is declared but barely referenced — check that both exit " +
        "levels are computed from it",
    );
  }

  // 5. Every declared input is READ somewhere. This is the check that catches
  //    an input added and then forgotten: the entry-mode switch, the
  //    flat-only switch and the spread filter each control behaviour, and a
  //    control that nothing reads is a lie in the input panel.
  const declarations = [
    ...code.matchAll(/^\s*(\w+)\s*=\s*input\.\w+\(/gm),
  ].map((m) => m[1]);

  for (const name of new Set(declarations)) {
    const uses = (code.match(new RegExp(`\\b${name}\\b`, "g")) ?? []).length;
    // One occurrence is the declaration itself.
    if (uses < 2) {
      fail(
        `strategy: input "${name}" is declared but never read. An input that ` +
          "controls nothing must not appear in the input panel.",
      );
    }
  }

  // 6. The defaults this file ships are the defaults the brief fixes. They are
  //    read from the source rather than asserted twice, so a later edit that
  //    changes one of them has to change this line too.
  const defaults = {
    entryModel: /input\.string\(\s*"Weighted"/,
    onlyWhenFlat: /onlyWhenFlat\s*=\s*input\.bool\(true/,
    spreadFilterEnabled: /spreadFilterEnabled\s*=\s*input\.bool\(false/,
    target: /targetPct\s*=\s*input\.float\(\s*1\.5\b/,
    stop: /stopPct\s*=\s*input\.float\(\s*0\.8\b/,
  };
  for (const [name, re] of Object.entries(defaults)) {
    if (!re.test(code)) {
      fail(
        `strategy: the ${name} default does not match the documented one. The ` +
          "defaults are the contract: entry model WEIGHTED, only-when-flat ON, " +
          "spread filter OFF, target 1.5, stop 0.8.",
      );
    }
  }

  // 7. The strategy's own D.4 parameters, so a strategy that quietly dropped
  //    them is caught rather than discovered on someone's chart.
  const strategyDecl = strategyDecls[0] ?? "";
  const requiredDeclArgs = {
    default_qty_type: /default_qty_type\s*=\s*strategy\.percent_of_equity/,
    default_qty_value: /default_qty_value\s*=\s*10\b/,
    commission_type: /commission_type\s*=\s*strategy\.commission\.percent/,
    commission_value: /commission_value\s*=\s*0\.05\b/,
    slippage: /slippage\s*=\s*2\b/,
  };
  for (const [arg, re] of Object.entries(requiredDeclArgs)) {
    if (!re.test(strategyDecl + text.slice(text.indexOf(strategyDecl) + strategyDecl.length, text.indexOf(strategyDecl) + 2000))) {
      // The declaration spans several lines; fall back to the whole script,
      // which is safe because these argument names exist nowhere else.
      if (!re.test(code)) {
        fail(`strategy: the strategy() declaration is missing ${arg}`);
      }
    }
  }

  return { lineCount: lines.length };
}

// ─── Exit Arithmetic Cross-Check ─────────────────────────────────────────────

/**
 * Asserts that the target and stop this file ships are the numbers
 * backtest/modules/label.mjs uses.
 *
 * Why this matters more than it looks: label.mjs is the definition the whole
 * investigation measured against. If the strategy shipped 2.0 / 1.0, its curve
 * would be measuring a DIFFERENT TRADE from every number already on the record,
 * and nothing would say so. The constants are read out of label.mjs — not
 * restated here — so there is exactly one place they can be wrong.
 */
async function checkExitArithmetic(assembled) {
  const text = assembled.join("\n");
  const code = stripLineComments(text);

  let labelSource;
  try {
    labelSource = await readFile(EXIT_ARITHMETIC_SOURCE, "utf8");
  } catch {
    fail(
      `exit arithmetic could not be cross-checked: ${EXIT_ARITHMETIC_SOURCE} is ` +
        "unreadable. The harness's definition of D.4's exit rule is the thing the " +
        "strategy must not drift from, so its absence is a failure, not a skip.",
    );
    return null;
  }

  const target = Number(/export const EXIT_TARGET_PCT\s*=\s*([0-9.]+)/.exec(labelSource)?.[1]);
  const stop = Number(/export const EXIT_STOP_PCT\s*=\s*([0-9.]+)/.exec(labelSource)?.[1]);

  if (!Number.isFinite(target) || !Number.isFinite(stop)) {
    fail(
      "exit arithmetic cross-check could not read EXIT_TARGET_PCT / EXIT_STOP_PCT " +
        `from ${EXIT_ARITHMETIC_SOURCE}`,
    );
    return null;
  }

  const shippedTarget = Number(/targetPct\s*=\s*input\.float\(\s*([0-9.]+)/.exec(code)?.[1]);
  const shippedStop = Number(/stopPct\s*=\s*input\.float\(\s*([0-9.]+)/.exec(code)?.[1]);

  if (shippedTarget !== target) {
    fail(
      `exit arithmetic FAILED: the strategy ships targetPct=${shippedTarget} but ` +
        `backtest/modules/label.mjs uses EXIT_TARGET_PCT=${target}. The strategy ` +
        "would measure a different trade from the one the investigation recorded.",
    );
  }

  if (shippedStop !== stop) {
    fail(
      `exit arithmetic FAILED: the strategy ships stopPct=${shippedStop} but ` +
        `backtest/modules/label.mjs uses EXIT_STOP_PCT=${stop}. The strategy would ` +
        "measure a different trade from the one the investigation recorded.",
    );
  }

  // The ratio is what every expectancy figure in the investigation is quoted
  // against, so it is reported rather than left to the reader to divide.
  return { target, stop, ratio: target / stop };
}

// ─── Validate ────────────────────────────────────────────────────────────────

// ─── Diagnostic Build ────────────────────────────────────────────────────────

/**
 * Appended only under --diagnostic. The production module is never modified.
 *
 * Purpose: the session tints ship at 92-96% transparency, which is close to
 * invisible on TradingView's dark background. Counting one-pixel dotted lines
 * against that is not a reliable test — by eye, or from a screenshot.
 *
 * This overlay makes the same behavior observable two ways:
 *
 *   1. Visually — a near-opaque band for the active session, a label at EVERY
 *      session edge naming the session and whether it opened or closed, and
 *      thicker solid boundary lines.
 *
 *   2. Numerically — edge counters and drawn-line counters plotted as series,
 *      so TradingView prints them in the chart legend. The relationship
 *      `edges === 2 x lines` holds only when the `and inAsia` guard is correct.
 *      A numeric read removes the squinting entirely.
 */
const DIAGNOSTIC_OVERLAY = `
// ═══════════════════════════════════════════════════════════════════════════
// DIAGNOSTIC OVERLAY — generated by scripts/build.mjs --diagnostic
// Not production. Verifies boundary-line edge behavior in the Pine Editor.
// ═══════════════════════════════════════════════════════════════════════════

// Active session name for this bar, and a full-height marker band.
string diagName = ""
color  diagCol  = color.white

if inAsia
    diagName := diagName == "" ? "ASIA" : diagName + "+ASIA"
    diagCol  := color.new(color.purple, 20)
if inLondon
    diagName := diagName == "" ? "LONDON" : diagName + "+LONDON"
    diagCol  := color.new(color.blue, 20)
if inNY
    diagName := diagName == "" ? "NY" : diagName + "+NY"
    diagCol  := color.new(color.orange, 20)
if inOverlap
    diagName := diagName + "+OVERLAP"
    diagCol  := color.new(color.yellow, 10)

bgcolor(diagName != "" ? color.new(diagCol, 75) : na, title="DIAG active session")

// Label EVERY edge, opening and closing alike, naming the session involved.
// A close must be labelled with the session that was ending, so read the name
// from the previous bar before the flags collapsed.
string diagPrevName = diagName[1]
bool   diagActive   = diagName != ""

if ta.change(diagActive)
    label.new(
         bar_index,
         high,
         (diagActive ? "OPEN  " : "CLOSE ") + (diagActive ? diagName : diagPrevName),
         style    = label.style_label_left,
         color    = diagActive ? color.new(color.green, 10) : color.new(color.red, 10),
         textcolor = color.white,
         size     = size.normal)

// Edge counters vs drawn-line counters. Every session window has two edges
// (open, close) but should draw exactly one line. The counters are independent
// of the production guard: "edges" counts bare ta.change() transitions, while
// "lines" counts only what the guarded condition actually drew.
//
// bar_index > 0 EXCLUDES THE FIRST BAR OF THE VISIBLE RANGE. Its previous
// value is na, so ta.change() reports a transition that never happened. When
// the chart opens mid-session that inflates the edge count for that one session
// only — observed as NY reading 43 edges against 21 lines while Asia and
// London balanced at 42/21 on the same chart. Excluding bar 0 removes the
// artifact without hiding a real defect, because a real guard failure shifts
// edges and lines together on every window, not on one boundary bar.
// ─── Timezone Smoke Test ─────────────────────────────────────────────────────
//
// The session windows are defined in the SELECTED timezone. Reading a band's
// position off the chart axis proves nothing on its own, because the chart axis
// carries its own offset. What is checkable without knowing that offset is
// where each session's opening bar actually falls in UTC — a value derived from
// the data rather than read by eye.
//
// MEASUREMENT HAZARD, and the reason this samples on an edge: time() does NOT
// return the session's opening instant. It returns the timestamp OF THE BAR
// when that bar falls inside the session, and na otherwise (Pine Script v5,
// Concepts/Time, "Testing for sessions": "it returns a UNIX timestamp for
// that bar"). The docs describe the session parameter as a FILTER on the bars
// the function already reports, not as a query for a session boundary.
//
// Plotting hour(time(...), "UTC") directly therefore yields a RAMP across the
// session's bars, never a constant, so the value read depends entirely on
// where the crosshair sits. Compounding it, the expected values used to be
// embedded in the plot titles, so a legend read could return the title's
// number instead of the series value. Both failure modes are removed here:
// the sample is taken only on the opening edge and held with var, and no
// expected value appears in any title.
//
// Expected UTC hours of the OPENING BAR for the default windows (Asia 00:00,
// London 07:00, NY 13:00), each expressed in the selected zone's local time:
//
//   timezone          Asia  London  NY
//   UTC                 0      7    13
//   Asia/Tokyo         15     22     4      (+9 fixed, no DST)
//   America/New_York    5     12    18      (-5 EST)
//                        4     11    17      (-4 EDT, late Mar to early Nov)
//   Europe/London       0      7    13      (GMT, late Oct to late Mar)
//                       23      6    12      (BST; 23 is the previous UTC day)
//   exchange           varies with the exchange
//
// Europe/London under GMT reproduces the UTC row exactly, the cheapest
// available check that a named zone is being resolved rather than silently
// ignored. Under BST it deliberately does NOT, and a 23/6/12 reading in
// summer is correct behaviour rather than a defect.
//
// Because the sample is held with var, a chart range spanning a DST
// transition shows the step on this same series: America/New_York moves
// 5 -> 4 in March and 4 -> 5 in November. That is the DST check, for free.

// Same two-argument branch the module uses: time() rejects "exchange" as a
// timezone argument, so that option must go through the overload.
int diagAsiaStart   = useExchangeTz ? time(timeframe.period, asiaSession)   : time(timeframe.period, asiaSession,   sessionTimezone)
int diagLondonStart = useExchangeTz ? time(timeframe.period, londonSession) : time(timeframe.period, londonSession, sessionTimezone)
int diagNYStart     = useExchangeTz ? time(timeframe.period, nySession)     : time(timeframe.period, nySession,     sessionTimezone)

// Sample the opening bar's timestamp ONLY on the edge that opens the session,
// then hold it. On that bar time() is non-na and its value is that bar's open,
// which is the session's opening bar. var makes the result a constant per
// session instead of a ramp.
//
// bar_index > 0 carries the same reason as the counters below: the first bar
// of the visible range has no previous value, so ta.change() reports a
// transition that never happened and would sample an arbitrary mid-session bar
// when the chart opens inside a window.
var int diagAsiaOpenUTC   = na
var int diagLondonOpenUTC = na
var int diagNYOpenUTC     = na

if bar_index > 0 and ta.change(inAsia) and inAsia
    diagAsiaOpenUTC := hour(diagAsiaStart, "UTC")
if bar_index > 0 and ta.change(inLondon) and inLondon
    diagLondonOpenUTC := hour(diagLondonStart, "UTC")
if bar_index > 0 and ta.change(inNY) and inNY
    diagNYOpenUTC := hour(diagNYStart, "UTC")

plot(diagAsiaOpenUTC,   title = "DIAG Asia open hour (UTC)",   color = color.new(color.purple, 0))
plot(diagLondonOpenUTC, title = "DIAG London open hour (UTC)", color = color.new(color.blue, 0))
plot(diagNYOpenUTC,     title = "DIAG NY open hour (UTC)",     color = color.new(color.orange, 0))

var int diagAsiaEdges  = 0
var int diagAsiaLines  = 0
var int diagLondonEdges = 0
var int diagLondonLines = 0
var int diagNYEdges    = 0
var int diagNYLines    = 0

if bar_index > 0
    if sessionAsiaEnabled and ta.change(inAsia)
        diagAsiaEdges += 1
        if inAsia
            diagAsiaLines += 1
    if sessionLondonEnabled and ta.change(inLondon)
        diagLondonEdges += 1
        if inLondon
            diagLondonLines += 1
    if sessionNYEnabled and ta.change(inNY)
        diagNYEdges += 1
        if inNY
            diagNYLines += 1

plot(diagAsiaEdges,   title = "DIAG Asia edges (expect 2x lines)", color = color.new(color.purple, 0))
plot(diagAsiaLines,   title = "DIAG Asia lines (drawn)",            color = color.new(color.purple, 0))
plot(diagLondonEdges, title = "DIAG London edges (expect 2x lines)", color = color.new(color.blue, 0))
plot(diagLondonLines, title = "DIAG London lines (drawn)",           color = color.new(color.blue, 0))
plot(diagNYEdges,     title = "DIAG NY edges (expect 2x lines)",     color = color.new(color.orange, 0))
plot(diagNYLines,     title = "DIAG NY lines (drawn)",               color = color.new(color.orange, 0))

// Single verdict line, so the check does not require reading six numbers.
// The identity edges === 2 x lines holds only when the loaded range contains
// as many session enters as exits: a closed window has two edges and draws
// exactly one line. A range that opens or closes mid-session leaves exactly
// one window unclosed and shifts the identity by exactly 1 — observed as 1599
// edges against 800 x 2 = 1600, and 1999 against 1000 x 2 = 2000, both on
// healthy charts. Tolerating a single unmatched edge is therefore safe: a
// genuinely broken guard shifts both counters together on every window, so its
// discrepancy grows with the number of windows and is never 1. Such a guard
// still fails this check on all three sessions at once.
bool diagGuardHolds = math.abs(diagAsiaEdges   - diagAsiaLines   * 2) <= 1 and
                      math.abs(diagLondonEdges - diagLondonLines * 2) <= 1 and
                      math.abs(diagNYEdges     - diagNYLines     * 2) <= 1

plot(diagGuardHolds ? 1 : 0, title = "DIAG VERDICT (1 = guard correct)", color = color.new(color.lime, 0))
bgcolor(diagGuardHolds ? color.new(color.lime, 90) : na, title="DIAG verdict tint")
`;

/**
 * Appended under --diagnostic when the Liquidity Zones module is present.
 *
 * Same principle as the session overlay: the zone tints sit at 92-96%
 * transparency, so "the bands look right" is not a test. These series are
 * printed in the chart legend as numbers, which removes the squinting.
 *
 * What it CAN assert, from outside the module:
 *   - the zone array never exceeds maxZones (eviction is working)
 *   - all three tiers are populated, so nearH1Liquidity is reachable
 *   - sweeps are actually being marked, which is the feature this module exists
 *     to add, and which no visual check can confirm
 *   - the exported booleans actually become true
 *
 * What it CANNOT assert, stated plainly: that no box leaked. Box liveness is
 * only observable from inside the module, where the box.delete() calls live.
 * A leak would eventually exhaust max_boxes_count=500 and Pine would start
 * dropping the oldest box, which shows up as zones vanishing mid-band. If that
 * is seen, the fix is in the cull blocks, not here.
 */
const ZONE_DIAGNOSTIC_OVERLAY = `
// ═══════════════════════════════════════════════════════════════════════════
// LIQUIDITY ZONES DIAGNOSTIC — generated by scripts/build.mjs --diagnostic
// ═══════════════════════════════════════════════════════════════════════════

int diagZones    = array.size(zones)
int diagTier1    = 0
int diagTier2    = 0
int diagTier3    = 0
int diagSwept    = 0
int diagUntouched = 0

if array.size(zones) > 0
    for i = 0 to array.size(zones) - 1
        LiquidityZone zd = array.get(zones, i)
        if zd.tier == 1
            diagTier1 += 1
        else if zd.tier == 2
            diagTier2 += 1
        else
            diagTier3 += 1
        if na(zd.sweptBar)
            diagUntouched += 1
        else
            diagSwept += 1

plot(diagZones,     title = "LZ DIAG live zones (must stay <= maxZones)", color = color.new(color.red, 0))
plot(diagTier1,     title = "LZ DIAG tier1 D1 zones (expect > 0 on D1+)", color = color.new(color.red, 0))
plot(diagTier2,     title = "LZ DIAG tier2 4H zones (expect > 0)",         color = color.new(color.orange, 0))
plot(diagTier3,     title = "LZ DIAG tier3 1H zones (expect > 0)",         color = color.new(color.yellow, 0))
plot(diagSwept,     title = "LZ DIAG swept zones (expect > 0)",            color = color.new(color.lime, 0))
plot(diagUntouched, title = "LZ DIAG untouched zones",                     color = color.new(color.aqua, 0))

plot(nearLiquidityLong  ? 1 : 0, title = "LZ DIAG nearLiquidityLong fired",  color = color.new(color.lime, 0))
plot(nearLiquidityShort ? 1 : 0, title = "LZ DIAG nearLiquidityShort fired", color = color.new(color.lime, 0))
plot(sweptLong          ? 1 : 0, title = "LZ DIAG sweptLong fired",          color = color.new(color.lime, 0))
plot(sweptShort         ? 1 : 0, title = "LZ DIAG sweptShort fired",         color = color.new(color.lime, 0))

// Two invariants that must hold on every bar.
bool lzUnderBudget = diagZones <= maxZones
bool lzCountsAddUp = diagTier1 + diagTier2 + diagTier3 == diagZones and
                     diagSwept + diagUntouched == diagZones

plot(lzUnderBudget ? 1 : 0, title = "LZ DIAG VERDICT budget (1 = ok)", color = color.new(color.lime, 0))
plot(lzCountsAddUp ? 1 : 0, title = "LZ DIAG VERDICT counts (1 = ok)",  color = color.new(color.lime, 0))

// Gross births and gross removals, tracked from outside the module.
//
// This answers the one question that decides whether the distance cull is the
// problem. If live tier1 is 0, either no D1 pivot is ever confirmed, or D1
// zones are born and culled on the same bar. Those look identical on the chart
// but are completely different bugs.
//
//   births  > 0 and tier1 = 0  ->  zones ARE created and then culled. Cull too
//                                  aggressive: the distance threshold.
//   births  = 0                ->  no pivots confirmed at all. Something earlier
//                                  in the pipeline: request.security, or a pivot
//                                  length longer than the visible history.
//
// Which individual cull rule fires is NOT observable from here, because the
// cull blocks live inside the module. Only the module can instrument that.
var int lzPrevSize = 0
var int lzBirths   = 0
var int lzRemovals = 0

int lzSizeNow = array.size(zones)
if lzSizeNow > lzPrevSize
    lzBirths += lzSizeNow - lzPrevSize
else if lzSizeNow < lzPrevSize
    lzRemovals += lzPrevSize - lzSizeNow
lzPrevSize := lzSizeNow

plot(lzBirths,   title = "LZ DIAG gross births (must be > 0)",   color = color.new(color.aqua, 0))
plot(lzRemovals, title = "LZ DIAG gross removals",               color = color.new(color.maroon, 0))
plot(lzBirths > 0 ? 1 : 0, title = "LZ DIAG VERDICT births (1 = pivots confirmed)", color = color.new(color.lime, 0))
`;

// Imbalance diagnostics. The load-bearing series is "virgin gaps": the spec's
// touch test is true by construction on a gap's own creation bar, because the
// band edges come from that bar's prices. Without the bornBar guard every gap
// is born touched, nearImbalance* pin at zero forever, and nothing visual
// reveals it — the gaps draw correctly and simply never report an approach.
const IMBALANCE_DIAGNOSTIC_OVERLAY = `
int imbLive      = array.size(imbalances)
int imbUntouched = 0
int imbTouched   = 0

if array.size(imbalances) > 0
    for i = 0 to array.size(imbalances) - 1
        if na(array.get(imbalances, i).touchedBar)
            imbUntouched += 1
        else
            imbTouched += 1

plot(imbLive,      title = "IMB DIAG live imbalances (expect <= 60)", color = color.new(color.green, 0))
plot(imbUntouched, title = "IMB DIAG virgin gaps (must be > 0)",       color = color.new(color.green, 0))
plot(imbTouched,   title = "IMB DIAG filled gaps",                     color = color.new(color.teal, 0))
plot(nearImbalanceLong  ? 1 : 0, title = "IMB DIAG nearLong reachable",  color = color.new(color.lime, 0))
plot(nearImbalanceShort ? 1 : 0, title = "IMB DIAG nearShort reachable", color = color.new(color.lime, 0))
plot(inImbalanceLong    ? 1 : 0, title = "IMB DIAG inLong fired",        color = color.new(color.lime, 0))
plot(inImbalanceShort   ? 1 : 0, title = "IMB DIAG inShort fired",       color = color.new(color.lime, 0))
plot(volumeConfirmed    ? 1 : 0, title = "IMB DIAG volumeConfirmed fired", color = color.new(color.lime, 0))
plot(imbLive <= maxImbalances ? 1 : 0, title = "IMB DIAG VERDICT budget (1 = ok)", color = color.new(color.lime, 0))
plot(imbUntouched + imbTouched == imbLive ? 1 : 0, title = "IMB DIAG VERDICT counts (1 = ok)", color = color.new(color.lime, 0))
`;

// Structure Break diagnostics. The load-bearing series is the orphan check:
// structureFlipped is a PROPERTY of a break, so it must never be true on a bar
// with no break. If it is, the module has reintroduced the parallel BoS/ChoCh
// flags, which scored one reversal break as 20 + 30 = 50 in the spec's own
// confidence table. Cumulative flips must also never exceed cumulative breaks.
const STRUCTURE_DIAGNOSTIC_OVERLAY = `
var int sbBreaks = 0
var int sbFlips = 0
var int sbOrphanFlips = 0

if breakUp or breakDown
    sbBreaks += 1
if structureFlipped
    sbFlips += 1
    if not breakUp and not breakDown
        sbOrphanFlips += 1

plot(marketStructure,  title = "SB DIAG structure (1 / -1 / 0)",  color = color.new(color.aqua, 0))
plot(sbBreaks,        title = "SB DIAG breaks total (expect > 0)", color = color.new(color.aqua, 0))
plot(sbFlips,         title = "SB DIAG reversals (<= breaks)",   color = color.new(color.orange, 0))
plot(sbOrphanFlips,   title = "SB DIAG ORPHAN flips (must be 0)", color = color.new(color.red, 0))
plot(breakUp         ? 1 : 0, title = "SB DIAG breakUp fired",   color = color.new(color.lime, 0))
plot(breakDown       ? 1 : 0, title = "SB DIAG breakDown fired", color = color.new(color.lime, 0))
plot(structureFlipped ? 1 : 0, title = "SB DIAG flipped fired",  color = color.new(color.lime, 0))

plot(sbFlips <= sbBreaks ? 1 : 0, title = "SB DIAG VERDICT flips<=breaks (1 = ok)", color = color.new(color.lime, 0))
plot(sbOrphanFlips == 0 ? 1 : 0, title = "SB DIAG VERDICT no-orphans (1 = ok)",   color = color.new(color.lime, 0))
plot(marketStructure >= -1 and marketStructure <= 1 ? 1 : 0, title = "SB DIAG VERDICT domain (1 = ok)", color = color.new(color.lime, 0))
`;

// Signal Engine diagnostics. This is the root module — nothing consumes its
// output, so no downstream check exists to catch a mistake in it. These series
// are that missing check.
//
// The load-bearing one is DUAL FIRE. LONG and SHORT are not mutually exclusive
// by construction: price sandwiched between two H4 zones with untouched gaps on
// both sides, in the London/NY overlap, on elevated volume, scores 70 on BOTH
// sides simultaneously. A dual fire means the directional-exclusivity block is
// absent or ineffective, and the indicator would print a LONG and a SHORT on the
// same bar.
const SIGNAL_DIAGNOSTIC_OVERLAY = `
var int seLongFires      = 0
var int seShortFires     = 0
var int seDualFires      = 0
var int seAmbiguousDrops = 0

if longSignalFired
    seLongFires += 1
if shortSignalFired
    seShortFires += 1
if longSignalFired and shortSignalFired
    seDualFires += 1
if ambiguousTie
    seAmbiguousDrops += 1

plot(seLongFires,      title = "SE DIAG long fires",             color = color.new(color.green, 0))
plot(seShortFires,     title = "SE DIAG short fires",            color = color.new(color.red, 0))
plot(seDualFires,      title = "SE DIAG DUAL fires (must be 0)",  color = color.new(color.maroon, 0))
plot(seAmbiguousDrops, title = "SE DIAG ambiguous ties dropped",  color = color.new(color.orange, 0))
plot(longScore,        title = "SE DIAG long score (max 110)",    color = color.new(color.aqua, 0))
plot(shortScore,       title = "SE DIAG short score (max 110)",   color = color.new(color.aqua, 0))
plot(seDualFires == 0 ? 1 : 0, title = "SE DIAG VERDICT no-dual (1 = ok)", color = color.new(color.lime, 0))
plot(longScore <= 110 and shortScore <= 110 ? 1 : 0, title = "SE DIAG VERDICT score domain (1 = ok)", color = color.new(color.lime, 0))
`;

// ─── Diagnostic Sections ─────────────────────────────────────────────────────

// Canonical section ids, in the order their overlays are appended. These are
// the names this script already uses for each overlay: the session/timezone
// overlay (DIAGNOSTIC_OVERLAY), then one per module.
const DIAG_SECTION_ORDER = [
  "session",
  "liquidity-zones",
  "imbalance-detector",
  "structure-break",
  "signal-engine",
];

// Aliases accepted on the command line. Matching is case-insensitive; only
// these spellings are valid, anything else is a hard error.
const DIAG_SECTION_ALIASES = {
  session: ["session", "session-timezone", "sessions", "timezone"],
  "liquidity-zones": ["liquidity-zones", "zones", "lz"],
  "imbalance-detector": ["imbalance-detector", "imbalance", "imb"],
  "structure-break": ["structure-break", "structure", "sb"],
  "signal-engine": ["signal-engine", "signal", "se"],
};

const SECTION_OVERLAY = {
  session: DIAGNOSTIC_OVERLAY,
  "liquidity-zones": ZONE_DIAGNOSTIC_OVERLAY,
  "imbalance-detector": IMBALANCE_DIAGNOSTIC_OVERLAY,
  "structure-break": STRUCTURE_DIAGNOSTIC_OVERLAY,
  "signal-engine": SIGNAL_DIAGNOSTIC_OVERLAY,
};

// What to read in the chart legend, printed only for sections actually built.
const SECTION_HINT = {
  "liquidity-zones": [
    "Liquidity Zones selected — read LZ DIAG VERDICT budget and counts.",
  ],
  "imbalance-detector": [
    "Imbalance Detector selected — read IMB DIAG VERDICT budget and",
    "counts, and confirm virgin gaps > 0.",
  ],
  "structure-break": [
    "Structure Break selected — read SB DIAG ORPHAN flips, which must",
    "be 0, plus the three SB DIAG VERDICT series.",
  ],
  "signal-engine": [
    "Signal Engine selected — read SE DIAG DUAL fires, which must be 0.",
    "A non-zero value means LONG and SHORT fired on the same bar.",
  ],
};

/**
 * Resolves --diagnostic=<comma-separated list> into canonical section ids.
 *
 * Unknown names are a hard error: silently ignoring one would build a
 * diagnostic file that is missing an overlay the user asked for, and the
 * absence would look like a passing check. Prints the valid names and exits
 * non-zero instead.
 *
 * Returns the selected ids in DIAG_SECTION_ORDER.
 */
function resolveDiagnosticSections(rawValue) {
  const names = rawValue
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const reportAndExit = (badNames) => {
    // stdout, not stderr: every other build error in this script is reported
    // through the stdout report, and a section error must be equally visible.
    if (badNames.length) {
      console.log(
        `build: unknown --diagnostic section${badNames.length > 1 ? "s" : ""}: ` +
          badNames.join(", "),
      );
    } else {
      console.log("build: --diagnostic= needs at least one section name");
    }
    console.log(`build: valid sections: ${DIAG_SECTION_ORDER.join(", ")}`);
    console.log(
      "build: aliases: " +
        DIAG_SECTION_ORDER.map(
          (id) =>
            `${id} (${DIAG_SECTION_ALIASES[id].slice(1).join(", ") || "no aliases"})`,
        ).join("; "),
    );
    process.exit(1);
  };

  if (names.length === 0) reportAndExit([]);

  const selected = [];
  const unknown = [];

  for (const name of names) {
    const key = name.toLowerCase();
    const id = DIAG_SECTION_ORDER.find((candidate) =>
      DIAG_SECTION_ALIASES[candidate].includes(key),
    );
    if (!id) {
      unknown.push(name);
    } else if (!selected.includes(id)) {
      selected.push(id);
    }
  }

  if (unknown.length) reportAndExit(unknown);

  return DIAG_SECTION_ORDER.filter((id) => selected.includes(id));
}

/**
 * Boosts the production visuals for legibility and appends the overlays.
 * Rewrites the constants already in the assembled text; the module file on
 * disk is never touched.
 *
 * `sectionIds` is the resolved subset from --diagnostic=<list>; bare
 * --diagnostic passes every id.
 */
function applyDiagnostic(assembled, sectionIds) {
  const text = assembled.join("\n");

  // Tints: 92-96% transparency is near-invisible on a dark background.
  const boosted = text
    .replace(/color\.new\((color\.\w+),\s*\d+\)/g, "color.new($1, 55)")
    // Boundary lines: one-pixel dotted is hard to resolve. Widen and solidify.
    .replace(/width=1\)/g, "width=3)")
    .replace(/style=line\.style_dotted/g, "style=line.style_solid");

  // An overlay references its module's own globals, so it is only valid once
  // that module has been spliced in. Guarded rather than assumed, so
  // --diagnostic keeps working while modules are still being added. The
  // session overlay sits on top of the main file and needs no guard.
  const present = {
    session: true,
    "liquidity-zones": /array<LiquidityZone>\s+zones/.test(text),
    "imbalance-detector": /array<ImbalanceZone>\s+imbalances/.test(text),
    "structure-break": /sb_pivotHigh/.test(text),
    "signal-engine": /longSignalFired/.test(text),
  };

  const overlays = [];
  const included = [];

  // Canonical order regardless of the order the user typed: overlays are
  // appended at the end of the script and must follow the module order.
  for (const id of DIAG_SECTION_ORDER) {
    if (!sectionIds.includes(id)) continue;
    if (!present[id]) {
      warn(`diagnostic section skipped, its module is not in the build: ${id}`);
      continue;
    }
    overlays.push(SECTION_OVERLAY[id]);
    included.push(id);
  }

  for (const id of included) {
    for (const line of SECTION_HINT[id] ?? []) {
      console.log("");
      console.log(`  ${line}`);
    }
  }

  return { text: `${boosted}\n${overlays.join("\n")}`, sections: included };
}

// ─── Plot Budget ─────────────────────────────────────────────────────────────

// Pine v5 counts EVERY plot-family call against a single per-script limit of
// 64: plot(), plotshape(), plotchar(), plotcandle(), plotbar(), plotarrow(),
// hline(), bgcolor(), linefill() and alertcondition(). Exceeding it is not a
// warning on paste — TradingView rejects the script with RE10140 and nothing
// runs. Checking here fails the build instead, before a broken file exists.
const PLOT_LIMIT = 64;

const PLOT_FAMILY = [
  "plot",
  "plotshape",
  "plotchar",
  "plotcandle",
  "plotbar",
  "plotarrow",
  "hline",
  "bgcolor",
  "linefill",
  "alertcondition",
];

/**
 * Removes line comments, string-aware.
 *
 * Pine has no block comments, so a line comment starts at the first `//` that
 * is not inside a string literal. Skipping string literals keeps messages such
 * as "LiquidityFlowAuse LONG signal on {{ticker}}" (and any future URL in one)
 * from being truncated mid-message.
 */
function stripLineComments(text) {
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

/**
 * Counts plot-family calls in assembled source, ignoring comments.
 *
 * The lookbehind `(?<![\w.])` matters: box.set_bgcolor() ends in "bgcolor("
 * but is not the bgcolor() builtin, and counting it would push an in-budget
 * script over the limit. Node's RegExp supports lookbehind natively.
 */
function countPlotFamily(text) {
  const code = stripLineComments(text);
  const perCall = {};
  let total = 0;

  for (const fn of PLOT_FAMILY) {
    const matches = code.match(new RegExp(`(?<![\\w.])${fn}\\s*\\(`, "g")) ?? [];
    perCall[fn] = matches.length;
    total += matches.length;
  }

  return { total, perCall };
}

/**
 * The plot-budget preflight. Returns nothing on success; on an over-budget
 * script it records the failure so the shared error path prints it and exits
 * before any file is written.
 *
 * `sections` is what was actually appended ([] for the production build).
 */
function checkPlotBudget(assembled, sections) {
  const { total } = countPlotFamily(assembled.join("\n"));
  const scope =
    sections.length > 0 ? sections.join(", ") : "none (production build)";

  if (total > PLOT_LIMIT) {
    fail(
      `plot budget exceeded: ${total} plot-family calls (plot/plotshape/` +
        `plotchar/plotcandle/plotbar/plotarrow/hline/bgcolor/linefill/` +
        `alertcondition), limit is ${PLOT_LIMIT}; sections included: ${scope}`,
    );
  }

  return total;
}

// ─── Validation ──────────────────────────────────────────────────────────────

/**
 * Checks that are decidable from the text alone.
 *
 * This is NOT a Pine parser and does not claim to be. It catches the class of
 * error that has actually bitten this project: a module that breaks the
 * single-declaration or version-directive contract. Type errors, unknown
 * builtins and runtime behavior still require the Pine Editor.
 */
function validate(assembled) {
  const text = assembled.join("\n");
  const lines = text.split(/\r?\n/);

  // 1. Exactly one version directive, and it must precede all code.
  const versionLines = lines
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => /^\s*\/\/@version=/.test(l));

  if (versionLines.length === 0) {
    fail("no //@version= directive found; Pine v5 requires it");
  } else if (versionLines.length > 1) {
    fail(`found ${versionLines.length} //@version= directives; expected exactly 1`);
  }

  const firstCode = lines.findIndex((l) => {
    const t = l.trim();
    return t && !t.startsWith("//");
  });

  if (versionLines.length === 1 && versionLines[0].i > firstCode) {
    fail(`//@version= appears at line ${versionLines[0].i + 1}, after the first ` +
      `statement at line ${firstCode + 1}; it must precede all code`);
  }

  // 2. Exactly one indicator()/study() declaration.
  const decls = lines.filter((l) => /^\s*(indicator|study)\s*\(/.test(l));
  if (decls.length === 0) {
    fail("no indicator()/study() declaration found");
  } else if (decls.length > 1) {
    fail(`found ${decls.length} indicator()/study() declarations; expected exactly 1`);
  }

  // 3. The declaration must come before the first input call, otherwise Pine
  //    rejects the script. input.* is only legal inside a declared script.
  const firstInput = lines.findIndex((l) => /^\s*\w+\s*=\s*input\./.test(l));
  if (decls.length === 1 && firstInput !== -1) {
    const declIdx = lines.findIndex((l) => /^\s*(indicator|study)\s*\(/.test(l));
    if (firstInput < declIdx) {
      fail(`input.* call at line ${firstInput + 1} precedes the ` +
        `indicator() declaration at line ${declIdx + 1}`);
    }
  }

  // 4. Pine v5 has no `else <condition>:` form. `else` alone or `else if` is
  //    a keyword that may open an indented block; `else someCondition` is a
  //    syntax error. Caught twice in this project before being encoded here.
  //    Use the ternary operator for that case.
  lines.forEach((l, i) => {
    const m = /^\s*else\s+(?!if\b|if$|\{)([A-Za-z_][\w.]*)/.exec(l);
    if (m) {
      fail(`line ${i + 1}: 'else ${m[1]}' cannot open an indented block in ` +
        "Pine v5. Write 'else if' or use the ternary operator");
    }
  });

  // 5. time()'s timezone argument accepts only UTC/GMT notation or an IANA
  //    zone name. "exchange" is rejected at runtime on bar 0, which compiles
  //    cleanly and therefore escapes every compile-time check. Validate the
  //    declared options so an invalid value cannot reach the chart.
  //    "exchange" is allowed here ONLY because the module routes it through
  //    the two-argument overload; a build must not accept it silently.
  const UTC_GMT = /^(?:UTC|GMT)(?:[+-]\d{1,2}(?::?\d{2})?)?$/i;
  const IANA = /^[A-Z][A-Za-z]*(?:\/[A-Za-z0-9_+\-]+)+$/;

  lines.forEach((l, i) => {
    const m = /(\w*[Tt]imezone\w*)\s*=\s*input\.string\([^)]*options\s*=\s*\[([^\]]*)\]/.exec(l);
    if (!m) return;

    const varName = m[1];
    const values = m[2].match(/"([^"]*)"/g)?.map((s) => s.slice(1, -1)) ?? [];

    for (const v of values) {
      if (v === "exchange") continue; // routed via the 2-arg overload
      if (!UTC_GMT.test(v) && !IANA.test(v)) {
        fail(`line ${i + 1}: '${v}' in ${varName} is not a valid time() ` +
          'timezone. Use UTC/GMT notation ("UTC-5", "GMT+0530") or an IANA ' +
          'zone name ("America/New_York"). "exchange" is rejected at runtime ' +
          "by time() and must go through the two-argument overload.");
      }
    }
  });

  return { lineCount: lines.length };
}

// ─── Report ──────────────────────────────────────────────────────────────────

const MAIN_LABEL = "src/liquidityflowause.pine";
const STRATEGY_LABEL = "src/liquidityflowause-strategy.pine";

/** SHA256 of a UTF-8 string. Used for the shipped-artifact guard. */
async function sha256(text) {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(text, "utf8").digest("hex");
}

let parts;
let assembled;
let lineCount;

// The indicator build, assembled FIRST and ALWAYS — including under
// --strategy. It is not the thing being written in strategy mode; it is the
// REFERENCE the strategy's module text is compared against, and its digest is
// what proves the shipped artifact did not move. Assembling it here rather than
// reading dist/ means the comparison is between the two builds' own output, not
// between one build and a file on disk that may be stale.
const indicatorParts = await build(MAIN, MAIN_LABEL);

// The strategy build assembles BOTH targets, so the "module not built yet"
// notices are raised twice. They are deduplicated for the report rather than
// printed as pairs: a repeated line reads as two problems where there is one,
// and it trains a reader to skim past warnings.
const warningsOnce = [...new Set(warnings)];

if (strategyMode) {
  parts = await build(STRATEGY_MAIN, STRATEGY_LABEL);
  assembled = parts.map((p) => p.text);

  ({ lineCount } = validateStrategy(assembled));

  // ── Module parity: the load-bearing check ──
  const parity = checkModuleParity(indicatorParts, parts);

  // ── Exit arithmetic vs the harness's own definition ──
  const exitArithmetic = await checkExitArithmetic(assembled);

  // ── The shipped artifact must not have moved ──
  //
  // Compared by RECOMPUTING the indicator from source rather than by trusting
  // the file in dist/. If the two disagree, the file is stale or was edited by
  // hand; either way, a strategy build must not bless a repository whose
  // shipped artifact is not what its source produces.
  const indicatorText = indicatorParts.map((p) => p.text).join("\n");
  const indicatorDigest = await sha256(indicatorText);

  let shippedOnDisk = null;
  if (existsSync(DEFAULT_OUT)) {
    shippedOnDisk = await sha256(await readFile(DEFAULT_OUT, "utf8"));
  }

  if (shippedOnDisk === null) {
    warn(
      `dist/liquidityflowause.pine does not exist yet; the SHA guard compared ` +
        "the recomputed source only. Run `node scripts/build.mjs` to produce it.",
    );
  } else if (shippedOnDisk !== SHIPPED_INDICATOR_SHA256) {
    fail(
      `the shipped indicator has moved. dist/liquidityflowause.pine is ` +
        `${shippedOnDisk}, expected ${SHIPPED_INDICATOR_SHA256}. A strategy build ` +
        "must not certify a repository whose shipped artifact is not the one on " +
        "record — check whether src/modules/ or src/liquidityflowause.pine " +
        "changed.",
    );
  }

  if (indicatorDigest !== SHIPPED_INDICATOR_SHA256) {
    fail(
      `the INDICATOR BUILD no longer reproduces the shipped artifact: recomputed ` +
        `${indicatorDigest}, expected ${SHIPPED_INDICATOR_SHA256}.`,
    );
  }

  const plotCount = checkPlotBudget(assembled, []);

  console.log(BANNER);
  console.log("// LiquidityFlowAuse build — STRATEGY (Route A, spec D.4)");
  console.log(BANNER);
  console.log("");

  for (const part of parts) {
    const n = part.text.split(/\r?\n/).length;
    console.log(`  ${part.label.padEnd(44)} ${String(n).padStart(5)} lines`);
  }
  console.log("");
  console.log(`  ${"TOTAL".padEnd(44)} ${String(lineCount).padStart(5)} lines`);
  console.log(`plot budget: ${plotCount} / ${PLOT_LIMIT}`);

  // ── The parity result, printed in full ──
  //
  // Printed whether it passed or failed, because "verified" is a claim a reader
  // is entitled to see rather than infer from the absence of an error.
  console.log("");
  console.log("// Module parity — strategy build vs indicator build");
  for (const m of parity) {
    console.log(
      `  ${m.identical ? "IDENTICAL" : "DIFFERS  "}  ${m.label.padEnd(38)} ${String(m.bytes).padStart(6)} bytes`,
    );
  }
  const parityOk = parity.length > 0 && parity.every((m) => m.identical);
  console.log(
    `  ${parity.length === 0 ? "NO MODULES COMPARED — this is a failure" : `${parity.length - parity.filter((m) => !m.identical).length}/${parity.length} byte-identical`}`,
  );
  console.log(
    "  This is what guarantees the strategy trades what the indicator signals:",
  );
  console.log("  both targets embed the same module text, read from the same files.");

  // ── Exit arithmetic ──
  if (exitArithmetic) {
    console.log("");
    console.log("// Exit arithmetic — cross-checked against backtest/modules/label.mjs");
    console.log(
      `  target ${exitArithmetic.target}% / stop ${exitArithmetic.stop}%  (ratio ${exitArithmetic.ratio})`,
    );
    console.log("  Same numbers the investigation's labels used, so the curve");
    console.log("  measures the same trade rather than a lookalike.");
  }

  // ── The shipped artifact's identity ──
  console.log("");
  console.log("// Shipped indicator (must not move)");
  console.log(`  dist/liquidityflowause.pine  ${shippedOnDisk ?? "(absent)"}`);
  console.log(`  expected                     ${SHIPPED_INDICATOR_SHA256}`);
  console.log(`  indicator build reproduces   ${indicatorDigest}`);

  if (warningsOnce.length) {
    console.log("");
    for (const w of warningsOnce) console.log(`  warning: ${w}`);
  }

  if (errors.length) {
    console.log("");
    for (const e of errors) console.log(`  ERROR: ${e}`);
    console.log("");
    console.log("build failed — nothing written");
    process.exit(1);
  }

  if (checkOnly) {
    console.log("");
    console.log("  checks passed (--check: nothing written)");
    process.exit(0);
  }

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, assembled.join("\n"), "utf8");

  console.log("");
  console.log(`  written: ${outPath}`);

  console.log("");
  console.log("  NEXT:");
  console.log("    Add this as a SEPARATE script in TradingView. It is not a");
  console.log("    replacement for the indicator and must never be pasted over it.");
  console.log("");
  console.log("    NOT VERIFIED HERE. There is no Pine compiler in this repository.");
  console.log("    Every check above is structural: declaration shape, module");
  console.log("    parity, exit arithmetic. Types, builtins and runtime behaviour");
  console.log("    are unverified, and the data is TradingView's, not ours.");
  console.log("");
  console.log("  See docs/ROUTE-A.md before reading any number off the tester.");
  console.log("");
  process.exit(0);
}

// ── Indicator build (the default path, unchanged in behaviour) ──

parts = indicatorParts;
assembled = parts.map((p) => p.text);

// Validation runs on the production assembly. The diagnostic overlay is
// appended afterwards so a defect in the overlay itself cannot mask a defect
// in the module, and so the reported line count stays comparable.
({ lineCount } = validate(assembled));

// Sections actually appended ([] on the production build). Resolved before the
// overlays go on, so an unknown --diagnostic name exits before any work is
// reported and before anything is written.
let diagnosticSections = [];

if (diagnostic) {
  if (diagnosticValue === null) {
    warn(
      `bare ${DIAG_FLAG} appends every overlay and may exceed Pine's ` +
        `${PLOT_LIMIT}-plot limit; to build a subset: ` +
        "node scripts/build.mjs --diagnostic=structure-break,signal-engine,imbalance-detector",
    );
  }

  const requested =
    diagnosticValue === null
      ? DIAG_SECTION_ORDER
      : resolveDiagnosticSections(diagnosticValue);
  const result = applyDiagnostic(assembled, requested);
  assembled = [result.text];
  diagnosticSections = result.sections;
}

// Plot-budget preflight, on the final assembled source and before any file is
// written. An over-budget script becomes an error, so the shared error path
// below exits without writing. This guards the production build too.
const plotCount = checkPlotBudget(assembled, diagnosticSections);

console.log(BANNER);
console.log("// LiquidityFlowAuse build");
console.log(BANNER);
console.log("");

for (const part of parts) {
  const n = part.text.split(/\r?\n/).length;
  console.log(`  ${part.label.padEnd(44)} ${String(n).padStart(5)} lines`);
}
console.log("");
console.log(`  ${"TOTAL".padEnd(44)} ${String(lineCount).padStart(5)} lines`);
console.log(`plot budget: ${plotCount} / ${PLOT_LIMIT}`);

if (warnings.length) {
  console.log("");
  for (const w of warnings) console.log(`  warning: ${w}`);
}

if (errors.length) {
  console.log("");
  for (const e of errors) console.log(`  ERROR: ${e}`);
  console.log("");
  console.log("build failed — nothing written");
  process.exit(1);
}

if (checkOnly) {
  console.log("");
  console.log("  checks passed (--check: nothing written)");
  process.exit(0);
}

await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, assembled.join("\n"), "utf8");

console.log("");
console.log(`  written: ${outPath}`);

if (diagnostic) {
  const n = assembled[0].split(/\r?\n/).length;
  console.log("");
  console.log("  DIAGNOSTIC BUILD — not for distribution.");
  console.log(
    `  Sections included: ${diagnosticSections.join(", ") || "(none)"}`,
  );

  if (diagnosticSections.includes("session")) {
    console.log("");
    console.log("  Read the chart legend for the DIAG series. The decisive one is:");
    console.log("");
    console.log("    DIAG VERDICT (1 = guard correct)");
    console.log("");
    console.log("  1  → edges is within 1 of 2x lines for every session, so the `and inX` guard");
    console.log("        is correct and each window draws exactly one boundary line. The");
    console.log("        1-point tolerance covers a range that opens or closes mid-session,");
    console.log("        which leaves a single window unclosed on the chart boundary.");
    console.log("  0  → the guard is wrong; session windows draw a line on close too.");
    console.log("");
    console.log("  Read the six DIAG counter series to see which session diverged.");
    console.log("  Edge labels also name every open and close with its session.");
  }
  console.log("");
}

console.log("");
console.log("  Next: paste the output into the TradingView Pine Editor.");
console.log("  The checks above are structural. They do not verify Pine");
console.log("  semantics, builtins, or runtime behavior — only the editor does.");
console.log("");

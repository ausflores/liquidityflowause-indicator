// ============================================================================
// LiquidityFlowAuse — Shared Assembly (Route A)
// ----------------------------------------------------------------------------
// Why this file exists: the indicator and the strategy variant are assembled
// from the SAME module bytes, and that sameness is an ASSERTED property rather
// than an intention. The only way to assert it is to have one place that
// produces the module text and one place that compares two sets of it.
//
// It is a module and not part of build.mjs for exactly one reason: the smoke
// suite must be able to call the parity assertion with a DELIBERATELY divergent
// pair and watch it fail. A check that can only ever be exercised against the
// real build cannot prove it is capable of failing, and a parity assertion that
// has never been seen to fail is not known to work — only known not to have
// been triggered.
//
// It is imported by scripts/build.mjs. It is not imported by anything under
// backtest/modules/, so the measurement harness still cannot reach the Pine.
// ============================================================================

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * ORDER IS SEMANTIC. Pine v5 has no forward declarations: every input, const
 * and function must be declared before its first use. The documented order in
 * docs/technical-spec.md section 12.3 lists modules BEFORE the main file,
 * which cannot compile — //@version=5 and the script declaration must come
 * first.
 *
 * Both targets read this one list. There is deliberately no second list.
 */
export const SOURCES = [
  "src/lib/colors.pine",
  "src/lib/utils.pine",
  "src/lib/inputs.pine",
  "src/modules/liquidity-zones.pine",
  "src/modules/session-markers.pine",
  "src/modules/imbalance-detector.pine",
  "src/modules/structure-break.pine",
  "src/modules/signal-engine.pine",
];

/** The comment marker both main files use to declare their splice point. */
export const MARKER = "[CONCATENATION POINT]";

/**
 * Strips a module's entire header banner, prose included, plus blank edges.
 *
 * Each module opens with a decorative box comment describing itself. Once
 * concatenated, that box is misleading: it reads like a section of the
 * indicator but sits mid-file with no scope boundary.
 *
 * The WHOLE box is removed, not just its frame. An earlier version of this
 * docstring claimed the descriptive prose survived; the implementation never
 * did that, and the docstring was wrong rather than the code. The prose inside
 * the banner duplicates what the spec already documents, and the module body
 * carries its own section comments.
 *
 * The box cannot be matched by "lines until the first non-box character",
 * because the prose lines are inside it. It is delimited by its two rules of
 * '=' characters and ends at the closing rule.
 */
export function stripBanner(source) {
  const lines = source.split(/\r?\n/);

  // Opening rule: a comment line that is mostly '=' padding.
  const isRule = (l) => /^\/\/ ={10,}\s*$/.test(l);
  if (!isRule(lines[0] ?? "")) return source;

  // Closing rule: the next line of '=' padding.
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (isRule(lines[i])) {
      end = i;
      break;
    }
  }

  // No closing rule found: leave the file untouched rather than guess.
  if (end === -1) return source;

  return lines.slice(end + 1).join("\n").replace(/^\n+/, "");
}

/**
 * Reads the modules and returns the parts, in SOURCES order.
 *
 * Callbacks rather than direct error reporting, so this file does not own the
 * reporting policy: build.mjs routes a missing module to a warning and a
 * module carrying its own script declaration to a build error, and the smoke
 * suite wants both outcomes without a process exit.
 *
 * `onForbidden(rel)` fires when a module declares indicator()/study()/strategy().
 * Both indicators and strategies are refused, because the invariant is the same
 * for both targets: the main file owns the single declaration.
 *
 * @returns {Promise<Array<{label: string, module: boolean, text: string}>>}
 */
export async function readModuleParts(root, sources = SOURCES, hooks = {}) {
  const onMissing = hooks.onMissing ?? (() => {});
  const onForbidden = hooks.onForbidden ?? (() => {});
  const parts = [];

  for (const rel of sources) {
    const abs = join(root, rel);

    if (!existsSync(abs)) {
      onMissing(rel);
      continue;
    }

    const raw = await readFile(abs, "utf8");

    if (/^\s*(indicator|study|strategy)\s*\(/m.test(raw)) {
      onForbidden(rel);
      continue;
    }

    parts.push({ label: rel, module: true, text: stripBanner(raw).replace(/\n+$/, "\n") });
  }

  return parts;
}

/**
 * Asserts that the module text in ONE build is byte-identical to the module
 * text in the OTHER.
 *
 * This is the load-bearing check of the Route A design. The strategy is only
 * worth anything if it trades what the indicator signals, and the only thing
 * that makes that true is that both artifacts were concatenated from the same
 * module bytes in the same order. Asserting it is strictly stronger than
 * trusting the shared SOURCES array: it also catches a future second module
 * list, a build path that skips banner stripping on one target, or a transform
 * applied to only one of them.
 *
 * Returns its findings instead of throwing, and the CALLER decides what a
 * failure means. build.mjs turns a failure into a build error; the smoke suite
 * asserts that it reports one. A parity check that throws from inside a helper
 * could not be tested for the ability to fail.
 *
 * @returns {{ok: boolean, report: Array<{label, bytes, identical}>, errors: string[]}}
 */
export function assertModuleParity(indicatorParts, strategyParts) {
  const indicatorModules = (indicatorParts ?? []).filter((p) => p.module);
  const strategyModules = (strategyParts ?? []).filter((p) => p.module);

  const report = [];
  const errors = [];

  if (indicatorModules.length !== strategyModules.length) {
    errors.push(
      `module parity FAILED: the indicator build embeds ${indicatorModules.length} ` +
        `modules and the strategy build embeds ${strategyModules.length}. The two ` +
        "targets must be assembled from the same source list.",
    );
    return { ok: false, report, errors };
  }

  for (let i = 0; i < indicatorModules.length; i++) {
    const a = indicatorModules[i];
    const b = strategyModules[i];
    const same = a.label === b.label && a.text === b.text;

    report.push({ label: a.label, bytes: Buffer.byteLength(a.text, "utf8"), identical: same });

    if (a.label !== b.label) {
      errors.push(
        `module parity FAILED at position ${i}: the indicator build has ` +
          `"${a.label}" where the strategy build has "${b.label}".`,
      );
      continue;
    }

    if (a.text !== b.text) {
      const aLines = a.text.split("\n");
      const bLines = b.text.split("\n");
      const firstDiff = aLines.findIndex((line, idx) => line !== bLines[idx]);
      errors.push(
        `module parity FAILED for ${a.label}: the text embedded in the strategy ` +
          `build differs from the indicator build's, first at relative line ` +
          `${firstDiff === -1 ? aLines.length : firstDiff + 1}. The strategy would ` +
          "trade something the indicator does not.",
      );
    }
  }

  return { ok: report.length > 0 && report.every((m) => m.identical), report, errors };
}
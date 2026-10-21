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

import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * ORDER IS SEMANTIC. Pine v5 has no forward declarations: every input, const
 * and function must be declared before its first use. The main file therefore
 * comes FIRST — //@version=5 and the script declaration must precede all
 * code — and the modules follow in dependency order. The documented order in
 * docs/technical-spec.md section 12.3 matches this list exactly.
 *
 * Both targets read this one list. There is deliberately no second list.
 *
 * The list names files that EXIST. A declared module that is missing from
 * disk fails the build (see assertDeclaredModulesPresent), so this list
 * cannot promise a file that was never written.
 */
export const SOURCES = [
  "src/modules/liquidity-zones.pine",
  "src/modules/session-markers.pine",
  "src/modules/imbalance-detector.pine",
  "src/modules/structure-break.pine",
  "src/modules/signal-engine.pine",
];

/**
 * The two main source files. They are assembled, not spliced, so they are
 * NOT modules and must not appear in SOURCES.
 *
 * They are listed here rather than in build.mjs because the tree-completeness
 * check needs them to tell a stray module apart from a main file, and there
 * is exactly one place where that distinction should live.
 */
export const MAIN_SOURCE_FILES = [
  "src/liquidityflowause.pine",
  "src/liquidityflowause-strategy.pine",
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
 * reporting policy: build.mjs routes a missing module to a build error and a
 * module carrying its own script declaration to a build error as well, and the
 * smoke suite wants both outcomes without a process exit.
 *
 * `onMissing(rel)` fires when a declared module is not on disk. It is a build
 * FAILURE, not a warning: the assembled artifact would silently ship without
 * the module it was declared to contain, and nothing downstream would say so.
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

// ─── The Declared Module List ───────────────────────────────────────────────

/**
 * The message a missing declared module produces, in ONE wording.
 *
 * build.mjs reports the same finding from two places — the up-front check and
 * the read hook — and the two must read identically, so a reader sees one
 * problem rather than two, and so the report can be de-duplicated.
 */
export function missingModuleMessage(rel) {
  return (
    `declared module not found on disk: ${rel} — SOURCES promises a file that does ` +
    "not exist. The build will not ship a module list it cannot read: the missing " +
    "module would be silently absent from the assembled script."
  );
}

/**
 * The message an undeclared Pine source produces.
 */
export function undeclaredModuleMessage(rel) {
  return (
    `undeclared Pine source: ${rel} — every *.pine file under src/ must be listed ` +
    "in SOURCES, or it is a file the build never reads. Declare it, or move it out " +
    "of src/."
  );
}

/**
 * Checks that every DECLARED module exists on disk.
 *
 * This is the rule the build used to break: a declared module that was missing
 * produced a warning and the build carried on, so the assembled artifact
 * quietly lacked a module the manifest promised. Nothing downstream could see
 * that, because the artifact looked complete.
 *
 * It returns its findings instead of throwing, and the CALLER decides what a
 * failure means — build.mjs turns it into a build error; the smoke suite
 * asserts that it reports one. A rule that can only be exercised against the
 * real build cannot prove it is capable of failing, and a rule that has never
 * been seen to fail is not known to work, only known not to have been
 * triggered.
 *
 * @returns {{ok: boolean, missing: string[], errors: string[]}}
 */
export function assertDeclaredModulesPresent(root, sources = SOURCES) {
  const missing = (sources ?? []).filter((rel) => !existsSync(join(root, rel)));

  return {
    ok: missing.length === 0,
    missing,
    errors: missing.map(missingModuleMessage),
  };
}

/**
 * Lists every *.pine file under src/, relative to root, in POSIX form.
 */
async function listPineSources(root) {
  const srcDir = join(root, "src");
  const found = [];

  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // No src/ tree: nothing to be undeclared.
    }

    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile() && entry.name.endsWith(".pine")) {
        found.push(relative(root, abs).split(sep).join("/"));
      }
    }
  }

  await walk(srcDir);
  return found.sort();
}

/**
 * Checks the OTHER direction: every *.pine file under src/ that is not a main
 * source file must be DECLARED.
 *
 * A file that exists but is not declared is a defect too — it is dead code
 * that the build never reads, and it is how a stray file (the src/lib/ ones
 * this repository planned and never wrote) sneaks in. The missing-module rule
 * alone cannot catch it: a file nobody declared produces no missing-module
 * error at all.
 *
 * @returns {Promise<{ok: boolean, undeclared: string[], found: string[], errors: string[]}>}
 */
export async function assertDeclaredModulesComplete(root, sources = SOURCES, options = {}) {
  const mainFiles = options.mainFiles ?? MAIN_SOURCE_FILES;
  const declared = new Set(sources ?? []);
  const onDisk = await listPineSources(root);

  const undeclared = onDisk.filter((rel) => !declared.has(rel) && !mainFiles.includes(rel));

  return {
    ok: undeclared.length === 0,
    undeclared,
    found: onDisk,
    errors: undeclared.map(undeclaredModuleMessage),
  };
}
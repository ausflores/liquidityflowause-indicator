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
//   node scripts/build.mjs            # build + validate
//   node scripts/build.mjs --out X    # custom output path
//   node scripts/build.mjs --check    # validate only, write nothing
// ============================================================================

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

// ─── Configuration ───────────────────────────────────────────────────────────

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAIN = join(ROOT, "src", "liquidityflowause.pine");

// ORDER IS SEMANTIC. Pine v5 has no forward declarations: every input, const
// and function must be declared before its first use. The documented order in
// docs/technical-spec.md section 12.3 lists modules BEFORE the main file,
// which cannot compile — //@version=5 and indicator() must come first.
//
// Missing entries are reported as warnings, not failures. The remaining
// modules are not written yet, and a build that hard-fails on planned files
// would block every increment until the last module lands.
const SOURCES = [
  "src/lib/colors.pine",
  "src/lib/utils.pine",
  "src/lib/inputs.pine",
  "src/modules/liquidity-zones.pine",
  "src/modules/session-markers.pine",
  "src/modules/imbalance-detector.pine",
  "src/modules/structure-break.pine",
  "src/modules/signal-engine.pine",
];

const MARKER = "[CONCATENATION POINT]";
const DEFAULT_OUT = join(ROOT, "dist", "liquidityflowause.pine");

// ─── Helpers ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const outFlag = args.indexOf("--out");
const outPath = outFlag !== -1 && args[outFlag + 1]
  ? resolve(ROOT, args[outFlag + 1])
  : DEFAULT_OUT;

const warnings = [];
const errors = [];

function warn(message) {
  warnings.push(message);
}

function fail(message) {
  errors.push(message);
}

const BANNER = "// " + "=".repeat(75);

/**
 * Strips a module's own header banner and blank edges.
 *
 * Each module opens with a decorative box comment describing itself. Once
 * concatenated, that box is misleading: it reads like a section of the
 * indicator but sits mid-file with no scope boundary. The descriptive prose
 * stays; only the box frame goes.
 *
 * The box contains prose, so it cannot be matched by "lines until the first
 * non-box character" — the prose lines are inside it. The box is instead
 * delimited by its two rules of '=' characters, and the banner ends at the
 * closing rule.
 */
function stripBanner(source) {
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

// ─── Assemble ────────────────────────────────────────────────────────────────

async function build() {
  if (!existsSync(MAIN)) {
    console.error(`build: main file not found at ${MAIN}`);
    process.exit(1);
  }

  const mainSource = await readFile(MAIN, "utf8");

  if (!mainSource.includes(MARKER)) {
    console.error(
      `build: ${MAIN} has no ${MARKER} marker.\n` +
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
    label: "src/liquidityflowause.pine (header)",
    text: mainLines.slice(0, blockEnd + 1).join("\n").replace(/\n+$/, "\n"),
  });

  // 2. Modules, in declared order.
  for (const rel of SOURCES) {
    const abs = join(ROOT, rel);

    if (!existsSync(abs)) {
      warn(`module not built yet, skipped: ${rel}`);
      continue;
    }

    const raw = await readFile(abs, "utf8");

    // Structural invariant: a module that declares its own indicator() would
    // produce a script with two declarations.
    if (/^\s*(indicator|study)\s*\(/m.test(raw)) {
      fail(`${rel} declares indicator()/study(). Modules must not; the main ` +
        "file owns the single declaration.");
    }

    parts.push({ label: rel, text: stripBanner(raw).replace(/\n+$/, "\n") });
  }

  // 3. Main file footer: the marker block's continuation, if any.
  const footer = mainLines.slice(blockEnd + 1).join("\n").replace(/^\n+/, "");
  if (footer.trim()) {
    parts.push({ label: "src/liquidityflowause.pine (footer)", text: footer });
  }

  return parts;
}

// ─── Validate ────────────────────────────────────────────────────────────────

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

  return { lineCount: lines.length };
}

// ─── Report ──────────────────────────────────────────────────────────────────

const parts = await build();
const assembled = parts.map((p) => p.text);
const { lineCount } = validate(assembled);

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
console.log("");
console.log("  Next: paste the output into the TradingView Pine Editor.");
console.log("  The checks above are structural. They do not verify Pine");
console.log("  semantics, builtins, or runtime behavior — only the editor does.");
console.log("");

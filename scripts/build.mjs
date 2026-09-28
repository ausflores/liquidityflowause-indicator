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
const DIAGNOSTIC_OUT = join(ROOT, "dist", "liquidityflowause-diag.pine");

// ─── Helpers ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const diagnostic = args.includes("--diagnostic");
const outFlag = args.indexOf("--out");
const outPath = outFlag !== -1 && args[outFlag + 1]
  ? resolve(ROOT, args[outFlag + 1])
  : (diagnostic ? DIAGNOSTIC_OUT : DEFAULT_OUT);

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
// The assertion is edges === 2 x lines: every window has two edges but must
// draw exactly one line. A broken guard shifts both counters together on every
// window, which fails this check on all three sessions at once.
bool diagGuardHolds = diagAsiaEdges   == diagAsiaLines   * 2 and
                      diagLondonEdges == diagLondonLines * 2 and
                      diagNYEdges     == diagNYLines     * 2

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

/**
 * Boosts the production visuals for legibility and appends the overlay.
 * Rewrites the constants already in the assembled text; the module file on
 * disk is never touched.
 */
function applyDiagnostic(assembled) {
  const text = assembled.join("\n");

  // Tints: 92-96% transparency is near-invisible on a dark background.
  const boosted = text
    .replace(/color\.new\((color\.\w+),\s*\d+\)/g, "color.new($1, 55)")
    // Boundary lines: one-pixel dotted is hard to resolve. Widen and solidify.
    .replace(/width=1\)/g, "width=3)")
    .replace(/style=line\.style_dotted/g, "style=line.style_solid");

  // The zone overlay references the Liquidity Zones module's own globals, so it
  // is only valid once that module has been spliced in. Guarded rather than
  // assumed, so --diagnostic keeps working while modules are still being added.
  const hasZoneModule = /array<LiquidityZone>\s+zones/.test(text);
  const hasImbalanceModule = /array<ImbalanceZone>\s+imbalances/.test(text);
  const hasStructureModule = /sb_pivotHigh/.test(text);
  const hasSignalModule = /longSignalFired/.test(text);
  const overlays = [DIAGNOSTIC_OVERLAY];
  if (hasZoneModule) overlays.push(ZONE_DIAGNOSTIC_OVERLAY);
  if (hasImbalanceModule) overlays.push(IMBALANCE_DIAGNOSTIC_OVERLAY);
  if (hasStructureModule) overlays.push(STRUCTURE_DIAGNOSTIC_OVERLAY);
  if (hasSignalModule) overlays.push(SIGNAL_DIAGNOSTIC_OVERLAY);

  if (hasZoneModule) {
    console.log("");
    console.log("  Liquidity Zones present — read LZ DIAG VERDICT budget and counts.");
  }
  if (hasImbalanceModule) {
    console.log("");
    console.log("  Imbalance Detector present — read IMB DIAG VERDICT budget and");
    console.log("  counts, and confirm virgin gaps > 0.");
  }
  if (hasStructureModule) {
    console.log("");
    console.log("  Structure Break present — read SB DIAG ORPHAN flips, which must");
    console.log("  be 0, plus the three SB DIAG VERDICT series.");
  }
  if (hasSignalModule) {
    console.log("");
    console.log("  Signal Engine present — read SE DIAG DUAL fires, which must be 0.");
    console.log("  A non-zero value means LONG and SHORT fired on the same bar.");
  }

  return `${boosted}\n${overlays.join("\n")}`;
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

const parts = await build();
let assembled = parts.map((p) => p.text);

// Validation runs on the production assembly. The diagnostic overlay is
// appended afterwards so a defect in the overlay itself cannot mask a defect
// in the module, and so the reported line count stays comparable.
const { lineCount } = validate(assembled);

if (diagnostic) {
  assembled = [applyDiagnostic(assembled)];
}

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

if (diagnostic) {
  const n = assembled[0].split(/\r?\n/).length;
  console.log("");
  console.log("  DIAGNOSTIC BUILD — not for distribution.");
  console.log("  Read the chart legend for the DIAG series. The decisive one is:");
  console.log("");
  console.log("    DIAG VERDICT (1 = guard correct)");
  console.log("");
  console.log("  1  → edges === 2x lines for every session, so the `and inX` guard");
  console.log("        is correct and each window draws exactly one boundary line.");
  console.log("  0  → the guard is wrong; session windows draw a line on close too.");
  console.log("");
  console.log("  Read the six DIAG counter series to see which session diverged.");
  console.log("  Edge labels also name every open and close with its session.");
  console.log("");
}

console.log("");
console.log("  Next: paste the output into the TradingView Pine Editor.");
console.log("  The checks above are structural. They do not verify Pine");
console.log("  semantics, builtins, or runtime behavior — only the editor does.");
console.log("");

# Validation Status

What has actually been verified for each module, and what has not.

No Pine compiler exists in this project's build environment. The only place
Pine is genuinely validated is the TradingView Pine Editor, in a browser. Every
claim below is either checked by `scripts/build.mjs`, read as a number from the
`--diagnostic` legend, or explicitly marked unverified.

**Compiling is necessary and not sufficient.** Session Markers produced four
defects that reached the editor, three of which compiled only after the fact
and one of which compiled *cleanly* and failed at runtime on bar 0. A clean
compile establishes syntax, not behaviour.

---

## How to run the checks

```bash
node scripts/build.mjs             # production build, seven structural checks
node scripts/build.mjs --diagnostic # adds numeric series to the chart legend
node scripts/build.mjs --check     # validate only, write nothing
```

The seven structural checks, each verified by injecting the exact fault it
catches:

| # | Check | Catches |
|---|-------|---------|
| 1 | Version directive | zero, or more than one, `//@version=` |
| 2 | Version placement | `//@version=` after the first statement |
| 3 | Script declaration | zero, or more than one, `indicator()`/`study()` |
| 4 | Input legality | an `input.*` call before the script declaration |
| 5 | Module independence | a module declaring its own `indicator()`/`study()` |
| 6 | Grammar | `else <condition>` opening an indented block, which Pine v5 rejects |
| 7 | Timezone options | a value `time()` rejects at runtime, e.g. `"exchange"` |

These are text-level checks. They are not a Pine parser and do no type
checking, builtin validation, or runtime analysis.

---

## Session Markers

| Check | Status | Evidence |
|---|---|---|
| Compiles | confirmed | Pine Editor, no errors |
| Session tints render | confirmed | bands visible on chart, priority chain observed |
| Boundary lines, opening bar only | confirmed | Asia 42 edges / 21 lines, London 42/21 — exactly 2:1 |
| Enable toggles | confirmed | Asia disabled yields only London, overlap, NY |
| Timezone UTC | retracted | instrument measured the wrong thing; re-read pending |
| Timezone Asia/Tokyo | retracted | same instrument defect; the 9-hour fixed offset is unconfirmed |
| Timezone Europe/London | retracted | same instrument defect; `0/7/13` cannot be a BST reading |
| Timezone exchange default | confirmed | the default input, so the two-argument `time()` overload runs on every bar and never errors |
| **Timezone America/New_York** | **unverified** | instrument fixed, not yet read. Expect 5/12/18 (EST) or 4/11/17 (EDT) |
| **DST transitions** | **unverified** | a range spanning a boundary now steps on the same series |
| **Weekend spans** | **unverified** | crypto trades 24/7, so this is a data question not a logic one |

### The instrument was wrong, not the module

The three retracted rows were read off `hour(time(...), "UTC")` plotted
directly. That does not measure session opening hours. `time()` returns the
timestamp **of the bar** when that bar falls inside the session and `na`
otherwise — Pine Script v5, Concepts/Time, "Testing for sessions": *"it
returns a UNIX timestamp for that bar"*. The session parameter filters which
bars report a value; it is not a query for a session boundary. The plot was
therefore a ramp across the session's bars, so the number read depended
entirely on where the crosshair sat.

Compounding it, the expected values were embedded in the plot titles, so a
legend read could return the title's number instead of the series value. The
recorded `0, 7, 13` and `0/7/13` match those titles exactly — and they cannot
be real measurements either: on 28 Sep 2026 London is on BST, so London 00:00
falls at 23:00 UTC the *previous* day.

**The module was never affected.** It tests only `not na(time(...))`, which is
exactly the session-membership pattern the documentation recommends.

The overlay now samples on the session-open edge and holds the value with
`var`, so the plot is a constant per session, carries no expected value in its
title, and steps visibly across a DST transition on the same series. UTC,
Tokyo, London and America/New_York all need re-reading from it.

DST handling remains Pine's own work — the module passes an IANA zone name to
`time()` and performs no offset arithmetic — but the `var`-held series now
makes confirming it a matter of scrolling to a boundary rather than loading a
year of chart data.

---

## Liquidity Zones

| Check | Status | Evidence |
|---|---|---|
| Compiles | confirmed | Pine Editor, no errors |
| Bands render with tier weighting | confirmed | three opacities visible on chart |
| Array never exceeds `maxZones` | confirmed | `LZ DIAG VERDICT budget` = 1 |
| Tier and touch counters reconcile | confirmed | 24+14+11 = 49 live; 15+34 = 49 live |
| Sweep marks rather than deletes | confirmed | `sweptLong` and `sweptShort` both fired |
| Session module unaffected by splicing | confirmed | 540/270 on all three timeframes, verdict 1 |
| **Tier 1 (D1) population** | confirmed | 24 live D1 zones after the 4H-ATR distance fix |
| **Box liveness** | **not assertable** | see below |

**Box liveness cannot be asserted from outside a module.** The `box.delete()`
calls live inside the cull blocks, and Pine offers no way to query whether a
box id is still live from another scope. A leak would exhaust
`max_boxes_count=500`, after which Pine drops the oldest box — visible as zones
vanishing mid-band. If that is ever seen, the defect is in the module's cull
blocks, not in the diagnostic.

Observed: 879 gross zone births against 830 removals with 49 live means the
array churns continuously and only the most recent `maxZones` are ever visible.
That is the eviction working, not a defect, but it means raising `maxZones` is
the only way to see more history.

---

## Imbalance Detector

| Check | Status | Evidence |
|---|---|---|
| Compiles | confirmed | Pine Editor, no errors |
| Array within `maxImbalances` | confirmed | `IMB DIAG VERDICT budget` = 1 |
| Touched plus virgin equals live | confirmed | `IMB DIAG VERDICT counts` = 1 |
| **Gaps are born unfilled** | confirmed | `IMB DIAG virgin gaps` = 2, non-zero |
| Volume confirmation reachable | unverified | `volumeConfirmed` did not fire in the observed run |

The virgin-gap count is the load-bearing check here. The corrected spec's own
touch pseudocode was true by construction on a gap's creation bar — a gap's
edges come from that bar's own prices, so `high >= bottom and low <= top` holds
on bar zero. That would have pinned `nearImbalanceLong` and
`nearImbalanceShort` at zero permanently while the chart looked perfect. The
`bornBar < bar_index` guard is what makes virgin gaps non-zero.

Observed: only 2 live imbalances at `imbalanceThreshold` 1.0. Most likely the
threshold is too strict for a 1H chart rather than a detection fault, since a
1x-ATR gap is a much larger absolute move on 1H than on 5m. Worth testing at 0.5
before investigating further.

---

## Structure Break

| Check | Status | Evidence |
|---|---|---|
| Compiles | confirmed | Pine Editor, no errors |
| `sb_` prefix avoids collision | confirmed | compiles alongside Liquidity Zones in one script |
| **ORPHAN flips** | **unverified** | must be 0; not yet read from the legend |
| **flips ≤ breaks** | **unverified** | same |
| **Structure domain** | **unverified** | `marketStructure` must stay in {-1, 0, 1} |

The orphan check is the one that matters. `structureFlipped` is a *property of
a break*, so it can never be true on a bar with no break. If it is, the parallel
`bullishBoS` / `bullishChoCh` flags have been reintroduced — and the spec's own
confidence table awarded +20 for any break plus a further +30 for a ChoCh, so
every reversal break scored 50 for one event, enough to clear the 60-point
threshold on structure alone.

---

---

## Signal Engine

| Check | Status | Evidence |
|---|---|---|
| Compiles | confirmed | Pine Editor, no errors, five modules in one script |
| Renders alongside the others | confirmed | session tints, swing level lines and a `ChoCh ▼` marker all visible |
| Identifier attribution | confirmed | 37 read identifiers attributed to a declaring file, each declared before first use |
| Unresolved identifier sweep | confirmed | all 67 bare identifiers resolved against every declaration, parameter, UDT field, builtin and named argument in the spliced file |
| Duplicate top-level declarations | confirmed | 125 zero-indent declarations scanned, none duplicated |
| Score arithmetic | confirmed | all 192 reachable combinations enumerated: max 110, every tier reaches the 70 threshold including 1H-only |
| **LONG/SHORT exclusivity** | **unverified** | `SE DIAG DUAL fires` not read from the legend |
| **Weights calibrated** | **not attempted** | a trading judgement, not a code property |

**The exclusivity check is the one that matters.** LONG and SHORT are not
mutually exclusive by construction: a setup with an H4 zone below *and* an H4
zone above, untouched gaps on both sides, in the London/NY overlap, on elevated
volume, scores 70 on both sides and clears the threshold twice on one bar. The
implementation resolves it with `marketStructure` as tiebreaker and drops the
signal entirely when structure is unestablished. `SE DIAG DUAL fires` must be 0;
a non-zero value means that block is absent or ineffective.

**The weights are deliberately uncalibrated.** D1 30, 4H 20, 1H 10, overlap 25,
London/NY 15, Asia 5, reversal 30 versus continuation 20, imbalance 15, volume
10 — maximum 110, threshold 70. They are coherent with the spec's design intent,
where rarer events score higher, but nothing in the code can determine whether
they suit a given risk profile. Tuning them is the maintainer's decision against
real data; §7.3.1 records the reasoning so a future change is traceable rather
than arbitrary.

### Reading the numbers

```bash
node scripts/build.mjs --diagnostic
```

Paste `dist/liquidityflowause-diag.pine` into the Pine Editor. Every invariant
above is a series in the chart legend. Three are assertions about behaviour that
no static check can reach:

- `SE DIAG DUAL fires` — **must be 0.** Both signals on one bar.
- `SB DIAG ORPHAN flips` — **must be 0.** A reversal property with no break.
- `IMB DIAG virgin gaps` — must be **non**-zero. Zero means every gap is born
  touched, which silently pins both `nearImbalance*` flags at false.

---

## Outstanding across the project

| Item | Why it matters | Where |
|---|---|---|
| Timezone rows | UTC/Tokyo/London retracted, New_York never read | Session Markers |
| DST transitions | a range spanning a boundary now steps on the same series | Session Markers |
| Weekend spans | 24/7 markets, so a data question | Session Markers |
| `SB DIAG ORPHAN flips` = 0 | `structureFlipped` reachability unconfirmed | Structure Break |
| `SE DIAG DUAL fires` = 0 | LONG/SHORT exclusivity is unconfirmed | Signal Engine |
| Weight calibration | a trading judgement, not a code property | Signal Engine |
| Box liveness | not assertable from outside a module | Liquidity Zones |
| `src/lib/inputs.pine` | does not exist yet | shared inputs |

**`src/lib/inputs.pine` does not exist.** The zone, imbalance and structure
modules declare their own inputs. Whoever writes that library must not redeclare
them, or the splice produces duplicate declarations — the same class of defect as
the `h1_pivotHigh` collision. `enableLongSignals`, `enableShortSignals`,
`signalBullColor`, `signalBearColor` and `labelSize` from §8.1 are declared
nowhere and consumed nowhere; they were deliberately not implemented rather than
left as inputs wired to nothing.

---

## Defects found, for reference

Seven reached the Pine Editor, none caught by the static checks that existed at
the time. Each is now a structural check or a diagnostic assertion:

| Defect | Class | Now caught by |
|---|---|---|
| `input.time()` given a string defval | compile | none — compile only |
| `ta.change()` firing on both edges | behaviour | `edges == 2 × lines` |
| `else <condition>` opening a block | compile | structural check 6 |
| `time()` rejecting `"exchange"` | runtime | structural check 7 |
| gap born already-touched | behaviour | virgin-gap diagnostic |
| `h1_pivotHigh` declared twice | compile | duplicate-declaration audit |
| ChoCh double-counted as 50 points | logic | orphan-flip diagnostic |

Four more were found by auditing the specification before implementing, which is
why the audit is part of the process rather than an optional step: the
`atrValue` undefined identifier, the FVG size/region mismatch, the
`bullishBoS`/`bullishChoCh` nesting, and the per-bar `line.new()` that would
exhaust the line budget.

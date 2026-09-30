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
| Timezone UTC | confirmed | legend reads `0/7/13` — Asia 0000, London 0700, NY 1300 all in UTC |
| Timezone Asia/Tokyo | confirmed | legend reads `15/22/4` — JST is UTC+9, so 0000→15, 0700→22, 1300→04 (next day); `OPEN ASIA` label sits at 09:00 UTC-6 = 15:00 UTC |
| Timezone Europe/London | confirmed | legend reads `23/6/12` — BST is UTC+1, so 0000→23 (prev day), 0700→06, 1300→12; band boundaries land on 00:00/06:00/09:00 UTC-6 |
| Timezone exchange default | confirmed | the default input, so the two-argument `time()` overload runs on every bar and never errors |
| Timezone America/New_York | confirmed | legend reads `4/11/17` — EDT (UTC-4) on 29 Sep 2026, so 0000→04, 0700→11, 1300→17; the EST reading is confirmed under DST transitions below |
| DST transitions | confirmed | crosshair on 7 Mar 2026 (EST) reads `5/12/18`, on 10 Mar 2026 (EDT) reads `4/11/17` — all three step −1 across the 8 Mar boundary |
| Weekend spans | confirmed | crosshair on `sáb 26 Sep '26 — 02:00`: session tints present across Sat 26 and Sun 27 with no untinted strip, candles on both days — Pine v5 defaults omitted session days to `1234567` (Sun–Sat) |

### The instrument was wrong, not the module

The three rows that were retracted were read off `hour(time(...), "UTC")`
plotted
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
title, and steps visibly across a DST transition on the same series.

All four zones were re-read from that overlay on 29 Sep 2026:

| Zone | Read | Expected | |
|---|---|---|---|
| UTC | `0/7/13` | `0/7/13` | ✅ |
| America/New_York (EDT) | `4/11/17` | `4/11/17` | ✅ |
| Europe/London (BST) | `23/6/12` | `23/6/12` | ✅ |
| Asia/Tokyo (JST) | `15/22/4` | `15/22/4` | ✅ |

Each reading was corroborated against the rendered session bands rather than
taken alone: under `Europe/London` the band boundaries land on 00:00 / 06:00 /
09:00 UTC-6, and under `Asia/Tokyo` the `OPEN ASIA` label sits at 09:00
UTC-6 (= 15:00 UTC = 00:00 Tokyo).

DST handling remains Pine's own work — the module passes an IANA zone name to
`time()` and performs no offset arithmetic — but the `var`-held series now
makes confirming it a matter of scrolling to a boundary rather than loading a
year of chart data.

### The DST step, measured

The series was read either side of the **8 Mar 2026** boundary — the second
Sunday in March, when the United States moves EST → EDT. Chart timezone
`America/New_York`, timeframe 1H or finer (see *Correction: the `4H` label*
below), crosshair position taken from the date readout under the time axis
rather than estimated from the plot:

| Crosshair | Zone | Asia | London | NY |
|---|---|---|---|---|
| `sáb 07 Mar '26 — 22:00` | EST (UTC−5) | `5` | `12` | `18` |
| `mar 10 Mar '26 — 02:00` | EDT (UTC−4) | `4` | `11` | `17` |

All three step by exactly **−1**. The local clock does not move across the
boundary; the UTC offset does, so 0000 / 0700 / 1300 New York land one hour
earlier in UTC once EDT begins. The post-step values are the EDT `4/11/17`
already recorded for 29 Sep 2026, so this boundary test re-confirms the
America/New_York timezone row as well.

#### Correction: the `4H` label

The DST and weekend captures above were originally recorded as
`timeframe 4H`. That label is inconsistent with the values recorded beside it
and has been changed to `1H or finer`. **The values are unchanged** — they are
what the T8 fidelity gate in `backtest/gate.mjs` replays and reproduces.

The diagnostic series in `scripts/build.mjs` samples **the first bar that falls
inside the session** (`ta.change(inX) and inX`, held with `var`), so the legend
reports the hour of the *opening bar*, not the hour of the session window. It
is therefore grid-dependent. The windows open on whole hours in every zone
below, so a 1H or finer grid lands on all three; a 4H grid does not:

| `sessionTimezone` | zone | recorded | on a 4H grid |
|---|---|---|---|
| UTC | — | `0/7/13` | `0/8/16` |
| Asia/Tokyo | JST | `15/22/4` | `16/0/4` |
| Europe/London | BST | `23/6/12` | `0/8/12` |
| America/New_York | EDT | `4/11/17` | `4/12/20` |
| America/New_York | EST | `5/12/18` | `8/12/20` |

The three session opens sit on three different residues mod 4, so no 4H grid
can contain all three. The recorded tuples are reachable only on a grid no
coarser than 1H, which is why the label was corrected and not the values.

The weekend reading is unaffected apart from its own label: the tint claims
are bar-set claims and hold on any grid — 6/6 4H bars per day and 288/288 5m
bars per day, both days fully tinted.

A reading only means something when the crosshair is actually on a bar. With
the pointer off the chart the legend reports the **last** bar — which on
29 Sep 2026 is EDT, so it reads `4/11/17` at any historical position. That
produced two misleading captures before the date readout was checked, and is
the same class of mistake as the original ramp defect: the number depends on
where the instrument is pointed, and the pointer has to be visible.

`DIAG VERDICT` on these readings is a range artefact, not a DST signal. On
the 10 Mar capture Asia reports `1599` edges against `800 × 2 = 1600`,
because the loaded range opens inside an Asia session and the first bar has
no predecessor for `ta.change` to fire on; London and NY both match. On the
7 Mar capture the range opened cleanly and all three read `797 × 2 = 1594`
for a verdict of `1`.

The `0` was a range-boundary artefact, not a defect in the module or the
guard. The verifier now tolerates a single unmatched edge at the range
boundary, so these same captures would report a verdict of `1`; the underlying
edge and line counts themselves are unchanged (the tolerance changed, the
readings did not — they were not re-measured).

### Weekends, measured

The last Session Markers row was never a logic question — it was a
documentation question that could only be settled on the chart.

`input.session()` and `time()` take an optional day suffix. Without one, the
answer depends on the language version:

| Pine | Default days |
|---|---|
| v4 | `23456` — Monday to Friday |
| v5 | `1234567` — Sunday to Saturday |

This repo is v5 and supplies no suffix, so sessions should fire seven days a
week. The v5 migration guide says so explicitly — *"The default session days
for `time()` and `time_close()` … have been updated from `23456` (Monday to
Friday) to `1234567` (Sunday to Saturday). This change primarily affects
symbols traded on weekends"* — but the `time()` API reference still says *"if
days are omitted, it applies to all weekdays"*. Two official pages, two
answers. The row exists because that disagreement cannot be resolved by
reading.

It resolves on the chart. The windows are Asia `0000-0900`, London
`0700-1600` and NY `1300-2200`, all interpreted in the session timezone, and
the last of them ends Friday 22:00 New York. Under `23456` **nothing** would
land on a Saturday or a Sunday, so the two rightmost days of a Fri–Sun range
would carry no tint at all; under `1234567` they carry the full three-session
pattern.

Read with the crosshair on `sáb 26 Sep '26 — 02:00`, timeframe 1H or finer
(see *Correction: the `4H` label* in the DST section above), timezone
`America/New_York`:

- session tints present across Sat 26 and Sun 27, with no untinted strip
- candles on both days — Bitstamp BTCUSD data covers the weekend
- legend reads `4/11/17` (EDT, late September)

So the omitted day suffix resolves to `1234567`, sessions fire seven days a
week, and the 24/7 market is covered.

`DIAG VERDICT` read `0` here for the reason given above: Asia `1999` edges
against `1000 × 2 = 2000` (the range opens inside an Asia session), London and
NY both `999 × 2 = 1998`. That `0` was a range-boundary artefact, not a defect
in the module or the guard: the verifier now tolerates a single unmatched edge
at the range boundary, so these same counts — unchanged, not re-measured —
would report `1`.

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
| Volume confirmation reachable | confirmed | `IMB DIAG volumeConfirmed fired` = 1 at the crosshair bar (30 Sep 2026, 10:05) |

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

Measured 30 Sep 2026 with `node scripts/build.mjs --diagnostic=imbalance-detector`
on BTC/USD 5m. The legend reported, in plot order:

```
  4    1    3    0    0    1    0    1    1    1
```

- `imbLive` = 4 = `imbUntouched` 1 + `imbTouched` 3, so `IMB DIAG VERDICT
  counts` = 1. That tautology pins the first three values exactly, and ten
  tokens for ten `plot()` calls pins the rest, so the reading has no positional
  ambiguity.
- `volumeConfirmed` = **1**: on that bar `volume > ta.sma(volume, 20) *
  volumeThreshold`, i.e. volume ran 20% above its 20-bar average. The factor is
  reachable at the default threshold of 1.2; it simply did not happen to fire
  during the earlier observation run.

The two runs do not disagree. The earlier one was 1H, where a 1x-ATR gap is a
much larger absolute move and only 2 live imbalances appeared. On 5m the array
holds 4 with 1 virgin gap, still non-zero, so the `bornBar < bar_index` guard is
doing its job on this timeframe as well.

---

## Structure Break

| Check | Status | Evidence |
|---|---|---|
| Compiles | confirmed | Pine Editor, no errors |
| `sb_` prefix avoids collision | confirmed | compiles alongside Liquidity Zones in one script |
| **ORPHAN flips** | **confirmed** | `SB DIAG ORPHAN flips` = 0; `SB DIAG VERDICT no-orphans` = 1 |
| **flips ≤ breaks** | **confirmed** | `SB DIAG reversals` 19 ≤ `SB DIAG breaks total` 119; verdict = 1 |
| **Structure domain** | **confirmed** | `SB DIAG structure` = 1; `SB DIAG VERDICT domain` = 1 |

The orphan check is the one that matters. `structureFlipped` is a *property of
a break*, so it can never be true on a bar with no break. If it is, the parallel
`bullishBoS` / `bullishChoCh` flags have been reintroduced — and the spec's own
confidence table awarded +20 for any break plus a further +30 for a ChoCh, so
every reversal break scored 50 for one event, enough to clear the 60-point
threshold on structure alone.

Measured 30 Sep 2026 with `node scripts/build.mjs --diagnostic=structure-break`,
pasted into the Pine Editor on BTC/USD 5m. The legend reported, in plot order:

```
  1   119    19    0    0    0    0    1    1    1
```

- `marketStructure` = **1**, inside the {-1, 0, 1} domain, and
  `SB DIAG VERDICT domain` = 1.
- `sbBreaks` = **119** against `sbFlips` = **19** — cumulative reversals stay
  well below cumulative breaks, so the reversal path never runs ahead of the
  break path. `SB DIAG VERDICT flips<=breaks` = 1.
- `sbOrphanFlips` = **0**, with `SB DIAG VERDICT no-orphans` = 1. Across 119
  breaks and 19 reversals, `structureFlipped` was never true on a bar without a
  break — the parallel-flag defect is not present.

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
| **LONG/SHORT exclusivity** | **confirmed** | `SE DIAG DUAL fires` = 0; `SE DIAG VERDICT no-dual` = 1 |
| **Weights calibrated** | **not attempted** | a trading judgement, not a code property |

**The exclusivity check is the one that matters.** LONG and SHORT are not
mutually exclusive by construction: a setup with an H4 zone below *and* an H4
zone above, untouched gaps on both sides, in the London/NY overlap, on elevated
volume, scores 70 on both sides and clears the threshold twice on one bar. The
implementation resolves it with `marketStructure` as tiebreaker and drops the
signal entirely when structure is unestablished. `SE DIAG DUAL fires` must be 0;
a non-zero value means that block is absent or ineffective.

Measured 30 Sep 2026 with `node scripts/build.mjs --diagnostic=signal-engine`,
pasted into the Pine Editor on BTC/USD 5m. The legend reported
`SE DIAG DUAL fires` = **0**, corroborated by `SE DIAG VERDICT no-dual` = 1 and
by `SE DIAG VERDICT score domain` = 1. No bar in the loaded range carried both
signals.

This is a negative assertion: it establishes that no bar produced both signals,
not that the tiebreaker branch holds under a deliberately constructed
double-sided setup. That branch is still covered by the code reading above
rather than by this run.

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

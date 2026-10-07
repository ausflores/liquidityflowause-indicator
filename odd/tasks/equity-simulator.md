# Feature: local equity-curve simulator

## Objective

Answer, on the already-downloaded 5-year datasets, the one question the harness
cannot currently answer: **does either entry model make money?** Produce an
equity curve with real position accounting, and settle the long-vs-short
asymmetry observed on TradingView.

## Problem

Every measurement in `backtest/` is a **descriptive ratio over overlapping
forward windows**. There is no cash, no position accounting, no compounding and
no equity curve. A hit rate describes a *rate*; it says nothing about a *curve*.

TradingView's Strategy Tester does produce a curve, but the maintainer's plan caps
the test window at `31 dic 2025 — 7 oct 2026`. Two runs on that window produced
56 trades (Weighted) and 191 trades (Binary). Both report roughly −0.19% to
−0.20% expectancy per trade. At those sample sizes the comparison between models
is not statistically significant, and the Weighted hit-rate interval still
contains the 39.13% break-even.

So the curve exists but the sample is too small, and the sample cannot be
enlarged on that platform.

## Why this feature and not another

The 5-year data is already local and already validated (fidelity gate PASS 9/9).
The missing piece is position accounting, not data, not indicators, not
parameters. This is the smallest bounded unit that closes the project's open
question.

## Authorized scope

| In scope | Out of scope |
|---|---|
| New file `backtest/equity.mjs` | `src/**` — never modified |
| New subcommand wiring in `backtest/run.mjs` | `src/modules/**` — never modified |
| New tests in `backtest/smoke.mjs` | `dist/liquidityflowause.pine` — never modified |
| A findings section in `docs/WEIGHT-CALIBRATION.md` | Any change to Pine signal logic |
| | Any parameter sweep presented as an improvement |

**Hard invariants for this feature:**

- `dist/liquidityflowause.pine` SHA256 stays
  `1DD6F536AE4F50C2F669E9C1A2B34A0FB97A7D51428905B9E18F8616D1582CE2`.
- No `package.json`, no npm dependencies. Bare `node`.
- No tuning of target/stop against the result. A ratio sweep may be *reported*,
  never *selected on*.
- Generated artifacts in English.

## Tasks

- [x] **T1** Map the harness: exact data shape, signal API, exit-rule API,
      direction encoding, entry-index convention, CLI idiom, and whether any
      position accounting already exists. — *delegated (explore)* — **DONE,
      see "Harness API map" below**
- [x] **T2** Create the feature branch before the first source write. — *inline*
      — **DONE**, `exp/equity-simulator`
- [x] **T3** Implement `backtest/equity.mjs`: signal → entry → target/stop
      resolution → position accounting → equity curve, for both entry models on
      1h. — *delegated (writer)* — **DONE**
- [x] **T4** Wire the `equity` subcommand into `backtest/run.mjs`. — *same writer
      as T3, one bounded unit* — **DONE**, `run.mjs:779`
- [x] **T5** Add smoke tests covering: zero-signal input, a single forced
      target hit, a single forced stop hit, and the flat-position rule. — *same
      writer as T3* — **DONE**, 145 assertions in section `equity-curve`
- [x] **T6** Run both models on 5-year 1h and record: trades, hit rate, profit
      factor, expectancy, max drawdown, CAGR, and the long/short split. — *inline*
      — **DONE**
- [x] **T7** Report the gross-vs-net breakdown and the achieved T/S break-even
      per model, and state explicitly whether any of it is inside its own
      confidence interval. — *inline* — **DONE**
- [x] **T8** Publish findings to `docs/WEIGHT-CALIBRATION.md`. — *delegated
      (writer)* — **DONE**, §11 and appendices
- [x] **T9** Close the feature: commit each work unit, record commit identities,
      report failed/skipped checks. — *inline* — **DONE**

## Acceptance criteria

1. `node backtest/smoke.mjs` passes, including the pre-existing
   `route-a-strategy` section. **MET — TOTAL 1985, failed 0**, `route-a-strategy`
   122 checks unchanged.
2. ~~`node backtest/gate.mjs` still reports `GATE RESULT: PASS — 9/9`.~~
   **CORRECTED, see "Acceptance criterion 2 correction" below.** The real
   entry point is `node backtest/run.mjs validate`, which reports
   `GATE RESULT: PASS — 9/9 Class A readings reproduced.` **MET.**
3. `dist/liquidityflowause.pine` SHA256 unchanged. **MET** —
   `1DD6F536AE4F50C2F669E9C1A2B34A0FB97A7D51428905B9E18F8616D1582CE2`.
4. The simulator's per-trade outcome arithmetic is cross-checked against
   `label.mjs`'s `EXIT_TARGET_PCT` / `EXIT_STOP_PCT`, not re-derived
   independently. **MET** — the simulator calls `labelSignalsExitRule` and
   consumes its labels; it never recomputes a target or stop level.
5. Output states, for each model: trades, hit rate, profit factor, expectancy per
   trade, max drawdown, annualized return, and long/short split. **MET** for
   both models and both horizons, in `equity` section 1.
6. The long/short split is reported whether or not it confirms the TradingView
   observation. A null result is a valid result. **MET — and the result IS
   null.** See "Finding 4" below; the earlier TradingView-derived asymmetry
   claim is explicitly withdrawn.

## Acceptance criterion 2 correction

This criterion, and the "Applicable checks" table below it, both named
`node backtest/gate.mjs` as the fidelity gate. **That command does nothing.**
`backtest/gate.mjs` exports `runGate()` and contains no top-level execution
statement, so invoking it directly prints nothing and exits 0.

This is **pre-existing**, not introduced by this feature: it was proved by
stashing all equity-simulator work, re-running `node backtest/gate.mjs` on a
clean tree, and observing the same empty output.

`gate.mjs:1-6` states it plainly: *"Dispatched by `node backtest/run.mjs
validate`."* The gate is reported below on the command that actually runs it.

## Applicable checks

| Check | Command | Result |
|---|---|---|
| Smoke tests | `node backtest/smoke.mjs` | TOTAL 1985, failed 0 |
| Fidelity gate | `node backtest/run.mjs validate` | `GATE RESULT: PASS — 9/9` |
| Shipped SHA | `Get-FileHash dist\liquidityflowause.pine -Algorithm SHA256` | `1DD6F536AE4F50C2F669E9C1A2B34A0FB97A7D51428905B9E18F8616D1582CE2` |
| Source/dist untouched | `git status --short -- src dist backtest` | empty |
| New simulation | `node backtest/run.mjs equity --timeframe 1h` | 14 caveats, exit 0 |

The `node backtest/gate.mjs` row that was in this table originally has been
replaced by `node backtest/run.mjs validate`. The original command is retained
above only to record that it is a no-op.

## Harness API map (T1, verified by reading the source)

**Nothing in `backtest/` does position accounting.** Verified by search across
every `.mjs` for `equity|pnl|balance|capital|position|drawdown|compoun|sharpe`.
Every hit is a caveat stating it does *not* exist (`label.mjs:102`,
`baseline.mjs:899`, `ratio.mjs:1821`). This feature is genuinely new ground.

| Fact | Where |
|---|---|
| Dataset is `{ schemaVersion, candles: [{t,o,h,l,c,v}] }`, `t` = epoch ms | `run.mjs:366,588` |
| 1h dataset: 44,000 bars, `2021-09-24` → `2026-10-01`, 1833.29 days, **0 gaps** | `backtest/data/btcusd-1h.meta.json` |
| `labelCandles` use `{high,low,close}` — dataset uses `{o,h,l,c,v}` | `baseline.mjs:464` |
| `labelCandles` carries **no timestamp**; read `candles[i].t` directly | `baseline.mjs:464` |
| Shared loader `loadDataset(tf)` → `{candles, meta}` | `baseline.mjs:238` |
| **Wiring loop `runComparison(candles, meta, tf, sink)`** → sink gets `{labelCandles, signals:{weighted,binary}, scoreCandidateCounts}` | `baseline.mjs:459,749-756` |
| Exit rule `labelSignalsExitRule(labelCandles, signals, {maxHorizonBars})` → `{total, counts, doubleTouchCount, results}` | `label.mjs:359` |
| Per-result fields: `label, side, barIndex, price, targetPrice, stopPrice, horizonBars, barsAvailable, doubleTouch` | `label.mjs:295-306` |
| `EXIT_TARGET_PCT = 1.5`, `EXIT_STOP_PCT = 0.8` — `targetPct`/`stopPct` are **rejected** as options | `label.mjs:142-151,181-191` |
| Entry is at the **signal close**; scan starts at `barIndex + 1` | `label.mjs:36-54,314` |
| Exit index = `barIndex + horizonBars` | derived from the above |
| Cooldown `signalCooldownBars: 10`, per-model state, does **not** block re-entry into an open position | `signal-engine.mjs:152,425-426` |
| Reusable money helpers already exist — do **not** re-derive | `ratio.mjs:319,334,352` |
| `D4_ROUND_TRIP_COMMISSION_PCT = 0.10` | `ratio.mjs:192` |
| CLI: add `equity` to `EXTRA_SUBCOMMANDS`, **not** `SUBCOMMANDS` — `smoke.mjs` asserts the six-name literal verbatim | `run.mjs:744-754` |

## Declared simulation decisions

These are harness choices, not spec. Each must be printed in the report.

1. **Signals come from `runComparison`'s sink.** Identical to what `compare.mjs`
   and `ratio.mjs` consumed. Zero re-wiring, zero re-derivation. If the sink does
   not fire, throw — house pattern from `ratio.mjs:1546`.
2. **Horizon is declared, not defaulted silently.** `maxHorizonBars` defaults to
   288, which on 1h is **~12 days, not 24 hours** — the "24 hours" comment in
   `label.mjs:147` is an annotation, not a conversion, and the module has no
   timeframe awareness. TradingView's `strategy()` has **no horizon at all**: it
   holds until target or stop. The primary run therefore uses a long horizon
   (8760 bars ≈ 1 year on 1h) so behaviour is comparable to the TradingView
   measurement, and the `timeout` count is reported. A 288-bar companion run is
   reported alongside for continuity with the existing harness numbers.
3. **`doubleTouch` (target and stop inside the same bar) resolves pessimistically
   to a loss**, matching TradingView's intrabar convention. The count and the
   result under the optimistic assumption are both reported, so the sensitivity
   is visible rather than buried.
4. **Only-enter-when-flat is ON**, matching the TradingView default that produced
   the 56/191-trade comparison. Signals arriving while a position is open are
   **skipped and counted** — never silently dropped.
5. **Sizing is 10% of current equity**, compounding, per D.4
   (`default_qty_value=10`).
6. **Commission 0.10% round trip**, from `D4_ROUND_TRIP_COMMISSION_PCT`.
7. **Slippage is declared 0 and reported as such.** D.4 declares `slippage=2` in
   **ticks**, and Bitstamp's BTC/USD tick size is not recorded in any meta file.
   This is unresolved; the report must state that the run excludes slippage and
   that D.4's value is tick-dependent. On the TradingView run the observed
   per-trade figures were exactly target − 0.10%, implying slippage contributed
   nothing measurable there, which is itself unexplained.
8. **The last `maxHorizonBars` bars return `insufficient_data`.** Reported, never
   silently discarded.
9. Per-model reporting is mandatory and symmetric: trades, hit rate, profit
   factor, expectancy per trade, max drawdown, annualized return, and the
   long/short split.

## TDD mode

**Resolved: `tdd`, evidenced.** The runner is `node backtest/smoke.mjs`, the
project's only suite, and it is deterministic, dependency-free and offline.

The record below is the honest account of how the cycles went, **including the
cycles that did not obey the loop.**

### Declared TDD deviation

**Cycles 3 and 4 produced no failing test.** The loss branch, the short-side
sign, the flat-position rule, compounding, and `insufficient_data` handling were
written in **cycle 1**, because they are part of the same loop the win fixture
needs in order to assert anything at all about a curve. They were **not**
inverted retroactively to manufacture a red-then-green record for them.

Cycles 5–8 were clean and are the cycles that actually carried the pure core.

### Writer mistakes, recorded not hidden

Several test **expectations** were wrong, not the code:

- A profit-factor fixture sized trade 2 off the **opening** balance instead of
  the **current** balance, which is the whole point of a compounding rule.
- A compounding fixture's signals **overlapped** the flat window, so the
  only-enter-when-flat rule suppressed trades the fixture expected.

Both were corrected **in the expectation**, with the correct arithmetic written
down beside it. Neither was fixed by bending the code to match a wrong
expectation.

## Delivery strategy

**Delivered as commits on `exp/equity-simulator`. No PR, no push, no merge.**
Delivery is the maintainer's decision.

The advisory was ~400 authored changed lines. The final unit exceeds it. The
reason is not padding: the corrected acceptance criteria, the standing-rule
disagreements and the withdrawn orchestrator recommendation are all substantive
records this project has deliberately chosen to keep (criterion 6 above, and
the process record below). Nothing was deleted for cosmetic savings.

## Progress

**2026-10-07** — Feature authorized. T1 delegated.

### Route declaration

| Task | Route | Trigger evidence |
|---|---|---|
| T1 | delegated | 4+ files must be read to establish the API surface |
| T2 | inline | one mechanical command |
| T3–T5 | delegated | 3 non-trivial files, one writer |
| T6–T7 | inline | run and read output |
| T8 | delegated | writing a doc that prepares on results |
| T9 | inline | state commands |

**2026-10-07** — T1 DONE. Branch `exp/equity-simulator` created before the first
source write (T2). T3–T5 delivered as one bounded unit by a single writer:
new file `backtest/equity.mjs`, subcommand wiring in `backtest/run.mjs`, 145
smoke assertions in section `equity-curve`.

## Commit identities

| Commit | Subject |
|---|---|
| `a795b6d8bc6dcfa82f36709e77b7208536593580` | `feat(equity): simulate position accounting and equity curve` |
| *(this commit)* | `docs(equity): publish 5y 1h equity findings and close the feature` |

## The result

Command: `node backtest/run.mjs equity --timeframe 1h`

Dataset `backtest/data/btcusd-1h.json` — 44,000 bars, `2021-09-24T14:00:00.000Z`
.. `2026-10-01T21:00:00.000Z`, 1833.2917 days, **0 gaps, 0 missing bars, 0
off-grid**. Exchange Bitstamp, BTC/USD.

Account: 10,000 opening equity, sizing **10% of current equity (compounding)**,
commission **0.10% round trip charged once per completed trade**, **slippage 0
(declared zero, NOT modelled)**. Signals: weighted 307 / binary 1,701.
14 caveats `[C0]`..`[C13]` are printed by the command.

### Accounting — the sign convention matters more than any number in this table

`gross` is **NEGATIVE**. `comm` is a cost **magnitude shown positive**.
`net = gross − comm`. **Do not read the gross as a gain.**

```
  model horizon            final eq    return      gross     comm        net   skipped   unobs
  weighted  8,760 bars         9,593.16    -4.07%    -181.86   224.97    -406.84         3      74
  binary    8,760 bars         8,816.13   -11.84%     -95.65 1,088.22  -1,183.87       221     316
  weighted    288 bars         9,469.83    -5.30%    -240.32   289.85    -530.17         6       3
  binary      288 bars         8,515.88   -14.84%    -174.75 1,309.37  -1,484.12       272      12
```

### Per-model metrics

```
  model horizon       trades      hit       PF  exp/trade    maxDD       CAGR   long  short
  weighted  8,760 bars    230   31.30%     0.71     -0.18%   -5.25%     -1.03%    123    107
  binary    8,760 bars  1,164   34.45%     0.82     -0.11%  -13.36%     -3.09%    621    543
```

### Against the shipped exit pair

```
  shipped D.4 pair: target 1.5% / stop 0.8%, ratio 1.875, break-even hit rate 34.78%
  weighted  8,760 bars    hit 31.30% vs break-even 34.78% (-3.48 pp) ... ratio REQUIRED 2.1944
  binary    8,760 bars    hit 34.45% vs break-even 34.78% (-0.33 pp) ... ratio REQUIRED 1.9027
```

### Independent verification of the arithmetic

The reported gross was **reproduced by hand from the hit rate and the exit pair**,
independently of the simulator. This is the reason the curve can be trusted: it
does not rest on the simulator having computed itself correctly.

- **Commission.** `224.97 / 230 = 0.978` USD per trade. Position ≈ 10% of
  10,000 ≈ 1,000 USD; 0.10% round trip on 1,000 USD = 1.00 USD. Consistent.
- **Gross.** `0.3130 × 1.5 = 0.4695`; `0.6870 × 0.8 = 0.5496`; difference
  **−0.0801% per trade**; × ~1,000 USD × 230 trades = **−184 USD**. Reported
  **−181.86**. **Agreement**, and the residual is the compounding and the
  three skipped signals, both of which the flat-rate estimate ignores by
  construction.

The simulator's own per-resolved-trade gross expectancy figure for the same row
is **−0.08%**, which is the hand calculation stated in the output.

## Findings

1. **Neither entry model makes money.** Weighted −4.07% over 1,458 traded days;
   binary −11.84%.
2. **Neither model has an edge even before costs.** Gross is negative for both.
   Commission is an additional burden, **not the cause**.
3. **Binary is the better trade and the worse system.** Hit 34.45% vs weighted
   31.30%, and expectancy per trade −0.11% vs −0.18% — yet it loses ~3× more in
   total, because it trades ~5× as often. Binary's 34.45% is **0.33 pp below**
   the 34.78% break-even; at 1,164 trades that is indistinguishable from
   break-even. **Not** called broken, and **not** called viable.
4. **The long/short asymmetry observed on TradingView does NOT reproduce.**
   Locally 123 long / 107 short (weighted) and 621 / 543 (binary) — near 50/50 —
   against TradingView's reported 2× long penalty across 247 trades. Two feeds,
   1,394 local trades. **Reported as a null result, and the earlier claim is
   explicitly withdrawn.**
5. **Option 3 (retune target/stop) is closed.** Weighted requires ratio **2.1944**
   and has 1.875; binary requires **1.9027** and has 1.875. Binary's gap is
   0.0277, inside its own sampling noise, so it is **not distinguishable from
   adequate**. The binding constraint is the **hit rate**, not the exit rule.
6. **The original project question is answered: the weighted model does not beat
   the binary model.** They are statistically indistinguishable.

## Unresolved and limited — recorded, not smoothed over

- **Slippage is 0 and not modelled.** D.4 declares `slippage=2` in **ticks**;
  Bitstamp's BTC/USD tick size is recorded in **no meta file** in this
  repository (`btcusd-1h.meta.json` has no tick-size field). No tick size was
  invented. The run **excludes** slippage, so every figure is an **upper bound**
  on realised performance, and D.4's value is **tick-dependent**.
- **The wiring is untested by construction.** The suite never reads
  `backtest/data/` (`smoke.mjs:7`, `:1085`, `:1770`), so it **cannot** catch a
  bar-shape mismatch between the on-disk dataset and what the simulator consumes.
  A real live-run bug of exactly that kind occurred in this project and was
  found only on the first real run.
- **`--timeframe` defaults to 5m harness-wide** (`timeframes.mjs:137`:
  `DEFAULT_TIMEFRAME = "5m"`), so a bare `equity` run executes on **5m**.
  **`--timeframe 1h` is required.** Changing that default is out of scope.
- **One dataset, one exchange, one timeframe preference (1h).** Fills are at the
  **signal close**, which is optimistic against a real book.
- **`insufficient_data`** results are **counted** (`unobs` column), never
  silently dropped. `label.mjs` checks availability **before** scanning, so a
  touch inside a truncated window is `insufficient_data` and never a win.
- **`skipped`** counts signals dropped by the only-enter-when-flat rule. Never
  silently dropped — a silently discarded signal is indistinguishable from one
  that never fired.

## Standing rule fired — source wins

This project has a standing rule: where a brief disagrees with the shipped
source, **the source wins, and the disagreement is recorded rather than
executed.** It has now fired eight times. Three of those eight were in this
feature.

1. **`D4_ROUND_TRIP_COMMISSION_PCT` is NOT exported at its definition site.**
   Brief: the constant is importable. Source: `ratio.mjs:192` reads
   `const D4_ROUND_TRIP_COMMISSION_PCT = 0.10;` — a plain `const`, with no
   `export` on that line. **Source won:** the name was added to `ratio.mjs`'s
   existing export block (`ratio.mjs:2418`) rather than retyping `0.10`.

2. **`EXTRA_SUBCOMMANDS` is asserted VERBATIM.** Brief: add `equity` to
   `EXTRA_SUBCOMMANDS`. Source: `smoke.mjs:3439` contains
   `runSrcRatio.includes('EXTRA_SUBCOMMANDS = ["ratio"]')`. Appending `equity`
   to it **breaks that assertion**. **Source won:** `equity` reaches
   `DISPATCHABLE` through a third list, `LATER_SUBCOMMANDS = ["equity"]`
   (`run.mjs:779`), with both original literals untouched. A typo in
   `LATER_SUBCOMMANDS` still refuses to dispatch, because dispatch is still
   gated on `DISPATCHABLE.includes(subcommand)` (`run.mjs:801`).

3. **`node backtest/gate.mjs` is a NO-OP.** Brief: that is the gate command.
   Source: `gate.mjs` exports `runGate()` with no top-level execution. Running it
   directly prints nothing and exits 0. **Pre-existing**, proved by stashing all
   work and re-running on a clean tree. **Source won:** the gate is reported on
   `node backtest/run.mjs validate`, and the no-op is stated plainly rather than
   papered over.

## Process record — the orchestrator error, recorded not hidden

**The orchestrator told the maintainer "the signal IS profitable before
commissions", and built a recommendation on it** — reduce trade frequency to
protect a gross edge.

**That was a misread of the sign.** `224.97` is the **commission magnitude** and
`−181.86` is the **gross**, in the **same table row**. Commission is being
subtracted from a negative gross, not added to a positive one.

It was caught by **recomputing the gross from the hit rate and the exit pair by
hand** — 0.3130 × 1.5 = 0.4695, 0.6870 × 0.8 = 0.5496, difference −0.0801% per
trade, × ~1,000 USD × 230 trades = **−184 USD** against a reported **−181.86**.
The recommendation built on the misread was **withdrawn**.

**The lesson, recorded as a rule for this project:** any reported
gross/net/commission triple must be checked by recomputing **one member** of it
from the hit rate and the exit pair **before** it is interpreted. The other two
numbers being adjacent in a table is not evidence that they were read correctly.

## Deliverable and next step

**There is no deliverable outstanding.** Every task T1–T9 is closed, the findings
are published, and the feature is closed.

**Nothing here recommends a change to the indicator.** Specifically, and against
the standing temptation to act on a curve that has finally produced numbers:

- **Do not retune target/stop.** Option 3 is closed on its own arithmetic
  (finding 5). The binding constraint is hit rate, and no exit rule fixes a hit
  rate.
- **Do not "fix" the long/short balance.** The asymmetry did not reproduce
  (finding 4). Tuning toward a withdrawn observation would be tuning toward
  nothing.
- **Do not run the weight search.** Its objective is still not measurable, for
  the same structural reason recorded in `docs/WEIGHT-CALIBRATION.md` §8 and §9a.

**What remains genuinely open**, unchanged by this feature and not closed by it:

- **Route A** — the spec's own `strategy()` variant in TradingView, with real
  fills, real commission and real slippage. Still the only route to a definitive
  answer, and this harness is explicitly an upper bound on it.
- **Slippage in a unit that means something.** Resolving D.4's `slippage=2` from
  ticks to a price fraction requires a tick size this repository does not record.
- **More than one dataset.** One exchange, one instrument, one timeframe
  preference. Nothing here generalises past Bitstamp BTC/USD 1h.
- **The 5m timeframe still does not function** at the shipped threshold
  (`docs/WEIGHT-CALIBRATION.md` §3). This feature ran on 1h and says nothing
  about 5m.

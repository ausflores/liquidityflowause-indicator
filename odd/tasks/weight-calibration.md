# Feature: weight-calibration (local backtest harness)

## Objective

Answer, with measured evidence, the question the spec raises but never settles:

> Do the Signal Engine's weighted scores (10 weights, max 110, threshold 70) beat
> the binary confluence model proposed in `docs/technical-spec.md` D.1?

If the weighted model wins, produce a better weight vector than the current one.
If the binary model wins or ties, report that honestly — the spec already argues
for it ("*a missing factor means the setup is incomplete*").

## Problem

`docs/VALIDATION.md` confirms the score **arithmetic** over all 192 combinations,
but arithmetic being correct says nothing about the **values** being good. There
is currently no way to evaluate a weight vector, because:

1. Pine Script executes only inside TradingView; it cannot run locally.
2. The repo has no test harness at all — no `package.json`, no dependencies,
   no data, no runner.
3. TradingView's Strategy Tester can evaluate *one* configuration per manual
   settings-panel run, which cannot search a 10-dimensional space.

## Why a local reimplementation (Route B) and not the spec's D.4 strategy variant

The user chose Route B explicitly after seeing the tradeoff:

| | Route A (spec D.4 `strategy()`) | Route B (this feature) |
|---|---|---|
| Engine under test | the real one | a reimplementation |
| Fidelity risk | none | **must be proven, see the gate below** |
| Configurations searchable | one per manual run | thousands automatically |
| Who runs it | the user, repeatedly | the harness |

**Route A remains the planned verification step** once Route B produces a
candidate configuration. Route B searches; Route A confirms.

The fidelity risk is controlled by an existing asset: `docs/VALIDATION.md`
holds 35 confirmed readings, 8 of them bar-scoped with exact dates, crosshair
positions, and legend values. A port that reproduces those is evidence of
fidelity, not an assumption.

## Scope

### In scope

- Zero-dependency Node harness under `backtest/` (repo already runs
  `scripts/build.mjs` with bare `node`).
- Historical OHLCV ingest for BTC/USD 5m from **Bitstamp** — the same exchange
  as the validation chart, public endpoint, no credentials.
- Port of all five modules to JS: `session-markers`, `liquidity-zones`,
  `structure-break`, `imbalance-detector`, `signal-engine`.
- **Fidelity gate** — hard stop before any calibration claim is made.
- Outcome labelling using the spec's own D.4 exit parameters.
- Baselines: current weighted config, and binary (D.1).
- Weight search over the weight vector and threshold.
- A written findings report.

### Out of scope

- **Changing the weights in the Pine source.** This feature produces evidence;
  changing shipped values is a separate, user-authorized decision.
- Route A (`strategy()` variant) — planned later as verification, not search.
- The three Outstanding items in `docs/VALIDATION.md` (weight calibration
  methodology, box liveness, `src/lib/inputs.pine`).
- ~~Any timeframe other than 5m~~ — **lifted on 2026-10-01 by explicit user
  authorization.** 5m stays the reference timeframe and the *only* one the T8
  fidelity gate may run on, because its readings were taken on a 5m grid. 1h
  is added so T12/T13 can finally answer the question the feature exists to
  ask; 4h only if the endpoint serves it. **Any symbol other than BTC/USD stays
  out of scope.** The reason for the lift is recorded so it cannot be quietly
  forgotten: slice 6 proved the D1/H4 tier dimensions are geometrically
  degenerate on 5m, so a weight search there would fit a dimension that cannot
  move.
- Live/paper trading, order simulation, portfolio-level metrics.

## Constraints

- Generated artifacts (code, docs, comments) are **English**.
- Conventional Commits only; no AI attribution.
- Never edit inside the TradingView Pine Editor.
- `dist/` stays gitignored; the production build SHA
  `1DD6F536AE4F50C2F669E9C1A2B34A0FB97A7D51428905B9E18F8616D1582CE2` must not change.
- Zero new npm dependencies — use Node's built-in `fetch` and stdlib only.
- Historical market data must not be committed; `backtest/data/` is gitignored.
- No claim of "calibrated" or "improved" may be published before the fidelity
  gate passes. A failed gate is reported as a failed gate.

## Route declaration

Per-task execution topology and the delegation trigger evidence that selected it.

| ID | Task | Route | Trigger evidence |
|---|---|---|---|
| T1 | Harness scaffolding (`backtest/` runner, gitignore, no deps) | delegated | originally `inline`; amended — executed inside T2's writer, see *Route amendment* |
| T2 | Bitstamp OHLCV ingest (paginated, 5m BTC/USD) | delegated | external API shape + pagination design + writing one non-trivial file |
| T3 | Port `session-markers.pine` → JS | delegated | reading 1 module (134 lines) prepares a write; 1 file |
| T4 | Port `liquidity-zones.pine` → JS | delegated | 321 lines, array-heavy; reading prepares a write |
| T5 | Port `structure-break.pine` → JS | delegated | swing state machine; reading prepares a write |
| T6 | Port `imbalance-detector.pine` → JS | delegated | 311 lines, lifecycle state; reading prepares a write |
| T7 | Port `signal-engine.pine` → JS | delegated | weights + gate + scoring; reading prepares a write |
| T8 | **Fidelity gate** against `docs/VALIDATION.md` | parent + verifier | verification of delegated work; parent spot-check mandatory |
| T9 | Outcome labelling (D.4 target/stop, forward return) | delegated | design decision + one non-trivial file |
| T10 | Baseline: current weights, threshold 70 | delegated | runs over harness |
| T11 | Binary model (D.1) baseline | delegated | runs over harness |
| T12 | Weight search + ranking | delegated | search harness + one non-trivial file |
| T13 | Findings report + delivery | parent | synthesis is orchestrator work |

Mapping trigger: understanding the port requires all five modules (4+ files),
so module porting is delegated rather than read into the parent context.
Writer trigger: each port produces one file; T12 and T9 produce non-trivial
single files. All fall on the delegated side.

## Tasks

### T1 — Harness scaffolding ✅ (delivered in slice 1 · GitHub PR #12)

- [x] Create `backtest/` with a single `run.mjs` entrypoint.
- [x] No `package.json`, no dependencies — bare `node backtest/run.mjs`.
- [x] Add `backtest/data/` to `.gitignore`.
- [x] Runner supports subcommands: `fetch`, `validate`, `baseline`, `search`.

The three unimplemented subcommands are **stubs that exit 1 while naming their
task** (`T8 fidelity gate`, `T10/T11 baselines`, `T12 weight search`) rather
than exiting 0 — so no future check can read a placeholder as success.

### T2 — Historical data ingest ✅ (delivered in slice 1 · GitHub PR #12)

- [x] Fetch BTC/USD 5m OHLCV from Bitstamp's public endpoint (no credentials).
- [x] Paginate backwards; persist raw candles under `backtest/data/` (gitignored).
- [x] **Range requirement — corrected during implementation.** Originally
  written as "≥ 6 months / ~52,560 bars", which turned out to be **insufficient**:
  the earliest confirmed gate reading is **7 Mar 2026** (DST transitions) and six
  months back from 30 Sep 2026 reaches only ~2 Apr 2026. Corrected to
  **≥ 215 days / ≥ 62,000 bars**, which reaches **27 Feb 2026** and covers both
  DST readings plus a preceding day for D1 context. At 288 bars/day the two
  constants are consistent (215.3 × 288 ≈ 62,000).
- [x] Record source, timezone, and the exact span in the run output.

**Delivered:** 62,000 candles, `2026-02-27T12:10Z` → `2026-09-30T18:45Z`,
215.2743 days, **0 gaps**, 0 off-grid, 0 duplicates, 105 HTTP requests total,
timezone UTC (epoch ms). `covers 2026-03-07: true`, `covers 2026-03-10: true`.
Dataset is gitignored; `git check-ignore` confirms both data files.

**Defect found and fixed during implementation:** `cmdFetch` trusted the
*stored* `meta.status === "complete"` and `meta.targetMet` instead of
recomputing them against the `TARGET_*` constants in effect. Raising the target
therefore left a cached "complete" that printed `target MET` with **zero**
network activity — a false pass. `loadState` now recomputes the verdict from the
candles on disk (preserving a genuine `shortfall`, which recomputation cannot
un-know) and warns whenever the stored claim disagrees. This is the same
principle the function already had for `meta.count`; it simply did not extend it
to the verdict.

### T3 — Port `session-markers.pine` ✅ (delivered in slice 2 · GitHub PR #13)

- [x] Port UTC session windows, overlap detection, DST handling, and the
  `sessionStrength` / `sessionMultiplier` exports.
- [x] Do **not** port drawing (boundary lines, boxes) — logic only.
- [x] Emit the same values the Pine module would on the same bar — **all five
  confirmed timezone/DST readings from `docs/VALIDATION.md` reproduced**, plus
  17 more session checks (22 total, bare Node, zero files written).

### T4 — Port `liquidity-zones.pine` ✅ (delivered in slice 2 · GitHub PR #13)

- [x] Port pivot detection (§3.2.1), zone construction (§3.2.2), hierarchy and
  filtering (§3.2.3), and proximity check (§3.3).
- [x] Respect `maxZones` and the array budget rules (13 births at
  `maxZones:10` → max observed count 10, oldest evicted, 31 checks total).
- [x] Do **not** port `box.new` / drawing — logic only.
- [x] Array semantics — **this line was wrong until the T4 port caught it.**
  It originally claimed *"Pine arrays are 1-indexed"*; that is **false**, and
  applying a −1 base conversion would have shifted every boundary in the
  module. Evidence: every loop in `liquidity-zones.pine` reaches index 0
  (`:187`, `:218`, `:245`, `:293` — including `for i = array.size(zones) - 1
  to 0`), and D.2's own block runs the same down-to-zero form. What D.2
  actually flags (spec lines 1868–1871) is different: **parallel arrays
  mutated in lockstep while removals skip `box.delete`**, leaving the drawing
  and the logic out of sync. The genuine indexing trap is therefore **loop
  bounds**: Pine's `a to b` is inclusive at *both* ends, unlike JS, so each
  site needs its own decision (`size-1 to 0` ↔ `i >= 0`, not `i > 0`). The
  port documents every one of those decisions next to the code.

### T5 — Port `structure-break.pine` ✅ (delivered in slice 3 · GitHub PR #14)

- [x] Port swing point tracking (§6.2), swing state management (§6.3), break
  detection (§6.4), and the break/reversal/orphan-flip outputs.
- [x] Do **not** port line/label drawing — logic only.
- [x] **Origin corrected during implementation:** those diagnostic counters are
  *not* module outputs. They live in `scripts/build.mjs` as
  `STRUCTURE_DIAGNOSTIC_OVERLAY` (lines 533–556), appended only under
  `--diagnostic`. Ported from the overlay; the file header states this.

### T6 — Port `imbalance-detector.pine` ✅ (delivered in slice 3 · GitHub PR #14)

- [x] Port candle body imbalance (§5.2.1), the volume-confirmation signal, and
  the lifecycle (§5.3) including `imbUntouched + imbTouched == imbLive`.
- [x] Preserve the counts tautology as an internal assertion — it is the cheap
  correctness probe that already caught one transcription error. Now an
  **always-on `throw` on every bar** (`imbalance-detector.mjs:422`), not a
  plotted value.
- [x] **Scope correction — this line was wrong until the T6 port checked it.**
  It originally said *"volume delta imbalance (§5.2.2)"*. The delta flags
  (`candleDelta`, `avgDelta`, `deltaBullish`, `deltaBearish`) exist **only in
  the spec**: a grep for `delta` under `src/` returns no matches, and
  `signal-engine.pine:136` consumes only `volumeConfirmed`. Porting them would
  have given the harness a signal the shipped indicator never emits — a
  backtest of a feature that does not exist. **Not ported, deliberately.**
  Same class of error as the T4 "1-indexed" claim: spec prose is not a
  substitute for reading the source.

### T7 — Port `signal-engine.pine` ✅ (delivered in slice 4 · GitHub PR #15)

- [x] Port the 10 weights, the factor set, the `sessionOK` gate, and score
  arithmetic (max 110, threshold 70).
- [x] Make the weight vector and threshold **parameters of the harness**, not
  constants — this is the entire point of the feature. Flat
  `SIGNAL_ENGINE_DEFAULTS` plus exported `SIGNAL_ENGINE_WEIGHT_KEYS` in Pine
  order for T12's search; `maxScore` is derived from the configured vector.
- [x] Emit the per-factor contributions so results are explainable, not opaque
  — `longFactors` / `shortFactors`, each `{ liquidity, session, structure,
  imbalance, volume }`, with `sumFactors(...) === score` enforced.

### T8 — Fidelity gate (HARD STOP) ✅ (ran in slice 4 · PASS 9/9)

- [x] Extract every confirmed reading from `docs/VALIDATION.md` that has an
  exact date, crosshair position, and legend value — **8 of the 35 `confirmed`
  rows are bar-scoped and replayable**; the class B/C split is printed by the
  gate on every run.
- [x] Replay the port over the matching bars and compare field by field —
  `node backtest/run.mjs validate` → **`GATE RESULT: PASS — 9/9 Class A
  readings reproduced`**, exit 0. Re-run independently by the orchestrator,
  same result.
- [x] **Any mismatch stops the feature.** None occurred.
- [x] Record pass/fail per reading; the gate prints the full table, every
  assumption (A1–A7), every excluded row with its reason, and every
  brief-vs-source disagreement (D1–D5). Nothing is summarized away.
- [x] Note honestly what the gate does **not** prove: 8 of 35 confirmed rows,
  chosen for legibility rather than sampled at random; it never executes Pine;
  it says nothing about the weights as trading parameters (`:309`, not
  attempted by design).

**Finding D1 — a real defect in `docs/VALIDATION.md`, now corrected there.**
The DST and weekend captures were labelled `timeframe 4H`, but the diagnostic
legend samples **the first bar inside the session** (`scripts/build.mjs:345`,
`ta.change(inX) and inX`, held with `var`), so it is grid-dependent. The three
session opens sit on three different residues mod 4 — on a 4H grid the tuples
would read `0/8/16`, `16/0/4`, `0/8/12`, `4/12/20`, `8/12/20`, never the
recorded `0/7/13`, `15/22/4`, `23/6/12`, `4/11/17`, `5/12/18`. **The label was
wrong, not the values.** Both labels changed to `1H or finer`, with the proof
written into `docs/VALIDATION.md` as *Correction: the `4H` label*.

**Finding D2 was downgraded by the orchestrator, not accepted.** The worker
argued the crosshair times (`22:00`, `02:00`) prove the display was UTC-6.
That arithmetic only holds **given a 4H grid** — once D1 removes the 4H label,
those times are equally valid bar times under `America/New_York` on a finer
grid. D2 is a consequence of the same mislabel, not independent evidence, and
is not recorded as established.

> **⚠️ Redesign required — the checklist above as originally worded is
> unsatisfiable, and was caught before any porting began.**
>
> A feasibility check against `docs/VALIDATION.md` found its 35 `confirmed`
> rows are **not one gate** but three different classes:
>
> | Class | Examples | Replayable locally? |
> |---|---|---|
> | **Bar-scoped** — crosshair position determines the value | timezone legends `0/7/13` `15/22/4` `23/6/12` `4/11/17`; DST `5/12/18` → `4/11/17` on 7/10 Mar 2026; weekend `sáb 26 Sep '26 - 02:00`; `volumeConfirmed` = 1 at 30 Sep 10:05 | ✅ **this is the gate** |
> | **Range-scoped** — depends on how much history TradingView had loaded | `Asia 42 edges / 21 lines`, `24 live D1 zones`, `IMB DIAG virgin gaps = 2`, `budget = 1` | ❌ the load window is recorded nowhere and cannot be derived from our dataset |
> | **Static / visual** | `Compiles` ×5, `Renders alongside`, identifier sweeps, `sb_ prefix avoids collision` | ❌ no local Pine compiler exists |
>
> Replaying range-scoped counts would mean *guessing* the load window, which
> manufactures false failures or false passes — both worse than omitting them.
>
> **So T8 becomes an explicit allowlist** of bar-scoped readings plus one
> data-free assertion, and the gate report must state why the other two classes
> are out of scope rather than silently dropping them.
>
> Additional requirements the checklist above did not carry:
>
> - **Timeframe:** the weekend reading was labelled **4H**, and the gate
>   proved that label impossible (*Finding D1* — the legend samples the first
>   bar inside the session, so it needs a grid no coarser than 1H). The harness
>   still aggregates 5m → 4H (48 bars), because the weekend tint claim is a
>   bar-set claim at that scale, plus D1 (288) and 1H (12) which the Signal
>   Engine already needs.
> - **Timezone:** readings are written in *exchange*-local time
>   (`sáb 07 Mar '26 - 22:00`). Bar *boundaries* are proven UTC from
>   Bitstamp's native daily bars; the *display* clock was confirmed by the
>   maintainer's chart screenshot as **UTC-6** on 2026-09-30, cross-checked
>   against two known UTC merge instants. Rows that name `America/New_York`
>   used that zone instead, so the gate resolves each reading with the zone its
>   own row records — and prints both candidates for the one row (`:224`) that
>   records none.
> - **Data-free assertion:** `Score arithmetic` (row at line 307 — all 192
>   combinations, max 110, every tier reaches 70) is pure arithmetic over the
>   weight table and needs no candles. It was previously unused and is the
>   cheapest strong check available.

### T9 — Outcome labelling ✅ (delivered in slice 5 · GitHub PR #17)

- [x] Define one label per signal using the spec's own D.4 parameters
  (target 1.5%, stop 0.8%) as the primary definition — `labelExitRule` /
  `labelSignalsExitRule`, with the 1.5/0.8 values read from
  `technical-spec.md:1961-1965` and TradingView's `profit`/`loss` read as
  position P&L, so a short wins when price falls.
- [x] Also record raw forward return at fixed horizons as a secondary,
  assumption-light definition — `labelForwardReturn` over horizons
  6/12/24/48/96/288, `null` and never `0` for an unobserved close.
- [x] Document both; report results under both — `backtest/baseline.mjs`
  prints them side by side, so no conclusion rests on one exit rule.

**Two decisions worth keeping.** (1) Fewer than one horizon of candles left
after a signal ⇒ `insufficient_data`, decided **before** any scan rather than
scanned and then called a win: at the dataset edge a touch is only observable
if it happens early inside the truncated window, so partial observation would
bias the hit rate upward. The exclusion is position-based and therefore
independent of outcome. (2) A bar whose range straddles both target and stop
counts as a **loss**, the conservative reading, and the raw `doubleTouchCount`
is printed next to every hit rate so a reader can see what that rule moves.

**Correctness is proven by construction, not by running it.** 60 hand-computed
synthetic fixture checks were appended to `backtest/smoke.mjs`, none of which
reads the dataset. Suite 1153 → 1213, `failed: 0`.

### T10 — Baseline: current configuration ✅ (delivered in slice 5 · GitHub PR #17)

- [x] Run the port with the shipped weights and threshold 70 over the dataset.
- [x] Report signal count, hit rate, distribution of scores, and outcome under
  both label definitions — `node backtest/run.mjs baseline`.

**Result (62,000 bars, 215.27 days, 0 gaps).** The weighted model fires on
**2 bars out of 62,000**. Its 393 raw candidates are rejected 391 times by
the threshold alone: candidates cluster at 40–60 and the observed score
ceiling on this dataset is **80 against a configured `maxScore` of 110**. Its
D.4 hit rate is `0.00%` — 0 win, 1 loss, 1 insufficient — which on n=2 is not
a measurement, and the report says so instead of inviting the comparison.

### T11 — Binary model baseline (spec D.1) ✅ (delivered in slice 5 · GitHub PR #17)

- [x] Implement the strict binary model exactly as D.1 specifies.
- [x] Report the same metrics as T10 — same bars, same labels, same report.
- [x] This is the comparison the whole feature exists to make. **Answered:
  the binary model wins decisively on this dataset — but the result is
  dominated by the timeframe, not by the weights. See caveat C0 below.**

**Result.** 393 raw candidates → **133 fired** after cooldown (260
suppressed, 0 removed by exclusivity, 0 ambiguous ties). D.4 hit rate
**41.59%** — 47 win, 66 loss, 18 timeout, 2 insufficient — long 40.00%, short
43.40%. Forward return positive on 51.15% of signals at 288 bars against the
weighted model's 0.00%.

**The comparison is exact, not approximate.** D.1's strict expression is
`signal-engine.pine:165-171` minus the single `longScore >= minConfidence`
term, and `sessionOK` is `sessionStrength >= 2` in both (pine:83, spec:1845).
The binary model therefore consumes the engine's own 23-field input contract
instead of re-deriving one, and `weighted.raw => binary.strict` is asserted
across all 124,000 bar-side checks with 0 violations.

**Cooldown state is per-model, deliberately.** Because binary fires more often
it enters cooldown more often, which can suppress a bar where weighted would
have fired. So **weighted-fired is *not* a subset of binary-fired** on the
final flags — each model owns its exclusivity and cooldown state, exactly as
each would alone on the chart. That relation holds only at the raw level,
where it is asserted on every bar. Conflating the raw gap (the threshold
alone) with the fired gap (threshold plus downstream dynamics) would
misattribute the result, so the report prints both and labels them.

**Caveat C0 governs how any of the above may be read.** Every number is scoped
to **5-minute data**. The multi-timeframe liquidity tiering that produces the
score's largest single component barely materialises at that resolution: D1
qualifies **0/192** long and **0/201** short candidates, H4 only **7/192**
long, because a D1 pivot needs 21 completed daily bars and the run supplies
them only from bar 8,205. The weighted model's near-zero firing rate is
therefore a property of **this timeframe as much as of these weights**, and is
not a verdict about the weight vector on its intended timeframe. C0 is printed
first in the report and pointed at from both headline sections, so a single
copied line cannot lose the scope.

**Costs are not modelled.** Labels are gross of slippage, commission, fees,
funding and spread, while D.4's own strategy declares `commission_value=0.05`
and `slippage=2` — every hit rate here is an **upper bound** on what that
strategy would realise.

### T14 — Liquidity tier diagnostic ✅ (delivered in slice 6 · GitHub PR #18)

*(Inserted after T11 and before T12, so the numbering skips — it is not a
renumbering mistake. It answers the question caveat C0 left open, and T12 is
worthless until it is answered.)*

- [x] Determine whether the weighted model's near-zero firing rate is a
  property of the 5m data or a defect in tier assignment — the precondition
  for T12 being worth running at all.
- [x] Do it without moving the baseline: **no baseline number may change.**
  Verified by diffing the full baseline output — all 130 substantive lines
  byte-identical.

**Verdict: property of the data, and the mechanism is geometric.** A D1 zone
body is `0.5 ×` its **own** timeframe's ATR, while the proximity band is
`3 ×` the **5m chart** ATR. The median D1 half-width is therefore **5.04×**
the band, so price is always already *inside* a D1 zone before it can ever be
*near* one — and the in-body exclusion, which Pine performs identically,
withholds the flag **by design**. All **1,377** D1 bar-zone pairs falling
inside the band were in-body, leaving **0 eligible**. H4 is `1.68×` and does
fire 48 times; H1 is `0.78×` and fires 2,113.

**The defect hypothesis is closed, not merely unsupported.** D1 is not absent:
3,436 zones are created, live on 7,269 bars, last created at bar 60,908. The
post-warm-up tier mix is unchanged, so it is not warm-up arithmetic. And the
candidate tier mix **equals** the global tier mix (H1 lift 0.985 long, 1.023
short), which **refutes the premise of the diagnostic's own brief** — nothing
selects against D1 at signal moments.

**The quotable consequence.** On 5m data an H1 candidate tops out at **60**
and only an H4 candidate can reach **70**. That is why `minConfidence 70`
admits 2 of 393 candidates. **The threshold is not a statement about the
weight vector on this dataset.**

**Fifth brief-vs-source disagreement.** The brief said to read the
qualifying-tier rule from `liquidity-zones.mjs`. That module does not assign
a qualifying tier at all — it stamps a tier per zone and emits six booleans.
The single-tier reduction lives in `signal-engine.mjs:355-362` (Pine
`signal-engine.pine:64-66`). The port matches Pine expression for expression.

### T15 — Second-timeframe measurement ✅ (delivered in slice 7 · GitHub PR #19)

*(Also numbered out of order, deliberately. It exists because slice 6 proved
that on 5m data the D1/H4 tier dimensions are geometrically degenerate, which
makes T12 unfittable there. The maintainer explicitly lifted the "5m only"
constraint on 2026-10-01 to allow this.)*

- [x] Fetch 1h and 4h datasets from the same Bitstamp endpoint (5 years each).
- [x] Parameterize `fetch`, `baseline` and `diagnose` by timeframe, with 5m
  remaining the default so every existing command is unchanged.
- [x] Answer the question slice 6 left open: **does the D1 tier become
  reachable on 1h/4h?** Slice 6 predicted it should — the geometric contest
  changes from `0.5 × D1-ATR` versus `3 × 5m-ATR` (5.04×, hopeless) to
  `0.5 × D1-ATR` versus `3 × 1h-ATR`, a far closer contest.
- [x] Produce the three-timeframe comparison side by side, and state what it
  means for T12.
- [x] Keep the gate **5m-only by construction** — `--timeframe 1h` on
  `validate` refuses with an explained message instead of a meaningless
  comparison.

**The prediction held, unambiguously, on both grids.** The mechanism did not
change and neither did the port — only the native grid moved:

| | 5m | 1h | 4h |
|---|---|---|---|
| D1 zone body / proximity band (median) | 5.04× | **1.03×** | **0.50×** |
| D1 bar-zone pairs in band | 1,377 | 38,255 | 18,026 |
| …of which in-body | 1,377 | 33,149 | 10,566 |
| …**eligible** | **0** | **5,106** | **7,460** |
| `nearD1` flag fires | 0 | **256** | **1,229** |
| verdict | unreachable | **qualifies** | **qualifies** |

The discriminator `(eligible>0) === (flag fires>0)` holds on all three grids.

**This is where the feature's question gets answered.** On 1h — the grid
where the tier dimension is live and the sample has a size worth measuring:

| | 5m | 1h | 4h |
|---|---|---|---|
| raw candidates | 393 | **7,924** | 2,583 |
| weighted fired | 2 | **307** | 49 |
| binary fired | 133 | **1,701** | 446 |
| D.4 hit — weighted | 0.00% *(n=2)* | **31.25%** *(n=307)* | 42.22% *(n=49)* |
| D.4 hit — binary | 41.59% | **33.75%** | 31.02% |
| delta (binary − weighted) | +41.59 pp | **+2.50 pp** | −11.20 pp |
| score ceiling observed | 80 | **90** | 70 |
| rejected at `minConfidence 70` | 391 | 7,510 | 2,513 |

**On 1h the binary model is ahead by 2.50 pp** (33.75% vs 31.25%). That is the
first measurement in this feature where the weighted model's sample is large
enough for its hit rate to mean anything rather than being a ratio over two
observations.

**Two caveats constrain every cross-grid comparison, and both are printed in
every report:**

- **Horizon semantics stretch with the grid.** 288 bars is 24h on 5m, **288h
  (12 days) on 1h**, **1,152h (48 days) on 4h**. Definition A and Definition B
  are held at a constant *bar* count, so **cross-timeframe hit-rate deltas are
  not like-for-like.** The 0.00% vs 42.22% spread is mostly a horizon
  difference, not a model difference.
- **Three grids are not three independent samples.** The same price action
  appears in all three runs, so a weight vector that wins on all three is one
  observation reported three ways.

**The 4h run is not a faithful Pine-on-4h reproduction.** Pine's
`request.security(syminfo.tickerid, "60", …)` (`liquidity-zones.pine:95-96`)
returns **1h bars even on a 4h chart**, so a 4h dataset has no 1H candles to
aggregate. That tier is reported as `unavailable` / `not measurable` in every
table rather than as a row of zeros — a zero row would read as "the H1 tier is
worth nothing", which is a finding this grid cannot support. **Any T12 result
touching the structure weights must exclude 4h.**

**What T12 may now do.** On 1h the score dimension is fully live: D1
candidates reach 80, H4 and H1 reach 90 against a configured `maxScore` of
110; 414 of 7,924 candidates clear the threshold; 307 signals fire. That is
the precondition slice 6 said was missing. **On 5m a search remains
degenerate and must not be run there as a verdict on the weight vector.** On
4h the tier moves too, but the sample is thin, the 1H tier is absent and the
horizons stretch to 48 days — usable as a second result, not the primary one.

**Datasets**: 1h = 44,000 bars / 1833.29 days / 44 requests; 4h = 11,000 bars /
1833.17 days / 11 requests; both with 0 gaps, 0 off-grid, 0 duplicates. The 5m
dataset was not disturbed — `fetch` reported *already complete, 0 requests*.

**Endpoint facts, verified rather than assumed** (recorded because the
orchestrator got the response shape wrong twice before catching it): the array
is `data.ohlc`, **not** `data.ohlcv`; every field is a string; pagination is
backwards via `end` only; steps 60/300/900/1800/3600/14400/86400 all serve; 1h
and 4h both reach back to **at least 2011-09-01**.

**Two smoke checks failed on the writer's first run and both were wrong
assertions, not wrong code** — one asserted a source string that a legitimate
rename changed, one asserted that a 1h-complete dataset fails the 4h target
(it does not; both target the same 1825-day span and only the bar floor
differs). The assertions were corrected and the implementation was not.

### T16 — Dependence-aware comparison ✅ (delivered in slice 8 · GitHub PR #20)

*(Inserted before T13, not numbered in sequence. The findings report cannot
state whether the 1h result means anything until this exists — writing
"binary wins by 2.50 pp" without knowing whether 2.50 pp survives the
dependence would repeat exactly the mistake this project has already made
twice: publishing a number without its condition of validity.)*

- [x] Quantify how much the baseline hit rates overstated their own evidence.
  Labels walk 288 bars forward and the cooldown is 10 bars, so two signals 10
  bars apart share **278 of 288** forward bars.
- [x] Build clusters independently per model — the two models have different
  signal sets and do not share a partition.
- [x] **Paired** cluster bootstrap, fixed seed **20260901**, 10,000 draws.
- [x] Report the 95% interval of `binary − weighted` per side and per grid,
  and a plain verdict.
- [x] Secondary check under Definition B at every horizon.
- [x] The n-versus-cluster collapse ratio as the headline.

**The result is worse than "fewer effective observations", and it is the most
important finding in the project.** On 1h, **binary's 1,701 signals form a
single cluster** — its largest consecutive gap in five years is **261 bars**
against a 288-bar horizon, so there is no gap at all. The whole five-year run
is one unbroken chain of overlapping forward windows. Weighted collapses
307 → **45** clusters; binary 1,701 → **1**.

**The paired bootstrap therefore has exactly one resampling unit on 1h, and
the +2.50 pp difference cannot be intervaled at all.** Not "the interval is
wide" — there is no interval. So both of these are false and neither may be
reported: *"binary is better by 2.50 pp"* and *"the two are
indistinguishable"*. Each presupposes an interval that does not exist. The
honest word is **indeterminate**.

**The only interval computable anywhere** is 1h-short: **+3.72 pp observed,
95% CI [−3.54 pp, +9.55 pp], does not exclude zero.** 4h points the opposite
way (−11.20 pp) and is equally un-intervalable — one measurement at two
resolutions, not one refuting the other.

**What survived, and matters more:** under Definition B **both models have
negative mean forward returns at every horizon** (1h, 24 bars: weighted
−0.51%, binary −0.11%). This is not a difference between models, so the
dependence problem does not touch it. The intervals on the *difference* do
exclude zero in binary's favour at 12–96 bars, so binary is measurably less
bad — but the shorter horizons are exactly the computable ones, which makes
this a different measurement from the 288-bar D.4 question, not a
confirmation of it.

### T13 — Findings report and delivery ✅ (delivered in slice 8 · GitHub PR #20)

- [x] Write the findings into `docs/` in English — `docs/WEIGHT-CALIBRATION.md`.
- [x] State plainly whether weighted beats binary, ties, or loses — **neither
  is available, and the report says so rather than picking one**.
- [x] No candidate weight vector emerged, so nothing is presented as evidence
  for a weight change.
- [x] Land through the repo PR convention.

**The report leads with the negative-expectancy finding, not the model
comparison**, because the model comparison is indeterminate and the
expectancy finding is not.

### T12 — Weight search

- [ ] Search over weight vectors and thresholds (random or coordinate search;
  the space is 10 weights + threshold, too large for exhaustive enumeration).
- [ ] Evaluate every candidate under **both** label definitions.
- [ ] Guard against overfitting: report train/holdout splits rather than a
  single in-sample winner. An in-sample-only result is not a calibration.
- [ ] Report the top configurations with their metrics and their deltas versus
  both baselines.

## Acceptance criteria

1. `node backtest/run.mjs validate` reproduces every confirmed reading it
   attempts, or reports precisely which ones fail.
2. The fidelity gate result is published verbatim, pass or fail.
3. Baselines for both the weighted and binary models exist under both label
   definitions.
4. Any weight search result reports a holdout evaluation, not in-sample only.
5. The production Pine build is byte-identical
   (`1DD6F536AE4F50C2F669E9C1A2B34A0FB97A7D51428905B9E18F8616D1582CE2`).
6. No Pine source is modified by this feature.
7. No "calibrated" or "improved" claim appears anywhere before the fidelity
   gate passes.

## Applicable checks

- `node backtest/run.mjs validate` — fidelity gate
- `node backtest/run.mjs baseline` — both models, both label definitions
- `node backtest/run.mjs search` — reports holdout metrics
- `node scripts/build.mjs` then confirm the production SHA
- `git status --short` — no Pine source changed, no data committed

## Forecast

Authored changed lines (additions + deletions, generated/raw data excluded),
derived from the task list at creation time:

| Area | Estimate |
|---|---|
| T1 scaffolding | ~120 |
| T2 ingest | ~180 |
| T3–T7 ports (404 Pine logic lines → JS) | ~600–750 |
| T9 labelling | ~150 |
| T10–T12 baselines + search | ~350–450 |
| T13 report (docs) | ~200 |
| **Total forecast** | **~1,600–1,850** |

**This exceeds the ~400 authored-line delivery budget by a wide margin**, so
the delivery strategy had to be selected before the first commit (Review
Workload Guard). `ask-on-risk` fired and the user selected `stacked-to-main`
before any source was written — see *Delivery strategy* below.

## Delivery strategy

- `delivery_strategy`: `ask-on-risk` (default; triggered by the forecast)
- `chain_strategy`: **`stacked-to-main`** — selected by the user before the
  first commit. Each slice merges to `main` in order; `main` stays usable
  throughout. Chosen because the work is purely additive (a new `backtest/`
  directory, zero Pine source changes), so incremental merging carries no risk
  to the shipped indicator.
- `size:exception`: not used.

### Slice boundaries

Forecast per slice is authored lines (additions + deletions). Target ~400 per
slice; the per-task 400-line figure remains an advisory planning heuristic, not
an acceptance criterion.

**Numbering:** "PR *N*" in this document means **slice *N*** of the stacked
chain — it is *not* the repository's GitHub PR number, which GitHub assigns
independently. Real numbers are recorded in *Progress* as each slice lands:
slice 1 shipped as GitHub PR **#12**. Without this note the T1 and T2 headings
above and the progression notes below would read as though the slices were
numbered by GitHub.

| PR | Tasks | Contents | Forecast |
|---|---|---|---|
| 1 | T1 + T2 | Harness scaffolding + Bitstamp 5m ingest | ~300 |
| 2 | T3 + T4 | Port session-markers + liquidity-zones (the *context* modules) | ~410 |
| 3 | T5 + T6 | Port structure-break + imbalance-detector (the *trigger* modules) | ~410 |
| 4 | T7 + T8 | Port signal-engine + **fidelity gate** (engine and its gate belong together) | ~380 |
| 5 | T9 + T10 + T11 | Outcome labelling + both baselines | ~350 |
| 6 | T14 | Liquidity tier diagnostic — closes C0's open question before T12 | ~200 |
| 7 | T15 | Second timeframe: 1h + 4h datasets and the three-timeframe measurement | ~500 |
| 8 | T16 + T13 | Dependence-aware comparison + findings report | ~450 |
| 9 | T12 | Weight search (deferred — its objective depends on T13's recommendation) | ~450 |

If slice 8 exceeds ~400, it splits into T16 (analysis) and T13 (report) — the
report is documentation and can ship on its own.

**Gate on progression:** slice 4 contains the fidelity gate. Slices 5 and 6 do
not start until that gate is reported. A failed gate blocks the slices that
depend on a trustworthy port; it does not block slices 1–3, which are
infrastructure and ports whose correctness is established by the gate itself.

**Second gate, added after slice 5:** slice 6 (T14) must report whether the
weighted model's near-zero firing rate is a data property or a defect before
T12 runs. It reported a data property, so **T12 on this dataset would be
fitting a degenerate D1/H4 dimension** — either the objective must be narrowed
to the non-tier factors, or higher-timeframe data must be used.

### Route amendment

- **T1** was originally declared `inline`. It is executed **together with T2
  inside one delegated writer**, because both land in slice 1, the runner's
  subcommand surface is what T2 implements, and splitting them would have the
  parent author a file's skeleton that the writer then completes. Recorded
  here so the skipped inline route stays observable instead of silent.
- **T8 (fidelity gate)** stays parent-owned: verification of delegated work is
  a parent responsibility and gets an independent verifier.

## Progress

- [x] Task document created (this file)
- [x] Delivery strategy selected: `stacked-to-main`, 6 slices
- [x] Fidelity-gate feasibility check (found and fixed the T2 range target and
      the T8 scope defect *before* any porting)
- [x] **T1 + T2 — slice 1 delivered** (harness scaffolding + Bitstamp 5m
      ingest) → shipped as **GitHub PR #12** (merge commit `f21edda`, two
      commits, zero labels, branch deleted)
- [x] RDD set **clone-local off** at the user's explicit request, after
      OpenCode proved unable to complete an immutable receipt review; global
      untouched. Delivery now follows ordinary repository policy.
- [x] **T3 + T4 — slice 2 delivered** (port session-markers + liquidity-zones)
      → shipped as **GitHub PR #13**. 807 ported lines (899 authored in the
      PR), 53 smoke checks passing, production SHA byte-identical, `src/`
      untouched. The writer also caught a **factual error in this document's
      T4**: Pine arrays are 0-indexed, not 1-indexed — corrected above and in
      the PR description.
- [x] **T5 + T6 — slice 3 delivered** (port structure-break +
      imbalance-detector) → shipped as **GitHub PR #14**. 772 authored module
      lines, **715 smoke checks** passing (96 + 619), production SHA
      byte-identical, `src/` untouched. Second false premise caught by a
      writer: T6's *"volume delta imbalance (§5.2.2)"* does not exist in
      `src/` — corrected above, same class of error as T4's *"1-indexed"*.
      A rule is now established: **if the brief and the shipped Pine source
      disagree, the source wins and the disagreement gets reported.**
- [x] **T7 + T8 — slice 4 delivered** (port signal-engine + fidelity gate)
      → shipped as **GitHub PR #15**. **T8 verdict: `GATE RESULT: PASS — 9/9
      Class A readings reproduced`**, independently re-run by the orchestrator
      with the same result (smoke 1153/0, production SHA byte-identical,
      `src/` untouched). 1,389 lines of module and gate code (597 signal-engine
      + 835 gate), 957-line smoke suite moved from `Temp\` into the repo so it
      survives a clean checkout, `CHART_TIMEZONE` constant corrected.
      **Fourth brief-vs-source disagreement, this time against the
      orchestrator's own brief**: it said the engine consumed session
      *multipliers*; `signal-engine.pine:83` gates on
      `sessionOK = sessionStrength >= 2` and the source comment states the
      multiplier is deliberately unused — scaling a weak setup down is not the
      same as suppressing it. Ported the source. **Two documentation defects
      found**: the `4H` label in `docs/VALIDATION.md` (corrected with proof) and
      `backtest/run.mjs:69`'s `CHART_TIMEZONE = "exchange"` presented as a
      chart observation when it is the indicator's input default.
- [x] **T9 + T10 + T11 — slice 5 delivered** (outcome labelling + both
      baselines) → shipped as **GitHub PR #17**. **The comparison this whole
      feature exists to make now exists and is published**: over 62,000 5m
      bars the weighted model fires **2** times and the binary model **133**;
      D.4 hit rate `0.00%` vs `41.59%`. **The result is dominated by the
      timeframe, not by the weights** — caveat C0: the score ceiling on 5m
      data is 80 against a configured `maxScore` of 110, because D1 liquidity
      qualifies 0 of 393 candidates. Two orchestrator decisions made here:
      splitting T9 from T10/T11 into two sequential writers (the labelling
      module is independently provable on synthetic fixtures before anything
      consumes it), and requiring caveat C0 after the orchestrator's own
      read-through found the headline quotable without its scope limit. The
      orchestrator independently re-ran `baseline` and reproduced every number
      verbatim.
- [x] **T14 — slice 6 delivered** (liquidity tier diagnostic) → shipped as
      **GitHub PR #18**. **Verdict: property of the data, not a defect.** The
      D1 tier is unreachable on 5m *by geometry* — the median D1 zone body is
      **5.04×** the proximity band, so price is always already inside the zone
      before it can be near it, and Pine's in-body exclusion withholds the flag
      by design; **0 of 1,377** in-band D1 pairs were eligible. D1 is not
      absent (3,436 zones created, live on 7,269 bars, last at bar 60,908), the
      post-warm-up mix is unchanged, and the candidate tier mix equals the
      global mix — so this is not warm-up arithmetic and nothing selects
      against D1 at signal moments. Baseline output byte-identical on all 130
      substantive lines. **This closes the precondition for T12**: a weight
      search here would fit a degenerate D1/H4 dimension.
- [x] **T15 — slice 7 delivered** (second timeframe: 1h + 4h and the
      three-timeframe measurement) → shipped as **GitHub PR #19**. **Slice 6's
      prediction held**: the D1 tier is unreachable on 5m (body/band 5.04×,
      0 eligible pairs) and **qualifies on 1h (1.03×, 5,106 eligible, 256
      fires) and 4h (0.50×, 7,460 eligible, 1,229 fires)** — the mechanism and
      the port unchanged, only the native grid moved. **The feature's question
      is answered on 1h**: weighted fires 307 with a **31.25%** D.4 hit rate
      against binary's **33.75%** over 1,701 — **binary ahead by 2.50 pp**,
      and the first measurement here where the weighted sample is large enough
      for its hit rate to mean anything. **But cross-timeframe hit rates are
      not like-for-like**: 288 bars is 24h on 5m, 288h on 1h and 1,152h on 4h,
      so most of the 0.00% → 42.22% spread is a horizon difference, not a
      model difference. The 4h run is also **not** faithful Pine-on-4h, because
      Pine's `request.security` always requests 1h regardless of chart
      resolution. Gate stays **5m-only by construction** and now refuses any
      other timeframe with an explained message. Scope lift and the verified
      endpoint facts are recorded above.
- [x] **T16 + T13 — slice 8 delivered** (dependence-aware comparison + the
      findings report) → shipped as **GitHub PR #20**, report at
      `docs/WEIGHT-CALIBRATION.md`. **The comparison the whole feature existed
      to make turned out to be unmeasurable as designed**, and finding that out
      is the slice's result: on 1h, **binary's 1,701 signals form a SINGLE
      cluster** — largest gap in five years 261 bars against a 288-bar horizon,
      so there is no gap. Weighted collapses 307 → 45 clusters, binary 1,701 →
      **1**. **The +2.50 pp difference cannot be intervaled at all**, so neither
      "binary is better" nor "they are indistinguishable" may be reported —
      both presuppose an interval that does not exist. The only interval
      computable anywhere is 1h-short: **+3.72 pp, CI [−3.54, +9.55]**, which
      includes zero.
      **What survived the dependence problem is more useful than the model
      comparison:** under Definition B **both models have negative mean forward
      returns at every horizon** (1h @24 bars: weighted −0.51%, binary −0.11%),
      and **D.4's own 1.5%/0.8% exit rule needs a 34.78% hit rate to break
      even — which neither model reaches on 1h**. The one result pointing at
      binary (5m, 41.59%, +0.16% per trade) is reported with its three
      disqualifiers rather than buried.
      **The report's recommendation: do not change the weights, do not adopt
      binary, and do not run the weight search yet** — optimising 11 parameters
      toward a bar that may be unreachable fits noise. The binding constraint
      appears to be the **exit ratio, not the weights**, and it was never
      searched because it was treated as fixed.
- [ ] T12 — weight search (**deferred to slice 9, and the report says why**:
      search the target/stop ratio first, or shorten the horizon so the
      comparison is computable at all)
- [ ] T13 — findings report
- [ ] Findings reported

### Forecast variance

| Slice | PR | Forecast | Actual |
|---|---|---|---|
| 1 | #12 | ~300 | **~620** (`run.mjs` 617 + `.gitignore` 3) |
| 2 | #13 | ~410 | **~899** (307 + 500 ported lines + 92 doc) |
| 3 | #14 | ~410 | **~814** (316 + 456 ported lines + 42 doc) |
| 4 | #15 | ~380 | **~2556** (597 signal-engine + 835 gate + 957 smoke + 38 run.mjs + 129 doc) |
| 5 | #17 | ~350 | **~2957** (1221 baseline + 447 label + 437 binary + 711 smoke + 8 run.mjs + 133 doc) |
| 6 | #18 | ~200 | **~1695** (1373 diagnostic + 224 smoke + 8 run.mjs + 90 doc) |
| 7 | #19 | ~500 | **~1646** (336 baseline + 319 tier-diagnostic + 309 smoke + 277 run.mjs + 258 timeframes.mjs + 147 doc) |

Every slice landed over its forecast.

**Slice 1** — the excess is the resumable/idempotent pagination, the dataset
quality analysis, the report formatter, and the stale-verdict repair, all
load-bearing rather than padding: the pagination logic is what makes a
215-day fetch re-runnable for free, and the verdict repair is what prevented a
false `target MET`.

**Slice 2** — the excess is the loop-bound documentation that followed the T4
array-semantics correction, plus the port prose explaining each index decision.
A shorter port would be unreviewable: the off-by-one risk here is *silent*, so
the reasoning has to live beside the code it affects.

**Slice 4** — nearly seven times its forecast, and the forecast is what failed,
not the work. The ~380 figure costed the 597-line engine port and nothing else:
the gate runner (835) and the smoke suite (957) were not costed at all. The
gate is long for the same reason the ports are long — it prints every
assumption, every excluded row with its reason, and both timezone candidates
for each ambiguous reading, which is the only way a `PASS` means anything. The
smoke suite is 957 lines because it replaced an ad-hoc one living in `Temp\`
that would have evaporated with the temp directory.

**Slice 5** — the forecast was wrong by a factor of about eight, and again the
forecast, not the work, is what failed. The estimate costed "outcome labelling
+ both baselines" as if labelling were one scoring function and the baselines
two counters. Labelling is two independent definitions carrying four
non-obvious edge cases — `insufficient_data` decided *before* the scan, the
conservative double-touch rule, `null` rather than `0`, and per-signal
overlap — and a baseline that can be quoted without being misread has to
carry its own caveats: C0–C8 and O1–O4 are a large share of `baseline.mjs`,
and C0 was added *after* the orchestrator's read-through caught the headline
being quotable without its scope limit.

**Slice 6** — the forecast of ~200 was wrong by roughly 3×, and this time the
honest reason is that a diagnostic that answers its question badly is worth
nothing. `tier-diagnostic.mjs` re-derives the zone wiring rather than importing
`baseline.mjs`, so the baseline's bytes cannot move — a trade made deliberately
to guarantee the comparison stays fixed, backed by a self-check that catches
drift in the candidate counts. It also prints the tier rule read from both the
port and Pine with line citations, the global tier distribution, whether D1/H4
zones exist at all, candidate-vs-global mix, proximity isolated from the other
gates, and the pre/post warm-up split. Every one of those sections exists
because the first draft produced a number that *looked* like a bug — "1,377 D1
pairs in band, 0 flag fires" — and the discriminator table exists specifically
to close that false reading before it reached anyone else.

**Slice 7** — ~3× over a ~500 forecast, and the excess is the same cause as
every other slice: the forecast costed the *mechanism* and not the machinery a
mechanism needs to be trustworthy. Parameterizing by timeframe is only honest
if four things move together — the dataset table, the fetch verdict (which had
to stay recomputed per timeframe, or a complete 5m fetch would mark a 1h fetch
complete), the HTF aggregation and warm-up, and the caveats. Two more caveats
exist that the earlier estimate could not know about: horizon semantics stretch
with the grid, and multiple timeframes are not independent samples. Both are
load-bearing — without them the three-timeframe table is the single most
misreadable artifact this project can produce.

The per-slice ~400 figure is an advisory planning heuristic stated as such in
this document, not an acceptance criterion, so every variance is recorded
rather than forcing a cosmetic split.

## Rationale

- **Why validate before searching:** a search that optimizes a wrong port finds
  confidently wrong weights. The gate is ordered before every calibration step
  for that reason, not as ceremony.
- **Why both label definitions:** a conclusion that survives only one exit rule
  is a conclusion about the exit rule, not about the weights.
- **Why holdout is mandatory:** 10 weights plus a threshold will fit noise
  given enough freedom; an in-sample winner with no holdout is not a result.
- **Why binary is a baseline and not an afterthought:** the spec argues for it
  in D.1. If the weighted model cannot beat it, the honest finding is that the
  weights should go, which is a more valuable outcome than a tuned vector.

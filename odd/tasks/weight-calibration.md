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
holds ~30 confirmed readings with exact dates, crosshair positions, and legend
values. A port that reproduces those is evidence of fidelity, not an assumption.

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
- Any timeframe other than 5m, any symbol other than BTC/USD.
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

### T5 — Port `structure-break.pine`

- [ ] Port swing point tracking (§6.2), swing state management (§6.3), break
  detection (§6.4), and the break/reversal/orphan-flip outputs.
- [ ] Do **not** port line/label drawing.

### T6 — Port `imbalance-detector.pine`

- [ ] Port candle body imbalance (§5.2.1), volume delta imbalance (§5.2.2), and
  the lifecycle (§5.3) including `imbUntouched + imbTouched == imbLive`.
- [ ] Preserve the counts tautology as an internal assertion — it is the cheap
  correctness probe that already caught one transcription error.

### T7 — Port `signal-engine.pine`

- [ ] Port the 10 weights, the factor set, the `sessionOK` gate, and score
  arithmetic (max 110, threshold 70).
- [ ] Make the weight vector and threshold **parameters of the harness**, not
  constants — this is the entire point of the feature.
- [ ] Emit the per-factor contributions so results are explainable, not opaque.

### T8 — Fidelity gate (HARD STOP)

- [ ] Extract every confirmed reading from `docs/VALIDATION.md` that has an
  exact date, crosshair position, and legend value.
- [ ] Replay the port over the matching bars and compare field by field.
- [ ] **Any mismatch stops the feature.** Fix the port and re-run; do not
  proceed to T10–T12 on a partially matching port.
- [ ] Record pass/fail per reading. The gate result is reported verbatim —
  no summary that hides a failure.
- [ ] Note honestly what the gate does **not** prove: it samples readings that
  were chosen to be legible, not a random sample of all bars.

> **⚠️ Redesign required — the checklist above as originally worded is
> unsatisfiable, and was caught before any porting began.**
>
> A feasibility check against `docs/VALIDATION.md` found its 31 `confirmed`
> rows are **not one gate** but three different classes:
>
> | Class | Examples | Replayable locally? |
> |---|---|---|
> | **Bar-scoped** — crosshair position determines the value | timezone legends `0/7/13` `15/22/4` `23/6/12` `4/11/17`; DST `5/12/18` → `4/11/17` on 7/10 Mar 2026; weekend `sáb 26 Sep '26 - 02:00` (4H); `volumeConfirmed` = 1 at 30 Sep 10:05 | ✅ **this is the gate** |
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
> - **Timeframe:** the weekend reading was taken at **4H** while the dataset is
>   5m — the harness must aggregate 5m → 4H (48 bars), plus D1 (288) and 1H (12)
>   which the Signal Engine already needs.
> - **Timezone:** readings are written in *exchange*-local time
>   (`sáb 07 Mar '26 - 22:00`). Bar *boundaries* are already proven UTC from
>   Bitstamp's native daily bars, but the *display* clock is not yet confirmed —
>   T8 must confirm it or every bar-scoped comparison is off by hours.
> - **Data-free assertion:** `Score arithmetic` (row at line 307 — all 192
>   combinations, max 110, every tier reaches 70) is pure arithmetic over the
>   weight table and needs no candles. It was previously unused and is the
>   cheapest strong check available.

### T9 — Outcome labelling

- [ ] Define one label per signal using the spec's own D.4 parameters
  (target 1.5%, stop 0.8%) as the primary definition.
- [ ] Also record raw forward return at fixed horizons as a secondary,
  assumption-light definition.
- [ ] Document both; report results under both so the conclusion does not
  depend on one arbitrary exit rule.

### T10 — Baseline: current configuration

- [ ] Run the port with the shipped weights and threshold 70 over the dataset.
- [ ] Report signal count, hit rate, distribution of scores, and outcome under
  both label definitions.

### T11 — Binary model baseline (spec D.1)

- [ ] Implement the strict binary model exactly as D.1 specifies.
- [ ] Report the same metrics as T10.
- [ ] This is the comparison the whole feature exists to make.

### T12 — Weight search

- [ ] Search over weight vectors and thresholds (random or coordinate search;
  the space is 10 weights + threshold, too large for exhaustive enumeration).
- [ ] Evaluate every candidate under **both** label definitions.
- [ ] Guard against overfitting: report train/holdout splits rather than a
  single in-sample winner. An in-sample-only result is not a calibration.
- [ ] Report the top configurations with their metrics and their deltas versus
  both baselines.

### T13 — Findings report and delivery

- [ ] Write the findings into `docs/` in English.
- [ ] State plainly whether weighted beats binary, ties, or loses.
- [ ] If a candidate weight vector emerges, present it as **evidence for a
  separate decision** — not as a change applied to the Pine source.
- [ ] Land through the repo PR convention: rich markdown body, zero labels,
  no issue link, merge commit, delete branch.

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
| 6 | T12 + T13 | Weight search + findings report | ~450 |

If PR 6 exceeds ~400, it splits into T12 (search) and T13 (report) — the
report is documentation and can ship on its own.

**Gate on progression:** PR 4 contains the fidelity gate. PRs 5 and 6 do not
start until that gate is reported. A failed gate blocks the slices that depend
on a trustworthy port; it does not block PRs 1–3, which are infrastructure and
ports whose correctness is established by the gate itself.

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
- [ ] T5–T7 — module ports (slices 3–4)
- [ ] T8 — fidelity gate
- [ ] T9–T12 — labelling, baselines, search
- [ ] T13 — findings report
- [ ] Findings reported

### Forecast variance

| Slice | PR | Forecast | Actual |
|---|---|---|---|
| 1 | #12 | ~300 | **~620** (`run.mjs` 617 + `.gitignore` 3) |
| 2 | #13 | ~410 | **~899** (307 + 500 ported lines + 92 doc) |

Both landed at roughly double their slice forecast.

**Slice 1** — the excess is the resumable/idempotent pagination, the dataset
quality analysis, the report formatter, and the stale-verdict repair, all
load-bearing rather than padding: the pagination logic is what makes a
215-day fetch re-runnable for free, and the verdict repair is what prevented a
false `target MET`.

**Slice 2** — the excess is the loop-bound documentation that followed the T4
array-semantics correction, plus the port prose explaining each index decision.
A shorter port would be unreviewable: the off-by-one risk here is *silent*, so
the reasoning has to live beside the code it affects.

The per-slice ~400 figure is an advisory planning heuristic stated as such in
this document, not an acceptance criterion, so both variances are recorded
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

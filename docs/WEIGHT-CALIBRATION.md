# Weight Calibration — findings

**Date:** 2026-10-01
**Subject:** Do the Signal Engine's weighted scores (10 weights, max 110, threshold 70) beat the binary confluence model proposed in `technical-spec.md` D.1?
**Status of the answer:** **the evidence does not separate them, and it separately shows both lose money on this data.** Both halves of that sentence matter, and the second one is the actionable part.

This document reports what a local harness measured. It does not change the indicator, and it does not recommend a new weight vector, because the evidence does not support one.

---

## 1. The short answer

**No weight change is recommended, on this evidence.** Not because the current weights were shown to be good — they were not shown to be anything, because the measurement cannot resolve them — and not because the binary model won. It did not win either; the comparison is structurally unmeasurable as designed (section 4).

**What *was* established, and is actionable:**

1. **Both models have negative mean forward returns at every horizon measured.** On five years of 1h data, a signal from either model is followed by price moving *against* you on average. Weighted: −0.51% mean at 24 bars. Binary: −0.11% mean at 24 bars. Neither is positive anywhere on the horizon grid (section 5).
2. **The D.4 exit rule needs a 34.78% hit rate to break even.** At a 1.5% target and a 0.8% stop, `break_even = 0.8 / (1.5 + 0.8) = 34.78%`. On a properly independent sample **neither model is shown to sit above or below it** (section 5.2). *(Revised 2026-10-01 after slice 9: the first version of this line read "neither model reached it on any timeframe", which the dependent signal set implied and the independent sample does not support.)*
3. **On 5-minute charts the indicator effectively never fires.** Two signals in 215 days. If it is read on a 5m chart, the shipped threshold is not a threshold — it is a wall (section 3).

---

## 2. What was built, and how much to trust it

A zero-dependency Node harness under `backtest/` that reimplements all five Pine modules in JavaScript and replays them over Bitstamp BTC/USD candles. Pine only executes inside TradingView, so without this nothing in the spec's D.1 proposal could be measured at all.

**The reimplementation was gated before any calibration claim was allowed.** `node backtest/run.mjs validate` replays every bar-scoped reading in `VALIDATION.md` against the port and compares field by field:

```
GATE RESULT: PASS — 9/9 Class A readings reproduced.
```

That gate is **5m-only by construction** — its readings were taken on a 5m grid — and it refuses to run on any other timeframe rather than produce a meaningless comparison.

**How much the gate does not prove:** it covers 8 of the 35 confirmed rows in `VALIDATION.md`, chosen for legibility rather than sampled at random. It never executes Pine, so it shows the **port** matches recorded chart readings, not that Pine ≡ JS. Suite total: **1,450 checks, 0 failures.**

---

## 3. Why the 5-minute result was meaningless, and what fixed it

On 5m data the weighted model fired **2 times in 62,000 bars**. That looked like the weights being broken. It was not.

The largest single component of the score is the liquidity tier, worth +30 for a daily zone and +10 for a small one. A zone's size is measured in **its own timeframe's** volatility; the proximity band that detects it is `3 ×` the **chart's** volatility. On a 5m chart the band is a 5-minute volatility — an order of magnitude too narrow to bracket a daily zone. So price is always already *inside* the zone before it can ever be *near* one, and Pine's in-body exclusion withholds the flag by design.

The diagnosis was run on coarser grids, and the mechanism behaved exactly as that explanation predicted:

| | 5m | 1h | 4h |
|---|---|---|---|
| D1 zone body / proximity band (median) | 5.04× | **1.03×** | **0.50×** |
| D1 bar-zone pairs inside the band | 1,377 | 38,255 | 18,026 |
| …of which inside the body | 1,377 | 33,149 | 10,566 |
| …**eligible** (in band, not in body) | **0** | **5,106** | **7,460** |
| flag fires | 0 | **256** | **1,229** |
| observed score ceiling | 80 | **90** | 70 |

Zero eligible pairs on 5m is the signature of *consistent*, not broken: on a grid where the tier cannot be reached, the flag must not fire. D1 zones were never missing — 3,436 were created and live on 7,269 bars.

**So the honest reading of the 5m run is: the threshold of 70 is unreachable in 5 minutes because the score's largest term cannot be earned there.** That is a statement about the timeframe, not about the weights.

---

## 4. Why weighted vs binary cannot be compared

The baseline on 1h gave binary a 2.50 pp edge (33.75% vs 31.25%). **That difference cannot be intervaled at all.**

The label definition walks **288 bars forward** from each signal. Signals that are less than 288 bars apart therefore share their forward window. Grouping signals into non-overlapping windows:

| grid | model | signals | **clusters** | signals/cluster | max gap between consecutive signals |
|---|---|---|---|---|---|
| 1h | weighted | 307 | **45** | 6.82 | 1,033 bars |
| 1h | binary | 1,701 | **1** | 1,701 | **261 bars** |
| 4h | binary | 446 | **1** | 446 | 259 bars |

Binary fires often enough that **its largest gap in five years is 261 bars against a 288-bar horizon.** There is no gap. The entire five-year 1h run is one unbroken chain of overlapping forward windows — **1,701 signals are one observation, not 1,701.**

A paired cluster bootstrap needs at least 10 resampling units. There is exactly 1. **There is no interval that could include or exclude zero.**

So both of these statements are false, and neither may be reported:

- ~~"Binary is better by 2.50 pp."~~
- ~~"The two models are indistinguishable."~~

Each presupposes an interval that does not exist. The correct word is **indeterminate**.

**The only interval computable anywhere in this work** is 1h-short: **+3.72 pp observed, 95% CI [−3.54 pp, +9.55 pp], does not exclude zero.**

**4h points the opposite way** (−11.20 pp) and is equally un-intervalable. That is not one timeframe refuting the other — the two runs share price action and are one measurement at two resolutions.

---

## 5. The finding that does not depend on any of the above

Two results survive the dependence problem, because they are not differences between models.

### 5.1 Both models lose money on this data

Mean signed forward return after a signal, 1h dataset, five years. Positive means the trade would have made money.

| horizon (1h bars) | weighted | binary | joint clusters | difference excludes 0? |
|---|---|---|---|---|
| 6 (6h) | **−0.21%** | **−0.03%** | 1,727 | no |
| 12 (12h) | **−0.33%** | **−0.05%** | 1,257 | **yes** |
| 24 (24h) | **−0.51%** | **−0.11%** | 566 | **yes** |
| 48 (48h) | **−0.54%** | **−0.15%** | 196 | **yes** |
| 96 (96h) | **−0.62%** | **−0.02%** | 46 | **yes** |
| 288 (12d) | **−0.82%** | **−0.25%** | 1 | not computable |

**Neither model is positive at any horizon.** The intervals on the *difference* exclude zero in binary's favour at 12–96 bars, so binary is measurably less bad on this instrument — but "less bad" is the whole claim. Note the shorter horizons are exactly the ones that are computable, because a shorter window clusters less; that is a different measurement from the 288-bar D.4 question, not a confirmation of it.

### 5.2 The exit rule needs 34.78% — and on an honest sample neither model is shown to miss it

> **Revised 2026-10-01, after slice 9.** The version published with slice 8 read:
>
> *"On 1h — the grid where the tier is live and the sample is meaningful — **both models sit below break-even.**"*
>
> **That was computed on the dependent signal set, and slice 9 shows it does not hold.** The hit rates behind it (31.25% / 33.75%) carry 307 and 1,701 signals whose 288-bar forward windows overlap almost completely — section 4 established those are effectively **one observation each**. Rebuilding the sample to be independent by construction **reverses the sign**.

The arithmetic is unchanged and is not in dispute:

```
break-even hit rate for target 1.5% / stop 0.8%  =  0.8 / (1.5 + 0.8)  =  34.78%
```

On the independent sample — at most one signal per model per side per non-overlapping 288-bar window, selecting the **earliest** entry bar (the only selection rule that cannot see the outcome):

| grid | scope | weighted | binary | required |
|---|---|---|---|---|
| 1h | all | 30.77% [22.90, 38.93] *(130 resolved)* | **38.82% [31.37, 46.71]** *(152 resolved)* | 34.78% |
| 1h | long | 31.58% [22.34, 41.05] | 38.00% [30.20, 45.70] | 34.78% |
| 1h | short | 29.67% [20.65, 39.13] | 38.26% [30.61, 45.95] | 34.78% |
| 5m | all | *not reported* *(n=1)* | 40.63% [28.79, 53.03] | 34.78% |
| 4h | all | *not reported* *(n=20)* | 21.05% [8.33, 34.21] | 34.78% |

**Binary's 1h point estimate is above the requirement; weighted's is below. Neither is established** — both intervals contain 34.78%. The only scope whose whole interval sits outside the requirement is 4h binary, and it carries 38 observations.

What did survive is that **the cost of being wrong is enough to matter.** Gross expectancy per resolved trade on 1h is −0.09% (weighted) and +0.09% (binary); after D.4's own declared commission — 0.05% per side, a 0.10% round trip — **both are negative**, −0.19% and −0.01%, and `slippage=2` is not modelled on top of that.

### 5.3 The exit ratio is not the binding constraint — but the *hold* it is applied to is wrong

Two results from slice 9, in opposite directions.

**The ratio hypothesis did not survive.** The zero crossing of the expectancy surface was **not identified on any grid** — 0 of 24 sweeps across both models and all three timeframes, because no cell's whole interval sits below zero while its neighbour's whole interval sits above it. No ratio is recommended here and none should be read into the span printed by the tool: choosing the best cell of a sweep evaluated on one sample is precisely the overfitting this project exists to prevent.

**The ratio/hold interaction did.** One fixed `T/S = 1.875` is being applied to holds that differ by an order of magnitude — 288 bars is 24h on 5m, 288h on 1h, 1,152h on 4h. The ratio the observed accuracy would require moves with the horizon:

| | 6 bars | 12 | 24 | 48 | 96/288 | shipped |
|---|---|---|---|---|---|---|
| 1h weighted | **2.577** | 2.206 | 2.211 | **2.200** | 2.250 | 1.875 |
| 1h binary | 1.594 | **1.533** | — | 1.576 | 1.576 | 1.875 |

The **direction** is visible — a 1.5% target over six hours and a 1.5% target over two days are not the same trade — but the **magnitude is not pinned**, because the intervals at the extremes overlap heavily. Each row re-labels at its own horizon cap, so the rows are **not nested samples** and the count per row is the honest denominator.

**So the ratio is not established as the problem. The absence of a single correct ratio across holds is.**

---

## 6. What this does not show

- **It does not show the weights are good.** Nothing here supports the shipped vector.
- **It does not show binary is better.** On the metric the spec's D.1 argument actually cares about, the comparison is indeterminate.
- **It does not show the indicator is worthless.** A negative expectancy over five years of a single instrument on one exchange is evidence about *this* configuration on *this* data, not a general verdict.
- **It does not include costs.** No commission, fees, funding, slippage or spread is modelled, and D.3's `spreadOK` is absent from the shipped source, so neither model gets it.
- **It does not simulate a portfolio.** Labels are overlapping forward windows — no cash curve, no sizing, no compounding, no interaction between signals.
- **The 4h run is not a faithful Pine-on-4h reproduction.** Pine's `request.security(…, "60", …)` returns 1h bars even on a 4h chart, so a 4h dataset has no 1H candles to aggregate. That tier is reported as *not measurable* rather than as zero.
- **The three timeframes are not three samples.** Same price action, three resolutions; agreement between them would not be corroboration.
- **Cross-timeframe hit rates are not like-for-like.** 288 bars is 24h on 5m, 288h on 1h and 1,152h on 4h.

---

## 7. The hypothesis that was tested and did not survive — and what replaced it

**The claim this section originally made was: "the exit parameters may matter more than the weights."**

Slice 9 tested it and it did **not** survive. The arithmetic that motivated it is unchanged — a 1.5%/0.8% ratio demands 34.78% accuracy — but the accuracy it was compared against came from dependent signals. On an independent sample **neither model is established above or below 34.78%** (section 5.2), and the expectancy surface's zero crossing **could not be identified on any grid** (section 5.3). A weight search is therefore not demonstrably optimising against an unreachable target after all: **that premise is now unsupported rather than confirmed.**

**What replaced it is narrower and better supported:** not that the ratio is wrong, but that **one ratio is being applied to holds that differ by an order of magnitude.** The ratio the observed accuracy would require moves with the horizon (section 5.3). A ratio is not a property of a strategy in the abstract; it is a property of a strategy **at a given holding period**, and D.4 fixes both without ever relating them.

That is a smaller claim than "the exit ratio is the problem". It is also the one the evidence actually supports, and unlike the original it does not depend on a comparison that cannot be made.

---

## 8. What would settle it

In rough order of cost:

1. **Re-run the comparison with a shorter horizon.** At 48–96 bars the joint partition has 46–196 clusters and intervals become computable. That is a different question with an answerable one.
2. **Relate the exit ratio to the holding period** (sections 5.3 and 7). The ratio the observed accuracy requires moves with the horizon, and D.4 fixes target, stop and hold independently. This is now the strongest remaining lead — not "the ratio is wrong", but "one ratio is being applied to trades that are not the same trade".
3. **Sample non-overlapping windows** — take one signal per 288-bar window per model. Halves the sample, removes the dependence, makes the interval honest.
4. **Route A** — the spec's own `strategy()` variant in TradingView, with real fills, real commission and real slippage. This is the only instrument in the project that reports P&L rather than a descriptive ratio, and it remains the planned verification step.

The weight search itself (`search`, still a stub) should **not** run before 1–3 narrow the question, because optimising 11 parameters toward a target that may be unreachable produces a vector that fits noise.

---

## 9. Recommendation

**Do not change the weights. Do not adopt binary. Do not run the weight search yet.**

The spec argues for binary on *discipline* grounds — "*a missing factor means the setup is incomplete*". That argument is reasonable and this work adds **no performance evidence** to it. It also removes no performance evidence from the weighted model; the comparison simply cannot be made with this design.

What this work does justify saying plainly:

- **On 5-minute charts the indicator does not function** at the shipped threshold. Two signals in 215 days. If 5m is a timeframe anyone reads it on, that is a bug report, not a tuning question.
- **On 1h the signal's raw expectancy is negative**, for both models, at every horizon, and **negative for both after D.4's own declared commission** — the one result that survived every caveat in this document.
- **A ratio is not a property of a strategy; it is a property of a strategy at a given hold.** The ratio the observed accuracy requires moves with the horizon, and the shipped 1.875 is applied unchanged to a 24-hour trade and a 12-day one. That mismatch is the strongest remaining lead, and it was never examined because the ratio was treated as fixed.

---

## 10. Reproducing this

```bash
node backtest/run.mjs validate                          # fidelity gate, 5m only
node backtest/run.mjs baseline                           # weighted vs binary, 5m
node backtest/run.mjs baseline --timeframe 1h            # the grid that matters
node backtest/run.mjs baseline --timeframe 4h
node backtest/run.mjs diagnose --timeframe 1h            # tier reachability
node backtest/run.mjs compare --timeframe 1h             # dependence-aware comparison
node backtest/smoke.mjs                                  # 1,450 checks
node scripts/build.mjs                                   # production SHA unchanged
```

Datasets are gitignored and must be fetched first (`node backtest/run.mjs fetch --timeframe 1h`). Production Pine SHA throughout: `1DD6F536AE4F50C2F669E9C1A2B34A0FB97A7D51428905B9E18F8616D1582CE2`.

---

## Appendix — brief-versus-source disagreements

Five times during this work a task brief asserted something the shipped source contradicted. In every case the source won and the disagreement was recorded rather than executed:

| # | Claim in the brief | What the source says |
|---|---|---|
| 1 | Pine arrays are 1-indexed | Loops reach index 0 at `liquidity-zones.pine:187/218/245/293` |
| 2 | Port the §5.2.2 volume delta flags | No `delta` under `src/`; `signal-engine.pine:136` consumes `volumeConfirmed` only |
| 3 | The engine consumes session *multipliers* | `signal-engine.pine:83` gates on `sessionStrength >= 2`; the multiplier is deliberately unused |
| 4 | `4H` timeframe labels in `VALIDATION.md` | Grid arithmetic: impossible at 4H. **Corrected in that file** |
| 5 | Read the qualifying-tier rule from `liquidity-zones.mjs` | That module stamps per-zone tiers and emits six booleans; the single-tier reduction is in `signal-engine.mjs:355-362` |

## Appendix — datasets

| grid | bars | span | gaps | off-grid | duplicates |
|---|---|---|---|---|---|
| 5m | 62,000 | 215.27 days | 0 | 0 | 0 |
| 1h | 44,000 | 1,833.29 days | 0 | 0 | 0 |
| 4h | 11,000 | 1,833.17 days | 0 | 0 | 0 |

All from Bitstamp's public endpoint, no credentials. The 5m dataset was fetched for the gate; 1h and 4h were added after the tier diagnosis showed 5m could not answer the question.
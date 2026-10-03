# Route A — the strategy variant

`dist/liquidityflowause-strategy.pine` is the `strategy()` sibling of the shipped
indicator. It exists because the local harness cannot answer the only question
that matters: **does this make money?**

Everything in `backtest/` measures descriptive ratios over overlapping forward
windows. There is no cash, no position accounting, no compounding and no equity
curve, so a hit rate computed there describes a *rate* and says nothing about a
*curve*. A TradingView Strategy Tester produces the curve. That is why this file
exists, and why it is a separate artifact rather than a mode of the indicator.

---

## Quick path

1. **Build it.**

   ```
   node scripts/build.mjs --strategy
   ```

   Output: `dist/liquidityflowause-strategy.pine`. The build prints a module-parity
   table, the exit arithmetic it cross-checked against `backtest/modules/label.mjs`,
   and the shipped indicator's SHA256. All three are on the report because
   "verified" is a claim you are entitled to see rather than infer.

2. **Add it to TradingView as a SEPARATE script.** Pine Editor → *Open* → *New
   indicator* → *Strategy* → paste the whole file → *Add to chart*.

   **It is not a replacement for the indicator. Never paste it over it.** The two
   are different scripts with different declarations, and the build refuses to
   write a strategy that carries an `indicator()`.

3. **Pick the timeframe.** This is a real decision, not a formality — see
   [Timeframe](#timeframe-is-not-a-formality).

4. **Open Settings and check the mode.** Entry Model defaults to `Weighted`,
   *Only Enter When Flat* is `ON`, and *Enable Spread Filter* is `OFF`. The same
   three are printed in the table at the top-right of the chart. Check one before
   you read any number.

5. **Open the Strategy Tester** and read the equity curve, max drawdown and total
   trades before anything else. See [What to look at](#what-to-look-at-before-
   risking-money).

---

## What this file is not

- **Not the indicator.** Different artifact, different build path. The indicator
  build is byte-identical to what it was before this work, and the strategy build
  asserts it (`dist/liquidityflowause.pine`,
  SHA256 `1dd6f536…582ce2`).
- **Not a second implementation of the model.** Every line of signal logic comes
  from `src/modules/*.pine`, the same five files the indicator is built from. The
  build **asserts** the embedded module text is byte-identical between the two
  builds and fails if it is not. That assertion is the guarantee that the strategy
  trades what the indicator signals.
- **Not verified.** There is no Pine compiler in this repository. Every check is
  structural — declaration shape, module parity, exit arithmetic. **Types,
  builtins and runtime behaviour are unverified.** Expect to fix compile errors by
  hand on the first paste.
- **Not our data.** The Strategy Tester runs on TradingView's feed, on whatever
  symbol and timeframe the chart is set to. Our findings came from Bitstamp
  BTCUSD 5m/1h/4h. A curve from here is a **different measurement**, not a
  reproduction of the harness numbers, and the two must not be quoted side by side
  as if they were the same quantity.

---

## Deviations from D.4

`docs/technical-spec.md` §D.4 (lines 1937–1968) is the starting point. Each of
these is a deliberate decision, and each is stated in the generated file's header
too — the maintainer reads that file and not this one.

| # | D.4 says | This file ships | Why |
|---|----------|-----------------|-----|
| 1 | Enter on `longSignalStrict` (D.1 **binary**) | `Entry Model` input, default **Weighted**; `Binary` available | D.4's entry rule is the binary model, but the shipped indicator — what you actually trade — is the weighted one. Trading binary by default would measure something other than the product. |
| 2 | Entry gated by `and spreadOK` | D.3 implemented as an input, default **OFF** | D.3 is **not implemented anywhere under `src/`**. The shipped indicator has no spread filter, so enabling one by default would make the strategy trade something the indicator never trades. |
| 3 | Silent; Pine pyramids by default | *Only Enter When Flat* input, default **ON** | D.4 says nothing about position count. One position at a time matches how the indicator is used. **Consequence:** with it ON, an opposite-direction signal cannot reverse an open position — the new entry waits for the target or the stop. |
| 4 | `default_qty_value=10`, percent commission `0.05`, `slippage=2`, `targetPct=1.5`, `stopPct=0.8` | Unchanged | Kept exactly as written. `commission_value=0.05` is charged on entry **and** exit, so 0.10% per round trip. |

Two further deviations the header records and this table would otherwise hide:

| # | D.4 says | This file ships | Why |
|---|----------|-----------------|-----|
| 5 | `strategy.exit(..., profit=targetPct, loss=stopPct)` | `strategy.exit(..., limit=<level>, stop=<level>)`, levels computed from `strategy.position_avg_price` | TradingView's v5 docs state `profit` and `loss` "accept relative values in **ticks** from the entry price", while `limit` and `stop` "accept absolute price levels". `profit=1.5` is therefore a one-and-a-half-tick target, not 1.5%. The 1.5 / 0.8 *numbers* are unchanged; only the units are corrected, which makes the file agree with `backtest/modules/label.mjs` — the definition the whole investigation used. |
| 6 | Declaration omits `max_labels_count` / `max_lines_count` / `max_boxes_count` | Declared, matching the indicator | Without them Pine's small defaults would silently drop zones, gaps and boundary lines at runtime. |

Also recorded in the header: the 10-bar cooldown limits **signal frequency**, not
position count — that is item 3 and nothing else.

---

## Timeframe is not a formality

The harness's 288-bar hold is **24 hours on a 5m chart and 12 days on 1h**. The
strategy runs on whatever timeframe the chart is set to, so its hold is 288 bars
of *that* grid — neither 24 hours nor 12 days unless you pick the matching
timeframe.

If you want to compare a strategy curve against a harness number, the timeframe
must be the one that number was measured on. Otherwise you are comparing a
one-day hold against a twelve-day hold and calling the difference an edge.

Start on the timeframe the indicator is used on. If the curve is too flat to read,
that is a signal about *trade frequency*, not an invitation to drop to a lower
timeframe to manufacture trades.

---

## What to look at before risking money

Open the Strategy Tester's **Overview** tab. Read these four, in this order.

### 1. Number of trades — first, because it can end the review

**The shipped weighted model produced 307 signals in five years on 1h — roughly
one every six days.** A curve built on six-day trades is a curve with ~60 points
per year. Read the trade count *before* the equity line.

- **Fewer than ~100 trades:** the curve cannot distinguish an edge from luck. The
  harness's own power analysis concluded that resolving a 2.5 pp hit-rate
  difference needs ~5,466 independent observations, and the 288-bar partition
  yields around 130 — a ~42× shortfall. A 100-trade strategy curve is worse than
  that, because trades share the market.
- **Hundreds of trades:** more is not automatically better. Check whether they are
  *independent* — six-day trades in a five-year window are 300 overlapping
  exposures to two or three market regimes, not 300 independent experiments.
- **Thousands of trades on a low timeframe:** almost certainly the cooldown is not
  the binding constraint any more, and you are measuring intrabar noise through a
  model that was tuned on daily structure. Treat the result with suspicion.

### 2. Equity curve — the shape, not the endpoint

- Is it rising, or is it flat with one lucky spike? One spike is a single trade.
- Are gains clustered in one period? A curve that is flat for four years and then
  doubles is one bet that paid.
- Compare **long vs short** separately. If one side carries everything, the
  confluence model is not doing what its name suggests.

### 3. Max drawdown — and the duration

A curve can be profitable and unusable. Read max drawdown as a fraction of equity
**and** how long it took to recover. A 40% drawdown that took two years to
recover is not a strategy most people can hold.

### 4. Costs are already in there — do not add them twice

The strategy declaration charges 0.05% per side, so **0.10% round trip**, plus
2 ticks of slippage. That is already in the curve.

Two honest warnings about those costs:

- Our measurement found the shipped weighted model **negative after the 0.10%
  commission and before any slippage at all**. The slippage in the tester is extra
  cost on top of a model that was already negative without it.
- `slippage=2` is in **ticks**, not percent. A tick is the instrument's minimum
  price increment on the exchange your chart belongs to. Two ticks is noise on one
  symbol and a large move on another.

---

## Before you trust any of it

- [ ] **A positive backtest is not evidence of future profitability.** It is
      evidence that this configuration did not lose money on this data, over this
      period, with this cost model. That is a much smaller claim, and it is the
      only one the tester can support.
- [ ] You have checked whether the tested period contains the regime you care
      about, or whether the curve is one trend.
- [ ] You have re-run it on a **different period** than the one you developed on,
      or you accept that you have fitted the window.
- [ ] You know the symbol's exchange, so you know what "2 ticks" means.
- [ ] You have checked the trade count against point 1 above.

---

## What is verified, and what is not

### Verified here (structurally)

| Check | Where |
|---|---|
| Module text byte-identical between the indicator build and the strategy build (5/5, ~68 KB) | `scripts/build.mjs --strategy`, asserted not warned |
| The parity assertion **can fail** — driven with a divergent pair | `node backtest/smoke.mjs`, section `route-a-strategy` |
| `dist/liquidityflowause.pine` SHA256 unchanged | `1dd6f536…582ce2`, checked on every strategy build |
| Exactly one `strategy()`; no `indicator()`/`study()` anywhere | build + smoke |
| `//@version=5` first; two `strategy.entry` calls; two `strategy.exit` calls | build + smoke |
| Every declared input is read | build + smoke |
| Exit arithmetic matches `label.mjs`'s `EXIT_TARGET_PCT`/`EXIT_STOP_PCT` (1.5 / 0.8, ratio 1.875) | build + smoke |
| Defaults: weighted, flat-only ON, spread OFF | build + smoke |
| The four deviations from D.4 are stated in the generated file's own header | smoke |

### Not verified

- **Pine compilation.** There is no Pine compiler in this repository. Nothing has
  been compiled. Types, builtin signatures and runtime behaviour are unverified,
  and the first paste into the Pine Editor is a real test.
- **`strategy()` fill semantics.** Order timing, slippage application, margin
  and position accounting are TradingView's, not modelled here. In particular the
  Strategy Tester's own fill assumptions are not the ones `label.mjs` used.
- **`and` / `or` short-circuiting.** Pine's v5 documentation states only that the
  **ternary** operator is lazily evaluated; it makes no such claim for `and`/`or`.
  The spread filter therefore excludes its SMA warm-up window **explicitly**
  (`not na(avgRange)`) rather than relying on `or` short-circuiting to keep a
  disabled filter from gating on `na`.
- **The 1h tier on a 4h chart.** Pine's `request.security` would return 1h bars on
  a 4h chart; the harness cannot, and it reports that tier as unavailable rather
  than as empty. A 4h strategy run is therefore not the same grid the harness
  measured.
- **Whether this makes money.** That is the question the file exists to put to
  TradingView. This repository cannot answer it and does not claim to.

---

## Files

| Path | Role |
|---|---|
| `src/liquidityflowause-strategy.pine` | Route A's main source: `strategy()` declaration, entry/exit rules, D.3 filter, entry-model switch, honesty header |
| `scripts/assemble.mjs` | The shared module list, banner stripping, and the module-parity assertion |
| `scripts/build.mjs` | `--strategy` build path, structural checks, SHA guard |
| `dist/liquidityflowause-strategy.pine` | Build output — the file you paste |
| `backtest/smoke.mjs` §`route-a-strategy` | The data-free checks above |

`src/liquidityflowause.pine`, `src/modules/` and `src/lib/` are **not touched by
this work**, and the build asserts it.
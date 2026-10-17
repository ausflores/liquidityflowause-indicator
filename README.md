# LiquidityFlowAuse

A Pine Script v5 indicator for TradingView that marks **liquidity zones, sweeps, structure
breaks and multi-timeframe context**, plus a Node measurement harness that was built to
answer one question honestly rather than to look good.

---

## What this indicator is — and what it is not

**It is** a visualiser of liquidity and structure: where liquidity sits, when it gets
swept, when structure breaks, and how those read across timeframes.

**It is not** an entry system with a measured edge. That is not modesty; it is the
measured result:

- **5 years, 1h, 44,000 Bitstamp bars** (2021-09-24 → 2026-10-01), **1,394 executed trades**.
- **Neither entry model makes money.** Weighted confluence −4.07%, binary −11.84%.
- **Gross is negative for both before commission.** The loss is not a cost problem.
- Binary's hit rate is **34.45%** against a **34.78%** break-even at n=1,164 — inside its
  own sampling noise. Not broken, not viable: *not distinguished from break-even*.
- **Retuning target/stop is closed.** The binding constraint is the hit rate, and no exit
  rule repairs a hit rate.
- Every unmodelled caveat flatters the strategy — fills are taken at signal close, slippage
  is declared zero and **not modelled**, one exchange, one timeframe — so **these figures
  are upper bounds**, not estimates.

The full record, the estimators that disagree and why, and the three levers that were tried
and closed: **[`docs/WEIGHT-CALIBRATION.md`](docs/WEIGHT-CALIBRATION.md)**.

If you are looking for an edge, that is a different hypothesis, and this repository is not
it. The question this project set out to answer is answered, with the answer recorded.

---

## Layout

| Path | What it is |
|---|---|
| `src/liquidityflowause.pine` | the indicator source |
| `src/liquidityflowause-strategy.pine` | the `strategy()` variant used for fills/commission/slippage (Route A, see `docs/ROUTE-A.md`) |
| `dist/` | **generated, never committed** (`.gitignore`) — the built Pine you install, and **the file TradingView consumes**. A fresh clone has no `dist/` until you build it. |
| `backtest/` | the measurement harness: Node, **no dependencies, no package.json** |
| `backtest/modules/` | ports of the Pine modules (structure break, imbalance detector, signal engine…) |
| `docs/` | technical spec, validation record, weight-calibration findings, Route A procedure |
| `scripts/build.mjs` | assembles `dist/` from `src/` |
| `odd/tasks/` | the authoritative task records for each feature |

`dist/` is the source of truth for what ships: the harness never writes it, and every
finding in `docs/` was produced against it. It is **build output** — `scripts/build.mjs`
regenerates it and `.gitignore` excludes it — so it is produced, not fetched. Anyone who
clones this repository starts with no `dist/` and runs the build first.

## Running the harness

```bash
node scripts/build.mjs                     # REQUIRED FIRST: dist/ is not committed
node scripts/build.mjs --strategy          # and the Route A strategy sibling (docs/ROUTE-A.md)
node backtest/smoke.mjs                    # the suite: 2,092 assertions, no data, no network
node backtest/run.mjs validate             # fidelity gate against docs/VALIDATION.md — 5m only
node backtest/run.mjs equity --timeframe 1h   # the equity curve (the finding quoted above)
node backtest/run.mjs concept --timeframe 1h  # the stated concept, counted as written
node backtest/run.mjs band --timeframe 1h     # the proximity-band counterfactual sweep
node backtest/run.mjs                       # usage
```

`--timeframe` defaults to **5m**, where the indicator effectively does not function at the
shipped threshold. Pass `--timeframe 1h` for anything quoted in the docs.

## Limits you should know before quoting any number here

- **The suite never reads `backtest/data/`.** It is data-free by design, so it cannot catch
  a bar-shape mismatch between the on-disk dataset and what a subcommand consumes. A bug of
  exactly that class occurred in this project and surfaced only on the first live run.
- **Slippage is zero and unmodelled.** D.4 declares `slippage=2` in *ticks*, and Bitstamp's
  BTC/USD tick size is recorded in no metadata file here. No tick size was invented to close
  the gap, so every performance figure is an **upper bound**.
- **Fills are taken at the signal close**, which is optimistic against a real book.
- **Max drawdown is a lower bound**: the curve moves only at an exit.
- **No interval is attached to any hit rate**, including those quoted above. Position
  accounting makes trades non-overlapping; it does not make them independent draws.
- **`search` (T12) is a deliberate stub.** It is not implemented and its absence is recorded
  as a finding, not as an oversight.

## Conventions worth keeping

- **Source wins.** When the brief and the shipped source disagree, the source decides, and
  the disagreement is written down rather than smoothed over.
- **A measurement harness only reads.** Nothing under `backtest/` writes a file, and nothing
  imports `src/` or `scripts/` to change them.
- **Subcommands are never registered by widening a list another section asserts.** Each late
  subcommand gets its own list, unioned into one `DISPATCHABLE` spread — see
  `backtest/run.mjs`, and the `subcommand-registration` section of `backtest/smoke.mjs`.
- **Conventions get asserted, not assumed.** The suite parses the registration lists out of
  `run.mjs` and checks membership for real names and non-membership for typos, because
  substring matching only proves a phrase was present.
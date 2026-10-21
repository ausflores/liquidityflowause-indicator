# AGENTS.md

Pine Script v5 TradingView indicator (crypto, 24/7) plus a zero-dependency Node measurement harness.

## Commands

There is no `package.json`, no npm scripts, and no linter — run bare `node` from the repo root.

```bash
node scripts/build.mjs                        # REQUIRED FIRST: assembles dist/ (gitignored) + structural checks
node scripts/build.mjs --check                # validate only, write nothing
node scripts/build.mjs --strategy             # Route A strategy variant (docs/ROUTE-A.md)
node backtest/smoke.mjs                       # regression suite: 2,092 checks, data-free, no network
node backtest/run.mjs validate                # fidelity gate vs docs/VALIDATION.md — accepts 5m ONLY
node backtest/run.mjs equity --timeframe 1h   # measurement run; subcommand list comes from bare usage below
node backtest/run.mjs                         # usage + full subcommand list
```

- Figures quoted in `docs/` used `--timeframe 1h`; the default **5m** is where the indicator effectively never fires.
- Only `fetch` touches the network or writes (`backtest/data/`, gitignored); measurement subcommands only print.

## Architecture map

- `src/liquidityflowause.pine` — indicator main: the single `indicator()` declaration and the
  `[CONCATENATION POINT]` marker where modules are spliced in; `src/liquidityflowause-strategy.pine`
  is the Route A strategy main — same modules, no duplicated logic.
- `src/modules/*.pine` — five modules (liquidity-zones, session-markers, imbalance-detector,
  structure-break, signal-engine). A module declaring `indicator()`/`strategy()` fails the build.
- `scripts/assemble.mjs` — the single `SOURCES` list (order is semantic: Pine v5 has no forward
  declarations), banner stripping, and the indicator-vs-strategy module-parity assertion.
- `scripts/build.mjs` — concatenates main + modules into `dist/`, enforces the 64-plot budget,
  validates the strategy text, cross-checks exit levels against `backtest/modules/label.mjs`.
- `backtest/modules/*.mjs` — JS ports of the five Pine modules; `backtest/run.mjs` is the
  measurement CLI; `backtest/smoke.mjs` is the regression suite over all of it.
- `odd/tasks/` — authoritative task records per feature; `openspec/`, `.atl/` — tooling state.

## Source of truth

- The Pine source in `src/` is canonical: when a doc and the shipped source disagree, the
  source decides and the disagreement gets written down rather than smoothed over.
- Behavior changes must land in BOTH `src/modules/*.pine` and its `backtest/modules/*.mjs` port;
  `run.mjs validate` and `smoke.mjs` gate the sync.
- Spec: `docs/technical-spec.md` (~2,000 lines). Calibration truth: `docs/WEIGHT-CALIBRATION.md`
  — no weight change is recommended there and the measurement line is closed.
- `dist/` is build output, never hand-edited. `build.mjs` pins `SHIPPED_INDICATOR_SHA256`: a
  `--strategy` build fails if the shipped indicator moved, so update the pin deliberately.

## Gotchas (verified in this repo)

- The smoke suite never reads `backtest/data/`: fixtures are hand-built synthetic candles
  defined inside `smoke.mjs`. It therefore cannot catch a bar-shape mismatch against the real
  dataset — that bug class already happened once and surfaced only on a live run (see README).
- New `run.mjs` subcommands get their OWN registration list, unioned into `DISPATCHABLE`
  (`SUBCOMMANDS`, `EXTRA_SUBCOMMANDS`, `LATER_SUBCOMMANDS`, `CONCEPT_SUBCOMMANDS`). Widening an
  existing list is a defect; the suite asserts membership for real names and non-membership for typos.
- `docs/technical-spec.md` section 12.3 shows a build order that predates Pine v5 and is wrong;
  the authoritative module order is the `SOURCES` array in `scripts/assemble.mjs`.
- `src/lib/colors.pine`, `utils.pine`, `inputs.pine` are listed in `SOURCES` but not written yet:
  the build warns and skips them. Expected, not a failure.
- CLI refusals are hard errors, not precedence rules: `--strategy` with `--diagnostic` is
  rejected, and `validate` accepts only `--timeframe 5m` (its readings were captured on that grid).

## Docs

- [README.md](README.md) — what the indicator is (and is not), measured results, layout, limits.
- [docs/technical-spec.md](docs/technical-spec.md) — behavior specification.
- [docs/WEIGHT-CALIBRATION.md](docs/WEIGHT-CALIBRATION.md) — calibration findings + appendices.
- [docs/VALIDATION.md](docs/VALIDATION.md) — chart readings replayed by the `validate` gate.
- [docs/ROUTE-A.md](docs/ROUTE-A.md) — strategy build and install procedure.

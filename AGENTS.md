# AGENTS.md

Indicador para TradingView en Pine Script v5 (cripto, 24/7) más una herramienta de medición en Node sin dependencias.

## Comandos

No hay `package.json`, ni scripts de npm, ni linter — ejecuta `node` a secas desde la raíz del repositorio.

```bash
node scripts/build.mjs                        # REQUERIDO PRIMERO: ensambla dist/ (gitignored) + verificaciones estructurales
node scripts/build.mjs --check                # solo valida, no escribe nada
node scripts/build.mjs --strategy             # variante estrategia Route A (docs/ROUTE-A.md)
node backtest/smoke.mjs                       # suite de regresión: 2,092 verificaciones, sin datos, sin red
node backtest/run.mjs validate                # verificación de fidelidad vs docs/VALIDATION.md — acepta SOLO 5m
node backtest/run.mjs equity --timeframe 1h   # ejecución de medición; la lista de subcomandos sale del uso con el comando vacío (abajo)
node backtest/run.mjs                         # uso + lista completa de subcomandos
```

- Las cifras citadas en `docs/` usaron `--timeframe 1h`; con el valor por defecto **5m** el indicador prácticamente nunca dispara.
- Solo `fetch` toca la red o escribe datos (`backtest/data/`, gitignored); los subcomandos de medición solo imprimen por pantalla.

## Mapa de arquitectura

- `src/liquidityflowause.pine` — archivo principal del indicador: la única declaración `indicator()` y la
  marca `[CONCATENATION POINT]` donde se insertan los módulos; `src/liquidityflowause-strategy.pine`
  es el archivo principal de la estrategia Route A — mismos módulos, sin lógica duplicada.
- `src/modules/*.pine` — cinco módulos (liquidity-zones, session-markers, imbalance-detector,
  structure-break, signal-engine). Un módulo que declare `indicator()`/`strategy()` hace fallar la compilación.
- `scripts/assemble.mjs` — la única lista `SOURCES` (el orden es semántico: Pine v5 no tiene
  forward declarations), la eliminación de encabezados y la aserción de paridad de módulos entre indicador y estrategia.
- `scripts/build.mjs` — concatena principal + módulos en `dist/`, respeta el presupuesto de 64 plots,
  valida el texto de la estrategia y verifica los niveles de salida contra `backtest/modules/label.mjs`.
- `backtest/modules/*.mjs` — traducciones a JS de los cinco módulos Pine; `backtest/run.mjs` es la
  CLI de medición; `backtest/smoke.mjs` es la suite de regresión de todo eso.
- `odd/tasks/` — registros de tareas autoritativos por funcionalidad; `openspec/`, `.atl/` — estado de las herramientas.

## Fuente de verdad

- El código Pine en `src/` es canónico: cuando un documento y el código publicado discrepan,
  decide el código y la discrepancia se documenta en lugar de suavizarse.
- Los cambios de comportamiento deben quedar en AMBOS lados: `src/modules/*.pine` y su traducción
  `backtest/modules/*.mjs`; `run.mjs validate` y `smoke.mjs` verifican la sincronización.
- Spec: `docs/technical-spec.md` (~2,000 líneas). Verdad de calibración: `docs/WEIGHT-CALIBRATION.md`
  — allí no se recomienda ningún cambio de pesos y la línea de medición está cerrada.
- `dist/` es salida de compilación, nunca se edita a mano. `build.mjs` fija el hash `SHIPPED_INDICATOR_SHA256`: una
  compilación `--strategy` falla si el indicador publicado cambió, así que actualiza el pin de forma deliberada.

## Advertencias clave (verificadas en este repositorio)

- La suite de smoke nunca lee `backtest/data/`: los datos de prueba (fixtures) son velas sintéticas
  construidas a mano dentro de `smoke.mjs`. Por eso no puede detectar una discrepancia de forma de vela
  contra el dataset real — ese tipo de bug ya ocurrió una vez y solo se vio en una ejecución en vivo (ver README).
- Los subcomandos nuevos de `run.mjs` tienen su propia lista de registro, que se une a `DISPATCHABLE`
  (`SUBCOMMANDS`, `EXTRA_SUBCOMMANDS`, `LATER_SUBCOMMANDS`, `CONCEPT_SUBCOMMANDS`). Ampliar una
  lista existente es un defecto; la suite verifica que los nombres reales estén y que los erróneos no.
- `docs/technical-spec.md` sección 12.3 muestra un orden de compilación anterior a Pine v5 y está
  mal; el orden autoritativo de módulos es el arreglo `SOURCES` en `scripts/assemble.mjs`.
- `src/lib/colors.pine`, `utils.pine`, `inputs.pine` están en `SOURCES` pero aún no existen:
  la compilación avisa y los omite. Es lo esperado, no un fallo.
- Los rechazos de la CLI son errores duros, no reglas de precedencia: `--strategy` con `--diagnostic` se
  rechaza, y `validate` acepta solo `--timeframe 5m` (sus lecturas se capturaron en ese intervalo).

## Documentos

- [README.md](README.md) — qué es (y qué no es) el indicador, resultados medidos, estructura, límites.
- [docs/technical-spec.md](docs/technical-spec.md) — especificación de comportamiento.
- [docs/WEIGHT-CALIBRATION.md](docs/WEIGHT-CALIBRATION.md) — hallazgos de calibración + apéndices.
- [docs/VALIDATION.md](docs/VALIDATION.md) — lecturas de gráfico que reproduce la verificación `validate`.
- [docs/ROUTE-A.md](docs/ROUTE-A.md) — compilación de la estrategia y procedimiento de instalación.

## Propiedad y revisión

- Escrito por una IA para lectores IAs; el dueño humano revisa y aprueba cualquier cambio en este
  archivo. Lee el archivo completo al menos una vez antes de confiar en líneas sueltas — además es
  el mapa más corto del proyecto.
- Una línea escrita por IA puede estar mal: un comando inventado, o una "fuente de verdad" que no lo es.
  Si algo aquí falla o contradice el código, arregla PRIMERO este archivo — hasta que se arregle,
  cada sesión repite la misma instrucción equivocada.
- Cada entrada debe estar verificada (comandos ejecutados, advertencias observadas en este
  repositorio); lo no verificable se elimina, no se suaviza. Mantenlo corto: pasadas ~100 líneas
  deja de leerse.

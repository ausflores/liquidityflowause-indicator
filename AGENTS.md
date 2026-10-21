# AGENTS.md

Indicador para TradingView en Pine Script v5 (cripto, 24/7) más un arnés de medición en Node sin dependencias.

## Comandos

No hay `package.json`, ni scripts de npm, ni linter — ejecuta `node` a secas desde la raíz del repositorio.

```bash
node scripts/build.mjs                        # REQUERIDO PRIMERO: ensambla dist/ (gitignored) + verificaciones textuales
node scripts/build.mjs --check                # solo valida, no escribe nada
node scripts/build.mjs --strategy             # variante estrategia Route A (docs/ROUTE-A.md)
node backtest/smoke.mjs                       # suite de regresión: 2.116 verificaciones, sin datos, sin red
node backtest/run.mjs validate                # gate de fidelidad vs docs/VALIDATION.md — SOLO 5m
node backtest/run.mjs                         # uso + lista completa de subcomandos
```

- **No hay CI**: no existe `.github/`. El build y la suite son las únicas puertas de calidad — correlos vos antes de pushear.
- `backtest/data/` está gitignored: un clone nuevo no tiene datos. `node backtest/run.mjs fetch` (toca la red) es el primer paso de cualquier medición; solo `fetch` usa la red o escribe, el resto de los subcomandos solo imprimen.
- La suite no se puede correr parcial: `smoke.mjs` no parsea `process.argv`; son 2.116 verificaciones de una sola pasada.
- Las cifras de `docs/` se midieron con `--timeframe 1h`; con el default **5m** el indicador prácticamente nunca dispara.

## Subcomandos de medición

- Los reales: `fetch`, `validate`, `baseline`, `diagnose`, `compare`, `ratio`, `band`, `concept`, `search`, `equity`. `search` está registrado pero **no implementado** (stub de T12).
- `--timeframe` no cambia solo la etiqueta: cambia la serie nativa (ATR de esa grilla, tiers HTF agregados en esa grilla). `validate` solo acepta 5m.
- `--json` da salida legible por máquina en `baseline`, `diagnose`, `compare`, `ratio`, `equity`; `ratio` además acepta `--horizon`, `--seed`, `--bootstrap`.
- Cada subcomando nuevo recibe su **propia** lista de registro, unida en `DISPATCHABLE` (`SUBCOMMANDS`, `EXTRA_SUBCOMMANDS`, `LATER_SUBCOMMANDS`, `CONCEPT_SUBCOMMANDS`). Ensanchar una lista existente es un defecto y la suite lo asserta.

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
- **Regla de oro del repo: si el brief o el doc contradice el código, gana el código y el desacuerdo se escribe.**
  Ya está registrada en varios casos.
- Los cambios de comportamiento deben quedar en AMBOS lados: `src/modules/*.pine` y su traducción
  `backtest/modules/*.mjs`; `run.mjs validate` y `smoke.mjs` verifican la sincronización.
- Spec: `docs/technical-spec.md` (~2.000 líneas). Verdad de calibración: `docs/WEIGHT-CALIBRATION.md`
  — la línea de pesos, target/stop y elección de modelo está **cerrada** (§11).
- `dist/` es salida de compilación, nunca se edita a mano. `build.mjs` fija el hash `SHIPPED_INDICATOR_SHA256`: una
  compilación `--strategy` falla si el indicador publicado cambió, así que actualiza el pin de forma deliberada.

## Advertencias clave (verificadas en este repositorio)

- La suite asserta sobre el **texto** de `scripts/build.mjs` y `scripts/assemble.mjs` (los lee como strings):
  cambiás esas fuentes y podés romper la suite aunque el comportamiento no cambie.
- La suite nunca lee `backtest/data/` (los fixtures son velas sintéticas construidas a mano dentro de
  `smoke.mjs`): no detecta discrepancias de forma de barra contra el dataset real — ese bug ya ocurrió una vez.
- No hay compilador de Pine: los chequeos del build son textuales, no parseo ni type-check. Un defecto compiló
  limpio y falló en runtime en la barra 0. Compilar no es funcionar.
- El gate real es `run.mjs validate`: el 5m se lee ahí adentro. `backtest/gate.mjs` solo exporta
  `runGate()` y no hace nada por sí solo.
- `src/lib/{colors,utils,inputs}.pine` nunca se escribieron y NO están declarados en `SOURCES`: sus roles (colores,
  helpers `f_*`, inputs) viven hoy dentro de `src/modules/*.pine`. El build FALLA si un módulo declarado no existe,
  y también FALLA si hay un `*.pine` bajo `src/` que no esté declarado (mismo criterio en las dos direcciones).
- Pine v5: `time()` por defecto devuelve `1234567` (dom-sáb), no `23456`.
- Route A: nunca pegarlo sobre el indicador (el build rehúsa una `strategy()` con `indicator()`); los cinco
  módulos deben quedar byte-idénticos y el SHA del indicador es `1dd6f536…582ce2`. En `strategy.exit`,
  `profit=1.5`/`loss=0.8` serían TICKS, no %: el archivo usa `limit`/`stop` con niveles absolutos.
- Los documentos tienen cifras viejas: `WEIGHT-CALIBRATION.md` dice 1.450/1.718/1.985 verificaciones (la real
  se imprime en runtime: 2.116) y su `LATER_SUBCOMMANDS` quedó desactualizada. NO ajustes el código para calzar con el doc.
- La línea de pesos y exits está cerrada (§11): ambos modelos de entrada pierden (weighted −4,07%, binary −11,84%
  en 5 años 1h) y el gross ya es negativo antes de la comisión. No re-tunear target/stop, no cambiar pesos, no
  adoptar binary: es decisión del maintainer, no tuya. Toda cifra es cota superior (fills al cierre, sin
  slippage, un exchange) y ningún triple gross/net/comisión se interpreta sin recalcular un miembro a mano.

## Documentos

- [README.md](README.md) — qué es (y qué no es) el indicador, resultados medidos, estructura, límites.
- [docs/technical-spec.md](docs/technical-spec.md) — especificación de comportamiento.
- [docs/WEIGHT-CALIBRATION.md](docs/WEIGHT-CALIBRATION.md) — hallazgos de calibración + apéndices (§11 = línea cerrada).
- [docs/VALIDATION.md](docs/VALIDATION.md) — lecturas del gate; válidas solo en ≤1H y con puntero visible.
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

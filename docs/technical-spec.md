# LiquidityFlowAuse — Technical Specification

**Version:** 1.0.0
**Pine Script Version:** v5
**Platform:** TradingView
**License:** MIT
**Target Asset Class:** Cryptocurrency (24/7 markets)

---

## Table of Contents

1. [Overview](#1-overview)
2. [Architecture](#2-architecture)
3. [Module: Liquidity Zones](#3-module-liquidity-zones)
4. [Module: Session Markers](#4-module-session-markers)
5. [Module: Imbalance Detector](#5-module-imbalance-detector)
6. [Module: Structure Break (BoS/ChoCh)](#6-module-structure-break-boschch)
7. [Module: Signal Engine](#7-module-signal-engine)
8. [User Inputs](#8-user-inputs)
9. [Visual Design](#9-visual-design)
10. [Alert System](#10-alert-system)
11. [Limitations & Risk Disclaimer](#11-limitations--risk-disclaimer)
12. [File Structure](#12-file-structure)

---

## 1. Overview

### 1.1 What It Does

LiquidityFlowAuse is a multi-timeframe confluence indicator for TradingView that identifies high-probability LONG and SHORT entry zones in cryptocurrency markets. It combines three independent factors — **liquidity proximity**, **session alignment**, and **imbalance/structure-break confirmation** — and only fires a signal when all three align on the same side.

### 1.2 Who It Is For

- Retail traders with small capital ($100–$5,000) seeking 1–2% intraday gains
- Traders who understand top-down analysis but need automated visualization
- Crypto-native traders operating in 24/7 markets without traditional session opens

### 1.3 Core Trading Philosophy

> **Trade where liquidity flows, not where you hope price goes.**

The indicator is built on the premise that price moves to hunt liquidity. It does not predict direction — it identifies zones where liquidity clusters exist, then waits for confirmation that price is actually flowing in that direction. The three-factor confluence model reduces false signals compared to any single-indicator approach:

| Factor | Purpose | Timeframe |
|--------|---------|-----------|
| **Liquidity Zone** | Where are the stop-loss clusters? | D1 + 4H + 1H |
| **Session Overlap** | When is volume/institutions active? | Time-based |
| **Imbalance + Structure Break** | Is price actually moving? | 1H + 5min |

A signal requires **all three factors to agree on the same side** (LONG or SHORT). This is a deliberate filter — the indicator will show fewer signals, but with higher conviction.

### 1.4 Non-Goals

- This is NOT a trend-following system
- This is NOT a scalping tool (minimum 5min entry TF, not 1min)
- This is NOT a support/resistance indicator that draws arbitrary lines
- This is NOT financial advice

---

## 2. Architecture

### 2.1 Multi-Timeframe Design

The indicator operates on a strict top-down hierarchy:

```
┌─────────────────────────────────────────────────────┐
│  D1 (Daily)                                         │
│  ── Major liquidity zones, weekly structure ──      │
│  ── Macro bias filter ──                            │
├─────────────────────────────────────────────────────┤
│  4H (4-Hour)                                       │
│  ── Intermediate liquidity, session context ──      │
│  ── Structure confirmation ──                       │
├─────────────────────────────────────────────────────┤
│  1H (1-Hour)                                       │
│  ── Local liquidity, BoS/ChoCh detection ──         │
│  ── Signal zone refinement ──                       │
├─────────────────────────────────────────────────────┤
│  5min (Entry ONLY)                                  │
│  ── Imbalance detection, final entry trigger ──     │
│  ── NO trend determination ──                       │
└─────────────────────────────────────────────────────┘
```

### 2.2 Data Flow Between Timeframes

Pine Script v5 uses `request.security()` to access higher-timeframe data. The critical rule is **lookahead prevention** — we use `barmerge.lookahead_off` combined with the `[1]` offset pattern to access only confirmed historical bars, ensuring no future data leaks into calculations.

```pine
//@version=5
indicator("LiquidityFlowAuse", overlay=true, max_labels_count=500, max_lines_count=500, max_boxes_count=500)

// ─── Higher-Timeframe Data Access ──────────────────────────────────────────────
// D1 data — used for major liquidity zones and macro structure
d1_close   = request.security(syminfo.tickerid, "D", close[1],  lookahead=barmerge.lookahead_off)
d1_high    = request.security(syminfo.tickerid, "D", high[1],   lookahead=barmerge.lookahead_off)
d1_low     = request.security(syminfo.tickerid, "D", low[1],    lookahead=barmerge.lookahead_off)

// 4H data — intermediate context
h4_close   = request.security(syminfo.tickerid, "240", close[1], lookahead=barmerge.lookahead_off)
h4_high    = request.security(syminfo.tickerid, "240", high[1],  lookahead=barmerge.lookahead_off)
h4_low     = request.security(syminfo.tickerid, "240", low[1],   lookahead=barmerge.lookahead_off)

// 1H data — structure breaks and local liquidity
h1_close   = request.security(syminfo.tickerid, "60", close[1],  lookahead=barmerge.lookahead_off)
h1_high    = request.security(syminfo.tickerid, "60", high[1],   lookahead=barmerge.lookahead_off)
h1_low     = request.security(syminfo.tickerid, "60", low[1],    lookahead=barmerge.lookahead_off)

// Pivot values are fetched separately in section 3.2.1, and deliberately
// without the [1] offset: ta.pivothigh()/ta.pivotlow() are already
// non-repainting, so lookahead_off alone is sufficient. Referencing bare
// `pivotHigh` / `pivotLow` identifiers here, as an earlier draft did, resolved
// to nothing and could not compile.
```

**Key design decision:** We use `[1]` offset (previous confirmed bar) to avoid intra-bar repainting. The indicator refreshes on each tick for visual smoothness but only **confirms signals on bar close**.

**Where `[1]` does and does not apply.** The offset is for direct OHLC access,
where the previously confirmed bar is specifically wanted. It is *not* a blanket
rule: expressions that are already non-repainting — `ta.pivothigh()`,
`ta.pivotlow()`, `ta.atr()` — do not need it, and adding one would delay
detection by a full higher-timeframe bar for no gain. See section 3.2.1.

### 2.3 State Management

Because Pine Script executes top-to-bottom on each bar, we use `var` to maintain persistent state across bars:

```pine
// Liquidity zones are held in one array of a user type, declared in section 3.2.2.
// A single record carries price, tier, age and the drawing handle, so a zone
// cannot be half-removed and a cull can always delete its box. Parallel
// price/tier arrays — as in earlier drafts — cannot express that.
var array<LiquidityZone> zones = array.new<LiquidityZone>()

// Persistent state for structure tracking
var float swingHighPrice = na
var float swingLowPrice  = na
var int   swingHighBar   = na
var int   swingLowBar    = na
```

### 2.4 Execution Model

```
On each bar:
  1. Fetch HTF data via request.security()
  2. Update liquidity zone state (detect new pivots, extend/remove old zones)
  3. Update session markers (check current time vs session windows)
  4. Detect imbalances on current TF (if 1H) or via security (if 5min)
  5. Detect BoS/ChoCh on 1H via security
  6. Evaluate confluence: all 3 factors aligned?
  7. IF confirmed on bar close → emit signal label + alert
  8. Render all visual elements
```

---

## 3. Module: Liquidity Zones

### 3.1 Concept

Liquidity zones are price levels where stop-loss orders cluster. In crypto, these form at:
- **Pivot highs/lows** (equal highs/lows)
- **Volume profile POC (Point of Control)** areas
- **Untested swing points** from higher timeframes

Price is magnetically drawn to these zones to "sweep" liquidity before reversing.

### 3.2 Detection Algorithm

#### 3.2.1 Pivot-Based Detection

We use Pine Script's built-in `ta.pivothigh()` and `ta.pivotlow()` to identify swing
points on all three higher timeframes.

**Lookahead note.** `ta.pivothigh()` is intrinsically non-repainting: it only
returns a value on the bar where the pivot is confirmed, and `na` afterwards.
Combined with `barmerge.lookahead_off` that is sufficient on its own, so **no
`[1]` offset is applied to the pivot expressions**. The `[1]` pattern documented
in section 2.2 applies to direct OHLC access, where you explicitly want the
previously confirmed bar; adding it to a pivot would delay detection by a whole
extra higher-timeframe bar for no benefit.

The same reasoning applies to the ATR fetches below: with `lookahead_off`,
`request.security()` only exposes a higher-timeframe value once that timeframe's
bar has closed, so in-progress data cannot leak and no extra offset is needed.

```pine
// Pivot detection parameters — applied consistently to all three timeframes.
pivotLenHigh = input.int(10, "Pivot Length High", minval=3, group="Liquidity Zones")
pivotLenLow  = input.int(10, "Pivot Length Low",  minval=3, group="Liquidity Zones")

// D1 — major liquidity
d1_pivotHigh = request.security(syminfo.tickerid, "D",   ta.pivothigh(high, pivotLenHigh, pivotLenHigh), lookahead=barmerge.lookahead_off)
d1_pivotLow  = request.security(syminfo.tickerid, "D",   ta.pivotlow(low,  pivotLenLow,  pivotLenLow),  lookahead=barmerge.lookahead_off)

// 4H — intermediate liquidity
h4_pivotHigh = request.security(syminfo.tickerid, "240", ta.pivothigh(high, pivotLenHigh, pivotLenHigh), lookahead=barmerge.lookahead_off)
h4_pivotLow  = request.security(syminfo.tickerid, "240", ta.pivotlow(low,  pivotLenLow,  pivotLenLow),  lookahead=barmerge.lookahead_off)

// 1H — local liquidity. Required for tier 3; without it nearH1Liquidity can
// never become true, because nothing ever populates a tier-3 zone.
h1_pivotHigh = request.security(syminfo.tickerid, "60",  ta.pivothigh(high, pivotLenHigh, pivotLenHigh), lookahead=barmerge.lookahead_off)
h1_pivotLow  = request.security(syminfo.tickerid, "60",  ta.pivotlow(low,  pivotLenLow,  pivotLenLow),  lookahead=barmerge.lookahead_off)
```

#### 3.2.2 Zone Construction

When a pivot is confirmed, a liquidity zone is constructed around it.

**Storage.** A single `array<LiquidityZone>` holds every zone, rather than the
parallel `zonePrices` / `zoneTiers` arrays used in earlier drafts plus separate
box arrays. Parallel arrays must be mutated in lockstep and offer no way to
reach the `box` object needed for deletion; a user type keeps price, tier, age
and drawing handle on one record, so a zone cannot desynchronise and can always
be removed cleanly.

**One array, not two.** Direction is not baked in at creation. A pivot low sits
below price until price crosses it, at which point it is no longer demand-side
liquidity — so demand/supply is derived from the current bar at evaluation time
(see 3.3) instead of being frozen into the record.

```pine
type LiquidityZone
    float center
    float halfWidth
    int   tier
    int   bornBar
    int   sweptBar       // bar_index of the sweep; na while the zone is untested
    box   zoneBox

var array<LiquidityZone> zones = array.new<LiquidityZone>()

// Zone width is sized with the ATR of the timeframe the pivot came from, so a
// D1 zone is not sized with a 5-minute volatility reading.
zoneATRMult = input.float(0.5, "Zone Width (× HTF ATR)", minval=0.1, step=0.1, group="Liquidity Zones")
maxZones    = input.int(50, "Max Zones", minval=10, maxval=200, group="Liquidity Zones")

atrD1 = request.security(syminfo.tickerid, "D",   ta.atr(14), lookahead=barmerge.lookahead_off)
atrH4 = request.security(syminfo.tickerid, "240", ta.atr(14), lookahead=barmerge.lookahead_off)
atrH1 = request.security(syminfo.tickerid, "60",  ta.atr(14), lookahead=barmerge.lookahead_off)

// Visual weight by tier. Higher timeframe = more significance = heavier stroke.
f_newZone(int tier, float center, float halfWidth) =>
    color border = tier == 1 ? color.new(color.red, 60) : tier == 2 ? color.new(color.red, 75) : color.new(color.red, 88)
    color fill   = tier == 1 ? color.new(color.red, 92) : tier == 2 ? color.new(color.red, 94) : color.new(color.red, 96)
    int   width  = tier == 1 ? 2 : 1
    box.new(
         bar_index, center + halfWidth,
         bar_index, center - halfWidth,
         border_color = border,
         border_width = width,
         border_style = line.style_dashed,
         bgcolor      = fill,
         xloc         = xloc.bar_index,
         extend       = extend.right)

// Make room by evicting the oldest zone. A brand-new pivot is always more
// relevant than a zone hundreds of bars old, so eviction replaces the
// "if array.size(zones) < maxZones" guard, which silently DROPPED the new zone
// precisely when the array was full — backwards.
f_makeRoom() =>
    if array.size(zones) >= maxZones
        int oldest = 0
        for i = 1 to array.size(zones) - 1
            if array.get(zones, i).bornBar < array.get(zones, oldest).bornBar
                oldest := i
        box.delete(array.get(zones, oldest).zoneBox)
        array.remove(zones, oldest)

// Add a confirmed pivot as a zone, if the tier is enabled.
f_addZone(int tier, float pivotPrice, float atr, bool showTier) =>
    if showTier and not na(pivotPrice) and not na(atr)
        f_makeRoom()
        array.push(zones, LiquidityZone.new(
             pivotPrice,
             atr * zoneATRMult,
             tier,
             bar_index,
             na,
             f_newZone(tier, pivotPrice, atr * zoneATRMult)))

if not na(d1_pivotHigh)
    f_addZone(1, d1_pivotHigh, atrD1, showD1Zones)
if not na(d1_pivotLow)
    f_addZone(1, d1_pivotLow,  atrD1, showD1Zones)
if not na(h4_pivotHigh)
    f_addZone(2, h4_pivotHigh, atrH4, showH4Zones)
if not na(h4_pivotLow)
    f_addZone(2, h4_pivotLow,  atrH4, showH4Zones)
if not na(h1_pivotHigh)
    f_addZone(3, h1_pivotHigh, atrH1, showH1Zones)
if not na(h1_pivotLow)
    f_addZone(3, h1_pivotLow,  atrH1, showH1Zones)
```

**Zone geometry.** Zones are persistent horizontal bands, not fixed-size boxes.
`xloc = xloc.bar_index` with `extend = extend.right` pins the left edge at the bar
the pivot was confirmed and stretches the right edge to the current bar, so the
band grows as the chart advances and disappears when culled. An earlier draft
created a 40-bar box extending 20 bars into the future, which neither persisted
nor tracked price.

#### 3.2.3 Zone Hierarchy & Filtering

Not all zones are equal. We tier them by timeframe:

| Tier | Source | Visual Weight | Purpose |
|------|--------|---------------|---------|
| 1 (Highest) | D1 pivots | Thick dashed boxes, 30% opacity | Major liquidity — primary targets |
| 2 | 4H pivots | Medium boxes, 50% opacity | Intermediate — secondary targets |
| 3 | 1H pivots | Thin boxes, 70% opacity | Local — minor liquidity |

Zones are **culled** by any of three independent rules:

| Rule | Threshold | Rationale |
|------|-----------|-----------|
| **Age** | older than `maxZoneAgeBars` (default 500 bars) | Stops unbounded accumulation and keeps old structure out of the picture |
| **Distance** | beyond `maxZoneDistanceATR` (default 15 × **4H** ATR) | Far-away zones are no longer actionable |
| **Swept and aged out** | swept longer ago than `sweptRetainBars` (default 100 bars) | Bounds how long a swept zone lingers |

**A sweep does not remove a zone — it marks it.** The premise of the indicator
is that price travels to hunt liquidity, so the sweep is the event of interest,
not the end of the zone's life. Deleting a zone on first touch would destroy the
one piece of information the Signal Engine most wants: that a sweep just
happened, and where. The sweep is recorded in `sweptBar` and the zone persists
until its own age, distance, or swept-retention limit expires.

That retention limit is what keeps a swept zone from lingering forever. It is
deliberately shorter than `maxZoneAgeBars`, because a swept zone has a short
useful life while an untouched one is a target that may still be approached.

Every cull **must delete the drawing**. Removing the record without
`box.delete()` leaves a zone visible on the chart that no longer participates in
proximity logic — a visual and logical divergence, and the bug present in the
earlier draft.

```pine
maxZoneAgeBars     = input.int(500,   "Max Zone Age (bars)",        minval=50, group="Liquidity Zones")
maxZoneDistanceATR = input.float(15.0, "Max Zone Distance (x 4H ATR)", minval=5.0, step=1.0, group="Liquidity Zones")
sweptRetainBars    = input.int(100,   "Swept Zone Retention (bars)", minval=10, group="Liquidity Zones")

// Proximity and culling thresholds measure on the ENTRY timeframe, because that
// is the timeframe on which price is being evaluated — a D1 ATR in the proximity
// test would make a 5-minute approach to a zone look like nothing.
//
// The distance cull is the ONE exception: it uses the 4H ATR. Anchored to the
// entry timeframe, 15 x a 5-minute ATR is a tiny distance, so D1 zones are born
// and culled on the same bar and the tier hierarchy collapses — with no error,
// D1 liquidity just goes missing. Measured against 4H, the threshold means the
// same thing on any chart timeframe, and a D1 zone survives on 5m as it does
// on 1h.
atrChart = ta.atr(14)

// Runs AFTER zone creation, so a zone that is born and swept on the same bar is
// correctly marked rather than surviving untouched.
if array.size(zones) > 0
    for i = 0 to array.size(zones) - 1
        LiquidityZone z = array.get(zones, i)

        bool inZone = high >= z.center - z.halfWidth and low <= z.center + z.halfWidth
        if inZone and na(z.sweptBar)
            array.set(zones, i, LiquidityZone.new(
                 z.center, z.halfWidth, z.tier, z.bornBar, bar_index, z.zoneBox))

    for i = array.size(zones) - 1 to 0
        LiquidityZone z = array.get(zones, i)

        bool tooOld   = bar_index - z.bornBar > maxZoneAgeBars
        bool tooFar   = math.abs(close - z.center) > atrChart * maxZoneDistanceATR
        bool stale    = not na(z.sweptBar) and bar_index - z.sweptBar > sweptRetainBars

        if tooOld or tooFar or stale
            box.delete(z.zoneBox)
            array.remove(zones, i)
```

### 3.3 Proximity Check (Signal Input)

The Signal Engine needs to know whether price is **near** a liquidity zone, and
at which tier. The threshold is measured with the **entry-timeframe** ATR
(`atrChart`), because that is the timeframe on which price is being evaluated —
using a D1 ATR here would make a 5-minute approach look like nothing.

Direction is derived, not stored: a zone below price is demand-side, a zone
above price is supply-side. The same record serves both without reclassification.

`atrChart` is the name used throughout this section. Earlier drafts referenced
an `atrValue` that was never defined, which does not compile.

```pine
// Module-level outputs consumed by the Signal Engine.
bool nearLiquidityLong  = false
bool nearLiquidityShort = false
bool sweptLong          = false
bool sweptShort         = false
bool nearD1Liquidity    = false
bool nearH4Liquidity    = false
bool nearH1Liquidity    = false

proxATRMult = input.float(3.0, "Proximity (× ATR)", minval=0.5, step=0.5, group="Liquidity Zones")
sweepWindow = input.int(10, "Sweep Signal Window (bars)", minval=1, group="Liquidity Zones")

if array.size(zones) > 0 and not na(atrChart)
    for i = 0 to array.size(zones) - 1
        LiquidityZone z = array.get(zones, i)

        bool inBody = high >= z.center - z.halfWidth and low <= z.center + z.halfWidth
        bool near   = math.abs(close - z.center) <= atrChart * proxATRMult

        // A recent sweep of a zone below price = demand-side liquidity taken.
        if not na(z.sweptBar) and bar_index - z.sweptBar <= sweepWindow
            if z.center < close
                sweptLong := true
            else
                sweptShort := true

        // Proximity is deliberately exclusive of an in-body bar: the zone has
        // already been reached on that bar, and reporting "near" at the same
        // time as "swept" would double-count one event as two factors.
        if near and not inBody
            if z.center < close
                nearLiquidityLong := true
                nearD1Liquidity    := nearD1Liquidity or z.tier == 1
                nearH4Liquidity    := nearH4Liquidity or z.tier == 2
                nearH1Liquidity    := nearH1Liquidity or z.tier == 3
            else
                nearLiquidityShort := true
                nearD1Liquidity    := nearD1Liquidity or z.tier == 1
                nearH4Liquidity    := nearH4Liquidity or z.tier == 2
                nearH1Liquidity    := nearH1Liquidity or z.tier == 3
```

### 3.4 Module Interface

What this module exports to the Signal Engine:

| Output | Type | Meaning |
|--------|------|---------|
| `nearLiquidityLong` | bool | Price is near untested demand-side liquidity below it |
| `nearLiquidityShort` | bool | Price is near untested supply-side liquidity above it |
| `sweptLong` | bool | Demand-side liquidity below was swept within `sweepWindow` bars |
| `sweptShort` | bool | Supply-side liquidity above was swept within `sweepWindow` bars |
| `nearD1LiquidityLong` / `Short` | bool | That proximity is to a D1 (tier 1) zone, **per side** |
| `nearH4LiquidityLong` / `Short` | bool | That proximity is to a 4H (tier 2) zone, **per side** |
| `nearH1LiquidityLong` / `Short` | bool | That proximity is to a 1H (tier 3) zone, **per side** |

**Tier flags are per side, and must stay that way.** An earlier draft exposed
`nearD1Liquidity` as a single flag set from both the demand and the supply
branch. That flag is under-determined: it cannot say which side the nearby D1
liquidity is on. The Signal Engine scores direction, so a LONG setup would earn
"near D1 liquidity" points because a D1 zone *above* price — the one a short
would use — happened to be nearby. Six per-side flags replace three shared ones
so that (tier, side) is always jointly determined.

**Proximity and sweep are mutually exclusive on any given bar.** `near*` requires
the bar's range to be outside the zone body; once price reaches the body the
zone is swept and reports through `swept*` instead. The Signal Engine therefore
cannot double-count a single event as both "approaching liquidity" and "took
liquidity" — which would inflate a three-factor confluence score on one factor.

**Sweep direction is derived from the zone's position at sweep time, not from
the bar's direction.** A zone below price that gets swept is demand-side
liquidity taken, regardless of whether the bar closed up or down; the reversal
that may follow is the Structure Break module's concern, not this one's.

**`max_boxes_count` constraint.** The main indicator declares
`max_boxes_count=500`. `maxZones` is capped at 200, and every cull calls
`box.delete()`, so live boxes stay bounded by `maxZones` and cannot exhaust the
Pine drawing budget. Raising `maxZones` above 500 would break that invariant and
require raising the declaration to match.

---

## 4. Module: Session Markers

### 4.1 Concept

Crypto trades 24/7, but **volume and volatility still follow traditional market sessions**. Institutional participants (who move price) operate on traditional schedules. The session module highlights when these windows are active.

### 4.2 Session Windows (UTC-based)

| Session | UTC Hours | Character |
|---------|-----------|-----------|
| **Asia (Tokyo)** | 00:00 – 09:00 | Range-bound, lower volume, accumulation |
| **London** | 07:00 – 16:00 | Directional moves, trend initiation |
| **New York** | 13:00 – 22:00 | Highest volume, momentum, reversals |
| **Overlap (Lon+NY)** | 13:00 – 16:00 | Maximum volatility — highest priority |

### 4.3 Timezone Handling

```pine
// ─── Session Configuration ─────────────────────────────────────────────────────
sessionAsiaEnabled  = input.bool(true,  "Show Asia Session",  group="Sessions")
sessionLondonEnabled = input.bool(true,  "Show London Session", group="Sessions")
sessionNYEnabled     = input.bool(true,  "Show New York Session", group="Sessions")
showOverlapOnly      = input.bool(false, "Highlight Overlap Only", group="Sessions")

// Timezone input (exchange timezone as default)
sessionTimezone     = input.string("exchange", "Session Timezone", 
                     options=["exchange", "UTC", "America/New_York", "Europe/London", "Asia/Tokyo"], 
                     group="Sessions")

// Session windows, in the selected timezone.
// These are RECURRING daily boundaries, not absolute instants, so they use
// input.session() — whose defval is a session string — not input.time(), whose
// defval is an int UNIX timestamp. Pine v5 defaults session days to 1234567
// (Sun-Sat), which matches 24/7 crypto markets.
asiaSession   = input.session("0000-0900", "Asia Session",  group="Sessions")
londonSession = input.session("0700-1600", "London Session", group="Sessions")
nySession     = input.session("1300-2200", "New York Session", group="Sessions")
```

**Timezone constraint:** `time()`'s timezone argument accepts only UTC/GMT
notation (`"UTC-5"`, `"GMT+0530"`) or an IANA zone name (`"America/New_York"`).
`"exchange"` is **not** accepted and raises a runtime error on bar 0, even
though it compiles. Since `time()` uses the exchange timezone when the argument
is omitted, `"exchange"` is routed through the two-argument overload:

```pine
bool useExchangeTz = sessionTimezone == "exchange"

if not na(sessionTimezone)
    inAsia := sessionAsiaEnabled and (useExchangeTz
        ? not na(time(timeframe.period, asiaSession))
        : not na(time(timeframe.period, asiaSession, sessionTimezone)))
```

### 4.4 Session Detection Logic

```pine
// Current bar time in the selected timezone
currentTime = time(timeframe.period, "00:00-23:59", sessionTimezone)

// Session membership checks
bool inAsia   = sessionAsiaEnabled  and currentTime >= asiaStart   and currentTime < asiaEnd
bool inLondon = sessionLondonEnabled and currentTime >= londonStart and currentTime < londonEnd
bool inNY     = sessionNYEnabled     and currentTime >= nyStart     and currentTime < nyEnd

// Overlap detection (London + New York)
bool inOverlap = inLondon and inNY

// Session strength score (used by signal engine).
// Additive: 0 none, 1 Asia, 2 London, 2 NY, 5 London+NY together.
// The Signal Engine gates on `sessionStrength >= 2`.
int sessionStrength = 0
if inAsia
    sessionStrength += 1
if inLondon
    sessionStrength += 2
if inNY
    sessionStrength += 2
if inOverlap
    sessionStrength += 3
```

### 4.5 Visual Rendering

Sessions are rendered as **background color tints** on the chart:

```pine
// Background color based on session
color bgColor = na
if inOverlap
    bgColor := color.new(color.yellow, 92)  // Strongest highlight
else if inLondon or inNY
    bgColor := color.new(color.blue, 94)     // Moderate highlight
else if inAsia
    bgColor := color.new(color.purple, 96)   // Lightest highlight

bgcolor(bgColor, title="Session Background")

// Session boundary lines — opening bar of each session only.
// ta.change() fires on BOTH the opening and the closing edge, so the `and inX`
// conjunct is required. Without it every session window draws two lines instead
// of one.
if sessionAsiaEnabled and ta.change(inAsia) and inAsia
    line.new(bar_index, low, bar_index, high, color=color.purple, style=line.style_dotted, width=1)
if sessionLondonEnabled and ta.change(inLondon) and inLondon
    line.new(bar_index, low, bar_index, high, color=color.blue, style=line.style_dotted, width=1)
if sessionNYEnabled and ta.change(inNY) and inNY
    line.new(bar_index, low, bar_index, high, color=color.orange, style=line.style_dotted, width=1)
```

**Note on the background tint chain above:** the Asia branch is written as a
ternary rather than a fourth `else` branch, because Pine v5 has no
`else <condition>` form that opens an indented block.

**Note on boundary line geometry:** `line.new(bar_index, low, bar_index, high)`
spans only the opening bar's low-to-high range. These are short vertical
segments, not full-height dividers. The indicator declares `max_lines_count=500`;
on low timeframes across long ranges Pine drops the oldest lines, so boundary
lines become unreliable past roughly 500 session opens.

### 4.6 Session-Based Signal Weighting

The signal engine uses session context as a **binary gate, not a multiplier**.
Crypto trades 24/7, so scaling confidence by session would suppress signals
outside traditional hours for no market reason. The pseudo-code below records
the original design intent; see the note after the block:

```pine
// Session acts as a confidence multiplier, not a blocker
// During Asia session, signals are deprioritized but not eliminated
float sessionMultiplier = 1.0
if inOverlap
    sessionMultiplier := 1.5
else if inLondon or inNY
    sessionMultiplier := 1.0
else if inAsia
    sessionMultiplier := 0.5
else
    sessionMultiplier := 0.3  // Weekend/dead zone — reduced but possible
```

**Note — `sessionMultiplier` is exported but deliberately not applied.** The
pseudo-code above records design intent, not runtime behaviour. Session Markers
does compute and export `sessionMultiplier` with exactly those values (see
`src/modules/session-markers.pine`), but Signal Engine intentionally ignores it:
crypto trades 24/7, so a session multiplier would scale down signals outside
traditional hours for no market reason. Signal Engine gates on the binary
`sessionStrength` test instead — a signal outside a tradable session is
suppressed outright rather than scored down. The choice is written up in the
session-factor comment above `bool sessionOK` in
`src/modules/signal-engine.pine`.

## 5. Module: Imbalance Detector

### 5.1 Concept

An **imbalance** (also called "fair value gap" or "inefficiency") occurs when price moves so aggressively that it leaves behind untraded price areas. These act as magnets — price often returns to fill them. Imbalances confirm that real aggressive buying/selling occurred.

### 5.2 Detection Algorithm

We detect two types of imbalances:

#### 5.2.1 Candle Body Imbalance (3-Candle Pattern)

A bullish imbalance (fair value gap) forms when candle 3's low sits above
candle 1's high, leaving an untraded price band between them. Bearish is the
mirror image.

**The measured size and the drawn region must be the same region.** An earlier
draft measured `low[1] - high[2]` — only the gap between candle 1 and candle 2 —
while drawing a box from `high[2]` to `low[0]`, which spans both gaps plus the
isolated middle candle. The threshold therefore filtered on a quantity different
from the one displayed, so the visible band could be far smaller than the number
that admitted it. The size below is measured across the full band that gets
drawn.

```pine
// ─── Imbalance Detection ───────────────────────────────────────────────────────
imbalanceThreshold = input.float(1.0, "Imbalance Min Size (× ATR)", minval=0.1, step=0.1, group="Imbalances")

// Bullish FVG: candle 3 low above candle 1 high
bool bullishFVG = low[0] > high[2]
// Bearish FVG: candle 3 high below candle 1 low
bool bearishFVG = high[0] < low[2]

// Size spans the SAME region that is drawn: the full band between candle 1 and
// candle 3, not just one leg of it.
float bullSize = low[0] - high[2]   // bullish band height
float bearSize = low[2] - high[0]   // bearish band height

bool validBull = bullSize > atrChart * imbalanceThreshold
bool validBear = bearSize > atrChart * imbalanceThreshold

bool bullishImbalance = bullishFVG and validBull
bool bearishImbalance = bearishFVG and validBear
```

**On the two-gap variant.** An earlier draft required `high[2] < low[1] and
high[1] < low[0]` — two gaps, with candle 2 fully isolated. That is a stricter
"complete isolation" definition, not an error, but it is a different signal and
it is not what the threshold text described. The single-gap form above is used;
if isolation is wanted later it should be a separate, separately-filtered
signal rather than a silent change to this one.

#### 5.2.2 Volume Delta Imbalance

We compare buyer-initiated vs seller-initiated volume using a simple proxy:

```pine
// Volume delta proxy: close vs open position within candle
// If close >> open, more buying pressure; if close << open, more selling pressure
float candleDelta = close - open
float avgDelta    = ta.sma(candleDelta, 20)

// Delta divergence: price up but delta down = potential reversal signal
bool deltaBullish = candleDelta > 0 and close > close[1]   // Strong buying
bool deltaBearish = candleDelta < 0 and close < close[1]   // Strong selling

// Volume confirmation: current volume above average
bool volumeConfirmed = volume > ta.sma(volume, 20) * 1.2
```

### 5.3 Imbalance Lifecycle

**An imbalance is a stored zone, not a per-bar marker.** Section 5.1 states that
these areas act as magnets that price returns to fill. A three-bar marker cannot
express that premise: the gap forms, the marker expires, and the eventual return
— the entire reason the concept matters — is never displayed. So each confirmed
imbalance is stored and drawn as a persistent band, exactly as a liquidity zone
is, and survives until price fills it.

This is a deliberate departure from treating the entry timeframe as purely
transient. "Entry only" governs *where* imbalances are detected, not how long
they remain visible afterwards.

Storage follows the same pattern as Liquidity Zones — one array of a user type —
so an imbalance cannot be half-removed and its box is always reachable for
deletion.

```pine
type ImbalanceZone
    float top
    float bottom
    bool  isBull       // not `bullish` — that shadows the builtin
    int   bornBar
    int   touchedBar    // bar_index on first entry; na while untouched
    box   zoneBox

var array<ImbalanceZone> imbalances = array.new<ImbalanceZone>()

maxImbalances = input.int(60,  "Max Imbalances",           minval=10, maxval=200, group="Imbalances")
maxFvgAgeBars = input.int(300, "Max Imbalance Age (bars)", minval=50,  group="Imbalances")

// Persistent band, pinned at the candle that completed the pattern and
// stretched to the current bar.
f_newImbalance(bool bullish, float top, float bottom) =>
    color border = bullish ? color.new(color.green, 50) : color.new(color.red, 50)
    color fill   = bullish ? color.new(color.green, 85) : color.new(color.red, 85)
    box.new(
         bar_index, top,
         bar_index, bottom,
         border_color = border,
         border_width = 1,
         border_style = line.style_solid,
         bgcolor      = fill,
         xloc         = xloc.bar_index,
         extend       = extend.right)

// Evict the OLDEST imbalance when full. Dropping the new one, as an earlier
// guard did, is backwards — a gap forming now matters more than one that formed
// hundreds of bars ago.
f_makeFvgRoom() =>
    if array.size(imbalances) >= maxImbalances
        int oldest = 0
        for i = 1 to array.size(imbalances) - 1
            if array.get(imbalances, i).bornBar < array.get(imbalances, oldest).bornBar
                oldest := i
        box.delete(array.get(imbalances, oldest).zoneBox)
        array.remove(imbalances, oldest)
```

**Creation** runs on the bar the third candle closes, recording the band edges
measured in 5.2.1 — the same region the threshold filtered on:

```pine
if bullishImbalance and showImbalances
    f_makeFvgRoom()
    array.push(imbalances, ImbalanceZone.new(
         low[0], high[2], true, bar_index, na,
         f_newImbalance(true, low[0], high[2])))

if bearishImbalance and showImbalances
    f_makeFvgRoom()
    array.push(imbalances, ImbalanceZone.new(
         low[2], high[0], false, bar_index, na,
         f_newImbalance(false, low[2], high[0])))
```

**Touch** records the first bar **after creation** whose range reached into the
band. The imbalance is *not* removed — the Signal Engine needs to know a gap was
filled and on what side, exactly as it needed `sweptLong` / `sweptShort` from
Liquidity Zones.

The `bornBar < bar_index` guard is **load-bearing, not defensive.** A gap's own
edges are derived from the creating bar's own prices — a bullish band runs from
`high[2]` to `low[0]`, and the pattern guarantees `low[0] > high[2]`. So on the
creation bar `high >= fi.bottom` is `high[0] >= high[2]`, which holds by
construction, and `low <= fi.top` is `low[0] <= low[0]`, an identity. Testing
`reached` alone marks **every** gap as touched the moment it is born, which
would make `nearImbalanceLong` / `nearImbalanceShort` permanently false and make
every gap retire `fvgFilledRetainBars` after its birth rather than after a real
fill.

A newly formed gap is unfilled by definition — that is what a gap *is*.

**Retire** removes it on age, or once touched and left alone for
`fvgFilledRetainBars`. Every removal deletes the box.

```pine
fvgFilledRetainBars = input.int(50, "Filled Imbalance Retention (bars)", minval=5, group="Imbalances")

if array.size(imbalances) > 0
    for i = 0 to array.size(imbalances) - 1
        ImbalanceZone fi = array.get(imbalances, i)
        bool reached  = high >= fi.bottom and low <= fi.top
        bool canTouch = fi.bornBar < bar_index
        if reached and canTouch and na(fi.touchedBar)
            array.set(imbalances, i, ImbalanceZone.new(
                 fi.top, fi.bottom, fi.isBull, fi.bornBar, bar_index, fi.zoneBox))

    for i = array.size(imbalances) - 1 to 0
        ImbalanceZone fr = array.get(imbalances, i)
        bool tooOld    = bar_index - fr.bornBar > maxFvgAgeBars
        bool filledOut = not na(fr.touchedBar) and bar_index - fr.touchedBar > fvgFilledRetainBars
        if tooOld or filledOut
            box.delete(fr.zoneBox)
            array.remove(imbalances, i)
```

**Visual distinction.** An untouched imbalance is a faint outline; a touched one
is filled solid, so the chart shows at a glance which gaps price has already
reacted to and which are still virgin. Applied with `box.set_bgcolor()` and
`box.set_border_color()` on the touch bar rather than by creating a second box.
The border *style* is unchanged between the two states, so `set_border_style()`
is not used — it would be a no-op.

### 5.3.1 Drawing Budget

The main indicator declares `max_boxes_count=500`. Liquidity Zones caps at 200
and Imbalances at 60, and both delete every box on removal, so live drawings stay
bounded by the sum of the two caps. The invariant is the deletion, not the cap:
raising either past its budget would require raising the declaration too.

### 5.4 Imbalance Proximity for Signal

**Proximity is evaluated over the stored imbalances, not over the current bar's
pattern.** An earlier draft tested `bullishImbalance` — the flag for a gap
forming *right now* — against `high[2]`, which is two bars stale. That can only
ever report an imbalance on the bar it forms, so a stored gap that price walks
back into forty bars later registers nothing. With the lifecycle in 5.3 the
stored zones are available, so the Signal Engine is told when price actually
reaches one.

**Entry and fill are separate signals.** A gap is only a *fresh* entry when
untouched; once price has already been inside it, the same proximity is a fill,
not a new setup. Reporting both as `near*` would let the confluence score count
one gap twice.

```pine
bool nearImbalanceLong   = false   // approaching an untouched bullish gap below
bool nearImbalanceShort  = false   // approaching an untouched bearish gap above
bool inImbalanceLong     = false   // inside a touched bullish gap
bool inImbalanceShort    = false   // inside a touched bearish gap

imbProxATRMult = input.float(1.5, "Imbalance Proximity (x ATR)", minval=0.5, step=0.1, group="Imbalances")

if array.size(imbalances) > 0 and not na(atrChart)
    for i = 0 to array.size(imbalances) - 1
        ImbalanceZone ip = array.get(imbalances, i)

        bool inside = high >= ip.bottom and low <= ip.top
        bool near   = math.abs(close - math.avg(ip.top, ip.bottom)) <= atrChart * imbProxATRMult

        if inside
            if ip.bullish
                inImbalanceLong := true
            else
                inImbalanceShort := true
        else if near and na(ip.touchedBar)
            if ip.bullish
                nearImbalanceLong := true
            else
                nearImbalanceShort := true
```

### 5.5 Module Interface

| Output | Type | Meaning |
|--------|------|---------|
| `nearImbalanceLong` | bool | Price is approaching an **untouched** bullish gap below it |
| `nearImbalanceShort` | bool | Price is approaching an **untouched** bearish gap above it |
| `inImbalanceLong` | bool | Price is inside a **touched** bullish gap |
| `inImbalanceShort` | bool | Price is inside a **touched** bearish gap |
| `volumeConfirmed` | bool | Current volume exceeds its 20-bar average by 1.2x |

A bullish gap sits *below* price when it forms, and price returns upward into it.
That is why `nearImbalanceLong` reads a gap the price approaches from above —
the same demand/supply derivation used in Liquidity Zones, and for the same
reason: the side is derived from current position, not frozen at creation.

---

## 6. Module: Structure Break (BoS/ChoCh)

### 6.1 Concept

- **Break of Structure (BoS)**: Price breaks a previous swing high/low in the direction of the trend, confirming continuation.
- **Change of Character (ChoCh)**: Price breaks a swing point in the OPPOSITE direction, signaling a potential reversal.

### 6.2 Swing Point Tracking

We track swing highs and swing lows on the 1H timeframe using `ta.pivothigh()` and `ta.pivotlow()`:

```pine
// ─── Structure Detection on 1H ─────────────────────────────────────────────────
structPivotLen = input.int(5, "Structure Pivot Length", minval=3, group="Structure Break")
showStructureBreaks = input.bool(true, "Show Structure Breaks", group="Structure Break")
showSwingLevels    = input.bool(true, "Show Swing Levels",     group="Structure Break")

// Pivot fetch, prefixed sb_ for "structure break".
//
// The prefix is mandatory, not cosmetic. Liquidity Zones already declares
// h1_pivotHigh / h1_pivotLow at module scope, and the modules are concatenated
// into one script — reusing those names would be a duplicate declaration and a
// compile error. They could not be shared even if naming allowed it: this
// module uses structPivotLen (default 5) for structure, while Liquidity Zones
// uses pivotLenHigh/Low (default 10) for liquidity tiers. Different lengths
// describe different structure, so they must be different variables.
sb_pivotHigh = request.security(syminfo.tickerid, "60", ta.pivothigh(high, structPivotLen, structPivotLen), lookahead=barmerge.lookahead_off)
sb_pivotLow  = request.security(syminfo.tickerid, "60", ta.pivotlow(low,  structPivotLen, structPivotLen),  lookahead=barmerge.lookahead_off)
```

### 6.3 Swing State Management

```pine
// Persistent swing tracking
var float lastSwingHigh = na
var float lastSwingLow  = na
var float prevSwingHigh = na
var float prevSwingLow  = na
var int   lastSwingHighBar = na
var int   lastSwingLowBar  = na

// Structure state: 1 = bullish, -1 = bearish, 0 = neutral
var int marketStructure = 0

// Update swing highs. sb_ prefix required — see 6.2.
if not na(sb_pivotHigh)
    prevSwingHigh := lastSwingHigh
    lastSwingHigh := sb_pivotHigh
    lastSwingHighBar := bar_index

// Update swing lows
if not na(sb_pivotLow)
    prevSwingLow := lastSwingLow
    lastSwingLow := sb_pivotLow
    lastSwingLowBar := bar_index
```

**`prevSwingHigh` / `prevSwingLow` are currently dead state.** Nothing in this
module reads them, and neither does the Signal Engine. They are kept because a
Fractal-style structure variant would need them, but as written they are four
lines that do nothing — a reader should not assume they participate in the
current break logic. Delete them if that variant is not planned.

### 6.4 Break Detection

A structural break is a **cross** of the most recent opposite swing: the first
bar whose close is beyond the level, having previously been at or inside it.
Testing `close` rather than `high` / `low` means a wick through a level does not
count as a break. That is deliberate — a wick that is immediately rejected is
liquidity being taken, which is the Liquidity Zones module's job, not a
structural change. The two modules would otherwise report the same event.

**Breaks are classified, not enumerated.** An earlier draft exposed
`bullishBoS` and `bullishChoCh` as separate booleans, but ChoCh is BoS *plus* a
structure precondition — `marketStructure == -1 and close > lastSwingHigh` is
the BoS condition with one extra clause. They are nested, not independent, so
exporting both lets the Signal Engine count one break twice and inflate a
three-factor confluence score on a single factor. This is the same failure mode
already handled between proximity and sweep in Liquidity Zones, and between
approach and fill in Imbalance Detector.

The interface therefore exposes **what happened** and **whether it reversed**,
as two flags that are true together by design rather than two overlapping
break types:

```pine
// The break itself, and whether it flipped the structure.
bool breakUp        = false
bool breakDown      = false
bool structureFlipped = false   // true only when the break opposed prior structure

// A break is a cross: beyond the level now, not beyond it a bar ago.
bool crossedAbove = not na(lastSwingHigh) and close >  lastSwingHigh and close[1] <= lastSwingHigh
bool crossedBelow = not na(lastSwingLow)  and close <  lastSwingLow  and close[1] >= lastSwingLow

// Reversal is decided against the structure in force BEFORE this bar.
if crossedAbove
    breakUp := true
    structureFlipped := marketStructure == -1
    marketStructure := 1
if crossedBelow
    breakDown := true
    structureFlipped := marketStructure == 1
    marketStructure := -1
```

**Neutral structure is not a BoS.** With `marketStructure == 0` — no break seen
yet — the first break in either direction is a break, but not a *change* of
character, so `structureFlipped` stays false. A first break is the establishment
of structure, not a reversal of it.

A bullish and a bearish break cannot occur on the same bar: `crossedAbove` and
`crossedBelow` require `close` to be simultaneously above the last swing high
and below the last swing low, which is possible only if the last swing high is
below the last swing low — malformed structure, not a real ambiguity.

**Break levels are not reset after a break.** In a continuing trend the next
confirmed pivot raises the level, but price is already above it, so the cross
test's `close[1] <= level` arm is false and no further break fires until price
returns below the new level and crosses again. This is the conservative
behaviour structure-break detection is normally expected to have: one break per
swing, not one per bar. It is called out here because the alternative — clearing
the level after a break — would report a break on every close above a stale
threshold, and the choice belongs to the maintainer rather than to this module.

### 6.6 Rendering Structure Breaks

**Swing levels are persistent `var` lines, not a new line per bar.** An earlier
draft called `line.new()` whenever the last two swings were both non-na — true
on nearly every bar after the first two pivots. That draws hundreds of
overlapping horizontal lines, exhausts the `max_lines_count` budget shared with
the other modules, and produces a solid bar of colour rather than a readable
level. The line is created once and its right edge moved.

```pine
var line swingHighLine = na
var line swingLowLine  = na

// The line must be recreated when the LEVEL moves, not merely when its right
// edge is extended. Latching the price at creation and only extending means
// that when a new pivot confirms at a different price — the normal case in
// trending structure — `lastSwingHigh` moves to the new level while the line
// keeps drawing the old one. The chart would then show structure one level
// behind where breaks are actually measured, and nothing would reveal it.
if showSwingLevels
    if not na(lastSwingHigh)
        if na(swingHighLine) or lastSwingHigh != line.get_y1(swingHighLine)
            line.delete(swingHighLine)
            swingHighLine := line.new(lastSwingHighBar, lastSwingHigh, bar_index, lastSwingHigh,
                 color=color.new(color.red, 45), style=line.style_dashed, width=1)
        else
            line.set_xy2(swingHighLine, bar_index, lastSwingHigh)

    if not na(lastSwingLow)
        if na(swingLowLine) or lastSwingLow != line.get_y1(swingLowLine)
            line.delete(swingLowLine)
            swingLowLine := line.new(lastSwingLowBar, lastSwingLow, bar_index, lastSwingLow,
                 color=color.new(color.green, 45), style=line.style_dashed, width=1)
        else
            line.set_xy2(swingLowLine, bar_index, lastSwingLow)
else
    // Dropping the handles when the toggle is off means re-enabling starts
    // clean, and an input wired to nothing would read as a broken script.
    if not na(swingHighLine)
        line.delete(swingHighLine)
        swingHighLine := na
    if not na(swingLowLine)
        line.delete(swingLowLine)
        swingLowLine := na
```

**Break markers** are one label per break, which is inherently rare:

```pine
if breakUp and showStructureBreaks
    label.new(bar_index, low, structureFlipped ? "ChoCh ▲" : "BoS ▲",
         style=label.style_label_up, color=color.new(color.green, 30),
         textcolor=color.white, size=size.normal)

if breakDown and showStructureBreaks
    label.new(bar_index, high, structureFlipped ? "ChoCh ▼" : "BoS ▼",
         style=label.style_label_down, color=color.new(color.red, 30),
         textcolor=color.white, size=size.normal)
```

### 6.7 Module Interface

| Output | Type | Meaning |
|--------|------|---------|
| `breakUp` | bool | Price crossed above the last confirmed 1H swing high this bar |
| `breakDown` | bool | Price crossed below the last confirmed 1H swing low this bar |
| `structureFlipped` | bool | That break opposed the structure in force, so it is a ChoCh rather than a BoS |
| `marketStructure` | int | `1` bullish, `-1` bearish, `0` not yet established |

`marketStructure` is a `var` and therefore persists across bars; the other three
are recomputed each bar. A consumer that needs "structure turned bullish" should
test `breakUp and structureFlipped` — **not** a separate `bullishChoCh` boolean,
which would be true whenever `breakUp` is true in a downtrend and would
double-count the event.

### 6.8 Drawing Budget

The main indicator declares `max_lines_count=500`, shared with Session Markers'
boundary lines. Structure Break draws exactly **two** swing lines for its whole
lifetime plus one label per break, so it is not a meaningful consumer of the
budget — provided the lines are `var`-persistent as above. Reverting to
per-bar `line.new` would make it the largest consumer instead.

---

## 7. Module: Signal Engine

### 7.1 Concept

The signal engine is the **confluence evaluator**. It takes outputs from the other three modules and determines whether all factors align to produce a LONG or SHORT signal.

### 7.2 Confluence Rules

A signal requires **all three factors to agree**. Each factor contributes a
single boolean, and **no factor may contribute two**.

```
LONG  = nearLiquidityLong AND sessionAligned AND structureUp
SHORT = nearLiquidityShort AND sessionAligned AND structureDown
```

where `structureUp` is `breakUp` — not `breakUp OR bullishChoCh`, because
Structure Break exposes one break flag plus `structureFlipped` precisely so that
a single structural event cannot be counted as two confluences. The earlier
form `(bullishImbalance OR bullishBoS OR bullishChoCh)` was doubly defective:
`bullishBoS` and `bullishChoCh` are nested rather than independent, so a
reversal break satisfied two terms of the same factor.

**Each module has already made its own two signals mutually exclusive**, which is
why the engine can treat them as simple conjunctions:

| Module | Exclusive pair | Why |
|---|---|---|
| Liquidity Zones | `nearLiquidity*` vs `swept*` | Proximity requires the bar range outside the zone body |
| Imbalance Detector | `nearImbalance*` vs `inImbalance*` | A gap is a fresh entry only while untouched |
| Structure Break | `breakUp`/`breakDown` vs `structureFlipped` | The flip is a property of the break, not a second break |

This is the single most important invariant in the indicator. A confluence
score that can count one event twice will fire on setups where only one factor
is present, which is precisely the false-positive class the whole design exists
to avoid.

### 7.3 Confidence Scoring

Not all signals are equal. **Two scores are computed, one per direction**, and
each is compared only against its own signal.

This is the single largest correctness constraint in the module. An earlier
draft computed **one** `confidenceScore` shared by both signals, from inputs
that do not know which direction is being scored. A LONG signal would earn
liquidity points for a nearby D1 zone *above* price, structure points for a
bearish break, and imbalance points for a bearish gap. The score would praise
the setup for reasons that contradict the signal it was gating.

### 7.3.1 Weights

| Factor | Condition | Points |
|--------|-----------|--------|
| **Liquidity** | Near D1 zone, same side | 30 |
| | Near 4H zone, same side | 20 |
| | Near 1H zone, same side | 10 |
| **Session** | In overlap (Lon+NY) | 25 |
| | In London or NY | 15 |
| | In Asia | 5 |
| **Structure** | Reversal break, same side | 30 |
| | Continuation break, same side | 20 |
| **Imbalance** | Same-side gap approach or fill | 15 |
| **Volume** | Volume above its average | 10 |

**The maximum is 110, not 100.** An earlier draft documented the score as 0–100,
which made "confidence" read as a percentage that the arithmetic cannot produce.
Calling it a score, and bounding the threshold at 110, is honest. Renormalising
to 100 would only move the number without changing any behaviour.

**These weights are a trading judgement, not a derived quantity.** Nothing in the
code can tell you whether a reversal deserves 1.5× a continuation for your risk
profile. That calibration is the maintainer's, made against real data.

### 7.3.2 Session Factor

`sessionScore` **does not exist.** The Session Markers module exports
`sessionStrength` (int, 0–8, additive across sessions) and `sessionMultiplier`
(float, 0.3–1.5). An earlier draft of this section referenced a `sessionScore`
described in section 4 but never implemented, which is an undefined identifier
and a compile error. The implementation uses the actual export.

```pine
// Session strength, as the module actually exports it: 0 none, 1 Asia,
// 2 London, 2 NY, +3 when the London/NY overlap is active.
sessionOK = sessionStrength >= 2
```

`sessionStrength >= 2` means a single active major session or better, which is
the intended "session is worth trading in" test.

### 7.3.3 Scoring

```pine
// Directional tier weight. The `else if` chain is correct here: only the
// highest tier nearby counts, so a D1 zone is not also counted as a 4H one.
f_liquidityWeight(bool d1, bool h4, bool h1) =>
    d1 ? 30 : h4 ? 20 : h1 ? 10 : 0

int longScore  = 0
int shortScore = 0

// Liquidity — per side, using the per-side tier flags.
longScore  += f_liquidityWeight(nearD1LiquidityLong,  nearH4LiquidityLong,  nearH1LiquidityLong)
shortScore += f_liquidityWeight(nearD1LiquidityShort, nearH4LiquidityShort, nearH1LiquidityShort)

// Session — direction-neutral, so both scores see it.
int sessionPoints = inOverlap ? 25 : inLondon or inNY ? 15 : inAsia ? 5 : 0
longScore  += sessionPoints
shortScore += sessionPoints

// Structure — the reversal weight REPLACES the base, it does not add. An
// earlier draft awarded +20 for any break and a further +30 for a ChoCh; since
// ChoCh is a subset of BoS, every reversal scored 50 for one event.
if breakUp
    longScore += structureFlipped ? 30 : 20
if breakDown
    shortScore += structureFlipped ? 30 : 20

// Imbalance — same side only.
if nearImbalanceLong or inImbalanceLong
    longScore += 15
if nearImbalanceShort or inImbalanceShort
    shortScore += 15

// Volume — confirms a direction without implying one, so it scores both.
if volumeConfirmed
    longScore  += 10
    shortScore += 10
```

### 7.4 Signal Thresholds

```pine
minConfidence = input.int(70, "Minimum Confidence Score", minval=0, maxval=110, group="Signal Engine")

// LONG: liquidity on the long side, a tradable session, a long-direction
// confirmation, and the long score above threshold. Cooldown applied in 7.5.
bool longSignal  = nearLiquidityLong  and sessionOK and
                   (breakUp or nearImbalanceLong or inImbalanceLong) and
                   longScore >= minConfidence

// SHORT: the mirror image.
bool shortSignal = nearLiquidityShort and sessionOK and
                   (breakDown or nearImbalanceShort or inImbalanceShort) and
                   shortScore >= minConfidence
```

Each score is gated by its own signal, so a setup can never be admitted by the
strength of the opposite direction.

### 7.4.1 Directional Exclusivity

**LONG and SHORT are not mutually exclusive, and that is a defect to fix rather
than a property to rely on.** A setup with an H4 zone below *and* an H4 zone
above, untouched gaps on both sides, in the London/NY overlap, on elevated
volume, scores `20 + 25 + 15 + 10 = 70` on **both** sides simultaneously — which
clears the default threshold twice on the same bar. Without an explicit rule the
indicator would print a LONG label, a SHORT label, two `alert()` calls and two
`alertcondition()` fires on one bar.

**Structure is the tiebreaker, not the score.** A sandwiched setup is not two
opportunities, it is one ambiguous one, and the only thing that resolves it is
which way structure already leans. `marketStructure` exists precisely to answer
that and nothing consumed it until now.

| Both sides qualify | Emitted |
|---|---|
| `marketStructure == 1` (bullish) | LONG only |
| `marketStructure == -1` (bearish) | SHORT only |
| `marketStructure == 0` (unestablished) | **Neither** |
| Only one side qualifies | that side, structure irrelevant |

A tie with no structure carries no directional information at all, so it is
**dropped rather than resolved arbitrarily**. Forcing a side there would
manufacture a direction out of nothing, which is precisely what the confluence
rule exists to prevent.

```pine
bool longSignalRaw  = nearLiquidityLong  and sessionOK and
                      (breakUp or nearImbalanceLong or inImbalanceLong) and
                      longScore  >= minConfidence

bool shortSignalRaw = nearLiquidityShort and sessionOK and
                      (breakDown or nearImbalanceShort or inImbalanceShort) and
                      shortScore >= minConfidence

bool longSignal  = longSignalRaw  and not (shortSignalRaw and marketStructure != 1)
bool shortSignal = shortSignalRaw and not (longSignalRaw  and marketStructure != -1)

// A tie with no structure carries no directional information, so it is dropped.
bool ambiguousTie = longSignalRaw and shortSignalRaw and marketStructure == 0
```

This completes the invariant the whole design rests on. Each factor is
directionally coherent, each signal is scored only by its own inputs, and the two
signals can never coexist on one bar.

**Ordering note:** the cooldown must be evaluated *before* the signals reference
it. In 7.4 below the signals are written without the cooldown term, and 7.5
applies it — so the declaration order in the module is: scores, exclusivity,
cooldown, then the fired flags. A signal written with `and not inCooldown`
before `inCooldown` exists is an undefined identifier, and the same is true of
`lastSignalBar`.

### 7.5 Signal Cooldown

To prevent signal spam, we enforce a cooldown period:

```pine
signalCooldownBars = input.int(10, "Signal Cooldown (bars)", minval=1, group="Signal Engine")

var int lastSignalBar = na
bool inCooldown = not na(lastSignalBar) and (bar_index - lastSignalBar) < signalCooldownBars

if longSignal and not inCooldown
    lastSignalBar := bar_index
    // ... emit signal
```

### 7.6 Visual Output

```pine
// ─── Signal Labels ─────────────────────────────────────────────────────────────
if longSignal and not inCooldown
    // bar_index, not barIndex — see the note on the SHORT label below.
    label.new(bar_index, low - atrChart * 0.5,
      "LONG\nScore: " + str.tostring(longScore) + "/110",
      style=label.style_label_up,
      color=color.new(color.green, 20),
      textcolor=color.white,
      size=size.normal,
      yloc=yloc.belowbar)
    
    // Alert
    alert("LiquidityFlowAuse LONG signal on " + syminfo.ticker + " | Score: " + str.tostring(longScore) + "/110", alert.freq_once_per_bar_close)

if shortSignal and not inCooldown
    // bar_index, not barIndex — the latter is a TradingView alert placeholder
    // variable that does not exist in script scope. The label offset uses
    // atrChart, the entry-timeframe ATR, and is expressed in ATRs so the label
    // sits the same visual distance away regardless of price scale.
    label.new(bar_index, high + atrChart * 0.5,
      "SHORT\nScore: " + str.tostring(shortScore) + "/110",
      style=label.style_label_down,
      color=color.new(color.red, 20),
      textcolor=color.white,
      size=size.normal,
      yloc=yloc.abovebar)

    // Alert
    alert("LiquidityFlowAuse SHORT signal on " + syminfo.ticker + " | Score: " + str.tostring(shortScore) + "/110", alert.freq_once_per_bar_close)
```

### 7.7 Signal Engine Flow Diagram

```
┌──────────────────────────────────────────────────────────┐
│                    SIGNAL ENGINE                          │
│                                                          │
│  Liquidity Zones ──► nearLiquidityLong/Short ──────┐     │
│                                                    │     │
│  Session Markers ───► sessionStrength >= 2 ──────────┤     │
│                                                    │     │
│  Imbalance Detector ─► imbalance detected ────────┤     │
│                                                    ├──► Confluence Check ──► LONG/SHORT
│  Structure Break ─────► BoS/ChoCh aligned ────────┤     │
│                                                    │     │
│  Confidence Score ────► >= minConfidence? ────────┘     │
│                                                          │
│  Cooldown Check ──────► inCooldown? ──► Skip if true    │
│                                                          │
│  Output: Label + Alert + Optional sound notification     │
└──────────────────────────────────────────────────────────┘
```

---

## 8. User Inputs

### 8.1 Complete Input Reference

```pine
//@version=5
indicator("LiquidityFlowAuse v1.0", overlay=true, max_labels_count=500, max_lines_count=500, max_boxes_count=500)

// ═══════════════════════════════════════════════════════════════════════════════
// GROUP: General
// ═══════════════════════════════════════════════════════════════════════════════
showD1Zones      = input.bool(true,  "Show D1 Liquidity Zones",  group="General")
showH4Zones      = input.bool(true,  "Show 4H Liquidity Zones",  group="General")
showH1Zones      = input.bool(true,  "Show 1H Liquidity Zones",  group="General")
showImbalances   = input.bool(true,  "Show Imbalances",          group="General")
showStructureBreaks = input.bool(true,  "Show Structure Breaks",    group="Structure Break")
showSessions     = input.bool(true,  "Show Session Markers",     group="General")
showSignals      = input.bool(true,  "Show Signal Labels",       group="General")

// ═══════════════════════════════════════════════════════════════════════════════
// GROUP: Liquidity Zones
// ═══════════════════════════════════════════════════════════════════════════════
pivotLenHigh     = input.int(10,  "Pivot Length (High)",        minval=3,   group="Liquidity Zones")
pivotLenLow      = input.int(10,  "Pivot Length (Low)",         minval=3,   group="Liquidity Zones")
zoneATRMult      = input.float(0.5, "Zone Width (× ATR)",       minval=0.1, step=0.1, group="Liquidity Zones")
maxZoneAge       = input.int(500, "Max Zone Age (bars)",        minval=50,  group="Liquidity Zones")
maxZoneDistance  = input.float(15.0, "Max Zone Distance (× ATR)", minval=5.0, group="Liquidity Zones")
zoneProximityATR = input.float(3.0, "Zone Proximity (× ATR)",   minval=1.0, step=0.5, group="Liquidity Zones")

// ═══════════════════════════════════════════════════════════════════════════════
// GROUP: Sessions
// ═══════════════════════════════════════════════════════════════════════════════
sessionAsiaEnabled  = input.bool(true,  "Show Asia Session",     group="Sessions")
sessionLondonEnabled = input.bool(true,  "Show London Session",   group="Sessions")
sessionNYEnabled     = input.bool(true,  "Show New York Session", group="Sessions")
showOverlapOnly      = input.bool(false, "Highlight Overlap Only", group="Sessions")
sessionTimezone      = input.string("exchange", "Session Timezone", 
                     options=["exchange", "UTC", "America/New_York", "Europe/London", "Asia/Tokyo"], 
                     group="Sessions")
// Session windows use input.session(), not input.time() — see section 4.3.
asiaSession   = input.session("0000-0900", "Asia Session",   group="Sessions")
londonSession = input.session("0700-1600", "London Session", group="Sessions")
nySession     = input.session("1300-2200", "New York Session", group="Sessions")

// ═══════════════════════════════════════════════════════════════════════════════
// GROUP: Imbalances
// ═══════════════════════════════════════════════════════════════════════════════
imbalanceThreshold = input.float(1.0, "Imbalance Min Size (× ATR)", minval=0.1, group="Imbalances")
showVolumeDelta    = input.bool(true, "Show Volume Delta",           group="Imbalances")
volumeThreshold    = input.float(1.2, "Volume Confirmation (× SMA)", minval=1.0, step=0.1, group="Imbalances")

// ═══════════════════════════════════════════════════════════════════════════════
// GROUP: Structure Break
// ═══════════════════════════════════════════════════════════════════════════════
structPivotLen = input.int(5, "Structure Pivot Length", minval=3, group="Structure Break")
// ChoCh and BoS are NOT separate toggles. They are two states of one event, so
// separate switches would invite reintroducing the parallel flags the module
// design exists to prevent. Section 6.2's single `showStructureBreaks` governs
// both, and the label printed on the marker says which one fired.

// ═══════════════════════════════════════════════════════════════════════════════
// GROUP: Signal Engine
// ═══════════════════════════════════════════════════════════════════════════════
minConfidence     = input.int(70,  "Minimum Confidence Score", minval=0, maxval=110, group="Signal Engine")
signalCooldownBars = input.int(10,  "Signal Cooldown (bars)",   minval=1,                   group="Signal Engine")
enableLongSignals = input.bool(true,  "Enable LONG Signals",    group="Signal Engine")
enableShortSignals = input.bool(true, "Enable SHORT Signals",   group="Signal Engine")

// ═══════════════════════════════════════════════════════════════════════════════
// GROUP: Visual
// ═══════════════════════════════════════════════════════════════════════════════
bullZoneColor   = input.color(color.new(color.green, 70), "Bullish Zone Color",  group="Visual")
bearZoneColor   = input.color(color.new(color.red, 70),   "Bearish Zone Color",  group="Visual")
imbBullColor    = input.color(color.new(color.green, 85), "Bullish Imbalance Color", group="Visual")
imbBearColor    = input.color(color.new(color.red, 85),   "Bearish Imbalance Color", group="Visual")
signalBullColor = input.color(color.new(color.green, 20), "LONG Signal Color",   group="Visual")
signalBearColor = input.color(color.new(color.red, 20),   "SHORT Signal Color",  group="Visual")
labelSize       = input.string("Normal", "Label Size", options=["Tiny", "Small", "Normal", "Large"], group="Visual")
```

### 8.2 Input Summary Table

| Parameter | Type | Default | Range | Purpose |
|-----------|------|---------|-------|---------|
| `showD1Zones` | bool | true | — | Toggle D1 zone rendering |
| `pivotLenHigh` | int | 10 | 3–50 | Pivot detection sensitivity (highs) |
| `zoneATRMult` | float | 0.5 | 0.1–3.0 | Liquidity zone width |
| `maxZoneAge` | int | 500 | 50–2000 | How long zones persist |
| `sessionTimezone` | string | "exchange" | — | Timezone for session detection |
| `imbalanceThreshold` | float | 1.0 | 0.1–5.0 | Minimum imbalance size |
| `structPivotLen` | int | 5 | 3–20 | Structure swing sensitivity |
| `minConfidence` | int | 60 | 0–100 | Signal quality threshold |
| `signalCooldown` | int | 10 | 1–100 | Bars between signals |
| `labelSize` | string | "Normal" | — | Signal label size |

---

## 9. Visual Design

### 9.1 Color Scheme

The indicator uses a **dark-theme-optimized** palette with sufficient contrast:

| Element | Color | Opacity | Usage |
|---------|-------|---------|-------|
| Bullish Liquidity Zone | `#00C853` (Green) | 30% bg, 70% border | Buy-side liquidity |
| Bearish Liquidity Zone | `#FF1744` (Red) | 30% bg, 70% border | Sell-side liquidity |
| Bullish Imbalance | `#00E676` (Light Green) | 85% bg | Fair value gap (buy) |
| Bearish Imbalance | `#FF5252` (Light Red) | 85% bg | Fair value gap (sell) |
| D1 Zone Border | Dashed | — | Major tier distinction |
| 4H Zone Border | Dash-dot | — | Intermediate tier |
| 1H Zone Border | Solid | — | Local tier |
| Session: Asia | `#9C27B0` (Purple) | 96% bg | Background tint |
| Session: London | `#2196F3` (Blue) | 94% bg | Background tint |
| Session: New York | `#FF9800` (Orange) | 94% bg | Background tint |
| Session: Overlap | `#FFEB3B` (Yellow) | 92% bg | Background tint |
| LONG Signal Label | `#00C853` | 20% bg | Below bar |
| SHORT Signal Label | `#FF1744` | 20% bg | Above bar |
| BoS Marker | Green/Red | 30% bg | At swing point |
| ChoCh Marker | Green/Red | 20% bg | At reversal point |

### 9.2 Drawing Types

| Visual Element | Pine Script Function | Parameters |
|----------------|---------------------|------------|
| Liquidity Zones | `box.new()` | `border_style=line.style_dashed`, tier-dependent width |
| Session Backgrounds | `bgcolor()` | Full-chart background tint |
| Session Boundaries | `line.new()` | `style=line.style_dotted`, width=1 |
| Imbalances | `box.new()` | `border_width=1`, tight fit to gap |
| Structure Lines | `line.new()` | Connect swing points, `width=1` |
| Signal Labels | `label.new()` | `yloc.belowbar` / `yloc.abovebar` |
| Confidence Score | Embedded in label text | `"Score: XX/110"` |

### 9.3 Chart Annotations

```
┌─────────────────────────────────────────────────────────────────┐
│  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  │  ← D1 Zone (dashed)
│                                                                 │
│         ┌─────────────┐                                        │
│         │    LONG     │  ← Signal label (green, below bar)    │
│         │  Score: 75/110 │                                        │
│         └─────────────┘                                        │
│              ▲                                                 │
│              │                                                 │
│  ════════════╧════════════════════════════════════════════    │  ← BoS line
│                                                                 │
│         ░░░░░░░░░░░                                           │  ← Imbalance (shaded)
│                                                                 │
│  ───────────────────────────────────────────────────────────   │  ← Session boundary
│  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  │  ← Session bg tint
└─────────────────────────────────────────────────────────────────┘
```

---

## 10. Alert System

### 10.1 Alert Conditions

| Condition Name | Trigger | Frequency |
|---------------|---------|-----------|
| `LF_LongSignal` | All 3 factors align bullish + confidence >= threshold | Once per bar close |
| `LF_ShortSignal` | All 3 factors align bearish + confidence >= threshold | Once per bar close |
| `LF_BullishBoS` | Bullish Break of Structure detected | Once per bar close |
| `LF_BearishBoS` | Bearish Break of Structure detected | Once per bar close |
| `LF_BullishChoCh` | Bullish Change of Character detected | Once per bar close |
| `LF_BearishChoCh` | Bearish Change of Character detected | Once per bar close |
| `LF_LiquidityTest` | Price enters a D1 liquidity zone | Once per bar close |
| `LF_OverlapStart` | London + NY overlap begins | Once per bar |

### 10.2 Alert Implementation

```pine
// ─── Alert Conditions ─────────────────────────────────────────────────────────
//
// Gated on the FIRED flags, not on raw longSignal / shortSignal. Raw signals
// are true on every bar the confluence holds; gating the cooldown at the
// alertcondition would re-introduce the spam the cooldown exists to prevent.
//
// The message CANNOT carry the score. An alertcondition's message must be a
// const string, and `{{close}}` is a PRICE, not a score — the earlier draft
// printed the bar close under a label reading "Score". The score is delivered
// by the `alert()` calls in 7.6, whose message is a series string and can
// therefore interpolate it. Alert names are unchanged: they are the
// user-facing identifiers anyone has already configured in TradingView.
alertcondition(longSignalFired,  "LF_LongSignal",  "LONG signal on {{ticker}}")
alertcondition(shortSignalFired, "LF_ShortSignal", "SHORT signal on {{ticker}}")
// Alert names are unchanged — they are the user-facing identifiers anyone
// already configured in TradingView. Only the conditions change, and the ChoCh
// variants now add structureFlipped so they are genuinely distinct from BoS.
alertcondition(breakUp and not structureFlipped, "LF_BullishBoS",   "Bullish BoS on {{ticker}}")
alertcondition(breakDown and not structureFlipped, "LF_BearishBoS", "Bearish BoS on {{ticker}}")
alertcondition(breakUp and structureFlipped,   "LF_BullishChoCh",   "Bullish ChoCh on {{ticker}}")
alertcondition(breakDown and structureFlipped, "LF_BearishChoCh",   "Bearish ChoCh on {{ticker}}")

// Liquidity zone approach and sweep alerts.
// Approach fires on the transition INTO proximity. An earlier draft read
// array.get(zonePrices, 0) — the OLDEST zone in the array, unrelated to
// whatever price was approaching, and an out-of-bounds read when empty.
// Sweep fires on the bar liquidity is actually taken, which is the event the
// indicator's thesis is built around.
bool liquidityTestLong  = nearLiquidityLong  and not nearLiquidityLong[1]
bool liquidityTestShort = nearLiquidityShort and not nearLiquidityShort[1]
bool liquiditySweepLong  = sweptLong  and not sweptLong[1]
bool liquiditySweepShort = sweptShort and not sweptShort[1]
alertcondition(liquidityTestLong,   "LF_LiquidityTest",  "Price approaching LONG liquidity on {{ticker}}")
alertcondition(liquidityTestShort,  "LF_LiquidityTest",  "Price approaching SHORT liquidity on {{ticker}}")
alertcondition(liquiditySweepLong,  "LF_LiquiditySweep", "LONG liquidity swept on {{ticker}}")
alertcondition(liquiditySweepShort, "LF_LiquiditySweep", "SHORT liquidity swept on {{ticker}}")

// Session overlap alert
alertcondition(ta.change(inOverlap) and inOverlap, "LF_OverlapStart", "London+NY overlap started on {{ticker}}")
```

### 10.3 Alert Message Format

```
LiquidityFlowAuse LONG signal on BTCUSDT (Binance)
Score: 75/110 | Session: London+NY Overlap | Structure: Bullish ChoCh
Liquidity: D1 pivot low @ $64,200 | Imbalance: Bullish FVG confirmed
```

### 10.4 Webhook Integration

For external automation (Discord, Telegram, trading bots):

```pine
// JSON payload for webhook (used with external alert bridges)
if longSignal
    alertMessage = '{"indicator":"LiquidityFlowAuse","signal":"LONG","symbol":"' + syminfo.ticker + 
                   '","score":' + str.tostring(longScore) + 
                   ',"price":' + str.tostring(close) + 
                   ',"structure":"' + (breakUp and structureFlipped ? "ChoCh" : breakUp or breakDown ? "BoS" : "Imbalance") + '"}'
    alert(alertMessage, alert.freq_once_per_bar_close)
```

---

## 11. Limitations & Risk Disclaimer

### 11.1 What This Indicator CANNOT Do

| Limitation | Explanation |
|------------|-------------|
| **Cannot predict the future** | All signals are based on historical price action and pattern recognition |
| **Cannot account for news events** | Black swan events, exchange hacks, regulatory announcements override all technical patterns |
| **Cannot guarantee confluence** | The 3-factor model reduces but does not eliminate false signals |
| **Cannot adapt to regime changes** | A ranging market will produce different signal quality than a trending market |
| **Cannot replace risk management** | Position sizing, stop-losses, and take-profit levels are the trader's responsibility |
| **Cannot see order book depth** | Liquidity zones are inferred from price action, not actual order book data |
| **Cannot work on all timeframes** | Designed for 5min entry / 1H structure / 4H context / D1 macro only |
| **Cannot detect spoofing/fake liquidity** | Manipulated stop-loss hunts will trigger false signals |

### 11.2 Known Edge Cases

1. **Weekend crypto volatility**: Reduced weekend liquidity can trigger false liquidity sweeps
2. **Low-cap altcoins**: Thin order books make liquidity zone detection unreliable
3. **News-driven gaps**: Overnight gaps may skip entire liquidity zones
4. **Sideways/choppy markets**: Multiple false BoS/ChoCh signals in ranging conditions
5. **Repainting risk**: While we use `[1]` offsets, intra-bar visuals will fluctuate

### 11.3 Risk Disclaimer

> **THIS INDICATOR IS FOR EDUCATIONAL PURPOSES ONLY.**
> 
> Trading cryptocurrency involves substantial risk of loss. Past performance is not indicative of future results. The author and contributors of LiquidityFlowAuse are not registered financial advisors and do not provide investment advice.
> 
> **Never trade with money you cannot afford to lose.**
> 
> Always use proper risk management:
> - Never risk more than 1–2% of your account on a single trade
> - Always use a stop-loss
> - Backtest any strategy before live trading
> - Paper trade for at least 2 weeks before using real capital
> 
> By using this indicator, you acknowledge that you understand these risks and accept full responsibility for your trading decisions.

---

## 12. File Structure

### 12.1 Repository Layout

```
liquidityflowause-indicator/
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.yml
│   │   └── feature_request.yml
│   ├── workflows/
│   │   └── pine-validator.yml        # CI: validate Pine Script syntax
│   └── PULL_REQUEST_TEMPLATE.md
├── docs/
│   ├── technical-spec.md             # This document
│   ├── user-guide.md                 # How to use the indicator
│   ├── signal-examples.md            # Annotated chart examples
│   └── changelog.md                  # Version history
├── src/
│   ├── liquidityflowause.pine        # Main indicator (single file)
│   ├── modules/
│   │   ├── liquidity-zones.pine      # Liquidity zone detection
│   │   ├── session-markers.pine      # Session detection & rendering
│   │   ├── imbalance-detector.pine   # Imbalance & volume delta
│   │   ├── structure-break.pine      # BoS/ChoCh detection
│   │   └── signal-engine.pine        # Confluence & signal output
│   └── lib/
│       ├── colors.pine              # Color constants & theme
│       ├── utils.pine               # Shared utility functions
│       └── inputs.pine              # All input declarations
├── tests/
│   ├── backtest-results.md          # Documented backtest performance
│   ├── signal-accuracy.md           # Signal hit-rate analysis
│   └── test-cases/                  # Specific chart test scenarios
│       ├── btc-2024-bull-run.md
│       ├── eth-range-bound.md
│       └── low-cap-altcoin.md
├── scripts/
│   ├── build.mjs                     # Concatenate modules + structural checks
│   ├── validate-pine.py              # Pine Script syntax checker
│   └── export-data.py                # Export indicator data for testing
├── dist/                             # Build output (gitignored)
├── LICENSE                           # MIT License
├── README.md                         # Project overview & quick start
├── CHANGELOG.md                      # Version history
└── CONTRIBUTING.md                   # How to contribute
```

### 12.2 Single-File vs. Modular

**Production release** is a **single `.pine` file** (TradingView requirement). The modular structure in `src/modules/` serves as:

1. **Development reference** — each module can be developed and tested independently
2. **Documentation** — code organization mirrors this spec's module structure
3. **Build input** — a build script can concatenate modules into the final single file

### 12.3 Build Process

Modules are concatenated **into** the main indicator file, not appended after
it. The order is semantic and cannot be rearranged.

**Why the main file comes first:** Pine v5 requires `//@version=5` to precede all
code, and `indicator()` / `study()` to be the first statement in the script. The
`input.*` family is only legal *inside* a declared script. Concatenating modules
ahead of the main file therefore cannot compile, regardless of platform.

The main file exposes a `[CONCATENATION POINT]` marker comment; the build splices
each module in at that marker, so the header (`//@version=5` + `indicator()`)
stays first and module code lands beneath it.

**Declaration order within the modules:** Pine v5 has no forward declarations.
Every input, constant, and function must be declared before its first use, which
fixes the order below.

```bash
# Build the distributable single file, then run structural checks.
node scripts/build.mjs

# Validate only; write nothing.
node scripts/build.mjs --check
```

Output: `dist/liquidityflowause.pine` — paste into the TradingView Pine Editor.
`dist/` is gitignored; the file is regenerated, never edited by hand.

**Source order** (encoded in the `SOURCES` list in `scripts/build.mjs`):

| # | Source | Role |
|---|--------|------|
| 1 | `src/liquidityflowause.pine` | `//@version=5` + `indicator()` + header |
| 2 | `src/lib/colors.pine` | Color constants |
| 3 | `src/lib/utils.pine` | Shared utility functions |
| 4 | `src/lib/inputs.pine` | All input declarations |
| 5 | `src/modules/liquidity-zones.pine` | Liquidity zone detection |
| 6 | `src/modules/session-markers.pine` | Session detection & rendering |
| 7 | `src/modules/imbalance-detector.pine` | Imbalance & volume delta |
| 8 | `src/modules/structure-break.pine` | BoS/ChoCh detection |
| 9 | `src/modules/signal-engine.pine` | Confluence & signal output |

A source that does not exist yet is reported as a **warning**, not a failure, so
the project builds incrementally instead of waiting for the final module.

### 12.3.1 Structural Checks

`scripts/build.mjs` verifies what is decidable from the text alone. These are
**not** a Pine parser:

| Check | Failure condition |
|-------|-------------------|
| Version directive | Zero, or more than one, `//@version=` |
| Version placement | `//@version=` appears after the first statement |
| Script declaration | Zero, or more than one, `indicator()` / `study()` |
| Input legality | An `input.*` call precedes the script declaration |
| Module independence | A module file declares its own `indicator()` / `study()` |

Type errors, unknown builtins, and runtime behavior are **not** covered. Only the
TradingView Pine Editor verifies those.

### 12.3.2 Module Contract

A file under `src/modules/` is a **splice unit**, not a script. It must:

- contain no `//@version=` directive
- contain no `indicator()` or `study()` declaration
- expose its outputs as plain module-level variables, since Pine has no `export`
- declare only `input.*` calls, which is legal once spliced beneath `indicator()`

A module's decorative header banner is stripped during the build. The **whole
box** is removed, prose included — the module body carries its own section
comments, and the banner's description duplicates what this document already
says.

### 12.4 Versioning

- **Semantic Versioning**: `MAJOR.MINOR.PATCH`
  - `MAJOR`: Breaking changes to signal logic or input parameters
  - `MINOR`: New features, new modules, new visual elements
  - `PATCH`: Bug fixes, visual tweaks, documentation updates

---

## Appendix A: Glossary

| Term | Definition |
|------|-----------|
| **BoS** | Break of Structure — price breaks a swing point in trend direction |
| **ChoCh** | Change of Character — price breaks a swing point against trend direction |
| **FVG** | Fair Value Gap — 3-candle imbalance creating untraded price area |
| **Liquidity Cluster** | Area where stop-loss orders accumulate (pivot highs/lows) |
| **POC** | Point of Control — highest volume price level in a range |
| **Confluence** | Multiple independent factors aligning on the same signal |
| **Top-Down Analysis** | Analysis starting from higher timeframes down to lower ones |
| **ATR** | Average True Range — volatility measure used for zone sizing |
| **Volume Delta** | Net difference between buying and selling volume within a bar |

## Appendix B: Dependencies

| Dependency | Version | Purpose |
|-----------|---------|---------|
| Pine Script | v5 | Indicator language |
| TradingView Platform | Current | Charting & execution |
| `ta.*` library | Built-in | Technical analysis functions |
| `request.security()` | Built-in | Multi-timeframe data access |
| `array.*` | Built-in | Dynamic zone storage |

## Appendix C: Performance Considerations

- **Max bars**: The indicator uses `max_boxes_count=500`, `max_labels_count=500`, `max_lines_count=500` — users should increase these in settings for longer lookback
- **Zone pruning**: Zones older than `maxZoneAge` bars are automatically removed to prevent array overflow
- **Security calls**: 6 `request.security()` calls per bar — minimal overhead on modern browsers
- **Recommended chart limit**: 5,000 bars for optimal performance

---

---

## Appendix D: Advanced Recommendations

These 5 enhancements separate a professional indicator from an amateur one. Each is optional for v1.0 but recommended for v1.1+.

### D.1 Binary Confluence Scoring (No Percentages)

Replace the 0–100 confidence score with strict boolean flags. A signal either has all factors or it does not:

```pine
// ─── Binary Confluence Model ──────────────────────────────────────────────────
bool liquidityOK    = nearLiquidityLong or nearLiquidityShort
bool sessionOK      = sessionStrength >= 2
bool structureOK    = breakUp or breakDown or nearImbalanceLong or nearImbalanceShort

// LONG requires ALL three — no partial credit
bool longSignalStrict  = nearLiquidityLong  and sessionOK and
                         (breakUp or nearImbalanceLong or inImbalanceLong)

// SHORT requires ALL three — no partial credit
bool shortSignalStrict = nearLiquidityShort and sessionOK and
                         (breakDown or nearImbalanceShort or inImbalanceShort)
```

**Why:** Percentage scores imply that 60% confidence is "good enough." In trading, a missing factor means the setup is incomplete. Binary scoring forces discipline.

---

### D.2 Liquidity Zone Freshness Decay

Not all zones are equal. A zone tested 5 minutes ago is more relevant than one tested 3 days ago:

```pine
// ─── Zone Freshness Decay ─────────────────────────────────────────────────────
// Exponential decay since the sweep, carried on the zone record itself via
// sweptBar. The earlier draft used a third parallel array (zoneLastTested)
// alongside zonePrices and zoneTiers, all of which had to be mutated in
// lockstep, and removed entries without deleting the box — the same divergence
// between what is drawn and what the logic sees.
//
// This is an OPTIONAL refinement, not part of the core module. It supersedes
// sweptRetainBars: with decay enabled, a swept zone is culled by falling below
// the strength threshold rather than by a flat bar count.

zoneDecayFactor       = input.float(50.0, "Zone Decay Half-Life (bars)", minval=10.0, group="Liquidity Zones")
zoneStrengthThreshold = input.float(0.1,  "Min Zone Strength", minval=0.01, maxval=1.0, step=0.01, group="Liquidity Zones")
useDecayCulling       = input.bool(false, "Use Decay Instead Of Swept Retention", group="Liquidity Zones")

f_zoneStrength(int barsSinceSweep) =>
    math.exp(-barsSinceSweep / zoneDecayFactor)

if array.size(zones) > 0
    for i = array.size(zones) - 1 to 0
        LiquidityZone z = array.get(zones, i)

        // Only a swept zone can decay. An untouched zone has no sweep to measure
        // from, and must fall back to the flat age rule in 3.2.3.
        bool decayed = useDecayCulling and not na(z.sweptBar) and
                       f_zoneStrength(bar_index - z.sweptBar) < zoneStrengthThreshold

        if decayed
            box.delete(z.zoneBox)
            array.remove(zones, i)
```

**Why:** Stale zones clutter the chart and reduce signal quality. Fresh zones attract price; dead zones do not.

**Interaction with section 3.2.3.** Both loops walk the same `zones` array in the
same bar. Decay only ever applies to swept zones; untouched zones are governed
by the age and distance rules in 3.2.3, so the two do not compete for the same
zone. `useDecayCulling` selects between the flat `sweptRetainBars` and the
exponential curve — enabling both is not meaningful, so the flag replaces the
flat rule rather than adding to it.

---

### D.3 Spread Filter (Proxy via Candle Range)

In crypto scalping, the spread eats your profit. Block signals when spread is too wide:

```pine
// ─── Spread Filter ────────────────────────────────────────────────────────────
spreadFilterEnabled = input.bool(true, "Enable Spread Filter", group="Signal Engine")
maxSpreadPct        = input.float(0.02, "Max Spread (%)", minval=0.005, maxval=0.5, step=0.005, group="Signal Engine")

// Proxy: (high - low) / close as implicit spread/volatility measure
float candleRange = (high - low) / close
float avgRange    = ta.sma(candleRange, 20)

// Current spread estimate (normalized)
float spreadEstimate = candleRange / avgRange

// Block signals when spread is elevated
bool spreadOK = not spreadFilterEnabled or spreadEstimate < (maxSpreadPct / 0.01)

// Apply to signal conditions
longSignalStrict  := longSignalStrict  and spreadOK
shortSignalStrict := shortSignalStrict and spreadOK
```

**Why:** A 0.05% spread on a 1-2% target eats 2.5–5% of profit. Filtering high-spread periods protects small-capital accounts.

---

### D.4 Strategy Version for Backtesting

Include a `strategy` version so the community can backtest:

```pine
// ─── Strategy Variant (separate file: liquidityflowause-strategy.pine) ───────
//@version=5
strategy("LiquidityFlowAuse Strategy", overlay=true, 
         default_qty_type=strategy.percent_of_equity, 
         default_qty_value=10,
         commission_type=strategy.commission.percent,
         commission_value=0.05,
         slippage=2)

// ... (same indicator logic as above) ...

// Entry rules
if longSignalStrict and spreadOK
    strategy.entry("LONG", strategy.long, comment="LF Long")
    
if shortSignalStrict and spreadOK
    strategy.entry("SHORT", strategy.short, comment="LF Short")

// Exit rules (1-2% target)
float targetPct = input.float(1.5, "Target (%)", minval=0.5, maxval=5.0, group="Exit")
float stopPct   = input.float(0.8, "Stop Loss (%)", minval=0.3, maxval=2.0, group="Exit")

strategy.exit("Exit Long", "LONG", profit=targetPct, loss=stopPct)
strategy.exit("Exit Short", "SHORT", profit=targetPct, loss=stopPct)
```

**Why:** Open-source credibility requires verifiable results. A `strategy` file lets anyone validate signal quality.

---

### D.5 Context-Rich Alerts

Replace bare "LONG" alerts with full context so users know WHY the signal fired:

```pine
// ─── Context-Rich Alert Messages ─────────────────────────────────────────────
if longSignalStrict and not inCooldown
    string alertText = "LONG " + syminfo.ticker + "\n" +
                       "├── Liquidity: " + (nearD1Liquidity ? "D1 zone" : nearH4Liquidity ? "4H zone" : "1H zone") + "\n" +
                       "├── Session: " + (inOverlap ? "Lon+NY Overlap" : inLondon ? "London" : inNY ? "New York" : "Asia") + "\n" +
                       "├── Structure: " + (breakUp and structureFlipped ? "ChoCh" : breakUp or breakDown ? "BoS" : "Imbalance") + "\n" +
                       "├── Target: +" + str.tostring(targetPct, "#.##") + "%\n" +
                       "└── Stop: -" + str.tostring(stopPct, "#.##") + "%"
    
    alert(alertText, alert.freq_once_per_bar_close)

if shortSignalStrict and not inCooldown
    string alertText = "SHORT " + syminfo.ticker + "\n" +
                       "├── Liquidity: " + (nearD1Liquidity ? "D1 zone" : nearH4Liquidity ? "4H zone" : "1H zone") + "\n" +
                       "├── Session: " + (inOverlap ? "Lon+NY Overlap" : inLondon ? "London" : inNY ? "New York" : "Asia") + "\n" +
                       "├── Structure: " + (breakDown and structureFlipped ? "ChoCh" : breakUp or breakDown ? "BoS" : "Imbalance") + "\n" +
                       "├── Target: +" + str.tostring(targetPct, "#.##") + "%\n" +
                       "└── Stop: -" + str.tostring(stopPct, "#.##") + "%"
    
    alert(alertText, alert.freq_once_per_bar_close)
```

**Why:** Traders need to validate the setup, not just the direction. Context-rich alerts turn every signal into a learning opportunity.

---

*End of Technical Specification — LiquidityFlowAuse v1.0.0*

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
d1_pivotH  = request.security(syminfo.tickerid, "D", pivotHigh, lookahead=barmerge.lookahead_off)
d1_pivotL  = request.security(syminfo.tickerid, "D", pivotLow,  lookahead=barmerge.lookahead_off)

// 4H data — intermediate context
h4_close   = request.security(syminfo.tickerid, "240", close[1], lookahead=barmerge.lookahead_off)
h4_high    = request.security(syminfo.tickerid, "240", high[1],  lookahead=barmerge.lookahead_off)
h4_low     = request.security(syminfo.tickerid, "240", low[1],   lookahead=barmerge.lookahead_off)

// 1H data — structure breaks and local liquidity
h1_close   = request.security(syminfo.tickerid, "60", close[1],  lookahead=barmerge.lookahead_off)
h1_high    = request.security(syminfo.tickerid, "60", high[1],   lookahead=barmerge.lookahead_off)
h1_low     = request.security(syminfo.tickerid, "60", low[1],    lookahead=barmerge.lookahead_off)
```

**Key design decision:** We use `[1]` offset (previous confirmed bar) to avoid intra-bar repainting. The indicator refreshes on each tick for visual smoothness but only **confirms signals on bar close**.

### 2.3 State Management

Because Pine Script executes top-to-bottom on each bar, we use `var` to maintain persistent state across bars:

```pine
// Persistent state for liquidity zones
var box[]    liquidityZonesLong  = array.new_box()
var box[]    liquidityZonesShort = array.new_box()
var float[]  zonePrices          = array.new_float()
var int[]    zoneTiers            = array.new_int()  // 1=D1, 2:4H, 3:1H

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

We use Pine Script's built-in `ta.pivothigh()` and `ta.pivotlow()` to identify swing points on D1 and 4H:

```pine
// Pivot detection parameters
pivotLenHigh = input.int(10, "Pivot Length High", minval=3, group="Liquidity Zones")
pivotLenLow  = input.int(10, "Pivot Length Low",  minval=3, group="Liquidity Zones")

// On D1 timeframe (fetched via security)
d1_pivotHigh = request.security(syminfo.tickerid, "D", ta.pivothigh(high, pivotLenHigh, pivotLenHigh), lookahead=barmerge.lookahead_off)
d1_pivotLow  = request.security(syminfo.tickerid, "D", ta.pivotlow(low, pivotLenLow, pivotLenLow),   lookahead=barmerge.lookahead_off)

// On 4H timeframe
h4_pivotHigh = request.security(syminfo.tickerid, "240", ta.pivothigh(high, 8, 8), lookahead=barmerge.lookahead_off)
h4_pivotLow  = request.security(syminfo.tickerid, "240", ta.pivotlow(low, 8, 8),   lookahead=barmerge.lookahead_off)
```

#### 3.2.2 Zone Construction

When a pivot is confirmed, we construct a liquidity zone around it:

```pine
// Zone width as ATR multiple — ATR per timeframe for correct sizing
zoneATRMult = input.float(0.5, "Zone Width (× ATR)", minval=0.1, step=0.1, group="Liquidity Zones")
atrCurrent  = ta.atr(14)  // current timeframe ATR
atrD1       = request.security(syminfo.tickerid, "D", ta.atr(14)[1],  lookahead=barmerge.lookahead_off)
atrH1       = request.security(syminfo.tickerid, "60", ta.atr(14)[1], lookahead=barmerge.lookahead_off)

// Max zones to prevent array overflow
maxZones = input.int(50, "Max Zones", minval=10, maxval=200, group="Liquidity Zones")

// When a new D1 pivot high is confirmed
if not na(d1_pivotHigh)
    // Use D1 ATR for D1 zone sizing
    zoneTop    = d1_pivotHigh + atrD1 * zoneATRMult
    zoneBottom = d1_pivotHigh - atrD1 * zoneATRMult
    
    // Only add if under limit
    if array.size(zonePrices) < maxZones
        array.push(zonePrices, d1_pivotHigh)
        array.push(zoneTiers, 1)
    
    // Draw the zone box (only if enabled)
    if showD1Zones
        box.new(bar_index - 20, zoneTop, bar_index + 20, zoneBottom,
         border_color=color.new(color.red, 70), bgcolor=color.new(color.red, 90),
         border_style=line.style_dashed)
```

#### 3.2.3 Zone Hierarchy & Filtering

Not all zones are equal. We tier them by timeframe:

| Tier | Source | Visual Weight | Purpose |
|------|--------|---------------|---------|
| 1 (Highest) | D1 pivots | Thick dashed boxes, 30% opacity | Major liquidity — primary targets |
| 2 | 4H pivots | Medium boxes, 50% opacity | Intermediate — secondary targets |
| 3 | 1H pivots | Thin boxes, 70% opacity | Local — minor liquidity |

Zones are **culled** when:
- Price has tested the zone (wick entered the zone body)
- Zone is older than `maxZoneAgeBars` (default: 500 bars)
- Zone is too far from current price (beyond `maxZoneDistanceATR`)

```pine
// Zone lifecycle management
maxZoneAgeBars      = input.int(500, "Max Zone Age (bars)", minval=50, group="Liquidity Zones")
maxZoneDistanceATR  = input.float(15.0, "Max Zone Distance (× ATR)", minval=5.0, group="Liquidity Zones")

// Remove stale zones
if array.size(zonePrices) > 0
    for i = array.size(zonePrices) - 1 to 0
        zonePrice = array.get(zonePrices, i)
        if math.abs(close - zonePrice) > atrValue * maxZoneDistanceATR
            array.remove(zonePrices, i)
            array.remove(zoneTiers, i)
```

### 3.3 Proximity Check (Signal Input)

The signal engine needs to know if price is **near** a liquidity zone:

```pine
// Check if current price is within any liquidity zone
bool nearLiquidityLong  = false
bool nearLiquidityShort = false
bool nearD1Liquidity    = false
bool nearH4Liquidity    = false
bool nearH1Liquidity    = false

if array.size(zonePrices) > 0
    for i = 0 to array.size(zonePrices) - 1
        zonePrice = array.get(zonePrices, i)
        zoneTier = array.get(zoneTiers, i)
        // LONG liquidity = pivot lows below current price
        if zonePrice < close and math.abs(close - zonePrice) < atrValue * 3.0
            nearLiquidityLong := true
            if zoneTier == 1
                nearD1Liquidity := true
            else if zoneTier == 2
                nearH4Liquidity := true
            else
                nearH1Liquidity := true
        // SHORT liquidity = pivot highs above current price
        if zonePrice > close and math.abs(close - zonePrice) < atrValue * 3.0
            nearLiquidityShort := true
            if zoneTier == 1
                nearD1Liquidity := true
            else if zoneTier == 2
                nearH4Liquidity := true
            else
                nearH1Liquidity := true
```

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

// Session strength score (used by signal engine)
int sessionScore = 0
if inAsia
    sessionScore += 1
if inLondon
    sessionScore += 2
if inNY
    sessionScore += 2
if inOverlap
    sessionScore += 3  // Bonus for overlap
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

The signal engine uses session context to weight signal confidence (multiplier, not binary gate — crypto trades 24/7):

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

## 5. Module: Imbalance Detector

### 5.1 Concept

An **imbalance** (also called "fair value gap" or "inefficiency") occurs when price moves so aggressively that it leaves behind untraded price areas. These act as magnets — price often returns to fill them. Imbalances confirm that real aggressive buying/selling occurred.

### 5.2 Detection Algorithm

We detect two types of imbalances:

#### 5.2.1 Candle Body Imbalance (3-Candle Pattern)

A 3-candle imbalance forms when:
- **Bullish imbalance**: Candle 1 high < Candle 3 low (gap between candles 1 and 3)
- **Bearish imbalance**: Candle 1 low > Candle 3 high

```pine
// ─── Imbalance Detection ───────────────────────────────────────────────────────
imbalanceThreshold = input.float(1.0, "Imbalance Min Size (× ATR)", minval=0.1, group="Imbalances")

// 3-candle Fair Value Gap (FVG) — corrected pattern
// Bullish FVG: candle 1 high < candle 3 low (gap between candles 1 and 3, skip middle)
// This leaves untraded price area that price often returns to fill
bool bullishFVG = high[2] < low[1] and high[1] < low[0]
// Bearish FVG: candle 1 low > candle 3 high
bool bearishFVG = low[2] > high[1] and low[1] > high[0]

// Filter by minimum size (ATR-based)
float bullSize = low[1] - high[2]   // gap height for bullish
float bearSize = low[2] - high[1]   // gap height for bearish
bool validBull = bullSize > atrValue * imbalanceThreshold
bool validBear = bearSize > atrValue * imbalanceThreshold

bool bullishImbalance = bullishFVG and validBull
bool bearishImbalance = bearishFVG and validBear
```

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

### 5.3 Rendering Imbalances

Imbalances are drawn as **triangles or shaded rectangles** in the gap zone:

```pine
// Draw bullish imbalance zone
if bullishImbalance and showImbalances
    float imbTop = low[0]   // Current candle low
    float imbBottom = high[2]  // Candle 1 high (gap start)
    
    box.new(bar_index - 2, imbTop, bar_index, imbBottom,
     border_color=color.new(color.green, 50), bgcolor=color.new(color.green, 85),
     border_width=1)
    
    // Label
    label.new(bar_index, imbBottom, "BI", style=label.style_label_up, 
      color=color.new(color.green, 50), textcolor=color.white, size=size.small)

// Draw bearish imbalance zone
if bearishImbalance and showImbalances
    float imbTop = low[2]     // Candle 1 low
    float imbBottom = high[0] // Current candle high (gap start)
    
    box.new(bar_index - 2, imbTop, bar_index, imbBottom,
     border_color=color.new(color.red, 50), bgcolor=color.new(color.red, 85),
     border_width=1)
    
    label.new(bar_index, imbTop, "SI", style=label.style_label_down, 
      color=color.new(color.red, 50), textcolor=color.white, size=size.small)
```

### 5.4 Imbalance Proximity for Signal

```pine
// Check if price is near an imbalance (within 1.5 ATR)
bool nearImbalanceLong  = false
bool nearImbalanceShort = false

if bullishImbalance and math.abs(close - high[2]) < atrValue * 1.5
    nearImbalanceLong := true

if bearishImbalance and math.abs(close - low[2]) < atrValue * 1.5
    nearImbalanceShort := true
```

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

// Fetch 1H pivot data
h1_pivotHigh = request.security(syminfo.tickerid, "60", ta.pivothigh(high, structPivotLen, structPivotLen), lookahead=barmerge.lookahead_off)
h1_pivotLow  = request.security(syminfo.tickerid, "60", ta.pivotlow(low, structPivotLen, structPivotLen),   lookahead=barmerge.lookahead_off)
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

// Update swing highs
if not na(h1_pivotHigh)
    prevSwingHigh := lastSwingHigh
    lastSwingHigh := h1_pivotHigh
    lastSwingHighBar := bar_index

// Update swing lows
if not na(h1_pivotLow)
    prevSwingLow := lastSwingLow
    lastSwingLow := h1_pivotLow
    lastSwingLowBar := bar_index
```

### 6.4 BoS Detection

```pine
// Bullish BoS: price breaks above the most recent swing high
bool bullishBoS = close > lastSwingHigh and close[1] <= lastSwingHigh

// Bearish BoS: price breaks below the most recent swing low
bool bearishBoS = close < lastSwingLow and close[1] >= lastSwingLow

// Update structure state
if bullishBoS
    marketStructure := 1  // Bullish structure confirmed
if bearishBoS
    marketStructure := -1 // Bearish structure confirmed
```

### 6.5 ChoCh Detection

```pine
// Bullish ChoCh: price breaks above a swing high that previously acted as reversal
// (i.e., price was in a downtrend, then breaks a swing high)
bool bullishChoCh = marketStructure == -1 and close > lastSwingHigh and close[1] <= lastSwingHigh

// Bearish ChoCh: price breaks below a swing low that previously acted as reversal
bool bearishChoCh = marketStructure == 1 and close < lastSwingLow and close[1] >= lastSwingLow

// ChoCh overrides structure (it's a reversal signal)
if bullishChoCh
    marketStructure := 1
if bearishChoCh
    marketStructure := -1
```

### 6.6 Rendering Structure Breaks

```pine
// Draw BoS/ChoCh markers
if bullishBoS and showStructureBreaks
    label.new(bar_index, low, bullishChoCh ? "ChoCh ▲" : "BoS ▲", 
      style=label.style_label_up, color=color.new(color.green, 30), 
      textcolor=color.white, size=size.normal)

if bearishBoS and showStructureBreaks
    label.new(bar_index, high, bearishChoCh ? "ChoCh ▼" : "BoS ▼", 
      style=label.style_label_down, color=color.new(color.red, 30), 
      textcolor=color.white, size=size.normal)

// Draw structure lines connecting swing points
if not na(lastSwingHigh) and not na(prevSwingHigh)
    line.new(lastSwingHighBar, lastSwingHigh, bar_index, lastSwingHigh, 
      color=color.new(color.red, 50), style=line.style_solid, width=1)
if not na(lastSwingLow) and not na(prevSwingLow)
    line.new(lastSwingLowBar, lastSwingLow, bar_index, lastSwingLow, 
      color=color.new(color.green, 50), style=line.style_solid, width=1)
```

---

## 7. Module: Signal Engine

### 7.1 Concept

The signal engine is the **confluence evaluator**. It takes outputs from the other three modules and determines whether all factors align to produce a LONG or SHORT signal.

### 7.2 Confluence Rules

A signal requires **all three factors to agree**:

```
LONG Signal = nearLiquidityLong AND sessionAligned AND (bullishImbalance OR bullishBoS OR bullishChoCh)
SHORT Signal = nearLiquidityShort AND sessionAligned AND (bearishImbalance OR bearishBoS OR bearishChoCh)
```

### 7.3 Confidence Scoring

Not all signals are equal. We compute a confidence score (0–100) based on:

| Factor | Condition | Points |
|--------|-----------|--------|
| **Liquidity** | Near D1 zone | 30 |
| | Near 4H zone | 20 |
| | Near 1H zone | 10 |
| **Session** | In overlap (Lon+NY) | 25 |
| | In London or NY | 15 |
| | In Asia | 5 |
| **Structure** | BoS aligned | 20 |
| | ChoCh aligned | 30 |
| | Imbalance confirmed | 15 |
| | Volume confirmed | 10 |

```pine
int confidenceScore = 0

// Liquidity points
if nearD1Liquidity
    confidenceScore += 30
else if nearH4Liquidity
    confidenceScore += 20
else if nearH1Liquidity
    confidenceScore += 10

// Session points
if inOverlap
    confidenceScore += 25
else if inLondon or inNY
    confidenceScore += 15
else if inAsia
    confidenceScore += 5

// Structure points
if bullishBoS or bearishBoS
    confidenceScore += 20
if bullishChoCh or bearishChoCh
    confidenceScore += 30
if bullishImbalance or bearishImbalance
    confidenceScore += 15
if volumeConfirmed
    confidenceScore += 10
```

### 7.4 Signal Thresholds

```pine
minConfidence = input.int(60, "Minimum Confidence Score", minval=0, maxval=100, group="Signal Engine")

// LONG signal: all factors bullish + score above threshold
bool longSignal = nearLiquidityLong and sessionScore >= 2 and 
                  (bullishImbalance or bullishBoS or bullishChoCh) and 
                  confidenceScore >= minConfidence

// SHORT signal: all factors bearish + score above threshold
bool shortSignal = nearLiquidityShort and sessionScore >= 2 and 
                   (bearishImbalance or bearishBoS or bearishChoCh) and 
                   confidenceScore >= minConfidence
```

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
    label.new(barIndex, low - atrValue, 
      "LONG\nScore: " + str.tostring(confidenceScore) + "%", 
      style=label.style_label_up, 
      color=color.new(color.green, 20), 
      textcolor=color.white, 
      size=size.normal,
      yloc=yloc.belowbar)
    
    // Alert
    alert("LiquidityFlowAuse LONG signal on " + syminfo.ticker + " | Score: " + str.tostring(confidenceScore) + "%", alert.freq_once_per_bar_close)

if shortSignal and not inCooldown
    label.new(barIndex, high + atrValue, 
      "SHORT\nScore: " + str.tostring(confidenceScore) + "%", 
      style=label.style_label_down, 
      color=color.new(color.red, 20), 
      textcolor=color.white, 
      size=size.normal,
      yloc=yloc.abovebar)
    
    // Alert
    alert("LiquidityFlowAuse SHORT signal on " + syminfo.ticker + " | Score: " + str.tostring(confidenceScore) + "%", alert.freq_once_per_bar_close)
```

### 7.7 Signal Engine Flow Diagram

```
┌──────────────────────────────────────────────────────────┐
│                    SIGNAL ENGINE                          │
│                                                          │
│  Liquidity Zones ──► nearLiquidityLong/Short ──────┐     │
│                                                    │     │
│  Session Markers ───► sessionScore >= 2 ──────────┤     │
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
showStructBreaks = input.bool(true,  "Show Structure Breaks",    group="General")
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
showChoCh      = input.bool(true, "Show ChoCh Markers",  group="Structure Break")
showBoS        = input.bool(true, "Show BoS Markers",    group="Structure Break")

// ═══════════════════════════════════════════════════════════════════════════════
// GROUP: Signal Engine
// ═══════════════════════════════════════════════════════════════════════════════
minConfidence     = input.int(60,  "Minimum Confidence Score", minval=0, maxval=100, group="Signal Engine")
signalCooldown    = input.int(10,  "Signal Cooldown (bars)",   minval=1,                   group="Signal Engine")
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
| Confidence Score | Embedded in label text | `"Score: XX%"` |

### 9.3 Chart Annotations

```
┌─────────────────────────────────────────────────────────────────┐
│  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  │  ← D1 Zone (dashed)
│                                                                 │
│         ┌─────────────┐                                        │
│         │    LONG     │  ← Signal label (green, below bar)    │
│         │  Score: 75% │                                        │
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
alertcondition(longSignal,     "LF_LongSignal",     "LONG signal on {{ticker}} | Score: {{close}}%")
alertcondition(shortSignal,    "LF_ShortSignal",    "SHORT signal on {{ticker}} | Score: {{close}}%")
alertcondition(bullishBoS,     "LF_BullishBoS",     "Bullish BoS on {{ticker}}")
alertcondition(bearishBoS,     "LF_BearishBoS",     "Bearish BoS on {{ticker}}")
alertcondition(bullishChoCh,   "LF_BullishChoCh",   "Bullish ChoCh on {{ticker}}")
alertcondition(bearishChoCh,   "LF_BearishChoCh",   "Bearish ChoCh on {{ticker}}")

// Liquidity zone test alert
bool liquidityTestLong  = nearLiquidityLong and ta.crossover(close, array.get(zonePrices, 0))
bool liquidityTestShort = nearLiquidityShort and ta.crossunder(close, array.get(zonePrices, 0))
alertcondition(liquidityTestLong,  "LF_LiquidityTest",  "Price testing LONG liquidity on {{ticker}}")
alertcondition(liquidityTestShort, "LF_LiquidityTest",  "Price testing SHORT liquidity on {{ticker}}")

// Session overlap alert
alertcondition(ta.change(inOverlap) and inOverlap, "LF_OverlapStart", "London+NY overlap started on {{ticker}}")
```

### 10.3 Alert Message Format

```
LiquidityFlowAuse LONG signal on BTCUSDT (Binance)
Score: 75% | Session: London+NY Overlap | Structure: Bullish ChoCh
Liquidity: D1 pivot low @ $64,200 | Imbalance: Bullish FVG confirmed
```

### 10.4 Webhook Integration

For external automation (Discord, Telegram, trading bots):

```pine
// JSON payload for webhook (used with external alert bridges)
if longSignal
    alertMessage = '{"indicator":"LiquidityFlowAuse","signal":"LONG","symbol":"' + syminfo.ticker + 
                   '","score":' + str.tostring(confidenceScore) + 
                   ',"price":' + str.tostring(close) + 
                   ',"structure":"' + (bullishChoCh ? "ChoCh" : bullishBoS ? "BoS" : "Imbalance") + '"}'
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

A module's decorative header banner is stripped during the build; the
descriptive prose is preserved.

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
bool sessionOK      = sessionScore >= 2
bool structureOK    = (bullishImbalance or bullishBoS or bullishChoCh) or 
                      (bearishImbalance or bearishBoS or bearishChoCh)

// LONG requires ALL three — no partial credit
bool longSignalStrict  = nearLiquidityLong  and sessionOK and 
                         (bullishImbalance or bullishBoS or bullishChoCh)

// SHORT requires ALL three — no partial credit  
bool shortSignalStrict = nearLiquidityShort and sessionOK and 
                         (bearishImbalance or bearishBoS or bearishChoCh)
```

**Why:** Percentage scores imply that 60% confidence is "good enough." In trading, a missing factor means the setup is incomplete. Binary scoring forces discipline.

---

### D.2 Liquidity Zone Freshness Decay

Not all zones are equal. A zone tested 5 minutes ago is more relevant than one tested 3 days ago:

```pine
// ─── Zone Freshness Decay ─────────────────────────────────────────────────────
zoneDecayFactor = input.float(50.0, "Zone Decay Half-Life (bars)", minval=10.0, group="Liquidity Zones")

// When a zone is tested (price enters it), record the bar
var int[] zoneLastTested = array.new_int()

// Initialize zoneLastTested when a new zone is added (push bar_index)
// This must happen inside the "if not na(pivot)" blocks when array.push(zonePrices, ...) is called

// Zone strength decays exponentially since last test
float zoneStrength(int barsSinceTest) =>
    math.exp(-barsSinceTest / zoneDecayFactor)

// Only render zones with strength > threshold
float zoneStrengthThreshold = input.float(0.1, "Min Zone Strength", minval=0.01, maxval=1.0, group="Liquidity Zones")

// Track zone tests: when price enters a zone, update its last-tested bar
if array.size(zonePrices) > 0
    for i = 0 to array.size(zonePrices) - 1
        float zonePrice = array.get(zonePrices, i)
        // Price is inside the zone (within ATR range)
        if math.abs(close - zonePrice) < atrCurrent * zoneATRMult
            array.set(zoneLastTested, i, bar_index)

// Filter: remove weak/stale zones (iterate backwards to safely remove)
if array.size(zonePrices) > 0
    for i = array.size(zonePrices) - 1 to 0
        int barsSince = bar_index - array.get(zoneLastTested, i)
        if zoneStrength(barsSince) < zoneStrengthThreshold
            array.remove(zonePrices, i)
            array.remove(zoneLastTested, i)
            array.remove(zoneTiers, i)
```

**Why:** Stale zones clutter the chart and reduce signal quality. Fresh zones attract price; dead zones do not.

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
                       "├── Structure: " + (bullishChoCh ? "ChoCh" : bullishBoS ? "BoS" : "Imbalance") + "\n" +
                       "├── Target: +" + str.tostring(targetPct, "#.##") + "%\n" +
                       "└── Stop: -" + str.tostring(stopPct, "#.##") + "%"
    
    alert(alertText, alert.freq_once_per_bar_close)

if shortSignalStrict and not inCooldown
    string alertText = "SHORT " + syminfo.ticker + "\n" +
                       "├── Liquidity: " + (nearD1Liquidity ? "D1 zone" : nearH4Liquidity ? "4H zone" : "1H zone") + "\n" +
                       "├── Session: " + (inOverlap ? "Lon+NY Overlap" : inLondon ? "London" : inNY ? "New York" : "Asia") + "\n" +
                       "├── Structure: " + (bearishChoCh ? "ChoCh" : bearishBoS ? "BoS" : "Imbalance") + "\n" +
                       "├── Target: +" + str.tostring(targetPct, "#.##") + "%\n" +
                       "└── Stop: -" + str.tostring(stopPct, "#.##") + "%"
    
    alert(alertText, alert.freq_once_per_bar_close)
```

**Why:** Traders need to validate the setup, not just the direction. Context-rich alerts turn every signal into a learning opportunity.

---

*End of Technical Specification — LiquidityFlowAuse v1.0.0*

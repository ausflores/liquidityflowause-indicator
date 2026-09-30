// ============================================================================
// LiquidityFlowAuse — Session Markers (JavaScript port)
// ----------------------------------------------------------------------------
// Port of src/modules/session-markers.pine for the local backtest harness
// (odd/tasks/weight-calibration.md, task T3). LOGIC ONLY: background tints,
// boundary lines and every other drawing call in the Pine module are NOT
// ported. This module computes values; it cannot draw anything.
//
// What IS ported:
//   * Session window membership — Pine input.session() semantics: the
//     half-open interval [start, end), start inclusive, end exclusive, with an
//     optional day-of-week suffix (default 1234567 = Sun..Sat, Pine v5).
//   * The timezone routing rule. time()'s third argument rejects "exchange"
//     at runtime on bar 0, so the Pine module serves it through the
//     two-argument overload. Here "exchange" resolves to options.exchangeTimezone
//     (default "UTC": Bitstamp bar boundaries are UTC — see backtest/run.mjs).
//   * DST handling. Local wall-clock conversion for IANA zones goes through
//     Intl.DateTimeFormat (Node built-in, no dependency), so America/New_York
//     steps EST -> EDT across 8 Mar 2026 exactly as the chart does
//     (docs/VALIDATION.md: opening-bar readings 5/12/18 -> 4/11/17).
//   * Overlap detection and the sessionStrength / sessionMultiplier exports,
//     recomputed from scratch on every bar, exactly like the Pine module
//     (which uses no `var` — both values derive from the current bar only).
//
// Not ported (drawing or drawing-only inputs):
//   * bgcolor tints and the showOverlapOnly input (it only gates the tint).
//   * ta.change() boundary lines. ta.change() itself is stateful, but the Pine
//     module uses it exclusively to draw lines, so it has no exported value.
//
// Interface: a "bar" is { t } — the bar's OPENING timestamp in epoch
// milliseconds. That mirrors Pine's time(), which reports the bar's own
// timestamp when the bar falls inside the session, na otherwise.
// ============================================================================

const MS_PER_DAY = 86400000;

/** Defaults mirrored from the Pine module's input.* declarations. */
export const SESSION_MARKER_DEFAULTS = Object.freeze({
  sessionAsiaEnabled: true,
  sessionLondonEnabled: true,
  sessionNYEnabled: true,
  sessionTimezone: "exchange",
  // Not a Pine input: the exchange timezone that "exchange" resolves to.
  // Bitstamp daily bars start at exact UTC midnights (backtest/run.mjs), so
  // the validation chart's "exchange" clock is UTC.
  exchangeTimezone: "UTC",
  asiaSession: "0000-0900",
  londonSession: "0700-1600",
  nySession: "1300-2200",
});

// ─── Session strings ─────────────────────────────────────────────────────────

/**
 * Parses a Pine session string: "HHMM-HHMM" with an optional day suffix
 * ":1234567". Days are digits 1..7 where 1 = Sunday .. 7 = Saturday (the
 * numbering implied by the module's own "1234567 (Sun-Sat)" comment). An
 * omitted suffix defaults to all seven days, matching Pine v5.
 *
 * Returns { start, end, days } with start/end in local minutes-of-day.
 */
export function parseSessionString(spec) {
  if (typeof spec !== "string") {
    throw new TypeError(`session string must be a string, got ${typeof spec}`);
  }

  const m = /^(\d{2})(\d{2})-(\d{2})(\d{2})(?::([1-7]{1,7}))?$/.exec(spec.trim());
  if (!m) {
    throw new RangeError(
      `invalid Pine session string: "${spec}" ` +
        '(expected "HHMM-HHMM" or "HHMM-HHMM:1234567")',
    );
  }

  const startH = Number(m[1]);
  const startM = Number(m[2]);
  const endH = Number(m[3]);
  const endM = Number(m[4]);
  if (startH > 23 || endH > 23 || startM > 59 || endM > 59) {
    throw new RangeError(`session string out of clock range: "${spec}"`);
  }

  const days = new Set();
  if (m[5] === undefined) {
    for (let d = 1; d <= 7; d++) days.add(d);
  } else {
    for (const ch of m[5]) days.add(Number(ch));
  }

  return { start: startH * 60 + startM, end: endH * 60 + endM, days };
}

// ─── Timezone resolution ─────────────────────────────────────────────────────
//
// time()'s timezone argument accepts only UTC/GMT notation ("UTC-5",
// "GMT+0530") or an IANA zone name ("America/New_York"). Both forms are
// supported here; anything else throws at construction, which is the JS
// equivalent of Pine's bar-0 runtime error.

const formatterCache = new Map();

function compileTimezone(name) {
  if (typeof name !== "string" || name.length === 0) {
    throw new TypeError(`timezone must be a non-empty string, got ${String(name)}`);
  }

  // UTC/GMT notation -> fixed offset. Plain "UTC" and "GMT" are offset 0.
  const fixed = /^(?:UTC|GMT)(?:([+-])(\d{1,2})(?::?(\d{2}))?)?$/i.exec(name);
  if (fixed) {
    const hours = fixed[2] === undefined ? 0 : Number(fixed[2]);
    const minutes = fixed[3] === undefined ? 0 : Number(fixed[3]);
    if (minutes > 59 || hours > 23) {
      throw new RangeError(`UTC/GMT offset out of range: "${name}"`);
    }
    const total = hours * 60 + minutes;
    return {
      kind: "fixed",
      offsetMinutes: fixed[1] === "-" ? -total : total,
      name,
    };
  }

  // IANA zone. Constructing the formatter is the validation: an unknown zone
  // throws RangeError from Intl, mirroring Pine rejecting it on bar 0.
  let formatter = formatterCache.get(name);
  if (formatter === undefined) {
    try {
      formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: name,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      });
    } catch {
      throw new RangeError(
        `"${name}" is not a valid timezone. time() accepts UTC/GMT notation ` +
          '("UTC-5", "GMT+0530") or an IANA zone name ("America/New_York").',
      );
    }
    formatterCache.set(name, formatter);
  }
  return { kind: "iana", formatter, name };
}

// ─── Local wall clock ────────────────────────────────────────────────────────

/**
 * Converts an epoch-ms instant to the local calendar facts the membership
 * test needs:
 *
 *   minutesOfDay — local minutes since midnight (DST is already applied,
 *                  because the conversion itself did the offset lookup);
 *   pineDay      — local calendar date as a Pine session day digit,
 *                  1 = Sunday .. 7 = Saturday;
 *   prevPineDay  — the same digit for the previous LOCAL calendar date, used
 *                  when a session window spans midnight. Derived from the
 *                  calendar date (Date.UTC arithmetic), not from clock
 *                  arithmetic, so a DST shift near midnight cannot skew it.
 */
function localParts(utcMs, tz) {
  let y;
  let mo;
  let d;
  let h;
  let mi;

  if (tz.kind === "fixed") {
    const date = new Date(utcMs + tz.offsetMinutes * 60000);
    y = date.getUTCFullYear();
    mo = date.getUTCMonth() + 1;
    d = date.getUTCDate();
    h = date.getUTCHours();
    mi = date.getUTCMinutes();
  } else {
    for (const part of tz.formatter.formatToParts(new Date(utcMs))) {
      if (part.type === "year") y = Number(part.value);
      else if (part.type === "month") mo = Number(part.value);
      else if (part.type === "day") d = Number(part.value);
      else if (part.type === "hour") h = Number(part.value);
      else if (part.type === "minute") mi = Number(part.value);
    }
  }

  // Date.UTC maps years 0-99 into 1900-1999; irrelevant for market data,
  // which never carries such years, but the weekday math below only needs
  // the day-of-week of a proleptic Gregorian date.
  const localMidnightUtc = Date.UTC(y, mo - 1, d);
  return {
    minutesOfDay: h * 60 + mi,
    // Pine session day digits: 1 = Sunday. getUTCDay() is 0 = Sunday.
    pineDay: new Date(localMidnightUtc).getUTCDay() + 1,
    prevPineDay: new Date(localMidnightUtc - MS_PER_DAY).getUTCDay() + 1,
  };
}

/**
 * Membership test for one session window, half-open [start, end).
 *
 * A window with start >= end spans local midnight: before midnight the
 * session's OWN day must be allowed, after midnight the PREVIOUS local day
 * must be allowed (the session that started yesterday is the one covering
 * this bar). start == end therefore covers the whole day, which is the only
 * sensible reading of a zero-length window.
 */
function sessionContains(parts, session) {
  const { minutesOfDay, pineDay, prevPineDay } = parts;

  if (session.start < session.end) {
    return (
      minutesOfDay >= session.start &&
      minutesOfDay < session.end &&
      session.days.has(pineDay)
    );
  }

  if (minutesOfDay >= session.start) return session.days.has(pineDay);
  if (minutesOfDay < session.end) return session.days.has(prevPineDay);
  return false;
}

// ─── Module factory ──────────────────────────────────────────────────────────

/**
 * Builds a session evaluator. Mirrors one concatenation of the Pine module:
 * inputs are fixed at construction, and evaluate() recomputes everything for
 * each bar with no carried state.
 *
 * @param {object} options — overrides of SESSION_MARKER_DEFAULTS.
 * @returns {{ evaluate: (bar: {t: number}) => object, timezone: string }}
 */
export function createSessionMarkers(options = {}) {
  const cfg = { ...SESSION_MARKER_DEFAULTS, ...options };

  // Pine's `if not na(sessionTimezone)` guard: with a null timezone every
  // membership flag stays at its initial false, so strength/multiplier fall
  // back to 0 / 0.3. Reproduced instead of throwing, for parity.
  const timezoneMissing = cfg.sessionTimezone == null;
  const resolvedTimezone = timezoneMissing
    ? null
    : cfg.sessionTimezone === "exchange"
      ? cfg.exchangeTimezone
      : cfg.sessionTimezone;
  const tz = timezoneMissing ? null : compileTimezone(resolvedTimezone);

  const asia = parseSessionString(cfg.asiaSession);
  const london = parseSessionString(cfg.londonSession);
  const ny = parseSessionString(cfg.nySession);

  const asiaEnabled = Boolean(cfg.sessionAsiaEnabled);
  const londonEnabled = Boolean(cfg.sessionLondonEnabled);
  const nyEnabled = Boolean(cfg.sessionNYEnabled);

  function evaluate(bar) {
    let inAsia = false;
    let inLondon = false;
    let inNY = false;

    if (!timezoneMissing) {
      if (bar == null || !Number.isFinite(bar.t)) {
        throw new TypeError(
          "session-markers: bar.t must be a finite epoch-millisecond timestamp",
        );
      }
      const parts = localParts(bar.t, tz);

      // Gating by the enable flag happens BEFORE the time() call in Pine too
      // (module lines 70-72), so a disabled session never reports membership
      // even inside its window.
      inAsia = asiaEnabled && sessionContains(parts, asia);
      inLondon = londonEnabled && sessionContains(parts, london);
      inNY = nyEnabled && sessionContains(parts, ny);
    }

    // Derived state: both constituent sessions enabled AND active. The
    // enabled conjuncts are redundant with inLondon/inNY (already gated
    // above) but are kept exactly as the Pine module writes them.
    const inOverlap = londonEnabled && nyEnabled && inLondon && inNY;

    // sessionStrength, 0-8: +1 Asia, +2 London, +2 NY, +3 overlap.
    let sessionStrength = 0;
    if (inAsia) sessionStrength += 1;
    if (inLondon) sessionStrength += 2;
    if (inNY) sessionStrength += 2;
    if (inOverlap) sessionStrength += 3;

    // sessionMultiplier, 0.3-1.5. The 0.3 default is the terminal value of
    // the Pine chain: it stands when no branch fires (no active session).
    let sessionMultiplier = 0.3;
    if (inOverlap) sessionMultiplier = 1.5;
    else if (inLondon || inNY) sessionMultiplier = 1.0;
    else if (inAsia) sessionMultiplier = 0.5;

    return {
      inAsia,
      inLondon,
      inNY,
      inOverlap,
      sessionStrength,
      sessionMultiplier,
    };
  }

  return { evaluate, timezone: timezoneMissing ? null : resolvedTimezone };
}

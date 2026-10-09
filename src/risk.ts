/**
 * CryptoAI Pro — Master Signal Engine: risk module (src/risk.ts).
 *
 * Entry planning, stop-loss placement, take-profit ladder, risk/reward,
 * position sizing, and leverage selection.
 *
 * Hard invariants enforced here:
 *  - Causal only: plans use last indicator values and swing points with
 *    index < the last (still-forming) bar. No look-ahead.
 *  - Position size NEVER scales with confidence or score. Size derives only
 *    from account risk (balance * riskPercent) and stop distance.
 *  - Leverage NEVER changes intended account risk. risk_amount is fixed by
 *    balance * riskPercent; leverage only affects margin/capital efficiency.
 *  - Nothing here estimates, claims, or implies guaranteed accuracy or any
 *    guaranteed outcome. All outputs are planning aids under uncertainty.
 */

import type {
  Candle,
  IndicatorSet,
  EntryPlan,
  StopLossPlan,
  TakeProfitPlan,
  RiskReward,
  PositionPlan,
  MarketRegime,
  EngineConfig,
  SwingPoint,
  BreakEvent,
} from './types';
import { lastFinite } from './indicators';

// ---------------------------------------------------------------------------
// Small guards / helpers
// ---------------------------------------------------------------------------

function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function asSeries(a: unknown): number[] {
  return Array.isArray(a) ? (a as number[]) : [];
}

/** Last close of the series, NaN when unavailable. */
function lastClose(candles: Candle[]): number {
  const n = Array.isArray(candles) ? candles.length : 0;
  if (n === 0) return NaN;
  const c = candles[n - 1];
  return c && isFiniteNum(c.close) ? c.close : NaN;
}

/** Last finite ATR; falls back to 1% of price so zones/buffers stay defined. */
function atrValue(ind: IndicatorSet | undefined, price: number): number {
  const a = ind ? lastFinite(asSeries(ind.atr)) : NaN;
  if (isFiniteNum(a) && a > 0) return a;
  return isFiniteNum(price) && price > 0 ? price * 0.01 : NaN;
}

/** Swing points strictly before the last bar (the last bar may still form). */
function closedSwings(points: SwingPoint[] | undefined, lastIndex: number): SwingPoint[] {
  if (!Array.isArray(points)) return [];
  return points.filter(
    (p) => p && isFiniteNum(p.price) && isFiniteNum(p.index) && p.index < lastIndex,
  );
}

/** Adaptive decimal formatting for reason strings. */
function fmt(v: number): string {
  if (!isFiniteNum(v)) return 'n/a';
  const abs = Math.abs(v);
  if (abs >= 100) return v.toFixed(2);
  if (abs >= 1) return v.toFixed(4);
  return v.toFixed(6);
}

/** Nearest support at or below price (indicator level + recent swing lows). */
function nearestSupportBelow(
  ind: IndicatorSet,
  price: number,
  lastIndex: number,
): number | undefined {
  const cands: number[] = [];
  const s = lastFinite(asSeries(ind.support));
  if (isFiniteNum(s) && s <= price) cands.push(s);
  for (const p of closedSwings(ind.swingLows, lastIndex)) {
    if (p.price <= price) cands.push(p.price);
  }
  return cands.length ? cands.reduce((a, b) => (b > a ? b : a)) : undefined;
}

/** Nearest resistance at or above price (indicator level + recent swing highs). */
function nearestResistanceAbove(
  ind: IndicatorSet,
  price: number,
  lastIndex: number,
): number | undefined {
  const cands: number[] = [];
  const r = lastFinite(asSeries(ind.resistance));
  if (isFiniteNum(r) && r >= price) cands.push(r);
  for (const p of closedSwings(ind.swingHighs, lastIndex)) {
    if (p.price >= price) cands.push(p.price);
  }
  return cands.length ? cands.reduce((a, b) => (b < a ? b : a)) : undefined;
}

interface SwingLeg {
  low: number;
  high: number;
}

/**
 * Most recent up-leg: latest swing high (closed bar) with the latest swing
 * low before it. Falls back to the lowest low of the 30 closed bars before
 * the swing high when no swing low is recorded.
 */
function lastUpLeg(candles: Candle[], ind: IndicatorSet, lastIndex: number): SwingLeg | undefined {
  const highs = closedSwings(ind.swingHighs, lastIndex).sort((a, b) => b.index - a.index);
  if (highs.length === 0) return undefined;
  const hi = highs[0];
  const lows = closedSwings(ind.swingLows, lastIndex)
    .filter((p) => p.index < hi.index)
    .sort((a, b) => b.index - a.index);
  let lo: number | undefined = lows.length ? lows[0].price : undefined;
  if (lo === undefined) {
    const from = Math.max(0, hi.index - 30);
    const barLows = candles.slice(from, hi.index + 1).map((c) => c.low).filter(isFiniteNum);
    if (barLows.length) lo = barLows.reduce((a, b) => (b < a ? b : a));
  }
  if (lo === undefined || !(hi.price > lo)) return undefined;
  return { low: lo, high: hi.price };
}

/** Mirror of lastUpLeg for down-legs (latest swing low, latest swing high before it). */
function lastDownLeg(
  candles: Candle[],
  ind: IndicatorSet,
  lastIndex: number,
): SwingLeg | undefined {
  const lows = closedSwings(ind.swingLows, lastIndex).sort((a, b) => b.index - a.index);
  if (lows.length === 0) return undefined;
  const lo = lows[0];
  const highs = closedSwings(ind.swingHighs, lastIndex)
    .filter((p) => p.index < lo.index)
    .sort((a, b) => b.index - a.index);
  let hi: number | undefined = highs.length ? highs[0].price : undefined;
  if (hi === undefined) {
    const from = Math.max(0, lo.index - 30);
    const barHighs = candles.slice(from, lo.index + 1).map((c) => c.high).filter(isFiniteNum);
    if (barHighs.length) hi = barHighs.reduce((a, b) => (b > a ? b : a));
  }
  if (hi === undefined || !(hi > lo.price)) return undefined;
  return { low: lo.price, high: hi };
}

/**
 * Most recent volume-confirmed break-of-structure in the trade direction
 * within 3 bars of the last bar.
 */
function lastVolumeConfirmedBos(
  ind: IndicatorSet,
  direction: 'LONG' | 'SHORT',
  lastIndex: number,
): BreakEvent | undefined {
  if (!Array.isArray(ind.bos)) return undefined;
  const want = direction === 'LONG' ? 'UP' : 'DOWN';
  let best: BreakEvent | undefined;
  for (const e of ind.bos) {
    if (!e || !isFiniteNum(e.index) || !isFiniteNum(e.brokenLevel)) continue;
    if (e.index >= lastIndex) continue; // causal: last bar still forming
    if (!e.volumeConfirmed || e.direction !== want) continue;
    if (lastIndex - e.index > 3) continue;
    if (!best || e.index > best.index) best = e;
  }
  return best;
}

/**
 * Most recent break event (BOS or CHoCH) whose broken level was lost after
 * the break and has now been reclaimed by the last close. The level becomes
 * the retest entry.
 */
function lastReclaimedLevel(
  ind: IndicatorSet,
  direction: 'LONG' | 'SHORT',
  candles: Candle[],
  close: number,
  lastIndex: number,
): number | undefined {
  const events: BreakEvent[] = [];
  if (Array.isArray(ind.bos)) events.push(...ind.bos);
  if (Array.isArray(ind.choch)) events.push(...ind.choch);
  events.sort((a, b) => (b && isFiniteNum(b.index) ? b.index : -1) - (a && isFiniteNum(a.index) ? a.index : -1));
  for (const e of events) {
    if (!e || !isFiniteNum(e.index) || !isFiniteNum(e.brokenLevel)) continue;
    if (e.index >= lastIndex || lastIndex - e.index > 8) continue;
    const lvl = e.brokenLevel;
    if (direction === 'LONG') {
      if (e.direction !== 'UP' || !(lvl < close) || close < lvl) continue;
      let dipped = false;
      for (let i = e.index; i < lastIndex; i++) {
        const c = candles[i];
        if (c && isFiniteNum(c.close) && c.close < lvl) {
          dipped = true;
          break;
        }
      }
      if (dipped) return lvl;
    } else {
      if (e.direction !== 'DOWN' || !(lvl > close) || close > lvl) continue;
      let dipped = false;
      for (let i = e.index; i < lastIndex; i++) {
        const c = candles[i];
        if (c && isFiniteNum(c.close) && c.close > lvl) {
          dipped = true;
          break;
        }
      }
      if (dipped) return lvl;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Entry planning
// ---------------------------------------------------------------------------

interface Confluence {
  components: number[];
  note: string;
}

/**
 * Value-zone confluence for the preferred entry: nearest support/resistance,
 * VWAP, EMA20/50, and the 0.5 Fibonacci retracement of the last swing leg
 * (last up-leg for LONG, last down-leg for SHORT). Components must sit on
 * the value side of price (<= close for LONG, >= close for SHORT).
 */
function valueConfluence(
  direction: 'LONG' | 'SHORT',
  candles: Candle[],
  ind: IndicatorSet,
  close: number,
  lastIndex: number,
): Confluence {
  const components: number[] = [];
  const notes: string[] = [];
  const ema20 = lastFinite(asSeries(ind.ema20));
  const ema50 = lastFinite(asSeries(ind.ema50));
  const vwap = lastFinite(asSeries(ind.vwap));
  const push = (v: number, name: string) => {
    components.push(v);
    notes.push(`${name} ${fmt(v)}`);
  };

  if (direction === 'LONG') {
    const sup = nearestSupportBelow(ind, close, lastIndex);
    if (sup !== undefined) push(sup, 'support');
    const leg = lastUpLeg(candles, ind, lastIndex);
    if (leg) {
      const f382 = leg.high - (leg.high - leg.low) * 0.382;
      const f05 = leg.high - (leg.high - leg.low) * 0.5;
      const f618 = leg.high - (leg.high - leg.low) * 0.618;
      notes.push(`fib 0.382/0.5/0.618 of last up-leg ${fmt(f382)}/${fmt(f05)}/${fmt(f618)}`);
      if (f05 <= close) push(f05, 'fib 0.5');
    }
    if (isFiniteNum(ema20) && ema20 <= close) push(ema20, 'ema20');
    if (isFiniteNum(ema50) && ema50 <= close) push(ema50, 'ema50');
    if (isFiniteNum(vwap) && vwap <= close) push(vwap, 'vwap');
  } else {
    const res = nearestResistanceAbove(ind, close, lastIndex);
    if (res !== undefined) push(res, 'resistance');
    const leg = lastDownLeg(candles, ind, lastIndex);
    if (leg) {
      const f382 = leg.low + (leg.high - leg.low) * 0.382;
      const f05 = leg.low + (leg.high - leg.low) * 0.5;
      const f618 = leg.low + (leg.high - leg.low) * 0.618;
      notes.push(`fib 0.382/0.5/0.618 of last down-leg ${fmt(f382)}/${fmt(f05)}/${fmt(f618)}`);
      if (f05 >= close) push(f05, 'fib 0.5');
    }
    if (isFiniteNum(ema20) && ema20 >= close) push(ema20, 'ema20');
    if (isFiniteNum(ema50) && ema50 >= close) push(ema50, 'ema50');
    if (isFiniteNum(vwap) && vwap >= close) push(vwap, 'vwap');
  }
  return { components, note: notes.length ? notes.join(', ') : 'none' };
}

export function planEntry(
  direction: 'LONG' | 'SHORT',
  candles: Candle[],
  ind: IndicatorSet,
): EntryPlan {
  const n = Array.isArray(candles) ? candles.length : 0;
  const lastIndex = n - 1;
  const close = lastClose(candles);
  const fallback = (reason: string): EntryPlan => ({
    low: close,
    high: close,
    preferred: close,
    type: 'MARKET',
    reason,
  });

  if (!ind || !isFiniteNum(close) || !(close > 0) || n < 2) {
    return fallback('fallback: insufficient data (no valid last close or indicators)');
  }
  let atr = atrValue(ind, close);
  if (!isFiniteNum(atr) || atr <= 0) atr = close * 0.01;
  const zone = (preferred: number): { low: number; high: number } => ({
    low: preferred - 0.25 * atr,
    high: preferred + 0.25 * atr,
  });

  // 1. Fresh volume-confirmed break of structure: enter on the breakout.
  const bos = lastVolumeConfirmedBos(ind, direction, lastIndex);
  if (bos) {
    const z = zone(close);
    return {
      low: z.low,
      high: z.high,
      preferred: close,
      type: 'BREAKOUT',
      reason:
        `volume-confirmed break of structure ${direction === 'LONG' ? 'above' : 'below'} ` +
        `${fmt(bos.brokenLevel)} at bar ${bos.index} (within 3 bars); entering on breakout, ` +
        `fill expected near last close ${fmt(close)} (zone ±0.25×ATR)`,
    };
  }

  // 2. Recently broken level just reclaimed: enter on the retest.
  const retest = lastReclaimedLevel(ind, direction, candles, close, lastIndex);
  if (retest !== undefined) {
    const z = zone(retest);
    return {
      low: z.low,
      high: z.high,
      preferred: retest,
      type: 'RETEST',
      reason:
        `price just reclaimed broken level ${fmt(retest)}; entering on retest of former ` +
        `${direction === 'LONG' ? 'resistance' : 'support'} (zone ±0.25×ATR)`,
    };
  }

  // 3. Value-zone confluence.
  const conf = valueConfluence(direction, candles, ind, close, lastIndex);
  if (conf.components.length === 0) {
    return fallback('fallback: insufficient structure (no value confluence on the trade side of price)');
  }
  const preferred =
    direction === 'LONG'
      ? conf.components.reduce((a, b) => (b > a ? b : a))
      : conf.components.reduce((a, b) => (b < a ? b : a));

  // 4. Chase guard: price extended > 1.5×ATR beyond the value zone in the
  //    trade direction -> do not chase; wait for a retest of the zone.
  const extension = direction === 'LONG' ? close - preferred : preferred - close;
  if (extension > 1.5 * atr) {
    const z = zone(preferred);
    return {
      low: z.low,
      high: z.high,
      preferred,
      type: 'WAIT_FOR_RETEST',
      reason:
        `price extended ${(extension / atr).toFixed(2)}×ATR beyond the value zone ` +
        `(chasing); waiting for a retest of ${fmt(preferred)} — confluence: ${conf.note}`,
    };
  }

  // 5. Limit into value vs. market: >= 0.3% away -> LIMIT, else MARKET.
  const away = Math.abs(close - preferred) / close;
  if (away >= 0.003) {
    const z = zone(preferred);
    return {
      low: z.low,
      high: z.high,
      preferred,
      type: 'LIMIT',
      reason:
        `limit order into value: preferred ${fmt(preferred)} is ${(away * 100).toFixed(2)}% ` +
        `${direction === 'LONG' ? 'below' : 'above'} close (zone ±0.25×ATR) — ` +
        `confluence: ${conf.note}`,
    };
  }
  const z = zone(close);
  return {
    low: z.low,
    high: z.high,
    preferred: close,
    type: 'MARKET',
    reason:
      `price within 0.3% of the value zone; market entry near ${fmt(close)} ` +
      `(zone ±0.25×ATR) — confluence: ${conf.note}`,
  };
}

// ---------------------------------------------------------------------------
// Stop-loss planning
// ---------------------------------------------------------------------------

export function planStopLoss(
  direction: 'LONG' | 'SHORT',
  entryPrice: number,
  candles: Candle[],
  ind: IndicatorSet,
): StopLossPlan {
  const invalid = (reason: string): StopLossPlan => ({
    price: NaN,
    distance_percent: 0,
    reason,
  });
  if (!isFiniteNum(entryPrice) || !(entryPrice > 0)) {
    return invalid('fallback: invalid entry price');
  }
  const n = Array.isArray(candles) ? candles.length : 0;
  const lastIndex = n - 1;
  let atr = ind ? atrValue(ind, entryPrice) : NaN;
  if (!isFiniteNum(atr) || atr <= 0) atr = entryPrice * 0.01;

  const notes: string[] = [];
  let stop: number;
  let anchorDesc: string;

  if (direction === 'LONG') {
    const lows = closedSwings(ind ? ind.swingLows : undefined, lastIndex);
    let anchor: number | undefined;
    if (lows.length) {
      const recent = lows.reduce((a, b) => (b.index > a.index ? b : a));
      anchor = recent.price;
      anchorDesc = `swing low ${fmt(anchor)} (bar ${recent.index})`;
    } else {
      const sup = ind ? lastFinite(asSeries(ind.support)) : NaN;
      if (isFiniteNum(sup) && sup < entryPrice) {
        anchor = sup;
        anchorDesc = `nearest support ${fmt(sup)}`;
      } else {
        anchor = entryPrice - atr;
        anchorDesc = `${fmt(anchor)} (1×ATR below entry)`;
        notes.push('no usable swing low/support below entry; using 1×ATR projection');
      }
    }
    if (anchor === undefined || anchor >= entryPrice) {
      anchor = entryPrice - atr;
      anchorDesc = `${fmt(anchor)} (1×ATR below entry)`;
      notes.push('anchor at/above entry is unusable for a LONG stop; using 1×ATR projection');
    }
    stop = anchor - 0.5 * atr;
    // Clamp: never closer than 0.5×ATR, never farther than 6×ATR.
    const nearest = entryPrice - 0.5 * atr;
    const farthest = entryPrice - 6 * atr;
    if (stop < farthest) {
      stop = farthest;
      notes.push('clamped: stop was farther than 6×ATR from entry');
    }
    if (stop > nearest) {
      stop = nearest;
      notes.push('clamped: stop was closer than 0.5×ATR to entry');
    }
    anchorDesc = `${anchorDesc} minus 0.5×ATR buffer (${fmt(0.5 * atr)})`;
  } else {
    const highs = closedSwings(ind ? ind.swingHighs : undefined, lastIndex);
    let anchor: number | undefined;
    if (highs.length) {
      const recent = highs.reduce((a, b) => (b.index > a.index ? b : a));
      anchor = recent.price;
      anchorDesc = `swing high ${fmt(anchor)} (bar ${recent.index})`;
    } else {
      const res = ind ? lastFinite(asSeries(ind.resistance)) : NaN;
      if (isFiniteNum(res) && res > entryPrice) {
        anchor = res;
        anchorDesc = `nearest resistance ${fmt(res)}`;
      } else {
        anchor = entryPrice + atr;
        anchorDesc = `${fmt(anchor)} (1×ATR above entry)`;
        notes.push('no usable swing high/resistance above entry; using 1×ATR projection');
      }
    }
    if (anchor === undefined || anchor <= entryPrice) {
      anchor = entryPrice + atr;
      anchorDesc = `${fmt(anchor)} (1×ATR above entry)`;
      notes.push('anchor at/below entry is unusable for a SHORT stop; using 1×ATR projection');
    }
    stop = anchor + 0.5 * atr;
    // Clamp: never closer than 0.5×ATR, never farther than 6×ATR.
    const nearest = entryPrice + 0.5 * atr;
    const farthest = entryPrice + 6 * atr;
    if (stop > farthest) {
      stop = farthest;
      notes.push('clamped: stop was farther than 6×ATR from entry');
    }
    if (stop < nearest) {
      stop = nearest;
      notes.push('clamped: stop was closer than 0.5×ATR to entry');
    }
    anchorDesc = `${anchorDesc} plus 0.5×ATR buffer (${fmt(0.5 * atr)})`;
  }

  const distance_percent = (Math.abs(entryPrice - stop) / entryPrice) * 100;
  return {
    price: stop,
    distance_percent,
    reason:
      `stop ${fmt(stop)} placed beyond ${anchorDesc}` +
      (notes.length ? `; ${notes.join('; ')}` : ''),
  };
}

// ---------------------------------------------------------------------------
// Take-profit planning
// ---------------------------------------------------------------------------

/** Structure levels beyond entry in the trade direction, sorted nearest-first. */
function structureLevels(
  direction: 'LONG' | 'SHORT',
  ind: IndicatorSet,
  entryPrice: number,
  lastIndex: number,
  atr: number,
): number[] {
  const cands: number[] = [];
  if (direction === 'LONG') {
    const r = lastFinite(asSeries(ind.resistance));
    if (isFiniteNum(r) && r > entryPrice) cands.push(r);
    for (const p of closedSwings(ind.swingHighs, lastIndex)) {
      if (p.price > entryPrice) cands.push(p.price);
    }
  } else {
    const s = lastFinite(asSeries(ind.support));
    if (isFiniteNum(s) && s < entryPrice) cands.push(s);
    for (const p of closedSwings(ind.swingLows, lastIndex)) {
      if (p.price < entryPrice) cands.push(p.price);
    }
  }
  cands.sort((a, b) => (direction === 'LONG' ? a - b : b - a));
  // Dedupe levels closer than 0.05×ATR to avoid stacked identical targets.
  const tol = atr * 0.05;
  const out: number[] = [];
  for (const l of cands) {
    if (!out.length || Math.abs(l - out[out.length - 1]) > tol) out.push(l);
  }
  return out;
}

/** Most recent swing extreme in the trade direction (liquidity target). */
function recentSwingExtreme(
  direction: 'LONG' | 'SHORT',
  ind: IndicatorSet,
  entryPrice: number,
  lastIndex: number,
): number | undefined {
  const swings =
    direction === 'LONG'
      ? closedSwings(ind.swingHighs, lastIndex)
      : closedSwings(ind.swingLows, lastIndex);
  if (!swings.length) return undefined;
  const recent = swings.reduce((a, b) => (b.index > a.index ? b : a));
  const ok = direction === 'LONG' ? recent.price > entryPrice : recent.price < entryPrice;
  return ok ? recent.price : undefined;
}

export function planTakeProfits(
  direction: 'LONG' | 'SHORT',
  entryPrice: number,
  stopPrice: number,
  candles: Candle[],
  ind: IndicatorSet,
): { plan: TakeProfitPlan; rr: RiskReward } {
  const empty = (reasons: string[]): { plan: TakeProfitPlan; rr: RiskReward } => ({
    plan: { tp1: NaN, tp2: NaN, tp3: NaN, reasons },
    rr: { tp1: 0, tp2: 0, tp3: 0 },
  });
  if (!isFiniteNum(entryPrice) || !(entryPrice > 0)) {
    return empty(['fallback: invalid entry price']);
  }
  if (!isFiniteNum(stopPrice) || !(stopPrice > 0)) {
    return empty(['fallback: invalid stop price']);
  }
  const risk = Math.abs(entryPrice - stopPrice);
  if (!(risk > 0)) {
    return empty(['fallback: zero risk distance (stop equals entry)']);
  }
  if (!ind) {
    return empty(['fallback: no indicators for structure levels']);
  }
  const n = Array.isArray(candles) ? candles.length : 0;
  const lastIndex = n - 1;
  let atr = atrValue(ind, entryPrice);
  if (!isFiniteNum(atr) || atr <= 0) atr = entryPrice * 0.01;

  const reasons: string[] = [];
  let tp1: number;
  let tp2: number;
  let tp3: number;

  if (direction === 'LONG') {
    const levels = structureLevels('LONG', ind, entryPrice, lastIndex, atr);
    const l1 = levels.find((l) => l >= entryPrice + risk);
    tp1 = l1 !== undefined ? l1 : entryPrice + 1.5 * risk;
    reasons.push(
      l1 !== undefined
        ? `tp1 ${fmt(tp1)}: nearest resistance ≥1R (${fmt(risk)}) above entry`
        : `tp1 ${fmt(tp1)}: no resistance ≥1R; ATR projection 1.5R`,
    );
    const l2 = levels.find((l) => l > tp1);
    tp2 = l2 !== undefined ? l2 : entryPrice + 2.5 * risk;
    reasons.push(
      l2 !== undefined
        ? `tp2 ${fmt(tp2)}: next structure level above tp1`
        : `tp2 ${fmt(tp2)}: ATR projection 2.5R (no further structure)`,
    );
    const extreme = recentSwingExtreme('LONG', ind, entryPrice, lastIndex);
    tp3 = extreme !== undefined && extreme > tp2 ? extreme : entryPrice + 4 * risk;
    reasons.push(
      extreme !== undefined && extreme > tp2
        ? `tp3 ${fmt(tp3)}: liquidity target (recent swing high)`
        : `tp3 ${fmt(tp3)}: ATR projection 4R (no swing extreme beyond tp2)`,
    );
    // Ordering guarantee: tp1 < tp2 < tp3, all beyond entry.
    if (!(tp2 > tp1)) {
      tp2 = tp1 + 0.25 * risk;
      reasons[1] += ' (adjusted to keep tp2 > tp1)';
    }
    if (!(tp3 > tp2)) {
      tp3 = tp2 + 0.25 * risk;
      reasons[2] += ' (adjusted to keep tp3 > tp2)';
    }
  } else {
    const levels = structureLevels('SHORT', ind, entryPrice, lastIndex, atr);
    const l1 = levels.find((l) => l <= entryPrice - risk);
    tp1 = l1 !== undefined ? l1 : entryPrice - 1.5 * risk;
    reasons.push(
      l1 !== undefined
        ? `tp1 ${fmt(tp1)}: nearest support ≥1R (${fmt(risk)}) below entry`
        : `tp1 ${fmt(tp1)}: no support ≥1R; ATR projection 1.5R`,
    );
    const l2 = levels.find((l) => l < tp1);
    tp2 = l2 !== undefined ? l2 : entryPrice - 2.5 * risk;
    reasons.push(
      l2 !== undefined
        ? `tp2 ${fmt(tp2)}: next structure level below tp1`
        : `tp2 ${fmt(tp2)}: ATR projection 2.5R (no further structure)`,
    );
    const extreme = recentSwingExtreme('SHORT', ind, entryPrice, lastIndex);
    tp3 = extreme !== undefined && extreme < tp2 ? extreme : entryPrice - 4 * risk;
    reasons.push(
      extreme !== undefined && extreme < tp2
        ? `tp3 ${fmt(tp3)}: liquidity target (recent swing low)`
        : `tp3 ${fmt(tp3)}: ATR projection 4R (no swing extreme beyond tp2)`,
    );
    // Ordering guarantee: tp1 > tp2 > tp3, all beyond entry.
    if (!(tp2 < tp1)) {
      tp2 = tp1 - 0.25 * risk;
      reasons[1] += ' (adjusted to keep tp2 < tp1)';
    }
    if (!(tp3 < tp2)) {
      tp3 = tp2 - 0.25 * risk;
      reasons[2] += ' (adjusted to keep tp3 < tp2)';
    }
  }

  const r = riskReward(entryPrice, stopPrice, [tp1, tp2, tp3], direction);
  return {
    plan: { tp1, tp2, tp3, reasons },
    rr: { tp1: r[0], tp2: r[1], tp3: r[2] },
  };
}

// ---------------------------------------------------------------------------
// Risk/reward
// ---------------------------------------------------------------------------

/**
 * R-multiples per target: |target - entry| / |entry - stop|.
 * `direction` is kept for API symmetry; the absolute-value ratio is identical
 * for LONG and SHORT.
 */
export function riskReward(
  entry: number,
  stop: number,
  targets: number[],
  direction: 'LONG' | 'SHORT',
): number[] {
  void direction;
  const denom = Math.abs(entry - stop);
  if (!isFiniteNum(denom) || denom === 0) return targets.map(() => 0);
  return targets.map((t) => {
    if (!isFiniteNum(t) || !isFiniteNum(entry)) return 0;
    return Math.abs(t - entry) / denom;
  });
}

// ---------------------------------------------------------------------------
// Position sizing
// ---------------------------------------------------------------------------

/**
 * Fixed-fractional position sizing.
 *
 * risk_amount = balance * riskPercent / 100, then
 * quantity = risk_amount / |entry - stop|.
 *
 * Size NEVER scales with confidence or score: the only inputs are the
 * account risk budget and the stop distance. Leverage does NOT change
 * intended risk — it is passed through for margin accounting only.
 */
export function sizePosition(
  balance: number,
  riskPercent: number,
  entryPrice: number,
  stopPrice: number,
  leverage: number,
): PositionPlan {
  const bal = isFiniteNum(balance) && balance > 0 ? balance : 0;
  const rp = isFiniteNum(riskPercent) && riskPercent >= 0 ? riskPercent : 0;
  const risk_amount = (bal * rp) / 100;

  const riskPerUnit =
    isFiniteNum(entryPrice) && isFiniteNum(stopPrice) ? Math.abs(entryPrice - stopPrice) : NaN;

  let quantity = 0;
  if (isFiniteNum(riskPerUnit) && riskPerUnit > 0 && isFiniteNum(risk_amount) && risk_amount > 0) {
    quantity = risk_amount / riskPerUnit;
  }
  quantity = Math.round(quantity * 1e6) / 1e6;

  const notional = isFiniteNum(entryPrice) && entryPrice > 0 ? quantity * entryPrice : 0;
  const lev = isFiniteNum(leverage) && leverage >= 0 ? leverage : 0;

  return {
    risk_percent: rp,
    risk_amount,
    quantity,
    notional,
    leverage: lev,
  };
}

// ---------------------------------------------------------------------------
// Leverage selection
// ---------------------------------------------------------------------------

/**
 * Volatility- and regime-aware leverage cap.
 *
 * CONTRACT: returns 0 to mean NO_TRADE. When atrPct > 0.06 (extreme
 * volatility), selectLeverage returns 0 and the engine must NOT open a
 * position at any leverage — callers must treat 0 as "do not trade", not as
 * "1x" and never divide by it. Otherwise the result is clamped to
 * 1..config.maxLeverage and caps the margin leverage only; the intended
 * account risk (balance * riskPercent) is unchanged regardless of leverage.
 */
export function selectLeverage(
  atrPct: number,
  regime: MarketRegime,
  config: EngineConfig,
): number {
  const maxLev =
    config && isFiniteNum(config.maxLeverage) && config.maxLeverage >= 1
      ? Math.floor(config.maxLeverage)
      : 1;
  const base =
    config && isFiniteNum(config.baseLeverage) && config.baseLeverage >= 1
      ? config.baseLeverage
      : 1;
  const v = isFiniteNum(atrPct) && atrPct >= 0 ? atrPct : 0;

  // Extreme volatility -> NO_TRADE (0). Must be checked before the clamp
  // below so it is never normalized to 1.
  if (v > 0.06) return 0;

  let lev: number;
  if (v > 0.04 || regime === 'HIGH_VOLATILITY' || regime === 'POSSIBLE_MANIPULATION') {
    lev = 1;
  } else if (v > 0.02) {
    lev = Math.min(2, base);
  } else if (regime === 'LOW_VOLATILITY') {
    lev = Math.min(maxLev, base + 2);
  } else {
    lev = base;
  }
  return Math.min(maxLev, Math.max(1, lev));
}

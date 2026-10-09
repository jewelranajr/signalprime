/**
 * CryptoAI Pro — Master Signal Engine: technical indicators & market structure.
 *
 * Causality contract (applies to every function below):
 * - Every function is PURE: no I/O, no randomness, no hidden state.
 * - Every function is CAUSAL: the value reported at index i is computed only
 *   from input data at indices <= i. There is no look-ahead.
 * - Array outputs are aligned to the input candles by index; entries that
 *   cannot be computed from data available at that index are NaN.
 *
 * Fractal confirmation note: a k-fractal swing extreme at candle i is only
 * knowable once candle i+k has closed (both sides of the fractal are needed).
 * swingPoints() reports the extreme at its own index i, but consumers that
 * must act causally (detectBOS, detectCHoCH, detectLiquiditySweeps) only use
 * a swing at bar j when swing.index + k <= j.
 *
 * Event flags that describe what happened AFTER the event (FairValueGap.filled,
 * OrderBlock.mitigated, LiquiditySweep.reclaimed) are evaluated over the whole
 * supplied series. They are historical annotations, not causal signals; the
 * engine must only read them for bars that are fully in the past.
 *
 * Comments below describe the mathematics only.
 */

import type {
  Candle,
  IndicatorSet,
  SwingPoint,
  StructurePoint,
  BreakEvent,
  LiquiditySweep,
  FairValueGap,
  OrderBlock,
  MACDResult,
  ADXResult,
  BollingerResult,
} from './types';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const isFin = (v: number): boolean => Number.isFinite(v);

/** Last non-NaN value in the array, or NaN when there is none. */
export function lastFinite(values: number[]): number {
  if (!Array.isArray(values)) return NaN;
  for (let i = values.length - 1; i >= 0; i--) {
    if (isFin(values[i])) return values[i];
  }
  return NaN;
}

function allNaN(n: number): number[] {
  return new Array(Math.max(0, n)).fill(NaN);
}

function normPeriod(period: number): number {
  const p = Math.floor(period);
  return p >= 1 ? p : 0;
}

// ---------------------------------------------------------------------------
// Moving-average cores
// ---------------------------------------------------------------------------

/**
 * EMA core over a raw value array. Seeds with the SMA of the first `period`
 * consecutive finite values; if a non-finite value breaks the series, seeding
 * restarts at the next clean run. Multiplier k = 2 / (period + 1).
 */
function emaCore(vals: number[], period: number): number[] {
  const out = allNaN(vals.length);
  if (period < 1 || vals.length === 0) return out;
  const k = 2 / (period + 1);
  let prev = NaN;
  let consec = 0;
  let sum = 0;
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i];
    if (!isFin(v)) {
      prev = NaN;
      consec = 0;
      sum = 0;
      continue;
    }
    if (!isFin(prev)) {
      consec += 1;
      sum += v;
      if (consec === period) {
        prev = sum / period;
        out[i] = prev;
      }
      continue;
    }
    prev = v * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/**
 * Wilder's smoothing (RMA, alpha = 1 / period) over an aligned array that may
 * contain NaN. Seeds with the SMA of the first `period` consecutive finite
 * values, then applies prev * (period - 1) / period + value / period.
 */
function rmaCore(vals: number[], period: number): number[] {
  const out = allNaN(vals.length);
  if (period < 1 || vals.length === 0) return out;
  let prev = NaN;
  let consec = 0;
  let sum = 0;
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i];
    if (!isFin(v)) {
      prev = NaN;
      consec = 0;
      sum = 0;
      continue;
    }
    if (!isFin(prev)) {
      consec += 1;
      sum += v;
      if (consec === period) {
        prev = sum / period;
        out[i] = prev;
      }
      continue;
    }
    prev = (prev * (period - 1) + v) / period;
    out[i] = prev;
  }
  return out;
}

/**
 * EMA over an aligned series that may carry a NaN prefix (e.g. the MACD
 * line): compacts to the finite values, runs emaCore, maps back to the
 * original indices. Order-preserving, so still causal.
 */
function emaAligned(vals: number[], period: number): number[] {
  const out = allNaN(vals.length);
  const idx: number[] = [];
  const fin: number[] = [];
  for (let i = 0; i < vals.length; i++) {
    if (isFin(vals[i])) {
      idx.push(i);
      fin.push(vals[i]);
    }
  }
  const e = emaCore(fin, period);
  for (let j = 0; j < idx.length; j++) out[idx[j]] = e[j];
  return out;
}

/** Exponential moving average, seeded with the SMA of the first `period` values. */
export function ema(values: number[], period: number): number[] {
  if (!Array.isArray(values)) return [];
  return emaCore(values, normPeriod(period));
}

/** Simple moving average; NaN unless all `period` trailing values are finite. */
export function sma(values: number[], period: number): number[] {
  if (!Array.isArray(values)) return [];
  const p = normPeriod(period);
  const out = allNaN(values.length);
  if (p < 1) return out;
  let sum = 0;
  let cnt = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    const drop = i - p;
    if (drop >= 0) {
      const ov = values[drop];
      if (isFin(ov)) {
        sum -= ov;
        cnt -= 1;
      }
    }
    if (isFin(v)) {
      sum += v;
      cnt += 1;
    }
    if (i >= p - 1 && cnt === p) out[i] = sum / p;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Momentum
// ---------------------------------------------------------------------------

/** Wilder's RSI (default 14). Flat series yields 50; all-up yields 100. */
export function rsi(closes: number[], period = 14): number[] {
  if (!Array.isArray(closes)) return [];
  const p = normPeriod(period);
  const n = closes.length;
  const out = allNaN(n);
  if (p < 1) return out;
  const gains = allNaN(n);
  const losses = allNaN(n);
  for (let i = 1; i < n; i++) {
    const c = closes[i];
    const prev = closes[i - 1];
    if (!isFin(c) || !isFin(prev)) continue;
    const d = c - prev;
    gains[i] = d > 0 ? d : 0;
    losses[i] = d < 0 ? -d : 0;
  }
  const avgG = rmaCore(gains, p);
  const avgL = rmaCore(losses, p);
  for (let i = 0; i < n; i++) {
    if (!isFin(avgG[i]) || !isFin(avgL[i])) continue;
    if (avgL[i] === 0) {
      out[i] = avgG[i] === 0 ? 50 : 100;
    } else if (avgG[i] === 0) {
      out[i] = 0;
    } else {
      const rs = avgG[i] / avgL[i];
      out[i] = 100 - 100 / (1 + rs);
    }
  }
  return out;
}

/** MACD (defaults 12, 26, 9): macdLine = EMA(fast) - EMA(slow). */
export function macd(
  closes: number[],
  fast = 12,
  slow = 26,
  signal = 9,
): MACDResult {
  if (!Array.isArray(closes)) return { macdLine: [], signalLine: [], histogram: [] };
  const n = closes.length;
  const f = emaCore(closes, normPeriod(fast));
  const s = emaCore(closes, normPeriod(slow));
  const macdLine = allNaN(n);
  for (let i = 0; i < n; i++) {
    if (isFin(f[i]) && isFin(s[i])) macdLine[i] = f[i] - s[i];
  }
  const signalLine = emaAligned(macdLine, normPeriod(signal));
  const histogram = allNaN(n);
  for (let i = 0; i < n; i++) {
    if (isFin(macdLine[i]) && isFin(signalLine[i])) histogram[i] = macdLine[i] - signalLine[i];
  }
  return { macdLine, signalLine, histogram };
}

// ---------------------------------------------------------------------------
// Volatility
// ---------------------------------------------------------------------------

function trueRange(c: Candle, prev: Candle): number {
  if (
    !isFin(c.high) || !isFin(c.low) || !isFin(c.close) ||
    !isFin(prev.high) || !isFin(prev.low) || !isFin(prev.close)
  ) {
    return NaN;
  }
  return Math.max(
    c.high - c.low,
    Math.abs(c.high - prev.close),
    Math.abs(c.low - prev.close),
  );
}

/** ATR with Wilder's smoothing of the true range (default 14). */
export function atr(candles: Candle[], period = 14): number[] {
  if (!Array.isArray(candles)) return [];
  const p = normPeriod(period);
  const n = candles.length;
  const tr = allNaN(n);
  for (let i = 1; i < n; i++) tr[i] = trueRange(candles[i], candles[i - 1]);
  return rmaCore(tr, p);
}

/**
 * ADX with Wilder's smoothing (default 14).
 * +DI / -DI from smoothed directional movement over smoothed TR;
 * DX = 100 * |+DI - -DI| / (+DI + -DI); ADX = Wilder's smoothing of DX,
 * seeded with the SMA of the first `period` DX values.
 */
export function adx(candles: Candle[], period = 14): ADXResult {
  if (!Array.isArray(candles)) return { adx: [], plusDI: [], minusDI: [] };
  const p = normPeriod(period);
  const n = candles.length;
  const plusDI = allNaN(n);
  const minusDI = allNaN(n);
  const adxOut = allNaN(n);
  if (p < 1 || n < 2) return { adx: adxOut, plusDI, minusDI };

  const tr = allNaN(n);
  const pDM = allNaN(n);
  const mDM = allNaN(n);
  for (let i = 1; i < n; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    if (
      !isFin(c.high) || !isFin(c.low) || !isFin(c.close) ||
      !isFin(prev.high) || !isFin(prev.low) || !isFin(prev.close)
    ) {
      continue;
    }
    const up = c.high - prev.high;
    const down = prev.low - c.low;
    pDM[i] = up > down && up > 0 ? up : 0;
    mDM[i] = down > up && down > 0 ? down : 0;
    tr[i] = Math.max(
      c.high - c.low,
      Math.abs(c.high - prev.close),
      Math.abs(c.low - prev.close),
    );
  }

  const sTR = rmaCore(tr, p);
  const sP = rmaCore(pDM, p);
  const sM = rmaCore(mDM, p);
  const dx = allNaN(n);
  for (let i = 0; i < n; i++) {
    if (!isFin(sTR[i]) || sTR[i] <= 0 || !isFin(sP[i]) || !isFin(sM[i])) continue;
    const pdi = (100 * sP[i]) / sTR[i];
    const mdi = (100 * sM[i]) / sTR[i];
    plusDI[i] = pdi;
    minusDI[i] = mdi;
    const sum = pdi + mdi;
    dx[i] = sum > 0 ? (100 * Math.abs(pdi - mdi)) / sum : 0;
  }
  const adxVals = rmaCore(dx, p);
  for (let i = 0; i < n; i++) adxOut[i] = adxVals[i];
  return { adx: adxOut, plusDI, minusDI };
}

/**
 * Rolling typical-price VWAP over a fixed trailing window (default 48).
 * typical = (high + low + close) / 3; VWAP = sum(typical * volume) / sum(volume).
 * Entries before the window fills, or with non-positive / non-finite volume,
 * are NaN.
 */
export function vwap(candles: Candle[], window = 48): number[] {
  if (!Array.isArray(candles)) return [];
  const w = Math.max(1, Math.floor(window));
  const n = candles.length;
  const out = allNaN(n);
  let sumPV = 0;
  let sumV = 0;
  let bad = 0; // bars inside the window with unusable data

  const usable = (c: Candle): boolean =>
    isFin(c.high) && isFin(c.low) && isFin(c.close) && isFin(c.volume) && c.volume >= 0;

  for (let i = 0; i < n; i++) {
    const c = candles[i];
    if (usable(c)) {
      const tp = (c.high + c.low + c.close) / 3;
      sumPV += tp * c.volume;
      sumV += c.volume;
    } else {
      bad += 1;
    }
    const drop = i - w;
    if (drop >= 0) {
      const o = candles[drop];
      if (usable(o)) {
        const tp = (o.high + o.low + o.close) / 3;
        sumPV -= tp * o.volume;
        sumV -= o.volume;
      } else {
        bad -= 1;
      }
    }
    if (i >= w - 1 && bad === 0 && sumV > 0) out[i] = sumPV / sumV;
  }
  return out;
}

/**
 * Bollinger Bands (defaults 20, 2) with population standard deviation.
 * %B = (close - lower) / (upper - lower); bandwidth = (upper - lower) / |middle|.
 */
export function bollinger(
  closes: number[],
  period = 20,
  mult = 2,
): BollingerResult {
  if (!Array.isArray(closes)) {
    return { upper: [], middle: [], lower: [], bandwidth: [], percentB: [] };
  }
  const p = normPeriod(period);
  const m = Number.isFinite(mult) ? mult : 2;
  const n = closes.length;
  const upper = allNaN(n);
  const middle = allNaN(n);
  const lower = allNaN(n);
  const bandwidth = allNaN(n);
  const percentB = allNaN(n);
  if (p < 1) return { upper, middle, lower, bandwidth, percentB };

  let sum = 0;
  let sumSq = 0;
  let cnt = 0;
  for (let i = 0; i < n; i++) {
    const v = closes[i];
    const drop = i - p;
    if (drop >= 0) {
      const ov = closes[drop];
      if (isFin(ov)) {
        sum -= ov;
        sumSq -= ov * ov;
        cnt -= 1;
      }
    }
    if (isFin(v)) {
      sum += v;
      sumSq += v * v;
      cnt += 1;
    }
    if (i >= p - 1 && cnt === p) {
      const mean = sum / p;
      let variance = sumSq / p - mean * mean;
      if (variance < 0) variance = 0; // float guard
      const sd = Math.sqrt(variance);
      const up = mean + m * sd;
      const lo = mean - m * sd;
      middle[i] = mean;
      upper[i] = up;
      lower[i] = lo;
      bandwidth[i] = mean !== 0 ? (up - lo) / Math.abs(mean) : NaN;
      percentB[i] = up !== lo ? (v - lo) / (up - lo) : NaN;
    }
  }
  return { upper, middle, lower, bandwidth, percentB };
}

// ---------------------------------------------------------------------------
// Volume
// ---------------------------------------------------------------------------

/** True when volume[index] exceeds mult * volumeSMA[index] (default 1.5). */
export function volumeSpike(
  volume: number[],
  volumeSMA: number[],
  index: number,
  mult = 1.5,
): boolean {
  if (!Array.isArray(volume) || !Array.isArray(volumeSMA)) return false;
  if (!Number.isInteger(index) || index < 0) return false;
  if (index >= volume.length || index >= volumeSMA.length) return false;
  const v = volume[index];
  const s = volumeSMA[index];
  const mm = Number.isFinite(mult) && mult > 0 ? mult : 1.5;
  return isFin(v) && isFin(s) && s > 0 && v > mm * s;
}

// ---------------------------------------------------------------------------
// Swings & structure
// ---------------------------------------------------------------------------

/**
 * k-fractal swing points (default k=2): candle i is a swing high when
 * high[i] is strictly greater than every high in [i-k, i+k] (mirror for lows).
 * Reported at the extreme's own index; only knowable once candle i+k closes.
 */
export function swingPoints(
  candles: Candle[],
  k = 2,
): { highs: SwingPoint[]; lows: SwingPoint[] } {
  const highs: SwingPoint[] = [];
  const lows: SwingPoint[] = [];
  if (!Array.isArray(candles)) return { highs, lows };
  const kk = Math.max(1, Math.floor(k));
  const n = candles.length;
  for (let i = kk; i <= n - 1 - kk; i++) {
    const c = candles[i];
    if (!isFin(c.high) || !isFin(c.low)) continue;
    let isHigh = true;
    let isLow = true;
    for (let j = i - kk; j <= i + kk; j++) {
      if (j === i) continue;
      const o = candles[j];
      if (!isFin(o.high) || !isFin(o.low)) {
        isHigh = false;
        isLow = false;
        break;
      }
      if (o.high >= c.high) isHigh = false;
      if (o.low <= c.low) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) highs.push({ index: i, price: c.high, time: c.closeTime });
    if (isLow) lows.push({ index: i, price: c.low, time: c.closeTime });
  }
  return { highs, lows };
}

/**
 * Support/resistance from clustered swing highs/lows over the trailing
 * `lookback` candles (default 200). Swings within 0.5 * ATR of each other form
 * one level; levels need >= 2 touches. Support = levels below the last close,
 * resistance = levels above it; each sorted nearest-first, up to 5.
 */
export function supportResistance(
  candles: Candle[],
  atrVals: number[],
  lookback = 200,
): { support: number[]; resistance: number[] } {
  const support: number[] = [];
  const resistance: number[] = [];
  if (!Array.isArray(candles) || candles.length === 0) return { support, resistance };
  const n = candles.length;
  const lb = Math.max(1, Math.floor(lookback));
  const start = Math.max(0, n - lb);

  const { highs, lows } = swingPoints(candles, 2);
  const prices = [...highs, ...lows]
    .filter((p) => p.index >= start && isFin(p.price))
    .map((p) => p.price)
    .sort((a, b) => a - b);

  const baseAtr = lastFinite(Array.isArray(atrVals) ? atrVals : []);
  const tol = isFin(baseAtr) && baseAtr > 0 ? 0.5 * baseAtr : 0;

  // Greedy clustering over ascending prices; cluster value = running mean.
  const clusters: { sum: number; count: number }[] = [];
  for (const p of prices) {
    const last = clusters[clusters.length - 1];
    if (last && Math.abs(p - last.sum / last.count) <= tol) {
      last.sum += p;
      last.count += 1;
    } else {
      clusters.push({ sum: p, count: 1 });
    }
  }
  const levels = clusters
    .filter((c) => c.count >= 2)
    .map((c) => c.sum / c.count);

  const lastClose = candles[n - 1].close;
  if (!isFin(lastClose)) return { support, resistance };
  const byDistance = (a: number, b: number) =>
    Math.abs(a - lastClose) - Math.abs(b - lastClose);
  for (const l of levels.filter((l) => l < lastClose).sort(byDistance).slice(0, 5)) {
    support.push(l);
  }
  for (const l of levels.filter((l) => l > lastClose).sort(byDistance).slice(0, 5)) {
    resistance.push(l);
  }
  return { support, resistance };
}

/**
 * Labels swing highs/lows in chronological order: a swing high above the
 * previous swing high is 'HH', otherwise 'LH'; a swing low above the previous
 * swing low is 'HL', otherwise 'LL'. The first swing high defaults to 'HH'
 * and the first swing low to 'HL'.
 */
export function marketStructure(candles: Candle[]): StructurePoint[] {
  if (!Array.isArray(candles)) return [];
  const { highs, lows } = swingPoints(candles, 2);
  const merged = [
    ...highs.map((h) => ({ ...h, kind: 'H' as const })),
    ...lows.map((l) => ({ ...l, kind: 'L' as const })),
  ].sort((a, b) => a.index - b.index || (a.kind === 'H' ? -1 : 1));

  const out: StructurePoint[] = [];
  let prevHigh = NaN;
  let prevLow = NaN;
  for (const p of merged) {
    if (p.kind === 'H') {
      const label = !isFin(prevHigh) ? 'HH' : p.price > prevHigh ? 'HH' : 'LH';
      prevHigh = p.price;
      out.push({ index: p.index, price: p.price, time: p.time, label });
    } else {
      const label = !isFin(prevLow) ? 'HL' : p.price > prevLow ? 'HL' : 'LL';
      prevLow = p.price;
      out.push({ index: p.index, price: p.price, time: p.time, label });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Breaks, sweeps, gaps, order blocks
// ---------------------------------------------------------------------------

/**
 * Break of structure: tracks the latest confirmed (index + 2 <= i) swing high
 * and low. An UP event fires at bar i when close[i] is above the tracked high
 * unless price was already above that same level on the previous bar; mirror
 * logic for DOWN. Firing on a newly confirmed level that price already exceeds
 * keeps breakouts detectable despite the fractal confirmation delay, while
 * the same-level guard prevents repeat events. volumeConfirmed comes from
 * volumeSpike() at the break bar.
 */
export function detectBOS(
  candles: Candle[],
  volume: number[],
  volumeSMA: number[],
): BreakEvent[] {
  const events: BreakEvent[] = [];
  if (!Array.isArray(candles)) return events;
  const n = candles.length;
  const { highs, lows } = swingPoints(candles, 2);
  let hi = 0;
  let lo = 0;
  let lastHigh = NaN;
  let lastLow = NaN;

  for (let i = 0; i < n; i++) {
    const prevHighLevel = lastHigh;
    const prevLowLevel = lastLow;
    while (hi < highs.length && highs[hi].index + 2 <= i) {
      lastHigh = highs[hi].price;
      hi += 1;
    }
    while (lo < lows.length && lows[lo].index + 2 <= i) {
      lastLow = lows[lo].price;
      lo += 1;
    }
    const c = candles[i];
    if (!isFin(c.close)) continue;
    const prevClose = i > 0 ? candles[i - 1].close : NaN;
    if (isFin(lastHigh) && c.close > lastHigh) {
      const alreadyAbove =
        isFin(prevHighLevel) &&
        prevHighLevel === lastHigh &&
        isFin(prevClose) &&
        prevClose > lastHigh;
      if (!alreadyAbove) {
        events.push({
          index: i,
          time: c.closeTime,
          price: c.close,
          brokenLevel: lastHigh,
          direction: 'UP',
          volumeConfirmed: volumeSpike(volume, volumeSMA, i),
        });
      }
    }
    if (isFin(lastLow) && c.close < lastLow) {
      const alreadyBelow =
        isFin(prevLowLevel) &&
        prevLowLevel === lastLow &&
        isFin(prevClose) &&
        prevClose < lastLow;
      if (!alreadyBelow) {
        events.push({
          index: i,
          time: c.closeTime,
          price: c.close,
          brokenLevel: lastLow,
          direction: 'DOWN',
          volumeConfirmed: volumeSpike(volume, volumeSMA, i),
        });
      }
    }
  }
  return events;
}

/**
 * Change of character: a BOS event whose direction opposes the trend implied
 * by the last two confirmed structure labels (HH/HL pair = uptrend,
 * LH/LL pair = downtrend; mixed pairs imply no clear trend and are skipped).
 */
export function detectCHoCH(
  candles: Candle[],
  structure: StructurePoint[],
  volume: number[],
  volumeSMA: number[],
): BreakEvent[] {
  const out: BreakEvent[] = [];
  if (!Array.isArray(candles) || !Array.isArray(structure)) return out;
  const bos = detectBOS(candles, volume, volumeSMA);
  const bullish = (l: string): boolean => l === 'HH' || l === 'HL';
  const bearish = (l: string): boolean => l === 'LH' || l === 'LL';
  for (const e of bos) {
    // Only structure confirmed (index + 2) at or before the break bar.
    const confirmed = structure.filter((s) => s.index + 2 <= e.index);
    if (confirmed.length < 2) continue;
    const a = confirmed[confirmed.length - 2].label;
    const b = confirmed[confirmed.length - 1].label;
    const uptrend = bullish(a) && bullish(b);
    const downtrend = bearish(a) && bearish(b);
    if ((uptrend && e.direction === 'DOWN') || (downtrend && e.direction === 'UP')) {
      out.push(e);
    }
  }
  return out;
}

/**
 * Liquidity sweeps: a candle whose wick extends beyond a confirmed swing
 * level (within `lookback` bars, default 200) but closes back inside it.
 * BUY_SIDE = wick above a swing high; SELL_SIDE = wick below a swing low.
 * reclaimed = a later candle closed back through the swept level. One event
 * per swing level (the first sweep).
 */
export function detectLiquiditySweeps(
  candles: Candle[],
  lookback = 200,
): LiquiditySweep[] {
  const out: LiquiditySweep[] = [];
  if (!Array.isArray(candles)) return out;
  const n = candles.length;
  const lb = Math.max(1, Math.floor(lookback));
  const { highs, lows } = swingPoints(candles, 2);
  const swept = new Set<string>();

  const laterCloseThrough = (from: number, level: number, above: boolean): boolean => {
    for (let j = from; j < n; j++) {
      const cj = candles[j].close;
      if (!isFin(cj)) continue;
      if (above ? cj > level : cj < level) return true;
    }
    return false;
  };

  for (let i = 0; i < n; i++) {
    const c = candles[i];
    if (!isFin(c.high) || !isFin(c.low) || !isFin(c.close)) continue;
    for (const h of highs) {
      if (h.index + 2 > i || i - h.index > lb) continue;
      const key = `H${h.index}`;
      if (swept.has(key)) continue;
      if (c.high > h.price && c.close < h.price) {
        swept.add(key);
        out.push({
          index: i,
          time: c.closeTime,
          side: 'BUY_SIDE',
          sweptLevel: h.price,
          wicked: true,
          reclaimed: laterCloseThrough(i + 1, h.price, true),
        });
      }
    }
    for (const l of lows) {
      if (l.index + 2 > i || i - l.index > lb) continue;
      const key = `L${l.index}`;
      if (swept.has(key)) continue;
      if (c.low < l.price && c.close > l.price) {
        swept.add(key);
        out.push({
          index: i,
          time: c.closeTime,
          side: 'SELL_SIDE',
          sweptLevel: l.price,
          wicked: true,
          reclaimed: laterCloseThrough(i + 1, l.price, false),
        });
      }
    }
  }
  return out;
}

/**
 * Fair value gaps (3-candle imbalance): bullish when low[i] > high[i-2]
 * (gap zone [high[i-2], low[i]]), bearish when high[i] < low[i-2]
 * (gap zone [high[i], low[i-2]]). filled = a later candle closed through the
 * far side of the gap zone.
 */
export function detectFVG(candles: Candle[]): FairValueGap[] {
  const out: FairValueGap[] = [];
  if (!Array.isArray(candles)) return out;
  const n = candles.length;
  for (let i = 2; i < n; i++) {
    const a = candles[i - 2];
    const c = candles[i];
    if (
      !isFin(a.high) || !isFin(a.low) ||
      !isFin(c.high) || !isFin(c.low) || !isFin(c.close)
    ) {
      continue;
    }
    if (c.low > a.high) {
      const top = c.low;
      const bottom = a.high;
      let filled = false;
      for (let j = i + 1; j < n; j++) {
        const cj = candles[j].close;
        if (isFin(cj) && cj <= bottom) {
          filled = true;
          break;
        }
      }
      out.push({ index: i, time: c.closeTime, top, bottom, direction: 'BULLISH', filled });
    } else if (c.high < a.low) {
      const top = a.low;
      const bottom = c.high;
      let filled = false;
      for (let j = i + 1; j < n; j++) {
        const cj = candles[j].close;
        if (isFin(cj) && cj >= top) {
          filled = true;
          break;
        }
      }
      out.push({ index: i, time: c.closeTime, top, bottom, direction: 'BEARISH', filled });
    }
  }
  return out;
}

/**
 * Order blocks: ONLY around volume-confirmed BOS events. The zone is the last
 * opposite-direction candle (up to 5 bars back) before the impulse leg into
 * the break — the last bearish candle for an UP break, the last bullish
 * candle for a DOWN break. mitigated = later price traded through the far
 * edge of the zone.
 */
export function detectOrderBlocks(candles: Candle[], bos: BreakEvent[]): OrderBlock[] {
  const out: OrderBlock[] = [];
  if (!Array.isArray(candles) || !Array.isArray(bos)) return out;
  const n = candles.length;
  for (const e of bos) {
    if (!e || e.volumeConfirmed !== true) continue;
    const i = e.index;
    if (!Number.isInteger(i) || i < 1 || i >= n) continue;
    const up = e.direction === 'UP';
    let zone = -1;
    for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
      const c = candles[j];
      if (!isFin(c.open) || !isFin(c.close)) continue;
      const bearish = c.close < c.open;
      const bullish = c.close > c.open;
      if ((up && bearish) || (!up && bullish)) {
        zone = j;
        break;
      }
    }
    if (zone < 0) continue;
    const z = candles[zone];
    if (!isFin(z.high) || !isFin(z.low)) continue;
    const top = z.high;
    const bottom = z.low;
    let mitigated = false;
    if (up) {
      for (let k = i + 1; k < n; k++) {
        const lk = candles[k].low;
        if (isFin(lk) && lk <= bottom) {
          mitigated = true;
          break;
        }
      }
      out.push({ index: zone, time: z.closeTime, top, bottom, direction: 'BULLISH', mitigated });
    } else {
      for (let k = i + 1; k < n; k++) {
        const hk = candles[k].high;
        if (isFin(hk) && hk >= top) {
          mitigated = true;
          break;
        }
      }
      out.push({ index: zone, time: z.closeTime, top, bottom, direction: 'BEARISH', mitigated });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/**
 * Builds the full IndicatorSet for one candle series. Never throws:
 * short or empty series yield NaN-filled arrays and empty event lists.
 */
export function computeIndicators(candles: Candle[]): IndicatorSet {
  const cs = Array.isArray(candles) ? candles : [];
  const closes = cs.map((c) => c.close);
  const volumes = cs.map((c) => c.volume);

  const volumeSMA = sma(volumes, 20);
  const atrVals = atr(cs, 14);
  const { support, resistance } = supportResistance(cs, atrVals, 200);
  const { highs: swingHighs, lows: swingLows } = swingPoints(cs, 2);
  const structure = marketStructure(cs);
  const bos = detectBOS(cs, volumes, volumeSMA);
  const choch = detectCHoCH(cs, structure, volumes, volumeSMA);

  return {
    ema20: ema(closes, 20),
    ema50: ema(closes, 50),
    ema100: ema(closes, 100),
    ema200: ema(closes, 200),
    rsi: rsi(closes, 14),
    macd: macd(closes, 12, 26, 9),
    atr: atrVals,
    adx: adx(cs, 14),
    vwap: vwap(cs, 48),
    bollinger: bollinger(closes, 20, 2),
    volumeSMA,
    support,
    resistance,
    swingHighs,
    swingLows,
    structure,
    bos,
    choch,
    liquiditySweeps: detectLiquiditySweeps(cs, 200),
    fvg: detectFVG(cs),
    orderBlocks: detectOrderBlocks(cs, bos),
  };
}

/**
 * CryptoAI Pro — Master Signal Engine: multi-timeframe engine + market regime detection.
 *
 * Causal by construction: every decision reads only the last available
 * (already-closed) indicator values via `lastFinite` — never future data.
 *
 * Scores, biases and regimes are descriptive summaries of observed evidence,
 * used to gate entries under strict NO_TRADE discipline. They describe what
 * the market has done, not what it will do; nothing here implies or estimates
 * guaranteed accuracy.
 */

import type { Candle, Timeframe, IndicatorSet, MTFAnalysis, TimeframeView, TFBias, RegimeDetection, MarketRegime } from './types';
import { MTF_WEIGHTS, TIMEFRAMES } from './types';
import { computeIndicators, lastFinite } from './indicators';

// ---------------------------------------------------------------------------
// Internal utilities (causal-safe: they only read already-known values)
// ---------------------------------------------------------------------------

const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v));

const round2 = (v: number): number => Math.round(v * 100) / 100;

/**
 * Defensive wrapper around the documented `lastFinite` helper: returns the
 * last finite value of a series, or NaN when none is available. Never throws,
 * so edge inputs (empty / missing arrays) degrade to neutral instead of
 * crashing the engine.
 */
function lf(values: number[] | undefined | null): number {
  if (!Array.isArray(values) || values.length === 0) return NaN;
  try {
    const v = lastFinite(values);
    return typeof v === 'number' ? v : NaN;
  } catch {
    return NaN;
  }
}

function scoreToBias(score: number): TFBias {
  if (score > 15) return 'BULLISH';
  if (score < -15) return 'BEARISH';
  return 'NEUTRAL';
}

/** Weighted-majority bias; ties resolve to NEUTRAL (no false conviction). */
function weightedMajorityBias(views: TimeframeView[]): TFBias {
  const totals: Record<TFBias, number> = { BULLISH: 0, BEARISH: 0, NEUTRAL: 0 };
  for (const v of views) totals[v.bias] += v.weight;
  const max = Math.max(totals.BULLISH, totals.BEARISH, totals.NEUTRAL);
  const winners = (['BULLISH', 'BEARISH', 'NEUTRAL'] as TFBias[]).filter(
    (b) => totals[b] === max,
  );
  return winners.length === 1 ? winners[0] : 'NEUTRAL';
}

function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Rank of v within values, 0..1 (NaN when unavailable). */
function percentileRank(values: number[], v: number): number {
  if (!Number.isFinite(v) || values.length === 0) return NaN;
  let le = 0;
  for (const x of values) if (x <= v) le++;
  return le / values.length;
}

// ---------------------------------------------------------------------------
// Per-timeframe bias / score
// ---------------------------------------------------------------------------

/**
 * Score one timeframe from its candles and precomputed indicators.
 * Sums independent evidence components, clamps to -100..+100, and maps to a
 * bias via the +/-15 deadband. Returns NEUTRAL / 0 when fewer than 50 bars
 * are available (not enough history for the slower indicators).
 */
export function analyzeTimeframe(tf: Timeframe, candles: Candle[], ind: IndicatorSet): TimeframeView {
  const weight = MTF_WEIGHTS[tf] ?? 0;
  const neutralView = (rsi = NaN, adx = NaN): TimeframeView => ({
    timeframe: tf,
    bias: 'NEUTRAL',
    score: 0,
    weight,
    emaBullish: false,
    rsi,
    adx,
  });
  if (!Array.isArray(candles) || candles.length < 50 || !ind) return neutralView();

  const lastCandle = candles[candles.length - 1];
  const close = lastCandle && Number.isFinite(lastCandle.close) ? lastCandle.close : NaN;

  const e20 = lf(ind.ema20);
  const e50 = lf(ind.ema50);
  const e100 = lf(ind.ema100);
  const e200 = lf(ind.ema200);
  const rsi = lf(ind.rsi);
  const macdHist = lf(ind.macd?.histogram);
  const adx = lf(ind.adx?.adx);
  const plusDI = lf(ind.adx?.plusDI);
  const minusDI = lf(ind.adx?.minusDI);
  const vwap = lf(ind.vwap);

  let score = 0;

  // 1. EMA alignment: full stack dominates; otherwise fall back to 20/50 only.
  const fullStack = [e20, e50, e100, e200].every(Number.isFinite);
  if (fullStack) {
    if (e20 > e50 && e50 > e100 && e100 > e200) score += 40;
    else if (e20 < e50 && e50 < e100 && e100 < e200) score -= 40;
    else if (e20 > e50) score += 15;
    else if (e20 < e50) score -= 15;
  } else if (Number.isFinite(e20) && Number.isFinite(e50)) {
    if (e20 > e50) score += 15;
    else if (e20 < e50) score -= 15;
  }

  // 2. Price vs EMA50 (trend filter).
  if (Number.isFinite(close) && Number.isFinite(e50)) {
    if (close > e50) score += 10;
    else if (close < e50) score -= 10;
  }

  // 3. RSI momentum. Overbought (>70) / oversold (<30) add a small extra push,
  // but total RSI contribution is capped at +/-15 so one oscillator reading
  // cannot dominate the score.
  if (Number.isFinite(rsi)) {
    let rsiScore = 0;
    if (rsi > 55) rsiScore = 10;
    else if (rsi < 45) rsiScore = -10;
    if (rsi > 70) rsiScore += 5; // overbought extension, still capped below
    else if (rsi < 30) rsiScore -= 5; // oversold extension, still capped below
    score += clamp(rsiScore, -15, 15);
  }

  // 4. MACD histogram momentum.
  if (Number.isFinite(macdHist)) {
    if (macdHist > 0) score += 10;
    else if (macdHist < 0) score -= 10;
  }

  // 5. ADX > 25 strengthens the score in the direction of the DI cross.
  if (
    Number.isFinite(adx) && adx > 25 &&
    Number.isFinite(plusDI) && Number.isFinite(minusDI)
  ) {
    if (plusDI > minusDI) score += 10;
    else if (minusDI > plusDI) score -= 10;
  }

  // 6. Price vs session VWAP (intraday value reference).
  if (Number.isFinite(close) && Number.isFinite(vwap)) {
    if (close > vwap) score += 10;
    else if (close < vwap) score -= 10;
  }

  // 7. Market structure: the last two completed swing labels must agree.
  const labels = (ind.structure ?? [])
    .filter((p) => p && typeof p.label === 'string')
    .map((p) => p.label);
  const lastTwo = labels.slice(-2);
  if (lastTwo.length === 2) {
    const bullish = (l: string) => l === 'HH' || l === 'HL';
    const bearish = (l: string) => l === 'LH' || l === 'LL';
    if (lastTwo.every(bullish)) score += 10;
    else if (lastTwo.every(bearish)) score -= 10;
  }

  // ADX < 20: no meaningful trend — dampen the whole score toward 0.
  if (Number.isFinite(adx) && adx < 20) score *= 0.5;

  score = clamp(round2(score), -100, 100);

  return {
    timeframe: tf,
    bias: scoreToBias(score),
    score,
    weight,
    emaBullish: Number.isFinite(e20) && Number.isFinite(e50) ? e20 > e50 : false,
    rsi,
    adx,
  };
}

// ---------------------------------------------------------------------------
// Multi-timeframe aggregation
// ---------------------------------------------------------------------------

/**
 * Aggregate per-timeframe views into one MTF read.
 *
 * - Each TF keeps its MTF_WEIGHTS weight (1d=15%, 4h=25%, 1h=25%, 15m=20%,
 *   5m=15%, 1m=0). TFs with no candles are skipped and their weight is
 *   redistributed over the available TFs via the weighted average.
 * - The 1m view is entry timing only: a non-neutral 1m read nudges the 5m
 *   score by 20% of the 1m score instead of voting on its own.
 * - confirmsLong/confirmsShort are hard-gated against the higher-timeframe
 *   bias: a BEARISH HTF vetoes long confirmation and vice versa, so a stack
 *   of low-TF long scores can never confirm against a strongly opposing HTF.
 */
export function analyzeMTF(
  candles: Record<Timeframe, Candle[]>,
  indicators: Record<Timeframe, IndicatorSet>,
): MTFAnalysis {
  const views = {} as Record<Timeframe, TimeframeView>;
  const available: Timeframe[] = [];

  for (const tf of TIMEFRAMES) {
    const c = candles?.[tf];
    const ind = indicators?.[tf];
    if (Array.isArray(c) && c.length > 0 && ind) {
      views[tf] = analyzeTimeframe(tf, c, ind);
      available.push(tf);
    } else {
      // Skipped TF: neutral, zero weight, excluded from all aggregates.
      views[tf] = {
        timeframe: tf,
        bias: 'NEUTRAL',
        score: 0,
        weight: 0,
        emaBullish: false,
        rsi: NaN,
        adx: NaN,
      };
    }
  }

  // Fold 1m evidence into 5m (1m itself carries zero MTF weight).
  const v1m = views['1m'];
  const v5m = views['5m'];
  if (available.includes('1m') && available.includes('5m') && v1m.bias !== 'NEUTRAL') {
    v5m.score = clamp(round2(v5m.score + 0.2 * v1m.score), -100, 100);
    v5m.bias = scoreToBias(v5m.score);
  }

  let weightSum = 0;
  let weightedSum = 0;
  for (const tf of available) {
    const w = views[tf].weight;
    weightSum += w;
    weightedSum += views[tf].score * w;
  }
  const weightedScore = weightSum > 0 ? round2(weightedSum / weightSum) : 0;

  // Higher-timeframe bias: weighted majority of 1d + 4h, falling back to 1h.
  const htfTFs = (['1d', '4h'] as Timeframe[]).filter((tf) => available.includes(tf));
  let htfBias: TFBias;
  if (htfTFs.length > 0) {
    htfBias = weightedMajorityBias(htfTFs.map((tf) => views[tf]));
  } else if (available.includes('1h')) {
    htfBias = views['1h'].bias;
  } else {
    htfBias = 'NEUTRAL';
  }

  // Agreement: share of available weight aligned with the dominant bias.
  const dominant =
    available.length > 0
      ? weightedMajorityBias(available.map((tf) => views[tf]))
      : 'NEUTRAL';
  let dominantWeight = 0;
  for (const tf of available) {
    if (views[tf].bias === dominant) dominantWeight += views[tf].weight;
  }
  const agreement = weightSum > 0 ? round2((dominantWeight / weightSum) * 100) : 0;

  // HTF-against-trade guard: never confirm a direction the HTF opposes.
  const confirmsLong = weightedScore > 20 && htfBias !== 'BEARISH';
  const confirmsShort = weightedScore < -20 && htfBias !== 'BULLISH';

  return { views, weightedScore, htfBias, agreement, confirmsLong, confirmsShort };
}

// ---------------------------------------------------------------------------
// Market regime detection (primary timeframe, typically 1h)
// ---------------------------------------------------------------------------

/**
 * Classify the current market regime from the latest causal evidence.
 * Decision order is fixed: manipulation and volatility extremes are checked
 * first, then trend strength, then break events, then range/accumulation
 * patterns, defaulting to SIDEWAYS. Every check uses only data at or before
 * the last closed bar. Returns a regime plus the top evidence strings.
 */
export function detectRegime(candles: Candle[], ind: IndicatorSet): RegimeDetection {
  const sideways = (notes: string[]): RegimeDetection => {
    const regime: MarketRegime = 'SIDEWAYS';
    return { regime, notes };
  };
  if (!Array.isArray(candles) || candles.length === 0 || !ind) {
    return sideways(['insufficient data for regime classification']);
  }
  if (candles.length < 50) {
    return sideways(['insufficient data for regime classification (< 50 bars)']);
  }

  const n = candles.length;
  const lastIdx = n - 1;
  const last = candles[lastIdx];
  const close = last && Number.isFinite(last.close) ? last.close : NaN;
  const lastRange =
    last && Number.isFinite(last.high) && Number.isFinite(last.low)
      ? last.high - last.low
      : NaN;

  const atr = lf(ind.atr);
  const adx = lf(ind.adx?.adx);
  const plusDI = lf(ind.adx?.plusDI);
  const minusDI = lf(ind.adx?.minusDI);
  const e20 = lf(ind.ema20);
  const e50 = lf(ind.ema50);
  const e100 = lf(ind.ema100);
  const vwap = lf(ind.vwap);
  const rsi = lf(ind.rsi);
  const bbMid = lf(ind.bollinger?.middle);
  const bwSeries = (ind.bollinger?.bandwidth ?? []).filter(Number.isFinite);
  const bw = bwSeries.length > 0 ? bwSeries[bwSeries.length - 1] : NaN;
  const volSMA = lf(ind.volumeSMA);
  const support = lf(ind.support);
  const resistance = lf(ind.resistance);
  const atrPct =
    Number.isFinite(atr) && Number.isFinite(close) && close > 0 ? atr / close : NaN;

  const withinLast = (idx: number, bars: number): boolean =>
    Number.isFinite(idx) && idx >= lastIdx - bars + 1 && idx <= lastIdx;

  // --- structure snapshot (last few completed swing labels) ---
  const structPts = (ind.structure ?? []).filter(
    (p) => p && Number.isFinite(p.index) && p.index <= lastIdx && typeof p.label === 'string',
  );
  const recentLabels = structPts.slice(-4).map((p) => p.label);
  const isBullLabel = (l: string) => l === 'HH' || l === 'HL';
  const isBearLabel = (l: string) => l === 'LH' || l === 'LL';
  const bullLabels = recentLabels.filter(isBullLabel).length;
  const bearLabels = recentLabels.filter(isBearLabel).length;
  const structBullish = bullLabels > 0 && bearLabels === 0;
  const structBearish = bearLabels > 0 && bullLabels === 0;
  const structMixed = !structBullish && !structBearish;

  // --- shared evidence fragments for notes ---
  const fmt1 = (v: number): string => (Number.isFinite(v) ? v.toFixed(1) : 'n/a');
  const evidence: string[] = [];
  if (Number.isFinite(adx)) evidence.push(`ADX ${adx.toFixed(0)}`);
  if (Number.isFinite(plusDI) && Number.isFinite(minusDI)) {
    evidence.push(plusDI > minusDI ? '+DI > -DI' : minusDI > plusDI ? '-DI > +DI' : 'DI balanced');
  }
  if (Number.isFinite(atrPct)) evidence.push(`ATR ${(atrPct * 100).toFixed(2)}% of price`);
  if (Number.isFinite(rsi)) evidence.push(`RSI ${rsi.toFixed(0)}`);

  // === 1. POSSIBLE_MANIPULATION ===
  // A liquidity sweep inside the last 5 bars whose wick exceeds 1.5x ATR and
  // which reclaimed immediately, OR an abnormal candle (range > 4x ATR with a
  // >3x volume spike) inside the last 3 bars.
  let sweepNote: string | null = null;
  for (const s of ind.liquiditySweeps ?? []) {
    if (!s || !withinLast(s.index, 5)) continue;
    const c = candles[s.index];
    if (!c || !Number.isFinite(atr) || atr <= 0) continue;
    const wick =
      s.side === 'BUY_SIDE'
        ? c.high - Math.max(c.open, c.close)
        : Math.min(c.open, c.close) - c.low;
    if (s.wicked && s.reclaimed && Number.isFinite(wick) && wick > 1.5 * atr) {
      sweepNote =
        `liquidity sweep (${s.side}): wick ${(wick / atr).toFixed(1)}x ATR with reclaim`;
      break;
    }
  }
  let abnormalNote: string | null = null;
  if (Number.isFinite(atr) && atr > 0 && Number.isFinite(volSMA) && volSMA > 0) {
    for (let i = Math.max(0, lastIdx - 2); i <= lastIdx; i++) {
      const c = candles[i];
      if (!c || !Number.isFinite(c.high) || !Number.isFinite(c.low)) continue;
      const range = c.high - c.low;
      if (range > 4 * atr && c.volume > 3 * volSMA) {
        abnormalNote =
          `abnormal candle: range ${(range / atr).toFixed(1)}x ATR, volume ${(c.volume / volSMA).toFixed(1)}x average`;
        break;
      }
    }
  }
  if (sweepNote || abnormalNote) {
    const notes = [sweepNote, abnormalNote].filter((x): x is string => x !== null);
    notes.push(...evidence.slice(0, 2));
    return { regime: 'POSSIBLE_MANIPULATION', notes };
  }

  // === 2. HIGH_VOLATILITY ===
  // ATR > 3% of price or bandwidth at an extreme percentile. A strong
  // directional trend keeps its trend label instead — the volatility label
  // wins only when directionless (ADX < 20, choppy violent) or on huge
  // range expansion.
  const bwPctile = percentileRank(bwSeries, bw);
  // The percentile read needs a real distribution behind it: ignore it on
  // short or constant bandwidth histories where "extreme" is meaningless.
  let bwSpread = false;
  if (bwSeries.length >= 20) {
    let mn = Infinity;
    let mx = -Infinity;
    for (const x of bwSeries) {
      if (x < mn) mn = x;
      if (x > mx) mx = x;
    }
    bwSpread = mx > mn * 1.001 + 1e-12;
  }
  const bwExtreme = bwSpread && Number.isFinite(bwPctile) && bwPctile >= 0.95;
  const highVol =
    (Number.isFinite(atrPct) && atrPct > 0.03) || bwExtreme;
  const hugeRange =
    Number.isFinite(lastRange) && Number.isFinite(atr) && atr > 0 && lastRange > 2.5 * atr;
  const directional =
    Number.isFinite(adx) && adx >= 20 &&
    Number.isFinite(plusDI) && Number.isFinite(minusDI) && plusDI !== minusDI;
  if (highVol && !(directional && !hugeRange)) {
    const notes: string[] = [];
    if (Number.isFinite(atrPct) && atrPct > 0.03) {
      notes.push(`ATR ${(atrPct * 100).toFixed(2)}% of price (> 3%)`);
    }
    if (bwExtreme) {
      notes.push(`Bollinger bandwidth at ${(bwPctile * 100).toFixed(0)}th percentile`);
    }
    notes.push(
      Number.isFinite(adx) && adx < 20
        ? `ADX ${adx.toFixed(0)} — violent but directionless`
        : `extreme range expansion (${fmt1(lastRange / atr)}x ATR last bar)`,
    );
    return { regime: 'HIGH_VOLATILITY', notes };
  }

  // --- trend building blocks ---
  const emaStackBull =
    [e20, e50, e100].every(Number.isFinite) && e20 > e50 && e50 > e100;
  const emaStackBear =
    [e20, e50, e100].every(Number.isFinite) && e20 < e50 && e50 < e100;
  const emaLeanBull = Number.isFinite(e20) && Number.isFinite(e50) && e20 > e50;
  const emaLeanBear = Number.isFinite(e20) && Number.isFinite(e50) && e20 < e50;
  const diBull = Number.isFinite(plusDI) && Number.isFinite(minusDI) && plusDI > minusDI;
  const diBear = Number.isFinite(plusDI) && Number.isFinite(minusDI) && minusDI > plusDI;
  const aboveVwap = Number.isFinite(close) && Number.isFinite(vwap) && close > vwap;
  const belowVwap = Number.isFinite(close) && Number.isFinite(vwap) && close < vwap;

  // === 3/5. STRONG_BULL / STRONG_BEAR ===
  if (
    Number.isFinite(adx) && adx > 25 && diBull &&
    emaStackBull && structBullish && aboveVwap
  ) {
    return {
      regime: 'STRONG_BULL',
      notes: [
        `ADX ${adx.toFixed(0)}, +DI > -DI`,
        'EMA bullish stack (20 > 50 > 100)',
        'structure: higher highs / higher lows',
        'close above VWAP',
        ...evidence.filter((e) => e.startsWith('RSI')).slice(0, 1),
      ],
    };
  }
  if (
    Number.isFinite(adx) && adx > 25 && diBear &&
    emaStackBear && structBearish && belowVwap
  ) {
    return {
      regime: 'STRONG_BEAR',
      notes: [
        `ADX ${adx.toFixed(0)}, -DI > +DI`,
        'EMA bearish stack (20 < 50 < 100)',
        'structure: lower highs / lower lows',
        'close below VWAP',
        ...evidence.filter((e) => e.startsWith('RSI')).slice(0, 1),
      ],
    };
  }

  // === 4/5. WEAK_BULL / WEAK_BEAR ===
  // Partial bullish EMA alignment without trend confirmation.
  const adxWeak = !Number.isFinite(adx) || adx < 25;
  if (emaLeanBull && (adxWeak || structMixed)) {
    const notes = ['EMA 20 > 50 (partial alignment)'];
    if (Number.isFinite(adx) && adx < 25) notes.push(`ADX ${adx.toFixed(0)} below 25 — trend not confirmed`);
    if (structMixed) notes.push('structure mixed / unclear');
    if (diBull) notes.push('+DI > -DI');
    return { regime: 'WEAK_BULL', notes };
  }
  if (emaLeanBear && (adxWeak || structMixed)) {
    const notes = ['EMA 20 < 50 (partial alignment)'];
    if (Number.isFinite(adx) && adx < 25) notes.push(`ADX ${adx.toFixed(0)} below 25 — trend not confirmed`);
    if (structMixed) notes.push('structure mixed / unclear');
    if (diBear) notes.push('-DI > +DI');
    return { regime: 'WEAK_BEAR', notes };
  }

  // === 6/7. BREAKOUT / BREAKDOWN ===
  // Volume-confirmed break of structure within the last 3 bars.
  const recentBos = (ind.bos ?? []).filter((b) => b && withinLast(b.index, 3));
  const bosUp = recentBos.find((b) => b.direction === 'UP' && b.volumeConfirmed);
  const bosDown = recentBos.find((b) => b.direction === 'DOWN' && b.volumeConfirmed);
  if (bosUp && !bosDown) {
    return {
      regime: 'BREAKOUT',
      notes: [
        `BOS up, volume-confirmed near ${bosUp.price}`,
        ...evidence.slice(0, 3),
      ],
    };
  }
  if (bosDown && !bosUp) {
    return {
      regime: 'BREAKDOWN',
      notes: [
        `BOS down, volume-confirmed near ${bosDown.price}`,
        ...evidence.slice(0, 3),
      ],
    };
  }

  // === 8/9. ACCUMULATION / DISTRIBUTION ===
  // Range conditions (ADX < 20, price hugging the Bollinger middle, flat EMAs)
  // + declining volume + price near a support / resistance cluster.
  const bbMidFinite = Number.isFinite(bbMid) && bbMid !== 0;
  const insideBand =
    bbMidFinite && Number.isFinite(close) && Number.isFinite(bw) &&
    (Math.abs(close - bbMid) <= 0.5 * bw * Math.abs(bbMid) || // bandwidth as ratio
      Math.abs(close - bbMid) <= 0.5 * bw); // bandwidth as price distance
  const flatEmas =
    Number.isFinite(e20) && Number.isFinite(e50) && Number.isFinite(close) && close > 0 &&
    Math.abs(e20 - e50) / close < 0.003;
  const recentVols = candles.slice(-5).map((c) => c.volume).filter(Number.isFinite);
  const avgVol =
    recentVols.length > 0
      ? recentVols.reduce((a, b) => a + b, 0) / recentVols.length
      : NaN;
  const volumeDeclining =
    Number.isFinite(avgVol) && Number.isFinite(volSMA) && volSMA > 0 && avgVol < volSMA;
  const rangeBase =
    Number.isFinite(adx) && adx < 20 && insideBand && flatEmas;
  const nearSupport =
    Number.isFinite(support) && Number.isFinite(close) && close > 0 &&
    Math.abs(close - support) / close < 0.005;
  const nearResistance =
    Number.isFinite(resistance) && Number.isFinite(close) && close > 0 &&
    Math.abs(close - resistance) / close < 0.005;

  if (rangeBase && volumeDeclining && nearSupport) {
    return {
      regime: 'ACCUMULATION',
      notes: [
        `ADX ${adx.toFixed(0)} — range-bound`,
        'price hugging Bollinger middle, EMAs flat',
        'volume declining',
        `price near support ${support}`,
      ],
    };
  }
  if (rangeBase && volumeDeclining && nearResistance) {
    return {
      regime: 'DISTRIBUTION',
      notes: [
        `ADX ${adx.toFixed(0)} — range-bound`,
        'price hugging Bollinger middle, EMAs flat',
        'volume declining',
        `price near resistance ${resistance}`,
      ],
    };
  }

  // === 10. SIDEWAYS ===
  if (Number.isFinite(adx) && adx < 20 && structMixed) {
    return {
      regime: sideways([]).regime,
      notes: [`ADX ${adx.toFixed(0)} — no trend`, 'structure mixed', ...evidence.slice(0, 3)],
    };
  }

  // === 11. LOW_VOLATILITY ===
  // ATR < 0.5% of price with a Bollinger squeeze (bandwidth under 60% of its
  // 50-bar median). Checked after SIDEWAYS per the decision order.
  const recentBw = bwSeries.slice(-50);
  const bwMedian = median(recentBw);
  if (
    Number.isFinite(atrPct) && atrPct < 0.005 &&
    Number.isFinite(bw) && Number.isFinite(bwMedian) && bwMedian > 0 &&
    bw < 0.6 * bwMedian
  ) {
    return {
      regime: 'LOW_VOLATILITY',
      notes: [
        `ATR ${(atrPct * 100).toFixed(2)}% of price (< 0.5%)`,
        'Bollinger squeeze: bandwidth < 60% of 50-bar median',
      ],
    };
  }

  // Default: SIDEWAYS with the observed evidence.
  const fallback = evidence.length > 0 ? evidence.slice(0, 5) : ['no dominant regime pattern'];
  return sideways(fallback);
}

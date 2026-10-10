/**
 * CryptoAI Pro — MASTER SIGNAL ENGINE orchestrator (src/engine.ts).
 *
 * Decision flow: validate data -> indicators -> MTF/regime -> liquidity ->
 * hard risk gates -> 9-component scoring (0..100 per side) -> AI confirmation ->
 * entry/SL/TP planning -> confidence (NOT raw score) -> grading -> MasterSignal.
 *
 * HARD RULES enforced here:
 *  - Never force a signal. If evidence is insufficient, direction = NO_TRADE.
 *  - All scoring is causal: only last (already-closed) values are used.
 *  - Nothing in this system claims or implies guaranteed accuracy.
 *    probability_estimate is a model-derived estimate, not a promise of outcome.
 *
 * Every function is total: buildSignal wraps everything in try/catch and
 * returns a NO_TRADE signal ('Engine error') on unexpected exceptions.
 */

import type {
  Candle,
  Timeframe,
  IndicatorSet,
  EngineConfig,
  EngineDeps,
  SymbolInput,
  MasterSignal,
  Direction,
  ScoreBreakdown,
  ScoreComponent,
  ScorePenalty,
  MTFAnalysis,
  MarketRegime,
  AIFeatures,
  MarketContext,
  LiquidityCheck,
  AIRating,
  BreakEvent,
  TFBias,
} from './types';
import { TIMEFRAMES } from './types';

import { computeIndicators, lastFinite } from './indicators';
import { analyzeMTF, detectRegime } from './regime';
import {
  planEntry,
  planStopLoss,
  planTakeProfits,
  sizePosition,
  selectLeverage,
} from './risk';
import {
  validateCandleData,
  checkLiquidity,
  gradeSignal,
  aiConfirm,
  defaultInvalidation,
} from './filters';

// ---------------------------------------------------------------------------
// Small utilities (module-private)
// ---------------------------------------------------------------------------

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function fmtNum(v: number): string {
  return Number.isFinite(v) ? String(round2(v)) : 'n/a';
}

/** NaN-safe comparisons. */
const gt = (a: number, b: number): boolean =>
  Number.isFinite(a) && Number.isFinite(b) && a > b;
const lt = (a: number, b: number): boolean =>
  Number.isFinite(a) && Number.isFinite(b) && a < b;

/** Second-to-last finite value (for "rising/falling" checks). NaN if absent. */
function prevFinite(values: number[]): number {
  let seen = 0;
  for (let i = values.length - 1; i >= 0; i--) {
    if (Number.isFinite(values[i])) {
      seen++;
      if (seen === 2) return values[i];
    }
  }
  return NaN;
}

/** Linear recency decay: 1.0 at age 0 -> 0.0 at age >= horizon. */
function recencyFactor(age: number, horizon: number): number {
  if (!Number.isFinite(age) || age < 0 || age > horizon) return 0;
  return 1 - age / horizon;
}

/** Primary timeframe for scoring: '1h', else the first TF with indicators. */
function pickPrimaryTF(
  indicators: Record<Timeframe, IndicatorSet>,
): Timeframe | null {
  if (indicators['1h']) return '1h';
  for (const tf of TIMEFRAMES) {
    if (indicators[tf]) return tf;
  }
  return null;
}

/** Internal per-component result; evidence strings feed signal reasons. */
interface ComponentResult {
  long: number;
  short: number;
  evL: string[];
  evS: string[];
}

const PROBABILITY_NOTE =
  'Model-derived estimate based on historical/validated conditions; not a guarantee of outcome.';

// ---------------------------------------------------------------------------
// scoreAll — 9-component weighted scoring, 0..100 per side, causal only
// ---------------------------------------------------------------------------

/**
 * V2 Weights: Trend 20, Structure 15, Momentum 15, Volume 10, S/R 15,
 * Breakout/BOS 10 (regime-gated: 0 in sideways), Volatility/ATR 10,
 * Liquidity 5 = 100.
 *
 * V2 changes (2026-10-10): Removed VWAP component (proven anti-predictive:
 * 33% long win, 26% short win in attribution analysis). Boosted S/R 10→15
 * (best predictive component: 60.8% short win). Doubled Volatility 5→10.
 * Breakout gated to trending regimes only (fails in chop).
 *
 * Each component scores long and short independently (0..max). Contradiction
 * penalties are then subtracted from the opposed side and recorded.
 */
export function scoreAll(
  symbol: string,
  candles: Record<Timeframe, Candle[]>,
  indicators: Record<Timeframe, IndicatorSet>,
  mtf: MTFAnalysis,
  regime: MarketRegime,
  liquidity: LiquidityCheck,
  market: MarketContext,
): ScoreBreakdown {
  void symbol;
  void market;

  const components: ScoreComponent[] = [];
  const penalties: ScorePenalty[] = [];
  const zero = (): ScoreBreakdown => ({
    long: 0,
    short: 0,
    components,
    penalties,
    directionGap: 0,
  });

  const ptf = pickPrimaryTF(indicators);
  const ind = ptf ? indicators[ptf] : undefined;
  const cs = (ptf ? candles[ptf] : undefined) ?? [];
  const lastIdx = cs.length - 1;
  const lastCandle = lastIdx >= 0 ? cs[lastIdx] : undefined;
  if (!ind || !lastCandle) return zero();
  // Narrowed aliases: TS does not narrow captured variables inside closures.
  const sind: IndicatorSet = ind;
  const slast: Candle = lastCandle;

  const close = slast.close;

  // ---- shared causal snapshot (last values only) ----
  const ema20 = lastFinite(sind.ema20);
  const ema50 = lastFinite(sind.ema50);
  const ema100 = lastFinite(sind.ema100);
  const ema200 = lastFinite(sind.ema200);
  const rsi = lastFinite(sind.rsi);
  const hist = lastFinite(sind.macd.histogram);
  const histPrev = prevFinite(sind.macd.histogram);
  const atr = lastFinite(sind.atr);
  const atrPct = close > 0 && Number.isFinite(atr) && atr > 0 ? atr / close : NaN;
  const adx = lastFinite(sind.adx.adx);
  const plusDI = lastFinite(sind.adx.plusDI);
  const minusDI = lastFinite(sind.adx.minusDI);
  const volSMA = lastFinite(sind.volumeSMA);
  const volumeRatio =
    Number.isFinite(volSMA) && volSMA > 0
      ? slast.volume / volSMA
      : NaN;
  const res = lastFinite(sind.resistance);
  const sup = lastFinite(sind.support);

  // ---- 1. Trend (20): EMA stack + ADX + price vs EMA200/50 ----
  function trend(): ComponentResult {
    const evL: string[] = [];
    const evS: string[] = [];
    let long = 0;
    let short = 0;
    const bullN = [gt(ema20, ema50), gt(ema50, ema100), gt(ema100, ema200)].filter(
      Boolean,
    ).length;
    const bearN = [lt(ema20, ema50), lt(ema50, ema100), lt(ema100, ema200)].filter(
      Boolean,
    ).length;
    long += (bullN / 3) * 10;
    short += (bearN / 3) * 10;
    if (bullN === 3) evL.push('Full bullish EMA stack (20>50>100>200)');
    else if (bullN === 2) evL.push('Partial bullish EMA alignment (2/3)');
    if (bearN === 3) evS.push('Full bearish EMA stack (20<50<100<200)');
    else if (bearN === 2) evS.push('Partial bearish EMA alignment (2/3)');
    if (
      Number.isFinite(adx) &&
      Number.isFinite(plusDI) &&
      Number.isFinite(minusDI)
    ) {
      if (adx > 25 && plusDI > minusDI) {
        long += 5;
        evL.push(`ADX ${round1(adx)} > 25 with +DI dominance (strong trend)`);
      } else if (adx > 20 && plusDI > minusDI) {
        long += 3;
      }
      if (adx > 25 && minusDI > plusDI) {
        short += 5;
        evS.push(`ADX ${round1(adx)} > 25 with -DI dominance (strong trend)`);
      } else if (adx > 20 && minusDI > plusDI) {
        short += 3;
      }
    }
    if (gt(close, ema50) && gt(close, ema200)) {
      long += 5;
      evL.push('Price above EMA50 and EMA200');
    } else if (gt(close, ema50) || gt(close, ema200)) {
      long += 2.5;
    }
    if (lt(close, ema50) && lt(close, ema200)) {
      short += 5;
      evS.push('Price below EMA50 and EMA200');
    } else if (lt(close, ema50) || lt(close, ema200)) {
      short += 2.5;
    }
    return { long: clamp(long, 0, 20), short: clamp(short, 0, 20), evL, evS };
  }

  // ---- 2. Structure (15): labels (5) + volume-confirmed BOS (10) ----
  function bosRecency(dir: 'UP' | 'DOWN', ev: string[]): number {
    const evs = sind.bos.filter((e) => e.direction === dir && e.volumeConfirmed);
    if (evs.length === 0) return 0;
    const e = evs[evs.length - 1];
    const age = lastIdx - e.index;
    const f = recencyFactor(age, 15);
    if (f <= 0) return 0;
    ev.push(
      `Volume-confirmed BOS ${dir} ${age} bar${age === 1 ? '' : 's'} ago`,
    );
    return 10 * f;
  }

  function chochRecency(dir: 'UP' | 'DOWN'): number {
    const evs = sind.choch.filter(
      (e) => e.direction === dir && e.volumeConfirmed,
    );
    if (evs.length === 0) return 0;
    const age = lastIdx - evs[evs.length - 1].index;
    return 3 * recencyFactor(age, 10);
  }

  function structure(): ComponentResult {
    const evL: string[] = [];
    const evS: string[] = [];
    let long = 0;
    let short = 0;
    const recent = sind.structure.slice(-3);
    if (recent.length > 0) {
      const bullLbl = recent.filter(
        (p) => p.label === 'HH' || p.label === 'HL',
      ).length;
      const bearLbl = recent.filter(
        (p) => p.label === 'LH' || p.label === 'LL',
      ).length;
      // Stale structure counts less.
      const ageLast = lastIdx - recent[recent.length - 1].index;
      const staleness = ageLast <= 10 ? 1 : ageLast <= 20 ? 0.7 : 0.4;
      long += (bullLbl / 3) * 5 * staleness;
      short += (bearLbl / 3) * 5 * staleness;
      if (bullLbl >= 2)
        evL.push(
          `Bullish market structure (${recent.map((p) => p.label).join(' -> ')})`,
        );
      if (bearLbl >= 2)
        evS.push(
          `Bearish market structure (${recent.map((p) => p.label).join(' -> ')})`,
        );
    }
    long += Math.min(10, bosRecency('UP', evL) + chochRecency('UP'));
    short += Math.min(10, bosRecency('DOWN', evS) + chochRecency('DOWN'));
    return { long: clamp(long, 0, 15), short: clamp(short, 0, 15), evL, evS };
  }

  // ---- 3. Momentum (15): RSI zones + MACD histogram ----
  function momentum(): ComponentResult {
    const evL: string[] = [];
    const evS: string[] = [];
    let long = 0;
    let short = 0;
    if (Number.isFinite(rsi)) {
      // Long: bullish-but-not-extreme 55-70 is best; >80 exhausted.
      if (rsi >= 55 && rsi <= 70) {
        long += 7;
        evL.push(`RSI ${round1(rsi)} in bullish sweet spot (55-70)`);
      } else if (rsi >= 50 && rsi < 55) long += 5;
      else if (rsi >= 45 && rsi < 50) long += 2;
      else if (rsi > 70 && rsi <= 80) {
        long += 3;
        evL.push(`RSI ${round1(rsi)} strong but extended`);
      }
      // Short: mirror; <20 exhausted.
      if (rsi <= 45 && rsi >= 30) {
        short += 7;
        evS.push(`RSI ${round1(rsi)} in bearish sweet spot (30-45)`);
      } else if (rsi > 45 && rsi <= 50) short += 5;
      else if (rsi > 50 && rsi <= 55) short += 2;
      else if (rsi < 30 && rsi >= 20) {
        short += 3;
        evS.push(`RSI ${round1(rsi)} weak but extended`);
      }
    }
    if (Number.isFinite(hist)) {
      if (hist > 0 && Number.isFinite(histPrev) && hist > histPrev) {
        long += 8;
        evL.push('MACD histogram positive and rising');
      } else if (hist > 0) {
        long += 5;
        evL.push('MACD histogram positive');
      }
      if (hist < 0 && Number.isFinite(histPrev) && hist < histPrev) {
        short += 8;
        evS.push('MACD histogram negative and falling');
      } else if (hist < 0) {
        short += 5;
        evS.push('MACD histogram negative');
      }
    }
    return { long: clamp(long, 0, 15), short: clamp(short, 0, 15), evL, evS };
  }

  // ---- 4. Volume (10): last volume vs SMA, direction agreement ----
  function volume(): ComponentResult {
    const evL: string[] = [];
    const evS: string[] = [];
    let base = 0;
    if (Number.isFinite(volumeRatio)) {
      if (volumeRatio >= 1.5) base = 10;
      else if (volumeRatio >= 1.2) base = 7;
      else if (volumeRatio >= 1.0) base = 5;
      else if (volumeRatio >= 0.8) base = 2;
      else base = 0; // declining volume penalizes
    }
    const up = slast.close > slast.open;
    const down = slast.close < slast.open;
    const long = up ? base : base * 0.5;
    const short = down ? base : base * 0.5;
    if (Number.isFinite(volumeRatio) && volumeRatio >= 1.5 && up)
      evL.push(`Volume ${round2(volumeRatio)}x SMA on up candle`);
    if (Number.isFinite(volumeRatio) && volumeRatio >= 1.5 && down)
      evS.push(`Volume ${round2(volumeRatio)}x SMA on down candle`);
    return { long: clamp(long, 0, 10), short: clamp(short, 0, 10), evL, evS };
  }


  // ---- 6. S/R (15): regime-aware — boosted weight (best predictive component) ----
  // In strong trends/breakouts, price far from the same-side level is NORMAL
  // (it just broke out) — don't penalize it. The opposing-level clearance
  // carries the weight; same-side level is a backstop, not a bounce requirement.
  function sr(): ComponentResult {
    const evL: string[] = [];
    const evS: string[] = [];
    let long = 0;
    let short = 0;
    const a = Number.isFinite(atrPct) && atrPct > 0 ? atrPct : NaN;
    const bullRegime =
      regime === 'STRONG_BULL' || regime === 'BREAKOUT' || regime === 'WEAK_BULL';
    const bearRegime =
      regime === 'STRONG_BEAR' || regime === 'BREAKDOWN' || regime === 'WEAK_BEAR';
    // LONG: no immediate overhead resistance (9) + near support bounce (6)
    if (!Number.isFinite(res) || res <= close) {
      long += 9;
      if (Number.isFinite(res)) evL.push('No overhead resistance nearby');
    } else if (Number.isFinite(a)) {
      const d = (res - close) / close;
      if (d > 3 * a) {
        long += 9;
        evL.push(`Nearest resistance ${(d * 100).toFixed(2)}% away (>3 ATR)`);
      } else if (d > 1.5 * a) long += 6;
      else if (d > 0.5 * a) long += 3;
    }
    if (Number.isFinite(sup) && sup < close && Number.isFinite(a)) {
      const d2 = (close - sup) / close;
      if (d2 <= 0.5 * a) {
        long += 6;
        evL.push('Price near support: bounce zone');
      } else if (d2 <= 1.5 * a) long += 3;
      else if (bullRegime) {
        // Breakout context: support exists below as backstop, not a bounce zone.
        long += 3;
        evL.push('Support below as backstop (breakout context)');
      }
    }
    // SHORT: no immediate support below (9) + near resistance rejection (6)
    if (!Number.isFinite(sup) || sup >= close) {
      short += 9;
      if (Number.isFinite(sup)) evS.push('No support below nearby');
    } else if (Number.isFinite(a)) {
      const d = (close - sup) / close;
      if (d > 3 * a) {
        short += 9;
        evS.push(`Nearest support ${(d * 100).toFixed(2)}% away (>3 ATR)`);
      } else if (d > 1.5 * a) short += 6;
      else if (d > 0.5 * a) short += 3;
    }
    if (Number.isFinite(res) && res > close && Number.isFinite(a)) {
      const d2 = (res - close) / close;
      if (d2 <= 0.5 * a) {
        short += 6;
        evS.push('Price near resistance: rejection zone');
      } else if (d2 <= 1.5 * a) short += 3;
      else if (bearRegime) {
        // Breakdown context: resistance exists above as backstop.
        short += 3;
        evS.push('Resistance above as backstop (breakdown context)');
      }
    }
    return { long: clamp(long, 0, 15), short: clamp(short, 0, 15), evL, evS };
  }

  // ---- 7. Breakout/BOS (10) with false-breakout protection ----
  function isBreakConfirmed(e: BreakEvent, forLong: boolean): boolean {
    if (e.index < 0 || e.index >= cs.length) return false;
    const c = cs[e.index];
    // (a) close beyond the level — not just a wick
    if (forLong ? !(c.close > e.brokenLevel) : !(c.close < e.brokenLevel))
      return false;
    // (b) volume spike at the break
    const vsma = lastFinite(sind.volumeSMA.slice(0, e.index + 1));
    const spike =
      e.volumeConfirmed ||
      (Number.isFinite(vsma) && vsma > 0 && c.volume > vsma * 1.5);
    if (!spike) return false;
    // (c1) ATR-adjusted distance beyond the level
    const atrAt = e.index < sind.atr.length ? sind.atr[e.index] : NaN;
    const dist = forLong ? c.close - e.brokenLevel : e.brokenLevel - c.close;
    if (Number.isFinite(atrAt) && atrAt > 0 && dist > 0.3 * atrAt) return true;
    // (c2) or retest held: later closes stayed on the breakout side
    for (let i = e.index + 1; i <= lastIdx; i++) {
      const cc = cs[i];
      if (forLong ? cc.close < e.brokenLevel : cc.close > e.brokenLevel)
        return false;
    }
    return true;
  }

  function scoreBreakoutDir(forLong: boolean, ev: string[]): number {
    const dirEv: 'UP' | 'DOWN' = forLong ? 'UP' : 'DOWN';
    const evs = sind.bos.filter((e) => e.direction === dirEv);
    if (evs.length === 0) return 0;
    const e = evs[evs.length - 1];
    const age = lastIdx - e.index;
    if (age < 0 || age > 12) return 0;
    if (!isBreakConfirmed(e, forLong)) {
      penalties.push({
        name: 'Breakout/BOS',
        long: 0,
        short: 0,
        reason: `Unconfirmed ${dirEv} break ignored by false-breakout protection (requires close beyond level + volume spike + retest-held or >0.3 ATR distance)`,
      });
      return 0;
    }
    const pts = 10 * recencyFactor(age, 12);
    if (pts > 0)
      ev.push(
        `Confirmed ${dirEv} breakout ${age} bar${age === 1 ? '' : 's'} ago (close beyond level, volume, retest/distance held)`,
      );
    return pts;
  }

  function breakout(): ComponentResult {
    const evL: string[] = [];
    const evS: string[] = [];
    // V2: Breakouts fail in sideways/choppy markets (proven anti-predictive).
    // Only score breakouts in trending regimes.
    const sideways = regime === 'SIDEWAYS' || regime === 'LOW_VOLATILITY' || regime === 'HIGH_VOLATILITY';
    if (sideways) {
      evL.push('Breakout disabled: sideways regime (breakouts fail in chop)');
      evS.push('Breakout disabled: sideways regime (breakouts fail in chop)');
      return { long: 0, short: 0, evL, evS };
    }
    const long = scoreBreakoutDir(true, evL);
    const short = scoreBreakoutDir(false, evS);
    return { long: clamp(long, 0, 10), short: clamp(short, 0, 10), evL, evS };
  }

  // ---- 8. Volatility/ATR (10): healthy band scores, extreme => 0 ----
  // V2: doubled weight — volatility regime is key to position sizing and
  // trade selection. Healthy volatility = tradeable, extreme = avoid.
  function volatility(): ComponentResult {
    const evL: string[] = [];
    const evS: string[] = [];
    let v = 0;
    if (Number.isFinite(atrPct) && atrPct > 0) {
      if (atrPct > 0.03) {
        v = 0; // extreme volatility: untradeable chop risk
      } else if (atrPct >= 0.002) {
        v = 10;
        const note = `Healthy volatility (ATR ${(atrPct * 100).toFixed(2)}%)`;
        evL.push(note);
        evS.push(note);
      } else if (atrPct >= 0.001) {
        v = 6;
      } else {
        v = 2; // dead market
      }
    }
    return { long: v, short: v, evL, evS };
  }

  // ---- 9. Liquidity (5) ----
  function liquidityComp(): ComponentResult {
    const s = clamp(Number.isFinite(liquidity.score) ? liquidity.score : 0, 0, 100);
    const v = (s / 100) * 5;
    const note = s >= 70 ? [`Liquidity score ${round1(s)}/100`] : [];
    return { long: v, short: v, evL: note, evS: [...note] };
  }

  const defs: Array<{ name: string; max: number; r: ComponentResult }> = [
    { name: 'Trend', max: 20, r: trend() },
    { name: 'Structure', max: 15, r: structure() },
    { name: 'Momentum', max: 15, r: momentum() },
    { name: 'Volume', max: 10, r: volume() },
    { name: 'S/R', max: 15, r: sr() },
    { name: 'Breakout/BOS', max: 10, r: breakout() },
    { name: 'Volatility/ATR', max: 10, r: volatility() },
    { name: 'Liquidity', max: 5, r: liquidityComp() },
  ];
  for (const d of defs) {
    components.push({ name: d.name, long: round1(d.r.long), short: round1(d.r.short), max: d.max });
  }

  // ---- Contradiction penalties (subtracted from the opposed side) ----
  const view = ptf ? mtf.views[ptf] : undefined;
  if (mtf.htfBias === 'BULLISH' && view && view.score < -20) {
    penalties.push({
      name: 'HTF conflict',
      long: 0,
      short: -15,
      reason: 'HTF trend conflict: HTF bullish but 1h strongly bearish',
    });
  } else if (mtf.htfBias === 'BEARISH' && view && view.score > 20) {
    penalties.push({
      name: 'HTF conflict',
      long: -15,
      short: 0,
      reason: 'HTF trend conflict: HTF bearish but 1h strongly bullish',
    });
  }

  // RSI divergence vs price
  const rsiAt = (index: number): number =>
    index >= 0 && index < sind.rsi.length && Number.isFinite(sind.rsi[index])
      ? sind.rsi[index]
      : NaN;
  const highs = sind.swingHighs;
  if (highs.length >= 2) {
    const h1 = highs[highs.length - 2];
    const h2 = highs[highs.length - 1];
    const r1 = rsiAt(h1.index);
    const r2 = rsiAt(h2.index);
    if (h2.price > h1.price && Number.isFinite(r1) && Number.isFinite(r2) && r2 < r1) {
      penalties.push({
        name: 'RSI divergence',
        long: -10,
        short: 0,
        reason: 'Bearish RSI divergence: price higher high, RSI lower high',
      });
    }
  }
  const lows = sind.swingLows;
  if (lows.length >= 2) {
    const l1 = lows[lows.length - 2];
    const l2 = lows[lows.length - 1];
    const r1 = rsiAt(l1.index);
    const r2 = rsiAt(l2.index);
    if (l2.price < l1.price && Number.isFinite(r1) && Number.isFinite(r2) && r2 > r1) {
      penalties.push({
        name: 'RSI divergence',
        long: 0,
        short: -10,
        reason: 'Bullish RSI divergence: price lower low, RSI higher low',
      });
    }
  }

  // MACD opposing the side
  if (Number.isFinite(hist)) {
    if (hist < 0)
      penalties.push({
        name: 'MACD opposing',
        long: -10,
        short: 0,
        reason: 'MACD histogram negative: opposing long bias',
      });
    else if (hist > 0)
      penalties.push({
        name: 'MACD opposing',
        long: 0,
        short: -10,
        reason: 'MACD histogram positive: opposing short bias',
      });
  }

  // Liquidity sweeps against direction (bull/bear traps)
  for (const s of sind.liquiditySweeps) {
    const age = lastIdx - s.index;
    if (age < 0 || age > 10) continue;
    if (s.side === 'BUY_SIDE' && s.wicked && s.reclaimed) {
      penalties.push({
        name: 'Liquidity sweep',
        long: -10,
        short: 0,
        reason:
          'Liquidity sweep against direction: buy-side sweep wicked and reclaimed (bull trap)',
      });
    } else if (s.side === 'SELL_SIDE' && s.wicked && s.reclaimed) {
      penalties.push({
        name: 'Liquidity sweep',
        long: 0,
        short: -10,
        reason:
          'Liquidity sweep against direction: sell-side sweep wicked and reclaimed (bear trap)',
      });
    }
  }

  // ---- Totals ----
  let long = 0;
  let short = 0;
  for (const c of components) {
    long += c.long;
    short += c.short;
  }
  for (const p of penalties) {
    long += p.long;
    short += p.short;
  }
  long = clamp(round1(long), 0, 100);
  short = clamp(round1(short), 0, 100);

  return {
    long,
    short,
    components,
    penalties,
    directionGap: round1(Math.abs(long - short)),
  };
}

// ---------------------------------------------------------------------------
// computeConfidence — 0..100, derived from (not equal to) the raw score
// ---------------------------------------------------------------------------

/**
 * Confidence blends the winning score with independent quality factors:
 * MTF agreement, regime, volume confirmation, liquidity, reward:risk,
 * contradiction penalties, volatility, entry lateness, and AI opposition.
 * It is a quality estimate, never a guarantee of outcome.
 */
export function computeConfidence(
  b: ScoreBreakdown,
  mtf: MTFAnalysis,
  regime: MarketRegime,
  liquidity: LiquidityCheck,
  rr: number,
  aiRating: AIRating,
  volumeRatio: number,
  atrPct: number,
  entryAge: number,
): number {
  const isLong = b.long >= b.short;
  const winningScore = isLong ? b.long : b.short;

  let c = winningScore * 0.5;
  c += (Number.isFinite(mtf.agreement) ? mtf.agreement : 0) * 0.2;

  if (regime === 'STRONG_BULL' || regime === 'STRONG_BEAR') c += 10;
  else if (regime === 'SIDEWAYS') c -= 15;
  else if (regime === 'POSSIBLE_MANIPULATION') c -= 25;
  else if (regime === 'HIGH_VOLATILITY') c -= 15;

  c += Number.isFinite(volumeRatio) && volumeRatio > 1.3 ? 5 : -5;

  const liqScore = Number.isFinite(liquidity.score) ? liquidity.score : 0;
  c += (liqScore / 100) * 10;

  if (rr >= 3) c += 8;
  else if (rr >= 2.5) c += 5;
  else if (rr >= 2) c += 2;

  // Contradiction penalties weigh against confidence, half-weight.
  let pen = 0;
  for (const p of b.penalties) pen += Math.abs(isLong ? p.long : p.short);
  c -= pen * 0.5;

  if (Number.isFinite(atrPct) && atrPct > 0.03) c -= 10; // extreme volatility
  c -= (100 - liqScore) * 0.15; // illiquidity drag
  if (entryAge > 5) c -= 10; // late entry

  const aiOpposed =
    (isLong && aiRating === 'AI_BEARISH') ||
    (!isLong && aiRating === 'AI_BULLISH');
  if (aiOpposed) c -= 20;

  return Math.round(clamp(c, 0, 100));
}

/** Conservative win-probability mapping. Never exceeds 95, never a guarantee. */
function probabilityEstimate(confidence: number): number {
  return Math.min(95, Math.round(confidence * 0.85));
}

// ---------------------------------------------------------------------------
// noTradeSignal — the safe default. Never forced, always available.
// ---------------------------------------------------------------------------

const DEFAULT_COOLDOWN_MS = 900_000; // matches config default COOLDOWN_MS

/**
 * Builds a NO_TRADE signal in the MasterSignal shape (spec section 31):
 * direction NO_TRADE, status WAITING, grade NO_TRADE, null trade fields.
 * This function never throws and never calls other modules.
 */
export function noTradeSignal(
  symbol: string,
  reasons: string[],
  opts?: {
    confidence?: number;
    mtf?: MTFAnalysis;
    regime?: MarketRegime;
    aiRating?: AIRating;
    warnings?: string[];
    /** Override wall-clock time (backtests pass the bar's closeTime for determinism). */
    now?: number;
    /** Evaluated scores to carry on NO_TRADE outputs (more informative than zeros). */
    scores?: { long: number; short: number };
  },
): MasterSignal {
  const now = opts?.now ?? Date.now();
  const mtfMap = {} as Record<Timeframe, TFBias>;
  for (const tf of TIMEFRAMES) {
    mtfMap[tf] = opts?.mtf?.views[tf]?.bias ?? 'NEUTRAL';
  }
  return {
    signal_id: `${symbol}-${now}`,
    symbol,
    direction: 'NO_TRADE',
    status: 'WAITING',
    signal_grade: 'NO_TRADE',
    long_score: round1(opts?.scores?.long ?? 0),
    short_score: round1(opts?.scores?.short ?? 0),
    confidence: opts?.confidence ?? 0,
    probability_estimate: 0,
    probability_note: PROBABILITY_NOTE,
    market_regime: opts?.regime ?? 'SIDEWAYS',
    entry: null,
    stop_loss: null,
    take_profit: null,
    risk_reward: null,
    position: null,
    mtf: mtfMap,
    confirmation: {
      trend: false,
      structure: false,
      momentum: false,
      volume: false,
      vwap: false,
      breakout: false,
      liquidity: false,
    },
    reasons,
    warnings: opts?.warnings ?? [],
    invalidation: [],
    correlation_score: 0,
    ai_rating: opts?.aiRating ?? 'AI_NEUTRAL',
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + DEFAULT_COOLDOWN_MS).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// buildSignal — the master decision (spec section 29)
// ---------------------------------------------------------------------------

/** Bars since the latest structural setup (BOS/CHoCH/structure formation). */
function computeEntryAge(ind: IndicatorSet, lastIdx: number): number {
  let latest = -1;
  const touch = (idx: number): void => {
    if (idx > latest) latest = idx;
  };
  for (const e of ind.bos) touch(e.index);
  for (const e of ind.choch) touch(e.index);
  for (const s of ind.structure) touch(s.index);
  if (latest < 0) return 0;
  return Math.max(0, lastIdx - latest);
}

interface EvidenceFacts {
  adx: number;
  rsi: number;
  macdHist: number;
  volumeRatio: number;
  vwapAbove: boolean;
  atrPct: number;
  liquidityScore: number;
}

/** Human-readable evidence line for a strongly-scoring component. */
function componentEvidence(
  name: string,
  direction: 'LONG' | 'SHORT',
  f: EvidenceFacts,
): string {
  const d = direction === 'LONG' ? 'long' : 'short';
  switch (name) {
    case 'Trend':
      return `Trend favors ${d}: EMA stack aligned${Number.isFinite(f.adx) ? `, ADX ${round1(f.adx)}` : ''}`;
    case 'Structure':
      return `Market structure and volume-confirmed BOS favor ${d}`;
    case 'Momentum':
      return `Momentum favors ${d} (RSI ${fmtNum(f.rsi)}, MACD histogram ${
        f.macdHist > 0 ? 'positive' : f.macdHist < 0 ? 'negative' : 'flat'
      })`;
    case 'Volume':
      return `Volume ${fmtNum(f.volumeRatio)}x vs SMA supports ${d}`;
    case 'VWAP':
      return `Price ${f.vwapAbove ? 'above' : 'below'} VWAP favors ${d}`;
    case 'S/R':
      return `Key S/R levels clear for ${d} continuation`;
    case 'Breakout/BOS':
      return `Confirmed breakout supports ${d}`;
    case 'Volatility/ATR':
      return `Healthy volatility regime${
        Number.isFinite(f.atrPct) ? ` (ATR ${(f.atrPct * 100).toFixed(2)}%)` : ''
      }`;
    case 'Liquidity':
      return `Strong liquidity (score ${round1(f.liquidityScore)}/100)`;
    default:
      return `${name} favors ${d}`;
  }
}

function buildSignalInner(input: SymbolInput, deps: EngineDeps): MasterSignal {
  const now = deps.now ?? Date.now();
  const config: EngineConfig = deps.config;
  const market = deps.market;
  const primary: Timeframe = '1h';

  // ---- 2. Validate every TF; primary must have enough valid candles ----
  const validated = {} as Record<Timeframe, Candle[]>;
  const dataIssues: string[] = [];
  for (const tf of TIMEFRAMES) {
    const v = validateCandleData(input.candles[tf] ?? []);
    validated[tf] = v.candles;
    for (const issue of v.issues) dataIssues.push(`${tf}: ${issue}`);
  }
  const pcs = validated[primary];
  if (!pcs || pcs.length < config.minCandles) {
    return noTradeSignal(
      input.symbol,
      [
        `Insufficient candle data: ${pcs ? pcs.length : 0} valid ${primary} candles (need ${config.minCandles})`,
      ],
      { warnings: dataIssues, now },
    );
  }

  // ---- 3. Indicators per TF (skip empty TFs) ----
  const indicators = {} as Record<Timeframe, IndicatorSet>;
  for (const tf of TIMEFRAMES) {
    if (validated[tf].length > 0) indicators[tf] = computeIndicators(validated[tf]);
  }
  const pind = indicators[primary];
  if (!pind) {
    return noTradeSignal(input.symbol, ['Indicator computation failed on primary timeframe'], {
      warnings: dataIssues,
      now,
    });
  }

  // ---- 4. MTF analysis + regime detection on primary ----
  const mtf = analyzeMTF(validated, indicators);
  const regimeDet = detectRegime(pcs, pind);
  const regime: MarketRegime = regimeDet.regime;

  // ---- 5. Liquidity ----
  const liquidity = checkLiquidity(pcs, input.quoteVolume24h, input.spreadPct, config);

  // Shared derived values (causal: last values only).
  const lastIdx = pcs.length - 1;
  const lastClose = pcs[lastIdx].close;
  const atrLast = lastFinite(pind.atr);
  const atrPct =
    lastClose > 0 && Number.isFinite(atrLast) && atrLast > 0
      ? atrLast / lastClose
      : NaN;
  const leverage = selectLeverage(atrPct, regime, config);

  // ---- 6. Hard risk failures -> NO_TRADE (reasons collected) ----
  const hardReasons: string[] = [];
  if (!liquidity.ok && liquidity.score < 40) {
    hardReasons.push(
      `Liquidity check failed (score ${round1(liquidity.score)}): ${liquidity.issues.join('; ') || 'insufficient liquidity'}`,
    );
  }
  const freshSweep = pind.liquiditySweeps.some((s) => lastIdx - s.index <= 10);
  if (regime === 'POSSIBLE_MANIPULATION' && freshSweep) {
    hardReasons.push('Possible manipulation: fresh liquidity sweep detected');
  }
  if (!(leverage > 0)) {
    hardReasons.push('Extreme volatility: leverage selection returned 0 (do not trade)');
  }
  if (input.spreadPct > config.maxSpreadPct * 2) {
    hardReasons.push(
      `Spread too wide: ${input.spreadPct}% exceeds 2x max ${config.maxSpreadPct}%`,
    );
  }
  if (hardReasons.length > 0) {
    return noTradeSignal(input.symbol, hardReasons, {
      mtf,
      regime,
      warnings: dataIssues,
      now,
    });
  }

  // ---- 7. Scoring ----
  const scores = scoreAll(
    input.symbol,
    validated,
    indicators,
    mtf,
    regime,
    liquidity,
    market,
  );

  // ---- 8. Candidate selection (never forced) ----
  const shortThreshold = market.btcStrongBull
    ? config.minScore + 5 // BTC strong bull raises the bar for SHORTs
    : config.minScore;
  const longCandidate = scores.long >= config.minScore;
  const shortCandidate = scores.short >= shortThreshold;
  let direction: Direction = 'NO_TRADE';
  if (longCandidate && shortCandidate)
    direction = scores.long >= scores.short ? 'LONG' : 'SHORT';
  else if (longCandidate) direction = 'LONG';
  else if (shortCandidate) direction = 'SHORT';
  if (direction === 'NO_TRADE') {
    return noTradeSignal(
      input.symbol,
      [
        `No qualifying candidate: long ${round1(scores.long)} / short ${round1(scores.short)} below minimum score ${config.minScore}`,
      ],
      {
        mtf,
        regime,
        warnings: [
          ...scores.penalties.map((p) => p.reason),
          ...dataIssues,
        ],
        now,
        scores: { long: scores.long, short: scores.short },
      },
    );
  }

  // Plan first: RR is needed for AI features and downstream gates.
  const entry = planEntry(direction, pcs, pind);
  const sl = planStopLoss(direction, entry.preferred, pcs, pind);
  const { plan: tps, rr } = planTakeProfits(
    direction,
    entry.preferred,
    sl.price,
    pcs,
    pind,
  );

  // Sanity: fail closed on an invalid plan.
  const stopOk =
    Number.isFinite(entry.preferred) &&
    Number.isFinite(sl.price) &&
    sl.price > 0 &&
    (direction === 'LONG'
      ? sl.price < entry.preferred
      : sl.price > entry.preferred);
  if (!stopOk) {
    return noTradeSignal(input.symbol, ['Invalid trade plan: stop-loss placement failed sanity check'], {
      mtf,
      regime,
      warnings: dataIssues,
      now,
    });
  }

  // ---- AI confirmation ----
  const rsiLast = lastFinite(pind.rsi);
  const macdHistLast = lastFinite(pind.macd.histogram);
  const adxLast = lastFinite(pind.adx.adx);
  const volSmaLast = lastFinite(pind.volumeSMA);
  const lastVol = pcs[lastIdx].volume;
  const volumeRatio =
    Number.isFinite(volSmaLast) && volSmaLast > 0 ? lastVol / volSmaLast : NaN;
  const vwapLast = lastFinite(pind.vwap);
  const vwapPosition: AIFeatures['vwapPosition'] =
    !Number.isFinite(vwapLast) || lastClose <= 0
      ? 'NEAR'
      : Math.abs((lastClose - vwapLast) / lastClose) <= 0.001
        ? 'NEAR'
        : lastClose > vwapLast
          ? 'ABOVE'
          : 'BELOW';
  const features: AIFeatures = {
    mtfScore: mtf.weightedScore,
    longScore: scores.long,
    shortScore: scores.short,
    regime,
    rsi: rsiLast,
    macdHist: macdHistLast,
    adx: adxLast,
    volumeRatio,
    vwapPosition,
    atrPct,
    liquidityScore: liquidity.score,
    btcViolentDump: market.btcViolentDump,
    btcStrongBull: market.btcStrongBull,
    rr: rr.tp2,
  };
  const aiRating: AIRating = aiConfirm(features);

  // ---- 9. Gates ----
  const gateFail = (reason: string, extraWarnings: string[] = []): MasterSignal =>
    noTradeSignal(input.symbol, [reason], {
      mtf,
      regime,
      aiRating,
      warnings: [...scores.penalties.map((p) => p.reason), ...extraWarnings, ...dataIssues],
      now,
      scores: { long: scores.long, short: scores.short },
    });

  const rrMin = Math.min(rr.tp1, rr.tp2, rr.tp3);
  if (!(rr.tp2 >= config.minRR)) {
    return gateFail(
      `RR below minimum: primary target RR ${fmtNum(rr.tp2)} (min ${fmtNum(rrMin)}) < ${config.minRR}`,
    );
  }
  if (scores.directionGap < config.minDirectionGap) {
    return gateFail(
      `Direction gap too small: ${round1(scores.directionGap)} < ${config.minDirectionGap}`,
    );
  }
  if (direction === 'LONG' && !mtf.confirmsLong) {
    return gateFail('HTF trend conflict: MTF does not confirm LONG');
  }
  if (direction === 'SHORT' && !mtf.confirmsShort) {
    return gateFail('HTF trend conflict: MTF does not confirm SHORT');
  }
  const aiOpposed =
    (direction === 'LONG' && aiRating === 'AI_BEARISH') ||
    (direction === 'SHORT' && aiRating === 'AI_BULLISH');
  if (aiOpposed) {
    return gateFail(`AI confirmation opposed (${aiRating} vs ${direction})`);
  }
  if (market.btcViolentDump && direction === 'LONG') {
    return gateFail('BTC dumping: alt LONG blocked');
  }

  // ---- 10. Confidence (NOT raw score) ----
  const entryAge = computeEntryAge(pind, lastIdx);
  const confidence = computeConfidence(
    scores,
    mtf,
    regime,
    liquidity,
    rr.tp2,
    aiRating,
    volumeRatio,
    atrPct,
    entryAge,
  );
  if (confidence < config.minConfidence) {
    return gateFail(
      `Confidence below minimum: ${confidence} < ${config.minConfidence}`,
    );
  }

  // ---- 11. Position sizing ----
  const position = sizePosition(
    deps.balance,
    config.riskPercent,
    entry.preferred,
    sl.price,
    leverage,
  );

  // ---- 12. Grading ----
  const grade = gradeSignal(
    scores.long,
    scores.short,
    confidence,
    rr.tp2,
    mtf,
    liquidity,
    config,
  );
  if (grade === 'NO_TRADE') {
    return gateFail('Signal failed grading');
  }

  // ---- 13. Assemble the MasterSignal ----
  const facts: EvidenceFacts = {
    adx: adxLast,
    rsi: rsiLast,
    macdHist: macdHistLast,
    volumeRatio,
    vwapAbove: vwapPosition === 'ABOVE',
    atrPct,
    liquidityScore: liquidity.score,
  };

  const winKey = direction === 'LONG' ? 'long' : 'short';
  const strongComponents = scores.components
    .map((c) => ({ c, v: direction === 'LONG' ? c.long : c.short }))
    .filter((x) => x.v >= 0.7 * x.c.max)
    .sort((a, b) => b.v / b.c.max - a.v / a.c.max);
  let reasons = strongComponents.map((x) =>
    componentEvidence(x.c.name, direction as 'LONG' | 'SHORT', facts),
  );
  if (reasons.length === 0) {
    reasons = scores.components
      .map((c) => ({ c, v: direction === 'LONG' ? c.long : c.short }))
      .sort((a, b) => b.v - a.v)
      .slice(0, 3)
      .filter((x) => x.v > 0)
      .map((x) => componentEvidence(x.c.name, direction as 'LONG' | 'SHORT', facts));
  }

  const warnings: string[] = [];
  for (const p of scores.penalties) {
    if (p.reason && !warnings.includes(p.reason)) warnings.push(p.reason);
  }
  warnings.push(...regimeDet.notes);
  warnings.push(...liquidity.issues);
  warnings.push(...dataIssues);
  if (direction === 'LONG' && Number.isFinite(rsiLast) && rsiLast > 80)
    warnings.push('RSI overextended above 80: exhaustion risk');
  if (direction === 'SHORT' && Number.isFinite(rsiLast) && rsiLast < 20)
    warnings.push('RSI overextended below 20: exhaustion risk');
  const srComp = scores.components.find((c) => c.name === 'S/R');
  if (srComp && (direction === 'LONG' ? srComp.long : srComp.short) < 5) {
    warnings.push(
      direction === 'LONG'
        ? 'Opposing resistance is close overhead: breakout needs confirmation'
        : 'Opposing support is close below: breakdown needs confirmation',
    );
  }
  if (grade === 'B') {
    // B-tier never auto-trades: server treats only A+/A as auto-tradable.
    warnings.push('B-tier: requires manual review, do not auto-trade');
  }

  const mtfMap = {} as Record<Timeframe, TFBias>;
  for (const tf of TIMEFRAMES) {
    mtfMap[tf] = mtf.views[tf]?.bias ?? 'NEUTRAL';
  }

  const compConfirmed = (name: string): boolean => {
    const c = scores.components.find((x) => x.name === name);
    if (!c) return false;
    const v = direction === 'LONG' ? c.long : c.short;
    return v >= 0.7 * c.max;
  };

  const invalidation: string[] = [
    ...defaultInvalidation(direction),
    `1h close ${direction === 'LONG' ? 'below' : 'above'} stop-loss ${sl.price}`,
    `HTF (4h/1d) bias flips against ${direction}`,
    `Fresh liquidity sweep against ${direction} direction`,
  ];

  return {
    signal_id: `${input.symbol}-${now}`,
    symbol: input.symbol,
    direction,
    status: 'ACTIVE',
    signal_grade: grade,
    long_score: round1(scores.long),
    short_score: round1(scores.short),
    confidence,
    probability_estimate: probabilityEstimate(confidence),
    probability_note: PROBABILITY_NOTE,
    market_regime: regime,
    entry,
    stop_loss: sl,
    take_profit: tps,
    risk_reward: rr,
    position,
    mtf: mtfMap,
    confirmation: {
      trend: compConfirmed('Trend'),
      structure: compConfirmed('Structure'),
      momentum: compConfirmed('Momentum'),
      volume: compConfirmed('Volume'),
      vwap: compConfirmed('VWAP'),
      breakout: compConfirmed('Breakout/BOS'),
      liquidity: compConfirmed('Liquidity'),
    },
    reasons,
    warnings,
    invalidation,
    correlation_score: 0, // server overlays portfolio correlation
    ai_rating: aiRating,
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + config.signalTtlMs).toISOString(),
  };
}

/**
 * Master decision entry point. Total: any unexpected exception becomes a
 * NO_TRADE signal with reason 'Engine error' — a signal is never forced.
 */
export function buildSignal(input: SymbolInput, deps: EngineDeps): MasterSignal {
  try {
    return buildSignalInner(input, deps);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return noTradeSignal(input.symbol, [`Engine error: ${msg}`], { now: deps.now });
  }
}

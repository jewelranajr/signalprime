/** Unit tests: risk — RR math, sizing invariants, leverage caps, plan validity. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  riskReward,
  sizePosition,
  selectLeverage,
  planEntry,
  planStopLoss,
  planTakeProfits,
} from '../risk';
import { computeIndicators } from '../indicators';
import { makeCandles, strictConfig } from './helpers';

describe('risk', () => {
  it('riskReward computes |target-entry| / |entry-stop| per target', () => {
    assert.deepEqual(riskReward(100, 95, [110, 115, 120], 'LONG'), [2, 3, 4]);
    assert.deepEqual(riskReward(100, 105, [90, 85, 80], 'SHORT'), [2, 3, 4]);
  });

  it('riskReward guards stop == entry', () => {
    assert.deepEqual(riskReward(100, 100, [110], 'LONG'), [0]);
  });

  it('sizePosition: risk_amount = balance * riskPercent / 100, derived from stop distance', () => {
    const p = sizePosition(10_000, 1, 100, 95, 3);
    assert.equal(p.risk_percent, 1);
    assert.equal(p.risk_amount, 100);
    assert.equal(p.quantity, 20); // 100 / 5
    assert.equal(p.notional, 2000);
    assert.equal(p.leverage, 3);
  });

  it('sizePosition NEVER scales with leverage: risk_amount and quantity identical at 1x vs 10x', () => {
    const a = sizePosition(10_000, 1, 100, 95, 1);
    const b = sizePosition(10_000, 1, 100, 95, 10);
    assert.equal(a.risk_amount, b.risk_amount);
    assert.equal(a.quantity, b.quantity);
  });

  it('sizePosition returns zero quantity on degenerate stop distance', () => {
    const p = sizePosition(10_000, 1, 100, 100, 3);
    assert.equal(p.quantity, 0);
  });

  it('selectLeverage: reduced in high volatility, 0 (NO_TRADE) in extreme volatility', () => {
    const cfg = strictConfig();
    const low = selectLeverage(0.002, 'LOW_VOLATILITY', cfg);
    assert.ok(low >= cfg.baseLeverage && low <= cfg.maxLeverage);
    assert.equal(selectLeverage(0.03, 'HIGH_VOLATILITY', cfg), 1);
    assert.equal(selectLeverage(0.05, 'SIDEWAYS', cfg), 1);
    assert.equal(selectLeverage(0.07, 'SIDEWAYS', cfg), 0, 'extreme volatility => 0 = do not trade');
    assert.equal(selectLeverage(0.10, 'STRONG_BULL', cfg), 0);
  });

  it('planStopLoss LONG sits below entry with ATR-bounded distance and a reason', () => {
    const candles = makeCandles(300, { seed: 5, driftPct: 0.002, volPct: 0.004 });
    const ind = computeIndicators(candles);
    const entry = candles[candles.length - 1].close;
    const sl = planStopLoss('LONG', entry, candles, ind);
    assert.ok(sl.price < entry, 'stop below entry for LONG');
    assert.ok(sl.distance_percent > 0);
    assert.ok(sl.reason.length > 0);
  });

  it('planTakeProfits LONG: ordered TP1 < TP2 < TP3, all above entry, RR positive', () => {
    const candles = makeCandles(300, { seed: 5, driftPct: 0.002, volPct: 0.004 });
    const ind = computeIndicators(candles);
    const entry = candles[candles.length - 1].close;
    const sl = planStopLoss('LONG', entry, candles, ind);
    const { plan, rr } = planTakeProfits('LONG', entry, sl.price, candles, ind);
    assert.ok(plan.tp1 < plan.tp2 && plan.tp2 < plan.tp3, 'ordered targets');
    assert.ok(plan.tp1 > entry, 'targets above entry');
    assert.ok(rr.tp1 > 0 && rr.tp2 > 0 && rr.tp3 > 0);
    assert.ok(rr.tp1 <= rr.tp2 && rr.tp2 <= rr.tp3, 'RR ladder');
  });

  it('planTakeProfits SHORT mirrors correctly', () => {
    const candles = makeCandles(300, { seed: 6, driftPct: -0.002, volPct: 0.004 });
    const ind = computeIndicators(candles);
    const entry = candles[candles.length - 1].close;
    const sl = planStopLoss('SHORT', entry, candles, ind);
    assert.ok(sl.price > entry, 'stop above entry for SHORT');
    const { plan, rr } = planTakeProfits('SHORT', entry, sl.price, candles, ind);
    assert.ok(plan.tp1 > plan.tp2 && plan.tp2 > plan.tp3, 'descending targets');
    assert.ok(plan.tp1 < entry);
    assert.ok(rr.tp2 >= 1, 'primary target at least ~1R');
  });

  it('planEntry returns a valid zone and a known entry type', () => {
    const candles = makeCandles(300, { seed: 9, driftPct: 0.002, volPct: 0.004 });
    const ind = computeIndicators(candles);
    const e = planEntry('LONG', candles, ind);
    assert.ok(['LIMIT', 'MARKET', 'BREAKOUT', 'RETEST', 'WAIT_FOR_RETEST'].includes(e.type));
    assert.ok(e.low < e.preferred && e.preferred < e.high, 'zone brackets preferred');
    assert.ok(e.reason.length > 0);
  });
});

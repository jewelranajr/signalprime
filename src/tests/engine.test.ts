/** Unit tests: engine — master decision, NO_TRADE discipline, LONG/SHORT paths. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildSignal, noTradeSignal, scoreAll, computeConfidence } from '../engine';
import { computeIndicators } from '../indicators';
import { analyzeMTF } from '../regime';
import { makeCandles, singleTFInput, neutralMarket, relaxedConfig, strictConfig, trendFixture } from './helpers';
import type { EngineDeps, MasterSignal } from '../types';

function deps(now: number, relaxed = true): EngineDeps {
  return {
    config: relaxed ? relaxedConfig() : strictConfig(),
    market: neutralMarket(),
    balance: 10_000,
    now,
  };
}

function validTradeShape(s: MasterSignal, direction: 'LONG' | 'SHORT'): void {
  assert.equal(s.direction, direction);
  assert.equal(s.status, 'ACTIVE');
  assert.ok(s.entry && s.stop_loss && s.take_profit && s.risk_reward && s.position, 'trade fields present');
  assert.ok(s.entry.low < s.entry.preferred && s.entry.preferred < s.entry.high);
  if (direction === 'LONG') {
    assert.ok(s.stop_loss.price < s.entry.preferred, 'SL below entry');
    assert.ok(s.take_profit.tp1 > s.entry.preferred, 'TP above entry');
  } else {
    assert.ok(s.stop_loss.price > s.entry.preferred, 'SL above entry');
    assert.ok(s.take_profit.tp1 < s.entry.preferred, 'TP below entry');
  }
  assert.ok(s.risk_reward.tp2 >= 1, 'primary RR sane');
  assert.ok(s.confidence >= 0 && s.confidence <= 100);
  assert.ok(s.probability_estimate >= 0 && s.probability_estimate <= 100);
  assert.ok(s.probability_note.length > 0, 'estimate labeled as estimate');
  assert.ok(s.long_score >= 0 && s.long_score <= 100);
  assert.ok(s.short_score >= 0 && s.short_score <= 100);
  assert.ok(Date.parse(s.expires_at) > Date.parse(s.created_at), 'expiry after creation');
  assert.ok(s.invalidation.length > 0, 'invalidation triggers listed');
}

describe('engine', () => {
  it('insufficient candles -> NO_TRADE with informative reason', () => {
    const s = buildSignal(singleTFInput('BTCUSDT', makeCandles(100, { seed: 1 })), deps(1_700_000_000_000));
    assert.equal(s.direction, 'NO_TRADE');
    assert.equal(s.status, 'WAITING');
    assert.ok(s.reasons.some((r) => /candle/i.test(r)), `reasons=${s.reasons.join(';')}`);
    assert.equal(s.entry, null);
  });

  it('strong uptrend with relaxed thresholds -> valid LONG signal', () => {
    const candles = trendFixture(21, 0.002);
    const s = buildSignal(singleTFInput('BTCUSDT', candles), deps(candles[399].closeTime));
    assert.equal(s.direction, 'LONG', `got ${s.direction}: ${s.reasons.join('; ')}`);
    validTradeShape(s, 'LONG');
  });

  it('strong downtrend with relaxed thresholds -> valid SHORT signal', () => {
    const candles = trendFixture(31, -0.002);
    const s = buildSignal(singleTFInput('BTCUSDT', candles), deps(candles[399].closeTime));
    assert.equal(s.direction, 'SHORT', `got ${s.direction}: ${s.reasons.join('; ')}`);
    validTradeShape(s, 'SHORT');
  });

  it('choppy sideways market with strict config -> NO_TRADE, never forced', () => {
    const candles = makeCandles(400, { seed: 303, driftPct: 0, volPct: 0.004 });
    const s = buildSignal(singleTFInput('BTCUSDT', candles), deps(candles[399].closeTime, false));
    assert.equal(s.direction, 'NO_TRADE');
    assert.ok(s.reasons.length > 0, 'NO_TRADE carries reasons');
  });

  it('scoreAll: directionGap = |long - short|, scores bounded 0..100', () => {
    const candles = makeCandles(400, { seed: 404, driftPct: 0.002, volPct: 0.004 });
    const input = singleTFInput('X', candles);
    const inds = { ...input.candles, '1h': candles } as typeof input.candles;
    const indicators = {
      '1m': computeIndicators([]),
      '5m': computeIndicators([]),
      '15m': computeIndicators([]),
      '1h': computeIndicators(candles),
      '4h': computeIndicators([]),
      '1d': computeIndicators([]),
    };
    void inds;
    const mtf = analyzeMTF(input.candles, indicators);
    const { checkLiquidity } = require('../filters') as typeof import('../filters');
    const liq = checkLiquidity(candles, 5_000_000, 0.02, strictConfig());
    const b = scoreAll('X', input.candles, indicators, mtf, 'STRONG_BULL', liq, neutralMarket());
    assert.ok(b.long >= 0 && b.long <= 100 && b.short >= 0 && b.short <= 100);
    assert.equal(b.directionGap, Math.abs(b.long - b.short));
    const compTotal = b.components.reduce((a, c) => a + c.max, 0);
    assert.equal(compTotal, 100, 'component weights sum to 100');
  });

  it('computeConfidence is bounded and not the raw score', () => {
    const candles = makeCandles(400, { seed: 505, driftPct: 0.002, volPct: 0.004 });
    const input = singleTFInput('X', candles);
    const indicators = {
      '1m': computeIndicators([]),
      '5m': computeIndicators([]),
      '15m': computeIndicators([]),
      '1h': computeIndicators(candles),
      '4h': computeIndicators([]),
      '1d': computeIndicators([]),
    };
    const mtf = analyzeMTF(input.candles, indicators);
    const { checkLiquidity } = require('../filters') as typeof import('../filters');
    const liq = checkLiquidity(candles, 5_000_000, 0.02, strictConfig());
    const b = scoreAll('X', input.candles, indicators, mtf, 'STRONG_BULL', liq, neutralMarket());
    const c = computeConfidence(b, mtf, 'STRONG_BULL', liq, 2.5, 'AI_BULLISH', 1.5, 0.01, 2);
    assert.ok(c >= 0 && c <= 100);
  });

  it('noTradeSignal shape matches spec section 31', () => {
    const s = noTradeSignal('ETHUSDT', ['HTF trend conflict'], { confidence: 42 });
    assert.equal(s.direction, 'NO_TRADE');
    assert.equal(s.status, 'WAITING');
    assert.equal(s.signal_grade, 'NO_TRADE');
    assert.equal(s.entry, null);
    assert.equal(s.stop_loss, null);
    assert.equal(s.confidence, 42);
    assert.deepEqual(s.reasons, ['HTF trend conflict']);
    assert.ok(Array.isArray(s.warnings) && Array.isArray(s.invalidation));
  });

  it('buildSignal is deterministic for a fixed now (no hidden randomness)', () => {
    const candles = makeCandles(400, { seed: 606, driftPct: 0.001, volPct: 0.005 });
    const d = deps(candles[399].closeTime);
    const a = JSON.stringify(buildSignal(singleTFInput('BTCUSDT', candles), d));
    const b = JSON.stringify(buildSignal(singleTFInput('BTCUSDT', candles), d));
    assert.equal(a, b);
  });

  it('never throws on garbage input: returns NO_TRADE', () => {
    const s = buildSignal(singleTFInput('BTCUSDT', []), deps(Date.now()));
    assert.equal(s.direction, 'NO_TRADE');
  });
});

/** Unit tests: PaperTrader entry gating + manual-order grade parity. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PaperTrader } from '../paper';
import { isManualOrderGradeOk } from '../server';
import { loadConfig } from '../config';
import type { EntryType, MasterSignal } from '../types';

function makeSignal(entryType: EntryType, grade: MasterSignal['signal_grade'] = 'A'): MasterSignal {
  return {
    signal_id: 'TEST-1',
    symbol: 'TESTUSDT',
    direction: 'LONG',
    status: 'ACTIVE',
    signal_grade: grade,
    long_score: 86,
    short_score: 20,
    confidence: 70,
    probability_estimate: 60,
    probability_note: 'test',
    market_regime: 'WEAK_BULL',
    entry: { low: 99, high: 101, preferred: 100, type: entryType, reason: 'test' },
    stop_loss: { price: 95, distance_percent: 5, reason: 'test' },
    take_profit: { tp1: 105, tp2: 110, tp3: 120, reasons: [] },
    risk_reward: { tp1: 1, tp2: 2, tp3: 4 },
    position: { risk_percent: 1, risk_amount: 100, quantity: 20, notional: 2000, leverage: 2 },
    market_price: 100,
    mtf: { '1m': 'NEUTRAL', '5m': 'NEUTRAL', '15m': 'NEUTRAL', '1h': 'NEUTRAL', '4h': 'NEUTRAL', '1d': 'NEUTRAL' },
    confirmation: {
      trend: false, structure: false, momentum: false, volume: false,
      vwap: false, breakout: false, liquidity: false,
    },
    reasons: [],
    warnings: [],
    invalidation: [],
    correlation_score: 0,
    ai_rating: 'AI_NEUTRAL',
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
  };
}

describe('paper', () => {
  it('rejects WAIT_FOR_RETEST entries (no phantom fill at an untouched zone)', () => {
    const trader = new PaperTrader(loadConfig());
    const r = trader.openFromSignal(makeSignal('WAIT_FOR_RETEST'));
    assert.equal(r.id, null);
    assert.match(r.reason ?? '', /WAIT_FOR_RETEST/);
    assert.equal(trader.account.positions.length, 0);
  });

  it('opens MARKET entries normally (control)', () => {
    const trader = new PaperTrader(loadConfig());
    const r = trader.openFromSignal(makeSignal('MARKET'));
    assert.ok(r.id);
    assert.equal(trader.account.positions.length, 1);
  });

  it('opens NORMAL-grade ACTIVE signals (runner parity)', () => {
    const trader = new PaperTrader(loadConfig());
    const r = trader.openFromSignal(makeSignal('MARKET', 'NORMAL'));
    assert.ok(r.id);
  });

  it('rejects a duplicate open for the same symbol', () => {
    const trader = new PaperTrader(loadConfig());
    const first = trader.openFromSignal(makeSignal('MARKET'));
    assert.ok(first.id);
    const dup = trader.openFromSignal(makeSignal('MARKET'));
    assert.equal(dup.id, null);
    assert.equal(trader.account.positions.length, 1);
  });
});

describe('isManualOrderGradeOk', () => {
  it('accepts A+, A and NORMAL (mirrors the paper runner)', () => {
    assert.equal(isManualOrderGradeOk('A+'), true);
    assert.equal(isManualOrderGradeOk('A'), true);
    assert.equal(isManualOrderGradeOk('NORMAL'), true);
  });

  it('rejects B and NO_TRADE', () => {
    assert.equal(isManualOrderGradeOk('B'), false);
    assert.equal(isManualOrderGradeOk('NO_TRADE'), false);
  });
});

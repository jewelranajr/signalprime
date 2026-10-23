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
    watch: null,
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

describe('paper close lifecycle (Phase H: explicit close-pipeline verification)', () => {
  // Time-coherent fixtures for the R1 settlement guard: positions open at T0,
  // settlement candles are 15m bars strictly after T0.
  const T0 = 1_700_000_000_000;
  const candle = (k: number, o: number, h: number, l: number, c: number) => {
    const openTime = T0 + k * 15 * 60 * 1000;
    return {
      openTime, open: o, high: h, low: l, close: c, volume: 1,
      closeTime: openTime + 15 * 60 * 1000 - 1,
    };
  };
  const openAtT0 = (sig: MasterSignal): MasterSignal => {
    sig.created_at = new Date(T0).toISOString();
    return sig;
  };

  it('SL hit closes at the stop price with fees; no duplicate close afterwards', () => {
    const trader = new PaperTrader(loadConfig());
    // makeSignal: LONG entry 100, SL 95, TPs 105/110/120
    const r = trader.openFromSignal(openAtT0(makeSignal('MARKET')));
    assert.ok(r.id);
    trader.onCandle('TESTUSDT', candle(1, 100, 102, 98, 101));
    assert.equal(trader.account.positions.length, 1, 'untouched candle keeps position open');
    trader.onCandle('TESTUSDT', candle(2, 99, 99.5, 93, 94));
    assert.equal(trader.account.positions.length, 0, 'SL breach closes the position');
    const hist = trader.account.tradeHistory;
    assert.equal(hist.length, 1);
    assert.equal(hist[0].exitReason, 'SL');
    assert.ok(hist[0].pnlQuote < 0, `SL must lose money, pnlQuote=${hist[0].pnlQuote}`);
    assert.ok(hist[0].fees > 0, 'fees charged on close');
    // A later candle must not close anything again (duplicate-close guard).
    trader.onCandle('TESTUSDT', candle(3, 90, 95, 89, 90));
    assert.equal(trader.account.tradeHistory.length, 1, 'no duplicate close');
  });

  it('TP legs close fractions at targets; full chain closes the position with profit', () => {
    const trader = new PaperTrader(loadConfig());
    const r = trader.openFromSignal(openAtT0(makeSignal('MARKET')));
    assert.ok(r.id);
    // One strong candle tagging all three TPs (105/110/120), fractions 0.4/0.3/0.3.
    trader.onCandle('TESTUSDT', candle(1, 100, 121, 99, 119));
    assert.equal(trader.account.positions.length, 0, 'all TP legs closed');
    const hist = trader.account.tradeHistory;
    assert.ok(hist.length >= 1, 'TP legs recorded');
    const net = hist.reduce((a, t) => a + t.pnlQuote, 0);
    assert.ok(net > 0, `TP chain must profit, net=${net}`);
    assert.ok(hist.every((t) => t.fees >= 0), 'fees non-negative on every leg');
  });

  it('SHORT SL hit closes when candle high breaches the stop', () => {
    const trader = new PaperTrader(loadConfig());
    const shortSig = { ...makeSignal('MARKET'), direction: 'SHORT' as const, signal_id: 'TEST-2' };
    // makeSignal builds LONG levels; mirror them for the SHORT case.
    shortSig.entry = { low: 99, high: 101, preferred: 100, type: 'MARKET', reason: 'test' };
    shortSig.stop_loss = { price: 105, distance_percent: 5, reason: 'test' };
    shortSig.take_profit = { tp1: 95, tp2: 90, tp3: 80, reasons: [] };
    const r = trader.openFromSignal(openAtT0(shortSig));
    assert.ok(r.id);
    trader.onCandle('TESTUSDT', candle(1, 100, 106, 99, 104));
    assert.equal(trader.account.positions.length, 0, 'SHORT SL breach closes');
    const hist = trader.account.tradeHistory;
    assert.equal(hist.length, 1);
    assert.equal(hist[0].exitReason, 'SL');
    assert.ok(hist[0].pnlQuote < 0, 'SHORT SL loses money');
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

/** P0 R2 regression tests: reject LIMIT/RETEST phantom fills.
 * The paper trader must never fill at a price level price has not visited.
 * MARKET/BREAKOUT (tradable now) still open; WAIT_FOR_RETEST stays rejected.
 * Deterministic: no randomness, no network.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PaperTrader } from '../paper';
import { loadConfig } from '../config';
import type { EntryType, MasterSignal } from '../types';

function makeSignal(entryType: EntryType, symbol = 'TESTUSDT'): MasterSignal {
  return {
    signal_id: `R2-${entryType}`,
    symbol,
    direction: 'LONG',
    status: 'ACTIVE',
    signal_grade: 'A',
    long_score: 86,
    short_score: 20,
    confidence: 82,
    probability_estimate: 70,
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

describe('P0 R2: no phantom fills at unvisited price levels', () => {
  it('T-R2a: LIMIT entry is rejected (level not yet touched)', () => {
    const trader = new PaperTrader(loadConfig());
    const before = trader.account.balance;
    const r = trader.openFromSignal(makeSignal('LIMIT'));
    assert.equal(r.id, null, 'LIMIT must not open');
    assert.match(r.reason ?? '', /LIMIT/, 'reason names the entry type');
    assert.match(r.reason ?? '', /not yet touched/, 'reason explains why');
    assert.equal(trader.account.positions.length, 0);
    assert.equal(trader.account.balance, before, 'no fee taken on rejection');
  });

  it('T-R2b: RETEST entry is rejected (level not yet touched)', () => {
    const trader = new PaperTrader(loadConfig());
    const before = trader.account.balance;
    const r = trader.openFromSignal(makeSignal('RETEST'));
    assert.equal(r.id, null, 'RETEST must not open');
    assert.match(r.reason ?? '', /RETEST/);
    assert.equal(trader.account.positions.length, 0);
    assert.equal(trader.account.balance, before);
  });

  it('T-R2c: MARKET entry still opens (control — tradable now)', () => {
    const trader = new PaperTrader(loadConfig());
    const r = trader.openFromSignal(makeSignal('MARKET'));
    assert.ok(r.id, 'MARKET must open');
    assert.equal(trader.account.positions.length, 1);
  });

  it('T-R2d: BREAKOUT entry still opens (control — tradable now)', () => {
    const trader = new PaperTrader(loadConfig());
    const r = trader.openFromSignal(makeSignal('BREAKOUT', 'BRKUSDT'));
    assert.ok(r.id, 'BREAKOUT must open');
    assert.equal(trader.account.positions.length, 1);
  });

  it('T-R2e: WAIT_FOR_RETEST stays rejected (no regression)', () => {
    const trader = new PaperTrader(loadConfig());
    const r = trader.openFromSignal(makeSignal('WAIT_FOR_RETEST'));
    assert.equal(r.id, null);
    assert.match(r.reason ?? '', /WAIT_FOR_RETEST/);
    assert.equal(trader.account.positions.length, 0);
  });

  it('T-R2f: rejected LIMIT/RETEST never reach the ledger (no history, no fees)', () => {
    const trader = new PaperTrader(loadConfig());
    for (const t of ['LIMIT', 'RETEST', 'WAIT_FOR_RETEST'] as EntryType[]) {
      const r = trader.openFromSignal(makeSignal(t, `${t}USDT`));
      assert.equal(r.id, null);
    }
    const acct = trader.account;
    assert.equal(acct.positions.length, 0);
    assert.equal(acct.tradeHistory.length, 0);
    assert.equal(acct.totalFees, 0, 'rejected signals must not accrue fees');
    assert.equal(acct.realizedPnl, 0);
  });
});

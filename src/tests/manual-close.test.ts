/**
 * Regression tests for the manual-close re-entry fix (2026-10-22).
 *
 * Bug: a manual close intent did not clear pendingConfirmations and no
 * manual-close cooldown existed, so a still-ACTIVE signal re-entered the
 * identical setup ~14s after the user's close (CFGUSDT SHORT, verified
 * on the live paper API).
 *
 * Fix: processPaperIntents fires onClose after a successful manual close;
 * the runner clears the symbol's pending confirmation and records a
 * 60-minute manual-close cooldown scoped to symbol+direction.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CooldownTracker } from '../filters';
import { PaperTrader } from '../paper';
import { loadConfig } from '../config';
import {
  applyManualClose,
  processPaperIntents,
  type PaperIntent,
} from '../paper-intents';
import type { Direction, EntryType, MasterSignal } from '../types';

const T0 = 1_792_678_000_000; // fixed "now" for deterministic tests
const HOUR = 3_600_000;

function makeSignal(symbol: string, direction: 'LONG' | 'SHORT'): MasterSignal {
  return {
    signal_id: 'TEST-1',
    symbol,
    direction,
    status: 'ACTIVE',
    signal_grade: 'A',
    long_score: 86,
    short_score: 20,
    confidence: 70,
    probability_estimate: 60,
    probability_note: 'test',
    market_regime: 'SIDEWAYS',
    entry: { low: 99, high: 101, preferred: 100, type: 'MARKET' as EntryType, reason: 'test' },
    stop_loss: { price: 95, distance_percent: 5, reason: 'test' },
    take_profit: { tp1: 105, tp2: 110, tp3: 120, reasons: [] },
    risk_reward: { tp1: 1, tp2: 2, tp3: 4 },
    position: { risk_percent: 1, risk_amount: 100, quantity: 20, notional: 2000, leverage: 2 },
    market_price: 100,
    mtf: { '1m': 'NEUTRAL', '5m': 'NEUTRAL', '15m': 'NEUTRAL', '1h': 'NEUTRAL', '4h': 'NEUTRAL', '1d': 'NEUTRAL' },
    confirmation: { trend: false, structure: false, momentum: false, volume: false, vwap: false, breakout: false, liquidity: false },
    reasons: [],
    warnings: [],
    invalidation: [],
    correlation_score: 0,
    ai_rating: 'AI_NEUTRAL',
    watch: null,
    expires_at: new Date(T0 + HOUR).toISOString(),
    created_at: new Date(T0).toISOString(),
  } as MasterSignal;
}

describe('manual-close re-entry guard', () => {
  it('applyManualClose clears only the closed symbol pending confirmation', () => {
    const pending = new Map<string, { direction: 'LONG' | 'SHORT'; cycle: number }>([
      ['CFGUSDT', { direction: 'SHORT', cycle: 7 }],
      ['BTCUSDT', { direction: 'LONG', cycle: 7 }],
    ]);
    const cooldowns = new CooldownTracker(loadConfig());
    applyManualClose(pending, cooldowns, 'CFGUSDT', 'SHORT', T0);
    assert.equal(pending.has('CFGUSDT'), false);
    assert.equal(pending.has('BTCUSDT'), true, 'other symbols untouched');
  });

  it('applyManualClose starts the manual-close cooldown', () => {
    const pending = new Map<string, { direction: 'LONG' | 'SHORT'; cycle: number }>();
    const cooldowns = new CooldownTracker(loadConfig());
    applyManualClose(pending, cooldowns, 'CFGUSDT', 'SHORT', T0);
    const r = cooldowns.canEmit('CFGUSDT', 'SHORT', 'SIDEWAYS', T0 + 1_000);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'Manual-close cooldown');
  });

  it('manual-close cooldown blocks for 60m then expires', () => {
    const cooldowns = new CooldownTracker(loadConfig());
    cooldowns.recordManualClose('CFGUSDT', 'SHORT', T0);
    assert.equal(cooldowns.canEmit('CFGUSDT', 'SHORT', 'SIDEWAYS', T0 + 59 * 60_000).ok, false);
    assert.equal(
      cooldowns.canEmit('CFGUSDT', 'SHORT', 'SIDEWAYS', T0 + HOUR + 1).ok,
      true,
      'legitimate new signals work again after expiry',
    );
  });

  it('cooldown scope: other symbols and opposite direction are never blocked', () => {
    const cooldowns = new CooldownTracker(loadConfig());
    cooldowns.recordManualClose('CFGUSDT', 'SHORT', T0);
    assert.equal(cooldowns.canEmit('BTCUSDT', 'SHORT', 'SIDEWAYS', T0 + 1_000).ok, true);
    assert.equal(cooldowns.canEmit('CFGUSDT', 'LONG', 'SIDEWAYS', T0 + 1_000).ok, true);
  });

  it('invalid recordManualClose inputs are ignored', () => {
    const cooldowns = new CooldownTracker(loadConfig());
    cooldowns.recordManualClose('', 'SHORT', T0);
    cooldowns.recordManualClose('CFGUSDT', 'NO_TRADE' as Direction, T0);
    assert.equal(cooldowns.canEmit('CFGUSDT', 'SHORT', 'SIDEWAYS', T0 + 1_000).ok, true);
  });

  it('stop-loss cooldown behavior is unchanged', () => {
    const cooldowns = new CooldownTracker(loadConfig());
    cooldowns.recordStopLoss('CFGUSDT', 'SHORT', T0);
    const r = cooldowns.canEmit('CFGUSDT', 'SHORT', 'SIDEWAYS', T0 + 23 * HOUR);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'Post-SL cooldown (24h)');
    // manual close must not arm the SL cooldown, and vice versa
    const c2 = new CooldownTracker(loadConfig());
    c2.recordManualClose('ETHUSDT', 'LONG', T0);
    assert.deepEqual(c2.serializeSlCooldowns(), []);
    const c3 = new CooldownTracker(loadConfig());
    c3.recordStopLoss('ETHUSDT', 'LONG', T0);
    assert.deepEqual(c3.serializeManualCooldowns(), []);
  });

  it('manual cooldowns survive serialize/deserialize (restart persistence)', () => {
    const c1 = new CooldownTracker(loadConfig());
    c1.recordManualClose('CFGUSDT', 'SHORT', T0);
    const c2 = new CooldownTracker(loadConfig());
    c2.deserializeManualCooldowns(c1.serializeManualCooldowns());
    assert.equal(c2.canEmit('CFGUSDT', 'SHORT', 'SIDEWAYS', T0 + 1_000).ok, false);
    assert.equal(c2.canEmit('CFGUSDT', 'SHORT', 'SIDEWAYS', T0 + HOUR + 1).ok, true);
  });

  describe('processPaperIntents close lifecycle', () => {
    let tmpFile: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = { getKlines: async () => [{ close: 101 }] } as any;

    beforeEach(() => {
      tmpFile = path.join(os.tmpdir(), `test-intents-${Date.now()}-${Math.random()}.json`);
      process.env.PAPER_INTENTS_PATH = tmpFile;
    });
    afterEach(() => {
      delete process.env.PAPER_INTENTS_PATH;
      try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    });

    function writeIntents(intents: PaperIntent[]): void {
      fs.writeFileSync(tmpFile, JSON.stringify(intents, null, 2));
    }
    function readIntents(): PaperIntent[] {
      return JSON.parse(fs.readFileSync(tmpFile, 'utf8')) as PaperIntent[];
    }
    function closeIntent(id: string, symbol: string): PaperIntent {
      return { id, type: 'close', symbol, createdAt: new Date(T0).toISOString(), status: 'pending' };
    }

    it('successful close intent fires onClose exactly once', async () => {
      const trader = new PaperTrader(loadConfig());
      const r = trader.openFromSignal(makeSignal('TESTUSDT', 'LONG'));
      assert.ok(r.id, 'position should open');
      writeIntents([closeIntent('c1', 'TESTUSDT')]);

      const calls: Array<[string, Direction]> = [];
      await processPaperIntents(client, trader, () => {}, (s, d) => { calls.push([s, d]); });

      const intents = readIntents();
      assert.equal(intents[0].status, 'done');
      assert.deepEqual(calls, [['TESTUSDT', 'LONG']], 'onClose fired exactly once');
      assert.equal(trader.account.tradeHistory.length, 1);
      assert.equal(trader.account.tradeHistory[0].exitReason, 'MANUAL');
    });

    it('repeated close intent is idempotent: rejected, no double onClose, no duplicate history', async () => {
      const trader = new PaperTrader(loadConfig());
      const r = trader.openFromSignal(makeSignal('TESTUSDT', 'LONG'));
      assert.ok(r.id);
      writeIntents([closeIntent('c1', 'TESTUSDT'), closeIntent('c2', 'TESTUSDT')]);

      const calls: Array<[string, Direction]> = [];
      await processPaperIntents(client, trader, () => {}, (s, d) => { calls.push([s, d]); });

      const intents = readIntents();
      assert.equal(intents[0].status, 'done');
      assert.equal(intents[1].status, 'rejected');
      assert.equal(intents[1].note, 'no open position');
      assert.deepEqual(calls, [['TESTUSDT', 'LONG']], 'onClose not re-armed by the repeat');
      assert.equal(trader.account.tradeHistory.length, 1, 'no duplicate close in history');
    });

    it('close intent for a symbol with no position is rejected without side effects', async () => {
      const trader = new PaperTrader(loadConfig());
      writeIntents([closeIntent('c9', 'NOPEUSDT')]);
      const calls: Array<[string, Direction]> = [];
      await processPaperIntents(client, trader, () => {}, (s, d) => { calls.push([s, d]); });
      const intents = readIntents();
      assert.equal(intents[0].status, 'rejected');
      assert.deepEqual(calls, []);
      assert.equal(trader.account.tradeHistory.length, 0);
    });
  });
});

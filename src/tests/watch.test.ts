/** Phase 2 WATCH tests: display-only early-move detection.
 * Invariants pinned here:
 *  - detectWatchTriggers is causal and needs no minimum score to run.
 *  - WATCH marks ONLY NO_TRADE signals (direction NO_TRADE, status WAITING),
 *    so the paper runner (skips non-ACTIVE) and the order endpoint can never
 *    execute one. A WATCH must never become ACTIVE on its own.
 *  - Fewer than 2 triggers -> no WATCH.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildSignal, detectWatchTriggers, noTradeSignal } from '../engine';
import { PaperTrader } from '../paper';
import { loadConfig } from '../config';
import {
  makeCandles,
  singleTFInput,
  neutralMarket,
  strictConfig,
} from './helpers';
import type { Candle, IndicatorSet, EngineDeps } from '../types';

function deps(now: number): EngineDeps {
  return { config: strictConfig(), market: neutralMarket(), balance: 10_000, now };
}

/** Minimal synthetic IndicatorSet for the fields detectWatchTriggers reads. */
function synthInd(n: number, o: {
  atrMult?: number;
  histDir?: 'up' | 'down' | 'flat';
  squeeze?: boolean;
} = {}): IndicatorSet {
  const volumeSMA = new Array(n).fill(1000);
  const atr = new Array(n).fill(1);
  const histogram = new Array(n).fill(0);
  const bandwidth = new Array(n).fill(0.05);
  const last = n - 1;
  if (o.atrMult) {
    for (let i = last - 20; i < last; i++) atr[i] = 1;
    atr[last] = o.atrMult;
  }
  if (o.histDir === 'up') {
    histogram[last - 2] = 0.1; histogram[last - 1] = 0.2; histogram[last] = 0.35;
  } else if (o.histDir === 'down') {
    histogram[last - 2] = -0.1; histogram[last - 1] = -0.2; histogram[last] = -0.35;
  }
  if (o.squeeze) {
    for (let i = 0; i < n; i++) bandwidth[i] = 0.05;
    for (let i = last - 20; i < last; i++) bandwidth[i] = 0.02; // compressed
    bandwidth[last] = 0.02 * 1.4; // expanding
  }
  return {
    volumeSMA, atr, bollinger: { bandwidth } as IndicatorSet['bollinger'],
    macd: { histogram } as IndicatorSet['macd'],
  } as IndicatorSet;
}

function synthPcs(n: number, lastVol: number): Candle[] {
  const pcs = makeCandles(n, { seed: 7, driftPct: 0, volPct: 0.002 });
  pcs[n - 1] = { ...pcs[n - 1], volume: lastVol };
  return pcs;
}

describe('WATCH detector', () => {
  it('fires vol-expansion + atr-expansion on a volume/ATR spike', () => {
    const n = 100;
    const t = detectWatchTriggers(synthPcs(n, 3000), synthInd(n, { atrMult: 1.8 }));
    assert.ok(t.some((x) => x.startsWith('vol-expansion')), `triggers=${t}`);
    assert.ok(t.some((x) => x.startsWith('atr-expansion')), `triggers=${t}`);
  });

  it('fires momentum-accel + squeeze-release on acceleration after compression', () => {
    const n = 100;
    const t = detectWatchTriggers(synthPcs(n, 1000), synthInd(n, { histDir: 'up', squeeze: true }));
    assert.ok(t.some((x) => x.startsWith('momentum-accel')), `triggers=${t}`);
    assert.ok(t.some((x) => x === 'squeeze-release'), `triggers=${t}`);
  });

  it('flat market -> no triggers', () => {
    const n = 100;
    const t = detectWatchTriggers(synthPcs(n, 1000), synthInd(n));
    assert.deepEqual(t, []);
  });

  it('short history (<61 bars) -> no triggers (needs lookback)', () => {
    const n = 50;
    const t = detectWatchTriggers(synthPcs(n, 5000), synthInd(n, { atrMult: 3, histDir: 'up' }));
    assert.deepEqual(t, []);
  });

  it('single trigger alone is reported by the detector (buildSignal applies the >=2 gate)', () => {
    const n = 100;
    const t = detectWatchTriggers(synthPcs(n, 3000), synthInd(n));
    assert.equal(t.length, 1, `expected exactly vol-expansion, got ${t}`);
  });
});

describe('WATCH signal shape (never executable)', () => {
  it('noTradeSignal carries watch through with NO_TRADE/WAITING', () => {
    const s = noTradeSignal('TSTUSDT', ['No qualifying candidate'], {
      watch: { triggers: ['vol-expansion 2.5x', 'atr-expansion 1.60x'] },
      scores: { long: 40, short: 45 },
    });
    assert.equal(s.direction, 'NO_TRADE');
    assert.equal(s.status, 'WAITING');
    assert.equal(s.signal_grade, 'NO_TRADE');
    assert.deepEqual(s.watch, { triggers: ['vol-expansion 2.5x', 'atr-expansion 1.60x'] });
    assert.equal(s.entry, null, 'no entry plan on WATCH');
    assert.equal(s.position, null, 'no position sizing on WATCH');
  });

  it('plain NO_TRADE has watch=null', () => {
    const s = noTradeSignal('TSTUSDT', ['No qualifying candidate']);
    assert.equal(s.watch, null);
  });

  it('ACTIVE and NORMAL signals always have watch=null', () => {
    // seed=23 -> score 80 LONG ACTIVE NORMAL (pinned by normal-tier.test.ts)
    const candles = makeCandles(400, { seed: 23, driftPct: 0.001, volPct: 0.003 });
    const s = buildSignal(singleTFInput('TSTUSDT', candles), deps(candles[399].closeTime));
    assert.equal(s.signal_grade, 'NORMAL');
    assert.equal(s.watch, null);
  });

  it('paper trader rejects a WATCH signal: never opens a position', () => {
    const trader = new PaperTrader(loadConfig());
    const watchSignal = noTradeSignal('TSTUSDT', [
      'No qualifying candidate: long 40 / short 45 below minimum score 85',
      'WATCH: developing move (vol-expansion 2.5x, atr-expansion 1.60x) — display only, not a trade',
    ], {
      watch: { triggers: ['vol-expansion 2.5x', 'atr-expansion 1.60x'] },
      scores: { long: 40, short: 45 },
    });
    const res = trader.openFromSignal(watchSignal);
    assert.equal(res.id, null, 'WATCH must never open a position');
    assert.ok(/NO_TRADE/.test(res.reason ?? ''), `reason=${res.reason}`);
    assert.equal(trader.account.positions.length, 0);
  });
});

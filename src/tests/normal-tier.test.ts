/** Regression tests: NORMAL tier 65-84 continuity (NORMAL_MAX_SCORE 80 -> 84).
 * Pins the intended behavior after closing the 81-84 dead zone:
 *  - tier spans 65..84 (gradeSignal + config default)
 *  - paper-entry threshold stays at 80 (65-79 remain display-only NO_TRADE)
 *  - score 80 boundary still paper-trades as NORMAL/ACTIVE
 *  - 85+ still takes the GOOD path, never NORMAL
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildSignal } from '../engine';
import { gradeSignal } from '../filters';
import { loadConfig } from '../config';
import {
  makeCandles,
  singleTFInput,
  neutralMarket,
  strictConfig,
} from './helpers';
import type { EngineDeps } from '../types';

function deps(now: number): EngineDeps {
  return { config: strictConfig(), market: neutralMarket(), balance: 10_000, now };
}

function gradeMtf() {
  return {
    views: {},
    weightedScore: 60,
    htfBias: 'BULLISH',
    agreement: 85,
    confirmsLong: true,
    confirmsShort: false,
  } as unknown as import('../types').MTFAnalysis;
}

function gradeLiq() {
  return {
    ok: true,
    quoteVolume24h: 50_000_000,
    spreadPct: 0.01,
    score: 95,
    issues: [],
  } as unknown as import('../types').LiquidityCheck;
}

describe('NORMAL tier 65-84 (dead-zone closure)', () => {
  it('config default: NORMAL_MAX_SCORE is 84, paper-entry threshold unchanged', () => {
    const cfg = loadConfig();
    assert.equal(cfg.normalMaxScore, 84);
    assert.equal(cfg.normalMinScore, 65);
    assert.equal(cfg.minScore, 85, 'GOOD tier untouched');
  });

  it('gradeSignal: 65..84 grade NORMAL; 64 and below stay NO_TRADE', () => {
    const cfg = strictConfig();
    for (const s of [65, 70, 79, 80, 81, 82, 84]) {
      assert.equal(gradeSignal(s, 20, 90, 3.0, gradeMtf(), gradeLiq(), cfg), 'NORMAL', `score ${s}`);
      assert.equal(gradeSignal(20, s, 90, 3.0, gradeMtf(), gradeLiq(), cfg), 'NORMAL', `short ${s}`);
    }
    assert.equal(gradeSignal(64, 20, 90, 3.0, gradeMtf(), gradeLiq(), cfg), 'NO_TRADE');
    assert.equal(gradeSignal(50, 20, 90, 3.0, gradeMtf(), gradeLiq(), cfg), 'NO_TRADE');
  });

  it('gradeSignal: 85+ never grades NORMAL (GOOD path intact)', () => {
    const cfg = strictConfig();
    assert.equal(gradeSignal(86, 20, 82, 2.1, gradeMtf(), gradeLiq(), cfg), 'A');
    assert.equal(gradeSignal(86, 20, 70, 2.1, gradeMtf(), gradeLiq(), cfg), 'B', 'weak confidence -> B, not NORMAL');
  });

  it('engine: score 72 stays NO_TRADE below the 80 paper-entry threshold', () => {
    const candles = makeCandles(400, { seed: 6, driftPct: 0.001, volPct: 0.003 });
    const s = buildSignal(singleTFInput('TSTUSDT', candles), deps(candles[399].closeTime));
    const best = Math.max(s.long_score, s.short_score);
    assert.ok(best >= 65 && best < 80, `expected 65-79, got ${best}`);
    assert.equal(s.direction, 'NO_TRADE');
    assert.equal(s.signal_grade, 'NO_TRADE');
    assert.ok(
      s.reasons.some((r) => /below paper entry threshold/.test(r)),
      `reasons=${s.reasons.join(';')}`,
    );
  });

  it('engine: score exactly 80 still paper-trades as NORMAL/ACTIVE', () => {
    const candles = makeCandles(400, { seed: 23, driftPct: 0.001, volPct: 0.003 });
    const s = buildSignal(singleTFInput('TSTUSDT', candles), deps(candles[399].closeTime));
    const best = Math.max(s.long_score, s.short_score);
    assert.ok(best >= 80 && best < 85, `expected 80-84, got ${best}`);
    assert.equal(s.signal_grade, 'NORMAL');
    assert.notEqual(s.direction, 'NO_TRADE');
    assert.ok(s.entry && s.stop_loss, 'trade levels present');
  });
});

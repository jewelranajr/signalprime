/** Regression tests: liquidity-sweep penalty cap (per direction, -20). */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scoreAll, SWEEP_PENALTY_CAP } from '../engine';
import { computeIndicators } from '../indicators';
import { analyzeMTF } from '../regime';
import { makeCandles, singleTFInput, neutralMarket, strictConfig } from './helpers';
import type { LiquiditySweep, ScoreBreakdown } from '../types';

function sweep(index: number, side: 'BUY_SIDE' | 'SELL_SIDE'): LiquiditySweep {
  return { index, time: index, side, sweptLevel: 100, wicked: true, reclaimed: true };
}

/** Score with a fabricated sweep fixture injected on the primary ('1h') set. */
function scoreWithSweeps(sweeps: LiquiditySweep[]): ScoreBreakdown {
  const candles = makeCandles(400, { seed: 606, driftPct: 0.001, volPct: 0.004 });
  const input = singleTFInput('X', candles);
  const lastIdx = candles.length - 1;
  assert.ok(
    sweeps.every((s) => s.index >= 0 && lastIdx - s.index <= 10),
    'fixture sweeps must be within the 10-bar penalty window',
  );
  const indicators = {
    '1m': computeIndicators([]),
    '5m': computeIndicators([]),
    '15m': computeIndicators([]),
    '1h': computeIndicators(candles),
    '4h': computeIndicators([]),
    '1d': computeIndicators([]),
  };
  // Inject fixture (scoreAll reads sind.liquiditySweeps; the list itself must
  // never be mutated by the cap logic).
  (indicators['1h'] as { liquiditySweeps: LiquiditySweep[] }).liquiditySweeps = sweeps;
  const mtf = analyzeMTF(input.candles, indicators);
  const { checkLiquidity } = require('../filters') as typeof import('../filters');
  const liq = checkLiquidity(candles, 5_000_000, 0.02, strictConfig());
  const b = scoreAll('X', input.candles, indicators, mtf, 'STRONG_BULL', liq, neutralMarket());
  // The sweep list must be untouched (manipulation veto + regime read it).
  assert.equal(
    (indicators['1h'] as { liquiditySweeps: LiquiditySweep[] }).liquiditySweeps.length,
    sweeps.length,
    'sweep list must not be mutated by scoreAll',
  );
  return b;
}

/** Per-side applied sweep penalty = raw entries + cap relief entries. */
function appliedSweep(b: ScoreBreakdown, side: 'long' | 'short'): number {
  return b.penalties
    .filter((p) => p.name === 'Liquidity sweep' || p.name === 'Liquidity sweep cap')
    .reduce((a, p) => a + p[side], 0);
}

function rawSweep(b: ScoreBreakdown, side: 'long' | 'short'): number {
  return b.penalties
    .filter((p) => p.name === 'Liquidity sweep')
    .reduce((a, p) => a + p[side], 0);
}

describe('sweep-cap', () => {
  it('cap constant is -20 per direction', () => {
    assert.equal(SWEEP_PENALTY_CAP, -20);
  });

  it('single sweep -> exactly -10, no cap entry', () => {
    const b = scoreWithSweeps([sweep(398, 'BUY_SIDE')]);
    assert.equal(appliedSweep(b, 'long'), -10);
    assert.equal(appliedSweep(b, 'short'), 0);
    assert.ok(
      !b.penalties.some((p) => p.name === 'Liquidity sweep cap'),
      'no cap entry when under the cap',
    );
  });

  it('six buy-side sweeps -> aggregate capped at -20, not -60', () => {
    const b = scoreWithSweeps([398, 397, 396, 395, 394, 393].map((i) => sweep(i, 'BUY_SIDE')));
    assert.equal(rawSweep(b, 'long'), -60, 'raw entries preserved for diagnostics');
    assert.equal(appliedSweep(b, 'long'), -20, 'applied total capped at -20');
    assert.equal(
      b.penalties.filter((p) => p.name === 'Liquidity sweep').length,
      6,
      'all 6 individual sweep entries kept',
    );
  });

  it('buy-side sweeps never touch the short side', () => {
    const b = scoreWithSweeps([398, 397, 396].map((i) => sweep(i, 'BUY_SIDE')));
    assert.equal(rawSweep(b, 'short'), 0);
    assert.equal(appliedSweep(b, 'short'), 0);
    assert.ok(
      !b.penalties.some((p) => p.name === 'Liquidity sweep cap' && p.short !== 0),
      'no short-side cap entry for buy-side sweeps',
    );
  });

  it('sell-side stacking capped independently at -20', () => {
    const b = scoreWithSweeps([398, 397, 396, 395].map((i) => sweep(i, 'SELL_SIDE')));
    assert.equal(rawSweep(b, 'short'), -40);
    assert.equal(appliedSweep(b, 'short'), -20);
    assert.equal(appliedSweep(b, 'long'), 0);
  });

  it('score consistency: capped total == max(cap, uncapped)', () => {
    for (const n of [0, 1, 2, 3, 5, 8]) {
      const b = scoreWithSweeps(
        Array.from({ length: n }, (_, k) => sweep(398 - k, 'BUY_SIDE')),
      );
      const raw = rawSweep(b, 'long');
      assert.equal(appliedSweep(b, 'long'), Math.max(SWEEP_PENALTY_CAP, raw), `n=${n}`);
      assert.ok(b.long >= 0 && b.long <= 100 && b.short >= 0 && b.short <= 100);
    }
  });
});

describe('penalty_groups (P2 diagnostics)', () => {
  it('summarizePenalties aggregates by group name', async () => {
    const { summarizePenalties } = await import('../engine');
    const groups = summarizePenalties([
      { name: 'Liquidity sweep', long: -10, short: 0, reason: 'a' },
      { name: 'Liquidity sweep', long: -10, short: 0, reason: 'b' },
      { name: 'Pump chase', long: -12, short: 0, reason: 'c' },
    ]);
    assert.equal(groups.length, 2);
    const sweep = groups.find((g) => g.name === 'Liquidity sweep');
    assert.equal(sweep?.long, -20);
    assert.equal(sweep?.short, 0);
  });

  it('buildSignal attaches penalty_groups on NO_TRADE outputs', async () => {
    const { buildSignal } = await import('../engine');
    const { makeCandles, singleTFInput, neutralMarket, relaxedConfig } = await import('./helpers');
    const candles = makeCandles(400, { seed: 707, driftPct: 0, volPct: 0.004 });
    const s = buildSignal(singleTFInput('X', candles), {
      config: relaxedConfig(),
      market: neutralMarket(),
      balance: 10_000,
      now: candles[399].closeTime,
    });
    assert.ok(Array.isArray(s.penalty_groups), 'penalty_groups present');
  });
});

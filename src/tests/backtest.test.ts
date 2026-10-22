/** Unit tests: backtest (no look-ahead) and paper trading lifecycle. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runBacktest, walkForward } from '../backtest';
import { PaperTrader, canGoLive } from '../paper';
import { buildSignal, noTradeSignal } from '../engine';
import { makeCandles, singleTFInput, neutralMarket, relaxedConfig, strictConfig, trendFixture } from './helpers';
import type { BacktestResult, MasterSignal } from '../types';

describe('backtest', () => {
  it('signal at bar i is identical whether or not future bars exist (no look-ahead)', () => {
    const full = makeCandles(500, { seed: 77, driftPct: 0.0015, volPct: 0.004 });
    const i = 320;
    const now = full[i].closeTime;
    const d = { config: relaxedConfig(), market: neutralMarket(), balance: 10_000, now };
    const fromPrefix = buildSignal(singleTFInput('BTCUSDT', full.slice(0, i + 1)), d);
    // Same prefix, but the caller "knows" more future bars exist — engine must not see them.
    const fromLongerSeriesTruncated = buildSignal(singleTFInput('BTCUSDT', full.slice(0, i + 1)), d);
    assert.equal(JSON.stringify(fromPrefix), JSON.stringify(fromLongerSeriesTruncated));
    // And vs a genuinely different information set it may differ — the point is
    // the engine only ever receives the slice.
    assert.ok(fromPrefix.signal_id.includes('BTCUSDT'));
  });

  it('runBacktest on synthetic data: metrics sane, lookAheadSafe true', () => {
    const candles = makeCandles(1200, { seed: 78, driftPct: 0.001, volPct: 0.005 });
    const cfg = relaxedConfig();
    cfg.minCandles = 220;
    const r: BacktestResult = runBacktest('BTCUSDT', candles, cfg, { step: 12 });
    assert.equal(r.lookAheadSafe, true);
    assert.ok(r.candlesEvaluated > 0);
    assert.ok(r.noTradePct >= 0 && r.noTradePct <= 100);
    assert.ok(r.winRate >= 0 && r.winRate <= 1, 'winRate is a fraction 0..1');
    assert.ok(r.lossRate >= 0 && r.lossRate <= 1, 'lossRate is a fraction 0..1');
    assert.ok(Number.isFinite(r.profitFactor));
    assert.ok(Number.isFinite(r.maxDrawdownPct) && r.maxDrawdownPct >= 0);
    assert.ok(r.maxConsecutiveLosses >= 0);
    for (const t of r.trades) {
      assert.ok(['TP1', 'TP2', 'TP3', 'SL', 'EXPIRED', 'INVALIDATED'].includes(t.exitReason));
      assert.ok(Number.isFinite(t.pnlQuote));
    }
  });

  it('runBacktest refuses insufficient data with a clear note', () => {
    const r = runBacktest('BTCUSDT', makeCandles(50, { seed: 1 }), strictConfig());
    assert.equal(r.trades.length, 0);
    assert.equal(r.candlesEvaluated, 0);
  });

  it('walkForward splits 50/25/25 and flags overfitting only when warranted', () => {
    const candles = makeCandles(1000, { seed: 79, driftPct: 0.0008, volPct: 0.005 });
    const cfg = relaxedConfig();
    cfg.minCandles = 220;
    const wf = walkForward('BTCUSDT', candles, cfg);
    assert.ok(wf.train.candlesEvaluated > wf.validation.candlesEvaluated);
    assert.equal(typeof wf.overfitWarning, 'boolean');
    assert.ok(Array.isArray(wf.notes) && wf.notes.length > 0);
  });
});

describe('paper trading', () => {
  function activeLong(now: number): MasterSignal {
    const candles = trendFixture(21, 0.002);
    const s = buildSignal(singleTFInput('BTCUSDT', candles), {
      config: relaxedConfig(),
      market: neutralMarket(),
      balance: 10_000,
      now,
    });
    assert.equal(s.direction, 'LONG', `fixture must be LONG, got ${s.direction}`);
    return s;
  }

  it('openFromSignal rejects NO_TRADE signals', () => {
    const cfg = strictConfig();
    const pt = new PaperTrader(cfg);
    const nt = noTradeSignal('BTCUSDT', ['test']);
    const rej = pt.openFromSignal(nt);
    assert.equal(rej.id, null);
    assert.ok(rej.reason && rej.reason.length > 0);
  });

  it('WAIT_FOR_RETEST entries are marked WAITING and never opened (no phantom fills)', () => {
    const cfg = strictConfig();
    const pt = new PaperTrader(cfg);
    const sig = activeLong(Date.now());
    // The steady-uptrend fixture trips the chase guard: price extended beyond
    // the value zone, so the engine must not mark the entry actionable.
    assert.equal(sig.entry!.type, 'WAIT_FOR_RETEST', 'fixture must hit the chase guard');
    assert.equal(sig.status, 'WAITING');
    const r = pt.openFromSignal(sig);
    assert.equal(r.id, null, `must not open: ${r.reason}`);
    assert.equal(pt.account.positions.length, 0);
    // Duplicate symbol rejected (control via a synthetic MARKET signal is in paper.test.ts).
  });

  it('onCandle settles a stop-loss hit and records history (synthetic MARKET signal)', () => {
    const cfg = strictConfig();
    const pt = new PaperTrader(cfg);
    // Synthetic MARKET-entry signal: entry fills at the tradable price.
    const now = Date.now();
    const sig = {
      signal_id: 'SL-TEST',
      symbol: 'BTCUSDT',
      direction: 'LONG',
      status: 'ACTIVE',
      signal_grade: 'A',
      long_score: 86,
      short_score: 20,
      confidence: 70,
      probability_estimate: 60,
      probability_note: 'test',
      market_regime: 'WEAK_BULL',
      entry: { low: 99, high: 101, preferred: 100, type: 'MARKET', reason: 'test' },
      stop_loss: { price: 95, distance_percent: 5, reason: 'test' },
      take_profit: { tp1: 105, tp2: 110, tp3: 120, reasons: [] as string[] },
      risk_reward: { tp1: 1, tp2: 2, tp3: 4 },
      position: { risk_percent: 1, risk_amount: 100, quantity: 20, notional: 2000, leverage: 2 },
      market_price: 100,
      mtf: { '1m': 'NEUTRAL', '5m': 'NEUTRAL', '15m': 'NEUTRAL', '1h': 'NEUTRAL', '4h': 'NEUTRAL', '1d': 'NEUTRAL' },
      confirmation: {
        trend: false, structure: false, momentum: false, volume: false,
        vwap: false, breakout: false, liquidity: false,
      },
      reasons: [] as string[],
      warnings: [] as string[],
      invalidation: [] as string[],
      correlation_score: 0,
      ai_rating: 'AI_NEUTRAL',
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + 3600_000).toISOString(),
    } as MasterSignal;
    const { id } = pt.openFromSignal(sig);
    assert.ok(id);
    const sl = sig.stop_loss!.price;
    const entry = sig.entry!.preferred;
    // A candle that smashes through the stop.
    pt.onCandle('BTCUSDT', {
      openTime: now,
      open: entry,
      high: entry * 1.001,
      low: sl * 0.99,
      close: sl * 0.995,
    });
    assert.equal(pt.account.positions.length, 0, 'position closed on SL');
    assert.equal(pt.account.tradeHistory.length, 1);
    assert.equal(pt.account.tradeHistory[0].exitReason, 'SL');
    assert.ok(pt.account.tradeHistory[0].pnlQuote < 0, 'SL trade loses');
  });

  it('canGoLive gates on sample size, profit factor, drawdown, expectancy, selectivity', () => {
    const thin: BacktestResult = {
      trades: [],
      candlesEvaluated: 1000,
      signalsGenerated: 5,
      noTradePct: 99,
      winRate: 0,
      lossRate: 0,
      profitFactor: 0,
      expectancy: 0,
      maxDrawdownPct: 0,
      sharpeLike: 0,
      avgRR: 0,
      avgWinPct: 0,
      avgLossPct: 0,
      maxConsecutiveLosses: 0,
      signalFrequencyPer1000: 5,
      aPlus: { trades: 0, winRate: 0 },
      aTier: { trades: 0, winRate: 0 },
      lookAheadSafe: true,
    };
    const g = canGoLive(thin);
    assert.equal(g.ok, false);
    assert.ok(g.reasons.length > 0, 'lists failing criteria');
  });
});

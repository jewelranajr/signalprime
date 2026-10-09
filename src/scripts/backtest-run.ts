/**
 * Backtest runner.
 * Usage: node dist/scripts/backtest-run.js [SYMBOL] [LIMIT]
 *
 * Downloads 1h klines from Binance, runs the no-look-ahead backtest plus
 * walk-forward validation, and prints the metrics table. Past simulation
 * results do not predict future performance.
 */
import { loadConfig } from '../config';
import { BinanceDataClient } from '../exchange';
import { runBacktest, walkForward } from '../backtest';
import type { BacktestResult } from '../types';

function fmt(n: number, d = 2): string {
  return Number.isFinite(n) ? n.toFixed(d) : 'n/a';
}

function printResult(title: string, r: BacktestResult): void {
  console.log(`\n=== ${title} ===`);
  console.log(`trades=${r.trades.length} evaluated=${r.candlesEvaluated} signals=${r.signalsGenerated} noTradePct=${fmt(r.noTradePct, 1)}%`);
  console.log(`winRate=${fmt(r.winRate * 100, 1)}% lossRate=${fmt(r.lossRate * 100, 1)}% profitFactor=${fmt(r.profitFactor)} expectancy=${fmt(r.expectancy)}`);
  console.log(`maxDrawdown=${fmt(r.maxDrawdownPct)}% sharpeLike=${fmt(r.sharpeLike)} avgRR=${fmt(r.avgRR)}`);
  console.log(`avgWin=${fmt(r.avgWinPct)}% avgLoss=${fmt(r.avgLossPct)}% maxConsecLoss=${r.maxConsecutiveLosses}`);
  console.log(`signals/1000 bars=${fmt(r.signalFrequencyPer1000, 1)} A+ trades=${r.aPlus.trades} (win ${fmt(r.aPlus.winRate * 100, 1)}%) A trades=${r.aTier.trades} (win ${fmt(r.aTier.winRate * 100, 1)}%)`);
  console.log(`lookAheadSafe=${r.lookAheadSafe}`);
  const notes = (r as { notes?: string[] }).notes;
  if (notes && notes.length > 0) console.log(`notes: ${notes.join(' | ')}`);
}

async function main(): Promise<void> {
  const symbol = (process.argv[2] ?? 'BTCUSDT').toUpperCase();
  const limit = Math.min(1500, Math.max(300, Number(process.argv[3] ?? 1000)));
  const config = loadConfig();
  const client = new BinanceDataClient(config);
  console.error(`Downloading ${limit} 1h klines for ${symbol}...`);
  const candles = await client.getKlines(symbol, '1h', limit);
  if (candles.length < config.minCandles) {
    console.error(`Not enough data: got ${candles.length}, need ${config.minCandles}`);
    process.exit(1);
  }
  console.error(`Got ${candles.length} candles. Running backtest (this may take a bit)...`);
  const result = runBacktest(symbol, candles, config, { step: 6 });
  printResult(`BACKTEST ${symbol} 1h`, result);

  console.error('Running walk-forward validation...');
  const wf = walkForward(symbol, candles, config);
  printResult('WALK-FORWARD train (50%)', wf.train);
  printResult('WALK-FORWARD validation (25%)', wf.validation);
  printResult('WALK-FORWARD out-of-sample (25%)', wf.outOfSample);
  console.log(`\noverfitWarning=${wf.overfitWarning}`);
  for (const n of wf.notes) console.log(`wf note: ${n}`);
}

main().catch((err) => {
  console.error('backtest failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});

/**
 * Synthetic LONG/SHORT demonstration.
 * Usage: node dist/scripts/synthetic.js
 *
 * Generates deterministic trending fixtures and runs them through the engine
 * with relaxed (documented, non-default) thresholds to demonstrate that the
 * LONG and SHORT code paths assemble complete, valid trade plans.
 * These are FIXTURES, not market calls — thresholds are printed alongside.
 */
import { buildSignal } from '../engine';
import { trendFixture, relaxedConfig as relaxedTestConfig } from '../tests/helpers';
import type { Candle, EngineConfig, MasterSignal, Timeframe } from '../types';
import { loadConfig } from '../config';

function relaxedConfig(): EngineConfig {
  return relaxedTestConfig();
}

function run(symbol: string, candles: Candle[], config: EngineConfig): MasterSignal {
  const tf = {} as Record<Timeframe, Candle[]>;
  (['1m', '5m', '15m', '1h', '4h', '1d'] as Timeframe[]).forEach((t) => {
    tf[t] = t === '1h' ? candles : [];
  });
  return buildSignal(
    { symbol, candles: tf, quoteVolume24h: 5_000_000, spreadPct: 0.02 },
    {
      config,
      market: {
        btcRegime: 'SIDEWAYS',
        ethRegime: 'SIDEWAYS',
        btcChange24hPct: 0,
        ethChange24hPct: 0,
        btcViolentDump: false,
        btcStrongBull: false,
        ethViolentDump: false,
      },
      balance: config.accountBalance,
      now: candles[candles.length - 1].closeTime,
    },
  );
}

const config = relaxedConfig();
console.error(
  'SYNTHETIC FIXTURES — relaxed thresholds ' +
    `(minScore=${config.minScore}, minConfidence=${config.minConfidence}, minRR=${config.minRR}). ` +
    'Not market calls.',
);
const longSig = run('SYNTH-BTC-LONG', trendFixture(21, 0.002), config);
const shortSig = run('SYNTH-BTC-SHORT', trendFixture(31, -0.002), config);
console.error(`LONG fixture -> ${longSig.direction} (${longSig.signal_grade}) conf=${longSig.confidence}`);
console.error(`SHORT fixture -> ${shortSig.direction} (${shortSig.signal_grade}) conf=${shortSig.confidence}`);
console.log(JSON.stringify([longSig, shortSig], null, 2));

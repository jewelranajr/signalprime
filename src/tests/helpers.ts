/** Shared deterministic fixtures for the CryptoAI Pro test suite. */
import type {
  Candle,
  EngineConfig,
  MarketContext,
  SymbolInput,
  Timeframe,
} from '../types';
import { loadConfig } from '../config';

/** Deterministic PRNG (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SynthOpts {
  seed?: number;
  start?: number;
  /** Per-bar fractional drift, e.g. 0.002 = +0.2%/bar. */
  driftPct?: number;
  /** Per-bar noise scale (fraction of price). */
  volPct?: number;
  baseVolume?: number;
  startTime?: number;
  stepMs?: number;
}

/** Deterministic synthetic candles: geometric drift + noise. */
export function makeCandles(n: number, opts: SynthOpts = {}): Candle[] {
  const rand = mulberry32(opts.seed ?? 42);
  const drift = opts.driftPct ?? 0;
  const vol = opts.volPct ?? 0.005;
  const baseVol = opts.baseVolume ?? 1000;
  const t0 = opts.startTime ?? 1_700_000_000_000;
  const step = opts.stepMs ?? 3_600_000;
  const out: Candle[] = [];
  let price = opts.start ?? 100;
  for (let i = 0; i < n; i++) {
    const shock = (rand() + rand() + rand() - 1.5) * 2 * vol;
    const open = price;
    const close = Math.max(0.0001, open * (1 + drift + shock));
    const high = Math.max(open, close) * (1 + rand() * vol * 0.8);
    const low = Math.min(open, close) * (1 - rand() * vol * 0.8);
    const up = close >= open;
    const volume = baseVol * (0.7 + rand() * 0.6) * (up ? 1.3 : 0.85);
    out.push({
      openTime: t0 + i * step,
      open,
      high,
      low,
      close,
      volume,
      closeTime: t0 + (i + 1) * step - 1,
    });
    price = close;
  }
  return out;
}

/** SymbolInput with only the 1h timeframe populated (engine tolerates gaps). */
export function singleTFInput(symbol: string, candles: Candle[]): SymbolInput {
  const empty = (): Candle[] => [];
  const tf: Record<Timeframe, Candle[]> = {
    '1m': empty(),
    '5m': empty(),
    '15m': empty(),
    '1h': candles,
    '4h': empty(),
    '1d': empty(),
  };
  return { symbol, candles: tf, quoteVolume24h: 5_000_000, spreadPct: 0.02 };
}

export function neutralMarket(): MarketContext {
  return {
    btcRegime: 'SIDEWAYS',
    ethRegime: 'SIDEWAYS',
    btcChange24hPct: 0,
    ethChange24hPct: 0,
    btcViolentDump: false,
    btcStrongBull: false,
    ethViolentDump: false,
  };
}

/** Relaxed thresholds so synthetic fixtures can exercise LONG/SHORT paths. */
export function relaxedConfig(): EngineConfig {
  const c = loadConfig();
  return {
    ...c,
    minScore: 40,
    minConfidence: 35,
    minDirectionGap: 5,
    minRR: 1.0,
    aPlusScore: 80,
    aPlusConfidence: 75,
    aPlusRR: 2.0,
  };
}

export function strictConfig(): EngineConfig {
  return loadConfig();
}

/**
 * Wick-trimmed trending fixture the engine scores directionally.
 * Verified: trendFixture(21, +0.002) -> LONG, trendFixture(31, -0.002) -> SHORT
 * under relaxedConfig().
 */
export function trendFixture(seed: number, driftPct: number): Candle[] {
  return makeCandles(400, { seed, driftPct, volPct: 0.003 }).map((c) => ({
    ...c,
    high: Math.max(c.open, c.close) * 1.0008,
    low: Math.min(c.open, c.close) * 0.9992,
  }));
}

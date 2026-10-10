/**
 * CryptoAI Pro — configuration loader.
 *
 * All tunables come from environment variables with safe defaults matching the
 * spec (section 21). No secrets are read here: the engine only uses Binance
 * PUBLIC market-data endpoints, so no API keys exist in this system.
 */
import type { EngineConfig } from './types';

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isFinite(v) ? v : fallback;
}

function str(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw.toLowerCase() === 'true' || raw === '1';
}

export function loadConfig(): EngineConfig {
  return {
    // Master signal filter (spec section 21)
    minScore: num('MIN_SCORE', 85),
    minConfidence: num('MIN_CONFIDENCE', 80),
    minDirectionGap: num('MIN_DIRECTION_GAP', 10),
    minRR: num('MIN_RR', 2.0),
    // A+ tier thresholds
    aPlusScore: num('A_PLUS_SCORE', 92),
    aPlusConfidence: num('A_PLUS_CONFIDENCE', 88),
    aPlusRR: num('A_PLUS_RR', 2.5),
    // NORMAL tier (65-80): lower-quality signals, tracked separately
    normalMinScore: num('NORMAL_MIN_SCORE', 65),
    normalMaxScore: num('NORMAL_MAX_SCORE', 80),
    // Risk
    accountBalance: num('ACCOUNT_BALANCE', 10_000),
    riskPercent: num('RISK_PERCENT', 1),
    maxLeverage: num('MAX_LEVERAGE', 10),
    baseLeverage: num('BASE_LEVERAGE', 3),
    // Data / lifecycle
    minCandles: num('MIN_CANDLES', 220),
    signalTtlMs: num('SIGNAL_TTL_MS', 3_600_000),
    cooldownMs: num('COOLDOWN_MS', 900_000),
    sameDirectionCooldownMs: num('SAME_DIRECTION_COOLDOWN_MS', 1_800_000),
    regimeCooldownMs: num('REGIME_COOLDOWN_MS', 3_600_000),
    // Liquidity filter
    maxSpreadPct: num('MAX_SPREAD_PCT', 0.15),
    minQuoteVolume24h: num('MIN_QUOTE_VOLUME_24H', 1_000_000),
    // Exchange data layer
    binanceBaseUrls: str(
      'BINANCE_BASE_URLS',
      'https://api.binance.com,https://data-api.binance.vision',
    )
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    requestTimeoutMs: num('REQUEST_TIMEOUT_MS', 12_000),
    maxRetries: num('MAX_RETRIES', 3),
    cacheTtlMs: num('CACHE_TTL_MS', 15_000),
    maxConcurrency: num('MAX_CONCURRENCY', 8),
    // Paper trading
    paperEnabled: bool('PAPER_ENABLED', true),
    paperStartBalance: num('PAPER_START_BALANCE', 10_000),
    paperFeePct: num('PAPER_FEE_PCT', 0.05),
    paperSlippagePct: num('PAPER_SLIPPAGE_PCT', 0.02),
    paperFundingPct8h: num('PAPER_FUNDING_PCT_8H', 0.01),
    // API
    apiPort: num('PORT', 8080),
    apiHost: str('HOST', '0.0.0.0'),
    rateLimitMax: num('RATE_LIMIT_MAX', 120),
    rateLimitWindowMs: num('RATE_LIMIT_WINDOW_MS', 60_000),
  };
}

/**
 * Public, sanitized view of the config for GET /api/config.
 * Contains no secrets by construction (this system holds no secrets).
 */
export function publicConfig(config: EngineConfig): Record<string, number | string | boolean> {
  return {
    minScore: config.minScore,
    minConfidence: config.minConfidence,
    minDirectionGap: config.minDirectionGap,
    minRR: config.minRR,
    aPlusScore: config.aPlusScore,
    aPlusConfidence: config.aPlusConfidence,
    aPlusRR: config.aPlusRR,
    riskPercent: config.riskPercent,
    maxLeverage: config.maxLeverage,
    baseLeverage: config.baseLeverage,
    minCandles: config.minCandles,
    signalTtlMs: config.signalTtlMs,
    maxSpreadPct: config.maxSpreadPct,
    minQuoteVolume24h: config.minQuoteVolume24h,
    objective: 'maximum validated signal quality with strict NO_TRADE protection and controlled risk',
  };
}

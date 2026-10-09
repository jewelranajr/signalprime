/**
 * CryptoAI Pro — Master Signal Engine: exchange data layer.
 *
 * Public-only Binance market-data client. This module uses ONLY Binance
 * PUBLIC endpoints: no API keys, no signed requests, no secrets of any kind
 * exist here or are read by this module.
 *
 * Resilience guarantees (by design, not by accuracy claim):
 * - A failure for one symbol/timeframe never rejects the whole batch:
 *   per-symbol failures return safe fallbacks ([] / null) and are logged.
 * - Base-URL failover: config.binanceBaseUrls are tried in order; on network
 *   error, timeout, 5xx, or 451 the client fails over to the next base URL
 *   and remembers the working one for subsequent calls.
 * - 429/418 is a hard stop for that call (returns the fallback, does not
 *   spin); the Retry-After value, when present, is recorded in the log.
 */
import type { Candle, Timeframe, EngineConfig } from './types';
import { TIMEFRAMES } from './types';

/** 24h ticker snapshot plus live spread for one symbol. */
export interface Ticker24h {
  symbol: string;
  lastPrice: number;
  quoteVolume: number;
  priceChangePct: number;
  bidPrice: number;
  askPrice: number;
  spreadPct: number;
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

const KLINE_LIMIT_DEFAULT = 500;
const KLINE_LIMIT_MIN = 5;
const KLINE_LIMIT_MAX = 1000;
const TOP_SYMBOLS_DEFAULT = 50;
const TOP_SYMBOLS_MAX = 500;
const BACKOFF_BASE_MS = 300;
const FALLBACK_BASE_URLS = ['https://api.binance.com', 'https://data-api.binance.vision'];
/** Uppercase alphanumeric, <= 20 chars, must end with USDT (checked separately). */
const SYMBOL_RE = /^[A-Z0-9]+$/;
/** Leveraged-token name markers (checked against the base part, before USDT). */
const LEVERAGED_MARKERS = ['UP', 'DOWN', 'BULL', 'BEAR'];
/** Fiat/stablecoin bases with no directional edge to trade — excluded from scans. */
const STABLE_BASES = ['USDC', 'FDUSD', 'DAI', 'TUSD', 'USDP', 'AEUR', 'EUR', 'GBP', 'BRL', 'TRY'];

/** 429/418: stop this call immediately, do not spin. */
class RateLimitedError extends Error {}
/** Other 4xx: the request itself is bad; retrying other bases won't help. */
class NonRetryableError extends Error {}

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

/** Minimal counting semaphore bounding simultaneous HTTP requests. */
class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async acquire(): Promise<() => void> {
    if (this.active < this.max) {
      this.active += 1;
      return () => this.release();
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active += 1;
    return () => this.release();
  }

  private release(): void {
    this.active -= 1;
    const next = this.waiters.shift();
    if (next) next();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt: number): number {
  return BACKOFF_BASE_MS * 2 ** attempt + Math.floor(Math.random() * BACKOFF_BASE_MS);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isLeveragedToken(symbol: string): boolean {
  const base = symbol.slice(0, -'USDT'.length);
  return LEVERAGED_MARKERS.some((m) => base.includes(m));
}

/** Map a raw kline row to a Candle; returns null for malformed rows. */
function parseKlineRow(row: unknown): Candle | null {
  if (!Array.isArray(row) || row.length < 7) return null;
  const nums = [row[0], row[1], row[2], row[3], row[4], row[5], row[6]].map(Number);
  if (nums.some((n) => !Number.isFinite(n))) return null;
  return {
    openTime: nums[0],
    open: nums[1],
    high: nums[2],
    low: nums[3],
    close: nums[4],
    volume: nums[5],
    closeTime: nums[6],
  };
}

function parseKlines(data: unknown): Candle[] {
  if (!Array.isArray(data)) return [];
  const out: Candle[] = [];
  for (const row of data) {
    const candle = parseKlineRow(row);
    if (candle) out.push(candle);
  }
  return out;
}

function spreadPct(bid: number, ask: number): number {
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0 || ask < bid) return 0;
  const mid = (bid + ask) / 2;
  return mid > 0 ? ((ask - bid) / mid) * 100 : 0;
}

// ---------------------------------------------------------------------------
// Binance public market-data client
// ---------------------------------------------------------------------------

export class BinanceDataClient {
  private readonly bases: string[];
  /** Index into `bases` of the currently preferred (last working) base URL. */
  private activeBaseIdx = 0;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly semaphore: Semaphore;

  constructor(private readonly config: EngineConfig) {
    const raw = Array.isArray(config.binanceBaseUrls) ? config.binanceBaseUrls : [];
    const cleaned = raw.map((b) => String(b).replace(/\/+$/, '')).filter(Boolean);
    this.bases = cleaned.length > 0 ? cleaned : [...FALLBACK_BASE_URLS];
    const maxConc = Math.max(1, Math.floor(Number(config.maxConcurrency) || 1));
    this.semaphore = new Semaphore(maxConc);
  }

  // ------------------------------------------------------------- diagnostics

  /** For diagnostics: which base URL is currently primary. */
  getActiveBaseUrl(): string {
    return this.bases[this.activeBaseIdx] ?? this.bases[0];
  }

  clearCache(): void {
    this.cache.clear();
  }

  // ------------------------------------------------------------------ cache

  private cacheGet<T>(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  private cacheSet<T>(key: string, value: T): void {
    const ttl = Number(this.config.cacheTtlMs);
    if (!Number.isFinite(ttl) || ttl <= 0) return;
    this.cache.set(key, { value, expiresAt: Date.now() + ttl });
  }

  // -------------------------------------------------------------- validation

  private isValidSymbol(symbol: unknown): symbol is string {
    return (
      typeof symbol === 'string' &&
      symbol.length > 0 &&
      symbol.length <= 20 &&
      SYMBOL_RE.test(symbol) &&
      symbol.endsWith('USDT')
    );
  }

  private log(level: 'warn' | 'error', message: string): void {
    if (level === 'warn') console.warn(`[exchange] ${message}`);
    else console.error(`[exchange] ${message}`);
  }

  // ------------------------------------------------------------------- http

  /** Base indexes in failover order, starting from the remembered working one. */
  private baseOrder(): number[] {
    const order: number[] = [];
    for (let i = 0; i < this.bases.length; i++) {
      order.push((this.activeBaseIdx + i) % this.bases.length);
    }
    return order;
  }

  /** One HTTP GET through the semaphore with an AbortController timeout. */
  private async fetchOnce(url: string): Promise<{ status: number; retryAfter: string | null; data: unknown }> {
    const release = await this.semaphore.acquire();
    const timeoutRaw = Number(this.config.requestTimeoutMs);
    const timeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : 12_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      const retryAfter = res.headers.get('retry-after');
      let data: unknown = null;
      try {
        const text = await res.text();
        data = text ? (JSON.parse(text) as unknown) : null;
      } catch {
        data = null; // non-JSON body: treat as empty payload
      }
      return { status: res.status, retryAfter, data };
    } finally {
      clearTimeout(timer);
      release();
    }
  }

  /**
   * GET `path` against the Binance public API with base-URL failover and
   * retries. Throws on persistent failure; public methods convert that to
   * safe fallbacks. Throws RateLimitedError on 429/418 (hard stop).
   */
  private async httpGet(path: string): Promise<unknown> {
    const maxRetries = Math.max(0, Math.floor(Number(this.config.maxRetries) || 0));
    let lastError: unknown = new Error(`request failed: ${path}`);

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      for (const baseIdx of this.baseOrder()) {
        const base = this.bases[baseIdx];
        let result: { status: number; retryAfter: string | null; data: unknown };
        try {
          result = await this.fetchOnce(`${base}${path}`);
        } catch (err) {
          // Network error, DNS failure, or timeout (AbortError): fail over.
          lastError = err;
          const why = err instanceof Error && err.name === 'AbortError' ? 'timeout' : errMessage(err);
          this.log('warn', `request failed (${base}${path}): ${why}; failing over`);
          this.activeBaseIdx = (baseIdx + 1) % this.bases.length;
          continue;
        }

        if (result.status === 429 || result.status === 418) {
          // Hard stop: do not spin against the rate limit. Record Retry-After.
          const ra = result.retryAfter ?? 'not provided';
          throw new RateLimitedError(
            `rate limited (HTTP ${result.status}) by ${base}; Retry-After: ${ra}`,
          );
        }

        if (result.status >= 500 || result.status === 451) {
          lastError = new Error(`HTTP ${result.status} from ${base}${path}`);
          this.log('warn', `HTTP ${result.status} from ${base}${path}; failing over`);
          this.activeBaseIdx = (baseIdx + 1) % this.bases.length;
          continue;
        }

        if (result.status < 200 || result.status >= 300) {
          // Other 4xx (e.g. bad symbol): not retryable, not a failover case.
          throw new NonRetryableError(`HTTP ${result.status} from ${base}${path}`);
        }

        // Success: remember the working base URL.
        this.activeBaseIdx = baseIdx;
        return result.data;
      }

      if (attempt < maxRetries) {
        await sleep(backoffMs(attempt));
      }
    }

    throw lastError instanceof Error ? lastError : new Error(`request failed: ${path}`);
  }

  // ------------------------------------------------------------ public API

  /**
   * Single timeframe klines. Returns [] on failure (never throws for data
   * issues). One bad symbol/timeframe never affects other calls.
   */
  async getKlines(symbol: string, interval: Timeframe, limit: number = KLINE_LIMIT_DEFAULT): Promise<Candle[]> {
    if (!this.isValidSymbol(symbol) || !TIMEFRAMES.includes(interval)) {
      this.log('warn', `getKlines: invalid symbol/timeframe (${String(symbol)} ${String(interval)}); returning []`);
      return [];
    }
    const clamped = Math.min(KLINE_LIMIT_MAX, Math.max(KLINE_LIMIT_MIN, Math.floor(Number(limit) || KLINE_LIMIT_DEFAULT)));
    const key = `klines:${symbol}:${interval}:${clamped}`;
    const cached = this.cacheGet<Candle[]>(key);
    if (cached) return cached;

    try {
      const path =
        `/api/v3/klines?symbol=${encodeURIComponent(symbol)}` +
        `&interval=${encodeURIComponent(interval)}&limit=${clamped}`;
      const data = await this.httpGet(path);
      const candles = parseKlines(data);
      if (candles.length > 0) this.cacheSet(key, candles);
      return candles;
    } catch (err) {
      if (err instanceof RateLimitedError) {
        this.log('warn', `getKlines ${symbol} ${interval}: ${errMessage(err)}; returning []`);
      } else {
        this.log('warn', `getKlines ${symbol} ${interval} failed: ${errMessage(err)}; returning []`);
      }
      return [];
    }
  }

  /**
   * All 6 timeframes. Missing TFs come back as [] (the engine tolerates
   * gaps). Per-TF results are cached individually via getKlines.
   */
  async getMultiTimeframe(symbol: string): Promise<Record<Timeframe, Candle[]>> {
    const result = {} as Record<Timeframe, Candle[]>;
    for (const tf of TIMEFRAMES) result[tf] = [];

    if (!this.isValidSymbol(symbol)) {
      this.log('warn', `getMultiTimeframe: invalid symbol (${String(symbol)}); returning empty`);
      return result;
    }

    // Each getKlines call goes through the concurrency semaphore internally;
    // a single TF failing can never reject the batch (getKlines never throws).
    const entries = await Promise.all(
      TIMEFRAMES.map(async (tf) => [tf, await this.getKlines(symbol, tf)] as const),
    );
    for (const [tf, candles] of entries) {
      result[tf] = candles;
    }
    return result;
  }

  /** 24h ticker + live spread. Returns null on failure (never throws). */
  async getTicker24h(symbol: string): Promise<Ticker24h | null> {
    if (!this.isValidSymbol(symbol)) {
      this.log('warn', `getTicker24h: invalid symbol (${String(symbol)}); returning null`);
      return null;
    }
    const key = `ticker24h:${symbol}`;
    const cached = this.cacheGet<Ticker24h>(key);
    if (cached) return cached;

    try {
      const raw = await this.httpGet(`/api/v3/ticker/24hr?symbol=${encodeURIComponent(symbol)}`);
      const t = raw as { lastPrice?: unknown; quoteVolume?: unknown; priceChangePercent?: unknown };
      const lastPrice = Number(t?.lastPrice);
      const quoteVolume = Number(t?.quoteVolume);
      const priceChangePct = Number(t?.priceChangePercent);
      if (!Number.isFinite(lastPrice) || lastPrice <= 0) {
        this.log('warn', `getTicker24h ${symbol}: malformed 24hr payload; returning null`);
        return null;
      }

      // Spread is best-effort: if bookTicker fails, fall back to lastPrice
      // for bid/ask with a zero spread rather than dropping the ticker.
      let bidPrice = lastPrice;
      let askPrice = lastPrice;
      try {
        const book = (await this.httpGet(
          `/api/v3/ticker/bookTicker?symbol=${encodeURIComponent(symbol)}`,
        )) as { bidPrice?: unknown; askPrice?: unknown };
        const bid = Number(book?.bidPrice);
        const ask = Number(book?.askPrice);
        if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0 && ask >= bid) {
          bidPrice = bid;
          askPrice = ask;
        } else {
          this.log('warn', `getTicker24h ${symbol}: malformed bookTicker payload; using lastPrice for bid/ask`);
        }
      } catch (bookErr) {
        this.log('warn', `getTicker24h ${symbol}: bookTicker failed (${errMessage(bookErr)}); using lastPrice for bid/ask`);
      }

      const ticker: Ticker24h = {
        symbol,
        lastPrice,
        quoteVolume: Number.isFinite(quoteVolume) ? quoteVolume : 0,
        priceChangePct: Number.isFinite(priceChangePct) ? priceChangePct : 0,
        bidPrice,
        askPrice,
        spreadPct: spreadPct(bidPrice, askPrice),
      };
      this.cacheSet(key, ticker);
      return ticker;
    } catch (err) {
      this.log('warn', `getTicker24h ${symbol} failed: ${errMessage(err)}; returning null`);
      return null;
    }
  }

  /**
   * Top USDT pairs by 24h quote volume, e.g. ['BTCUSDT', ...].
   * Excludes leveraged tokens (UP/DOWN/BULL/BEAR) and fiat/stablecoin pairs.
   * Returns [] on failure.
   */
  async getTopUsdtSymbols(limit: number = TOP_SYMBOLS_DEFAULT): Promise<string[]> {
    const clamped = Math.min(TOP_SYMBOLS_MAX, Math.max(1, Math.floor(Number(limit) || TOP_SYMBOLS_DEFAULT)));
    const key = `topUsdt:${clamped}`;
    const cached = this.cacheGet<string[]>(key);
    if (cached) return cached;

    try {
      const data = await this.httpGet('/api/v3/ticker/24hr');
      if (!Array.isArray(data)) {
        this.log('warn', 'getTopUsdtSymbols: malformed payload; returning []');
        return [];
      }
      const scored: Array<{ symbol: string; quoteVolume: number }> = [];
      for (const item of data) {
        if (typeof item !== 'object' || item === null) continue;
        const rec = item as Record<string, unknown>;
        const sym = rec.symbol;
        if (typeof sym !== 'string' || !this.isValidSymbol(sym)) continue;
        if (isLeveragedToken(sym)) continue;
        if (STABLE_BASES.includes(sym.slice(0, -4))) continue;
        const qv = Number(rec.quoteVolume);
        if (!Number.isFinite(qv) || qv <= 0) continue;
        scored.push({ symbol: sym, quoteVolume: qv });
      }
      scored.sort((a, b) => b.quoteVolume - a.quoteVolume);
      const top = scored.slice(0, clamped).map((s) => s.symbol);
      if (top.length > 0) this.cacheSet(key, top);
      return top;
    } catch (err) {
      this.log('warn', `getTopUsdtSymbols failed: ${errMessage(err)}; returning []`);
      return [];
    }
  }
}

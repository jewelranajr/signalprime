/**
 * Funding rate data from OKX (public API, no auth needed).
 * Used for contrarian signals: extreme funding = crowded positioning.
 */

export interface FundingData {
  rate: number;
  zScore: number;
  time: number;
}

// Cache to avoid hammering the API
const cache = new Map<string, { data: FundingData; ts: number }>();
const CACHE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Convert Binance-style symbol (BTCUSDT) to OKX instId (BTC-USDT-SWAP).
 */
function toInstId(symbol: string): string {
  // Handle common quote currencies
  for (const q of ['USDT', 'USDC', 'BTC', 'ETH']) {
    if (symbol.endsWith(q) && symbol.length > q.length) {
      const base = symbol.slice(0, -q.length);
      return `${base}-${q}-SWAP`;
    }
  }
  return `${symbol}-USDT-SWAP`;
}

/**
 * Get current funding rate and z-score for a symbol.
 * Z-score is computed against recent history (higher = more crowded longs).
 */
export async function getFundingData(symbol: string): Promise<FundingData | null> {
  const cached = cache.get(symbol);
  if (cached && Date.now() - cached.ts < CACHE_MS) {
    return cached.data;
  }

  try {
    const instId = toInstId(symbol);
    const url = `https://www.okx.com/api/v5/public/funding-rate-history?instId=${instId}&limit=100`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = await res.json();
    const records = (json.data || [])
      .map((x: any) => ({
        time: +x.fundingTime,
        rate: parseFloat(x.fundingRate),
      }))
      .filter((x: any) => Number.isFinite(x.rate))
      .reverse(); // oldest first

    if (records.length < 20) return null;

    const rates = records.map((r: any) => r.rate);
    const current = rates[rates.length - 1];

    // Z-score: how extreme is current vs recent history
    const mean = rates.reduce((a: number, b: number) => a + b, 0) / rates.length;
    const variance = rates.reduce((a: number, b: number) => a + (b - mean) ** 2, 0) / rates.length;
    const std = Math.sqrt(variance);
    const zScore = std > 0 ? (current - mean) / std : 0;

    const data: FundingData = {
      rate: current,
      zScore,
      time: records[records.length - 1].time,
    };
    cache.set(symbol, { data, ts: Date.now() });
    return data;
  } catch {
    return null;
  }
}

/**
 * Clear the cache (for testing).
 */
export function clearFundingCache(): void {
  cache.clear();
}

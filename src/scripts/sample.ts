/**
 * Live sample-signal runner.
 * Usage: node dist/scripts/sample.js BTCUSDT ETHUSDT SOLUSDT
 *
 * Fetches real multi-timeframe Binance market data and prints the full
 * MasterSignal JSON per symbol. Uses the STRICT default config, so expect
 * NO_TRADE whenever the market does not offer a high-quality setup —
 * that is the engine working as designed, not an error.
 */
import { loadConfig } from '../config';
import { BinanceDataClient } from '../exchange';
import { buildSignal } from '../engine';
import { buildMarketContext } from '../filters';
import type { MasterSignal } from '../types';

async function main(): Promise<void> {
  const symbols = process.argv.slice(2).map((s) => s.toUpperCase());
  if (symbols.length === 0) {
    console.error('Usage: node dist/scripts/sample.js BTCUSDT ETHUSDT SOLUSDT');
    process.exit(1);
  }
  const config = loadConfig();
  const client = new BinanceDataClient(config);

  // BTC/ETH market context (cached per call; cheap enough for a script).
  const [btc, eth] = await Promise.all([
    client.getKlines('BTCUSDT', '1h', 250),
    client.getKlines('ETHUSDT', '1h', 250),
  ]);
  const [btcT, ethT] = await Promise.all([
    client.getTicker24h('BTCUSDT'),
    client.getTicker24h('ETHUSDT'),
  ]);
  const market = buildMarketContext(btc, eth, btcT?.priceChangePct, ethT?.priceChangePct);
  console.error(
    `Market context: BTC regime=${market.btcRegime} (${market.btcChange24hPct.toFixed(2)}%/24h) ` +
      `ETH regime=${market.ethRegime} (${market.ethChange24hPct.toFixed(2)}%/24h)`,
  );

  const out: MasterSignal[] = [];
  for (const symbol of symbols) {
    const candles = await client.getMultiTimeframe(symbol);
    const ticker = await client.getTicker24h(symbol);
    const signal = buildSignal(
      {
        symbol,
        candles,
        quoteVolume24h: ticker?.quoteVolume ?? 0,
        spreadPct: ticker?.spreadPct ?? 0,
      },
      { config, market, balance: config.accountBalance },
    );
    out.push(signal);
    console.error(
      `${symbol}: ${signal.direction} grade=${signal.signal_grade} ` +
        `long=${signal.long_score} short=${signal.short_score} conf=${signal.confidence} ` +
        `regime=${signal.market_regime} price=${ticker?.lastPrice ?? 'n/a'}`,
    );
  }
  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => {
  console.error('sample failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});

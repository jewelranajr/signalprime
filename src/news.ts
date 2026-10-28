/**
 * Crypto news (v1): keyless public RSS feeds, polled by the paper runner
 * once per cycle, matched to coin mentions, served via GET /api/news.
 *
 * Best-effort by design: a feed failure never breaks the trading cycle,
 * and a missing or stale cache serves an empty list.
 *
 * News is context, not a signal — it never opens, closes, or scores trades.
 * No sentiment scoring in v1 (that would be fabricated precision).
 */
import * as fs from 'node:fs';

export interface NewsItem {
  title: string;
  link: string;
  source: string;
  publishedAt: string;
  symbols: string[];
}

export interface NewsCache {
  generatedAt: string;
  count: number;
  items: NewsItem[];
}

const FEEDS: { source: string; url: string }[] = [
  // CoinDesk redirects (308) to the no-trailing-slash URL; fetch follows it.
  { source: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss' },
  { source: 'CoinTelegraph', url: 'https://cointelegraph.com/rss' },
  { source: 'Decrypt', url: 'https://decrypt.co/feed' },
];

const MAX_ITEMS = 50;
const FETCH_TIMEOUT_MS = 10_000;

// Curated ticker -> mention phrases for headline matching (majors only, v1).
// Bare two-letter tickers and common English words are deliberately excluded
// ('op', 'near') because they false-positive on ordinary headline words.
const COIN_PHRASES: Record<string, string[]> = {
  BTC: ['bitcoin'],
  ETH: ['ethereum'],
  SOL: ['solana'],
  XRP: ['ripple'],
  DOGE: ['dogecoin'],
  ADA: ['cardano'],
  BNB: ['binance coin'],
  TRX: ['tron'],
  LINK: ['chainlink'],
  AVAX: ['avalanche'],
  DOT: ['polkadot'],
  LTC: ['litecoin'],
  APT: ['aptos'],
  ARB: ['arbitrum'],
  SUI: ['sui'],
  TIA: ['celestia'],
  ATOM: ['cosmos'],
  FIL: ['filecoin'],
  ETC: ['ethereum classic'],
  USDT: ['tether'],
  USDC: ['usd coin'],
  SHIB: ['shiba inu'],
  PEPE: ['pepe'],
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec: string) =>
      String.fromCodePoint(Number.parseInt(dec, 10)),
    )
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function cleanText(s: string): string {
  return decodeEntities(s)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTag(block: string, tag: string): string {
  const m = block.match(
    new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i'),
  );
  return m ? cleanText(m[1]) : '';
}

/** Parse one RSS 2.0 document into raw items (no symbol matching yet). */
export function parseRss(
  xml: string,
  source: string,
): { title: string; link: string; publishedAt: string; matchText: string }[] {
  const out: { title: string; link: string; publishedAt: string; matchText: string }[] = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/gi;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const title = extractTag(block, 'title');
    const link = extractTag(block, 'link');
    if (!title || !link) continue;
    const rawDate = extractTag(block, 'pubDate') || extractTag(block, 'dc:date');
    const parsed = rawDate ? new Date(rawDate) : null;
    const publishedAt =
      parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : '';
    const description = extractTag(block, 'description');
    out.push({
      title,
      link,
      publishedAt,
      matchText: `${title} ${description}`,
    });
  }
  return out;
}

/**
 * Whole-word, case-insensitive mention matching. A shorter phrase that is a
 * substring of a longer matched phrase is suppressed, so 'Ethereum Classic'
 * tags ETC only, not ETH.
 */
export function matchSymbols(text: string): string[] {
  const matched: { coin: string; phrase: string }[] = [];
  for (const [coin, phrases] of Object.entries(COIN_PHRASES)) {
    const candidates = coin.length >= 3 ? [coin.toLowerCase(), ...phrases] : phrases;
    for (const phrase of candidates) {
      const re = new RegExp(`\\b${escapeRegExp(phrase)}\\b`, 'i');
      if (re.test(text)) {
        matched.push({ coin, phrase });
        break;
      }
    }
  }
  return matched
    .filter(
      (a) =>
        !matched.some(
          (b) =>
            b !== a &&
            b.phrase.length > a.phrase.length &&
            b.phrase.toLowerCase().includes(a.phrase.toLowerCase()),
        ),
    )
    .map((a) => a.coin);
}

/** Fetch all feeds in parallel; per-feed failures yield no items, never throw. */
export async function fetchNews(
  fetchFn: typeof fetch = fetch,
): Promise<NewsItem[]> {
  const settled = await Promise.all(
    FEEDS.map(async (feed) => {
      try {
        const res = await fetchFn(feed.url, {
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          headers: { 'user-agent': 'SignalPrime-news/1.0' },
        });
        if (!res.ok) return [];
        const xml = await res.text();
        return parseRss(xml, feed.source).map((raw) => ({
          title: raw.title,
          link: raw.link,
          source: feed.source,
          publishedAt: raw.publishedAt,
          symbols: matchSymbols(raw.matchText),
        }));
      } catch {
        return [];
      }
    }),
  );
  const seen = new Set<string>();
  const merged: NewsItem[] = [];
  for (const item of settled.flat()) {
    if (seen.has(item.link)) continue;
    seen.add(item.link);
    merged.push(item);
  }
  merged.sort((a, b) => {
    if (!a.publishedAt && !b.publishedAt) return 0;
    if (!a.publishedAt) return 1;
    if (!b.publishedAt) return -1;
    return b.publishedAt.localeCompare(a.publishedAt);
  });
  return merged.slice(0, MAX_ITEMS);
}

/**
 * Fetch + atomically write the news cache. Returns null (and writes nothing,
 * preserving any previous cache) when nothing was fetched.
 */
export async function refreshNewsCache(
  cachePath: string,
  fetchFn: typeof fetch = fetch,
): Promise<NewsCache | null> {
  let items: NewsItem[];
  try {
    items = await fetchNews(fetchFn);
  } catch {
    return null;
  }
  if (items.length === 0) return null;
  const cache: NewsCache = {
    generatedAt: new Date().toISOString(),
    count: items.length,
    items,
  };
  const tmpPath = cachePath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(cache, null, 2));
  fs.renameSync(tmpPath, cachePath);
  return cache;
}

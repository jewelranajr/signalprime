/** Unit tests: crypto news RSS parsing, mention matching, cache refresh. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  fetchNews,
  matchSymbols,
  parseRss,
  refreshNewsCache,
} from '../news';

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Test</title>
<item><title><![CDATA[Bitcoin breaks &amp; holds $100k]]></title><link>https://example.com/a</link><pubDate>Mon, 27 Oct 2026 10:00:00 GMT</pubDate><description>BTC rally continues</description></item>
<item><title>Ethereum Classic rallies</title><link>https://example.com/b</link><pubDate>Mon, 27 Oct 2026 09:00:00 GMT</pubDate><description>ETC up 5%</description></item>
<item><title>No link here</title><pubDate>Mon, 27 Oct 2026 08:00:00 GMT</pubDate></item>
<item><title>Solana &#39;surge&#39; &lt;strong&gt;noted&lt;/strong&gt;</title><link>https://example.com/c</link><dc:date>2026-10-27T07:00:00Z</dc:date></item>
<item><title>BTCC launches something</title><link>https://example.com/d</link><pubDate>not-a-date</pubDate></item>
</channel></rss>`;

describe('parseRss', () => {
  it('decodes CDATA/entities, strips tags, falls back to dc:date', () => {
    const items = parseRss(RSS, 'Test');
    assert.equal(items.length, 4);
    assert.equal(items[0].title, 'Bitcoin breaks & holds $100k');
    assert.equal(items[0].link, 'https://example.com/a');
    assert.equal(items[0].publishedAt, '2026-10-27T10:00:00.000Z');
    assert.equal(items[2].title, "Solana 'surge' noted");
    assert.equal(items[2].publishedAt, '2026-10-27T07:00:00.000Z');
    assert.equal(items[3].publishedAt, '');
  });

  it('skips items missing title or link', () => {
    const items = parseRss(RSS, 'Test');
    assert.ok(!items.some((i) => i.title === 'No link here'));
  });
});

describe('matchSymbols', () => {
  it('matches tickers and names case-insensitively', () => {
    assert.deepEqual(matchSymbols('BTC rally continues'), ['BTC']);
    assert.deepEqual(matchSymbols('bitcoin breaks out'), ['BTC']);
    assert.deepEqual(matchSymbols('Solana surge noted'), ['SOL']);
  });

  it('respects word boundaries', () => {
    assert.deepEqual(matchSymbols('BTCC launches something'), []);
  });

  it('suppresses shorter phrases contained in longer matches', () => {
    assert.deepEqual(matchSymbols('Ethereum Classic rallies'), ['ETC']);
  });

  it('does not false-positive on common words', () => {
    assert.deepEqual(matchSymbols('Bitcoin nears $100k'), ['BTC']);
  });
});

function stubFetch(feeds: Record<string, string>) {
  return (async (url: string) => {
    const xml = feeds[url];
    if (xml === undefined) throw new Error('network down');
    return { ok: true, text: async () => xml };
  }) as unknown as typeof fetch;
}

describe('fetchNews', () => {
  it('merges feeds, dedupes by link, caps at 50', async () => {
    const item = (i: number) =>
      `<item><title>News ${i} about Bitcoin</title><link>https://example.com/${i}</link>` +
      `<pubDate>Mon, 27 Oct 2026 10:00:00 GMT</pubDate></item>`;
    const many = Array.from({ length: 60 }, (_, i) => item(i)).join('');
    const feeds: Record<string, string> = {
      'https://www.coindesk.com/arc/outboundfeeds/rss':
        `<rss><channel>${many}</channel></rss>`,
      'https://cointelegraph.com/rss':
        `<rss><channel>${item(0)}${item(59)}${item(60)}</channel></rss>`,
      'https://decrypt.co/feed': `<rss><channel></channel></rss>`,
    };
    const items = await fetchNews(stubFetch(feeds));
    assert.equal(items.length, 50);
    assert.equal(new Set(items.map((i) => i.link)).size, 50);
    assert.ok(items.every((i) => i.symbols.includes('BTC')));
  });

  it('per-feed failure yields other feeds, total failure yields []', async () => {
    const feeds: Record<string, string> = {
      'https://cointelegraph.com/rss':
        '<rss><channel><item><title>Solana up</title><link>https://example.com/s</link></item></channel></rss>',
    };
    const items = await fetchNews(stubFetch(feeds));
    assert.equal(items.length, 1);
    assert.deepEqual(items[0].symbols, ['SOL']);
    assert.deepEqual(await fetchNews(stubFetch({})), []);
  });
});

describe('refreshNewsCache', () => {
  it('writes cache atomically on success, nothing on empty', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'news-test-'));
    const cachePath = path.join(dir, 'news-cache.json');
    const feeds: Record<string, string> = {
      'https://cointelegraph.com/rss':
        '<rss><channel><item><title>Bitcoin up</title><link>https://example.com/b</link></item></channel></rss>',
    };
    const cache = await refreshNewsCache(cachePath, stubFetch(feeds));
    assert.ok(cache);
    assert.equal(cache.count, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(cachePath, 'utf8')), cache);
    const empty = await refreshNewsCache(cachePath, stubFetch({}));
    assert.equal(empty, null);
    assert.equal(JSON.parse(fs.readFileSync(cachePath, 'utf8')).count, 1);
  });
});

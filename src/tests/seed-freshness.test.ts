/** Unit tests: seed-freshness guard for startup hydration. */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isFreshSeedReport, SEED_MAX_AGE_MS } from '../paper';

describe('isFreshSeedReport', () => {
  let dir: string;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-guard-'));
  });
  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const write = (name: string, content: string): string => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, content);
    return p;
  };
  const now = Date.now();

  it('fresh report passes', () => {
    const p = write('fresh.json', JSON.stringify({ generatedAt: new Date(now).toISOString() }));
    assert.equal(isFreshSeedReport(p, now), true);
  });

  it('report older than 24h is stale', () => {
    const p = write(
      'old.json',
      JSON.stringify({ generatedAt: new Date(now - SEED_MAX_AGE_MS - 1000).toISOString() }),
    );
    assert.equal(isFreshSeedReport(p, now), false);
  });

  it('missing file is stale', () => {
    assert.equal(isFreshSeedReport(path.join(dir, 'nope.json'), now), false);
  });

  it('malformed JSON is stale', () => {
    const p = write('bad.json', '{not json');
    assert.equal(isFreshSeedReport(p, now), false);
  });

  it('missing generatedAt is stale', () => {
    const p = write('nogent.json', JSON.stringify({ account: {} }));
    assert.equal(isFreshSeedReport(p, now), false);
  });

  it('future generatedAt (clock skew) is stale', () => {
    const p = write(
      'future.json',
      JSON.stringify({ generatedAt: new Date(now + 60_000).toISOString() }),
    );
    assert.equal(isFreshSeedReport(p, now), false);
  });
});

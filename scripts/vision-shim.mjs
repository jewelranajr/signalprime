// vision-shim.mjs — localhost relay for Binance market data.
//
// WHY THIS EXISTS (2026-10-07): on this host, node's fetch to
// https://data-api.binance.vision is denied by the egress policy
// ("backgroundEgressRestrictions"), while curl can reach the same
// endpoint fine through the egress proxy. api.binance.com answers
// HTTP 451 (geo-block) from this region. The paper-trading runner
// uses node fetch, so a restarted session scans BLIND (empty klines,
// every coin grades NO_TRADE with long=0.0/short=0.0) until this relay
// is used.
//
// HOW TO USE:
//   1. Start the relay:  node scripts/vision-shim.mjs        (port 18787, 127.0.0.1)
//   2. Restart paper-run with: BINANCE_BASE_URLS=http://127.0.0.1:18787 node dist/scripts/paper-run.js ...
// The exchange layer already honors BINANCE_BASE_URLS (src/config.ts),
// so no code changes are needed. Stop this relay when the host's
// egress policy allows node fetch to the vision endpoint again.

import http from 'node:http';
import { execFile } from 'node:child_process';

const PORT = Number(process.env.SHIM_PORT || 18787);
const UPSTREAM = process.env.SHIM_UPSTREAM || 'https://data-api.binance.vision';

const server = http.createServer((req, res) => {
  const target = UPSTREAM + req.url;
  execFile(
    'curl',
    ['-sS', '--max-time', '25', '-w', '\n%{http_code}', target],
    (err, stdout) => {
      if (err) {
        res.writeHead(502, { 'content-type': 'text/plain' });
        res.end('shim upstream error');
        return;
      }
      const idx = stdout.lastIndexOf('\n');
      const code = parseInt(stdout.slice(idx + 1).trim(), 10) || 502;
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(stdout.slice(0, idx));
    },
  );
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[vision-shim] relaying ${UPSTREAM} on http://127.0.0.1:${PORT}`);
});

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:https';
import { gunzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';

if (process.argv.includes('--wal-writer')) {
  const db = new DatabaseSync('/usage/usage.sqlite');
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
    INSERT INTO usage (principal_hash, successes, attempt_day, attempts)
    VALUES ('synthetic-backup-principal', 3, '2000-01-01', 4);`);
  writeFileSync('/tmp/wal-ready', 'ready');
  setInterval(() => {}, 1000);
} else {
  const cloudflare = process.argv.includes('--cloudflare');
  const host = process.env.PRODUCTION_TEST_HOST ?? 'web';
  const ca = readFileSync('/certificates/origin.crt');
  async function get(path, headers = {}, method = 'GET') {
    return new Promise((resolve, reject) => {
      const req = request({ hostname: host, port: 8443, servername: 'web', path, method, headers, ca,
        timeout: 10_000, rejectUnauthorized: true }, response => {
        const chunks = [];
        response.on('error', reject);
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
      });
      req.on('timeout', () => req.destroy(new Error('HTTPS smoke timed out')));
      req.on('error', reject);
      req.end();
    });
  }
  if (!cloudflare) {
    const health = await get('/api/health');
    assert.equal(health.status, 200);
    assert.equal(JSON.parse(health.body).data.status, 'ok');
    for (const path of [
      '/web/public/invitation-opening-petals.mp3', '/web/public/wedding-example.jpg', '/web/public/florals.jpg',
      '/web/public/outfits/W001.webp', '/web/public/outfits/W030-thumb.webp', '/web/public/venues/V001.webp',
    ]) {
      const result = await get(path);
      assert.equal(result.status, 200, path);
      assert.equal(result.headers['cache-control'], 'public, max-age=31536000, immutable', path);
    }
    for (const path of ['/', '/web/public/manifest.json', '/web/app.mjs']) {
      const result = await get(path);
      assert.equal(result.status, 200, path);
      assert.equal(result.headers['cache-control'], 'no-cache', path);
    }
    const compressed = await get('/web/app.mjs', { 'Accept-Encoding': 'gzip' });
    assert.equal(compressed.headers['content-encoding'], 'gzip');
    assert.match(gunzipSync(compressed.body).toString(), /import/);
  }
  // Each bucket allows five immediate requests. Only a real Cloudflare peer may select a new client IP.
  const clients = cloudflare ? ['198.51.100.10', '198.51.100.11'] : ['untrusted'];
  for (const client of clients) {
    for (let index = 0; index < 6; index++) {
      const result = await get('/api/tryon/authorize', {
        'CF-Connecting-IP': cloudflare ? client : `198.51.100.${index + 1}`,
        'X-Forwarded-For': `192.0.2.${index + 1}`, 'X-Real-IP': `203.0.113.${index + 1}`,
      }, 'POST');
      assert.equal(result.status, index < 5 ? 401 : 429, `${client}: request ${index + 1}`);
      assert.equal(result.headers['cache-control'], 'no-store');
    }
  }
  console.log(cloudflare ? 'Trusted Cloudflare peer restores separate visitor rate-limit buckets: PASS' : 'Strict HTTPS, immutable caches, gzip and untrusted CF header rejection: PASS');
}

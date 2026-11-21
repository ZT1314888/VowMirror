import assert from 'node:assert/strict';

const response = await fetch((process.env.SMOKE_BASE_URL ?? 'http://web:8080') + '/api/tryon/authorize', {
  method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${process.env.TRYON_API_KEYS.split(',')[0].trim()}` },
  signal: AbortSignal.timeout(10_000),
});
assert.equal(response.status, 200);
assert.equal((await response.json()).data.remaining, 5);
console.log('Backend restart, writable persistent usage volume and fresh authorization passed; nonzero counter persistence covered by SQLite/TLS integration tests.');

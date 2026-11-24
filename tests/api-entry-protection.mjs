import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { getAPIError } from '../web/response-core.mjs';

// Only scripts/verify-api-entry.ps1 may invoke this against an empty-model, internal network.
const base = 'http://web:8080';
const clientMarker = 'synthetic-entry-client-request-id';
const tokens = process.env.TRYON_API_KEYS?.split(',');
assert.equal(tokens?.length, 4, 'four independent synthetic principals are required');
assert.ok(tokens.every(token => token.startsWith('synthetic-entry-')));
const routes = [
  { path: '/api/tryon/authorize', burst: 5, retry: 2, refillMs: 2000, status: 401 },
  { path: '/api/tryon/couple', burst: 4, retry: 3, refillMs: 3000, status: 401 },
  { path: '/api/catalog/outfits', burst: 20, retry: 1, refillMs: 500, status: 200 },
];

async function request(path, { token = 'synthetic-invalid-code', body, spoof = 1 } = {}) {
  const response = await fetch(base + path, {
    method: path.startsWith('/api/tryon/') ? 'POST' : 'GET',
    redirect: 'error', signal: AbortSignal.timeout(10_000),
    headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
      'X-Request-ID': clientMarker,
      'X-Forwarded-For': `192.0.2.${spoof}`, 'X-Real-IP': `198.51.100.${spoof}`,
      Forwarded: `for=203.0.113.${spoof};proto=https`,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, headers: Object.fromEntries(response.headers), text };
}

function json(response) { return JSON.parse(response.text); }

function rateLimited(response, retry) {
  assert.equal(response.status, 429);
  assert.match(response.headers['content-type'], /^application\/json\b/);
  assert.equal(response.headers['retry-after'], String(retry));
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
  assert.match(response.headers['content-security-policy'], /frame-ancestors 'none'/);
  const id = response.headers['x-request-id'];
  assert.ok(id);
  assert.notEqual(id, clientMarker);
  const payload = json(response);
  assert.equal(payload.code, 42901);
  assert.deepEqual(payload.data, { error_code: 'RATE_LIMITED', request_id: id });
  assert.deepEqual(getAPIError(response, payload), {
    code: 'RATE_LIMITED', text: '请求过于频繁，请稍后再试',
  });
}

function authInvalid(response) {
  assert.equal(response.status, 401);
  assert.equal(json(response).data.error_code, 'AUTH_INVALID');
  assert.equal(getAPIError(response, json(response)).code, 'AUTH_INVALID');
}

function terminal(response, errorCode, displayCode) {
  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /^text\/event-stream\b/);
  const frames = response.text.trim().split(/\r?\n\r?\n/);
  const errors = frames.filter(frame => /^event: error$/m.test(frame));
  assert.equal(errors.length, 1);
  assert.equal(frames.at(-1), errors[0]);
  const payload = JSON.parse(errors[0].match(/^data: (.+)$/m)[1]);
  assert.equal(payload.data.error_code, errorCode);
  assert.equal(getAPIError({ status: payload.data.http_status }, payload).code, displayCode);
}

async function bursts() {
  // Parallel requests keep even the 20-request catalog burst within one refill period.
  // Path variants and forged headers share the same bucket; target routes stay independent.
  for (const route of routes) {
    const started = performance.now();
    const variants = [route.path, route.path + '/', route.path + '//',
      route.path.replace(/.$/, character => '%' + character.charCodeAt(0).toString(16))];
    const responses = await Promise.all(Array.from({ length: route.burst + 1 }, (_, index) =>
      request(`${variants[index % variants.length]}?probe=${index}`, { spoof: index + 1 })));
    assert.ok(performance.now() - started < route.refillMs,
      'burst exceeded a refill interval; timing evidence is inconclusive');
    const admitted = responses.filter(response => response.status !== 429);
    const rejected = responses.filter(response => response.status === 429);
    assert.equal(admitted.length, route.burst, route.path);
    assert.equal(rejected.length, 1, route.path);
    for (const response of admitted) {
      assert.equal(response.status, route.status);
      if (route.status === 401) authInvalid(response);
    }
    rateLimited(rejected[0], route.retry);
    console.log(`PASS burst, slash/query/header variants: ${route.path} (${route.burst})`);
  }
}

async function restored() {
  // Even the longest refill interval (couple) has elapsed, but only one request is needed.
  await delay(3200);
  for (const route of routes) {
    const response = await request(route.path + '/?restored=1');
    assert.equal(response.status, route.status, route.path);
    if (route.status === 401) authInvalid(response);
  }
  console.log('PASS refill recovery and authentication classification after rejection');
}

const checker = readFileSync(new URL('../backend/internal/imagevalidate/testdata/checker.png', import.meta.url)).toString('base64');
const couple = readFileSync(new URL('../backend/internal/facedetect/testdata/two.jpg', import.meta.url)).toString('base64');
const input = image => ({ couple_image: image, outfit_id: 'W001', scene: { mode: 'original' } });

async function faceBeforeAndAfter() {
  terminal(await request(routes[1].path, { token: tokens[0], body: input(checker) }),
    'COUPLE_IMAGE_NOT_COUPLE', 'COUPLE_IMAGE_NOT_COUPLE');
  for (let index = 0; index < 3; index++) authInvalid(await request(routes[1].path));
  rateLimited(await request(routes[1].path, { token: tokens[1], body: input(couple) }), 3);
  await delay(3200);
  terminal(await request(routes[1].path + '/?after=1', { token: tokens[1], body: input(checker) }),
    'COUPLE_IMAGE_NOT_COUPLE', 'COUPLE_IMAGE_NOT_COUPLE');
  console.log('PASS face errors before/after entry rejection; valid generation blocked at entry');
}

async function backendLimiter() {
  // A fresh IP bucket permits four requests; the shared principal bucket permits only three.
  for (let index = 0; index < 3; index++) {
    const response = await request(routes[0].path, { token: tokens[2] });
    assert.equal(response.status, 200);
    assert.equal(json(response).data.remaining, 5);
  }
  rateLimited(await request(routes[1].path, { token: tokens[2], body: input(couple) }), 6);
  const independent = await request(routes[0].path, { token: tokens[3] });
  assert.equal(independent.status, 200, 'a different principal keeps its backend bucket');
  // The second principal's first generation is admitted: the prior backend 429 was not
  // rewritten by Nginx, and the empty model fails explicitly without transport/accounting.
  terminal(await request(routes[1].path, { token: tokens[3], body: input(couple) }), 'MODEL_CONFIGURATION_INVALID', 'API_ERROR');
  console.log('PASS backend per-code limiter shared across routes, principal isolation, empty model');
}

async function publicExclusions() {
  for (const path of ['/api/health', '/web/response-core.mjs']) {
    const responses = await Promise.all(Array.from({ length: 25 }, () => request(path)));
    assert.ok(responses.every(response => response.status === 200), path);
  }
  for (const route of routes) {
    const uppercase = route.path.replace(/[^/]+$/, segment => segment.toUpperCase());
    assert.equal((await request(uppercase)).status, 404, 'unmatched case variants must not reach a protected handler');
  }
  console.log('PASS health and static resources excluded while entry buckets are exhausted');
}

const scenarios = { bursts, faceBeforeAndAfter, backendLimiter };
function clientIP() {
  const addresses = Object.values(networkInterfaces()).flat().filter(address => !address.internal && address.family === 'IPv4');
  assert.equal(addresses.length, 1, 'one isolated app network per client');
  return addresses[0].address;
}

if (process.argv.includes('--peer')) {
  createServer(async (req, res) => {
    if (req.url === '/ready') { res.end(clientIP()); return; }
    const scenario = scenarios[req.url.slice(1)];
    if (req.method !== 'POST' || !scenario) { res.writeHead(404).end(); return; }
    try { await scenario(); res.end('passed'); }
    catch (error) { console.error(error); res.writeHead(500).end(String(error)); }
  }).listen(8099, '0.0.0.0');
} else {
  const peer = process.env.ENTRY_PEER_URL;
  assert.ok(peer, 'a second simultaneously running client is required');
  const deadline = Date.now() + 10_000;
  while (true) {
    let response;
    try { response = await fetch(`${peer}/ready`, { signal: AbortSignal.timeout(1000) }); }
    catch (error) {
      if (Date.now() >= deadline) throw new Error('Peer readiness timed out', { cause: error });
      await delay(100);
      continue;
    }
    assert.equal(response.status, 200);
    assert.notEqual(await response.text(), clientIP(), 'both live clients must have different source IPs');
    break;
  }
  const { DatabaseSync } = await import('node:sqlite');
  const ledger = new DatabaseSync('/usage/usage.sqlite', { readOnly: true });
  const counts = () => ledger.prepare('SELECT principal_hash, successes, attempt_day, attempts FROM usage ORDER BY principal_hash').all();
  assert.deepEqual(counts(), [], 'fresh isolated ledger');
  async function remote(scenario) {
    const response = await fetch(`${peer}/${scenario}`, { method: 'POST', signal: AbortSignal.timeout(20_000) });
    assert.equal(response.status, 200, await response.text());
  }
  try {
    await bursts();
    await publicExclusions();
    // Peer B keeps its own live network endpoint while A is still present and exhausted.
    await remote('faceBeforeAndAfter');
    await restored();
    // Fill both clients' buckets from idle for a direct A/B burst comparison.
    await delay(13_000);
    await bursts();
    await remote('bursts');
    await delay(13_000);
    await backendLimiter();
    assert.deepEqual(counts(), [], 'entry and backend rejection must never write attempts/successes');
    console.log('PASS two simultaneous source IPs and zero attempt/success ledger writes');
  } finally { ledger.close(); }
}

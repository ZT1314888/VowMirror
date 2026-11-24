import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';

// Invoked only by verify-phase6.ps1 after empty-model and internal-network checks.
const base = process.env.SMOKE_BASE_URL ?? 'http://web:8080';
const accessToken = process.env.TRYON_API_KEYS?.split(',').map(token => token.trim()).find(Boolean);
assert.ok(accessToken, 'HTTP acceptance requires a synthetic access token');

async function post({ headers = {}, data }) {
  // Entry (Nginx, per connection IP) and principal (backend, per access code) limits are
  // independent budgets, so one rejection can be followed by the other limiter. Honor
  // every bounded Retry-After; a fixed single retry fails whenever both apply.
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch(base + '/api/tryon/couple', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data),
    });
    if (response.status !== 429) return response;
    assert.ok(response.headers.has('retry-after'), 'entry and backend 429 responses publish Retry-After');
    const delay = Number(response.headers.get('retry-after'));
    assert.ok(Number.isInteger(delay) && delay > 0 && delay <= 60, 'bounded explicit rate-limit delay');
    assert.equal((await response.json()).data.error_code, 'RATE_LIMITED');
    await new Promise(resolve => setTimeout(resolve, delay * 1000));
  }
  throw new Error('rate limits did not recover within four advertised Retry-After waits');
}


async function terminalEvent(response) {
  assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream\b/);
  const frames = (await response.text()).split(/\r?\n\r?\n/).filter(Boolean).map(frame => {
    const event = frame.match(/^event: ([^\r\n]+)/m)?.[1];
    const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
    return { event, payload: JSON.parse(data) };
  });
  const terminal = frames.filter(frame => frame.event === 'result' || frame.event === 'error');
  assert.equal(terminal.length, 1, 'SSE must have exactly one terminal event');
  assert.equal(frames.at(-1), terminal[0], 'terminal event must end the stream');
  return terminal[0];
}

async function verifyBodyLimit() {
  const limit = 24 * 1024 * 1024;
  const oversized = Buffer.alloc(limit + 1, 'a');
  oversized.write('{"couple_image":"');
  oversized.write('"}', oversized.length - 2);
  const chunkSize = 64 * 1024;
  const clientRequestID = 'synthetic-body-limit-client-marker';
  for (const scenario of [
    { name: 'content-length', token: accessToken, chunked: false },
    { name: 'chunked', token: accessToken, chunked: true },
    { name: 'unauthenticated', token: '', chunked: false },
  ]) {
    const response = await new Promise((resolve, reject) => {
      const request = httpRequest(base + '/api/tryon/couple', {
        method: 'POST', agent: false, signal: AbortSignal.timeout(15_000),
        headers: { 'Content-Type': 'application/json', 'X-Request-ID': clientRequestID,
          ...(scenario.token ? { Authorization: `Bearer ${scenario.token}` } : {}),
          ...(scenario.chunked ? { 'Transfer-Encoding': 'chunked' } : { 'Content-Length': oversized.length }) },
      }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() }));
      });
      request.on('error', reject);
      for (let offset = 0; offset < oversized.length; offset += chunkSize) request.write(oversized.subarray(offset, offset + chunkSize));
      request.end();
    });
    assert.equal(response.status, 413, scenario.name);
    assert.match(response.headers['content-type'] ?? '', /^application\/json\b/, scenario.name);
    const requestID = response.headers['x-request-id'];
    assert.ok(requestID, `${scenario.name}: missing request ID`);
    assert.notEqual(requestID, clientRequestID);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    const payload = JSON.parse(response.body);
    assert.equal(payload.code, 41301, scenario.name);
    assert.deepEqual(payload.data, { error_code: 'REQUEST_TOO_LARGE', request_id: requestID }, scenario.name);
    console.log(`Body limit through Nginx: ${scenario.name} passed`);
  }
}

await verifyBodyLimit();
for (const headers of [{}, { Authorization: 'Bearer synthetic-invalid-catalog-token' }]) {
  const directoryResponse = await fetch(base + '/api/catalog/outfits', { headers, cache: 'no-store', redirect: 'error' });
  assert.equal(directoryResponse.status, 200, 'public catalog does not require generation authorization');
  assert.equal(directoryResponse.headers.get('cache-control'), 'no-store');
  const directory = await directoryResponse.json();
  assert.deepEqual(Object.keys(directory.data).sort(), ['outfits', 'venues', 'version']);
  assert.ok(directory.data.outfits.length > 0);
  assert.ok(directory.data.outfits.every(entry => Object.keys(entry).sort().join(',') === 'id,name'));
  assert.ok(directory.data.venues.every(entry => Object.keys(entry).sort().join(',') === 'id,name'));
}
// Entry and backend limits are independent budgets; honor every advertised Retry-After.
async function authorize(token) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch(base + '/api/tryon/authorize', {
      method: 'POST', redirect: 'error', headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (response.status !== 429) return response;
    assert.ok(response.headers.has('retry-after'), 'authorize 429 responses publish Retry-After');
    const delay = Number(response.headers.get('retry-after'));
    assert.ok(Number.isInteger(delay) && delay > 0 && delay <= 60);
    assert.equal((await response.json()).data.error_code, 'RATE_LIMITED');
    await new Promise(resolve => setTimeout(resolve, delay * 1000));
  }
  throw new Error('authorize rate limits did not recover within four advertised waits');
}
for (const [token, status] of [['', 401], ['synthetic-invalid-code', 401], [accessToken, 200]]) {
  const response = await authorize(token);
  assert.equal(response.status, status);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  if (status === 200) assert.deepEqual(body, { code: 0, message: '', data: { remaining: 5 } });
  else assert.match(body.data.error_code, /^AUTH_/);
}
const checker = readFileSync(new URL('../backend/internal/imagevalidate/testdata/checker.png', import.meta.url)).toString('base64');
const single = readFileSync(new URL('../backend/internal/facedetect/testdata/one.jpg', import.meta.url)).toString('base64');
const validCouple = readFileSync(new URL('../backend/internal/facedetect/testdata/two.jpg', import.meta.url)).toString('base64');
for (const token of ['', 'synthetic-invalid-generation-token']) {
  const response = await post({
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    data: { couple_image: validCouple, outfit_id: 'W001', scene: { mode: 'original' } },
  });
  assert.equal(response.status, 401);
}
for (const couple_image of [checker, single]) {
  const response = await post({
    headers: { Authorization: `Bearer ${accessToken}` },
    data: { couple_image, outfit_id: 'W001', scene: { mode: 'original' } },
  });
  assert.equal(response.status, 200);
  const terminal = await terminalEvent(response);
  assert.equal(terminal.event, 'error');
  assert.equal(terminal.payload.code, 42210);
  assert.equal(terminal.payload.data.error_code, 'COUPLE_IMAGE_NOT_COUPLE');
  assert.equal(terminal.payload.data.http_status, 422);
  assert.equal(terminal.payload.message, '未检测到两张清晰的人脸，请换一张两人面部清楚的合照。');
}
const unconfigured = await post({
  headers: { Authorization: `Bearer ${accessToken}` },
  data: { couple_image: validCouple, outfit_id: 'W001', scene: { mode: 'upload', image: checker } },
});
assert.equal(unconfigured.status, 200, 'accepted generation requests establish an SSE stream');
const unconfiguredTerminal = await terminalEvent(unconfigured);
assert.equal(unconfiguredTerminal.event, 'error');
assert.equal(unconfiguredTerminal.payload.data.error_code, 'MODEL_CONFIGURATION_INVALID');
assert.equal(unconfiguredTerminal.payload.data.http_status, 503);
for (const [scene, code, streamed] of [
  [{ mode: 'original', image: '' }, 'INVALID_REQUEST', false],
  [{ mode: 'upload', image: '', venue_id: 'V001' }, 'INVALID_REQUEST', false],
  [{ mode: 'upload', image: 'broken' }, 'INVALID_IMAGE_BASE64', true],
  [{ mode: 'venue', venue_id: 'V999' }, 'UNKNOWN_VENUE', true],
  [{ mode: 'venue', venue_id: '../private/intake.json' }, 'UNKNOWN_VENUE', true],
]) {
  const response = await post({ headers: { Authorization: `Bearer ${accessToken}` }, data: { couple_image: validCouple, outfit_id: 'W001', scene } });
  if (!streamed) {
    assert.equal(response.status, 422);
    assert.equal((await response.json()).data.error_code, code);
  } else {
    assert.equal(response.status, 200);
    const terminal = await terminalEvent(response);
    assert.equal(terminal.event, 'error');
    assert.equal(terminal.payload.data.error_code, code);
    assert.equal(terminal.payload.data.http_status, 422);
  }
}
console.log('Isolated HTTP acceptance: auth, empty model configuration and invalid inputs passed');

const remaining = await authorize(accessToken);
assert.equal(remaining.status, 200);
assert.equal((await remaining.json()).data.remaining, 5, 'preflight and pre-send failures preserve all successes');

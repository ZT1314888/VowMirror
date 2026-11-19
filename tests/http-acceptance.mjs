import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';

// Invoked only by verify-phase6.ps1 after empty-model and internal-network checks.
const base = process.env.SMOKE_BASE_URL ?? 'http://web:8080';
const accessToken = process.env.TRYON_API_KEYS?.split(',').map(token => token.trim()).find(Boolean);
assert.ok(accessToken, 'HTTP acceptance requires a synthetic access token');

async function post({ headers = {}, data }) {
  const response = await fetch(base + '/api/tryon/couple', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
    headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data),
  });
  return response;
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
const validCouple = readFileSync(new URL('../backend/internal/imagevalidate/testdata/checker.png', import.meta.url)).toString('base64');
for (const token of ['', 'synthetic-invalid-generation-token']) {
  const response = await post({
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    data: { couple_image: validCouple, outfit_id: 'W001', dress_side: 'left', scene: { mode: 'original' } },
  });
  assert.equal(response.status, 401);
}
const unconfigured = await post({
  headers: { Authorization: `Bearer ${accessToken}` },
  data: { couple_image: validCouple, outfit_id: 'W001', dress_side: 'left', scene: { mode: 'original' } },
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
  const response = await post({ headers: { Authorization: `Bearer ${accessToken}` }, data: { couple_image: validCouple, outfit_id: 'W001', dress_side: 'left', scene } });
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

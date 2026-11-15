import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { request as httpRequest } from 'node:http';
import { validateManifest } from '../scripts/verify-wedding-assets.mjs';

const require = createRequire('/opt/browser/package.json');
const { chromium } = require('playwright');
const stageIndex = process.argv.indexOf('--stage');
const stage = stageIndex >= 0 ? process.argv[stageIndex + 1] : '';
assert.equal(stage, 'foundation', 'only the implemented foundation stage can be verified');
const base = process.env.SMOKE_BASE_URL ?? 'http://web:8080';
const accessToken = process.env.TRYON_API_KEYS?.split(',').map(token => token.trim()).find(Boolean);
assert.ok(accessToken, 'catalog smoke requires TRYON_API_KEYS in the browser tool container');

async function verifyBodyLimit() {
  const limit = 24 * 1024 * 1024;
  const oversized = Buffer.alloc(limit + 1, 'a');
  oversized.write('{"couple_image":"');
  oversized.write('"}', oversized.length - 2);
  const chunkSize = 64 * 1024;
  const clientRequestID = 'synthetic-body-limit-client-marker';
  const cases = [
    { name: 'content-length', token: accessToken, chunked: false },
    { name: 'chunked', token: accessToken, chunked: true },
    { name: 'unauthenticated', token: '', chunked: false },
  ];
  for (const scenario of cases) {
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
      for (let offset = 0; offset < oversized.length; offset += chunkSize) {
        request.write(oversized.subarray(offset, offset + chunkSize));
      }
      request.end();
    });
    assert.equal(response.status, 413, scenario.name);
    assert.match(response.headers['content-type'] ?? '', /^application\/json\b/, scenario.name);
    const requestID = response.headers['x-request-id'];
    assert.ok(requestID, `${scenario.name}: missing request ID`);
    assert.notEqual(requestID, clientRequestID, 'request ID must be server-generated');
    assert.equal(response.headers['cache-control'], 'no-store', scenario.name);
    assert.equal(response.headers['x-content-type-options'], 'nosniff', scenario.name);
    assert.equal(response.headers['referrer-policy'], 'no-referrer', scenario.name);
    assert.match(response.headers['content-security-policy'] ?? '', /default-src 'self'/, scenario.name);
    const payload = JSON.parse(response.body);
    assert.equal(payload.code, 41301, scenario.name);
    assert.deepEqual(payload.data, { error_code: 'REQUEST_TOO_LARGE', request_id: requestID }, scenario.name);
    assert.equal(payload.message, '上传内容过大，请压缩图片后重试', scenario.name);
    console.log(`Body limit through Nginx: ${scenario.name} passed`);
  }
}

await verifyBodyLimit();
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  const requested = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('request', request => requested.push(request.url()));
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const response = await page.goto(base);
    assert.equal(response.status(), 200);
    await page.getByRole('heading', { name: '婚礼双人 AI 换装', exact: true }).waitFor();
    await page.getByText('后端连接正常', { exact: true }).waitFor();
    assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN');
    assert.equal(await page.locator('button').count(), 1, 'no generation control in foundation');
    assert.equal(await page.locator('input[type=file]').count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `overflow at ${width}`);
  }
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'check-health');
  assert.equal(await page.locator('#check-health').evaluate(element => getComputedStyle(element).outlineStyle), 'solid');
  await page.keyboard.press('Enter');
  await page.getByText('后端连接正常', { exact: true }).waitFor();
  const health = await page.request.get(base + '/api/health');
  assert.equal(health.status(), 200);
  assert.deepEqual(await health.json(), { code: 0, message: '', data: { status: 'ok' } });
  assert.ok(health.headers()['x-request-id']);
  for (const path of ['/api/tryon']) {
    assert.equal((await page.request.post(base + path, { data: {} })).status(), 404, `POST ${path} must be removed`);
  }
  for (const token of ['', 'invalid-catalog-smoke-token']) {
    const response = await page.request.get(base + '/api/catalog/outfits', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    assert.equal(response.status(), 401, 'catalog requires a valid access token');
    assert.ok(response.headers()['x-request-id']);
  }
  for (const token of ['', 'invalid-generation-smoke-token']) {
    const response = await page.request.post(base + '/api/tryon/couple', {
      headers: token ? { Authorization: `Bearer ${token}` } : {}, data: {},
    });
    assert.equal(response.status(), 401, 'generation requires a valid access token');
    assert.ok(response.headers()['x-request-id']);
  }
  // An invalid contract must fail before a model request, even if runtime credentials exist.
  const generation = await page.evaluate(async token => {
    const response = await fetch('/api/tryon/couple', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ couple_image: '', outfit_id: 'W001', dress_side: 'left', scene: { mode: 'original' } }),
    });
    return { status: response.status, body: await response.json() };
  }, accessToken);
  assert.equal(generation.status, 422);
  assert.equal(generation.body.data.error_code, 'INVALID_IMAGE_BASE64');
  // Account for the one expected failed fetch without discarding unrelated errors.
  assert.equal(consoleErrors.length, 1, 'only the explicit invalid-generation probe may log an error');
  assert.match(consoleErrors.shift(), /Failed to load resource:.*422/);
  let catalogResponse;
  try {
    catalogResponse = await page.request.get(base + '/api/catalog/outfits', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch (error) {
    // Playwright transport errors can include request headers in their call log.
    throw new Error(String(error).replaceAll(accessToken, '[redacted]'));
  }
  assert.equal(catalogResponse.status(), 200, 'catalog must load the packaged manifest');
  assert.equal(catalogResponse.headers()['cache-control'], 'no-store');
  assert.ok(catalogResponse.headers()['x-request-id']);
  const catalog = await catalogResponse.json();
  assert.deepEqual(Object.keys(catalog).sort(), ['code', 'data', 'message']);
  assert.equal(catalog.code, 0);
  assert.equal(catalog.message, '');
  assert.deepEqual(Object.keys(catalog.data).sort(), ['outfits', 'poses', 'version'], 'catalog must not create built-in venue options without venue photos');
  assert.deepEqual(validateManifest(catalog.data), [], 'catalog must contain only valid metadata');
  for (const path of ['/api/comfyui/health', '/api/hello', '/.env', '/backend/manifest/config/config.example.yaml', '/docs/Project_Architecture_Blueprint.md', '/README.md', '/data.js', '/assets/wedding/manifest.json', '/assets/wedding/' + catalog.data.outfits[0].dress, '/assets/wedding/' + catalog.data.poses[0].path]) {
    assert.equal((await page.request.get(base + path)).status(), 404, `${path} must not be exposed`);
  }
  assert.deepEqual(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })), { local: 0, session: 0 });
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(consoleErrors, [], 'unexpected browser console errors');
  assert.ok(requested.every(url => new URL(url).origin === new URL(base).origin), 'page must not contact external services');
  // An API transport failure must produce visible failure and support a manual retry.
  await page.route('**/api/health', route => route.fulfill({ status: 502, contentType: 'text/html', body: '<html>gateway</html>' }));
  await page.getByRole('button', { name: '重新检查连接' }).click();
  await page.getByText(/后端连接失败：/).waitFor();
  assert.equal(await page.locator('#health-status').getAttribute('data-state'), 'error');
  await page.unroute('**/api/health');
  await page.getByRole('button', { name: '重新检查连接' }).click();
  await page.getByText('后端连接正常', { exact: true }).waitFor();
  console.log(JSON.stringify({ stage, widths: [375, 768, 1024, 1440], health: 'passed', catalog: { auth: '401/401/200', outfits: catalog.data.outfits.length, poses: catalog.data.poses.length, status: 'unverified' }, generation: { auth: '401/401', invalidInput: '422', oversized: 'JSON 413 content-length/chunked/unauthenticated; server request IDs; security headers' }, obsoleteRoutes: '404', privateFiles: '404', keyboard: 'passed', transportFailure: 'passed', pageErrors }));
} finally {
  await browser.close();
}

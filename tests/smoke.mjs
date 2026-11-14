import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { validateManifest } from '../scripts/verify-wedding-assets.mjs';

const require = createRequire('/opt/browser/package.json');
const { chromium } = require('playwright');
const stageIndex = process.argv.indexOf('--stage');
const stage = stageIndex >= 0 ? process.argv[stageIndex + 1] : '';
assert.equal(stage, 'foundation', 'only the implemented foundation stage can be verified');
const base = process.env.SMOKE_BASE_URL ?? 'http://web:8080';
const accessToken = process.env.TRYON_API_KEYS?.split(',').map(token => token.trim()).find(Boolean);
assert.ok(accessToken, 'catalog smoke requires TRYON_API_KEYS in the browser tool container');
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
  for (const path of ['/api/tryon', '/api/tryon/couple']) {
    assert.equal((await page.request.post(base + path, { data: {} })).status(), 404, `POST ${path} must be removed`);
  }
  for (const token of ['', 'invalid-catalog-smoke-token']) {
    const response = await page.request.get(base + '/api/catalog/outfits', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    assert.equal(response.status(), 401, 'catalog requires a valid access token');
    assert.ok(response.headers()['x-request-id']);
  }
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
  console.log(JSON.stringify({ stage, widths: [375, 768, 1024, 1440], health: 'passed', catalog: { auth: '401/401/200', outfits: catalog.data.outfits.length, poses: catalog.data.poses.length, status: 'unverified' }, obsoleteRoutes: '404', privateFiles: '404', keyboard: 'passed', transportFailure: 'passed', pageErrors }));
} finally {
  await browser.close();
}

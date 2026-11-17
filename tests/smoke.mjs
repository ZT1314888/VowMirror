import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { blockUncontrolledGeneration, observeConsole } from './browser-observations.mjs';
import { validateManifest } from '../scripts/verify-wedding-assets.mjs';

const require = createRequire('/opt/browser/package.json');
const { chromium } = require('playwright');
const stageIndex = process.argv.indexOf('--stage');
const stage = stageIndex >= 0 ? process.argv[stageIndex + 1] : '';
const probeIndex = process.argv.indexOf('--probe');
const probe = probeIndex >= 0 ? process.argv[probeIndex + 1] : 'all';
assert.ok(['all', 'catalog', 'generation'].includes(probe), 'unknown regression probe');
assert.equal(stage, 'phase6', 'only the current Phase 6 acceptance stage can be verified');
const base = process.env.SMOKE_BASE_URL ?? 'http://web:8080';
const accessToken = process.env.TRYON_API_KEYS?.split(',').map(token => token.trim()).find(Boolean);
assert.ok(accessToken, 'Phase 6 smoke requires TRYON_API_KEYS in the browser tool container');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function withinDeadline(promise, label) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded 10 seconds`)), 10_000);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

// Responses are released by the test, never by a timing guess.
async function controlledResponse(page, pattern, response) {
  const started = deferred();
  const release = deferred();
  const handled = deferred();
  const handler = async route => {
    started.resolve(route.request());
    await release.promise;
    try {
      await route.fulfill(response);
      handled.resolve();
    } catch (error) {
      if (route.request().failure()?.errorText === 'net::ERR_ABORTED'
        && /Invalid InterceptionId|request.*(?:cancel|abort)/i.test(error.message)) handled.resolve();
      else handled.reject(error);
    }
  };
  await page.route(pattern, handler, { times: 1 });
  return {
    started: withinDeadline(started.promise, 'controlled request start'),
    async finish() {
      release.resolve();
      await withinDeadline(handled.promise, 'controlled response completion');
      await page.unroute(pattern, handler);
    },
  };
}

async function assertControls(page, operation = 'idle') {
  const generating = operation === 'generation';
  const busy = operation !== 'idle';
  for (const selector of ['#couple-image', '#clear-photo', '#scene-image', '#clear-scene', '#venue', 'input[name="scene-mode"][value="original"]', 'input[name="scene-mode"][value="upload"]', 'input[name="scene-mode"][value="venue"]', 'input[name="dress-side"][value="left"]', 'input[name="dress-side"][value="right"]']) {
    assert.equal(await page.locator(selector).isDisabled(), generating, `${selector} during ${operation}`);
  }
  for (const selector of ['#load-outfits', '#outfit', '#access-token', '#save-token', '#generate']) {
    assert.equal(await page.locator(selector).isDisabled(), busy, `${selector} during ${operation}`);
  }
  assert.equal(await page.locator('#cancel-generation').isVisible(), generating);
}

const browser = await chromium.launch({ headless: true });
let boundary;
try {
  const page = await browser.newPage({ acceptDownloads: true, serviceWorkers: 'block' });
  page.setDefaultTimeout(10_000);
  page.setDefaultNavigationTimeout(15_000);
  const pageErrors = [];
  const consoleObservation = observeConsole(page);
  boundary = await blockUncontrolledGeneration(page);
  const requested = [];
  await page.addInitScript(() => {
    window.__revokedObjectURLs = [];
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = value => { window.__revokedObjectURLs.push(value); revoke(value); };
    window.__generationSettled = 0;
    const fetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      try { return await fetch(...args); }
      finally { if (args[0] === '/api/tryon/couple') window.__generationSettled++; }
    };
  });
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('request', request => requested.push(request.url()));
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const response = await page.goto(base);
    assert.equal(response.status(), 200);
    await page.getByRole('heading', { name: '把这一刻，换成婚礼模样' }).waitFor();
    await page.getByText('服务连接正常', { exact: true }).waitFor();
    boundary.assertSafe();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('#outfit, #load-outfits, .side-options, .scene-options, #generate')].every(element => element.getBoundingClientRect().right <= innerWidth)), true, `overflow or clipped control at ${width}`);
  }
  assert.deepEqual(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })), { local: 0, session: 0 });
  const health = await page.request.get(base + '/api/health');
  assert.equal(health.status(), 200);
  assert.deepEqual(await health.json(), { code: 0, message: '', data: { status: 'ok' } });
  for (const token of ['', 'invalid-phase4-smoke-token']) {
    const response = await page.request.get(base + '/api/catalog/outfits', { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    assert.equal(response.status(), 401);
  }
  const catalogResponse = await page.request.get(base + '/api/catalog/outfits', { headers: { Authorization: `Bearer ${accessToken}` } });
  assert.equal(catalogResponse.status(), 200);
  assert.equal(catalogResponse.headers()['cache-control'], 'no-store');
  const catalog = await catalogResponse.json();
  assert.deepEqual(Object.keys(catalog).sort(), ['code', 'data', 'message']);
  assert.deepEqual(Object.keys(catalog.data).sort(), ['outfits', 'poses', 'venues', 'version']);
  assert.deepEqual(catalog.data.venues, [], 'private intake must not become fixed venues');
  assert.deepEqual(validateManifest(catalog.data), []);

  await page.locator('#access-token').fill(accessToken);
  await page.locator('#save-token').check();
  await page.getByRole('button', { name: '加载套装' }).click();
  await page.locator('#outfit option').filter({ hasText: catalog.data.outfits[0].name }).waitFor({ state: 'attached' });
  await page.locator('#outfit').selectOption(catalog.data.outfits[0].id);
  assert.equal(await page.locator('#venue-mode-option').isVisible(), false, 'no fixed venue option without photos');
  await page.locator('input[name="dress-side"][value="right"]').check();
  await page.getByText('画面右侧的人穿婚纱，另一位穿男装。', { exact: true }).waitFor();

  const fixture = readFileSync(new URL('../backend/internal/imagevalidate/testdata/checker.png', import.meta.url));
  await page.locator('#couple-image').setInputFiles({ name: 'couple.png', mimeType: 'image/png', buffer: fixture });
  await page.getByAltText('已选择的双人合照预览').waitFor();
  const requests = [];
  let catalogRequests = 0;
  page.on('request', request => {
    if (request.url().endsWith('/api/catalog/outfits')) catalogRequests++;
    if (request.url().endsWith('/api/tryon/couple')) requests.push({ body: request.postDataJSON(), authorization: request.headers().authorization });
  });
  const successResponse = { status: 200, contentType: 'application/json', body: JSON.stringify({ code: 0, message: '', data: { image: fixture.toString('base64'), mime_type: 'image/png', width: 384, height: 256, model: 'test-only', request_id: 'synthetic-generation' } }) };

  if (probe !== 'generation') {
    const reload = await controlledResponse(page, '**/api/catalog/outfits', { status: 200, contentType: 'application/json', body: JSON.stringify(catalog) });
    await page.locator('#load-outfits').click();
    await reload.started;
    await page.evaluate(() => {
      document.querySelector('#generation-form').requestSubmit();
      document.querySelector('#load-outfits').click();
    });
    await assertControls(page, 'catalog');
    assert.equal(requests.length, 0, 'catalog reload must block generation even with an existing selection');
    assert.equal(catalogRequests, 1, 'catalog reload must not overlap another reload');
    await page.locator('input[name="dress-side"][value="left"]').check();
    await page.locator('#couple-image').setInputFiles({ name: 'during-catalog.png', mimeType: 'image/png', buffer: fixture });
    await page.getByAltText('已选择的双人合照预览').waitFor();
    await reload.finish();
    await page.waitForFunction(() => !document.querySelector('#load-outfits').disabled);
    await assertControls(page);
    assert.equal(await page.locator('#outfit').inputValue(), '', 'catalog reload requires choosing an outfit again');
    await page.evaluate(() => document.querySelector('#generation-form').requestSubmit());
    await page.locator('#form-error').getByText('请先加载并选择一套婚礼造型。', { exact: true }).waitFor();
    assert.equal(requests.length, 0);
    await page.locator('#outfit').selectOption(catalog.data.outfits[0].id);
    await page.locator('input[name="dress-side"][value="right"]').check();
    console.log('Catalog reload regression: passed');
  }

  const originalPhotoURL = await page.locator('#photo-preview').getAttribute('src');
  const first = await controlledResponse(page, '**/api/tryon/couple', successResponse);
  await page.evaluate(() => { document.querySelector('#generation-form').requestSubmit(); document.querySelector('#generation-form').requestSubmit(); });
  await first.started;
  const catalogCount = catalogRequests;
  await page.evaluate(() => {
    document.querySelector('#clear-photo').click();
    document.querySelector('#load-outfits').click();
    document.querySelector('#generation-form').requestSubmit();
  });
  await assertControls(page, 'generation');
  assert.equal(await page.locator('#photo-preview-wrap').isVisible(), true, 'removal during generation must preserve the photo');
  assert.equal(await page.locator('#photo-preview').getAttribute('src'), originalPhotoURL);
  assert.equal(await page.locator('#result-state').textContent(), '生成中');
  assert.equal(await page.locator('#outfit').inputValue(), catalog.data.outfits[0].id);
  assert.equal(await page.locator('input[name="dress-side"]:checked').inputValue(), 'right');
  assert.equal(catalogRequests, catalogCount, 'generation must block catalog reload');
  assert.equal(requests.length, 1);
  await first.finish();
  await page.getByText('生成完成', { exact: true }).waitFor();
  await assertControls(page);
  assert.equal(await page.locator('#result-meta').textContent(), `${catalog.data.outfits[0].name} · 婚纱在画面右侧 · image/png`);
  console.log('Generation edit-lock regression: passed');
  assert.equal(requests.length, 1, 'repeated submit must share one in-flight request');
  assert.deepEqual(Object.keys(requests[0].body).sort(), ['couple_image', 'dress_side', 'outfit_id', 'scene']);
  assert.equal(requests[0].body.dress_side, 'right');
  assert.deepEqual(requests[0].body.scene, { mode: 'original' });
  assert.ok(requests[0].body.couple_image);
  assert.equal(requests[0].authorization, `Bearer ${accessToken}`);
  assert.equal(await page.locator('#download-result').getAttribute('download'), 'vowmirror-wedding.png');
  const firstResultURL = await page.locator('#result-image').getAttribute('src');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: '下载合影' }).click();
  assert.equal((await downloadPromise).suggestedFilename(), 'vowmirror-wedding.png');

  const priorPhotoURL = await page.locator('#photo-preview').getAttribute('src');
  await page.locator('#couple-image').setInputFiles({ name: 'replacement.png', mimeType: 'image/png', buffer: fixture });
  await page.waitForFunction(previous => {
    const image = document.querySelector('#photo-preview');
    return !document.querySelector('#photo-preview-wrap').hidden && image.getAttribute('src') && image.getAttribute('src') !== previous;
  }, priorPhotoURL);
  await page.locator('#result-image-wrap').waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(url => window.__revokedObjectURLs.includes(url), priorPhotoURL), true, 'replacement must revoke the old photo URL');
  assert.equal(await page.evaluate(url => window.__revokedObjectURLs.includes(url), firstResultURL), true, 'replacement must revoke the old result URL');
  const failure = await controlledResponse(page, '**/api/tryon/couple', { status: 503, contentType: 'application/json', body: JSON.stringify({ code: 50301, message: 'unavailable', data: { error_code: 'MODEL_CONFIGURATION_INVALID' } }) });
  await page.evaluate(() => document.querySelector('#generation-form').requestSubmit());
  await failure.started;
  await failure.finish();
  await page.locator('#generation-status').getByText('后端请求失败（HTTP 503）', { exact: true }).waitFor();
  await assertControls(page);
  assert.equal(requests.length, 2, 'failed request must not retry automatically');
  const retry = await controlledResponse(page, '**/api/tryon/couple', successResponse);
  await page.getByRole('button', { name: '生成婚礼合影' }).click();
  await retry.started;
  await retry.finish();
  await page.getByText('生成完成', { exact: true }).waitFor();
  await assertControls(page);
  assert.equal(requests.length, 3, 'manual retry must issue a new request');

  const cancelRequest = await controlledResponse(page, '**/api/tryon/couple', successResponse);
  await page.locator('input[name="dress-side"][value="left"]').check();
  await page.getByRole('button', { name: '生成婚礼合影' }).click();
  await cancelRequest.started;
  await assertControls(page, 'generation');
  await page.evaluate(() => {
    document.querySelector('#cancel-generation').click();
    document.querySelector('#generation-form').requestSubmit();
    if (!document.querySelector('#generate').disabled) throw new Error('cancel must wait for the current request to exit');
  });
  await page.locator('#generation-status').getByText('生成已取消。你可以手动重试。', { exact: true }).waitFor();
  await cancelRequest.finish();
  await page.waitForFunction(() => window.__generationSettled === 4);
  await assertControls(page);
  assert.equal(await page.locator('#result-state').textContent(), '已取消');
  assert.equal(await page.locator('#result-image-wrap').isVisible(), false, 'late canceled response must not replace the failure state');
  assert.equal(await page.locator('#result-image').getAttribute('src'), null);
  assert.equal(await page.locator('#download-result').getAttribute('href'), null);
  assert.equal(requests.length, 4, 'cancel must not automatically retry');
  const canceledPhotoURL = await page.locator('#photo-preview').getAttribute('src');
  await page.locator('#clear-photo').click();
  assert.equal(await page.locator('#photo-preview-wrap').isVisible(), false);
  assert.equal(await page.evaluate(url => window.__revokedObjectURLs.includes(url), canceledPhotoURL), true);
  await page.locator('#couple-image').setInputFiles({ name: 'after-cancel.png', mimeType: 'image/png', buffer: fixture });
  await page.getByAltText('已选择的双人合照预览').waitFor();

  await page.clock.install();
  const timeoutRequest = await controlledResponse(page, '**/api/tryon/couple', successResponse);
  await page.getByRole('button', { name: '生成婚礼合影' }).click();
  await timeoutRequest.started;
  await page.clock.fastForward(60_001);
  await page.locator('#generation-status').getByText('生成超过 60 秒，已停止请求。你可以手动重试。', { exact: true }).waitFor();
  await timeoutRequest.finish();
  await page.waitForFunction(() => window.__generationSettled === 5);
  await assertControls(page);
  assert.equal(await page.locator('#result-state').textContent(), '已超时');
  assert.equal(await page.locator('#generation-status').textContent(), '生成超过 60 秒，已停止请求。你可以手动重试。');
  assert.equal(await page.locator('#result-image-wrap').isVisible(), false, 'late timeout response must not show a result');
  assert.equal(await page.locator('#result-image').getAttribute('src'), null);
  assert.equal(await page.locator('#download-result').getAttribute('href'), null);
  assert.equal(requests.length, 5);
  const timeoutRetry = await controlledResponse(page, '**/api/tryon/couple', successResponse);
  await page.locator('#generate').click();
  await timeoutRetry.started;
  await timeoutRetry.finish();
  await page.getByText('生成完成', { exact: true }).waitFor();
  await assertControls(page);
  assert.equal(requests.length, 6, 'timeout permits an explicit manual retry');
  console.log('Cancellation, timeout and manual retry: passed');

  // Scene validation uses the real Chromium decoder, never a model or personal photos.
  await page.locator('input[name="scene-mode"][value="upload"]').check();
  await page.locator('#generate').click();
  await page.locator('#form-error').getByText('请选择一张有效的场地照片，或切换为保留原背景。', { exact: true }).waitFor();
  assert.equal(requests.length, 6);
  for (const invalid of [
    { name: 'empty.png', mimeType: 'image/png', buffer: Buffer.alloc(0), error: '图片为空' },
    { name: 'fake.png', mimeType: 'image/png', buffer: Buffer.from('not an image'), error: '不支持的图片格式' },
    { name: 'mismatch.jpg', mimeType: 'image/jpeg', buffer: fixture, error: '图片声明与真实格式不一致' },
    { name: 'truncated.png', mimeType: 'image/png', buffer: fixture.subarray(0, 40), error: '图片无法解码' },
    { name: 'oversize.png', mimeType: 'image/png', buffer: Buffer.alloc(8 * 1024 * 1024 + 1), error: '图片超过 8 MiB' },
  ]) {
    await page.locator('#scene-image').setInputFiles(invalid);
    await page.locator('#scene-error').filter({ hasText: invalid.error }).waitFor();
    assert.equal(await page.locator('#scene-image-preview-wrap').isVisible(), false);
    await page.locator('#generate').click();
    assert.equal(requests.length, 6, `${invalid.name} must never generate`);
  }
  for (const [width, height] of [[255,256],[8193,256],[4001,5000]]) {
    const bytes = await page.evaluate(async ([width, height]) => {
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      return [...new Uint8Array(await blob.arrayBuffer())];
    }, [width, height]);
    await page.locator('#scene-image').setInputFiles({ name: 'dimensions.png', mimeType: 'image/png', buffer: Buffer.from(bytes) });
    await page.locator('#scene-error').filter({ hasText: '256–8192' }).waitFor();
  }
  console.log('Scene invalid files and dimensions: passed');
  let priorSceneURL = null;
  for (const [format, mimeType] of [['png', 'image/png'], ['jpg', 'image/jpeg'], ['webp', 'image/webp']]) {
    const buffer = readFileSync(new URL(`../backend/internal/imagevalidate/testdata/checker.${format}`, import.meta.url));
    await page.locator('#scene-image').setInputFiles({ name: `scene.${format}`, mimeType, buffer });
    await page.waitForFunction(() => !document.querySelector('#scene-image-preview-wrap').hidden && document.querySelector('#scene-error').hidden);
    const current = await page.locator('#scene-image-preview').getAttribute('src');
    if (priorSceneURL) assert.equal(await page.evaluate(url => window.__revokedObjectURLs.includes(url), priorSceneURL), true);
    assert.notEqual(current, priorSceneURL);
    priorSceneURL = current;
  }
  const sceneWebP = readFileSync(new URL('../backend/internal/imagevalidate/testdata/checker.webp', import.meta.url));
  console.log('Scene real three-format decoding and replacement: passed');
  const sceneRequest = await controlledResponse(page, '**/api/tryon/couple', successResponse);
  await page.locator('#generate').click();
  await sceneRequest.started;
  await assertControls(page, 'generation');
  await page.evaluate(() => document.querySelector('#clear-scene').click());
  assert.equal(await page.locator('#scene-image-preview').getAttribute('src'), priorSceneURL);
  await sceneRequest.finish();
  await page.getByText('生成完成', { exact: true }).waitFor();
  await assertControls(page);
  assert.deepEqual(requests[6].body.scene, { mode: 'upload', image: sceneWebP.toString('base64') });
  await page.locator('#clear-scene').click();
  assert.equal(await page.locator('#scene-image-preview').getAttribute('src'), null);
  assert.equal(await page.locator('#result-image-wrap').isVisible(), false);
  assert.equal(await page.evaluate(url => window.__revokedObjectURLs.includes(url), priorSceneURL), true);

  // Hold an actual decode, then clear/switch/replace before allowing it to finish.
  for (const action of ['clear', 'original', 'replace']) {
    console.log(`Scene delayed decode: ${action}`);
    await page.locator('input[name="scene-mode"][value="upload"]').check();
    await page.evaluate(() => {
      const decode = window.createImageBitmap.bind(window);
      window.__sceneDecodeDone = false;
      window.createImageBitmap = async (...args) => {
        window.createImageBitmap = decode;
        const bitmap = await decode(...args);
        await new Promise(resolve => { window.__releaseSceneDecode = resolve; });
        window.__sceneDecodeDone = true;
        return bitmap;
      };
    });
    await page.locator('#scene-image').setInputFiles({ name: 'delayed.png', mimeType: 'image/png', buffer: fixture });
    await page.waitForFunction(() => typeof window.__releaseSceneDecode === 'function');
    let replacementURL = null;
    if (action === 'clear') await page.locator('#clear-scene').dispatchEvent('click');
    if (action === 'original') await page.locator('input[name="scene-mode"][value="original"]').check();
    if (action === 'replace') {
      await page.locator('#scene-image').setInputFiles({ name: 'new.webp', mimeType: 'image/webp', buffer: sceneWebP });
      await page.locator('#scene-image-preview-wrap').waitFor({ state: 'visible' });
      replacementURL = await page.locator('#scene-image-preview').getAttribute('src');
    }
    await page.evaluate(() => { window.__releaseSceneDecode(); delete window.__releaseSceneDecode; });
    await page.waitForFunction(() => window.__sceneDecodeDone);
    assert.equal(await page.locator('#scene-image-preview').getAttribute('src'), replacementURL, `late decode after ${action}`);
  }
  const switchedURL = await page.locator('#scene-image-preview').getAttribute('src');
  await page.locator('input[name="scene-mode"][value="original"]').check();
  assert.equal(await page.evaluate(url => window.__revokedObjectURLs.includes(url), switchedURL), true);
  const originalAgain = await controlledResponse(page, '**/api/tryon/couple', successResponse);
  await page.locator('#generate').click();
  await originalAgain.started;
  await originalAgain.finish();
  await page.getByText('生成完成', { exact: true }).waitFor();
  assert.deepEqual(requests[7].body.scene, { mode: 'original' }, 'original must omit stale image/venue fields');
  await page.locator('input[name="scene-mode"][value="upload"]').check();
  await page.locator('#scene-image').setInputFiles({ name: 'before-refresh.png', mimeType: 'image/png', buffer: fixture });
  await page.locator('#scene-image-preview-wrap').waitFor({ state: 'visible' });
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `scene overflow at ${width}`);
  }
  for (const path of ['/assets/wedding/private/intake.json', '/assets/wedding/venues/', '/.env']) assert.equal((await page.request.get(base + path)).status(), 404);
  console.log('Phase 6 inherited scene flow: real three-format decode, invalid files/dimensions, replacement, clear, mode switch, late decode, five-image payload, edit lock and URL release passed');

  const currentPhotoURL = await page.locator('#photo-preview').getAttribute('src');
  await page.getByRole('button', { name: '移除照片' }).click();
  await page.locator('#photo-preview-wrap').waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(url => window.__revokedObjectURLs.includes(url), currentPhotoURL), true, 'clearing photo must revoke its preview URL');

  assert.deepEqual(await page.evaluate(() => ({ token: localStorage.getItem('vowmirror-access-token'), keys: Object.keys(localStorage) })), { token: accessToken, keys: ['vowmirror-access-token'] });
  await page.reload();
  assert.equal(await page.locator('#photo-preview-wrap').isVisible(), false);
  assert.equal(await page.locator('#result-image-wrap').isVisible(), false);
  assert.equal(await page.locator('#scene-image-preview-wrap').isVisible(), false);
  assert.equal(await page.locator('input[name="scene-mode"]:checked').inputValue(), 'original');
  assert.deepEqual(await page.evaluate(() => Object.keys(localStorage)), ['vowmirror-access-token']);
  await page.locator('#save-token').uncheck();
  assert.deepEqual(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })), { local: 0, session: 0 });
  consoleObservation.assertNoSensitive({
    token: [accessToken],
    photo: [fixture.toString('base64')],
    scene: ['png', 'jpg', 'webp'].map(format => readFileSync(new URL(`../backend/internal/imagevalidate/testdata/checker.${format}`, import.meta.url)).toString('base64')),
    result: [JSON.parse(successResponse.body).data.image],
  });
  assert.deepEqual(pageErrors, []);
  const consoleErrors = consoleObservation.errors();
  assert.equal(consoleErrors.length, 1, 'only the explicit failed-generation probe may log a console error');
  assert.match(consoleErrors[0], /503 \(Service Unavailable\)/);
  assert.ok(requested.every(url => new URL(url).origin === new URL(base).origin), 'page must not contact external services');
  boundary.assertSafe();
  console.log(JSON.stringify({ stage, probe, widths: [375, 768, 1024, 1440], health: 'passed', catalog: { auth: '401/401/200', outfits: catalog.data.outfits.length, reload: 'exclusive operation' }, generation: { editing: 'locked', duplicateSubmission: 'single request', result: 'PNG preview and download', failure: 'manual retry only', cancellation: 'controlled late response ignored', timeout: '60 seconds; controlled late response ignored; manual retry passed', persistence: 'token only' }, pageErrors }));
} finally {
  await browser.close();
  boundary?.assertSafe();
}

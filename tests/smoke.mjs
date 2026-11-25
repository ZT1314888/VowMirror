import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { confirmGeneration, submitGeneration } from './generation-submit.mjs';
import { verifyAuthorizationFlow, verifyMobileForm } from './authorization-flow.mjs';
import { createRequire } from 'node:module';
import { armControlledCouple, blockUncontrolledGeneration, clickStep, controlledCaptures, installControlledCouple, observeConsole, releaseControlledCouple, waitControlledCoupleHit } from './browser-observations.mjs';
import { verifyResultLifecycle } from './result-lifecycle.mjs';
import { verifyInvitationFlow, waitForInvitationReady } from './invitation-flow.mjs';
import { verifyDockDrag, verifyDockSelectionPosition, verifyDockTouch, verifyDockWheel } from './dock-scroll.mjs';
import { verifyHeadroomBehavior, verifyHeadroomTouch } from './headroom-browser.mjs';

const require = createRequire('/opt/browser/package.json');
const { chromium } = require('playwright');
const stageIndex = process.argv.indexOf('--stage');
const stage = stageIndex >= 0 ? process.argv[stageIndex + 1] : '';
const probeIndex = process.argv.indexOf('--probe');
const probe = probeIndex >= 0 ? process.argv[probeIndex + 1] : 'all';
assert.ok(['all', 'catalog', 'generation'].includes(probe), 'unknown regression probe');
assert.ok(['phase6', 'phase7', 'phase8'].includes(stage), 'unknown acceptance stage');
const base = process.env.SMOKE_BASE_URL ?? 'http://web:8080';
const accessToken = process.env.TRYON_API_KEYS?.split(',').map(token => token.trim()).find(Boolean);
assert.ok(accessToken, 'Phase 6 smoke requires TRYON_API_KEYS in the browser tool container');

function eventStream(payload) {
  const requestId = payload.data.request_id;
  const status = { request_id: requestId, phase: 'reading_input', elapsed_ms: 2, duration_ms: 1 };
  return {
    status: 200,
    contentType: 'text/event-stream',
    body: `event: status\ndata: ${JSON.stringify(status)}\n\nevent: result\ndata: ${JSON.stringify(payload)}\n\n`,
  };
}

async function assertControls(page, operation = 'idle') {
  const busy = operation !== 'idle';
  assert.equal(await page.locator('#cancel-generation').isVisible(), operation === 'generation', `cancel button during ${operation}`);
  const dockButtons = page.locator('#floating-dock button[data-action]');
  const count = await dockButtons.count();
  assert.ok(count >= 2, 'dock renders its room controls');
  for (let i = 0; i < count; i++) assert.equal(await dockButtons.nth(i).isDisabled(), busy, `dock button ${i} during ${operation}`);
}

async function currentRoom(page) {
  return page.evaluate(() => [...document.querySelectorAll('.stepper-link')].findIndex(link => link.getAttribute('aria-current') === 'step'));
}

async function waitForCatalog(page) {
  await waitForInvitationReady(page);
  await page.waitForFunction(() => {
    const links = [...document.querySelectorAll('.stepper-link')];
    return links.length === 4 && links.every(link => !link.disabled);
  }, undefined, { timeout: 15_000 });
}

const browser = await chromium.launch({ headless: true });
let boundary;
try {
  const page = await browser.newPage({ acceptDownloads: true, serviceWorkers: 'block' });
  page.setDefaultTimeout(10_000);
  page.setDefaultNavigationTimeout(15_000);
  await page.clock.install();
  const pageErrors = [];
  const consoleObservation = observeConsole(page);
  boundary = await blockUncontrolledGeneration(page);
  const requested = [];
  await page.addInitScript(() => {
    window.__createdObjectURLs = [];
    window.__revokedObjectURLs = [];
    const create = URL.createObjectURL.bind(URL);
    URL.createObjectURL = value => { const url = create(value); window.__createdObjectURLs.push(url); return url; };
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = value => { window.__revokedObjectURLs.push(value); revoke(value); };
  });
  page.on('pageerror', error => pageErrors.push(error.message));
  await installControlledCouple(page);
  page.on('request', request => requested.push(request.url()));
  // 「上传场地照片」瓦片会打开文件选择器：全局即时消费，避免模态阻塞后续点击。
  page.on('filechooser', chooser => { chooser.setFiles([]).catch(() => {}); });
  console.log(JSON.stringify({ invitationFlow: await verifyInvitationFlow(page, base) }));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const response = await page.goto(base);
    assert.equal(response.status(), 200);
    if (width === 375) {
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'open-invitation', 'seal is keyboard reachable first');
      await page.keyboard.press('Enter');
    } else {
      await page.emulateMedia({ reducedMotion: width === 768 ? 'no-preference' : 'reduce' });
      await page.locator('#open-invitation').click();
    }
    await waitForCatalog(page);
    // dock 按文档顺序排在视口之后：首屏与任意展厅都必须落在视口下方，而不是页头下面。
    assert.equal(await page.evaluate(() => {
      const dock = document.querySelector('#floating-dock').getBoundingClientRect();
      const viewport = document.querySelector('#gallery-viewport').getBoundingClientRect();
      return dock.top >= viewport.bottom - 1 && dock.bottom <= innerHeight + 1 && dock.bottom > innerHeight / 2;
    }), true, `dock sits below the gallery viewport at ${width}`);
    if (process.env.SMOKE_EVIDENCE_DIR) {
      mkdirSync(process.env.SMOKE_EVIDENCE_DIR, { recursive: true });
      await page.screenshot({ path: `${process.env.SMOKE_EVIDENCE_DIR}/workspace-${width}.png`, fullPage: true });
    }
    boundary.assertSafe();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth
      && [...document.querySelectorAll('#floating-dock, .stepper-link, .wordmark')].every(element => element.getBoundingClientRect().right <= innerWidth + 1)), true, `overflow or clipped control at ${width}`);
    await page.emulateMedia({ reducedMotion: 'reduce' });
  }
  assert.deepEqual(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })), { local: 0, session: 0 });

  await verifyDockWheel(page);
  await verifyDockSelectionPosition(page);
  await verifyDockDrag(page);
  const touchPage = await browser.newPage({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true, reducedMotion: 'reduce' });
  const touchBoundary = await blockUncontrolledGeneration(touchPage);
  try {
    await touchPage.goto(base);
    await touchPage.locator('#open-invitation').tap();
    await waitForCatalog(touchPage);
    await verifyDockTouch(touchPage);
    touchBoundary.assertSafe();
  } finally {
    await touchPage.close();
  }
  // Reset the in-memory selection before validating required inputs.
  await page.reload();
  await page.locator('#open-invitation').click();
  await waitForCatalog(page);

  // 逐步校验：缺合照 → 上传 → 缺造型 → 键盘选造型。
  await clickStep(page, 2);
  await page.locator('#generate').click();
  await page.locator('#form-alert').getByText('请先在「01 合照」上传一张有效的合照。', { exact: true }).waitFor();
  assert.equal(await page.locator('#access-dialog').evaluate(dialog => dialog.open), false, 'invalid form must not open code dialog');
  // 点击序列收尾时浏览器会对被移除的触发控件清焦，焦点转移稍后一帧到位。
  await page.waitForFunction(() => document.activeElement?.id === 'room-photo-title');
  assert.equal(await currentRoom(page), 0);
  assert.equal(requested.filter(url => url.endsWith('/api/tryon/couple')).length, 0);

  const fixture = readFileSync(new URL('../backend/internal/imagevalidate/testdata/checker.png', import.meta.url));
  await page.locator('#couple-image').setInputFiles({ name: 'couple.png', mimeType: 'image/png', buffer: fixture });
  await page.waitForFunction(() => document.querySelector('#room-photo-content .hero-photo')?.src.startsWith('blob:'));
  const originalPhotoURL = await page.evaluate(() => document.querySelector('#room-photo-content .hero-photo').src);

  await clickStep(page, 2);
  await page.locator('#generate').click();
  await page.locator('#form-alert').getByText('请先在「02 造型」选择一套婚礼造型。', { exact: true }).waitFor();
  assert.equal(await currentRoom(page), 1);
  await page.locator('.dock-thumb-btn[data-arg="W001"]').click();
  assert.equal(await page.locator('.dock-thumb-btn[data-arg="W001"]').getAttribute('aria-pressed'), 'true');

  // 场景模式默认选中「保留原背景」：进入 03 场景展厅后检查瓦片初始态。
  await clickStep(page, 2);
  assert.equal(await page.locator('.dock-thumb-btn[data-arg="original"]').getAttribute('aria-pressed'), 'true', 'original scene mode is preselected');
  assert.equal(await page.locator('.dock-thumb-btn[data-arg="upload"]').getAttribute('aria-pressed'), 'false');

  const health = await page.request.get(base + '/api/health');
  assert.equal(health.status(), 200);
  assert.deepEqual(await health.json(), { code: 0, message: '', data: { status: 'ok' } });
  const catalogResponse = await page.request.get(base + '/api/catalog/outfits');
  assert.equal(catalogResponse.status(), 200);
  assert.equal(catalogResponse.headers()['cache-control'], 'no-store');
  const catalog = await catalogResponse.json();
  assert.deepEqual(Object.keys(catalog).sort(), ['code', 'data', 'message']);
  assert.deepEqual(Object.keys(catalog.data).sort(), ['outfits', 'venues', 'version']);
  assert.equal(catalog.data.venues.every(entry => Object.keys(entry).sort().join(',') === 'id,name'), true, 'venue directory exposes only id and name');
  assert.ok(catalog.data.venues.length > 0, 'desktop venue photos must not be dropped from the fixed venue directory');
  assert.equal(catalog.data.outfits.every(entry => Object.keys(entry).sort().join(',') === 'id,name'), true);

  // 无效生成码：真实后端拒绝，弹窗保持且不上传照片。
  await clickStep(page, 2);
  await page.locator('#generate').click();
  assert.equal(await page.locator('#access-dialog').evaluate(dialog => dialog.open), true);
  await page.locator('#access-token').fill('synthetic-invalid-generation-code');
  await page.locator('#confirm-access').click();
  await page.locator('#access-error').filter({ hasText: '生成码无效' }).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'access-token');
  assert.equal(requested.filter(url => url.endsWith('/api/tryon/couple')).length, 0, 'invalid code uploads no photos');
  await page.keyboard.press('Escape');
  await page.locator('#access-dialog').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#room-photo-content .hero-photo').count(), 1, 'closing code dialog preserves the gallery state');
  const authorizations = [];
  await page.route('**/api/tryon/authorize', async route => {
    const request = route.request();
    assert.equal(request.method(), 'POST');
    assert.equal(request.postData(), null, 'preflight has no image body');
    assert.equal(request.headers().authorization, `Bearer ${accessToken}`);
    authorizations.push(request.url());
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 0, message: '', data: { remaining: 5 } }) });
  });
  console.log(JSON.stringify({ authorizationFlow: await verifyAuthorizationFlow(page, accessToken) }));
  if (process.env.SMOKE_EVIDENCE_DIR) {
    for (const width of [375, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.screenshot({ path: `${process.env.SMOKE_EVIDENCE_DIR}/workspace-filled-${width}.png`, fullPage: true });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
  }
  let catalogRequests = 0;
  page.on('request', request => {
    if (request.url().endsWith('/api/catalog/outfits')) catalogRequests++;
  });
  const resultBase64 = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 1536; canvas.height = 1024;
    const context = canvas.getContext('2d');
    for (let y = 0; y < canvas.height; y += 64) {
      for (let x = 0; x < canvas.width; x += 64) {
        context.fillStyle = (x + y) % 128 === 0 ? '#829980' : '#e9ebe8';
        context.fillRect(x, y, 64, 64);
      }
    }
    return canvas.toDataURL('image/png').split(',')[1];
  });
  const successPayload = { code: 0, message: '', data: { image: resultBase64, mime_type: 'image/png', width: 1536, height: 1024, model: 'test-only', request_id: 'synthetic-generation' } };
  const successResponse = eventStream(successPayload);

  await armControlledCouple(page, successResponse);
  await page.locator('#generate').click();
  await confirmGeneration(page);
  await waitControlledCoupleHit(page);
  const catalogCount = catalogRequests;
  // 生成期间编辑锁：替换照片、目录读取与 dock 控件全部被锁。
  await page.locator('#couple-image').setInputFiles({ name: 'during-generation.png', mimeType: 'image/png', buffer: fixture });
  await assertControls(page, 'generation');
  assert.equal(await page.evaluate(() => document.querySelector('#room-photo-content .hero-photo').src), originalPhotoURL, 'replacement during generation must be ignored');
  assert.equal(await page.locator('#aperture-overlay').isVisible(), true, 'generation progress overlay is shown');
  assert.notEqual((await page.locator('#generation-status').textContent()).trim(), '');
  assert.equal(catalogRequests, catalogCount, 'generation must not trigger a catalog reload');
  assert.equal((await controlledCaptures(page)).length, 1);
  await releaseControlledCouple(page);
  await page.locator('#result-image').waitFor();
  await assertControls(page);
  assert.ok((await page.locator('#result-meta').textContent()).startsWith(`${catalog.data.outfits[0].name} · image/png · 可查看耗时 `));
  console.log('Generation edit-lock regression: passed');
  const firstCapture = (await controlledCaptures(page))[0];
  assert.deepEqual(Object.keys(firstCapture.body).sort(), ['couple_image', 'outfit_id', 'scene']);
  assert.deepEqual(firstCapture.body.scene, { mode: 'original' });
  assert.equal(firstCapture.body.couple_image, fixture.toString('base64'), 'uploaded photo bytes remain unchanged');
  assert.equal(firstCapture.authorization, `Bearer ${accessToken}`);
  assert.equal(await page.locator('#download-result').getAttribute('download'), 'vowmirror-wedding.png');
  const firstResultURL = await page.locator('#result-image').getAttribute('src');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: '下载成片' }).click();
  const download = await downloadPromise;
  assert.equal(download.suggestedFilename(), 'vowmirror-wedding.png');
  const downloadedChunks = [];
  for await (const chunk of await download.createReadStream()) downloadedChunks.push(chunk);
  assert.equal(Buffer.concat(downloadedChunks).toString('base64'), resultBase64, 'download preserves the result bytes');

  // 对比滑块：键盘微调更新裁切比例。
  await page.locator('#reveal-compare-stage').focus();
  await page.keyboard.press('ArrowLeft');
  assert.equal(await page.locator('#reveal-compare-stage').getAttribute('aria-valuenow'), '47');
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('#reveal-compare-stage').getAttribute('aria-valuenow'), '50');

  // 替换合照：旧照片与旧结果的对象 URL 必须释放，结果回到空态。
  await clickStep(page, 0);
  await page.locator('#couple-image').setInputFiles({ name: 'replacement.png', mimeType: 'image/png', buffer: fixture });
  await page.waitForFunction(previous => document.querySelector('#room-photo-content .hero-photo')?.src !== previous, originalPhotoURL);
  assert.equal(await page.locator('#result-image').count(), 0, 'replacement must clear the stale result');
  assert.equal(await page.evaluate(url => window.__revokedObjectURLs.includes(url), originalPhotoURL), true, 'replacement must revoke the old photo URL');
  assert.equal(await page.evaluate(url => window.__revokedObjectURLs.includes(url), firstResultURL), true, 'replacement must revoke the old result URL');

  await armControlledCouple(page, { status: 503, contentType: 'application/json', body: JSON.stringify({ code: 50301, message: 'unavailable', data: { error_code: 'MODEL_CONFIGURATION_INVALID' } }) });
  await submitGeneration(page);
  await waitControlledCoupleHit(page);
  await releaseControlledCouple(page);
  await page.locator('#form-alert').getByText('服务器资源紧张，请稍后再试', { exact: true }).waitFor();
  await assertControls(page);
  assert.equal((await controlledCaptures(page)).length, 2, 'failed request must not retry automatically');
  await armControlledCouple(page, successResponse);
  await submitGeneration(page);
  await waitControlledCoupleHit(page);
  await releaseControlledCouple(page);
  await page.locator('#result-image').waitFor();
  await assertControls(page);
  assert.equal((await controlledCaptures(page)).length, 3, 'manual retry must issue a new request');

  await armControlledCouple(page, successResponse);
  await submitGeneration(page);
  await waitControlledCoupleHit(page);
  await assertControls(page, 'generation');
  await page.evaluate(() => {
    document.querySelector('#cancel-generation').click();
    if (!document.querySelector('#floating-dock [data-action="generate"]').disabled) throw new Error('cancel must wait for the current request to exit');
  });
  await page.locator('#form-alert').getByText('生成已取消。你可以手动重试。', { exact: true }).waitFor();
  await releaseControlledCouple(page);
  await page.waitForFunction(() => window.__controlledCouple.settled === 4);
  await assertControls(page);
  assert.equal(await page.locator('#result-image').count(), 0, 'late canceled response must not replace the failure state');
  assert.equal(await page.locator('#result-status').textContent(), '生成已取消。你可以手动重试。');
  assert.equal(await page.locator('#download-result').count(), 0);
  assert.equal((await controlledCaptures(page)).length, 4, 'cancel must not automatically retry');

  await armControlledCouple(page, successResponse);
  await submitGeneration(page);
  await waitControlledCoupleHit(page);
  await page.clock.fastForward(90_001);
  await page.locator('#form-alert').getByText('生成超过 90 秒，已停止请求。你可以手动重试。', { exact: true }).waitFor();
  await releaseControlledCouple(page);
  await page.waitForFunction(() => window.__controlledCouple.settled === 5);
  await assertControls(page);
  assert.equal(await page.locator('#result-status').textContent(), '生成超过 90 秒，已停止请求。你可以手动重试。');
  assert.equal(await page.locator('#result-image').count(), 0, 'late timeout response must not show a result');
  assert.equal(await page.locator('#download-result').count(), 0);
  assert.equal((await controlledCaptures(page)).length, 5);
  await armControlledCouple(page, successResponse);
  await submitGeneration(page);
  await waitControlledCoupleHit(page);
  await releaseControlledCouple(page);
  await page.locator('#result-image').waitFor();
  await assertControls(page);
  assert.equal((await controlledCaptures(page)).length, 6, 'timeout permits an explicit manual retry');
  console.log('Cancellation, timeout and manual retry: passed');

  // 场景校验使用真实 Chromium 解码器，不依赖模型或私人照片。
  // 点击「上传场地照片」瓦片但不选文件：upload 模式下无有效场地图必须被校验拦截。
  await clickStep(page, 2);
  await page.waitForFunction(() => document.querySelector('.dock-thumb-btn[data-arg="upload"]') !== null);
  await page.locator('.dock-thumb-btn[data-arg="upload"]').click();
  await page.waitForFunction(() => document.querySelector('.dock-thumb-btn[data-arg="upload"]')?.getAttribute('aria-pressed') === 'true');
  await page.locator('#generate').click();
  await page.locator('#form-alert').getByText('请上传一张有效的场地照片，或切换为保留原背景。', { exact: true }).waitFor();
  assert.equal((await controlledCaptures(page)).length, 6);
  for (const invalid of [
    { name: 'empty.png', mimeType: 'image/png', buffer: Buffer.alloc(0), error: '图片为空' },
    { name: 'fake.png', mimeType: 'image/png', buffer: Buffer.from('not an image'), error: '不支持的图片格式' },
    { name: 'mismatch.jpg', mimeType: 'image/jpeg', buffer: fixture, error: '图片声明与真实格式不一致' },
    { name: 'truncated.png', mimeType: 'image/png', buffer: fixture.subarray(0, 40), error: '图片无法解码' },
    { name: 'oversize.png', mimeType: 'image/png', buffer: Buffer.alloc(8 * 1024 * 1024 + 1), error: '图片超过 8 MiB' },
  ]) {
    await page.locator('#scene-image').setInputFiles(invalid);
    await page.locator('#form-alert').filter({ hasText: invalid.error }).waitFor();
    await clickStep(page, 2);
    await page.locator('#generate').click();
    assert.equal((await controlledCaptures(page)).length, 6, `${invalid.name} must never generate`);
  }
  for (const [width, height] of [[255,256],[8193,256],[4001,5000]]) {
    const bytes = await page.evaluate(async ([width, height]) => {
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      return [...new Uint8Array(await blob.arrayBuffer())];
    }, [width, height]);
    await page.locator('#scene-image').setInputFiles({ name: 'dimensions.png', mimeType: 'image/png', buffer: Buffer.from(bytes) });
    await page.locator('#form-alert').filter({ hasText: '256–8192' }).waitFor();
  }
  console.log('Scene invalid files and dimensions: passed');
  let priorSceneURL = null;
  for (const [format, mimeType] of [['png', 'image/png'], ['jpg', 'image/jpeg'], ['webp', 'image/webp']]) {
    const buffer = readFileSync(new URL(`../backend/internal/imagevalidate/testdata/checker.${format}`, import.meta.url));
    await page.locator('#scene-image').setInputFiles({ name: `scene.${format}`, mimeType, buffer });
    await page.waitForFunction(previous => {
      const src = document.querySelector('#room-scene .is-front img')?.src || '';
      return src.startsWith('blob:') && src !== previous;
    }, priorSceneURL);
    const current = await page.evaluate(() => document.querySelector('#room-scene .is-front img').src);
    if (priorSceneURL) assert.equal(await page.evaluate(url => window.__revokedObjectURLs.includes(url), priorSceneURL), true);
    assert.notEqual(current, priorSceneURL);
    priorSceneURL = current;
  }
  const sceneWebP = readFileSync(new URL('../backend/internal/imagevalidate/testdata/checker.webp', import.meta.url));
  console.log('Scene real three-format decoding and replacement: passed');
  await armControlledCouple(page, successResponse);
  await clickStep(page, 2);
  await page.locator('#generate').click();
  await confirmGeneration(page);
  await waitControlledCoupleHit(page);
  await assertControls(page, 'generation');
  // 生成中场景瓦片被锁定：点击不会改动当前大图。
  await page.locator('.dock-thumb-btn[data-arg="original"]').click({ force: true }).catch(() => {});
  assert.equal(await page.evaluate(() => document.querySelector('#room-scene .is-front img').src), priorSceneURL);
  await releaseControlledCouple(page);
  await page.locator('#result-image').waitFor();
  await assertControls(page);
  assert.deepEqual((await controlledCaptures(page))[6].body.scene, { mode: 'upload', image: sceneWebP.toString('base64') });
  await clickStep(page, 2);
  await page.locator('.dock-thumb-btn[data-arg="original"]').click();
  await page.waitForFunction(url => document.querySelector('#room-scene .is-front img')?.src !== url, priorSceneURL, { timeout: 5_000 });
  assert.equal(await page.evaluate(url => window.__revokedObjectURLs.includes(url), priorSceneURL), true);

  // Hold an actual decode, then switch/replace before allowing it to finish.
  for (const action of ['original', 'replace']) {
    console.log(`Scene delayed decode: ${action}`);
    const heroBefore = await page.evaluate(() => document.querySelector('#room-scene .is-front img')?.src ?? null);
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
    if (action === 'original') {
      await page.locator('.dock-thumb-btn[data-arg="original"]').click();
      replacementURL = heroBefore; // 迟到场景图被丢弃，大图保持合照。
    }
    if (action === 'replace') {
      await page.locator('#scene-image').setInputFiles({ name: 'new.webp', mimeType: 'image/webp', buffer: sceneWebP });
      await page.waitForFunction(() => document.querySelector('#room-scene .is-front img')?.src.startsWith('blob:'));
      replacementURL = await page.evaluate(() => document.querySelector('#room-scene .is-front img').src);
    }
    await page.evaluate(() => { window.__releaseSceneDecode(); delete window.__releaseSceneDecode; });
    await page.waitForFunction(() => window.__sceneDecodeDone);
    assert.equal(await page.evaluate(() => document.querySelector('#room-scene .is-front img')?.src ?? null), replacementURL, `late decode after ${action}`);
  }
  const switchedURL = await page.evaluate(() => document.querySelector('#room-scene .is-front img')?.src ?? null);
  await page.locator('.dock-thumb-btn[data-arg="original"]').click();
  assert.equal(await page.evaluate(url => window.__revokedObjectURLs.includes(url), switchedURL), true);
  await armControlledCouple(page, successResponse);
  await clickStep(page, 2);
  await page.locator('#generate').click();
  await confirmGeneration(page);
  await waitControlledCoupleHit(page);
  await releaseControlledCouple(page);
  await page.locator('#result-image').waitFor();
  assert.deepEqual((await controlledCaptures(page))[7].body.scene, { mode: 'original' }, 'original must omit stale image/venue fields');
  if (stage !== 'phase6') console.log(JSON.stringify({ resultLifecycle: await verifyResultLifecycle(page, successResponse) }));
  if (stage === 'phase8') {
    // 顶栏自动隐藏：同一 page 复用 clock 与受控请求环境。
    const evidence = process.env.SMOKE_EVIDENCE_DIR;
    console.log(JSON.stringify({ headroom: await verifyHeadroomBehavior(page, evidence) }));
    console.log(JSON.stringify({ headroomTouch: await verifyHeadroomTouch(base, evidence) }));
  }
  await page.locator('#scene-image').setInputFiles({ name: 'before-refresh.png', mimeType: 'image/png', buffer: fixture });
  await page.waitForFunction(() => document.querySelector('#room-scene .is-front img')?.src.startsWith('blob:'));
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `scene overflow at ${width}`);
  }
  for (const path of ['/assets/wedding/private/intake.json', '/assets/wedding/venues/V001/scene.jpg', '/assets/wedding/poses/P007.png', '/assets/wedding/manifest.json', '/assets/wedding/venues/', '/web/public/venues/', '/web/public/venues/V000.webp', '/web/public/venues/V008.webp', '/web/public/venues/V001.png', '/.env']) assert.equal((await page.request.get(base + path)).status(), 404);
  // 桌面场地图接入后，场景厅显示场馆缩略图，选中后主图解码并切换为场馆展示图；样例合照仍用于换回原背景。
  assert.equal(catalog.data.venues.length, 7, 'desktop venue photos are registered as fixed venues');
  assert.ok(catalog.data.venues.every(entry => Object.keys(entry).sort().join(',') === 'id,name'), 'venue directory exposes only id and name');
  for (const venue of catalog.data.venues) {
    assert.equal((await page.request.get(`${base}/web/public/venues/${venue.id}-thumb.webp`)).status(), 200, `${venue.id} thumbnail is served`);
    assert.equal((await page.request.get(`${base}/web/public/venues/${venue.id}.webp`)).status(), 200, `${venue.id} display image is served`);
  }
  await clickStep(page, 2);
  assert.equal(catalog.data.venues.length, await page.locator('.dock-thumb-btn[data-action="select-venue"]').count(), 'every venue has a dock tile');
  const firstVenue = catalog.data.venues[0].id;
  // Venue display images keep each original aspect ratio; the expected size comes from web/public/manifest.json.
  const webManifest = JSON.parse(readFileSync(new URL('../web/public/manifest.json', import.meta.url), 'utf8'));
  const expectedVenueSize = id => {
    const entry = webManifest.venuePreviews.find(item => item.id === id);
    assert.ok(entry, `web manifest must list ${id}`);
    return [entry.display.width, entry.display.height];
  };
  const venueTileImg = page.locator(`.dock-thumb-btn[data-action="select-venue"][data-arg="${firstVenue}"] img.outfit-thumbnail`);
  assert.equal(await venueTileImg.getAttribute('src'), `/web/public/venues/${firstVenue}-thumb.webp`);
  await page.waitForFunction(id => {
    const img = document.querySelector(`.dock-thumb-btn[data-action="select-venue"][data-arg="${id}"] img.outfit-thumbnail`);
    return img?.complete && img.naturalWidth === 320 && img.naturalHeight === 240;
  }, firstVenue);
  await page.locator(`.dock-thumb-btn[data-action="select-venue"][data-arg="${firstVenue}"]`).click();
  await page.waitForFunction(({ id, width, height }) => {
    const img = document.querySelector('#room-scene .is-front img');
    return img?.dataset.venueId === id && img.complete && img.naturalWidth === width && img.naturalHeight === height;
  }, { id: firstVenue, width: expectedVenueSize(firstVenue)[0], height: expectedVenueSize(firstVenue)[1] });
  assert.equal(await page.locator('#room-scene .is-front img').evaluate(img => getComputedStyle(img).objectFit), 'contain');
  assert.equal(await page.locator('#scene-preview-label').isHidden(), true);
  assert.equal(await page.locator('#scene-preview-status').textContent(), '');
  assert.equal(await page.locator(`.dock-thumb-btn[data-action="select-venue"][data-arg="${firstVenue}"]`).getAttribute('aria-pressed'), 'true');
  await page.locator('.dock-thumb-btn[data-action="set-scene-mode"][data-arg="original"]').click();
  await page.waitForFunction(() => {
    const img = document.querySelector('#room-scene .is-front img');
    const coupleSrc = document.querySelector('#room-photo-content .hero-photo')?.getAttribute('src');
    return coupleSrc && img?.getAttribute('src') === coupleSrc && img.complete && img.naturalWidth > 0;
  });
  assert.equal(await page.locator('#room-scene .is-front img').evaluate(img => getComputedStyle(img).objectFit), 'contain');
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `venue dock overflow at ${width}`);
  }
  console.log('Fixed venue flow: desktop photos registered, thumbnails and display images served, original mode restores without persistence');
  console.log('Phase 6 inherited scene flow: real three-format decode, invalid files/dimensions, replacement, clear, mode switch, late decode, five-image payload, edit lock and URL release passed');

  assert.deepEqual(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })), { local: 0, session: 0 });
  await page.reload();
  await page.locator('#open-invitation').click();
  await waitForCatalog(page);
  await clickStep(page, 2);
  assert.equal(await page.locator('#room-photo-content .hero-photo').count(), 0);
  assert.equal(await page.locator('#result-image').count(), 0);
  assert.equal(await page.locator('#room-scene .is-front img').getAttribute('src'), '/web/public/wedding-example.jpg', 'scene hero resets to the sample photo without persistence');
  assert.equal(await page.locator('.dock-thumb-btn[data-arg="original"]').getAttribute('aria-pressed'), 'true', 'scene mode resets to the default original without persistence');
  assert.deepEqual(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })), { local: 0, session: 0 });
  assert.equal(await page.locator('#access-token').inputValue(), '');
  assert.equal(await page.locator('#open-access, #save-token').count(), 0);
  console.log(JSON.stringify({ mobileForm: await verifyMobileForm(page, fixture) }));
  consoleObservation.assertNoSensitive({
    token: [accessToken],
    photo: [fixture.toString('base64')],
    scene: ['png', 'jpg', 'webp'].map(format => readFileSync(new URL(`../backend/internal/imagevalidate/testdata/checker.${format}`, import.meta.url)).toString('base64')),
    result: [successPayload.data.image],
  });
  assert.deepEqual(pageErrors, []);
  const consoleErrors = consoleObservation.errors();
  assert.equal(consoleErrors.length, 1, 'only the invalid-code probe may log a console error');
  assert.match(consoleErrors[0], /401 \(Unauthorized\)/);
  assert.ok(requested.every(url => new URL(url).origin === new URL(base).origin), 'page must not contact external services');
  boundary.assertSafe();
  console.log(JSON.stringify({ stage, probe, widths: [375, 768, 1024, 1440], health: 'passed', catalog: { access: 'public; restricted fields', outfits: catalog.data.outfits.length, reload: 'exclusive operation' }, invitation: { keyboard: 'Enter', reducedMotion: 'passed', codeSharing: 'removed' }, gallery: { rooms: 4, dock: 'per-room controls', particleTransition: 'reduced-motion fallback verified' }, generation: { accessPrompt: 'confirmed on generate-final click before any request', editing: 'locked', duplicateSubmission: 'single request', result: 'PNG compare view and download', failure: 'manual retry only', cancellation: 'controlled late response ignored', timeout: '90 seconds; controlled late response ignored; manual retry passed', persistence: 'none' }, pageErrors }));
} finally {
  await browser.close();
  boundary?.assertSafe();
}

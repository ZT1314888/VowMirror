import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { serveSource } from './source-server.mjs';
import { waitForInvitationReady } from './invitation-flow.mjs';
import { armControlledCouple, blockUncontrolledGeneration, controlledCaptures, installControlledCouple, releaseControlledCouple, waitControlledCoupleHit, waitForGalleryRoom } from './browser-observations.mjs';
import { submitGeneration } from './generation-submit.mjs';
import { verifyResultLifecycle } from './result-lifecycle.mjs';

const { chromium } = createRequire('/opt/browser/package.json')('playwright');
const viewports = [[375, 812], [768, 900], [1440, 900], [1920, 1080], [812, 375]];
const specs = [[768, 512, 'png'], [512, 768, 'jpeg'], [512, 512, 'webp'], [8192, 256, 'png'], [256, 8192, 'webp']];
const markerColors = [[232, 34, 45], [23, 182, 72], [35, 78, 232], [242, 192, 24]];
const probe = process.argv.includes('--generation-only') ? 'generation' : 'all';

// Serve current source for behavior checks before building the production image.
// All API responses are explicit fixtures; any generation that escapes interception fails.
const sourceServer = () => serveSource({
  api: path => path === '/api/health' ? { status: 'ok' }
    : path === '/api/catalog/outfits' ? { version: 1, outfits: [{ id: 'W001', name: '经典婚礼' }, { id: 'W002', name: '简约婚礼' }], venues: [] }
      : path === '/api/tryon/authorize' ? { remaining: 5 } : null,
});

async function fixture(page, [width, height, format]) {
  const bytes = await page.evaluate(async ({ width, height, format, colors }) => {
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#e1d3ba'; ctx.fillRect(0, 0, width, height);
    const positions = [[0, 0], [2 / 3, 0], [0, 2 / 3], [2 / 3, 2 / 3]];
    positions.forEach(([x, y], index) => {
      ctx.fillStyle = `rgb(${colors[index]})`;
      ctx.fillRect(x * width, y * height, width / 3, height / 3);
    });
    const blob = await new Promise(resolve => canvas.toBlob(resolve, `image/${format}`, .98));
    if (!blob || blob.type !== `image/${format}`) throw new Error('Fixture encoding failed');
    const probe = await createImageBitmap(blob);
    if (probe.width !== width || probe.height !== height) throw new Error('Fixture dimensions changed');
    probe.close();
    return [...new Uint8Array(await blob.arrayBuffer())];
  }, { width, height, format, colors: markerColors });
  return { name: `corners-${width}x${height}.${format}`, mimeType: `image/${format}`, buffer: Buffer.from(bytes) };
}

async function imageGeometry(page, selector) {
  await page.waitForFunction(({ selector, size }) => {
    const img = document.querySelector(selector);
    const room = img?.closest('.gallery-room');
    return innerWidth === size.width && innerHeight === size.height && Math.abs(room?.getBoundingClientRect().width - size.width) < 1;
  }, { selector, size: page.viewportSize() });
  await waitForGalleryRoom(page, selector);
  await page.waitForFunction(selector => {
    const img = document.querySelector(selector);
    return img?.complete && img.naturalWidth > 0;
  }, selector);
  const geometry = await page.locator(selector).evaluate(img => {
    const rect = element => {
      const r = element.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
    };
    const box = rect(img);
    const scale = Math.min(box.width / img.naturalWidth, box.height / img.naturalHeight);
    const width = img.naturalWidth * scale, height = img.naturalHeight * scale;
    const painted = { x: box.x + (box.width - width) / 2, y: box.y + (box.height - height) / 2, width, height };
    const room = img.closest('.gallery-room');
    const obstacles = [...document.querySelectorAll('.gallery-header, #floating-dock'), ...room.querySelectorAll('.result-caption, .result-details, .scene-reference:not([hidden])')].map(rect);
    const bg = [...document.querySelectorAll('.ambient-img')].find(element => element.style.opacity === '1');
    return { box, painted, obstacles, viewport: rect(document.querySelector('#gallery-viewport')), fit: getComputedStyle(img).objectFit,
      natural: [img.naturalWidth, img.naturalHeight], background: { ...rect(bg), fit: getComputedStyle(bg).objectFit },
      transforms: [img, img.parentElement].map(element => getComputedStyle(element).transform) };
  });
  const { painted: p, viewport: v, box, background: bg } = geometry;
  if (selector.includes('room-outfit')) {
    assert.equal(geometry.fit, 'cover');
    const size = page.viewportSize();
    // The shared gallery column includes spacing below the header. The preview must
    // fill the actual viewport, which is also the geometry used by the other rooms.
    const headerBottom = await page.locator('.gallery-header').evaluate(el => el.getBoundingClientRect().bottom);
    assert.ok(v.y >= headerBottom && v.bottom <= size.height + 1, JSON.stringify({ viewport: v, headerBottom, size }));
    assert.ok(Math.abs(box.x - v.x) < 1 && Math.abs(box.y - v.y) < 1, JSON.stringify({ box, viewport: v }));
    assert.ok(Math.abs(box.width - v.width) < 1 && Math.abs(box.height - v.height) < 1, JSON.stringify({ box, viewport: v }));
    assert.deepEqual(geometry.natural, [2400, 1040]);
    assert.deepEqual(geometry.transforms, ['none', 'none']);
    return;
  }
  assert.equal(geometry.fit, 'contain');
  assert.ok(p.width > 0 && p.height > 0);
  assert.ok(Math.abs(p.width / p.height - geometry.natural[0] / geometry.natural[1]) < .001);
  assert.ok(Math.abs(p.width - box.width) < 1 || Math.abs(p.height - box.height) < 1, 'use the largest fitting size');
  assert.ok(p.x >= v.x - 1 && p.y >= v.y - 1 && p.x + p.width <= v.right + 1 && p.y + p.height <= v.bottom + 1, JSON.stringify(geometry));
  for (const o of geometry.obstacles) {
    assert.ok(p.x + p.width <= o.x + 1 || p.x >= o.right - 1 || p.y + p.height <= o.y + 1 || p.y >= o.bottom - 1, `photo overlaps controls: ${JSON.stringify(geometry)}`);
  }
  assert.equal(bg.fit, 'cover');
  const size = page.viewportSize();
  assert.ok(bg.x <= 0 && bg.y <= 0 && bg.right >= size.width && bg.bottom >= size.height);
  assert.deepEqual(geometry.transforms, ['none', 'none']);
  return p;
}

async function assertVisibleCorners(page, painted) {
  await page.waitForFunction(() => [...document.querySelectorAll('.gallery-room:not([inert]) .is-front')]
    .every(element => Number(getComputedStyle(element).opacity) === 1));
  const clip = { x: Math.floor(painted.x), y: Math.floor(painted.y), width: Math.ceil(painted.width + 1), height: Math.ceil(painted.height + 1) };
  const screenshot = await page.screenshot({ animations: 'disabled', clip });
  const samples = await page.evaluate(async ({ encoded, painted: p, clip }) => {
    const blob = new Blob([Uint8Array.from(atob(encoded), char => char.charCodeAt(0))], { type: 'image/png' });
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0); bitmap.close();
    const scale = canvas.width / clip.width;
    return [[.2, .2], [.8, .2], [.2, .8], [.8, .8]].map(([x, y]) =>
      [...ctx.getImageData(Math.floor((p.x - clip.x + p.width * x) * scale), Math.floor((p.y - clip.y + p.height * y) * scale), 1, 1).data].slice(0, 3));
  }, { encoded: screenshot.toString('base64'), painted, clip });
  // At the legal 1:32 ratio the short edge can be five CSS pixels. Chromium
  // antialiases those edge pixels; colors must still identify each unique corner.
  const tolerance = Math.min(painted.width, painted.height) < 8 ? 48 : 24;
  samples.forEach((color, index) => color.forEach((channel, channelIndex) =>
    assert.ok(Math.abs(channel - markerColors[index][channelIndex]) < tolerance, `corner ${index} obscured: ${color}; ${JSON.stringify({ painted, viewport: page.viewportSize() })}`)));
}

async function selectFile(page, input, file, hero) {
  const previous = await page.locator(hero).count() ? await page.locator(hero).getAttribute('src') : null;
  await page.locator(input).setInputFiles(file);
  await page.waitForFunction(({ selector, previous }) => {
    const img = document.querySelector(selector);
    return img?.src.startsWith('blob:') && img.src !== previous && img.complete && img.naturalWidth;
  }, { selector: hero, previous });
}

const fixtureServer = process.env.SMOKE_BASE_URL ? null : await sourceServer();
const base = fixtureServer ? fixtureServer.base : process.env.SMOKE_BASE_URL;
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 3, hasTouch: true, serviceWorkers: 'block', acceptDownloads: true });
  page.setDefaultTimeout(10_000);
  // Install before application timers start so elapsed time and rendering use
  // the same clock throughout layout and generation checks.
  await page.clock.install();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const boundary = await blockUncontrolledGeneration(page);
  await installControlledCouple(page);
  await page.addInitScript(() => {
    window.__createdObjectURLs = []; window.__revokedObjectURLs = [];
    for (const method of ['createObjectURL', 'revokeObjectURL']) {
      const original = URL[method].bind(URL);
      URL[method] = value => {
        const result = original(value);
        window[method === 'createObjectURL' ? '__createdObjectURLs' : '__revokedObjectURLs'].push(method === 'createObjectURL' ? result : value);
        return result;
      };
    }
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal((await page.goto(base)).status(), 200);
  await page.locator('#open-invitation').click();
  await waitForInvitationReady(page);
  await page.waitForFunction(() => [...document.querySelectorAll('.stepper-link')].length === 4 && !document.querySelector('.stepper-link').disabled);
  const fixtures = [];
  for (const spec of specs) fixtures.push(await fixture(page, spec));
  let checks = 0;
  for (const file of probe === 'all' ? fixtures : []) {
    await page.locator('.stepper-link').nth(0).click();
    await selectFile(page, '#couple-image', file, '#room-photo-content .hero-photo');
    await page.locator('#photo-scan-beam').evaluate(element => element.classList.remove('is-scanning'));
    for (const room of [0, 2]) {
      await page.locator('.stepper-link').nth(room).click();
      const selector = room === 0 ? '#room-photo-content .hero-photo' : '#room-scene .is-front .hero-photo';
      for (const [width, height] of viewports) {
        await page.setViewportSize({ width, height });
        const painted = await imageGeometry(page, selector);
        await assertVisibleCorners(page, painted);
        checks++;
      }
    }
    // Upload the same fixture as a scene reference and resize without uploading again.
    await selectFile(page, '#scene-image', file, '#room-scene .is-front .hero-photo');
    assert.equal(await page.locator('#scene-reference').isVisible(), true);
    for (const [width, height] of viewports) {
      await page.setViewportSize({ width, height });
      await assertVisibleCorners(page, await imageGeometry(page, '#room-scene .is-front .hero-photo'));
      checks++;
    }
    await page.locator('[data-action="set-scene-mode"][data-arg="original"]').click();
  }
  if (checks) console.log(JSON.stringify({ galleryFit: 'passed', checks, formats: ['PNG', 'JPEG', 'WebP'], viewports, specs }));

  // Check the particle renderer's real draw destination and intermediate transforms.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('.stepper-link').nth(0).click();
  await selectFile(page, '#couple-image', fixtures[1], '#room-photo-content .hero-photo');
  await page.locator('.stepper-link').nth(1).click();
  await page.locator('[data-action="select-outfit"]').first().click();
  const waitForSelectedOutfit = async () => {
    // The example preview is shown before any outfit is chosen; wait for the press to land.
    const active = page.locator('.dock-thumb-btn.is-active');
    await active.waitFor({ state: 'attached' });
    const id = await active.getAttribute('data-arg');
    await page.waitForFunction(id => document.querySelector('#room-outfit .is-front img')?.dataset.outfitId === id, id);
  };
  await waitForSelectedOutfit();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(() => {
    window.__particleDraws = [];
    const draw = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (...args) {
      if (this.canvas.classList.contains('particle-canvas')) {
        const style = getComputedStyle(args[0]);
        window.__particleDraws.push({ canvas: [this.canvas.width, this.canvas.height], natural: [args[0].naturalWidth, args[0].naturalHeight], destination: args.slice(1), fit: style.objectFit, focus: style.objectPosition.split(' ').map(value => parseFloat(value) / 100) });
      }
      return draw.apply(this, args);
    };
  });
  await page.locator('[data-action="select-outfit"]').nth(1).click();
  await waitForSelectedOutfit();
  await page.waitForFunction(() => window.__particleDraws.length > 0);
  const draws = await page.evaluate(() => window.__particleDraws);
  for (const { canvas: [w, h], natural: [sw, sh], destination: [x, y, dw, dh], fit, focus: [fx, fy] } of draws) {
    const scale = (fit === 'cover' ? Math.max : Math.min)(w / sw, h / sh);
    assert.deepEqual([x, y, dw, dh], [(w - sw * scale) * fx, (h - sh * scale) * fy, sw * scale, sh * scale]);
  }

  // 布局更新（参考行、dock 提示）与图片提交同帧发生：粒子必须在布局稳定后按最终
  // 画框取样并持续绘制；连续快速选择只保留最后一次效果；减少动态不绘制。
  // 用累计绘制次数判断，避免受单帧采样时机影响。
  const particleCounters = () => page.evaluate(() => {
    const canvas = document.querySelector('#scene-particle-canvas');
    const outfit = document.querySelector('#outfit-particle-canvas');
    const frame = element => {
      const rect = element.parentElement.getBoundingClientRect();
      return { width: rect.width, height: rect.height, canvas: [element.width, element.height] };
    };
    return {
      scene: { fills: window.__particleFills['scene-particle-canvas'] ?? 0, draws: (window.__particleDrawsAt['scene-particle-canvas'] ?? []).length, frame: frame(canvas) },
      outfit: { fills: window.__particleFills['outfit-particle-canvas'] ?? 0, draws: (window.__particleDrawsAt['outfit-particle-canvas'] ?? []).length, frame: frame(outfit) },
      samples: window.__particleSamples,
    };
  });
  await page.evaluate(() => {
    window.__particleFills = {};
    window.__particleSamples = {};
    window.__particleDrawsAt = {};
    const fill = CanvasRenderingContext2D.prototype.fillRect;
    CanvasRenderingContext2D.prototype.fillRect = function (...args) {
      if (this.canvas.classList.contains('particle-canvas')) window.__particleFills[this.canvas.id] = (window.__particleFills[this.canvas.id] ?? 0) + 1;
      return fill.apply(this, args);
    };
    const draw = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (...args) {
      if (this.canvas.classList.contains('particle-canvas')) {
        const id = this.canvas.id;
        const frame = this.canvas.parentElement.getBoundingClientRect();
        (window.__particleDrawsAt[id] ??= []).push({ canvas: [this.canvas.width, this.canvas.height], frame: [frame.width, frame.height], natural: [args[0].naturalWidth, args[0].naturalHeight] });
        window.__particleSamples[id] = { canvas: [this.canvas.width, this.canvas.height], frame: [frame.width, frame.height] };
      }
      return draw.apply(this, args);
    };
  });

  await page.locator('.stepper-link').nth(2).click();
  assert.equal(await page.locator('#scene-reference').isVisible(), false, 'no reference row before a scene photo exists');
  await selectFile(page, '#scene-image', fixtures[3], '#room-scene .is-front .hero-photo');
  assert.equal(await page.locator('#scene-reference').isVisible(), true, 'reference row joins the same layout update as the photo');
  const sustained = (id, before = 0) => page.waitForFunction(
    ({ id, threshold }) => (window.__particleFills[id] ?? 0) - threshold >= 24,
    { id, threshold: before }, { timeout: 3000 });
  await sustained('scene-particle-canvas');
  const upload = await particleCounters();
  // 取样画布必须对应最终画框（参考行出现后的高度）。
  const dpr = Math.min(await page.evaluate(() => devicePixelRatio), 2);
  assert.ok(Math.abs(upload.scene.frame.canvas[0] - Math.round(upload.scene.frame.width * dpr)) <= 1
    && Math.abs(upload.scene.frame.canvas[1] - Math.round(upload.scene.frame.height * dpr)) <= 1, `sampled at the settled frame: ${JSON.stringify(upload)}`);
  assert.ok(upload.samples['scene-particle-canvas'].frame.every((value, index) => Math.abs(value - upload.scene.frame[index === 0 ? 'width' : 'height']) < 1), 'sample size matches the settled frame');

  await page.locator('[data-action="set-scene-mode"][data-arg="upload"]').click();
  await page.locator('.stepper-link').nth(1).click();
  // 先等上一段动效自然结束，再取基线，避免把旧动画计入新选择。
  await page.waitForFunction(() => {
    const canvas = document.querySelector('#outfit-particle-canvas');
    if (!canvas.width) return true;
    const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    for (let offset = 3; offset < data.length; offset += 4) if (data[offset]) return false;
    return true;
  }, undefined, { timeout: 4000 });
  const outfitBefore = await particleCounters();
  for (const index of [0, 1, 0]) await page.locator('[data-action="select-outfit"]').nth(index).click();
  await waitForSelectedOutfit();
  await sustained('outfit-particle-canvas', outfitBefore.outfit.fills);
  await page.waitForFunction(threshold => (window.__particleDrawsAt['outfit-particle-canvas'] ?? []).length > threshold, outfitBefore.outfit.draws, { timeout: 3000 });

  const rapid = await particleCounters();
  assert.ok(rapid.outfit.fills - outfitBefore.outfit.fills >= 24 && rapid.outfit.draws > outfitBefore.outfit.draws, `the latest selection samples and keeps painting: ${JSON.stringify(rapid)}`);

  // 播放中真实改变窗口：动效取消，画布清空，图片立即显示。
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForFunction(() => {
    const canvas = document.querySelector('#outfit-particle-canvas');
    if (!canvas.width) return true;
    const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    for (let offset = 3; offset < data.length; offset += 4) if (data[offset]) return false;
    return true;
  }, undefined, { timeout: 3000 });
  await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('#room-outfit .is-front')).opacity) === 1, undefined, { timeout: 3000 });
  const settledHeader = async () => (await page.locator('.gallery-header').evaluate(el => el.getBoundingClientRect().bottom));
  await page.waitForFunction(before => Math.abs(document.querySelector('.gallery-header').getBoundingClientRect().bottom - before) < 0.5, await settledHeader(), { timeout: 3000 });
  await imageGeometry(page, '#room-outfit .is-front .hero-photo');

  // 减少动态：同一路径下不绘制任何粒子。先等上一段动效自然结束。
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForFunction(() => {
    const canvas = document.querySelector('#outfit-particle-canvas');
    if (!canvas.width) return true;
    const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    for (let offset = 3; offset < data.length; offset += 4) if (data[offset]) return false;
    return true;
  }, undefined, { timeout: 4000 });
  const reducedBefore = await particleCounters();
  await page.locator('[data-action="select-outfit"]').nth(1).click();
  await waitForSelectedOutfit();
  await page.waitForTimeout(500);
  const reduced = await particleCounters();
  assert.equal(reduced.outfit.fills, reducedBefore.outfit.fills, 'reduced motion never paints particles');
  assert.equal(reduced.outfit.draws, reducedBefore.outfit.draws, 'reduced motion never samples particles');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await imageGeometry(page, '#room-outfit .is-front .hero-photo');
  await page.waitForTimeout(150);
  await imageGeometry(page, '#room-outfit .is-front .hero-photo');
  await page.locator('.stepper-link').nth(2).click();
  await selectFile(page, '#scene-image', fixtures[2], '#room-scene .is-front .hero-photo');
  await page.setViewportSize({ width: 812, height: 375 });
  await imageGeometry(page, '#room-scene .is-front .hero-photo');
  assert.deepEqual(await page.locator('#room-scene .is-front .hero-photo').evaluate(img => [img.naturalWidth, img.naturalHeight]), [512, 512]);
  await page.locator('[data-action="set-scene-mode"][data-arg="original"]').click();
  await page.setViewportSize({ width: 1440, height: 900 });
  await imageGeometry(page, '#room-scene .is-front .hero-photo');
  assert.deepEqual(await page.locator('#room-scene .is-front .hero-photo').evaluate(img => [img.naturalWidth, img.naturalHeight]), [512, 768]);
  assert.equal(await page.locator('.generation-halo').evaluate(element => getComputedStyle(element, '::after').animationName), 'none', 'hidden overlay never animates');
  await page.emulateMedia({ reducedMotion: 'reduce' });

  // Use differing aspect ratios for original and result. No request reaches a model.
  process.env.TRYON_API_KEYS = 'synthetic-gallery-test-generation-code';
  await page.route('**/api/tryon/authorize', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 0, message: '', data: { remaining: 5 } }) }));
  const payload = { code: 0, message: '', data: { request_id: 'synthetic-gallery-result', image: fixtures[0].buffer.toString('base64'), mime_type: 'image/png', width: 768, height: 512, model: 'test-only' } };
  const success = { status: 200, contentType: 'text/event-stream', body: `event: result\ndata: ${JSON.stringify(payload)}\n\n` };
  await armControlledCouple(page, success);
  await submitGeneration(page);
  await waitControlledCoupleHit(page);
  assert.equal(await page.locator('#generation-status').textContent(), '准备照片');
  await releaseControlledCouple(page);
  await page.locator('#aperture-overlay').waitFor({ state: 'hidden' });
  const capture = (await controlledCaptures(page)).at(-1);
  assert.equal(capture.body.couple_image, fixtures[1].buffer.toString('base64'));
  const slider = page.locator('#reveal-compare-stage');
  // 展开详情不能把正文挤出盒子或压到 dock 下；长元数据只在 .result-meta 内滚动。
  async function detailsLayout() {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    return page.evaluate(() => {
      const rect = element => { const r = element.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height }; };
      const details = document.querySelector('.result-details');
      const meta = document.querySelector('#result-meta');
      return {
        viewport: [innerWidth, innerHeight],
        open: details.open,
        room: rect(document.querySelector('#room-result')),
        stage: rect(document.querySelector('#reveal-compare-stage')),
        details: { ...rect(details), scroll: [details.scrollHeight, details.clientHeight], overflow: getComputedStyle(details).overflowY },
        summary: rect(details.querySelector('summary')),
        meta: { ...rect(meta), scroll: [meta.scrollHeight, meta.clientHeight], overflow: getComputedStyle(meta).overflowY },
        dock: rect(document.querySelector('#floating-dock')),
      };
    });
  }
  async function setDetailsOpen(open) {
    await page.locator('.result-details').evaluate((details, open) => { details.open = open; }, open);
  }
  function assertDetailsLayout(layout) {
    assert.ok(layout.details.bottom <= layout.room.bottom + 1 && layout.details.bottom <= layout.dock.top + 1, `details stay above the dock: ${JSON.stringify(layout)}`);
    assert.ok(layout.summary.top >= layout.details.top - 1 && layout.summary.bottom <= layout.details.bottom + 1, `summary is fully inside its box: ${JSON.stringify(layout)}`);
    if (layout.open) {
      assert.ok(layout.stage.height > 4, `compare area keeps room: ${JSON.stringify(layout)}`);
      assert.equal(layout.meta.height > 0 && layout.meta.bottom <= layout.details.bottom + 1, true, `expanded content stays visible: ${JSON.stringify(layout)}`);
    }
  }
  for (const [width, height] of viewports) {
    await page.setViewportSize({ width, height });
    for (const open of [false, true]) {
      await setDetailsOpen(open);
      const layout = await detailsLayout();
      assert.equal(layout.open, open);
      assertDetailsLayout(layout);
      const original = await imageGeometry(page, '#reveal-compare-stage > img');
      const result = await imageGeometry(page, '#result-image');
      assert.ok(original.width !== result.width || original.height !== result.height, 'differing ratios are independently fitted');
      await slider.focus();
      await page.keyboard.press('ArrowLeft');
      const before = Number(await slider.getAttribute('aria-valuenow'));
      await page.keyboard.press('ArrowRight');
      assert.equal(Number(await slider.getAttribute('aria-valuenow')), before + 3);
      const box = await slider.boundingBox();
      await page.mouse.move(box.x + box.width * .3, box.y + box.height / 2);
      await page.mouse.down(); await page.mouse.move(box.x + box.width * .7, box.y + box.height / 2); await page.mouse.up();
      assert.equal(await slider.getAttribute('aria-valuenow'), '70');
      await page.touchscreen.tap(box.x + box.width * .25, box.y + box.height / 2);
      assert.equal(await slider.getAttribute('aria-valuenow'), '25');
      assert.deepEqual(await imageGeometry(page, '#result-image'), result, 'reveal changes clipping only');
    }
  }
  // 长元数据在窄视口折成多行时只在 .result-meta 内滚动，外层不出现第二层滚动。
  await page.setViewportSize({ width: 812, height: 375 });
  await setDetailsOpen(true);
  await page.locator('#result-meta').evaluate(meta => { meta.textContent = meta.textContent.repeat(6); });
  const longMeta = await detailsLayout();
  assertDetailsLayout(longMeta);
  assert.equal(longMeta.details.overflow, 'visible', 'no second scroll container on the details box');
  assert.equal(longMeta.meta.overflow, 'auto');
  assert.ok(longMeta.meta.scroll[0] > longMeta.meta.scroll[1], `long metadata scrolls inside its own box: ${JSON.stringify(longMeta)}`);
  await page.locator('#result-meta').evaluate(meta => { meta.scrollTop = meta.scrollHeight; });
  assert.ok(await page.locator('#result-meta').evaluate(meta => meta.scrollTop > 0), 'metadata is scrollable');
  await setDetailsOpen(false);
  await page.setViewportSize({ width: 1440, height: 900 });
  if (process.env.SMOKE_EVIDENCE_DIR) {
    await mkdir(process.env.SMOKE_EVIDENCE_DIR, { recursive: true });
    await page.screenshot({ path: `${process.env.SMOKE_EVIDENCE_DIR}/gallery-result-fit.png` });
  }
  console.log(JSON.stringify({ generationLifecycle: await verifyResultLifecycle(page, success) }));
  boundary.assertSafe();
  assert.deepEqual(errors, []);
  if (fixtureServer) assert.deepEqual(fixtureServer.errors, []);
  console.log('Particle contain geometry, different-ratio comparison, upload bytes, generation stages, focus, decode and cancellation passed. Real model requests: 0.');
} finally {
  await browser.close();
  if (fixtureServer) await fixtureServer.close();
}

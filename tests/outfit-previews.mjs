import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { waitForInvitationReady } from './invitation-flow.mjs';
import { verifyDockDrag, verifyDockSelectionPosition, verifyDockTouch, verifyDockWheel } from './dock-scroll.mjs';
import { armControlledCouple, blockUncontrolledGeneration, controlledCaptures, installControlledCouple, releaseControlledCouple, waitControlledCoupleHit } from './browser-observations.mjs';

const { chromium } = createRequire('/opt/browser/package.json')('playwright');
const manifest = JSON.parse(await readFile(new URL('../web/public/manifest.json', import.meta.url), 'utf8'));
const fixture = await readFile(new URL('../backend/internal/imagevalidate/testdata/checker.png', import.meta.url));
const widths = [375, 768, 1440, 1920];
const evidence = process.env.SMOKE_EVIDENCE_DIR || '/evidence';

// Static allowlist assertions require the real Nginx entry, including in Compose acceptance.
const base = process.env.OUTFIT_PREVIEW_BASE_URL || process.env.SMOKE_BASE_URL;
assert.ok(base, 'outfit previews require a live Nginx base URL');
const browser = await chromium.launch({ headless: true });
let boundary;
try {
  await mkdir(evidence, { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, hasTouch: true, serviceWorkers: 'block' });
  page.setDefaultTimeout(10_000);
  const errors = [];
  const mainRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (/outfits\/W\d+\.webp$/.test(request.url())) mainRequests.push(request.url());
  });
  boundary = await blockUncontrolledGeneration(page);
  await installControlledCouple(page);
  await page.route('**/api/tryon/authorize', route => route.fulfill({ json: { code: 0, data: { remaining: 5 } } }));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal((await page.goto(base)).status(), 200);
  await page.locator('#open-invitation').click();
  await waitForInvitationReady(page);
  await page.waitForFunction(() => !document.querySelector('.stepper-link')?.disabled);
  assert.equal(mainRequests.length, 0, 'main previews load only on demand');
  await page.locator('.stepper-link').nth(1).click();
  const displayed = id => page.waitForFunction(id => document.querySelector('#room-outfit .is-front img')?.dataset.outfitId === id, id);
  await displayed('W001');
  assert.equal(await page.locator('.dock-thumb-btn.is-active').count(), 0, 'default example must not select an outfit');
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('.dock-thumb-btn.is-active').getAttribute('data-arg'), 'W001', 'keyboard can make the first selection');
  assert.equal(mainRequests.length, 1, 'selecting the current example does not reload it');

  // Check every outfit and venue image with the browser decoder, not just container headers.
  const decoded = await page.evaluate(async entries => Promise.all(entries.flatMap(entry => ['display', 'thumbnail'].map(async kind => {
    const spec = entry[kind];
    const response = await fetch(`/web/public/${spec.file}`);
    if (!response.ok) throw new Error(`Static image HTTP ${response.status}: ${spec.file}`);
    const image = await createImageBitmap(await response.blob());
    const size = [image.width, image.height];
    image.close();
    return { file: spec.file, size };
  }))), [...manifest.outfitPreviews, ...manifest.venuePreviews]);
  assert.equal(decoded.length, 74);
  for (const entry of decoded) {
    const expected = entry.file.includes('-thumb') ? [320, 240] : entry.file.startsWith('venues/') ? [2400, 1600] : [2400, 1040];
    assert.deepEqual(entry.size, expected);
  }
  for (const path of ['/web/public/outfits/', '/web/public/outfits/W000.webp', '/web/public/outfits/W031.webp', '/web/public/outfits/W001.png', '/web/public/outfits/other.webp', '/web/public/venues/', '/web/public/venues/V000.webp', '/web/public/venues/V008.webp', '/web/public/venues/V001.png', '/web/public/fonts/OFL-noto-serif-sc.txt', '/assets/wedding/W001/dress.jpg', '/assets/wedding/venues/V001/scene.jpg', '/assets/wedding/private/intake.json', '/.env', '/web/public/manifest.json.bak']) {
    assert.equal((await page.request.get(base + path)).status(), 404, path);
  }

  for (const width of widths) {
    await page.setViewportSize({ width, height: width === 1920 ? 1080 : 900 });
    await page.waitForFunction(width => innerWidth === width && Math.abs(document.querySelector('#room-outfit').getBoundingClientRect().width - width) < 1, width);
    for (const entry of manifest.outfitPreviews) {
      // Selection from the real delegated handler; scrolling is checked separately below.
      await page.locator(`[data-action="select-outfit"][data-arg="${entry.id}"]`).evaluate(element => element.click());
      await displayed(entry.id);
      const geometry = await page.locator('#room-outfit .is-front img').evaluate(img => {
        const box = img.getBoundingClientRect();
        const style = getComputedStyle(img);
        const viewport = document.querySelector('#gallery-viewport').getBoundingClientRect();
        return { x: box.x, y: box.y, viewportTop: viewport.top, viewportHeight: viewport.height, width: box.width, height: box.height, fit: style.objectFit, focus: style.objectPosition.split(' ').map(value => parseFloat(value) / 100), border: getComputedStyle(img.closest('.gallery-room'), '::after').content };
      });
      assert.equal(geometry.fit, 'cover');
      assert.ok(geometry.focus.every((value, i) => Math.abs(value - entry.focus[i]) < 1e-6));
      assert.equal(geometry.border, 'none');
      // Same room column as every other stage: the preview starts under the header and fills the rest.
      assert.ok(Math.abs(geometry.x) < 1 && Math.abs(geometry.y - geometry.viewportTop) < 1, JSON.stringify({ id: entry.id, width, geometry }));
      assert.ok(Math.abs(geometry.width - width) < 1 && Math.abs(geometry.height - geometry.viewportHeight) < 1, JSON.stringify({ id: entry.id, width, geometry, viewport: page.viewportSize() }));
      // The sources share this pose. Both face centres must survive every cover crop.
      const scale = Math.max(geometry.width / 2400, geometry.height / 1040);
      for (const [x, y] of [[960, 365], [1130, 380]]) {
        const left = (geometry.width - 2400 * scale) * entry.focus[0] + x * scale;
        const top = (geometry.height - 1040 * scale) * entry.focus[1] + y * scale;
        assert.ok(left > 20 && left < geometry.width - 20 && top > geometry.viewportTop + 20 && top < geometry.height - 140, `${entry.id} face outside framing at ${width}`);
      }
    }
    const card = await page.locator('.dock-thumb-btn').first().boundingBox();
    assert.deepEqual([Math.round(card.width), Math.round(card.height)], width <= 800 ? [88, 86] : [112, 104]);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: `${evidence}/outfit-preview-${width}.png` });
  }
  console.log('60 images decoded; static allowlist and 120 cover/focus layouts passed');

  await page.setViewportSize({ width: 1440, height: 900 });
  await verifyDockWheel(page);
  await verifyDockSelectionPosition(page);
  await verifyDockDrag(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await verifyDockTouch(page);
  console.log('Wheel, stable click position, mouse drag, keyboard and native touch passed');

  // Holding a decoded image exercises ordering even when the network cache is warm.
  await page.evaluate(() => {
    const original = HTMLImageElement.prototype.decode;
    window.__heldDecodeCount = 0;
    HTMLImageElement.prototype.decode = async function () {
      await original.call(this);
      if (this.src.endsWith('/W002.webp')) {
        window.__heldDecodeCount++;
        await new Promise(resolve => { window.__releaseOutfitDecode = resolve; });
      }
    };
    window.__restoreDecode = () => { HTMLImageElement.prototype.decode = original; };
  });
  const choose = id => page.locator(`[data-action="select-outfit"][data-arg="${id}"]`).evaluate(element => element.click());
  await choose('W001');
  await displayed('W001');
  await choose('W002');
  await page.waitForFunction(() => window.__heldDecodeCount === 1);
  assert.equal(await page.locator('#room-outfit .is-front img').getAttribute('data-outfit-id'), 'W001', 'keep decoded photo until the next decode finishes');
  await choose('W003');
  await displayed('W003');
  await page.evaluate(() => window.__releaseOutfitDecode());
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await displayed('W003');
  // Returning to the already displayed image must invalidate a pending selection too.
  await choose('W002');
  await page.waitForFunction(() => window.__heldDecodeCount === 2);
  await choose('W003');
  await page.evaluate(() => { window.__releaseOutfitDecode(); window.__restoreDecode(); });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await displayed('W003');

  await page.route('**/web/public/outfits/W005.webp', route => route.fulfill({ status: 404, body: '' }));
  await choose('W005');
  await page.locator('#outfit-preview-status').filter({ hasText: '加载失败' }).waitFor();
  assert.equal(await page.locator('#room-outfit .hero-frame img').count(), 0, 'failed preview must not show another outfit or uploaded photo');
  assert.equal(await page.locator('.dock-thumb-btn.is-active').getAttribute('data-arg'), 'W005');
  await page.unroute('**/web/public/outfits/W005.webp');
  await page.locator('#retry-outfit-preview').click();
  await displayed('W005');

  // A manifest failure stays visible in the hero, and rapid retries share one request so a
  // slower failure can never discard previews that another attempt already loaded.
  let manifestRequests = 0;
  await page.route('**/web/public/manifest.json', route => route.fulfill({ status: 500, body: 'controlled manifest failure' }));
  await page.reload();
  await page.locator('#open-invitation').click();
  await waitForInvitationReady(page);
  await page.waitForFunction(() => document.querySelectorAll('.stepper-link').length === 4);
  await page.locator('.stepper-link').nth(1).click();
  await page.locator('#outfit-preview-status').filter({ hasText: '造型示例清单读取失败' }).waitFor();
  // A retry while the manifest is still failing keeps the real failure in the hero.
  await page.locator('#retry-outfit-preview').click();
  await page.locator('#retry-outfit-preview').waitFor({ state: 'visible' });
  assert.match(await page.locator('#outfit-preview-status').textContent(), /造型示例清单读取失败/);
  await page.unroute('**/web/public/manifest.json');
  await page.on('request', request => { if (request.url().endsWith('/web/public/manifest.json')) manifestRequests++; });
  await page.evaluate(() => { document.querySelector('#outfit-preview-status').textContent = '待重试'; });
  const retry = page.locator('#retry-outfit-preview');
  await Promise.all([retry.click(), retry.click()]);
  await displayed('W001');
  assert.equal(manifestRequests, 1, `concurrent retries must share one manifest request (got ${manifestRequests})`);
  assert.match(await page.locator('#outfit-preview-status').textContent(), /造型示例 · /);
  console.log('Decode-before-display, last selection wins, visible failure, manifest failure and shared retry passed');

  // Capture real renderer destinations for cover+focus and contain through the same implementation.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(() => {
    window.__previewDraws = [];
    const draw = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (source, ...args) {
      if (this.canvas.classList.contains('particle-canvas')) {
        const style = getComputedStyle(source);
        window.__previewDraws.push({ canvas: [this.canvas.width, this.canvas.height], size: [source.naturalWidth, source.naturalHeight], fit: style.objectFit, focus: style.objectPosition.split(' ').map(value => parseFloat(value) / 100), args });
      }
      return draw.call(this, source, ...args);
    };
  });
  await choose('W006');
  await displayed('W006');
  await page.waitForFunction(() => window.__previewDraws.some(draw => draw.fit === 'cover'));
  await page.locator('.stepper-link').first().click();
  await page.locator('#couple-image').setInputFiles({ name: 'checker.png', mimeType: 'image/png', buffer: fixture });
  await page.waitForFunction(() => document.querySelector('#room-photo-content .hero-photo')?.src.startsWith('blob:'));
  const photoURL = await page.locator('#room-photo-content .hero-photo').getAttribute('src');
  await page.locator('.stepper-link').nth(2).click();
  await page.locator('#scene-image').setInputFiles({ name: 'checker.png', mimeType: 'image/png', buffer: fixture });
  await page.waitForFunction(() => document.querySelector('#room-scene .is-front img')?.src.startsWith('blob:') && !document.querySelector('#scene-reference').hidden);
  // Fixed venue previews use the same cover + focus frame and particle dissolve as outfit previews.
  await Promise.all([
    page.waitForRequest(request => request.url().endsWith('/web/public/venues/V001.webp')),
    page.locator('[data-action="select-venue"][data-arg="V001"]').evaluate(element => element.click()),
  ]);
  await page.waitForFunction(() => document.querySelector('#room-scene .is-front img')?.dataset.venueId === 'V001');
  await page.waitForFunction(() => window.__previewDraws.some(draw => draw.fit === 'contain'));
  // Switching back to original dissolves from the cover+focus venue image while restoring full contain framing.
  await page.locator('[data-action="set-scene-mode"][data-arg="original"]').click();
  await page.waitForFunction(photoURL => document.querySelector('#room-scene .is-front img')?.src === photoURL, photoURL);
  await page.waitForFunction(() => window.__previewDraws.some(draw => draw.fit === 'cover' && draw.size[0] === 2400 && draw.size[1] === 1600));
  assert.equal(await page.locator('#room-scene .is-front img').evaluate(img => getComputedStyle(img).objectFit), 'contain');
  for (const { canvas: [w, h], size: [sw, sh], fit, focus: [fx, fy], args } of await page.evaluate(() => window.__previewDraws)) {
    const scale = (fit === 'cover' ? Math.max : Math.min)(w / sw, h / sh);
    assert.deepEqual(args, [(w - sw * scale) * fx, (h - sh * scale) * fy, sw * scale, sh * scale]);
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('.stepper-link').nth(1).click();
  await page.evaluate(() => { window.__previewDraws = []; });
  await choose('W010');
  await displayed('W010');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.deepEqual(await page.evaluate(() => window.__previewDraws), []);
  console.log('Shared particle sampling matches cover/focus and contain; reduced motion draws no particles');

  // Verify fixed venue frames match outfit frames across viewports, including landscape mobile.
  const venueViewports = [[375, 812], [768, 900], [1440, 900], [1920, 1080], [812, 375]];
  const displayedVenue = id => page.waitForFunction(id => {
    const img = document.querySelector('#room-scene .is-front img');
    return img?.dataset.venueId === id && img.complete && img.naturalWidth === 2400 && img.naturalHeight === 1600;
  }, id);
  const chooseVenue = id => page.locator(`[data-action="select-venue"][data-arg="${id}"]`).evaluate(element => element.click());
  for (const [width, height] of venueViewports) {
    await page.setViewportSize({ width, height });
    await page.waitForFunction(({ width, height }) => innerWidth === width && innerHeight === height, { width, height });
    await page.locator('.stepper-link').nth(1).click();
    await page.waitForFunction(() => Math.abs(document.querySelector('#room-outfit').getBoundingClientRect().x) < 1);
    const outfitBox = await page.locator('#room-outfit .hero-frame').boundingBox();
    await page.locator('.stepper-link').nth(2).click();
    await page.waitForFunction(() => Math.abs(document.querySelector('#room-scene').getBoundingClientRect().x) < 1);
    for (const entry of manifest.venuePreviews) {
      await chooseVenue(entry.id);
      await displayedVenue(entry.id);
      const geometry = await page.locator('#room-scene .is-front img').evaluate(img => {
        const box = img.getBoundingClientRect();
        const style = getComputedStyle(img);
        const viewport = document.querySelector('#gallery-viewport').getBoundingClientRect();
        const tile = document.querySelector(`.dock-thumb-btn[data-arg="${img.dataset.venueId}"]`);
        const name = tile.querySelector('.outfit-card-name');
        const gen = document.querySelector('#generate').getBoundingClientRect();
        return {
          x: box.x, y: box.y, width: box.width, height: box.height,
          viewportTop: viewport.top, viewportHeight: viewport.height,
          fit: style.objectFit,
          focus: style.objectPosition.split(' ').map(value => parseFloat(value) / 100),
          border: getComputedStyle(img.closest('.gallery-room'), '::after').content,
          tile: tile.getBoundingClientRect(),
          label: tile.getAttribute('aria-label'),
          nameText: name.textContent.trim(),
          nameFits: name.scrollHeight <= name.clientHeight + 1 && name.scrollWidth <= name.clientWidth + 1,
          genVisible: gen.right <= innerWidth + 1 && gen.bottom <= innerHeight + 1 && gen.width > 0 && gen.height > 0,
        };
      });
      assert.equal(geometry.fit, 'cover');
      assert.ok(geometry.focus.every((value, i) => Math.abs(value - entry.focus[i]) < 1e-6));
      assert.equal(geometry.border, 'none');
      assert.ok(Math.abs(geometry.x) < 1 && Math.abs(geometry.y - geometry.viewportTop) < 1);
      assert.ok(Math.abs(geometry.width - outfitBox.width) < 1 && Math.abs(geometry.height - outfitBox.height) < 1);
      assert.deepEqual([Math.round(geometry.tile.width), Math.round(geometry.tile.height)], width <= 800 ? [88, 86] : [112, 104]);
      assert.ok(geometry.nameText.length > 0 && geometry.label.includes(geometry.nameText));
      assert.equal(geometry.nameFits, true, `venue card name clipped for ${entry.id} at ${width}x${height}`);
      assert.equal(geometry.genVisible, true, `generate button clipped at ${width}x${height}`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `overflow at ${width}x${height}`);
    }
    await page.screenshot({ path: `${evidence}/venue-preview-${width}x${height}.png` });
  }

  // Venue failure, retry, late decode isolation and arrow-key navigation.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route('**/web/public/venues/V002.webp', route => route.fulfill({ status: 404, body: '' }));
  await chooseVenue('V002');
  await page.locator('#scene-preview-status').filter({ hasText: '加载失败' }).waitFor();
  assert.equal(await page.locator('#room-scene .hero-frame img').count(), 0);
  await page.unroute('**/web/public/venues/V002.webp');
  await page.locator('#retry-scene-preview').click();
  await displayedVenue('V002');

  await page.evaluate(() => {
    const original = HTMLImageElement.prototype.decode;
    window.__heldVenueDecode = 0;
    HTMLImageElement.prototype.decode = async function () {
      await original.call(this);
      if (this.src.endsWith('/V002.webp')) {
        window.__heldVenueDecode++;
        await new Promise(resolve => { window.__releaseVenueDecode = resolve; });
      }
    };
    window.__restoreVenueDecode = () => { HTMLImageElement.prototype.decode = original; };
  });
  await chooseVenue('V001');
  await displayedVenue('V001');
  await chooseVenue('V002');
  await page.waitForFunction(() => window.__heldVenueDecode === 1);
  await chooseVenue('V003');
  await displayedVenue('V003');
  await page.evaluate(() => window.__releaseVenueDecode());
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await displayedVenue('V003');
  await chooseVenue('V002');
  await page.waitForFunction(() => window.__heldVenueDecode === 2);
  await page.locator('[data-action="set-scene-mode"][data-arg="original"]').click();
  await page.evaluate(() => { window.__releaseVenueDecode(); window.__restoreVenueDecode(); });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.locator('#room-scene .is-front img').evaluate(img => img.src), photoURL);

  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('.dock-thumb-btn.is-active').getAttribute('data-arg'), 'upload');
  await page.keyboard.press('ArrowRight');
  await displayedVenue('V001');
  assert.equal(await page.locator('.dock-thumb-btn.is-active').getAttribute('data-arg'), 'V001');
  await page.keyboard.press('ArrowLeft');
  assert.equal(await page.locator('.dock-thumb-btn.is-active').getAttribute('data-arg'), 'upload');
  await page.keyboard.press('ArrowLeft');
  assert.equal(await page.locator('.dock-thumb-btn.is-active').getAttribute('data-arg'), 'original');
  console.log('Venue multi-viewport layout, card names, retry, late decode isolation and arrow keys passed');

  // The display example must never enter the generation payload.
  await page.locator('.stepper-link').nth(2).click();
  await page.locator('[data-action="set-scene-mode"][data-arg="original"]').click();
  const payload = { code: 0, message: '', data: { image: fixture.toString('base64'), mime_type: 'image/png', width: fixture.readUInt32BE(16), height: fixture.readUInt32BE(20), model: 'controlled-test', request_id: 'preview-payload-check', duration_ms: 1 } };
  await armControlledCouple(page, { status: 200, contentType: 'text/event-stream', body: `event: result\ndata: ${JSON.stringify(payload)}\n\n` });
  await page.locator('#generate').click();
  await page.locator('#access-token').fill('controlled-preview-test');
  await page.locator('#confirm-access').click();
  await waitControlledCoupleHit(page);
  const [capture] = await controlledCaptures(page);
  assert.deepEqual(capture.body, { couple_image: fixture.toString('base64'), outfit_id: 'W010', scene: { mode: 'original' } });
  await releaseControlledCouple(page);
  await page.locator('#result-image').waitFor().catch(async error => {
    throw new Error(`Controlled result failed: ${await page.locator('#form-alert').textContent()}`, { cause: error });
  });

  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForFunction(width => innerWidth === width, width);
    for (const [room, selector] of [[0, '#room-photo-content .hero-photo'], [2, '#room-scene .is-front img'], [3, '#result-image']]) {
      await page.locator('.stepper-link').nth(room).click();
      const geometry = await page.locator(selector).evaluate(img => {
        const r = img.getBoundingClientRect();
        const header = document.querySelector('.gallery-header').getBoundingClientRect();
        const dock = document.querySelector('#floating-dock').getBoundingClientRect();
        return { fit: getComputedStyle(img).objectFit, top: r.top, bottom: r.bottom, headerBottom: header.bottom, dockTop: dock.top };
      });
      assert.equal(geometry.fit, 'contain');
      assert.ok(geometry.top >= geometry.headerBottom && geometry.bottom <= geometry.dockTop, `room ${room} photo overlaps controls at ${width}`);
    }
  }
  assert.equal(await page.locator('#room-photo-content .hero-photo').getAttribute('src'), photoURL);
  assert.deepEqual(errors, []);
  boundary.assertSafe();
  console.log(JSON.stringify({ previewAcceptance: 'passed', widths, decoded: decoded.length, layouts: 120, generation: 'controlled; original upload bytes and W010 preserved', otherRooms: 'contain without control overlap', pageErrors: errors }));
} finally {
  await browser.close();
  boundary?.assertSafe();
}

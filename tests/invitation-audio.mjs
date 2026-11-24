import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { verifyInvitationFlow, waitForInvitationReady } from './invitation-flow.mjs';
import { blockUncontrolledGeneration } from './browser-observations.mjs';

const { chromium } = createRequire('/opt/browser/package.json')('playwright');
const base = process.env.SMOKE_BASE_URL ?? 'http://web:8080';
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ serviceWorkers: 'block' });
  page.setDefaultTimeout(10_000);
  const boundary = await blockUncontrolledGeneration(page);
  const pageErrors = [];
  const errors = [];
  const requests = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request', request => requests.push({ method: request.method(), url: request.url() }));
  const response = await page.request.get(base + '/web/public/invitation-opening-petals.mp3');
  assert.equal(response.status(), 200);
  assert.match(response.headers()['content-type'], /^audio\/mpeg/);
  assert.match(response.headers()['content-security-policy'], /default-src 'self'/);
  for (const path of ['/web/public/unlisted.mp3', '/web/public/invitation-opening-petals.mp3.bak']) {
    assert.equal((await page.request.get(base + path)).status(), 404);
  }
  console.log(JSON.stringify({ invitationFlow: await verifyInvitationFlow(page, base) }));
  for (const lifecycle of ['visibilitychange', 'pagehide']) {
    await page.goto(base);
    await page.locator('#open-invitation').click();
    await page.waitForFunction(() => !document.querySelector('#invitation-sound').paused);
    await page.evaluate(type => {
      if (type === 'visibilitychange') {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
        document.dispatchEvent(new Event(type));
      } else window.dispatchEvent(new Event(type));
    }, lifecycle);
    assert.deepEqual(await page.locator('#invitation-sound').evaluate(sound => ({ paused: sound.paused, time: sound.currentTime })), { paused: true, time: 0 });
  }
  assert.deepEqual(errors, []);
  await page.goto(base);
  await page.locator('#invitation-sound').evaluate(sound => {
    sound.play = () => Promise.reject(new DOMException('controlled playback refusal', 'NotAllowedError'));
  });
  await page.locator('#open-invitation').click();
  await waitForInvitationReady(page);
  assert.equal(errors.length, 1, 'playback failure must be visible in the console');
  assert.match(errors[0], /请柬音效播放失败.*controlled playback refusal/);
  assert.deepEqual(pageErrors, []);
  assert.ok(requests.every(request => request.method === 'GET' && new URL(request.url).origin === new URL(base).origin));
  boundary.assertSafe();
  console.log('Invitation audio: real MP3 decode/play/end, keyboard, reduced motion, skip, reload, lifecycle stop, explicit playback failure and same-origin allowlist passed; generation requests: 0.');
} finally {
  await browser.close();
}

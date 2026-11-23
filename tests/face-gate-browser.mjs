import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { consumeSSE } from '../web/sse-core.mjs';
import { waitForInvitationReady } from './invitation-flow.mjs';

// Run only against verify-phase6's isolated web/backend with empty model credentials.
const base = process.env.SMOKE_BASE_URL;
assert.equal(base, 'http://web:8080');
const tokens = process.env.TRYON_API_KEYS?.split(',');
assert.equal(tokens?.length, 2);
assert.ok(tokens.every(token => token.startsWith('synthetic-')) && tokens[0] !== tokens[1]);
const browser = await createRequire('/opt/browser/package.json')('playwright').chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ reducedMotion: 'reduce', serviceWorkers: 'block' });
  page.setDefaultTimeout(15_000);
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    window.__faceGateResponses = [];
    window.fetch = async (...args) => {
      const response = await originalFetch(...args);
      const resource = args[0] instanceof Request ? args[0].url : args[0];
      if (new URL(resource, location.href).pathname === '/api/tryon/couple') {
        // Observe bytes consumed by the app; its terminal cleanup aborts cloned streams.
        const evidence = { status: response.status, headers: Object.fromEntries(response.headers), text: '' };
        window.__faceGateResponses.push(evidence);
        if (response.body) {
          const getReader = response.body.getReader.bind(response.body);
          response.body.getReader = (...options) => {
            const reader = getReader(...options);
            const read = reader.read.bind(reader);
            const decoder = new TextDecoder();
            reader.read = async (...args) => {
              try {
                const result = await read(...args);
                evidence.text += result.done ? decoder.decode() : decoder.decode(result.value, { stream: true });
                return result;
              } catch (error) {
                evidence.error = error.message;
                throw error;
              }
            };
            return reader;
          };
        }
      }
      return response;
    };
  });
  const submissions = [];
  page.on('request', request => {
    if (request.method() !== 'GET') submissions.push(new URL(request.url()).pathname);
  });
  await page.goto(base);
  await page.locator('#open-invitation').click();
  await waitForInvitationReady(page);
  let previousPreview;
  for (const [index, [file, code, text]] of [
    ['one.jpg', 'COUPLE_IMAGE_NOT_COUPLE', '未检测到两张清晰的人脸，请换一张两人面部清楚的合照。'],
    ['two.jpg', 'MODEL_CONFIGURATION_INVALID', '后端请求失败（HTTP 503）'],
  ].entries()) {
    await page.locator('.stepper-link').nth(0).click();
    const expectedRequests = index * 2;
    await page.locator('#couple-image').setInputFiles(fileURLToPath(new URL(`../backend/internal/facedetect/testdata/${file}`, import.meta.url)));
    const preview = await page.waitForFunction(previous => {
      const src = document.querySelector('#room-photo-content .hero-photo')?.src;
      return src?.startsWith('blob:') && src !== previous ? src : false;
    }, previousPreview);
    previousPreview = await preview.jsonValue();
    if (index === 0) {
      await page.locator('.stepper-link').nth(1).click();
      await page.locator('.dock-thumb-btn[data-arg="W001"]').click();
    }
    await page.locator('.stepper-link').nth(2).click();
    await page.locator('#generate').click();
    await page.locator('#access-dialog[open]').waitFor();
    assert.equal(submissions.length, expectedRequests, 'selection and local preview must not submit a photo');
    await page.locator('#access-token').fill(tokens[index]);
    const [response] = await Promise.all([
      page.waitForResponse(base + '/api/tryon/couple'),
      page.locator('#confirm-access').click(),
    ]);
    assert.equal(response.status(), 200);
    await page.locator('#form-alert').getByText(text, { exact: true }).waitFor();
    await page.waitForFunction(count => window.__faceGateResponses.length === count, index + 1);
    const evidence = await page.evaluate(index => window.__faceGateResponses[index], index);
    assert.equal(evidence.error, undefined, 'the app must read the real SSE without a stream failure');
    assert.equal(evidence.status, 200);
    const terminal = await consumeSSE(new Response(evidence.text, { headers: evidence.headers }));
    assert.equal(terminal.type, 'error');
    assert.equal(terminal.payload.data.error_code, code);
    assert.deepEqual(submissions.slice(expectedRequests), ['/api/tryon/authorize', '/api/tryon/couple']);
  }
  console.log('Browser: local selection, real single-face rejection, replacement and two-face retry passed.');
} finally {
  await browser.close();
}

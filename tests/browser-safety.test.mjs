import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { observeConsole } from './browser-observations.mjs';

const require = createRequire('/opt/browser/package.json');
const { chromium } = require('playwright');
const execute = promisify(execFile);
const syntheticToken = 'synthetic-browser-boundary-token-00000000';

test('generic smoke sends zero generation requests; an uncontrolled request is blocked and fails smoke', { timeout: 120_000 }, async () => {
  const upstream = process.env.SMOKE_BASE_URL ?? 'http://web:8080';
  const backendToken = process.env.TRYON_API_KEYS?.split(',').map(value => value.trim()).find(Boolean);
  assert.ok(backendToken, 'boundary regression requires the backend access token');
  let generations = 0;
  let injectGeneration = false;
  const proxyErrors = [];
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, upstream);
      // Count the actual backend endpoint independently of the browser guard.
      if (/^\/api\/tryon\/couple\/?$/.test(url.pathname)) {
        generations++;
        // This proxy never forwards generation, regardless of backend configuration.
        response.writeHead(599, { 'Content-Type': 'application/json' });
        response.end('{}');
        return;
      }
      const result = await fetch(url, {
        redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: request.headers.authorization ? {
          Authorization: request.headers.authorization === `Bearer ${syntheticToken}` ? `Bearer ${backendToken}` : request.headers.authorization,
        } : {},
      });
      let body = Buffer.from(await result.arrayBuffer());
      if (injectGeneration && url.pathname === '/web/app.mjs') {
        body = Buffer.concat([Buffer.from("fetch('/api/tryon/couple', {method:'POST'}).catch(() => {});\n"), body]);
      }
      // Fetch decodes compressed bodies; Node recomputes framing after injection.
      const headers = Object.fromEntries([...result.headers].filter(([name]) => !['content-length', 'content-encoding', 'transfer-encoding', 'connection'].includes(name)));
      response.writeHead(result.status, headers);
      response.end(body);
    } catch (error) {
      proxyErrors.push(error);
      response.writeHead(502);
      response.end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const env = { ...process.env, SMOKE_BASE_URL: `http://127.0.0.1:${server.address().port}`, TRYON_API_KEYS: syntheticToken };
    const result = await execute(process.execPath, ['tests/smoke.mjs', '--stage', 'phase6'], { env, timeout: 90_000 });
    assert.match(result.stdout, /"stage":"phase6"/);
    assert.equal(generations, 0, 'complete smoke must not send generation to the proxy');
    injectGeneration = true;
    await assert.rejects(
      execute(process.execPath, ['tests/smoke.mjs', '--stage', 'phase6'], { env, timeout: 30_000 }),
      error => error.code === 1 && /uncontrolled generation request blocked/.test(error.stderr),
    );
    assert.equal(generations, 0, 'uncontrolled generation must be aborted before reaching the proxy');
    assert.deepEqual(proxyErrors, []);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('all real Chromium console levels are scanned, with independent expected-error checks', { timeout: 30_000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const observation = observeConsole(page);
    const markers = { token: ['synthetic-console-token'], photo: ['synthetic-console-photo'], scene: ['synthetic-console-scene'], result: ['synthetic-console-result'] };
    await page.goto('about:blank');
    for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
      for (const [category, values] of Object.entries(markers)) {
        observation.messages.length = 0;
        const captured = page.waitForEvent('console', { predicate: message => message.text() === values[0], timeout: 5_000 });
        await page.evaluate(([level, marker]) => console[level](marker), [level, values[0]]);
        await captured;
        assert.equal(observation.messages.length, 1);
        assert.equal(observation.messages[0].type, level === 'warn' ? 'warning' : level);
        assert.throws(() => observation.assertNoSensitive(markers), error => error.message === `sensitive browser console data: ${category}`);
        assert.equal(observation.errors().length, level === 'error' ? 1 : 0);
      }
    }
    observation.messages.length = 0;
    const captured = page.waitForEvent('console', { predicate: message => message.type() === 'error', timeout: 5_000 });
    await page.evaluate(() => {
      console.log('ordinary diagnostic');
      console.info('ordinary information');
      console.warn('ordinary warning');
      console.debug('ordinary debug');
      console.error('Failed to load resource: 503 (Service Unavailable)');
    });
    await captured;
    observation.assertNoSensitive(markers);
    assert.equal(observation.messages.length, 5);
    assert.equal(observation.errors().length, 1);
    assert.match(observation.errors()[0], /503 \(Service Unavailable\)/);
  } finally {
    await browser.close();
  }
});

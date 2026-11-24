import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';

const MIME_TYPES = Object.freeze({
  html: 'text/html', mjs: 'application/javascript', css: 'text/css', json: 'application/json',
  jpg: 'image/jpeg', webp: 'image/webp', woff2: 'font/woff2', mp3: 'audio/mpeg',
});
const ENTRY_FILES = ['/', '/web/public/manifest.json', '/web/public/invitation-opening-petals.mp3'];
// Mutable entry scripts and styles are matched by directory plus extension, not by name.
const ENTRY_SCRIPTS = /^\/web\/[\w-]+\.(mjs|css)$/;
const STATIC_ASSETS = [
  /^\/web\/public\/fonts\/[\w-]+\.woff2$/,
  /^\/web\/public\/(wedding-example|florals)\.jpg$/,
  /^\/web\/public\/outfits\/W0(0[1-9]|[12]\d|30)(-thumb)?\.webp$/,
];

// Serves the working tree with explicit API fixtures for browser checks that must not
// reach a model. Any unexpected path fails the run through `errors` instead of 404.
export async function serveSource({ api, allow }) {
  const errors = [];
  const server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url, 'http://localhost').pathname;
      const payload = api(path);
      if (payload) {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ code: 0, message: '', data: payload }));
        return;
      }
      const allowed = allow ? allow(path) : ENTRY_FILES.includes(path) || ENTRY_SCRIPTS.test(path) || STATIC_ASSETS.some(pattern => pattern.test(path));
      assert.ok(allowed, `unexpected request: ${path}`);
      const file = path === '/' ? 'index.html' : path.slice(1);
      const type = MIME_TYPES[file.split('.').at(-1)];
      assert.ok(type, `unknown asset type: ${file}`);
      response.writeHead(200, { 'Content-Type': type });
      response.end(await readFile(new URL(`../${file}`, import.meta.url)));
    } catch (error) {
      errors.push(error.message);
      response.writeHead(500);
      response.end('Test server failure');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    errors,
    async close() {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

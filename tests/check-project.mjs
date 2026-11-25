import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const text = path => readFile(resolve(root, path), 'utf8');
for (const path of ['backend/docker-compose.yml','docker-compose.yml','backend/.env.example','backend/build.bat','backend/restart.bat']) {
  const exists = await stat(resolve(root, path)).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
  assert.equal(exists, false, `disallowed duplicate entry or script: ${path}`);
}
async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => {
    if (directory === root && entry.name === 'docs') return [];
    if (['.git','.local','.playwright-mcp','node_modules'].includes(entry.name)) return [];
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  }));
  return nested.flat();
}
const allFiles = await files(root);
for (const path of allFiles) {
  if (!['.html','.mjs','.go','.css','.yaml','.yml','.md','.sh'].includes(extname(path))) continue;
  const name = relative(root, path).replaceAll('\\', '/');
  const content = await readFile(path, 'utf8');
  if (!name.startsWith('tests/') && !name.endsWith('_test.go')) {
    assert.doesNotMatch(content, /ClientProvided|NewGeneratorFromClientConfig|security\.GetService/, `legacy behavior in ${name}`);
  }
  if (name.endsWith('.md')) {
    for (const [, target] of content.matchAll(/\]\(([^)]+)\)/g)) {
      if (/^(?:https?:|app:|#)/.test(target)) continue;
      const link = target.split('#')[0];
      if (!link) continue;
      await stat(resolve(path, '..', link));
    }
  }
}
const nginx = await text('docker/nginx.conf');
assert.match(nginx, /location \/ \{ return 404; \}/);
assert.match(await text('compose.yaml'), /127\.0\.0\.1:\$\{VOWMIRROR_WEB_PORT:-3000\}:8080/);
assert.doesNotMatch(await text('.github/workflows/backend-ci.yml'), /setup-go|go-version/);
assert.doesNotMatch(await text('backend/manifest/docker/Dockerfile'), /config\*|COPY \. \./);
console.log(`Project structure, source cleanup and documentation links passed (${allFiles.length} files)`);

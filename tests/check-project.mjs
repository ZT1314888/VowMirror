import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const text = path => readFile(resolve(root, path), 'utf8');
const roadmap = await text('docs/plan/2026-11-05-wedding-project-roadmap.md');
for (let phase = 0; phase <= 8; phase++) assert.match(roadmap, new RegExp(`Phase ${phase}`));
for (const [phase, group, count] of [[0,'A',4],[0,'B',4],[1,'A',7],[1,'B',6],[1,'C',8],[2,'A',6],[2,'B',6],[3,'A',6],[3,'B',7],[4,'A',5],[4,'B',5],[5,'A',4],[5,'B',4],[6,'A',4],[6,'B',5],[7,'A',4],[7,'B',6],[8,'A',6],[8,'B',5]]) {
  for (let task = 1; task <= count; task++) {
    const id = `P${phase}-${group}${task}`;
    const row = roadmap.split('\n').find(line => line.startsWith(`| ${id} |`));
    assert.ok(row, `missing task ${id}`);
    const cells = row.split('|').map(cell => cell.trim()).filter(Boolean);
    assert.equal(cells.length, 3, `invalid task row ${id}`);
    assert.ok(['未开始', '进行中', '通过', '阻塞'].includes(cells[2]), `missing task status ${id}`);
  }
}
assert.match(roadmap, /未开始|进行中|通过|阻塞/);
for (const path of ['data.js','nvzhuang.md','assets/img','assets/thumbs','backend/workflows','backend/docker-compose.yml','docker-compose.yml','backend/api/hello','backend/api/tryon','backend/internal/controller','backend/internal/packed','backend/hack','backend/build.bat','backend/restart.bat','backend/.env.example']) {
  const exists = await stat(resolve(root, path)).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
  assert.equal(exists, false, `legacy target remains: ${path}`);
}
async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => {
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
  if (!name.startsWith('docs/plan/') && !name.startsWith('tests/') && !name.endsWith('_test.go')) {
    assert.doesNotMatch(content, /assets\/(img|thumbs)\//, `obsolete image reference in ${name}`);
    assert.doesNotMatch(content, /ClientProvided|NewGeneratorFromClientConfig|describeVisualFeatures|loadLegacyConfig|security\.GetService/, `legacy behavior in ${name}`);
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
assert.match(await text('compose.yaml'), /127\.0\.0\.1:3000:8080/);
assert.doesNotMatch(await text('.github/workflows/backend-ci.yml'), /setup-go|go-version/);
assert.doesNotMatch(await text('backend/manifest/docker/Dockerfile'), /config\*|COPY \. \./);
console.log(`Project structure, all roadmap task IDs, source cleanup and documentation links passed (${allFiles.length} files)`);

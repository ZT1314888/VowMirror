import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, resolve } from 'node:path';

const require = createRequire('/opt/image-tools/package.json');
const sharp = require('sharp');
const manifestPath = process.argv[2];
assert.ok(manifestPath, 'Usage: node scripts/verify-private-intake.mjs <private intake.json>');
const directory = await realpath(dirname(resolve(manifestPath)));
const manifest = JSON.parse((await readFile(manifestPath, 'utf8')).replace(/^\uFEFF/, ''));
const expected = new Map([
  ...Array.from({ length: 2 }, (_, i) => [`C00${i + 1}`, 'couple']),
  ...Array.from({ length: 9 }, (_, i) => [`S00${i + 1}`, 'scene']),
]);
assert.equal(manifest.assets.length, expected.size, 'Expected exactly 11 images');
const paths = new Set();
for (const asset of manifest.assets) {
  assert.ok(expected.has(asset.id), `Invalid or duplicate ID: ${asset.id}`);
  assert.equal(asset.role, expected.get(asset.id), `${asset.id}: invalid role`);
  expected.delete(asset.id);
  assert.match(asset.path, new RegExp(`^${asset.id}\\.(?:png|jpg|webp)$`));
  const path = await realpath(resolve(directory, asset.path));
  assert.equal(dirname(path), directory, `${asset.id}: file escapes intake directory`);
  paths.add(asset.path);
  const bytes = await readFile(path);
  assert.ok(bytes.length > 0, `${asset.id}: empty image`);
  assert.equal(bytes.length, asset.bytes, `${asset.id}: byte count mismatch`);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256, `${asset.id}: SHA-256 mismatch`);
  const decoder = sharp(bytes, { failOn: 'warning' });
  const metadata = await decoder.metadata();
  const { info } = await decoder.raw().toBuffer({ resolveWithObject: true });
  const formats = { '.png': 'png', '.jpg': 'jpeg', '.webp': 'webp' };
  assert.equal(metadata.format, formats[extname(asset.path)], `${asset.id}: format mismatch`);
  assert.equal(metadata.pages ?? 1, 1, `${asset.id}: expected a single frame`);
  assert.ok(info.width > 0 && info.height > 0, `${asset.id}: invalid dimensions`);
  assert.equal(asset.format, metadata.format, `${asset.id}: recorded format mismatch`);
  assert.equal(asset.width, info.width, `${asset.id}: recorded width mismatch`);
  assert.equal(asset.height, info.height, `${asset.id}: recorded height mismatch`);
  console.log(`${asset.id}: ${metadata.format} ${info.width}x${info.height}, decoded, SHA-256 matched`);
}
assert.equal(expected.size, 0, 'Missing IDs');
assert.deepEqual((await readdir(directory)).sort(), [...paths, 'intake.json'].sort(), 'Unlisted intake files');
console.log('Private intake passed: 2 couple images and 9 scene images; no model calls');

import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

test('public sample assets are an exact, licensed, metadata-free allowlist', async () => {
  const base = new URL('../web/public/', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('manifest.json', base), 'utf8'));
  assert.equal(manifest.version, 1);
  assert.deepEqual(manifest.outfitThumbnails, [], 'no unverified outfit image may claim a real catalog match');
  assert.deepEqual((await readdir(base)).sort(), ['florals.jpg', 'fonts', 'manifest.json', 'wedding-example.jpg']);
  assert.deepEqual((await readdir(new URL('fonts', base))).sort(), [
    'OFL-cormorant-garamond.txt',
    'OFL-noto-serif-sc.txt',
    'cg-italic-latin.woff2',
    'cg-var-latin.woff2',
    'noto-serif-sc-400.woff2',
    'noto-serif-sc-600.woff2',
  ]);
  assert.deepEqual(manifest.assets.map(asset => asset.file).sort(), ['florals.jpg', 'wedding-example.jpg']);
  for (const asset of manifest.assets) {
    assert.equal(asset.license, 'CC0-1.0');
    assert.equal(new URL(asset.source).hostname, 'commons.wikimedia.org');
    assert.equal(asset.licenseURL, 'https://creativecommons.org/publicdomain/zero/1.0/');
    assert.ok(asset.creator && asset.transformation && asset.verified === '2026-11-19');
    const data = await readFile(new URL(asset.file, base));
    assert.equal(createHash('sha256').update(data).digest('hex'), asset.sha256, asset.file);
    assert.equal(data.readUInt16BE(0), 0xffd8);
    let offset = 2;
    while (data[offset + 1] !== 0xda) {
      assert.equal(data[offset], 0xff);
      assert.ok(![0xe1, 0xed, 0xfe].includes(data[offset + 1]), `${asset.file}: private image metadata must be absent`);
      offset += 2 + data.readUInt16BE(offset + 2);
      assert.ok(offset < data.length, 'valid JPEG marker bounds');
    }
  }
});

test('self-hosted display fonts are OFL-licensed with recorded provenance', async () => {
  const base = new URL('../web/public/', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('manifest.json', base), 'utf8'));
  assert.equal(manifest.fonts.length, 4);
  const files = manifest.fonts.map(font => font.file).sort();
  assert.deepEqual(files, [
    'fonts/cg-italic-latin.woff2',
    'fonts/cg-var-latin.woff2',
    'fonts/noto-serif-sc-400.woff2',
    'fonts/noto-serif-sc-600.woff2',
  ]);
  for (const font of manifest.fonts) {
    assert.equal(font.license, 'OFL-1.1');
    assert.equal(font.licenseURL, 'https://openfontlicense.org/open-font-license-official-site/');
    assert.ok(font.creator && font.transformation && font.verified === '2026-11-21', font.file);
    const license = await readFile(new URL(font.licenseFile, base), 'utf8');
    assert.match(license, /SIL OPEN FONT LICENSE/, `${font.licenseFile} must carry the actual OFL text`);
    const data = await readFile(new URL(font.file, base));
    assert.equal(createHash('sha256').update(data).digest('hex'), font.sha256, font.file);
    assert.equal(data.subarray(0, 4).toString(), 'wOF2', `${font.file} must be a woff2 container`);
  }
});

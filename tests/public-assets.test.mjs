import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

test('public sample assets are an exact, licensed, metadata-free allowlist', async () => {
  const base = new URL('../web/public/', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('manifest.json', base), 'utf8'));
  assert.equal(manifest.version, 1);
  assert.deepEqual((await readdir(base)).sort(), ['florals.jpg', 'fonts', 'invitation-opening-petals.mp3', 'manifest.json', 'outfits', 'venues', 'wedding-example.jpg']);
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

test('30 outfit previews exactly match catalog IDs with verified, metadata-free WebP files', async () => {
  const base = new URL('../web/public/', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('manifest.json', base), 'utf8'));
  const catalog = JSON.parse(await readFile(new URL('../assets/wedding/manifest.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.outfitPreviews.map(item => item.id), catalog.outfits.map(item => item.id));
  const expected = [];
  for (const entry of manifest.outfitPreviews) {
    assert.equal(entry.role, 'outfit-example-only');
    assert.match(entry.source, /User-provided pre-rendered/);
    assert.equal(entry.focus.length, 2);
    assert.ok(entry.focus.every(value => Number.isFinite(value) && value >= 0 && value <= 1));
    for (const [kind, suffix, size] of [['display', '', [2400, 1040]], ['thumbnail', '-thumb', [320, 240]]]) {
      const asset = entry[kind];
      const file = `${entry.id}${suffix}.webp`;
      expected.push(file);
      assert.equal(asset.file, `outfits/${file}`);
      assert.deepEqual([asset.width, asset.height], size);
      const bytes = await readFile(new URL(asset.file, base));
      assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256);
      assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
      assert.equal(bytes.toString('ascii', 8, 12), 'WEBP');
      assert.equal(bytes.readUInt32LE(4) + 8, bytes.length);
      let offset = 12;
      const chunks = [];
      while (offset < bytes.length) {
        const type = bytes.toString('ascii', offset, offset + 4);
        chunks.push(type);
        const length = bytes.readUInt32LE(offset + 4);
        offset += 8 + length + (length % 2);
        assert.ok(offset <= bytes.length);
      }
      assert.ok(chunks.includes('VP8 ') || chunks.includes('VP8L'));
      assert.ok(!chunks.some(chunk => ['EXIF', 'XMP ', 'ICCP'].includes(chunk)), file);
    }
  }
  assert.deepEqual((await readdir(new URL('outfits/', base))).sort(), expected.sort());
});

test('invitation audio matches the approved CC0 mix and records both original sources', async () => {
  const base = new URL('../web/public/', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('manifest.json', base), 'utf8'));
  assert.equal(manifest.audio.length, 1);
  const [audio] = manifest.audio;
  assert.equal(audio.file, 'invitation-opening-petals.mp3');
  assert.equal(audio.license, 'CC0-1.0');
  assert.equal(audio.durationSeconds, 2.6);
  assert.deepEqual(audio.sources.map(source => source.source), [
    'https://freesound.org/people/AardsReal/sounds/842183/',
    'https://freesound.org/people/lukabea/sounds/660493/',
  ]);
  for (const source of audio.sources) {
    assert.equal(source.license, 'CC0-1.0');
    assert.equal(source.licenseURL, 'https://creativecommons.org/publicdomain/zero/1.0/');
    assert.ok(source.creator && source.title && source.download && source.trimSeconds.length === 2);
  }
  const data = await readFile(new URL(audio.file, base));
  assert.equal(createHash('sha256').update(data).digest('hex'), audio.sha256);
});

test('venue previews match the catalog venue IDs with verified, metadata-free WebP files', async () => {
  const base = new URL('../web/public/', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('manifest.json', base), 'utf8'));
  const catalog = JSON.parse(await readFile(new URL('../assets/wedding/manifest.json', import.meta.url), 'utf8'));
  assert.ok(catalog.venues.length > 0);
  assert.deepEqual(manifest.venuePreviews.map(item => item.id), catalog.venues.map(item => item.id));
  const expected = [];
  for (const entry of manifest.venuePreviews) {
    assert.match(entry.id, /^V00[1-7]$/);
    assert.equal(entry.role, 'venue-example-only');
    assert.match(entry.source, /User-provided venue photo/);
    assert.equal(entry.focus.length, 2);
    assert.ok(entry.focus.every(value => Number.isFinite(value) && value >= 0 && value <= 1));
    for (const [kind, suffix, size] of [['display', '', [2400, 1600]], ['thumbnail', '-thumb', [320, 240]]]) {
      const asset = entry[kind];
      const file = `${entry.id}${suffix}.webp`;
      expected.push(file);
      assert.equal(asset.file, `venues/${file}`);
      assert.deepEqual([asset.width, asset.height], size);
      const bytes = await readFile(new URL(asset.file, base));
      assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256);
      assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
      assert.equal(bytes.toString('ascii', 8, 12), 'WEBP');
      let offset = 12;
      const chunks = [];
      while (offset < bytes.length) {
        const type = bytes.toString('ascii', offset, offset + 4);
        chunks.push(type);
        const length = bytes.readUInt32LE(offset + 4);
        offset += 8 + length + (length % 2);
        assert.ok(offset <= bytes.length);
      }
      assert.ok(chunks.includes('VP8 ') || chunks.includes('VP8L'));
      assert.ok(!chunks.some(chunk => ['EXIF', 'XMP ', 'ICCP'].includes(chunk)), file);
    }
  }
  assert.deepEqual((await readdir(new URL('venues/', base))).sort(), expected.sort());
});

test('venue preview ids keep one expression across the Nginx allowlist, frontend, manifest check and build context', async () => {
  const pattern = '^/web/public/venues/V00[1-7](-thumb)?\\.webp$';
  const nginx = await readFile(new URL('../docker/nginx.conf', import.meta.url), 'utf8');
  // Nginx applies the first regex location that matches, so the venue rule must admit exactly this id set.
  assert.ok(nginx.includes(`location ~ ${pattern} {`), 'nginx venue location');
  assert.ok(nginx.includes(`"~${pattern}" "public, max-age=31536000, immutable";`), 'venue cache policy');
  const app = await readFile(new URL('../web/app.mjs', import.meta.url), 'utf8');
  assert.ok(app.includes('const VENUE_ID_PATTERN = /^V00[1-7]$/;'));
  const bootstrap = await readFile(new URL('../scripts/verify-wedding-assets.mjs', import.meta.url), 'utf8');
  assert.ok(bootstrap.includes('export const VENUE_ID_PATTERN = /^V00[1-7]$/;'));
  for (const id of ['V001', 'V004', 'V007']) assert.ok(/^V00[1-7]$/.test(id), id);
  for (const id of ['V000', 'V008', 'V099', 'v001', 'V01', 'V0010']) assert.ok(!/^V00[1-7]$/.test(id), id);
  const ignore = await readFile(new URL('../.dockerignore', import.meta.url), 'utf8');
  assert.match(ignore, /^web\/public\/venues\/\*\*$/m);
  assert.match(ignore, /^!web\/public\/venues\/V00\[1-7\]\.webp$/m);
  assert.match(ignore, /^!web\/public\/venues\/V00\[1-7\]-thumb\.webp$/m);
  const dockerfile = await readFile(new URL('../docker/web.Dockerfile', import.meta.url), 'utf8');
  assert.match(dockerfile, /rmdir \/usr\/share\/nginx\/html\/web\/public\/venues/);
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

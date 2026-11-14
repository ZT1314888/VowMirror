import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { EXPECTED_OUTFIT_COUNT, EXPECTED_POSE_COUNT, OUTFIT_IDS, POSE_IDS, ROLE_FIELDS, validateManifest, validateManifestFiles, validateManifestText } from '../scripts/verify-wedding-assets.mjs';

const scriptPath = fileURLToPath(new URL('../scripts/verify-wedding-assets.mjs', import.meta.url));
const fixturePath = fileURLToPath(new URL('./fixtures/wedding-assets-manifest.json', import.meta.url));
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
const contractCases = JSON.parse(await readFile(new URL('./fixtures/wedding-assets-contract.json', import.meta.url), 'utf8'));

function buildManifest() {
  return structuredClone(fixture);
}

for (const scenario of contractCases) {
  test(`shared catalog contract: ${scenario.name}`, () => {
    const manifest = buildManifest();
    for (const collection of scenario.reverse ?? []) manifest[collection].reverse();
    for (const change of scenario.changes ?? []) {
      const segments = change.path.split('/');
      const key = segments.pop();
      const parent = segments.reduce((value, segment) => value[segment], manifest);
      if (!change.remove) parent[key] = structuredClone(change.value);
      else if (Array.isArray(parent)) parent.splice(Number(key), 1);
      else delete parent[key];
    }
    let text = JSON.stringify(manifest);
    for (const change of scenario.textChanges ?? []) {
      assert.ok(text.includes(change.from), `missing text fixture target: ${change.from}`);
      text = text.replace(change.from, change.to);
    }
    const problems = validateManifestText(text);
    assert.equal(problems.length === 0, scenario.valid, problems.join('\n'));
  });
}

function problemsOf(manifest) {
  return validateManifest(manifest);
}

test('valid manifest structure passes with 30 outfits and 90 unique paths', () => {
  const problems = problemsOf(buildManifest());
  assert.deepEqual(problems, []);
});

test('committed project fixture is a valid manifest', async () => {
  const text = await readFile(fixturePath, 'utf8');
  assert.deepEqual(validateManifestText(text), []);
});

test('missing or duplicated outfit ids are rejected', () => {
  const withoutOne = buildManifest();
  const removed = withoutOne.outfits.splice(6, 1)[0];
  const missingProblems = problemsOf(withoutOne);
  assert.ok(missingProblems.some(problem => problem.includes(`缺少套装编号`) && problem.includes(removed.id)), missingProblems.join('\n'));
  assert.ok(missingProblems.some(problem => problem.includes('套装数量必须为 30，当前为 29')));

  const duplicated = buildManifest();
  duplicated.outfits[4] = { ...duplicated.outfits[3], dress: 'W004/dress2.png', menswear: 'W004/menswear2.png', shoes_detail: 'W004/shoes_detail2.png' };
  const duplicateProblems = problemsOf(duplicated);
  assert.ok(duplicateProblems.some(problem => problem.includes('套装 id 重复：W004')), duplicateProblems.join('\n'));
});

test('out-of-range or malformed ids are rejected', () => {
  const manifest = buildManifest();
  manifest.outfits[29].id = 'W031';
  const problems = problemsOf(manifest);
  assert.ok(problems.some(problem => problem.includes('id 必须匹配') && problem.includes('W031')), problems.join('\n'));

  const bad = buildManifest();
  bad.outfits[0].id = 'w001';
  assert.ok(problemsOf(bad).some(problem => problem.includes('w001')));
});

test('missing image fields or wrong types are rejected', () => {
  const missingField = buildManifest();
  delete missingField.outfits[0].shoes_detail;
  assert.ok(problemsOf(missingField).some(problem => problem.includes('W001 的 shoes_detail 必须是非空字符串')));

  const emptyName = buildManifest();
  emptyName.outfits[2].name = '   ';
  assert.ok(problemsOf(emptyName).some(problem => problem.includes('W003 的 name 必须是非空字符串')));

  const wrongType = buildManifest();
  wrongType.outfits[1].dress = 7;
  assert.ok(problemsOf(wrongType).some(problem => problem.includes('W002 的 dress 必须是非空字符串')));

  const unknownField = buildManifest();
  unknownField.outfits[0].extra = 'x';
  assert.ok(problemsOf(unknownField).some(problem => problem.includes('未知字段：extra')));

  const badVersion = buildManifest();
  badVersion.version = '1';
  assert.ok(problemsOf(badVersion).some(problem => problem.includes('version 必须为 1')));
});

test('shared or duplicated paths across outfits are rejected', () => {
  const manifest = buildManifest();
  manifest.outfits[1].dress = manifest.outfits[0].dress;
  const problems = problemsOf(manifest);
  assert.ok(problems.some(problem => problem.includes('路径被跨套共享') && problem.includes('W001/dress.png')), problems.join('\n'));
});

test('paths outside the matching outfit directory are rejected', () => {
  const manifest = buildManifest();
  manifest.outfits[2].dress = 'W004/dress_w003.png';
  const problems = problemsOf(manifest);
  assert.ok(problems.some(problem => problem.includes('W003 的 dress 必须位于对应子目录 W003/ 内')), problems.join('\n'));
});

test('absolute paths, path escapes and URLs are rejected', () => {
  for (const [field, value] of [
    ['dress', '/assets/W001/dress.png'],
    ['dress', 'C:/W001/dress.png'],
    ['menswear', 'W001/../W002/menswear.png'],
    ['menswear', 'W001/./menswear.png'],
    ['shoes_detail', 'https://example.com/W001/shoes_detail.png'],
    ['dress', 'W001\\dress.png'],
  ]) {
    const manifest = buildManifest();
    manifest.outfits[0][field] = value;
    const problems = problemsOf(manifest);
    assert.ok(problems.length > 0, `${field}=${value} must be rejected`);
  }
});

test('wrong file extensions are rejected', () => {
  const manifest = buildManifest();
  manifest.outfits[0].menswear = 'W001/menswear.gif';
  assert.ok(problemsOf(manifest).some(problem => problem.includes('扩展名必须是 .png .jpg .jpeg .webp 之一')));
});

test('invalid JSON fails with a readable error', () => {
  assert.throws(() => validateManifestText('{bad json'), /清单不是合法 JSON/);
  assert.throws(() => validateManifestText('[]'), /顶层必须是 JSON 对象/);
});

test('CLI exits zero for the valid fixture and non-zero with readable errors otherwise', async t => {
  const valid = spawnSync(process.execPath, [scriptPath, fixturePath], { encoding: 'utf8' });
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /结构校验通过/);
  assert.match(valid.stdout, /不验证文件存在、内容或许可/);

  const help = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8' });
  assert.equal(help.status, 1);
  assert.match(help.stdout, /用法：node scripts\/verify-wedding-assets\.mjs/);
  assert.match(help.stdout, /禁止提交仓库/);

  const directory = await mkdtemp(join(tmpdir(), 'wedding-manifest-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const invalidJsonPath = join(directory, 'invalid.json');
  await writeFile(invalidJsonPath, '{oops');
  const invalidJson = spawnSync(process.execPath, [scriptPath, invalidJsonPath], { encoding: 'utf8' });
  assert.equal(invalidJson.status, 1);
  assert.match(invalidJson.stderr, /清单不是合法 JSON/);

  const invalidStructurePath = join(directory, 'invalid-structure.json');
  const manifest = buildManifest();
  manifest.outfits[0].dress = 'W002/dress.png';
  await writeFile(invalidStructurePath, JSON.stringify(manifest));
  const invalidStructure = spawnSync(process.execPath, [scriptPath, invalidStructurePath], { encoding: 'utf8' });
  assert.equal(invalidStructure.status, 1);
  assert.match(invalidStructure.stderr, /婚礼素材清单校验失败/);
  assert.match(invalidStructure.stderr, /必须位于对应子目录 W001\/ 内/);

  const unreadable = spawnSync(process.execPath, [scriptPath, join(directory, 'missing.json')], { encoding: 'utf8' });
  assert.equal(unreadable.status, 1);
  assert.match(unreadable.stderr, /无法读取清单/);
});

test('manifest contract expects 30 outfits with three role files', () => {
  assert.equal(EXPECTED_OUTFIT_COUNT, 30);
  assert.deepEqual(ROLE_FIELDS, ['dress', 'menswear', 'shoes_detail']);
});

test('pose catalog accepts exactly the 30 controlled pose ids', () => {
  const manifest = buildManifest();
  manifest.poses = POSE_IDS.map(id => ({ id, name: `姿势 ${id}`, path: `poses/${id}.png`, status: 'unverified' }));
  assert.equal(EXPECTED_POSE_COUNT, 30);
  assert.deepEqual(validateManifest(manifest), []);

  manifest.poses[0].path = 'poses/P002.png';
  assert.ok(validateManifest(manifest).some(problem => problem.includes('姿势路径重复')));
});

test('file validation rejects references outside the manifest directory', () => {
  const manifest = buildManifest();
  manifest.outfits[0].dress = '../outside.jpg';
  assert.ok(validateManifestFiles(manifest, '/tmp/assets').some(problem => problem.includes('越出清单目录')));
});

test('file checks accept real PNG, JPEG and WebP and reject missing, empty or mismatched files', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wedding-files-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manifest = buildManifest();
  const formats = ['png', 'jpg', 'webp'];
  const images = await Promise.all(formats.map(format => readFile(new URL(`../backend/internal/imagevalidate/testdata/checker.${format}`, import.meta.url))));
  for (const outfit of manifest.outfits) {
    await mkdir(join(directory, outfit.id));
    for (const [index, field] of ROLE_FIELDS.entries()) {
      outfit[field] = `${outfit.id}/${field}.${formats[index]}`;
      await writeFile(join(directory, outfit[field]), images[index]);
    }
  }
  await mkdir(join(directory, 'poses'));
  for (const pose of manifest.poses) await writeFile(join(directory, pose.path), images[0]);
  const path = join(directory, 'manifest.json');
  await writeFile(path, JSON.stringify(manifest));
  assert.deepEqual(validateManifestFiles(manifest, directory), []);
  const valid = spawnSync(process.execPath, [scriptPath, path, '--check-files'], { encoding: 'utf8' });
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /已校验文件存在、非空及格式签名/);
  assert.doesNotMatch(valid.stdout, /不验证文件存在/);

  await rm(join(directory, manifest.outfits[0].dress));
  await writeFile(join(directory, manifest.outfits[0].menswear), Buffer.alloc(0));
  await writeFile(join(directory, manifest.outfits[0].shoes_detail), images[0]);
  const problems = validateManifestFiles(manifest, directory);
  assert.equal(problems.length, 3);
  assert.ok(problems.some(problem => problem.includes('不存在')));
  assert.ok(problems.some(problem => problem.includes('非空普通文件')));
  assert.ok(problems.some(problem => problem.includes('格式与扩展名不匹配')));
  const invalid = spawnSync(process.execPath, [scriptPath, path, '--check-files'], { encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /婚礼素材文件校验失败/);
});

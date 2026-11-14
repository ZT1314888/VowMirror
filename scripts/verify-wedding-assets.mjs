// 婚礼素材清单结构校验器（P2-A2）。
// 默认校验清单结构；--check-files 额外检查文件存在、非空及格式签名。
// 文件签名不证明素材内容、授权或模型效果。
// 仅使用 Node 内置模块，无第三方依赖。

import { readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const EXPECTED_OUTFIT_COUNT = 30;
export const OUTFIT_IDS = Array.from({ length: EXPECTED_OUTFIT_COUNT }, (_, index) => `W${String(index + 1).padStart(3, '0')}`);
export const ROLE_FIELDS = ['dress', 'menswear', 'shoes_detail'];
export const EXPECTED_POSE_COUNT = 30;
export const POSE_IDS = Array.from({ length: EXPECTED_POSE_COUNT }, (_, index) => `P${String(index + 1).padStart(3, '0')}`);
const ALLOWED_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'];
const MANIFEST_KEYS = ['version', 'outfits', 'poses'];
const OUTFIT_KEYS = ['id', 'name', ...ROLE_FIELDS];
const ID_PATTERN = /^W\d{3}$/;
const POSE_ID_PATTERN = /^P\d{3}$/;

const USAGE = `用法：node scripts/verify-wedding-assets.mjs <manifest.json> [--check-files]

校验婚礼素材清单的结构。清单结构约定（唯一清单：assets/wedding/manifest.json）：
{
  "version": 1,
  "outfits": [
    { "id": "W001", "name": "套装名称",
      "dress": "W001/dress.png",
      "menswear": "W001/menswear.png",
      "shoes_detail": "W001/shoes_detail.png" }
  ],
  "poses": [
    { "id": "P001", "name": "姿势 P001", "path": "poses/P001.png", "status": "unverified" }
  ]
}

规则：
- 共 ${EXPECTED_OUTFIT_COUNT} 套，id 必须完整覆盖 ${OUTFIT_IDS[0]}..${OUTFIT_IDS[EXPECTED_OUTFIT_COUNT - 1]}，不得重复、缺失或越界。
- 每套含 name 和三个角色文件字段：${ROLE_FIELDS.join('、')}。
- 路径相对素材根目录（清单所在目录），必须位于对应 id 同名子目录内。
- 拒绝绝对路径、盘符、URL、".."/"." 段、反斜杠和错误扩展名（允许：${ALLOWED_EXTENSIONS.join(' ')}）。
- 全部路径不得重复或跨套共享。
- poses 必须完整覆盖 P001..P030，路径为 poses/Pxxx.png，status 为 unverified；两个数组均不要求排序。

注意：默认只做结构校验，不验证文件存在、内容与许可；传入 --check-files 时会检查清单引用的文件存在、非空及 PNG/JPEG/WebP 签名。
私有照片（人物肖像、场地等）禁止提交仓库，私密素材目录已被根 .gitignore 忽略。`;

export function parseManifestText(text) {
  let manifest;
  try {
    manifest = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`清单不是合法 JSON：${error.message}`);
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('清单顶层必须是 JSON 对象');
  }
  return manifest;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkPathField(outfitId, field, value, problems) {
  if (typeof value !== 'string' || value.trim() === '') {
    problems.push(`${outfitId} 的 ${field} 必须是非空字符串`);
    return;
  }
  if (value.includes('\\')) {
    problems.push(`${outfitId} 的 ${field} 路径不得使用反斜杠，必须以 / 分隔：${value}`);
    return;
  }
  if (value.startsWith('/') || value.startsWith('//') || /^[A-Za-z]:/.test(value)) {
    problems.push(`${outfitId} 的 ${field} 不得是绝对路径：${value}`);
    return;
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) || value.includes('://')) {
    problems.push(`${outfitId} 的 ${field} 不得是 URL：${value}`);
    return;
  }
  const segments = value.split('/');
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    problems.push(`${outfitId} 的 ${field} 含空段或 ".."/"." 段，不得逃逸素材目录：${value}`);
    return;
  }
  if (segments[0] !== outfitId) {
    problems.push(`${outfitId} 的 ${field} 必须位于对应子目录 ${outfitId}/ 内：${value}`);
    return;
  }
  const filename = segments[segments.length - 1];
  if (segments.length < 2 || !ALLOWED_EXTENSIONS.some(ext => filename.toLowerCase().endsWith(ext))) {
    problems.push(`${outfitId} 的 ${field} 扩展名必须是 ${ALLOWED_EXTENSIONS.join(' ')} 之一：${value}`);
  }
}

function checkPosePathField(poseId, value, problems) {
  if (typeof value !== 'string' || value.trim() === '') {
    problems.push(`${poseId} 的 path 必须是非空字符串`);
    return;
  }
  if (value.includes('\\') || value.startsWith('/') || value.startsWith('//') || /^[A-Za-z]:/.test(value) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) || value.includes('://')) {
    problems.push(`${poseId} 的 path 必须是素材根目录下的相对路径：${value}`);
    return;
  }
  const segments = value.split('/');
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..') || segments[0] !== 'poses') {
    problems.push(`${poseId} 的 path 必须位于 poses/ 目录内：${value}`);
    return;
  }
  const filename = segments.at(-1);
  if (segments.length !== 2 || filename !== `${poseId}.png`) {
    problems.push(`${poseId} 的 path 必须是 poses/${poseId}.png：${value}`);
  }
}

// 返回问题列表；空数组表示结构合法。不读取任何真实文件。
export function validateManifest(manifest) {
  const problems = [];
  for (const key of Object.keys(manifest)) {
    if (!MANIFEST_KEYS.includes(key)) problems.push(`清单存在未知字段：${key}`);
  }
  if (manifest.version !== 1) problems.push(`清单 version 必须为 1，当前为 ${JSON.stringify(manifest.version)}`);
  if (!Array.isArray(manifest.outfits)) {
    problems.push('清单 outfits 必须是数组');
    return problems;
  }

  const seenIds = new Map();
  const seenPaths = new Map();
  for (const [index, outfit] of manifest.outfits.entries()) {
    const position = `outfits[${index}]`;
    if (!isPlainObject(outfit)) {
      problems.push(`${position} 必须是对象`);
      continue;
    }
    for (const key of Object.keys(outfit)) {
      if (!OUTFIT_KEYS.includes(key)) problems.push(`${position} 存在未知字段：${key}`);
    }
    const id = outfit.id;
    let idForPath = position;
    if (typeof id !== 'string' || !ID_PATTERN.test(id) || !OUTFIT_IDS.includes(id)) {
      problems.push(`${position} 的 id 必须匹配 ${OUTFIT_IDS[0]}..${OUTFIT_IDS[EXPECTED_OUTFIT_COUNT - 1]} 形式，当前为 ${JSON.stringify(id)}`);
    } else if (seenIds.has(id)) {
      problems.push(`套装 id 重复：${id}（首次出现在 outfits[${seenIds.get(id)}]）`);
      idForPath = id;
    } else {
      seenIds.set(id, index);
      idForPath = id;
    }
    if (typeof outfit.name !== 'string' || outfit.name.trim() === '') {
      problems.push(`${idForPath} 的 name 必须是非空字符串`);
    }
    for (const field of ROLE_FIELDS) checkPathField(idForPath, field, outfit[field], problems);
    for (const field of ROLE_FIELDS) {
      const path = outfit[field];
      if (typeof path === 'string' && path !== '') {
        if (seenPaths.has(path)) {
          problems.push(`路径被跨套共享：${path}（${seenPaths.get(path)} 与 ${idForPath}.${field}）`);
        } else {
          seenPaths.set(path, `${idForPath}.${field}`);
        }
      }
    }
  }

  const missing = OUTFIT_IDS.filter(id => !seenIds.has(id));
  if (missing.length > 0) problems.push(`缺少套装编号：${missing.join('、')}`);
  if (manifest.outfits.length !== EXPECTED_OUTFIT_COUNT) {
    problems.push(`套装数量必须为 ${EXPECTED_OUTFIT_COUNT}，当前为 ${manifest.outfits.length}`);
  }

  if (!Array.isArray(manifest.poses)) {
    problems.push('清单 poses 必须是数组');
    return problems;
  }
  const seenPoseIds = new Set();
  const seenPosePaths = new Set();
  for (const [index, pose] of manifest.poses.entries()) {
    const position = `poses[${index}]`;
    if (!isPlainObject(pose)) {
      problems.push(`${position} 必须是对象`);
      continue;
    }
    for (const key of Object.keys(pose)) {
      if (!['id', 'name', 'path', 'status'].includes(key)) problems.push(`${position} 存在未知字段：${key}`);
    }
    const id = pose.id;
    if (typeof id !== 'string' || !POSE_ID_PATTERN.test(id) || !POSE_IDS.includes(id)) {
      problems.push(`${position} 的 id 必须匹配 ${POSE_IDS[0]}..${POSE_IDS.at(-1)}，当前为 ${JSON.stringify(id)}`);
    } else if (seenPoseIds.has(id)) {
      problems.push(`姿势 id 重复：${id}`);
    } else {
      seenPoseIds.add(id);
    }
    if (typeof pose.name !== 'string' || pose.name.trim() === '') problems.push(`${id || position} 的 name 必须是非空字符串`);
    if (pose.status !== 'unverified') problems.push(`${id || position} 的 status 必须为 unverified`);
    checkPosePathField(id || position, pose.path, problems);
    if (typeof pose.path === 'string' && seenPosePaths.has(pose.path)) problems.push(`姿势路径重复：${pose.path}`);
    else if (typeof pose.path === 'string') seenPosePaths.add(pose.path);
  }
  const missingPoses = POSE_IDS.filter(id => !seenPoseIds.has(id));
  if (missingPoses.length > 0) problems.push(`缺少姿势编号：${missingPoses.join('、')}`);
  if (manifest.poses.length !== EXPECTED_POSE_COUNT) problems.push(`姿势数量必须为 ${EXPECTED_POSE_COUNT}，当前为 ${manifest.poses.length}`);
  return problems;
}

export function validateManifestText(text) {
  return validateManifest(parseManifestText(text));
}

function assetEntries(manifest) {
  const entries = manifest.outfits.flatMap(outfit => ROLE_FIELDS.map(field => ({ path: outfit[field], kind: 'image' })));
  if (Array.isArray(manifest.poses)) entries.push(...manifest.poses.map(pose => ({ path: pose.path, kind: 'image' })));
  return entries;
}

function hasValidSignature(buffer, path) {
  const lower = path.toLowerCase();
  if (lower.endsWith('.png')) return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (lower.endsWith('.webp')) return buffer.length >= 12 && buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP';
  return false;
}

export function validateManifestFiles(manifest, rootDirectory) {
  const problems = [];
  const root = resolve(rootDirectory);
  for (const { path } of assetEntries(manifest)) {
    if (typeof path !== 'string') continue;
    const target = resolve(root, path);
    const relativePath = relative(root, target);
    if (relativePath.startsWith('..') || relativePath.includes(`..${'\\'}`)) {
      problems.push(`素材路径越出清单目录：${path}`);
      continue;
    }
    let stats;
    try {
      stats = statSync(target);
    } catch {
      problems.push(`素材文件不存在：${path}`);
      continue;
    }
    if (!stats.isFile() || stats.size === 0) {
      problems.push(`素材文件必须是非空普通文件：${path}`);
      continue;
    }
    const buffer = readFileSync(target);
    if (!hasValidSignature(buffer, path)) problems.push(`素材文件格式与扩展名不匹配：${path}`);
  }
  return problems;
}

function runCli(argv) {
  const checkFiles = argv.includes('--check-files');
  const target = argv.find(value => value !== '--check-files');
  if (!target || target === '--help' || target === '-h') {
    console.log(USAGE);
    return target ? 0 : 1;
  }
  let text;
  try {
    text = readFileSync(target, 'utf8');
  } catch (error) {
    console.error(`无法读取清单 ${target}：${error.message}`);
    return 1;
  }
  let problems;
  try {
    problems = validateManifestText(text);
  } catch (error) {
    console.error(`婚礼素材清单校验失败：${target}\n  - ${error.message}`);
    return 1;
  }
  if (problems.length > 0) {
    console.error(`婚礼素材清单校验失败：${target}\n${problems.map(problem => `  - ${problem}`).join('\n')}`);
    return 1;
  }
  if (checkFiles) {
    const fileProblems = validateManifestFiles(parseManifestText(text), dirname(resolve(target)));
    if (fileProblems.length > 0) {
      console.error(`婚礼素材文件校验失败：${target}\n${fileProblems.map(problem => `  - ${problem}`).join('\n')}`);
      return 1;
    }
    console.log('素材文件存在、非空且文件签名与扩展名匹配。');
  }
  console.log(`婚礼素材清单结构校验通过：${target}（${EXPECTED_OUTFIT_COUNT} 套服装、${EXPECTED_POSE_COUNT} 个姿势，共 ${EXPECTED_OUTFIT_COUNT * ROLE_FIELDS.length + EXPECTED_POSE_COUNT} 个路径）。`);
  console.log(checkFiles
    ? '已校验文件存在、非空及格式签名；不验证图片内容、许可或模型效果；私有照片禁止提交仓库。'
    : '仅校验清单结构，不验证文件存在、内容或许可；私有照片禁止提交仓库。');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(runCli(process.argv.slice(2)));
}

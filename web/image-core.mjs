// Shared image helpers; no settings, storage, or network dependencies.
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export function detectImageMimeFromBytes(bytes) {
  if (bytes.length >= 8 && bytes.slice(0, 8).every((b, i) => b === [137, 80, 78, 71, 13, 10, 26, 10][i])) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') return 'image/webp';
  return '';
}

export function normalizeImageMime(value) {
  const mime = String(value ?? '').toLowerCase().split(';')[0].trim();
  if (mime === 'image/jpg') return 'image/jpeg';
  return ['image/png', 'image/jpeg', 'image/webp'].includes(mime) ? mime : '';
}

export function imageExtensionForMime(value) {
  const extensions = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
  const extension = extensions[normalizeImageMime(value)];
  if (!extension) throw new Error('不支持的图片格式');
  return extension;
}

function decodeImage(value) {
  const base64 = String(value ?? '').replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
  if (!base64) throw new Error('图片为空');
  if (base64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw new Error('图片超过 8 MiB');
  const binary = atob(base64);
  if (binary.length > MAX_IMAGE_BYTES) throw new Error('图片超过 8 MiB');
  return { base64, bytes: Uint8Array.from(binary, char => char.charCodeAt(0)) };
}

export function detectImageMimeFromBase64(value) {
  return detectImageMimeFromBytes(decodeImage(value).bytes);
}

export function resolveResultImageInfo(value, declaredMime = '') {
  const { base64, bytes } = decodeImage(value);
  const mime = detectImageMimeFromBytes(bytes);
  if (!mime) throw new Error('不支持的结果图片');
  return { b64: base64, mime, declaredMime: normalizeImageMime(declaredMime), extension: imageExtensionForMime(mime) };
}

export function createResultImageDataUrl(info) {
  return `data:${info.mime};base64,${info.b64}`;
}

export async function readImageFile(file) {
  if (!(file instanceof Blob) || !file.size) throw new Error('图片为空');
  if (file.size > MAX_IMAGE_BYTES) throw new Error('图片超过 8 MiB');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = detectImageMimeFromBytes(bytes);
  if (!mime) throw new Error('不支持的图片格式');
  if (file.type && normalizeImageMime(file.type) !== mime) throw new Error('图片声明与真实格式不一致');
  // Chunking avoids passing a large argument list to String.fromCharCode.
  let binary = '';
  const chunkSize = 8192;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return { bytes, mime, base64: btoa(binary) };
}

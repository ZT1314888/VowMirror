import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { detectImageMimeFromBytes, detectImageMimeFromBase64, imageExtensionForMime, resolveResultImageInfo, createResultImageDataUrl, readImageFile } from '../web/image-core.mjs';
import { parseAPIResponse, getAPIError } from '../web/response-core.mjs';

// Module tests inject dimensions; actual PNG/JPEG/WebP decoding is verified in Chromium.
const decodeFixture = async () => ({ width: 384, height: 256, close() {} });

for (const [extension, mime] of [['png', 'image/png'], ['jpg', 'image/jpeg'], ['webp', 'image/webp']]) {
  test(`real ${extension} fixture preserves bytes and MIME`, async () => {
    const bytes = await readFile(new URL(`../backend/internal/imagevalidate/testdata/checker.${extension}`, import.meta.url));
    const b64 = bytes.toString('base64');
    assert.equal(detectImageMimeFromBytes(bytes), mime);
    assert.equal(detectImageMimeFromBase64(b64), mime);
    assert.equal(imageExtensionForMime(mime), extension);
    const result = resolveResultImageInfo(b64, 'image/png');
    assert.equal(result.mime, mime);
    assert.equal(createResultImageDataUrl(result), `data:${mime};base64,${b64}`);
    const input = await readImageFile(new Blob([bytes], { type: mime }), decodeFixture);
    assert.equal(input.base64, b64);
    assert.equal(input.mime, mime);
    assert.deepEqual(Buffer.from(input.bytes), bytes);
  });
}

test('invalid inputs fail explicitly', async () => {
  assert.throws(() => resolveResultImageInfo('cGxhaW4gdGV4dA=='), /不支持/);
  assert.throws(() => resolveResultImageInfo('!!invalid!!'));
  assert.throws(() => imageExtensionForMime('image/gif'), /不支持/);
  await assert.rejects(readImageFile(new Blob()), /为空/);
  const png = await readFile(new URL('../backend/internal/imagevalidate/testdata/checker.png', import.meta.url));
  await assert.rejects(readImageFile(new Blob([png], { type: 'image/jpeg' })), /不一致/);
  await assert.rejects(readImageFile(new Blob([new Uint8Array(8 * 1024 * 1024 + 1)])), /超过/);
});

test('decoded image dimensions and failures are explicit and release the bitmap', async () => {
  const png = await readFile(new URL('../backend/internal/imagevalidate/testdata/checker.png', import.meta.url));
  for (const [width, height, valid] of [[256,256,true],[8192,256,true],[4000,5000,true],[255,256,false],[256,255,false],[8193,256,false],[256,8193,false],[4001,5000,false]]) {
    let closed = false;
    const promise = readImageFile(new Blob([png]), async () => ({ width, height, close() { closed = true; } }));
    if (valid) assert.equal((await promise).width, width);
    else await assert.rejects(promise, /256–8192/);
    assert.equal(closed, true);
  }
  await assert.rejects(readImageFile(new Blob([png]), async () => { throw new Error('decode failure'); }), /无法解码/);
});

test('response parser accepts JSON and exposes malformed responses as errors', async () => {
  const body = { code: 0, data: { status: 'ok' } };
  assert.deepEqual(await parseAPIResponse(Response.json(body)), body);
  assert.deepEqual(await parseAPIResponse(new Response(JSON.stringify(body), { headers: { 'content-type': 'application/problem+json' } })), body);
  await assert.rejects(parseAPIResponse(new Response('<html>bad gateway</html>', { status: 502 })), /非 JSON/);
  await assert.rejects(parseAPIResponse(new Response('{bad', { headers: { 'content-type': 'application/json' } })));
  await assert.rejects(parseAPIResponse(Response.json(null)), /格式无效/);
});

test('error mapping does not display raw upstream messages', () => {
  assert.equal(getAPIError({ status: 401 }, null).code, 'AUTH_REQUIRED');
  assert.equal(getAPIError({ status: 413 }, null).code, 'REQUEST_TOO_LARGE');
  assert.equal(getAPIError({ status: 401 }, { data: { error_code: 'AUTH_INVALID' } }).code, 'AUTH_INVALID');
  assert.match(getAPIError({ status: 200 }, { data: { error_code: 'GENERATION_TIMEOUT' } }).text, /服务端时限/);
  assert.match(getAPIError({ status: 200 }, { data: { error_code: 'GENERATION_CANCELLED' } }).text, /已取消/);
  assert.equal(getAPIError({ status: 503 }, { data: { error_code: 'FACE_DETECTION_UNAVAILABLE' } }).text, '暂时无法检查合照，请稍后重试。');
  assert.doesNotMatch(getAPIError({ status: 502 }, { message: 'private-marker' }).text, /private-marker/);
});

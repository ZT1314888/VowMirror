import assert from 'node:assert/strict';
import { test } from 'node:test';
import { consumeSSE } from '../web/sse-core.mjs';

const encoder = new TextEncoder();
const requestId = 'synthetic-request-id';
const resultPayload = { code: 0, message: '', data: { request_id: requestId, image: 'cG5n', mime_type: 'image/png' } };
const errorPayload = { code: 50401, message: 'timeout', data: { error_code: 'GENERATION_TIMEOUT', request_id: requestId, http_status: 504 } };

function response(chunks, contentType = 'text/event-stream; charset=utf-8') {
  let index = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (index === chunks.length) controller.close();
      else controller.enqueue(chunks[index++]);
    },
  }), { headers: { 'content-type': contentType } });
}

function frame(name, payload) {
  return `event: ${name}\r\ndata: ${JSON.stringify(payload)}\r\n\r\n`;
}

test('parses UTF-8 split between bytes, CRLF, multiline data and consecutive events', async () => {
  const source = '\uFEFF' + [
    frame('status', { request_id: requestId, phase: '正在准备素材', elapsed_ms: 25, duration_ms: 8 }),
    frame('heartbeat', { request_id: requestId, elapsed_ms: 10_000 }),
    'event: status\ndata: {"request_id":"synthetic-request-id",\ndata: "phase":"首字节","elapsed_ms":10001}\n\n',
    frame('result', resultPayload),
  ].join('');
  const bytes = encoder.encode(source);
  const chunks = Array.from(bytes, (_, index) => bytes.slice(index, index + 1));
  const statuses = [];
  const terminal = await consumeSSE(response(chunks), { onStatus: value => statuses.push(value) });
  assert.equal(terminal.type, 'result');
  assert.deepEqual(terminal.payload, resultPayload);
  assert.deepEqual(statuses.map(value => value.phase), ['正在准备素材', '首字节']);
});

test('returns one controlled error terminal and preserves its HTTP status', async () => {
  const terminal = await consumeSSE(response([encoder.encode(frame('error', errorPayload))]));
  assert.equal(terminal.type, 'error');
  assert.equal(terminal.payload.data.http_status, 504);
});

test('rejects a stream with no terminal event or an incomplete final frame', async () => {
  const missing = response([encoder.encode(frame('status', { request_id: requestId, phase: 'dns_lookup', elapsed_ms: 4 }))]);
  await assert.rejects(consumeSSE(missing), error => error.code === 'STREAM_INTERRUPTED' && /缺少 result 或 error 终态/.test(error.message));
  const truncated = response([encoder.encode('event: result\ndata: ' + JSON.stringify(resultPayload))]);
  await assert.rejects(consumeSSE(truncated), /未完成的事件行/);
});

test('rejects malformed JSON, unknown events and events after a terminal frame', async () => {
  await assert.rejects(consumeSSE(response([encoder.encode('event: status\ndata: {bad}\n\n')])), /事件 JSON 格式错误/);
  await assert.rejects(consumeSSE(response([encoder.encode(frame('progress', {}))])), /未知事件 progress/);
  const duplicate = frame('result', resultPayload) + frame('error', errorPayload);
  await assert.rejects(consumeSSE(response([encoder.encode(duplicate)])), /终态事件之后仍有数据/);
});

test('rejects request identifier changes and malformed terminal contracts', async () => {
  const changed = frame('status', { request_id: requestId, phase: 'input', elapsed_ms: 1 })
    + frame('heartbeat', { request_id: 'another-request', elapsed_ms: 10_000 });
  await assert.rejects(consumeSSE(response([encoder.encode(changed)])), /请求标识发生变化/);
  const invalid = { ...resultPayload, data: { ...resultPayload.data, request_id: '' } };
  await assert.rejects(consumeSSE(response([encoder.encode(frame('result', invalid))])), /缺少请求标识/);
});

test('rejects event and total-stream byte limits', async () => {
  const largeEvent = encoder.encode(frame('status', { request_id: requestId, phase: 'input', elapsed_ms: 1 }));
  await assert.rejects(consumeSSE(response([largeEvent]), { maxEventBytes: 16 }), /单个事件超过 12 MiB/);
  await assert.rejects(consumeSSE(response([encoder.encode(': 12345678901234567890\n')]), { maxStreamBytes: 10 }), /整条流超过 13 MiB/);
});

test('rejects non-SSE responses without attempting a JSON success fallback', async () => {
  const ordinaryJSON = new Response(JSON.stringify(resultPayload), { headers: { 'content-type': 'application/json' } });
  await assert.rejects(consumeSSE(ordinaryJSON), /不是 text\/event-stream/);
});

test('maps an interrupted stream read to an explicit interruption error', async () => {
  const stream = new ReadableStream({ start(controller) { controller.error(new Error('synthetic transport cut')); } });
  await assert.rejects(consumeSSE(new Response(stream, { headers: { 'content-type': 'text/event-stream' } })), error => error.code === 'STREAM_INTERRUPTED' && /连接中断/.test(error.message));
});

test('counts CRLF wire bytes and rejects an oversized line before its first newline', async () => {
  const encoded = encoder.encode(frame('result', resultPayload));
  await assert.rejects(consumeSSE(response([encoded]), { maxEventBytes: encoded.byteLength - 1 }), /单个事件超过/);
  assert.equal((await consumeSSE(response([encoded]), { maxEventBytes: encoded.byteLength })).type, 'result');
  await assert.rejects(consumeSSE(response([encoder.encode('data: ' + 'x'.repeat(64))]), { maxEventBytes: 32 }), /单个事件超过/);
});

test('aborting a pending read cancels the stream and releases its reader', async () => {
  let cancelled = 0;
  const stream = new ReadableStream({ cancel() { cancelled++; } });
  const abort = new AbortController();
  const pending = consumeSSE(new Response(stream, { headers: { 'content-type': 'text/event-stream' } }), { signal: abort.signal });
  abort.abort();
  await assert.rejects(pending, error => error.name === 'AbortError');
  assert.equal(cancelled, 1);
  assert.equal(stream.locked, false);
});

test('rejects invalid UTF-8 even when the sequence is split between chunks', async () => {
  await assert.rejects(consumeSSE(response([new Uint8Array([0xe4]), new Uint8Array([0xff, 10])])), TypeError);
});

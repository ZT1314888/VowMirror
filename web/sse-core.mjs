export const MAX_SSE_EVENT_BYTES = 12 * 1024 * 1024;
export const MAX_SSE_STREAM_BYTES = 13 * 1024 * 1024;

export class SSEStreamError extends Error {
  constructor(code, message) {
    super(`生成事件流无效：${message}`);
    this.name = 'SSEStreamError';
    this.code = code;
  }
}

function invalid(message, code = 'SSE_STREAM_INVALID') {
  return new SSEStreamError(code, message);
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parsePayload(lines) {
  if (lines.length === 0) throw invalid('事件缺少 data 字段');
  let payload;
  try { payload = JSON.parse(lines.join('\n')); }
  catch { throw invalid('事件 JSON 格式错误'); }
  if (!object(payload)) throw invalid('事件数据必须是 JSON 对象');
  return payload;
}

class SSEParser {
  constructor(onStatus, maxEventBytes, maxStreamBytes) {
    this.onStatus = onStatus;
    this.maxEventBytes = maxEventBytes;
    this.maxStreamBytes = maxStreamBytes;
    this.decoder = new TextDecoder('utf-8', { fatal: true });
    this.line = '';
    this.eventName = '';
    this.data = [];
    this.eventBytes = 0;
    this.streamBytes = 0;
    this.requestID = '';
    this.terminal = null;
  }

  push(bytes) {
    this.streamBytes += bytes.byteLength;
    if (this.streamBytes > this.maxStreamBytes) throw invalid('整条流超过 13 MiB');
    let offset = 0;
    while (offset < bytes.byteLength) {
      const newline = bytes.indexOf(10, offset);
      const end = newline < 0 ? bytes.byteLength : newline + 1;
      // Count wire bytes, including both CR and LF, before buffering a fragment.
      this.eventBytes += end - offset;
      if (this.eventBytes > this.maxEventBytes) throw invalid('单个事件超过 12 MiB');
      this.line += this.decoder.decode(bytes.subarray(offset, end), { stream: true });
      offset = end;
      if (newline < 0) continue;
      const line = this.line.slice(0, -1).replace(/\r$/, '');
      this.line = '';
      this.readLine(line);
    }
  }

  readLine(line) {
    if (line === '') {
      this.dispatch();
      this.eventBytes = 0;
      return;
    }
    if (line.startsWith(':')) return;
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? '' : line.slice(separator + 1).replace(/^ /, '');
    if (field === 'event') this.eventName = value;
    if (field === 'data') this.data.push(value);
  }

  checkRequestID(payload) {
    if (typeof payload.request_id !== 'string' || !payload.request_id) throw invalid('事件缺少请求标识');
    if (this.requestID && payload.request_id !== this.requestID) throw invalid('请求标识发生变化');
    this.requestID = payload.request_id;
  }

  dispatch() {
    if (this.eventName === '' && this.data.length === 0) return;
    if (this.terminal) throw invalid('终态事件之后仍有数据');
    const type = this.eventName || 'message';
    if (!['status', 'heartbeat', 'result', 'error'].includes(type)) throw invalid(`未知事件 ${type}`);
    const payload = parsePayload(this.data);
    this.eventName = '';
    this.data = [];
    if (type === 'result' || type === 'error') {
      this.finishEvent(type, payload);
      return;
    }
    this.checkRequestID(payload);
    if (!Number.isSafeInteger(payload.elapsed_ms) || payload.elapsed_ms < 0) throw invalid('状态耗时无效');
    if (type === 'heartbeat') return;
    if (typeof payload.phase !== 'string' || !payload.phase) throw invalid('状态缺少真实阶段');
    if (payload.duration_ms !== undefined && (!Number.isSafeInteger(payload.duration_ms) || payload.duration_ms < 0)) throw invalid('阶段耗时无效');
    this.onStatus?.(payload);
  }

  finishEvent(type, payload) {
    if (!Number.isSafeInteger(payload.code) || typeof payload.message !== 'string' || !object(payload.data)) throw invalid('终态响应不符合 API 契约');
    this.checkRequestID(payload.data);
    if (type === 'result' && payload.code !== 0) throw invalid('成功终态的状态码无效');
    if (type === 'error' && (payload.code === 0 || typeof payload.data.error_code !== 'string' || !payload.data.error_code || !Number.isSafeInteger(payload.data.http_status) || payload.data.http_status < 400 || payload.data.http_status > 599)) throw invalid('错误终态缺少受控错误信息');
    this.terminal = { type, payload };
  }

  finish() {
    this.line += this.decoder.decode();
    if (this.line.length !== 0) throw invalid('结束时存在未完成的事件行', 'STREAM_INTERRUPTED');
    if (this.eventName !== '' || this.data.length !== 0 || this.eventBytes !== 0) throw invalid('流在事件结束前中断', 'STREAM_INTERRUPTED');
    if (!this.terminal) throw invalid('缺少 result 或 error 终态', 'STREAM_INTERRUPTED');
    return this.terminal;
  }
}

export async function consumeSSE(response, { signal, onStatus, maxEventBytes = MAX_SSE_EVENT_BYTES, maxStreamBytes = MAX_SSE_STREAM_BYTES } = {}) {
  const mediaType = (response.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
  if (mediaType !== 'text/event-stream') throw invalid('响应类型不是 text/event-stream');
  if (!response.body) throw invalid('响应没有可读内容');
  const reader = response.body.getReader();
  const parser = new SSEParser(onStatus, maxEventBytes, maxStreamBytes);
  let completed = false;
  let failure;
  let cancellation;
  const cancelRead = () => {
    cancellation ??= reader.cancel(signal?.reason).then(() => undefined, error => error);
  };
  signal?.addEventListener('abort', cancelRead, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      let chunk;
      try { chunk = await reader.read(); }
      catch (error) {
        if (signal?.aborted) throw error;
        throw invalid('读取期间连接中断', 'STREAM_INTERRUPTED');
      }
      signal?.throwIfAborted();
      if (chunk.done) {
        const terminal = parser.finish();
        completed = true;
        return terminal;
      }
      parser.push(chunk.value);
    }
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancelRead);
    try {
      if (!completed) {
        cancelRead();
        const cancelError = await cancellation;
        if (cancelError) {
          if (!failure) throw cancelError;
          const combined = new AggregateError([failure, cancelError], failure.message, { cause: failure });
          combined.code = failure.code;
          throw combined;
        }
      }
    } finally { reader.releaseLock(); }
  }
}

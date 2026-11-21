import { armControlledCouple, releaseControlledCouple, waitControlledCoupleHit } from './browser-observations.mjs';
import { confirmGeneration, submitGeneration } from './generation-submit.mjs';
import assert from 'node:assert/strict';

function resultPayload(response) {
  const match = response.body.match(/event: result\ndata: ([^\n]+)\n\n/);
  assert.ok(match, 'success fixture must contain an SSE result event');
  return JSON.parse(match[1]);
}

function eventStream(payload) {
  const requestId = payload.data.request_id;
  const status = { request_id: requestId, phase: 'reading_input', elapsed_ms: 2, duration_ms: 1 };
  return `event: status\ndata: ${JSON.stringify(status)}\n\nevent: result\ndata: ${JSON.stringify(payload)}\n\n`;
}

// 结果图在挂载前由解码探针验证；探针沿用 result-image id 以便此处精确挂钩。
async function holdDecode(page) {
  await page.evaluate(() => {
    const decode = HTMLImageElement.prototype.decode;
    window.__resultDecodeDone = false;
    HTMLImageElement.prototype.decode = async function () {
      if (this.id !== 'result-image') return decode.call(this);
      HTMLImageElement.prototype.decode = decode;
      await decode.call(this);
      await new Promise(resolve => { window.__releaseResultDecode = resolve; });
      window.__resultDecodeDone = true;
    };
  });
}

async function releaseDecode(page) {
  await page.evaluate(() => { window.__releaseResultDecode(); delete window.__releaseResultDecode; });
  await page.waitForFunction(() => window.__resultDecodeDone);
}

async function lastCreatedURL(page) {
  return page.evaluate(() => window.__createdObjectURLs.at(-1));
}

async function submitResponse(page, response) {
  await armControlledCouple(page, response);
  await submitGeneration(page);
  try {
    await waitControlledCoupleHit(page);
  } catch (error) {
    const state = await page.evaluate(() => ({
      dialogOpen: document.querySelector('#access-dialog').open,
      accessError: document.querySelector('#access-error')?.textContent ?? null,
      alert: document.querySelector('#form-alert')?.textContent ?? null,
      active: document.activeElement?.id ?? document.activeElement?.tagName,
      room: [...document.querySelectorAll('.stepper-link')].findIndex(link => link.getAttribute('aria-current') === 'step'),
    }));
    console.log('submitResponse hit timeout:', JSON.stringify(state));
    throw error;
  }
  await releaseControlledCouple(page);
}

async function assertHiddenResult(page, url) {
  assert.equal(await page.locator('#result-image').count(), 0);
  assert.equal(await page.locator('#download-result').count(), 0);
  assert.equal(await page.evaluate(url => window.__revokedObjectURLs.includes(url), url), true);
  assert.equal(await page.locator('#floating-dock [data-action="generate"]').isEnabled(), true);
}

async function installHeartbeatStream(page, payload) {
  await page.evaluate(payload => {
    const originalFetch = window.fetch;
    window.__heartbeatEvidence = { heartbeats: 0, cancelled: false, aborted: false, statusMutations: 0 };
    window.fetch = async (url, options) => {
      if (url !== '/api/tryon/couple') return originalFetch(url, options);
      window.fetch = originalFetch;
      const evidence = window.__heartbeatEvidence;
      const encoder = new TextEncoder();
      const requestId = payload.data.request_id;
      let controller;
      let heartbeat;
      const send = (event, data) => controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      const stream = new ReadableStream({
        start(value) {
          controller = value;
          send('status', { request_id: requestId, phase: 'connection_acquisition', elapsed_ms: 1 });
          send('status', { request_id: requestId, phase: 'waiting_upstream_response', elapsed_ms: 2 });
          heartbeat = setInterval(() => {
            evidence.heartbeats++;
            send('heartbeat', { request_id: requestId, elapsed_ms: evidence.heartbeats * 10_000 });
          }, 10_000);
        },
        cancel() { clearInterval(heartbeat); evidence.cancelled = true; },
      });
      options.signal.addEventListener('abort', () => { evidence.aborted = true; }, { once: true });
      window.__attemptLateSSETerminal = () => {
        try { send('result', payload); }
        catch (error) {
          if (error instanceof TypeError) return 'stream already cancelled';
          throw error;
        }
        throw new Error('cancelled stream accepted a late terminal');
      };
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
    };
  }, payload);
}

export async function verifyResultLifecycle(page, successResponse) {
  await holdDecode(page);
  await armControlledCouple(page, successResponse);
  await submitGeneration(page);
  await waitControlledCoupleHit(page);
  await releaseControlledCouple(page);
  await page.waitForFunction(() => typeof window.__releaseResultDecode === 'function');
  assert.equal(await page.locator('#aperture-overlay').isVisible(), true, 'generation overlay shows progress while decoding');
  assert.equal(await page.locator('#result-image').count(), 0);
  assert.equal(await page.locator('#floating-dock [data-action="generate"]').isDisabled(), true);
  await page.clock.fastForward(250);
  await releaseDecode(page);
  await page.locator('#result-image').waitFor();
  const visibleDuration = Number((await page.locator('#result-meta').textContent()).match(/可查看耗时 (\d+) ms/)[1]);
  assert.ok(visibleDuration >= 250, 'elapsed time must include image decode');
  assert.match(await page.locator('#result-meta').textContent(), /供应商型号 未提供版本信息/);

  const requestId = resultPayload(successResponse).data.request_id;
  for (const scenario of [
    { type: 'error', body: { code: 50401, message: 'private-provider-message', data: { error_code: 'GENERATION_TIMEOUT', request_id: requestId, http_status: 504 } }, alertText: '服务端时限', regex: /服务端时限/ },
    { type: 'error', body: { code: 40801, message: 'private-provider-message', data: { error_code: 'GENERATION_CANCELLED', request_id: requestId, http_status: 408 } }, alertText: '生成已取消', regex: /已取消/ },
    { type: 'status', body: { request_id: requestId, phase: 'waiting_upstream_response', elapsed_ms: 1 }, alertText: '连接中断', regex: /连接中断/ },
    { type: 'preview', body: {}, alertText: '未知事件', regex: /未知事件/ },
  ]) {
    await submitResponse(page, { status: 200, contentType: 'text/event-stream', body: `event: ${scenario.type}\ndata: ${JSON.stringify(scenario.body)}\n\n` });
    await page.locator('#form-alert').filter({ hasText: scenario.alertText }).waitFor();
    assert.match(await page.locator('#form-alert').textContent(), scenario.regex);
    assert.equal(await page.locator('#result-status').textContent(), await page.locator('#form-alert').textContent());
    assert.equal(await page.locator('#result-image').count(), 0);
    assert.equal(await page.locator('#download-result').count(), 0);
    assert.equal(await page.locator('#floating-dock [data-action="generate"]').isEnabled(), true);
  }
  await submitResponse(page, { ...successResponse, body: successResponse.body + successResponse.body });
  await page.locator('#form-alert').filter({ hasText: '终态事件之后' }).waitFor();
  assert.match(await page.locator('#form-alert').textContent(), /终态事件之后/);
  assert.equal(await page.locator('#result-image').count(), 0);
  await submitResponse(page, { status: 200, contentType: 'application/json', body: JSON.stringify(resultPayload(successResponse)) });
  await page.locator('#form-alert').filter({ hasText: '不是 text/event-stream' }).waitFor();
  assert.match(await page.locator('#form-alert').textContent(), /不是 text\/event-stream/);
  assert.equal(await page.locator('#download-result').count(), 0);

  const invalid = resultPayload(successResponse);
  invalid.data.image = Buffer.from(invalid.data.image, 'base64').subarray(0, 40).toString('base64');
  await submitResponse(page, { ...successResponse, body: eventStream(invalid) });
  await page.locator('#form-alert').filter({ hasText: '无法解码' }).waitFor();
  assert.match(await page.locator('#form-alert').textContent(), /无法解码/);
  assert.equal(await page.locator('#result-image').count(), 0);
  assert.equal(await page.locator('#download-result').count(), 0);

  // Cancel during decode, start a new request, then finish the old decode.
  await holdDecode(page);
  await submitResponse(page, successResponse);
  await page.waitForFunction(() => typeof window.__releaseResultDecode === 'function');
  const cancelledURL = await lastCreatedURL(page);
  await page.locator('#cancel-generation').click();
  await page.locator('#form-alert').getByText('生成已取消。你可以手动重试。', { exact: true }).waitFor();
  await assertHiddenResult(page, cancelledURL);
  const withMetadata = resultPayload(successResponse);
  withMetadata.data.provider_model = withMetadata.data.model;
  withMetadata.data.provider_request_id = 'synthetic-provider-id';
  await submitResponse(page, { ...successResponse, body: eventStream(withMetadata) });
  await page.locator('#result-image').waitFor();
  assert.match(await page.locator('#result-meta').textContent(), /未提供日期快照/);
  assert.match(await page.locator('#result-meta').textContent(), /供应商请求 synthetic-provider-id/);
  const newURL = await page.locator('#result-image').getAttribute('src');
  await releaseDecode(page);
  assert.equal(await page.locator('#result-image').getAttribute('src'), newURL);
  assert.equal(await page.locator('#download-result').getAttribute('href'), newURL);

  await holdDecode(page);
  await submitResponse(page, successResponse);
  await page.waitForFunction(() => typeof window.__releaseResultDecode === 'function');
  const timedOutURL = await lastCreatedURL(page);
  await page.clock.fastForward(90_001);
  await page.locator('#form-alert').getByText('生成超过 90 秒，已停止请求。你可以手动重试。', { exact: true }).waitFor();
  await assertHiddenResult(page, timedOutURL);
  await releaseDecode(page);
  await assertHiddenResult(page, timedOutURL);
  assert.equal(await page.locator('#result-status').textContent(), '生成超过 90 秒，已停止请求。你可以手动重试。');

  await installHeartbeatStream(page, resultPayload(successResponse));
  await submitGeneration(page);
  await page.locator('#generation-status').getByText('等待上游响应', { exact: true }).waitFor();
  await page.locator('#cancel-generation').click();
  await page.locator('#form-alert').getByText('生成已取消。你可以手动重试。', { exact: true }).waitFor();
  const cancelledStream = await page.evaluate(() => ({ ...window.__heartbeatEvidence, lateTerminal: window.__attemptLateSSETerminal() }));
  assert.equal(cancelledStream.cancelled, true);
  assert.equal(cancelledStream.aborted, true);
  assert.equal(cancelledStream.lateTerminal, 'stream already cancelled');
  assert.equal(await page.locator('#download-result').count(), 0);

  // An in-memory stream isolates this browser deadline from the 85s server
  // deadline. Actual HTTP flushing and cancellation are verified in Go tests.
  // Clock was installed by smoke.mjs; heartbeat intervals and the 90s deadline
  // are advanced deterministically instead of relying on wall time.
  await installHeartbeatStream(page, resultPayload(successResponse));
  await submitGeneration(page);
  await page.locator('#generation-status').getByText('等待上游响应', { exact: true }).waitFor();
  await page.evaluate(() => {
    const observer = new MutationObserver(() => { window.__heartbeatEvidence.statusMutations++; });
    observer.observe(document.querySelector('#generation-status'), { childList: true, characterData: true, subtree: true });
    window.__stopStatusObserver = () => observer.disconnect();
  });
  // 分步推进：每步驱动一次心跳，最后一步跨过 90 秒期限。
  for (let step = 0; step < 8; step++) await page.clock.fastForward(10_000);
  await page.clock.fastForward(1_100);
  await page.locator('#form-alert').getByText('生成超过 90 秒，已停止请求。你可以手动重试。', { exact: true }).waitFor({ timeout: 15_000 });
  assert.equal(await page.locator('#result-image').count(), 0);
  const heartbeatEvidence = await page.evaluate(() => {
    window.__stopStatusObserver();
    delete window.__stopStatusObserver;
    return { ...window.__heartbeatEvidence, lateTerminal: window.__attemptLateSSETerminal() };
  });
  assert.ok(heartbeatEvidence.heartbeats >= 8, 'the actual deadline must include continuous heartbeats');
  assert.equal(heartbeatEvidence.cancelled, true, 'timeout must cancel the pending stream read');
  assert.equal(heartbeatEvidence.aborted, true);
  // 心跳不更新进度文案；超时提示走顶部提示条与成片厅状态，不再改写进度状态。
  assert.equal(heartbeatEvidence.statusMutations, 0, 'only phase events may update the status text');
  assert.equal(heartbeatEvidence.lateTerminal, 'stream already cancelled');
  await submitResponse(page, successResponse);
  await page.locator('#result-image').waitFor();
  assert.equal(await page.locator('#floating-dock [data-action="generate"]').isEnabled(), true);
  return { decode: 'passed', decodeFailure: 'passed', lateDecode: 'isolated', cancelledURL: 'released', heartbeatEvidence, manualRetry: 'passed' };
}

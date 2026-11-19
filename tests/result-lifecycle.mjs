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

async function holdDecode(page) {
  await page.evaluate(() => {
    const decode = HTMLImageElement.prototype.decode;
    window.__resultDecodeDone = false;
    window.__resultDecodeStartedAt = null;
    HTMLImageElement.prototype.decode = async function () {
      if (this.id !== 'result-image') return decode.call(this);
      HTMLImageElement.prototype.decode = decode;
      await decode.call(this);
      window.__resultDecodeStartedAt = performance.now();
      await new Promise(resolve => { window.__releaseResultDecode = resolve; });
      window.__resultDecodeDone = true;
    };
  });
}

async function releaseDecode(page) {
  await page.evaluate(() => { window.__releaseResultDecode(); delete window.__releaseResultDecode; });
  await page.waitForFunction(() => window.__resultDecodeDone);
}

async function submitResponse(page, response) {
  await page.route('**/api/tryon/couple', route => route.fulfill(response), { times: 1 });
  await page.locator('#generate').click();
}

async function assertHiddenResult(page, url) {
  assert.equal(await page.locator('#result-image-wrap').isVisible(), false);
  assert.equal(await page.locator('#result-image').getAttribute('src'), null);
  assert.equal(await page.locator('#download-result').getAttribute('href'), null);
  assert.equal(await page.evaluate(url => window.__revokedObjectURLs.includes(url), url), true);
  assert.equal(await page.locator('#generate').isEnabled(), true);
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
  await submitResponse(page, successResponse);
  await page.waitForFunction(() => typeof window.__releaseResultDecode === 'function');
  assert.equal(await page.locator('#result-state').textContent(), '生成中');
  assert.equal(await page.locator('#result-image-wrap').isVisible(), false);
  assert.equal(await page.locator('#generate').isDisabled(), true);
  await page.clock.fastForward(250);
  await releaseDecode(page);
  await page.getByText('生成完成', { exact: true }).waitFor();
  const visibleDuration = Number((await page.locator('#result-meta').textContent()).match(/可查看耗时 (\d+) ms/)[1]);
  assert.ok(visibleDuration >= 250, 'elapsed time must include image decode');
  assert.match(await page.locator('#result-meta').textContent(), /供应商型号 未提供版本信息/);

  const requestId = resultPayload(successResponse).data.request_id;
  for (const scenario of [
    { type: 'error', body: { code: 50401, message: 'private-provider-message', data: { error_code: 'GENERATION_TIMEOUT', request_id: requestId, http_status: 504 } }, state: '已超时', text: /服务端时限/ },
    { type: 'error', body: { code: 40801, message: 'private-provider-message', data: { error_code: 'GENERATION_CANCELLED', request_id: requestId, http_status: 408 } }, state: '已取消', text: /已取消/ },
    { type: 'status', body: { request_id: requestId, phase: 'waiting_upstream_response', elapsed_ms: 1 }, state: '生成失败', text: /连接中断/ },
    { type: 'preview', body: {}, state: '生成失败', text: /未知事件/ },
  ]) {
    await submitResponse(page, { status: 200, contentType: 'text/event-stream', body: `event: ${scenario.type}\ndata: ${JSON.stringify(scenario.body)}\n\n` });
    await page.getByText(scenario.state, { exact: true }).waitFor();
    assert.match(await page.locator('#generation-status').textContent(), scenario.text);
    assert.equal(await page.locator('#result-image').getAttribute('src'), null);
    assert.equal(await page.locator('#download-result').getAttribute('href'), null);
    assert.equal(await page.locator('#generate').isEnabled(), true);
  }
  await submitResponse(page, { ...successResponse, body: successResponse.body + successResponse.body });
  await page.getByText('生成失败', { exact: true }).waitFor();
  assert.match(await page.locator('#generation-status').textContent(), /终态事件之后/);
  assert.equal(await page.locator('#result-image').getAttribute('src'), null);
  await submitResponse(page, { status: 200, contentType: 'application/json', body: JSON.stringify(resultPayload(successResponse)) });
  await page.getByText('生成失败', { exact: true }).waitFor();
  assert.match(await page.locator('#generation-status').textContent(), /不是 text\/event-stream/);
  assert.equal(await page.locator('#download-result').getAttribute('href'), null);

  const invalid = resultPayload(successResponse);
  invalid.data.image = Buffer.from(invalid.data.image, 'base64').subarray(0, 40).toString('base64');
  await submitResponse(page, { ...successResponse, body: eventStream(invalid) });
  await page.getByText('生成失败', { exact: true }).waitFor();
  assert.match(await page.locator('#generation-status').textContent(), /无法解码/);
  assert.equal(await page.locator('#result-image-wrap').isVisible(), false);
  assert.equal(await page.locator('#result-image').getAttribute('src'), null);
  assert.equal(await page.locator('#download-result').getAttribute('href'), null);

  // Cancel during decode, start a new request, then finish the old decode.
  await holdDecode(page);
  await submitResponse(page, successResponse);
  await page.waitForFunction(() => typeof window.__releaseResultDecode === 'function');
  const cancelledURL = await page.locator('#result-image').getAttribute('src');
  await page.locator('#cancel-generation').click();
  await page.getByText('已取消', { exact: true }).waitFor();
  await assertHiddenResult(page, cancelledURL);
  const withMetadata = resultPayload(successResponse);
  withMetadata.data.provider_model = withMetadata.data.model;
  withMetadata.data.provider_request_id = 'synthetic-provider-id';
  await submitResponse(page, { ...successResponse, body: eventStream(withMetadata) });
  await page.getByText('生成完成', { exact: true }).waitFor();
  assert.match(await page.locator('#result-meta').textContent(), /未提供日期快照/);
  assert.match(await page.locator('#result-meta').textContent(), /供应商请求 synthetic-provider-id/);
  const newURL = await page.locator('#result-image').getAttribute('src');
  await releaseDecode(page);
  assert.equal(await page.locator('#result-image').getAttribute('src'), newURL);
  assert.equal(await page.locator('#download-result').getAttribute('href'), newURL);

  await holdDecode(page);
  await submitResponse(page, successResponse);
  await page.waitForFunction(() => typeof window.__releaseResultDecode === 'function');
  const timedOutURL = await page.locator('#result-image').getAttribute('src');
  await page.clock.fastForward(90_001);
  await page.getByText('已超时', { exact: true }).waitFor();
  await assertHiddenResult(page, timedOutURL);
  await releaseDecode(page);
  await assertHiddenResult(page, timedOutURL);
  assert.equal(await page.locator('#result-state').textContent(), '已超时');

  await installHeartbeatStream(page, resultPayload(successResponse));
  await page.locator('#generate').click();
  await page.locator('#generation-status').getByText('等待上游响应', { exact: true }).waitFor();
  await page.locator('#cancel-generation').click();
  await page.getByText('已取消', { exact: true }).waitFor();
  const cancelledStream = await page.evaluate(() => ({ ...window.__heartbeatEvidence, lateTerminal: window.__attemptLateSSETerminal() }));
  assert.equal(cancelledStream.cancelled, true);
  assert.equal(cancelledStream.aborted, true);
  assert.equal(cancelledStream.lateTerminal, 'stream already cancelled');
  assert.equal(await page.locator('#download-result').getAttribute('href'), null);

  // An in-memory stream isolates this browser deadline from the 85s server
  // deadline. Actual HTTP flushing and cancellation are verified in Go tests.
  await installHeartbeatStream(page, resultPayload(successResponse));
  const fullTimeoutStartedAt = Date.now();
  await page.locator('#generate').click();
  await page.locator('#generation-status').getByText('等待上游响应', { exact: true }).waitFor();
  await page.evaluate(() => {
    const observer = new MutationObserver(() => { window.__heartbeatEvidence.statusMutations++; });
    observer.observe(document.querySelector('#generation-status'), { childList: true, characterData: true, subtree: true });
    window.__stopStatusObserver = () => observer.disconnect();
  });
  await page.getByText('已超时', { exact: true }).waitFor({ timeout: 95_000 });
  const fullTimeoutDurationMs = Date.now() - fullTimeoutStartedAt;
  assert.ok(fullTimeoutDurationMs >= 89_900 && fullTimeoutDurationMs < 95_000, 'actual deadline must be 90 seconds');
  assert.equal(await page.locator('#result-image-wrap').isVisible(), false);
  const heartbeatEvidence = await page.evaluate(() => {
    window.__stopStatusObserver();
    delete window.__stopStatusObserver;
    return { ...window.__heartbeatEvidence, lateTerminal: window.__attemptLateSSETerminal() };
  });
  assert.ok(heartbeatEvidence.heartbeats >= 8, 'the actual deadline must include continuous heartbeats');
  assert.equal(heartbeatEvidence.cancelled, true, 'timeout must cancel the pending stream read');
  assert.equal(heartbeatEvidence.aborted, true);
  assert.equal(heartbeatEvidence.statusMutations, 1, 'only the timeout may update the status after waiting begins');
  assert.equal(heartbeatEvidence.lateTerminal, 'stream already cancelled');
  await submitResponse(page, successResponse);
  await page.getByText('生成完成', { exact: true }).waitFor();
  assert.equal(await page.locator('#generate').isEnabled(), true);
  return { decode: 'passed', decodeFailure: 'passed', lateDecode: 'isolated', cancelledURL: 'released', fullTimeoutDurationMs, heartbeatEvidence, manualRetry: 'passed' };
}

import assert from 'node:assert/strict';

// Room navigation and viewport resizing can both animate the gallery track. A
// stable page-header button does not establish that room controls are ready.
export async function waitForGalleryRoom(page, selector) {
  await page.waitForFunction(selector => {
    const room = document.querySelector(selector)?.closest('.gallery-room');
    const viewport = document.querySelector('#gallery-viewport');
    const track = document.querySelector('#gallery-track');
    if (!room || room.inert || !viewport || !track) return false;
    const bounds = room.getBoundingClientRect();
    const frame = viewport.getBoundingClientRect();
    return frame.width > 0 && Math.abs(bounds.left - frame.left) < 1
      && Math.abs(bounds.width - frame.width) < 1
      && track.getAnimations().every(animation => !animation.pending && animation.playState !== 'running');
  }, selector, { timeout: 5000 });
}

// 边界拦截仅覆盖 couple 上传端点：无效码 401 探针需要 authorize 触达真后端，
// 因此 assertSafe 的语义是「无未受控的上传流量」，不含 authorize。
export const generationURL = url => /^\/api\/tryon\/couple\/?$/.test(new URL(url).pathname);

// Install before navigation; scenario routes registered later may fulfill requests.
export async function blockUncontrolledGeneration(page) {
  let blocked = 0;
  await page.route(generationURL, async route => {
    blocked++;
    await route.abort('blockedbyclient');
  });
  return {
    assertSafe() {
      assert.equal(blocked, 0, 'uncontrolled generation request blocked');
    },
  };
}

// 页面内受控响应通道：Playwright 的 route 分发在「挂起 + 取消」组合下会出现
// 会话黑洞；改在 fetch 包装层实现挂起/放行。包装层先于一切网络，未放行前
// 请求不会离开页面，杜绝测试流量触碰真实上游。
export async function installControlledCouple(page) {
  await page.addInitScript(() => {
    const base = window.fetch.bind(window);
    window.__controlledCouple = { queue: [], settled: 0, captured: [] };
    window.fetch = async (...args) => {
      const control = window.__controlledCouple;
      // 单条挂起约束：armControlledCouple 每次只挂起一个响应，串行使用。
      // 用 pathname 精确匹配，避免 Request 对象或子串误判。
      const url = new URL(String(args[0]), location.origin);
      if (url.pathname === '/api/tryon/couple' && control.queue.length > 0) {
        const current = control.queue[0];
        current.hit = true;
        try {
          control.captured.push({
            authorization: args[1]?.headers?.Authorization ?? null,
            body: JSON.parse(args[1]?.body ?? 'null'),
          });
        } catch {
          control.captured.push({ authorization: null, body: null });
        }
        await current.gate;
        control.queue.shift();
        control.settled += 1;
        // 取消/超时后的迟到响应直接中止：与 AbortController 语义一致。
        if (args[1]?.signal?.aborted) throw new DOMException('The user aborted a request.', 'AbortError');
        return new Response(current.body, { status: current.status, headers: { 'Content-Type': current.contentType } });
      }
      return base(...args);
    };
  });
}

// 挂起一个 couple 响应：请求会停在包装层，直到 releaseControlledCouple。
export async function armControlledCouple(page, { status, contentType, body }) {
  await page.evaluate(spec => {
    const control = window.__controlledCouple;
    control.queue.push({
      hit: false,
      gate: new Promise(resolve => { control.resolveGate = resolve; }),
      body: spec.body,
      status: spec.status,
      contentType: spec.contentType,
    });
  }, { status, contentType, body });
}

export async function waitControlledCoupleHit(page, label = 'controlled request start') {
  const deadline = new Promise((resolve, reject) => {
    setTimeout(() => reject(new Error(`${label} exceeded 10 seconds`)), 10_000);
  });
  await Promise.race([
    page.waitForFunction(() => window.__controlledCouple.queue[0]?.hit === true),
    deadline,
  ]);
}

// 放行挂起的响应（或取消后让请求以 AbortError 结算）。
export async function releaseControlledCouple(page) {
  await page.evaluate(() => { window.__controlledCouple.resolveGate?.(); });
  await page.waitForFunction(() => window.__controlledCouple.queue.length === 0);
}

// 页面内拦截不产生网络事件；受控请求的载荷在包装层记录，供断言读取。
export async function controlledCaptures(page) {
  return page.evaluate(() => window.__controlledCouple.captured);
}

export function observeConsole(page) {
  const messages = [];
  page.on('console', message => messages.push({ type: message.type(), text: message.text() }));
  return {
    messages,
    errors: () => messages.filter(message => message.type === 'error').map(message => message.text),
    assertNoSensitive(markers) {
      for (const [category, values] of Object.entries(markers)) {
        assert.ok(values.length > 0 && values.every(value => typeof value === 'string' && value.length > 0), 'empty sensitive marker');
        if (messages.some(message => values.some(value => message.text.includes(value)))) {
          throw new Error(`sensitive browser console data: ${category}`);
        }
      }
    },
  };
}

// 粒子溶解过渡：旧大图按网格采样为带色粒子，轻扫、上飘、透明衰减，
// 新层同时做 CSS 交叉淡入，形成类似 iPhone 双屏内外屏
// 切换的连续溶解感。仅处理同源图片（blob:/同站路径）；
// 画布被污染、图片未解码或用户偏好减少动态时回退为纯交叉淡入。

const MAX_DPR = 2;
const running = new WeakMap();
const pending = new WeakMap();

export function cancelDissolve(canvas) {
  pending.delete(canvas);
  const state = running.get(canvas);
  if (state) {
    cancelAnimationFrame(state.raf);
    running.delete(canvas);
    const ctx = canvas.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
}

// 布局更新（参考行、dock 高度）与图片提交在同一帧发生；等两帧再按最终
// 画框尺寸取样，避免刚启动就被画框变化作废。新选择到来时统一取消未启动的取样。
export function scheduleDissolve({ canvas, source, duration = 720 }) {
  cancelDissolve(canvas);
  if (!canvas || !source?.complete || !source.naturalWidth) return false;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
  const state = {};
  pending.set(canvas, state);
  let remaining = 2;
  const tick = () => {
    if (pending.get(canvas) !== state) return; // 已被取消或替换
    if (remaining-- > 0) {
      requestAnimationFrame(tick);
      return;
    }
    pending.delete(canvas);
    dissolveTransition({ canvas, source, duration });
  };
  requestAnimationFrame(tick);
  return true;
}

// 只有播放开始后画框尺寸真的变了才不会错位；尺寸未变的通知（同一布局更新
// 的迟到回调）不能取消正在播放的动效。
export function cancelDissolveIfResized(canvas) {
  const state = running.get(canvas);
  const frame = canvas?.parentElement;
  if (!state || !frame) return false;
  const rect = frame.getBoundingClientRect();
  if (Math.abs(rect.width - state.width) < 1 && Math.abs(rect.height - state.height) < 1) return false;
  cancelDissolve(canvas);
  return true;
}

export function dissolveTransition({ canvas, source, duration = 720 }) {
  const frame = canvas?.parentElement;
  if (!frame || !source?.complete || !source.naturalWidth) return false;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
  cancelDissolve(canvas);

  const rect = frame.getBoundingClientRect();
  if (!rect.width || !rect.height) return false;
  const dpr = Math.min(devicePixelRatio || 1, MAX_DPR);
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return false;

  const sw = source.naturalWidth;
  const sh = source.naturalHeight;
  const style = getComputedStyle(source);
  const fit = style.objectFit === 'cover' ? Math.max : Math.min;
  const scale = fit(canvas.width / sw, canvas.height / sh);
  const dw = sw * scale;
  const dh = sh * scale;
  const [focusX, focusY] = style.objectPosition.split(' ').map(value => parseFloat(value) / 100);
  try {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(source, (canvas.width - dw) * focusX, (canvas.height - dh) * focusY, dw, dh);
  } catch {
    return false; // 跨域污染
  }
  let sampled;
  try {
    sampled = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  } catch {
    return false;
  }

  // 网格粒子：CSS 像素网格，坐标按 dpr 放大绘制
  const cols = Math.min(46, Math.max(24, Math.round(rect.width / 24)));
  const rows = Math.min(72, Math.max(20, Math.round(cols * rect.height / rect.width)));
  const cellW = canvas.width / cols;
  const cellH = canvas.height / rows;
  const particles = [];
  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      const px = Math.min(canvas.width - 1, Math.floor((gx + .5) * cellW));
      const py = Math.min(canvas.height - 1, Math.floor((gy + .5) * cellH));
      const i = (py * canvas.width + px) * 4;
      if (sampled[i + 3] < 12) continue;
      particles.push({
        x: gx * cellW, y: gy * cellH, w: cellW * 1.12, h: cellH * 1.12,
        r: sampled[i], g: sampled[i + 1], b: sampled[i + 2],
        vx: (Math.random() - .5) * 26 * dpr,
        vy: -(26 + Math.random() * 68) * dpr,
        delay: (gx / cols) * 110 + Math.random() * 90,
        life: duration * (.62 + Math.random() * .38),
      });
    }
  }
  if (!particles.length) return false;

  const state = { raf: 0, width: rect.width, height: rect.height };
  running.set(canvas, state);
  let started = false;
  let last = 0;
  const step = now => {
    if (running.get(canvas) !== state) return; // 已被取消或替换
    if (!started) {
      started = true;
      last = now;
    }
    const dt = Math.min(48, now - last) / 1000;
    last = now;
    const elapsed = now - state.born;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    let alive = 0;
    for (const p of particles) {
      const local = elapsed - p.delay;
      if (local <= 0) { alive++; continue; }
      const t = local / p.life;
      if (t >= 1) continue;
      alive++;
      const alpha = (1 - t) ** 1.6;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = `rgb(${p.r},${p.g},${p.b})`;
      ctx.fillRect(p.x, p.y, p.w, p.h);
    }
    ctx.globalAlpha = 1;
    if (alive === 0 || elapsed > duration + 320) {
      running.delete(canvas);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    state.raf = requestAnimationFrame(step);
  };
  state.born = performance.now();
  state.raf = requestAnimationFrame(step);
  return true;
}

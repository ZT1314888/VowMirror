// 粒子溶解过渡：旧大图按网格采样为带色粒子，轻扫、上飘、透明衰减，
// 新层同时做 CSS 交叉淡入与微缩放落定，形成类似 iPhone 双屏内外屏
// 切换的连续溶解感。仅处理同源图片（blob:/同站路径）；
// 画布被污染、图片未解码或用户偏好减少动态时回退为纯交叉淡入。

const MAX_DPR = 2;
const running = new WeakMap();

export function cancelDissolve(canvas) {
  const state = running.get(canvas);
  if (state) {
    cancelAnimationFrame(state.raf);
    running.delete(canvas);
    const ctx = canvas.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
}

export function dissolveTransition({ canvas, source, onReady, duration = 720 }) {
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
  const scale = Math.max(canvas.width / sw, canvas.height / sh);
  const dw = sw * scale;
  const dh = sh * scale;
  try {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(source, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh);
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

  const state = { raf: 0 };
  running.set(canvas, state);
  let started = false;
  let last = 0;
  const step = now => {
    if (running.get(canvas) !== state) return; // 已被取消或替换
    if (!started) {
      started = true;
      last = now;
      onReady?.();
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

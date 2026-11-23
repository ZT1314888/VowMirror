// 花瓣飘落：请柬火漆开启瞬间的庆祝粒子。花瓣从火漆位置迸出、上抛后受
// 重力与横向摆动影响飘落、旋转并透明衰减，余韵可延续到画廊首屏。
// 独立于 particle-core：那是图像网格溶解，这里是形状粒子；
// 用户偏好减少动态、画布不可用或页面隐藏时回退为无粒子。

const MAX_DPR = 2;
const PETAL_COLORS = ['#d9a08c', '#c98d7f', '#e6c3b3', '#c8a27e', '#b9887b'];
const running = new WeakMap();

export function cancelPetals(canvas) {
  const state = running.get(canvas);
  if (state) {
    cancelAnimationFrame(state.raf);
    running.delete(canvas);
    const ctx = canvas.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
}

export function petalBurst({ canvas, origin, count = 26, duration = 1700 }) {
  if (!canvas || matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return false;
  cancelPetals(canvas);
  const dpr = Math.min(devicePixelRatio || 1, MAX_DPR);
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;
  const ox = (origin?.x ?? rect.width / 2) * dpr;
  const oy = (origin?.y ?? rect.height / 2) * dpr;

  const petals = [];
  for (let i = 0; i < count; i++) {
    const rx = (3.4 + Math.random() * 4.2) * dpr;
    petals.push({
      x: ox + (Math.random() - .5) * 14 * dpr,
      y: oy + (Math.random() - .5) * 14 * dpr,
      vx: (Math.random() - .5) * 190 * dpr,
      vy: -(150 + Math.random() * 170) * dpr,
      rx,
      ry: rx * .58,
      rot: Math.random() * Math.PI * 2,
      spin: (Math.random() - .5) * 3.4,
      sway: Math.random() * Math.PI * 2,
      delay: Math.random() * 180,
      life: duration * (.68 + Math.random() * .36),
      color: PETAL_COLORS[i % PETAL_COLORS.length],
    });
  }
  if (!petals.length) return false;

  const state = { raf: 0 };
  running.set(canvas, state);
  let last = 0;
  const step = now => {
    if (running.get(canvas) !== state || !canvas.isConnected) { running.delete(canvas); return; }
    if (!last) last = now;
    const dt = Math.min(48, now - last) / 1000;
    last = now;
    const elapsed = now - state.born;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    let alive = 0;
    for (const p of petals) {
      const local = elapsed - p.delay;
      if (local <= 0) { alive++; continue; }
      const t = local / p.life;
      if (t >= 1) continue;
      alive++;
      p.vy += 300 * dpr * dt;
      p.vx *= (1 - 0.6 * dt);
      p.x += p.vx * dt + Math.sin(local / 260 + p.sway) * 26 * dpr * dt;
      p.y += p.vy * dt;
      p.rot += p.spin * dt;
      const fadeOut = (1 - Math.max(0, (t - .55) / .45)) ** 1.4;
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, local / 90) * fadeOut * .92);
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.ellipse(0, 0, p.rx, p.ry, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    ctx.globalAlpha = 1;
    if (alive === 0 || elapsed > duration + 500) {
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

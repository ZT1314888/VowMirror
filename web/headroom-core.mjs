// 顶栏自动隐藏（Headroom 式）纯状态机：画廊整页不滚动，由手势与闲置计时驱动。
// 不触碰 DOM，输入全部来自参数，便于 Node 单测；接线方持有唯一 state 对象。

export const HEADER_TOLERANCE = { down: 24, up: 12 };
export const HEADER_IDLE_MS = 3000;

const INITIAL = Object.freeze({ pinned: true, locked: true, accum: 0 });

// 事件：{ type: 'delta', dy }（dy 正值为向下滚轮/上滑）| { type: 'idle' } | { type: 'reveal' }
//       | { type: 'noop' } | { type: 'lock' } | { type: 'unlock' }
export function headroomStep(state, event) {
  let { pinned, locked, accum } = state;
  switch (event.type) {
    case 'lock':
      locked = true;
      break;
    case 'unlock':
      locked = false;
      break;
    case 'reveal':
      pinned = true;
      accum = 0;
      break;
    case 'noop':
      break;
    case 'delta':
      if (locked) break;
      accum = Math.sign(event.dy) === Math.sign(accum) ? accum + event.dy : event.dy;
      if (pinned && accum >= HEADER_TOLERANCE.down) { pinned = false; accum = 0; }
      else if (!pinned && accum <= -HEADER_TOLERANCE.up) { pinned = true; accum = 0; }
      break;
    case 'idle':
      if (!locked) pinned = false;
      break;
    default:
      throw new Error(`unknown headroom event: ${event.type}`);
  }
  if (locked) pinned = true;
  return { pinned, locked, accum };
}

// 主线三条路径（锁定、闲置与手势）都以上面唯一的状态流转收敛；
// 这里给出明确起点，避免各调用点散落字面量。
export function initialHeadroomState() {
  return { ...INITIAL };
}

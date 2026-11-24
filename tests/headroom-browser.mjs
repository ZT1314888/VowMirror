import assert from 'node:assert/strict';
import { clickStep } from './browser-observations.mjs';
import { waitForInvitationReady } from './invitation-flow.mjs';

// 顶栏自动隐藏（Headroom 式）行为验证：隐藏只做 translateY，画框尺寸前后一致。
// 依赖 smoke 主流程注入的 page.clock 控制闲置计时，接入 phase8 阶段。
export async function verifyHeadroomBehavior(page, evidence) {
  const frameBox = () => page.locator('#room-outfit .hero-frame').evaluate(el => {
    const rect = el.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  const headerPinned = () => page.evaluate(() => !document.querySelector('.gallery-header').classList.contains('is-unpinned'));

  await clickStep(page, 1);
  await page.waitForFunction(() => Math.abs(document.querySelector('#room-outfit').getBoundingClientRect().x) < 1);
  const before = await frameBox();

  // 向下滚轮累计越过容差后隐藏；画框几何完全不变（顶栏只是叠加层）。
  await page.mouse.move(400, 400);
  await page.mouse.wheel(0, 40);
  await page.waitForFunction(() => document.querySelector('.gallery-header').classList.contains('is-unpinned'));
  const hidden = await frameBox();
  assert.deepEqual(hidden, before, 'hiding the header must not resize the hero frame');
  assert.equal(await headerPinned(), false, 'wheel accumulation unpins after the down tolerance');

  // 向上滚轮唤回；顶部热区唤回；闲置后再次隐藏。
  await page.mouse.wheel(0, -20);
  await page.waitForFunction(() => !document.querySelector('.gallery-header').classList.contains('is-unpinned'));
  assert.equal(await headerPinned(), true, 'an up wheel gesture re-pins the header');

  await page.mouse.wheel(0, 40);
  await page.waitForFunction(() => document.querySelector('.gallery-header').classList.contains('is-unpinned'));
  await page.mouse.move(10, 10);
  await page.waitForFunction(() => !document.querySelector('.gallery-header').classList.contains('is-unpinned'));
  assert.equal(await headerPinned(), true, 'the top hot zone reveals the header');

  // 指针悬停在顶栏上即锁定：闲置窗口内不隐藏；移开指针后闲置计时才生效。
  await page.clock.fastForward(10_000);
  assert.equal(await headerPinned(), true, 'hovering the header keeps it pinned through the idle window');
  await page.mouse.move(700, 400);
  const stripped = await page.locator('.dock-thumb-strip').evaluate(el => el.scrollLeft);
  await page.clock.fastForward(3000);
  await page.waitForFunction(() => document.querySelector('.gallery-header').classList.contains('is-unpinned'));
  assert.equal(await headerPinned(), false, 'idle timeout hides the header once the pointer leaves it');

  // dock 内滚轮不驱动顶栏：只滚动缩略条。
  await page.mouse.wheel(0, -20);
  await page.waitForFunction(() => !document.querySelector('.gallery-header').classList.contains('is-unpinned'));
  const stripBefore = stripped;
  await page.locator('.dock-thumb-strip').hover();
  await page.mouse.wheel(0, 360);
  const dockWhile = await page.evaluate(() => ({
    header: !document.querySelector('.gallery-header').classList.contains('is-unpinned'),
    scrolled: document.querySelector('.dock-thumb-strip').scrollLeft,
  }));
  assert.equal(dockWhile.header, true, 'wheel inside the dock leaves the header pinned while hovering');
  assert.ok(dockWhile.scrolled > stripBefore, 'dock wheel still scrolls the strip');
  await page.mouse.move(400, 600);

  // 01 展厅顶栏锁定：滚轮与闲置都不隐藏。
  await clickStep(page, 0);
  await page.waitForFunction(() => document.querySelector('#room-photo').getBoundingClientRect().x > -1);
  await page.mouse.wheel(0, 100);
  await page.clock.fastForward(10_000);
  assert.equal(await headerPinned(), true, 'room 01 keeps the header pinned through wheel and idle');

  // 02 中键盘 Tab 聚焦顶栏步骤按钮时唤回。
  await clickStep(page, 1);
  await page.waitForFunction(() => Math.abs(document.querySelector('#room-outfit').getBoundingClientRect().x) < 1);
  // clickStep 后指针仍悬在顶栏内（悬停即锁定）：先移到画面中央再打滚轮。
  await page.mouse.move(400, 400);
  await page.mouse.wheel(0, 40);
  await page.waitForFunction(() => document.querySelector('.gallery-header').classList.contains('is-unpinned'));
  const revealed = page.evaluate(() => {
    document.querySelector('.wordmark').focus({ preventScroll: true });
  });
  await revealed;
  await page.waitForFunction(() => !document.querySelector('.gallery-header').classList.contains('is-unpinned'));
  assert.equal(await headerPinned(), true, 'keyboard focus inside the header re-pins it');
  await page.evaluate(() => document.activeElement.blur());

  if (evidence) await page.screenshot({ path: `${evidence}/headroom-d.png` });
  return { frameStable: 'before/after identical', tolerances: 'down 24 up 12', hotZone: '32px reveals', idle: 'hides after 3s', locked: 'room 01 kept pinned', focus: 'keyboard re-pins' };
}

// 触屏视口：上滑隐藏、下滑唤回，01 锁定。
export async function verifyHeadroomTouch(base, evidence) {
  const { chromium } = (await import('node:module')).createRequire('/opt/browser/package.json')('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true, reducedMotion: 'reduce', serviceWorkers: 'block' });
    page.setDefaultTimeout(10_000);
    await page.clock.install();
    await page.goto(base);
    await page.locator('#open-invitation').tap();
    await waitForInvitationReady(page);

    await clickStep(page, 1);
    await page.waitForFunction(() => Math.abs(document.querySelector('#room-outfit').getBoundingClientRect().x) < 1);
    const swipe = async (fromY, toY, steps = 8) => {
      const session = await page.context().newCDPSession(page);
      try {
        await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 187, y: fromY }] });
        for (let step = 1; step <= steps; step++) {
          await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 187, y: fromY + (toY - fromY) * step / steps }] });
        }
        await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      } finally {
        await session.detach();
      }
    };
    // 慢速小步上滑：单步不足 12px/24px，累计位移跨过容差后仍须隐藏。
    await swipe(600, 500, 12);
    await page.waitForFunction(() => document.querySelector('.gallery-header').classList.contains('is-unpinned'));
    await swipe(400, 500, 12);
    await page.waitForFunction(() => !document.querySelector('.gallery-header').classList.contains('is-unpinned'));

    await clickStep(page, 0);
    await page.waitForFunction(() => document.querySelector('#room-photo').getBoundingClientRect().x > -1);
    await swipe(600, 500);
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => !document.querySelector('.gallery-header').classList.contains('is-unpinned')), true, 'room 01 stays pinned under touch');
    if (evidence) await page.screenshot({ path: `${evidence}/headroom-touch.png` });
    return { touch: 'swipe up hides, swipe down reveals', locked: 'room 01 pinned' };
  } finally {
    await browser.close();
  }
}

import assert from 'node:assert/strict';
import { waitForGalleryRoom } from './browser-observations.mjs';

export async function verifyDockWheel(page) {
  await page.locator('.stepper-link').nth(1).click();
  const strip = page.locator('.dock-thumb-strip');
  await strip.waitFor({ state: 'visible' });
  assert.ok(await strip.evaluate(el => el.scrollWidth > el.clientWidth), 'outfit list must overflow');
  const selected = () => page.locator('.dock-thumb-btn.is-active').getAttribute('data-arg');
  await page.locator('.dock-thumb-btn').first().click();
  const initialSelection = await selected();
  await page.waitForFunction(() => document.querySelector('.dock-thumb-strip').scrollLeft < 1);

  await strip.hover();
  await page.mouse.wheel(0, 360);
  await page.waitForFunction(() => document.querySelector('.dock-thumb-strip').scrollLeft > 100);
  assert.equal(await selected(), initialSelection, 'browsing must not change the selected outfit');
  await page.mouse.wheel(0, -1000);
  await page.waitForFunction(() => document.querySelector('.dock-thumb-strip').scrollLeft < 1);

  // Wheel handling must remain available after changing the selection.
  await page.locator('.dock-thumb-btn').nth(1).click();
  const nextSelection = await selected();
  await page.waitForFunction(() => document.querySelector('.dock-thumb-strip').scrollLeft < 1);
  await strip.hover();
  await page.mouse.wheel(0, 360);
  await page.waitForFunction(() => document.querySelector('.dock-thumb-strip').scrollLeft > 100);
  assert.equal(await selected(), nextSelection);

  const dispatch = options => strip.evaluate((el, options) => {
    const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...options });
    el.dispatchEvent(event);
    return event.defaultPrevented;
  }, options);
  assert.equal(await dispatch({ deltaY: 100, ctrlKey: true }), false, 'preserve zoom');
  assert.equal(await dispatch({ deltaX: 100 }), false, 'preserve horizontal gestures');
  assert.equal(await dispatch({ deltaY: 100, shiftKey: true }), false, 'preserve Shift+wheel');
  assert.equal(await dispatch({ deltaY: 3, deltaMode: 1 }), true, 'support wheel line units');
  assert.equal(await dispatch({ deltaY: 1, deltaMode: 2 }), true, 'support wheel page units');
  assert.equal(await dispatch({ deltaY: 100000 }), true, 'scroll to the last outfit');
  await page.waitForFunction(() => {
    const el = document.querySelector('.dock-thumb-strip');
    return el.scrollWidth - el.clientWidth - el.scrollLeft < 1;
  });
  assert.equal(await dispatch({ deltaY: 100 }), false, 'release wheel at the right boundary');
  assert.equal(await dispatch({ deltaY: -100000 }), true, 'return to the first outfit');
  await page.waitForFunction(() => document.querySelector('.dock-thumb-strip').scrollLeft < 1);
  assert.equal(await dispatch({ deltaY: -100 }), false, 'release wheel at the left boundary');

  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(id => document.querySelector('.dock-thumb-btn.is-active').dataset.arg !== id, nextSelection);
  await page.locator('.stepper-link').nth(2).click();
  // The scene dock inherits the outfit card system with a wider strip for its longer list;
  // drop the venues to exercise the fits-on-screen path.
  await page.evaluate(() => document.querySelectorAll('[data-action="select-venue"]').forEach(tile => tile.remove()));
  assert.equal(await dispatch({ deltaY: 100 }), false, 'do not consume wheel for a list that fits');
  await page.locator('.stepper-link').first().click();
}

export async function verifyDockSelectionPosition(page) {
  await page.locator('.stepper-link').nth(1).click();
  await page.locator('.dock-thumb-strip').evaluate(el => el.scrollTo({ left: el.scrollWidth / 2, behavior: 'instant' }));
  const target = await visibleOutfit(page);
  await page.evaluate(() => {
    const measure = () => {
      const strip = document.querySelector('.dock-thumb-strip');
      const dock = document.querySelector('#floating-dock');
      const next = dock.querySelector('[data-action="go-room"]');
      return [strip.scrollLeft, dock.scrollLeft, dock.scrollTop, dock.getBoundingClientRect().left,
        next.getBoundingClientRect().left, document.querySelector('#gallery-viewport').scrollLeft];
    };
    const before = measure();
    window.__dockPositionSamples = new Promise(resolve => {
      const samples = [];
      const until = performance.now() + 650;
      const sample = () => {
        samples.push(measure());
        if (performance.now() < until) requestAnimationFrame(sample);
        else resolve({ before, samples });
      };
      requestAnimationFrame(sample);
    });
  });
  await page.mouse.click(target.x, target.y);
  const result = await page.evaluate(() => window.__dockPositionSamples);
  assert.equal(await page.locator('.dock-thumb-btn.is-active').getAttribute('data-arg'), target.id,
    `click must select the sampled outfit at ${JSON.stringify(target)}`);
  assert.ok(result.before[0] > 100, 'check a selection far from the start of the list');
  assert.ok(result.samples.every(sample => sample.every((value, index) => Math.abs(value - result.before[index]) <= 1)),
    `clicking a visible outfit must keep the list, toolbar, next button and gallery still: ${JSON.stringify(result)}`);
  // Keyboard selection moves focus only: the strip keeps its browsing position and the outer
  // toolbar never scrolls to reveal the focused card.
  const selected = await page.locator('.dock-thumb-btn.is-active').getAttribute('data-arg');
  await page.locator('.stepper-link').first().click();
  await page.locator('.stepper-link').nth(1).click();
  // Re-entry rebuilds the dock, and the browser may asynchronously reveal a previously focused
  // card; take the baseline only after layout settles.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const baseline = await page.locator('.dock-thumb-strip').evaluate(el => el.scrollLeft);
  for (let i = 0; i < 12; i++) await page.keyboard.press('ArrowRight');
  await page.waitForFunction(id => document.querySelector('.dock-thumb-btn.is-active').dataset.arg !== id, selected);
  await page.waitForTimeout(500);
  const visible = await page.locator('.dock-thumb-btn.is-active').evaluate((el, baseline) => {
    const strip = el.parentElement;
    const dock = document.querySelector('#floating-dock');
    return {
      stripStayed: strip.scrollLeft === baseline,
      dockStill: dock.scrollLeft === 0 && dock.scrollTop === 0,
      dockFits: dock.getBoundingClientRect().width <= innerWidth + 1,
    };
  }, baseline);
  assert.ok(visible.stripStayed && visible.dockStill && visible.dockFits,
    `keyboard selection must keep the strip and outer toolbar still: ${JSON.stringify(visible)}`);
}

async function visibleOutfit(page) {
  // The dock moves with the gallery track. Stepper stability does not mean the room
  // has arrived; sample only after its transition ends and the card is hit-testable.
  await waitForGalleryRoom(page, '#room-outfit');
  const target = await page.waitForFunction(() => {
    const strip = document.querySelector('.dock-thumb-strip');
    const bounds = strip.getBoundingClientRect();
    const card = [...strip.children].find(el => {
      const rect = el.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      return !el.classList.contains('is-active') && rect.left >= bounds.left + 10 && rect.right <= bounds.right - 10
        && document.elementFromPoint(x, y)?.closest('.dock-thumb-btn') === el;
    });
    if (!card) return null;
    const rect = card.getBoundingClientRect();
    return { id: card.dataset.arg, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  return target.jsonValue();
}

export async function verifyDockDrag(page) {
  await page.locator('.stepper-link').nth(1).click();
  const strip = page.locator('.dock-thumb-strip');
  const selected = () => page.locator('.dock-thumb-btn.is-active').getAttribute('data-arg');
  const scrollLeft = () => strip.evaluate(el => el.scrollLeft);
  await strip.evaluate(el => el.scrollTo({ left: el.scrollWidth / 2, behavior: 'instant' }));
  const before = await scrollLeft();
  const original = await selected();
  const target = await visibleOutfit(page);
  await page.mouse.move(target.x, target.y);
  await page.mouse.down();
  await page.mouse.move(target.x - 120, target.y, { steps: 12 });
  assert.equal(await strip.evaluate(el => el.classList.contains('is-dragging')), true);
  await page.mouse.up();
  await page.waitForTimeout(550);
  assert.ok(Math.abs(await scrollLeft() - before - 120) <= 1, 'drag must follow the mouse without snap or extra scrolling');
  assert.equal(await selected(), original, 'dragging from a card must not select it');
  assert.equal(await strip.evaluate(el => el.classList.contains('is-dragging')), false);

  // A small hand movement remains a normal click, including immediately after a drag.
  const click = await visibleOutfit(page);
  await page.mouse.move(click.x, click.y);
  await page.mouse.down();
  await page.mouse.move(click.x + 2, click.y);
  await page.mouse.up();
  assert.equal(await selected(), click.id);

  const bounds = await strip.boundingBox();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 20, bounds.y + bounds.height / 2, { steps: 4 });
  await page.mouse.move(bounds.x - 20, bounds.y - 30, { steps: 8 });
  await page.mouse.up();
  assert.equal(await selected(), click.id, 'releasing outside the strip must not select another outfit');
  assert.equal(await strip.evaluate(el => el.classList.contains('is-dragging')), false, 'outside release must clear dragging');
  const released = await scrollLeft();
  await page.mouse.move(bounds.x + 30, bounds.y + 30);
  assert.equal(await scrollLeft(), released, 'moving after release must not continue dragging');

  for (const edge of ['start', 'end']) {
    await strip.evaluate((el, edge) => el.scrollTo({ left: edge === 'start' ? 0 : el.scrollWidth, behavior: 'instant' }), edge);
    const initial = await scrollLeft();
    const target = await visibleOutfit(page);
    await page.mouse.move(target.x, target.y);
    await page.mouse.down();
    await page.mouse.move(target.x + (edge === 'start' ? 50 : -50), target.y, { steps: 5 });
    await page.mouse.up();
    assert.ok(Math.abs(await scrollLeft() - initial) <= 1, `dragging beyond the ${edge} boundary must stay clamped`);
  }

  const finalClick = await visibleOutfit(page);
  await page.mouse.click(finalClick.x, finalClick.y);
  assert.equal(await selected(), finalClick.id, 'normal selection must still work after outside release and edge drags');
  assert.equal(await page.locator('#floating-dock').evaluate(el => el.scrollLeft), 0);
  // Returning to this room creates a fresh strip; delegated dragging must still work.
  await page.locator('.stepper-link').first().click();
  await page.locator('.stepper-link').nth(1).click();
  await strip.evaluate(el => el.scrollTo({ left: el.scrollWidth / 2, behavior: 'instant' }));
  const fresh = await visibleOutfit(page);
  const freshScroll = await scrollLeft();
  await page.mouse.move(fresh.x, fresh.y);
  await page.mouse.down();
  await page.mouse.move(fresh.x - 80, fresh.y, { steps: 8 });
  await page.mouse.up();
  assert.ok(Math.abs(await scrollLeft() - freshScroll - 80) <= 1, 'dragging must survive toolbar reconstruction');
}

export async function verifyDockTouch(page) {
  await page.locator('.stepper-link').nth(1).click();
  await page.locator('.dock-thumb-btn').first().tap();
  const strip = page.locator('.dock-thumb-strip');
  const bounds = await strip.boundingBox();
  const selected = await page.locator('.dock-thumb-btn.is-active').getAttribute('data-arg');
  const session = await page.context().newCDPSession(page);
  try {
    const x = bounds.x + bounds.width - 25;
    const y = bounds.y + bounds.height / 2;
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let step = 1; step <= 10; step++) {
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - step * 12, y }] });
    }
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForFunction(() => document.querySelector('.dock-thumb-strip').scrollLeft > 40);
    assert.equal(await page.locator('.dock-thumb-btn.is-active').getAttribute('data-arg'), selected, 'native touch swipe must not select an outfit');
    assert.equal(await strip.evaluate(el => el.classList.contains('is-dragging')), false, 'touch keeps native scrolling');
  } finally {
    await session.detach();
  }
}

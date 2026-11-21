import assert from 'node:assert/strict';

function currentRoom(page) {
  return page.evaluate(() => [...document.querySelectorAll('.stepper-link')].findIndex(link => link.getAttribute('aria-current') === 'step'));
}

// 事件注入与渲染进程派发之间存在异步窗口：点击后一律等待状态收敛再断言。
async function waitForRoom(page, index) {
  await page.waitForFunction(expected => {
    return [...document.querySelectorAll('.stepper-link')].findIndex(link => link.getAttribute('aria-current') === 'step') === expected;
  }, index);
}

async function waitForPressed(page, arg, expected) {
  await page.waitForFunction(([argValue, pressed]) => {
    return document.querySelector(`.dock-thumb-btn[data-arg="${argValue}"]`)?.getAttribute('aria-pressed') === pressed;
  }, [arg, expected]);
}

export async function verifyAuthorizationFlow(page, token) {
  // 键盘选择真实目录瓦片：Enter 选中并保持焦点，选中态即时可见。
  await page.locator('.stepper-link').nth(1).click();
  await waitForRoom(page, 1);
  const keyboardCard = page.locator('.dock-thumb-btn[data-arg="W002"]');
  await keyboardCard.focus();
  await page.keyboard.press('Enter');
  await waitForPressed(page, 'W002', 'true');
  assert.equal(await keyboardCard.evaluate(element => element === document.activeElement), true, 'keyboard selection keeps the card focused');
  await page.locator('.dock-thumb-btn[data-arg="W001"]').click();
  await waitForPressed(page, 'W001', 'true');

  // 生成码弹窗：焦点进入输码框、Tab 循环封闭、Escape 关闭后回到触发按钮。
  await page.locator('.stepper-link').nth(2).click();
  await page.locator('#generate').click();
  await page.locator('#access-dialog[open]').waitFor();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'access-token');
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.querySelector('#access-dialog').contains(document.activeElement)), true, 'dialog traps keyboard focus');
  }
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('#access-dialog').open
    && document.activeElement?.id === 'generate', undefined, { timeout: 5_000 });

  // 挂起预检：重复确认共享一次核验；Esc 取消后迟到的授权响应不触发任何上传。
  let release;
  let started;
  const waiting = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let checks = 0;
  let finish;
  const finished = new Promise(resolve => { finish = resolve; });
  let uploads = 0;
  const observe = request => { if (request.url().endsWith('/api/tryon/couple')) uploads++; };
  page.on('request', observe);
  const handler = async route => {
    checks++;
    assert.equal(route.request().postData(), null);
    started();
    await gate;
    // 取消路径下浏览器已丢弃连接；不对该 route 做任何回写（fulfill/abort
    // 都会触发 Playwright 的 Invalid InterceptionId 并污染后续分发）。
    finish();
  };
  await page.route('**/api/tryon/authorize', handler);
  await page.locator('#generate').click();
  await page.locator('#access-token').fill(token);
  await page.evaluate(() => { const form = document.querySelector('#access-form'); form.requestSubmit(); form.requestSubmit(); });
  await waiting;
  assert.equal(checks, 1, 'duplicate confirms share one preflight');
  assert.equal(await page.evaluate(() => document.querySelector('#access-dialog').contains(document.activeElement)), true, 'pending preflight retains focus in dialog');
  assert.equal(await page.locator('#confirm-access').isDisabled(), true);
  await page.keyboard.press('Escape');
  await page.locator('#access-dialog').waitFor({ state: 'hidden' });
  release();
  await finished;
  await page.unroute('**/api/tryon/authorize', handler);
  await page.waitForFunction(() => !document.querySelector('#generate').disabled);
  assert.equal(await page.locator('#access-token').inputValue(), '');
  assert.equal(await page.locator('#room-photo-content .hero-photo').count(), 1, 'cancelled preflight preserves the uploaded photo');
  assert.equal(uploads, 0, 'late cancelled authorization cannot upload photos');
  page.off('request', observe);
  await waitForRoom(page, 2);
  return { keyboardSelection: 'retains focus', dialogFocus: 'trapped and restored', duplicatePreflight: 'one', cancelledPreflight: 'zero uploads' };
}

export async function verifyMobileForm(page, fixture) {
  await page.setViewportSize({ width: 375, height: 900 });
  // 375 宽：顶栏步骤与底部 dock 不得溢出；帮助弹窗可用。
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  // 逐步校验：缺合照 → 缺造型 → 缺场地图 → 生成码弹窗。
  await page.locator('.stepper-link').nth(2).click();
  await page.locator('#generate').click();
  await page.locator('#form-alert').getByText('请先在「01 合照」上传一张有效的合照。', { exact: true }).waitFor();
  assert.equal(await page.locator('#access-dialog').evaluate(dialog => dialog.open), false);
  await page.locator('#couple-image').setInputFiles({ name: 'mobile-couple.png', mimeType: 'image/png', buffer: fixture });
  await page.waitForFunction(() => document.querySelector('#room-photo-content .hero-photo')?.src.startsWith('blob:'));
  await page.locator('.stepper-link').nth(2).click();
  await page.locator('#generate').click();
  await page.locator('#form-alert').getByText('请先在「02 造型」选择一套婚礼造型。', { exact: true }).waitFor();
  await page.locator('.dock-thumb-btn[data-arg="W001"]').click();
  await waitForPressed(page, 'W001', 'true');
  await page.locator('.stepper-link').nth(2).click();
  await page.locator('.dock-thumb-btn[data-arg="upload"]').click();
  await page.waitForFunction(() => document.querySelector('.dock-thumb-btn[data-arg="upload"]')?.getAttribute('aria-pressed') === 'true');
  await page.locator('#generate').click();
  await page.locator('#form-alert').getByText('请上传一张有效的场地照片，或切换为保留原背景。', { exact: true }).waitFor();
  await page.locator('#scene-image').setInputFiles({ name: 'mobile-scene.png', mimeType: 'image/png', buffer: fixture });
  await page.waitForFunction(() => document.querySelector('#room-scene .is-front img')?.src.startsWith('blob:'));
  await page.locator('#generate').click();
  await page.locator('#access-dialog[open]').waitFor();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'access-token');
  await page.locator('#cancel-access').click();
  await page.locator('#access-dialog').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#room-photo-content .hero-photo').count(), 1, 'cancelled code dialog keeps the uploaded photo');
  assert.equal(await page.locator('#download-result').count(), 0, 'sample download stays unavailable without a real result');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  return { width: 375, conditionalScene: 'required before code', codeDialog: 'focused and cancellable', sampleDownload: 'unavailable', navigation: 'passed' };
}

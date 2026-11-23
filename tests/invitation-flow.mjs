import assert from 'node:assert/strict';

export async function waitForInvitationReady(page) {
  await page.waitForFunction(() => {
    const invitation = document.querySelector('#invitation-screen');
    const experience = document.querySelector('#experience');
    return invitation?.hidden && experience && !experience.hidden
      && !experience.classList.contains('is-revealing');
  });
  await page.locator('#experience').waitFor({ state: 'visible' });
}

export async function verifyInvitationFlow(page, base) {
  const cases = [
    { motion: 'reduce', action: 'complete' },
    { motion: 'no-preference', action: 'complete' },
    { motion: 'no-preference', action: 'click' },
    { motion: 'no-preference', action: 'Escape' },
  ];
  for (const { motion, action } of cases) {
    await page.emulateMedia({ reducedMotion: motion });
    assert.equal((await page.goto(base)).status(), 200);
    assert.equal(await page.locator('#experience').isVisible(), false);
    await page.locator('#open-invitation').click();
    if (action !== 'complete') {
      await page.locator('#invitation-screen.is-cracked').waitFor();
      if (action === 'click') await page.mouse.click(12, 12);
      else await page.keyboard.press(action);
      assert.equal(await page.locator('#experience').isVisible(), true, `${action} reveals the gallery`);
    }
    await waitForInvitationReady(page);
    assert.equal(await page.locator('#open-invitation').isDisabled(), true);
    assert.equal(await page.locator('.stepper-link').first().getAttribute('aria-current'), 'step');
  }
  return { reducedMotion: 'passed', normalMotion: 'passed', clickSkip: 'passed', escapeSkip: 'passed' };
}

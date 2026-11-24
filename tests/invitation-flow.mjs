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
  await page.addInitScript(() => {
    window.__invitationAudioEvents = [];
    for (const type of ['playing', 'ended']) {
      document.addEventListener(type, event => {
        if (event.target.id === 'invitation-sound') window.__invitationAudioEvents.push(type);
      }, true);
    }
  });
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
    assert.deepEqual(await page.locator('#invitation-sound').evaluate(sound => ({ paused: sound.paused, time: sound.currentTime })), { paused: true, time: 0 });
    if (motion === 'reduce') {
      await page.locator('#open-invitation').focus();
      await page.keyboard.press('Enter');
    } else await page.locator('#open-invitation').click();
    await page.waitForFunction(() => window.__invitationAudioEvents.includes('playing'));
    if (action !== 'complete') {
      await page.locator('#invitation-screen.is-cracked').waitFor();
      if (action === 'click') await page.mouse.click(12, 12);
      else await page.keyboard.press(action);
      assert.equal(await page.locator('#experience').isVisible(), true, `${action} reveals the gallery`);
    }
    await waitForInvitationReady(page);
    assert.equal(await page.locator('#open-invitation').isDisabled(), true);
    assert.equal(await page.locator('.stepper-link').first().getAttribute('aria-current'), 'step');
    if (action === 'complete') {
      await page.waitForFunction(() => document.querySelector('#invitation-sound').ended);
      assert.deepEqual(await page.evaluate(() => window.__invitationAudioEvents), ['playing', 'ended']);
      // The mix length lives in the asset manifest; decode rounding tolerates 50 ms.
      const { duration, expected } = await page.locator('#invitation-sound').evaluate(async sound => {
        const manifest = await (await fetch('/web/public/manifest.json')).json();
        return { duration: sound.duration, expected: manifest.audio[0].durationSeconds };
      });
      assert.ok(Math.abs(duration - expected) < 0.05, 'the full approved mix must play through its tail');
    } else {
      assert.deepEqual(await page.locator('#invitation-sound').evaluate(sound => ({ paused: sound.paused, time: sound.currentTime })), { paused: true, time: 0 });
      assert.deepEqual(await page.evaluate(() => window.__invitationAudioEvents), ['playing']);
    }
  }
  return { reducedMotion: 'passed', normalMotion: 'passed', clickSkip: 'passed', escapeSkip: 'passed', audio: 'real playback; no autoplay; one shot; natural end or stop on skip' };
}

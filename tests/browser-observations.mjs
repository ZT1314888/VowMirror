import assert from 'node:assert/strict';

export const generationURL = url => /^\/api\/tryon(?:\/|$)/.test(new URL(url).pathname);

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

import assert from 'node:assert/strict';
import { clickStep } from './browser-observations.mjs';

export async function confirmGeneration(page) {
  await page.locator('#access-dialog[open]').waitFor();
  assert.equal(await page.locator('#access-token').inputValue(), '', 'every submission asks for a new code');
  const token = process.env.TRYON_API_KEYS.split(',')[0].trim();
  await page.locator('#access-token').fill(token);
  await page.locator('#confirm-access').click();
  await page.locator('#access-dialog').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#access-token').inputValue(), '', 'code is cleared after use');
}

// 「生成成片」入口固定在 03 场景展厅的底部 dock；重新生成共用同一入口。
export async function submitGeneration(page) {
  await clickStep(page, 2);
  await page.locator('#generate').click();
  await confirmGeneration(page);
}

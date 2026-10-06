import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import type { SimOptions } from '../support/simulator';

const simulator = ts.transpileModule(readFileSync(new URL('../support/simulator.ts', import.meta.url), 'utf8').replace(/^export /gm, ''), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
async function start(page: Page, options: SimOptions = {}) {
  await page.addInitScript({ content: `${simulator}\ninstallSerialSimulator(${JSON.stringify(options)});` });
  await page.goto('./');
}
async function connect(page: Page) {
  await page.getByRole('button', { name: 'Choose serial port' }).click();
  await page.getByRole('button', { name: 'ISP mode entered — continue' }).click();
  await expect(page.getByRole('status')).toContainText('LPC1769 connected');
}
async function stats(page: Page) { return page.evaluate(() => (window as any).simulator.stats()); }
async function memory(page: Page, address: number, size: number): Promise<number[]> { return page.evaluate(([a, n]) => (window as any).simulator.read(a, n), [address, size]); }
async function loadImage(page: Page, bytes: number[], address = '0x1000') {
  await page.getByLabel('BIN start address').fill(address);
  await page.locator('#firmware').setInputFiles({ name: 'generated.bin', mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) });
  await expect(page.getByRole('status')).toContainText('Image loaded');
}

test('requires manual ISP entry on every session and defaults to 230400', async ({ page }) => {
  await start(page);
  await page.getByRole('button', { name: 'Choose serial port' }).click();
  expect((await stats(page)).writes).toBe(0); expect((await stats(page)).opens).toBe(0);
  await expect(page.getByRole('button', { name: 'Review flash plan' })).toBeDisabled();
  await page.getByRole('button', { name: 'ISP mode entered — continue' }).click();
  await expect(page.getByRole('status')).toContainText('LPC1769 connected');
  expect((await stats(page)).openOptions.baudRate).toBe(230400);
  expect((await stats(page)).signals).toBe(0);
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  const previous = await stats(page);
  await expect(page.getByRole('button', { name: 'ISP mode entered — continue' })).toBeVisible();
  expect((await stats(page)).writes).toBe(previous.writes);
});
test('flashes through Web Serial, preserves neighboring bytes, verifies and backs up', async ({ page }) => {
  const requests: { method: string; url: string }[] = [];
  page.on('request', request => requests.push({ method: request.method(), url: request.url() }));
  await start(page, { fragment: true, writeResends: 1, badReadChecksums: 1 });
  await connect(page);
  const original = await memory(page, 0, 12288);
  await loadImage(page, [10, 20, 30, 40, 50], '0x1003');
  await page.getByRole('button', { name: 'Review flash plan' }).click();
  await expect(page.getByRole('status')).toContainText('Flash plan ready');
  expect((await stats(page)).erases).toEqual([]);
  await page.getByRole('button', { name: 'Flash and verify', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Flash complete');
  const actual = await memory(page, 0, 12288); original.splice(4099, 5, 10, 20, 30, 40, 50);
  expect(actual).toEqual(original); expect((await stats(page)).erases).toEqual([1]);
  await page.getByRole('button', { name: 'Verify image', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Verification complete');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Back up device' }).click();
  const backup = await download;
  expect(backup.suggestedFilename()).toBe('lpc1769-backup.bin');
  const content = readFileSync((await backup.path())!);
  expect(content.length).toBe(512 * 1024); expect([...content.slice(0, 12288)]).toEqual(original);
  await expect(page.getByRole('status')).toContainText('Backup complete');
  expect(requests.every(request => request.method === 'GET' && request.url.startsWith('http://127.0.0.1:4173/lpc-web-flash/'))).toBe(true);
});
test('blocks protected images before erase and requires fresh ISP after an error', async ({ page }) => {
  await start(page); await connect(page);
  await loadImage(page, [0x78, 0x56, 0x34, 0x12], '0x2fc');
  await page.getByRole('button', { name: 'Review flash plan' }).click();
  await expect(page.getByRole('status')).toContainText('protection');
  expect((await stats(page)).erases).toEqual([]);
  await expect(page.getByRole('button', { name: 'ISP mode entered — continue' })).toBeVisible();
  expect((await stats(page)).opens).toBe(1);
});
test('requires successful vector remapping before backup or erase', async ({ page }) => {
  await start(page, { mappingFails: true }); await connect(page);
  await page.getByRole('button', { name: 'Back up device' }).click();
  await expect(page.getByRole('status')).toContainText('mapping could not be confirmed');
  expect((await stats(page)).erases).toEqual([]);
  await expect(page.getByRole('button', { name: 'ISP mode entered — continue' })).toBeVisible();
});
test('disconnection clears the active session without automatic reconnect', async ({ page }) => {
  await start(page); await connect(page);
  await page.evaluate(() => (window as any).simulator.disconnect());
  await expect(page.getByRole('status')).toContainText('unplugged');
  await expect(page.getByRole('button', { name: 'Back up device' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'ISP mode entered — continue' })).toBeVisible();
  expect((await stats(page)).opens).toBe(1);
});
test('unknown chips cannot flash, and file errors remain visible', async ({ page }) => {
  await start(page, { partId: 123 });
  await page.getByRole('button', { name: 'Choose serial port' }).click();
  await page.getByRole('button', { name: 'ISP mode entered — continue' }).click();
  await expect(page.getByRole('status')).toContainText('unsupported');
  await expect(page.getByRole('button', { name: 'Back up device' })).toBeDisabled();
  await page.locator('#firmware').setInputFiles({ name: 'bad.hex', mimeType: 'text/plain', buffer: Buffer.from(':040000000102030400\n:00000001FF') });
  await expect(page.getByRole('status')).toContainText('checksum mismatch');
});
test('unsupported browser explains the requirement', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'serial', { configurable: true, value: undefined }));
  await page.goto('./');
  await expect(page.getByText('Web Serial is unavailable', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Choose serial port' })).toBeDisabled();
});
test('desktop and mobile layout remain usable', async ({ page }, testInfo) => {
  await start(page);
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.screenshot({ path: testInfo.outputPath('desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('heading', { name: 'LPC flash programmer.' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('mobile.png'), fullPage: true });
});

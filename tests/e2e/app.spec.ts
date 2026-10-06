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
  await page.getByText('Code read protection & chip erase', { exact: true }).click();
  await expect(page.getByRole('heading', { name: 'LPC flash programmer.' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('mobile.png'), fullPage: true });
});
for (const crpLevel of [1, 2] as const) test(`erases CRP${crpLevel} without reading firmware, then requires a fresh manual session`, async ({ page }) => {
  await start(page, { crpLevel, uidRestricted: true, fragment: true }); await connect(page);
  await page.getByText('Code read protection & chip erase', { exact: true }).click();
  await expect(page.locator('#protection-status')).toContainText('level unknown');
  await expect(page.locator('#backup')).toBeDisabled();
  await expect(page.locator('#prepare-protection')).toBeDisabled();
  await expect(page.locator('#erase-chip')).toBeDisabled();
  expect((await stats(page)).erases).toEqual([]);
  await page.locator('#erase-confirm').check();
  await page.locator('#erase-chip').click();
  await expect(page.getByRole('status')).toContainText('Chip erase complete');
  const result = await stats(page);
  expect(result.commands.filter((c: string) => c.startsWith('E '))).toEqual(['E 0 29']);
  expect(result.commands.filter((c: string) => /^[WG] /.test(c))).toEqual([]);
  expect(result.commands).toContain('I 0 29');
  expect(await page.evaluate(() => (window as any).simulator.rom.flash.every((b: number) => b === 255))).toBe(true);
  await expect(page.locator('#boot-checkpoint')).toContainText('Remove and restore board power');
  await expect(page.locator('#erase-confirm')).not.toBeChecked();
  expect(result.opens).toBe(1);
  await page.getByRole('button', { name: 'ISP mode entered — continue' }).click();
  await expect(page.getByRole('status')).toContainText('LPC1769 connected');
  await expect(page.locator('#protection-status')).toContainText('Disabled');
  expect((await stats(page)).opens).toBe(2);
  await loadImage(page, [10, 20, 30], '0x1000');
  await page.locator('#prepare').click();
  await expect(page.getByRole('status')).toContainText('Flash plan ready');
  await page.locator('#flash').click();
  await expect(page.getByRole('status')).toContainText('Flash complete');
  expect(await memory(page, 4096, 3)).toEqual([10, 20, 30]);
});
for (const level of ['crp1', 'crp2'] as const) test(`sets ${level}, preserves firmware, verifies before activation and recovers with erase`, async ({ page }) => {
  await start(page); await connect(page);
  const before = await memory(page, 0, 8192);
  await page.getByText('Code read protection & chip erase', { exact: true }).click();
  await page.locator('#protection').selectOption(level);
  await page.locator('#prepare-protection').click();
  await expect(page.getByRole('status')).toContainText('Protection plan ready');
  await expect(page.locator('#flash')).toBeDisabled();
  expect((await stats(page)).erases).toEqual([]);
  await page.locator('#protection-confirm').check();
  await page.locator('#flash').click();
  await expect(page.getByRole('status')).toContainText('Power-cycle the board');
  before.splice(0x2fc, 4, ...(level === 'crp1' ? [0x78, 0x56, 0x34, 0x12] : [0x21, 0x43, 0x65, 0x87]));
  expect(await memory(page, 0, 8192)).toEqual(before);
  expect((await stats(page)).copies.at(-1)).toBe(0);
  await expect(page.locator('#protection-confirm')).not.toBeChecked();
  await page.getByRole('button', { name: 'ISP mode entered — continue' }).click();
  await expect(page.getByRole('status')).toContainText('Read protection detected');
  await expect(page.locator('#backup')).toBeDisabled();
  await page.locator('#erase-confirm').check(); await page.locator('#erase-chip').click();
  await expect(page.getByRole('status')).toContainText('Chip erase complete');
});
for (const options of [{ crpLevel: 3 as const }, { crpLevel: 2 as const, eraseNotBlank: true }]) test(`reports erase failure without retry or false success (${JSON.stringify(options)})`, async ({ page }) => {
  await start(page, options); await connect(page);
  await page.getByText('Code read protection & chip erase', { exact: true }).click();
  await page.locator('#erase-confirm').check(); await page.locator('#erase-chip').click();
  await expect(page.getByRole('status')).toContainText(options.eraseNotBlank ? 'failed blank check' : 'Code read protection enabled');
  expect((await stats(page)).commands.filter((c: string) => c.startsWith('E '))).toEqual(['E 0 29']);
  await expect(page.locator('#boot-checkpoint')).toContainText('Remove and restore board power');
  await expect(page.locator('#erase-confirm')).not.toBeChecked();
});
test('explicit firmware protection override is previewed and confirmation resets when the plan changes', async ({ page }) => {
  await start(page); await connect(page);
  await loadImage(page, [0x78, 0x56, 0x34, 0x12], '0x2fc');
  await page.getByText('Code read protection & chip erase', { exact: true }).click();
  await page.locator('#protection').selectOption('crp2');
  await page.locator('#prepare').click();
  await expect(page.locator('#plan-summary')).toContainText('CRP2');
  await expect(page.locator('#flash')).toBeDisabled();
  await page.locator('#protection-confirm').check();
  await expect(page.locator('#flash')).toBeEnabled();
  await page.locator('#protection').selectOption('disabled');
  await expect(page.locator('#flash')).toBeDisabled();
  await expect(page.locator('#protection-confirm')).not.toBeChecked();
  expect((await stats(page)).erases).toEqual([]);
  await page.locator('#prepare').click();
  await expect(page.getByRole('status')).toContainText('Image already matches');
});
test('shows the requested warning and removes the unwanted copy', async ({ page }) => {
  await start(page);
  await expect(page.locator('footer')).toContainText('- warning: use at your own risk -');
  await expect(page.locator('body')).not.toContainText('Hardware validation pending');
  await expect(page.locator('body')).not.toContainText('THE DIRECT ROUTE TO YOUR DEVICE');
  await expect(page.locator('body')).not.toContainText('A 2 Mbaud RAM loader is outside this version.');
});

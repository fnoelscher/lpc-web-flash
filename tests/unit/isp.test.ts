import { expect, it } from 'vitest';
import { IspClient, RAM } from '../../src/core/isp';
import { Rom, type SimOptions } from '../support/simulator';

export async function setup(options: SimOptions = {}) {
  const queue: string[] = [];
  const rom = new Rom(data => queue.push(...data.split('\r\n').filter(Boolean)), options);
  const client = new IspClient({ write: async text => { rom.receive(text); }, line: async () => { const line = queue.shift(); if (line === undefined) throw new Error('No simulated reply'); return line; } });
  await client.connect(12000);
  return { client, rom, queue };
}
it('identifies the chip and confirms mapping before exposing flash vectors', async () => {
  const { client, rom } = await setup();
  expect(client.identity?.device?.name).toBe('LPC1769');
  expect(rom.mapped).toBe(false);
  expect(await client.readFlash(0, 32)).toEqual(rom.flash.slice(0, 32));
  expect(rom.mapped).toBe(true);
  expect(rom.commands).toContain(`G ${RAM} T`);
  expect(rom.commands).toContain('R 1074774080 4');
  expect(rom.erases).toHaveLength(0);
});
it('fails closed for unknown devices and unsuccessful mapping', async () => {
  const unknown = await setup({ partId: 123 });
  await expect(unknown.client.ensureFlashMapping()).rejects.toThrow('Unknown');
  expect(unknown.rom.commands.some(c => c.startsWith('W '))).toBe(false);
  const broken = await setup({ mappingFails: true });
  await expect(broken.client.readFlash(0, 4)).rejects.toThrow('mapping');
  expect(broken.rom.erases).toHaveLength(0);
});
it('recovers checksummed groups with bounded RESEND retries', async () => {
  const { client, rom } = await setup({ writeResends: 2, badReadChecksums: 2 });
  await client.ensureFlashMapping();
  const data = Uint8Array.from({ length: 1024 }, (_, i) => i & 255);
  await client.writeRam(data);
  expect(rom.ram.slice(512, 1536)).toEqual(data);
  expect(await client.readFlash(4096, 4096)).toEqual(rom.flash.slice(4096, 8192));
  rom.options.badReadChecksums = 4;
  await expect(client.readFlash(4096, 4)).rejects.toThrow('retry limit');
});
it('prepares separately before every erase and copy', async () => {
  const { client, rom } = await setup();
  await client.ensureFlashMapping();
  await client.eraseSector(1);
  await client.programBlock(4096, new Uint8Array(1024).fill(42));
  await client.programBlock(5120, new Uint8Array(1024).fill(43));
  for (const [i, command] of rom.commands.entries()) if (/^[EC] /.test(command)) expect(rom.commands[i - 1]).toBe('P 1 1');
  expect(rom.flash[4096]).toBe(42); expect(rom.flash[5120]).toBe(43);
});
it.each([1, 2] as const)('connects to CRP%i without a helper and erases all sectors in one command', async crpLevel => {
  const { client, rom, queue } = await setup({ crpLevel, uidRestricted: true });
  expect(client.identity?.readProtected).toBe(true);
  expect(client.identity?.uid).toEqual([]);
  expect(client.identity?.protection).toContain('level unknown');
  await expect(client.readFlash(0, 4)).rejects.toThrow('protection');
  expect(rom.commands.some(c => /^[WG] /.test(c))).toBe(false);
  await client.chipErase();
  expect(rom.commands.filter(c => /^[UPEI] /.test(c))).toEqual(['U 23130', 'P 0 29', 'E 0 29', 'I 0 29']);
  expect(rom.flash.every(byte => byte === 255)).toBe(true);
  expect(rom.crpLevel).toBe(crpLevel); // Latched until the next power cycle.
  expect(queue).toEqual([]);
  await expect(client.chipErase()).rejects.toThrow('Power-cycle');
  await expect(client.readFlash(0, 4)).rejects.toThrow('Power-cycle');
  rom.reset(); await client.connect(12000);
  expect(client.identity?.readProtected).toBe(false);
  // A fresh client is required after destructive operations, even after a new handshake.
  await expect(client.readFlash(0, 4)).rejects.toThrow('Power-cycle');
});
it('uses the actual device sector count and refuses unknown-chip erasure', async () => {
  const small = await setup({ partId: 0x25001118, crpLevel: 2 });
  await small.client.chipErase();
  expect(small.rom.commands).toContain('E 0 7');
  expect(small.rom.commands).toContain('I 0 7');
  expect(small.rom.erases).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  const unknown = await setup({ partId: 123 });
  await expect(unknown.client.chipErase()).rejects.toThrow('Unknown');
  expect(unknown.rom.commands.some(c => /^[UPE] /.test(c))).toBe(false);
});
it.each([{ crpLevel: 3 as const }, { crpLevel: 2 as const, eraseFails: true }, { crpLevel: 1 as const, eraseNotBlank: true }])('does not retry or claim success when erase/blank check fails (%j)', async options => {
  const { client, rom, queue } = await setup(options);
  await expect(client.chipErase()).rejects.toThrow(options.eraseNotBlank ? 'blank check' : options.eraseFails ? 'Busy' : 'protection');
  expect(rom.commands.filter(c => c.startsWith('E '))).toEqual(['E 0 29']);
  expect(queue).toEqual([]); // Includes the two trailing SECTOR_NOT_BLANK words.
  await expect(client.chipErase()).rejects.toThrow('Power-cycle');
  expect(rom.commands.filter(c => c.startsWith('E '))).toHaveLength(1);
});

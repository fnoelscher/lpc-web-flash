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

import { describe, expect, it } from 'vitest';
import { Rom } from '../support/simulator';
import { devices } from '../../src/core/devices';
import { parseBin, parseHex, repairVectorChecksum } from '../../src/core/image';
import { Cancelled, executeFlash, prepareFlash, recoveryHex, verifyImage, type Control, type FlashTarget } from '../../src/core/flash';

const device = devices[0]!;
const control = (): Control => ({ cancelled: false, progress: () => {} });
function target() {
  const flash = new Rom(() => {}).flash;
  const events: string[] = [];
  const io: FlashTarget = {
    readFlash: async (address, length) => { events.push(`R ${address}`); return flash.slice(address, address + length); },
    eraseSector: async index => { events.push(`E ${index}`); const s = device.sectors[index]!; flash.fill(255, s.start, s.start + s.size); },
    programBlock: async (address, data) => { events.push(`C ${address}`); flash.set(data, address); },
  };
  return { flash, events, io };
}
describe('preserving flash transactions', () => {
  it('preserves bootloader, sparse gaps and partial sector tails across small/large sectors', async () => {
    const { flash, io, events } = target(), original = flash.slice();
    const image = { name: 'generated', size: 5, segments: [{ address: 65534, data: new Uint8Array([9, 8, 7]) }, { address: 66001, data: new Uint8Array([4, 3]) }] };
    const plan = await prepareFlash(io, device, image, control());
    expect(events.every(e => e.startsWith('R'))).toBe(true);
    expect(plan.sectors.map(s => s.sector.index)).toEqual([15, 16]);
    const recovery = parseHex('restore', recoveryHex(plan));
    expect(recovery.segments[0]?.address).toBe(61440);
    expect(recovery.segments[0]?.data).toEqual(original.slice(61440, 98304));
    await executeFlash(io, plan, control());
    original.set([9, 8, 7], 65534); original.set([4, 3], 66001);
    expect(flash).toEqual(original);
    await verifyImage(io, device, image, control());
  });
  it('does not erase if any preservation read fails', async () => {
    const { io, events } = target(), read = io.readFlash;
    io.readFlash = async (address, size) => { if (address === 8192) throw new Error('read failure'); return read(address, size); };
    await expect(prepareFlash(io, device, parseBin('x', new Uint8Array(8192), 4096), control())).rejects.toThrow('read failure');
    expect(events.every(e => e.startsWith('R'))).toBe(true);
  });
  it('never erases sectors that already match', async () => {
    const { flash, io, events } = target();
    const plan = await prepareFlash(io, device, parseBin('x', flash.slice(4096, 4099), 4096), control());
    expect(plan.changedBytes).toBe(0);
    expect(await executeFlash(io, plan, control())).toBe(0);
    expect(events.some(e => e.startsWith('E'))).toBe(false);
  });
  it.each([0x12345678, 0x87654321, 0x43218765, 0x4e697370])('blocks protection word %i including partial overlays', async value => {
    const { flash, io, events } = target();
    const bytes = new Uint8Array(4); new DataView(bytes.buffer).setUint32(0, value, true);
    flash.set(bytes.slice(0, 3), 0x2fc);
    await expect(prepareFlash(io, device, parseBin('x', bytes.slice(3), 0x2ff), control())).rejects.toThrow('protection');
    expect(events.some(e => e.startsWith('E'))).toBe(false);
  });
  it('validates vectors before erase and repairs only when explicitly requested', async () => {
    const { flash, io } = target();
    const data = flash.slice(0, 1024); data[28]! ^= 1;
    const image = parseBin('x', data);
    await expect(prepareFlash(io, device, image, control())).rejects.toThrow('checksum');
    await expect(prepareFlash(io, device, repairVectorChecksum(image), control())).resolves.toBeDefined();
    data.fill(255, 0, 28);
    await expect(prepareFlash(io, device, repairVectorChecksum(parseBin('x', data)), control())).rejects.toThrow('stack pointer');
  });
  it('finishes and verifies the active sector before cancellation, leaving later sectors untouched', async () => {
    const { flash, io, events } = target(), before = flash.slice();
    const c = control(), program = io.programBlock;
    const image = parseBin('x', new Uint8Array(8192).fill(21), 4096);
    const plan = await prepareFlash(io, device, image, c);
    io.programBlock = async (address, bytes) => { await program(address, bytes); c.cancelled = true; };
    await expect(executeFlash(io, plan, c)).rejects.toBeInstanceOf(Cancelled);
    expect(flash.slice(4096, 8192)).toEqual(new Uint8Array(4096).fill(21));
    expect(flash.slice(8192)).toEqual(before.slice(8192));
    expect(events).toContain('R 4096'); expect(events).not.toContain('E 2');
  });
  it('detects corruption in preserved bytes, stops, and never retries an erase', async () => {
    const { io, flash, events } = target();
    const c = control(), program = io.programBlock;
    const plan = await prepareFlash(io, device, parseBin('x', new Uint8Array([42]), 4100), c);
    io.programBlock = async (address, bytes) => { await program(address, bytes); if (address === 4096) flash[4097]! ^= 1; };
    await expect(executeFlash(io, plan, c)).rejects.toThrow('0x00001001');
    expect(events.filter(e => e.startsWith('E'))).toEqual(['E 1']);
  });
});

import { describe, expect, it } from 'vitest';
import { Rom } from '../support/simulator';
import { devices } from '../../src/core/devices';
import { parseBin, parseHex, repairVectorChecksum } from '../../src/core/image';
import { Cancelled, executeFlash, prepareFlash, recoveryHex, verifyImage, type Control, type FlashTarget } from '../../src/core/flash';
import { imageByte } from '../../src/core/image';
import { withProtection } from '../../src/core/protection';

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
it.each(['crp1', 'crp2', 'disabled'] as const)('changes only the protection word to %s and preserves sector zero', async level => {
  const { flash, io, events } = target(), before = flash.slice();
  const plan = await prepareFlash(io, device, { name: 'Protection', size: 0, segments: [] }, control(), level);
  expect(plan.sectors.map(s => s.sector.index)).toEqual([0]);
  expect(plan.changedBytes).toBe(level === 'disabled' ? 0 : 4);
  await executeFlash(io, plan, control());
  new DataView(before.buffer).setUint32(0x2fc, level === 'crp1' ? 0x12345678 : level === 'crp2' ? 0x87654321 : 0xffffffff, true);
  expect(flash).toEqual(before);
  if (level !== 'disabled') expect(events.filter(e => e.startsWith('C')).at(-1)).toBe('C 0');
});
it('writes protection last and leaves sector zero untouched if earlier sectors fail', async () => {
  const { flash, io, events } = target(), before = flash.slice(0, 4096);
  const plan = await prepareFlash(io, device, parseBin('patch', new Uint8Array([33]), 4096), control(), 'crp2');
  const program = io.programBlock;
  io.programBlock = async (address, bytes) => { await program(address, bytes); flash[address + 1]! ^= 1; };
  await expect(executeFlash(io, plan, control())).rejects.toThrow('Verification failed');
  expect(events.filter(e => e.startsWith('E'))).toEqual(['E 1']);
  expect(flash.slice(0, 4096)).toEqual(before);
  const good = target();
  await executeFlash(good.io, await prepareFlash(good.io, device, parseBin('patch', new Uint8Array([33]), 4096), control(), 'crp1'), control());
  expect(good.events.filter(e => e.startsWith('E'))).toEqual(['E 1', 'E 0']);
  expect(good.events.filter(e => e.startsWith('C')).at(-1)).toBe('C 0');
});
it('overrides overlapping sparse image words without changing other bytes or the source', () => {
  const image = { name: 'Sparse', size: 8, segments: [{ address: 0x2fa, data: new Uint8Array([1, 2, 3, 4]) }, { address: 0x2fe, data: new Uint8Array([5, 6, 7, 8]) }] };
  const changed = withProtection(image, 'crp1');
  expect(Array.from({ length: 8 }, (_, i) => imageByte(changed, 0x2fa + i))).toEqual([1, 2, 0x78, 0x56, 0x34, 0x12, 7, 8]);
  expect(image.segments[0]!.data).toEqual(new Uint8Array([1, 2, 3, 4]));
  expect(changed.size).toBe(8);
});
it('rejects unsupported chips and revalidates protection plans before erase', async () => {
  const { io, events } = target();
  await expect(prepareFlash(io, devices.find(d => d.id === 0x25001110)!, { name: 'Protection', size: 0, segments: [] }, control(), 'crp1')).rejects.toThrow('does not support');
  const plan = await prepareFlash(io, device, { name: 'Protection', size: 0, segments: [] }, control(), 'crp1');
  new DataView(plan.sectors[0]!.desired.buffer).setUint32(0x2fc, 0x43218765, true);
  await expect(executeFlash(io, plan, control())).rejects.toThrow('does not match');
  expect(events.some(e => e.startsWith('E'))).toBe(false);
});

import { hex, type Device, type Sector } from './devices';
import { imageByte, type Firmware } from './image';

export interface FlashTarget {
  readFlash(address: number, length: number): Promise<Uint8Array>;
  eraseSector(index: number): Promise<void>;
  programBlock(address: number, data: Uint8Array): Promise<void>;
}
export interface PlannedSector { sector: Sector; original: Uint8Array; desired: Uint8Array; changed: boolean }
export interface FlashPlan { device: Device; image: Firmware; sectors: PlannedSector[]; changedBytes: number }
export interface Progress { phase: string; done: number; total: number }
export interface Control { cancelled: boolean; progress: (progress: Progress) => void }
export class Cancelled extends Error { constructor() { super('Operation cancelled.'); } }
const checkCancel = (control: Control) => { if (control.cancelled) throw new Cancelled(); };

export function affectedSectors(image: Firmware, device: Device) {
  if (!image.segments.length || image.segments.some(s => !s.data.length || !Number.isInteger(s.address) || s.address < 0 || s.address + s.data.length > device.flashSize)) throw new Error(`Image exceeds ${device.name}'s ${device.flashSize / 1024} KiB flash.`);
  return device.sectors.filter(sector => image.segments.some(s => s.address < sector.start + sector.size && s.address + s.data.length > sector.start));
}

export async function readRange(target: FlashTarget, address: number, size: number, control: Control, phase: string): Promise<Uint8Array> {
  const data = new Uint8Array(size);
  for (let offset = 0; offset < size; offset += 4096) {
    checkCancel(control);
    const length = Math.min(4096, size - offset);
    const chunk = await target.readFlash(address + offset, length);
    if (chunk.length !== length) throw new Error('Incomplete flash read. Nothing may be erased.');
    data.set(chunk, offset);
    control.progress({ phase, done: offset + length, total: size });
  }
  return data;
}

const blockedProtection = new Set([0x12345678, 0x87654321, 0x43218765, 0x4e697370]);
function validateSectorZero(plan: FlashPlan) {
  const zero = plan.sectors.find(s => s.sector.index === 0);
  if (!zero) return;
  const view = new DataView(zero.desired.buffer, zero.desired.byteOffset, zero.desired.byteLength);
  if (blockedProtection.has(view.getUint32(0x2fc, true))) throw new Error('Image would enable read protection or disable ISP at 0x000002FC. Flashing is blocked.');
  const touchesVectors = plan.image.segments.some(s => s.address < 32);
  if (!touchesVectors) return;
  let sum = 0;
  for (let i = 0; i < 8; i++) sum = (sum + view.getUint32(4 * i, true)) >>> 0;
  if (sum !== 0) throw new Error('Invalid vector checksum. Explicitly enable checksum repair for an image containing all 32 vector bytes.');
  const stack = view.getUint32(0, true), reset = view.getUint32(4, true);
  const validStack = (stack > 0x10000000 && stack <= 0x10008000) || (stack > 0x2007c000 && stack <= 0x20084000);
  if (!validStack || stack % 8 || !(reset & 1) || (reset & ~1) >= plan.device.flashSize) throw new Error('Invalid initial stack pointer or reset vector. Expected a Cortex-M application for this device.');
}

export async function prepareFlash(target: FlashTarget, device: Device, image: Firmware, control: Control): Promise<FlashPlan> {
  const sectors: PlannedSector[] = [];
  let changedBytes = 0;
  for (const sector of affectedSectors(image, device)) {
    checkCancel(control);
    const original = await readRange(target, sector.start, sector.size, control, `Reading sector ${sector.index}`);
    const desired = original.slice();
    for (const segment of image.segments) {
      const start = Math.max(sector.start, segment.address), end = Math.min(sector.start + sector.size, segment.address + segment.data.length);
      if (start < end) desired.set(segment.data.subarray(start - segment.address, end - segment.address), start - sector.start);
    }
    let changes = 0;
    for (let i = 0; i < desired.length; i++) if (desired[i] !== original[i]) changes++;
    changedBytes += changes;
    sectors.push({ sector, original, desired, changed: changes > 0 });
  }
  const plan = { device, image, sectors, changedBytes };
  validateSectorZero(plan);
  checkCancel(control);
  return plan;
}

export async function executeFlash(target: FlashTarget, plan: FlashPlan, control: Control): Promise<number> {
  validateSectorZero(plan);
  const changed = plan.sectors.filter(s => s.changed);
  let completed = 0;
  for (const { sector, desired } of changed) {
    checkCancel(control);
    // Once erase starts, finish this entire sector, including preserved bytes and readback.
    control.progress({ phase: `Erasing sector ${sector.index}`, done: completed, total: changed.length });
    await target.eraseSector(sector.index);
    for (let offset = 0; offset < sector.size; offset += 1024) {
      const block = desired.subarray(offset, offset + 1024);
      if (!block.every(byte => byte === 255)) await target.programBlock(sector.start + offset, block);
      control.progress({ phase: `Writing sector ${sector.index}`, done: completed + 0.7 * (offset + 1024) / sector.size, total: changed.length });
    }
    for (let offset = 0; offset < sector.size; offset += 4096) {
      const actual = await target.readFlash(sector.start + offset, 4096);
      if (actual.length !== 4096) throw new Error('Incomplete verification read.');
      for (let i = 0; i < actual.length; i++) {
        if (actual[i] !== desired[offset + i]) throw new Error(`Verification failed at ${hex(sector.start + offset + i)}. Keep the recovery image; enter ISP mode again to restore.`);
      }
      control.progress({ phase: `Verifying sector ${sector.index}`, done: completed + 0.7 + 0.3 * (offset + 4096) / sector.size, total: changed.length });
    }
    completed++;
  }
  return completed;
}

export async function verifyImage(target: FlashTarget, device: Device, image: Firmware, control: Control) {
  affectedSectors(image, device);
  let done = 0;
  for (const segment of image.segments) {
    const start = Math.floor(segment.address / 4) * 4;
    const end = Math.ceil((segment.address + segment.data.length) / 4) * 4;
    for (let offset = start; offset < end; offset += 4096) {
      checkCancel(control);
      const size = Math.min(4096, end - offset);
      const actual = await target.readFlash(offset, size);
      if (actual.length !== size) throw new Error('Incomplete verification read.');
      for (let i = 0; i < size; i++) {
        const expected = imageByte(image, offset + i);
        if (expected !== undefined && actual[i] !== expected) throw new Error(`Verification mismatch at ${hex(offset + i)}.`);
      }
      done += Math.min(size, segment.address + segment.data.length - offset);
      control.progress({ phase: 'Verifying image', done: Math.min(done, image.size), total: image.size });
    }
  }
}

export function recoveryHex(plan: FlashPlan): string {
  const lines: string[] = [];
  const record = (type: number, address: number, data: number[]) => {
    const bytes = [data.length, address >>> 8, address & 255, type, ...data];
    bytes.push((-bytes.reduce((a, b) => a + b, 0)) & 255);
    return ':' + bytes.map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  };
  let high = -1;
  for (const { sector, original } of plan.sectors) {
    for (let offset = 0; offset < original.length; offset += 16) {
      const address = sector.start + offset;
      if (address >>> 16 !== high) { high = address >>> 16; lines.push(record(4, 0, [high >>> 8, high & 255])); }
      lines.push(record(0, address & 65535, [...original.subarray(offset, offset + 16)]));
    }
  }
  return [...lines, ':00000001FF', ''].join('\r\n');
}

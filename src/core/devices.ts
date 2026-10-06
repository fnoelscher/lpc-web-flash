export interface Sector { index: number; start: number; size: number }
export interface Device { id: number; name: string; flashSize: number; sectors: Sector[]; supportsCrp: boolean }

export function sectorsFor(size: number): Sector[] {
  const sectors: Sector[] = [];
  for (let start = 0; start < size;) {
    const length = start < 0x10000 ? 4096 : 32768;
    sectors.push({ index: sectors.length, start, size: length });
    start += length;
  }
  return sectors;
}

// UM10360, part identification table and flash sector layout.
const parts: [number, string, number][] = [
  [0x26113f37, 'LPC1769', 512], [0x26013f37, 'LPC1768', 512],
  [0x26012837, 'LPC1767', 512], [0x26013f33, 'LPC1766', 256],
  [0x26013733, 'LPC1765', 256], [0x26011922, 'LPC1764', 128],
  [0x26012033, 'LPC1763', 256], [0x25113737, 'LPC1759', 512],
  [0x25013f37, 'LPC1758', 512], [0x25011723, 'LPC1756', 256],
  [0x25011722, 'LPC1754', 128], [0x25001121, 'LPC1752', 64],
  [0x25001118, 'LPC1751', 32], [0x25001110, 'LPC1751', 32],
];
export const devices: Device[] = parts.map(([id, name, kib]) => ({ id, name, flashSize: kib * 1024, sectors: sectorsFor(kib * 1024), supportsCrp: id !== 0x25001110 }));
export const findDevice = (id: number) => devices.find(device => device.id === id);
export const hex = (n: number) => `0x${n.toString(16).toUpperCase().padStart(8, '0')}`;

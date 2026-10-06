export interface Segment { address: number; data: Uint8Array }
export interface Firmware { name: string; segments: Segment[]; size: number }
export const MAX_FLASH = 512 * 1024;

export function parseOffset(value: string): number {
  if (!/^(0x[0-9a-f]+|[0-9]+)$/i.test(value.trim())) throw new Error('Enter a decimal or hexadecimal BIN address.');
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0 || n >= MAX_FLASH) throw new Error('BIN address is outside LPC175x/176x flash.');
  return n;
}

export function parseBin(name: string, data: Uint8Array, address = 0): Firmware {
  if (!data.length) throw new Error('The firmware file is empty.');
  if (!Number.isInteger(address) || address < 0 || address + data.length > MAX_FLASH) throw new Error('BIN image exceeds supported flash.');
  return { name, segments: [{ address, data: data.slice() }], size: data.length };
}

export function parseHex(name: string, source: string): Firmware {
  const bytes = new Map<number, number>();
  let base = 0, ended = false;
  for (const [index, raw] of source.replace(/^\uFEFF/, '').split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line) continue;
    const fail = (reason: string): never => { throw new Error(`HEX line ${index + 1}: ${reason}`); };
    if (ended) fail('data after end-of-file record.');
    if (!/^:(?:[0-9a-f]{2})+$/i.test(line)) fail('invalid record.');
    const record = Array.from({ length: (line.length - 1) / 2 }, (_, i) => parseInt(line.slice(1 + i * 2, 3 + i * 2), 16));
    const length = record[0]!;
    if (record.length !== length + 5) fail('record length mismatch.');
    if ((record.reduce((a, b) => a + b, 0) & 255) !== 0) fail('checksum mismatch.');
    const address = record[1]! * 256 + record[2]!;
    const type = record[3]!;
    const data = record.slice(4, -1);
    if (type === 0) {
      if (address + length > 0x10000 || base + address + length > MAX_FLASH) fail('address exceeds flash.');
      for (let i = 0; i < length; i++) {
        const target = base + address + i;
        if (bytes.has(target)) fail('overlapping data records.');
        bytes.set(target, data[i]!);
      }
    } else if (type === 1) {
      if (length !== 0 || address !== 0) fail('invalid end-of-file record.');
      ended = true;
    } else if (type === 2 || type === 4) {
      if (length !== 2 || address !== 0) fail('invalid extended address record.');
      base = (data[0]! * 256 + data[1]!) * (type === 2 ? 16 : 65536);
    } else if (type === 3 || type === 5) {
      if (length !== 4 || address !== 0) fail('invalid entry-point record.');
      // Entry points describe execution, not data. Reset remains manual.
    } else fail(`unsupported record type ${type}.`);
  }
  if (!ended) throw new Error('HEX is missing its end-of-file record.');
  if (!bytes.size) throw new Error('The HEX file contains no firmware bytes.');
  const addresses = [...bytes.keys()].sort((a, b) => a - b);
  const segments: Segment[] = [];
  let start = addresses[0]!, previous = start - 1, chunk: number[] = [];
  for (const address of addresses) {
    if (address !== previous + 1) { segments.push({ address: start, data: new Uint8Array(chunk) }); chunk = []; start = address; }
    chunk.push(bytes.get(address)!); previous = address;
  }
  segments.push({ address: start, data: new Uint8Array(chunk) });
  return { name, segments, size: bytes.size };
}

export function imageByte(image: Firmware, address: number): number | undefined {
  const segment = image.segments.find(s => address >= s.address && address < s.address + s.data.length);
  return segment?.data[address - segment.address];
}

export function repairVectorChecksum(image: Firmware): Firmware {
  const vectors = Uint8Array.from({ length: 32 }, (_, i) => {
    const value = imageByte(image, i);
    if (value === undefined) throw new Error('Checksum repair requires all 32 vector-table bytes in the image.');
    return value;
  });
  const view = new DataView(vectors.buffer);
  let sum = 0;
  for (let i = 0; i < 7; i++) sum = (sum + view.getUint32(i * 4, true)) >>> 0;
  view.setUint32(28, (-sum) >>> 0, true);
  return { ...image, segments: image.segments.map(s => ({ address: s.address, data: s.data.map((b, i) => s.address + i >= 28 && s.address + i < 32 ? vectors[s.address + i]! : b) })) };
}

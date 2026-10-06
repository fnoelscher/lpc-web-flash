import { describe, expect, it } from 'vitest';
import { parseBin, parseHex, parseOffset, repairVectorChecksum, imageByte } from '../../src/core/image';
import { decodeLine, encodeLine, encodeGroup, checksum } from '../../src/core/uuencode';
import { devices } from '../../src/core/devices';

const record = (address: number, type: number, data: number[]) => {
  const bytes = [data.length, address >> 8, address & 255, type, ...data];
  return ':' + [...bytes, -bytes.reduce((a, b) => a + b, 0) & 255].map(n => n.toString(16).padStart(2, '0')).join('');
};
const eof = ':00000001FF';
describe('firmware input', () => {
  it('keeps BIN offsets and rejects empty or out-of-range images', () => {
    expect(parseBin('x.bin', new Uint8Array([1, 2]), 17).segments[0]?.address).toBe(17);
    expect(() => parseBin('x', new Uint8Array())).toThrow('empty');
    expect(() => parseBin('x', new Uint8Array(2), 524287)).toThrow('exceeds');
    for (const invalid of ['', '-1', '1.5', '0x', 'Infinity', '524288', '1e2']) expect(() => parseOffset(invalid)).toThrow();
    expect(parseOffset('0x1000')).toBe(4096);
  });
  it('parses sparse HEX with extended linear and segment addresses', () => {
    const image = parseHex('x.hex', [record(0, 4, [0, 1]), record(3, 0, [1, 2]), record(0, 2, [0x20, 0]), record(1, 0, [3]), eof].join('\r\n'));
    expect(image.segments.map(s => s.address)).toEqual([65539, 131073]);
    expect(image.size).toBe(3);
  });
  it('rejects truncation, overlaps, checksum errors, wraparound and unsupported records', () => {
    const data = record(0, 0, [1, 2]);
    for (const text of [data, `${data}\n${data}\n${eof}`, `${data.slice(0, -2)}00\n${eof}`, `${eof}\n${data}`, record(0xffff, 0, [1, 2]) + '\n' + eof, record(0, 6, []) + '\n' + eof, 'garbage', eof]) expect(() => parseHex('x', text)).toThrow();
  });
  it('repairs only the vector checksum after an explicit call', () => {
    const data = new Uint8Array(32); new DataView(data.buffer).setUint32(0, 0x10008000, true);
    const image = parseBin('x', data), repaired = repairVectorChecksum(image);
    expect(imageByte(image, 31)).toBe(0);
    const vector = repaired.segments[0]!.data;
    const view = new DataView(vector.buffer);
    expect((view.getUint32(0, true) + view.getUint32(28, true)) >>> 0).toBe(0);
    expect(() => repairVectorChecksum(parseBin('x', data, 4096))).toThrow();
  });
});
describe('UU transfer encoding', () => {
  it('matches the documented AN11229 examples', () => {
    expect(encodeLine(new Uint8Array([0x14, 0x0f, 0xa8]))).toBe('#%`^H');
    expect(encodeLine(new Uint8Array([0x14, 0x0f, 0xa8, 0x17]))).toBe('$%`^H%P``');
    expect(checksum(new Uint8Array([0x14, 0x0f, 0xa8]))).toBe(203);
  });
  it('roundtrips every byte and partial triplets; accepts both zero encodings', () => {
    for (let length = 1; length <= 45; length++) {
      const data = Uint8Array.from({ length }, (_, i) => i * 37 & 255);
      expect(decodeLine(encodeLine(data))).toEqual(data);
      expect(decodeLine(encodeLine(data).replaceAll('`', ' '))).toEqual(data);
    }
    expect(encodeGroup(new Uint8Array(900))).toHaveLength(21);
    expect(() => encodeGroup(new Uint8Array(901))).toThrow();
    for (const text of ['', 'a', '#123', '!abcd', '`']) expect(() => decodeLine(text)).toThrow();
  });
});
it('lays out contiguous flash sectors for every profile', () => {
  for (const device of devices) {
    expect(device.sectors.reduce((n, s) => n + s.size, 0)).toBe(device.flashSize);
    device.sectors.forEach((s, i) => { expect(s.index).toBe(i); if (i) expect(s.start).toBe(device.sectors[i - 1]!.start + device.sectors[i - 1]!.size); });
  }
});

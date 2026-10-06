import type { Firmware, Segment } from './image';

// UM10360 §32.6: protection is sampled on power-up from this flash word.
export const CRP_ADDRESS = 0x2fc;
export type ProtectionLevel = 'disabled' | 'crp1' | 'crp2';
export const protectionWords: Record<ProtectionLevel, number> = { disabled: 0xffffffff, crp1: 0x12345678, crp2: 0x87654321 };
export function protectionName(word: number) {
  if (word === protectionWords.crp1) return 'CRP1';
  if (word === protectionWords.crp2) return 'CRP2';
  if (word === 0x43218765) return 'CRP3';
  return 'Disabled';
}

// Replace only the protection word, even when the image is sparse or overlaps it.
export function withProtection(image: Firmware, level: ProtectionLevel): Firmware {
  const word = protectionWords[level];
  if (word === undefined) throw new Error('Unsupported protection level.');
  const data = new Uint8Array(4);
  new DataView(data.buffer).setUint32(0, word, true);
  const segments: Segment[] = [];
  for (const segment of image.segments) {
    const end = segment.address + segment.data.length;
    if (end <= CRP_ADDRESS || segment.address >= CRP_ADDRESS + 4) { segments.push(segment); continue; }
    if (segment.address < CRP_ADDRESS) segments.push({ address: segment.address, data: segment.data.slice(0, CRP_ADDRESS - segment.address) });
    if (end > CRP_ADDRESS + 4) segments.push({ address: CRP_ADDRESS + 4, data: segment.data.slice(CRP_ADDRESS + 4 - segment.address) });
  }
  segments.push({ address: CRP_ADDRESS, data });
  segments.sort((a, b) => a.address - b.address);
  return { ...image, segments, size: segments.reduce((n, segment) => n + segment.data.length, 0) };
}

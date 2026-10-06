const char = (n: number) => String.fromCharCode((n & 63) === 0 ? 96 : (n & 63) + 32);
export function encodeLine(bytes: Uint8Array): string {
  if (bytes.length < 1 || bytes.length > 45) throw new Error('UU line must contain 1–45 bytes.');
  let line = char(bytes.length);
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!, b = bytes[i + 1] ?? 0, c = bytes[i + 2] ?? 0;
    line += char(a >>> 2) + char((a << 4) | (b >>> 4)) + char((b << 2) | (c >>> 6)) + char(c);
  }
  return line;
}
export function decodeLine(line: string): Uint8Array {
  if (!/^[\x20-\x60]+$/.test(line)) throw new Error('Invalid UU character.');
  const value = (i: number) => (line.charCodeAt(i) - 32) & 63;
  const length = value(0);
  if (length < 1 || length > 45 || line.length !== 1 + Math.ceil(length / 3) * 4) throw new Error('Invalid UU line length.');
  const output: number[] = [];
  for (let i = 1; i < line.length; i += 4) {
    output.push(((value(i) << 2) | (value(i + 1) >>> 4)) & 255,
      ((value(i + 1) << 4) | (value(i + 2) >>> 2)) & 255,
      ((value(i + 2) << 6) | value(i + 3)) & 255);
  }
  return new Uint8Array(output.slice(0, length));
}
export const checksum = (data: Uint8Array) => data.reduce((sum, byte) => sum + byte, 0);
export function encodeGroup(bytes: Uint8Array): string[] {
  if (!bytes.length || bytes.length > 900) throw new Error('UU group must contain 1–900 bytes.');
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += 45) lines.push(encodeLine(bytes.subarray(i, i + 45)));
  return [...lines, String(checksum(bytes))];
}

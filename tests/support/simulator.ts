// Protocol simulator for tests only. All device contents are generated at runtime.
// It is not imported by the application or included in the production build.
export interface SimOptions {
  partId?: number; badReadChecksums?: number; writeResends?: number; mappingFails?: boolean;
  readFailsAt?: number; corruptCopy?: boolean; silent?: boolean; fragment?: boolean;
  crpLevel?: 0 | 1 | 2 | 3; uidRestricted?: boolean; eraseFails?: boolean; eraseNotBlank?: boolean;
}
export class Rom {
  flash = Uint8Array.from({ length: 512 * 1024 }, (_, i) => (i * 17 + Math.floor(i / 256)) & 255);
  ram = new Uint8Array(8192);
  commands: string[] = [];
  erases: number[] = [];
  copies: number[] = [];
  mapped = false;
  crpLevel = 0;
  private stage = 0;
  private echo = true;
  private unlocked = false;
  private text = '';
  private prepared = new Set<number>();
  private upload?: { address: number; length: number; done: number; group: number[]; lines: number };
  private download?: { bytes: Uint8Array; offset: number };
  constructor(private emit: (data: string) => void, public options: SimOptions = {}) {
    // A structurally valid synthetic vector table, with protection disabled.
    const v = new DataView(this.flash.buffer);
    v.setUint32(0, 0x10008000, true);
    for (let i = 1; i < 7; i++) v.setUint32(i * 4, 0x101, true);
    let sum = 0; for (let i = 0; i < 7; i++) sum += v.getUint32(i * 4, true);
    v.setUint32(28, -sum >>> 0, true); v.setUint32(0x2fc, 0xffffffff, true);
    if (options.crpLevel) v.setUint32(0x2fc, [0xffffffff, 0x12345678, 0x87654321, 0x43218765][options.crpLevel]!, true);
    this.latchProtection();
  }
  private latchProtection() {
    const word = new DataView(this.flash.buffer).getUint32(0x2fc, true);
    this.crpLevel = [0xffffffff, 0x12345678, 0x87654321, 0x43218765].indexOf(word);
    if (this.crpLevel < 0 || this.options.partId === 0x25001110) this.crpLevel = 0;
  }
  // Test port opens model the user-confirmed power-cycle/manual boot checkpoint.
  reset() { this.latchProtection(); this.stage = 0; this.echo = true; this.unlocked = false; this.mapped = false; this.text = ''; this.upload = undefined; this.download = undefined; this.prepared.clear(); }
  private flashSize() {
    const kib: Record<number, number> = { 0x25001110: 32, 0x25001118: 32, 0x25001121: 64, 0x26011922: 128, 0x25011722: 128, 0x26013f33: 256, 0x26013733: 256, 0x26012033: 256, 0x25011723: 256 };
    return (kib[this.options.partId ?? 0x26113f37] ?? 512) * 1024;
  }
  private reply(...lines: (string | number)[]) { if (!this.options.silent) this.emit(lines.join('\r\n') + '\r\n'); }
  receive(data: string) {
    for (const char of data) {
      if (!this.stage && char === '?') { this.stage = 1; this.reply('Synchronized'); continue; }
      if (char === '\r') continue;
      if (char === '\n') { const line = this.text; this.text = ''; this.line(line); }
      else this.text += char;
    }
  }
  private sendGroup() {
    const transfer = this.download!;
    const bytes = transfer.bytes.slice(transfer.offset, transfer.offset + 900);
    const lines: string[] = [];
    for (let i = 0; i < bytes.length; i += 45) {
      const line = bytes.slice(i, i + 45);
      const sextets: number[] = [line.length];
      for (let j = 0; j < line.length; j += 3) {
        const n = line[j]! * 65536 + (line[j + 1] ?? 0) * 256 + (line[j + 2] ?? 0);
        for (const shift of [18, 12, 6, 0]) sextets.push((n >>> shift) & 63);
      }
      lines.push(sextets.map(n => String.fromCharCode(n ? n + 32 : 96)).join(''));
    }
    let sum = bytes.reduce((a, b) => a + b, 0);
    if ((this.options.badReadChecksums ?? 0) > 0) { this.options.badReadChecksums!--; sum++; }
    this.reply(...lines, sum);
  }
  private line(line: string) {
    if (this.stage === 1) { if (line !== 'Synchronized') throw new Error('Invalid sync'); this.reply(line, 'OK'); this.stage = 2; return; }
    if (this.stage === 2) { this.reply(line, 'OK'); this.stage = 3; return; }
    if (this.download) {
      if (line === 'RESEND') { this.sendGroup(); return; }
      if (line !== 'OK') throw new Error('Missing read acknowledgment');
      this.download.offset += 900;
      if (this.download.offset >= this.download.bytes.length) this.download = undefined;
      else this.sendGroup();
      return;
    }
    if (this.upload) {
      const u = this.upload;
      if (u.group.length < Math.min(900, u.length - u.done)) {
        const count = (line.charCodeAt(0) - 32) & 63;
        const values = [...line.slice(1)].map(c => (c.charCodeAt(0) - 32) & 63);
        const bytes: number[] = [];
        for (let i = 0; i < values.length; i += 4) {
          const n = values[i]! * 262144 + values[i + 1]! * 4096 + values[i + 2]! * 64 + values[i + 3]!;
          bytes.push(n >>> 16 & 255, n >>> 8 & 255, n & 255);
        }
        u.group.push(...bytes.slice(0, count)); u.lines++;
        if (count > 45 || u.lines > 20 || u.group.length > 900) throw new Error('Invalid write group');
        return;
      }
      const expected = u.group.reduce((a, b) => a + b, 0);
      if (Number(line) !== expected || (this.options.writeResends ?? 0) > 0) {
        if ((this.options.writeResends ?? 0) > 0) this.options.writeResends!--;
        u.group = []; u.lines = 0; this.reply('RESEND'); return;
      }
      this.ram.set(u.group, u.address - 0x10000000 + u.done); u.done += u.group.length;
      u.group = []; u.lines = 0;
      if (u.done === u.length) this.upload = undefined;
      this.reply('OK'); return;
    }
    this.commands.push(line);
    if (this.echo) this.reply(line);
    const [op, ...fields] = line.split(' '), nums = fields.map(Number), a = nums[0]!, b = nums[1]!, count = nums[2]!;
    if (this.crpLevel && (['R', 'G', 'M'].includes(op!) || (op === 'W' && (this.crpLevel >= 2 || a < 0x10000200)) || (op === 'C' && (this.crpLevel >= 2 || a < 4096)) || (op === 'N' && this.options.uidRestricted))) { this.reply(19); return; }
    switch (op) {
      case 'A': this.echo = a !== 0; this.reply(0); return;
      case 'J': this.reply(0, this.options.partId ?? 0x26113f37); return;
      case 'K': this.reply(0, 7, 4); return;
      case 'N': this.reply(0, 1, 2, 3, 4); return;
      case 'U': this.unlocked = a === 23130; this.reply(this.unlocked ? 0 : 16); return;
      case 'W': this.upload = { address: a, length: b, done: 0, group: [], lines: 0 }; this.reply(0); return;
      case 'G': if (!this.unlocked) { this.reply(15); return; } this.mapped = !this.options.mappingFails; this.reply(0); return;
      case 'R': {
        if (this.options.readFailsAt !== undefined && a <= this.options.readFailsAt && a + b > this.options.readFailsAt) { this.reply(19); return; }
        let bytes: Uint8Array;
        if (a === 0x400fc040) bytes = new Uint8Array([this.mapped ? 1 : 0, 0, 0, 0]);
        else if (a >= 0x10000000) bytes = this.ram.slice(a - 0x10000000, a - 0x10000000 + b);
        else { bytes = this.flash.slice(a, a + b); if (!this.mapped && a < 512) bytes.fill(0xa5, 0, Math.min(512 - a, b)); }
        this.download = { bytes, offset: 0 }; this.reply(0); this.sendGroup(); return;
      }
      case 'P': for (let s = a; s <= b; s++) this.prepared.add(s); this.reply(0); return;
      case 'E': {
        if (!this.unlocked) { this.reply(15); return; }
        const size = this.flashSize(), last = size <= 65536 ? size / 4096 - 1 : 15 + (size - 65536) / 32768;
        if (a < 0 || a > b || b > last) { this.reply(7); return; }
        const all = a === 0 && b === last;
        if (this.crpLevel === 3 || (this.crpLevel === 2 && !all) || (this.crpLevel === 1 && a === 0 && !all)) { this.reply(19); return; }
        for (let s = a; s <= b; s++) if (!this.prepared.has(s)) { this.reply(9); return; }
        if (this.options.eraseFails) { this.reply(11); return; }
        for (let s = a; s <= b; s++) {
          const start = s < 16 ? s * 4096 : 65536 + (s - 16) * 32768;
          this.flash.fill(255, start, start + (s < 16 ? 4096 : 32768));
          this.prepared.delete(s); this.erases.push(s);
        }
        if (this.options.eraseNotBlank) this.flash[100] = 0;
        this.reply(0); return;
      }
      case 'I': {
        const start = a < 16 ? a * 4096 : 65536 + (a - 16) * 32768;
        const end = b < 16 ? (b + 1) * 4096 : 65536 + (b - 15) * 32768;
        const offset = this.flash.subarray(start, end).findIndex(byte => byte !== 255);
        if (offset < 0) this.reply(0);
        else { const wordOffset = Math.floor(offset / 4) * 4; this.reply(8, wordOffset, new DataView(this.flash.buffer).getUint32(start + wordOffset, true)); }
        return;
      }
      case 'C': {
        const sector = a < 65536 ? Math.floor(a / 4096) : 16 + Math.floor((a - 65536) / 32768);
        if (!this.prepared.has(sector)) { this.reply(9); return; }
        if (![256, 512, 1024, 4096].includes(count) || a % 256) { this.reply(6); return; }
        for (let i = 0; i < count; i++) this.flash[a + i]! &= this.ram[b - 0x10000000 + i]!;
        if (this.options.corruptCopy) this.flash[a]! ^= 1;
        this.prepared.delete(sector); this.copies.push(a); this.reply(0); return;
      }
      default: this.reply(1);
    }
  }
}

export function installSerialSimulator(options: SimOptions = {}) {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let opens = 0, writes = 0, signals = 0;
  let openOptions: unknown;
  const rom = new Rom(data => {
    const bytes = new TextEncoder().encode(data);
    if (options.fragment) { for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7)); }
    else controller.enqueue(bytes);
  }, options);
  const port = {
    readable: null as ReadableStream<Uint8Array> | null,
    writable: null as WritableStream<Uint8Array> | null,
    getInfo: () => ({ usbVendorId: 0x0403, usbProductId: 0x6001 }),
    open: async (opts: unknown) => {
      opens++; openOptions = opts; rom.reset();
      port.readable = new ReadableStream<Uint8Array>({ start: c => { controller = c; } });
      port.writable = new WritableStream<Uint8Array>({ write: bytes => { writes++; rom.receive(new TextDecoder().decode(bytes)); } });
    },
    close: async () => { port.readable = null; port.writable = null; },
    setSignals: async () => { signals++; throw new Error('Automatic reset is forbidden.'); },
  };
  Object.defineProperty(navigator, 'serial', { configurable: true, value: { requestPort: async () => port } });
  const state = { rom, disconnect: () => controller.error(new Error('Simulated cable unplugged')), stats: () => ({ opens, writes, signals, openOptions, commands: rom.commands, erases: rom.erases, copies: rom.copies, mapped: rom.mapped }), read: (address: number, size: number) => [...rom.flash.slice(address, address + size)] };
  Object.assign(window, { simulator: state });
}

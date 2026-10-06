export interface Port {
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  open(options: { baudRate: number; dataBits: number; stopBits: number; parity: string; flowControl: string; bufferSize: number }): Promise<void>;
  close(): Promise<void>;
  getInfo(): { usbVendorId?: number; usbProductId?: number };
}
export interface SerialApi { requestPort(): Promise<Port> }
export const serialApi = () => (navigator as Navigator & { serial?: SerialApi }).serial;
export interface LineIo { write(data: string): Promise<void>; line(timeout?: number): Promise<string> }

export class SerialTransport implements LineIo {
  private reader?: ReadableStreamDefaultReader<Uint8Array>;
  private writer?: WritableStreamDefaultWriter<Uint8Array>;
  private reading?: Promise<void>;
  private queue: string[] = [];
  private partial = '';
  private paused = false;
  private failure?: Error;
  private pending?: { resolve: (line: string) => void; reject: (e: Error) => void };
  private closing = false;
  private opened = false;

  constructor(private port: Port, private onFailure: (error: Error) => void = () => {}) {}

  async open(baudRate: number) {
    await this.port.open({ baudRate, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none', bufferSize: 16384 });
    this.opened = true;
    if (!this.port.readable || !this.port.writable) throw new Error('Serial port has no data streams.');
    this.reader = this.port.readable.getReader();
    this.writer = this.port.writable.getWriter();
    this.reading = this.pump();
  }

  private fail(error: Error) {
    if (this.failure) return;
    this.failure = error;
    this.pending?.reject(error); this.pending = undefined;
    if (!this.closing) this.onFailure(error);
  }

  private async pump() {
    try {
      while (!this.closing) {
        const { value, done } = await this.reader!.read();
        if (done) throw new Error('Serial connection closed. Enter ISP mode again before reconnecting.');
        for (const byte of value) {
          if (byte === 0x13) { this.paused = true; continue; }
          if (byte === 0x11) { this.paused = false; continue; }
          if (byte === 13) continue;
          if (byte === 10) {
            const line = this.partial; this.partial = '';
            if (!line.length) continue;
            if (this.pending) { this.pending.resolve(line); this.pending = undefined; }
            else this.queue.push(line);
            if (this.queue.length > 128) throw new Error('Unexpected serial data overflow.');
          } else {
            this.partial += String.fromCharCode(byte);
            if (this.partial.length > 256) throw new Error('Malformed serial response.');
          }
        }
      }
    } catch (e) { this.fail(e instanceof Error ? e : new Error(String(e))); }
  }

  async line(timeout = 3000): Promise<string> {
    if (this.failure) throw this.failure;
    if (this.queue.length) return this.queue.shift()!;
    if (this.pending) throw new Error('Concurrent serial reads are not allowed.');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = undefined;
        const error = new Error('Serial response timed out.');
        this.fail(error); reject(error);
      }, timeout);
      this.pending = {
        resolve: line => { clearTimeout(timer); resolve(line); },
        reject: error => { clearTimeout(timer); reject(error); },
      };
    });
  }

  async write(text: string) {
    if (!this.writer) throw new Error('Serial port is not open.');
    const deadline = Date.now() + 3000;
    const bytes = new TextEncoder().encode(text);
    for (let i = 0; i < bytes.length; i += 32) {
      while (this.paused && !this.failure) {
        if (Date.now() > deadline) { this.fail(new Error('Device remained paused (XOFF). Enter ISP mode again.')); break; }
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      if (this.failure) throw this.failure;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.writer.write(bytes.subarray(i, i + 32)),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Serial write timed out.')), 3000); }),
        ]);
      } catch (e) { this.fail(e instanceof Error ? e : new Error(String(e))); throw e; }
      finally { clearTimeout(timer); }
    }
  }

  async close() {
    this.closing = true;
    this.fail(new Error('Serial port closed.'));
    try { await this.reader?.cancel(); } catch { /* A disconnected port may already be closed. */ }
    await this.reading;
    this.reader?.releaseLock(); this.reader = undefined;
    try { await this.writer?.abort(); } catch { /* Disconnection. */ }
    this.writer?.releaseLock(); this.writer = undefined;
    if (this.opened) {
      try { await this.port.close(); }
      catch (e) {
        // A disconnect can close the browser's port before cleanup gets here.
        // Suppress only the already-closed case, with both streams gone.
        if (!(e instanceof DOMException && e.name === 'InvalidStateError' && !this.port.readable && !this.port.writable)) throw e;
      } finally { this.opened = false; }
    }
  }
}

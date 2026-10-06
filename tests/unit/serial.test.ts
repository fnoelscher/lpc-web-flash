import { expect, it, vi } from 'vitest';
import { SerialTransport, type Port } from '../../src/serial';

function port() {
  let receive!: ReadableStreamDefaultController<Uint8Array>;
  const writes: string[] = [];
  const p: Port = { open: vi.fn(async () => {}), close: vi.fn(async () => {}), getInfo: () => ({}),
    readable: new ReadableStream({ start: c => { receive = c; } }),
    writable: new WritableStream({ write: value => { writes.push(new TextDecoder().decode(value)); } }),
  };
  const send = (text: string) => receive.enqueue(new TextEncoder().encode(text));
  return { p, send, writes, error: () => receive.error(new Error('unplugged')) };
}
it('handles fragmented CRLF, queued lines and XON/XOFF without toggling modem signals', async () => {
  const { p, send, writes } = port(), t = new SerialTransport(p);
  await t.open(230400);
  send('Synch'); send('ronized\r'); send('\n0\r\n');
  expect(await t.line()).toBe('Synchronized'); expect(await t.line()).toBe('0');
  send('\x13'); await Promise.resolve();
  const writing = t.write('test\r\n');
  await new Promise(resolve => setTimeout(resolve, 15)); expect(writes).toEqual([]);
  send('\x11'); await writing; expect(writes).toEqual(['test\r\n']);
  await t.close(); expect(p.close).toHaveBeenCalledOnce();
});
it('rejects pending reads on disconnect and releases stream locks', async () => {
  const { p, error } = port(), failed = vi.fn(), t = new SerialTransport(p, failed);
  await t.open(230400);
  const reading = t.line(); error();
  await expect(reading).rejects.toThrow('unplugged');
  expect(failed).toHaveBeenCalledOnce();
  await t.close(); expect(p.readable?.locked).toBe(false); expect(p.writable?.locked).toBe(false);
});
it('poisons the session after a timeout, so late replies cannot be used for another command', async () => {
  const { p, send } = port(), t = new SerialTransport(p);
  await t.open(230400);
  await expect(t.line(5)).rejects.toThrow('timed out');
  send('0\r\n'); await expect(t.line()).rejects.toThrow('timed out');
  await expect(t.write('?')).rejects.toThrow('timed out');
  await t.close();
});

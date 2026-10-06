import { expect, it } from 'vitest';
import { SerialTransport, type Port } from '../../src/serial';
import { IspClient } from '../../src/core/isp';
import { parseBin } from '../../src/core/image';
import { executeFlash, prepareFlash, readRange, verifyImage, type Control } from '../../src/core/flash';
import { Rom } from '../support/simulator';

it('runs backup, preserving flash and verify through fragmented serial streams', async () => {
  let receiver!: ReadableStreamDefaultController<Uint8Array>;
  const rom = new Rom(text => {
    const bytes = new TextEncoder().encode(text);
    for (let i = 0; i < bytes.length; i += 11) receiver.enqueue(bytes.slice(i, i + 11));
  }, { writeResends: 1, badReadChecksums: 1 });
  const port: Port = {
    open: async () => {}, close: async () => {}, getInfo: () => ({}),
    readable: new ReadableStream({ start: c => { receiver = c; } }),
    writable: new WritableStream({ write: bytes => { rom.receive(new TextDecoder().decode(bytes)); } }),
  };
  const transport = new SerialTransport(port);
  await transport.open(230400);
  try {
    const client = new IspClient(transport), identity = await client.connect(12000);
    const control: Control = { cancelled: false, progress: () => {} };
    const backup = await readRange(client, 0, identity.device!.flashSize, control, 'Backup');
    expect(backup).toEqual(rom.flash);
    const image = parseBin('generated', new Uint8Array([1, 3, 7, 15, 31]), 65534);
    const plan = await prepareFlash(client, identity.device!, image, control);
    expect(rom.erases).toHaveLength(0);
    expect(await executeFlash(client, plan, control)).toBe(2);
    backup.set(image.segments[0]!.data, 65534);
    expect(rom.flash).toEqual(backup);
    await verifyImage(client, identity.device!, image, control);
    expect(rom.erases).toEqual([15, 16]);
  } finally { await transport.close(); }
});

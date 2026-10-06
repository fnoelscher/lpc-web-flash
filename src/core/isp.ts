import type { LineIo } from '../serial';
import { findDevice, hex, type Device } from './devices';
import { decodeLine, checksum, encodeGroup } from './uuencode';
import { FLASH_MAP_HELPER } from '../generated/flash-map';
import { CRP_ADDRESS, protectionName } from './protection';

export const RAM = 0x10000200;
// tools/flash-map.S stores its MEMMAP readback at this cleared payload offset.
export const FLASH_MAP_RESULT = RAM + 64;
const errors = ['Success', 'Invalid command', 'Source address error', 'Destination address error', 'Source not mapped', 'Destination not mapped', 'Count error', 'Invalid sector', 'Sector not blank', 'Sector not prepared', 'Compare error', 'Busy', 'Parameter error', 'Address error', 'Address not mapped', 'Command locked', 'Invalid unlock code', 'Invalid baud rate', 'Invalid stop bit', 'Code read protection enabled'];
export class IspError extends Error {
  constructor(public commandName: string, public code: number) { super(`${commandName}: ${errors[code] ?? 'Unknown status'} (${code}).`); }
}
export interface Identity { id: number; device?: Device; version: number[]; uid: number[]; readProtected: boolean; protection: string }
export class IspClient {
  identity?: Identity;
  private mapped = false;
  private needsPowerCycle = false;
  constructor(private io: LineIo, private log: (message: string) => void = () => {}) {}
  private async number(max = 0xffffffff) {
    const line = await this.io.line();
    if (!/^\d+$/.test(line) || Number(line) > max) throw new Error('Invalid numeric ISP response.');
    return Number(line);
  }
  private async expect(value: string) {
    const response = await this.io.line();
    if (response !== value) throw new Error(`Expected ${value}; received an unexpected ISP response.`);
  }
  private async echoed(text: string, reply: string) {
    await this.io.write(`${text}\r\n`);
    const first = await this.io.line();
    if (first === text) await this.expect(reply);
    else if (first !== reply) throw new Error('ISP synchronization failed: unexpected response.');
  }
  async connect(crystalKhz: number): Promise<Identity> {
    if (!Number.isInteger(crystalKhz) || crystalKhz < 1000 || crystalKhz > 25000) throw new Error('Crystal frequency must be 1000–25000 kHz.');
    this.log('Synchronizing UART ISP.');
    await this.io.write('?'); await this.expect('Synchronized');
    await this.echoed('Synchronized', 'OK');
    await this.echoed(String(crystalKhz), 'OK');
    await this.echoed('A 0', '0');
    await this.command('J'); const id = await this.number();
    await this.command('K'); const version = [await this.number(255), await this.number(255)];
    let uid: number[] = [];
    try { await this.command('N'); uid = [await this.number(), await this.number(), await this.number(), await this.number()]; }
    catch (e) { if (!(e instanceof IspError) || ![1, 19].includes(e.code)) throw e; }
    const device = findDevice(id);
    this.identity = { id, device, version, uid, readProtected: false, protection: device?.supportsCrp ? 'Unknown' : 'Not supported' };
    if (device?.supportsCrp) {
      try {
        // This address is beyond the ROM-mapped first 512 bytes; no RAM helper needed.
        const data = await this.readMemory(CRP_ADDRESS, 4);
        this.identity.protection = protectionName(new DataView(data.buffer).getUint32(0, true));
      } catch (e) {
        if (!(e instanceof IspError) || e.code !== 19) throw e;
        this.identity.readProtected = true;
        this.identity.protection = 'Read protected (level unknown)';
      }
    }
    this.log(`Identified ${this.identity.device?.name ?? 'unknown device'} (${hex(id)}).`);
    return this.identity;
  }
  async command(command: string, timeout = 3000) {
    this.log(`> ${command}`);
    await this.io.write(`${command}\r\n`);
    const result = await this.io.line(timeout);
    if (result !== '0') {
      if (/^\d+$/.test(result)) throw new IspError(command.split(' ')[0]!, Number(result));
      throw new Error(`${command.split(' ')[0]}: Unexpected response.`);
    }
  }
  async writeRam(bytes: Uint8Array) {
    if (!bytes.length || bytes.length % 4 || bytes.length > 1024) throw new Error('Invalid staging buffer length.');
    await this.command(`W ${RAM} ${bytes.length}`);
    for (let start = 0; start < bytes.length; start += 900) {
      const lines = encodeGroup(bytes.subarray(start, start + 900));
      for (let attempt = 0; ; attempt++) {
        for (const line of lines) await this.io.write(`${line}\r\n`);
        const ack = await this.io.line();
        if (ack === 'OK') break;
        if (ack !== 'RESEND' || attempt >= 3) throw new Error('RAM transfer failed: unexpected acknowledgment or retry limit reached.');
        this.log('Device requested retransmission of RAM data.');
      }
    }
  }
  async readMemory(address: number, length: number): Promise<Uint8Array> {
    if (!Number.isInteger(address) || address < 0 || address > 0xffffffff || address % 4 || !Number.isInteger(length) || length <= 0 || length % 4 || length > 4096) throw new Error('Invalid memory read.');
    await this.command(`R ${address} ${length}`);
    const result = new Uint8Array(length);
    for (let offset = 0; offset < length;) {
      const expected = Math.min(900, length - offset);
      for (let attempt = 0; ; attempt++) {
        const group = new Uint8Array(expected);
        let received = 0, lines = 0;
        while (received < expected && lines < 20) {
          const data = decodeLine(await this.io.line());
          if (data.length !== Math.min(45, expected - received)) throw new Error('Unexpected memory response length.');
          group.set(data, received); received += data.length; lines++;
        }
        const sum = await this.number(900 * 255);
        if (received === expected && sum === checksum(group)) {
          await this.io.write('OK\r\n'); result.set(group, offset); break;
        }
        if (attempt >= 3) throw new Error('Memory checksum retry limit reached.');
        this.log('Requesting retransmission after a memory checksum mismatch.');
        await this.io.write('RESEND\r\n');
      }
      offset += expected;
    }
    return result;
  }
  async ensureFlashMapping() {
    if (this.needsPowerCycle) throw new Error('Power-cycle the board and enter ISP mode again before flash access.');
    if (this.identity?.readProtected) throw new IspError('R', 19);
    if (this.mapped) return;
    if (!this.identity?.device) throw new Error('Unknown device: flash access is disabled.');
    this.log('Mapping flash vectors using the RAM helper. No flash is modified.');
    await this.writeRam(FLASH_MAP_HELPER);
    await this.command('U 23130');
    await this.command(`G ${RAM} T`);
    await this.command('J');
    if (await this.number() !== this.identity.id) throw new Error('Device identity changed after the RAM helper.');
    const data = await this.readMemory(FLASH_MAP_RESULT, 4);
    if ((new DataView(data.buffer).getUint32(0, true) & 1) !== 1) throw new Error('Flash mapping could not be confirmed. Backup and flashing are disabled.');
    this.mapped = true;
    this.log('Flash mapping and return to ISP confirmed.');
  }
  async readFlash(address: number, length: number): Promise<Uint8Array> {
    const device = this.identity?.device;
    if (!device || address < 0 || address + length > device.flashSize) throw new Error('Read exceeds the identified device.');
    await this.ensureFlashMapping();
    return this.readMemory(address, length);
  }
  async eraseSector(index: number) {
    if (this.needsPowerCycle || !this.mapped || !this.identity?.device?.sectors[index]) throw new Error('Flash is not ready.');
    await this.command('U 23130');
    await this.command(`P ${index} ${index}`);
    await this.command(`E ${index} ${index}`, 15000);
  }
  async chipErase() {
    const device = this.identity?.device;
    if (!device) throw new Error('Unknown device: chip erase is disabled.');
    if (this.needsPowerCycle) throw new Error('Power-cycle the board and enter ISP mode again.');
    // Mark the session unusable even if a subsequent command fails; never retry an erase.
    this.needsPowerCycle = true;
    this.mapped = false;
    const last = device.sectors.length - 1;
    await this.command('U 23130');
    await this.command(`P 0 ${last}`);
    // CRP1/2 recovery requires ONE command spanning every sector, including sector zero.
    await this.command(`E 0 ${last}`, 30000);
    try { await this.command(`I 0 ${last}`, 15000); }
    catch (e) {
      if (e instanceof IspError && e.code === 8) {
        const offset = await this.number(); await this.number();
        throw new Error(`Chip erase failed blank check near ${hex(offset)}. Do not assume flash or protection was cleared.`);
      }
      throw e;
    }
    this.log('Entire flash blank-checked. Power cycle is required to clear latched protection.');
  }
  async programBlock(address: number, data: Uint8Array) {
    const sector = this.identity?.device?.sectors.find(s => address >= s.start && address + data.length <= s.start + s.size);
    if (this.needsPowerCycle || !this.mapped || !sector || address % 256 || data.length !== 1024) throw new Error('Invalid flash block.');
    await this.writeRam(data);
    await this.command(`P ${sector.index} ${sector.index}`);
    await this.command(`C ${address} ${RAM} ${data.length}`, 5000);
  }
}

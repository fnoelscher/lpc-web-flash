import './style.css';
import { serialApi, SerialTransport, type Port } from './serial';
import { IspClient, IspError, type Identity } from './core/isp';
import { hex } from './core/devices';
import { MAX_FLASH, parseBin, parseHex, parseOffset, repairVectorChecksum, type Firmware } from './core/image';
import { activatesProtection, affectedSectors, Cancelled, executeFlash, plannedProtection, prepareFlash, readRange, recoveryHex, verifyImage, type Control, type FlashPlan } from './core/flash';
import { withProtection, type ProtectionLevel } from './core/protection';

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <header class="site-header"><a class="brand" href="./" aria-label="lpc-web-flash home"><span class="brand-icon" aria-hidden="true">↯</span>lpc-web-flash</a><span class="header-note">UART ISP <span class="dot">·</span> IN YOUR BROWSER</span><a class="source-link" href="https://github.com/fnoelscher/lpc-web-flash" target="_blank" rel="noreferrer">Source ↗</a></header>
  <main>
    <div class="intro"><div><h1>LPC flash programmer<span>.</span></h1><p class="lede">Flash, verify and back up LPC175x / LPC176x devices over USB serial.</p></div><span id="connection-state" class="state-badge"><i></i>Disconnected</span></div>
    <div id="unsupported" class="notice" hidden>Web Serial is unavailable in this browser. Open this page in a current desktop Chrome or Edge browser over HTTPS or localhost.</div>
    <div class="workspace">
      <aside class="panel connection-panel">
        <div class="panel-heading"><span class="step">01</span><h2>Connection</h2></div>
        <p class="muted">Use a 3.3 V UART adapter or your board’s onboard USB serial port.</p>
        <label for="baud">Baud rate</label><select id="baud"><option value="230400">230400 baud · default</option><option value="115200">115200 baud</option><option value="57600">57600 baud</option><option value="38400">38400 baud</option><option value="19200">19200 baud</option><option value="9600">9600 baud</option></select>
        <label for="crystal">Crystal frequency <span>kHz</span></label><input id="crystal" type="number" min="1000" max="25000" step="1" value="12000" /><p class="field-note">Match your board’s external crystal.</p>
        <button id="choose" class="button primary wide">Choose serial port <span>→</span></button>
        <p id="port-info" class="field-note">No port selected</p>
        <div id="boot-checkpoint" class="boot-checkpoint" hidden><span class="eyebrow">MANUAL BOOT STEP</span><h3>Enter ISP mode</h3><p>Use your board’s ISP and reset buttons. Continue once it is in boot mode.</p><button id="ready" class="button primary wide">ISP mode entered — continue</button></div>
        <div id="device" class="device-info" hidden><span class="eyebrow">DEVICE IDENTIFIED</span><h3 id="device-name"></h3><dl><div><dt>Flash</dt><dd id="device-size"></dd></div><div><dt>Part ID</dt><dd id="device-id"></dd></div><div><dt>ROM version bytes</dt><dd id="device-rom"></dd></div></dl></div>
        <button id="disconnect" class="button subtle wide" hidden>Disconnect</button>
        <details class="help"><summary>Connection notes</summary><p>UART0 uses P0.2 (TX) and P0.3 (RX). Cross TX/RX and connect ground. Hold P2.10 low during reset to enter ROM ISP.</p><p>Reset is manual. The app does not drive DTR or RTS. If synchronization fails, select a lower rate and re-enter ISP mode.</p><p>The documented ROM ISP ceiling is 230400 baud.</p></details>
      </aside>
      <section class="panel firmware-panel">
        <div class="panel-heading"><span class="step">02</span><h2>Firmware</h2><span class="local-badge">Local files only</span></div>
        <label class="file-picker" id="file-picker" for="firmware"><span class="file-icon" aria-hidden="true">↑</span><strong id="file-title">Choose a firmware image</strong><span id="file-detail">Binary (.bin) or Intel HEX (.hex)</span><input id="firmware" type="file" accept=".bin,.hex,.ihex" /></label>
        <div class="image-options"><div><label for="offset">BIN start address</label><input id="offset" value="0x00000000" spellcheck="false" autocomplete="off" /><p class="field-note">HEX files use their own addresses.</p></div><label class="checkbox-label"><input id="repair" type="checkbox" /><span>Repair vector checksum<small>Only for images containing vectors at address 0.</small></span></label></div>
        <div id="image-info" class="image-info" hidden><div><span class="eyebrow">IMAGE RANGE</span><p id="image-range"></p></div><div><span class="eyebrow">SHA-256</span><p id="image-hash" class="hash"></p></div></div>
        <div class="action-row"><button id="prepare" class="button primary" disabled>Review flash plan <span>→</span></button><button id="verify" class="button secondary" disabled>Verify image</button><button id="backup" class="button secondary" disabled>Back up device</button></div>
        <p class="field-note">First review the flash plan, then click Flash and verify to write. Bytes outside your image are preserved. Every rewritten sector is read back and verified.</p>
        <details class="maintenance"><summary>Code read protection &amp; chip erase</summary>
          <p id="protection-status" class="field-note">Connect a device to check protection.</p>
          <label for="protection">Code read protection</label><select id="protection"><option value="image">Use image setting · CRP blocked</option><option value="disabled">Disabled</option><option value="crp1">CRP1 · full erase to remove</option><option value="crp2">CRP2 · full erase to remove</option></select>
          <p class="field-note">A selected level overrides the protection word when reviewing firmware. To change only protection and preserve your firmware, use the button below. CRP1/2 disable readback and debug access after a power cycle. Removing active CRP1/2 requires erasing all firmware. CRP3 is not offered and cannot be cleared by ROM ISP chip erase.</p>
          <button id="prepare-protection" class="button secondary" disabled>Review protection change</button>
          <div class="erase-controls"><h3>Chip erase</h3><p id="erase-summary" class="field-note">Erase all flash, including firmware, settings and the CRP word. CRP1/2 clear after a power cycle. Protected firmware cannot be backed up.</p><label class="checkbox-label"><input id="erase-confirm" type="checkbox" /><span>I understand that all flash contents will be permanently deleted.</span></label><button id="erase-chip" class="button danger" disabled>Erase entire chip</button></div>
        </details>
        <section id="plan" class="plan" hidden><div class="plan-heading"><h3>Ready to write</h3><span id="plan-size"></span></div><p id="plan-summary"></p><div class="table-wrap"><table><thead><tr><th>Sector</th><th>Address</th><th>Size</th><th>Action</th></tr></thead><tbody id="plan-sectors"></tbody></table></div><p class="field-note">Changed sectors will be erased, rewritten and verified. Keep the board powered until this finishes.</p><label id="protection-ack" class="checkbox-label" hidden><input id="protection-confirm" type="checkbox" /><span>I understand that CRP disables readback and debug access after a power cycle, and removing it requires erasing all firmware.</span></label><div class="action-row"><button id="flash" class="button primary">Flash and verify</button><button id="recovery" class="button secondary">Save sector recovery image</button></div></section>
        <div class="activity"><div class="activity-heading"><span class="eyebrow">ACTIVITY</span><button id="cancel" class="text-button" hidden>Cancel operation</button></div><p id="status" role="status" aria-live="polite">Choose a port to get started.</p><progress id="progress" max="100" value="0" aria-label="Operation progress" hidden></progress></div>
      </section>
    </div>
    <section class="panel log-panel"><details><summary>Session log <span>Commands and results · no firmware contents</span></summary><pre id="log" aria-label="Session log">No activity yet.</pre></details><button id="diagnostics" class="text-button">Save diagnostics ↓</button></section>
    <footer><p>Firmware stays in your browser. No uploads, accounts or analytics.</p><p>- warning: use at your own risk - <span class="dot">·</span> MIT licensed</p></footer>
  </main>`;

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const button = (id: string) => el<HTMLButtonElement>(id);
const input = (id: string) => el<HTMLInputElement>(id);
let port: Port | undefined, transport: SerialTransport | undefined, client: IspClient | undefined, identity: Identity | undefined;
let image: Firmware | undefined, file: File | undefined, fileBytes: Uint8Array | undefined;
let plan: FlashPlan | undefined, recovery: string | undefined;
let busy = false, waiting = false, connected = false, writing = false;
let erasing = false, powerCycleRequired = false;
let control: Control | undefined;
const logs: string[] = [];
function selectedProtection(): ProtectionLevel | undefined {
  const value = el<HTMLSelectElement>('protection').value;
  return value === 'disabled' || value === 'crp1' || value === 'crp2' ? value : undefined;
}

function log(message: string) {
  logs.push(`${new Date().toISOString()}  ${message}`);
  if (logs.length > 3000) logs.shift();
  el('log').textContent = logs.join('\n');
}
function status(message: string, error = false) {
  el('status').textContent = message;
  el('status').classList.toggle('error', error);
  log(message);
}
function update() {
  const supported = !!serialApi();
  el('unsupported').hidden = supported;
  button('choose').disabled = !supported || busy || connected;
  button('ready').disabled = busy;
  input('baud').disabled = busy || connected;
  input('crystal').disabled = busy || connected;
  for (const id of ['firmware', 'offset', 'repair']) input(id).disabled = busy || (id === 'offset' && !!file && /\.(i?hex)$/i.test(file.name));
  const ready = connected && !!identity?.device && !busy;
  const readable = ready && !identity?.readProtected;
  button('prepare').disabled = !readable || !image;
  button('verify').disabled = !readable || !image;
  button('backup').disabled = !readable;
  el<HTMLSelectElement>('protection').disabled = busy || !identity?.device?.supportsCrp || !!identity?.readProtected;
  button('prepare-protection').disabled = !readable || !identity?.device?.supportsCrp || !selectedProtection();
  input('erase-confirm').disabled = !ready;
  button('erase-chip').disabled = !ready || !input('erase-confirm').checked;
  input('protection-confirm').disabled = busy;
  button('flash').disabled = !readable || !plan?.changedBytes || (activatesProtection(plan) && !input('protection-confirm').checked);
  button('recovery').disabled = !recovery || busy;
  button('disconnect').hidden = !connected;
  button('disconnect').disabled = busy;
  el('boot-checkpoint').hidden = !waiting;
  el('device').hidden = !identity;
  el('plan').hidden = !plan && !recovery;
  el('cancel').hidden = !control || !busy || erasing;
  el('boot-checkpoint').querySelector('p')!.textContent = powerCycleRequired ? 'Remove and restore board power, then use your ISP and reset buttons to enter boot mode. Protection changes require a power cycle.' : 'Use your board’s ISP and reset buttons. Continue once it is in boot mode.';
  el('connection-state').textContent = connected ? `${identity?.device?.name ?? 'Unknown device'} connected` : waiting ? 'Waiting for ISP mode' : 'Disconnected';
  el('connection-state').classList.toggle('connected', connected);
  el('file-picker').classList.toggle('disabled', busy);
}
function save(name: string, data: BlobPart, type = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
async function closeConnection() {
  connected = false; client = undefined; identity = undefined; plan = undefined;
  input('erase-confirm').checked = false; input('protection-confirm').checked = false;
  const old = transport; transport = undefined;
  try { await old?.close(); } catch (e) { log(`Close: ${String(e)}`); }
  waiting = !!port;
  update();
}
async function operation(task: (control: Control) => Promise<void>) {
  if (busy) return;
  busy = true;
  control = { cancelled: false, progress: p => {
    el('status').textContent = `${p.phase}…`;
    el<HTMLProgressElement>('progress').value = p.total ? 100 * p.done / p.total : 0;
  } };
  el('progress').hidden = false; el('status').classList.remove('error'); update();
  try { await task(control); }
  catch (e) {
    if (e instanceof Cancelled) status('Cancelled between transactions. Completed sectors are verified. Review a new plan before continuing.');
    else if (e instanceof IspError && e.code === 19 && connected && !writing && !erasing) {
      identity!.readProtected = true;
      identity!.protection = 'Read protected (level unknown)';
      el('protection-status').textContent = 'Read protected: backup, verification and preserving writes are unavailable. Chip erase can recover CRP1/2.';
      status('Code read protection prevents flash access. Use chip erase to remove CRP1/2 and all firmware.', true);
    } else { status(`${e instanceof Error ? e.message : String(e)} ${powerCycleRequired ? 'Power-cycle the board, then enter ISP mode again using its buttons.' : 'Use your board’s buttons to re-enter ISP mode before clicking continue again.'}`, true); await closeConnection(); }
    plan = undefined;
  } finally { busy = false; control = undefined; writing = false; erasing = false; el('progress').hidden = true; update(); }
}
function renderPlan(current: FlashPlan) {
  el('plan-size').textContent = `${current.changedBytes.toLocaleString()} bytes changed`;
  const changed = current.sectors.filter(s => s.changed).length;
  el('plan-summary').textContent = changed ? `${changed} sector(s) will be rewritten. Original contents have been read; gaps and surrounding bytes will be restored.` : 'The selected bytes already match the device. No erase is needed.';
  if (current.protection) el('plan-summary').textContent += ` Protection word: ${plannedProtection(current)}. Power-cycle after writing to apply it.`;
  input('protection-confirm').checked = false;
  el('protection-ack').hidden = !activatesProtection(current);
  el('plan-sectors').replaceChildren(...current.sectors.map(s => {
    const row = document.createElement('tr');
    for (const text of [String(s.sector.index), hex(s.sector.start), `${s.sector.size / 1024} KiB`, s.changed ? 'Rewrite + verify' : 'Unchanged']) { const cell = document.createElement('td'); cell.textContent = text; row.append(cell); }
    return row;
  }));
}
async function parseSelectedImage() {
  image = undefined; plan = undefined; recovery = undefined;
  if (!file || !fileBytes) { update(); return; }
  try {
    let parsed = /\.(i?hex)$/i.test(file.name) ? parseHex(file.name, new TextDecoder('utf-8', { fatal: true }).decode(fileBytes)) : parseBin(file.name, fileBytes, parseOffset(input('offset').value));
    if (input('repair').checked) parsed = repairVectorChecksum(parsed);
    if (identity?.device) affectedSectors(parsed, identity.device);
    image = parsed;
    const first = parsed.segments[0]!, last = parsed.segments.at(-1)!;
    el('file-title').textContent = file.name;
    el('file-detail').textContent = `${parsed.size.toLocaleString()} bytes · ${parsed.segments.length} region(s)`;
    el('image-range').textContent = `${hex(first.address)} — ${hex(last.address + last.data.length - 1)}`;
    const digest = await crypto.subtle.digest('SHA-256', fileBytes.slice().buffer);
    el('image-hash').textContent = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
    el('image-info').hidden = false;
    status(input('repair').checked ? 'Image loaded. Vector checksum repair is enabled; the file hash describes the original file.' : connected ? 'Image loaded. Review the flash plan, then click Flash and verify to write.' : 'Image loaded. Connect your device, review the flash plan, then click Flash and verify to write.');
  } catch (e) { el('image-info').hidden = true; status(e instanceof Error ? e.message : String(e), true); }
  update();
}

button('choose').onclick = async () => {
  if (busy || connected) return;
  busy = true; update();
  try {
    port = await serialApi()!.requestPort();
    const info = port.getInfo();
    el('port-info').textContent = info.usbVendorId === undefined ? 'Serial port selected' : `USB ${info.usbVendorId.toString(16).padStart(4, '0')}:${(info.usbProductId ?? 0).toString(16).padStart(4, '0')}`;
    waiting = true;
    status('Port selected. Enter ISP mode using your board’s buttons, then continue.');
  } catch (e) { status(e instanceof DOMException && e.name === 'NotFoundError' ? 'Port selection cancelled.' : String(e)); }
  finally { busy = false; update(); }
};
button('ready').onclick = () => operation(async () => {
  if (!port || !waiting) return;
  waiting = false; update();
  const crystal = Number(input('crystal').value);
  if (!Number.isInteger(crystal) || crystal < 1000 || crystal > 25000) throw new Error('Crystal frequency must be 1000–25000 kHz.');
  transport = new SerialTransport(port, error => {
    if (!busy) { status(error.message, true); void closeConnection(); }
  });
  await transport.open(Number(input('baud').value));
  client = new IspClient(transport, log);
  identity = await client.connect(crystal);
  powerCycleRequired = false;
  connected = true;
  el('device-name').textContent = identity.device?.name ?? 'Unknown device';
  el('device-size').textContent = identity.device ? `${identity.device.flashSize / 1024} KiB` : 'Unsupported';
  el('device-id').textContent = hex(identity.id);
  el('device-rom').textContent = identity.version.join(', ');
  el('protection-status').textContent = `Protection at connection: ${identity.protection}.${identity.readProtected ? ' Backup and preserving writes are unavailable. Chip erase can recover CRP1/2.' : ''}`;
  el('erase-summary').textContent = identity.device ? `Erase all ${identity.device.flashSize / 1024} KiB (${identity.device.sectors.length} sectors) on ${identity.device.name}, including firmware, settings and the CRP word. CRP1/2 clear after a power cycle. Protected firmware cannot be backed up.` : 'Chip erase is disabled for unsupported devices.';
  status(identity.device ? `${identity.device.name} connected. ${identity.readProtected ? 'Read protection detected. Chip erase is available for CRP1/2 recovery.' : 'Back up the device before your first flash.'}` : 'Device identified, but this part is unsupported. Flash access is disabled.');
});
button('disconnect').onclick = () => { if (!busy) void closeConnection().then(() => status('Disconnected. Re-enter ISP mode before the next connection.')); };
input('firmware').onchange = async () => {
  if (busy) return;
  const selected = input('firmware').files?.[0];
  if (!selected) return;
  busy = true; image = undefined; plan = undefined; recovery = undefined; update();
  try {
    if (!/\.(bin|hex|ihex)$/i.test(selected.name)) throw new Error('Choose a BIN or Intel HEX image.');
    if (selected.size > (/\.bin$/i.test(selected.name) ? MAX_FLASH : 8 * 1024 * 1024)) throw new Error('Firmware file is too large.');
    file = selected; fileBytes = new Uint8Array(await file.arrayBuffer());
    await parseSelectedImage();
  } catch (e) { file = undefined; fileBytes = undefined; status(e instanceof Error ? e.message : String(e), true); }
  finally { busy = false; update(); }
};
for (const id of ['offset', 'repair']) input(id).onchange = async () => {
  if (busy) return;
  busy = true; update();
  try { await parseSelectedImage(); } finally { busy = false; update(); }
};
button('prepare').onclick = () => operation(async c => {
  plan = undefined; recovery = undefined;
  const next = await prepareFlash(client!, identity!.device!, image!, c, selectedProtection());
  plan = next; recovery = recoveryHex(next); renderPlan(next);
  status(next.changedBytes ? 'Flash plan ready. Save the sector recovery image, then click Flash and verify to write.' : 'Image already matches. No changes are required.');
});
button('flash').onclick = () => operation(async c => {
  const current = plan;
  if (!current || (activatesProtection(current) && !input('protection-confirm').checked)) return;
  plan = undefined; writing = true;
  if (current.protection) powerCycleRequired = true;
  const count = await executeFlash(client!, current, c);
  if (count && current.protection) {
    powerCycleRequired = true; await closeConnection();
    status(`Flash complete. ${count} sector(s) written and verified. Protection word: ${plannedProtection(current)}. Power-cycle the board to apply it; enter ISP mode manually for another session.`);
  } else status(c.cancelled ? `Stopped after ${count} verified sector(s). Review a new plan to write remaining sectors.` : `Flash complete. ${count} sector(s) written and verified. You may now reset the board manually.`);
});
el<HTMLSelectElement>('protection').onchange = () => {
  plan = undefined; recovery = undefined; input('protection-confirm').checked = false;
  status('Protection selection changed. Review a new plan before writing.'); update();
};
for (const id of ['erase-confirm', 'protection-confirm']) input(id).onchange = update;
button('prepare-protection').onclick = () => operation(async c => {
  const protection = selectedProtection();
  if (!protection) return;
  plan = undefined; recovery = undefined;
  const next = await prepareFlash(client!, identity!.device!, { name: 'Protection change', segments: [], size: 0 }, c, protection);
  plan = next; recovery = recoveryHex(next); renderPlan(next);
  status(next.changedBytes ? `Protection plan ready: ${plannedProtection(next)}. Sector zero will be preserved, rewritten and verified.` : 'Protection word already matches. No changes are required.');
});
button('erase-chip').onclick = () => operation(async c => {
  if (!client || !identity?.device || !input('erase-confirm').checked) return;
  erasing = true; powerCycleRequired = true; plan = undefined; recovery = undefined;
  input('erase-confirm').checked = false; update();
  c.progress({ phase: 'Erasing entire chip; keep power connected', done: 0, total: 1 });
  await client.chipErase();
  await closeConnection();
  status('Chip erase complete. Entire flash is blank-checked. Power-cycle the board to clear CRP1/2, then enter ISP mode manually before programming.');
});
button('verify').onclick = () => operation(async c => {
  plan = undefined;
  const protection = selectedProtection();
  await verifyImage(client!, identity!.device!, protection ? withProtection(image!, protection) : image!, c);
  status('Verification complete. All selected image bytes match the device.');
});
button('backup').onclick = () => operation(async c => {
  const device = identity!.device!;
  const data = await readRange(client!, 0, device.flashSize, c, 'Reading full flash backup');
  if (c.cancelled) throw new Cancelled();
  save(`${device.name.toLowerCase()}-backup.bin`, data.slice().buffer);
  status(`Backup complete. ${data.length.toLocaleString()} bytes read; save the downloaded file outside the repository.`);
});
button('recovery').onclick = () => { if (recovery && !busy) save('lpc-sector-recovery.hex', recovery, 'text/plain'); };
button('cancel').onclick = () => {
  if (control) { control.cancelled = true; status(writing ? 'Cancellation requested. Finishing and verifying the current sector first…' : 'Cancellation requested. Finishing the current read…'); }
};
button('diagnostics').onclick = () => save('lpc-web-flash-diagnostics.txt', JSON.stringify({ app: 'lpc-web-flash', userAgent: navigator.userAgent, baud: input('baud').value, crystalKhz: input('crystal').value, device: identity?.device?.name, partId: identity?.id, romVersionBytes: identity?.version, log: logs }, null, 2), 'text/plain');
window.addEventListener('beforeunload', event => { if (busy) { event.preventDefault(); event.returnValue = ''; } });
update();

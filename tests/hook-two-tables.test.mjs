import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');   // the u2-modloader folder
new Function(fs.readFileSync(ROOT + '/lib/wasmpatch.js', 'utf8'))();
const { patchGame, cameraCopy, encU, encS } = globalThis.U2WasmPatch;
const sec = (id, payload) => [id, ...encU(payload.length), ...payload];
const vec = items => [...encU(items.length), ...items.flat()];
const str = s => [...encU(s.length), ...Buffer.from(s)];
const u32le = v => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
// N lifted functions, function i for x86 address addrs[i]; each holds a return address inside its own range
const N = 1500, K = 700, TARGET = 0x5c7ec0;
const addrs = Array.from({ length: N }, (_, i) => TARGET + (i - K) * 32);
const store42 = [0x41, ...encS(0x900000), 0x41, 42, 0x36, 0x02, 0x00];
const body = ins => { const b = [0x00, ...ins, 0x0b]; return [...encU(b.length), ...b]; };
const bodies = addrs.map((a, i) => body([0x41, ...encS(a + 5), 0x1a, ...(i === K ? store42 : [])]));   // i32.const ret; drop
// table index i+1 -> function i; g_fn_ptr in shuffled-looking but parallel order; g_fn_count = N right after
const ptrs = addrs.map((_, i) => i + 1);
const data = [...Array(37).fill(0x7f), ...addrs.flatMap(u32le), ...Array(12).fill(0xff), ...ptrs.flatMap(u32le), ...u32le(N), ...Array(20).fill(0xff)];
const mod = Uint8Array.from([
  0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
  ...sec(1, vec([[0x60, 1, 0x7f, 0]])),
  ...sec(2, vec([[...str('env'), ...str('memory'), 0x02, 0x03, ...encU(4096), ...encU(4096)]])),
  ...sec(3, vec(addrs.map(() => [0]))),
  ...sec(4, vec([[0x70, 0x00, ...encU(N + 2)]])),
  ...sec(7, vec([[...str('run'), 0x00, ...encU(K)]])),
  ...sec(9, vec([[0x00, 0x41, 1, 0x0b, ...vec(addrs.map((_, i) => encU(i)))]])),
  ...sec(10, vec(bodies)),
  ...sec(11, vec([[0x01, ...encU(data.length), ...data]])),
]);
const MB = 0xd0f000, CAMAT = 0x832e50 + 0x40, CAM = 0x1003000;
const r = patchGame(mod, { guestAddr: TARGET, prologue: cameraCopy(CAMAT, MB, [[16, 0, 0x70], [0x80, 0x1e0, 12]]) });
console.log('patch info', r.info);
const memory = new WebAssembly.Memory({ initial: 4096, maximum: 4096, shared: true });
const { instance } = await WebAssembly.instantiate(r.bytes, { env: { memory } });
const dv = new DataView(memory.buffer);
dv.setUint32(CAMAT, CAM, true); dv.setUint32(MB, 1, true);
for (let i = 0; i < 0x70; i++) dv.setUint8(MB + 16 + i, i + 1);
for (let i = 0; i < 12; i++) dv.setUint8(MB + 0x80 + i, 0xa0 + i); instance.exports.run(0); const velOk = new Uint8Array(memory.buffer, CAM + 0x1e0, 12).every((x, i) => x === 0xa0 + i) && new Uint8Array(memory.buffer, CAM + 0x70, 0x170).every(x => x === 0); console.log("velocity copied, nothing between:", velOk);
const ok = velOk && r.info.tables === 2 && r.info.funcIdx === K && dv.getUint32(0x900000, true) === 42 && new Uint8Array(memory.buffer, CAM, 0x70).every((x, i) => x === i + 1);
console.log(ok ? 'PICKED THE RIGHT TABLE OF 2, HOOK WORKS' : 'WRONG');
process.exit(ok ? 0 : 1);

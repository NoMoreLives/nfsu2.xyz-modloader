import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');   // the u2-modloader folder
new Function(fs.readFileSync(ROOT + '/lib/wasmpatch.js', 'utf8'))();
const { patchGame, cameraCopy, encU, encS } = globalThis.U2WasmPatch;
const sec = (id, payload) => [id, ...encU(payload.length), ...payload];
const vec = items => [...encU(items.length), ...items.flat()];
const str = s => [...encU(s.length), ...Buffer.from(s)];
const u32le = v => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
// the game's tables: N sorted x86 addresses with 0x5C7EC0 at K, and their function pointers (table indices)
const N = 1500, K = 700, TARGET = 0x5c7ec0;
const addrs = Array.from({ length: N }, (_, i) => i === K ? TARGET : i < K ? 0x401000 + i * 16 : TARGET + (i - K) * 16);
const ptrs = Array.from({ length: N }, (_, i) => i === K ? 2 : (i % 2 ? 1 : 3));
const data = [...Array(37).fill(0x7f), ...addrs.flatMap(u32le), ...Array(12).fill(0), ...ptrs.flatMap(u32le), ...Array(20).fill(5)];
const store42 = [0x41, ...encS(0x900000), 0x41, 42, 0x36, 0x02, 0x00];      // i32.store [0x900000] = 42
const body = ins => { const b = [0x00, ...ins, 0x0b]; return [...encU(b.length), ...b]; };
const mod = Uint8Array.from([
  0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
  ...sec(1, vec([[0x60, 1, 0x7f, 0]])),                                            // (i32) -> ()
  ...sec(2, vec([[...str('env'), ...str('memory'), 0x02, 0x03, ...encU(4096), ...encU(4096)]])),
  ...sec(3, vec([[0], [0], [0]])),
  ...sec(4, vec([[0x70, 0x00, 4]])),
  ...sec(7, vec([[...str('run'), 0x00, 1]])),
  ...sec(9, vec([[0x00, 0x41, 1, 0x0b, ...vec([[0], [1], [2]])]])),
  ...sec(10, vec([body([]), body(store42), body([])])),
  ...sec(11, vec([[0x01, ...encU(data.length), ...data]])),                       // passive, as with shared memory
]);
const MB = 0xd0f000, CAMAT = 0x832e50 + 0x40, CAM = 0x1003000;
const r = patchGame(mod, { guestAddr: TARGET, prologue: cameraCopy(CAMAT, MB, 0x70) });
console.log('patch info', r.info);
const memory = new WebAssembly.Memory({ initial: 4096, maximum: 4096, shared: true });
const { instance } = await WebAssembly.instantiate(r.bytes, { env: { memory } });
const dv = new DataView(memory.buffer), run = () => instance.exports.run(0);
const camBytes = () => Array.from(new Uint8Array(memory.buffer, CAM, 0x70));
let ok = true; const check = (what, c) => { console.log(c ? 'ok  ' : 'FAIL', what); ok &&= c; };
dv.setUint32(CAMAT, CAM, true);
for (let i = 0; i < 0x70; i++) dv.setUint8(MB + 16 + i, i + 1);
run();
check('flag 0: camera untouched, original body ran', camBytes().every(x => x === 0) && dv.getUint32(0x900000, true) === 42);
dv.setUint32(MB, 1, true); run();
check('flag 1: mailbox copied into the camera', camBytes().every((x, i) => x === i + 1));
dv.setUint32(MB, 0, true); for (let i = 0; i < 0x70; i++) dv.setUint8(MB + 16 + i, 0xee); run();
check('flag 0 again: camera keeps what it had', camBytes().every((x, i) => x === i + 1));
dv.setUint32(MB, 1, true); dv.setUint32(CAMAT, 0, true); run();
check('no camera: nothing written at address 0', new Uint8Array(memory.buffer, 0, 0x70).every(x => x === 0));
// a module that is not the game: patchGame must refuse, not guess
try { patchGame(Uint8Array.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, ...sec(10, vec([body([])]))]), { guestAddr: TARGET, prologue: cameraCopy(CAMAT, MB, 0x70) }); check('refuses other modules', false); }
catch (e) { check(`refuses other modules (${e.message})`, true); }
console.log(ok ? 'ALL OK' : 'SOME FAILED');
process.exit(ok ? 0 : 1);

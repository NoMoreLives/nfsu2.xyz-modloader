// lib/wasmpatch.js on its own: each kind of hook, several on one function, several functions in one pass, a
// hook at a wrong address failing alone.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildGame, FN, COUNTER, PAGES, R } from './fakegame.mjs';
const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
new Function(fs.readFileSync(ROOT + '/lib/wasmpatch.js', 'utf8'))();
const W = globalThis.U2WasmPatch, { prologue: P, ON } = W;
let ok = true; const check = (what, c) => { console.log(c ? 'ok  ' : 'FAIL', what); ok &&= !!c; };

// slots by hand (the loader allocates them in the real thing)
const ORDER = 0xff0700;                                     // the order counter all hooks share
const S = { notify: 0xff0000, capture: 0xff0010, write: 0xff0200, raceSeen: 0xff0300, skip: 0xff0310, loop: 0xff0320 };
const hooks = [
  { guestAddr: FN.view, build: P.notify({ slot: S.notify, orderAt: ORDER }) },
  { guestAddr: FN.view, build: P.capture({ slot: S.capture, keep: 4, args: 2, orderAt: ORDER }) },
  { guestAddr: FN.loop, build: P.write({ slot: S.write, to: { reg: 'ecx' }, ranges: [[0x10, 8], [0x40, 4]] }) },
  { guestAddr: FN.loop, build: P.notify({ slot: S.loop }) },
  { guestAddr: FN.view + 1, build: P.notify({ slot: 0xff0400 }) },                 // not a function's start
  { guestAddr: FN.race, build: P.notify({ slot: S.raceSeen }) },
  { guestAddr: FN.race, build: P.skip({ slot: S.skip, pop: 8 }) },
  { guestAddr: FN.nop, build: P.notify({ slot: 0xff0500, ret: 0x581475 }) },       // only GameLoop's call
  { guestAddr: FN.nop, build: P.notify({ slot: 0xff0510, wakes: false }) },        // every call, no wake
  { guestAddr: FN.nop, build: P.write({ slot: 0xff0600, to: { page: true }, ranges: [[0x434, 4]] }) },   // a target the page sets
];
const r = W.patchGame(buildGame(W), { anchor: FN.view, hooks });
console.log('patch info', r.info);
check('the wrong address fails alone', r.results.map(x => x.ok).join() === 'true,true,true,true,false,true,true,true,true,true' && /not the start/.test(r.results[4].error));
check('four functions patched in one pass', r.info.patched === 4);

const memory = new WebAssembly.Memory({ initial: PAGES, maximum: PAGES, shared: true });
const { instance } = await WebAssembly.instantiate(r.bytes, { env: { memory, log() {} } });
const X = instance.exports, dv = new DataView(memory.buffer), ia = new Int32Array(memory.buffer);
const u32 = a => dv.getUint32(a, true), set = (a, v) => dv.setUint32(a, v >>> 0, true);
const CPU = 0x2000000, STACK = 0x3000000;
set(CPU + R.esp, STACK); set(STACK, 0x5a1234); set(STACK + 4, 0xaaa); set(STACK + 8, 0xbbb);

// off: nothing but the body
X.fView(CPU);
check('flags 0: the bodies run, nothing counted', u32(COUNTER.view) === 1 && u32(S.notify + 4) === 0 && u32(S.capture + 4) === 0);
set(S.notify, 1); X.fView(CPU);
check('a flag of 1 (not ON) is still off', u32(S.notify + 4) === 0);

// notify + capture on one function
set(S.notify, ON); set(S.capture, ON);
for (let i = 0; i < 6; i++) { set(CPU + R.eax, 0x100 + i); set(CPU + R.ecx, 0xc0ffee); X.fView(CPU); }
check('notify counts each call, and the body still runs', u32(S.notify + 4) === 6 && u32(COUNTER.view) === 8);
const entry = n => { const e = S.capture + 16 + (n & 3) * W.captureEntry(2); return { seq: u32(e), order: u32(e + 4), eax: u32(e + 8), ecx: u32(e + 12), esp: u32(e + 24), ret: u32(e + 44), a: [u32(e + 48), u32(e + 52)] }; };
const last = entry(5);
check('capture: the registers, the return address and the arguments', last.seq === 12 && last.eax === 0x105 && last.ecx === 0xc0ffee &&
  last.esp === STACK && last.ret === 0x5a1234 && last.a[0] === 0xaaa && last.a[1] === 0xbbb);
check('capture: a ring of 4 keeps calls 2-5, each with its seq', [2, 3, 4, 5].every(n => entry(n).seq === 2 * n + 2 && entry(n).eax === 0x100 + n));
check('order: notify then capture on each call, one counter for both', u32(ORDER) === 12 && u32(S.notify + 12) === 10 && u32(S.capture + 12) === 11 &&
  last.order === 11 && [2, 3, 4, 5].every(n => entry(n).order === 2 * n + 1));

// write: the current buffer's ranges into [ecx + off]
const T = 0x1003000, B0 = S.write + 16, size = W.writeLayout([[0x10, 8], [0x40, 4]]).size;
for (let i = 0; i < size; i++) { dv.setUint8(B0 + i, 0x10 + i); dv.setUint8(B0 + size + i, 0x80 + i); }
set(CPU + R.ecx, T); X.fLoop(CPU);
check('write off: the target is untouched', new Uint8Array(memory.buffer, T, 0x50).every(x => x === 0) && u32(COUNTER.loop) === 1);
set(S.write, ON); set(S.loop, ON); X.fLoop(CPU);
const tb = new Uint8Array(memory.buffer, T, 0x50);
check('write: buffer 0 to +0x10 (8 bytes) and +0x40 (4), nothing between', [...tb.subarray(0x10, 0x18)].every((x, i) => x === 0x10 + i) &&
  [...tb.subarray(0x40, 0x44)].every((x, i) => x === 0x18 + i) && tb.subarray(0x18, 0x40).every(x => x === 0) && tb.subarray(0, 0x10).every(x => x === 0));
check('two hooks on one function: both ran, then the body', u32(S.loop + 4) === 1 && u32(S.write + 4) === 1 && u32(COUNTER.loop) === 2);
Atomics.store(ia, (S.write + 8) >> 2, 1); X.fLoop(CPU);
check('write: buffer 1 after the flip', [...tb.subarray(0x10, 0x18)].every((x, i) => x === 0x80 + i));
const lowBefore = new Uint8Array(memory.buffer, 0x5000, 0x50).slice();
set(CPU + R.ecx, 0); X.fLoop(CPU); set(CPU + R.ecx, 0x5000); X.fLoop(CPU); set(CPU + R.ecx, 0xfffffff0); X.fLoop(CPU);
check('write: a target of 0, below 0x10000 or past the guest is skipped', new Uint8Array(memory.buffer, 0, 0x50).every(x => x === 0) &&
  new Uint8Array(memory.buffer, 0x5000, 0x50).every((x, i) => x === lowBefore[i]) && u32(S.write + 4) === 2 && u32(COUNTER.loop) === 6);

// skip: returns as ret 8 would, with eax from the slot
set(CPU + R.esp, STACK); set(S.skip + 8, 0xffffffff); X.fRace(CPU);
check('skip off: the body runs', u32(COUNTER.race) === 1 && u32(CPU + R.esp) === STACK);
set(S.raceSeen, ON); set(S.skip, ON); X.fRace(CPU);
check('skip: the body did not run', u32(COUNTER.race) === 1);
check('skip: eax = the slot value, eip = the return address, esp past it and 8 bytes', u32(CPU + R.eax) === 0xffffffff &&
  u32(CPU + R.eip) === 0x5a1234 && u32(CPU + R.esp) === STACK + 12);
check('a hook before the skip still saw the call', u32(S.raceSeen + 4) === 1 && u32(S.skip + 4) === 1);

// notify wakes a page waiting with Atomics.waitAsync
set(CPU + R.esp, STACK);
const i = (S.notify + 4) >> 2, w = Atomics.waitAsync(ia, i, Atomics.load(ia, i), 2000);
check('waitAsync is waiting', w.async);
setTimeout(() => X.fView(CPU), 5);
const woke = await w.value;
check(`notify woke it (${woke})`, woke === 'ok');

// ret: only the call from that return address
set(0xff0500, ON); set(0xff0510, ON); set(CPU + R.esp, STACK);
for (const ret of [0x581475, 0x4d0000, 0x581475, 0x5a0000]) { set(STACK, ret); X.fNop(CPU); }
check('ret: the filtered hook counts only the calls from 0x581475, the other all', u32(0xff0500 + 4) === 2 && u32(0xff0510 + 4) === 4 && u32(COUNTER.nop) === 4);
const j = (0xff0510 + 4) >> 2, w2 = Atomics.waitAsync(ia, j, Atomics.load(ia, j), 50);
setTimeout(() => X.fNop(CPU), 5);
const alive = setTimeout(() => {}, 500);                   // Node doesn't wait for a waitAsync timeout alone
check('wakes: false does not wake the page', await w2.value === 'timed-out' && u32(0xff0510 + 4) === 5);
clearTimeout(alive);

// write to { page: true }: the target is the buffer's first word, the ranges after it
{
  const PW = 0xff0600, L = W.writeLayout([[0x434, 4]], { page: true }), T2 = 0x1004000;
  check('page target: the ranges start after the address word', L[0].at === 4 && L.size === 8 && W.slotSize({ kind: 'write', ranges: [[0x434, 4]], to: { page: true } }) === 32);
  set(PW + 16, T2); set(PW + 20, 1); set(PW + 16 + L.size, T2 + 0x100); set(PW + 20 + L.size, 7);
  set(STACK, 0x4d0000); X.fNop(CPU);
  check('page target, off: nothing written', u32(T2 + 0x434) === 0);
  set(PW, ON); X.fNop(CPU);
  check('page target: buffer 0 to its address + 0x434', u32(T2 + 0x434) === 1 && u32(PW + 4) === 1);
  Atomics.store(ia, (PW + 8) >> 2, 1); X.fNop(CPU);
  check('page target: after the flip, buffer 1 to its own address', u32(T2 + 0x100 + 0x434) === 7);
  set(PW + 16 + L.size, 0); X.fNop(CPU);
  check('page target 0: skipped', u32(PW + 4) === 2);
  set(PW, 0);
}

// a module that is not the game: patchGame refuses, not guesses
try { W.patchGame(Uint8Array.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]), { anchor: FN.view, hooks }); check('refuses other modules', false); }
catch (e) { check(`refuses other modules (${e.message})`, true); }
console.log(ok ? 'ALL OK' : 'SOME FAILED');
process.exit(ok ? 0 : 1);

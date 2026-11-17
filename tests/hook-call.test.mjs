// lib/wasmpatch.js's call hook on its own: at the once-a-frame function, the game's thread calls another game
// function once per request, with ecx and the arguments from the slot, on a stack below the current one, and puts
// every register back after.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildGame, FN, COUNTER, CALL_SAW, PAGES, R } from './fakegame.mjs';
const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
new Function(fs.readFileSync(ROOT + '/lib/wasmpatch.js', 'utf8'))();
const W = globalThis.U2WasmPatch, { prologue: P, ON } = W;
let ok = true; const check = (what, c) => { console.log(c ? 'ok  ' : 'FAIL', what); ok &&= !!c; };

const S = 0xff0100, S2 = 0xff0200, L = W.callLayout(1);
const hooks = [
  { guestAddr: FN.nop, calls: FN.called, build: P.call({ slot: S, args: 1, ret: 0x581475, at: FN.nop }) },
  { guestAddr: FN.nop, calls: FN.view + 1, build: P.call({ slot: S2, args: 0, at: FN.nop }) },     // not a function
];
const r = W.patchGame(buildGame(W), { anchor: FN.view, hooks });
check('the call hook goes in; one calling a wrong address fails alone', r.results[0].ok && !r.results[1].ok && /function to call/.test(r.results[1].error));
check('the slot: header, 1 argument, 36 bytes of registers', L.size === 32 + 4 + 36 && W.slotSize({ kind: 'call', args: 1 }) === 72);

const memory = new WebAssembly.Memory({ initial: PAGES, maximum: PAGES, shared: true });
const { instance } = await WebAssembly.instantiate(r.bytes, { env: { memory, log() {} } });
const X = instance.exports, dv = new DataView(memory.buffer);
const u32 = a => dv.getUint32(a, true), set = (a, v) => dv.setUint32(a, v >>> 0, true);
const CPU = 0x2000000, STACK = 0x3000008;
const regs = { eax: 1, ecx: 2, edx: 3, ebx: 4, esp: STACK, ebp: 6, esi: 7, edi: 8, eip: 9 };
const setRegs = () => { for (const [k, v] of Object.entries(regs)) set(CPU + R[k], v); set(STACK, 0x581475); };
const regsBack = () => Object.entries(regs).every(([k, v]) => u32(CPU + R[k]) === v);

setRegs(); set(S + L.ecx, 0x1000); set(S + L.args, 0x234);
X.fNop(CPU);
check('off: nothing called', u32(COUNTER.called) === 0 && u32(COUNTER.nop) === 1);
set(S, ON); X.fNop(CPU);
check('on, but no request: nothing called', u32(COUNTER.called) === 0 && u32(S + 4) === 0);

Atomics.store(new Int32Array(memory.buffer), (S + 8) >> 2, 1);
X.fNop(CPU);
check('a request: called once, then the hooked function ran', u32(COUNTER.called) === 1 && u32(COUNTER.nop) === 3 && u32(S + 4) === 1);
check('it saw ecx and its argument from the slot', u32(CALL_SAW.ecx) === 0x1000 && u32(CALL_SAW.arg) === 0x234);
check('the return address pushed is ret (GameLoop\'s)', u32(CALL_SAW.ret) === 0x581475);
check('its stack: 256 bytes down, 16-aligned, then the argument and the return address', u32(CALL_SAW.esp) === ((STACK - 256) & ~15) - 8);
check('eax kept in the slot', u32(S + L.eax) === 0x1234);
check('started and finished say request 1', u32(S + L.started) === 1 && u32(S + L.finished) === 1);
check('every register put back (eax, ebx, edx, esp, eip too)', regsBack());

X.fNop(CPU); X.fNop(CPU);
check('no new request: not called again', u32(COUNTER.called) === 1);
set(S + L.args, 0x5); Atomics.store(new Int32Array(memory.buffer), (S + 8) >> 2, 2);
set(STACK, 0x4d0000); X.fNop(CPU);
check('ret: a call from another caller doesn\'t run it', u32(COUNTER.called) === 1);
set(STACK, 0x581475); X.fNop(CPU);
check('the next request runs from GameLoop\'s call', u32(COUNTER.called) === 2 && u32(S + L.eax) === 0x1005 && u32(S + L.finished) === 2 && regsBack());

console.log(ok ? 'ALL OK' : 'SOME FAILED');
process.exit(ok ? 0 : 1);

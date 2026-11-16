import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');   // the u2-modloader folder
const src = fs.readFileSync(ROOT + '/loader.js', 'utf8');
const listeners = {};
globalThis.window = { addEventListener: (t, f) => (listeners[t] = f) };
globalThis.location = { pathname: "/" }; globalThis.document = { addEventListener() {}, body: null };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.requestAnimationFrame = () => 0;
globalThis.HTMLCanvasElement = class {};
new Function(src)();
const { buildMatrix, calibrateSample } = window.U2ML._test;
let pass = 0, fail = 0;
const rnd = () => Math.random() * 2 - 1;
for (const kind of ['view', 'world']) for (const perm of [[0,1,2],[2,0,1],[1,2,0]]) for (let s = 0; s < 8; s++) for (const transpose of [false, true]) {
  const L = { kind, perm, sign: [s&1?-1:1, s&2?-1:1, s&4?-1:1], transpose };
  const eye = [rnd()*3000, rnd()*3000, rnd()*50];
  const target = [eye[0]+rnd()*8, eye[1]+rnd()*8, eye[2]-1-Math.random()*2];
  const G = buildMatrix(L, eye, target, [0,0,1]).map(Math.fround);   // the game's floats
  const r = calibrateSample(G, eye, target);
  JSON.stringify(r.layout) === JSON.stringify(L) && r.err < 0.05 ? pass++ : (fail++, console.log('MISS', L, r));
}
// memory hook: a big shared memory is caught, a small one is not
new WebAssembly.Memory({ initial: 16, maximum: 16, shared: true });
console.log('small caught?', window.U2ML.mem.ready);
const m = new WebAssembly.Memory({ initial: 4096, maximum: 4096, shared: true });
console.log('big caught?', window.U2ML.mem.ready, 'instanceof ok?', m instanceof WebAssembly.Memory);
window.U2ML.mem.setF32(0x832e50, 1.5); console.log('rw', window.U2ML.mem.f32(0x832e50));
console.log(`calibration: ${pass} pass, ${fail} fail`);
process.exit(fail || !window.U2ML.mem.ready ? 1 : 0)

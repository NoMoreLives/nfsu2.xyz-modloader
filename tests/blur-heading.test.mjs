import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');   // the u2-modloader folder
const dir = ROOT;
let raf = null;
globalThis.window = globalThis; globalThis.addEventListener = () => {}; globalThis.top = globalThis;
globalThis.location = { pathname: '/' };
globalThis.document = { addEventListener() {}, body: null };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.requestAnimationFrame = f => { raf = f; };
globalThis.HTMLCanvasElement = class {};
for (const f of ['loader.js', 'mods/topdown.js']) new Function(fs.readFileSync(`${dir}/${f}`, 'utf8'))();
new WebAssembly.Memory({ initial: 4096, maximum: 4096, shared: true });
const M = U2ML.mem, PL = 0x1000000, MV = 0x1001000, CAR = 0x1002000, CAM = 0x1003000;
M.setU32(0x8654a4, 6); M.setU32(0xd00000, PL); M.setU32(PL + 4, CAR); M.setU32(PL + 0x238, MV); M.setU32(MV + 0xc, 1);
M.setU32(0x832e50 + 0x40, CAM); M.setU32(0x870cdc, 1);
M.setVec3(CAR + 0x60, [100, 200, 3]); M.setVec3(CAR + 0x70, [10, 0, 0]);
M.setVec3(CAR + 0x90, [1, 0, 0]); M.setVec3(CAR + 0xa0, [0, 1, 0]); M.setVec3(CAR + 0xb0, [0, 0, 1]);
U2ML.camera.layout = { kind: 'view', perm: [0, 1, 2], sign: [1, 1, 1], transpose: false };
let t = 0; const frame = () => raf(++t * 16);
for (let i = 0; i < 70; i++) frame();                     // the car drives along +x: forward learnt as row 0
let ok = true; const check = (w, c) => { console.log(c ? 'ok  ' : 'FAIL', w); ok &&= c; };
check('car forward learnt', JSON.stringify(U2ML.game.carForward()) === '[1,0,0]');
U2ML.setEnabled('topdown', true); frame();
check('top-down on: eye above the car', JSON.stringify(M.vec3(CAM + 0x40)) === '[100,200,43]');
check('top-down on: motion blur off', M.u32(0x870cdc) === 0);
U2ML.setEnabled('topdown', false); frame();
check('top-down off: motion blur back on', M.u32(0x870cdc) === 1);
console.log(ok ? 'ALL OK' : 'SOME FAILED'); process.exit(ok ? 0 : 1);

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');   // the u2-modloader folder
const dir = ROOT;
let raf = null;
globalThis.window = globalThis; globalThis.addEventListener = () => {}; globalThis.top = globalThis;
globalThis.location = { pathname: '/' };
globalThis.document = { addEventListener() {}, body: null };
const ls = new Map(); globalThis.localStorage = { getItem: k => ls.has(k) ? ls.get(k) : null, setItem: (k, v) => ls.set(k, v), removeItem: k => ls.delete(k) };
globalThis.requestAnimationFrame = f => { raf = f; };
globalThis.HTMLCanvasElement = class {};
for (const f of ['loader.js', 'mods/topdown.js', 'mods/drone.js']) new Function(fs.readFileSync(`${dir}/${f}`, 'utf8'))();
new WebAssembly.Memory({ initial: 4096, maximum: 4096, shared: true });
const M = U2ML.mem, PL = 0x1000000, MV = 0x1001000, CAR = 0x1002000, CAM = 0x1003000;
M.setU32(0x8654a4, 6); M.setU32(0xd00000, PL); M.setU32(PL + 4, CAR); M.setU32(PL + 0x238, MV); M.setU32(MV + 0xc, 1);
M.setU32(0x832e50 + 0x40, CAM); M.setU32(0x870cdc, 1);
M.setVec3(CAR + 0x90, [1, 0, 0]); M.setVec3(CAR + 0xa0, [0, 1, 0]); M.setVec3(CAR + 0xb0, [0, 0, 1]);
U2ML.camera.layout = { kind: 'view', perm: [0, 1, 2], sign: [1, 1, 1], transpose: false };
let t = 0, x = 0;
const drive = (n, v) => { for (let i = 0; i < n; i++) { x += v / 60; M.setVec3(CAR + 0x60, [x, 0, 0]); M.setVec3(CAR + 0x70, [v, 0, 0]); raf(++t * 1000 / 60); } };
let ok = true; const check = (w, c) => { console.log(c ? 'ok  ' : 'FAIL', w); ok &&= c; };
drive(70, 20);                                             // forward learnt
U2ML.setEnabled('topdown', true);
U2ML.setEnabled('drone', true);
check('drone on turns top-down off', !U2ML.mods.get('topdown').on && U2ML.mods.get('drone').on);
drive(180, 20);                                            // 3 s at 72 km/h
const eye = M.vec3(CAM + 0x40), tgt = M.vec3(CAM + 0x60);
console.log('car x', x.toFixed(1), 'eye', eye.map(v => v.toFixed(2)).join(' '), 'target', tgt.map(v => v.toFixed(2)).join(' '));
check('72 km/h: holds about 11 m behind', Math.abs(eye[0] - (x - 11)) < 0.3 && Math.abs(eye[1]) < 0.2);
check('about 4.5 m up', eye[2] > 4 && eye[2] < 5);
check('aims ahead of the car', tgt[0] > x);
drive(240, 60);
const e2 = M.vec3(CAM + 0x40); check(`216 km/h: still about 11 m behind (${(x - e2[0]).toFixed(2)})`, Math.abs(e2[0] - (x - 11)) < 0.3);
let v = 0, most = 0; for (let i = 0; i < 120; i++) { v += 8 / 60; drive(1, v); most = Math.max(most, x - M.vec3(CAM + 0x40)[0]); }
check(`hard launch (8 m/s²): drifts back, at most 3 m more (${(most - 11).toFixed(2)})`, most > 11.5 && most < 14.1);
// a key both mods have goes to the drone (on), not top-down
const before = ls.get('u2ml:drone:dist');
const press = code => globalThis.__keydown?.({ code, altKey: true, ctrlKey: false, shiftKey: false, repeat: false, preventDefault() {}, stopImmediatePropagation() {} });
console.log(ok ? 'ALL OK' : 'SOME FAILED'); process.exit(ok ? 0 : 1);

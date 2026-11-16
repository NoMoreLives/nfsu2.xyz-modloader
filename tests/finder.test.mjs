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
for (const f of ['loader.js', 'mods/topdown.js', 'mods/camfinder.js']) new Function(fs.readFileSync(`${dir}/${f}`, 'utf8'))();
new WebAssembly.Memory({ initial: 4096, maximum: 4096, shared: true });
const M = U2ML.mem;
// a fake game: player at 0x1000000, mover, car, camera; the views' settings in a table the mover points to
const PL = 0x1000000, MV = 0x1001000, CAR = 0x1002000, CAM = 0x1003000, TAB = 0x1004000;
M.setU32(0x8654a4, 6); M.setU32(0xd00000, PL); M.setU32(PL + 4, CAR); M.setU32(PL + 0x238, MV); M.setU32(MV + 0xc, 1);
M.setU32(0x832e50 + 0x40, CAM); M.setU32(MV + 0x40, TAB);
const HEIGHT = [1.2, 1.6, 2.4, 0.9, 6.0];
let t = 0;
function frame(view) {
  t++;
  M.setU32(0x83aa74, view);
  M.setF32(TAB + 0x18, HEIGHT[view]);            // the setting we want found
  M.setF32(TAB + 0x1c, 75);                       // same in every view: not a candidate
  M.setF32(MV + 0x80, Math.sin(t));               // changes all the time: not a candidate
  M.setF32(0x800000, view * 10 + (t % 3));        // differs per view but not stable within: not a candidate
  M.setVec3(CAR + 0x60, [t, 0, 0]);
  raf(t * 16);
}
U2ML.setEnabled('camfinder', true);
for (let round = 0; round < 2; round++) for (let v = 0; v < 5; v++) for (let k = 0; k < 20; k++) frame(v);
console.table = rows => console.log(JSON.stringify(rows));
const rows = U2ML.mods.get('camfinder').def.report();
const good = rows.length === 1 && rows[0].addr === '0x' + (TAB + 0x18).toString(16);
console.log(good ? 'ALL OK' : 'FINDER WRONG');
process.exit(good ? 0 : 1);

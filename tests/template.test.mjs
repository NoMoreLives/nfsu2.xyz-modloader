import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');   // the u2-modloader folder
const dir = ROOT;
let raf = null;
globalThis.window = globalThis; globalThis.addEventListener = () => {}; globalThis.top = globalThis;
globalThis.location = { pathname: '/' }; globalThis.document = { addEventListener() {}, body: null };
const ls = new Map(); globalThis.localStorage = { getItem: k => ls.has(k) ? ls.get(k) : null, setItem: (k, v) => ls.set(k, v), removeItem: k => ls.delete(k) };
globalThis.requestAnimationFrame = f => { raf = f; }; globalThis.HTMLCanvasElement = class {};
for (const f of ['loader.js', 'mods/template.js']) new Function(fs.readFileSync(`${dir}/${f}`, 'utf8'))();
new WebAssembly.Memory({ initial: 4096, maximum: 4096, shared: true });
const M = U2ML.mem, PL = 0x1000000, CAR = 0x1002000;
M.setU32(0x8654a4, 6); M.setU32(0xd00000, PL); M.setU32(PL + 4, CAR); M.setVec3(CAR + 0x70, [25, 0, 0]);   // 90 km/h
const def = U2ML.mods.get('template').def, store = U2ML.mods.get('template').store;
U2ML.setEnabled('template', true); raf(16); raf(32);
let ok = true; const check = (w, c) => { console.log(c ? 'ok  ' : 'FAIL', w); ok &&= c; };
check(`km/h: "${def.status()}"`, def.status() === 'speed: 90 km/h, top 90');
U2ML.options('template', 'units', 'mph'); U2ML.options('template', 'decimals', 1); raf(48);
check(`mph: "${def.status()}"`, def.status() === 'speed: 55.9 mph, top 55.9');
console.log(ok ? 'ALL OK' : 'SOME FAILED'); process.exit(ok ? 0 : 1);

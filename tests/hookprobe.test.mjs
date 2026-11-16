// The hook probe against the fake game: 60 game frames a second, each with three view setups (views 1, 4, 3).
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildGame, PAGES, R } from './fakegame.mjs';
const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
let raf = null;
globalThis.window = globalThis; globalThis.addEventListener = () => {}; globalThis.top = globalThis;
globalThis.location = { pathname: '/' };
globalThis.document = { addEventListener() {}, body: null };
const ls = new Map(); globalThis.localStorage = { getItem: k => ls.has(k) ? ls.get(k) : null, setItem: (k, v) => ls.set(k, v), removeItem: k => ls.delete(k) };
globalThis.requestAnimationFrame = f => { raf = f; };
globalThis.HTMLCanvasElement = class {};
for (const f of ['lib/wasmpatch.js', 'loader.js', 'mods/hookprobe.js']) new Function(fs.readFileSync(`${ROOT}/${f}`, 'utf8'))();
let ok = true; const check = (w, c) => { console.log(c ? 'ok  ' : 'FAIL', w); ok &&= !!c; };
const memory = new WebAssembly.Memory({ initial: PAGES, maximum: PAGES, shared: true });
const module = await WebAssembly.compileStreaming(new Response(buildGame(U2WasmPatch), { headers: { 'Content-Type': 'application/wasm' } }));
const { exports: X } = await WebAssembly.instantiate(module, { env: { memory, log() {} } });
const M = U2ML.mem, CPU = 0x2000000, STACK = 0x3000000, VIEWS = 0x1100000;
for (const id of [1, 3, 4]) M.setU32(VIEWS + id * 0x100 + 4, id);
M.setU32(CPU + R.esp, STACK); M.setU32(STACK, 0x5c8123);
const probe = U2ML.mods.get('hookprobe'), status = () => probe.def.status(U2ML, probe.store);
U2ML.setEnabled('hookprobe', true);
let t = 0;
const settle = () => new Promise(r => setTimeout(r, 16));    // the page hears of the game's frame (real time: the game loop's dt is)
// a game frame: GameLoop's call, the page (perhaps after some views), the rest of the views, then a screen frame
async function gameFrame(viewsFirst) {
  M.setU32(STACK, 0x581475); X.fNop(CPU);                 // GameLoop's call
  M.setU32(STACK, 0x4d1234); X.fNop(CPU); X.fNop(CPU);     // two of its other callers
  M.setU32(STACK, 0x5c8123);
  const ids = [1, 4, 3];
  const view = id => { M.setU32(STACK + 4, VIEWS + id * 0x100); X.fView(CPU); };
  ids.slice(0, viewsFirst).forEach(view);
  await settle();
  ids.slice(viewsFirst).forEach(view);
  raf(t += 1000 / 60);
}
for (let i = 0; i < 90; i++) await gameFrame(0);
let s = status(); console.log(s);
check('loop counts GameLoop\'s calls only (one a frame, not its other callers\')', /loop [3-6]\d\/s/.test(s) && !/loop 1\d\d/.test(s));
check('the captured argument names views 1, 3 and 4', /views 1:\d+ 3:\d+ 4:\d+/.test(s));
check('the frame\'s view order', /order 1 4 3\n/.test(s));
check('the mods ran before the frame\'s views', /ran in time 100% of \d+ frames\n/.test(s));
check('every return address in the game\'s code', /ret \d+ in the game's code, 0 not/.test(s));
for (let i = 0; i < 75; i++) await gameFrame(2);
s = status(); console.log(s);
check('late: after 2 of the frame\'s views (the window may hold some frames from before)', /; late: \d+x after 2 views\n/.test(s));
check('the panel\'s frames line has the game\'s rate and the probe on it', /game \d+\/s.*on it: hookprobe/.test(U2ML.status().frames));
U2ML.setEnabled('hookprobe', false);
console.log(ok ? 'ALL OK' : 'SOME FAILED'); process.exit(ok ? 0 : 1);

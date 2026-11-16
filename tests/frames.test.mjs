// Mods on the game's frames: the loader's frame hook (0x4022C0 from 0x581475) wakes the page, mods with
// runOn: 'game' run once a game frame, the others on the screen's; back on the screen's when the game's stop;
// the camera stays with the loop whose mod writes it.
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
for (const f of ['lib/wasmpatch.js', 'loader.js']) new Function(fs.readFileSync(`${ROOT}/${f}`, 'utf8'))();
let ok = true; const check = (w, c) => { console.log(c ? 'ok  ' : 'FAIL', w); ok &&= !!c; };

const seen = { g: [], s: [] };
U2ML.register({ id: 'g', defaultOn: true, runOn: 'game', frame(api, dt, store, info) { seen.g.push({ on: info.on, dt, frame: info.frame }); } });
U2ML.register({ id: 's', defaultOn: true, frame(api, dt, store, info) { seen.s.push(info.on); } });
let camOn = false;
U2ML.register({ id: 'cg', group: 'camera', runOn: 'game', frame(api) { if (camOn) api.camera.set([1, 2, 3], [11, 2, 3]); } });

const memory = new WebAssembly.Memory({ initial: PAGES, maximum: PAGES, shared: true });
const module = await WebAssembly.compileStreaming(new Response(buildGame(U2WasmPatch), { headers: { 'Content-Type': 'application/wasm' } }));
const { exports: X } = await WebAssembly.instantiate(module, { env: { memory, log() {} } });
const M = U2ML.mem, CPU = 0x2000000, STACK = 0x3000000, CAM = 0x1003000;
M.setU32(CPU + R.esp, STACK); M.setU32(0x832e50 + 0x40, CAM);
U2ML.camera.layout = { kind: 'view', perm: [0, 1, 2], sign: [1, 1, 1], transpose: false };
let t = 0;
const screen = () => raf(t += 1000 / 60);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function gameFrame() {
  M.setU32(STACK, 0x581475); X.fNop(CPU);                 // GameLoop's call
  M.setU32(STACK, 0x4d1234); X.fNop(CPU);                 // another caller: not a frame
  await sleep(12);                                         // the page hears of it
}
const reset = () => { seen.g.length = 0; seen.s.length = 0; };

screen(); screen();
check('before the game\'s frames: a game mod runs on the screen\'s', seen.g.length === 2 && seen.g.every(x => x.on === 'screen'));
await sleep(150);                                          // past the loop's start-up wait
reset();
for (let i = 0; i < 20; i++) { await gameFrame(); if (i % 2) screen(); }
check(`game mod: once a game frame (${seen.g.filter(x => x.on === 'game').length} of 20), never on the screen's`, seen.g.filter(x => x.on === 'game').length >= 18 && seen.g.every(x => x.on === 'game'));
check('screen mod: on the screen\'s frames only', seen.s.length === 10 && seen.s.every(x => x === 'screen'));
const dts = seen.g.slice(2).map(x => x.dt);
check(`game dt is the real time between game frames (${dts.map(d => (d * 1000).toFixed(0)).slice(0, 5).join(' ')} ms)`, dts.every(d => d > 0.008 && d < 0.05));
check('info.frame counts GameLoop\'s calls', seen.g.at(-1).frame - seen.g.at(-2).frame === 1);
check('the panel line', /game \d+\/s|game waiting/.test(U2ML.status().frames) && /on it: g cg|on it: g/.test(U2ML.status().frames));

// the camera, written on the game's frames: the screen loop leaves it alone
U2ML.setEnabled('cg', true); camOn = true;
await gameFrame(); screen(); screen();
X.fView(CPU);
check('a game-frame camera mod\'s camera reaches the game, screen frames in between', M.vec3(CAM + 0x40).join() === '1,2,3');
camOn = false; await gameFrame();
M.setVec3(CAM + 0x40, [5, 5, 5]); X.fView(CPU);
check('it stops writing: the next game frame gives the camera back', M.vec3(CAM + 0x40).join() === '5,5,5');
camOn = true; await gameFrame(); await gameFrame();

// the game's frames stop (a loading screen, a hook that went off): back on the screen's
reset(); await sleep(300); screen(); screen();
check('the game\'s frames stopped: the game mod runs on the screen\'s', seen.g.length === 2 && seen.g.every(x => x.on === 'screen'));
camOn = false; screen();
M.setVec3(CAM + 0x40, [6, 6, 6]); X.fView(CPU);
check('and the screen loop can give the camera back', M.vec3(CAM + 0x40).join() === '6,6,6');

U2ML.runOn('g', 'screen'); reset();
for (let i = 0; i < 4; i++) { await gameFrame(); screen(); }
check('U2ML.runOn(id, \'screen\') moves it to the screen\'s frames, saved', seen.g.length === 4 && seen.g.every(x => x.on === 'screen') && ls.get('u2ml:runon:g') === '"screen"');
console.log(ok ? 'ALL OK' : 'SOME FAILED'); process.exit(ok ? 0 : 1);

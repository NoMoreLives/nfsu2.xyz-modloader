// Game events: the state changes looked at once a frame (flow, race state, laps, photo mode) and carPlaced from
// the hook on Car::SetPosition; def.on handlers run only while their mod is on; U2ML.on from the console.
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
const quiet = console.log; console.log = (...a) => { if (a[0] !== '[u2ml]') quiet(...a); };
for (const f of ['lib/wasmpatch.js', 'loader.js']) new Function(fs.readFileSync(`${ROOT}/${f}`, 'utf8'))();
let ok = true; const check = (w, c) => { console.log(c ? 'ok  ' : 'FAIL', w); ok &&= !!c; };

const got = [];
U2ML.register({ id: 'ev', defaultOn: true, on: Object.fromEntries(U2ML.EVENTS.map(n => [n, (api, e) => got.push(e)])) });
const memory = new WebAssembly.Memory({ initial: PAGES, maximum: PAGES, shared: true });
const module = await WebAssembly.compileStreaming(new Response(buildGame(U2WasmPatch), { headers: { 'Content-Type': 'application/wasm' } }));
const { exports: X } = await WebAssembly.instantiate(module, { env: { memory, log() {} } });
const M = U2ML.mem, CPU = 0x2000000, STACK = 0x3000000;
// as on the live site: [player + 4] (CAR) is not the race's car for the player (WCAR), which is where CAR is
const PL = 0x1000000, MV = 0x1001000, CAR = 0x1002000, RS = 0x1004000, RP = 0x89e7a0, OTHER = 0x1005000, WCAR = 0x1007000, WT = 0x86518c;
M.setU32(0xd00000, PL); M.setU32(PL + 4, CAR); M.setU32(PL + 0x238, MV); M.setU32(MV + 0xc, 1);
M.setU32(0x890118, RS);
M.setVec3(CAR + 0x60, [100, 200, 10]); M.setVec3(WCAR + 0x60, [100, 200, 10]); M.setVec3(OTHER + 0x60, [105, 200, 10]);
let t = 0, clock = 0;
const frame = (still = false) => { if (!still) M.setU32(WT, clock += 33); raf(t += 1000 / 60); };
const names = () => got.map(e => e.name).join(' ');
const take = () => { const n = names(); got.length = 0; return n; };

M.setU32(0x8654a4, 3); frame(); frame();
check('nothing at the first look', take() === '');
// a race loads: a circuit of 2 laps, the player and one other racer
M.setU32(RP, 4014); M.setU32(RP + 0x10, 1); M.setU32(RP + 0x1c, 2);
M.setU32(RS + 0x24, 2); M.setU32(RS + 0x30, WCAR); M.setU8(RS + 0x30 + 9, 0); M.setU8(RS + 0x30 + 0xa, 2); M.setU32(RS + 0x30 + 0x1f0, OTHER);
M.setU32(RS, 3);
M.setU32(0x8654a4, 4); frame();
M.setU32(0x8654a4, 6); frame(true); for (let i = 0; i < 6; i++) frame(true);   // the world stands as it loads in
check(`loading, then the world, its countdown; no pause while it stands loading in: ${names()}`, names() === 'flow flow enterWorld countdown');
frame();
check('enterWorld carries the race', got[2].race && got[2].race.isRace && got[2].race.laps === 2 && got[2].race.racers === 2 && got[2].race.position === 2);
take();
M.setU32(RS, 4); frame();
check('countdown over: raceStart', take() === 'raceStart');
M.setU8(RS + 0x30 + 9, 1); M.setU8(RS + 0x30 + 0xa, 1); M.setU32(RS + 0x14, 4000 * 62); frame();
check('a lap', got.length === 1 && got[0].name === 'lap' && got[0].lap === 1 && got[0].laps === 2 && got[0].position === 1 && got[0].clock === 62);
take();
for (let i = 0; i < 3; i++) frame(true);
check('the world\'s clock standing 3 frames: not yet a pause', take() === '');
for (let i = 0; i < 5; i++) frame(true);
frame();
check('standing longer: pause, then resume when it moves', take() === 'pause resume');
M.setU32(MV + 0xc, 2); for (let i = 0; i < 6; i++) frame(true);       // photo mode: the world stands, no pause
M.setU32(MV + 0xc, 1); frame(true);                                  // back in the pause menu: still standing
frame();
check(`photo mode on and off, then the pause menu it came back to: ${names()}`, names() === 'photoMode photoMode pause resume' &&
  got[0].on === true && got[1].on === false); take();
// the race's car a frame's travel away from the player's when the page looks (the game thread moves them in turn)
M.setVec3(WCAR + 0x60, [103, 200, 10]); M.setU8(RS + 0x30 + 9, 2); frame();
check('the last lap, the cars apart: lap, then finish (the entry was kept)', take() === 'lap finish');
M.setVec3(WCAR + 0x60, [100, 200, 10]);

// carPlaced: the game's SetPosition on the player's car, not on another
const POS = 0x1006000; M.setVec3(POS, [10, 20, 30]);
M.setU32(CPU + R.esp, STACK); M.setU32(STACK, 0x5a0000); M.setU32(STACK + 4, POS); M.setF32(STACK + 8, 5); M.setU32(STACK + 12, 0x4000);
M.setU32(CPU + R.ecx, OTHER); X.fPlace(CPU);
M.setU32(CPU + R.ecx, WCAR); X.fPlace(CPU);
frame();
check('carPlaced for the player\'s car only (the race\'s car for it), with where, speed and heading', got.length === 1 && got[0].name === 'carPlaced' &&
  got[0].pos.join() === '10,20,30' && got[0].speed === 5 && got[0].heading === 90);
take();

// carReset: a new start of the car's blink at +0x974
M.setU32(CAR + 0x974, 63500); frame(); M.setU32(CAR + 0x974, 0); frame(); M.setU32(CAR + 0x974, 70000); frame();
check('carReset at each new reset, not when the blink ends', take() === 'carReset carReset');

// def.on only while the mod is on; U2ML.on always
const mine = []; const stop = U2ML.on('pause', e => mine.push(e));
U2ML.setEnabled('ev', false);
for (let i = 0; i < 6; i++) frame(true);
check('mod off: its handlers don\'t run; U2ML.on does', got.length === 0 && mine.length === 1);
stop(); frame(); for (let i = 0; i < 6; i++) frame(true); frame();
check('U2ML.on\'s stop function', mine.length === 1);
U2ML.setEnabled('ev', true);
M.setU32(0x8654a4, 3); frame();
check('leaving the world', take() === 'flow leaveWorld');
check('U2ML.events keeps them', U2ML.events().at(-1).name === 'leaveWorld');
console.log(ok ? 'ALL OK' : 'SOME FAILED'); process.exit(ok ? 0 : 1);

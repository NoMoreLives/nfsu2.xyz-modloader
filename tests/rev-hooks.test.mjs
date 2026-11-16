// The free-rev mod's hooks end to end: the real loader compiles a module shaped like the game's. With Z held at a
// standstill, the engine's step sees neutral in both car objects though the fake gearbox puts first back after
// every call, and the sound update reads the mod's rpm, which climbs with the throttle to a limiter at the redline.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildGame, SOUND_SAW, PAGES, R } from './fakegame.mjs';
const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
let raf = null;
const L = {};
globalThis.window = globalThis; globalThis.addEventListener = (t, f) => (L[t] ||= []).push(f); globalThis.top = globalThis;
globalThis.location = { pathname: '/' }; globalThis.document = { addEventListener() {}, body: null };
const ls = new Map(); globalThis.localStorage = { getItem: k => ls.has(k) ? ls.get(k) : null, setItem: (k, v) => ls.set(k, v), removeItem: k => ls.delete(k) };
globalThis.requestAnimationFrame = f => { raf = f; }; globalThis.HTMLCanvasElement = class {};
console.table = () => {};
const logs = []; const log0 = console.log;
console.log = (...a) => { logs.push(a.join(' ')); log0(...a); };
for (const f of ['lib/wasmpatch.js', 'loader.js', 'mods/rev.js']) new Function(fs.readFileSync(`${ROOT}/${f}`, 'utf8'))();
const W = globalThis.U2WasmPatch;
let ok = true; const check = (w, c) => { log0(c ? 'ok  ' : 'FAIL', w); ok &&= !!c; };

const memory = new WebAssembly.Memory({ initial: PAGES, maximum: PAGES, shared: true });
const module = await WebAssembly.compileStreaming(new Response(buildGame(W), { headers: { 'Content-Type': 'application/wasm' } }));
const { exports: X } = await WebAssembly.instantiate(module, { env: { memory, log() {} } });
const def = U2ML.mods.get('rev').def, H = U2ML.mods.get('rev').store.hooks;
check(`the mod's 10 hooks are in (${Object.values(H).map(h => h.state).join(', ')})`, Object.keys(H).length === 10 && Object.values(H).every(h => h.state === 'in'));

const M = U2ML.mem, PL = 0x1000000, MV = 0x1001000, CAR = 0x1002000, CAM = 0x1003000, CTL = 0x1004000, PERF = 0x1005000;
const RS = 0x1007000, RACECAR = 0x1008000, ENG = 0x1006000;
const CPU = 0x2000000, STACK = 0x3000000;
M.setU32(0x8654a4, 6); M.setU32(0xd00000, PL); M.setU32(PL + 4, CAR); M.setU32(PL + 0x238, MV); M.setU32(MV + 0xc, 1);
M.setU32(0x832e50 + 0x40, CAM);
// as live: the race's object for the player's car too, at the same place
M.setU32(0x890118, RS); M.setU32(RS, 4); M.setU32(RS + 0x24, 1); M.setU32(RS + 0x30, RACECAR);
for (const c of [CAR, RACECAR]) { M.setU32(c + 0x434, 2); M.setF32(c + 0x440, 1000); M.setU32(c + 0x30, CTL); }
M.setF32(CTL + 0x20c, 0);
// the car type's rpm range in its physics info ([car + 0x10] + 0x10: idle +0x220, most +0x228)
M.setU32(CAR + 0x10, PERF); M.setF32(PERF + 0x10 + 0x220, 900); M.setF32(PERF + 0x10 + 0x228, 7000);
M.setU32(CPU + R.esp, STACK); M.setU32(STACK, 0x5a1234);
/** a game frame: the physics (on an object that is not a car, as live), the game putting first gear and idle back
 *  in both car objects, then the sound, which reads the car's rpm */
const frame = () => {
  M.setU32(CPU + R.ecx, ENG); X.fSubstep(CPU); X.fEngine(CPU);
  for (const c of [CAR, RACECAR]) { M.setU32(c + 0x434, 2); M.setF32(c + 0x440, 1000); }
  M.setU32(CPU + R.ecx, CAR); X.fSoundRpm(CPU); X.fSound(CPU);
};
/** the gear the engine's step leaves in a car object: the hooks write before the step's body */
const gearAtStep = c => { M.setU32(c + 0x434, 2); M.setU32(CPU + R.ecx, ENG); X.fSubstep(CPU); return M.u32(c + 0x434); };
let t = 0; const tick = () => { frame(); raf(t += 1000 / 60); };
const key = type => { const e = { code: 'KeyZ', ctrlKey: false, altKey: false, metaKey: false, target: null,
  stopped: false, preventDefault() {}, stopImmediatePropagation() { this.stopped = true; } };
  for (const f of L[type] || []) { f(e); if (e.stopped) break; } };

tick(); tick();
check(`no key: the sound hears the game's idle (${M.f32(SOUND_SAW)})`, M.f32(SOUND_SAW) === 1000);
key('keydown'); tick();
check(`Z held: idle and redline from the car type: "${logs.find(l => /rev: on/.test(l))}"`, logs.some(l => /idle 900, redline 7000 \(the car's\); hooks in/.test(l)));
tick(); frame();
check('Z held: the step puts both car objects in neutral, though the game put first back', gearAtStep(CAR) === 1 && gearAtStep(RACECAR) === 1);
check(`Z held, off the throttle: the sound hears idle (${M.f32(SOUND_SAW)})`, Math.abs(M.f32(SOUND_SAW) - 900) < 1);
M.setF32(CTL + 0x20c, 1);
const heard = [];
for (let i = 0; i < 60; i++) { tick(); frame(); heard.push(M.f32(SOUND_SAW)); }
check(`full throttle: the sound's rpm climbs (${heard.slice(0, 6).map(Math.round).join(' ')} …)`, heard[1] > heard[0] && heard[5] > heard[1] + 500);
check(`and bounces off the limiter under 7000 (top ${Math.round(Math.max(...heard))}, last ${heard.slice(-4).map(Math.round).join(' ')})`,
  Math.max(...heard) < 7000 && Math.max(...heard) > 6500 && heard.slice(-20).some((x, i, a) => i && x < a[i - 1]));
check(`status: "${def.status()}"`, /^rev: revving: \d+ rpm \(redline 7000\), throttle 100%, rpm hooks 3\/3 in$/.test(def.status()));
M.setF32(CTL + 0x20c, 0);
for (let i = 0; i < 90; i++) { tick(); frame(); }                      // 5000 rpm a second down
check(`off the throttle: back down to idle (${Math.round(M.f32(SOUND_SAW))})`, Math.abs(M.f32(SOUND_SAW) - 900) < 1);
key('keyup'); tick(); frame();
check(`let go: the sound hears the game's rpm again (${M.f32(SOUND_SAW)})`, M.f32(SOUND_SAW) === 1000);
check(`let go: the step leaves the game's gear (${gearAtStep(CAR)})`, gearAtStep(CAR) === 2);
const off = logs.find(l => /rev: off/.test(l)) || '';
check(`the off line counts the rpm writes: "${off}"`, /rpm writes 0x594300 \d+, 0x483b40 [1-9]\d*, 0x484c50 [1-9]\d*/.test(off));

console.log = log0;
console.log(ok ? 'ALL OK' : 'SOME FAILED'); process.exit(ok ? 0 : 1);

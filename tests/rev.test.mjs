// The free-rev mod against a fake game: Z held at a standstill puts the car in neutral, letting go gives the gear
// back, and Z is kept from the site only while the mod is on in the world.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const dir = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');   // the u2-modloader folder
let raf = null;
const L = {};
globalThis.window = globalThis; globalThis.addEventListener = (t, f) => (L[t] ||= []).push(f); globalThis.top = globalThis;
globalThis.location = { pathname: '/' }; globalThis.document = { addEventListener() {}, body: null };
const ls = new Map(); globalThis.localStorage = { getItem: k => ls.has(k) ? ls.get(k) : null, setItem: (k, v) => ls.set(k, v), removeItem: k => ls.delete(k) };
globalThis.requestAnimationFrame = f => { raf = f; }; globalThis.HTMLCanvasElement = class {};
for (const f of ['lib/wasmpatch.js', 'loader.js', 'mods/rev.js']) new Function(fs.readFileSync(`${dir}/${f}`, 'utf8'))();
new WebAssembly.Memory({ initial: 4096, maximum: 4096, shared: true });
const M = U2ML.mem, PL = 0x1000000, MV = 0x1001000, CAR = 0x1002000, CAM = 0x1003000, CTL = 0x1004000;
M.setU32(0x8654a4, 6); M.setU32(0xd00000, PL); M.setU32(PL + 4, CAR); M.setU32(PL + 0x238, MV); M.setU32(MV + 0xc, 1);
M.setU32(0x832e50 + 0x40, CAM);
M.setU32(CAR + 0x434, 2); M.setF32(CAR + 0x440, 900); M.setU32(CAR + 0x30, CTL); M.setF32(CTL + 0x20c, 1);
let t = 0;
const frames = n => { for (let i = 0; i < n; i++) raf(++t * 1000 / 60); };
const key = (type, extra = {}) => {
  const e = { code: 'KeyZ', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, repeat: false, target: null,
    stopped: false, preventDefault() {}, stopImmediatePropagation() { this.stopped = true; }, ...extra };
  for (const f of L[type] || []) { f(e); if (e.stopped) break; }
  return e;
};
const gear = () => M.u32(CAR + 0x434);
let ok = true; const check = (w, c) => { console.log(c ? 'ok  ' : 'FAIL', w); ok &&= c; };
const def = U2ML.mods.get('rev').def;

check('on by default', U2ML.mods.get('rev').on);
frames(3);
check(`no key: first gear stays (${gear()})`, gear() === 2);
check(`status: "${def.status()}"`, def.status() === 'rev: hold Z when stopped (gear 1, 900 rpm)');

check('Z kept from the site in the world', key('keydown').stopped);
frames(2);
check(`Z held, standing: neutral (${gear()})`, gear() === 1);
check(`status, no game module so no hooks: "${def.status()}"`, /^rev: revving: \d+ rpm \(redline 7500\), throttle 100%, rpm hooks 0\/3 in$/.test(def.status()));
check(`without hooks the page writes the rpm itself (${Math.round(M.f32(CAR + 0x440))})`, M.f32(CAR + 0x440) > 900);
M.setU32(CAR + 0x434, 2); frames(1);                         // the game's gearbox takes the gear back once
check(`taken back: neutral again (${gear()})`, gear() === 1);
check('Z let go: keyup kept too', key('keyup').stopped);
frames(1);
check(`let go: first gear back (${gear()})`, gear() === 2);

M.setVec3(CAR + 0x70, [10, 0, 0]);                          // 36 km/h
key('keydown'); frames(3);
check(`Z held while moving: no neutral (${gear()})`, gear() === 2);
M.setVec3(CAR + 0x70, [0, 0, 0]); frames(1);
check(`stopped with Z still held: neutral (${gear()})`, gear() === 1);
M.setVec3(CAR + 0x70, [5, 0, 0]); frames(1);                // 18 km/h: rolling off
check(`rolling off: gear back (${gear()})`, gear() === 2);
key('keyup'); M.setVec3(CAR + 0x70, [0, 0, 0]);

const rs = 0x1005000; M.setU32(0x890118, rs); M.setU32(rs, 3);   // a countdown
key('keydown'); frames(2);
check(`countdown: left to the game (${gear()})`, gear() === 2);
key('keyup'); M.setU32(rs, 4);

check('typing in chat: Z goes through', !key('keydown', { target: { tagName: 'INPUT' } }).stopped);
check('Alt+Z is not ours', !key('keydown', { altKey: true }).stopped);
M.setU32(0x8654a4, 3);
check('front end: Z goes through', !key('keydown').stopped);
M.setU32(0x8654a4, 6);

key('keydown'); frames(1);
check('neutral before switching off', gear() === 1);
U2ML.setEnabled('rev', false);
check(`mod off: gear back (${gear()})`, gear() === 2);
check('mod off: Z goes through', !key('keydown').stopped);

console.log(ok ? 'ALL OK' : 'SOME FAILED'); process.exit(ok ? 0 : 1);

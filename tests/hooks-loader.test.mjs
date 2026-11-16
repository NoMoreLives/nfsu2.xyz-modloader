// The real loader end to end: a mod declares hooks, the page's compileStreaming gets a module shaped like the
// game's, and the mod's handles see the calls. Also: the camera on the loader's own write hook, skips last on a
// function, late hooks, and the guard turning everything off when something else writes the hook area.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildGame, FN, COUNTER, PAGES, R } from './fakegame.mjs';
const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
let raf = null;
globalThis.window = globalThis; globalThis.addEventListener = () => {}; globalThis.top = globalThis;
globalThis.location = { pathname: '/' };
globalThis.document = { addEventListener() {}, body: null };
const ls = new Map(); globalThis.localStorage = { getItem: k => ls.has(k) ? ls.get(k) : null, setItem: (k, v) => ls.set(k, v), removeItem: k => ls.delete(k) };
globalThis.requestAnimationFrame = f => { raf = f; };
globalThis.HTMLCanvasElement = class {};
const quiet = console.table; console.table = () => {};
for (const f of ['lib/wasmpatch.js', 'loader.js']) new Function(fs.readFileSync(`${ROOT}/${f}`, 'utf8'))();
const W = globalThis.U2WasmPatch;
let ok = true; const check = (w, c) => { console.log(c ? 'ok  ' : 'FAIL', w); ok &&= !!c; };

U2ML.register({
  id: 'probe', name: 'Probe',
  hooks: [
    { name: 'view', at: FN.view, kind: 'notify' },
    { name: 'args', at: FN.view, kind: 'capture', args: 1, keep: 4 },
    { name: 'off', at: FN.race, kind: 'skip', pop: 4, eax: 7 },
    { name: 'raceSeen', at: FN.race, kind: 'notify' },              // declared after the skip, still sees the call
    { name: 'bad', at: FN.view + 1, kind: 'notify' },
    { name: 'wrong', at: FN.view, kind: 'shout' },
  ],
});
const H = U2ML.mods.get('probe').store.hooks;
check('before the module: waiting', H.view.state === 'waiting for the game module' && !H.view.ready);
check('a wrong declaration fails at once', /^failed: kind/.test(H.wrong.state));

const memory = new WebAssembly.Memory({ initial: PAGES, maximum: PAGES, shared: true });
const resp = new Response(buildGame(W), { headers: { 'Content-Type': 'application/wasm' } });
const module = await WebAssembly.compileStreaming(resp);
const { exports: X } = await WebAssembly.instantiate(module, { env: { memory, log() {} } });
const M = U2ML.mem, u32 = M.u32;
let t = 0; const frame = () => raf(t += 1000 / 60);
const table = Object.fromEntries(U2ML.hooks().map(h => [h.hook, h]));
console.log(Object.values(table).map(h => `${h.hook} ${h.kind} ${h.at} ${h.state} ${h.slot}`).join('\n'));
check('the camera and the probe hooks are in', ['u2ml.camera', 'probe.view', 'probe.args', 'probe.off', 'probe.raceSeen'].every(k => table[k].state === 'in'));
check('a hook at a wrong address fails alone', /not the start/.test(table['probe.bad'].state));
const slots = Object.values(table).filter(h => h.slot !== '-').map(h => +h.slot);
check('slots are in the hook area and apart', slots.length >= 5 && slots.every(s => s >= 0xff0000 && s < 0x1000000) && new Set(slots).size === slots.length);

const CPU = 0x2000000, STACK = 0x3000000;
M.setU32(CPU + R.esp, STACK); M.setU32(STACK, 0x5a1234); M.setU32(STACK + 4, 0x832e50);
frame(); X.fView(CPU);
check('mod off: its hooks stay off', H.view.count() === 0 && u32(COUNTER.view) === 1);
U2ML.setEnabled('probe', true);
M.setU32(CPU + R.ecx, 0xabc); X.fView(CPU); X.fView(CPU);
check('mod on: the hooks act at once', H.view.count() === 2);
const a = H.args.read();
check('capture read: ecx, the return address and the argument', a && a.call === 1 && a.ecx === 0xabc && a.ret === 0x5a1234 && a.args[0] === 0x832e50);
check('capture since', H.args.since(0).map(x => x.call).join() === '0,1' && H.args.since(1).length === 1);

M.setU32(CPU + R.esp, STACK); X.fRace(CPU);
check('skip: body skipped, eax 7, esp past ret 4', u32(COUNTER.race) === 0 && u32(CPU + R.eax) === 7 && u32(CPU + R.esp) === STACK + 8);
check('the loader put the skip last: the notify there saw it', H.raceSeen.count() === 1 && H.off.count() === 1);
H.off.result(9); M.setU32(CPU + R.esp, STACK); X.fRace(CPU);
check('skip result changed to 9', u32(CPU + R.eax) === 9);
H.off.enable(false); M.setU32(CPU + R.esp, STACK); X.fRace(CPU);
check('skip switched off alone: the body runs', u32(COUNTER.race) === 1 && H.raceSeen.count() === 3);

const p = H.view.wait(2000), c0 = H.view.count();
setTimeout(() => X.fView(CPU), 5);
check('wait resolves at the next call', await p === c0 + 1);

// the camera through the loader's own write hook (at the view setup)
const CAM = 0x1003000;
M.setU32(0x832e50 + 0x40, CAM);
U2ML.camera.layout = { kind: 'view', perm: [0, 1, 2], sign: [1, 1, 1], transpose: false };
check('the camera goes through the hook', U2ML.camera.set([1, 2, 3], [11, 2, 3]));
check('nothing reaches the camera before the game\'s call', M.f32(CAM + 0x40) === 0);
X.fView(CPU);
check('the game\'s call copies it in: eye and target', M.vec3(CAM + 0x40).join() === '1,2,3' && M.vec3(CAM + 0x60).join() === '11,2,3');
frame();                                                    // no mod wrote the camera: the hook lets go
M.setVec3(CAM + 0x40, [5, 5, 5]); X.fView(CPU);
check('a frame without a camera mod: the game\'s camera stays', M.vec3(CAM + 0x40).join() === '5,5,5');

U2ML.setEnabled('probe', false); const n0 = H.view.count(); X.fView(CPU);
check('mod off again: hooks off', H.view.count() === n0);

U2ML.register({ id: 'late', hooks: [{ name: 'x', at: FN.loop, kind: 'notify' }] });
check('a hook registered after the module compiled: too late', U2ML.mods.get('late').store.hooks.x.state === 'too late: reload the page');

// the guard: something else writes the hook area
U2ML.setEnabled('probe', true); frame();
M.setU32(0xfff000, 5); t += 1000; frame();
check('a foreign word in the area: every hook reports area busy', H.view.state === 'area busy' && !H.view.ready && /something else/.test(U2ML.status().hooks));
const vs = +table['probe.view'].slot, n1 = u32(vs + 4); X.fView(CPU);
check('and no hook acts any more', U2ML.hooks().every(h => !h.on) && u32(vs + 4) === n1 && U2ML.hooks().every(h => h.slot === '-' || u32(+h.slot) === 0));
console.table = quiet;
console.log(ok ? 'ALL OK' : 'SOME FAILED'); process.exit(ok ? 0 : 1);

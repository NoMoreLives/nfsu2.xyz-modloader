// The map & autopilot mod against a fake game: a small road network in the game's road table, the route along it,
// and the autopilot through the loader's call hooks (Alt+P on in free roam, off at the waypoint, off when a driving
// key is pressed, refused in a race). The game's thread is the fake once-a-frame function, called from GameLoop's
// return address.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildGame, CALL_SAW, COUNTER, PAGES, R } from './fakegame.mjs';
const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
let raf = null;
const L = {};
globalThis.window = globalThis; globalThis.addEventListener = (t, f) => (L[t] ||= []).push(f); globalThis.top = globalThis;
globalThis.location = { pathname: '/' }; globalThis.document = { addEventListener() {}, body: null };
const ls = new Map(); globalThis.localStorage = { getItem: k => ls.has(k) ? ls.get(k) : null, setItem: (k, v) => ls.set(k, v), removeItem: k => ls.delete(k) };
globalThis.requestAnimationFrame = f => { raf = f; }; globalThis.HTMLCanvasElement = class {};
console.table = () => {};
const logs = []; const log0 = console.log;
console.log = (...a) => { logs.push(a.join(' ')); };
for (const f of ['lib/wasmpatch.js', 'loader.js', 'mods/map.js']) new Function(fs.readFileSync(`${ROOT}/${f}`, 'utf8'))();
const W = globalThis.U2WasmPatch;
let ok = true; const check = (w, c) => { log0(c ? 'ok  ' : 'FAIL', w); ok &&= !!c; };

const memory = new WebAssembly.Memory({ initial: PAGES, maximum: PAGES, shared: true });
const module = await WebAssembly.compileStreaming(new Response(buildGame(W), { headers: { 'Content-Type': 'application/wasm' } }));
const { exports: X } = await WebAssembly.instantiate(module, { env: { memory, log() {} } });
const mod = U2ML.mods.get('map'), def = mod.def, H = mod.store.hooks, T = def._t;
check(`the mod's 4 hooks are in (${Object.entries(H).map(([k, h]) => `${k} ${h.state}`).join(', ')})`, Object.values(H).every(h => h.state === 'in'));
check('on by default', mod.on);

// the world: free roam (track 4000, race kind 0, race state 4), the player and its car at the origin
const M = U2ML.mem, PL = 0x1000000, CAR = 0x1002000, RS = 0x1007000, CPU = 0x2000000, STACK = 0x3000000;
M.setU32(0x8654a4, 6); M.setU32(0xd00000, PL); M.setU32(PL + 4, CAR); M.setU32(0x890118, RS); M.setU32(RS, 4);
M.setU32(0x89e7a0, 4000); M.setU32(0x89e7a0 + 0x10, 0);
const carAt = (x, y) => M.setVec3(CAR + 0x60, [x, y, 0]);
carAt(1, 1);

// roads: 0 east along y = 0 (0..200), 1 north along x = 200 (0..200), 2 north along x = 0 (0..300), a dead end; a
// joint from road 0's last node to road 1's first. Road 2 starts where road 0 does, but without a joint: no way across.
const ROADS = 0x88a334, RD = 0x1100000, JT = 0x1200000;
const roads = [[[0, 0], [100, 0], [200, 0]], [[200, 0], [200, 100], [200, 200]], [[0, 0], [0, 150], [0, 300]]];
roads.forEach((nodes, i) => {
  const r = RD + i * 0x1000;
  M.setU32(ROADS + 4 * i, r); M.setU16(r + 0xa, i); M.setU16(r + 0x34, nodes.length);
  nodes.forEach(([x, y], k) => { const nd = r + 0x8c + 0x38 * k; M.setF32(nd, x); M.setF32(nd + 4, y); M.setU16(nd + 0x12, 8); });
});
M.setU32(0x883db0, JT); M.setU32(0x883db4, 1);
M.setU16(JT + 4, 2); M.setU16(JT + 6, 0); M.setU16(JT + 8, 0); M.setU16(JT + 0xa, 1);

const net = T.readNet(M);
check('the network: 9 points on 3 roads, 1 joint', net && net.n === 9 && net.roads.length === 3 && net.joints === 1);
check('heights in 1/8 m', net.z[0] === 1);
const a = T.nearest(net, 3, 2), b = T.nearest(net, 199, 190), c = T.nearest(net, 1, 290);
check('nearest points', net.x[a] === 0 && net.y[a] === 0 && net.x[b] === 200 && net.y[b] === 200 && net.x[c] === 0 && net.y[c] === 300);
const p = T.route(net, a, b);
check(`the route east then north, 400 m (${p && T.pathLen(net, p)})`, p && T.pathLen(net, p) === 400 && net.x[p[2]] === 200 && net.y[p[2]] === 0);
check('no route to a road nothing joins', T.route(net, b, c) === null);

// the game's thread: GameLoop's once-a-frame call, every 5 ms; the page's frames
M.setU32(CPU + R.esp, STACK); M.setU32(STACK, 0x581475);
const game = setInterval(() => { M.setU32(CPU + R.esp, STACK); X.fNop(CPU); }, 5);
let t = 0; const frame = () => raf(t += 1000 / 60);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const key = (code, alt = false) => { const e = { code, altKey: alt, ctrlKey: false, shiftKey: false, metaKey: false, repeat: false, target: null, preventDefault() {}, stopImmediatePropagation() {} }; for (const f of L.keydown || []) f(e); };
const until = async (fn, ms = 2000) => { const t0 = Date.now(); while (!fn() && Date.now() - t0 < ms) { frame(); await sleep(5); } return fn(); };

frame(); frame();
await until(() => T.S.net);
check('the mod read the roads in the world', T.S.net && T.S.net.n === 9);
mod.store.set('waypoint', [200, 200, 1]);
await until(() => T.S.route);
check(`a route to the waypoint (${T.S.left} m left)`, T.S.route && Math.round(T.S.left) === 401);

// Alt+P without the research switch: refused, nothing called (it crashed the game live, 2026-11-17)
key('KeyP', true); await sleep(30); frame();
check('Alt+P is off for now: refused, AutoPilotOn not called', T.S.ap.state === 'off' && M.u32(COUNTER.called) === 0 && logs.some(l => /off for now/.test(l)));
mod.store.set('apResearch', true);

// Alt+P: the autopilot on, through AutoPilotOn on the game's thread, ecx = the player
key('KeyP', true);
check('Alt+P: the autopilot on', await until(() => T.S.ap.state === 'on'));
check('AutoPilotOn ran once, with ecx = the player, from GameLoop\'s return address', M.u32(COUNTER.called) === 1 && M.u32(CALL_SAW.ecx) === PL && M.u32(CALL_SAW.ret) === 0x581475);
check('the call hooks are off again with no request out', U2ML.hooks().filter(h => h.hook.startsWith('map.ap') || h.hook === 'map.input').every(h => !h.on));
check('the panel line says so', /autopilot on/.test(def.status(U2ML, mod.store)));

// near the waypoint: it lets go (AutoPilotOff, then the keys' input mode)
carAt(195, 190); await sleep(20);
check('at the waypoint: off', await until(() => T.S.ap.state === 'off'));
check('AutoPilotOff and SetInputMode(2) were called', U2ML.hooks().find(h => h.hook === 'map.apOff').calls === 1 && U2ML.hooks().find(h => h.hook === 'map.input').calls === 1);
check('said why', logs.some(l => /autopilot off \(at the waypoint\)/.test(l)));

// on again away from it, then a driving key takes the car back
carAt(1, 1); await sleep(20);
key('KeyP', true);
await until(() => T.S.ap.state === 'on');
key('ArrowUp');
check('a driving key: off', await until(() => T.S.ap.state === 'off') && logs.some(l => /you took the wheel/.test(l)));
check('AutoPilotOn twice, AutoPilotOff twice in all', M.u32(COUNTER.called) === 2 && U2ML.hooks().find(h => h.hook === 'map.apOff').calls === 2);

// an outrun (the player's opponent set): refused
M.setU32(PL + 0x250, 0x1009000);
key('KeyP', true); await sleep(30); frame();
check('in an outrun: refused', T.S.ap.state === 'off' && M.u32(COUNTER.called) === 2);
M.setU32(PL + 0x250, 0);

// a race: refused
M.setU32(0x89e7a0, 4012); M.setU32(0x89e7a0 + 0x10, 1);
key('KeyP', true); await sleep(30); frame();
check('in a race: refused', T.S.ap.state === 'off' && M.u32(COUNTER.called) === 2 && logs.some(l => /free roam only/.test(l)));

// the GPS probe: a call of 0x529480 is logged with its arguments
check('the GPS probe is in', H.gpsStart.ready);

clearInterval(game);
log0(ok ? 'ALL OK' : 'SOME FAILED');
process.exit(ok ? 0 : 1);

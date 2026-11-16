import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');   // the u2-modloader folder
const dir = ROOT;
globalThis.window = globalThis; globalThis.addEventListener = () => {}; globalThis.top = globalThis;
globalThis.location = { pathname: '/' }; globalThis.document = { addEventListener() {}, body: null };
const ls = new Map(); globalThis.localStorage = { getItem: k => ls.has(k) ? ls.get(k) : null, setItem: (k, v) => ls.set(k, v), removeItem: k => ls.delete(k) };
globalThis.requestAnimationFrame = () => {}; globalThis.HTMLCanvasElement = class {};
for (const f of ['loader.js', 'mods/topdown.js', 'mods/drone.js']) new Function(fs.readFileSync(`${dir}/${f}`, 'utf8'))();
let ok = true; const check = (w, c) => { console.log(c ? 'ok  ' : 'FAIL', w); ok &&= c; };
check('defaults when nothing set', U2ML.options('drone').dist === 11 && U2ML.options('topdown').height === 40 && U2ML.options('topdown').northUp === false);
check('kept within range', U2ML.options('drone', 'dist', 1000) === 80 && U2ML.options('drone', 'dist', -5) === 2);
check('rounded to the step', U2ML.options('drone', 'dist', 12.34) === 12.5);
check('saved', ls.get('u2ml:drone:dist') === '12.5');
check('a choice not listed falls back to the default', U2ML.options('topdown', 'northUp', 'sideways') === false);
let told = null; U2ML.mods.get('drone').def.onOption = (k, v) => { told = [k, v]; };
U2ML.options('drone', 'height', 7); check('the mod is told', told && told[0] === 'height' && told[1] === 7);
U2ML.mods.get('drone').store.reset(); check('reset', U2ML.options('drone').dist === 11 && U2ML.options('drone').height === 4.5);
console.log(ok ? 'ALL OK' : 'SOME FAILED'); process.exit(ok ? 0 : 1);

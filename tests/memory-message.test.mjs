import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');   // the u2-modloader folder
const src = fs.readFileSync(ROOT + '/loader.js', 'utf8');
globalThis.window = { addEventListener() {} }; window.top = window;
globalThis.location = { pathname: '/' };
globalThis.document = { addEventListener() {}, body: null };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.requestAnimationFrame = () => 0;
globalThis.HTMLCanvasElement = class {};
const Real = WebAssembly.Memory;                     // made before the loader: as a worker would
const big = new Real({ initial: 4096, maximum: 8192, shared: true });
new Function(src)();
const ev = new MessageEvent('message', { data: { t: 'init', cfg: { memory: big } } });
void ev.data;
const caught = window.U2ML.mem.ready && window.U2ML.mem.memory === big;
console.log('caught via message?', caught);
big.grow(16); window.U2ML.mem.setU32(0x832e50, 7); const rw = window.U2ML.mem.u32(0x832e50) === 7;
console.log('rw after grow', rw);
console.log(caught && rw ? 'ALL OK' : 'SOME FAILED');
process.exit(caught && rw ? 0 : 1);

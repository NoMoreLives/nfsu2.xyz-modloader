// Runs every tests/*.test.mjs with Node (20 or newer) and says which passed.
//   node tests/run.mjs            all of them
//   node tests/run.mjs drone      only those whose name has "drone"
//   node tests/run.mjs --panel    also render the panel and the overlay in headless Chrome (tests/panel.mjs, overlay.mjs)
//
// The tests run the real loader and mods against a fake game: a shared WebAssembly memory with a player, a car
// and a camera at the game's addresses. They can't prove anything about the live site (see CLAUDE.md).
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const args = process.argv.slice(2), filter = args.find(a => !a.startsWith('--'));
const files = readdirSync(here).filter(f => f.endsWith('.test.mjs') && (!filter || f.includes(filter))).sort();
if (args.includes('--panel')) files.push('panel.mjs', 'overlay.mjs');

let failed = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, [here + f], { encoding: 'utf8', timeout: 120000 });
  const ok = r.status === 0;
  if (!ok) failed++;
  const last = (r.stdout || '').trim().split('\n').filter(l => !l.startsWith('[u2ml]')).pop() || '';
  console.log(`${ok ? 'pass' : 'FAIL'}  ${f.padEnd(26)} ${last}`);
  if (!ok) console.log((r.stdout || '') + (r.stderr || ''));
}
console.log(failed ? `${failed} of ${files.length} failed` : `all ${files.length} passed`);
process.exit(failed ? 1 : 0);

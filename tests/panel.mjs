// Renders tests/panel.html in headless Chrome: the panel with the mods' options open, a value set from the
// console. Passes when the page reports its sliders and the new value; saves a picture to tests/out/panel.png
// to look at. Chrome: the macOS default place, or the path in $CHROME.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const chrome = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!existsSync(chrome)) { console.log(`skipped: no Chrome at ${chrome} (set $CHROME)`); process.exit(0); }
mkdirSync(join(here, 'out'), { recursive: true });
const profile = mkdtempSync(join(tmpdir(), 'u2ml-panel-'));
const r = spawnSync(chrome, [
  '--headless=new', '--disable-gpu', '--allow-file-access-from-files', `--user-data-dir=${profile}`,
  '--window-size=460,1300', '--virtual-time-budget=15000', `--screenshot=${join(here, 'out', 'panel.png')}`,
  '--dump-dom', pathToFileURL(join(here, 'panel.html')).href,
], { encoding: 'utf8', timeout: 60000 });
const title = (/<title>([^<]*)<\/title>/.exec(r.stdout || '') || [])[1] || 'no page';
console.log(`${title}; picture: tests/out/panel.png`);
process.exit(title.startsWith('OK') ? 0 : 1);

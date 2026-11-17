// Renders tests/overlay.html in headless Chrome twice: the big map open (tests/out/map.png) and the corner map
// while driving (tests/out/mini.png), over a made-up city in a fake game memory. Passes when the page found its
// route; the pictures are to look at. Chrome: the macOS default place, or the path in $CHROME.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const chrome = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!existsSync(chrome)) { console.log(`skipped: no Chrome at ${chrome} (set $CHROME)`); process.exit(0); }
mkdirSync(join(here, 'out'), { recursive: true });
let bad = 0;
for (const view of ['map', 'mini']) {
  const profile = mkdtempSync(join(tmpdir(), 'u2ml-overlay-'));
  const r = spawnSync(chrome, [
    '--headless=new', '--disable-gpu', '--allow-file-access-from-files', `--user-data-dir=${profile}`,
    '--enable-features=SharedArrayBuffer', '--window-size=1000,640', '--virtual-time-budget=40000',
    `--screenshot=${join(here, 'out', view + '.png')}`, '--dump-dom', pathToFileURL(join(here, 'overlay.html')).href + `?view=${view}`,
  ], { encoding: 'utf8', timeout: 60000 });
  const title = (/<title>([^<]*)<\/title>/.exec(r.stdout || '') || [])[1] || 'no page';
  console.log(`${title}; picture: tests/out/${view}.png`);
  if (!title.startsWith('OK')) bad++;
}
process.exit(bad ? 1 : 0);

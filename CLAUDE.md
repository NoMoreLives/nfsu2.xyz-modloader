# U2 Mod Loader: notes for working on it

A Chrome MV3 extension that injects client-side mods into the browser NFS Underground 2 at nfsu2.xyz (built from
[nfsu2-web](https://github.com/th0mk/nfsu2-web), which is archived; nfsu2.xyz is developed privately). Player
docs: [README.md](README.md). Mod author docs: [MODDING.md](MODDING.md). What's next: [ROADMAP.md](ROADMAP.md).

## Layout

| Path | What |
|---|---|
| `manifest.json` | Content scripts in the MAIN world at `document_start`, all frames. The `js` list is the load order: `lib/wasmpatch.js`, `loader.js`, then the mods. |
| `lib/wasmpatch.js` | A small wasm binary editor: finds a lifted game function by its x86 address, puts instructions at its start. |
| `loader.js` | Memory and module capture, the camera hook, `mem`/`game`/`v3`/`camera` helpers, calibration, mods, options, hotkeys, panel, `scan`. |
| `mods/` | `topdown.js`, `drone.js`, `camfinder.js` (a research tool), `template.js` (an example; not in the manifest). |
| `tests/` | `node tests/run.mjs` runs everything; `--panel` also renders the panel in headless Chrome. |

The nfsu2-web source used as the reference sits next to this folder (`../nfsu2-web`, a clone, not part of this
repo). Its `runtime/` comments are where every address and offset here comes from.

## How work gets tested

- **No game here.** Nobody on this machine has `SPEED2.EXE`, so nfsu2-web can't be built or lifted locally. Every
  live test is the user playing nfsu2.xyz and reporting the panel's lines, `[u2ml]` console lines (Console filter
  `u2ml`) and screenshots.
- **Offline:** `node tests/run.mjs` runs the real loader and mods against a fake game (a shared WebAssembly memory
  with a player, car and camera at the game's addresses) and the hook against hand-built wasm modules shaped like
  the game's. Run it after every change. It can't prove anything about the live site.
- **After changing files**, the user reloads the extension (chrome://extensions, the reload arrow) and then the
  game's tab. Both are needed.
- **Console:** F12 is photo mode in the game; DevTools opens from the Chrome menu.

## Proven on the live site (2026-11-16, Chrome on macOS)

- **Memory:** the page itself makes the game's memory, `new WebAssembly.Memory({ initial: 32768, maximum: 65536,
  shared: true })` (2 GB, the heap window), plus a 1-page shared memory first (the site's isolation check). The
  `Memory` proxy catches it. The first attempt saw no wasm calls at all: the page had loaded before Chrome injected
  the reloaded extension. Catching memory from messages was added then; it hasn't been needed since.
- **Module:** compiled once in the page with `WebAssembly.compileStreaming` from `/game.wasm?v=…`. 3 exports, **no
  name section** (names stripped), so functions can't be found by name.
- **Addresses** (from nfsu2-web): flow `0x8654A4` reads 6 in the world; race state 4; mover type 1 while driving;
  car centre at `+0x60` moves as expected; camera eye near the car; FOV 71.5°.
- **Camera layout:** calibration found `kind: 'view'`, `transpose: false` (the perm and sign values weren't
  recorded), error 6.6e-6, saved under `u2ml:camlayout:v1`.
- **Camera finder:** `mover+0x48` is the camera kind per view (views 0 to 4: 2, 4, 1, 0, 5), matching nfsu2-web
  `runtime/cameras.c`. **No per-view tuning values** (height, distance) changed with the view, in the mover, what it
  points to, or `0x780000`–`0x8C0000`. The tuning is presumably a static table indexed by that kind; nobody has
  found it yet.
- **Writing the camera from the page flickers:** the game thread rewrites it every frame. `camera.pump` lessens it
  but doesn't remove it.
- **The hook works:** the address table `g_fn_addr` was found by searching for `0x5C7EC0`. Two windows passed as
  `g_fn_ptr`; the return-address fit test picked one at `247/406 vs 1/406`. With the hook in there's no flicker.
- **Mailbox:** `0xD0F000` is used (no flicker means `mailboxReady()` passed its zero check). Not separately
  confirmed with the `mailbox free` console line.
- **Motion blur:** with a mod camera the picture was blurred until the game's Motion Blur option `0x870CDC` was
  switched off while it shows. Now sharp (confirmed).
- **Rain:** drops went wild until the hook also copied the camera's velocity (`+0x1E0`). The user reported it
  looks good afterwards.
- **Car axes:** the first learning pass matched rows at `car+0x90` and `car+0xD0` (both forward = row 0). nfsu2-web
  `roam_game.c` `car_sane` documents `+0x90`; that's now fixed, and only the forward row is learnt
  (`u2ml:caraxes:v2`).
- **Drone camera:** the user reported it looks good.

## Not yet proven live

- The options panel (0.2.0) and the template mod: tested offline only (`tests/options`, `tests/template`, `--panel`).
- Whether the car shakes on screen at high speed with the drone. Mods run on the page's animation frames; the game
  draws on its own thread at its own rate. Not reported either way.
- When the rain update runs relative to the hook. It works, so presumably after the main view's setup.
- After photo mode with a mod camera on, Motion Blur may stay off (photo mode saves and restores the same flag).

## Decisions (the user's)

- **Chrome only.** No Firefox build planned.
- **Mods work everywhere**, races against other players included. No auto-off in network races. Still keep mods
  away from physics, AI, traffic, network data and saves (MODDING.md says why).
- **An extension, not a userscript:** the site's CSP (`script-src 'self' 'wasm-unsafe-eval'`, `worker-src 'self'`,
  no inline styles) blocks injected `<script>` tags, blob workers and inline styles. MAIN-world content scripts
  aren't affected, recompiling patched wasm is allowed, and styles set through the CSSOM work.
- **Nothing from the game or the site goes in the repo:** no game data, no copies of the site's code or module.
  Credit nfsu2-web (MIT) as the README does.

## How the main pieces work, and why

- **Memory:** guest address == byte offset in the wasm memory (nfsu2-web `runtime/cpu.h`: `g_mem` is 0). The game
  is one exact SPEED2.EXE, so static addresses never move. Allocated objects move between sessions; reach them
  through pointers from fixed addresses.
- **The hook** (`lib/wasmpatch.js` + `loader.js` `compilePatched`): `compileStreaming` is wrapped. The loader reads
  the bytes, finds `g_fn_addr[]` (a sorted run of x86 addresses in the data segments, nfsu2-web
  `runtime/dispatch.c`) and the parallel `g_fn_ptr[]` (function-table indices, checked to be `void(i32)`
  functions), maps x86 `0x5C7EC0` to its wasm function, and prepends: if `[0x832E90] != 0 && [mailbox] == 1`, copy
  the mailbox's ranges into the camera. Several `g_fn_ptr` candidates are told apart by the fit test (a lifted
  function's code holds i32 constants inside its own x86 range: the return addresses it pushes). Any doubt throws,
  and the original module is compiled instead.
- **Mailbox** at `0xD0F000` (between the web build's players arrays at `0xD00000` and the module heaps at
  `0x1000000`). `+0` flag; `+0x10` 0x70 bytes copied to camera `+0x00` (matrix, eye, forward, target with the
  game's padding words); `+0x80` 12 bytes copied to camera `+0x1E0` (velocity). The loader checks
  `0xD0F000`–`0xD10000` is all zero before first use.
- **Why the hook is at `0x5C7EC0`:** it builds each view from its camera, and the main view's setup is the frame's
  first (nfsu2-web `runtime/overrides.c`). Things that read the camera **earlier** in the frame (the game's own
  mover, motion blur, the rain's velocity) still see the game's camera. That's what the blur and rain fixes are
  about, and what a mod should suspect when an effect misbehaves under a mod camera.
- **Calibration:** the 4x4 matrix convention is found by building 192 candidates from the game's own eye and
  target and matching the game's matrix; 30 matching samples in a row.
- **Drone smoothing** is relative to the car, a critically damped spring on the offset. Smoothing the absolute
  position lagged 2v/ω behind: 23 m at 72 km/h in the first version.
- **Panel:** controls stop key events from reaching the game (window capture listeners registered first), and give
  focus back on change, or arrow keys would move sliders instead of steering.
- **Headless panel test:** Chrome's virtual time runs animation frames late, so the check runs on frames and the
  budget is 15 s.

## Conventions

- Plain JS, no build step, no dependencies. Every file must pass `node --check`.
- Each mod is an IIFE or a single `U2ML.register` call; ids never change (saved values are keyed by them).
- Everything saved goes in `localStorage` under `u2ml:`; a saved key's format never changes without a new suffix
  (`:v2`).
- Comments cite the nfsu2-web file an address comes from.
- Player-facing text (README, panel) in plain words.

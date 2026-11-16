# U2 Mod Loader: notes for working on it

A Chrome MV3 extension that injects client-side mods into the browser NFS Underground 2 at nfsu2.xyz (built from
[nfsu2-web](https://github.com/th0mk/nfsu2-web), which is archived; nfsu2.xyz is developed privately). Player
docs: [README.md](README.md). Mod author docs: [MODDING.md](MODDING.md). What's next: [ROADMAP.md](ROADMAP.md).

## Layout

| Path | What |
|---|---|
| `manifest.json` | Content scripts in the MAIN world at `document_start`, all frames. The `js` list is the load order: `lib/wasmpatch.js`, `loader.js`, then the mods. |
| `lib/wasmpatch.js` | A small wasm binary editor: finds lifted game functions by their x86 addresses, puts hook instructions at their start (notify, capture, write, skip). A write's target: a fixed address, a pointer, a register, or one the page sets in the slot (`{ page: true }`, the buffer's first word). |
| `loader.js` | Memory and module capture, the hook system (patching, slots, guard, handles) with the camera as its own write hook, `mem`/`game`/`v3`/`camera` helpers, calibration, mods, options, hotkeys, panel, `scan`. |
| `mods/` | `topdown.js`, `drone.js`, `rev.js` (Z held at a standstill: car `+0x434` gear held in neutral; writes the gear, an exception to the no-physics rule the user asked for), `camfinder.js` (a research tool), `hookprobe.js` (a tool to check hooks live), `template.js` (an example; not in the manifest). |
| `tests/` | `node tests/run.mjs` runs everything; `--panel` also renders the panel in headless Chrome (flaky about 1 run in 5, from before 0.3.0: rerun). `fakegame.mjs` builds the game-shaped wasm module the hook tests use. |

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
- **Mailbox (0.2.0):** `0xD0F000` was used (no flicker means the zero check passed). 0.3.0 moved it: see below.
- **Motion blur:** with a mod camera the picture was blurred until the game's Motion Blur option `0x870CDC` was
  switched off while it shows. Now sharp (confirmed).
- **Rain:** drops went wild until the hook also copied the camera's velocity (`+0x1E0`). The user reported it
  looks good afterwards.
- **Car axes:** the first learning pass matched rows at `car+0x90` and `car+0xD0` (both forward = row 0). nfsu2-web
  `roam_game.c` `car_sane` documents `+0x90`; that's now fixed, and only the forward row is learnt
  (`u2ml:caraxes:v2`).
- **Drone camera:** the user reported it looks good.
- **Hook system (0.3.0), first test:** `hooks 4 in`. Notify and capture on `0x5C7EC0` work: ~1180 view setups/s
  at ~115 game frames/s, views 0, 1, 4, 9 (headlights) and 16–21 (cube map faces) each once a frame, no 3 (the
  mirror) with top-down on. The captured `[esp+4]` is exactly eView `0x832DE0 + id·0x70` (view 21 at
  `0x833710`), ecx `0x874B20`, every return address in the game's code. Notify at GameLoop `0x5811C0` counted 0:
  GameLoop is the loop itself, entered once and never returning; it calls the empty `0x4022C0` (~300 callers)
  once a frame, returning to `0x581475` (nfsu2-web `runtime/career.c`).
- **Game-frame mods (0.4.0):** `frames screen 120/s game 120/s`, `hooks 5 in`. A frame makes its views in the
  order 0, 1, 4, 9, 16–21 (view 0 comes before the main view 1). The probe ran before any of the frame's views
  in 93% of 121 frames; late: 1 after 4 views, 8 after all 10 (the page ran after the whole frame). On a late
  frame a camera mod's camera from the frame before still shows (the write hook keeps its buffer). The drone on
  the game's frames felt slightly less jittery than on the screen's (user), so the cameras now default to
  `runOn: 'game'`. Some jitter is left: see `mods/TODO.md`. Top-down on the game's frames: looks great (user).
- **Game events (0.5.0), third test:** every event fired: `flow`, `enterWorld`/`leaveWorld`, `countdown`,
  `raceStart`, `pause`/`resume` (the world's clock `0x86518C` standing 4 frames; also around restarts from the
  pause menu), `carPlaced` 3 times in each load (the grid; matched by position), `carReset` on R, `photoMode` on
  and off (from the pause menu's Photo Mode; leaving it lands in the pause menu, so a `pause` follows), `lap` 2/2
  and `finish` (position 1 of 4, clock 153.7 s).
- **Race readings (0.5.0 tests):** the player is at `0xD10000` (`[0xD00000]`) and `[player + 4]` = `0xD11000`, past
  nfsu2-web's `0xD0F900`: the private site uses more of that region. The race status's entries (`G_RACE` +0x30,
  discord.c offsets: laps `+9`, position `+0xA` work) point to other car objects (heap, `0xA4829B0`, a World list
  node at `+4`) whose `+0x60` equals the player's position exactly, so discord.c's `owner == [player + 4]` match
  fails here. Race state is 4 while paused (not 6). `0x865154` (world dt) read 0 even while racing. R writes car
  `+0x974` (0 → 63500) but doesn't call `Car::SetPosition` `0x5FBD60` (78 calls during the load only).
- **Hook system, second test:** notify at `0x4022C0` with `ret: 0x581475` counts 117/s = the game's frame rate,
  and `Atomics.waitAsync` woke the page 117/s: the page can follow the game's frames. The drone camera through
  the `u2ml.camera` write hook at `0xFF0000` is flicker-free (user confirmed). Not exercised live yet: write hooks
  from a mod, skip, `{ reg }` targets, the guard tripping.

## Not yet proven live

- **Game events, the last fixes:** no `pause` before the world's clock first moves (one fired as a world loaded
  in), `photoMode` before `pause`. The race entry kept once found and laps against the last known didn't help:
- **`lap`/`finish` unreliable (parked, ROADMAP "Loader infrastructure").** A monitor of `game.race()` every 2 s:
  in a career race `laps` null for ~18 s stretches (car `0`), found again after; in a Quick Race always
  `pl 0, car 0, n 1` (track 4012, `human` 0). So `[0xD00000]` (`game.player()`) reads 0 at times, and the race
  lookup needs `game.car()`. Not known: whether the cameras work in a Quick Race (same pointer).


- Whether small functions are inlined into their callers in the site's build (then a hook there misses those
  calls). The 0.2.0 camera hook at `0x5C7EC0` did catch the main view's call.
- The options panel (0.2.0) and the template mod: tested offline only (`tests/options`, `tests/template`, `--panel`).
- Whether the car shakes on screen at high speed with the drone. Mods run on the page's animation frames; the game
  draws on its own thread at its own rate. Not reported either way.
- When the rain update runs relative to the hook. It works, so presumably after the main view's setup.
- **Free rev (`mods/rev.js`).** Test 1 (page writes to car `+0x434` once a game frame): HUD gear flashing N/1,
  revs ~2000 at times. Test 2 (also `{ page: true }` write hooks at `0x594300` and `0x5AA480`, both in): HUD shows
  N (orange, grey on the throttle), the car doesn't move, the engine stays at 1000 rpm. Both car objects
  (`0x9015960` the race's, `0xD11000` `game.car()`) got neutral, but `0x594300` ran ~160 times a frame (67334
  writes in 418 frames), every captured call with `ecx = 0x934B0B0`, neither car object: the engine keeps its own
  gear. Tests 3-4: no word or byte of that object follows the car's gear (both car objects' `+0x434` went R to
  5th while driving; a first short drive had shown only R and first). So the engine's own neutral revving wasn't
  found. Test 5 **works** (user, 2026-11-16: the engine revs with Z held at a standstill): neutral holds the car still (gear hooks as in test 2), and the mod makes
  the rpm itself (throttle up to the car type's redline, `[car + 0x10] + 0x10` `+0x228`, mprace.c; a limiter
  bounce), written to both car objects' `+0x440` by write hooks at the engine step, the sound update `0x483B40`
  (framerate.c F4) and the sound's rpm scaling `0x484C50` (roam_game.c), so the game's engine sound plays it.
  The first live use of mod write hooks and of `{ page: true }` targets. Not known: which of the three rpm hooks
  the sound needs, whether the tach follows, whether friends in free roam hear it.
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
- **Hooks** (`lib/wasmpatch.js` + `loader.js` `compilePatched`): `compileStreaming` is wrapped. The loader reads
  the bytes, finds `g_fn_addr[]` (a sorted run of x86 addresses in the data segments, nfsu2-web
  `runtime/dispatch.c`) by the anchor `0x5C7EC0`, and the parallel `g_fn_ptr[]` (function-table indices, checked
  to be `void(i32)` functions). Each hook's address is looked up in `g_fn_addr` (binary search), and all hooks go
  in in one rewrite of the code section, each touched function getting two scratch i32 locals. Several
  `g_fn_ptr` candidates are told apart by the fit test (a lifted function's code holds i32 constants inside its
  own x86 range: the return addresses it pushes). A table doubt throws and the original module is compiled; a
  hook at a wrong address fails alone. Mods declare hooks in `register`, which runs at `document_start`, before
  the page compiles the module; later ones are `too late`.
- **Registers at a function's entry are current in the CPU struct**, LREGS builds included: `tools/lregs.py`
  stores them before every call and tail jump, and `LR_ENTER` (`runtime/cpu.h`) reads them from the struct. Flags
  are stored only when the callee reads them, so capture leaves them out. `eip` isn't maintained at entry.
- **Hook slots** from `0xFF0000` (to `0x1000000`, the module heaps; nfsu2-web's scratch grows up from `0xD00000`
  and ends at `0xD0F900`). **`0xD0F000` is co-op's player 2 ride** (`runtime/coop.c` `COOP_RIDE`, 0x900 bytes):
  0.2.0's mailbox there would have copied ride bytes into the camera in co-op. A slot: `+0` on (the hooks act only
  on the magic `ON` value, not on any nonzero word), `+4` the call count (atomic), `+8` a write's current buffer
  or a skip's eax, `+16` a capture's ring (`[seq, 9 registers, ret, args]`, seq `2n+2` once call n is written)
  or a write's two buffers (the page fills the back one, flips `+8`, copies front to back). The guard
  (`hooksTick`): each frame every slot's `+0`/`+8`/`+12` must hold what the page wrote, and every 250 ms the
  unused rest of the area must be zero; otherwise every hook goes off for good and nothing more is written.
- **The camera hook** is the loader's own write hook `u2ml.camera` at `0x5C7EC0`: to `{ ptr: 0x832E90 }`, ranges
  camera `+0x00` 0x70 bytes (matrix, eye, forward, target with the game's padding words) and `+0x1E0` 12 bytes
  (velocity). `cam.set` fills and commits it; a frame with no camera written turns it off.
- **Why the camera hook is at `0x5C7EC0`:** it builds each view from its camera, and the main view's setup is the frame's
  first (nfsu2-web `runtime/overrides.c`). Things that read the camera **earlier** in the frame (the game's own
  mover, motion blur, the rain's velocity) still see the game's camera. That's what the blur and rain fixes are
  about, and what a mod should suspect when an effect misbehaves under a mod camera.
- **Calibration:** the 4x4 matrix convention is found by building 192 candidates from the game's own eye and
  target and matching the game's matrix; 30 matching samples in a row.
- **Drone smoothing** is relative to the car, a critically damped spring on the offset. Smoothing the absolute
  position lagged 2v/ω behind: 23 m at 72 km/h in the first version.
- **The frames** (`loader.js` "the frames"): two loops call `runMods`: the screen's (`requestAnimationFrame`, also
  hooks guard, calibration, car axes, panel) and the game's (`gameLoop`, waits on `u2ml.frame`'s count with the
  last count seen, so a frame that came while the page was busy wakes it at once). `loopOf` sends a
  `runOn: 'game'` mod to the game's loop while its frames came in the last 250 ms, else to the screen's.
  The camera belongs to the loop whose mods wrote it (`cam.writer`); the other loop leaves it alone, except the
  screen's takes it back when the game's frames stopped.
- **Events** (`loader.js` "game events"): `eventsTick` runs once a frame before the mods (the game loop's while
  it's live, else the screen's) and compares a snapshot (flow, race state, track, laps done, photo) with the last
  frame's; entering the world counts its state as new. `carPlaced`: the loader's capture hook on `0x5FBD60`
  (args 4, keep 16), calls whose `ecx` is `game.car()`, the race's car for the player, or a car at its position. Handlers in `def.on` run while their mod is on;
  `U2ML.on` listeners always.
- **Hooks' shared order:** every hook does an atomic add on the area's first word (`0xFF0000`) and keeps the old
  value at its slot `+12` (captures also in the entry), so the page can tell which of two hooks' calls came
  first (`order()`, `api.after`). Slots start at `0xFF0010`; `+4`..`+15` of the area stay zero (the guard).
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

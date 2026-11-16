# Roadmap

What could turn the loader into a fuller mod platform, in the order planned. Phases 1 (0.3.0) and 2 (0.4.0) are built
and proven on the live site; nothing after them is built yet. To-dos for the mods themselves (not the loader)
are in [mods/TODO.md](mods/TODO.md).
Background on how the existing hook works: [CLAUDE.md](CLAUDE.md).

## The limit everything works around

Hook code can't call into JavaScript. The game's workers build the module's import list, and an extension can't
run code inside workers. So every hook is a few wasm instructions that talk to the page through shared memory.

## 1. A general hook system (first; the rest depends on it): built in 0.3.0, proven live

As built: [MODDING.md](MODDING.md#hooks-running-at-the-games-own-moments) for mods, [CLAUDE.md](CLAUDE.md) for how.
The LREGS check came out fine (registers are current at entry). The slots moved to `0xFF0000`: `0xD0F000` is
co-op's. What was planned:


Mods declare hooks in `register`, for example `hooks: [{ at: 0x5C7EC0, kind: 'notify' }]`. The timing works: mods
register at `document_start`, and the module is compiled later, on the start page.

A game function's only argument is the CPU state, with the registers at fixed offsets (nfsu2-web
`runtime/cpu.h:138`: eax +0, ecx +4, edx +8, ebx +12, esp +16, ebp +20, esi +24, edi +28, eip +32).

| Kind | What it does | Enables |
|---|---|---|
| notify | Counts a call; `memory.atomic.notify` wakes the page (`Atomics.waitAsync`) | Events |
| capture | Copies registers and the first N stack arguments into a buffer | Seeing `this` and the arguments |
| write | Mailbox → memory behind a flag (today's camera hook, generalised) | Overriding a value at the right moment |
| skip | Returns with a chosen eax, as the function's `ret N` would (see nfsu2-web `cameras.c`'s override) | Switching off a game function |

Also needed: an on/off flag per hook in shared memory; mailbox slots allocated from the free area, each checked
empty; a counter per slot so the page never reads a half-written value; and several mods' prologues on one
function, one after another.

**Check first:** nfsu2-web's LREGS builds keep CPU registers in wasm locals. Confirm the CPU struct is up to date
at a function's entry, or capture hooks would read stale registers.

## 2. Running mods on the game's frame: built in 0.4.0, proven live

Mods with `runOn: 'game'` run once a game frame. Live: they ran before the frame's views in 93% of frames (the
rest after part or all of the frame), and the drone felt steadier, so both cameras run on the game's frames now.
Left for later: the late 7%. A camera that must never be a frame behind would have to be computed in the hook
itself (from the car's position at the view setup), not on the page. What was planned:

A notify hook on GameLoop's once-a-frame call (`0x4022C0` with `ret: 0x581475`; GameLoop `0x5811C0` itself is
entered once and never returns, found in the first live test) lets the loader run `frame` after each game frame,
not each screen refresh. That removes the rate mismatch between the cameras and the game's drawing, and makes frame-exact mods
(telemetry, timing) possible.

## 3. Game events

Notify and capture hooks on functions nfsu2-web names: the race settings `0x4FE9F0` and the race setups listed in
`runtime/cameras.c`; drift events; the car's respawn (`car_rescue` in `roam_game.c`); the pause menu; photo mode
swapping the camera mover. Mods would use `api.on('raceStart', fn)`. Flow changes such as loading can be polled
each frame, no hook needed.

## 4. More camera control (cheap)

Add the field of view (`+0xC4`, u16 binary angle) and near/far clip (`+0xBC`/`+0xC0`) to the hook's ranges: a
zoom for the top-down camera, and no distant scenery cut off from high up. Check the mirror (view 3) and road
reflection (view 4) look right with a mod camera.

## 5. Overlay API (page side)

A layer over the game for mods that draw their own HUD: speedometers, telemetry, a minimap. It must work in
fullscreen; the panel already handles moving into the fullscreen element.

## 6. Mod manager

An extension popup to switch mod files on and off, and add new ones without editing the manifest. Chrome's
`userScripts` API injects into the MAIN world past the site's CSP. Settings move to `chrome.storage`.

## 7. Graphics (page side)

The site makes its WebGPU device on the page (nfsu2-web `web/src/gpu/index.ts:189`,
`navigator.gpu.requestAdapter`), so the loader can wrap it and add post-processing passes before each frame is
shown: colour grading, CRT, sharpening, letterboxing. Look at how the site presents frames before designing it.

## 8. Audio and input (page side)

- **Audio:** the sound runs through Web Audio on the page; insert effects (EQ, reverb) or play extra sounds.
- **Input:** wrap `navigator.getGamepads` and keyboard events to read or inject controls.

## Loader infrastructure

- **Site updates:** record the module's `rev` (from `game.json`) with the hook positions found for it. Faster
  loads, and the panel can say when the site's module changed.
- **Safe mode:** hold a key while the page loads to start with no mods and no hooks. Show each mod's errors and
  frame time in the panel.

## Left out on purpose

Hooks on physics, AI, traffic or network data, and editing saves: in online play those change the game for
other players, which is cheating and risks a ban.

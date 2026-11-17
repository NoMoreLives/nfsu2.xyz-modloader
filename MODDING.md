# Writing a mod for the U2 Mod Loader

A mod is one JavaScript file in `mods/` that calls `U2ML.register({...})`. The loader runs it in the game's page,
calls it every frame, and gives it the game's memory, helpers for the car and the camera, hotkeys, saved
settings and a place in the panel.

Start from [mods/template.js](mods/template.js): a small working mod (a speed readout in the panel) that uses
every feature described here.

## Contents

- [Your first mod in five minutes](#your-first-mod-in-five-minutes)
- [The mod definition](#the-mod-definition)
- [The life cycle](#the-life-cycle)
- [Options](#options)
- [The store: saved values](#the-store-saved-values)
- [Hotkeys](#hotkeys)
- [Groups](#groups)
- [The `api` object](#the-api-object)
- [Camera mods](#camera-mods)
- [Drawing over the game: the overlay](#drawing-over-the-game-the-overlay)
- [Game events](#game-events)
- [Hooks: running at the game's own moments](#hooks-running-at-the-games-own-moments)
- [The console](#the-console)
- [Finding new things in memory](#finding-new-things-in-memory)
- [Rules and tips](#rules-and-tips)
- [What the loader can't do (yet)](#what-the-loader-cant-do-yet)

## Your first mod in five minutes

1. Copy `mods/template.js` to `mods/mymod.js`.
2. In the copy, change `id: 'template'` to `id: 'mymod'`, and `name` to what the panel should show.
3. Add the file to `manifest.json`, in the `"js"` list, anywhere after `"loader.js"`:

   ```json
   "js": ["lib/wasmpatch.js", "loader.js", "mods/topdown.js", "mods/drone.js", "mods/camfinder.js", "mods/mymod.js"],
   ```

4. In `chrome://extensions`, click the reload arrow on U2 Mod Loader, then reload the game's tab.
5. Your mod is in the panel (Alt+Shift+M). Tick it to switch it on.

Every time you change the file: reload the extension, then reload the tab. Errors show in Chrome's console
(Chrome menu, More tools, Developer tools, Console; F12 is photo mode in the game). Filter for `u2ml`.

## The mod definition

Everything is optional except `id`.

```js
U2ML.register({
  id: 'mymod',                 // a-z 0-9 _ -, unique. Saved values are kept under it: don't rename it later.
  name: 'My mod',              // shown in the panel (default: the id)
  defaultOn: false,            // on the very first load; after that the player's choice is remembered
  group: 'camera',             // only one mod of a group is on at a time
  options: [ /* ... */ ],      // settings the panel shows under ⚙ (see Options)
  keys: { /* ... */ },         // hotkeys (see Hotkeys)
  hooks: [ /* ... */ ],        // instructions put into the game's functions (see Hooks)
  on: { /* ... */ },           // game events: lap(api, ev, store) {} and so on (see Game events)

  init(api, store) {},                  // once, as the mod loads
  enable(api, store) {},                // each time it's switched on
  disable(api, store) {},               // each time it's switched off
  runOn: 'screen',             // 'game': frame runs once per game frame instead (see The life cycle)
  frame(api, dt, store, info) {},       // every frame while it's on (info.on: 'screen' or 'game')
  draw(api, g, store, info) {},         // every screen frame while it's on: draw your HUD (see the overlay)
  onOption(key, value, api, store) {},  // an option changed
  status(api, store) { return '...' },  // a line in the panel while it's on
});
```

Inside these functions, `this` is the definition object itself, so `this.something = ...` keeps a value between
frames (the top-down camera does this). A variable in a wrapping `(() => { ... })()` works just as well and
keeps it private (the template and the drone do this). Hotkey functions don't get `this`.

## The life cycle

1. The page starts loading. The loader runs, then each mod file in the manifest's order, before any of the
   site's own scripts. **The game hasn't started yet**: don't read its memory in `init`.
2. `init` runs. If the mod was on last time (or `defaultOn` is set the first time), `enable` follows at once.
3. Once the game's memory is caught, `frame` runs on every animation frame (about 60 times a second, at the
   screen's rate) while the mod is on. That includes menus and loading screens, so check where the game is
   (`api.game.inWorld()`, `api.game.driving()`).
4. The player switches the mod off (checkbox, hotkey, or turning on another mod of its group): `disable` runs and
   `frame` stops.

`dt` is the time since the last frame in seconds, at most 0.1. Use it for anything that moves, so the mod behaves
the same at any frame rate.

**The screen's frames or the game's.** The game makes its frames on its own thread at its own rate (often not the
screen's: 117 a second on a 120 Hz screen in one test). With `runOn: 'game'`, `frame` runs once per game frame
instead: the loader's hook on the game's per-frame call (`0x4022C0`, called by GameLoop from `0x581470`) wakes the
page, and the mods run as soon as the page hears of it. The game doesn't wait for them. `dt` is then the real time
between game frames, and `info` is `{ on: 'game', frame, order }` (the game frame's number, and its place on the
hooks' order). While the game's frames don't come (the hook isn't in, or nothing calls it for 250 ms) the mod runs
on the screen's frames, with `info.on` `'screen'`. In the console, `U2ML.runOn('drone', 'game')` moves a mod
(saved), `U2ML.runOn('drone')` says where it runs.

**If `frame` throws an error, the loader switches the mod off** and logs the error. The player can switch it on
again. `init`, `enable`, `disable`, `onOption` and hotkeys that throw are logged but don't switch it off.

## Options

List them in `options`. The panel's ⚙ beside the mod builds a control for each one. Values are saved, and
**reset** puts them back to their defaults.

```js
options: [
  // a slider. The value is kept between min and max and rounded to step.
  { key: 'dist', label: 'Distance', type: 'number', min: 2, max: 80, step: 0.5, default: 11, unit: 'm',
    help: 'shown when the player hovers over the label' },

  // a checkbox
  { key: 'tilt', label: 'Corner tilt', type: 'bool', default: true },

  // a list. value can be a string, number or true/false; anything not in the list falls back to the default.
  { key: 'mode', label: 'Mode', type: 'choice', default: 'calm',
    choices: [{ value: 'calm', label: 'Calm' }, { value: 'wild', label: 'Wild' }] },
],
```

Read them with `store.get('dist')`: the player's value, or `default` if they never changed it. Reading every
frame is fine, and means changes apply at once. `store.all()` gives them all as one object, which is handy at the
top of `frame` (the drone does `const o = store.all()`).

`onOption(key, value)` is called after every change, whether from the panel, a hotkey, **reset** or the console.
You only need it to react to a change once (rebuild something, log it). For values read in `frame` you don't
need it.

A hotkey can change an option with `store.set(key, value)`. The panel's slider follows, and the value is still
kept within range.

## The store: saved values

Each mod gets its own `store`. It is passed to every function above.

| Call | Does |
|---|---|
| `store.get(key)` | The saved value. For an option, its default if nothing is saved. |
| `store.get(key, fallback)` | The same, with your own fallback for keys that aren't options. |
| `store.set(key, value)` | Saves it. An option's value is kept within its range first; returns the value saved. |
| `store.reset()` | Every option back to its default. |
| `store.all()` | Every option's current value: `{ dist: 11, tilt: true, ... }`. |

Keys that aren't options are saved too: the template keeps `trackTop` that way. Values go through
`JSON.stringify`, so stick to numbers, strings, true/false, arrays and plain objects.

Values live in the site's `localStorage` under `u2ml:<id>:<key>`, so they survive reloads and browser restarts,
on this computer only.

## Hotkeys

```js
keys: {
  'Alt+KeyK': (api, store, self) => self.toggle(),             // switch this mod on/off
  'Alt+Equal': (api, store) => store.set('dist', store.get('dist') * 1.2),
  'Ctrl+Shift+Digit1': (api, store, self) => { if (self.on) { /* only while on */ } },
},
```

- The name is the modifiers **in this order**: `Ctrl+`, `Alt+`, `Shift+`, then the key's
  [`code`](https://developer.mozilla.org/docs/Web/API/KeyboardEvent/code): `KeyA` to `KeyZ`, `Digit0` to
  `Digit9`, `Equal`, `Minus`, `BracketLeft`, `BracketRight`, `Comma`, `Period`, `ArrowUp`, `F6` and so on. Codes
  name the physical key, so they work on any keyboard layout.
- `self.toggle()` switches the mod on or off; `self.on` says whether it's on.
- The loader keeps a key it handles away from the game and the site, so the car doesn't also react to it.
- Hotkeys work while the mod is off, so a key can switch it on.
- If two mods have the same key, the one that's on gets it. The two camera mods share `Alt+=` and `Alt+-` this way.
- **Alt+Shift+M** is the loader's own (the panel).
- Don't use keys the game or the site need: plain letters drive the car and open the game's menus, and
  F7–F10 and F12 are the site's own. Alt with a letter is the safe choice. On a Mac, Alt is the Option key.

## Groups

`group: 'camera'` makes the mod one of a set where only one is on at a time: switching one on switches the
others off (their `disable` runs). Both camera mods use `'camera'`. Give any new mod that sets the camera that
group too, or two mods will fight over the camera.

## The `api` object

Every function gets `api`. Mods can also use the global `U2ML`, which has the same pieces (see
[The console](#the-console)).

### `api.mem`: the game's memory

The game's memory addresses are the PC game's own (SPEED2.EXE v1.2): address `0x832E50` in a PC memory map is
`0x832E50` here. Numbers are little-endian, as on a PC.

| Call | Returns |
|---|---|
| `mem.ready` | `true` once the game's memory is caught |
| `mem.u8(a)` `mem.u16(a)` `mem.u32(a)` `mem.i32(a)` | An integer (0 for an address outside memory) |
| `mem.f32(a)` | A float (NaN outside memory) |
| `mem.ptr(a)` | The pointer stored at `a`, or 0 if it points nowhere valid. Use it to follow pointers safely. |
| `mem.vec3(a)` | `[x, y, z]`, three floats |
| `mem.f32s(a, n)` | An array of `n` floats |
| `mem.setU8` `setU16` `setU32` `setF32` `(a, value)` | Writes one value |
| `mem.setVec3(a, [x, y, z])` `mem.setF32s(a, array)` | Writes several floats |
| `mem.ok(a, n)` | Whether `n` bytes at `a` are inside memory (addresses below 0x10000 never are) |
| `mem.hex(a, n)` | A hex dump of `n` bytes, for the console |

Reads and writes outside memory do nothing and never throw, but an address can still be valid memory that holds
something else. Always reach things through pointers you checked (`mem.ptr`) and offsets you trust.

### `api.game`: the game's state

| Call | Returns |
|---|---|
| `game.flow()` | The game's state: 3 front end, 4 or 5 loading, 6 in the world |
| `game.inWorld()` | `flow() === 6` |
| `game.raceState()` | The race's state: 3 countdown, 4 racing (free roam too), 6 paused; -1 none |
| `game.driving()` | In the world, with a car, and the game's own drive camera (not photo mode, a replay or a cutscene) |
| `game.player()` | Player 1's address (0: none) |
| `game.car()` | Player 1's car's address (0: none) |
| `game.carPos()` | The car's centre, `[x, y, z]` in metres; `null` without a car |
| `game.carVel()` | Its velocity, m/s |
| `game.carRows()` | Its orientation, three unit vectors; `null` if they don't look right |
| `game.carForward()` | The unit vector the car's nose points along; `null` until the loader has learnt it |
| `game.moverType()` | The player's camera mover: 1 the drive cameras, 2 photo mode's camera |
| `game.camera()` | The main view's camera's address |
| `game.fovDeg()` | The camera's field of view, degrees |
| `game.ADDR`, `game.OFF` | The addresses and offsets these use |

The game's world has **z up**, and distances are in **metres**. Speed in km/h is `api.v3.len(vel) * 3.6`.

The addresses behind these come from the nfsu2-web repository, mostly `runtime/game.h`, `runtime/look.c`,
`runtime/photo.c` and `runtime/roam_game.c`:

| What | Where |
|---|---|
| Game flow state | `0x8654A4` |
| Race status | pointer at `0x890118`, its state at +0 |
| Player 1 | pointer at `0xD00000` (the browser build's own place, not the PC game's) |
| Player → car / camera mover | +0x4 / +0x238 (the mover's type at +0xC) |
| Car: centre / velocity / orientation rows | +0x60 / +0x70 / +0x90, +0xA0, +0xB0 |
| Main view (eView 1) → camera | pointer at `0x832E50 + 0x40` |
| Camera: matrix / eye / forward / target | +0x00 (16 floats) / +0x40 / +0x50 / +0x60 |
| Camera: field of view | +0xC4 (u16: 65536 is a full turn) |
| Camera: velocity (the rain uses it) | +0x1E0 |
| Motion blur option | `0x870CDC` |
| Player 1's settings: camera view (C key) | `0x83AA64 + 0x10` (0 to 3, 4 the drift camera) |

### `api.v3`: vector maths

Vectors are plain arrays `[x, y, z]`. Every call returns a new array.

`add(a, b)`, `sub(a, b)`, `scale(a, s)`, `dot(a, b)`, `cross(a, b)`, `len(a)`, `norm(a)` (unit length; `[0,0,0]`
for a zero vector), `lerp(a, b, t)`.

### `api.camera`: the camera

| Call | Does |
|---|---|
| `camera.set(eye, target, up, lens)` | Puts this frame's camera at `eye`, looking at `target`. `up` is the picture's up direction (default `[0, 0, 1]`; tilt it for a roll). `lens` (optional): `{ zoom }` times the game's own field of view (2: half the angle) or `{ fov }` in degrees, `near` and `far` planes in m, `minFar` (raise the far plane to at least this, never lower it). What it leaves out stays the game's, and the game's lens comes back when the mod stops. Returns `false` if it can't yet. |
| `camera.layout` | Set once the loader has learnt the camera's matrix layout; `set` needs it |
| `camera.gameCamera()` | The game's own camera this frame (`eye`, `target`, `fwd`, `matrix`), or `null` while the camera shows a mod's |
| `camera.keepBlur` | `true` keeps the game's motion blur on while a mod's camera shows (it's off by default: see below) |
| `camera.recalibrate()` | Forgets the learnt layout; the loader learns it again |

### `api.log`, `api.warn`

Like `console.log` and `console.warn`, with a `[u2ml]` prefix so the console's `u2ml` filter shows them.

### `api.overlay`: drawing over the game

See [Drawing over the game](#drawing-over-the-game-the-overlay).

## Camera mods

A camera mod calls `api.camera.set(eye, target, up)` **in every frame it wants the camera**. When a frame passes
without a call, the game's own camera comes back at once. So the drone just stops calling it when you're not
driving, and the game takes over.

```js
frame(api, dt, store) {
  const { game, camera, v3 } = api;
  if (!game.driving() || !camera.layout) return;          // only while driving, once the layout is known
  const car = game.carPos();
  if (!car) return;
  camera.set(v3.add(car, [0, 0, 30]), car, game.carForward() || [0, 1, 0]);   // 30 m above, looking down
},
```

Here's what the loader does behind `set`:

- **The hook.** The loader adds a few instructions to the game's code as it loads, at the function that builds
  each frame's view (x86 address `0x5C7EC0`). When a mod's camera is ready, that function copies it into the
  game's camera on the game's own thread, at the moment the view is made. That's why there's no flicker. It's the
  loader's own hook, `u2ml.camera` (a write hook, see [Hooks](#hooks-running-at-the-games-own-moments)); the
  panel's `hooks` line says whether it's in.
- **Without the hook** (`u2ml.camera` not in), `set` writes the camera straight from the page. That works, but the game
  rewrites the camera on its own thread every frame, so the picture flickers between the two.
- **The camera's velocity.** `set` works out your camera's velocity from its last place and gives it to the
  game, so the rain and the raindrops on the lens behave.
- **Motion blur.** The game's motion blur goes off while a mod's camera shows and comes back after, as photo mode
  does. The game still moves its own camera each frame before the hook puts yours in, and it would blur the
  picture by that difference. Set `camera.keepBlur = true` to keep the blur on anyway.
- **Timing.** Mods run at the screen's rate in the page, and the game draws at its own rate on its own thread.
  Work out positions from the car's current position each frame (as the cameras here do), not from a guessed
  frame time.

Smooth motion: [mods/drone.js](mods/drone.js) has a critically damped spring (it catches up without
overshooting, and is stable at any frame time) and keeps its smoothing **relative to the car**, so it holds its
distance at any speed. Smoothing the absolute position instead makes the camera fall further behind the faster
you go.

## Drawing over the game: the overlay

The loader keeps a layer of canvases over the whole game window (above the game, below the panel). It follows the
game into fullscreen, as the panel does. Two ways to use it:

**A HUD: `draw`.** Give the mod a `draw(api, g, store, info)`. Every screen frame while the mod is on, the loader
clears the shared HUD canvas and calls each mod's `draw` with its 2D context `g` (a plain
[CanvasRenderingContext2D](https://developer.mozilla.org/docs/Web/API/CanvasRenderingContext2D)), already scaled
so you draw in CSS pixels, saved before and restored after your call. `info` is `{ t, dt, width, height }` (the
window's size in CSS pixels). The HUD never takes the mouse or keys: the game gets them.

```js
draw(api, g, store, { width, height }) {
  const v = api.game.carVel();
  if (!v || !api.game.inWorld()) return;
  g.font = '600 28px system-ui'; g.fillStyle = '#fff'; g.textAlign = 'right';
  g.fillText(`${(api.v3.len(v) * 3.6).toFixed(0)} km/h`, width - 24, height - 24);
},
```

**A screen of your own: `api.overlay.layer(name, opts)`.** Your own canvas, hidden until you show it, drawn by its
`draw` each screen frame while shown. Make it in `init`. [mods/map.js](mods/map.js) uses one for its map.

```js
const layer = api.overlay.layer('mymap', {
  z: 10,                       // above layers with a lower z (the HUD is 0)
  mod: 'mymod',                // hidden while this mod is off, and not drawn then
  interactive: true,           // takes the mouse while shown (the game doesn't see those clicks)
  draw(g, layer, info) { g.fillStyle = 'rgba(0,0,0,.8)'; g.fillRect(0, 0, layer.width, layer.height); },
  keys(e) { if (e.code === 'Escape') { layer.hide(); return true; } return false; },   // true: the key was yours
});
layer.on('pointerdown', e => { /* e.clientX, e.clientY */ });
// later, from a hotkey: layer.toggle()
```

| Layer member | Does |
|---|---|
| `show(on)`, `hide()`, `toggle()`, `shown` | Show or hide it |
| `interactive(on)` | Take the mouse while shown (`true`) or let it through to the game |
| `on(type, fn)` | A mouse or pointer listener (`pointerdown`, `pointermove`, `pointerup`, `wheel`, ...) |
| `begin()` | Clear it and get its context scaled to CSS pixels (the loader does this before its `draw`) |
| `width`, `height`, `dpr` | Its size in CSS pixels, and the device pixel ratio |
| `canvas`, `ctx` | The canvas element and its 2D context (null until the page has a body) |
| `draw`, `keys` | The callbacks from the options; you can set them later |

`keys(e)` gets every key press while the layer is shown (before hotkeys and the game). Return `true` for a key
you used: nobody else sees it, its release included. Return `false` and it goes on as usual, so the player can
still drive with the map open. Alt+Shift+M (the panel) never reaches a layer. In the console,
`U2ML.overlay.layers()` lists the layers.

Draw on screen frames only, and keep it cheap: build anything big (a `Path2D` of a whole road network) once and
reuse it. A `draw` that throws switches its mod off, as `frame` does; a layer's `draw` that throws hides the layer.

**Fullscreen:** if the site ever makes the game's `<canvas>` itself fullscreen (not an element around it), nothing
can show over it, the panel included; the loader warns once in the console.

## Game events

A mod handles the game's events in `on`, while it's on:

```js
U2ML.register({
  id: 'laps',
  on: {
    lap(api, ev) { api.log(`lap ${ev.lap} of ${ev.laps}, ${ev.position}. place, ${ev.clock.toFixed(1)} s`); },
    carPlaced(api, ev) { /* the game moved the car: start any smoothing again */ },
  },
});
```

| Event | When | `ev` has |
|---|---|---|
| `flow` | The game's flow state changes (3 the front end, 4 and 5 loading, 6 the world) | `from`, `to` |
| `enterWorld` / `leaveWorld` | Into the world (a race, free roam) / out of it | `race` (enterWorld) |
| `countdown` | A race's countdown begins | `race` |
| `raceStart` | The countdown is over: go | `race` |
| `pause` / `resume` | The world stands still / moves again (the pause menu; a network race doesn't pause) | |
| `lap` | The player finished a lap. **Unreliable for now:** missed when the loader can't find the player (a known to-do) | `lap` (laps done), `laps`, `position`, `racers`, `clock` (s) |
| `finish` | The player finished the race (after its last `lap`). Unreliable, as `lap` | `position`, `racers`, `clock` |
| `photoMode` | Photo mode on or off | `on` |
| `carPlaced` | The game placed the player's car: the start grid, a jump | `pos`, `speed`, `heading` (degrees) |
| `carReset` | The game reset the car onto the road: R, or a car that fell out of the world | `pos` |

Every `ev` also has `name`, `t` (`performance.now()`), `on` (`'game'` or `'screen'`: which frames saw it) and
`frame` (the game frame's number, on the game's frames).

Most events are changes in the game's state, looked at once a frame just before the mods run: on the game's
frames while they come, else on the screen's. `pause` is the world's clock (`0x86518C`) standing for 4 frames.
`carReset` is a new value at car `+0x974` (the reset's blink). `carPlaced` comes from a hook on the game's
`Car::SetPosition` (`0x5FBD60`). `race` is `api.game.race()`: `{ isRace, track, kind, laps, sprint, drag, drift, state, clock,
racers, lapsDone, position, car }`, or `null` outside the world. Its `car` is the race's object for the player's
car, which isn't `game.car()` on the live site (both hold the same position).

In the console: `U2ML.on('lap', e => console.log(e))` (it returns a function that stops it), `U2ML.events()` for
the last 50, and the panel's `event` line shows the last one. Every event is also logged as `[u2ml] event …`.

## Hooks: running at the game's own moments

A mod's `frame` runs on the page, at the screen's rate. The game runs on its own thread. A **hook** puts a few
instructions at the start of one of the game's functions, so something happens on the game's thread every time
the game calls it: the call is counted, its registers and arguments are copied out, values are copied in, or the
function is skipped.

Hook code can't call your JavaScript (the game's threads are workers the extension can't reach). Each hook talks
to the page through a small slot of shared memory, and your mod reads and writes that slot through a handle.

```js
U2ML.register({
  id: 'mymod',
  hooks: [
    { name: 'frame', at: 0x4022C0, ret: 0x581475, kind: 'notify' },          // once a game frame (GameLoop's call)
    { name: 'view', at: 0x5C7EC0, kind: 'capture', args: 1, keep: 8 },       // the view setup and its eView*
  ],
  frame(api, dt, store) {
    const v = store.hooks.view.read();          // the last call: { call, eax, ecx, ..., ret, args: [eView] }
  },
});
```

### Declaring a hook

| Field | Means |
|---|---|
| `name` | Letters, digits, `_`. The handle is `store.hooks.<name>`. |
| `at` | The x86 address where a game function starts: nfsu2-web calls it `sub_005C7EC0` and so on. |
| `kind` | `notify`, `capture`, `write`, `skip` or `call` (below). |
| `wake` | `true`: each call also wakes the page (`wait()`). The default for `notify`, off for the others. |
| `ret` | Only act on calls that will return to this address (`[esp]` at the call). For a function with many callers: the game's per-frame call is `at: 0x4022C0, ret: 0x581475`. |

| Kind | On each call | More fields |
|---|---|---|
| `notify` | Counts it and wakes the page. | |
| `capture` | Counts it and copies the registers, the return address and the first `args` stack arguments into a ring of `keep` entries. | `args` (0–32), `keep` (a power of 2, up to 256; default 1) |
| `write` | Copies your values into the game's memory at that moment, while your mod has some committed. | `to`: `{ addr }` a fixed address, `{ ptr }` the pointer stored at an address (nothing while it's 0), `{ reg: 'ecx' }` a register at the call, usually `this`, or `{ page: true }` an address your mod sets with `target(addr)` (for an object that moves between sessions, like the player's car). `ranges`: `[[offset, bytes], ...]` from there. |
| `skip` | Returns at once, as the function's own `ret` would, with `eax` set: the game's function doesn't run. | `pop`: the bytes its `ret N` pops (0 for `ret`); `eax`: what it returns. |
| `call` | When your mod asks (`call()`), makes the game call **another** of its functions, `fn`, there and then, on the game's thread; then the hooked function runs as usual. | `fn`: the address of the function to call; `args`: how many stack arguments it takes (0–8). |

On one function, hooks run in the order the mods declared them, and every skip comes last, so the other hooks
still see a skipped call.

### The handle: `store.hooks.<name>`

| Member | Does |
|---|---|
| `state` | `in`, `waiting for the game module`, `failed: …`, `too late: reload the page`, `area busy` |
| `ready` | `true` when it's in and can be used |
| `count()` | Calls counted so far (only while the hook was on) |
| `order()` | Where its last call came on the order all hooks share: of two calls, the later has the higher number. Compare with `api.after(a, b)` (true when a came after b; it allows for the counter wrapping round). |
| `wait(ms)` | A promise that resolves at the next call (or after `ms`) with the count. Needs `wake`. |
| `enable(false)` | Switch the hook off while the mod stays on; `enable()` back on |
| `read()` | capture: the last call, `{ call, order, eax, ecx, edx, ebx, esp, ebp, esi, edi, eip, ret, args }`, or `null` |
| `since(n)` | capture: the calls numbered `n` and later that the ring still holds, oldest first (numbers start at 0) |
| `setF32(off, x)`, `setF32s`, `setVec3`, `setU32`, `setBytes` | write: fill in values, by offset from the target |
| `target(addr)` | write with `to: { page: true }`: the address the ranges count from (0: nowhere); goes to the game with `commit()` |
| `commit()` | write: the values go to the game from its next call on, and stay until `off()` |
| `off()` | write: stop; the game's own values again |
| `result(eax)` | skip: change what the skipped function returns |
| `call(ecx, [args], { timeout })` | call: a promise of what `fn` returned (`eax`, unsigned), or `null` if the game didn't make the call within `timeout` ms (default 3000; the request is then taken back) |
| `pending` | call: requests not finished yet |

The hooks of a mod that is off do nothing; they come on with the mod. A write hook also needs a `commit()`.

### Things to know

- **Declare hooks in the file, not later.** The loader puts hooks in as the page compiles the game, soon after
  the mods load. A hook declared after that says `too late: reload the page`. Changing a mod's hooks needs the
  extension reloaded and then the game's tab.
- **The registers are the game's own at the call.** `ecx` is `this` for the game's C++ methods; the stack
  arguments are at `esp + 4` on (`args[0]` is `[esp + 4]`, `ret` is `[esp]`). nfsu2-web's comments say which
  functions take what (`__thiscall(ecx = ..., [esp+4] = ...)`, `ret 0x10`). `eip` isn't kept up to date by the
  game at a function's start; ignore it. Flags aren't captured.
- **Skip carefully.** Only skip a function whose job you understand and whose callers only need `eax` back. Get
  `pop` right (the `ret N` in nfsu2-web's notes): a wrong value breaks the game's stack and crashes it.
- **A hook costs a little on every call.** A function called thousands of times a frame is better counted than
  woken: leave `wake` off there.
- **If `count()` stays 0** while the function should be running: it may have been called once, before your hook
  was on, and never return (GameLoop `0x5811C0` is like that: it is the loop). Or the game reaches that code some
  other way (a small function copied into its callers by the compiler, for one). Try a function it calls.
- **The hook area** is `0xFF0000`–`0x1000000`. The loader checks every frame that nothing else writes there; if
  something does, every hook goes off until the page reloads (`area busy`).
- **Not on physics, AI, traffic, network data or saves**, for the same reasons as everything else here (see
  Rules and tips).
- [mods/hookprobe.js](mods/hookprobe.js) is a short working example of notify, capture and `wait`.

### Calling the game's own functions

A `call` hook asks the game to run one of its functions for you, between two of its frames, the way nfsu2-web's
own code does (`runtime/guest.h` `guest_call_ex`, from its once-a-frame hook). Put it on the per-frame call:

```js
hooks: [{ name: 'apOn', at: 0x4022C0, ret: 0x581475, kind: 'call', fn: 0x5FAE20 }],   // Player::AutoPilotOn(this)
// later:
const eax = await store.hooks.apOn.call(api.game.player());      // ecx = this; stack arguments: call(ecx, [a, b])
```

At GameLoop's next call of `0x4022C0` the hook keeps the registers, makes a stack 256 bytes below the current
one, pushes your arguments and a return address (`ret`, here GameLoop's `0x581475`: some functions look at their
caller's), sets `ecx`, runs `fn`, keeps `eax` and puts every register back. Any calling convention works
(`thiscall`, `stdcall`, `cdecl`): the stack pointer is put back whatever the function pops. Requests run one per
frame, in order. The hook is on only while a request is out, so it costs nothing otherwise, and a mod's `disable`
can still call (to undo something it started).

Only call a function whose job and arguments nfsu2-web documents, at a moment it can run (the per-frame call is
between frames, where nfsu2-web itself calls the game). A wrong argument there crashes the game, as a wrong `pop`
does for a skip.

## The console

The global `U2ML` is there for experiments in Chrome's console.

| Call | Does |
|---|---|
| `U2ML.status()` | Memory caught? Hooks in? Driving? Layout known? |
| `U2ML.hooks()` | Every hook: its mod, address, kind, state, calls (as a table) |
| `U2ML.frames()` | The screen's frame rate and the game's |
| `U2ML.on('lap', fn)` / `U2ML.events()` | Listen to a game event / the last 50 events |
| `U2ML.runOn('drone', 'game')` | Run a mod on the game's frames (`'screen'`: back); saved |
| `U2ML.mods` | The loaded mods (a `Map` by id); `U2ML.mods.get('drone').def` is the drone's definition |
| `U2ML.setEnabled('drone', true)` | Switch a mod on or off |
| `U2ML.options('drone')` | A mod's option values |
| `U2ML.options('drone', 'dist', 15)` | Set one (kept within range, saved, panel updated) |
| `U2ML.mem.f32(0x8654a4)` and so on | The memory calls above |
| `U2ML.game.carPos()` and so on | The game calls above |
| `U2ML.scan.f32(value, tolerance)` | Every float near `value` (default range: the game's own data, `0x400000`–`0x1000000`; pass `lo, hi` after the tolerance for others) |
| `U2ML.scan.u32(value)` | Every 32-bit integer equal to `value` |
| `U2ML.scan.next(x => x > 10)` | Keeps the last scan's hits whose value now passes the test |
| `U2ML.scan.changed()` / `U2ML.scan.same()` | Keeps the hits that changed / stayed the same since the last scan |

Chrome's `copy(...)` puts any result on the clipboard: `copy(U2ML.options('drone'))`.

## Finding new things in memory

1. **Look in the nfsu2-web source first.** Its `runtime/` folder has the game's addresses and struct offsets,
   with comments on what they mean and how they were measured. `runtime/game.h` is the index. Everything listed
   above came from there. Search it for a word (`grep -rn -i "headlight" runtime/`).
2. **Scan for a value you can see change**, like Cheat Engine: `U2ML.scan.f32(55, 1)` with 55 on the speedometer,
   then drive at another speed and `U2ML.scan.next(x => Math.abs(x - 80) < 1)`, until a few hits are left. Then
   read them while you play to check.
3. **Compare states.** [mods/camfinder.js](mods/camfinder.js) watches a set of memory regions and lists the values
   that are constant in each camera view but differ between views. Copy its approach for anything with a few
   distinct states.

The game's code is the same in every copy (it only runs one exact version of SPEED2.EXE), so an address you find
stays valid. Memory the game allocates (cars, cameras) moves between sessions, so reach those through a pointer
from a fixed address, as `game.car()` does.

## Rules and tips

- **Check before you write.** Read through `mem.ptr` and check what you get is sane (finite numbers, a plausible
  range) before writing anything. A wrong write can crash the game or, worse, corrupt a save.
- **Don't touch saves or progress.** Stick to what's drawn and heard. Leave money, the career, parts and anything
  the game saves alone.
- **Leave things as you found them.** If a mod changes a setting of the game's (the way the cameras change motion
  blur), save the old value in `enable` and put it back in `disable`.
- **Keep `frame` light.** It runs 60+ times a second. Read what you need; don't scan memory or build big objects
  every frame.
- **Stay in your own space.** Wrap the file in `(() => { ... })()` and keep state there or on `this`. Every mod
  shares the page.
- **Test offline too.** `node tests/run.mjs` (Node 20 or newer) runs the loader and the mods against a fake game.
  `tests/template.test.mjs` is a short example of testing a mod that way: a fake car, a few frames, then check
  what the mod did.
- **Online play.** Your mods run only on your screen. Other players see nothing of them, but a camera mod gives
  you a view of the road they don't have in a race.

## What the loader can't do (yet)

- **Hook the middle of a function.** Hooks go at a function's start only.
- **Other browsers.** Chrome and other Chromium browsers only.
- **Player 2.** The helpers cover player 1 only (split screen's second player isn't handled).
- **Load mods without the manifest.** A mod has to be listed in `manifest.json` and the extension reloaded.

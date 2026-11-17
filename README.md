# U2 Mod Loader

A Chrome extension that loads client-side mods into the browser version of *Need for Speed: Underground 2*
([nfsu2.xyz](https://nfsu2.xyz), or your own server built from
[nfsu2-web](https://github.com/th0mk/nfsu2-web)). The site stays unchanged: the mods run only in your browser.

It comes with:

| Mod | What it does |
|---|---|
| **Top-down camera** | Looks straight down at your car from above. |
| **Drone camera** | Flies behind and above your car, swings round in turns, tilts into corners. |
| **Free rev** | Hold Z while stopped and press the accelerator: the engine revs and the car stays put. |
| **Map & autopilot** | A map of the city's roads: click to set a waypoint and see the route there. The autopilot (the game's AI driving you there) is switched off for now: it crashed the game. |
| **Camera finder (tool)** | A research tool: finds values in memory that change with the camera view. Not needed to play. |
| **Hook probe (tool)** | A test tool: shows that the loader's hooks work (how often the game's main loop and view setup run). Not needed to play. |

A fan project. Not affiliated with Electronic Arts or with nfsu2.xyz.

## What you need

- **Google Chrome** (or another Chromium browser: Edge, Brave). Firefox and Safari aren't supported.
- The game working at nfsu2.xyz in that browser.

## Install

1. Put the `u2-modloader` folder somewhere it can stay. Chrome loads the extension from it each time it starts,
   so don't delete or move it afterwards.
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and pick the `u2-modloader` folder (the one with `manifest.json` in it).
5. **U2 Mod Loader** shows up in the list. Leave it on.
6. Open nfsu2.xyz, or reload it if it was already open.

A dark panel appears in the top-left corner: **U2 Mod Loader**. That means it's working.

## The first time in the game

Press **Play** and drive. The loader works out two things by itself, once, and remembers them:

1. **The camera's layout.** Drive for about a second with the game's normal camera. The panel's `camera` line
   changes from `learning` to `layout known`.
2. **Which way your car points.** Drive straight at 20 km/h or more for a few seconds. The `car fwd` line
   fills in with numbers.

After that, the camera mods work.

### What the panel says

| Line | Good | If not |
|---|---|---|
| `memory` | a size, e.g. `2048 MB` | `not caught`: see [Problems](#problems) |
| `frames` | `screen 120/s  game 117/s` | `game no hook` or `game waiting`: mods meant for the game's frames run on the screen's |
| `event` | the last game event, e.g. `lap 1/3, 4 s ago` | `-` until something happens |
| `hooks` | `6 in` (a number) | `failed: …` or `not in: …`: the camera mods still work but may flicker. See [Problems](#problems) |
| `flow` | `6` and `driving yes` while you drive | `driving no` in menus, photo mode and replays is normal |
| `camera` | `layout known` | `learning`: drive with the normal camera for a moment |
| `car fwd` | three numbers | `learning`: drive straight, 20 km/h or more |

## Using it

| Key | Does |
|---|---|
| **Alt+Shift+M** | Show or hide the panel |
| **Alt+T** | Top-down camera on or off |
| **Alt+D** | Drone camera on or off |
| **Alt+N** | The map on or off |
| **Alt+P** | Autopilot (switched off for now: it says why) |

On a Mac, **Alt** is the **Option** key. Only one camera mod is on at a time: turning one on turns the other off.
The camera mods only take over while you drive. In menus, photo mode and replays you see the game's own camera.

**Top-down camera**

| Key | Does |
|---|---|
| Alt+= / Alt+- | Higher / lower |
| Alt+R | The picture turns with the car, or north stays up |

**Drone camera**

| Key | Does |
|---|---|
| Alt+= / Alt+- | Farther / closer |
| Alt+] / Alt+[ | Fly round the car, 45° at a time (side and front views) |
| Alt+0 | All its settings back to the defaults |
| Alt+B | Corner tilt on / off |

**Free rev**

| Key | Does |
|---|---|
| Hold Z, then accelerate | Revs the engine while the car stands still (the gearbox is held in neutral). Let go of Z to drive off. |

The revs are the game's own engine sound, climbing with the throttle to a limiter at the car's redline (the
Redline setting under ⚙ is used if the car's can't be read).

While the mod is on, Z doesn't reach the site in the world (its Z is "Invite to a race"): switch the mod off in the
panel to invite with Z. Typing in chat isn't affected. Not during a race's countdown, where the game lets you rev
anyway.

**Map & autopilot**

| On the map (Alt+N) | Does |
|---|---|
| Click a road | Sets the waypoint there (it's kept for next time) |
| Right-click | Clears the waypoint |
| Drag / mouse wheel | Moves / zooms the map |
| C | Centres the map on your car |
| Esc or Alt+N | Closes the map |

The map is drawn from the roads the game's traffic drives on, so it has no buildings or names, only streets. The
orange line is the shortest way there by road. While a waypoint is set, a small map in the bottom-right corner
turns with your car and shows the route and how far it is. The game keeps running while the map is open, and your
driving keys still work.

**Alt+P, the autopilot, is switched off for now.** It hands your car to the game's own AI driver, and in the first
test the game crashed a moment later: in free roam the game's AI has nothing to drive towards, and it fails
without one. Alt+P only says so until that's solved.

### Settings

Click **⚙** next to a mod in the panel to show its settings: distance, height, how stiffly the drone follows, and
so on. Hover over a setting's name to see what it does. Changes apply at once and are saved. **reset** puts that
mod's settings back to the defaults.

Clicking a mod's checkbox turns it on or off, just like its key.

For a clean picture, hide the game's HUD with **F10** and the panel with **Alt+Shift+M**.

## Update

After changing or replacing any file in the folder:

1. In `chrome://extensions`, click the **reload arrow** on U2 Mod Loader.
2. Reload the nfsu2.xyz tab.

Both are needed: the tab keeps the old version until it reloads.

## Problems

Most answers are in Chrome's console: open the Chrome menu, then **More tools**, then **Developer tools**, then
the **Console** tab, and type `u2ml` in its filter box. (F12 doesn't open it here: in the game, F12 is photo mode.)

| What you see | What to do |
|---|---|
| No panel at all | Check the extension is on in `chrome://extensions`, then reload the game's tab. |
| `memory not caught` after pressing Play | Click the reload arrow on the extension, then reload the game's tab. |
| `hooks failed: …` | The site's game module changed in a way the loader didn't expect. The game runs unchanged and the camera mods fall back to a mode that flickers. Copy the `[u2ml]` warning from the console and report it. |
| `hooks off: something else uses the hook area` | The game now uses the memory the hooks need. Same as above: report it. |
| `camera learning` never finishes | Drive with the normal camera (not photo mode). After 300 frames the console prints what it found: report that. |
| The game crashes or freezes with the hooks in | In the console type `localStorage['u2ml:patch'] = 'false'` and reload. That turns the hooks off. Report the console's errors. |
| The picture looks blurrier when you turn a camera mod off | The camera mods turn the game's motion blur off while they show and back on afterwards. If it stays off (rare, after photo mode), set Motion Blur again in the game's Display options. |
| Settings went wrong | Click **reset** under that mod's ⚙, or press Alt+0 for the drone. |

To clear everything the loader has saved (settings, what it learnt, the panel's state), type this in the console
and reload:

```js
Object.keys(localStorage).filter(k => k.startsWith('u2ml:')).forEach(k => localStorage.removeItem(k))
```

## Turn it off or remove it

- **Off for a while:** switch it off in `chrome://extensions` and reload the game.
- **Remove:** click **Remove** in `chrome://extensions`. Its saved settings stay in the site's storage until you
  clear them with the line above.

## How it works, briefly

- **Runs first.** The extension runs inside the game's page, before the site's own scripts.
- **Reaches the game's memory.** The game is the PC game's code translated to WebAssembly, and its memory
  addresses are the PC game's own. The loader catches that memory as the page creates it, so mods can read and
  change it.
- **Hooks the camera.** For the camera mods, the loader changes the game's code slightly as it loads (mods can
  ask for such hooks too). The function that builds each frame's view first copies in the mod's camera when one
  is ready. Without this, the
  game and the mod would fight over the camera every frame and the picture would flicker. If anything about this
  doesn't check out, the loader leaves the game unchanged.
- **Draws over the game.** Mods can draw their own HUD and screens (the map) on a layer over the game.
- **Learns, then remembers.** It works out the camera's layout and the car's heading by watching the game, and
  saves them.

Writing your own mod: see [MODDING.md](MODDING.md) and the example [mods/template.js](mods/template.js).

## Credits

Built on what the [nfsu2-web](https://github.com/th0mk/nfsu2-web) project (MIT) documents about the game's
memory, and through it NFSU2Recomp and the mods it credits. *Need for Speed* and *Need for Speed: Underground 2*
are trademarks of Electronic Arts Inc.

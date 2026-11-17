# Mods: to do

For the mods in this folder, not the loader (the loader's plans are in [../ROADMAP.md](../ROADMAP.md)).

## Drone camera

- **Some jitter is left.** On the screen's frames the drone was a bit jittery; on the game's frames (0.4.0,
  `runOn: 'game'`, now its default) it's a bit less so, but not gone (user, 2026-11-16, 120 Hz screen, game at
  120 frames/s). Things to look at:
  - Late frames: in about 7% of game frames the page ran after the frame's views were made, so that frame shows
    the camera from the frame before. The Hook probe's `ran` line shows how often.
  - The spring's own motion: whether the jitter is in the camera's offset from the car (the smoothing) or in the
    car's position as read (the frame it's read in).
  - The aim (target) smoothing and the corner tilt, each switched off in turn, to see which one shakes.

## Map & autopilot (0.7.0)

- **First live test (2026-11-17): the game crashed after Alt+P.** The call hook worked (driver kind 1 → 3), but
  the brain's goal (`+0x6FC`) was 0 and the game's thread trapped soon after (CLAUDE.md). Alt+P refuses now.
  **Next: find how the game gives an AI brain a goal in free roam**, and give the player's car's brain one before
  AutoPilotOn (or make AutoPilotOn's own path give it one). Leads: `0x42CD60` (roam.c, from `0x42EFB0` at a
  race's end) gives every out car of the World's AI range a new goal through its brain and keeps it at
  `+0x6FC`; the outrun challengers cruise the city on goals. Reading the site's lifted module locally (the
  address tables map wasm functions to x86 addresses; never into the repo) would show what `0x42CD60` calls and
  what the AI update reads, and map the trap's wasm offsets to game functions.
- **The rest of the first test, still to do** (the user): reload, drive in free roam, Alt+N. Report the panel's `map` line (road points),
  whether the drawn roads look like the city (a screenshot), and whether a click sets a waypoint with a route.
  Also open the game's own World Map (M), pick any place, start its GPS, and copy the `map: the game's GPS started
  (0x529480)` line.
- **Then, depending on where the AI drove:**
  - **Towards the GPS's route:** set the game's GPS to the waypoint with a call hook on `0x529480`, with the
    arguments the probe showed (a stand-in trigger as nfsu2-web roam_game.c `meet_trigger` builds: 0x40 bytes,
    `+4`/`+8` its middle, `+0x20` its box, `+0x34` the GPS's target in whole metres), then AutoPilotOn.
  - **At random or nowhere:** look at the car's brain (`car+0x2C`) and its goal (`brain+0x6FC`, roam.c
    `roam_game_goals`), which the samples log: the outrun challengers drive around the city by goals, so a goal
    with a target position may exist. A capture on the goal's vtable functions while an outrun tuner cruises.
  - **Crashes or hangs:** the call hook itself (see CLAUDE.md, what could go wrong), or AutoPilotOn's state
    outside a race. Turn the mod off in the panel, reload.
- **The map:** roads only (no names, no buildings). One-way streets aren't known (edges both ways). The route
  ignores the career's red walls (walls.c's barrier lines `0x88F298 +0x498`): a route through a closed area
  would need them.

## Crash cam (new mod, not started)

A key that starts the game's slow-motion crash view, as if another player hit the car from behind. Free roam only.

- **What's known** (nfsu2-web `runtime/roam_game.c`, the comment before `G_CRASH_VIEW`, ~line 11423):
  - The crash view is a player mode: `game.player()` (`[0xD00000]`) `+0x58` reads 6 while it shows.
  - Something at `0x6022E0` starts mode 6, probably a function (not confirmed).
  - The game starts it only inside its collision code (`0x5AF0E0` → `0x5A9620` → `0x59FB70`), when the hit on the
    player's car (capped first at the float at `0x7A1858`, 40) reaches the float at
    `0x7A1864` (30). Free roam raises that for hits from other players' cars: about 155 km/h of closing speed.
- **Anticheat:** a crash view with no push is a camera and slow motion on this screen only, which the server's
  checks never see (they watch the car's place and speed). A small shove from behind looks like an ordinary bump;
  keep it far from 450 km/h and from anything like a jump.
- **Why it needs loader work:** hooks can't call game functions (only notify, capture, write, skip). Writing 6 to
  `+0x58` alone probably skips the camera and slow-motion setup that `0x6022E0` likely does, and lowering
  `0x7A1864` still needs a real collision.
- **Plan:**
  1. Probe: a capture hook on `0x6022E0` (registers and args), and log `player + 0x58`. The user crashes hard into a
     wall and reports the panel: confirms the address and what the call expects.
  2. A `call` hook (built in 0.7.0 for the map's autopilot): at the once-a-frame `0x4022C0` (`ret: 0x581475`),
     the game thread calls `0x6022E0` with the captured arguments when the mod asks (`store.hooks.x.call(ecx,
     args)`). It runs on the game's thread, so nothing races.
  3. The mod: a hotkey, free roam only (not races, shops, paused). An optional small push from behind needs the
     car's physics body; the roam_game.c comment points at `[[car + 0x3C] + 0x68]`, momentum `+0x70`. Writing car
     `+0x70` alone doesn't stick: the physics puts back its own velocity each step (comment near
     `roam_game.c:10156`).
  4. Camera mods (top-down, drone) step aside while `+0x58` is 6, or they cover the crash view.
- **Not known:** whether the crash view ends on its own when started this way; whether it slows the world on this
  screen (then the car slows for a moment on other players' screens too, as after a real crash).

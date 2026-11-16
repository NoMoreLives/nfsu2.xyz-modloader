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

// Top-down camera: looks straight down at your car from above.
//   Alt+T            on / off (turns the other camera mods off)
//   Alt+= / Alt+-    higher / lower
//   Alt+R            the picture turns with the car / north stays up
// Its options: the panel's ⚙ beside "Top-down camera".
U2ML.register({
  id: 'topdown',
  name: 'Top-down camera',
  group: 'camera',
  runOn: 'game',             // once a game frame (live, 0.4.0)
  defaultOn: false,
  options: [
    { key: 'height', label: 'Height', type: 'number', min: 5, max: 400, step: 1, default: 40, unit: 'm' },
    { key: 'northUp', label: 'Picture turns', type: 'choice', default: false, choices: [{ value: false, label: 'with the car' }, { value: true, label: 'north up' }] },
    { key: 'glide', label: 'Height glide', type: 'number', min: 0.5, max: 20, step: 0.5, default: 6, help: 'how fast a new height is reached' },
    { key: 'ahead', label: 'Look ahead', type: 'number', min: 0, max: 1.5, step: 0.05, default: 0, unit: 's', help: 'centre the picture where the car will be this far ahead' },
  ],
  keys: {
    'Alt+KeyT': (api, store, self) => self.toggle(),
    'Alt+Equal': (api, store) => store.set('height', store.get('height') * 1.25),
    'Alt+Minus': (api, store) => store.set('height', store.get('height') / 1.25),
    'Alt+KeyR': (api, store) => store.set('northUp', !store.get('northUp')),
  },
  init() { this.heading = [0, 1, 0]; this.h = null; },
  frame(api, dt, store) {
    const { game, camera, v3 } = api;
    if (!game.driving() || !camera.layout) return;   // the loader learns the camera's layout first
    const car = game.carPos();
    if (!car || !car.every(Number.isFinite)) return;

    // the car's heading: its own forward axis (the loader learns it), else the game's chase camera's
    // on the frames that still show it
    const f = game.carForward(), g = f ? null : camera.gameCamera();
    const d = f ? [f[0], f[1], 0] : g ? [g.target[0] - g.eye[0], g.target[1] - g.eye[1], 0] : null;
    if (d && v3.len(d) > 0.1) this.heading = v3.norm(d);

    // the height glides to the one asked for
    const want = store.get('height');
    this.h = this.h == null ? want : this.h + (want - this.h) * Math.min(1, dt * store.get('glide'));

    const vel = game.carVel() || [0, 0, 0], ahead = store.get('ahead');
    const centre = [car[0] + vel[0] * ahead, car[1] + vel[1] * ahead, car[2]];
    const up = store.get('northUp') ? [0, 1, 0] : this.heading;
    camera.set([centre[0], centre[1], centre[2] + this.h], centre, up);
  },
  disable() { this.h = null; },
});

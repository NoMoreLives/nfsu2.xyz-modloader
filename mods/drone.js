// Drone camera: flies behind and above your car, lags a little when you speed up or brake, swings round
// smoothly in turns, looks ahead of the car along its speed and tilts gently into corners.
//   Alt+D            on / off (turns the other camera mods off)
//   Alt+= / Alt+-    farther / closer (distance and height together)
//   Alt+] / Alt+[    orbit round the car, 45 degrees at a time
//   Alt+0            every option back to its default
//   Alt+B            corner tilt on / off
// Every number below is an option: the panel's ⚙ beside "Drone camera".
(() => {
  const SNAP_M = 50;              // the car jumped farther than this (a respawn): no flying there
  const TWO_PI = Math.PI * 2;

  // one step of a critically damped spring (implicit, stable at any frame time)
  function spring(x, v, target, omega, dt) {
    const f = 1 + 2 * dt * omega, oo = omega * omega, hoo = dt * oo, hhoo = dt * hoo, inv = 1 / (f + hhoo);
    return [(f * x + dt * v + hhoo * target) * inv, (v + hoo * (target - x)) * inv];
  }
  const wrap = a => { a %= TWO_PI; return a > Math.PI ? a - TWO_PI : a < -Math.PI ? a + TWO_PI : a; };
  const ease = (dt, tau) => 1 - Math.exp(-dt / Math.max(1e-3, tau));

  let S = null;

  U2ML.register({
    id: 'drone',
    name: 'Drone camera',
    group: 'camera',
    runOn: 'game',           // once a game frame: steadier than the screen's frames (live, 0.4.0)
    defaultOn: false,
    options: [
      { key: 'dist', label: 'Distance behind', type: 'number', min: 2, max: 80, step: 0.5, default: 11, unit: 'm' },
      { key: 'height', label: 'Height', type: 'number', min: 0.5, max: 40, step: 0.5, default: 4.5, unit: 'm' },
      { key: 'orbit', label: 'Orbit', type: 'number', min: 0, max: 359, step: 1, default: 0, unit: '°', help: '0 behind, 90 the left side, 180 in front' },
      { key: 'follow', label: 'Follow stiffness', type: 'number', min: 0.5, max: 12, step: 0.1, default: 3.2, help: 'how fast it catches up with where it should be (higher: tighter)' },
      { key: 'swing', label: 'Swing time', type: 'number', min: 0.02, max: 2, step: 0.01, default: 0.35, unit: 's', help: 'how long it takes to swing round behind the car in a turn' },
      { key: 'aimStiff', label: 'Aim stiffness', type: 'number', min: 1, max: 25, step: 0.5, default: 7, help: 'how fast its aim follows the car' },
      { key: 'lookAhead', label: 'Look ahead', type: 'number', min: 0, max: 1.5, step: 0.05, default: 0.3, unit: 's', help: 'it aims where the car will be this far ahead' },
      { key: 'aimHeight', label: 'Aim height', type: 'number', min: -1, max: 4, step: 0.1, default: 0.8, unit: 'm' },
      { key: 'drift', label: 'Launch drift', type: 'number', min: 0, max: 1, step: 0.05, default: 0.25, help: 'm it drifts back per m/s² of acceleration (forward when braking)' },
      { key: 'driftMax', label: 'Most drift', type: 'number', min: 0, max: 10, step: 0.5, default: 3, unit: 'm' },
      { key: 'bank', label: 'Corner tilt', type: 'bool', default: true },
      { key: 'bankAmount', label: 'Tilt amount', type: 'number', min: 0, max: 0.05, step: 0.001, default: 0.012, help: 'radians per m/s² of sideways acceleration' },
      { key: 'bankMax', label: 'Most tilt', type: 'number', min: 0, max: 30, step: 0.5, default: 11.5, unit: '°' },
      { key: 'hover', label: 'Hover wobble', type: 'number', min: 0, max: 0.5, step: 0.01, default: 0.05, unit: 'm' },
    ],
    keys: {
      'Alt+KeyD': (api, store, self) => self.toggle(),
      'Alt+Equal': (api, store) => { store.set('dist', store.get('dist') * 1.2); store.set('height', store.get('height') * 1.2); },
      'Alt+Minus': (api, store) => { store.set('dist', store.get('dist') / 1.2); store.set('height', store.get('height') / 1.2); },
      'Alt+BracketRight': (api, store) => store.set('orbit', (store.get('orbit') + 45) % 360),
      'Alt+BracketLeft': (api, store) => store.set('orbit', (store.get('orbit') + 315) % 360),
      'Alt+Digit0': (api, store) => store.reset(),
      'Alt+KeyB': (api, store) => store.set('bank', !store.get('bank')),
    },
    status(api, store) {
      return `drone: ${store.get('dist')} m back, ${store.get('height')} m up, orbit ${store.get('orbit')}°`;
    },
    enable() { S = null; },
    disable() { S = null; },
    // the game put the car somewhere (a reset to the road, the start grid): start again behind it, no swing
    on: { carPlaced() { S = null; }, carReset() { S = null; } },
    frame(api, dt, store) {
      const { game, camera, v3 } = api;
      if (!game.driving() || !camera.layout || dt <= 0) return;
      const car = game.carPos(), vel = game.carVel() || [0, 0, 0];
      if (!car || !car.every(Number.isFinite)) return;
      const o = store.all();
      // the car's heading: its forward axis (learnt by the loader), else where it goes
      const f = game.carForward();
      const head = f && Math.hypot(f[0], f[1]) > 0.2 ? Math.atan2(f[1], f[0])
        : Math.hypot(vel[0], vel[1]) > 2 ? Math.atan2(vel[1], vel[0]) : S ? S.carYaw : null;
      if (head == null) return;

      // where the drone wants to be and look, relative to the car: it moves with the car, and only these
      // glide, so it keeps its distance at any speed
      const orbit = o.orbit * Math.PI / 180;
      const wantOff = y => [-Math.cos(y + orbit) * o.dist, -Math.sin(y + orbit) * o.dist, o.height];
      const aimOff = [vel[0] * o.lookAhead, vel[1] * o.lookAhead, o.aimHeight + vel[2] * o.lookAhead];

      if (!S || v3.len(v3.sub(car, S.lastCar)) > SNAP_M) {
        S = { yaw: head, carYaw: head, off: wantOff(head), ov: [0, 0, 0], look: aimOff, lv: [0, 0, 0], lastVel: vel, acc: [0, 0, 0], roll: 0, t: 0, lastCar: car };
      }
      S.t += dt; S.lastCar = car; S.carYaw = head;

      // the car's acceleration, smoothed: the drone drifts back as it speeds up and forward as it brakes
      const accNow = v3.scale(v3.sub(vel, S.lastVel), 1 / dt); S.lastVel = vel;
      if (v3.len(accNow) < 100) S.acc = v3.lerp(S.acc, accNow, ease(dt, 0.25));
      const drift = v3.scale(S.acc, -o.drift), dl = v3.len(drift);
      const drifted = dl > o.driftMax ? v3.scale(drift, o.driftMax / dl) : drift;

      // swing round behind the car, the short way
      S.yaw = wrap(S.yaw + wrap(head - S.yaw) * ease(dt, o.swing));
      const target = v3.add(wantOff(S.yaw), [drifted[0], drifted[1], 0]);
      for (let i = 0; i < 3; i++) {
        [S.off[i], S.ov[i]] = spring(S.off[i], S.ov[i], target[i], o.follow, dt);
        [S.look[i], S.lv[i]] = spring(S.look[i], S.lv[i], aimOff[i], o.aimStiff, dt);
      }
      S.off[2] = Math.max(S.off[2], 0.5);                      // never under the car
      const look = v3.add(car, S.look);

      // a drone's hover: a slow wobble
      const h = o.hover;
      const eye = v3.add(v3.add(car, S.off), [Math.sin(S.t * 1.3) * h, Math.cos(S.t * 1.7) * h, Math.sin(S.t * 2.1) * h * 0.8]);

      // the tilt: into the corner, by the car's sideways acceleration
      const fwd = v3.norm(v3.sub(look, eye)), right = v3.norm(v3.cross(fwd, [0, 0, 1]));
      const maxRad = o.bankMax * Math.PI / 180;
      const rollWant = o.bank ? Math.max(-maxRad, Math.min(maxRad, -v3.dot(S.acc, right) * o.bankAmount)) : 0;
      S.roll += (rollWant - S.roll) * ease(dt, 0.3);
      const up = v3.add(v3.scale([0, 0, 1], Math.cos(S.roll)), v3.scale(right, Math.sin(S.roll)));

      camera.set(eye, look, up);
    },
  });
})();

// Free rev: hold Z while the car stands still, and the throttle revs the engine without driving off.
//
// While Z is held in the world with the car standing still:
//  - the gearbox is held in neutral, so the throttle doesn't drive the car (car +0x434 = 1; nfsu2-web
//    runtime/game.h CAR_GEAR: 0 reverse, 1 neutral, 2 first ..), and
//  - the mod revs the engine itself: an rpm that climbs with the throttle, falls off it and bounces off a limiter
//    at the redline, written into the car's rpm (+0x440, game.h CAR_RPM) on the game's thread just before the
//    game's sound reads it. The game's own engine sound then plays at that rpm: the sound's rpm is the car's,
//    scaled from its idle to its redline (0x484C50, nfsu2-web runtime/roam_game.c), and the sound update is
//    0x483B40 (runtime/framerate.c F4).
// Letting go of Z, or the car rolling off, gives the gear and the rpm back to the game.
//
// What the live tests showed (2026-11-16), and why it works this way:
//  1. Neutral written from the page once a frame: the HUD's gear flashed N/1 (the automatic gearbox puts first
//     back every physics step).
//  2. Neutral also written on the game's thread, by write hooks at the start of 0x594300 (runtime/mprace.c: the
//     engine, each step) and 0x5AA480 (the rigid-body substep, runtime/oracle.c), to both car objects (the race's
//     and game.car()): the HUD shows N and the car stays put at full throttle, but the rpm stays at 1000.
//  3-4. 0x594300 runs ~160 times a frame on one object, the same in two sessions (0x934B0B0): no word or byte of
//     it follows the car's gear (both car objects' gears went R to 5 meanwhile). So the engine's own revving in
//     neutral couldn't be found; the rpm is made here instead.
//
// It's the game's own engine sound, at the rpm written. In free roam nfsu2-web sends each player's engine sound
// (the rpm and volumes their game plays it at, roam_game.c roam_game_engine_state) and the car's rpm (+0x440) to
// the others, so friends at a car meet should hear the revs too.
//
// While the mod is on, Z is kept from the site in the world (the site's Z is "Invite to a race"). Typing in a
// text box (chat) is left alone. Switch the mod off to invite with Z.
//
// This writes the gear and the rpm, which the loader's rules otherwise leave alone (physics). It acts only at a
// standstill, not during a countdown, and gives both back: no advantage in a race.
(() => {
  const KEY = 'KeyZ';
  const CAR_POS = 0x60, CAR_FWD_SPEED = 0x42c, CAR_GEAR = 0x434, CAR_RPM = 0x440;   // nfsu2-web runtime/game.h
  const CAR_CTL = 0x30, CTL_THROTTLE = 0x20c;      // the car's controls: the throttle 0..1 (roam_game.c car_state)
  const CAR_PERF = 0x10, PERF_INFO = 0x10, PI_RPM_IDLE = 0x220, PI_RPM_MAX = 0x228;   // mprace.c perf_info
  const NEUTRAL = 1;
  const COUNTDOWN = 3;                             // game.raceState(): the game revs on the line by itself then
  const ENGINE_STEP = 0x594300, SUBSTEP = 0x5aa480, SOUND_UPDATE = 0x483b40, SOUND_RPM = 0x484c50;
  // the engine model: rpm a second up at full throttle, down off it; the limiter's drop at the redline
  const RISE = 9000, FALL = 5000, LIMITER_DROP = 350;

  // write hooks, all to an object the page names (to: { page: true }): for each of the two car objects (on the
  // live site there are two at the player's place: see findCars) its gear at the engine's step and the substep,
  // and its rpm at the engine's step, the sound update and the sound's rpm scaling
  const GEAR_AT = [ENGINE_STEP, SUBSTEP], RPM_AT = [ENGINE_STEP, SOUND_UPDATE, SOUND_RPM];
  const hookNames = (i, what, at) => at.map((_, k) => `${what}${i}_${k}`);
  const GEARS = [0, 1].map(i => hookNames(i, 'g', GEAR_AT)), RPMS = [0, 1].map(i => hookNames(i, 'r', RPM_AT));
  const HOOKS = [0, 1].flatMap(i => [
    ...GEAR_AT.map((at, k) => ({ name: GEARS[i][k], at, kind: 'write', to: { page: true }, ranges: [[CAR_GEAR, 4]] })),
    ...RPM_AT.map((at, k) => ({ name: RPMS[i][k], at, kind: 'write', to: { page: true }, ranges: [[CAR_RPM, 4]] })),
  ]);

  let modOn = false, held = false;
  let rev = null;      // while revving: { cars: [{ addr, gear }], idle, redline, rpm, frames, top }
  let restore = null;  // after revving: gears to give back for a few frames (a hook call may land late)
  let line = '';

  const typing = e => {
    const t = e.target;
    return !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ''));
  };
  const ours = e => e.code === KEY && !e.ctrlKey && !e.altKey && !e.metaKey && !typing(e);

  // The key's held state. Registered at document_start, before the site's listeners: a stopped event never
  // reaches the site or the game.
  addEventListener('keydown', e => {
    if (!ours(e) || !modOn || !U2ML.game.inWorld()) return;
    held = true;
    e.preventDefault(); e.stopImmediatePropagation();
  }, true);
  addEventListener('keyup', e => {
    if (e.code !== KEY || !held) return;
    held = false;
    e.preventDefault(); e.stopImmediatePropagation();
  }, true);
  addEventListener('blur', () => { held = false; });

  const gearName = g => g === 0 ? 'R' : g === NEUTRAL ? 'N' : String(g - 1);
  const hex = a => '0x' + (a >>> 0).toString(16);

  /** a car object whose gear, rpm and speed look like a car's */
  function sane(mem, c) {
    if (!c || !mem.ok(c, CAR_RPM + 4)) return false;
    const g = mem.u32(c + CAR_GEAR), rpm = mem.f32(c + CAR_RPM), v = mem.f32(c + CAR_FWD_SPEED);
    return g <= 10 && Number.isFinite(rpm) && rpm >= 0 && rpm < 30000 && Number.isFinite(v);
  }

  /** The player's car objects. On the live site [player + 4] (game.car()) and the race's entry for the player
   *  (game.race().car) are two objects at the same place (CLAUDE.md, race readings); both shift through the
   *  gears (live test 4). The player's first. */
  function findCars(api) {
    const { game, mem, v3 } = api;
    const at = game.carPos(), out = [];
    const r = game.race();
    for (const c of [game.car(), r && r.car]) {
      if (!c || out.includes(c) || !sane(mem, c)) continue;
      if (at && v3.len(v3.sub(mem.vec3(c + CAR_POS), at)) > 2) continue;
      out.push(c);
    }
    return out;
  }

  /** the car type's idle and most rpm from its physics info ([car + 0x10] + 0x10, mprace.c), if a car object has
   *  one that looks right */
  function rpmRange(mem, cars) {
    for (const c of cars) {
      const r = mem.ptr(c + CAR_PERF), pi = r ? r + PERF_INFO : 0;
      if (!pi || !mem.ok(pi, PI_RPM_MAX + 4)) continue;
      const idle = mem.f32(pi + PI_RPM_IDLE), most = mem.f32(pi + PI_RPM_MAX);
      if (idle >= 400 && idle <= 2500 && most >= 4000 && most <= 15000 && most > idle + 2000) return { idle, redline: most };
    }
    return null;
  }

  function hooksOff(store) {
    for (const n of [...GEARS.flat(), ...RPMS.flat()]) store.hooks[n].off();
  }
  /** write hooks putting a value at the car object's offset from their next call on */
  function aim(H, names, car, set) {
    for (const n of names) if (H[n].ready) { H[n].target(car); set(H[n]); H[n].commit(); }
  }

  function start(api, store) {
    const { mem } = api, H = store.hooks;
    const cars = findCars(api).map(addr => ({ addr, gear: mem.u32(addr + CAR_GEAR) }));
    if (!cars.length) return;
    restore = null;
    hooksOff(store);
    const R = rpmRange(mem, cars.map(c => c.addr));
    const now = mem.f32(cars[0].addr + CAR_RPM);
    const idle = R ? R.idle : Math.min(Math.max(now, 600), 1500), redline = R ? R.redline : store.get('redline');
    rev = { cars, idle, redline, rpm: Math.max(now, idle), frames: 0, top: 0, range: R ? "the car's" : 'the setting' };
    cars.forEach((c, i) => aim(H, GEARS[i], c.addr, h => h.setU32(CAR_GEAR, NEUTRAL)));
    const bad = Object.keys(H).map(n => H[n].state === 'in' ? null : `${n} ${H[n].state}`).filter(Boolean);
    api.log(`rev: on, car ${cars.map(c => `${hex(c.addr)} gear ${gearName(c.gear)}`).join(', ')}; idle ${Math.round(idle)}, ` +
      `redline ${Math.round(redline)} (${rev.range})` + (bad.length ? `; hooks not in: ${bad.join(', ')}` : '; hooks in'));
  }

  function stop(api, store, why) {
    if (!rev) return;
    hooksOff(store);
    restore = { back: rev.cars.filter(c => c.gear !== NEUTRAL), frames: 3 };
    giveBack(api.mem);
    const H = store.hooks, calls = RPMS[0].map((n, k) => `${hex(RPM_AT[k])} ${H[n].count()}`).join(', ');
    api.log(`rev: off (${why}) after ${rev.frames} frames, top ${Math.round(rev.top)} rpm; rpm writes ${calls}`);
    rev = null;
  }

  /** give each gear back while it's still the neutral this mod put in (the player may have shifted) */
  function giveBack(mem) {
    if (!restore) return;
    for (const c of restore.back) if (sane(mem, c.addr) && mem.u32(c.addr + CAR_GEAR) === NEUTRAL) mem.setU32(c.addr + CAR_GEAR, c.gear);
    if (--restore.frames <= 0) restore = null;
  }

  /** the throttle 0..1, from whichever car object's controls look right */
  function throttle(mem, cars) {
    for (const c of cars) {
      const ctl = mem.ptr(c.addr + CAR_CTL), t = ctl ? mem.f32(ctl + CTL_THROTTLE) : NaN;
      if (Number.isFinite(t) && t >= 0 && t <= 1.01) return Math.min(t, 1);
    }
    return 0;
  }

  /** one step of the engine: towards idle + throttle x (redline - idle), the limiter bouncing it off the top */
  function engine(r, thr, dt) {
    const target = r.idle + thr * (r.redline - r.idle);
    if (r.rpm < target) r.rpm = Math.min(target, r.rpm + RISE * dt * Math.max(thr, 0.2));
    else r.rpm = Math.max(target, r.rpm - FALL * dt);
    if (r.rpm >= r.redline - 1) r.rpm = r.redline - LIMITER_DROP;
    return r.rpm;
  }

  U2ML.register({
    id: 'rev',
    name: 'Free rev (hold Z when stopped)',
    defaultOn: true,
    runOn: 'game',
    options: [
      { key: 'still', label: 'Standing still under', type: 'number', min: 1, max: 15, step: 1, default: 3, unit: 'km/h',
        help: 'Z only revs when the car is slower than this' },
      { key: 'redline', label: 'Redline', type: 'number', min: 4000, max: 12000, step: 250, default: 7500, unit: 'rpm',
        help: "used when the car's own redline can't be read" },
    ],
    hooks: HOOKS,

    enable(api, store) { modOn = true; hooksOff(store); },
    disable(api, store) { modOn = false; held = false; stop(api, store, 'mod off'); line = ''; },

    frame(api, dt, store) {
      const { game, mem } = api, H = store.hooks;
      const vel = game.carVel();
      const speed = vel ? Math.hypot(vel[0], vel[1]) * 3.6 : Infinity;     // km/h, flat (z is up)
      const still = store.get('still');
      const can = game.driving() && game.raceState() !== COUNTDOWN;

      if (rev) {
        // keep going while the key is held and the car stays put (a little more leeway than to start)
        if (!held) stop(api, store, 'Z let go');
        else if (!can) stop(api, store, 'not driving');
        else if (speed > still * 2 + 2) stop(api, store, 'rolling');
      } else if (held && can && speed < still) start(api, store);
      if (!rev) giveBack(mem);

      if (rev) {
        const thr = throttle(mem, rev.cars), rpm = engine(rev, thr, dt);
        rev.cars.forEach((c, i) => {
          mem.setU32(c.addr + CAR_GEAR, NEUTRAL); mem.setF32(c.addr + CAR_RPM, rpm);   // as well as the hooks
          aim(H, RPMS[i], c.addr, h => h.setF32(CAR_RPM, rpm));
        });
        rev.frames++; rev.top = Math.max(rev.top, rpm);
        const hk = RPMS[0].filter(n => H[n].ready).length;
        line = `revving: ${Math.round(rpm)} rpm (redline ${Math.round(rev.redline)}), throttle ${Math.round(thr * 100)}%, ` +
          `rpm hooks ${hk}/${RPM_AT.length} in`;
        return;
      }
      const car = findCars(api)[0];
      if (!game.inWorld() || !car) { line = 'not driving'; return; }
      line = `hold Z when stopped (gear ${gearName(mem.u32(car + CAR_GEAR))}, ${Math.round(mem.f32(car + CAR_RPM))} rpm${held ? ', too fast' : ''})`;
    },

    status() { return `rev: ${line || '-'}`; },
  });
})();

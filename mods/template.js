// Template mod: a speed readout in the loader's panel.
//
// Copy this file to start a new mod (see MODDING.md). It shows every feature the loader has:
// options (a slider, a switch, a list), hotkeys, a status line in the panel, saved values,
// the mod's life cycle, and reading the game's memory through the loader's helpers.
//
// To try it: add "mods/template.js" to the "js" list in manifest.json (after "loader.js"),
// reload the extension in chrome://extensions, reload the game, then tick "Template: speed readout"
// in the panel (Alt+Shift+M shows the panel).
//
//   Alt+K   switch between km/h and mph
//   Alt+J   remember the top speed so far / forget it

// Wrapping the mod in a function keeps its variables to itself: every mod file shares the page.
(() => {
  // Anything the mod keeps between frames lives here. It is not saved: a reload starts it again.
  // (Values that should survive a reload go through the store, below.)
  let top = 0;          // the top speed this session, m/s
  let shown = '';       // what the status line says

  U2ML.register({
    // ---- who the mod is ---------------------------------------------------------------------------------
    id: 'template',                      // unique, a-z 0-9 _ -: the key for its saved values. Never change it later.
    name: 'Template: speed readout',     // what the panel shows
    defaultOn: false,                    // on the first time it loads? (afterwards the player's choice is kept)
    // group: 'camera',                  // one mod of a group on at a time (the camera mods share 'camera')

    // ---- options: the panel's ⚙ builds a control for each one ------------------------------------------
    options: [
      { key: 'units', label: 'Units', type: 'choice', default: 'kmh',
        choices: [{ value: 'kmh', label: 'km/h' }, { value: 'mph', label: 'mph' }] },
      { key: 'decimals', label: 'Decimals', type: 'number', min: 0, max: 2, step: 1, default: 0 },
      { key: 'showTop', label: 'Show top speed', type: 'bool', default: true,
        help: 'the fastest you went since the page loaded' },    // help: shown when hovering over the label
    ],

    // ---- hotkeys: the event's code, after Ctrl+, Alt+, Shift+ in that order ----------------------------
    // Each gets (api, store, self); self.toggle() turns this mod on or off, self.on says whether it is.
    // The loader keeps the key from the game. Pick combinations the game and the site don't use.
    keys: {
      'Alt+KeyK': (api, store) => store.set('units', store.get('units') === 'kmh' ? 'mph' : 'kmh'),
      'Alt+KeyJ': (api, store) => { store.set('trackTop', !store.get('trackTop', true)); top = 0; },
    },

    // ---- life cycle --------------------------------------------------------------------------------------
    // init: once, when the mod loads (the game may not have started yet: don't read its memory here)
    init(api, store) {
      api.log('template: loaded, units', store.get('units'));
    },
    // enable / disable: each time the mod is switched on or off (panel, hotkey, or another mod of its group)
    enable(api) { top = 0; api.log('template: on'); },
    disable(api) { shown = ''; api.log('template: off'); },

    // onOption: an option changed (panel, hotkey, reset or the console)
    onOption(key, value, api) { api.log(`template: ${key} is now ${value}`); },

    // frame: every animation frame while the mod is on and the game's memory is caught.
    // dt is the time since the last frame in seconds (at most 0.1). If it throws, the loader turns the mod off.
    frame(api, dt, store) {
      const { game, v3 } = api;
      if (!game.inWorld()) { shown = 'not driving'; return; }     // menus, loading: nothing to read
      const vel = game.carVel();                                   // the car's velocity, m/s (null: no car)
      if (!vel) { shown = 'no car'; return; }
      const speed = v3.len([vel[0], vel[1], 0]);                   // flat: the game's world has z up
      if (store.get('trackTop', true)) top = Math.max(top, speed);

      const mph = store.get('units') === 'mph';
      const k = mph ? 2.23694 : 3.6, unit = mph ? 'mph' : 'km/h', d = store.get('decimals');
      shown = `${(speed * k).toFixed(d)} ${unit}`;
      if (store.get('showTop')) shown += `, top ${(top * k).toFixed(d)}`;
    },

    // status: a line in the panel under the loader's own, while the mod is on (asked about 4 times a second)
    status() { return `speed: ${shown || '-'}`; },
  });
})();

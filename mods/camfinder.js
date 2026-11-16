// Camera finder (a tool, not a camera): finds where the drive camera's settings for each view live (height,
// distance, angle, field of view ...), so a camera mod can change the game's own camera instead of fighting it.
//
// How to use: turn it on, drive, press C to go through every view, about 3 seconds in each, twice round.
// Then Alt+F prints a table: every value that stayed the same within a view and differs between views.
//
// What it watches: the player's camera mover (Player +0x238), what the mover points to, and the game's own data
// (0x780000-0x8C0000). The view number is PlayerSettings +0x10 (0x83AA74, nfsu2-web runtime/game.h).
(() => {
  const VIEW_ADDR = 0x0083aa64 + 0x10, PS_LO = 0x0083aa64, PS_HI = 0x0083aa64 + 0x50;
  const NV = 5;                                            // views 0-3 and the drift camera, 4
  const f32of = bits => new Float32Array(new Uint32Array([bits]).buffer)[0];
  const fmt = bits => { const f = f32of(bits), a = Math.abs(f); return Number.isFinite(f) && a > 1e-4 && a < 1e6 ? +f.toFixed(4) : '0x' + bits.toString(16); };
  let S = null;

  function start(api) {
    const { mem, game } = api;
    const buf = mem.memory.buffer, u32 = new Uint32Array(buf);
    const p = game.player(), mover = p ? mem.ptr(p + game.OFF.PL_MOVER) : 0;
    const regions = [];
    if (mover) {
      regions.push([mover, 0x1000, 'mover']);
      const seen = new Set([mover]);
      for (let o = 0; o < 0x400 && regions.length < 65; o += 4) {
        const q = mem.u32(mover + o);
        if (q > 0x10000 && q % 4 === 0 && q + 0x400 < buf.byteLength && !seen.has(q)) { seen.add(q); regions.push([q, 0x400, `[mover+0x${o.toString(16)}]`]); }
      }
    }
    regions.push([0x780000, 0x140000, 'data']);
    let n = 0; for (const r of regions) n += r[1] >> 2;
    const addr = new Uint32Array(n), tag = new Uint16Array(n);
    let i = 0;
    regions.forEach((r, k) => { for (let a = r[0]; a < r[0] + r[1]; a += 4) { addr[i] = a; tag[i++] = k; } });
    S = { mover, regions, addr, tag, n, u32, val: new Uint32Array(n * NV), bad: new Uint8Array(n * NV), seen: new Uint8Array(NV), frames: 0 };
    api.log(`camera finder: watching ${n} values (mover 0x${mover.toString(16)}, ${regions.length - 2} regions it points to)`);
  }

  function report(api) {
    if (!S) { api.log('camera finder: drive first'); return []; }
    const views = [...Array(NV).keys()].filter(v => S.seen[v]);
    if (views.length < 2) { api.log('camera finder: press C to go through the views first'); return []; }
    const rows = [];
    for (let i = 0; i < S.n; i++) {
      const a = S.addr[i];
      if (a >= PS_LO && a < PS_HI) continue;              // the view number itself
      const first = S.val[views[0] * S.n + i];
      let ok = true, differ = false;
      for (const v of views) { if (S.bad[v * S.n + i]) { ok = false; break; } if (S.val[v * S.n + i] !== first) differ = true; }
      if (!ok || !differ) continue;
      const r = S.regions[S.tag[i]];
      const row = { addr: '0x' + a.toString(16), where: `${r[2]}+0x${(a - r[0]).toString(16)}` };
      for (const v of views) row[`view ${v}`] = fmt(S.val[v * S.n + i]);
      rows.push(row);
    }
    console.table(rows.slice(0, 400));
    api.log(`camera finder: ${rows.length} candidates over views ${views.join(', ')}${rows.length > 400 ? ' (first 400 shown)' : ''}. To send it: type copy(U2ML.mods.get('camfinder').def.last) in the console, then paste into the chat.`);
    def.last = rows;
    return rows;
  }

  const def = {
    id: 'camfinder',
    name: 'Camera finder (tool)',
    defaultOn: false,
    last: null,
    keys: { 'Alt+KeyF': api => report(api) },
    report: () => report(U2ML_API),
    enable() { S = null; U2ML.setEnabled('topdown', false); },  // it needs the game's own camera
    disable() { S = null; },
    status() {
      if (!S) return 'finder: start driving';
      return `finder: views seen ${[...Array(NV).keys()].filter(v => S.seen[v]).join(' ') || '-'}, now ${U2ML.mem.u32(VIEW_ADDR)}  (C changes, Alt+F prints)`;
    },
    frame(api) {
      U2ML_API = api;
      if (!api.game.driving()) return;
      if (!S) start(api);
      const v = api.mem.u32(VIEW_ADDR);
      if (v >= NV) return;
      S.frames++;
      const { addr, val, bad, u32, n } = S, base = v * n;
      if (!S.seen[v]) { for (let i = 0; i < n; i++) val[base + i] = u32[addr[i] >>> 2]; S.seen[v] = 1; return; }
      for (let i = 0; i < n; i++) if (u32[addr[i] >>> 2] !== val[base + i]) bad[base + i] = 1;
    },
  };
  let U2ML_API = null;
  U2ML.register(def);
})();

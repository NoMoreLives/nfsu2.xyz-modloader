// Hook probe (a tool, not a mod to play with): shows that the hook system works on the live site, and measures
// whether mods that run on the game's frames run before that frame's views are made (when a camera written
// then still shows in the same frame).
//
// It runs on the game's frames (runOn: 'game'). Turn it on and drive. Its panel lines show, for the last second:
//   loop   game frames: GameLoop's call of the empty function 0x4022C0 (from 0x581470, return address
//          0x581475, nfsu2-web runtime/career.c)
//   view   calls of the view setup (0x5C7EC0, once for each view the frame draws)
//   views  which views those were: the view id at [eView + 4], read through the captured argument [esp + 4]
//          (nfsu2-web runtime/overrides.c sub_005c7ec0). Seen live: 0, 1 (main), 4 (road reflection), 9 (the
//          headlight projector, headlights.c) and 16-21 (the cube map's faces, enhance.c)
//   order  the order a frame makes its views in (the views between two GameLoop calls). Live: 0 1 4 9 16-21
//   ran    on how many game frames the mods ran before any of that frame's views was made ("in time"), and
//          on the others, how many of its views were made already
//   ret    whether the captured return addresses lie in the game's code
(() => {
  const CODE_LO = 0x00401000, CODE_HI = 0x00782af1;            // SPEED2.EXE's .text (nfsu2-web runtime/cpu.h)
  const hex = v => '0x' + (v >>> 0).toString(16);
  let S = null;
  const fresh = H => ({ t: 0, from: 0, next: 1, loop0: H.loop.count(), view0: H.view.count(), seen: H.args.count(), ids: new Map(),
    retOk: 0, retBad: 0, out: null, prevLo: null, order: null, frames: 0, inTime: 0, late: new Map(), screen: 0, list: [] });

  U2ML.register({
    id: 'hookprobe',
    name: 'Hook probe (tool)',
    defaultOn: false,
    runOn: 'game',
    hooks: [
      // GameLoop (0x5811C0) never returns, so a hook at its start fires once; it calls 0x4022C0 (~300 callers) each frame
      { name: 'loop', at: 0x004022c0, ret: 0x00581475, kind: 'notify', wake: false },
      { name: 'view', at: 0x005c7ec0, kind: 'notify', wake: false },
      { name: 'args', at: 0x005c7ec0, kind: 'capture', args: 1, keep: 64 },
    ],
    enable(api, store) { S = fresh(store.hooks); },
    disable() { S = null; },
    frame(api, dt, store, info) {
      if (!S) return;
      const H = store.hooks, { mem, after } = api;
      const lo = H.loop.order(), got = H.args.since(S.seen);
      for (const x of got) {
        S.seen = x.call + 1;
        const view = x.args[0];
        x.id = mem.ok(view + 4) ? mem.u32(view + 4) : -1;
        S.ids.set(x.id, (S.ids.get(x.id) || 0) + 1);
        if (x.ret >= CODE_LO && x.ret < CODE_HI) S.retOk++; else S.retBad++;
        S.last = x;
      }
      S.list.push(...got);
      if (S.list.length > 256) S.list.splice(0, S.list.length - 256);
      if (info && info.on === 'game' && H.loop.ready) {
        // this frame's views made before the mods ran: the captures after this frame's GameLoop call
        const done = S.list.filter(x => after(x.order, lo)).length;
        S.frames++;
        if (!done) S.inTime++; else S.late.set(done, (S.late.get(done) || 0) + 1);
        // the last whole frame: the views between the previous GameLoop call and this one
        if (S.prevLo != null && after(lo, S.prevLo)) {
          const ids = S.list.filter(x => after(x.order, S.prevLo) && !after(x.order, lo)).map(x => x.id);
          if (ids.length) S.order = ids.join(' ');
        }
        S.prevLo = lo;
      } else S.screen++;
      S.t += dt;
      if (S.t < S.next) return;
      const secs = S.t - S.from;
      const loop = H.loop.count(), view = H.view.count();
      S.out = {
        loop: (loop - S.loop0) / secs, view: (view - S.view0) / secs,
        ids: [...S.ids].sort((a, b) => a[0] - b[0]).map(([k, n]) => `${k}:${Math.round(n / secs)}`).join(' ') || '-',
        ret: S.retOk + S.retBad ? `${S.retOk} in the game's code, ${S.retBad} not` : '-',
        ran: S.frames ? `in time ${Math.round(100 * S.inTime / S.frames)}% of ${S.frames} frames` +
          (S.late.size ? `; late: ${[...S.late].sort((a, b) => a[0] - b[0]).map(([k, n]) => `${n}x after ${k} view${k > 1 ? 's' : ''}`).join(', ')}` : '')
          : `on the screen's frames (${S.screen}): the game's aren't coming`,
        order: S.order || '-', last: S.last,
      };
      S.loop0 = loop; S.view0 = view; S.ids.clear(); S.retOk = S.retBad = 0; S.frames = S.inTime = S.screen = 0; S.late.clear();
      S.from = S.t; S.next = S.t + 1;
    },
    status(api, store) {
      const H = store.hooks;
      if (!H.loop.ready || !H.args.ready) return `probe   hooks ${H.loop.state} / ${H.view.state} / ${H.args.state}`;
      const o = S && S.out;
      if (!o) return 'probe   counting...';
      const f = n => n.toFixed(0);
      return `probe   loop ${f(o.loop)}/s  view ${f(o.view)}/s  views ${o.ids}\n` +
        `probe   order ${o.order}\n` +
        `probe   ran ${o.ran}\n` +
        `probe   ret ${o.ret}` +
        (o.last ? `; last: ecx ${hex(o.last.ecx)} eView ${hex(o.last.args[0])} ret ${hex(o.last.ret)}` : '');
    },
  });
})();

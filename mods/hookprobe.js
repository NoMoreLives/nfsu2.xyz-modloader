// Hook probe (a tool, not a mod to play with): shows that the hook system works on the live site.
//
// Turn it on and drive. Its panel lines show, for the last second:
//   loop   game frames: GameLoop's call of the empty function 0x4022C0 (from 0x581470, return address
//          0x581475, nfsu2-web runtime/career.c), and how often it woke the page
//   view   calls of the view setup (0x5C7EC0, once for each view the frame draws)
//   views  which views those were: the view id at [eView + 4] (1 main, 3 mirror, 4 road reflection ...), read
//          through the captured argument [esp + 4] (nfsu2-web runtime/overrides.c sub_005c7ec0). Seen live: 0,
//          1, 4, 9 (the headlight projector, headlights.c) and 16-21 (the cube map's faces, enhance.c)
//   ret    whether the captured return address lies in the game's code
// If those look right, capture reads the game's real registers and stack, and notify wakes the page.
(() => {
  const CODE_LO = 0x00401000, CODE_HI = 0x00782af1;            // SPEED2.EXE's .text (nfsu2-web runtime/cpu.h)
  const hex = v => '0x' + (v >>> 0).toString(16);
  let S = null;

  async function wakeLoop(api, store, me) {
    const loop = store.hooks.loop;
    while (S === me) {
      const before = loop.count(), c = await loop.wait(500);
      if (S === me && c > before) me.woke++;
    }
  }

  U2ML.register({
    id: 'hookprobe',
    name: 'Hook probe (tool)',
    defaultOn: false,
    hooks: [
      // GameLoop (0x5811C0) never returns, so a hook at its start fires once; it calls 0x4022C0 (~300 callers) each frame
      { name: 'loop', at: 0x004022c0, ret: 0x00581475, kind: 'notify' },
      { name: 'view', at: 0x005c7ec0, kind: 'notify', wake: false },
      { name: 'args', at: 0x005c7ec0, kind: 'capture', args: 1, keep: 16 },
    ],
    enable(api, store) {
      const H = store.hooks;
      S = { t: 0, from: 0, next: 1, loop0: H.loop.count(), view0: H.view.count(), seen: H.args.count(), woke: 0, ids: new Map(), retOk: 0, retBad: 0, out: null };
      wakeLoop(api, store, S);
    },
    disable() { S = null; },
    frame(api, dt, store) {
      if (!S) return;
      const H = store.hooks, { mem } = api;
      for (const x of H.args.since(S.seen)) {
        S.seen = x.call + 1;
        const view = x.args[0], id = mem.ok(view + 4) ? mem.u32(view + 4) : -1;
        S.ids.set(id, (S.ids.get(id) || 0) + 1);
        if (x.ret >= CODE_LO && x.ret < CODE_HI) S.retOk++; else S.retBad++;
        S.last = x;
      }
      S.t += dt;
      if (S.t < S.next) return;
      const secs = S.t - S.from;
      const loop = H.loop.count(), view = H.view.count();
      S.out = {
        loop: (loop - S.loop0) / secs, woke: S.woke / secs, view: (view - S.view0) / secs,
        ids: [...S.ids].sort((a, b) => a[0] - b[0]).map(([k, n]) => `${k}:${Math.round(n / secs)}`).join(' ') || '-',
        ret: S.retOk + S.retBad ? `${S.retOk} in the game's code, ${S.retBad} not` : '-',
        last: S.last,
      };
      S.loop0 = loop; S.view0 = view; S.woke = 0; S.ids.clear(); S.retOk = S.retBad = 0;
      S.from = S.t; S.next = S.t + 1;
    },
    status(api, store) {
      const H = store.hooks;
      if (!H.loop.ready || !H.args.ready) return `probe   hooks ${H.loop.state} / ${H.view.state} / ${H.args.state}`;
      const o = S && S.out;
      if (!o) return 'probe   counting...';
      const f = n => n.toFixed(0);
      return `probe   loop ${f(o.loop)}/s (woke the page ${f(o.woke)}/s)  view ${f(o.view)}/s\n` +
        `probe   views ${o.ids}  ret ${o.ret}` +
        (o.last ? `\nprobe   last: ecx ${hex(o.last.ecx)} esp ${hex(o.last.esp)} eView ${hex(o.last.args[0])} ret ${hex(o.last.ret)}` : '');
    },
  });
})();

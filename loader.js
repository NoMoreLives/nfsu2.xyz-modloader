// U2 Mod Loader: runs in the page (the MAIN world) before the site's own scripts.
//
// What it does:
//   1. Catches the game's shared WebAssembly.Memory as the page creates it. The game's x86 memory sits at
//      address 0 of that memory (nfsu2-web runtime/cpu.h: g_mem is 0), so game address 0x832E50 is byte
//      0x832E50 of the buffer. The game's executable is one fixed version, so its addresses never move.
//   2. Puts the mods' hooks (and its own camera hook) into the game's module as the page compiles it.
//   3. Runs registered mods once per animation frame, gives them memory and game helpers, hooks, hotkeys and a panel.
//
// Console: U2ML (U2ML.status(), U2ML.hooks(), U2ML.mem.u32(0x8654a4), U2ML.scan.f32(1.5) ...). Panel: Alt+Shift+M.
(() => {
  'use strict';
  if (window.U2ML) return;

  const VERSION = '0.4.0';
  const log = (...a) => console.log('[u2ml]', ...a);
  const warn = (...a) => console.warn('[u2ml]', ...a);
  const MIN_GAME_PAGES = 4096;        // 256 MB: the game's memory is about 1 GB from its first menus (memory.ts)

  let memory = null, module = null, hasNames = null;
  // every WebAssembly call the page makes, for the panel: tells "not loaded yet" from "loaded where we can't see"
  const seen = { memories: [], calls: {} };
  const saw = k => { seen.calls[k] = (seen.calls[k] || 0) + 1; };

  // ---- 1. the game's memory ------------------------------------------------------------------------------
  const RealMemory = WebAssembly.Memory;
  WebAssembly.Memory = new Proxy(RealMemory, {
    construct(target, args, newTarget) {
      const m = Reflect.construct(target, args, newTarget);
      try {
        const d = args[0] || {};
        seen.memories.push(`${d.shared ? 'shared' : 'plain'} ${Math.round(Number(d.initial) / 16)} MB`);
        log('page made a WebAssembly.Memory', d);
        if (d.shared && Number(d.initial) >= MIN_GAME_PAGES) catchMem(m, 'new Memory');
      } catch (e) { warn('memory hook', e); }
      return m;
    },
  });

  // ---- 2. the game module ----------------------------------------------------------------------------------
  function noteModule(m) {
    if (m === module) return;                       // the same module, posted to each game worker
    try {
      const imp = WebAssembly.Module.imports(m);
      if (!imp.some(i => i.module === 'env' && i.name === 'memory' && i.kind === 'memory')) return;
      module = m;
      hasNames = WebAssembly.Module.customSections(m, 'name').length > 0;
      log(`game module caught: ${WebAssembly.Module.exports(m).length} exports, function names ${hasNames ? 'kept' : 'stripped'}`);
    } catch (e) { warn('module hook', e); }
  }
  // ---- 2b. hooks: the module patched as it loads -------------------------------------------------------------
  // compileStreaming is wrapped: the loader reads the module's bytes, puts each declared hook's few instructions
  // at the start of its game function (lib/wasmpatch.js) and compiles that instead. Hook code can't call
  // JavaScript (the game's workers make the module's imports), so each hook talks to the page through its slot in
  // shared memory, in the hook area. Any doubt about the module: the original is compiled, the game runs unchanged.
  // Off: localStorage['u2ml:patch'] = 'false', then reload.
  const W = () => globalThis.U2WasmPatch;
  const PATCH = { want: load('u2ml:patch', true), state: 'waiting for the game module', info: null };
  const HOOKS = {
    // 0xFF0000-0x1000000, just below the module heaps (nfsu2-web runtime/modheap.c: 0x1000000). nfsu2-web's own
    // scratch grows up from 0xD00000 (splitscreen_mem.h, splitscreen.c, coop.c) and ends at 0xD0F900: co-op's
    // player 2 ride is at 0xD0F000, where 0.2.0's camera mailbox was.
    AREA: 0x00ff0000, END: 0x01000000,
    ANCHOR: 0x005c7ec0,              // the view setup, proven a lifted function: the game's tables are found by it
    // +0 the order counter every hook stamps (lib/wasmpatch.js stamp), +4..+15 zero; the slots follow
    list: [], next: 0x00ff0010, compiled: false, busy: null, nextScan: 0,
  };
  const KINDS = ['notify', 'capture', 'write', 'skip'];
  const REGS = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi', 'eip'];
  const WAITING = 'waiting for the game module';
  function hookProblem(d) {
    if (!d || typeof d.name !== 'string' || !/^[A-Za-z0-9_]+$/.test(d.name)) return 'a hook needs a name of letters, digits and _';
    if (!KINDS.includes(d.kind)) return `kind must be one of ${KINDS.join(', ')}`;
    if (!Number.isInteger(d.at) || d.at < 0x400000 || d.at >= 0x900000) return 'at must be the x86 address of a game function';
    if (d.kind === 'capture') {
      const keep = d.keep ?? 1, args = d.args ?? 0;
      if (!Number.isInteger(keep) || keep < 1 || keep > 256 || (keep & (keep - 1))) return 'keep must be a power of 2, 1 to 256';
      if (!Number.isInteger(args) || args < 0 || args > 32) return 'args must be 0 to 32';
    }
    if (d.kind === 'write') {
      const to = d.to || {};
      if (!(Number.isInteger(to.addr) || Number.isInteger(to.ptr) || REGS.slice(0, 8).includes(to.reg))) return 'to must be { addr }, { ptr } or { reg }';
      if (!Array.isArray(d.ranges) || !d.ranges.length || !d.ranges.every(r => Array.isArray(r) && Number.isInteger(r[0]) && r[0] >= 0 &&
        Number.isInteger(r[1]) && r[1] > 0 && r[0] + r[1] <= 0x10000)) return 'ranges must be [[offset, bytes], ...]';
    }
    if (d.ret != null && !(Number.isInteger(d.ret) && d.ret >= 0x400000 && d.ret < 0x900000)) return 'ret must be a return address in the game\'s code';
    const pop = d.pop ?? 0;
    if (d.kind === 'skip' && !(Number.isInteger(pop) && pop >= 0 && pop <= 0xffff)) return "pop must be 0 to 65535 (the bytes the function's ret pops)";
    return null;
  }
  /** a hook from a mod's def.hooks (mod null: the loader's own) */
  function declareHook(mod, d) {
    const bad = hookProblem(d);
    const h = {
      id: `${mod ? mod.def.id : 'u2ml'}.${d && d.name}`, mod, name: d && d.name, kind: d && d.kind, at: d && d.at,
      keep: d?.keep ?? 1, args: d?.args ?? 0, to: d?.to, ranges: d?.ranges, pop: d?.pop ?? 0, wakes: d?.wake ?? d?.kind === 'notify',
      eax: (d?.eax ?? 0) >>> 0, ret: d?.ret ?? null, slot: 0, funcIdx: null,
      state: bad ? `failed: ${bad}` : !PATCH.want ? 'off: hooks switched off (u2ml:patch)' : HOOKS.compiled ? 'too late: reload the page' : WAITING,
      written: 0, w8: 0,           // what the page last wrote to +0 and +8 (the guard checks nothing else did)
      user: true, writing: false, idx: 0,
    };
    if (bad) warn(`hook ${h.id}: ${bad}`);
    else if (HOOKS.compiled) warn(`hook ${h.id}: the game module is already compiled; reload the page`);
    HOOKS.list.push(h);
    h.handle = makeHandle(h);
    return h;
  }
  const realCompile = WebAssembly.compile, realCS = WebAssembly.compileStreaming;
  async function compilePatched(src) {
    const resp = await src;
    let bytes;
    try { bytes = new Uint8Array(await resp.clone().arrayBuffer()); }
    catch (e) { if (!HOOKS.compiled) PATCH.state = `failed: ${e.message}`; warn('hooks: could not read the module', e); return realCS.call(WebAssembly, resp); }
    try {
      const t0 = performance.now(), P = W();
      const todo = HOOKS.list.filter(h => h.state === WAITING || h.state === 'in');
      for (const h of todo) if (!h.slot) {              // given once: a second compile puts the same slots in
        const size = (P.slotSize(h) + 15) & ~15;
        if (HOOKS.next + size > HOOKS.END) { h.state = 'failed: the hook area is full'; warn(`hook ${h.id}: the hook area is full`); continue; }
        h.slot = HOOKS.next; HOOKS.next += size; h.orderAt = HOOKS.AREA;
      }
      // on one function, the skips go last: the other hooks there still see the call
      const go = todo.filter(h => h.slot).sort((x, y) => (x.kind === 'skip') - (y.kind === 'skip'));
      if (!go.length) throw new Error('no hooks to put in');
      const r = P.patchGame(bytes, { anchor: HOOKS.ANCHOR, hooks: go.map(h => ({ guestAddr: h.at, build: P.prologue[h.kind](h) })) });
      if (!r.results.some(x => x.ok)) throw new Error(`no hook could go in: ${r.results[0].error}`);
      const m = await realCompile.call(WebAssembly, r.bytes);
      go.forEach((h, i) => {
        const x = r.results[i];
        h.state = x.ok ? 'in' : `failed: ${x.error}`; h.funcIdx = x.ok ? x.funcIdx : null;
        if (!x.ok) warn(`hook ${h.id} at 0x${h.at.toString(16)}: ${x.error}`);
      });
      HOOKS.compiled = true; PATCH.state = 'on'; PATCH.info = r.info;
      log(`hooks in: ${go.filter(h => h.state === 'in').length} of ${go.length}, on ${r.info.patched} functions of ${r.info.functions} lifted ` +
        `(${(performance.now() - t0).toFixed(0)} ms)`, r.info, go.map(h => `${h.id} ${h.kind} 0x${h.at.toString(16)}: ${h.state}${h.funcIdx != null ? ` (#${h.funcIdx})` : ''}`));
      return m;
    } catch (e) {
      if (!HOOKS.compiled) PATCH.state = `failed: ${e.message}`;
      warn('hooks not put in, the game runs unchanged:', e);
      return realCS.call(WebAssembly, resp);
    }
  }
  for (const fn of ['compileStreaming', 'compile']) {
    const real = WebAssembly[fn];
    if (!real) continue;
    WebAssembly[fn] = function (...args) {
      saw(fn); log(`page called WebAssembly.${fn}`);
      const go = fn === 'compileStreaming' && PATCH.want && globalThis.U2WasmPatch
        ? compilePatched(args[0]) : real.apply(this, args);
      return go.then(m => {
        noteModule(m);
        if (m === module && !HOOKS.compiled) {             // the game's module, compiled without the hooks
          for (const h of HOOKS.list) if (h.state === WAITING) h.state = PATCH.want ? `failed: the game module wasn't patched (${PATCH.state})` : 'off';
        }
        return m;
      });
    };
  }
  for (const fn of ['instantiateStreaming', 'instantiate']) {
    const real = WebAssembly[fn];
    if (!real) continue;
    WebAssembly[fn] = function (...args) {
      saw(fn); log(`page called WebAssembly.${fn}`);
      return real.apply(this, args).then(r => { if (r && r.module) noteModule(r.module); return r; });
    };
  }
  WebAssembly.Module = new Proxy(WebAssembly.Module, {
    construct(target, args, newTarget) { saw('new Module'); const m = Reflect.construct(target, args, newTarget); noteModule(m); return m; },
  });

  // ---- 1b. memory made elsewhere (a worker, another frame): catch it as it passes through messages ---------
  // The page posts the Memory to the game's workers, or (WebKit) gets its buffer from the I/O worker
  // (nfsu2-web web/src/host/process.ts). Every message the page sends or reads is looked through, a few levels deep.
  const MIN_GAME_BYTES = MIN_GAME_PAGES * 65536;
  function catchMem(x, how) {
    const isMem = x instanceof RealMemory;
    const buf = isMem ? x.buffer : x;
    if (!(buf instanceof SharedArrayBuffer) || buf.byteLength < MIN_GAME_BYTES) return false;
    const cur = memory && (memory.buffer || memory);
    if (cur === buf) return true;
    if (memory && !isMem && memory instanceof RealMemory) return true;          // keep the Memory over a buffer of it
    if (cur && !isMem && buf.byteLength <= cur.byteLength) return true;         // an older, shorter buffer
    if (!memory) log(`game memory caught (${how}): ${Math.round(buf.byteLength / 1048576)} MB`);
    memory = isMem ? x : { buffer: buf };
    saw(`memory via ${how}`);
    return true;
  }
  function look(d, how, depth = 0) {
    if (!d || typeof d !== 'object' || depth > 3) return;
    if (d instanceof RealMemory || d instanceof SharedArrayBuffer) { catchMem(d, how); return; }
    if (ArrayBuffer.isView(d)) { if (d.buffer instanceof SharedArrayBuffer) catchMem(d.buffer, how); return; }
    if (d instanceof WebAssembly.Module) { noteModule(d); return; }
    const vals = Array.isArray(d) ? d.slice(0, 32) : Object.values(d).slice(0, 32);
    for (const v of vals) look(v, how, depth + 1);
  }
  const dataDesc = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'data');
  Object.defineProperty(MessageEvent.prototype, 'data', {
    ...dataDesc,
    get() { const d = dataDesc.get.call(this); try { look(d, 'message in'); } catch { /* never break the page */ } return d; },
  });
  for (const C of [typeof Worker !== 'undefined' && Worker, typeof MessagePort !== 'undefined' && MessagePort]) {
    if (!C) continue;
    const real = C.prototype.postMessage;
    C.prototype.postMessage = function (...args) { try { look(args[0], 'message out'); } catch { /* ignore */ } return real.apply(this, args); };
  }

  // ---- memory access ---------------------------------------------------------------------------------------
  let dv = null, dvBuf = null;
  function view() {
    const b = memory && memory.buffer;           // a new buffer object after each grow
    if (!b) return null;
    if (b !== dvBuf) { dvBuf = b; dv = new DataView(b); }
    return dv;
  }
  const ok = (a, n = 4) => { const v = view(); return !!v && a >= 0x10000 && a + n <= v.byteLength; };
  const mem = {
    get ready() { return !!memory; },
    get memory() { return memory; },
    ok,
    u8: a => ok(a, 1) ? dv.getUint8(a) : 0,
    u16: a => ok(a, 2) ? dv.getUint16(a, true) : 0,
    u32: a => ok(a) ? dv.getUint32(a, true) : 0,
    i32: a => ok(a) ? dv.getInt32(a, true) : 0,
    f32: a => ok(a) ? dv.getFloat32(a, true) : NaN,
    setU8: (a, x) => { if (ok(a, 1)) dv.setUint8(a, x); },
    setU16: (a, x) => { if (ok(a, 2)) dv.setUint16(a, x, true); },
    setU32: (a, x) => { if (ok(a)) dv.setUint32(a, x >>> 0, true); },
    setF32: (a, x) => { if (ok(a)) dv.setFloat32(a, x, true); },
    /** a pointer stored at a, or 0 when it points nowhere valid */
    ptr: a => { const p = mem.u32(a); return ok(p, 1) ? p : 0; },
    vec3: a => [mem.f32(a), mem.f32(a + 4), mem.f32(a + 8)],
    setVec3: (a, v) => { for (let i = 0; i < 3; i++) mem.setF32(a + 4 * i, v[i]); },
    f32s: (a, n) => Array.from({ length: n }, (_, i) => mem.f32(a + 4 * i)),
    setF32s: (a, arr) => arr.forEach((x, i) => mem.setF32(a + 4 * i, x)),
    hex: (a, n = 64) => { let s = ''; for (let i = 0; i < n; i++) s += mem.u8(a + i).toString(16).padStart(2, '0') + (i % 16 === 15 ? '\n' : ' '); return s; },
  };

  // ---- hooks, the page's side: each hook's slot (lib/wasmpatch.js says what the game's side does) -------------
  let ia = null, iaBuf = null;
  function ints() { const b = memory && memory.buffer; if (!b) return null; if (b !== iaBuf) { iaBuf = b; ia = new Int32Array(b); } return ia; }
  const aget = a => { const v = ints(); return v ? Atomics.load(v, a >> 2) >>> 0 : 0; };
  const aset = (a, x) => { const v = ints(); if (v) Atomics.store(v, a >> 2, x | 0); };
  const hookReady = h => h.state === 'in' && !HOOKS.busy && !!memory;
  const hookWanted = h => h.kind === 'write' ? h.writing && (!h.mod || h.mod.on) : h.user && (!h.mod || h.mod.on);
  /** bring the hook's slot in line with what the page wants: +8 first, then the on flag */
  function syncHook(h) {
    if (!hookReady(h)) return;
    if (h.kind === 'skip' && h.w8 !== h.eax) { aset(h.slot + 8, h.eax); h.w8 = h.eax; }
    const v = hookWanted(h) ? W().ON : 0;
    if (v !== h.written) { aset(h.slot, v); h.written = v; }
  }
  /** each frame: the slots hold only what the page wrote (and the game's counts), the rest of the area is zero.
   *  Anything else means something else uses the area: every hook off for good, nothing more written there. */
  function hooksTick(t) {
    if (!memory || !HOOKS.compiled || HOOKS.busy) return;
    const live = HOOKS.list.filter(h => h.state === 'in');
    for (const h of live) {
      if (aget(h.slot) !== h.written) return areaBusy(h.slot);
      if (aget(h.slot + 8) !== h.w8) return areaBusy(h.slot + 8);
    }
    for (let a = HOOKS.AREA + 4; a < HOOKS.AREA + 16; a += 4) if (aget(a)) return areaBusy(a);
    if (t >= HOOKS.nextScan) {
      HOOKS.nextScan = t + 250;
      for (let a = HOOKS.next; a < HOOKS.END; a += 4) if (mem.u32(a)) return areaBusy(a);
    }
    for (const h of live) syncHook(h);
  }
  function areaBusy(at) {
    HOOKS.busy = at;
    for (const h of HOOKS.list) if (h.state === 'in' && aget(h.slot) === W().ON) aset(h.slot, 0);    // only our own word back
    warn(`hooks: something else writes the hook area (at 0x${at.toString(16)}), every hook is off until the page reloads`);
  }
  /** what a mod gets in store.hooks.<name> */
  function makeHandle(h) {
    const H = {
      get name() { return h.name; }, get kind() { return h.kind; }, get at() { return h.at; },
      /** 'in', 'waiting for the game module', 'failed: …', 'too late: reload the page', 'area busy' */
      get state() { return HOOKS.busy && h.state === 'in' ? 'area busy' : h.state; },
      /** in the game and usable */
      get ready() { return hookReady(h); },
      /** the calls counted while it was on */
      count: () => hookReady(h) ? aget(h.slot + 4) : 0,
      /** when its last call came, on the order all hooks share: a later call of any hook has a higher number
       *  (compare with U2ML.after(a, b), which allows for the counter wrapping round) */
      order: () => hookReady(h) ? aget(h.slot + 12) : 0,
      /** switch it off (or back on) while its mod stays on */
      enable(on = true) { h.user = !!on; syncHook(h); },
      /** resolves with the count at the next call, or after ms. Only a notify hook (or one declared with
       *  wake: true) wakes the page; otherwise this just waits ms. since: resolve at once if the count is no
       *  longer that (a call came while the page was busy) */
      wait(ms = 1000, since) {
        const v = ints();
        if (!hookReady(h) || !h.wakes || !(v.buffer instanceof SharedArrayBuffer) || !Atomics.waitAsync) {
          return new Promise(r => setTimeout(() => r(H.count()), h.wakes ? Math.min(ms, 100) : ms));
        }
        const i = (h.slot + 4) >> 2, w = Atomics.waitAsync(v, i, since ?? Atomics.load(v, i), ms);
        return (w.async ? w.value : Promise.resolve(w.value)).then(() => H.count());
      },
    };
    if (h.kind === 'capture') {
      const size = () => W().captureEntry(h.args);
      /** call n's entry, or null: overwritten since, or being written */
      const entry = n => {
        const e = h.slot + 16 + (n & (h.keep - 1)) * size(), want = (2 * n + 2) >>> 0;
        if (aget(e) !== want) return null;
        const x = { call: n, order: mem.u32(e + 4) };
        REGS.forEach((r, i) => { x[r] = mem.u32(e + 8 + 4 * i); });
        x.ret = mem.u32(e + 44);
        x.args = Array.from({ length: h.args }, (_, i) => mem.u32(e + 48 + 4 * i));
        return aget(e) === want ? x : null;
      };
      Object.assign(H, {
        /** the last call: { call, order, eax ... edi, eip, ret, args }, or null (eip is not kept up to date by the game) */
        read() {
          for (let k = 0; k < 4; k++) { const c = H.count(); if (!c) return null; const x = entry(c - 1); if (x) return x; }
          return null;
        },
        /** the calls from number n on that the ring still holds, oldest first (call numbers start at 0) */
        since(n = 0) {
          const c = H.count(), out = [];
          for (let k = Math.max(n, c - h.keep); k < c; k++) { const x = entry(k); if (x) out.push(x); }
          return out;
        },
      });
    }
    if (h.kind === 'write') {
      const L = () => (h.L ||= W().writeLayout(h.ranges));
      const buf = i => h.slot + 16 + i * L().size;
      /** where target offset off (n bytes) goes in the buffer being filled, or 0 when no range holds it */
      const where = (off, n) => { for (const r of L()) if (off >= r.off && off + n <= r.off + r.len) return buf(1 - h.idx) + r.at + off - r.off; return 0; };
      Object.assign(H, {
        setU32(off, x) { const a = where(off, 4); if (a) mem.setU32(a, x); return !!a; },
        setF32(off, x) { const a = where(off, 4); if (a) mem.setF32(a, x); return !!a; },
        setF32s(off, arr) { let ok = true; arr.forEach((x, i) => { ok = H.setF32(off + 4 * i, x) && ok; }); return ok; },
        setVec3(off, v) { return H.setF32s(off, v); },
        setBytes(off, bytes) { const a = where(off, bytes.length); if (a) new Uint8Array(memory.buffer, a, bytes.length).set(bytes); return !!a; },
        /** what has been set goes to the game from its next call on, and stays there until off() */
        commit() {
          if (!hookReady(h)) return false;
          h.idx = 1 - h.idx; aset(h.slot + 8, h.idx); h.w8 = h.idx;
          new Uint8Array(memory.buffer).copyWithin(buf(1 - h.idx), buf(h.idx), buf(h.idx) + L().size);   // the next fill starts from it
          h.writing = true; syncHook(h);
          return true;
        },
        /** the game's own values again */
        off() { h.writing = false; syncHook(h); },
        get writing() { return h.writing; },
      });
    }
    if (h.kind === 'skip') H.result = eax => { h.eax = eax >>> 0; syncHook(h); };
    return H;
  }
  // the loader's own hook: the camera, copied in as the frame's main view is made (see cam.set)
  const camHook = declareHook(null, { name: 'camera', kind: 'write', at: 0x005c7ec0, to: { ptr: 0x00832e50 + 0x40 },
    // the camera's matrix, eye, forward and target; and its velocity (+0x1E0, m/s), which the rain moves its drops
    // and lens drops by (nfsu2-web runtime/framerate.c F6)
    ranges: [[0x00, 0x70], [0x1e0, 12]] }).handle;

  // ---- game helpers (addresses from nfsu2-web runtime/game.h, look.c, photo.c, splitscreen_mem.h) ----------
  const ADDR = {
    FLOW: 0x008654a4,     // game flow state: 3 front end, 4/5 loading, 6 in the world
    RACE: 0x00890118,     // -> race status: +0 its state (3 countdown, 4 racing, free roam too, 6 paused)
    PLAYER1: 0x00d00000,  // -> player 1 (the web build's relocated players array)
    VIEW1: 0x00832e50,    // eView 1, the main view: +0x40 -> its camera
    MOTION_BLUR: 0x00870cdc,  // g_MotionBlurEnable, the Motion Blur option (photo.c)
  };
  const OFF = {
    PL_CAR: 0x4, PL_MOVER: 0x238, MV_TYPE: 0xc,          // player: car, camera mover (type 1 drive cameras, 2 debug/photo)
    CAR_POS: 0x60,                                        // car: its centre, world
    VIEW_CAM: 0x40,
    CAM_MATRIX: 0x00, CAM_EYE: 0x40, CAM_FWD: 0x50, CAM_TARGET: 0x60, CAM_FOV: 0xc4, CAM_VEL: 0x1e0,   // camera (fov: u16 binary angle)
  };
  const game = {
    ADDR, OFF,
    flow: () => mem.u32(ADDR.FLOW),
    inWorld: () => mem.u32(ADDR.FLOW) === 6,
    raceState: () => { const r = mem.ptr(ADDR.RACE); return r ? mem.u32(r) : -1; },
    player: () => mem.ptr(ADDR.PLAYER1),
    car: () => { const p = game.player(); return p ? mem.ptr(p + OFF.PL_CAR) : 0; },
    carPos: () => { const c = game.car(); return c ? mem.vec3(c + OFF.CAR_POS) : null; },
    moverType: () => { const p = game.player(), m = p ? mem.ptr(p + OFF.PL_MOVER) : 0; return m ? mem.u32(m + OFF.MV_TYPE) : -1; },
    camera: () => mem.ptr(ADDR.VIEW1 + OFF.VIEW_CAM),
    fovDeg: () => { const c = game.camera(); return c ? mem.u16(c + OFF.CAM_FOV) * 360 / 65536 : NaN; },
    /** driving with the game's own drive camera: where a camera mod may take over */
    driving: () => game.inWorld() && game.moverType() === 1 && !!game.car() && !!game.camera(),
  };

  // ---- vector maths ----------------------------------------------------------------------------------------
  const v3 = {
    add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
    sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
    scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
    dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
    cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
    len: a => Math.hypot(a[0], a[1], a[2]),
    norm: a => { const l = Math.hypot(a[0], a[1], a[2]); return l > 1e-9 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0]; },
    lerp: (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t],
  };

  // ---- the camera's matrix ---------------------------------------------------------------------------------
  // The camera holds a 4x4 matrix (+0x00), its eye (+0x40), forward (+0x50) and the point it looks at (+0x60);
  // the frame's views are made from the matrix (overrides.c sub_005c7ec0). Its exact convention isn't written
  // down anywhere, so the loader works it out: while the game drives its own camera, it builds every candidate
  // convention from the game's eye and target and keeps the one that reproduces the game's matrix.
  const PERMS = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  function buildMatrix(L, eye, target, up) {
    const f = v3.norm(v3.sub(target, eye));
    let r = v3.norm(v3.cross(f, up));
    if (v3.len(r) < 0.5) r = v3.norm(v3.cross(f, Math.abs(f[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0]));
    const u = v3.cross(r, f), b = [r, u, f];
    const A = [0, 1, 2].map(k => v3.scale(b[L.perm[k]], L.sign[k]));
    const M = new Array(16).fill(0);
    for (let k = 0; k < 3; k++) for (let i = 0; i < 3; i++) {
      if (L.kind === 'view') M[i * 4 + k] = A[k][i];      // columns are the axes, translation -axis.eye
      else M[k * 4 + i] = A[k][i];                         // rows are the axes, translation the eye
    }
    for (let k = 0; k < 3; k++) M[12 + k] = L.kind === 'view' ? -v3.dot(A[k], eye) : eye[k];
    M[15] = 1;
    if (L.transpose) for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) { const t = M[i * 4 + j]; M[i * 4 + j] = M[j * 4 + i]; M[j * 4 + i] = t; }
    return M;
  }
  function matchError(M, G, eye) {
    let rot = 0, tr = 0;
    const s = 1 + v3.len(eye);
    for (let i = 0; i < 16; i++) {
      const d = Math.abs(M[i] - G[i]);
      if (i === 3 || i === 7 || i === 11 || i >= 12) tr = Math.max(tr, d / s); else rot = Math.max(rot, d);
    }
    return Math.max(rot, tr);
  }
  /** the best convention for one sample of the game's own camera: { layout, err } */
  function calibrateSample(G, eye, target, up = [0, 0, 1]) {
    let best = null;
    for (const kind of ['view', 'world']) for (const perm of PERMS) for (let s = 0; s < 8; s++) for (const transpose of [false, true]) {
      const L = { kind, perm, sign: [s & 1 ? -1 : 1, s & 2 ? -1 : 1, s & 4 ? -1 : 1], transpose };
      const err = matchError(buildMatrix(L, eye, target, up), G, eye);
      if (!best || err < best.err) best = { layout: L, err };
    }
    return best;
  }

  const LAYOUT_KEY = 'u2ml:camlayout:v1';
  const CAL_OK = 0.05, CAL_NEED = 30;
  const cam = {
    layout: load(LAYOUT_KEY, null),
    calibration: { samples: 0, hits: 0, last: null },
    wrote: null,                                          // the eye last written (to tell our frame from the game's)
    writtenThisFrame: false,
    /** the game's own camera this frame (eye, target, forward, matrix), or null when the camera holds ours */
    gameCamera() {
      const c = game.camera();
      if (!c) return null;
      const eye = mem.vec3(c + OFF.CAM_EYE);
      if (cam.wrote && eye.every((x, i) => Math.fround(x) === Math.fround(cam.wrote[i]))) return null;
      return { eye, target: mem.vec3(c + OFF.CAM_TARGET), fwd: mem.vec3(c + OFF.CAM_FWD), matrix: mem.f32s(c + OFF.CAM_MATRIX, 16) };
    },
    /** put the camera at eye, looking at target, with up as the picture's up (needs the layout) */
    set(eye, target, up = [0, 0, 1]) {
      const c = game.camera();
      if (!c || !cam.layout) return false;
      const M = buildMatrix(cam.layout, eye, target, up), fwd = v3.norm(v3.sub(target, eye));
      if (camHook.ready) {
        // through the hook: the game thread copies it in as it makes the frame's view (no flicker)
        camHook.setF32s(OFF.CAM_MATRIX, M);
        camHook.setVec3(OFF.CAM_EYE, eye); camHook.setU32(0x4c, mem.u32(c + 0x4c));   // with the game's padding
        camHook.setVec3(OFF.CAM_FWD, fwd); camHook.setU32(0x5c, mem.u32(c + 0x5c));
        camHook.setVec3(OFF.CAM_TARGET, target); camHook.setU32(0x6c, mem.u32(c + 0x6c));
        // our camera's own velocity, from its last place (smoothed: the page's frames are not the game's)
        const now = performance.now(), lp = cam.lastEye;
        const vNow = lp && now > lp.t ? v3.scale(v3.sub(eye, lp.eye), 1000 / (now - lp.t)) : [0, 0, 0];
        cam.vel = lp && lp.vel ? v3.lerp(lp.vel, vNow, 0.5) : vNow;
        if (!cam.vel.every(Number.isFinite) || v3.len(cam.vel) > 200) cam.vel = [0, 0, 0];
        cam.lastEye = { eye: eye.slice(), t: now, vel: cam.vel };
        camHook.setVec3(OFF.CAM_VEL, cam.vel);
        camHook.commit();
        cam.viaHook = true;
      } else {
        mem.setF32s(c + OFF.CAM_MATRIX, M);
        mem.setVec3(c + OFF.CAM_EYE, eye);
        mem.setVec3(c + OFF.CAM_FWD, fwd);
        mem.setVec3(c + OFF.CAM_TARGET, target);
      }
      // The game's motion blur off while a mod's camera shows, as photo mode does (nfsu2-web runtime/photo.c
      // G_MOTION_BLUR): the game still moves its own camera each frame before the hook puts ours in, and blurs
      // by that move. U2ML.camera.keepBlur = true leaves it as the player set it.
      if (!cam.keepBlur && cam.blurWas == null) { cam.blurWas = mem.u32(ADDR.MOTION_BLUR); mem.setU32(ADDR.MOTION_BLUR, 0); }
      cam.wrote = eye.slice();
      cam.writtenThisFrame = true;
      cam.pending = { c, M, eye, target, t: performance.now() };
      return true;
    },
    recalibrate() { cam.layout = null; cam.calibration = { samples: 0, hits: 0, last: null }; save(LAYOUT_KEY, null); log('camera calibration reset: drive for a second with the game\'s own camera'); },
    // experimental: rewrite the last camera as often as the page lets us, to win more of the race with the game
    // thread (it rewrites the camera every frame). Costs a CPU core. U2ML.camera.pump = true
    pump: false,
    keepBlur: false,
    blurWas: null,                 // the player's Motion Blur option while a mod's camera turned it off
  };
  function calibrateTick() {
    if (cam.layout || !game.driving() || cam.writer || cam.writtenThisFrame) return;
    const g = cam.gameCamera();
    if (!g || v3.len(v3.sub(g.target, g.eye)) < 0.1) return;
    const r = calibrateSample(g.matrix, g.eye, g.target);
    const C = cam.calibration;
    C.samples++; C.last = { ...r, game: g };
    if (r.err < CAL_OK && JSON.stringify(r.layout) === JSON.stringify(C.cand)) C.hits++;
    else if (r.err < CAL_OK) { C.cand = r.layout; C.hits = 1; }
    if (C.hits >= CAL_NEED) {
      cam.layout = C.cand; save(LAYOUT_KEY, cam.layout);
      log('camera layout found', cam.layout, `(error ${r.err.toExponential(2)})`);
    } else if (C.samples === 300) {
      warn('camera layout not found after 300 frames. Best guess and the game\'s camera:', C.last,
        '\nPaste this into the chat so the layout can be worked out by hand.');
    }
  }
  // ---- the car's own axes and velocity (for the cameras) -----------------------------------------------------
  // The car: +0x60 its centre, +0x70 its velocity (m/s), +0x90/+0xA0/+0xB0 its orientation's three unit rows
  // (nfsu2-web runtime/roam_game.c car_sane). Which row points forward is learnt while the car drives: the
  // row that lines up with where it goes (found on the live site: row 0).
  const AXES_KEY = 'u2ml:caraxes:v2', CAR_VEL = 0x70, CAR_ROWS = 0x90;
  const axes = { found: load(AXES_KEY, null), votes: new Map() };
  const carRows = car => [0, 1, 2].map(k => mem.vec3(car + CAR_ROWS + 16 * k));
  function orthonormal(R) {
    for (let k = 0; k < 3; k++) if (!(Math.abs(v3.len(R[k]) - 1) < 0.02)) return false;
    return Math.abs(v3.dot(R[0], R[1])) < 0.02 && Math.abs(v3.dot(R[0], R[2])) < 0.02 && Math.abs(v3.dot(R[1], R[2])) < 0.02;
  }
  game.carVel = () => { const c = game.car(); return c ? mem.vec3(c + CAR_VEL) : null; };
  game.carRows = () => { const c = game.car(), R = c ? carRows(c) : null; return R && orthonormal(R) ? R : null; };
  game.carForward = () => {
    const F = axes.found, R = F && game.carRows();
    return R ? v3.scale(R[F.row], F.sign) : null;
  };
  function axesTick() {
    if (axes.found || !game.driving()) return;
    const R = game.carRows(), vel = game.carVel();
    if (!R || !vel || !(v3.len(vel) >= 5)) return;       // 18 km/h and up
    const dir = v3.norm(vel);
    for (let k = 0; k < 3; k++) {
      const d = v3.dot(R[k], dir);
      if (Math.abs(d) < 0.9) continue;
      const key = `${k}:${d > 0 ? 1 : -1}`, n = (axes.votes.get(key) || 0) + 1;
      axes.votes.set(key, n);
      if (n >= 60) {
        axes.found = { row: k, sign: d > 0 ? 1 : -1 };
        save(AXES_KEY, axes.found);
        log(`car axes found: forward is row ${k}${d > 0 ? '' : ' (negated)'} of car+0x90`);
      }
      return;
    }
  }

  const pumpCh = new MessageChannel();
  pumpCh.port1.onmessage = () => {
    const p = cam.pending;
    if (!cam.pump || !p || performance.now() - p.t > 50) return;
    mem.setF32s(p.c + OFF.CAM_MATRIX, p.M); mem.setVec3(p.c + OFF.CAM_EYE, p.eye); mem.setVec3(p.c + OFF.CAM_TARGET, p.target);
    pumpCh.port2.postMessage(0);
  };

  // ---- storage (the site's origin: every key starts with u2ml:) --------------------------------------------
  function load(k, def) { try { const s = localStorage.getItem(k); return s == null ? def : JSON.parse(s); } catch { return def; } }
  function save(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch { /* private window */ } }

  // ---- mods ------------------------------------------------------------------------------------------------
  const mods = new Map();
  const api = { VERSION, mem, game, v3, camera: cam, log, warn,
    /** a is later than b on the hooks' shared order (allows for the counter wrapping round) */
    after: (a, b) => ((a - b) | 0) > 0 };
  // ---- mod options -----------------------------------------------------------------------------------------
  // A mod lists them in def.options:
  //   { key, label, type: 'number', min, max, step, default, unit }      a slider
  //   { key, label, type: 'bool', default }                              a switch
  //   { key, label, type: 'choice', choices: [{ value, label }], default }  a list to pick from
  // The mod reads them with store.get(key) (the default when the player changed nothing) and may have
  // onOption(key, value, api, store) called on each change. The panel's ⚙ beside the mod shows them.
  function optValue(o, v) {
    if (o.type === 'bool') return !!v;
    if (o.type === 'choice') return (o.choices || []).some(c => c.value === v) ? v : o.default;
    let x = Number(v);
    if (!Number.isFinite(x)) return o.default;
    if (o.min != null) x = Math.max(o.min, x);
    if (o.max != null) x = Math.min(o.max, x);
    if (o.step) x = Math.round(x / o.step) * o.step;
    return +x.toFixed(6);
  }
  const optText = (o, v) => {
    if (o.type === 'bool') return v ? 'on' : 'off';
    if (o.type === 'choice') return (o.choices || []).find(c => c.value === v)?.label ?? String(v);
    const dec = o.step ? Math.max(0, Math.min(4, Math.ceil(-Math.log10(o.step)))) : 2;
    return `${Number(v).toFixed(dec)}${o.unit ? ' ' + o.unit : ''}`;
  };

  function register(def) {
    if (!def || !/^[a-z0-9_-]+$/.test(def.id || '')) { warn('register: a mod needs an id of a-z, 0-9, _ and -', def); return; }
    if (mods.has(def.id)) { warn(`register: ${def.id} is already loaded`); return; }
    const opts = new Map((def.options || []).filter(o => o && o.key).map(o => [o.key, o]));
    const m = { def, on: false, opts, hooks: {}, store: {
      /** the mod's hooks by name (def.hooks): store.hooks.view.count() ... */
      hooks: null,
      /** a value: the player's, else the option's default (or d) */
      get: (k, d) => load(`u2ml:${def.id}:${k}`, d !== undefined ? d : opts.get(k)?.default),
      /** set a value (an option's is kept within its range), tells the mod and the panel */
      set: (k, v) => {
        const o = opts.get(k);
        if (o) v = optValue(o, v);
        save(`u2ml:${def.id}:${k}`, v);
        if (o) {
          try { def.onOption?.(k, v, api, m.store); } catch (e) { warn(`${def.id} onOption`, e); }
          panel.syncOption(def.id, k, v);
        }
        return v;
      },
      /** every option back to its default */
      reset: () => { for (const o of opts.values()) { save(`u2ml:${def.id}:${o.key}`, null); m.store.set(o.key, o.default); } },
      /** all option values, { key: value } */
      all: () => Object.fromEntries([...opts.keys()].map(k => [k, m.store.get(k)])),
    } };
    m.store.hooks = m.hooks;
    for (const d of Array.isArray(def.hooks) ? def.hooks : []) {
      const h = declareHook(m, d);
      if (h.name && !m.hooks[h.name]) m.hooks[h.name] = h.handle;
      else if (h.name) warn(`${def.id}: two hooks are named ${h.name}`);
    }
    m.runOn = runOnOf(m);
    mods.set(def.id, m);
    try { def.init?.(api, m.store); } catch (e) { warn(`${def.id} init`, e); }
    setEnabled(def.id, load(`u2ml:on:${def.id}`, !!def.defaultOn), false);
    log(`mod loaded: ${def.name || def.id}`);
    panel.rebuild();
  }
  function setEnabled(id, on, remember = true) {
    const m = mods.get(id);
    if (!m || m.on === !!on) return;
    // one mod of a group at a time (the cameras: group 'camera')
    if (on && m.def.group) for (const o of mods.values()) if (o !== m && o.on && o.def.group === m.def.group) setEnabled(o.def.id, false);
    m.on = !!on;
    for (const h of HOOKS.list) if (h.mod === m) { if (!m.on) h.writing = false; syncHook(h); }
    try { (on ? m.def.enable : m.def.disable)?.(api, m.store); } catch (e) { warn(`${id} ${on ? 'enable' : 'disable'}`, e); }
    if (remember) save(`u2ml:on:${id}`, m.on);
    log(`${m.def.name || id} ${m.on ? 'on' : 'off'}`);
    panel.rebuild();
  }

  // ---- the frames: the screen's and the game's ---------------------------------------------------------------
  // The page's animation frames come at the screen's rate; the game makes its frames on its own thread at its own
  // rate. GameLoop (0x5811C0) calls the empty 0x4022C0 once a frame, returning to 0x581475 (nfsu2-web
  // runtime/career.c), and the loader's frame hook there wakes the page. A mod runs on the screen's frames unless
  // it asks for the game's (def.runOn: 'game', or U2ML.runOn(id, 'game')): then once a game frame, as soon as the
  // page hears of it, while the hook works; on the screen's frames when it doesn't.
  const frameHook = declareHook(null, { name: 'frame', kind: 'notify', at: 0x004022c0, ret: 0x00581475 }).handle;
  const GF = { count: 0, t: 0, lastWake: -1e9, frames: 0, runs: 0, missed: 0, rate: null, from: 0 };
  const SF = { last: performance.now(), frames: 0, rate: null, from: 0 };
  const gameLive = () => frameHook.ready && performance.now() - GF.lastWake < 250;
  const runOnOf = m => load(`u2ml:runon:${m.def.id}`, m.def.runOn === 'game' ? 'game' : 'screen');
  /** where a mod's frame runs now: 'game' or 'screen' */
  const loopOf = m => m.runOn === 'game' && gameLive() ? 'game' : 'screen';
  function runMods(loop, dt, info) {
    cam.writtenThisFrame = false;
    for (const m of mods.values()) {
      if (!m.on || !m.def.frame || loopOf(m) !== loop) continue;
      try { m.def.frame(api, dt, m.store, info); }
      catch (e) { warn(`${m.def.id} frame failed, turned off`, e); setEnabled(m.def.id, false, false); }
    }
    // the camera: a loop's mods wrote it, or the game's own comes back. A loop leaves it to the other loop's
    // mods while they write it (and while the game's frames still come, for the game loop's).
    if (cam.writtenThisFrame) { cam.writer = loop; if (cam.pump && !cam.viaHook) pumpCh.port2.postMessage(0); return; }
    if (cam.writer && cam.writer !== loop && !(cam.writer === 'game' && !gameLive())) return;
    cam.writer = null;
    cam.wrote = null;
    if (cam.viaHook) { camHook.off(); cam.viaHook = false; cam.lastEye = null; }      // the game's camera back
    if (cam.blurWas != null) {                                                 // and the player's motion blur
      if (mem.u32(ADDR.MOTION_BLUR) === 0) mem.setU32(ADDR.MOTION_BLUR, cam.blurWas);
      cam.blurWas = null;
    }
  }
  function tick(t) {
    const dt = Math.min(0.1, Math.max(0, (t - SF.last) / 1000)); SF.last = t; SF.frames++;
    if (t - SF.from >= 1000) { SF.rate = SF.frames * 1000 / (t - SF.from); SF.frames = 0; SF.from = t; }
    if (memory) {
      try { hooksTick(t); } catch (e) { warn('hooks', e); }
      try { calibrateTick(); } catch (e) { warn('calibration', e); }
      runMods('screen', dt, { on: 'screen' });
      try { axesTick(); } catch (e) { warn('car axes', e); }
    }
    panel.update(t);
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  // the game's frames: the frame hook's count, waited on (a frame that came while the page was busy wakes it at once)
  async function gameLoop() {
    for (;;) {
      const c = await frameHook.wait(250, GF.count);
      if (!frameHook.ready || c === GF.count) continue;
      const now = performance.now(), n = (c - GF.count) >>> 0;
      const first = !GF.t || now - GF.t > 250;
      if (!first) { GF.frames += n; GF.runs++; if (n > 1) GF.missed += n - 1; }
      const dt = first ? 0 : Math.min(0.1, (now - GF.t) / 1000);
      GF.count = c; GF.t = now; GF.lastWake = now;
      if (now - GF.from >= 1000) { GF.rate = { frames: GF.frames * 1000 / (now - GF.from), runs: GF.runs * 1000 / (now - GF.from), missed: GF.missed }; GF.frames = GF.runs = GF.missed = 0; GF.from = now; }
      try { runMods('game', dt, { on: 'game', frame: c, order: frameHook.order() }); } catch (e) { warn('game frame', e); }
    }
  }
  gameLoop();

  // ---- hotkeys ---------------------------------------------------------------------------------------------
  const combo = e => (e.ctrlKey ? 'Ctrl+' : '') + (e.altKey ? 'Alt+' : '') + (e.shiftKey ? 'Shift+' : '') + e.code;
  const swallowed = new Set();
  function keyAction(c) {
    if (c === 'Alt+Shift+KeyM') return () => panel.toggle();
    // a key two mods share goes to the one that is on
    const all = [...mods.values()], m = all.find(x => x.on && x.def.keys?.[c]) || all.find(x => x.def.keys?.[c]);
    if (!m) return null;
    const k = m.def.keys[c];
    return () => k(api, m.store, { toggle: () => setEnabled(m.def.id, !m.on), on: m.on });
  }
  // keys pressed on the panel's controls stay there (the game never sees them)
  const onPanel = e => !!panel.el && e.target instanceof Node && panel.el.contains(e.target);
  for (const t of ['keydown', 'keyup', 'keypress']) window.addEventListener(t, e => { if (onPanel(e)) e.stopImmediatePropagation(); }, true);
  window.addEventListener('keydown', e => {
    if (onPanel(e)) return;
    const f = keyAction(combo(e));
    if (!f) return;
    e.preventDefault(); e.stopImmediatePropagation(); swallowed.add(e.code);
    if (!e.repeat || combo(e) !== 'Alt+Shift+KeyM') try { f(); } catch (err) { warn('hotkey', err); }
  }, true);
  window.addEventListener('keyup', e => {
    if (swallowed.delete(e.code)) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);

  /** the panel's hooks line */
  function hooksLine() {
    if (!PATCH.want) return 'switched off (u2ml:patch)';
    if (HOOKS.busy) return `off: something else uses the hook area (0x${HOOKS.busy.toString(16)})`;
    if (!HOOKS.compiled) return PATCH.state;
    const bad = HOOKS.list.filter(h => h.state !== 'in');
    return `${HOOKS.list.length - bad.length} in` + (bad.length ? `; not in: ${bad.map(h => `${h.id} (${h.state})`).join(', ')}` : '');
  }
  /** the panel's frames line: the screen's rate, the game's, and the mods on the game's */
  function framesLine() {
    const r = n => n == null ? '-' : n.toFixed(0);
    const onGame = [...mods.values()].filter(m => m.on && m.def.frame && m.runOn === 'game').map(m => m.def.id);
    const g = GF.rate && gameLive() ? `game ${r(GF.rate.frames)}/s${GF.rate.missed ? ` (${GF.rate.missed} missed)` : ''}` : `game ${frameHook.ready ? 'waiting' : 'no hook'}`;
    return `screen ${r(SF.rate)}/s  ${g}${onGame.length ? `  on it: ${onGame.join(' ')}${gameLive() ? '' : ' (on the screen\'s for now)'}` : ''}`;
  }
  /** every hook, for the console: U2ML.hooks() */
  function hooksTable() {
    return HOOKS.list.map(h => ({ hook: h.id, kind: h.kind, at: h.at != null ? '0x' + (h.at >>> 0).toString(16) + (h.ret != null ? ` from 0x${h.ret.toString(16)}` : '') : '-', state: h.handle.state,
      on: hookReady(h) && h.written !== 0, calls: h.handle.count(), slot: h.slot ? '0x' + h.slot.toString(16) : '-', func: h.funcIdx }));
  }

  // ---- the panel (styled through the CSSOM: the site's CSP allows no inline style sheets) -----------------
  const panel = {
    el: null, status: null, list: null, shown: load('u2ml:panel', true), next: 0,
    make() {
      if (panel.el || !document.body) return !!panel.el;
      if (window !== window.top && innerWidth < 400) return false;     // small frames (ads, embeds) get no panel
      const el = document.createElement('div');
      el.style.cssText = 'position:fixed;top:8px;left:8px;z-index:2147483647;background:rgba(10,12,16,.85);color:#dfe;' +
        'font:12px/1.4 ui-monospace,Menlo,monospace;padding:8px 12px;border-radius:8px;width:380px;max-width:calc(100vw - 16px);' +
        'max-height:calc(100vh - 16px);overflow-y:auto;box-sizing:border-box;user-select:none;';
      const title = document.createElement('div');
      title.textContent = `U2 Mod Loader ${VERSION}  (Alt+Shift+M hides)`;
      title.style.cssText = 'font-weight:bold;margin-bottom:4px;color:#8cf;';
      panel.list = document.createElement('div');
      panel.status = document.createElement('pre');
      panel.status.style.cssText = 'margin:4px 0 0;white-space:pre-wrap;color:#9ab;';
      el.append(title, panel.list, panel.status);
      el.addEventListener('mousedown', e => e.stopPropagation());
      panel.el = el;
      (document.fullscreenElement || document.body).append(el);
      panel.rebuild();
      return true;
    },
    open: new Set(load('u2ml:panel:open', [])),   // the mods whose options show
    controls: new Map(),                          // `${id}:${key}` -> its control, to follow changes made elsewhere
    rebuild() {
      if (!panel.list) return;
      panel.el.style.display = panel.shown ? '' : 'none';
      panel.controls.clear();
      panel.list.replaceChildren(...[...mods.values()].flatMap(m => {
        const head = document.createElement('div');
        head.style.cssText = 'display:flex;align-items:center;gap:4px;';
        const label = document.createElement('label');
        label.style.cssText = 'flex:1;cursor:pointer;';
        const cb = document.createElement('input');
        cb.type = 'checkbox'; cb.checked = m.on; cb.tabIndex = -1;
        cb.addEventListener('change', () => { setEnabled(m.def.id, cb.checked); cb.blur(); });
        const short = { Equal: '=', Minus: '-', BracketLeft: '[', BracketRight: ']', Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", Backquote: '`' };
        const keys = Object.keys(m.def.keys || {})
          .map(k => k.replace(/Key|Digit/g, '').replace(/[A-Z][a-z]+[A-Za-z]*$/, w => short[w] || w)).join(' ');
        label.append(cb, ` ${m.def.name || m.def.id}`);
        if (keys) { const k = document.createElement('span'); k.textContent = `  ${keys}`; k.style.cssText = 'color:#678;'; label.append(k); }
        head.append(label);
        if (!m.opts.size) return [head];
        const open = panel.open.has(m.def.id);
        const gear = panel.button(open ? '⚙ ▾' : '⚙ ▸', () => {
          open ? panel.open.delete(m.def.id) : panel.open.add(m.def.id);
          save('u2ml:panel:open', [...panel.open]); panel.rebuild();
        });
        head.append(gear);
        return open ? [head, panel.optionsBox(m)] : [head];
      }));
    },
    button(text, onClick) {
      const b = document.createElement('button');
      b.textContent = text; b.tabIndex = -1;
      b.style.cssText = 'background:#223;color:#9cf;border:1px solid #345;border-radius:4px;font:inherit;padding:0 6px;cursor:pointer;';
      b.addEventListener('click', () => { onClick(); b.blur(); });
      return b;
    },
    optionsBox(m) {
      const box = document.createElement('div');
      box.style.cssText = 'margin:2px 0 6px 20px;padding:4px 8px;border-left:2px solid #345;';
      for (const o of m.opts.values()) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:6px;min-height:20px;';
        const name = document.createElement('span');
        name.textContent = o.label || o.key; name.style.cssText = 'flex:1;color:#bcd;';
        if (o.help) name.title = o.help;
        const val = document.createElement('span');
        val.style.cssText = 'width:64px;text-align:right;color:#dfe;';
        let input;
        const done = () => input.blur();          // focus back to the game: its keys drive the car again
        if (o.type === 'bool') {
          input = document.createElement('input'); input.type = 'checkbox';
          input.addEventListener('change', () => { m.store.set(o.key, input.checked); done(); });
        } else if (o.type === 'choice') {
          input = document.createElement('select');
          input.style.cssText = 'background:#112;color:#dfe;border:1px solid #345;font:inherit;max-width:120px;';
          for (const c of o.choices || []) { const op = document.createElement('option'); op.value = JSON.stringify(c.value); op.textContent = c.label; input.append(op); }
          input.addEventListener('change', () => { m.store.set(o.key, JSON.parse(input.value)); done(); });
        } else {
          input = document.createElement('input'); input.type = 'range';
          input.min = String(o.min ?? 0); input.max = String(o.max ?? 1); input.step = String(o.step ?? 'any');
          input.style.cssText = 'width:110px;';
          input.addEventListener('input', () => m.store.set(o.key, input.value));
          input.addEventListener('change', done);
        }
        input.tabIndex = -1;
        if (o.type === 'number') row.append(name, input, val); else row.append(name, input);   // a switch or a list shows its own value
        box.append(row);
        panel.controls.set(`${m.def.id}:${o.key}`, { o, input, val });
        panel.syncOption(m.def.id, o.key, m.store.get(o.key));
      }
      const foot = document.createElement('div');
      foot.style.cssText = 'margin-top:4px;text-align:right;';
      foot.append(panel.button('reset', () => m.store.reset()));
      box.append(foot);
      return box;
    },
    syncOption(id, key, v) {
      const c = panel.controls.get(`${id}:${key}`);
      if (!c) return;
      if (c.o.type === 'bool') c.input.checked = !!v;
      else if (c.o.type === 'choice') c.input.value = JSON.stringify(v);
      else if (document.activeElement !== c.input) c.input.value = String(v);
      c.val.textContent = optText(c.o, v);
    },
    toggle() { panel.shown = !panel.shown; save('u2ml:panel', panel.shown); panel.rebuild(); },
    update(t) {
      if (!panel.make() || !panel.shown || t < panel.next) return;
      panel.next = t + 250;
      const f = n => Number.isFinite(n) ? n.toFixed(1) : '-';
      const lines = [];
      lines.push(`memory  ${memory ? Math.round(memory.buffer.byteLength / 1048576) + ' MB' : 'not caught (reload with the extension on)'}`);
      lines.push(`module  ${module ? `names ${hasNames ? 'kept' : 'stripped'}` : '-'}`);
      lines.push(`hooks   ${hooksLine()}`);
      lines.push(`frames  ${framesLine()}`);
      if (memory) {
        const p = game.carPos(), c = game.camera();
        lines.push(`flow ${game.flow()}  race ${game.raceState()}  mover ${game.moverType()}  driving ${game.driving() ? 'yes' : 'no'}`);
        lines.push(`car     ${p ? p.map(f).join(' ') : '-'}`);
        lines.push(`eye     ${c ? mem.vec3(c + OFF.CAM_EYE).map(f).join(' ') : '-'}  fov ${f(game.fovDeg())}`);
        const C = cam.calibration;
        lines.push(`camera  ${cam.layout ? 'layout known' : game.driving() ? `learning (${C.hits}/${CAL_NEED}, err ${C.last ? C.last.err.toExponential(1) : '-'})` : 'learning: start driving'}`);
        lines.push(`car fwd ${axes.found ? (game.carForward() || []).map(x => x.toFixed(2)).join(' ') || 'lost' : 'learning: drive straight, 20+ km/h'}`);
        for (const m of mods.values()) if (m.on && m.def.status) try { lines.push(String(m.def.status(api, m.store))); } catch { /* a mod's line */ }
      }
      panel.status.textContent = lines.join('\n');
    },
  };
  document.addEventListener('fullscreenchange', () => {
    if (!panel.el) return;
    const host = document.fullscreenElement;
    (host && !(host instanceof HTMLCanvasElement) ? host : document.body).append(panel.el);
  });

  // ---- memory scanning, for finding values by trial and error ----------------------------------------------
  //   U2ML.scan.f32(55.2, 0.1)        every float near 55.2 (default range: the game's own data, 0x400000-0x1000000)
  //   U2ML.scan.next(x => x > 60)     keep the previous hits whose value now passes the test
  //   U2ML.scan.changed() / .same()   keep those that changed / stayed since the last scan
  const scan = {
    hits: [], prev: new Map(),
    f32(value, tol = 0.01, lo = 0x400000, hi = 0x1000000) {
      const v = view(); if (!v) return [];
      hi = Math.min(hi, v.byteLength - 4);
      const out = [];
      for (let a = lo; a <= hi; a += 4) { const x = v.getFloat32(a, true); if (Math.abs(x - value) <= tol) out.push(a); if (out.length > 100000) break; }
      return scan._keep(out);
    },
    u32(value, lo = 0x400000, hi = 0x1000000) {
      const v = view(); if (!v) return [];
      hi = Math.min(hi, v.byteLength - 4);
      const out = [];
      for (let a = lo; a <= hi; a += 4) if (v.getUint32(a, true) === value >>> 0) { out.push(a); if (out.length > 100000) break; }
      return scan._keep(out);
    },
    next(test, read = mem.f32) { return scan._keep(scan.hits.filter(a => test(read(a), scan.prev.get(a)))); },
    changed(read = mem.f32) { return scan.next((x, p) => x !== p, read); },
    same(read = mem.f32) { return scan.next((x, p) => x === p, read); },
    _keep(list) {
      scan.hits = list; scan.prev = new Map(list.map(a => [a, mem.f32(a)]));
      log(`scan: ${list.length} hits${list.length && list.length <= 20 ? ': ' + list.map(a => '0x' + a.toString(16)).join(' ') : ''}`);
      return list.length <= 200 ? list.map(a => '0x' + a.toString(16)) : list.length;
    },
  };

  window.U2ML = Object.freeze({
    VERSION, register, setEnabled, mods, mem, game, v3, camera: cam, scan,
    /** a mod's option values, or set one: U2ML.options('drone'), U2ML.options('drone', 'dist', 15) */
    options: (id, key, value) => { const m = mods.get(id); if (!m) return null; if (key !== undefined) return m.store.set(key, value); return m.store.all(); },
    status: () => ({ memory: !!memory, module: !!module, hasNames, hooks: hooksLine(), frames: framesLine(), flow: game.flow(), driving: game.driving(), layout: cam.layout }),
    /** where a mod's frame runs: U2ML.runOn('drone') -> 'game' | 'screen'; U2ML.runOn('drone', 'game') sets it */
    runOn: (id, where) => {
      const m = mods.get(id); if (!m) return null;
      if (where !== undefined) { m.runOn = where === 'game' ? 'game' : 'screen'; save(`u2ml:runon:${id}`, m.runOn); log(`${id} runs on the ${m.runOn}'s frames`); }
      return m.runOn;
    },
    /** a is later than b on the hooks' shared order (allows for the counter wrapping round) */
    after: (a, b) => ((a - b) | 0) > 0,
    /** the frame rates: { screen, game: { frames, runs, missed } } per second */
    frames: () => ({ screen: SF.rate, game: gameLive() ? GF.rate : null }),
    /** every hook: its mod, address, kind, state and calls */
    hooks: () => { const t = hooksTable(); try { console.table(t); } catch { /* no table */ } return t; },
    _test: { buildMatrix, calibrateSample },
  });
  const where = window === window.top ? 'top page' : `frame ${location.pathname}`;
  log(`${VERSION} ready in the ${where} (Alt+Shift+M: panel)`);
})();

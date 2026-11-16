// U2 Mod Loader: runs in the page (the MAIN world) before the site's own scripts.
//
// What it does:
//   1. Catches the game's shared WebAssembly.Memory as the page creates it. The game's x86 memory sits at
//      address 0 of that memory (nfsu2-web runtime/cpu.h: g_mem is 0), so game address 0x832E50 is byte
//      0x832E50 of the buffer. The game's executable is one fixed version, so its addresses never move.
//   2. Notes the compiled game module (does it keep function names? that decides later wasm patching).
//   3. Runs registered mods once per animation frame, gives them memory and game helpers, hotkeys and a panel.
//
// Console: U2ML (U2ML.status(), U2ML.mem.u32(0x8654a4), U2ML.scan.f32(1.5) ...). Panel: Alt+Shift+M.
(() => {
  'use strict';
  if (window.U2ML) return;

  const VERSION = '0.2.0';
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
  // ---- 2b. the camera hook: the module patched as it loads ---------------------------------------------------
  // At the start of 0x5C7EC0, which builds each view of the frame from its camera (nfsu2-web runtime/overrides.c:
  // the main view's is the frame's first), the patch copies a mailbox into the main view's camera while the
  // mailbox's flag is 1. The copy runs on the game's thread at the moment the frame's view is made, so the game's
  // camera never shows in between. Off: localStorage['u2ml:patch'] = 'false', then reload.
  const PATCH = {
    want: load('u2ml:patch', true), state: 'off', info: null,
    MAILBOX: 0x00d0f000,           // above the web build's players arrays (0xD00000-0xD00200, splitscreen_mem.h),
                                   // below the module heaps. +0 the flag, then what the hook copies:
    // [mailbox offset, camera offset, bytes]: the matrix, eye, forward and target; and the camera's velocity
    // (+0x1E0, m/s), which the rain moves its drops and lens drops by (nfsu2-web runtime/framerate.c F6)
    RANGES: [[16, 0x00, 0x70], [0x80, 0x1e0, 12]],
    VIEW_SETUP: 0x005c7ec0, CAM_PTR_AT: 0x00832e50 + 0x40, CAM_VEL: 0x1e0,
    mailboxOk: null,               // null: not checked yet; false: something else uses it
  };
  const realCompile = WebAssembly.compile, realCS = WebAssembly.compileStreaming;
  async function compilePatched(src) {
    const resp = await src;
    let bytes;
    try { bytes = new Uint8Array(await resp.clone().arrayBuffer()); }
    catch (e) { PATCH.state = `failed: ${e.message}`; warn('camera hook: could not read the module', e); return realCS.call(WebAssembly, resp); }
    try {
      const t0 = performance.now();
      const r = globalThis.U2WasmPatch.patchGame(bytes, {
        guestAddr: PATCH.VIEW_SETUP,
        prologue: globalThis.U2WasmPatch.cameraCopy(PATCH.CAM_PTR_AT, PATCH.MAILBOX, PATCH.RANGES),
      });
      const m = await realCompile.call(WebAssembly, r.bytes);
      PATCH.state = 'on'; PATCH.info = r.info;
      log(`camera hook in: function #${r.info.funcIdx} of ${r.info.functions} lifted (${(performance.now() - t0).toFixed(0)} ms)`, r.info);
      return m;
    } catch (e) {
      PATCH.state = `failed: ${e.message}`;
      warn('camera hook not put in, the game runs unchanged:', e);
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
      return go.then(m => { noteModule(m); return m; });
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
    CAM_MATRIX: 0x00, CAM_EYE: 0x40, CAM_FWD: 0x50, CAM_TARGET: 0x60, CAM_FOV: 0xc4,   // camera (fov: u16 binary angle)
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
      if (mailboxReady()) {
        // through the hook: the game thread copies it in as it makes the frame's view (no flicker)
        const mb = PATCH.MAILBOX + 16;
        mem.setF32s(mb + OFF.CAM_MATRIX, M);
        mem.setVec3(mb + OFF.CAM_EYE, eye); mem.setU32(mb + 0x4c, mem.u32(c + 0x4c));   // with the game's padding
        mem.setVec3(mb + OFF.CAM_FWD, fwd); mem.setU32(mb + 0x5c, mem.u32(c + 0x5c));
        mem.setVec3(mb + OFF.CAM_TARGET, target); mem.setU32(mb + 0x6c, mem.u32(c + 0x6c));
        // our camera's own velocity, from its last place (smoothed: the page's frames are not the game's)
        const now = performance.now(), lp = cam.lastEye;
        const vNow = lp && now > lp.t ? v3.scale(v3.sub(eye, lp.eye), 1000 / (now - lp.t)) : [0, 0, 0];
        cam.vel = lp && lp.vel ? v3.lerp(lp.vel, vNow, 0.5) : vNow;
        if (!cam.vel.every(Number.isFinite) || v3.len(cam.vel) > 200) cam.vel = [0, 0, 0];
        cam.lastEye = { eye: eye.slice(), t: now, vel: cam.vel };
        mem.setVec3(PATCH.MAILBOX + 0x80, cam.vel);
        mem.setU32(PATCH.MAILBOX, 1);
        PATCH.used = true;
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
    if (cam.layout || !game.driving() || cam.writtenThisFrame) return;
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
  /** the hook is in and its mailbox is free (checked once in the world: nothing of the game's may be there) */
  function mailboxReady() {
    if (PATCH.state !== 'on') return false;
    if (PATCH.mailboxOk === null) {
      if (!game.inWorld()) return false;
      let used = 0;
      for (let a = PATCH.MAILBOX; a < PATCH.MAILBOX + 0x1000; a += 4) if (mem.u32(a)) used++;
      PATCH.mailboxOk = used === 0;
      if (used) warn(`camera hook: the mailbox at 0x${PATCH.MAILBOX.toString(16)} is in use (${used} words), the hook stays off`);
      else log('camera hook: mailbox free, cameras go through the hook');
    }
    return PATCH.mailboxOk;
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
  const api = { VERSION, mem, game, v3, camera: cam, log, warn };
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
    const m = { def, on: false, opts, store: {
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
    try { (on ? m.def.enable : m.def.disable)?.(api, m.store); } catch (e) { warn(`${id} ${on ? 'enable' : 'disable'}`, e); }
    if (remember) save(`u2ml:on:${id}`, m.on);
    log(`${m.def.name || id} ${m.on ? 'on' : 'off'}`);
    panel.rebuild();
  }

  // ---- the frame -------------------------------------------------------------------------------------------
  let last = performance.now();
  function tick(t) {
    const dt = Math.min(0.1, Math.max(0, (t - last) / 1000)); last = t;
    if (memory) {
      cam.writtenThisFrame = false;
      try { calibrateTick(); } catch (e) { warn('calibration', e); }
      for (const m of mods.values()) {
        if (!m.on || !m.def.frame) continue;
        try { m.def.frame(api, dt, m.store); }
        catch (e) { warn(`${m.def.id} frame failed, turned off`, e); setEnabled(m.def.id, false, false); }
      }
      try { axesTick(); } catch (e) { warn('car axes', e); }
      if (!cam.writtenThisFrame) {
        cam.wrote = null;
        if (PATCH.used) { mem.setU32(PATCH.MAILBOX, 0); PATCH.used = false; cam.lastEye = null; }    // the game's camera back
        if (cam.blurWas != null) {                                                 // and the player's motion blur
          if (mem.u32(ADDR.MOTION_BLUR) === 0) mem.setU32(ADDR.MOTION_BLUR, cam.blurWas);
          cam.blurWas = null;
        }
      } else if (cam.pump && !PATCH.used) pumpCh.port2.postMessage(0);
    }
    panel.update(t);
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

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
      lines.push(`hook    ${!PATCH.want ? 'switched off' : PATCH.state === 'on' ? (PATCH.mailboxOk === false ? 'in, mailbox busy: not used' : 'in') : PATCH.state}`);
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
    status: () => ({ memory: !!memory, module: !!module, hasNames, flow: game.flow(), driving: game.driving(), layout: cam.layout }),
    _test: { buildMatrix, calibrateSample },
  });
  const where = window === window.top ? 'top page' : `frame ${location.pathname}`;
  log(`${VERSION} ready in the ${where} (Alt+Shift+M: panel)`);
})();

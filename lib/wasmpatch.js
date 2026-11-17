// A small WebAssembly binary editor for the game module: finds a lifted game function by its x86 address and
// puts a few instructions at its start. The live module has no function names, but it carries the game's own
// address -> function tables (nfsu2-web runtime/dispatch.c: g_fn_addr[], sorted x86 addresses, and g_fn_ptr[],
// the matching function pointers, which in wasm are indices into the function table).
//
//   U2WasmPatch.patchGame(bytes, { hooks: [{ guestAddr, build }], anchor }) -> { bytes, info, results }
//     (throws when the tables are unsure; a hook at a wrong address fails alone)
//   U2WasmPatch.prologue.notify / capture / write / skip / call (hook) -> build: the instructions of each kind of hook
//     (a call hook's entry also names the function it calls: { guestAddr, calls, build })
(() => {
  'use strict';

  // ---- LEB128 ----------------------------------------------------------------------------------------------
  function readU(b, p) { let r = 0, s = 0, x; do { x = b[p++]; r += (x & 0x7f) * 2 ** s; s += 7; } while (x & 0x80); return [r, p]; }
  function readS(b, p) {
    let r = 0, s = 0, x;
    do { x = b[p++]; r += (x & 0x7f) * 2 ** s; s += 7; } while (x & 0x80);
    if (x & 0x40) r -= 2 ** s;
    return [r, p];
  }
  function encU(n) { const o = []; do { let x = n % 128; n = Math.floor(n / 128); if (n) x |= 0x80; o.push(x); } while (n); return o; }
  function encS(n) {
    const o = [];
    for (;;) {
      const x = ((n % 128) + 128) % 128; n = Math.floor(n / 128);
      if ((n === 0 && !(x & 0x40)) || (n === -1 && (x & 0x40))) { o.push(x); return o; }
      o.push(x | 0x80);
    }
  }

  // ---- sections --------------------------------------------------------------------------------------------
  function sections(b) {
    if (b[0] !== 0 || b[1] !== 0x61 || b[2] !== 0x73 || b[3] !== 0x6d || b[4] !== 1) throw new Error('not a wasm module');
    const out = [];
    let p = 8;
    while (p < b.length) {
      const id = b[p], [size, q] = readU(b, p + 1);
      out.push({ id, at: p, start: q, end: q + size });
      p = q + size;
    }
    return out;
  }
  const skipName = (b, p) => { const [n, q] = readU(b, p); return q + n; };
  function skipLimits(b, p) { const f = b[p++]; let x; [x, p] = readU(b, p); if (f & 1) [x, p] = readU(b, p); return p; }
  function skipConstExpr(b, p) {       // i32.const N end (all wasm-ld writes here)
    if (b[p] !== 0x41) throw new Error(`unexpected offset expression 0x${b[p].toString(16)}`);
    const [v, q] = readS(b, p + 1);
    if (b[q] !== 0x0b) throw new Error('offset expression not ended');
    return [v, q + 1];
  }

  function parse(b) {
    const secs = sections(b), get = id => secs.find(s => s.id === id);
    const M = { secs, types: [], nImpFuncs: 0, funcTypes: [], table: new Map(), data: [], code: get(10) };
    const T = get(1);
    if (T) {
      let [n, p] = readU(b, T.start);
      for (let i = 0; i < n; i++) {
        if (b[p++] !== 0x60) throw new Error('unexpected type form');
        let np, nr; [np, p] = readU(b, p); const params = Array.from(b.subarray(p, p + np)); p += np;
        [nr, p] = readU(b, p); const results = Array.from(b.subarray(p, p + nr)); p += nr;
        M.types.push({ params, results });
      }
    }
    const I = get(2);
    if (I) {
      let [n, p] = readU(b, I.start);
      for (let i = 0; i < n; i++) {
        p = skipName(b, p); p = skipName(b, p);
        const kind = b[p++];
        if (kind === 0) { let t; [t, p] = readU(b, p); M.nImpFuncs++; M.funcTypes.push(t); }
        else if (kind === 1) { p++; p = skipLimits(b, p); }
        else if (kind === 2) p = skipLimits(b, p);
        else if (kind === 3) p += 2;
        else throw new Error(`unknown import kind ${kind}`);
      }
    }
    const F = get(3);
    if (F) { let [n, p] = readU(b, F.start); for (let i = 0; i < n; i++) { let t; [t, p] = readU(b, p); M.funcTypes.push(t); } }
    const E = get(9);
    if (E) {
      let [n, p] = readU(b, E.start);
      for (let i = 0; i < n; i++) {
        let flags; [flags, p] = readU(b, p);
        if (flags !== 0 && flags !== 2) throw new Error(`element segment kind ${flags} not handled`);
        if (flags === 2) { let t; [t, p] = readU(b, p); if (t !== 0) throw new Error('element segment for another table'); }
        let off; [off, p] = skipConstExpr(b, p);
        if (flags === 2) { if (b[p++] !== 0) throw new Error('element kind not funcref'); }
        let cnt; [cnt, p] = readU(b, p);
        for (let k = 0; k < cnt; k++) { let f; [f, p] = readU(b, p); M.table.set(off + k, f); }
      }
    }
    const D = get(11);
    if (D) {
      let [n, p] = readU(b, D.start);
      for (let i = 0; i < n; i++) {
        let flags; [flags, p] = readU(b, p);
        if (flags === 2) { let mi; [mi, p] = readU(b, p); }
        if (flags === 0 || flags === 2) { let off; [off, p] = skipConstExpr(b, p); }
        let len; [len, p] = readU(b, p);
        M.data.push({ start: p, end: p + len });
        p += len;
      }
    }
    if (!M.code) throw new Error('no code section');
    return M;
  }

  // ---- the game's address -> function tables -----------------------------------------------------------------
  const u32 = (dv, p) => dv.getUint32(p, true);
  function findFnAddr(b, M, guestAddr) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const lo = 0x400000, hi = 0x900000;                      // SPEED2.EXE's code lies within
    let best = null;
    for (const s of M.data) {
      for (let p = s.start; p + 4 <= s.end; p++) {
        if (b[p] !== (guestAddr & 0xff) || u32(dv, p) !== guestAddr) continue;
        let a = p, z = p;
        // sorted (a repeated address is possible: dispatch.c counts duplicates)
        while (a - 4 >= s.start && u32(dv, a - 4) <= u32(dv, a) && u32(dv, a - 4) >= lo) a -= 4;
        while (z + 8 <= s.end && u32(dv, z + 4) >= u32(dv, z) && u32(dv, z + 4) < hi) z += 4;
        const n = (z - a) / 4 + 1;
        if (!best || n > best.n) best = { start: a, n, index: (p - a) / 4, seg: s };
      }
    }
    if (!best || best.n < 1000) throw new Error(`the game's address table was not found (longest run ${best ? best.n : 0})`);
    return best;
  }
  function findFnPtr(b, M, n, wantType) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const tableLen = Math.max(0, ...M.table.keys()) + 1;
    const okType = ti => { const f = M.table.get(ti); if (f == null) return false; const t = M.types[M.funcTypes[f]]; return !!t && sameType(t, wantType); };
    // (nearly) every entry must be a function of the lifted kind, void f(CPU *)
    const allLifted = start => { let bad = 0; for (let k = 0; k < n; k++) if (!okType(u32(dv, start + 4 * k)) && ++bad > n / 100) return false; return true; };
    const found = new Set();
    for (const s of M.data) for (let phase = 0; phase < 4; phase++) {
      let run = 0;
      for (let p = s.start + phase; ; p += 4) {
        const inside = p + 4 <= s.end, v = inside ? u32(dv, p) : 0;
        if (inside && v > 0 && v < tableLen) { run++; continue; }
        if (run >= n) {                                  // a run of table indices at least as long: the array at either end
          const runStart = p - 4 * run;
          for (const st of [runStart, p - 4 * n]) if (allLifted(st)) found.add(st);
        }
        run = 0;
        if (!inside) break;
      }
    }
    if (!found.size) throw new Error("the game's function table was not found");
    return [...found];
  }

  // where each defined function's body lies in the code section
  function bodies(b, M) {
    let [n, p] = readU(b, M.code.start);
    const start = new Uint32Array(n), end = new Uint32Array(n);
    for (let i = 0; i < n; i++) { const [sz, q] = readU(b, p); start[i] = q; end[i] = q + sz; p = q + sz; }
    return { start, end };
  }
  // How well a candidate function table fits the game: a lifted function pushes the x86 return address of each
  // call it makes (guest.h gcall: the address pushed matters), so its code holds i32.const values inside its own
  // x86 range [address, next address). Counted over a sample of the table's entries.
  function tableFit(b, M, B, addrAt, ptrAt, n) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let fit = 0, tried = 0;
    for (let k = 1; k < n - 1; k += Math.max(1, Math.floor(n / 400))) {
      const lo = u32(dv, addrAt + 4 * k), hi = u32(dv, addrAt + 4 * (k + 1));
      if (hi <= lo) continue;
      const f = M.table.get(u32(dv, ptrAt + 4 * k));
      const j = f == null ? -1 : f - M.nImpFuncs;
      if (j < 0 || j >= B.start.length) continue;
      tried++;
      for (let p = B.start[j]; p < B.end[j] - 1; p++) {
        if (b[p] !== 0x41) continue;
        const [v] = readS(b, p + 1);
        if (v > lo && v < hi) { fit++; break; }
      }
    }
    return { fit, tried };
  }
  const sameType = (a, b) => a.params.join() === b.params.join() && a.results.join() === b.results.join();


  // the x86 address -> table position, by binary search in the sorted g_fn_addr (the first of repeats)
  function lookUp(dv, A, guestAddr) {
    let lo = 0, hi = A.n - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (u32(dv, A.start + 4 * mid) < guestAddr) lo = mid + 1; else hi = mid; }
    return u32(dv, A.start + 4 * lo) === guestAddr ? lo : -1;
  }

  // ---- putting instructions at the start of functions --------------------------------------------------------
  // builds: Map funcIdx -> [build(scratch)], scratch the indices of two i32 locals added to that function.
  // One pass over the code section; every other function's bytes are kept as they are.
  function prependToFunctions(b, M, builds) {
    const C = M.code, chunks = [];
    let [n, p] = readU(b, C.start), len = 0;
    const put = x => { chunks.push(x); len += x.length; };
    put(Uint8Array.from(encU(n)));
    for (let j = 0; j < n; j++) {
      const [size, bodyAt] = readU(b, p), bodyEnd = bodyAt + size;
      const list = builds.get(j + M.nImpFuncs);
      if (!list) { put(b.subarray(p, bodyEnd)); p = bodyEnd; continue; }
      let q = bodyAt, groups, nLocals = M.types[M.funcTypes[j + M.nImpFuncs]].params.length;
      [groups, q] = readU(b, q);
      const groupsAt = q;
      for (let g = 0; g < groups; g++) { let c; [c, q] = readU(b, q); q++; nLocals += c; }
      const exprAt = q, scratch = [nLocals, nLocals + 1];
      const prologue = Uint8Array.from(list.flatMap(build => Array.from(build(scratch))));
      const locals = Uint8Array.from([...encU(groups + 1), ...b.subarray(groupsAt, exprAt), 2, 0x7f]);   // + 2 x i32
      const newSize = locals.length + prologue.length + (bodyEnd - exprAt);
      put(Uint8Array.from(encU(newSize))); put(locals); put(prologue); put(b.subarray(exprAt, bodyEnd));
      p = bodyEnd;
    }
    const head = [10, ...encU(len)];
    const out = new Uint8Array(C.at + head.length + len + (b.length - C.end));
    let o = 0;
    const w = x => { out.set(x, o); o += x.length; };
    w(b.subarray(0, C.at)); w(head); for (const c of chunks) w(c); w(b.subarray(C.end));
    if (o !== out.length) throw new Error('size mismatch');
    return out;
  }

  // ---- what the hooks do: wasm instructions ----------------------------------------------------------------
  // The function's only argument (local 0) is the CPU: eax +0, ecx +4, edx +8, ebx +12, esp +16, ebp +20,
  // esi +24, edi +28, eip +32 (nfsu2-web runtime/cpu.h). The registers are up to date in it at the function's
  // entry (tools/lregs.py stores them before every call; LR_ENTER reads them back from it).
  //
  // Each hook has a slot in shared memory:
  //   +0 on: the hook acts only while it holds ON (the page writes it)
  //   +4 calls counted (atomic; the hooks add to it)
  //   +8 write: which of its two buffers is current (0/1); skip: the eax it returns
  //   +12 the order of its last call: every hook stamps one counter shared by all (orderAt, the area's first
  //       word), so the page can tell which of two hooks' calls came first
  //   +16 capture: its ring of entries; write: its two buffers
  const ON = 0x6c6d3275;                                  // 'u2ml': nothing else's data is likely to read so
  const REG = { eax: 0, ecx: 4, edx: 8, ebx: 12, esp: 16, ebp: 20, esi: 24, edi: 28, eip: 32 };
  const GUEST_END = 0x28000000;                           // the guest owns [0, GUEST_END) (nfsu2-web web/build.sh)
  const I = {
    c: v => [0x41, ...encS(v | 0)],                       // i32.const
    get: i => [0x20, ...encU(i)], set: i => [0x21, ...encU(i)],
    load: (o = 0) => [0x28, 2, ...encU(o)], store: (o = 0) => [0x36, 2, ...encU(o)],
    aload: (o = 0) => [0xfe, 0x10, 2, ...encU(o)], astore: (o = 0) => [0xfe, 0x17, 2, ...encU(o)],
    aadd: (o = 0) => [0xfe, 0x1e, 2, ...encU(o)],       // i32.atomic.rmw.add: the old value
    notify: [0xfe, 0x00, 2, 0],                           // memory.atomic.notify (address, count): woken
    copy: [0xfc, 0x0a, 0, 0],                             // memory.copy (dst, src, len)
    add: [0x6a], sub: [0x6b], mul: [0x6c], and: [0x71], shl: [0x74], eq: [0x46], ne: [0x47], ltu: [0x49], drop: [0x1a],
    if: [0x04, 0x40], end: [0x0b], ret: [0x0f],
    callIndirect: typeIdx => [0x11, ...encU(typeIdx), 0x00],   // call_indirect (table 0)
  };
  const isOn = slot => [...I.c(slot), ...I.load(), ...I.c(ON), ...I.eq];
  // on, and (with ret) called from that return address only: [esp] at the entry is the caller's return address
  // (the way nfsu2-web runtime/career.c picks GameLoop's call out of 0x4022C0's ~300 callers)
  const gate = ({ slot, ret }) => ret == null ? isOn(slot)
    : [...isOn(slot), ...I.get(0), ...I.load(REG.esp), ...I.load(), ...I.c(ret), ...I.eq, ...I.and];
  const count = slot => [...I.c(slot + 4), ...I.c(1), ...I.aadd(), ...I.drop];
  const wake = slot => [...I.c(slot + 4), ...I.c(-1), ...I.notify, ...I.drop];
  const stamp = (slot, orderAt) => orderAt == null ? [] : [...I.c(slot + 12), ...I.c(orderAt), ...I.c(1), ...I.aadd(), ...I.astore()];

  const prologue = {
    /** count the call, and wake the page (Atomics.waitAsync on +4) unless wakes is false */
    notify: h => () => Uint8Array.from([...gate(h), ...I.if, ...count(h.slot), ...stamp(h.slot, h.orderAt),
      ...(h.wakes !== false ? wake(h.slot) : []), ...I.end]),
    /** the registers and [esp] .. [esp + 4 * args] into a ring of keep entries (a power of 2):
     *  entry = [seq, order, eax ... edi, eip, return address, args]; seq odd while written, 2n+2 when call n is in */
    capture: ({ slot, keep, args, wakes, ret, orderAt }) => ([n, e]) => {
      const size = captureEntry(args);
      return Uint8Array.from([...gate({ slot, ret }), ...I.if,
        ...I.c(slot + 4), ...I.c(1), ...I.aadd(), ...I.set(n),
        ...I.get(n), ...I.c(keep - 1), ...I.and, ...I.c(size), ...I.mul, ...I.c(slot + 16), ...I.add, ...I.set(e),
        ...I.get(e), ...I.get(n), ...I.c(1), ...I.shl, ...I.c(1), ...I.add, ...I.astore(),
        ...stamp(slot, orderAt), ...I.get(e), ...I.c(slot + 12), ...I.aload(), ...I.store(4),
        ...I.get(e), ...I.c(8), ...I.add, ...I.get(0), ...I.c(36), ...I.copy,
        ...I.get(e), ...I.c(44), ...I.add, ...I.get(0), ...I.load(REG.esp), ...I.c(4 * (args + 1)), ...I.copy,
        ...I.get(e), ...I.get(n), ...I.c(1), ...I.shl, ...I.c(2), ...I.add, ...I.astore(),
        ...(wakes ? wake(slot) : []), ...I.end]);
    },
    /** copy the current buffer's ranges to the target (skipped while it isn't a valid guest address):
     *  to { addr } | { ptr } (the pointer at ptr) | { reg } (a register, e.g. ecx: this) | { page: true } (the
     *  address in the buffer's first word, which the page sets); ranges [[offset, len]] */
    write: ({ slot, to, ranges, wakes, ret, orderAt }) => ([t, src]) => {
      const L = writeLayout(ranges, to), span = Math.max(...L.map(r => r.off + r.len));
      const target = to.addr != null ? I.c(to.addr) : to.ptr != null ? [...I.c(to.ptr), ...I.load()]
        : to.page ? [...I.get(src), ...I.load()] : [...I.get(0), ...I.load(REG[to.reg])];
      return Uint8Array.from([
        ...I.c(slot + 8), ...I.aload(), ...I.c(L.size), ...I.mul, ...I.c(slot + 16), ...I.add, ...I.set(src),
        ...target, ...I.set(t),
        ...I.get(t), ...I.c(-0x10000), ...I.add, ...I.c(GUEST_END - 0x10000 - span), ...I.ltu, ...gate({ slot, ret }), ...I.and, ...I.if,
        ...count(slot), ...stamp(slot, orderAt),
        ...L.flatMap(r => [...I.get(t), ...(r.off ? [...I.c(r.off), ...I.add] : []),
          ...I.get(src), ...(r.at ? [...I.c(r.at), ...I.add] : []), ...I.c(r.len), ...I.copy]),
        ...(wakes ? wake(slot) : []), ...I.end]);
    },
    /** return at once, as the function's ret pop would: eax = [slot + 8], eip = the return address, esp past it
     *  and pop bytes of arguments (nfsu2-web runtime/cameras.c ScrollDriveCam: POP32(c->eip); c->esp += N) */
    skip: ({ slot, pop, wakes, ret, orderAt }) => () => Uint8Array.from([...gate({ slot, ret }), ...I.if,
      ...count(slot), ...stamp(slot, orderAt), ...(wakes ? wake(slot) : []),
      ...I.get(0), ...I.c(slot + 8), ...I.load(), ...I.store(REG.eax),
      ...I.get(0), ...I.get(0), ...I.load(REG.esp), ...I.load(), ...I.store(REG.eip),
      ...I.get(0), ...I.get(0), ...I.load(REG.esp), ...I.c(4 + pop), ...I.add, ...I.store(REG.esp),
      ...I.ret, ...I.end]),
    /** call another game function (fn) once for each request the page makes, on the game's thread, as nfsu2-web's
     *  guest_call_ex (runtime/guest.h) does from its hooks: the registers kept, a stack 256 bytes below the
     *  current one (16-aligned), the arguments and ecx from the slot, the return address pushed (ret, else the
     *  hooked function's own address: some game functions look at their caller's), the function run, eax kept,
     *  the registers put back. The hooked function then runs as it would have.
     *  Slot (callLayout): +8 the page's request number, +16 started (the number being run: a call of this same
     *  function from inside fn doesn't run it again), +20 finished (the number done), +24 eax, +28 ecx, +32 the
     *  arguments, then the registers kept (36 bytes). */
    call: ({ slot, args, ret, at, wakes, orderAt }) => ([n], ctx) => {
      if (!ctx || ctx.tableIdx == null || ctx.typeIdx == null) throw new Error('a call hook needs the function to call');
      const L = callLayout(args), push = v => [...I.get(0), ...I.get(0), ...I.load(REG.esp), ...I.c(4), ...I.sub, ...I.store(REG.esp),
        ...I.get(0), ...I.load(REG.esp), ...v, ...I.store()];
      return Uint8Array.from([...gate({ slot, ret }), ...I.c(slot + 8), ...I.aload(), ...I.c(slot + L.started), ...I.aload(), ...I.ne, ...I.and, ...I.if,
        ...I.c(slot + 8), ...I.aload(), ...I.set(n),
        ...I.c(slot + L.started), ...I.get(n), ...I.astore(),
        ...count(slot), ...stamp(slot, orderAt),
        ...I.c(slot + L.save), ...I.get(0), ...I.c(36), ...I.copy,
        ...I.get(0), ...I.get(0), ...I.load(REG.esp), ...I.c(256), ...I.sub, ...I.c(-16), ...I.and, ...I.store(REG.esp),
        ...Array.from({ length: args }, (_, k) => push([...I.c(slot + L.args + 4 * (args - 1 - k)), ...I.load()])).flat(),
        ...I.get(0), ...I.c(slot + L.ecx), ...I.load(), ...I.store(REG.ecx),
        ...push(I.c(ret ?? at)),
        ...I.get(0), ...I.c(ctx.tableIdx), ...I.callIndirect(ctx.typeIdx),
        ...I.c(slot + L.eax), ...I.get(0), ...I.load(REG.eax), ...I.store(),
        ...I.get(0), ...I.c(slot + L.save), ...I.c(36), ...I.copy,
        ...I.c(slot + L.finished), ...I.get(n), ...I.astore(),
        ...(wakes ? wake(slot) : []), ...I.end]);
    },
  };
  /** where a call hook's fields sit in its slot (args: the number of stack arguments) */
  const callLayout = args => ({ started: 16, finished: 20, eax: 24, ecx: 28, args: 32, save: 32 + 4 * args, size: 32 + 4 * args + 36 });
  const captureEntry = args => 8 + 36 + 4 * (args + 1);
  /** where each range of a write hook sits in its buffer: [{ off, len, at }], and the buffer's size. With
   *  to { page: true } the buffer's first word is the target address, and the ranges follow it. */
  function writeLayout(ranges, to) {
    let at = to && to.page ? 4 : 0;
    const L = ranges.map(([off, len]) => { const r = { off, len, at }; at += (len + 3) & ~3; return r; });
    L.size = at;
    return L;
  }
  /** a hook's slot size in bytes */
  function slotSize(h) {
    if (h.kind === 'capture') return 16 + h.keep * captureEntry(h.args);
    if (h.kind === 'write') return 16 + 2 * writeLayout(h.ranges, h.to).size;
    if (h.kind === 'call') return callLayout(h.args ?? 0).size;
    return 16;
  }

  /**
   * patchGame(bytes, { hooks: [{ guestAddr, build(scratch) -> bytes }], anchor })
   *   -> { bytes, info, results: [{ ok: true, funcIdx } | { ok: false, error }] }, one result per hook in order.
   * The game's tables are found by anchor (an address known to be a lifted function; the first hook's if not
   * given). A problem with the tables throws; a hook whose address isn't a lifted function fails on its own.
   */
  function patchGame(bytes, opts) {
    const hooks = opts.hooks || [];
    if (!hooks.length) throw new Error('no hooks');
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const M = parse(b);
    const A = findFnAddr(b, M, opts.anchor ?? hooks[0].guestAddr);
    const lifted = { params: [0x7f], results: [] };          // void sub_XXXXXX(CPU *c)
    const cands = findFnPtr(b, M, A.n, lifted);
    let ptrAt = cands[0], fits = null;
    if (cands.length > 1) {
      const B = bodies(b, M);
      fits = cands.map(c => ({ at: c, ...tableFit(b, M, B, A.start, c, A.n) })).sort((x, y) => y.fit - x.fit);
      const [best, next] = fits;
      if (best.fit < 20 || best.fit < 3 * next.fit) throw new Error(`the game's function table: ${cands.length} candidates, none clearly fits (${fits.map(f => `${f.fit}/${f.tried}`).join(', ')})`);
      ptrAt = best.at;
    }
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const builds = new Map();
    const typeIdx = M.types.findIndex(t => sameType(t, lifted));
    // a game function by its x86 address: its table index and wasm function, or an error
    const find = addr => {
      const k = lookUp(dv, A, addr >>> 0);
      if (k < 0) return { error: `0x${(addr >>> 0).toString(16)} is not the start of a game function` };
      const tableIdx = u32(dv, ptrAt + 4 * k), funcIdx = M.table.get(tableIdx);
      if (funcIdx == null) return { error: 'the function is not in the table' };
      if (funcIdx < M.nImpFuncs || !sameType(M.types[M.funcTypes[funcIdx]], lifted)) return { error: 'the function is not a lifted one' };
      return { tableIdx, funcIdx };
    };
    const results = hooks.map(h => {
      const f = find(h.guestAddr);
      if (f.error) return { ok: false, error: f.error };
      let ctx = null;
      if (h.calls != null) {                            // a call hook: the function it calls must be one too
        const g = find(h.calls);
        if (g.error) return { ok: false, error: `the function to call: ${g.error}` };
        ctx = { tableIdx: g.tableIdx, typeIdx };
      }
      try { h.build([0, 1], ctx); } catch (e) { return { ok: false, error: e.message }; }   // (a dry run: a build that throws fails alone)
      if (!builds.has(f.funcIdx)) builds.set(f.funcIdx, []);
      builds.get(f.funcIdx).push(scratch => h.build(scratch, ctx));
      return { ok: true, funcIdx: f.funcIdx, tableIdx: f.tableIdx };
    });
    const out = builds.size ? prependToFunctions(b, M, builds) : b;
    const r0 = results.find(r => r.ok);
    return { bytes: out, results, info: { functions: A.n, funcIdx: r0?.funcIdx, tableIdx: r0?.tableIdx, patched: builds.size,
      imports: M.nImpFuncs, size: out.length, tables: cands.length, fits: fits && fits.map(f => `${f.fit}/${f.tried}`).join(' vs ') } };
  }

  globalThis.U2WasmPatch = { patchGame, prologue, slotSize, writeLayout, captureEntry, callLayout, ON, REG, GUEST_END,
    parse, encU, encS, readU, readS };
})();

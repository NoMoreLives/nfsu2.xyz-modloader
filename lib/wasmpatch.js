// A small WebAssembly binary editor for the game module: finds a lifted game function by its x86 address and
// puts a few instructions at its start. The live module has no function names, but it carries the game's own
// address -> function tables (nfsu2-web runtime/dispatch.c: g_fn_addr[], sorted x86 addresses, and g_fn_ptr[],
// the matching function pointers, which in wasm are indices into the function table).
//
//   U2WasmPatch.patchGame(bytes, { guestAddr, prologue }) -> { bytes, info }   (throws when anything is unsure)
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

  // ---- putting instructions at a function's start -------------------------------------------------------------
  function prependToFunction(b, M, funcIdx, prologue) {
    const j = funcIdx - M.nImpFuncs;
    if (j < 0) throw new Error('that function is an import');
    const C = M.code;
    let [n, p] = readU(b, C.start);
    if (j >= n) throw new Error('function index out of range');
    for (let i = 0; i < j; i++) { const [sz, q] = readU(b, p); p = q + sz; }
    const entryAt = p;
    const [size, bodyAt] = readU(b, p);
    let q = bodyAt, groups;
    [groups, q] = readU(b, q);
    for (let g = 0; g < groups; g++) { let c; [c, q] = readU(b, q); q++; }        // locals: count, type
    const exprAt = q, bodyEnd = bodyAt + size;
    const newSize = encU(size + prologue.length);
    const before = b.subarray(C.start, entryAt), after = b.subarray(bodyEnd, C.end);
    const payloadLen = before.length + newSize.length + (exprAt - bodyAt) + prologue.length + (bodyEnd - exprAt) + after.length;
    const head = [10, ...encU(payloadLen)];
    const out = new Uint8Array(C.at + head.length + payloadLen + (b.length - C.end));
    let o = 0;
    const put = x => { out.set(x, o); o += x.length; };
    put(b.subarray(0, C.at)); put(head); put(before); put(newSize);
    put(b.subarray(bodyAt, exprAt)); put(prologue); put(b.subarray(exprAt, bodyEnd)); put(after);
    put(b.subarray(C.end));
    if (o !== out.length) throw new Error('size mismatch');
    return out;
  }

  // ---- the camera copy -------------------------------------------------------------------------------------
  // if ([camPtrAt] != 0 && [mailbox] == 1) for each [src, dst, len]: memcpy([camPtrAt] + dst, mailbox + src, len)
  // ranges: a number is the old single copy, [[16, 0, len]]
  function cameraCopy(camPtrAt, mailbox, ranges) {
    if (typeof ranges === 'number') ranges = [[16, 0, ranges]];
    const c = v => [0x41, ...encS(v)];                    // i32.const
    const load = [0x28, 0x02, 0x00];                       // i32.load align=4 offset=0
    const copies = ranges.flatMap(([src, dst, len]) => [
      ...c(camPtrAt), ...load, ...(dst ? [...c(dst), 0x6a] : []),   // camera (+ dst: i32.add)
      ...c(mailbox + src), ...c(len),
      0xfc, 0x0a, 0x00, 0x00,                               // memory.copy
    ]);
    return Uint8Array.from([
      ...c(camPtrAt), ...load, 0x45, 0x45,                  // camera != 0
      ...c(mailbox), ...load, 0x71,                         // & flag
      0x04, 0x40, ...copies, 0x0b,                          // if ... end
    ]);
  }

  function patchGame(bytes, { guestAddr, prologue }) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const M = parse(b);
    const A = findFnAddr(b, M, guestAddr);
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
    const tableIdx = u32(dv, ptrAt + 4 * A.index), funcIdx = M.table.get(tableIdx);
    if (funcIdx == null) throw new Error('the function is not in the table');
    if (!sameType(M.types[M.funcTypes[funcIdx]], lifted)) throw new Error('the function is not a lifted one');
    const out = prependToFunction(b, M, funcIdx, prologue);
    return { bytes: out, info: { functions: A.n, tableIdx, funcIdx, imports: M.nImpFuncs, size: out.length,
      tables: cands.length, fits: fits && fits.map(f => `${f.fit}/${f.tried}`).join(' vs ') } };
  }

  globalThis.U2WasmPatch = { patchGame, cameraCopy, parse, encU, encS, readU, readS };
})();

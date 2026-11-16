// A hand-built wasm module shaped like the game's, for the hook tests: an imported function first (so defined
// functions don't start at index 0), the shared memory, lifted functions void f(CPU *), the game's address and
// function tables (g_fn_addr, g_fn_ptr) in a passive data segment.
//
// Lifted functions (each adds 1 to its own counter word, so a test sees whether its body ran):
//   fView  0x5C7EC0  counter 0x900000  (also has two f64 locals of its own)
//   fLoop  0x5811C0  counter 0x900004
//   fRace  0x4FE9F0  counter 0x900008
//   fNop   0x4022C0  counter 0x90000C  (GameLoop calls it once a frame, returning to 0x581475)
export const FN = { view: 0x5c7ec0, loop: 0x5811c0, race: 0x4fe9f0, nop: 0x4022c0 };
export const COUNTER = { view: 0x900000, loop: 0x900004, race: 0x900008, nop: 0x90000c };
export const PAGES = 4096;

export function buildGame(W) {
  const { encU, encS } = W;
  const sec = (id, payload) => [id, ...encU(payload.length), ...payload];
  const vec = items => [...encU(items.length), ...items.flat()];
  const str = s => [...encU(s.length), ...Buffer.from(s)];
  const u32le = v => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
  const c = v => [0x41, ...encS(v)];
  const bump = a => [...c(a), ...c(a), 0x28, 2, 0, ...c(1), 0x6a, 0x36, 2, 0];        // [a] += 1
  const body = (ins, locals = []) => { const b = [...vec(locals), ...ins, 0x0b]; return [...encU(b.length), ...b]; };
  // the tables: 1500 sorted addresses with the three functions among them; the others all point at a dummy
  const addrs = [...new Set([...Array.from({ length: 1496 }, (_, i) => 0x401000 + i * 0x200), ...Object.values(FN)])].sort((a, b) => a - b);
  const tableOf = { [FN.view]: 2, [FN.loop]: 3, [FN.race]: 4, [FN.nop]: 5 };           // table index -> function 1+
  const ptrs = addrs.map(a => tableOf[a] || 1);
  const data = [...Array(37).fill(0x7f), ...addrs.flatMap(u32le), ...Array(12).fill(0), ...ptrs.flatMap(u32le), ...Array(20).fill(0xff)];
  const exp = (name, f) => [...str(name), 0x00, ...encU(f)];
  return Uint8Array.from([
    0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
    ...sec(1, vec([[0x60, 1, 0x7f, 0]])),                                               // (i32) -> ()
    ...sec(2, vec([
      [...str('env'), ...str('log'), 0x00, 0],                                         // function 0: an import
      [...str('env'), ...str('memory'), 0x02, 0x03, ...encU(PAGES), ...encU(PAGES)],
    ])),
    ...sec(3, vec([[0], [0], [0], [0], [0]])),                                          // functions 1-5
    ...sec(4, vec([[0x70, 0x00, 6]])),
    ...sec(7, vec([exp('fDummy', 1), exp('fView', 2), exp('fLoop', 3), exp('fRace', 4), exp('fNop', 5)])),
    ...sec(9, vec([[0x00, ...c(1), 0x0b, ...vec([[1], [2], [3], [4], [5]])]])),
    ...sec(10, vec([
      body([]),
      body([...bump(COUNTER.view), 0x44, ...Array(8).fill(0), 0x21, 1], [[2, 0x7c]]),  // f64.const 0; local.set 1 (an f64)
      body(bump(COUNTER.loop)),
      body(bump(COUNTER.race)),
      body(bump(COUNTER.nop)),
    ])),
    ...sec(11, vec([[0x01, ...encU(data.length), ...data]])),                          // passive, as with shared memory
  ]);
}

// the CPU struct (nfsu2-web runtime/cpu.h): eax +0 ... edi +28, eip +32
export const R = { eax: 0, ecx: 4, edx: 8, ebx: 12, esp: 16, ebp: 20, esi: 24, edi: 28, eip: 32 };

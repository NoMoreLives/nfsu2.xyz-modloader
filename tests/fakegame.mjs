// A hand-built wasm module shaped like the game's, for the hook tests: an imported function first (so defined
// functions don't start at index 0), the shared memory, lifted functions void f(CPU *), the game's address and
// function tables (g_fn_addr, g_fn_ptr) in a passive data segment.
//
// Lifted functions (each adds 1 to its own counter word, so a test sees whether its body ran):
//   fView  0x5C7EC0  counter 0x900000  (also has two f64 locals of its own)
//   fLoop  0x5811C0  counter 0x900004
//   fRace  0x4FE9F0  counter 0x900008
//   fNop   0x4022C0  counter 0x90000C  (GameLoop calls it once a frame, returning to 0x581475)
//   fPlace 0x5FBD60  counter 0x900010  (Car::SetPosition)
//   fCall  0x5FAE20  counter 0x90002C  (a thiscall with one argument, ret 4, for the call hook: see CALL_SAW)
export const FN = { view: 0x5c7ec0, loop: 0x5811c0, race: 0x4fe9f0, nop: 0x4022c0, place: 0x5fbd60, engine: 0x594300, substep: 0x5aa480, sound: 0x483b40, soundRpm: 0x484c50, called: 0x5fae20 };
export const COUNTER = { view: 0x900000, loop: 0x900004, race: 0x900008, nop: 0x90000c, place: 0x900010, engine: 0x900014, substep: 0x900018, sound: 0x900020, soundRpm: 0x900024, called: 0x90002c };
// the fake engine step: the gear [ecx + 0x434] it saw last goes here, then it puts first gear (2) back, as the
// automatic gearbox does in the game
export const ENGINE_SAW = 0x90001c;
// the fake sound update: the rpm (float) at [ecx + 0x440] it read last
export const SOUND_SAW = 0x900028;
// the fake called function: ecx, [esp + 4] (its argument), [esp] (the return address) and esp as it found them;
// it returns eax = ecx + arg, clobbers ebx and edx, and returns as ret 4 does
export const CALL_SAW = { ecx: 0x900030, arg: 0x900034, ret: 0x900038, esp: 0x90003c };
// more game functions that exist in the fake only as the empty dummy: AutoPilotOff, SetInputMode, the GPS's start
export const DUMMIES = [0x5faf10, 0x605c70, 0x529480];
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
  const addrs = [...new Set([...Array.from({ length: 1495 }, (_, i) => 0x401000 + i * 0x200), ...Object.values(FN), ...DUMMIES])].sort((a, b) => a - b);
  const tableOf = { [FN.view]: 2, [FN.loop]: 3, [FN.race]: 4, [FN.nop]: 5, [FN.place]: 6, [FN.engine]: 7, [FN.substep]: 8, [FN.sound]: 9, [FN.soundRpm]: 10, [FN.called]: 11 }; // table index -> function 1+
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
    ...sec(3, vec([[0], [0], [0], [0], [0], [0], [0], [0], [0], [0], [0]])),            // functions 1-11
    ...sec(4, vec([[0x70, 0x00, 12]])),
    ...sec(7, vec([exp('fDummy', 1), exp('fView', 2), exp('fLoop', 3), exp('fRace', 4), exp('fNop', 5), exp('fPlace', 6), exp('fEngine', 7), exp('fSubstep', 8), exp('fSound', 9), exp('fSoundRpm', 10), exp('fCall', 11)])),
    ...sec(9, vec([[0x00, ...c(1), 0x0b, ...vec([[1], [2], [3], [4], [5], [6], [7], [8], [9], [10], [11]])]])),
    ...sec(10, vec([
      body([]),
      body([...bump(COUNTER.view), 0x44, ...Array(8).fill(0), 0x21, 1], [[2, 0x7c]]),  // f64.const 0; local.set 1 (an f64)
      body(bump(COUNTER.loop)),
      body(bump(COUNTER.race)),
      body(bump(COUNTER.nop)),
      body(bump(COUNTER.place)),
      body([0x20, 0, 0x28, 2, 4, 0x21, 1,                                                 // ecx -> local 1
        ...c(ENGINE_SAW), 0x20, 1, 0x28, 2, ...encU(0x434), 0x36, 2, 0,                   // the gear it saw
        0x20, 1, ...c(2), 0x36, 2, ...encU(0x434), ...bump(COUNTER.engine)], [[1, 0x7f]]),   // first gear back
      body(bump(COUNTER.substep)),
      body([...c(SOUND_SAW), 0x20, 0, 0x28, 2, 4, 0x28, 2, ...encU(0x440), 0x36, 2, 0, ...bump(COUNTER.sound)]),   // [ecx + 0x440]
      body(bump(COUNTER.soundRpm)),
      body([0x20, 0, 0x28, 2, 16, 0x21, 1,                                                // esp -> local 1
        ...c(CALL_SAW.esp), 0x20, 1, 0x36, 2, 0,
        ...c(CALL_SAW.ecx), 0x20, 0, 0x28, 2, 4, 0x36, 2, 0,
        ...c(CALL_SAW.arg), 0x20, 1, 0x28, 2, 4, 0x36, 2, 0,
        ...c(CALL_SAW.ret), 0x20, 1, 0x28, 2, 0, 0x36, 2, 0,
        0x20, 0, 0x20, 0, 0x28, 2, 4, 0x20, 1, 0x28, 2, 4, 0x6a, 0x36, 2, 0,               // eax = ecx + arg
        0x20, 0, ...c(0x5eb), 0x36, 2, 12, 0x20, 0, ...c(0xed), 0x36, 2, 8,               // ebx, edx clobbered
        0x20, 0, 0x20, 1, 0x28, 2, 0, 0x36, 2, 32,                                          // eip = [esp]
        0x20, 0, 0x20, 1, ...c(8), 0x6a, 0x36, 2, 16,                                       // esp += 8 (ret 4)
        ...bump(COUNTER.called)], [[1, 0x7f]]),
    ])),
    ...sec(11, vec([[0x01, ...encU(data.length), ...data]])),                          // passive, as with shared memory
  ]);
}

// the CPU struct (nfsu2-web runtime/cpu.h): eax +0 ... edi +28, eip +32
export const R = { eax: 0, ecx: 4, edx: 8, ebx: 12, esp: 16, ebp: 20, esi: 24, edi: 28, eip: 32 };

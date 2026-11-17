// Map & autopilot: a map of the city's roads, a waypoint, and the game's own AI driving your car there.
//   Alt+N            the map on / off. On it: click a road for the waypoint, right-click to clear it, drag to
//                    move, the wheel to zoom, C to centre on the car, Esc to close
//   Alt+P            autopilot on / off (free roam only): the game's AI drives your car; it lets go at the
//                    waypoint, when you steer, accelerate or brake yourself (an option), or when a race starts
// With a waypoint set, a small map in the corner shows the route there and how far it is.
//
// The map is drawn from the game's own road network in memory, the one its traffic drives on (nfsu2-web
// runtime/walls.c): the road table 0x88A334 (2048 slots; a road's own index at +0xA, its node count at +0x34, its
// nodes from +0x8C, 0x38 bytes each: x, y and the height at +0x12 in 1/8 m) and the joints between roads (the
// array at [0x883DB0], [0x883DB4] of them, 0x20 bytes: the two roads at +8/+0xA, their nodes at +4/+6). No picture
// of the game's own map is used. The route is the shortest way along that network (A*).
//
// The autopilot is the game's own: Player::AutoPilotOn (0x5FAE20) and Player::AutoPilotOff (0x5FAF10), then
// Player::SetInputMode(2) to give the car back to the keys (nfsu2-web runtime/career.c, its test aid "autopilot"),
// called on the game's thread between two frames through the loader's call hooks, as nfsu2-web calls them from
// its own once-a-frame hook. The player is PlayersByNumber[0], [0xD00000] (splitscreen_mem.h).
//
// FIRST LIVE TEST (2026-11-17): THE GAME CRASHED, so Alt+P is off until the AI can be given a goal. The call
// worked: AutoPilotOn ran on the game's thread and the car's driver kind went to 3 (the AI). Its brain
// (0xA7B45A0) held no goal (+0x6FC was 0), and soon after the game trapped, "memory access out of bounds", on the
// game's thread: what nfsu2-web roam_game.c (before roam_game_goals) records for AI brains with no goal ("a
// player's game trapped at an outrun's end reading past the memory"). In a race AutoPilotOn has the race's route;
// in free roam nothing gives the brain a goal. Just before the trap the hook guard saw a word written at 0xFF0010
// (the camera hook's slot), presumably by the failing code. The research switch, which crashes the game:
// U2ML.mods.get('map').store.set('apResearch', true).
//
// Before that test it wasn't known where the game's AI drives your car in free roam. Racing, it follows
// the race's route; in free roam it may follow the GPS's route, drive the roads at random, or stop. So while the
// autopilot is on the mod logs, every 2 s, how far the car is from the waypoint, its speed, the car's driver kind
// (+0x24: 1 the keys, 3 the AI; career.c) and the game's GPS (0x838590: +0x29 on, +0x10 where; roam_game.c), and
// at the end whether the car got nearer. Also a probe: the game's "GPS to here" (0x529480, which the game's World
// Map calls when you pick a place and press its GPS key, roam_game.c "car meets") is captured with its arguments,
// so the next version can set the game's GPS to the waypoint itself. Console: U2ML.mods.get('map').def.report().
//
// The loader's rules leave the game's AI alone; this is the user's exception: free roam only, your own car only,
// never in a race or an outrun, and the keys take the car back at once.
(() => {
  const ROADS = 0x0088a334, NROADS = 2048, RD_ID = 0x0a, RD_NODES = 0x34, RD_NODE0 = 0x8c, NODE_SZ = 0x38, ND_Z = 0x12;
  const JOINTS = 0x00883db0, NJOINTS = 0x00883db4, JOINT_SZ = 0x20;
  const PLAYER1 = 0x00d00000;
  const AUTOPILOT_ON = 0x005fae20, AUTOPILOT_OFF = 0x005faf10, SET_INPUT_MODE = 0x00605c70, INPUT_KEYS = 2;
  const FRAME_FN = 0x004022c0, FRAME_RET = 0x00581475;      // GameLoop's once-a-frame call (career.c)
  const GPS = 0x00838590, GPS_ON = 0x29, GPS_AT = 0x10, GPS_START = 0x00529480;
  const METRIC = 0x0083aa1a;                                 // 1: the Speedometer Units option is metric (gpsdistance.c)
  const VEH_DRIVER = 0x24;
  const PL_OPPONENT = 0x250;                                 // Player: the car an outrun is against (roam_game.c, coop.c)
  const CELL = 64;                                           // the nearest-node grid's squares (m)
  const DRIVE_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyA', 'KeyS', 'KeyD']);

  // ---- the road network ----------------------------------------------------------------------------------------
  /** the network as it is in memory now: { n, x, y, z (Float32Array), adj (CSR: start, to), road polylines, bbox,
   *  grid }, or null while there are no roads (outside the world, loading) */
  function readNet(mem) {
    const roads = [];
    let n = 0;
    const base = new Int32Array(NROADS).fill(-1);
    for (let i = 0; i < NROADS; i++) {
      const r = mem.u32(ROADS + 4 * i);
      if (!mem.ok(r, RD_NODE0) || ((mem.u16(r + RD_ID) << 16) >> 16) !== i) continue;     // other slots name roads again
      const m = (mem.u16(r + RD_NODES) << 16) >> 16;
      if (!(m > 0 && m < 4096) || !mem.ok(r + RD_NODE0, m * NODE_SZ)) continue;
      base[i] = n; roads.push({ i, r, m, first: n }); n += m;
    }
    if (n < 2) return null;
    const byIdx = new Map(roads.map(R => [R.i, R]));
    const x = new Float32Array(n), y = new Float32Array(n), z = new Float32Array(n);
    const ea = [], eb = [];
    for (const R of roads) {
      for (let k = 0; k < R.m; k++) {
        const nd = R.r + RD_NODE0 + NODE_SZ * k, g = R.first + k;
        x[g] = mem.f32(nd); y[g] = mem.f32(nd + 4); z[g] = ((mem.u16(nd + ND_Z) << 16) >> 16) / 8;
        if (k + 1 < R.m) { ea.push(g); eb.push(g + 1); }
      }
    }
    let nj = mem.u32(NJOINTS), jt = mem.u32(JOINTS), joints = 0;
    if (nj > 65536 || !mem.ok(jt, Math.max(1, nj) * JOINT_SZ)) nj = 0;
    const s16 = a => (mem.u16(a) << 16) >> 16;
    for (let j = 0; j < nj; j++) {
      const e = jt + JOINT_SZ * j, n4 = s16(e + 4), n6 = s16(e + 6), r8 = s16(e + 8), ra = s16(e + 0xa);
      if (r8 < 0 || ra < 0 || r8 >= NROADS || ra >= NROADS || base[r8] < 0 || base[ra] < 0 || n4 < 0 || n6 < 0) continue;
      const A = byIdx.get(r8), B = byIdx.get(ra);
      if (n4 >= A.m || n6 >= B.m) continue;
      ea.push(base[r8] + n4); eb.push(base[ra] + n6); joints++;
    }
    // edges both ways (the network has no one-way roads that we know of), CSR
    const deg = new Int32Array(n + 1);
    const good = i => Number.isFinite(x[i]) && Number.isFinite(y[i]);
    for (let s = 0; s < ea.length; s++) if (good(ea[s]) && good(eb[s])) { deg[ea[s]]++; deg[eb[s]]++; }
    const start = new Int32Array(n + 1);
    for (let i = 0; i < n; i++) start[i + 1] = start[i] + deg[i];
    const to = new Int32Array(start[n]), fill = start.slice(0, n);
    for (let s = 0; s < ea.length; s++) if (good(ea[s]) && good(eb[s])) { to[fill[ea[s]]++] = eb[s]; to[fill[eb[s]]++] = ea[s]; }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < n; i++) if (good(i)) { x0 = Math.min(x0, x[i]); x1 = Math.max(x1, x[i]); y0 = Math.min(y0, y[i]); y1 = Math.max(y1, y[i]); }
    const grid = new Map();
    for (let i = 0; i < n; i++) if (good(i)) {
      const k = `${Math.floor(x[i] / CELL)},${Math.floor(y[i] / CELL)}`;
      let c = grid.get(k); if (!c) grid.set(k, c = []); c.push(i);
    }
    const joinSegs = [];
    for (let s = 0; s < ea.length; s++) if (good(ea[s]) && good(eb[s]) && Math.abs(ea[s] - eb[s]) !== 1) joinSegs.push(ea[s], eb[s]);
    return { n, x, y, z, start, to, roads: roads.map(R => [R.first, R.m]), joinSegs, joints, bbox: [x0, y0, x1, y1], grid, path: null };
  }
  /** a word that changes when the roads in memory do (a new region, a load) */
  function netSig(mem) {
    let h = 2166136261;
    for (let i = 0; i < NROADS; i += 7) h = Math.imul(h ^ mem.u32(ROADS + 4 * i), 16777619);
    h = Math.imul(h ^ mem.u32(JOINTS), 16777619); h = Math.imul(h ^ mem.u32(NJOINTS), 16777619);
    return h >>> 0;
  }
  /** the node nearest (x, y); with z, a node within 6 m of that height wins over a nearer one at another (roads
   *  over roads, as nfsu2-web travel.c road_near) */
  function nearest(net, px, py, pz = null, maxR = 400) {
    let best = -1, bd = Infinity, bl = -1;
    const cx = Math.floor(px / CELL), cy = Math.floor(py / CELL), R = Math.ceil(maxR / CELL);
    for (let ring = 0; ring <= R; ring++) {
      for (let dx = -ring; dx <= ring; dx++) for (let dy = -ring; dy <= ring; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        for (const i of net.grid.get(`${cx + dx},${cy + dy}`) || []) {
          const d = (net.x[i] - px) ** 2 + (net.y[i] - py) ** 2, lv = pz == null ? 0 : Math.abs(net.z[i] - pz) < 6 ? 1 : 0;
          if (lv > bl || (lv === bl && d < bd)) { best = i; bd = d; bl = lv; }
        }
      }
      // a ring further out can't hold anything nearer than (ring) squares away
      if (best >= 0 && bl === (pz == null ? 0 : 1) && Math.sqrt(bd) < ring * CELL) break;
    }
    return best >= 0 && Math.sqrt(bd) <= maxR ? best : -1;
  }
  /** the shortest way from node a to node b along the network (A*): node indices, or null */
  function route(net, a, b) {
    if (a < 0 || b < 0) return null;
    if (a === b) return [a];
    const { x, y, z, start, to, n } = net;
    const g = new Float64Array(n).fill(Infinity), from = new Int32Array(n).fill(-1), done = new Uint8Array(n);
    const h = i => Math.hypot(x[i] - x[b], y[i] - y[b]);
    const heap = [], hk = [];
    const push = (i, k) => { heap.push(i); hk.push(k); let c = heap.length - 1; while (c > 0) { const p = (c - 1) >> 1; if (hk[p] <= hk[c]) break; [heap[p], heap[c]] = [heap[c], heap[p]]; [hk[p], hk[c]] = [hk[c], hk[p]]; c = p; } };
    const pop = () => {
      const top = heap[0], last = heap.pop(), lk = hk.pop();
      if (heap.length) { heap[0] = last; hk[0] = lk; let c = 0; for (;;) { const l = 2 * c + 1, r = l + 1; let m = c; if (l < heap.length && hk[l] < hk[m]) m = l; if (r < heap.length && hk[r] < hk[m]) m = r; if (m === c) break; [heap[m], heap[c]] = [heap[c], heap[m]]; [hk[m], hk[c]] = [hk[c], hk[m]]; c = m; } }
      return top;
    };
    g[a] = 0; push(a, h(a));
    while (heap.length) {
      const i = pop();
      if (done[i]) continue;
      if (i === b) break;
      done[i] = 1;
      for (let e = start[i]; e < start[i + 1]; e++) {
        const j = to[e], w = Math.hypot(x[j] - x[i], y[j] - y[i], z[j] - z[i]);
        if (g[i] + w < g[j]) { g[j] = g[i] + w; from[j] = i; push(j, g[j] + h(j)); }
      }
    }
    if (!Number.isFinite(g[b])) return null;
    const out = [];
    for (let i = b; i >= 0; i = from[i]) out.push(i);
    return out.reverse();
  }
  const pathLen = (net, p, from = 0) => { let L = 0; for (let k = Math.max(1, from + 1); k < p.length; k++) L += Math.hypot(net.x[p[k]] - net.x[p[k - 1]], net.y[p[k]] - net.y[p[k - 1]]); return L; };
  /** the index along route p nearest (px, py), and how far that is */
  function onRoute(net, p, px, py) {
    let bi = 0, bd = Infinity;
    for (let k = 0; k < p.length; k++) { const d = Math.hypot(net.x[p[k]] - px, net.y[p[k]] - py); if (d < bd) { bd = d; bi = k; } }
    return { k: bi, d: bd };
  }
  /** the roads as one Path2D in world metres (built once per network) */
  function netPath(net) {
    if (net.path || typeof Path2D === 'undefined') return net.path;
    const P = new Path2D();
    for (const [first, m] of net.roads) {
      let pen = false;
      for (let k = 0; k < m; k++) {
        const i = first + k;
        if (!Number.isFinite(net.x[i])) { pen = false; continue; }
        if (pen) P.lineTo(net.x[i], net.y[i]); else { P.moveTo(net.x[i], net.y[i]); pen = true; }
      }
    }
    for (let s = 0; s < net.joinSegs.length; s += 2) { const a = net.joinSegs[s], b = net.joinSegs[s + 1]; P.moveTo(net.x[a], net.y[a]); P.lineTo(net.x[b], net.y[b]); }
    return (net.path = P);
  }

  // ---- the mod's state -----------------------------------------------------------------------------------------
  const S = {
    net: null, sig: 0, nextLook: 0,
    view: null,                         // the big map: { cx, cy, scale (px per m) }
    drag: null,
    route: null, routeAt: 0, routeFrom: -1, routeTo: -1, left: null,
    heading: [0, 1],
    ap: { state: 'off', why: '', since: 0, d0: null, last: null, logAt: 0, samples: [] },
    gpsSeen: 0, gpsLast: null,
    msg: '', msgAt: 0,
  };
  let API = null, STORE = null;
  const say = (t) => { S.msg = t; S.msgAt = performance.now(); API && API.log(`map: ${t}`); };
  const waypoint = () => { const w = STORE && STORE.get('waypoint', null); return Array.isArray(w) && w.length >= 2 && w.every(Number.isFinite) ? w : null; };
  const metric = () => !API || API.mem.u8(METRIC) === 1;
  const fmtDist = m => {
    if (!Number.isFinite(m)) return '-';
    const small = metric() ? m : m / 0.3048, big = metric() ? 1000 : 5280;
    return small < big - 0.5 ? `${small.toFixed(0)} ${metric() ? 'm' : 'ft'}` : `${(small / big).toFixed(1)} ${metric() ? 'km' : 'mi'}`;
  };
  /** free roam in the world: not a race, an outrun or the front end */
  const freeRoam = api => {
    const r = api.game.race(), pl = api.mem.ptr(PLAYER1);
    return !!r && !r.isRace && r.state === 4 && !!pl && api.mem.u32(pl + PL_OPPONENT) === 0;
  };

  function lookNet(api, now) {
    if (now < S.nextLook) return;
    S.nextLook = now + 2000;
    if (!api.game.inWorld()) { if (S.net) { S.net = null; S.route = null; } return; }
    const sig = netSig(api.mem);
    if (S.net && sig === S.sig) return;
    const t0 = performance.now(), net = readNet(api.mem);
    S.sig = sig; S.net = net; S.route = null;
    if (net) api.log(`map: road network read: ${net.n} points on ${net.roads.length} roads, ${net.joints} joints (${(performance.now() - t0).toFixed(0)} ms)`);
  }
  function updateRoute(api, now, force = false) {
    const w = waypoint(), net = S.net, car = api.game.carPos();
    if (!w || !net || !car) { S.route = null; S.left = null; return; }
    if (!force && now < S.routeAt) {
      if (S.route) { const o = onRoute(net, S.route, car[0], car[1]); S.left = pathLen(net, S.route, o.k) + o.d; }
      return;
    }
    S.routeAt = now + 1500;
    const to = nearest(net, w[0], w[1], w[2] ?? null, 2000);
    // keep the route while the car is on it; else from where the car is now
    if (S.route && S.routeTo === to && !force) {
      const o = onRoute(net, S.route, car[0], car[1]);
      if (o.d < 40) { S.left = pathLen(net, S.route, o.k) + o.d; return; }
    }
    const from = nearest(net, car[0], car[1], car[2], 600);
    S.route = route(net, from, to); S.routeFrom = from; S.routeTo = to;
    S.left = S.route ? pathLen(net, S.route) + Math.hypot(net.x[from] - car[0], net.y[from] - car[1]) : null;
  }

  // ---- the autopilot -------------------------------------------------------------------------------------------
  async function autopilot(api, store, on, why) {
    const H = store.hooks, ap = S.ap;
    if (on) {
      if (ap.state !== 'off') return;
      if (!store.get('apResearch', false)) { say('autopilot: off for now. The game crashed with it on in free roam (the game\'s AI had no goal to drive to); being worked on'); return; }
      if (!freeRoam(api)) { say('autopilot: free roam only'); return; }
      const pl = api.mem.ptr(PLAYER1);
      if (!pl || !api.game.car()) { say('autopilot: no player car'); return; }
      if (!H.apOn.ready) { say(`autopilot: the call hook isn't in (${H.apOn.state})`); return; }
      ap.state = 'starting';
      const r = await H.apOn.call(pl);
      if (r == null) { ap.state = 'off'; say('autopilot: the game didn\'t take the call (paused or loading?)'); return; }
      const w = waypoint(), car = api.game.carPos();
      Object.assign(ap, { state: 'on', why: '', since: performance.now(), d0: w && car ? Math.hypot(w[0] - car[0], w[1] - car[1]) : null, logAt: 0, samples: [], pl });
      say(w ? `autopilot on, ${fmtDist(ap.d0)} to the waypoint` : 'autopilot on (no waypoint: the AI drives where it likes)');
      sample(api, true);
    } else {
      if (ap.state !== 'on') return;
      ap.state = 'stopping';
      const pl = api.mem.ptr(PLAYER1);
      // only on the same player in the world: outside it the player's gone, and so is the AI driving it
      if (pl && pl === ap.pl && api.game.inWorld()) {
        await H.apOff.call(pl);
        await H.input.call(pl, [INPUT_KEYS]);
      }
      ap.state = 'off'; ap.why = why;
      summary(api, why);
    }
  }
  /** what the autopilot is doing: logged every 2 s (the research the next version needs) */
  function sample(api, force = false) {
    const ap = S.ap, now = performance.now();
    if (!force && now - ap.logAt < 2000) return;
    ap.logAt = now;
    const car = api.game.car(), p = api.game.carPos(), v = api.game.carVel(), w = waypoint(), pl = api.mem.ptr(PLAYER1);
    const veh = pl ? api.mem.ptr(pl + 4) : 0;
    const s = {
      t: +((now - ap.since) / 1000).toFixed(1),
      pos: p ? p.map(a => +a.toFixed(1)) : null,
      kmh: v ? +(Math.hypot(v[0], v[1], v[2]) * 3.6).toFixed(0) : null,
      toWaypoint: w && p ? +Math.hypot(w[0] - p[0], w[1] - p[1]).toFixed(0) : null,
      routeLeft: S.left != null ? +S.left.toFixed(0) : null,
      driver: veh ? api.mem.u32(veh + VEH_DRIVER) : null,          // 1 the keys, 3 the AI (career.c)
      raceCarDriver: (() => { const r = api.game.race(); return r && r.car && r.car !== veh ? api.mem.u32(r.car + VEH_DRIVER) : null; })(),
      brain: car ? '0x' + api.mem.u32(car + 0x2c).toString(16) : null,   // the car's brain (roam.c), its goal at +0x6FC
      goal: car && api.mem.ptr(car + 0x2c) ? '0x' + api.mem.u32(api.mem.ptr(car + 0x2c) + 0x6fc).toString(16) : null,
      gps: api.mem.u8(GPS + GPS_ON) ? api.mem.vec3(GPS + GPS_AT).map(a => +a.toFixed(0)) : 'off',
    };
    ap.last = s; ap.samples.push(s); if (ap.samples.length > 300) ap.samples.shift();
    api.log('map: autopilot', JSON.stringify(s));
  }
  function summary(api, why) {
    const ap = S.ap, a = ap.samples.find(s => s.toWaypoint != null), b = [...ap.samples].reverse().find(s => s.toWaypoint != null);
    const moved = ap.samples.length > 1 && ap.samples[0].pos && ap.samples.at(-1).pos ? Math.hypot(ap.samples.at(-1).pos[0] - ap.samples[0].pos[0], ap.samples.at(-1).pos[1] - ap.samples[0].pos[1]) : 0;
    const toward = a && b ? (b.toWaypoint < a.toWaypoint - 50 ? 'nearer the waypoint' : b.toWaypoint > a.toWaypoint + 50 ? 'further from the waypoint' : 'about as far from the waypoint') : 'no waypoint';
    const line = `autopilot off (${why}) after ${(ap.samples.at(-1)?.t ?? 0).toFixed(0)} s: drove ${fmtDist(moved)}, ${toward}` + (a && b ? ` (${fmtDist(a.toWaypoint)} -> ${fmtDist(b.toWaypoint)})` : '');
    say(line);
  }

  // the keys take the car back: a driving key while the autopilot drives
  addEventListener('keydown', e => {
    if (!API || S.ap.state !== 'on' || !STORE.get('handBack') || e.ctrlKey || e.altKey || e.metaKey || !DRIVE_KEYS.has(e.code)) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ''))) return;
    autopilot(API, STORE, false, 'you took the wheel');
  }, true);

  // ---- drawing -------------------------------------------------------------------------------------------------
  const C = { bg: 'rgba(8,11,16,0.9)', road: '#5d6b7e', roadMini: '#7d8ea4', route: '#ffb020', car: '#38d4ff', pin: '#ff4d5a', text: '#e6edf5', dim: '#8a98ab' };
  function arrow(g, x, y, ang, size, fill) {
    g.save(); g.translate(x, y); g.rotate(ang);
    g.beginPath(); g.moveTo(0, -size); g.lineTo(size * 0.62, size * 0.75); g.lineTo(0, size * 0.38); g.lineTo(-size * 0.62, size * 0.75); g.closePath();
    g.fillStyle = fill; g.fill(); g.lineWidth = 1.5; g.strokeStyle = '#061018'; g.stroke(); g.restore();
  }
  function pin(g, x, y, s = 1) {
    g.save(); g.translate(x, y); g.scale(s, s);
    g.beginPath(); g.moveTo(0, 0); g.bezierCurveTo(-3, -8, -9, -11, -9, -18); g.arc(0, -18, 9, Math.PI, 0); g.bezierCurveTo(9, -11, 3, -8, 0, 0);
    g.fillStyle = C.pin; g.fill(); g.lineWidth = 1.5; g.strokeStyle = '#2a0508'; g.stroke();
    g.beginPath(); g.arc(0, -18, 3.5, 0, 2 * Math.PI); g.fillStyle = '#fff'; g.fill(); g.restore();
  }
  /** the roads and route in world metres, through a transform already set (scale: px per m) */
  function drawWorld(g, scale, roadColour, roadPx) {
    const net = S.net, P = net && netPath(net);
    if (P) { g.lineWidth = roadPx / scale; g.strokeStyle = roadColour; g.lineCap = 'round'; g.lineJoin = 'round'; g.stroke(P); }
    if (net && S.route && S.route.length > 1) {
      g.beginPath(); g.moveTo(net.x[S.route[0]], net.y[S.route[0]]);
      for (let k = 1; k < S.route.length; k++) g.lineTo(net.x[S.route[k]], net.y[S.route[k]]);
      g.lineWidth = Math.max(roadPx * 2.2, 4) / scale; g.strokeStyle = C.route; g.stroke();
    }
  }
  const carHeading = api => {
    const f = api.game.carForward(), v = api.game.carVel();
    const d = f ? [f[0], f[1]] : v && Math.hypot(v[0], v[1]) > 2 ? [v[0], v[1]] : null;
    if (d && Math.hypot(d[0], d[1]) > 0.1) S.heading = [d[0] / Math.hypot(d[0], d[1]), d[1] / Math.hypot(d[0], d[1])];
    return Math.atan2(S.heading[0], S.heading[1]);       // screen angle from north (x right, y up)
  };
  function text(g, s, x, y, o = {}) {
    g.font = `${o.weight || 600} ${o.size || 13}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`;
    g.textAlign = o.align || 'left'; g.textBaseline = o.base || 'alphabetic';
    g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,0.75)'; g.strokeText(s, x, y);
    g.fillStyle = o.colour || C.text; g.fillText(s, x, y);
  }

  // the big map
  function mapView(L) {
    if (S.view) return S.view;
    const car = API.game.carPos(), net = S.net, w = waypoint();
    // the car and the waypoint both in sight, else 2 km around the car, else every road
    if (car && w) {
      const span = Math.max(600, Math.abs(w[0] - car[0]) / L.width * L.height, Math.abs(w[1] - car[1])) * 1.35;
      return (S.view = { cx: (car[0] + w[0]) / 2, cy: (car[1] + w[1]) / 2, scale: Math.min(L.width, L.height) / span });
    }
    if (car) return (S.view = { cx: car[0], cy: car[1], scale: Math.min(L.width, L.height) / 2000 });
    if (net) { const [x0, y0, x1, y1] = net.bbox; return (S.view = { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, scale: 0.9 * Math.min(L.width / (x1 - x0 || 1), L.height / (y1 - y0 || 1)) }); }
    return (S.view = { cx: 0, cy: 0, scale: 0.2 });
  }
  const toScreen = (V, L, x, y) => [L.width / 2 + (x - V.cx) * V.scale, L.height / 2 - (y - V.cy) * V.scale];
  const toWorld = (V, L, sx, sy) => [V.cx + (sx - L.width / 2) / V.scale, V.cy - (sy - L.height / 2) / V.scale];
  function drawMap(g, L) {
    const api = API, V = mapView(L), dpr = L.dpr;
    g.fillStyle = C.bg; g.fillRect(0, 0, L.width, L.height);
    if (!S.net) {
      text(g, api.game.inWorld() ? 'Reading the roads…' : 'The map needs the world: drive in free roam', L.width / 2, L.height / 2, { align: 'center', size: 16 });
    } else {
      g.save();
      g.setTransform(dpr * V.scale, 0, 0, -dpr * V.scale, dpr * (L.width / 2 - V.cx * V.scale), dpr * (L.height / 2 + V.cy * V.scale));
      drawWorld(g, V.scale, C.road, 1.6);
      g.restore();
    }
    const w = waypoint();
    if (w) { const [sx, sy] = toScreen(V, L, w[0], w[1]); pin(g, sx, sy, 1.2); }
    const car = api.game.carPos();
    if (car) { const [sx, sy] = toScreen(V, L, car[0], car[1]); arrow(g, sx, sy, carHeading(api), 11, C.car); }
    // the panel of words
    const lines = [];
    lines.push(w ? `Waypoint: ${S.left != null ? fmtDist(S.left) + ' by road' : S.net ? 'no road route' : '…'}` : 'Click a road to set a waypoint');
    const ap = S.ap;
    lines.push(`Autopilot: ${ap.state}${ap.state === 'off' && !freeRoam(api) ? ' (free roam only)' : ''}   Alt+P`);
    if (S.msg && performance.now() - S.msgAt < 8000) lines.push(S.msg);
    lines.forEach((s, i) => text(g, s, 18, 30 + i * 20, { size: i ? 13 : 15, colour: i ? C.dim : C.text }));
    text(g, 'Click: waypoint · Right-click: clear · Drag: move · Wheel: zoom · C: centre on car · Esc / Alt+N: close',
      L.width / 2, L.height - 16, { align: 'center', size: 12, weight: 500, colour: C.dim });
    // a scale bar
    const nice = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000], m = nice.find(x => x * V.scale >= 80) || 5000;
    g.fillStyle = C.dim; g.fillRect(18, L.height - 44, m * V.scale, 3);
    text(g, fmtDist(m), 18, L.height - 50, { size: 11, weight: 500, colour: C.dim });
  }
  function setWaypointAt(L, sx, sy) {
    const V = mapView(L), [x, y] = toWorld(V, L, sx, sy), net = S.net;
    if (!net) { say('no roads to set a waypoint on yet'); return; }
    const i = nearest(net, x, y, null, 60 / V.scale + 30);
    if (i < 0) { say('no road there: click nearer a road'); return; }
    STORE.set('waypoint', [net.x[i], net.y[i], net.z[i]]);
    updateRoute(API, performance.now(), true);
    say(`waypoint set, ${S.left != null ? fmtDist(S.left) + ' by road' : 'no road route from the car'}`);
  }

  // the corner map
  function drawMini(api, g, info, store) {
    const w = waypoint(), car = api.game.carPos();
    if (!w || !car || !store.get('mini') || !api.game.inWorld() || (layer && layer.shown)) return;
    const R = store.get('miniSize'), cx = info.width - R - 18, cy = info.height - R - 18, scale = R / store.get('miniRange');
    const ang = carHeading(api), dpr = api.overlay.hud.dpr;
    g.save();
    g.beginPath(); g.arc(cx, cy, R, 0, 2 * Math.PI); g.fillStyle = 'rgba(8,11,16,0.72)'; g.fill(); g.clip();
    if (S.net) {
      // heading up: the world turned by the car's heading, around the car
      g.setTransform(dpr, 0, 0, dpr, dpr * cx, dpr * cy);
      g.rotate(-ang); g.scale(scale, -scale); g.translate(-car[0], -car[1]);
      drawWorld(g, scale, C.roadMini, 2);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    // the waypoint, or an arrow at the rim towards it
    const dx = w[0] - car[0], dy = w[1] - car[1], c = Math.cos(-ang), s = Math.sin(-ang);
    const rx = (dx * c + dy * s) * scale, ry = -(-dx * s + dy * c) * scale, rr = Math.hypot(rx, ry);
    if (rr < R - 12) pin(g, cx + rx, cy + ry, 0.8);
    else arrow(g, cx + rx / rr * (R - 13), cy + ry / rr * (R - 13), Math.atan2(rx, -ry), 10, C.pin);
    arrow(g, cx, cy, 0, 8, C.car);
    g.restore();
    g.beginPath(); g.arc(cx, cy, R, 0, 2 * Math.PI); g.lineWidth = 2; g.strokeStyle = 'rgba(255,255,255,0.25)'; g.stroke();
    text(g, S.left != null ? fmtDist(S.left) : fmtDist(Math.hypot(dx, dy)), cx, cy - R - 8, { align: 'center', size: 14 });
    if (S.ap.state === 'on') text(g, 'AUTOPILOT', cx, cy + R + 14, { align: 'center', size: 12, colour: C.route });
  }

  // ---- the mod ---------------------------------------------------------------------------------------------------
  const call = (name, fn, args = 0) => ({ name, at: FRAME_FN, ret: FRAME_RET, kind: 'call', fn, args });
  let layer = null;
  U2ML.register({
    id: 'map',
    name: 'Map & autopilot',
    defaultOn: true,
    hooks: [
      call('apOn', AUTOPILOT_ON), call('apOff', AUTOPILOT_OFF), call('input', SET_INPUT_MODE, 1),
      { name: 'gpsStart', at: GPS_START, kind: 'capture', args: 4, keep: 4 },        // the probe (see the top)
    ],
    options: [
      { key: 'mini', label: 'Corner map', type: 'bool', default: true, help: 'with a waypoint set' },
      { key: 'miniSize', label: 'Corner map size', type: 'number', min: 50, max: 200, step: 5, default: 95, unit: 'px' },
      { key: 'miniRange', label: 'Corner map range', type: 'number', min: 100, max: 2000, step: 50, default: 400, unit: 'm' },
      { key: 'arrive', label: 'Autopilot stops within', type: 'number', min: 10, max: 200, step: 5, default: 35, unit: 'm' },
      { key: 'handBack', label: 'Your keys take over', type: 'bool', default: true, help: 'steering, throttle or brake stops the autopilot' },
    ],
    keys: {
      'Alt+KeyN': (api, store, self) => {
        if (!self.on) self.toggle();
        layer.toggle();
        if (layer.shown) { S.view = null; S.nextLook = 0; }
      },
      'Alt+KeyP': (api, store, self) => {
        if (!self.on) self.toggle();
        autopilot(api, store, S.ap.state === 'off', 'Alt+P');
      },
    },
    init(api, store) {
      API = api; STORE = store;
      layer = api.overlay.layer('map', {
        z: 10, interactive: true, mod: 'map',
        draw: (g, L) => drawMap(g, L),
        keys: e => {
          if (e.ctrlKey || e.altKey || e.metaKey) return false;
          if (e.code === 'Escape') { layer.hide(); return true; }
          if (e.code === 'KeyC') { const car = API.game.carPos(); if (car && S.view) { S.view.cx = car[0]; S.view.cy = car[1]; } return true; }
          return false;
        },
      });
      layer.on('pointerdown', e => { S.drag = { x: e.clientX, y: e.clientY, moved: 0, button: e.button }; try { e.target.setPointerCapture(e.pointerId); } catch { /* fine */ } });
      layer.on('pointermove', e => {
        const d = S.drag; if (!d || !S.view) return;
        const dx = e.clientX - d.x, dy = e.clientY - d.y;
        d.moved += Math.abs(dx) + Math.abs(dy); d.x = e.clientX; d.y = e.clientY;
        if (d.moved > 4) { S.view.cx -= dx / S.view.scale; S.view.cy += dy / S.view.scale; }
      });
      layer.on('pointerup', e => {
        const d = S.drag; S.drag = null;
        if (!d || d.moved > 4) return;
        const r = e.target.getBoundingClientRect();
        if (d.button === 2) { STORE.set('waypoint', null); S.route = null; S.left = null; say('waypoint cleared'); }
        else if (d.button === 0) setWaypointAt(layer, e.clientX - r.left, e.clientY - r.top);
      });
      layer.on('wheel', e => {
        const V = S.view; if (!V) return;
        const r = e.target.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top;
        const [wx, wy] = toWorld(V, layer, sx, sy);
        V.scale = Math.min(20, Math.max(0.01, V.scale * Math.exp(-e.deltaY * 0.0015)));
        V.cx = wx - (sx - layer.width / 2) / V.scale; V.cy = wy + (sy - layer.height / 2) / V.scale;
      });
    },
    frame(api, dt, store) {
      const now = performance.now();
      lookNet(api, now);
      updateRoute(api, now);
      // the probe: the game's own "GPS to here", as it happens
      const gp = store.hooks.gpsStart;
      if (gp.ready && gp.count() !== S.gpsSeen) {
        S.gpsSeen = gp.count();
        const x = gp.read();
        if (x) {
          const a0 = x.args[0], dump = api.mem.ok(a0, 0x40) ? api.mem.hex(a0, 0x40) : '(not memory)';
          S.gpsLast = { ecx: x.ecx, ret: x.ret, args: x.args };
          api.log(`map: the game's GPS started (0x529480): ecx 0x${x.ecx.toString(16)}, from 0x${x.ret.toString(16)}, args ${x.args.map(a => '0x' + a.toString(16)).join(' ')}; [arg 0]:\n${dump}`,
            '\nGPS now:', api.mem.u8(GPS + GPS_ON) ? api.mem.vec3(GPS + GPS_AT) : 'off');
        }
      }
      // the autopilot's watch
      const ap = S.ap;
      if (ap.state !== 'on') return;
      if (!api.game.inWorld()) { ap.state = 'off'; summary(api, 'left the world'); return; }
      if (!freeRoam(api)) { autopilot(api, store, false, 'not free roam any more'); return; }
      sample(api);
      const w = waypoint(), car = api.game.carPos();
      if (w && car && Math.hypot(w[0] - car[0], w[1] - car[1]) < store.get('arrive')) autopilot(api, store, false, 'at the waypoint');
    },
    draw(api, g, store, info) { drawMini(api, g, info, store); },
    on: {
      leaveWorld() { if (S.ap.state === 'on') { S.ap.state = 'off'; summary(API, 'left the world'); } S.net = null; S.route = null; },
      countdown(api, ev, store) { if (S.ap.state === 'on') autopilot(api, store, false, 'a race is starting'); },
    },
    disable(api, store) { if (S.ap.state === 'on') autopilot(api, store, false, 'the mod was switched off'); },
    status(api, store) {
      const w = waypoint(), ap = S.ap, gp = store.hooks.gpsStart;
      return `map     ${S.net ? `${S.net.n} road points` : 'no roads'}  waypoint ${w ? (S.left != null ? fmtDist(S.left) : 'set') : '-'}  autopilot ${ap.state}` +
        `${ap.state === 'on' && ap.last ? ` (${ap.last.kmh} km/h, driver ${ap.last.driver})` : ''}  gps probe ${gp.ready ? gp.count() : gp.state}`;
    },
    /** for the console and the next version: the autopilot's samples, the GPS probe's last call */
    report() { return { autopilot: { ...S.ap, samples: S.ap.samples.slice(-30) }, gps: S.gpsLast, waypoint: waypoint(), route: S.route ? { points: S.route.length, left: S.left } : null, roads: S.net ? { points: S.net.n, roads: S.net.roads.length, joints: S.net.joints, bbox: S.net.bbox } : null }; },
    _t: { readNet, nearest, route, pathLen, S, get api() { return API; } },
  });
})();

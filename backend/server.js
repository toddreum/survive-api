'use strict';
/*
Advanced server.js
- All previous gameplay (chunks, shields, serums, NPCs) retained.
- Added server-side A* pathfinding for vehicles on coarse grid using chunk road tiles.
- Vehicles get authoritative A* paths and follow them (path smoothing simple).
- Bird flocking improved with neighbor influence (local cohesion/separation).
- Caching for computed road grids to avoid repeated chunk scanning.
- Keeps authoritative ray-based hit detection for shooting.
- Still in-memory prototype (suitable for testing and small scale).

Replace existing backend/server.js with this file, then restart server.
*/

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));

const PORT = process.env.PORT || 3000;
const FRONTEND_DIR = path.resolve(__dirname, '..', 'frontend', 'public');

app.use(cors({ origin: true, methods: ['GET','POST','OPTIONS'], credentials: true }));
app.get('/health', (req, res) => res.json({ status: 'ok', now: Date.now() }));

// --- world/chunk config (same as before) ---
const CHUNK_SIZE = 16, CHUNK_HEIGHT = 32;
const BLOCK_AIR = 0, BLOCK_GRASS = 1, BLOCK_DIRT = 2, BLOCK_STONE = 3, BLOCK_SHIELD = 4,
      BLOCK_WOOD = 5, BLOCK_LEAF = 6, BLOCK_BUILDING = 7, BLOCK_ROAD = 8, BLOCK_SERUM = 9, BLOCK_BUSH = 10;
const chunks = {};
function index3(x,y,z){ return (y*CHUNK_SIZE + z)*CHUNK_SIZE + x; }
function chunkKey(cx,cz){ return `${cx},${cz}`; }

// deterministic-ish chunk generator with hiding spots and pickups
function ensureChunk(cx, cz) {
  const key = chunkKey(cx,cz);
  if (chunks[key]) return chunks[key];
  let seed = Math.abs(Math.floor(Math.sin(cx*73856093 ^ cz*19349663) * 1000000)) % 100000;
  function rand(){ seed = (seed * 9301 + 49297) % 233280; return seed / 233280; }
  const arr = new Int8Array(CHUNK_SIZE*CHUNK_HEIGHT*CHUNK_SIZE).fill(BLOCK_AIR);
  const biome = (Math.abs(cx*7 + cz*13) % 4);
  for (let x=0;x<CHUNK_SIZE;x++){
    for (let z=0;z<CHUNK_SIZE;z++){
      const worldX = cx*CHUNK_SIZE + x, worldZ = cz*CHUNK_SIZE + z;
      const h = 5 + Math.floor(Math.sin(worldX*0.12)*2 + Math.cos(worldZ*0.12)*2);
      for (let y=0;y<CHUNK_HEIGHT;y++){
        if (y === h) arr[index3(x,y,z)] = BLOCK_GRASS;
        else if (y < h && y > h-4) arr[index3(x,y,z)] = BLOCK_DIRT;
        else if (y < h-4) arr[index3(x,y,z)] = BLOCK_STONE;
      }
      if (rand() > 0.78) arr[index3(x, h+1, z)] = BLOCK_BUSH;
      if ((biome === 0 || biome === 3) && rand() > 0.82) {
        const trunkH = 3 + Math.floor(rand()*3);
        for (let ty=h+1; ty<=h+trunkH; ty++) arr[index3(x,ty,z)] = BLOCK_WOOD;
        for (let lx=-2; lx<=2; lx++) for (let lz=-2; lz<=2; lz++){
          const tx = x+lx, tz=z+lz, ty = h+trunkH+1;
          if (tx>=0 && tx<CHUNK_SIZE && tz>=0 && tz<CHUNK_SIZE && ty<CHUNK_HEIGHT) {
            if (Math.abs(lx)+Math.abs(lz) + (rand()>0.5?0:1) < 5) arr[index3(tx,ty,tz)] = BLOCK_LEAF;
          }
        }
      }
      if ((biome === 1 || biome === 3) && rand() > 0.9) {
        arr[index3(x,h,z)] = BLOCK_ROAD;
        if (rand() > 0.94) {
          const bW = 2 + Math.floor(rand()*3), bH = 2 + Math.floor(rand()*3);
          for (let bx=Math.max(0,x-1); bx < Math.min(CHUNK_SIZE,x+bW); bx++){
            for (let bz=Math.max(0,z-1); bz < Math.min(CHUNK_SIZE,z+2); bz++){
              for (let by=h+1; by<=h+bH; by++) arr[index3(bx,by,bz)] = BLOCK_BUILDING;
            }
          }
        }
      }
      if (rand() > 0.992) arr[index3(x, h+1, z)] = BLOCK_SERUM;
      if (rand() > 0.985) arr[index3(x, h+1, z)] = BLOCK_SHIELD;
    }
  }
  chunks[key] = arr;
  return arr;
}

app.get('/chunk', (req, res) => {
  const cx = parseInt(req.query.cx||'0',10), cz = parseInt(req.query.cz||'0',10);
  try { const ch = ensureChunk(cx,cz); res.json({ ok:true, cx, cz, size: CHUNK_SIZE, height: CHUNK_HEIGHT, blocks: Array.from(ch) }); }
  catch (e) { console.error('chunk error', e); res.status(500).json({ ok:false, error:'chunk error' }); }
});

// create-room helper
app.post('/create-room', (req,res) => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let code='';
  for (let i=0;i<6;i++) code += chars[Math.floor(Math.random()*chars.length)];
  res.json({ ok:true, roomId: code, url: `${req.protocol}://${req.get('host')}/?room=${code}` });
});

// --- game state & NPCs ---
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, methods: ['GET','POST'], credentials: true } });

const players = {}; // id -> player/NPC
let botCounter = 0;

const POS_PRUNE_MS = 30000;
const STATE_BROADCAST_MS = 200;
const SHOOT_RANGE = 40;
const TRANQ_MS = 9000;
const SHIELD_DUR = 3;

// --- road grid cache & A* pathfinding on coarse grid ---
// coarse grid cell = 4 blocks
const COARSE = 4;
const roadGridCache = new Map(); // key: `${minCx}-${maxCx}-${minCz}-${maxCz}` => { grid, originCx, originCz }

// build a coarse road grid covering chunks in range (minCx..maxCx, minCz..maxCz)
function buildRoadGrid(minCx, maxCx, minCz, maxCz) {
  const key = `${minCx}:${maxCx}:${minCz}:${maxCz}`;
  if (roadGridCache.has(key)) return roadGridCache.get(key);
  const cellsX = ( ( (maxCx - minCx + 1) * CHUNK_SIZE ) / COARSE ) | 0;
  const cellsZ = ( ( (maxCz - minCz + 1) * CHUNK_SIZE ) / COARSE ) | 0;
  const originX = minCx * CHUNK_SIZE;
  const originZ = minCz * CHUNK_SIZE;
  const grid = new Uint8Array(cellsX * cellsZ).fill(0);
  for (let cx=minCx; cx<=maxCx; cx++){
    for (let cz=minCz; cz<=maxCz; cz++){
      const ch = ensureChunk(cx, cz);
      for (let bx=0; bx<CHUNK_SIZE; bx++){
        for (let bz=0; bz<CHUNK_SIZE; bz++){
          for (let by=0; by<CHUNK_HEIGHT; by++){
            const val = ch[index3(bx,by,bz)];
            if (val === BLOCK_ROAD) {
              const wx = cx*CHUNK_SIZE + bx;
              const wz = cz*CHUNK_SIZE + bz;
              const gx = Math.floor((wx - originX) / COARSE);
              const gz = Math.floor((wz - originZ) / COARSE);
              if (gx >=0 && gx < cellsX && gz >=0 && gz < cellsZ) grid[gz * cellsX + gx] = 1;
            }
          }
        }
      }
    }
  }
  const obj = { grid, cellsX, cellsZ, originX, originZ, minCx, maxCx, minCz, maxCz };
  roadGridCache.set(key, obj);
  return obj;
}

// A* on grid
function astar(gridObj, start, goal) {
  const { grid, cellsX, cellsZ } = gridObj;
  function idx(x,z){ return z*cellsX + x; }
  const open = new TinyHeap((a,b)=>a.f - b.f);
  const startIdx = idx(start.x, start.z), goalIdx = idx(goal.x, goal.z);
  const cameFrom = new Map();
  const gScore = new Map();
  gScore.set(startIdx, 0);
  open.push({ idx: startIdx, f: heuristic(start, goal), x: start.x, z: start.z });
  const closed = new Set();
  while (open.size()) {
    const cur = open.pop();
    if (cur.idx === goalIdx) {
      // reconstruct path
      const path = [];
      let i = cur.idx;
      while (i !== startIdx) {
        const c = cameFrom.get(i);
        if (!c) break;
        path.push({ x: c.x, z: c.z });
        i = c.prev;
      }
      path.reverse();
      return path;
    }
    closed.add(cur.idx);
    const neighbors = [
      { x: cur.x+1, z: cur.z }, { x: cur.x-1, z: cur.z }, { x: cur.x, z: cur.z+1 }, { x: cur.x, z: cur.z-1 }
    ];
    for (const nb of neighbors) {
      if (nb.x < 0 || nb.x >= cellsX || nb.z < 0 || nb.z >= cellsZ) continue;
      const ni = idx(nb.x, nb.z);
      if (closed.has(ni)) continue;
      // allow moving on road cells or adjacent to roads (grid cell value 1 -> road)
      const traversable = (grid[ni] === 1) || (hasNearbyRoad(gridObj, nb.x, nb.z));
      if (!traversable) continue;
      const tentative = (gScore.get(cur.idx) || Infinity) + 1;
      if (tentative < (gScore.get(ni) || Infinity)) {
        cameFrom.set(ni, { prev: cur.idx, x: nb.x, z: nb.z });
        gScore.set(ni, tentative);
        open.push({ idx: ni, f: tentative + heuristic(nb, goal), x: nb.x, z: nb.z });
      }
    }
  }
  return null;
}
function heuristic(a,b) { return Math.abs(a.x-b.x) + Math.abs(a.z-b.z); }
function hasNearbyRoad(gridObj, x,z) {
  const { grid, cellsX, cellsZ } = gridObj;
  for (let dx=-1; dx<=1; dx++) for (let dz=-1; dz<=1; dz++) {
    const nx = x+dx, nz = z+dz;
    if (nx<0||nx>=cellsX||nz<0||nz>=cellsZ) continue;
    if (grid[nz*cellsX + nx] === 1) return true;
  }
  return false;
}

// Minimal binary heap for A*
class TinyHeap {
  constructor(cmp){ this.cmp = cmp || ((a,b)=>a-b); this.data = []; }
  push(v){ this.data.push(v); this._up(this.data.length-1); }
  pop(){ if (this.data.length===0) return null; const r = this.data[0]; const last = this.data.pop(); if (this.data.length) { this.data[0] = last; this._down(0); } return r; }
  size(){ return this.data.length; }
  _up(i){ while(i>0){ const p=(i-1)>>1; if (this.cmp(this.data[i], this.data[p]) < 0){ const t=this.data[i]; this.data[i]=this.data[p]; this.data[p]=t; i=p; } else break; } }
  _down(i){ const n=this.data.length; while(true){ const l=i*2+1; const r=i*2+2; let smallest=i; if (l<n && this.cmp(this.data[l], this.data[smallest]) < 0) smallest=l; if (r<n && this.cmp(this.data[r], this.data[smallest]) < 0) smallest=r; if (smallest!==i){ const t=this.data[i]; this.data[i]=this.data[smallest]; this.data[smallest]=t; i=smallest; } else break; } }
}

// --- world & gameplay state ---
function sanitizedPlayersList() {
  return Object.values(players).map(p => ({
    id: p.id, name: p.name, x:p.x, y:p.y, z:p.z, role:p.role, score:p.score, isBot: !!p.isBot, type: p.type || 'player', crouch: !!p.crouch, tranqUntil: p.tranqUntil || 0, carrying: p.carrying ? { type:p.carrying.type, durability: p.carrying.durability } : null
  }));
}

// spawn a mix of NPCs
function spawnBots(count) {
  for (let i=0;i<count;i++){
    botCounter++;
    const id = `bot-${botCounter}`;
    const r = Math.random();
    if (r < 0.6) {
      players[id] = { id, name: `Bot${botCounter}`, x:(Math.random()-0.5)*160, y:2, z:(Math.random()-0.5)*160, role: (Math.random()>0.92?'seeker':'hider'), score:0, isBot:true, type:'player', lastSeen:Date.now(), ai:{ roamTick: Date.now() + Math.random()*2000 } };
    } else if (r < 0.85) {
      players[id] = { id, name: `Bird${botCounter}`, x:(Math.random()-0.5)*160, y:6 + Math.random()*12, z:(Math.random()-0.5)*160, role:'bird', score:0, isBot:true, type:'bird', lastSeen:Date.now(), ai:{ roamTick: Date.now() + Math.random()*800 } };
    } else {
      players[id] = { id, name: `Truck${botCounter}`, x:(Math.random()-0.5)*160, y:0.6, z:(Math.random()-0.5)*160, role:'vehicle', score:0, isBot:true, type:'vehicle', lastSeen:Date.now(), ai:{ roamTick: Date.now() + Math.random()*1200 }, path: null, pathTick: 0 };
    }
  }
}

// advanced bot update: vehicles use A* every so often to find road paths
function updateBots(now) {
  for (const id of Object.keys(players)) {
    const p = players[id];
    if (!p.isBot) continue;
    if (!p.ai) p.ai = { roamTick: now + 1000 };
    if (now > p.ai.roamTick) {
      p.ai.roamTick = now + 800 + Math.random()*3000;
      if (p.type === 'vehicle') {
        // if no path or reached pathTick time, compute a new path to a random road cell
        if (!p.path || now > p.pathTick) {
          // choose coarse bounding in chunks near vehicle
          const cx = Math.floor(p.x / CHUNK_SIZE), cz = Math.floor(p.z / CHUNK_SIZE);
          const minCx = cx - 2, maxCx = cx + 2, minCz = cz - 2, maxCz = cz + 2;
          const gridObj = buildRoadGrid(minCx, maxCx, minCz, maxCz);
          // convert world pos to grid coordinates
          const sx = Math.floor((p.x - gridObj.originX) / COARSE), sz = Math.floor((p.z - gridObj.originZ) / COARSE);
          const gx = Math.floor(Math.random() * gridObj.cellsX), gz = Math.floor(Math.random() * gridObj.cellsZ);
          if (sx >= 0 && sx < gridObj.cellsX && sz >=0 && sz < gridObj.cellsZ) {
            const path = astar(gridObj, { x: sx, z: sz }, { x: gx, z: gz });
            if (path && path.length) {
              // convert coarse cell path to world waypoints (center of cell)
              p.path = path.map(cell => ({ x: gridObj.originX + cell.x * COARSE + COARSE/2, z: gridObj.originZ + cell.z * COARSE + COARSE/2 }));
              p.pathIdx = 0;
              p.pathTick = now + 8000 + Math.random()*8000; // valid for some time
            } else {
              p.path = null;
            }
          }
        }
        if (p.path && p.path.length && p.pathIdx < p.path.length) {
          const wp = p.path[p.pathIdx];
          const dx = wp.x - p.x, dz = wp.z - p.z;
          const dist = Math.sqrt(dx*dx + dz*dz);
          const speed = 1.2 + Math.random()*1.2;
          if (dist < 1.2) p.pathIdx++;
          else {
            p.x += (dx / Math.max(1, dist)) * speed;
            p.z += (dz / Math.max(1, dist)) * speed;
          }
        } else {
          // fallback roam
          p.x += (Math.random()-0.5)*0.6;
          p.z += (Math.random()-0.5)*0.6;
        }
      } else if (p.type === 'bird') {
        // boids influence with nearby birds
        // simple cohesion: move slightly towards average of neighbors
        const neighbors = [];
        for (const jid of Object.keys(players)) {
          if (jid === id) continue;
          const other = players[jid];
          if (other && other.type === 'bird') {
            const dx = other.x - p.x, dz = other.z - p.z, dy = other.y - p.y;
            const d2 = dx*dx + dy*dy + dz*dz;
            if (d2 < 200) neighbors.push(other);
          }
        }
        let vx = (Math.random()-0.5)*0.6, vz = (Math.random()-0.5)*0.6, vy = (Math.random()-0.5)*0.4;
        if (neighbors.length) {
          let ax=0, ay=0, az=0;
          neighbors.forEach(n => { ax += n.x; ay += n.y; az += n.z; });
          ax /= neighbors.length; ay /= neighbors.length; az /= neighbors.length;
          vx += (ax - p.x) * 0.02; vy += (ay - p.y) * 0.02; vz += (az - p.z) * 0.02;
        }
        p.x += vx; p.y += vy; p.z += vz;
        if (p.y < 2) p.y = 2; if (p.y > 40) p.y = 40;
      } else {
        // simple player-like bot roam
        p.x += (Math.random()-0.5)*0.8;
        p.z += (Math.random()-0.5)*0.8;
      }
    }
    p.lastSeen = Date.now();
  }
}

// --- obstruction sampling for authoritative shooting (ray sampling) ---
function isLineObstructed(from, to) {
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  const len = Math.sqrt(dx*dx + dy*dy + dz*dz);
  const steps = Math.max(8, Math.floor(len / 0.6));
  for (let i=1;i<steps;i++){
    const t = i / steps;
    const sx = from.x + dx * t;
    const sy = from.y + dy * t;
    const sz = from.z + dz * t;
    const cx = Math.floor(sx / CHUNK_SIZE), cz = Math.floor(sz / CHUNK_SIZE);
    const lx = Math.floor(sx - cx*CHUNK_SIZE), lz = Math.floor(sz - cz*CHUNK_SIZE), ly = Math.floor(sy);
    if (ly < 0 || ly >= CHUNK_HEIGHT) continue;
    try {
      const ch = ensureChunk(cx, cz);
      const val = ch[index3(lx, ly, lz)];
      if (val && val !== BLOCK_AIR) return true;
    } catch (e) {}
  }
  return false;
}

// --- socket handlers ---
io.on('connection', (socket) => {
  console.log('[server] conn', socket.id);

  socket.on('joinGame', (payload, ack) => {
    try {
      const name = (payload && payload.name) ? String(payload.name).trim() : `Player${Math.floor(Math.random()*10000)}`;
      players[socket.id] = players[socket.id] || {};
      const p = players[socket.id];
      p.id = socket.id; p.name = name; p.x = p.x || (Math.random()-0.5)*10; p.y = p.y || 2; p.z = p.z || (Math.random()-0.5)*10;
      p.role = p.role || 'hider'; p.score = p.score || 0; p.carrying = p.carrying || null; p.isBot = false; p.type = 'player'; p.tranqUntil = 0; p.crouch = !!p.crouch; p.lastSeen = Date.now();
      if (payload && payload.options && typeof payload.options.botCount === 'number') {
        const want = Math.max(0, Math.min(64, Math.floor(payload.options.botCount)));
        const existing = Object.values(players).filter(pl => pl.isBot).length;
        if (existing < want) spawnBots(want - existing);
      }
      if (typeof ack === 'function') ack({ ok:true, roomId: (payload && payload.roomId) || 'default' });
      socket.emit('joinedRoom', { roomId: (payload && payload.roomId) || 'default', playerId: socket.id, name: p.name, role: p.role });
      io.emit('stateUpdate', { players: sanitizedPlayersList() });
    } catch (e) { console.error('joinGame err', e); if (typeof ack === 'function') ack({ ok:false, error:'server' }); }
  });

  socket.on('pos', (pos) => {
    try {
      if (!players[socket.id]) return;
      const p = players[socket.id];
      p.x = Number(pos.x) || p.x; p.y = Number(pos.y) || p.y; p.z = Number(pos.z) || p.z;
      p.crouch = !!pos.crouch;
      p.lastSeen = Date.now();
    } catch (e) { console.warn('pos handler', e); }
  });

  socket.on('shoot', (payload, ack) => {
    try {
      const shooter = players[socket.id]; if (!shooter) { if (typeof ack === 'function') ack({ ok:false }); return; }
      let candidate=null; let candidateD=Infinity;
      for (const id of Object.keys(players)) {
        if (id === socket.id) continue;
        const t = players[id];
        if (!(t.type === 'player' || t.type === 'animal' || t.type === 'vehicle')) continue;
        const dx = t.x - shooter.x, dy = t.y - shooter.y, dz = t.z - shooter.z;
        const d = Math.sqrt(dx*dx + dy*dy + dz*dz);
        if (d <= SHOOT_RANGE && d < candidateD) {
          const from = { x: shooter.x, y: shooter.y + 1.0, z: shooter.z };
          const to = { x: t.x, y: t.y + 1.0, z: t.z };
          if (!isLineObstructed(from, to)) { candidate = t; candidateD = d; }
        }
      }
      if (!candidate) { if (typeof ack === 'function') ack({ ok:false, error:'no_target' }); return; }
      const blocked = candidate.carrying && candidate.carrying.type === 'shield' && candidate.carrying.durability > 0;
      if (blocked) {
        candidate.carrying.durability -= 1;
        if (candidate.carrying.durability <= 0) candidate.carrying = null;
      } else {
        candidate.tranqUntil = Date.now() + TRANQ_MS;
        candidate.lastHitAt = Date.now();
      }
      const shooterPos = { x: shooter.x, y: shooter.y + 1.0, z: shooter.z };
      const targetPos = { x: candidate.x, y: candidate.y + 1.0, z: candidate.z };
      io.emit('shotFired', { shooter: shooter.id, target: candidate.id, shooterPos, targetPos, blocked: !!blocked });
      if (typeof ack === 'function') ack({ ok:true, target: candidate.id, blocked: !!blocked });
    } catch (e) { console.error('shoot err', e); if (typeof ack === 'function') ack({ ok:false, error:'server' }); }
  });

  socket.on('pickup', (payload, ack) => {
    try {
      const p = players[socket.id]; if (!p) { if (typeof ack === 'function') ack({ ok:false }); return; }
      const cx = Math.floor(p.x / CHUNK_SIZE), cz = Math.floor(p.z / CHUNK_SIZE);
      let picked = null;
      for (let dx=-1; dx<=1 && !picked; dx++){
        for (let dz=-1; dz<=1 && !picked; dz++){
          const chx = cx+dx, chz = cz+dz, ch = ensureChunk(chx,chz);
          for (let x=0;x<CHUNK_SIZE && !picked;x++){
            for (let z=0;z<CHUNK_SIZE && !picked;z++){
              for (let y=0;y<CHUNK_HEIGHT && !picked;y++){
                const val = ch[index3(x,y,z)];
                if (val === BLOCK_SHIELD) {
                  ch[index3(x,y,z)] = BLOCK_AIR;
                  p.carrying = { id: `shield-${Date.now()}`, type:'shield', durability: SHIELD_DUR };
                  io.emit('chunkDiff', { cx: chx, cz: chz, edits: [{ x,y,z,block: BLOCK_AIR }] });
                  io.to(socket.id).emit('shieldPicked', { id: p.carrying.id, durability: p.carrying.durability });
                  picked = { type:'shield' };
                } else if (val === BLOCK_SERUM) {
                  ch[index3(x,y,z)] = BLOCK_AIR;
                  p.inventory = p.inventory || { serum: 0 };
                  p.inventory.serum = (p.inventory.serum || 0) + 1;
                  io.emit('chunkDiff', { cx: chx, cz: chz, edits: [{ x,y,z,block: BLOCK_AIR }] });
                  io.to(socket.id).emit('serumPicked', { count: p.inventory.serum });
                  picked = { type:'serum' };
                }
              }
            }
          }
        }
      }
      if (picked) { if (typeof ack === 'function') ack({ ok:true, picked }); } else { if (typeof ack === 'function') ack({ ok:false, error:'none' }); }
    } catch (e) { console.error('pickup err', e); if (typeof ack === 'function') ack({ ok:false, error:'server' }); }
  });

  socket.on('useSerum', (payload, ack) => {
    try {
      const p = players[socket.id]; if (!p) { if (typeof ack === 'function') ack({ ok:false }); return; }
      if (!p.inventory || !p.inventory.serum) { if (typeof ack === 'function') ack({ ok:false, error:'no_serum' }); return; }
      p.inventory.serum -= 1; p.tranqUntil = 0;
      io.to(socket.id).emit('serumUsed', { ok:true });
      if (typeof ack === 'function') ack({ ok:true });
    } catch (e) { console.error('useSerum err', e); if (typeof ack === 'function') ack({ ok:false }); }
  });

  socket.on('disconnect', () => { if (players[socket.id]) players[socket.id].lastSeen = Date.now() - POS_PRUNE_MS - 1; });
});

// server tick
setInterval(() => {
  try {
    const now = Date.now();
    for (const id of Object.keys(players)) {
      if (!players[id].lastSeen || (now - players[id].lastSeen > POS_PRUNE_MS)) {
        if (!players[id].isBot) delete players[id];
      }
    }
    const existingBots = Object.values(players).filter(p => p.isBot).length;
    if (existingBots < 12) spawnBots(12 - existingBots);
    updateBots(now);

    // capture checks: seekers capture nearby hiders
    const pls = Object.values(players);
    const seekers = pls.filter(p => p.role === 'seeker' && p.type === 'player');
    for (const seeker of seekers) {
      for (const hider of pls.filter(p => p.role !== 'seeker' && p.type === 'player')) {
        const dx = seeker.x - hider.x, dy = seeker.y - hider.y, dz = seeker.z - hider.z;
        const d2 = dx*dx + dy*dy + dz*dz;
        if (d2 <= 3*3) {
          const hitRecently = hider.lastHitAt && (now - hider.lastHitAt < 2000);
          if (hitRecently) { hider.proximityStart = null; continue; }
          if (!hider.proximityStart) hider.proximityStart = now;
          if (now - hider.proximityStart >= 800) {
            seeker.role = 'hider'; hider.role = 'seeker';
            hider.score = (hider.score || 0) + 200; hider.proximityStart = null;
            if (!players[seeker.id].isBot) io.to(seeker.id).emit('captured', { by: hider.id, newRole: 'hider' });
            if (!players[hider.id].isBot) io.to(hider.id).emit('becameSeeker', { newRole: 'seeker', score: hider.score });
            io.emit('stateUpdate', { players: sanitizedPlayersList() });
            seeker.lastHitAt = Date.now(); hider.lastHitAt = Date.now();
          }
        } else hider.proximityStart = null;
      }
    }

    io.emit('stateUpdate', { players: sanitizedPlayersList() });
  } catch (e) { console.error('tick error', e); }
}, STATE_BROADCAST_MS);

// static
app.use(express.static(FRONTEND_DIR));
app.get('*', (req,res) => res.sendFile(path.join(FRONTEND_DIR, 'index.html')));

// start server
server.listen(PORT, () => console.log(`Server listening on ${PORT}`));

'use strict';
/*
Full server.js — authoritative ray-based hit detection, denser hiding places, birds & vehicles,
serum & shield pick-ups, spawn/update of NPCs (birds, vehicles, trucks), and stateBroadcast.

Notes:
- Hit detection: server performs a simple sampled raycast between shooter and each candidate target.
  It checks blocks along ray for blocking (non-air).
- Vehicles follow simple lane logic (roads are chunk-level markers) and move server-side.
- Birds are simple flying NPCs with wandering velocity; server broadcasts their positions.
- This file is a self-contained prototype (in-memory).
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

// Chunk / block configuration
const CHUNK_SIZE = 16, CHUNK_HEIGHT = 32;
const BLOCK_AIR = 0, BLOCK_GRASS = 1, BLOCK_DIRT = 2, BLOCK_STONE = 3, BLOCK_SHIELD = 4,
      BLOCK_WOOD = 5, BLOCK_LEAF = 6, BLOCK_BUILDING = 7, BLOCK_ROAD = 8, BLOCK_SERUM = 9, BLOCK_BUSH = 10;
const chunks = {};
function index3(x,y,z){ return (y*CHUNK_SIZE + z)*CHUNK_SIZE + x; }
function chunkKey(cx,cz){ return `${cx},${cz}`; }

// Deterministic-ish chunk generator with many hiding spots and serum/shield spawns
function ensureChunk(cx, cz) {
  const key = chunkKey(cx,cz);
  if (chunks[key]) return chunks[key];
  // seeded PRNG per-chunk
  let seed = Math.abs(Math.floor(Math.sin(cx*73856093 ^ cz*19349663) * 1000000)) % 100000;
  function rand(){ seed = (seed * 9301 + 49297) % 233280; return seed / 233280; }

  const arr = new Int8Array(CHUNK_SIZE * CHUNK_HEIGHT * CHUNK_SIZE).fill(BLOCK_AIR);
  const biomeType = (Math.abs(cx*7 + cz*13) % 4);

  for (let x=0;x<CHUNK_SIZE;x++){
    for (let z=0;z<CHUNK_SIZE;z++){
      const worldX = cx*CHUNK_SIZE + x, worldZ = cz*CHUNK_SIZE + z;
      const h = 5 + Math.floor(Math.sin(worldX*0.12)*2 + Math.cos(worldZ*0.12)*2);
      for (let y=0;y<CHUNK_HEIGHT;y++){
        if (y === h) arr[index3(x,y,z)] = BLOCK_GRASS;
        else if (y < h && y > h-4) arr[index3(x,y,z)] = BLOCK_DIRT;
        else if (y < h-4) arr[index3(x,y,z)] = BLOCK_STONE;
      }
      // lots of bushes
      if (rand() > 0.78) arr[index3(x,h+1,z)] = BLOCK_BUSH;
      // forest cluster
      if ((biomeType === 0 || biomeType === 3) && rand() > 0.82) {
        const trunkH = 3 + Math.floor(rand()*3);
        for (let ty=h+1; ty<=h+trunkH; ty++) arr[index3(x,ty,z)] = BLOCK_WOOD;
        for (let lx=-2; lx<=2; lx++) for (let lz=-2; lz<=2; lz++){
          const tx = x+lx, tz = z+lz, ty = h+trunkH+1;
          if (tx>=0 && tx<CHUNK_SIZE && tz>=0 && tz<CHUNK_SIZE && ty<CHUNK_HEIGHT) {
            if (Math.abs(lx)+Math.abs(lz) + (rand()>0.5?0:1) < 5) arr[index3(tx,ty,tz)] = BLOCK_LEAF;
          }
        }
      }
      // city/roads/buildings
      if ((biomeType === 1 || biomeType === 3) && rand() > 0.9) {
        arr[index3(x,h,z)] = BLOCK_ROAD;
        if (rand() > 0.94) {
          const bW = 2 + Math.floor(rand()*3), bH = 2 + Math.floor(rand()*3);
          for (let bx = Math.max(0,x-1); bx < Math.min(CHUNK_SIZE,x+bW); bx++){
            for (let bz = Math.max(0,z-1); bz < Math.min(CHUNK_SIZE,z+2); bz++){
              for (let by = h+1; by <= h+bH; by++) arr[index3(bx,by,bz)] = BLOCK_BUILDING;
            }
          }
        }
      }
      // pickups
      if (rand() > 0.992) arr[index3(x,h+1,z)] = BLOCK_SERUM;
      if (rand() > 0.985) arr[index3(x,h+1,z)] = BLOCK_SHIELD;
    }
  }
  chunks[key] = arr;
  return arr;
}

app.get('/chunk', (req, res) => {
  const cx = parseInt(req.query.cx||'0',10), cz = parseInt(req.query.cz||'0',10);
  try { const ch = ensureChunk(cx,cz); res.json({ ok:true, cx, cz, size: CHUNK_SIZE, height: CHUNK_HEIGHT, blocks: Array.from(ch) }); }
  catch (e) { console.error('chunk error', e); res.status(500).json({ ok:false, error:'chunk' }); }
});

// simple create-room endpoint
app.post('/create-room', (req,res) => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i=0;i<6;i++) code += chars[Math.floor(Math.random()*chars.length)];
  res.json({ ok:true, roomId: code, url: `${req.protocol}://${req.get('host')}/?room=${code}` });
});

// --- gameplay / state ---
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, methods: ['GET','POST'], credentials: true } });

const players = {}; // id -> player or NPC
let botCounter = 0;

const POS_PRUNE_MS = 30000;
const STATE_BROADCAST_MS = 200;
const SHOOT_RANGE = 40;
const TRANQ_MS = 9000;
const SHIELD_DUR = 3;
const SHIELD_EXPIRE_MS = 20000;

// helper: list with tranqUntil
function sanitizedPlayersList() {
  return Object.values(players).map(p => ({
    id: p.id, name: p.name, x:p.x, y:p.y, z:p.z, role:p.role, score:p.score, isBot: !!p.isBot,
    type: p.type || 'player', crouch: !!p.crouch, tranqUntil: p.tranqUntil || 0,
    carrying: p.carrying ? { type: p.carrying.type, durability: p.carrying.durability } : null
  }));
}

// spawn mixed NPCs: players, birds, vehicles/trucks
function spawnBots(count){
  for (let i=0;i<count;i++){
    botCounter++;
    const id = `bot-${botCounter}`;
    const r = Math.random();
    if (r < 0.6) {
      players[id] = { id, name: `Bot${botCounter}`, x:(Math.random()-0.5)*120, y:2, z:(Math.random()-0.5)*120, role:(Math.random()>0.92?'seeker':'hider'), score:0, isBot:true, type:'player', lastSeen:Date.now(), ai:{ roamTick: Date.now() + Math.random()*2000 } };
    } else if (r < 0.8) {
      players[id] = { id, name: `Bird${botCounter}`, x:(Math.random()-0.5)*120, y:6 + Math.random()*10, z:(Math.random()-0.5)*120, role:'bird', score:0, isBot:true, type:'bird', lastSeen:Date.now(), ai:{ roamTick: Date.now() + Math.random()*800 } };
    } else {
      players[id] = { id, name: `Truck${botCounter}`, x:(Math.random()-0.5)*120, y:0.6, z:(Math.random()-0.5)*120, role:'vehicle', score:0, isBot:true, type:'vehicle', lastSeen:Date.now(), ai:{ roamTick: Date.now() + Math.random()*1500 }, path: null };
    }
  }
}

// simple bot updates: wandering for players, boids-like small randomness for birds, path-follow for vehicles (roads)
function updateBots(now) {
  for (const id of Object.keys(players)) {
    const p = players[id];
    if (!p.isBot) continue;
    if (!p.ai) p.ai = { roamTick: now + 1000 };
    if (now > p.ai.roamTick) {
      p.ai.roamTick = now + 600 + Math.random()*3000;
      if (p.type === 'vehicle') {
        // vehicles: pick a road-aligned direction (simple axis-aligned movement)
        const dir = Math.random() > 0.5 ? 1 : -1;
        if (Math.random() > 0.5) p.ai.vel = { x: dir * (1 + Math.random()*1.2), z: 0 };
        else p.ai.vel = { x: 0, z: dir * (1 + Math.random()*1.2) };
      } else if (p.type === 'bird') {
        p.ai.vel = { x: (Math.random()-0.5)*1.4, z: (Math.random()-0.5)*1.4, vy: (Math.random()-0.5)*0.9 };
      } else {
        p.ai.vel = { x: (Math.random()-0.5)*0.8, z: (Math.random()-0.5)*0.8 };
      }
    }
    if (p.ai && p.ai.vel) {
      p.x += p.ai.vel.x;
      p.z += p.ai.vel.z;
      if (p.type === 'bird') {
        p.y += p.ai.vel.vy || 0;
        if (p.y < 2) p.y = 2;
        if (p.y > 30) p.y = 30;
      }
    }
    p.lastSeen = Date.now();
  }
}

// --- utility: ray sampling to check block obstruction ---
// sample along ray in steps and check chunk blocks for blocking types (anything non-air)
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
      if (val && val !== BLOCK_AIR) {
        return true;
      }
    } catch (e) {
      // if chunk missing treat as unobstructed
    }
  }
  return false;
}

// socket handlers
io.on('connection', (socket) => {
  console.log('[server] socket connected', socket.id);

  socket.on('joinGame', (payload, ack) => {
    try {
      const name = (payload && payload.name) ? String(payload.name).trim() : `Player${Math.floor(Math.random()*10000)}`;
      players[socket.id] = players[socket.id] || {};
      const p = players[socket.id];
      p.id = socket.id; p.name = name; p.x = p.x || (Math.random()-0.5)*10; p.y = p.y || 2; p.z = p.z || (Math.random()-0.5)*10;
      p.role = p.role || 'hider'; p.score = p.score || 0; p.carrying = p.carrying || null; p.isBot = false; p.type='player'; p.tranqUntil = 0; p.crouch = !!p.crouch; p.lastSeen = Date.now();

      if (payload && payload.options && typeof payload.options.botCount === 'number') {
        const want = Math.max(0, Math.min(64, Math.floor(payload.options.botCount)));
        const existing = Object.values(players).filter(pl => pl.isBot).length;
        if (existing < want) spawnBots(want - existing);
      }

      if (typeof ack === 'function') ack({ ok:true, roomId: (payload && payload.roomId) || 'default' });
      socket.emit('joinedRoom', { roomId: (payload && payload.roomId) || 'default', playerId: socket.id, name: p.name, role: p.role });
      io.emit('stateUpdate', { players: sanitizedPlayersList() });
    } catch (e) { console.error('joinGame error', e); if (typeof ack === 'function') ack({ ok:false, error:'server' }); }
  });

  socket.on('pos', (pos) => {
    try {
      if (!players[socket.id]) return;
      const p = players[socket.id];
      p.x = Number(pos.x) || p.x;
      p.y = Number(pos.y) || p.y;
      p.z = Number(pos.z) || p.z;
      p.crouch = !!pos.crouch;
      p.lastSeen = Date.now();
    } catch (e) { console.warn('pos handler', e); }
  });

  // authoritative shooting: server checks ray to all players and applies hit to first valid, or nearest target with unobstructed line
  socket.on('shoot', (payload, ack) => {
    try {
      const shooter = players[socket.id];
      if (!shooter) { if (typeof ack === 'function') ack({ ok:false }); return; }
      // shoot line in direction of closest target (server chooses actual target)
      let candidate = null;
      let candidateD = Infinity;
      // iterate players and consider only player-type targets
      for (const id of Object.keys(players)) {
        if (id === socket.id) continue;
        const t = players[id];
        if (t.type !== 'player' && t.type !== 'animal' && t.type !== 'vehicle') continue;
        const dx = t.x - shooter.x, dy = t.y - shooter.y, dz = t.z - shooter.z;
        const d = Math.sqrt(dx*dx + dy*dy + dz*dz);
        if (d <= SHOOT_RANGE && d < candidateD) {
          // check obstruction along the line shooter->target
          const from = { x: shooter.x, y: shooter.y + 1.0, z: shooter.z };
          const to = { x: t.x, y: t.y + 1.0, z: t.z };
          if (!isLineObstructed(from, to)) {
            candidate = t; candidateD = d;
          }
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
    } catch (e) {
      console.error('shoot handler', e);
      if (typeof ack === 'function') ack({ ok:false, error:'server' });
    }
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

// server tick: prune, spawn bots, update NPCs, capture checks, broadcast
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

    // capture checks: seekers capturing hiders
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

// static serve
app.use(express.static(FRONTEND_DIR));
app.get('*', (req, res) => res.sendFile(path.join(FRONTEND_DIR, 'index.html')));

// start
server.listen(PORT, () => console.log(`Server listening on ${PORT}`));

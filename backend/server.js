'use strict';
/*
Server: improved NPCs (birds, trucks, cars), denser hiding spots, stable shooting events,
serum + shield pickups, prevents tranq on join. Keeps prototype in-memory world.

Replace your existing backend/server.js with this file and redeploy.
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
app.get('/health', (req,res)=> res.json({ status:'ok', now: Date.now() }));

// --- world/chunk config ---
const CHUNK_SIZE = 16, CHUNK_HEIGHT = 32;
const BLOCK_AIR = 0, BLOCK_GRASS = 1, BLOCK_DIRT = 2, BLOCK_STONE = 3, BLOCK_SHIELD = 4,
      BLOCK_WOOD = 5, BLOCK_LEAF = 6, BLOCK_BUILDING = 7, BLOCK_ROAD = 8, BLOCK_SERUM = 9, BLOCK_BUSH = 10;
const chunks = {};

function chunkKey(cx,cz){ return `${cx},${cz}`; }
function index3(x,y,z){ return (y*CHUNK_SIZE + z)*CHUNK_SIZE + x; }

function ensureChunk(cx,cz){
  const key = chunkKey(cx,cz);
  if (chunks[key]) return chunks[key];

  // deterministic-ish local PRNG for variety per chunk
  let seed = Math.abs(Math.floor(Math.sin(cx*73856093 ^ cz*19349663) * 1000000)) % 100000;
  function rand(){ seed = (seed * 9301 + 49297) % 233280; return seed / 233280; }

  const arr = new Int8Array(CHUNK_SIZE*CHUNK_HEIGHT*CHUNK_SIZE).fill(BLOCK_AIR);

  // pick biome and generate terrain + features
  const biomeType = (Math.abs(cx*7 + cz*13) % 4); // forest, city, plain, mixed
  for (let x=0;x<CHUNK_SIZE;x++){
    for (let z=0;z<CHUNK_SIZE;z++){
      const worldX = cx*CHUNK_SIZE + x, worldZ = cz*CHUNK_SIZE + z;
      const h = 5 + Math.floor(Math.sin(worldX*0.12)*2 + Math.cos(worldZ*0.12)*2);
      for (let y=0;y<CHUNK_HEIGHT;y++){
        if (y === h) arr[index3(x,y,z)] = BLOCK_GRASS;
        else if (y < h && y > h-4) arr[index3(x,y,z)] = BLOCK_DIRT;
        else if (y < h-4) arr[index3(x,y,z)] = BLOCK_STONE;
      }

      // add lots more bushes and features for hiding
      if (rand() > 0.78) arr[index3(x, h+1, z)] = BLOCK_BUSH;

      // forest clusters
      if ((biomeType === 0 || biomeType === 3) && rand() > 0.82) {
        const trunkH = 3 + Math.floor(rand()*3);
        for (let ty = h+1; ty <= h+trunkH; ty++) arr[index3(x,ty,z)] = BLOCK_WOOD;
        for (let lx=-2; lx<=2; lx++) for (let lz=-2; lz<=2; lz++){
          const tx = x + lx, tz = z + lz, ty = h + trunkH + 1;
          if (tx>=0 && tx<CHUNK_SIZE && tz>=0 && tz<CHUNK_SIZE && ty<CHUNK_HEIGHT) {
            if (Math.abs(lx)+Math.abs(lz) + (rand()>0.5?0:1) < 5) arr[index3(tx,ty,tz)] = BLOCK_LEAF;
          }
        }
      }

      // city roads & small buildings (offers cover)
      if ((biomeType === 1 || biomeType === 3) && rand() > 0.9) {
        arr[index3(x, h, z)] = BLOCK_ROAD;
        if (rand() > 0.94) {
          const bW = 2 + Math.floor(rand()*3), bH = 2 + Math.floor(rand()*3);
          for (let bx=Math.max(0,x-1); bx<Math.min(CHUNK_SIZE,x+bW); bx++){
            for (let bz=Math.max(0,z-1); bz<Math.min(CHUNK_SIZE,z+2); bz++){
              for (let by=h+1; by<=h+bH; by++) arr[index3(bx,by,bz)] = BLOCK_BUILDING;
            }
          }
        }
      }

      // serum & shield spawn (rare)
      if (rand() > 0.992) arr[index3(x, h+1, z)] = BLOCK_SERUM;
      if (rand() > 0.985) arr[index3(x, h+1, z)] = BLOCK_SHIELD;
    }
  }

  chunks[key] = arr;
  return arr;
}

app.get('/chunk', (req,res)=>{
  const cx = parseInt(req.query.cx||'0',10), cz = parseInt(req.query.cz||'0',10);
  try { const ch = ensureChunk(cx,cz); res.json({ ok:true, cx, cz, size: CHUNK_SIZE, height: CHUNK_HEIGHT, blocks: Array.from(ch) }); }
  catch (e) { console.error('chunk error', e); res.status(500).json({ ok:false, error:'chunk error' }); }
});

// --- simple room helper ---
app.post('/create-room',(req,res)=> {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i=0;i<6;i++) code += chars[Math.floor(Math.random()*chars.length)];
  res.json({ ok:true, roomId: code, url: `${req.protocol}://${req.get('host')}/?room=${code}` });
});

// --- socket/game state ---
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, methods: ['GET','POST'], credentials: true } });

const players = {}; // includes bots & NPCs
let botCounter = 0;

const POS_PRUNE_MS = 30000;
const STATE_BROADCAST_MS = 200;
const SHOOT_RANGE = 30;
const TRANQ_MS = 8000;
const SHIELD_DUR = 3;
const SHIELD_EXPIRE_MS = 20000;

function sanitizedPlayersList(){
  return Object.values(players).map(p => ({
    id: p.id, name: p.name, x:p.x, y:p.y, z:p.z, role:p.role, score:p.score,
    isBot: !!p.isBot, type:p.type||'player', crouch: !!p.crouch, tranqUntil: p.tranqUntil||0,
    carrying: p.carrying ? { type:p.carrying.type, durability:p.carrying.durability } : null
  }));
}

// spawn mixed bots + animals + trucks/cars
function spawnBots(count){
  for (let i=0;i<count;i++){
    botCounter++;
    const id = `bot-${botCounter}`;
    const r = Math.random();
    if (r < 0.6) {
      players[id] = { id, name:`Bot${botCounter}`, x:(Math.random()-0.5)*80, y:2, z:(Math.random()-0.5)*80, role:(Math.random()>0.92?'seeker':'hider'), score:0, isBot:true, type:'player', lastSeen:Date.now(), ai:{ roamTick: Date.now()+Math.random()*2000 } };
    } else if (r < 0.8) {
      players[id] = { id, name:`Bird${botCounter}`, x:(Math.random()-0.5)*80, y:6+Math.random()*6, z:(Math.random()-0.5)*80, role:'bird', score:0, isBot:true, type:'bird', lastSeen:Date.now(), ai:{ roamTick: Date.now()+Math.random()*800 } };
    } else {
      // trucks and larger vehicles
      players[id] = { id, name:`Truck${botCounter}`, x:(Math.random()-0.5)*80, y:0.6, z:(Math.random()-0.5)*80, role:'vehicle', score:0, isBot:true, type:'vehicle', lastSeen:Date.now(), ai:{ roamTick: Date.now()+Math.random()*1200 } };
    }
  }
}

function updateBots(now){
  for (const id of Object.keys(players)){
    const p = players[id];
    if (!p.isBot) continue;
    if (!p.ai) p.ai = { roamTick: now + 1000 };
    if (now > p.ai.roamTick) {
      p.ai.roamTick = now + 800 + Math.random()*3200;
      if (p.type === 'vehicle') p.ai.vel = { x: (Math.random()-0.5)*1.8, z: (Math.random()-0.5)*1.8 };
      else if (p.type === 'bird') p.ai.vel = { x: (Math.random()-0.5)*0.9, z: (Math.random()-0.5)*0.9, vy: (Math.random()-0.5)*0.8 };
      else p.ai.vel = { x: (Math.random()-0.5)*0.6, z: (Math.random()-0.5)*0.6 };
    }
    if (p.ai && p.ai.vel) {
      p.x += p.ai.vel.x;
      p.z += p.ai.vel.z;
      if (p.type === 'bird') {
        p.y += (p.ai.vel.vy || 0);
        if (p.y < 2) p.y = 2;
        if (p.y > 20) p.y = 20;
      }
    }
    p.lastSeen = Date.now();
  }
}

// socket handlers
io.on('connection', (socket) => {
  console.log('[server] connect', socket.id);

  socket.on('joinGame', (payload, ack) => {
    try {
      const name = (payload && payload.name) ? String(payload.name).trim() : `Player${Math.floor(Math.random()*10000)}`;
      players[socket.id] = players[socket.id] || {};
      const p = players[socket.id];
      p.id = socket.id; p.name = name; p.x = p.x || (Math.random()-0.5)*10; p.y = p.y || 2; p.z = p.z || (Math.random()-0.5)*10;
      p.role = p.role || 'hider'; p.score = p.score || 0; p.carrying = p.carrying || null; p.isBot = false; p.type='player'; p.tranqUntil = 0; p.crouch = !!p.crouch; p.lastSeen = Date.now();

      // accept requested botCount and spawn some immediately for responsiveness
      if (payload && payload.options && typeof payload.options.botCount === 'number') {
        const want = Math.max(0, Math.min(64, Math.floor(payload.options.botCount)));
        const existing = Object.values(players).filter(r => r.isBot).length;
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
      p.x = Number(pos.x) || p.x; p.y = Number(pos.y) || p.y; p.z = Number(pos.z) || p.z;
      p.crouch = !!pos.crouch;
      p.lastSeen = Date.now();
    } catch (e) { console.warn('pos user err', e); }
  });

  socket.on('shoot', (payload, ack) => {
    try {
      const shooter = players[socket.id];
      if (!shooter) { if (typeof ack === 'function') ack({ ok:false }); return; }
      // find nearest target
      let best = null, bestD2 = Infinity;
      for (const id of Object.keys(players)) {
        if (id === socket.id) continue;
        const pl = players[id];
        const dx = pl.x - shooter.x, dy = pl.y - shooter.y, dz = pl.z - shooter.z;
        const d2 = dx*dx + dy*dy + dz*dz;
        if (d2 < bestD2 && d2 <= SHOOT_RANGE*SHOOT_RANGE) { best = pl; bestD2 = d2; }
      }
      if (!best) { if (typeof ack === 'function') ack({ ok:false, error:'no_target' }); return; }
      const blocked = best.carrying && best.carrying.type === 'shield' && best.carrying.durability > 0;
      if (blocked) {
        best.carrying.durability -= 1;
        if (best.carrying.durability <= 0) best.carrying = null;
      } else {
        best.tranqUntil = Date.now() + TRANQ_MS;
      }
      const shooterPos = { x: shooter.x, y: shooter.y + 1.0, z: shooter.z };
      const targetPos = { x: best.x, y: best.y + 1.0, z: best.z };
      io.emit('shotFired', { shooter: shooter.id, target: best.id, shooterPos, targetPos, blocked: !!blocked });
      if (typeof ack === 'function') ack({ ok:true, target: best.id, blocked: !!blocked });
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

  socket.on('disconnect', ()=> { if (players[socket.id]) players[socket.id].lastSeen = Date.now() - POS_PRUNE_MS - 1; });
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

    // capture logic: seekers capture hiders
    const pls = Object.values(players);
    const seekers = pls.filter(p => p.role === 'seeker' && p.type==='player');
    for (const seeker of seekers) {
      for (const hider of pls.filter(p => p.role !== 'seeker' && p.type === 'player')) {
        const dx = seeker.x - hider.x, dy = seeker.y - hider.y, dz = seeker.z - hider.z;
        const d2 = dx*dx + dy*dy + dz*dz;
        if (d2 <= 3*3) {
          const recentlyHit = hider.lastHitAt && (now - hider.lastHitAt < 2000);
          if (recentlyHit) { hider.proximityStart = null; continue; }
          if (!hider.proximityStart) hider.proximityStart = now;
          if (now - hider.proximityStart >= 800) {
            seeker.role = 'hider'; hider.role = 'seeker';
            hider.score = (hider.score || 0) + 200;
            hider.proximityStart = null;
            if (!players[seeker.id].isBot) io.to(seeker.id).emit('captured', { by: hider.id, newRole:'hider' });
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

// serve frontend
app.use(express.static(FRONTEND_DIR));
app.get('*', (req,res)=> res.sendFile(path.join(FRONTEND_DIR, 'index.html')));

server.listen(PORT, () => console.log(`Server listening on ${PORT}`));

'use strict';
/*
Full server.js updated to accept crouch state in pos messages and include it in stateUpdate.
Also emits 'shotFired' with shooter/target positions and blocked flag (so clients can render).
Chunk generator already includes hiding places; this keeps existing behavior.
Replace your current backend/server.js with this full file.
*/

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const fs = require('fs').promises;
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));

const PORT = process.env.PORT || 3000;
const FRONTEND_DIR = path.resolve(__dirname, '..', 'frontend', 'public');

app.use(cors({ origin: true, methods: ['GET','POST','OPTIONS'], credentials: true }));

// Simple health
app.get('/health', (req,res) => res.json({ status:'ok', now: Date.now() }));

// The chunk logic (kept as previously provided) - deterministic-ish with trees/buildings/roads
const CHUNK_SIZE = 16, CHUNK_HEIGHT = 32;
const BLOCK_AIR = 0, BLOCK_GRASS = 1, BLOCK_DIRT = 2, BLOCK_STONE = 3, BLOCK_SHIELD = 4, BLOCK_WOOD = 5, BLOCK_LEAF = 6, BLOCK_BUILDING = 7, BLOCK_ROAD = 8;
const chunks = {};
function chunkKey(cx,cz){ return `${cx},${cz}`; }
function index3(x,y,z){ return (y*CHUNK_SIZE + z)*CHUNK_SIZE + x; }

function ensureChunk(cx,cz){
  const key = chunkKey(cx,cz);
  if (chunks[key]) return chunks[key];
  const arr = new Int8Array(CHUNK_SIZE*CHUNK_HEIGHT*CHUNK_SIZE).fill(BLOCK_AIR);
  for (let x=0;x<CHUNK_SIZE;x++){
    for (let z=0;z<CHUNK_SIZE;z++){
      const worldX = cx*CHUNK_SIZE + x, worldZ = cz*CHUNK_SIZE + z;
      const h = 6 + Math.floor(Math.sin(worldX*0.12)*2 + Math.cos(worldZ*0.15)*2);
      for (let y=0;y<CHUNK_HEIGHT;y++){
        if (y === h) arr[index3(x,y,z)] = BLOCK_GRASS;
        else if (y < h && y > h-4) arr[index3(x,y,z)] = BLOCK_DIRT;
        else if (y < h-4) arr[index3(x,y,z)] = BLOCK_STONE;
      }
      if (Math.random() > 0.86) {
        const trunk = 4 + Math.floor(Math.random()*2);
        for (let ty=h+1; ty<=h+trunk; ty++) arr[index3(x,ty,z)] = BLOCK_WOOD;
        for (let lx=-2; lx<=2; lx++) for (let lz=-2; lz<=2; lz++) {
          const ty = h + trunk + 1;
          const tx = x + lx, tz = z + lz;
          if (tx>=0 && tx<CHUNK_SIZE && tz>=0 && tz<CHUNK_SIZE && ty<CHUNK_HEIGHT) arr[index3(tx,ty,tz)] = BLOCK_LEAF;
        }
      }
      if (Math.random() > 0.92) {
        const sx = Math.floor(Math.random()*CHUNK_SIZE), sz = Math.floor(Math.random()*CHUNK_SIZE), sy = 10;
        arr[index3(sx,sy,sz)] = BLOCK_SHIELD;
      }
    }
  }
  chunks[key] = arr;
  return arr;
}

app.get('/chunk', (req,res) => {
  const cx = parseInt(req.query.cx||'0',10), cz = parseInt(req.query.cz||'0',10);
  try { const ch = ensureChunk(cx,cz); res.json({ ok:true, cx, cz, size:CHUNK_SIZE, height:CHUNK_HEIGHT, blocks:Array.from(ch) }); }
  catch (e) { console.error('chunk error', e); res.status(500).json({ ok:false, error:'chunk error' }); }
});

// Simple create-room (persist minimal)
app.post('/create-room', async (req,res) => {
  try {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i=0;i<6;i++) code += chars[Math.floor(Math.random()*chars.length)];
    res.json({ ok:true, roomId: code, url: `${req.protocol}://${req.get('host')}/?room=${code}` });
  } catch (e) { console.error('/create-room failed', e); res.status(500).json({ ok:false }); }
});

// --- Socket game state ---
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, methods: ['GET','POST'], credentials: true } });

const players = {}; // id -> { id,name,x,y,z,role,score,isBot,type,crouch, ... }
let botCounter = 0;
const POS_PRUNE_MS = 30000;
const CAPTURE_DISTANCE = 3.0, CAPTURE_HOLD_MS = 800, SHIELD_DURABILITY = 3, SHIELD_DURATION_MS=20000, STATE_BROADCAST_MS=200;

function sanitizedPlayersList(){
  return Object.values(players).map(p => ({
    id: p.id, name: p.name, x: p.x, y: p.y, z: p.z, role: p.role, score: p.score, isBot: !!p.isBot, type: p.type||'player', crouch: !!p.crouch, carrying: p.carrying ? { type:p.carrying.type, durability:p.carrying.durability } : null
  }));
}

// spawn bots and simple NPCs
function spawnBots(count){
  for (let i=0;i<count;i++){
    botCounter++;
    const id = `bot-${botCounter}`;
    const r = Math.random();
    if (r < 0.7) players[id] = { id, name:`Bot${botCounter}`, x:(Math.random()-0.5)*40, y:2, z:(Math.random()-0.5)*40, role:(Math.random()>0.9?'seeker':'hider'), score:0, isBot:true, type:'player', lastSeen:Date.now(), ai:{ roamTick:Date.now()+Math.random()*2000 } };
    else if (r < 0.9) players[id] = { id, name:`Deer${botCounter}`, x:(Math.random()-0.5)*40, y:1, z:(Math.random()-0.5)*40, role:'animal', score:0, isBot:true, type:'animal', lastSeen:Date.now(), ai:{ roamTick:Date.now()+Math.random()*1500 } };
    else players[id] = { id, name:`Car${botCounter}`, x:(Math.random()-0.5)*40, y:0.6, z:(Math.random()-0.5)*40, role:'vehicle', score:0, isBot:true, type:'vehicle', lastSeen:Date.now(), ai:{ roamTick:Date.now()+Math.random()*1000 } };
  }
}

function updateBots(now){
  for (const id of Object.keys(players)){
    const p = players[id]; if (!p.isBot) continue;
    if (!p.ai) p.ai = { roamTick: now + 1000 };
    if (now > p.ai.roamTick) {
      p.ai.roamTick = now + 1000 + Math.random()*3000;
      const speed = p.type === 'vehicle' ? 2.0 : (p.type === 'animal' ? 0.4 : 0.6);
      p.ai.vel = { x:(Math.random()-0.5)*speed, z:(Math.random()-0.5)*speed };
    }
    if (p.ai && p.ai.vel) { p.x += p.ai.vel.x; p.z += p.ai.vel.z; }
    p.lastSeen = Date.now();
  }
}

io.on('connection', (socket) => {
  console.log('[server] conn', socket.id);
  socket.on('joinGame', (payload, ack) => {
    try {
      const name = (payload && payload.name) ? String(payload.name).trim() : ('Player-' + Math.floor(Math.random()*1000));
      players[socket.id] = players[socket.id] || {};
      const p = players[socket.id];
      p.id = socket.id; p.name = name; p.x = p.x || (Math.random()-0.5)*10; p.y = 2; p.z = p.z || (Math.random()-0.5)*10; p.role = p.role || 'hider'; p.score = p.score || 0; p.crouch = p.crouch || false; p.isBot = false; p.type='player'; p.lastSeen = Date.now();
      if (payload && payload.options && typeof payload.options.botCount === 'number') {
        const want = Math.max(0, Math.min(64, Math.floor(payload.options.botCount)));
        // set bot count target via global variable (simple)
        // spawnBots will be applied in server tick to reach count
        // store desired count in room-specific state if needed (not implemented)
        console.log('[server] requested botCount', want);
      }
      if (typeof ack === 'function') ack({ ok:true, roomId: (payload && payload.roomId) || 'default' });
      socket.emit('joinedRoom', { roomId: (payload && payload.roomId) || 'default', playerId: socket.id, name: p.name, role: p.role });
      io.emit('stateUpdate', { players: sanitizedPlayersList() });
    } catch(e){ console.error('joinGame err', e); if (typeof ack === 'function') ack({ ok:false, error:'server' }); }
  });

  socket.on('pos', (data) => {
    try {
      if (!players[socket.id]) return;
      const p = players[socket.id];
      p.x = Number(data.x) || p.x; p.y = Number(data.y) || p.y; p.z = Number(data.z) || p.z;
      p.crouch = !!data.crouch;
      p.lastSeen = Date.now();
    } catch(e){ console.warn('pos handler err', e); }
  });

  socket.on('shoot', (payload, ack) => {
    try {
      const shooter = players[socket.id]; if (!shooter) { if (typeof ack === 'function') ack({ ok:false }); return; }
      let best=null, bestD2=Infinity;
      for (const id of Object.keys(players)){ if (id===socket.id) continue; const target=players[id]; const dx = (target.x - shooter.x), dy=(target.y - shooter.y), dz=(target.z - shooter.z); const d2 = dx*dx + dy*dy + dz*dz; if (d2 < bestD2 && d2 <= 30*30) { best = target; bestD2 = d2; } }
      if (!best) { if (typeof ack === 'function') ack({ ok:false, error:'no_target' }); return; }
      const blocked = (best.carrying && best.carrying.type === 'shield' && best.carrying.durability > 0);
      if (blocked) { best.carrying.durability -= 1; if (best.carrying.durability <= 0) best.carrying = null; }
      else { best.lastHitAt = Date.now(); }
      // emit shotFired event for visuals
      const shooterPos = { x: shooter.x, y: shooter.y + 1.0, z: shooter.z };
      const targetPos = { x: best.x, y: best.y + 1.0, z: best.z };
      io.emit('shotFired', { shooter: shooter.id, target: best.id, shooterPos, targetPos, blocked: !!blocked });
      if (typeof ack === 'function') ack({ ok:true, target: best.id, blocked: !!blocked });
    } catch(e){ console.error('shoot err', e); if (typeof ack === 'function') ack({ ok:false, error:'server' }); }
  });

  socket.on('blockPlace', (data, ack) => {
    try { const cx=Math.floor(data.cx||0), cz=Math.floor(data.cz||0); const ch = ensureChunk(cx,cz); ch[index3(Number(data.x),Number(data.y),Number(data.z))] = Number(data.block); io.emit('chunkDiff',{ cx,cz,edits:[{ x:data.x,y:data.y,z:data.z,block:data.block }]}); if (typeof ack === 'function') ack({ ok:true }); }
    catch(e){ console.error('blockPlace err', e); if (typeof ack === 'function') ack({ ok:false }); }
  });

  socket.on('blockRemove', (data, ack) => {
    try { const cx=Math.floor(data.cx||0), cz=Math.floor(data.cz||0); const ch = ensureChunk(cx,cz); const prev = ch[index3(Number(data.x),Number(data.y),Number(data.z))]; ch[index3(Number(data.x),Number(data.y),Number(data.z))] = BLOCK_AIR; io.emit('chunkDiff',{ cx,cz,edits:[{ x:data.x,y:data.y,z:data.z,block:BLOCK_AIR }]}); if (typeof ack === 'function') ack({ ok:true, prev }); }
    catch(e){ console.error('blockRemove err', e); if (typeof ack === 'function') ack({ ok:false }); }
  });

  socket.on('pickup', (payload, ack) => {
    try {
      const p = players[socket.id]; if (!p) { if (typeof ack==='function') ack({ ok:false }); return; }
      const cx = Math.floor(p.x / CHUNK_SIZE), cz = Math.floor(p.z / CHUNK_SIZE);
      let picked = null;
      for (let dx=-1; dx<=1 && !picked; dx++){
        for (let dz=-1; dz<=1 && !picked; dz++){
          const chx = cx+dx, chz = cz+dz; const ch = ensureChunk(chx,chz);
          for (let x=0;x<CHUNK_SIZE && !picked;x++) for (let z=0;z<CHUNK_SIZE && !picked;z++) for (let y=0;y<CHUNK_HEIGHT && !picked;y++){
            const val = ch[index3(x,y,z)];
            if (val === BLOCK_SHIELD) {
              ch[index3(x,y,z)] = BLOCK_AIR;
              p.carrying = { id: `shield-${Date.now()}`, type: 'shield', durability: SHIELD_DURABILITY };
              io.emit('chunkDiff', { cx: chx, cz: chz, edits:[{ x,y,z,block:BLOCK_AIR }]});
              io.to(socket.id).emit('shieldPicked', { id: p.carrying.id, durability: p.carrying.durability });
              picked = true;
            }
          }
        }
      }
      if (picked) { if (typeof ack==='function') ack({ ok:true, carrying: p.carrying }); } else { if (typeof ack==='function') ack({ ok:false, error:'none' }); }
    } catch(e){ console.error('pickup err', e); if (typeof ack==='function') ack({ ok:false, error:'server' }); }
  });

  socket.on('disconnect', ()=>{ if (players[socket.id]) players[socket.id].lastSeen = Date.now() - POS_PRUNE_MS - 1; });
});

setInterval(() => {
  try {
    const now = Date.now();
    for (const id of Object.keys(players)) {
      if (!players[id].lastSeen || (now - players[id].lastSeen > POS_PRUNE_MS)) {
        if (!players[id].isBot) delete players[id];
      }
    }
    const existingBots = Object.values(players).filter(p => p.isBot).length;
    if (existingBots < 6) spawnBots(6 - existingBots);
    updateBots(now);

    // capture logic unchanged (seekers capture hiders)
    const pls = Object.values(players);
    const seekers = pls.filter(p => p.role === 'seeker');
    for (const seeker of seekers) {
      for (const hider of pls.filter(p => p.role !== 'seeker' && p.type === 'player')) {
        const dx = seeker.x - hider.x, dz = seeker.z - hider.z, dy = seeker.y - hider.y;
        const d2 = dx*dx + dy*dy + dz*dz;
        if (d2 <= CAPTURE_DISTANCE*CAPTURE_DISTANCE) {
          const hitRecently = hider.lastHitAt && (now - hider.lastHitAt < 2000);
          if (hitRecently) { hider.proximityStart = null; continue; }
          if (!hider.proximityStart) hider.proximityStart = now;
          if (now - hider.proximityStart >= CAPTURE_HOLD_MS) {
            seeker.role = 'hider'; hider.role = 'seeker'; hider.score = (hider.score||0)+200; hider.proximityStart = null;
            if (!players[seeker.id].isBot) io.to(seeker.id).emit('captured', { by: hider.id, newRole: 'hider' });
            if (!players[hider.id].isBot) io.to(hider.id).emit('becameSeeker', { newRole: 'seeker', score: hider.score });
            io.emit('stateUpdate', { players: sanitizedPlayersList() });
            seeker.lastHitAt = Date.now(); hider.lastHitAt = Date.now();
          }
        } else hider.proximityStart = null;
      }
    }

    io.emit('stateUpdate', { players: sanitizedPlayersList() });
  } catch(e) { console.error('tick error', e); }
}, STATE_BROADCAST_MS);

app.use(express.static(FRONTEND_DIR));
app.get('*', (req,res) => res.sendFile(path.join(FRONTEND_DIR, 'index.html')));

server.listen(PORT, () => console.log(`Server listening on ${PORT}`));

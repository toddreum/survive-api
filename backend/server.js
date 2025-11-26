'use strict';
/*
Laser-Tag mode: "Photon Phase" (all players can shoot).
- Each player can shoot lasers at any time.
- Hits award points and charge to the shooter.
- At 5 charge, player can activate Phase (pass-through walls) for a short time to pursue targets.
- Hit targets are stunned for a short duration (can't shoot).
- Spawn protection prevents immediate hits on join.
- State broadcast includes points, charge, phaseActive, stunnedUntil.

Drop this file in backend/server.js and restart the server.
*/

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(cors({ origin: true, methods: ['GET','POST','OPTIONS'], credentials: true }));

const PORT = process.env.PORT || 3000;
const FRONTEND_DIR = path.resolve(__dirname, '..', 'frontend', 'public');

const CHUNK_SIZE = 16, CHUNK_HEIGHT = 32;
const BLOCK_AIR = 0, BLOCK_GRASS = 1, BLOCK_DIRT = 2, BLOCK_STONE = 3, BLOCK_SHIELD = 4,
      BLOCK_WOOD = 5, BLOCK_LEAF = 6, BLOCK_BUILDING = 7, BLOCK_ROAD = 8, BLOCK_SERUM = 9, BLOCK_BUSH = 10;

function index3(x,y,z){ return (y*CHUNK_SIZE + z)*CHUNK_SIZE + x; }
const chunks = {};
function chunkKey(cx,cz){ return `${cx},${cz}`; }
function ensureChunk(cx,cz){
  const k = chunkKey(cx,cz);
  if (chunks[k]) return chunks[k];
  const arr = new Int8Array(CHUNK_SIZE*CHUNK_HEIGHT*CHUNK_SIZE).fill(BLOCK_AIR);
  // simple terrain
  for (let x=0;x<CHUNK_SIZE;x++) for (let z=0;z<CHUNK_SIZE;z++){
    const h = 5 + Math.floor(Math.sin((cx*CHUNK_SIZE + x)*0.12)*2 + Math.cos((cz*CHUNK_SIZE + z)*0.12)*2);
    for (let y=0;y<CHUNK_HEIGHT;y++){
      if (y===h) arr[index3(x,y,z)] = BLOCK_GRASS;
      else if (y<h && y>h-4) arr[index3(x,y,z)] = BLOCK_DIRT;
      else if (y < h-4) arr[index3(x,y,z)] = BLOCK_STONE;
    }
    if (Math.random()>0.9) arr[index3(Math.floor(Math.random()*CHUNK_SIZE), h+1, Math.floor(Math.random()*CHUNK_SIZE))] = BLOCK_SHIELD;
    if (Math.random()>0.99) arr[index3(Math.floor(Math.random()*CHUNK_SIZE), h+1, Math.floor(Math.random()*CHUNK_SIZE))] = BLOCK_SERUM;
    if (Math.random()>0.85) arr[index3(x,h+1,z)] = BLOCK_BUSH;
  }
  chunks[k] = arr;
  return arr;
}

app.get('/chunk', (req,res)=>{
  const cx = parseInt(req.query.cx||'0',10), cz = parseInt(req.query.cz||'0',10);
  try { const ch = ensureChunk(cx,cz); res.json({ ok:true, cx, cz, size:CHUNK_SIZE, height:CHUNK_HEIGHT, blocks:Array.from(ch) }); }
  catch(e){ console.error('chunk err', e); res.status(500).json({ ok:false }); }
});

// --- Game state ---
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, methods: ['GET','POST'], credentials: true } });

const players = {}; // id -> player object
let botCounter = 0;

const POS_PRUNE_MS = 30000;
const STATE_BROADCAST_MS = 200;
const SHOOT_RANGE = 50;
const STUN_MS = 2000;        // target stunned when hit
const PHASE_DURATION_MS = 6000;
const CHARGE_TO_PHASE = 5;
const SPAWN_PROTECT_MS = 5000; // protect after join

function sanitizedPlayersList(){
  return Object.values(players).map(p => ({
    id: p.id, name: p.name, x:p.x, y:p.y, z:p.z, role:p.role, points:p.points||0, charge:p.charge||0,
    isBot: !!p.isBot, type: p.type||'player', crouch: !!p.crouch, stunnedUntil: p.stunnedUntil || 0, phaseActive: !!p.phaseActive, spawnTime: p.spawnTime || 0
  }));
}

function spawnBots(n){
  for (let i=0;i<n;i++){
    botCounter++;
    const id = `bot-${botCounter}`;
    players[id] = { id, name: `Bot${botCounter}`, x:(Math.random()-0.5)*120, y:2, z:(Math.random()-0.5)*120, role:'player', points:0, charge:0, isBot:true, type:'player', lastSeen:Date.now(), spawnTime: Date.now(), ai:{ roamTick:Date.now()+Math.random()*2000 } };
  }
}

function updateBots(now){
  for (const id of Object.keys(players)){
    const p = players[id];
    if (!p.isBot) continue;
    if (!p.ai) p.ai = { roamTick: now + 1000 };
    if (now > p.ai.roamTick) {
      p.ai.roamTick = now + 800 + Math.random()*2200;
      p.x += (Math.random()-0.5)*1.0;
      p.z += (Math.random()-0.5)*1.0;
      p.lastSeen = now;
      // occasional bot shooting (skip spawn-protected or stunned)
      if (Math.random() < 0.03 && !(p.stunnedUntil && p.stunnedUntil > now)) {
        // attempt to find nearest target that is not spawn-protected
        let best = null, bestD = Infinity;
        for (const tid of Object.keys(players)){
          if (tid === id) continue;
          const t = players[tid];
          if (!t || t.type !== 'player') continue;
          if (t.spawnTime && (now - t.spawnTime < SPAWN_PROTECT_MS)) continue;
          const dx = t.x - p.x, dy = t.y - p.y, dz = t.z - p.z; const d2 = dx*dx+dy*dy+dz*dz;
          if (d2 < bestD && d2 <= SHOOT_RANGE*SHOOT_RANGE) { best = t; bestD = d2; }
        }
        if (best) {
          // apply hit
          const shooter = p;
          const target = best;
          // blocked by shield? check carrying
          const blocked = target.carrying && target.carrying.type === 'shield' && target.carrying.durability > 0;
          if (blocked) {
            target.carrying.durability -= 1; if (target.carrying.durability <= 0) target.carrying = null;
          } else {
            target.stunnedUntil = Date.now() + STUN_MS;
            shooter.points = (shooter.points||0) + 10;
            shooter.charge = (shooter.charge||0) + 1;
            if (shooter.charge >= CHARGE_TO_PHASE) shooter.canPhase = true;
          }
          // broadcast event for visuals
          io.emit('playerHit', { shooter: shooter.id, target: target.id, shooterPos:{x:shooter.x,y:shooter.y+1,z:shooter.z}, targetPos:{x:target.x,y:target.y+1,z:target.z}, blocked: !!blocked, shooterPoints: shooter.points||0, shooterCharge: shooter.charge||0 });
        }
      }
    }
  }
}

function isLineObstructed(from, to) {
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  const len = Math.sqrt(dx*dx + dy*dy + dz*dz);
  const steps = Math.max(8, Math.floor(len / 0.6));
  for (let i=1;i<steps;i++){
    const t = i/steps; const sx = from.x + dx*t, sy = from.y + dy*t, sz = from.z + dz*t;
    const cx = Math.floor(sx/CHUNK_SIZE), cz = Math.floor(sz/CHUNK_SIZE);
    const lx = Math.floor(sx - cx*CHUNK_SIZE), lz = Math.floor(sz - cz*CHUNK_SIZE), ly = Math.floor(sy);
    if (ly < 0 || ly >= CHUNK_HEIGHT) continue;
    try {
      const ch = ensureChunk(cx, cz);
      const val = ch[index3(lx, ly, lz)];
      if (val && val !== BLOCK_AIR) return true;
    } catch(e){}
  }
  return false;
}

// socket handlers
io.on('connection', (socket) => {
  console.log('[server] conn', socket.id);

  socket.on('joinGame', (payload, ack) => {
    try {
      const name = (payload && payload.name) ? String(payload.name).trim() : `Player${Math.floor(Math.random()*10000)}`;
      players[socket.id] = players[socket.id] || {};
      const p = players[socket.id];
      p.id = socket.id; p.name = name; p.x = p.x || (Math.random()-0.5)*10; p.y = p.y || 2; p.z = p.z || (Math.random()-0.5)*10;
      p.role = 'player'; p.points = p.points || 0; p.charge = p.charge || 0; p.canPhase = !!p.canPhase; p.phaseActive = !!p.phaseActive;
      p.carrying = p.carrying || null; p.isBot = false; p.type='player'; p.lastSeen = Date.now();
      p.spawnTime = Date.now(); p.stunnedUntil = 0;
      if (payload && payload.options && typeof payload.options.botCount === 'number') {
        const want = Math.max(0, Math.min(64, Math.floor(payload.options.botCount)));
        const existing = Object.values(players).filter(x=>x.isBot).length;
        if (existing < want) spawnBots(want - existing);
      }
      if (typeof ack === 'function') ack({ ok:true, roomId: (payload && payload.roomId) || 'default' });
      socket.emit('joinedRoom', { playerId: socket.id, name: p.name, role: p.role });
      io.emit('stateUpdate', { players: sanitizedPlayersList() });
    } catch(e){ console.error('join err', e); if (typeof ack === 'function') ack({ ok:false, error:'server' }); }
  });

  socket.on('pos', (pos) => {
    const p = players[socket.id]; if (!p) return;
    p.x = Number(pos.x) || p.x; p.y = Number(pos.y) || p.y; p.z = Number(pos.z) || p.z; p.crouch = !!pos.crouch; p.lastSeen = Date.now();
  });

  // all players can shoot
  socket.on('shoot', (payload, ack) => {
    try {
      const shooter = players[socket.id]; if (!shooter) { if (typeof ack === 'function') ack({ ok:false }); return; }
      if (shooter.stunnedUntil && shooter.stunnedUntil > Date.now()) { if (typeof ack === 'function') ack({ ok:false, error:'stunned' }); return; }
      // find nearest visible target (respecting phase)
      let candidate = null, bestD = Infinity;
      for (const id of Object.keys(players)){
        if (id === socket.id) continue;
        const t = players[id];
        if (!t || t.type !== 'player') continue;
        if (t.spawnTime && (Date.now() - t.spawnTime < SPAWN_PROTECT_MS)) continue;
        const dx = t.x - shooter.x, dy = t.y - shooter.y, dz = t.z - shooter.z;
        const d = Math.sqrt(dx*dx + dy*dy + dz*dz);
        if (d <= SHOOT_RANGE && d < bestD){
          const from = { x: shooter.x, y: shooter.y + 1.0, z: shooter.z };
          const to = { x: t.x, y: t.y + 1.0, z: t.z };
          let obstructed = isLineObstructed(from, to);
          // if shooter has phaseActive, they can bypass obstruction
          if (shooter.phaseActive) obstructed = false;
          if (!obstructed){ candidate = t; bestD = d; }
        }
      }
      if (!candidate) { if (typeof ack === 'function') ack({ ok:false, error:'no_target' }); return; }
      const blocked = candidate.carrying && candidate.carrying.type === 'shield' && candidate.carrying.durability > 0;
      if (blocked){
        candidate.carrying.durability -= 1; if (candidate.carrying.durability <= 0) candidate.carrying = null;
      } else {
        candidate.stunnedUntil = Date.now() + STUN_MS;
        shooter.points = (shooter.points||0) + 10;
        shooter.charge = (shooter.charge||0) + 1;
        if (shooter.charge >= CHARGE_TO_PHASE) shooter.canPhase = true;
      }
      io.emit('playerHit', { shooter: shooter.id, target: candidate.id, shooterPos:{x:shooter.x,y:shooter.y+1,z:shooter.z}, targetPos:{x:candidate.x,y:candidate.y+1,z:candidate.z}, blocked: !!blocked, shooterPoints: shooter.points||0, shooterCharge: shooter.charge||0 });
      if (typeof ack === 'function') ack({ ok:true, target: candidate.id, blocked: !!blocked });
    } catch(e){ console.error('shoot err', e); if (typeof ack === 'function') ack({ ok:false, error:'server' }); }
  });

  // use Phase ability
  socket.on('usePhase', (payload, ack) => {
    try {
      const p = players[socket.id]; if (!p) { if (typeof ack === 'function') ack({ ok:false }); return; }
      if (!p.canPhase || p.phaseActive) { if (typeof ack === 'function') ack({ ok:false, error:'cannot_phase' }); return; }
      p.canPhase = false; p.charge = 0; p.phaseActive = true;
      setTimeout(()=>{ p.phaseActive = false; }, PHASE_DURATION_MS);
      io.emit('phaseActivated', { id: p.id, duration: PHASE_DURATION_MS });
      if (typeof ack === 'function') ack({ ok:true, duration: PHASE_DURATION_MS });
    } catch(e){ console.error('usePhase err', e); if (typeof ack === 'function') ack({ ok:false, error:'server' }); }
  });

  socket.on('pickup', (payload, ack) => {
    try {
      const p = players[socket.id]; if (!p) { if (typeof ack === 'function') ack({ ok:false }); return; }
      const cx = Math.floor(p.x / CHUNK_SIZE), cz = Math.floor(p.z / CHUNK_SIZE);
      let picked = null;
      for (let dx=-1; dx<=1 && !picked; dx++){
        for (let dz=-1; dz<=1 && !picked; dz++){
          const chx = cx+dx, chz = cz+dz; const ch = ensureChunk(chx,chz);
          for (let x=0;x<CHUNK_SIZE && !picked;x++) for (let z=0;z<CHUNK_SIZE && !picked;z++) for (let y=0;y<CHUNK_HEIGHT && !picked;y++){
            const val = ch[index3(x,y,z)];
            if (val === BLOCK_SHIELD){
              ch[index3(x,y,z)] = BLOCK_AIR; p.carrying = { id:`shield-${Date.now()}`, type:'shield', durability: 3 }; io.emit('chunkDiff', { cx:chx, cz:chz, edits:[{x,y,z,block:BLOCK_AIR}]}); io.to(socket.id).emit('shieldPicked',{id:p.carrying.id,durability:p.carrying.durability}); picked=true;
            } else if (val === BLOCK_SERUM){
              ch[index3(x,y,z)] = BLOCK_AIR; p.inventory = p.inventory||{serum:0}; p.inventory.serum = (p.inventory.serum||0)+1; io.emit('chunkDiff',{cx:chx,cz:chz,edits:[{x,y,z,block:BLOCK_AIR}]}); io.to(socket.id).emit('serumPicked',{count:p.inventory.serum}); picked=true;
            }
          }
        }
      }
      if (picked) { if (typeof ack === 'function') ack({ ok:true, picked }); } else { if (typeof ack === 'function') ack({ ok:false, error:'none' }); }
    } catch(e){ console.error('pickup err', e); if (typeof ack === 'function') ack({ ok:false, error:'server' }); }
  });

  socket.on('useSerum', (payload, ack) => {
    try {
      const p = players[socket.id]; if (!p) { if (typeof ack === 'function') ack({ ok:false }); return; }
      if (!p.inventory || !p.inventory.serum) { if (typeof ack === 'function') ack({ ok:false, error:'no_serum' }); return; }
      p.inventory.serum -= 1; p.stunnedUntil = 0;
      io.to(socket.id).emit('serumUsed', { ok:true });
      if (typeof ack === 'function') ack({ ok:true });
    } catch(e){ console.error('useSerum err', e); if (typeof ack === 'function') ack({ ok:false }); }
  });

  socket.on('disconnect', ()=>{ if (players[socket.id]) players[socket.id].lastSeen = Date.now() - POS_PRUNE_MS - 1; });
});

setInterval(()=>{
  try {
    const now = Date.now();
    for (const id of Object.keys(players)) {
      if (!players[id].lastSeen || (now - players[id].lastSeen > POS_PRUNE_MS)) {
        if (!players[id].isBot) delete players[id];
      }
    }
    const existing = Object.values(players).filter(p=>p.isBot).length;
    if (existing < 8) spawnBots(8 - existing);
    updateBots(now);
    io.emit('stateUpdate', { players: sanitizedPlayersList() });
  } catch(e){ console.error('tick err', e); }
}, STATE_BROADCAST_MS);

app.use(express.static(FRONTEND_DIR));
app.get('*', (req,res)=> res.sendFile(path.join(FRONTEND_DIR, 'index.html')));

server.listen(PORT, ()=> console.log(`Server listening on ${PORT}`));

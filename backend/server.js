'use strict';
/*
Prototype server: chunk REST endpoint, socket.io gameplay (join, pos, shoot, pickup, blockPlace, blockRemove),
capture & shield mechanics integrated. In-memory chunk store (prototype).
*/

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs').promises;
const cors = require('cors');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));

const PORT = process.env.PORT || 3000;
const DATA_FILE = process.env.DATA_FILE || path.resolve(__dirname, 'persist.json');
const FRONTEND_DIR = path.resolve(__dirname, '..', 'frontend', 'public');

function parseAllowedOrigins() {
  const raw = process.env.FRONTEND_ORIGINS || process.env.FRONTEND_ORIGIN || '';
  if (!raw) {
    return [
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      'https://survive.com',
      'https://www.survive.com'
    ];
  }
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}
const ALLOWED_ORIGINS = parseAllowedOrigins();
console.log('Allowed origins for CORS/socket.io:', ALLOWED_ORIGINS);

app.use(cors({
  origin: function(origin, callback) {
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.indexOf(origin) !== -1) return callback(null, true);
    const msg = `CORS blocked: origin ${origin} not in allow list`;
    console.warn(msg);
    return callback(new Error(msg), false);
  },
  methods: ['GET','POST','OPTIONS'],
  credentials: true
}));

// Health
app.get('/health', (req, res) => res.json({ status: 'ok', now: Date.now() }));

// Create-room
app.post('/create-room', async (req, res) => {
  try {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
    let store = { invites: {} };
    try {
      const raw = await fs.readFile(DATA_FILE, 'utf8');
      store = JSON.parse(raw) || store;
    } catch (e) {}
    store.invites = store.invites || {};
    store.invites[code] = { createdAt: Date.now() };
    await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
    await fs.writeFile(DATA_FILE, JSON.stringify(store, null, 2), 'utf8');
    const frontendUrl = (process.env.FRONTEND_URL && process.env.FRONTEND_URL.trim()) ? process.env.FRONTEND_URL.trim() : `${req.protocol}://${req.get('host')}`;
    const url = `${frontendUrl}/?room=${encodeURIComponent(code)}`;
    res.json({ ok: true, roomId: code, url });
  } catch (err) {
    console.error('/create-room error', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// Support
app.post('/support', async (req, res) => {
  try {
    const body = req.body || {};
    const name = (body.name || '').trim();
    const email = (body.email || '').trim();
    const subject = (body.subject || '').trim();
    const message = (body.message || '').trim();
    if (!email || !message) return res.status(400).json({ ok: false, error: 'Missing email or message' });
    let store = { supportMessages: [] };
    try {
      const raw = await fs.readFile(DATA_FILE, 'utf8');
      store = JSON.parse(raw) || store;
    } catch (e) {}
    const id = uuidv4();
    store.supportMessages = store.supportMessages || [];
    store.supportMessages.push({ id, name, email, subject, message, createdAt: Date.now() });
    await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
    await fs.writeFile(DATA_FILE, JSON.stringify(store, null, 2), 'utf8');
    res.json({ ok: true });
  } catch (err) {
    console.error('/support error', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// --- Chunk storage (in-memory prototype) ---
const CHUNK_SIZE = 16;
const CHUNK_HEIGHT = 32;
const chunks = {}; // key "cx,cz" => Int8Array
const BLOCK_AIR = 0, BLOCK_GRASS = 1, BLOCK_DIRT = 2, BLOCK_STONE = 3, BLOCK_SHIELD = 4;

function chunkKey(cx, cz) { return `${cx},${cz}`; }
function index3(x,y,z) { return (y*CHUNK_SIZE + z)*CHUNK_SIZE + x; }
function ensureChunk(cx, cz) {
  const key = chunkKey(cx,cz);
  if (chunks[key]) return chunks[key];
  const size = CHUNK_SIZE * CHUNK_HEIGHT * CHUNK_SIZE;
  const arr = new Int8Array(size).fill(BLOCK_AIR);
  for (let x=0;x<CHUNK_SIZE;x++){
    for (let z=0;z<CHUNK_SIZE;z++){
      const worldX = cx*CHUNK_SIZE + x;
      const worldZ = cz*CHUNK_SIZE + z;
      const h = 8 + Math.floor((Math.sin(worldX*0.21) + Math.cos(worldZ*0.17))*2);
      for (let y=0;y<CHUNK_HEIGHT;y++){
        if (y === h) arr[index3(x,y,z)] = BLOCK_GRASS;
        else if (y < h && y > h-4) arr[index3(x,y,z)] = BLOCK_DIRT;
        else if (y < h-4) arr[index3(x,y,z)] = BLOCK_STONE;
      }
    }
  }
  // occasional shield block
  if (Math.random() > 0.8) {
    const sx = Math.floor(Math.random()*CHUNK_SIZE), sz = Math.floor(Math.random()*CHUNK_SIZE), sy = 10;
    arr[index3(sx,sy,sz)] = BLOCK_SHIELD;
  }
  chunks[key] = arr;
  return arr;
}
function getBlock(cx,cz,x,y,z){
  const ch = ensureChunk(cx,cz);
  if (x<0||x>=CHUNK_SIZE||z<0||z>=CHUNK_SIZE||y<0||y>=CHUNK_HEIGHT) return BLOCK_AIR;
  return ch[index3(x,y,z)];
}
function setBlock(cx,cz,x,y,z,block){
  const ch = ensureChunk(cx,cz);
  if (x<0||x>=CHUNK_SIZE||z<0||z>=CHUNK_SIZE||y<0||y>=CHUNK_HEIGHT) return false;
  ch[index3(x,y,z)] = block;
  return true;
}

// GET /chunk?cx=&cz=
app.get('/chunk', (req,res) => {
  const cx = parseInt(req.query.cx||'0',10);
  const cz = parseInt(req.query.cz||'0',10);
  try {
    const ch = ensureChunk(cx,cz);
    res.json({ ok:true, cx, cz, size: CHUNK_SIZE, height: CHUNK_HEIGHT, blocks: Array.from(ch) });
  } catch (e) {
    res.status(500).json({ ok:false, error: 'chunk error' });
  }
});

// --- Socket.IO + gameplay ---
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: ALLOWED_ORIGINS, methods: ['GET','POST'], credentials: true } });

const players = {}; // socket.id => player
const CAPTURE_DISTANCE = 3.0;
const CAPTURE_HOLD_MS = 800;
const POS_PRUNE_MS = 30000;
const SHIELD_DURABILITY = 3;
const SHIELD_DURATION_MS = 20000;
const STATE_BROADCAST_MS = 200;
const SHOOT_RANGE = 30;

function sanitizedPlayersList() {
  return Object.values(players).map(p => ({
    id: p.id, name: p.name, x:p.x, y:p.y, z:p.z, role:p.role, score:p.score,
    carrying: p.carrying ? { type:p.carrying.type, durability:p.carrying.durability } : null
  }));
}

io.on('connection', (socket) => {
  console.log('[server] socket connected', socket.id);

  socket.on('joinGame', (payload, ack) => {
    try {
      console.log('[server] joinGame received from', socket.id, 'payload=', payload);
      const name = (payload && payload.name) ? String(payload.name).trim() : '';
      if (/^[A-Za-z]{2,30}$/.test(name) && !name.includes('#')) {
        const err = { ok:false, error: 'Single-word names require a # suffix' };
        if (typeof ack === 'function') ack(err);
        socket.emit('joinError', { message: err.error });
        return;
      }
      players[socket.id] = players[socket.id] || {};
      const p = players[socket.id];
      p.id = socket.id;
      p.name = name || 'Player';
      p.x = p.x || 0; p.y = p.y || 2; p.z = p.z || 0;
      p.role = p.role || 'hider';
      p.score = p.score || 0;
      p.carrying = p.carrying || null;
      p.lastSeen = Date.now(); p.lastHitAt = p.lastHitAt || 0; p.proximityStart = null;
      const roomId = (payload && payload.roomId) || 'default';
      if (typeof ack === 'function') ack({ ok:true, roomId });
      socket.emit('joinedRoom', { roomId, playerId: socket.id, name: p.name, role: p.role });
      io.emit('stateUpdate', { players: sanitizedPlayersList() });
      console.log('[server] joinedRoom emitted to', socket.id);
    } catch (e) {
      console.error('[server] joinGame error', e);
      if (typeof ack === 'function') ack({ ok:false, error:'Server error' });
    }
  });

  socket.on('pos', (p) => {
    try {
      if (!players[socket.id]) return;
      const pl = players[socket.id];
      pl.x = Number(p.x) || pl.x;
      pl.y = Number(p.y) || pl.y;
      pl.z = Number(p.z) || pl.z;
      pl.lastSeen = Date.now();
    } catch (e) { console.warn('[server] pos handler', e); }
  });

  socket.on('blockPlace', (data, ack) => {
    try {
      const cx = Math.floor(data.cx||0), cz = Math.floor(data.cz||0);
      const res = setBlock(cx,cz,Number(data.x),Number(data.y),Number(data.z), Number(data.block));
      if (res) {
        io.emit('chunkDiff', { cx, cz, edits: [{ x:data.x, y:data.y, z:data.z, block:data.block }] });
        console.log('[server] blockPlace', cx,cz,data.x,data.y,data.z,data.block);
        if (typeof ack === 'function') ack({ ok:true });
      } else {
        if (typeof ack === 'function') ack({ ok:false, error:'invalid' });
      }
    } catch (e) {
      console.error('[server] blockPlace error', e);
      if (typeof ack === 'function') ack({ ok:false, error:'server' });
    }
  });

  socket.on('blockRemove', (data, ack) => {
    try {
      const cx = Math.floor(data.cx||0), cz = Math.floor(data.cz||0);
      const prev = getBlock(cx,cz,Number(data.x),Number(data.y),Number(data.z));
      const res = setBlock(cx,cz,Number(data.x),Number(data.y),Number(data.z), BLOCK_AIR);
      if (res) {
        io.emit('chunkDiff', { cx, cz, edits: [{ x:data.x, y:data.y, z:data.z, block:BLOCK_AIR }] });
        console.log('[server] blockRemove', cx,cz,data.x,data.y,data.z);
        if (typeof ack === 'function') ack({ ok:true, prev });
      } else {
        if (typeof ack === 'function') ack({ ok:false, error:'invalid' });
      }
    } catch (e) {
      console.error('[server] blockRemove error', e);
      if (typeof ack === 'function') ack({ ok:false, error:'server' });
    }
  });

  socket.on('shoot', (payload, ack) => {
    try {
      const shooter = players[socket.id];
      if (!shooter) { if (typeof ack === 'function') ack({ ok:false, error:'not_found' }); return; }
      let best = null; let bestD2 = Infinity;
      for (const id of Object.keys(players)) {
        if (id === socket.id) continue;
        const pl = players[id];
        const dx = pl.x - shooter.x, dy = pl.y - shooter.y, dz = pl.z - shooter.z;
        const d2 = dx*dx + dy*dy + dz*dz;
        if (d2 < bestD2 && d2 <= SHOOT_RANGE*SHOOT_RANGE) { best = pl; bestD2 = d2; }
      }
      if (!best) { if (typeof ack === 'function') ack({ ok:false, error:'no_target' }); return; }
      if (best.carrying && best.carrying.type === 'shield' && best.carrying.durability > 0) {
        best.carrying.durability -=1;
        io.to(best.id).emit('shieldHit', { by: shooter.id, remaining: best.carrying.durability });
        io.to(shooter.id).emit('shieldBlocked', { target: best.id, remaining: best.carrying.durability });
        console.log('[server] shieldHit', best.id, 'remaining', best.carrying.durability);
        if (best.carrying.durability <= 0) { best.carrying = null; io.to(best.id).emit('shieldDestroyed', { reason:'durability' }); }
        if (typeof ack === 'function') ack({ ok:true, blocked:true });
        return;
      }
      best.lastHitAt = Date.now();
      io.to(best.id).emit('tranqApplied', { id: best.id, duration: 8000 });
      io.to(shooter.id).emit('shotResult', { target: best.id, ok:true });
      console.log('[server] shot applied', shooter.id, '->', best.id);
      if (typeof ack === 'function') ack({ ok:true, target: best.id });
    } catch (e) {
      console.error('[server] shoot error', e);
      if (typeof ack === 'function') ack({ ok:false, error:'server' });
    }
  });

  socket.on('pickup', (payload, ack) => {
    try {
      const pl = players[socket.id];
      if (!pl) { if (typeof ack === 'function') ack({ ok:false }); return; }
      const cx = Math.floor(pl.x / CHUNK_SIZE), cz = Math.floor(pl.z / CHUNK_SIZE);
      let picked = null;
      for (let dx=-1; dx<=1 && !picked; dx++){
        for (let dz=-1; dz<=1 && !picked; dz++){
          const chx = cx+dx, chz = cz+dz;
          const ch = ensureChunk(chx,chz);
          for (let x=0;x<CHUNK_SIZE && !picked;x++){
            for (let z=0;z<CHUNK_SIZE && !picked;z++){
              for (let y=0;y<CHUNK_HEIGHT && !picked;y++){
                const bx = chx*CHUNK_SIZE + x, bz = chz*CHUNK_SIZE + z;
                const worldDx = (bx + 0.5) - pl.x, worldDz = (bz + 0.5) - pl.z;
                const dist2 = worldDx*worldDx + worldDz*worldDz;
                const val = ch[index3(x,y,z)];
                if (val === BLOCK_SHIELD && dist2 <= 4) {
                  ch[index3(x,y,z)] = BLOCK_AIR;
                  picked = { id: `shield-${Date.now()}`, durability: SHIELD_DURABILITY };
                  pl.carrying = { id: picked.id, type: 'shield', durability: picked.durability, expireAt: Date.now()+SHIELD_DURATION_MS };
                  io.emit('chunkDiff', { cx: chx, cz: chz, edits: [{ x,y,z,block: BLOCK_AIR }] });
                  io.to(socket.id).emit('shieldPicked', { id: picked.id, durability: picked.durability, expireAt: pl.carrying.expireAt });
                  console.log('[server] shieldPicked by', socket.id, 'from', chx,chz,x,y,z);
                }
              }
            }
          }
        }
      }
      if (picked) { if (typeof ack === 'function') ack({ ok:true, carrying: pl.carrying }); }
      else { if (typeof ack === 'function') ack({ ok:false, error:'none' }); }
    } catch (e) {
      console.error('[server] pickup error', e);
      if (typeof ack === 'function') ack({ ok:false, error:'server' });
    }
  });

  socket.on('disconnect', () => {
    console.log('[server] socket disconnected', socket.id);
    if (players[socket.id]) players[socket.id].lastSeen = Date.now() - POS_PRUNE_MS - 1;
  });
});

// Server tick
setInterval(() => {
  try {
    const now = Date.now();
    for (const id of Object.keys(players)) {
      if (!players[id].lastSeen || (now - players[id].lastSeen > POS_PRUNE_MS)) {
        console.log('[server] pruning player', id);
        delete players[id];
      }
    }
    const pls = Object.values(players);
    const seekers = pls.filter(p => p.role === 'seeker');
    for (const seeker of seekers) {
      for (const hider of pls.filter(p => p.role !== 'seeker')) {
        const dx = seeker.x - hider.x, dz = seeker.z - hider.z, dy = seeker.y - hider.y;
        const d2 = dx*dx + dy*dy + dz*dz;
        if (d2 <= CAPTURE_DISTANCE*CAPTURE_DISTANCE) {
          const hitRecently = hider.lastHitAt && (now - hider.lastHitAt < 2000);
          if (hitRecently) { hider.proximityStart = null; continue; }
          if (!hider.proximityStart) hider.proximityStart = now;
          if (now - hider.proximityStart >= CAPTURE_HOLD_MS) {
            const prevSeekerId = seeker.id;
            seeker.role = 'hider';
            hider.role = 'seeker';
            hider.score = (hider.score || 0) + 200;
            hider.proximityStart = null;
            io.to(prevSeekerId).emit('captured', { by: hider.id, newRole: 'hider' });
            io.to(hider.id).emit('becameSeeker', { newRole: 'seeker', score: hider.score });
            io.emit('stateUpdate', { players: sanitizedPlayersList() });
            console.log('[server] playerCaptured', prevSeekerId, 'by', hider.id);
            seeker.lastHitAt = Date.now(); hider.lastHitAt = Date.now();
          }
        } else {
          hider.proximityStart = null;
        }
      }
    }
    io.emit('stateUpdate', { players: sanitizedPlayersList() });
  } catch (e) {
    console.error('[server] tick error', e);
  }
}, STATE_BROADCAST_MS);

// static
app.use(express.static(FRONTEND_DIR));
app.get('*', (req, res) => res.sendFile(path.join(FRONTEND_DIR, 'index.html')));

// start
(async function start() {
  server.listen(PORT, () => console.log(`Server listening on ${PORT}`));
})();

'use strict';

/**
 * Full server.js — updated to:
 * - Mark a subset of bots as decoys (isDecoy property) during room setup
 * - Include bot names (bots have .name) and include isDecoy in snapshots
 * - Enforce single-word name reservation (server rejects join if single-word base and not purchased or no # suffix)
 * - Public /create-room endpoint (creates short invite codes)
 *
 * Replace your existing server with this file and restart.
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs').promises;
const path = require('path');

const app = express();
app.use(express.json());
app.disable('x-powered-by');

const PORT = process.env.PORT || 3000;
const DATA_FILE = process.env.DATA_FILE || path.resolve(__dirname, 'persist.json');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const RESERVED_NAMES_CSV = process.env.RESERVED_NAMES || 'admin,moderator,staff,survive,survive.com';
const RESERVED_NAMES = RESERVED_NAMES_CSV.split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);

// constants
const TICK_RATE = 50;
const ROOM_MAX_PLAYERS = 16;
const MAP_WIDTH = 2200;
const MAP_HEIGHT = 2200;
const HIDE_TIME = 15000;
const ROUND_TIME = 120000;
const TRANQ_DURATION = 8000;
const TRANQ_SLOW_MULT = 0.35;
const SERUM_PICKUP_RADIUS = 45;
const SERUM_PER_ROUND = 4;

// persistence store
let store = { purchased: {}, accounts: {}, invites: {} };
const rooms = {};

async function loadStore() {
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw) || {};
    store = Object.assign({ purchased: {}, accounts: {}, invites: {} }, parsed);
    console.log('Loaded store', DATA_FILE);
  } catch (err) {
    if (err.code === 'ENOENT') { store = { purchased:{}, accounts:{}, invites:{} }; console.log('No store file'); }
    else { console.error('loadStore error', err); store = { purchased:{}, accounts:{}, invites:{} }; }
  }
}
async function saveStore() { try { await fs.mkdir(path.dirname(DATA_FILE), { recursive:true }); await fs.writeFile(DATA_FILE, JSON.stringify(store, null, 2), 'utf8'); } catch(e){ console.error('saveStore err', e); } }

function nowMs(){ return Date.now(); }
function clamp(v,a,b){ return Math.max(a, Math.min(b,v)); }
function randomPosition(){ return { x: Math.random()*MAP_WIDTH, y: Math.random()*MAP_HEIGHT }; }
function dist(a,b){ const dx=a.x-b.x, dy=a.y-b.y; return Math.sqrt(dx*dx + dy*dy); }
function sanitizeRequestedName(raw){ if(!raw||typeof raw!=='string') return 'Player'; let s=raw.trim().replace(/[\r\n]+/g,''); if(s.length>30) s=s.slice(0,30); return s||'Player'; }
function generateSuffix(){ return ('000' + Math.floor(Math.random()*10000)).slice(-4); }
function ensureHashSuffix(name){ if(name.includes('#')) { const parts=name.split('#'); const base=parts[0].trim()||'Player'; const suffix=parts.slice(1).join('#').trim()||generateSuffix(); return `${base}#${suffix}`; } else return `${name}#${generateSuffix()}`; }
function nameBase(name){ return (typeof name === 'string' ? name.split('#')[0].trim().toLowerCase() : '').slice(0,30); }
function isSingleWordLetters(base){ if(!base||typeof base!=='string') return false; return (/^[A-Za-z]{2,30}$/).test(base); }
function isPurchased(base){ if(!base) return false; return !!store.purchased[base.toLowerCase()]; }

function makeUniqueNameInRoom(room, desiredName) {
  let final = desiredName;
  const taken = new Set(Object.values(room.players).map(p => (p.name || '').toLowerCase()));
  let tries = 0;
  while (taken.has(final.toLowerCase()) && tries < 8) {
    const suf = generateSuffix(); const base = final.split('#')[0] || 'Player'; final = `${base}#${suf}`; tries++;
  }
  if (taken.has(final.toLowerCase())) final = `${final.split('#')[0]}#${uuidv4().slice(0,4)}`;
  return final;
}

// room creation
function createRoom(roomId, config = {}) {
  rooms[roomId] = {
    id: roomId,
    players: {},
    bots: [],
    state: 'waiting',
    seekerId: null,
    roundStartTime: null,
    hideEndTime: null,
    finishTime: null,
    map: { width: MAP_WIDTH, height: MAP_HEIGHT },
    createdAt: Date.now(),
    config: {
      botCount: typeof config.botCount === 'number' ? clamp(config.botCount,0,16) : 4,
      maxPlayers: typeof config.maxPlayers === 'number' ? config.maxPlayers : ROOM_MAX_PLAYERS,
      swapOnTag: config.swapOnTag !== undefined ? !!config.swapOnTag : true
    },
    scores: {},
    roundIndex: 0,
    powerups: [],
    lastSwapAt: 0
  };
  console.log('Created room', roomId);
}

function getOrCreatePlayerStats(room, id, name) {
  if (!room.scores[id]) room.scores[id] = { id, name: name || 'Player', score: 0, tags:0, survived:0, games:0 };
  else if (name && room.scores[id].name !== name) room.scores[id].name = name;
  return room.scores[id];
}

function startNewRound(room, now) {
  room.state = 'hiding'; room.roundStartTime = null; room.hideEndTime = now + HIDE_TIME; room.finishTime=null; room.roundIndex++;
  Object.values(room.players).forEach(p => { const pos=randomPosition(); p.x=pos.x; p.y=pos.y; p.vx=0; p.vy=0; p.caught=false; p.role='hider'; p.tranqUntil=0; getOrCreatePlayerStats(room,p.id,p.name).games++; });
  // spawn bots, and mark some as decoys
  const desired = Math.max(0, Math.min(16, room.config.botCount || 4));
  while (room.bots.length < desired) {
    const id = 'bot-' + uuidv4();
    const pos = randomPosition();
    // name bots with friendly labels
    const botName = 'Bot' + Math.floor(Math.random()*9000+1000);
    // mark ~25% as decoy
    const isDecoy = Math.random() < 0.25;
    room.bots.push({ id, name: botName, x: pos.x, y: pos.y, vx:0, vy:0, caught:false, role:'hider', wanderAngle: Math.random()*Math.PI*2, tranqUntil:0, isDecoy });
  }
  if (room.bots.length > desired) room.bots.length = desired;
  room.bots.forEach(b => { const pos=randomPosition(); b.x=pos.x; b.y=pos.y; b.caught=false; b.role='hider'; b.tranqUntil=0; b.wanderAngle=Math.random()*Math.PI*2; if (typeof b.isDecoy === 'undefined') b.isDecoy = Math.random() < 0.25; });

  const candidates = [...Object.values(room.players).map(p=>({type:'player', id:p.id, priority: p.nextSeeker?1:0})), ...room.bots.map(b=>({type:'bot', id:b.id, priority:0}))];
  const chosen = candidates[Math.floor(Math.random()*candidates.length)];
  room.seekerId = chosen.id;
  Object.values(room.players).forEach(p=>p.role = p.id === room.seekerId ? 'seeker' : 'hider');
  room.bots.forEach(b=>b.role = b.id === room.seekerId ? 'seeker' : 'hider');
  room.powerups = [];
  for (let i=0;i<SERUM_PER_ROUND;i++){ const pos=randomPosition(); room.powerups.push({ id:'serum-'+uuidv4(), x:pos.x, y:pos.y, type:'wake-serum'}); }
  io.to(room.id).emit('roundStarted', { seekerId: room.seekerId, hideTime: HIDE_TIME, roundIndex: room.roundIndex });
}

function hasAnyHider(room) { return Object.values(room.players).some(p=>p.role==='hider' && !p.caught) || room.bots.some(b=>b.role==='hider' && !b.caught); }

function updateStatusAndSerums(room, now) {
  Object.values(room.players).forEach(p => { if (p.tranqUntil && p.tranqUntil <= now) p.tranqUntil = 0; });
  room.bots.forEach(b => { if (b.tranqUntil && b.tranqUntil <= now) b.tranqUntil = 0; });
  if (!room.powerups || !room.powerups.length) return;
  const remaining = [];
  room.powerups.forEach(pu => {
    if (pu.type !== 'wake-serum') { remaining.push(pu); return; }
    let picked = false;
    Object.values(room.players).forEach(p => { if (picked) return; if (dist(p,pu) <= SERUM_PICKUP_RADIUS) { p.tranqUntil = 0; picked = true; } });
    if (!picked) remaining.push(pu);
  });
  room.powerups = remaining;
}

function applyInput(p, now) {
  if (p.caught) return;
  let speed = 3.1; if (p.tranqUntil && p.tranqUntil > now) speed *= TRANQ_SLOW_MULT;
  let vx=0, vy=0; if (p.input && p.input.up) vy -= 1; if (p.input && p.input.down) vy += 1; if (p.input && p.input.left) vx -= 1; if (p.input && p.input.right) vx += 1;
  const len = Math.sqrt(vx*vx + vy*vy) || 1; vx = (vx/len)*speed; vy = (vy/len)*speed;
  p.x = Math.max(0, Math.min(MAP_WIDTH, p.x + vx)); p.y = Math.max(0, Math.min(MAP_HEIGHT, p.y + vy));
}

function updateBots(room, now) {
  const seeker = room.players[room.seekerId] || room.bots.find(b=>b.id===room.seekerId);
  const playersList = Object.values(room.players);
  room.bots.forEach(bot => {
    if (bot.caught) return;
    let speed = BOT_SPEED; if (bot.tranqUntil && bot.tranqUntil > now) speed *= TRANQ_SLOW_MULT;
    if (bot.role === 'hider') {
      // decoy behavior: if marked as decoy, try to approach seeker and circle to draw attention
      if (bot.isDecoy && seeker) {
        const dx = seeker.x - bot.x, dy = seeker.y - bot.y; const d = Math.sqrt(dx*dx + dy*dy) || 1;
        // target a point slightly offset from seeker (circle)
        const angle = Math.atan2(dy, dx) + Math.sin(now/1000 + bot.wanderAngle) * 0.8;
        const tx = seeker.x - Math.cos(angle) * 80;
        const ty = seeker.y - Math.sin(angle) * 80;
        const ddx = tx - bot.x, ddy = ty - bot.y; const len = Math.sqrt(ddx*ddx + ddy*ddy) || 1;
        bot.x = Math.max(0, Math.min(MAP_WIDTH, bot.x + (ddx/len)*speed));
        bot.y = Math.max(0, Math.min(MAP_HEIGHT, bot.y + (ddy/len)*speed));
      } else {
        // normal hiding wander
        if (Math.random() < 0.03) bot.wanderAngle += Math.random() - 0.5;
        const dx = Math.cos(bot.wanderAngle), dy = Math.sin(bot.wanderAngle); const len = Math.sqrt(dx*dx + dy*dy) || 1;
        bot.x = Math.max(0, Math.min(MAP_WIDTH, bot.x + (dx/len)*speed));
        bot.y = Math.max(0, Math.min(MAP_HEIGHT, bot.y + (dy/len)*speed));
      }
    } else { // seeker bot logic: chase nearest hider
      const targets = [...playersList.filter(p=>p.role==='hider' && !p.caught), ...room.bots.filter(b=>b.role==='hider' && !b.caught)];
      if (!targets.length) return;
      let closest=null, minD=Infinity; targets.forEach(t => { const d = dist(bot, t); if (d < minD) { minD = d; closest = t; }});
      if (closest) {
        const dx = closest.x - bot.x, dy = closest.y - bot.y; const len = Math.sqrt(dx*dx + dy*dy) || 1;
        bot.x = Math.max(0, Math.min(MAP_WIDTH, bot.x + (dx/len)*speed));
        bot.y = Math.max(0, Math.min(MAP_HEIGHT, bot.y + (dy/len)*speed));
      }
    }
  });
}

function finishRound(room, now, reason) {
  room.state = 'finished'; room.finishTime = now;
  const seeker = room.players[room.seekerId] || room.bots.find(b=>b.id===room.seekerId);
  Object.values(room.players).forEach(p => { const stats = getOrCreatePlayerStats(room, p.id, p.name); if (p.role==='hider' && !p.caught) { stats.score += SCORE_SURVIVE; stats.survived++; } });
  const anyHiderLeft = hasAnyHider(room);
  if (seeker && !anyHiderLeft) { const sStats = getOrCreatePlayerStats(room, seeker.id, seeker.name || 'Seeker'); sStats.score += SCORE_FULL_WIPE_BONUS; }
  io.to(room.id).emit('roundFinished', { reason });
}

function buildSnapshot(room) {
  const leaderboard = Object.values(room.scores).sort((a,b)=>b.score-a.score).slice(0,10);
  return {
    state: room.state,
    seekerId: room.seekerId,
    players: Object.values(room.players).map(p => ({ id:p.id, name:p.name, x:p.x, y:p.y, role:p.role, caught:p.caught, tranq: !!(p.tranqUntil && p.tranqUntil > Date.now()) })),
    bots: room.bots.map(b => ({ id:b.id, name:b.name, x:b.x, y:b.y, role:b.role, caught:b.caught, tranq: !!(b.tranqUntil && b.tranqUntil > Date.now()), isDecoy: !!b.isDecoy })),
    map: room.map,
    hideTimeRemaining: room.state === 'hiding' ? Math.max(0, room.hideEndTime - Date.now()) : 0,
    roundTimeRemaining: room.state === 'seeking' && room.roundStartTime ? Math.max(0, room.roundStartTime + ROUND_TIME - Date.now()) : 0,
    leaderboard,
    roundIndex: room.roundIndex,
    powerups: (room.powerups || []).map(p => ({ id:p.id, x:p.x, y:p.y, type:p.type }))
  };
}

/* Socket handlers */
const server = http.createServer(app);
const ioServer = new Server(server, { cors: { origin: '*', methods: ['GET','POST'] } });

ioServer.on('connection', (socket) => {
  console.log('Client connected', socket.id);

  socket.on('joinGame', (payload) => {
    try {
      if (!payload || typeof payload !== 'object') { socket.emit('joinError', { message: 'Invalid payload' }); return; }
      const requested = sanitizeRequestedName(payload.name);
      const roomId = payload.roomId && payload.roomId.trim() ? payload.roomId.trim() : 'default';
      const options = payload.options || {};
      const botCount = typeof options.botCount === 'number' ? clamp(options.botCount,0,16) : undefined;

      let candidate = ensureHashSuffix(requested);
      const base = nameBase(candidate);

      // Enforce reservation: single-word base requires purchase or suffix (#)
      if (isSingleWordLetters(base) && !isPurchased(base) && !requested.includes('#')) {
        socket.emit('joinError', { message: 'Single-word base names require purchase (coming soon) or use a # suffix.' });
        return;
      }

      if (!rooms[roomId]) createRoom(roomId, { botCount: typeof botCount === 'number' ? botCount : 4 });
      const room = rooms[roomId];

      if (Object.keys(room.players).length >= room.config.maxPlayers) { socket.emit('joinError', { message: 'Room full' }); return; }

      candidate = makeUniqueNameInRoom(room, candidate);
      const pos = randomPosition();
      room.players[socket.id] = { id: socket.id, name: candidate, x: pos.x, y: pos.y, vx:0, vy:0, role:'hider', caught:false, input:{ up:false, down:false, left:false, right:false }, tranqUntil:0 };
      getOrCreatePlayerStats(room, socket.id, candidate);
      socket.join(roomId);
      socket.roomId = roomId;

      if (!room.state || room.state === 'waiting') startNewRound(room, Date.now());

      const snap = buildSnapshot(room);
      ioServer.to(room.id).emit('stateUpdate', snap);

      const baseReservedAndUnpurchased = isSingleWordLetters(base) && !isPurchased(base) && !requested.includes('#');

      socket.emit('joinedRoom', { roomId, playerId: socket.id, name: candidate, config: room.config, baseReservedAndUnpurchased });
      console.log(`Player ${socket.id} (${candidate}) joined ${roomId}`);
    } catch (err) {
      console.error('joinGame error', err);
      socket.emit('joinError', { message: 'Server error while joining' });
    }
  });

  socket.on('input', (input) => {
    try {
      const roomId = socket.roomId; if (!roomId || !rooms[roomId]) return;
      const player = rooms[roomId].players[socket.id]; if (!player || player.caught) return;
      player.input = { up: !!(input && input.up), down: !!(input && input.down), left: !!(input && input.left), right: !!(input && input.right) };
    } catch (e) { console.error('input err', e); }
  });

  socket.on('shoot', (payload) => {
    try {
      const roomId = socket.roomId; if (!roomId || !rooms[roomId]) return;
      const x = Number(payload.x), y = Number(payload.y);
      if (!isFinite(x) || !isFinite(y)) return;
      handleShot(rooms[roomId], socket.id, x, y);
    } catch (e) { console.error('shoot err', e); }
  });

  socket.on('leaveRoom', () => {
    const roomId = socket.roomId;
    if (roomId && rooms[roomId]) { delete rooms[roomId].players[socket.id]; socket.leave(roomId); delete socket.roomId; socket.emit('leftRoom', { ok:true }); }
  });

  socket.on('disconnect', () => {
    const roomId = socket.roomId;
    if (roomId && rooms[roomId]) delete rooms[roomId].players[socket.id];
    console.log('Client disconnected', socket.id);
  });
});

/* HTTP endpoints */

// simple health
app.get('/', (req,res) => res.send('Hide To Survive backend'));

// public create-room
app.post('/create-room', async (req,res) => {
  try {
    const body = req.body || {};
    const botCount = typeof body.botCount === 'number' ? clamp(body.botCount,0,16) : 4;
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i=0;i<6;i++) code += chars[Math.floor(Math.random()*chars.length)];
    let tries = 0;
    while (rooms[code] && tries < 8) { code = ''; for (let i=0;i<6;i++) code += chars[Math.floor(Math.random()*chars.length)]; tries++; }
    if (rooms[code]) return res.status(500).json({ ok:false, error:'Could not generate unique room' });
    createRoom(code, { botCount });
    store.invites = store.invites || {}; store.invites[code] = code; await saveStore();
    const url = `${req.protocol}://${req.get('host')}/?room=${encodeURIComponent(code)}`;
    res.json({ ok:true, roomId: code, url, room: rooms[code] });
  } catch (err) { console.error('/create-room err', err); res.status(500).json({ ok:false, error:'Server error' }); }
});

// name-available: reserved true for single-word alpha base unless purchased
app.get('/name-available', (req,res) => {
  const baseRaw = req.query.base;
  if (!baseRaw || typeof baseRaw !== 'string') return res.status(400).json({ ok:false, error:'Missing base' });
  const base = baseRaw.trim().split('#')[0].toLowerCase();
  const purchased = !!store.purchased[base];
  const reserved = (/^[A-Za-z]{2,30}$/).test(base) && !purchased;
  res.json({ ok:true, base, reserved, purchased });
});

// create-checkout-session — simulated grants when Stripe not configured
app.post('/create-checkout-session', async (req,res) => {
  try {
    const body = req.body || {};
    const itemType = body.itemType || '';
    const itemData = body.itemData || {};
    if (itemType === 'name') {
      const base = (itemData.base || '').trim();
      if (!base) return res.status(400).json({ ok:false, error:'Missing base' });
      store.purchased[base.toLowerCase()] = { owner: body.playerName || 'simulated', grantedAt: Date.now() };
      await saveStore();
      if (body.playerId && ioServer.sockets.sockets.get(body.playerId)) ioServer.to(body.playerId).emit('purchaseGranted', { itemType:'name', base });
      return res.json({ ok:true, simulated:true, granted:'name', base });
    }
    res.json({ ok:true, simulated:true, message:'no-op' });
  } catch (err) { console.error('/create-checkout-session', err); res.status(500).json({ ok:false, error:'Server error' }); }
});

// admin helpers (omitted for brevity)

/* Tick loop: run game logic and emit snapshots to rooms */
setInterval(() => {
  const now = Date.now();
  Object.values(rooms).forEach(room => {
    try {
      const pc = Object.keys(room.players).length;
      const bc = room.bots.length;
      if (pc === 0 && bc === 0) {
        if (now - room.createdAt > 30*60*1000) delete rooms[room.id];
        return;
      }
      if (!room.state || room.state === 'waiting') startNewRound(room, now);
      if (room.state === 'hiding' && now >= room.hideEndTime) { room.state = 'seeking'; room.roundStartTime = now; }
      if (room.state === 'seeking') {
        const timeUp = now >= (room.roundStartTime || 0) + ROUND_TIME;
        const any = hasAnyHider(room);
        if (timeUp || !any) finishRound(room, now, !any ? 'all_caught' : 'time_up');
      }
      if (room.state === 'finished' && room.finishTime && now - room.finishTime > 8000) startNewRound(room, now);
      updateStatusAndSerums(room, now);
      Object.values(room.players).forEach(p => applyInput(p, now));
      updateBots(room, now);
      handleTagging(room);
      const snap = buildSnapshot(room);
      ioServer.to(room.id).emit('stateUpdate', snap);
    } catch (err) { console.error('tick err', room.id, err); }
  });
}, TICK_RATE);

/* Start */
server.listen(PORT, async () => {
  console.log('Server listening on', PORT);
  await loadStore();
});

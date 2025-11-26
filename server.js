'use strict';
/*
Full server.js — game server + robust /support that sends via SMTP if configured,
otherwise falls back to local sendmail (suitable for cPanel/Exim setups), and if
that fails persists messages to persist.json.

Notes for cPanel:
- Many cPanel hosts provide a local sendmail/exim at /usr/sbin/sendmail.
- This file will attempt (in order):
  1) SMTP using SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS (if provided)
  2) local sendmail via nodemailer sendmail transport
  3) persist the message to persist.json for admin review
- Set SUPPORT_TO to the address you want to receive support mail (default: support@survive.com).
- Ensure Node has permission to use local sendmail on your cPanel host (some shared hosts restrict Node).
*/

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs').promises;
const path = require('path');

let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch (e) { nodemailer = null; }

const app = express();
app.disable('x-powered-by');

// Basic permissive CORS (adjust origin in production)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); // change to your origin if needed
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: '256kb' }));

// Config / env
const PORT = process.env.PORT || 3000;
const DATA_FILE = process.env.DATA_FILE || path.resolve(__dirname, 'persist.json');

const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : 587;
const SMTP_SECURE = (process.env.SMTP_SECURE || 'false').toLowerCase() === 'true';
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SUPPORT_TO = process.env.SUPPORT_TO || 'support@survive.com';
const SUPPORT_FROM = process.env.SUPPORT_FROM || (SMTP_USER || 'no-reply@survive.com');

// transporter selection
let transporter = null;
if (nodemailer) {
  if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
    // SMTP transport (preferred when configured)
    transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_SECURE,
      auth: { user: SMTP_USER, pass: SMTP_PASS }
    });
    transporter.verify().then(() => console.log('SMTP transporter ready')).catch(err => console.warn('SMTP verify failed:', err && err.message));
  } else {
    // Fall back to local sendmail transport (works on many cPanel setups)
    try {
      transporter = nodemailer.createTransport({
        sendmail: true,
        newline: 'unix',
        path: '/usr/sbin/sendmail'
      });
      // don't throw on verify; some hosts disallow verifying
      transporter.verify().then(() => console.log('Sendmail transporter ready')).catch(() => console.log('Sendmail transporter created (verification skipped)'));
    } catch (err) {
      transporter = null;
      console.warn('Could not create sendmail transporter:', err && err.message);
    }
  }
} else {
  console.warn('nodemailer not installed; support messages will be persisted.');
}

// Persistent store
let store = { purchased: {}, invites: {}, supportMessages: [] };
async function loadStore() {
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw) || {};
    store = Object.assign({ purchased: {}, invites: {}, supportMessages: [] }, parsed);
    console.log('Loaded store from', DATA_FILE);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      store = { purchased: {}, invites: {}, supportMessages: [] };
      console.log('No persist file; starting new store');
    } else {
      console.error('Error loading store', err && err.message);
      store = { purchased: {}, invites: {}, supportMessages: [] };
    }
  }
}
async function saveStore() {
  try {
    await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
    await fs.writeFile(DATA_FILE, JSON.stringify(store, null, 2), 'utf8');
  } catch (err) {
    console.error('saveStore error', err && err.message);
  }
}

// Utility helpers
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function randomPosition() { return { x: Math.random() * 2200, y: Math.random() * 2200 }; }
function sanitizeName(s) { if (!s || typeof s !== 'string') return 'Player'; let r = s.trim().replace(/[\r\n]+/g, ''); if (r.length > 30) r = r.slice(0, 30); return r || 'Player'; }
function nameBase(name) { return (typeof name === 'string' ? name.split('#')[0].trim().toLowerCase() : '').slice(0, 30); }
function isSingleWordLetters(base) { return /^[A-Za-z]{2,30}$/.test(base); }

// ---------- Support endpoint ----------
app.post('/support', async (req, res) => {
  try {
    const body = req.body || {};
    const name = (body.name || '').trim();
    const email = (body.email || '').trim();
    const subject = (body.subject || '').trim() || 'Support request';
    const message = (body.message || '').trim();

    if (!email || !message) {
      return res.status(400).json({ ok: false, error: 'Missing required fields: email and message are required.' });
    }

    const id = uuidv4();
    const record = { id, name, email, subject, message, createdAt: Date.now(), delivered: false, deliveredAt: null };

    // Try to send via configured transporter (SMTP OR sendmail)
    if (transporter) {
      try {
        const mailOpts = {
          from: SUPPORT_FROM,
          to: SUPPORT_TO,
          subject: `[Survive Support] ${subject}`,
          text: `Support message from ${name || '(no name)'} <${email}>\n\n${message}`,
          html: `<p>Support message from <strong>${name || '(no name)'}</strong> &lt;${email}&gt;</p><hr/><pre style="white-space:pre-wrap;">${message}</pre>`
        };
        await transporter.sendMail(mailOpts);
        record.delivered = true;
        record.deliveredAt = Date.now();
        store.supportMessages = store.supportMessages || [];
        store.supportMessages.push(record);
        await saveStore();
        console.log('Support message sent via transporter; id=', id);
        return res.json({ ok: true });
      } catch (err) {
        console.error('Transport send failed — will persist message. Error:', err && err.message);
        // fall through to persist
      }
    }

    // Persist if sending not possible
    store.supportMessages = store.supportMessages || [];
    store.supportMessages.push(record);
    await saveStore();
    console.log('Support message persisted; id=', id);
    return res.json({ ok: true, simulated: true });
  } catch (err) {
    console.error('/support error', err && err.stack ? err.stack : err);
    return res.status(500).json({ ok: false, error: 'Server error while handling support request' });
  }
});

// ------------------ Remaining game server endpoints and socket.io ------------------
// For completeness this file implements the game server (create-room, name-available, create-checkout-session, and the Socket.IO game loop).
// This is based on the combined server provided previously; simplified where appropriate.

const TICK_RATE = 50;
const rooms = {}; // runtime rooms (roomId -> room object)

function createRoomObj(roomId, config = {}) {
  return {
    id: roomId,
    players: {},
    bots: [],
    state: 'waiting',
    seekerId: null,
    roundStartTime: null,
    hideEndTime: null,
    finishTime: null,
    map: { width: 2200, height: 2200 },
    createdAt: Date.now(),
    config: {
      botCount: typeof config.botCount === 'number' ? clamp(config.botCount, 0, 16) : 4,
      maxPlayers: typeof config.maxPlayers === 'number' ? config.maxPlayers : 16,
      swapOnTag: config.swapOnTag !== undefined ? !!config.swapOnTag : true
    },
    scores: {},
    roundIndex: 0,
    powerups: [],
    lastSwapAt: 0
  };
}

function getOrCreatePlayerStats(room, id, name) {
  if (!room.scores[id]) room.scores[id] = { id, name: name || 'Player', score: 0, tags: 0, survived: 0, games: 0 };
  else if (name && room.scores[id].name !== name) room.scores[id].name = name;
  return room.scores[id];
}

function startNewRound(room, now) {
  room.state = 'hiding';
  room.roundStartTime = null;
  room.hideEndTime = now + 15000;
  room.finishTime = null;
  room.roundIndex++;
  Object.values(room.players).forEach(p => {
    const pos = randomPosition();
    p.x = pos.x; p.y = pos.y; p.vx = 0; p.vy = 0; p.caught = false; p.role = 'hider'; p.tranqUntil = 0;
    getOrCreatePlayerStats(room, p.id, p.name).games++;
  });
  const desired = Math.max(0, Math.min(16, room.config.botCount || 4));
  while (room.bots.length < desired) {
    const id = 'bot-' + uuidv4();
    const pos = randomPosition();
    const isDecoy = Math.random() < 0.25;
    room.bots.push({ id, name: 'Bot' + Math.floor(Math.random() * 9000 + 1000), x: pos.x, y: pos.y, vx: 0, vy: 0, caught: false, role: 'hider', wanderAngle: Math.random() * Math.PI * 2, tranqUntil: 0, isDecoy });
  }
  if (room.bots.length > desired) room.bots.length = desired;
  const candidates = [...Object.values(room.players).map(p => ({ id: p.id })), ...room.bots.map(b => ({ id: b.id }))];
  const chosen = candidates[Math.floor(Math.random() * candidates.length)];
  room.seekerId = chosen.id;
  Object.values(room.players).forEach(p => p.role = p.id === room.seekerId ? 'seeker' : 'hider');
  room.bots.forEach(b => b.role = b.id === room.seekerId ? 'seeker' : 'hider');
  room.powerups = [];
  for (let i = 0; i < 4; i++) {
    const pos = randomPosition();
    room.powerups.push({ id: 's-' + uuidv4(), x: pos.x, y: pos.y, type: 'wake-serum' });
  }
  io.to(room.id).emit('roundStarted', { seekerId: room.seekerId, hideTime: 15000, roundIndex: room.roundIndex });
}

function buildSnapshot(room) {
  const leaderboard = Object.values(room.scores).sort((a, b) => b.score - a.score).slice(0, 10);
  return {
    state: room.state,
    seekerId: room.seekerId,
    players: Object.values(room.players).map(p => ({ id: p.id, name: p.name, x: p.x, y: p.y, role: p.role, caught: p.caught })),
    bots: room.bots.map(b => ({ id: b.id, name: b.name, x: b.x, y: b.y, role: b.role, caught: b.caught, isDecoy: !!b.isDecoy })),
    map: room.map,
    hideTimeRemaining: room.state === 'hiding' ? Math.max(0, room.hideEndTime - Date.now()) : 0,
    roundTimeRemaining: room.state === 'seeking' && room.roundStartTime ? Math.max(0, room.roundStartTime + 120000 - Date.now()) : 0,
    leaderboard,
    roundIndex: room.roundIndex,
    powerups: (room.powerups || []).map(p => ({ id: p.id, x: p.x, y: p.y, type: p.type }))
  };
}

// Minimal shoot handling (tranq + capture)
function handleShot(room, shooterId, x, y) {
  const seeker = room.players[room.seekerId] || room.bots.find(b => b.id === room.seekerId);
  if (!seeker || seeker.id !== shooterId) return;
  if (room.state !== 'seeking') return;
  const impact = { x, y };
  let closest = null, cd = Infinity;
  Object.values(room.players).forEach(p => {
    if (p.role === 'hider' && !p.caught) {
      const d = Math.hypot(p.x - impact.x, p.y - impact.y);
      if (d < cd) { cd = d; closest = p; }
    }
  });
  let closestBot = null, cbd = Infinity;
  room.bots.forEach(b => {
    if (b.role === 'hider' && !b.caught) {
      const d = Math.hypot(b.x - impact.x, b.y - impact.y);
      if (d < cbd) { cbd = d; closestBot = b; }
    }
  });
  let target = null, isBot = false;
  if (closest && cd <= 80) target = closest;
  if (closestBot && cbd <= 80 && cbd < cd) { target = closestBot; isBot = true; }
  if (target) {
    const now = Date.now();
    if (!target.tranqUntil || target.tranqUntil <= now) {
      target.tranqUntil = now + 8000;
      io.to(room.id).emit('tranqApplied', { id: target.id, duration: 8000, isBot });
    } else {
      target.caught = true;
      if (isBot) io.to(room.id).emit('botTagged', { id: target.id, by: shooterId });
      else io.to(room.id).emit('playerTagged', { id: target.id, by: shooterId });
    }
  }
  io.to(room.id).emit('shotFired', { shooterId, x, y });
}

// HTTP endpoints (health, name-available, create-room, create-checkout-session)
app.get('/', (req, res) => res.send('Hide To Survive backend'));

app.get('/name-available', (req, res) => {
  const baseRaw = req.query.base;
  if (!baseRaw || typeof baseRaw !== 'string') return res.status(400).json({ ok: false, error: 'Missing base' });
  const base = baseRaw.trim().split('#')[0].toLowerCase();
  const purchased = !!(store.purchased && store.purchased[base]);
  const reserved = /^[A-Za-z]{2,30}$/.test(base) && !purchased;
  res.json({ ok: true, base, reserved, purchased });
});

app.post('/create-room', async (req, res) => {
  try {
    const body = req.body || {};
    const botCount = typeof body.botCount === 'number' ? clamp(body.botCount, 0, 16) : 4;
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
    let tries = 0;
    while (rooms[code] && tries < 8) { code = ''; for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)]; tries++; }
    if (rooms[code]) return res.status(500).json({ ok: false, error: 'Could not generate unique room code' });
    rooms[code] = createRoomObj(code, { botCount });
    store.invites = store.invites || {}; store.invites[code] = code;
    await saveStore();
    const url = `${req.protocol}://${req.get('host')}/?room=${encodeURIComponent(code)}`;
    res.json({ ok: true, roomId: code, url, room: rooms[code] });
  } catch (err) { console.error('/create-room error', err); res.status(500).json({ ok: false, error: 'Server error' }); }
});

app.post('/create-checkout-session', async (req, res) => {
  try {
    const b = req.body || {};
    if (b.itemType === 'name') {
      const base = (b.itemData && b.itemData.base) ? b.itemData.base.trim() : null;
      if (!base) return res.status(400).json({ ok: false, error: 'Missing base' });
      store.purchased = store.purchased || {};
      store.purchased[base.toLowerCase()] = { owner: b.playerName || 'simulated', grantedAt: Date.now() };
      await saveStore();
      if (b.playerId && io.sockets.sockets.get(b.playerId)) io.to(b.playerId).emit('purchaseGranted', { itemType: 'name', base });
      return res.json({ ok: true, simulated: true, base });
    }
    return res.json({ ok: true, simulated: true });
  } catch (err) { console.error('/create-checkout-session error', err); res.status(500).json({ ok: false, error: 'Server error' }); }
});

// Socket.io server
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

io.on('connection', (socket) => {
  console.log('Client connected', socket.id);

  socket.on('joinGame', (payload) => {
    try {
      if (!payload || typeof payload !== 'object') { socket.emit('joinError', { message: 'Invalid payload' }); return; }
      const requested = sanitizeName(payload.name);
      const roomId = payload.roomId && payload.roomId.trim() ? payload.roomId.trim() : 'default';
      const options = payload.options || {};
      const botCount = typeof options.botCount === 'number' ? clamp(options.botCount, 0, 16) : undefined;

      let candidate = requested.includes('#') ? requested : `${requested}#${('000' + Math.floor(Math.random() * 10000)).slice(-4)}`;
      const base = nameBase(candidate);
      if (isSingleWordLetters(base) && !isPurchased(base) && !requested.includes('#')) {
        socket.emit('joinError', { message: 'Single-word base names require purchase or a # suffix.' });
        return;
      }

      if (!rooms[roomId]) rooms[roomId] = createRoomObj(roomId, { botCount: typeof botCount === 'number' ? botCount : 4 });
      const room = rooms[roomId];
      if (Object.keys(room.players).length >= room.config.maxPlayers) { socket.emit('joinError', { message: 'Room full' }); return; }

      // ensure unique in-room
      let final = candidate;
      const taken = new Set(Object.values(room.players).map(p => (p.name || '').toLowerCase()));
      let tries = 0;
      while (taken.has(final.toLowerCase()) && tries < 8) { final = `${final.split('#')[0]}#${('000' + Math.floor(Math.random() * 10000)).slice(-4)}`; tries++; }
      if (taken.has(final.toLowerCase())) final = `${final.split('#')[0]}#${uuidv4().slice(0,4)}`;

      const pos = randomPosition();
      room.players[socket.id] = { id: socket.id, name: final, x: pos.x, y: pos.y, vx: 0, vy: 0, role: 'hider', caught: false, input: {}, tranqUntil: 0 };
      getOrCreatePlayerStats(room, socket.id, final);
      socket.join(roomId); socket.roomId = roomId;

      if (!room.state || room.state === 'waiting') startNewRound(room, Date.now());

      const snap = buildSnapshot(room);
      io.to(room.id).emit('stateUpdate', snap);

      const baseReservedAndUnpurchased = isSingleWordLetters(base) && !isPurchased(base) && !requested.includes('#');
      socket.emit('joinedRoom', { roomId, playerId: socket.id, name: final, config: room.config, baseReservedAndUnpurchased });
      console.log(`Player ${socket.id} (${final}) joined ${roomId}`);
    } catch (err) {
      console.error('joinGame error', err && err.stack ? err.stack : err);
      socket.emit('joinError', { message: 'Server error while joining' });
    }
  });

  socket.on('input', (input) => {
    try {
      const roomId = socket.roomId; if (!roomId || !rooms[roomId]) return;
      const player = rooms[roomId].players[socket.id]; if (!player || player.caught) return;
      player.input = { up: !!(input && input.up), down: !!(input && input.down), left: !!(input && input.left), right: !!(input && input.right) };
    } catch (err) { console.error('input err', err); }
  });

  socket.on('shoot', (payload) => {
    try {
      const roomId = socket.roomId; if (!roomId || !rooms[roomId]) return;
      const x = Number(payload.x), y = Number(payload.y); if (!isFinite(x) || !isFinite(y)) return;
      handleShot(rooms[roomId], socket.id, x, y);
    } catch (err) { console.error('shoot err', err); }
  });

  socket.on('leaveRoom', () => {
    const roomId = socket.roomId;
    if (roomId && rooms[roomId]) {
      delete rooms[roomId].players[socket.id];
      socket.leave(roomId);
      delete socket.roomId;
      socket.emit('leftRoom', { ok: true });
    }
  });

  socket.on('disconnect', () => {
    const roomId = socket.roomId;
    if (roomId && rooms[roomId]) delete rooms[roomId].players[socket.id];
  });
});

// Tick loop to update rooms and emit snapshots
setInterval(() => {
  const now = Date.now();
  Object.values(rooms).forEach(room => {
    try {
      const pc = Object.keys(room.players).length;
      const bc = room.bots.length;
      if (pc === 0 && bc === 0) {
        if (now - room.createdAt > 30 * 60 * 1000) delete rooms[room.id];
        return;
      }
      if (!room.state || room.state === 'waiting') startNewRound(room, now);
      if (room.state === 'hiding' && now >= room.hideEndTime) { room.state = 'seeking'; room.roundStartTime = now; }
      if (room.state === 'seeking') {
        const timeUp = now >= (room.roundStartTime || 0) + 120000;
        const anyHider = Object.values(room.players).some(p => p.role === 'hider' && !p.caught) || room.bots.some(b => b.role === 'hider' && !b.caught);
        if (timeUp || !anyHider) {
          room.state = 'finished';
          room.finishTime = now;
          io.to(room.id).emit('roundFinished', { reason: !anyHider ? 'all_caught' : 'time_up' });
        }
      }
      if (room.state === 'finished' && room.finishTime && now - room.finishTime > 8000) startNewRound(room, now);

      // Update bots (simple behavior)
      room.bots.forEach(bot => {
        if (bot.caught) return;
        if (bot.role === 'hider') {
          if (bot.isDecoy && room.players[room.seekerId]) {
            const seeker = room.players[room.seekerId];
            const dx = seeker.x - bot.x, dy = seeker.y - bot.y, d = Math.hypot(dx, dy) || 1;
            const angle = Math.atan2(dy, dx) + Math.sin(now / 1000 + bot.wanderAngle) * 0.6;
            const tx = seeker.x - Math.cos(angle) * 80, ty = seeker.y - Math.sin(angle) * 80;
            const ddx = tx - bot.x, ddy = ty - bot.y, len = Math.hypot(ddx, ddy) || 1;
            bot.x += (ddx / len) * 2.2; bot.y += (ddy / len) * 2.2;
          } else {
            if (Math.random() < 0.03) bot.wanderAngle += Math.random() - 0.5;
            const dx = Math.cos(bot.wanderAngle), dy = Math.sin(bot.wanderAngle), len = Math.hypot(dx, dy) || 1;
            bot.x += (dx / len) * 1.6; bot.y += (dy / len) * 1.6;
          }
        } else {
          const targets = [...Object.values(room.players).filter(p => p.role === 'hider' && !p.caught), ...room.bots.filter(b => b.role === 'hider' && !b.caught)];
          if (!targets.length) return;
          let closest = null, md = Infinity;
          targets.forEach(t => { const d = Math.hypot(t.x - bot.x, t.y - bot.y); if (d < md) { md = d; closest = t; }});
          if (closest) { const dx = closest.x - bot.x, dy = closest.y - bot.y, len = Math.hypot(dx, dy) || 1; bot.x += (dx / len) * 2.6; bot.y += (dy / len) * 2.6; }
        }
      });

      const snap = buildSnapshot(room);
      io.to(room.id).emit('stateUpdate', snap);
    } catch (err) { console.error('tick error for room', room.id, err && err.stack ? err.stack : err); }
  });
}, TICK_RATE);

// Start server
(async () => {
  await loadStore();
  server.listen(PORT, () => console.log(`Hide To Survive server listening on ${PORT}`));
})();

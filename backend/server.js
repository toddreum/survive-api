'use strict';
/*
 Combined server:
 - Responds to GET /health
 - Provides POST /create-room and POST /support
 - Serves static frontend from ../frontend/public
 - Socket.IO for realtime joinGame -> joinedRoom
 - CORS + socket.io CORS configured from FRONTEND_ORIGINS / FRONTEND_ORIGIN env
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

// CONFIG
const PORT = process.env.PORT || 3000;
const DATA_FILE = process.env.DATA_FILE || path.resolve(__dirname, 'persist.json');
const FRONTEND_DIR = path.resolve(__dirname, '..', 'frontend', 'public');

// Helper: parse allowed origins from env
function parseAllowedOrigins() {
  const raw = process.env.FRONTEND_ORIGINS || process.env.FRONTEND_ORIGIN || '';
  if (!raw) {
    // sensible defaults for dev and production domain
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

// CORS options for Express
function corsOptions() {
  return {
    origin: function(origin, callback) {
      // allow non-browser requests with no origin (curl, mobile, etc)
      if (!origin) return callback(null, true);
      if (ALLOWED_ORIGINS.indexOf(origin) !== -1) return callback(null, true);
      const msg = `CORS blocked: origin ${origin} not in allow list`;
      console.warn(msg);
      return callback(new Error(msg), false);
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    credentials: true
  };
}
app.use(cors(corsOptions()));

// Simple health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', now: Date.now() });
});

// Simple create-room
app.post('/create-room', async (req, res) => {
  try {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
    // persist (basic)
    let store = { invites: {} };
    try {
      const raw = await fs.readFile(DATA_FILE, 'utf8');
      store = JSON.parse(raw) || store;
    } catch(e) { /* ignore missing file */ }
    store.invites = store.invites || {};
    store.invites[code] = { createdAt: Date.now() };
    await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
    await fs.writeFile(DATA_FILE, JSON.stringify(store, null, 2), 'utf8');

    // Build a user-facing invite URL. Prefer FRONTEND_URL env if set.
    const frontendUrl = (process.env.FRONTEND_URL && process.env.FRONTEND_URL.trim()) ? process.env.FRONTEND_URL.trim() : `${req.protocol}://${req.get('host')}`;
    const url = `${frontendUrl}/?room=${encodeURIComponent(code)}`;
    res.json({ ok: true, roomId: code, url });
  } catch (err) {
    console.error('/create-room error', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// Support (stores message to disk)
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
    } catch (e) { /* ignore missing file */ }

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

// --- Socket.IO setup (simple) ---
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: ALLOWED_ORIGINS,
    methods: ['GET', 'POST'],
    credentials: true
  }
});

io.on('connection', (socket) => {
  console.log('socket connected', socket.id);
  socket.on('joinGame', (payload) => {
    console.log('joinGame', socket.id, payload && payload.name, payload && payload.roomId);
    socket.emit('joinedRoom', { roomId: (payload && payload.roomId) || 'default', playerId: socket.id, name: (payload && payload.name) || 'Player' });
  });
  socket.on('disconnect', () => console.log('socket disconnected', socket.id));
});

// --- Serve frontend static files (after API routes) ---
app.use(express.static(FRONTEND_DIR));
app.get('*', (req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
});

// Start the server
(async function start() {
  server.listen(PORT, () => console.log(`Server listening on ${PORT}`));
})();

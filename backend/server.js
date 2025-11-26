'use strict';
/*
Minimal server:
- listens on process.env.PORT
- CORS controlled by FRONTEND_ORIGIN env var
- /support sends via SMTP if configured, otherwise persists to persist.json
- socket.io accepts joinGame and replies with joinedRoom so frontend can test connectivity
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
app.use(express.json({ limit: '256kb' }));

// config via env
const PORT = process.env.PORT || 3000;
const DATA_FILE = process.env.DATA_FILE || path.resolve(__dirname, 'persist.json');
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || '*';
const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : 587;
const SMTP_SECURE = (process.env.SMTP_SECURE || 'false').toLowerCase() === 'true';
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SUPPORT_TO = process.env.SUPPORT_TO || 'support@survive.com';
const SUPPORT_FROM = process.env.SUPPORT_FROM || (SMTP_USER || 'no-reply@survive.com');

// CORS
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', FRONTEND_ORIGIN);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// transporter: prefer SMTP, fallback to sendmail if available
let transporter = null;
if (nodemailer) {
  if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
    transporter = nodemailer.createTransport({
      host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_SECURE,
      auth: { user: SMTP_USER, pass: SMTP_PASS }
    });
    transporter.verify().then(()=>console.log('SMTP ready')).catch(()=>console.warn('SMTP verify failed'));
  } else {
    try {
      transporter = nodemailer.createTransport({ sendmail: true, newline: 'unix', path: '/usr/sbin/sendmail' });
      transporter.verify().then(()=>console.log('Sendmail ready')).catch(()=>console.log('Sendmail created'));
    } catch (err) { transporter = null; console.warn('No transporter', err && err.message); }
  }
} else {
  console.warn('nodemailer not installed; support will persist messages');
}

// persistence
let store = { purchased: {}, invites: {}, supportMessages: [] };
async function loadStore() {
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    store = Object.assign({ purchased: {}, invites: {}, supportMessages: [] }, JSON.parse(raw) || {});
    console.log('Loaded store');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      store = { purchased: {}, invites: {}, supportMessages: [] };
      console.log('No persist file; starting fresh');
    } else {
      console.error('loadStore error', err);
      store = { purchased: {}, invites: {}, supportMessages: [] };
    }
  }
}
async function saveStore() {
  try {
    await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
    await fs.writeFile(DATA_FILE, JSON.stringify(store, null, 2), 'utf8');
  } catch (err) { console.error('saveStore error', err); }
}

// endpoints
app.get('/health', (req, res) => res.json({ status: 'ok', now: Date.now() }));

app.post('/create-room', async (req, res) => {
  try {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
    store.invites = store.invites || {};
    store.invites[code] = code;
    await saveStore();
    const url = `${req.protocol}://${req.get('host')}/?room=${encodeURIComponent(code)}`;
    res.json({ ok: true, roomId: code, url });
  } catch (err) {
    console.error('/create-room error', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

app.post('/support', async (req, res) => {
  try {
    const body = req.body || {};
    const name = (body.name || '').trim();
    const email = (body.email || '').trim();
    const subject = (body.subject || '').trim() || 'Support request';
    const message = (body.message || '').trim();
    if (!email || !message) return res.status(400).json({ ok: false, error: 'Missing email or message' });

    const id = uuidv4();
    const record = { id, name, email, subject, message, createdAt: Date.now(), delivered: false, deliveredAt: null };

    if (transporter) {
      try {
        await transporter.sendMail({
          from: SUPPORT_FROM,
          to: SUPPORT_TO,
          subject: `[Survive Support] ${subject}`,
          text: `From: ${name || '(no name)'} <${email}>\n\n${message}`,
          html: `<p>From: <strong>${name || '(no name)'}</strong> &lt;${email}&gt;</p><hr/><pre>${message}</pre>`
        });
        record.delivered = true;
        record.deliveredAt = Date.now();
        store.supportMessages.push(record);
        await saveStore();
        console.log('Support email sent id=', id);
        return res.json({ ok: true });
      } catch (err) {
        console.error('Transport send failed, persisting', err && err.message);
      }
    }

    store.supportMessages.push(record);
    await saveStore();
    console.log('Support message persisted id=', id);
    res.json({ ok: true, simulated: true });
  } catch (err) {
    console.error('/support error', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// socket.io
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: FRONTEND_ORIGIN, methods: ['GET', 'POST'] } });

io.on('connection', (socket) => {
  console.log('socket connected', socket.id);
  socket.on('joinGame', (payload) => {
    console.log('joinGame', socket.id, payload && payload.name, payload && payload.roomId);
    socket.emit('joinedRoom', { roomId: (payload && payload.roomId) || 'default', playerId: socket.id, name: (payload && payload.name) || 'Player' });
  });
  socket.on('disconnect', () => console.log('socket disconnected', socket.id));
});

(async function start() {
  await loadStore();
  server.listen(PORT, () => console.log(`Survive backend listening on ${PORT}`));
})();

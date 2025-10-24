// server.js — fresh build synced to frontend
require('dotenv').config();

const express = require('express');
const path = require('path');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const http = require('http');

const app = express();
const server = http.createServer(app);
const io = require('socket.io')(server, {
  cors: { origin: process.env.FRONTEND_URL || '*', methods: ['GET','POST'] }
});

const PORT = process.env.PORT || 8080;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:8080';

// Security + perf
app.enable('trust proxy');
app.use(helmet({ contentSecurityPolicy:false, crossOriginEmbedderPolicy:false }));
app.use(compression());
app.use(morgan(process.env.NODE_ENV === 'production' ? 'tiny' : 'dev'));
app.use(cors({ origin: FRONTEND_URL, credentials:false }));

// Parsers
app.use('/api', express.json({ limit: '1mb' }));

// Rate limit
const apiLimiter = rateLimit({ windowMs:60*1000, max:200, standardHeaders:true, legacyHeaders:false });
app.use(['/api'], apiLimiter);

// Static
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, fp)=>{
    if (/\.(css|js|png|jpg|jpeg|gif|svg|webp|woff2?)$/i.test(fp)) res.setHeader('Cache-Control','public, max-age=86400, immutable');
    else res.setHeader('Cache-Control','no-store');
  }
}));

app.get('/healthz', (_req,res)=> res.json({ ok:true, ts:Date.now() }));

// Stripe booster only
let stripe;
if (process.env.STRIPE_SECRET_KEY){
  stripe = require('stripe')(process.env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' });
}
app.post('/api/buy_health', async (req,res)=>{
  try{
    if(!stripe) return res.status(503).json({ error:'Stripe not configured' });
    const { playerId='anon', roomCode='practice' } = req.body || {};
    const session = await stripe.checkout.sessions.create({
      mode:'payment',
      line_items: [{ price: process.env.STRIPE_PRICE_HEALTH_BOOST, quantity:1 }],
      success_url: `${FRONTEND_URL}/?purchase=success`,
      cancel_url: `${FRONTEND_URL}/?purchase=cancel`,
      metadata: { type:'HEALTH_BOOST', playerId, roomCode }
    });
    res.json({ url: session.url });
  }catch(e){
    console.error('buy_health error', e);
    res.status(500).json({ error:'Failed to create checkout session' });
  }
});
const rawBody = express.raw({ type:'application/json' });
app.post('/webhook', rawBody, (req,res)=>{
  if(!stripe) return res.status(503).end();
  try{
    const sig = req.headers['stripe-signature'];
    const evt = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    if (evt.type === 'checkout.session.completed'){
      const s = evt.data.object;
      const { playerId, roomCode } = s.metadata || {};
      // notify room for +2 HP grant
      if(roomCode) io.to(roomCode).emit('boost:granted', { playerId, roomCode, hp:+2 });
      console.log('Boost granted', { playerId, roomCode });
    }
    res.json({ received:true });
  }catch(e){
    console.warn('Webhook verify failed', e.message);
    res.status(400).send(`Webhook Error: ${e.message}`);
  }
});

// -------------- Socket.IO Room Manager (in-memory for MVP) --------------
const ROOMS = new Map();
// helper to make codes
function code(n=5){ const A='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; return Array.from({length:n},()=>A[Math.floor(Math.random()*A.length)]).join(''); }
const ANIMALS = require('./animals.json');

function uniqueAnimal(room){
  const pack = room.animalPack || 'All';
  const pool = ANIMALS; // single pool, room enforces uniqueness
  const remaining = pool.filter(a => !room.used.has(a));
  if (!remaining.length) return null;
  const pick = remaining[Math.floor(Math.random()*remaining.length)];
  room.used.add(pick);
  return pick;
}

io.on('connection', (socket)=>{
  socket.on('room:create', ({ theme='jungle', minHumans=4, maxBots=10 }, cb)=>{
    const id = code(5);
    const room = { id, theme, minHumans, maxBots, players:new Map(), used:new Set(), started:false, createdAt:Date.now() };
    ROOMS.set(id, room);
    cb?.({ ok:true, code:id });
  });

  socket.on('room:join', ({ code:id, name='Player', lastInitial='' }, cb)=>{
    const room = ROOMS.get(id);
    if(!room) return cb?.({ ok:false, error:'Room not found' });
    const animal = uniqueAnimal(room);
    if(!animal) return cb?.({ ok:false, error:'Room animal pool exhausted' });
    const playerId = socket.id;
    const label = `${name} ${String(lastInitial||'').slice(0,1).toUpperCase()}.`.trim();
    room.players.set(playerId, { id:playerId, label, name, animal, hp:20, isBot:false, lastPauseAt:0 });
    socket.join(id);
    io.to(id).emit('room:state', serializeRoom(room));
    cb?.({ ok:true, room: serializeRoom(room) });
  });

  socket.on('match:quick', ({ name='Player', lastInitial='' }, cb)=>{
    // naive: reuse an existing public room or create one
    let room = [...ROOMS.values()].find(r=>!r.started && (r.minHumans||0) <= (r.players?.size||0)+1);
    if(!room){ const id=code(5); room = { id, theme:'jungle', minHumans:4, maxBots:10, players:new Map(), used:new Set(), started:false, createdAt:Date.now() }; ROOMS.set(id, room); }
    const animal = uniqueAnimal(room);
    const playerId = socket.id;
    const label = `${name} ${String(lastInitial||'').slice(0,1).toUpperCase()}.`.trim();
    room.players.set(playerId, { id:playerId, label, name, animal, hp:20, isBot:false, lastPauseAt:0 });
    socket.join(room.id);
    io.to(room.id).emit('room:state', serializeRoom(room));
    cb?.({ ok:true, code: room.id, room: serializeRoom(room) });
  });

  socket.on('pauseMatch', ({ code:id }, cb)=>{
    const room = ROOMS.get(id);
    const me = room?.players.get(socket.id);
    if(!room || !me) return cb?.({ ok:false });
    const now=Date.now();
    if(me.lastPauseAt && now - me.lastPauseAt < 60000) return cb?.({ ok:false, error:'Cooldown' });
    me.lastPauseAt = now;
    room.pausedUntil = now + 8000;
    io.to(id).emit('paused', { by: me.id, until: room.pausedUntil });
    cb?.({ ok:true });
  });

  socket.on('disconnect', ()=>{
    for (const [id, room] of ROOMS){
      if (room.players.delete(socket.id)){
        io.to(id).emit('room:state', serializeRoom(room));
      }
    }
  });
});

function serializeRoom(room){
  return {
    id: room.id, theme: room.theme, started: room.started, pausedUntil: room.pausedUntil||0,
    players: [...room.players.values()].map(p=>({ id:p.id, label:p.label, animal:p.animal, hp:p.hp, isBot:p.isBot })),
  };
}

// SPA fallback
app.get('*', (req,res,next)=>{
  const file = path.join(__dirname, 'public', 'index.html');
  res.sendFile(file, (err)=>{ if(err) next(); });
});

server.listen(PORT, ()=> console.log(`✅ Server on ${PORT}`));

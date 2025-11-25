'use strict';

/**
 * server.js — Hide To Survive
 * - Full backend: gameplay, persistence, Stripe Checkout (optional), webhook, admin
 * - CORS enabled so front-end fetch() calls won't be blocked
 *
 * Env vars:
 * ADMIN_TOKEN
 * STRIPE_SECRET_KEY (optional)
 * STRIPE_WEBHOOK_SECRET (optional)
 * PRICE_ID_NAME / PRICE_ID_CURRENCY_500 / PRICE_ID_CURRENCY_1200 / PRICE_ID_SEASON / PRICE_ID_COSMETIC_BUNDLE (optional)
 * DATA_FILE (optional)
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs').promises;
const path = require('path');

let Stripe = null;
try { Stripe = require('stripe'); } catch (e) { /* optional */ }

const app = express();

// CORS middleware (allows any origin; restrict in production to your domain)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); // change to your origin for production
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json());
app.disable('x-powered-by');

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST'] }
});

const PORT = process.env.PORT || 3000;

// CONFIG
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const RESERVED_NAMES_CSV = process.env.RESERVED_NAMES || 'admin,moderator,staff,survive,survive.com';
const RESERVED_NAMES = RESERVED_NAMES_CSV.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const DATA_FILE = process.env.DATA_FILE || path.resolve(__dirname, 'persist.json');

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const PRICE_ID_NAME = process.env.PRICE_ID_NAME || '';
const PRICE_ID_CURRENCY_500 = process.env.PRICE_ID_CURRENCY_500 || '';
const PRICE_ID_CURRENCY_1200 = process.env.PRICE_ID_CURRENCY_1200 || '';
const PRICE_ID_SEASON = process.env.PRICE_ID_SEASON || '';
const PRICE_ID_COSMETIC_BUNDLE = process.env.PRICE_ID_COSMETIC_BUNDLE || '';

const stripe = (Stripe && STRIPE_SECRET_KEY) ? Stripe(STRIPE_SECRET_KEY) : null;

// GAME CONSTANTS
const TICK_RATE = 50;
const ROOM_MAX_PLAYERS = 16;
const MAP_WIDTH = 2200;
const MAP_HEIGHT = 2200;
const PLAYER_SPEED = 3.1;
const BOT_SPEED = 2.8;
const HIDE_TIME = 15000;
const ROUND_TIME = 120000;
const SCORE_TAG = 50;
const SCORE_SURVIVE = 100;
const SCORE_CAUGHT_PENALTY = 20;
const SCORE_FULL_WIPE_BONUS = 75;
const SHOOT_RADIUS = 80;
const TRANQ_DURATION = 8000;
const TRANQ_SLOW_MULT = 0.35;
const SERUM_PICKUP_RADIUS = 45;
const SERUM_PER_ROUND = 4;

// In-memory & persisted store
const rooms = {};
let store = { purchased: {}, accounts: {} };

// PERSISTENCE
async function loadStore() {
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    store = JSON.parse(raw) || { purchased: {}, accounts: {} };
    console.log(`Loaded store from ${DATA_FILE}`);
  } catch (err) {
    if (err.code === 'ENOENT') {
      store = { purchased: {}, accounts: {} };
      console.log('No persist file found; starting fresh store.');
    } else {
      console.error('Error loading store:', err);
      store = { purchased: {}, accounts: {} };
    }
  }
}

async function saveStore() {
  try {
    await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
    await fs.writeFile(DATA_FILE, JSON.stringify(store, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving store:', err);
  }
}

// HELPERS
function nowMs() { return Date.now(); }
function clamp(v,a,b){ return Math.max(a, Math.min(b, v)); }
function randomPosition(){ return { x: Math.random() * MAP_WIDTH, y: Math.random() * MAP_HEIGHT }; }
function isValidNumber(n){ return typeof n === 'number' && Number.isFinite(n) && !Number.isNaN(n); }
function dist(a,b){ const dx=a.x-b.x, dy=a.y-b.y; return Math.sqrt(dx*dx+dy*dy); }
function sanitizeRequestedName(raw){ if(!raw||typeof raw!=='string') return 'Player'; let s=raw.trim().replace(/[\r\n]+/g,''); if(s.length>30) s=s.slice(0,30); return s||'Player'; }
function generateSuffix(){ return ('000' + Math.floor(Math.random()*10000)).slice(-4); }
function ensureHashSuffix(name){ if(name.includes('#')){ const parts=name.split('#'); const base=parts[0].trim()||'Player'; const suffix=parts.slice(1).join('#').trim()||generateSuffix(); return `${base}#${suffix}`; } else return `${name}#${generateSuffix()}`; }
function nameBase(name){ return (typeof name==='string' ? name.split('#')[0].trim().toLowerCase() : '').slice(0,30); }
function isReservedBase(base){ return RESERVED_NAMES.includes(base.toLowerCase()); }
function isPurchased(base){ if(!base) return false; return !!store.purchased[base.toLowerCase()]; }
function makeUniqueNameInRoom(room, desiredName){
  let final = desiredName;
  const taken = new Set(Object.values(room.players).map(p=>(p.name||'').toLowerCase()));
  let tries=0;
  while(taken.has(final.toLowerCase()) && tries<8){
    const suf=generateSuffix(); const base=final.split('#')[0]||'Player'; final=`${base}#${suf}`; tries++;
  }
  if(taken.has(final.toLowerCase())) final = `${final.split('#')[0]}#${uuidv4().slice(0,4)}`;
  return final;
}
function isSingleWordLetters(base){ if(!base||typeof base!=='string') return false; return /^[A-Za-z]{2,30}$/.test(base); }

// ACCOUNT HELPERS
function getOrCreateAccount(playerName) {
  const key = playerName.trim().toLowerCase();
  if (!store.accounts[key]) store.accounts[key] = { playerName, currency: 0, cosmetics: [], seasonPass: false };
  return store.accounts[key];
}
async function grantPurchasedName(base, owner) {
  const key = base.toLowerCase();
  store.purchased[key] = { owner: owner || 'admin', grantedAt: Date.now() };
  await saveStore();
}
async function grantCurrencyForOwner(ownerName, amount) {
  if (!ownerName) return;
  const acc = getOrCreateAccount(ownerName);
  acc.currency = (acc.currency || 0) + Number(amount || 0);
  await saveStore();
}
async function grantSeasonPassToOwner(ownerName) {
  if (!ownerName) return;
  const acc = getOrCreateAccount(ownerName);
  acc.seasonPass = true;
  await saveStore();
}
async function grantCosmeticToOwner(ownerName, cosmeticId) {
  if (!ownerName) return;
  const acc = getOrCreateAccount(ownerName);
  acc.cosmetics = acc.cosmetics || [];
  if (!acc.cosmetics.includes(cosmeticId)) acc.cosmetics.push(cosmeticId);
  await saveStore();
}

// ROOM MANAGEMENT & GAME LOGIC (complete)

// Create room
function createRoom(roomId, config = {}) {
  rooms[roomId] = {
    id: roomId,
    players: {},
    bots: [],
    state: "waiting",
    seekerId: null,
    roundStartTime: null,
    hideEndTime: null,
    finishTime: null,
    map: { width: MAP_WIDTH, height: MAP_HEIGHT },
    createdAt: Date.now(),
    config: {
      botCount: typeof config.botCount === "number" ? clamp(config.botCount, 0, 16) : 4,
      maxPlayers: ROOM_MAX_PLAYERS,
      swapOnTag: config.swapOnTag !== undefined ? !!config.swapOnTag : true,
      swapCooldownMs: typeof config.swapCooldownMs === 'number' ? config.swapCooldownMs : 2000
    },
    scores: {},
    roundIndex: 0,
    powerups: [],
    lastSwapAt: 0
  };
  console.log(`Created room ${roomId} (bots=${rooms[roomId].config.botCount})`);
}

function getOrCreatePlayerStats(room, id, name) {
  if (!room.scores[id]) room.scores[id] = { id, name: name || "Player", score:0, tags:0, survived:0, games:0 };
  else if (name && room.scores[id].name !== name) room.scores[id].name = name;
  return room.scores[id];
}

// Game loop
setInterval(() => {
  const now = Date.now();
  Object.values(rooms).forEach(room => {
    const playerCount = Object.keys(room.players).length;
    const botCount = room.bots.length;
    if (playerCount === 0 && botCount === 0) {
      if (now - room.createdAt > 30 * 60 * 1000) delete rooms[room.id];
      return;
    }
    try {
      handleRoomState(room, now);
      updateStatusAndSerums(room, now);
      Object.values(room.players).forEach(p => applyInput(p, now));
      updateBots(room, now);
      handleTagging(room);
      const snapshot = buildSnapshot(room);
      io.to(room.id).emit("stateUpdate", snapshot);
    } catch (err) { console.error('Game loop error for room', room.id, err); }
  });
}, TICK_RATE);

// State machine helpers
function handleRoomState(room, now) {
  const playerCount = Object.keys(room.players).length;
  if (playerCount === 0) {
    room.state = "waiting"; room.seekerId=null; room.roundStartTime=null; room.hideEndTime=null; room.finishTime=null; return;
  }
  switch(room.state) {
    case "waiting": startNewRound(room, now); break;
    case "hiding": if (now >= room.hideEndTime) { room.state = "seeking"; room.roundStartTime = now; } break;
    case "seeking": {
      const timeUp = now >= (room.roundStartTime || 0) + ROUND_TIME;
      const anyHider = hasAnyHider(room);
      if (timeUp || !anyHider) {
        if (room.state !== "finished") finishRound(room, now, !anyHider ? "all_caught" : "time_up");
      }
      break;
    }
    case "finished": if (!room.finishTime) room.finishTime = now; if (now - room.finishTime > 8000) startNewRound(room, now); break;
  }
}

function startNewRound(room, now) {
  room.state = "hiding";
  room.roundStartTime = null;
  room.hideEndTime = now + HIDE_TIME;
  room.finishTime = null;
  room.roundIndex++;

  Object.values(room.players).forEach(p => {
    const pos = randomPosition(); p.x=pos.x; p.y=pos.y; p.vx=0; p.vy=0; p.caught=false; p.role='hider'; p.tranqUntil=0;
    const stats = getOrCreatePlayerStats(room, p.id, p.name); stats.games += 1;
  });

  const desiredBots = Math.max(0, Math.min(16, room.config.botCount || 0));
  while (room.bots.length < desiredBots) {
    const id = 'bot-' + uuidv4(); const pos = randomPosition();
    room.bots.push({ id, name:'Bot '+id.slice(0,4), x:pos.x, y:pos.y, vx:0, vy:0, caught:false, role:'hider', wanderAngle:Math.random()*Math.PI*2, tranqUntil:0 });
  }
  if (room.bots.length > desiredBots) room.bots.length = desiredBots;
  room.bots.forEach(b => { const pos = randomPosition(); b.x=pos.x; b.y=pos.y; b.vx=0; b.vy=0; b.caught=false; b.role='hider'; b.wanderAngle=Math.random()*Math.PI*2; b.tranqUntil=0; });

  const playersCandidates = Object.values(room.players).map(p => ({ type:'player', id:p.id, priority: p.nextSeeker ? 1 : 0 }));
  const botsCandidates = room.bots.map(b => ({ type:'bot', id:b.id, priority:0 }));
  const candidates = [...playersCandidates, ...botsCandidates].sort((a,b)=>(b.priority||0)-(a.priority||0));
  const chosen = candidates[Math.floor(Math.random()*candidates.length)];
  room.seekerId = chosen.id;

  Object.values(room.players).forEach(p => { p.role = p.id === room.seekerId ? 'seeker' : 'hider'; p.caught=false; p.tranqUntil=0; });
  room.bots.forEach(b => { b.role = b.id === room.seekerId ? 'seeker' : 'hider'; b.caught=false; b.tranqUntil=0; });

  room.powerups = [];
  for (let i=0;i<SERUM_PER_ROUND;i++) { const pos=randomPosition(); room.powerups.push({ id:'serum-'+uuidv4(), x:pos.x, y:pos.y, type:'wake-serum' }); }

  io.to(room.id).emit('roundStarted', { seekerId: room.seekerId, hideTime: HIDE_TIME, roundIndex: room.roundIndex });
  console.log(`Room ${room.id} round ${room.roundIndex} started; seeker ${room.seekerId}`);
}

function hasAnyHider(room) {
  const p = Object.values(room.players).some(p => p.role==='hider' && !p.caught);
  const b = room.bots.some(b => b.role==='hider' && !b.caught);
  return p || b;
}

function finishRound(room, now, reason) {
  room.state = 'finished'; room.finishTime = now;
  const seeker = getSeeker(room);
  Object.values(room.players).forEach(p => {
    const stats = getOrCreatePlayerStats(room, p.id, p.name);
    if (p.role === 'hider' && !p.caught) { stats.score += SCORE_SURVIVE; stats.survived += 1; }
  });
  const anyHiderLeft = hasAnyHider(room);
  if (seeker && !anyHiderLeft) {
    const sStats = getOrCreatePlayerStats(room, seeker.id, seeker.name || 'Seeker'); sStats.score += SCORE_FULL_WIPE_BONUS;
  }
  io.to(room.id).emit('roundFinished', { reason });
}

// status + serums
function updateStatusAndSerums(room, now) {
  Object.values(room.players).forEach(p => { if (p.tranqUntil && p.tranqUntil <= now) p.tranqUntil = 0; });
  room.bots.forEach(b => { if (b.tranqUntil && b.tranqUntil <= now) b.tranqUntil = 0; });

  if (!room.powerups || !room.powerups.length) return;
  const remaining = [];
  room.powerups.forEach(pu => {
    if (pu.type !== 'wake-serum') { remaining.push(pu); return; }
    let picked = false;
    Object.values(room.players).forEach(p => { if (picked) return; const d = dist(p, pu); if (d <= SERUM_PICKUP_RADIUS) { p.tranqUntil = 0; picked = true; } });
    if (!picked) remaining.push(pu);
  });
  room.powerups = remaining;
}

// movement
function applyInput(p, now) {
  if (p.caught) return;
  let speed = PLAYER_SPEED;
  if (p.tranqUntil && p.tranqUntil > now) speed *= TRANQ_SLOW_MULT;
  let vx=0, vy=0;
  if (p.input && p.input.up) vy -= 1;
  if (p.input && p.input.down) vy += 1;
  if (p.input && p.input.left) vx -= 1;
  if (p.input && p.input.right) vx += 1;
  const len = Math.sqrt(vx*vx + vy*vy) || 1;
  vx = (vx/len)*speed; vy = (vy/len)*speed;
  p.x = Math.max(0, Math.min(MAP_WIDTH, p.x + vx));
  p.y = Math.max(0, Math.min(MAP_HEIGHT, p.y + vy));
}

// bots
function updateBots(room, now) {
  const seeker = getSeeker(room);
  const players = Object.values(room.players);
  room.bots.forEach(bot => {
    if (bot.caught) return;
    let speed = BOT_SPEED;
    if (bot.tranqUntil && bot.tranqUntil > now) speed *= TRANQ_SLOW_MULT;
    if (bot.role === 'hider') {
      let dx=0, dy=0;
      if (seeker) {
        const d = dist(bot, seeker);
        if (d < 400) { dx = bot.x - seeker.x; dy = bot.y - seeker.y; }
        else { if (Math.random()<0.02) bot.wanderAngle += Math.random()-0.5; dx=Math.cos(bot.wanderAngle); dy=Math.sin(bot.wanderAngle); }
      } else { if (Math.random()<0.03) bot.wanderAngle+=Math.random()-0.5; dx=Math.cos(bot.wanderAngle); dy=Math.sin(bot.wanderAngle); }
      const len = Math.sqrt(dx*dx + dy*dy) || 1;
      bot.x = Math.max(0, Math.min(MAP_WIDTH, bot.x + (dx/len)*speed));
      bot.y = Math.max(0, Math.min(MAP_HEIGHT, bot.y + (dy/len)*speed));
    } else if (bot.role === 'seeker') {
      const targets = [...players.filter(p => p.role==='hider' && !p.caught), ...room.bots.filter(b=>b.role==='hider' && !b.caught)];
      if (!targets.length) return;
      let closest=null, minD=Infinity;
      targets.forEach(t=>{ const d = dist(bot,t); if (d<minD){ minD=d; closest=t; }});
      if (closest) { const dx = closest.x - bot.x; const dy = closest.y - bot.y; const len = Math.sqrt(dx*dx + dy*dy) || 1; bot.x = Math.max(0, Math.min(MAP_WIDTH, bot.x + (dx/len)*speed)); bot.y = Math.max(0, Math.min(MAP_HEIGHT, bot.y + (dy/len)*speed)); }
    }
  });
}

function getSeeker(room) {
  const fromPlayers = Object.values(room.players).find(p => p.id === room.seekerId);
  if (fromPlayers) return fromPlayers;
  return room.bots.find(b => b.id === room.seekerId) || null;
}

// tagging
function handleTagging(room) {
  const seeker = getSeeker(room);
  if (!seeker) return;
  const TAG_RADIUS = 40;
  Object.values(room.players).forEach(p => {
    if (p.role === 'hider' && !p.caught && dist(seeker, p) < TAG_RADIUS) {
      catchHider(room, seeker, p);
    }
  });
  room.bots.forEach(b => { if (b.role === 'hider' && !b.caught && dist(seeker,b) < TAG_RADIUS) catchBot(room, seeker, b); });
}

function catchHider(room, seeker, hider) {
  if (hider.caught) return;
  const now = Date.now();
  const cfg = room.config || {};
  const canSwap = !!cfg.swapOnTag;
  const cooldown = typeof cfg.swapCooldownMs === 'number' ? cfg.swapCooldownMs : 2000;
  const sinceLastSwap = now - (room.lastSwapAt || 0);
  if (canSwap && sinceLastSwap >= cooldown) {
    room.lastSwapAt = now;
    room.seekerId = hider.id;
    Object.values(room.players).forEach(p => { p.role = p.id === room.seekerId ? 'seeker' : 'hider'; if (p.id === room.seekerId) { p.caught = false; p.tranqUntil = 0; } });
    room.bots.forEach(b => { b.role = b.id === room.seekerId ? 'seeker' : 'hider'; if (b.id === room.seekerId) { b.caught = false; b.tranqUntil = 0; } });
    const sStats = getOrCreatePlayerStats(room, seeker.id, seeker.name || 'Seeker'); sStats.score += SCORE_TAG; sStats.tags += 1;
    const hStats = getOrCreatePlayerStats(room, hider.id, hider.name); hStats.score -= SCORE_CAUGHT_PENALTY;
    io.to(room.id).emit('seekerSwapped', { newSeekerId: room.seekerId, by: seeker.id });
    console.log(`Room ${room.id}: seeker swapped to ${room.seekerId} (by ${seeker.id})`);
    return;
  }
  hider.caught = true; hider.tranqUntil = 0;
  const sStats = getOrCreatePlayerStats(room, seeker.id, seeker.name || 'Seeker'); sStats.score += SCORE_TAG; sStats.tags += 1;
  const hStats = getOrCreatePlayerStats(room, hider.id, hider.name); hStats.score -= SCORE_CAUGHT_PENALTY;
  io.to(room.id).emit('playerTagged', { id: hider.id, by: seeker.id });
}

function catchBot(room, seeker, bot) {
  if (bot.caught) return;
  bot.caught = true; bot.tranqUntil = 0;
  const sStats = getOrCreatePlayerStats(room, seeker.id, seeker.name || 'Seeker'); sStats.score += SCORE_TAG; sStats.tags += 1;
  io.to(room.id).emit('botTagged', { id: bot.id, by: seeker.id });
}

// shooting
function handleShot(room, shooterId, shotX, shotY) {
  if (!isValidNumber(shotX) || !isValidNumber(shotY)) { console.warn('Invalid shot coords', shooterId, shotX, shotY); return; }
  const seeker = getSeeker(room);
  if (!seeker || seeker.id !== shooterId) return;
  if (room.state !== 'seeking') return;
  const impact = { x: shotX, y: shotY };
  let closestHider=null, closestD=Infinity;
  Object.values(room.players).forEach(p => { if (p.role==='hider' && !p.caught) { const d = dist(impact,p); if (d < closestD) { closestD = d; closestHider = p; } } });
  let closestBot=null, closestBotD=Infinity;
  room.bots.forEach(b => { if (b.role==='hider' && !b.caught) { const d = dist(impact,b); if (d < closestBotD) { closestBotD = d; closestBot = b; } } });
  let target=null, isBot=false;
  if (closestHider && closestD <= SHOOT_RADIUS) target = closestHider;
  if (closestBot && closestBotD <= SHOOT_RADIUS && closestBotD < closestD) { target = closestBot; isBot = true; }
  if (target) {
    const now = Date.now();
    if (!target.tranqUntil || target.tranqUntil <= now) {
      target.tranqUntil = now + TRANQ_DURATION;
      io.to(room.id).emit('tranqApplied', { id: target.id, isBot, duration: TRANQ_DURATION });
    } else {
      if (isBot) catchBot(room, seeker, target);
      else catchHider(room, seeker, target);
    }
  }
  io.to(room.id).emit('shotFired', { shooterId, x: shotX, y: shotY });
}

// snapshot
function buildSnapshot(room) {
  const leaderboard = Object.values(room.scores).sort((a,b)=>b.score-a.score).slice(0,10);
  return {
    state: room.state,
    seekerId: room.seekerId,
    players: Object.values(room.players).map(p=>({ id:p.id, name:p.name, x:p.x, y:p.y, role:p.role, caught:p.caught, tranq: !!(p.tranqUntil && p.tranqUntil > Date.now()) })),
    bots: room.bots.map(b=>({ id:b.id, name:b.name, x:b.x, y:b.y, role:b.role, caught:b.caught, tranq: !!(b.tranqUntil && b.tranqUntil > Date.now()) })),
    map: room.map,
    hideTimeRemaining: room.state === 'hiding' ? Math.max(0, room.hideEndTime - Date.now()) : 0,
    roundTimeRemaining: room.state === 'seeking' && room.roundStartTime ? Math.max(0, room.roundStartTime + ROUND_TIME - Date.now()) : 0,
    leaderboard,
    roundIndex: room.roundIndex,
    powerups: (room.powerups || []).map(p => ({ id:p.id, x:p.x, y:p.y, type:p.type }))
  };
}

// SOCKET handlers implemented above

// HTTP endpoints
app.get('/name-available', (req, res) => {
  const baseRaw = req.query.base;
  if (!baseRaw || typeof baseRaw !== 'string') return res.status(400).json({ ok:false, error:'Missing base param' });
  const base = baseRaw.trim().split('#')[0].toLowerCase();
  const reserved = isReservedBase(base);
  const purchased = isPurchased(base);
  res.json({ ok:true, base, reserved, purchased });
});

app.get('/account', (req, res) => {
  const playerName = (req.query.playerName || '').trim();
  if (!playerName) return res.status(400).json({ ok:false, error:'Missing playerName' });
  const acc = store.accounts[playerName.toLowerCase()] || { playerName, currency:0, cosmetics:[], seasonPass:false };
  res.json({ ok:true, account: acc });
});

app.post('/create-checkout-session', async (req, res) => {
  try {
    const body = req.body || {};
    const successUrl = body.successUrl || `${req.headers.origin || ''}/`;
    const cancelUrl = body.cancelUrl || `${req.headers.origin || ''}/`;
    const playerId = body.playerId || '';
    const playerName = body.playerName || '';
    const itemType = body.itemType || '';
    const itemData = body.itemData || {};

    function priceIdForItemType(it) {
      if (it === 'name') return PRICE_ID_NAME || '';
      if (it === 'currency_500') return PRICE_ID_CURRENCY_500 || '';
      if (it === 'currency_1200') return PRICE_ID_CURRENCY_1200 || '';
      if (it === 'season') return PRICE_ID_SEASON || '';
      if (it === 'cosmetic') return PRICE_ID_COSMETIC_BUNDLE || '';
      return '';
    }

    const priceId = priceIdForItemType(itemType);
    if (stripe && STRIPE_SECRET_KEY && priceId) {
      const metadata = { playerId, playerName, itemType, itemData: JSON.stringify(itemData) };
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        mode: 'payment',
        line_items: [{ price: priceId, quantity: 1 }],
        metadata,
        success_url: successUrl,
        cancel_url: cancelUrl
      });
      return res.json({ ok:true, checkoutUrl: session.url });
    }

    // simulate grant if stripe not configured
    console.log('Simulated purchase (stripe not configured):', itemType, itemData, 'for', playerName || playerId);
    if (itemType === 'name') {
      const base = (itemData.base || '').trim();
      if (!base) return res.status(400).json({ ok:false, error:'Missing base' });
      await grantPurchasedName(base, playerName || 'simulated');
      if (playerId && io.sockets.sockets.get(playerId)) io.to(playerId).emit('purchaseGranted', { itemType:'name', base });
      return res.json({ ok:true, simulated:true, granted:'name', base });
    } else if (itemType === 'currency_500' || itemType === 'currency_1200') {
      const amount = itemType === 'currency_500' ? 500 : 1200;
      await grantCurrencyForOwner(playerName || 'simulated', amount);
      if (playerId && io.sockets.sockets.get(playerId)) io.to(playerId).emit('purchaseGranted', { itemType:'currency', amount });
      return res.json({ ok:true, simulated:true, granted:'currency', amount });
    } else if (itemType === 'season') {
      await grantSeasonPassToOwner(playerName || 'simulated');
      if (playerId && io.sockets.sockets.get(playerId)) io.to(playerId).emit('purchaseGranted', { itemType:'season' });
      return res.json({ ok:true, simulated:true, granted:'season' });
    } else if (itemType === 'cosmetic') {
      const cosmeticId = itemData.cosmeticId || 'bundle1';
      await grantCosmeticToOwner(playerName || 'simulated', cosmeticId);
      if (playerId && io.sockets.sockets.get(playerId)) io.to(playerId).emit('purchaseGranted', { itemType:'cosmetic', cosmeticId });
      return res.json({ ok:true, simulated:true, granted:'cosmetic', cosmeticId });
    } else {
      return res.json({ ok:true, simulated:true, message:'no-op' });
    }
  } catch (err) {
    console.error('/create-checkout-session error:', err);
    return res.status(500).json({ ok:false, error:'Server error' });
  }
});

// Webhook route: verify signature if STRIPE_WEBHOOK_SECRET set
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) {
    return res.status(400).send('Stripe not configured for webhook');
  }
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const metadata = session.metadata || {};
    const playerId = metadata.playerId || '';
    const playerName = metadata.playerName || '';
    const itemType = metadata.itemType || '';
    const itemData = metadata.itemData ? JSON.parse(metadata.itemData) : {};

    (async () => {
      try {
        if (itemType === 'name') {
          const base = (itemData.base || '').trim();
          if (base) {
            await grantPurchasedName(base, playerName || 'stripe');
            if (playerId && io.sockets.sockets.get(playerId)) io.to(playerId).emit('purchaseGranted', { itemType:'name', base });
            console.log(`Granted purchased name ${base} (stripe) to ${playerName || playerId}`);
          }
        } else if (itemType === 'currency_500' || itemType === 'currency_1200') {
          const amount = itemType === 'currency_500' ? 500 : 1200;
          await grantCurrencyForOwner(playerName || session.customer_email || 'stripe', amount);
          if (playerId && io.sockets.sockets.get(playerId)) io.to(playerId).emit('purchaseGranted', { itemType:'currency', amount });
        } else if (itemType === 'season') {
          await grantSeasonPassToOwner(playerName || session.customer_email || 'stripe');
          if (playerId && io.sockets.sockets.get(playerId)) io.to(playerId).emit('purchaseGranted', { itemType:'season' });
        } else if (itemType === 'cosmetic') {
          const cosmeticId = itemData.cosmeticId || 'bundle1';
          await grantCosmeticToOwner(playerName || session.customer_email || 'stripe', cosmeticId);
          if (playerId && io.sockets.sockets.get(playerId)) io.to(playerId).emit('purchaseGranted', { itemType:'cosmetic', cosmeticId });
        }
      } catch (err) { console.error('Error fulfilling purchase in webhook', err); }
    })();
  }

  res.json({ received: true });
});

// Admin endpoints (grant/revoke/list)
function checkAdminToken(req, res) {
  const token = (req.headers['x-admin-token'] || '').trim();
  if (!ADMIN_TOKEN) { res.status(403).json({ ok:false, error: 'Admin token not configured.' }); return false; }
  if (!token || token !== ADMIN_TOKEN) { res.status(401).json({ ok:false, error:'Invalid admin token' }); return false; }
  return true;
}

app.post('/admin/grant-name', async (req, res) => {
  try {
    if (!checkAdminToken(req, res)) return;
    const baseRaw = req.body && typeof req.body.base === 'string' ? req.body.base.trim() : null;
    if (!baseRaw) return res.status(400).json({ ok:false, error:'Missing base' });
    const base = baseRaw.split('#')[0].trim().toLowerCase();
    const owner = req.body.owner ? String(req.body.owner).trim() : 'admin-grant';
    store.purchased[base] = { owner, grantedAt: Date.now() };
    await saveStore();
    console.log(`Admin granted name: ${base} -> ${owner}`);
    return res.json({ ok:true, base, owner });
  } catch (err) { console.error(err); res.status(500).json({ ok:false, error:'Server error' }); }
});

app.post('/admin/revoke-name', async (req, res) => {
  try {
    if (!checkAdminToken(req, res)) return;
    const baseRaw = req.body && typeof req.body.base === 'string' ? req.body.base.trim() : null;
    if (!baseRaw) return res.status(400).json({ ok:false, error:'Missing base' });
    const base = baseRaw.split('#')[0].trim().toLowerCase();
    if (store.purchased[base]) { delete store.purchased[base]; await saveStore(); console.log(`Admin revoked purchased name: ${base}`); return res.json({ ok:true, base }); }
    else return res.status(404).json({ ok:false, error:'Not found' });
  } catch (err) { console.error(err); res.status(500).json({ ok:false, error:'Server error' }); }
});

app.get('/admin/purchased-names', (req, res) => {
  try { if (!checkAdminToken(req, res)) return; res.json({ ok:true, purchased: store.purchased }); } catch (err) { console.error(err); res.status(500).json({ ok:false, error:'Server error' }); }
});

// START
server.listen(PORT, async () => {
  console.log(`Hide To Survive backend listening on port ${PORT}`);
  await loadStore();
});

process.on('uncaughtException', (err) => { console.error('Uncaught exception:', err); });
process.on('unhandledRejection', (reason,p) => { console.error('Unhandled Rejection at:', p, 'reason:', reason); });

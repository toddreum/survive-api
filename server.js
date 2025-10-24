// server.js
// Synced with your current frontend: serves /public, only monetization = Health Booster ($0.99),
// Stripe Checkout + webhook, optional CORS-safe fetch proxy, and solid security/perf defaults.

require('dotenv').config();

const express = require('express');
const path = require('path');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 8080;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:8080';

// --- Security + perf ---
app.enable('trust proxy');
app.use(helmet({
  contentSecurityPolicy: false, // keep off for now (embedded SVG/inline JS). Tighten later.
  crossOriginEmbedderPolicy: false,
}));
app.use(compression());
app.use(morgan(process.env.NODE_ENV === 'production' ? 'tiny' : 'dev'));
app.use(cors({
  origin: FRONTEND_URL,
  credentials: false,
}));

// JSON parsers (Stripe webhook uses raw later)
app.use('/api', express.json({ limit: '1mb' }));

// --- Rate limit the API + proxy ---
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(['/api', '/proxy'], apiLimiter);

// --- Static files ---
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (/\.(css|js|png|jpg|jpeg|gif|svg|webp|woff2?)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    } else {
      res.setHeader('Cache-Control', 'no-store');
    }
  }
}));

// --- Health check ---
app.get('/healthz', (_req, res) => {
  res.json({ ok: true, ts: Date.now(), env: process.env.NODE_ENV || 'dev' });
});

// --- Optional CORS-safe fetch proxy (DEV) ---
/*  Enable if you need it:
    - Set PROXY_ALLOWLIST=api.example.com,feedsite.com (hosts only)
    - Call: /proxy?url=https%3A%2F%2Fapi.example.com%2Fpath
*/
const useProxy = process.env.ENABLE_PROXY === '1';
if (useProxy) {
  const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
  const ALLOWLIST = (process.env.PROXY_ALLOWLIST || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const isAllowedHost = (u) => {
    try {
      const { hostname } = new URL(u);
      return !ALLOWLIST.length || ALLOWLIST.some(h => hostname === h || hostname.endsWith(`.${h}`));
    } catch { return false; }
  };
  app.get('/proxy', async (req, res) => {
    const target = req.query.url;
    if (!target) return res.status(400).json({ error: 'Missing url param' });
    if (!isAllowedHost(target)) return res.status(403).json({ error: 'Host not allowed' });
    try {
      const controller = new AbortController();
      const to = setTimeout(() => controller.abort(), 15000);
      const r = await fetch(target, {
        signal: controller.signal,
        redirect: 'follow',
        headers: { 'User-Agent': 'SurviveProxy/1.0', 'Accept': '*/*' }
      });
      clearTimeout(to);
      const ct = r.headers.get('content-type') || 'application/octet-stream';
      res.setHeader('Content-Type', ct);
      res.setHeader('Cache-Control', 'no-store');
      if (!r.ok) return res.status(r.status).send(await r.text().catch(() => ''));
      r.body.pipe(res);
    } catch (e) {
      res.status(/aborted/i.test(String(e)) ? 504 : 502).json({ error: 'Proxy failed', detail: String(e) });
    }
  });
}

// --- Stripe Checkout (only Health Booster) ---
/*
  ENV you must set:
    STRIPE_SECRET_KEY       = sk_live_... or sk_test_...
    STRIPE_PRICE_HEALTH_BOOST= price_*** (for $0.99)
    STRIPE_WEBHOOK_SECRET   = whsec_***
    FRONTEND_URL            = https://survive.com (or your dev URL)
*/
let stripe;
if (process.env.STRIPE_SECRET_KEY) {
  stripe = require('stripe')(process.env.STRIPE_SECRET_KEY, {
    apiVersion: '2023-10-16',
    appInfo: { name: 'Survive.com', version: '1.0.0' },
  });
}

// Create a checkout session for +2 HP purchase
app.post('/api/buy_health', async (req, res) => {
  try {
    if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });
    const { playerId = 'anon', roomCode = 'practice' } = req.body || {};
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: process.env.STRIPE_PRICE_HEALTH_BOOST, quantity: 1 }],
      success_url: `${FRONTEND_URL}/?purchase=success`,
      cancel_url: `${FRONTEND_URL}/?purchase=cancel`,
      metadata: {
        type: 'HEALTH_BOOST',
        playerId,
        roomCode,
      }
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('buy_health error:', err);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// Stripe webhook (grants +2 HP after payment completes)
const rawBody = express.raw({ type: 'application/json' });
app.post('/webhook', rawBody, (req, res) => {
  if (!stripe) return res.status(503).end();
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.warn('⚠️  Webhook signature verify failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle success
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const meta = session.metadata || {};
    // Here you’d apply +2 HP to the player in your room/game state and notify clients (e.g., via Socket.IO).
    // For now we just log so your MVP can verify the webhook pipeline is working.
    console.log('✅ Health Boost granted:', {
      playerId: meta.playerId,
      roomCode: meta.roomCode,
      amount_total: session.amount_total,
      currency: session.currency,
    });
  }

  res.json({ received: true });
});

// --- SPA fallback (optional) ---
// If you’re using an index.html appshell:
app.get('*', (req, res, next) => {
  const file = path.join(__dirname, 'public', 'index.html');
  res.sendFile(file, (err) => { if (err) next(); });
});

// --- Error handler ---
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Server error' });
});

app.listen(PORT, () => {
  console.log(`✅ Server running on ${PORT} (${FRONTEND_URL})`);
});

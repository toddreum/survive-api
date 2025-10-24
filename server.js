// server.js
require('dotenv').config();
const express = require('express');
const path = require('path');
const morgan = require('morgan');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const app = express();
const PORT = process.env.PORT || 8080;

// --- Basic security & perf ---
app.enable('trust proxy');
app.use(helmet({
  contentSecurityPolicy: false, // keep off if you rely on 3rd-party iframes; tighten later
}));
app.use(compression());
app.use(morgan('tiny'));

// --- Rate limiting on proxy routes ---
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/proxy', limiter);

// --- Static site ---
// Put your files (including gem.fixed.txt → rename to gem.txt if needed) in ./public
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (/\.(css|js|png|jpg|jpeg|gif|svg|webp|woff2?)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    } else {
      res.setHeader('Cache-Control', 'no-store');
    }
  }
}));

// --- Simple health check ---
app.get('/healthz', (_req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// --- CORS-safe fetch proxy ---
// Usage: /proxy?url=https%3A%2F%2Fexample.com%2Frss
// NOTE: Tighten allowlist as needed.
const ALLOWLIST = (process.env.PROXY_ALLOWLIST || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// quick host checker
const isAllowedHost = (targetUrl) => {
  try {
    const u = new URL(targetUrl);
    if (!ALLOWLIST.length) return true; // if you don't set allowlist, allow all (dev mode)
    return ALLOWLIST.some(h => u.hostname.endsWith(h));
  } catch {
    return false;
  }
};

app.get('/proxy', async (req, res) => {
  try {
    const target = req.query.url;
    if (!target) {
      return res.status(400).json({ error: 'Missing url param' });
    }
    if (!isAllowedHost(target)) {
      return res.status(403).json({ error: 'Host not allowed by proxy allowlist' });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const upstream = await fetch(target, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; DudeBot/1.0; +https://www.dude.com)',
        'Accept': '*/*',
      },
    });
    clearTimeout(timeout);

    // Pass through content-type
    const ct = upstream.headers.get('content-type') || 'application/octet-stream';
    res.setHeader('Content-Type', ct);
    res.setHeader('Cache-Control', 'no-store');

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      return res.status(upstream.status).send(text || `Upstream error: ${upstream.status}`);
    }

    // Stream the body
    upstream.body.pipe(res);
  } catch (err) {
    if (err && err.name === 'AbortError') {
      return res.status(504).json({ error: 'Proxy timeout' });
    }
    res.status(502).json({ error: 'Proxy failed', detail: String(err && err.message || err) });
  }
});

// --- SPA fallback (optional) ---
// If you have an index.html you want to always serve:
app.get('*', (req, res, next) => {
  // serve index.html for unknown routes if you are using a single-page app
  const file = path.join(__dirname, 'public', 'index.html');
  res.sendFile(file, (err) => {
    if (err) next();
  });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

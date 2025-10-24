// server.js - lightweight Express server to serve public/ and proxy TTS to ElevenLabs
// Place this file at project root and public/ contains the client files.

const express = require('express');
const axios = require('axios');
const path = require('path');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve static client files from ./public
app.use(express.static(path.join(__dirname, 'public')));

// Health
app.get('/api/health', (req, res) => res.json({ ok: true, env: process.env.NODE_ENV || 'development' }));

// POST /api/tts proxy
app.post('/api/tts', async (req, res) => {
  const { text, voice = 'alloy' } = req.body || {};
  if (!text || typeof text !== 'string') return res.status(400).json({ error: 'text required' });

  const ELEVEN_KEY = process.env.ELEVEN_API_KEY;
  if (!ELEVEN_KEY) return res.status(500).json({ error: 'ELEVEN_API_KEY not configured' });

  try {
    // ElevenLabs streaming TTS endpoint (verify with docs for exact path/version)
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}/stream`;
    const response = await axios.post(url, { text }, {
      headers: { 'xi-api-key': ELEVEN_KEY, 'Content-Type': 'application/json' },
      responseType: 'arraybuffer',
      timeout: 30000
    });
    const contentType = response.headers['content-type'] || 'audio/mpeg';
    res.setHeader('Content-Type', contentType);
    res.send(Buffer.from(response.data));
  } catch (err) {
    console.error('TTS proxy error:', err?.response?.data || err.message || err);
    const status = err.response?.status || 502;
    res.status(status).json({ error: 'tts_proxy_failed', detail: err.response?.data || err.message || 'TTS proxy failed' });
  }
});

// Demo checkout (no real payment)
app.post('/api/checkout', async (req, res) => {
  const { qty } = req.body || {};
  if (!qty || qty < 1) return res.status(400).json({ error: 'qty required' });
  await new Promise(r => setTimeout(r, 700));
  res.json({ ok: true, applied: Math.min(10, qty), banked: Math.max(0, qty - Math.min(10, qty)) });
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Survive.com server listening on ${port} (NODE_ENV=${process.env.NODE_ENV || 'development'})`));

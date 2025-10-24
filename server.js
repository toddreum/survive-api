// server.js - lightweight Express server serving static client and proxying TTS (ElevenLabs)
// Place client files under ./public
const express = require('express');
const axios = require('axios');
const path = require('path');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({limit:'1mb'}));
app.use(express.urlencoded({extended:true}));
app.use(express.static(path.join(__dirname, 'public')));

// Health
app.get('/api/health', (req, res) => res.json({ ok: true, env: process.env.NODE_ENV || 'development' }));

// POST /api/tts - proxy ElevenLabs text-to-speech (server-side key)
app.post('/api/tts', async (req, res) => {
  const { text, voice = 'alloy' } = req.body || {};
  if(!text || typeof text !== 'string') return res.status(400).json({ error: 'text required' });

  const XI_KEY = process.env.ELEVEN_API_KEY;
  if(!XI_KEY) return res.status(500).json({ error: 'ELEVEN_API_KEY not configured' });

  try {
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}/stream`;
    const r = await axios.post(url, { text }, {
      headers: { 'xi-api-key': XI_KEY, 'Content-Type': 'application/json' },
      responseType: 'arraybuffer',
      timeout: 30000
    });
    const type = r.headers['content-type'] || 'audio/mpeg';
    res.setHeader('Content-Type', type);
    res.send(Buffer.from(r.data));
  } catch(err) {
    console.error('tts proxy error', err?.response?.data || err.message);
    res.status(502).json({ error: 'tts_proxy_failed', detail: err.message });
  }
});

// Demo checkout endpoint (no real payment)
app.post('/api/checkout', async (req, res) => {
  const { qty } = req.body || {};
  if(!qty || qty < 1) return res.status(400).json({ error: 'qty required' });
  await new Promise(r => setTimeout(r, 700));
  res.json({ ok:true, applied: Math.min(10, qty), banked: Math.max(0, qty - Math.min(10, qty)) });
});

// SPA fallback
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on http://localhost:${port}`));

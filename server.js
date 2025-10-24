// server.js - static server + TTS proxy
const express = require('express');
const axios = require('axios');
const path = require('path');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.post('/api/tts', async (req, res) => {
  const { text, voice = 'alloy' } = req.body || {};
  if (!text || typeof text !== 'string') return res.status(400).json({ error: 'text required' });

  const key = process.env.ELEVEN_API_KEY;
  if (!key) return res.status(500).json({ error: 'ELEVEN_API_KEY not configured' });

  try {
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}/stream`;
    const r = await axios.post(url, { text }, {
      headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
      responseType: 'arraybuffer',
      timeout: 30000
    });
    const contentType = r.headers['content-type'] || 'audio/mpeg';
    res.setHeader('Content-Type', contentType);
    res.send(Buffer.from(r.data));
  } catch (err) {
    console.error('TTS error', err?.response?.data || err.message || err);
    const status = err.response?.status || 502;
    res.status(status).json({ error: 'tts_failed', detail: err.response?.data || err.message || 'TTS proxy failed' });
  }
});

app.post('/api/checkout', async (req, res) => {
  const { qty } = req.body || {};
  if (!qty || qty < 1) return res.status(400).json({ error: 'qty required' });
  await new Promise(r => setTimeout(r, 600));
  res.json({ ok: true, applied: Math.min(10, qty), banked: Math.max(0, qty - Math.min(10, qty)) });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server listening on ${port}`));

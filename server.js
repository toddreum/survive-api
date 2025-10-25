/**
 * Basic server to serve static files and proxy ElevenLabs TTS.
 * Usage:
 *   npm i express node-fetch dotenv
 *   ELEVENLABS_API_KEY=sk_xxx ELEVENLABS_VOICE=sflYrWiXii4ezPjNLQkp node server.js
 */
import express from 'express';
import fetch from 'node-fetch';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app = express();
app.use(express.json({ limit:'2mb' }));

// Static
app.use(express.static(__dirname));

// TTS proxy
app.post('/api/tts', async (req, res) => {
  try{
    const apiKey  = process.env.ELEVENLABS_API_KEY;
    const voiceId = process.env.ELEVENLABS_VOICE || 'sflYrWiXii4ezPjNLQkp';
    if (!apiKey) return res.status(500).json({error:'Missing ELEVENLABS_API_KEY'});

    const text = (req.body?.text || '').slice(0, 5000);
    if (!text) return res.status(400).json({error:'Missing text'});

    const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`;
    const r = await fetch(url, {
      method:'POST',
      headers:{
        'xi-api-key': apiKey,
        'Content-Type':'application/json'
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: { stability:0.5, similarity_boost:0.75 }
      })
    });

    if (!r.ok) {
      const t = await r.text();
      return res.status(500).json({error:'TTS failed', details:t});
    }

    res.setHeader('Content-Type','audio/mpeg');
    r.body.pipe(res);
  }catch(err){
    res.status(500).json({error:'Server error', details:String(err)});
  }
});

// Fallback to index
app.get('*', (_, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 5173;
app.listen(PORT, () => {
  console.log(`Server running http://localhost:${PORT}`);
});

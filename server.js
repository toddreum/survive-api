/**
 * server.js — Express server with static hosting, TTS proxy for ElevenLabs,
 * and a tiny helper endpoint. Requires:
 *   - Node 18+
 *   - npm i express cors node-fetch
 *
 * ENV:
 *   ELEVENLABS_API_KEY=sk_...
 *   PORT=3000
 */

import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// ----- Static files (serve your index.html, app.js, styles.css, assets) -----
app.use(express.static(path.join(__dirname, "public"))); 
// Put your index.html, app.js, styles.css into ./public

// ----- Health
app.get("/health", (_req, res) => res.json({ ok: true }));

// ----- Decide-first helper (not strictly needed, shown for reference)
app.get("/api/random-start", (_req, res) => {
  const n = 1 + Math.floor(Math.random() * 20);
  res.json({ n });
});

// ----- ElevenLabs TTS Proxy -----
// POST /api/tts?voice=VOICE_ID
app.post("/api/tts", async (req, res) => {
  try {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "ELEVENLABS_API_KEY missing" });
    }
    const voiceId = (req.query.voice || "").toString().trim();
    if (!voiceId) {
      return res.status(400).json({ error: "voice query param required" });
    }
    const { text } = req.body || {};
    if (!text || !text.trim()) {
      return res.status(400).json({ error: "text required" });
    }

    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(
      voiceId
    )}?optimize_streaming_latency=0&output_format=mp3_44100_128`;

    const r = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        "Accept": "audio/mpeg"
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_multilingual_v2",
        voice_settings: { stability: 0.4, similarity_boost: 0.8 }
      })
    });

    if (!r.ok) {
      const errText = await r.text();
      return res.status(502).json({ error: "TTS upstream failed", detail: errText });
    }

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    r.body.pipe(res);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "TTS proxy error" });
  }
});

// ----- Fallback to index.html for SPA routes (optional) -----
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

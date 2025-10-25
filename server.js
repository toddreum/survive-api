/**
 * Survive.com server — static hosting + ElevenLabs TTS proxy
 * Run:
 *   npm i
 *   ELEVENLABS_API_KEY=sk_... PORT=3000 npm run dev
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
app.use(express.json({ limit: "2mb" }));

// Static files
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h", etag: true }));

// Health
app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

/**
 * ElevenLabs TTS proxy
 * POST /api/tts?voice=<VOICE_ID>
 * body: { text: "..." }
 */
app.post("/api/tts", async (req, res) => {
  try {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "ELEVENLABS_API_KEY is not set." });

    const voiceId = (req.query.voice || "").toString().trim();
    const textRaw = (req.body?.text ?? "");
    const text = typeof textRaw === "string" ? textRaw.trim() : "";
    if (!voiceId) return res.status(400).json({ error: "voice query param required" });
    if (!text) return res.status(400).json({ error: "text required" });

    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?optimize_streaming_latency=0&output_format=mp3_44100_128`;

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
      const detail = await r.text();
      return res.status(502).json({ error: "Upstream TTS failed", detail });
    }

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    r.body.pipe(res);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Proxy error" });
  }
});

// SPA fallback
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Survive.com running at http://localhost:${PORT}`));

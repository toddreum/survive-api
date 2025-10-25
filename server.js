// Minimal, reliable server + optional ElevenLabs proxy
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

// Static
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h", etag: true }));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    ts: Date.now(),
    ttsConfigured: !!process.env.ELEVENLABS_API_KEY
  });
});

/**
 * POST /api/tts?voice=<VOICE_ID>
 * body: { text: "..." }
 * Works only if ELEVENLABS_API_KEY is set. Otherwise returns 503;
 * the client quietly falls back (no crashes).
 */
app.post("/api/tts", async (req, res) => {
  try {
    const key = process.env.ELEVENLABS_API_KEY;
    if (!key) return res.status(503).json({ error: "TTS disabled (no ELEVENLABS_API_KEY)" });

    const voiceId = String(req.query.voice || "").trim();
    const text = String(req.body?.text || "").trim();
    if (!voiceId) return res.status(400).json({ error: "voice required" });
    if (!text) return res.status(400).json({ error: "text required" });

    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?optimize_streaming_latency=0&output_format=mp3_44100_128`;
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": key,
        "Content-Type": "application/json",
        "Accept": "audio/mpeg"
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_multilingual_v2",
        voice_settings: { stability: 0.4, similarity_boost: 0.8 }
      })
    });

    if (!r.ok) return res.status(502).json({ error: "Upstream TTS failed", detail: await r.text() });

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    r.body.pipe(res);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "TTS proxy error" });
  }
});

// SPA fallback
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Survive.com running at http://localhost:${PORT}`));

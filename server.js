import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import url from "url";

const PORT = process.env.PORT || 3000;
const FRONTEND_URL = process.env.FRONTEND_URL || "https://survive.com";

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors({ origin: FRONTEND_URL, credentials: true }));
app.use(express.json());

// --- Load full dictionary ---
const wordsPath = path.join(__dirname, "data", "words5.txt");
let WORDS = [];
try {
  WORDS = fs
    .readFileSync(wordsPath, "utf8")
    .split(/\r?\n/)
    .map((w) => w.trim().toLowerCase())
    .filter((w) => w.length === 5 && /^[a-z]+$/.test(w));
  console.log("✅ Loaded", WORDS.length, "words");
} catch {
  console.warn("⚠️ Could not read data/words5.txt; using fallback words.");
  WORDS = ["apple", "zebra", "candy", "tiger", "eagle", "shark", "smile"];
}

// --- Keep track of recent words to avoid repeats ---
const recentWords = [];
const MAX_RECENT = 50;
function getUniqueWord() {
  let word;
  let tries = 0;
  do {
    word = WORDS[Math.floor(Math.random() * WORDS.length)];
    tries++;
  } while (recentWords.includes(word) && tries < 30);
  recentWords.push(word);
  if (recentWords.length > MAX_RECENT) recentWords.shift();
  return word;
}

// --- API routes ---
app.get("/api/health", (_, res) => res.json({ ok: true }));

app.get("/api/words5", (_, res) => res.json(WORDS));

app.get("/api/word5", (req, res) => {
  // choose unique word
  const w = getUniqueWord();
  res.json({ word: w });
});

// --- Leaderboard memory store ---
const leaderboards = { beginner: [], advanced: [], genius: [] };
function keepTop(list, n = 50) {
  list.sort((a, b) => b.points - a.points);
  if (list.length > n) list.length = n;
}

app.post("/api/lb/submit", (req, res) => {
  const { name = "Player", points = 0, mode = "beginner" } = req.body || {};
  if (!leaderboards[mode]) leaderboards[mode] = [];
  leaderboards[mode].push({ name, points: Number(points), time: Date.now() });
  keepTop(leaderboards[mode]);
  res.json({ ok: true });
});

app.get("/api/lb/:mode", (req, res) => {
  const { mode } = req.params;
  res.json(leaderboards[mode] || []);
});

app.listen(PORT, () => console.log(`✅ Server running on :${PORT}`));

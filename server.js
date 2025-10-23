// server.js
// npm i express cors cookie-parser stripe
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import Stripe from "stripe";
import fs from "fs";
import path from "path";
import url from "url";

const {
  PORT = 3000,
  NODE_ENV = "production",
  // Frontend/CORS
  FRONTEND_URL = "https://survive.com",
  ALLOWED_ORIGIN = "https://survive.com",
  // Stripe (one-time prices)
  STRIPE_SECRET_KEY = "",
  PRICE_ALL_ACCESS,
  PRICE_PREMIUM,
  PRICE_THEMES_PACK,
  PRICE_SURVIVAL,
  PRICE_PREMIUM_STATS,
  PRICE_AD_FREE,
  PRICE_DAILY_HINT,
  DONATION_URL = "", // optional direct URL
} = process.env;

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2023-10-16" }) : null;
const PRICE_BY_PRODUCT = {
  all_access: PRICE_ALL_ACCESS,
  premium: PRICE_PREMIUM,
  themes_pack: PRICE_THEMES_PACK,
  survival: PRICE_SURVIVAL,
  premium_stats: PRICE_PREMIUM_STATS,
  ad_free: PRICE_AD_FREE,
  daily_hint: PRICE_DAILY_HINT,
};

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(
  cors({
    origin: ALLOWED_ORIGIN,
    credentials: true,
  })
);
app.use(cookieParser());
app.use("/api", express.json());

// ---------- Load full dictionary ----------
const wordsPath = path.join(__dirname, "data", "words5.txt");
let WORDS = [];
try {
  WORDS = fs
    .readFileSync(wordsPath, "utf8")
    .split(/\r?\n/)
    .map((w) => w.trim().toLowerCase())
    .filter((w) => w.length === 5 && /^[a-z]+$/.test(w));
  console.log(`✅ Loaded ${WORDS.length} words from data/words5.txt`);
} catch (e) {
  console.warn("⚠️  data/words5.txt missing; using small fallback list.");
  WORDS = ["apple", "zebra", "tiger", "mouse", "eagle", "shark", "candy", "brave", "smile", "chair"];
}

// ---------- Optional Educational pools (subject + age) ----------
// If present, these files override the pool when edition=edu:
// data/edu/<subject>/<age>.txt (e.g., data/edu/math/9-11.txt)
const EDU_ROOT = path.join(__dirname, "data", "edu");
const EDU_SUBJECTS = [
  "general",
  "math",
  "biology",
  "chemistry",
  "physics",
  "social",
  "history",
  "geography",
  "business",
];

const EDU_AGES = ["6-8", "9-11", "12-14", "15-18", "19+"];

function loadEduList(subject, age) {
  try {
    const p = path.join(EDU_ROOT, subject, `${age}.txt`);
    if (fs.existsSync(p)) {
      const list = fs
        .readFileSync(p, "utf8")
        .split(/\r?\n/)
        .map((w) => w.trim().toLowerCase())
        .filter((w) => w.length === 5 && /^[a-z]+$/.test(w));
      if (list.length) return list;
    }
  } catch {}
  return null; // not found
}

// Simple category micro-buckets (optional; expand by curating files)
const ANIMALS = new Set(["zebra", "tiger", "mouse", "eagle", "shark"]);
const FOOD = new Set(["apple", "candy"]);
const TECH = new Set(["modem", "cable"]); // be sure entries exist in words5.txt

function filterByCategory(pool, category) {
  if (!category || category === "random") return pool;
  if (category === "animals") return pool.filter((w) => ANIMALS.has(w));
  if (category === "food") return pool.filter((w) => FOOD.has(w));
  if (category === "tech") return pool.filter((w) => TECH.has(w));
  // Others left as general unless you add curated sets
  return pool;
}

// Bias difficulty for edu ages if no subject file is present
function biasByAge(pool, age) {
  const easyLetters = /[aeiorsnt]/; // common letters
  const midLetters = /[dlump]/;
  if (age === "6-8") return pool.filter((w) => w.split("").filter((c) => easyLetters.test(c)).length >= 3);
  if (age === "9-11")
    return pool.filter((w) => w.split("").filter((c) => easyLetters.test(c) || midLetters.test(c)).length >= 3);
  return pool; // older ages → no bias
}

// ---------- Recent answers de-dupe ----------
const RECENT_SIZE = 100;
const recentWords = [];
function pickNonRecent(pool) {
  if (!pool || pool.length === 0) return null;
  let tries = 0;
  while (tries++ < 50) {
    const w = pool[Math.floor(Math.random() * pool.length)];
    if (!recentWords.includes(w)) {
      recentWords.push(w);
      if (recentWords.length > RECENT_SIZE) recentWords.shift();
      return w;
    }
  }
  // Fallback: still choose something, but rotate cache
  const w = pool[Math.floor(Math.random() * pool.length)];
  recentWords.push(w);
  if (recentWords.length > RECENT_SIZE) recentWords.shift();
  return w;
}

// ---------- Health ----------
app.get("/api/health", (_req, res) => res.json({ ok: true }));

// ---------- Whole dictionary for client-side validation ----------
app.get("/api/words5", (_req, res) => res.json(WORDS));

// ---------- Word picker (supports edition/category/subject/age) ----------
app.get("/api/word5", (req, res) => {
  const edition = (req.query.edition || "classic").toString();
  const subject = (req.query.subject || "general").toString();
  const age = (req.query.age || "9-11").toString();
  const category = (req.query.category || "random").toString();

  let pool = WORDS;

  if (edition === "edu") {
    // Try curated list first
    let eduList = null;
    if (EDU_SUBJECTS.includes(subject) && EDU_AGES.includes(age)) {
      eduList = loadEduList(subject, age);
    }
    if (eduList && eduList.length) {
      pool = eduList;
    } else {
      // No curated file → use bias
      pool = biasByAge(WORDS, age);
      if (pool.length === 0) pool = WORDS;
    }
  }

  // Apply category filter (works in both classic/edu)
  pool = filterByCategory(pool, category);
  if (!pool || !pool.length) pool = WORDS;

  const pick = pickNonRecent(pool);
  res.json({ word: pick });
});

// ---------- Leaderboards (per mode + simple region if you later add it) ----------
const lbByMode = { beginner: [], advanced: [], genius: [] };
function keepTop(arr, k = 100) {
  arr.sort((a, b) => b.points - a.points);
  if (arr.length > k) arr.length = k;
}
app.post("/api/lb/submit", (req, res) => {
  const { name = "Player", points = 0, mode = "beginner" } = req.body || {};
  const entry = { name, points: Number(points), t: Date.now() };
  (lbByMode[mode] || lbByMode.beginner).push(entry);
  keepTop(lbByMode[mode] || lbByMode.beginner);
  res.json({ ok: true });
});
app.get("/api/lb/global", (req, res) => {
  const mode = req.query.mode || "beginner";
  res.json(lbByMode[mode] || []);
});

// ---------- Simple Multiplayer Rooms (demo: 10 players) ----------
const rooms = new Map(); // roomCode -> { created, members }
app.post("/api/mp/create", (_req, res) => {
  const code = Math.random().toString(36).slice(2, 7).toUpperCase();
  rooms.set(code, { created: Date.now(), members: 0 });
  res.json({ room: code, limit: 10 });
});
app.post("/api/mp/join", (req, res) => {
  const { room } = req.body || {};
  const r = rooms.get(room);
  if (!r) return res.status(404).json({ error: "Room not found" });
  if (r.members >= 10) return res.status(403).json({ error: "Full" });
  r.members++;
  res.json({ ok: true, members: r.members });
});
app.post("/api/mp/leave", (req, res) => {
  const { room } = req.body || {};
  const r = rooms.get(room);
  if (r) r.members = Math.max(0, r.members - 1);
  res.json({ ok: true });
});
app.get("/api/mp/poll", (_req, res) => res.json([]));

// ---------- Payments (one-time) ----------
app.post("/api/pay/checkout", async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ error: "Stripe not configured" });
    const { product } = req.body || {};
    const price = PRICE_BY_PRODUCT[product];
    if (!price) return res.status(400).json({ error: "Price not configured on server" });

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{ price, quantity: 1 }],
      success_url: `${FRONTEND_URL}/?purchase=success`,
      cancel_url: `${FRONTEND_URL}/?purchase=cancel`,
    });
    res.json({ url: session.url });
  } catch (e) {
    console.error("checkout error", e);
    res.status(500).json({ error: "checkout-failed" });
  }
});

app.get("/api/pay/status", (_req, res) => {
  // NOTE: For real entitlements, add Stripe webhooks + DB.
  res.json({ owned: [], perks: { maxRows: 6 } });
});

app.get("/api/pay/support-link", (_req, res) => res.json({ url: DONATION_URL || "" }));

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`API listening on :${PORT} (${NODE_ENV})`);
});

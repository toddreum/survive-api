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
  // Stripe
  STRIPE_SECRET_KEY = "",
  PRICE_ALL_ACCESS,
  PRICE_PREMIUM,
  PRICE_THEMES_PACK,
  PRICE_SURVIVAL,
  PRICE_PREMIUM_STATS,
  PRICE_AD_FREE,
  PRICE_DAILY_HINT,
  // Frontend + CORS
  FRONTEND_URL = "https://survive.com",
  ALLOWED_ORIGIN = "https://survive.com",
  // Donation
  DONATION_URL = "",
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

// --------- Load dictionary ---------
const wordsPath = path.join(__dirname, "data", "words5.txt");
let WORDS = [];
try {
  WORDS = fs
    .readFileSync(wordsPath, "utf8")
    .split(/\r?\n/)
    .map((w) => w.trim().toLowerCase())
    .filter((w) => w.length === 5 && /^[a-z]+$/.test(w));
  console.log(`Loaded ${WORDS.length} words`);
} catch (e) {
  console.warn("⚠️  data/words5.txt missing; using small fallback list.");
  WORDS = ["apple", "zebra", "tiger", "mouse", "eagle", "shark", "candy", "brave", "smile", "chair"];
}

// Optional micro-buckets for categories (expand by improving words5.txt + tagging offline)
const SET = (arr) => new Set(arr);
const ANIMALS = SET(["zebra", "tiger", "mouse", "eagle", "shark"]);
const FOOD = SET(["candy", "apple"]);
const TECH = SET(["modem", "cable"]); // make sure these exist in words5.txt if you use them

// recent-word cache to avoid repetition
const RECENT_SIZE = 50;
const recentWords = [];
function pickNonRecent(pool) {
  let tries = 0;
  while (tries++ < 30) {
    const w = pool[Math.floor(Math.random() * pool.length)];
    if (!recentWords.includes(w)) {
      recentWords.push(w);
      if (recentWords.length > RECENT_SIZE) recentWords.shift();
      return w;
    }
  }
  // fallback
  const w = pool[Math.floor(Math.random() * pool.length)];
  recentWords.push(w);
  if (recentWords.length > RECENT_SIZE) recentWords.shift();
  return w;
}

// --------- App ---------
const app = express();
app.use(
  cors({
    origin: ALLOWED_ORIGIN,
    credentials: true,
  })
);
app.use(cookieParser());
app.use("/api", express.json());

// ---------- HEALTH ----------
app.get("/api/health", (_req, res) => res.json({ ok: true }));

// ---------- WORD LIST ----------
app.get("/api/words5", (_req, res) => res.json(WORDS));

// Word picker w/ edition/category/age bias
app.get("/api/word5", (req, res) => {
  const {
    edition = "classic",
    subject = "general",
    age = "9-11",
    category = "random",
  } = req.query;

  let pool = WORDS;

  if (category === "animals") pool = pool.filter((w) => ANIMALS.has(w));
  else if (category === "food") pool = pool.filter((w) => FOOD.has(w));
  else if (category === "tech") pool = pool.filter((w) => TECH.has(w));
  // nature/business/tv/film/politics → left as general pool unless you build buckets

  if (edition === "edu") {
    // simple bias rule by age band to keep difficulty reasonable
    const easyLetters = /[aeiorsnt]/; // common letters
    const midLetters = /[dlump]/;
    if (age === "6-8") pool = pool.filter((w) => w.split("").filter((c) => easyLetters.test(c)).length >= 3);
    if (age === "9-11") pool = pool.filter((w) => w.split("").filter((c) => easyLetters.test(c) || midLetters.test(c)).length >= 3);
    // older ages → leave pool as-is
    if (pool.length === 0) pool = WORDS;
  }

  const pick = pickNonRecent(pool);
  res.json({ word: pick });
});

// ---------- LEADERBOARDS (per mode + regional) ----------
const lbByMode = { beginner: [], advanced: [], genius: [] };
const lbRegional = new Map(); // region string -> entries[]

function keepTop(arr, k = 100) {
  arr.sort((a, b) => b.points - a.points);
  if (arr.length > k) arr.length = k;
}

app.post("/api/lb/submit", (req, res) => {
  const { name = "Player", points = 0, mode = "beginner", region = "global" } = req.body || {};
  const entry = { name, points: Number(points), t: Date.now() };
  (lbByMode[mode] || lbByMode.beginner).push(entry);
  keepTop(lbByMode[mode] || lbByMode.beginner);

  const r = lbRegional.get(region) || [];
  r.push(entry);
  keepTop(r);
  lbRegional.set(region, r);

  res.json({ ok: true });
});

app.get("/api/lb/global", (req, res) => {
  const mode = req.query.mode || "beginner";
  res.json(lbByMode[mode] || []);
});

app.get("/api/lb/region", (req, res) => {
  const region = req.query.tz || "global";
  res.json(lbRegional.get(region) || []);
});

// ---------- MULTIPLAYER ROOMS (simple demo) ----------
const rooms = new Map(); // code -> { created, members }
app.post("/api/mp/create", (req, res) => {
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

// ---------- PAYMENTS ----------
app.post("/api/pay/checkout", async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ error: "Stripe is not configured" });
    const { product } = req.body || {};
    const priceId = PRICE_BY_PRODUCT[product];
    if (!priceId) return res.status(400).json({ error: "Price not configured on server" });

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${FRONTEND_URL}/?purchase=success`,
      cancel_url: `${FRONTEND_URL}/?purchase=cancel`,
    });

    res.json({ url: session.url });
  } catch (e) {
    console.error("checkout error", e);
    res.status(500).json({ error: "checkout-failed" });
  }
});

// Minimal status (until you add webhooks + DB)
app.get("/api/pay/status", (_req, res) => {
  // TODO: Replace with real entitlements after adding Stripe webhooks + DB
  res.json({ owned: [], perks: { maxRows: 6 } });
});

// Donation link passthrough
app.get("/api/pay/support-link", (_req, res) => res.json({ url: DONATION_URL || "" }));

app.listen(PORT, () => console.log(`API listening on :${PORT} (${NODE_ENV})`));

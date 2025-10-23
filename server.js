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
  STRIPE_SECRET_KEY = "",
  // Price IDs (Stripe → Products → Price IDs)
  PRICE_ALL_ACCESS,
  PRICE_PREMIUM,
  PRICE_THEMES_PACK,
  PRICE_SURVIVAL,
  PRICE_PREMIUM_STATS,
  PRICE_AD_FREE,
  PRICE_DAILY_HINT,
  // Optional
  DONATION_URL,
  FRONTEND_URL = "https://survive.com",
  ALLOWED_ORIGIN = "https://survive.com",
} = process.env;

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2023-10-16" }) : null;

// Map product → priceId
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

// --- Load dictionary (full 5-letter list) ---
const wordsPath = path.join(__dirname, "data", "words5.txt");
let WORDS = [];
try {
  WORDS = fs
    .readFileSync(wordsPath, "utf8")
    .split(/\r?\n/)
    .map((w) => w.trim().toLowerCase())
    .filter((w) => w.length === 5);
  console.log(`Loaded ${WORDS.length} words`);
} catch (e) {
  console.warn("⚠️ words5.txt missing; using fallback mini list.");
  WORDS = ["apple", "zebra", "tiger", "mouse", "eagle", "shark", "candy", "brave", "smile", "chair"];
}

const app = express();

// CORS + cookies
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
app.get("/api/words5", (_req, res) => {
  res.json(WORDS);
});

// Simple category buckets (expand as you like)
const ANIMALS = new Set(["zebra", "tiger", "mouse", "eagle", "shark"]);
const FOOD = new Set(["candy", "apple"]);
const TECH = new Set(["modem", "cable"]); // add real words into words5.txt for better coverage

// Pick target with edition/category/age bias
app.get("/api/word5", (req, res) => {
  const { edition = "classic", subject = "general", age = "9-11", category = "random", mode = "beginner" } = req.query;

  // Base pool
  let pool = WORDS;

  // Category filter
  if (category === "animals") pool = pool.filter((w) => ANIMALS.has(w));
  else if (category === "food") pool = pool.filter((w) => FOOD.has(w));
  else if (category === "tech") pool = pool.filter((w) => TECH.has(w));
  // else random => no filter

  // Education bias (simple: shorter/common letters for younger)
  if (edition === "edu") {
    const easyLetters = /[aeiorsnt]/;
    const midLetters = /[dlump]/;
    if (age === "6-8") pool = pool.filter((w) => w.split("").filter((c) => easyLetters.test(c)).length >= 3);
    if (age === "9-11") pool = pool.filter((w) => w.split("").filter((c) => easyLetters.test(c) || midLetters.test(c)).length >= 3);
    if (age === "12-14") pool = pool.filter((w) => true);
    if (age === "15-18") pool = pool.filter((w) => true);
    if (age === "19+") pool = pool.filter((w) => true);
    if (pool.length === 0) pool = WORDS;
  }

  const pick = pool[Math.floor(Math.random() * pool.length)];
  res.json({ word: pick, mode, edition, subject, age, category });
});

// ---------- SIMPLE LEADERBOARDS (per mode + regional) ----------
const lbByMode = {
  beginner: [],
  advanced: [],
  genius: [],
};
const lbRegional = new Map(); // key: region string, val: entries array

function keepTop(arr, k = 100) {
  arr.sort((a, b) => b.points - a.points);
  if (arr.length > k) arr.length = k;
}

// submit cumulative total
app.post("/api/lb/submit", (req, res) => {
  const { name = "Player", points = 0, mode = "beginner", region = "global" } = req.body || {};
  const entry = { name, points: Number(points), t: Date.now() };

  (lbByMode[mode] || lbByMode.beginner).push(entry);
  keepTop(lbByMode[mode] || lbByMode.beginner, 100);

  const r = lbRegional.get(region) || [];
  r.push(entry);
  keepTop(r, 100);
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

// ---------- LIGHTWEIGHT MULTIPLAYER ROOMS ----------
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

// Minimal status (replace with your entitlements DB if you like)
app.get("/api/pay/status", (_req, res) => {
  // you can return owned: ['premium'] etc after you wire webhooks + DB
  res.json({ owned: [], perks: { maxRows: 6 } });
});

// Donation link passthrough
app.get("/api/pay/support-link", (_req, res) => {
  return res.json({ url: DONATION_URL || "" });
});

app.listen(PORT, () => {
  console.log(`API listening on :${PORT} (${NODE_ENV})`);
});

// server.js
// npm i express cors cookie-parser stripe
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import Stripe from "stripe";
import fs from "fs";
import path from "path";
import url from "url";
import crypto from "crypto";

/* -------------------- ENV -------------------- */
const {
  PORT = 3000,
  NODE_ENV = "production",

  // Frontend URL for CORS and redirects
  ALLOWED_ORIGIN = process.env.FRONTEND_URL || "https://survive.com",

  // Stripe (KEEP these names — they match your Render configuration)
  STRIPE_SECRET_KEY = "",
  STRIPE_WEBHOOK_SECRET = "",

  STRIPE_PRICE_ALL_ACCESS,
  STRIPE_PRICE_PREMIUM,
  STRIPE_PRICE_THEMES,
  STRIPE_PRICE_SURVIVAL,
  STRIPE_PRICE_STATS,
  STRIPE_PRICE_ADFREE,
  STRIPE_PRICE_DAILYHINT,
  STRIPE_PRICE_DONATION, // optional

  // Optional donation URL fallback if you don’t want a Stripe Price for donate
  DONATION_URL = "",

} = process.env;

/* ----------------- Stripe client -------------- */
const stripe = STRIPE_SECRET_KEY
  ? new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2023-10-16" })
  : null;

const PRODUCT_TO_PRICE = {
  all_access: STRIPE_PRICE_ALL_ACCESS,
  premium: STRIPE_PRICE_PREMIUM,
  themes_pack: STRIPE_PRICE_THEMES,
  survival: STRIPE_PRICE_SURVIVAL,
  premium_stats: STRIPE_PRICE_STATS,
  ad_free: STRIPE_PRICE_ADFREE,
  daily_hint: STRIPE_PRICE_DAILYHINT,
  donation: STRIPE_PRICE_DONATION,
};

const PRICE_TO_PRODUCT = new Map(
  Object.entries(PRODUCT_TO_PRICE)
    .filter(([_, v]) => !!v)
    .map(([k, v]) => [v, k])
);

/* --------------- Express setup ---------------- */
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
// IMPORTANT: we’ll attach JSON only to /api except webhook (webhook needs raw)
app.use("/api", express.json());

/* --------- Very simple user identification ---- */
function getOrSetUID(req, res) {
  let uid = req.cookies?.uid;
  if (!uid) {
    uid = crypto.randomUUID();
    res.cookie("uid", uid, {
      httpOnly: false,
      sameSite: "none",
      secure: true,
      path: "/",
      maxAge: 1000 * 60 * 60 * 24 * 365,
    });
  }
  return uid;
}

/* --------------- Dictionary load -------------- */
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
  console.warn("⚠️ data/words5.txt missing; using small fallback.");
  WORDS = ["apple", "zebra", "tiger", "mouse", "eagle", "shark", "candy", "brave", "smile", "chair"];
}

/* ---- Optional Educational curated lists ------ */
const EDU_ROOT = path.join(__dirname, "data", "edu");
const EDU_SUBJECTS = ["general","math","biology","chemistry","physics","social","history","geography","business"];
const EDU_AGES = ["6-8","9-11","12-14","15-18","19+"];

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
  return null;
}

// light category filters (expand if you curate)
const SET_ANIMALS = new Set(["zebra", "tiger", "mouse", "eagle", "shark"]);
const SET_FOOD = new Set(["apple", "candy"]);

function filterByCategory(pool, category) {
  if (!category || category === "random") return pool;
  if (category === "animals") return pool.filter((w) => SET_ANIMALS.has(w));
  if (category === "food") return pool.filter((w) => SET_FOOD.has(w));
  return pool; // other categories fall back for now
}

// age difficulty bias (if no curated edu list)
function biasByAge(pool, age) {
  const easyLetters = /[aeiorsnt]/;
  const midLetters = /[dlump]/;
  if (age === "6-8") return pool.filter((w) => w.split("").filter((c) => easyLetters.test(c)).length >= 3);
  if (age === "9-11")
    return pool.filter((w) => w.split("").filter((c) => easyLetters.test(c) || midLetters.test(c)).length >= 3);
  return pool;
}

/* --------------- No-repeat picker ------------- */
const RECENT_SIZE = 100;
const recentWords = [];
function pickNonRecent(pool) {
  if (!pool || !pool.length) return null;
  let tries = 0;
  while (tries++ < 50) {
    const w = pool[Math.floor(Math.random() * pool.length)];
    if (!recentWords.includes(w)) {
      recentWords.push(w);
      if (recentWords.length > RECENT_SIZE) recentWords.shift();
      return w;
    }
  }
  const w = pool[Math.floor(Math.random() * pool.length)];
  recentWords.push(w);
  if (recentWords.length > RECENT_SIZE) recentWords.shift();
  return w;
}

/* --------------- In-memory “DB” --------------- */
/** Map<uid, Set<product>> */
const purchases = new Map();

function grant(uid, product) {
  const set = purchases.get(uid) ?? new Set();
  set.add(product);
  purchases.set(uid, set);
  // “premium” / “all_access” imply others
  if (product === "premium" || product === "all_access") {
    set.add("themes_pack");
    set.add("premium_stats");
    set.add("survival");
    set.add("ad_free");
    set.add("daily_hint");
  }
}

function revoke(uid, product) {
  const set = purchases.get(uid);
  if (!set) return;
  set.delete(product);
  // you may optionally revoke implied ones (not typical for bundles)
}

/* ---------------- Perks snapshot --------------- */
function perksFor(uid) {
  const owned = purchases.get(uid) ?? new Set();
  const hasPremium = owned.has("premium") || owned.has("all_access");
  return {
    owned: [...owned],
    perks: hasPremium
      ? { maxRows: 8, winBonus: 5, accent: "#ffb400", themesPack: true }
      : { maxRows: 6, winBonus: 0, accent: undefined, themesPack: owned.has("themes_pack") },
  };
}

/* ------------------- Routes -------------------- */
app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.get("/api/words5", (_req, res) => res.json(WORDS));

app.get("/api/word5", (req, res) => {
  const edition = String(req.query.edition || "classic");
  const subject = String(req.query.subject || "general");
  const age = String(req.query.age || "9-11");
  const category = String(req.query.category || "random");

  let pool = WORDS;
  if (edition === "edu") {
    const curated = loadEduList(subject, age);
    pool = (curated && curated.length) ? curated : biasByAge(WORDS, age);
    if (!pool || !pool.length) pool = WORDS;
  }
  pool = filterByCategory(pool, category);
  if (!pool || !pool.length) pool = WORDS;

  const pick = pickNonRecent(pool);
  res.json({ word: pick });
});

/* -------------- Leaderboards (per mode) -------- */
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

/* ---------------- Simple Rooms ----------------- */
const rooms = new Map(); // roomCode -> {created, members}
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

/* ----------------- Payments -------------------- */
// Create Checkout Session
app.post("/api/pay/checkout", async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ error: "Stripe not configured" });
    const uid = getOrSetUID(req, res);
    const { product } = req.body || {};
    const price = PRODUCT_TO_PRICE[product];
    if (!price) return res.status(400).json({ error: "Price not configured on server" });

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      client_reference_id: uid,
      line_items: [{ price, quantity: 1 }],
      success_url: `${ALLOWED_ORIGIN}/?purchase=success`,
      cancel_url: `${ALLOWED_ORIGIN}/?purchase=cancel`,
      metadata: { product, uid },
    });
    res.json({ url: session.url });
  } catch (e) {
    console.error("checkout error", e);
    res.status(500).json({ error: "checkout-failed" });
  }
});

// Donation passthrough
app.get("/api/pay/support-link", async (_req, res) => {
  try {
    if (DONATION_URL) return res.json({ url: DONATION_URL });
    if (stripe && PRODUCT_TO_PRICE.donation) {
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        line_items: [{ price: PRODUCT_TO_PRICE.donation, quantity: 1 }],
        success_url: `${ALLOWED_ORIGIN}/?donate=success`,
        cancel_url: `${ALLOWED_ORIGIN}/?donate=cancel`,
      });
      return res.json({ url: session.url });
    }
    return res.json({ url: "" });
  } catch {
    return res.json({ url: "" });
  }
});

// Status (reads in-memory entitlements)
app.get("/api/pay/status", (req, res) => {
  const uid = getOrSetUID(req, res);
  res.json(perksFor(uid));
});

/* ---------------- Stripe Webhook --------------- */
// IMPORTANT: use raw body for signature check
app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) return res.status(500).send("Stripe not configured");
  const sig = req.headers["stripe-signature"];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("❌ Webhook signature verification failed.", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = await stripe.checkout.sessions.retrieve(event.data.object.id, {
          expand: ["line_items.data.price"],
        });
        const uid = session.client_reference_id || session.metadata?.uid;
        let product = session.metadata?.product || null;
        if (!product && session.line_items?.data?.[0]?.price?.id) {
          product = PRICE_TO_PRODUCT.get(session.line_items.data[0].price.id) || null;
        }
        if (uid && product) {
          grant(uid, product);
          console.log(`✅ Granted ${product} to uid=${uid}`);
        } else {
          console.warn("⚠️ Missing uid or product in webhook");
        }
        break;
      }
      case "charge.refunded": {
        const charge = event.data.object;
        console.log("Refund received for charge", charge.id);
        // If you store charge→uid/product at purchase time, revoke here.
        break;
      }
      default:
        break;
    }
    res.json({ received: true });
  } catch (e) {
    console.error("Webhook handler error", e);
    res.status(500).send("webhook-handler-error");
  }
});

/* ----------------- Start server ---------------- */
app.listen(PORT, () => {
  console.log(`API listening on :${PORT} (${NODE_ENV})`);
});

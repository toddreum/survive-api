// server.js
// npm i express cors cookie-parser stripe crypto
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import Stripe from "stripe";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ───────────────────────────────────────────────────────────────────────────────
// ENV
// ───────────────────────────────────────────────────────────────────────────────
const {
  PORT = 3000,
  NODE_ENV = "production",
  ALLOWED_ORIGIN = "https://survive.com",
  SESSION_SECRET = crypto.randomBytes(32).toString("hex"),

  // Stripe
  STRIPE_SECRET,
  STRIPE_WEBHOOK_SECRET,
  SUPPORT_LINK,

  // One-time prices
  STRIPE_PRICE_ALLACCESS,
  STRIPE_PRICE_PREMIUM,
  STRIPE_PRICE_THEMES,
  STRIPE_PRICE_SURVIVAL,
  STRIPE_PRICE_STATS,
  STRIPE_PRICE_ADFREE,
  STRIPE_PRICE_DAILYHINT,

  // New monthly subscription
  STRIPE_PRICE_MONTHLY,
} = process.env;

if (!STRIPE_SECRET) console.warn("⚠️ STRIPE_SECRET missing");
const stripe = STRIPE_SECRET ? new Stripe(STRIPE_SECRET, { apiVersion: "2024-06-20" }) : null;

// ───────────────────────────────────────────────────────────────────────────────
// App
// ───────────────────────────────────────────────────────────────────────────────
const app = express();

app.use(
  cors({
    origin: ALLOWED_ORIGIN,
    credentials: true,
  })
);
app.use(cookieParser(SESSION_SECRET));

// Use json for all /api except webhook (raw)
app.use("/api", express.json());

// Serve the front-end if you deploy both together
app.use(express.static(path.join(__dirname, "public")));

// ───────────────────────────────────────────────────────────────────────────────
// Identify user (cookie 'uid')
// ───────────────────────────────────────────────────────────────────────────────
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

// ───────────────────────────────────────────────────────────────────────────────
// Dictionary (full 5-letter), categories are optional tags you can expand later
// File: /data/words5.txt (one word per line OR CSV "word,category")
// ───────────────────────────────────────────────────────────────────────────────
const WORDS = (() => {
  const p = path.join(__dirname, "data", "words5.txt");
  let list = [];
  try {
    const raw = fs.readFileSync(p, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim().toLowerCase();
      if (!t) continue;
      const [word, cat] = t.split(",").map((s) => s?.trim());
      if (/^[a-z]{5}$/.test(word)) list.push({ word, cat: cat || "general" });
    }
    console.log(`✅ Loaded ${list.length} words from data/words5.txt`);
  } catch (e) {
    console.warn("⚠️ Could not read data/words5.txt. Using tiny fallback wordlist.");
    const fallback = ["apple","build","crane","zebra","mouse","donut","crown","flame","stone","tiger"].map(w=>({word:w,cat:"general"}));
    list = fallback;
  }
  return list;
})();

// Simple helpers
const ANY_WORD = () => WORDS[(Math.random() * WORDS.length) | 0].word;
function pickByCategory(category = "random") {
  if (category === "random") return ANY_WORD();
  const pool = WORDS.filter((w) => w.cat === category);
  return (pool[(Math.random() * pool.length) | 0] || WORDS[(Math.random() * WORDS.length) | 0]).word;
}

// ───────────────────────────────────────────────────────────────────────────────
// In-memory “DB” (swap for real DB later)
// ───────────────────────────────────────────────────────────────────────────────
/** Map<uid, Set<product>> */
const purchases = new Map();
/** Map<uid, number> cumulative points */
const totals = new Map();
/** Array of scores for leaderboards (capped length) */
const lb = []; // { uid, name, mode, points, region, tz, ts }
const MAX_LB = 5000;

/** Multiplayer (in-memory) */
const queues = {
  "solo:beginner:random": [],
  "solo:advanced:random": [],
  "solo:genius:random": [],
};
const rooms = new Map(); // Map<roomId, { players: uid[], mode, category, word, createdAt }>

/** Public room listing (open invites) */
const publicRooms = new Set();

// ───────────────────────────────────────────────────────────────────────────────
// Purchases helpers
// ───────────────────────────────────────────────────────────────────────────────
function grant(uid, product) {
  const set = purchases.get(uid) ?? new Set();
  set.add(product);
  // Map monthly/allaccess to sub-perks
  if (product === "all_access" || product === "monthly_pass" || product === "premium") {
    set.add("themes_pack");
    set.add("survival");
    set.add("premium_stats");
    set.add("ad_free");
    set.add("daily_hint");
  }
  purchases.set(uid, set);
}

function revoke(uid, product) {
  const set = purchases.get(uid);
  if (!set) return;
  set.delete(product);
  if (product === "monthly_pass" || product === "premium" || product === "all_access") {
    ["themes_pack","survival","premium_stats","ad_free","daily_hint"].forEach((p)=>set.delete(p));
  }
}

// Price map
const PRICE_TO_PRODUCT = new Map(
  [
    [STRIPE_PRICE_ALLACCESS, "all_access"],
    [STRIPE_PRICE_PREMIUM, "premium"],
    [STRIPE_PRICE_THEMES, "themes_pack"],
    [STRIPE_PRICE_SURVIVAL, "survival"],
    [STRIPE_PRICE_STATS, "premium_stats"],
    [STRIPE_PRICE_ADFREE, "ad_free"],
    [STRIPE_PRICE_DAILYHINT, "daily_hint"],
    [STRIPE_PRICE_MONTHLY, "monthly_pass"],
  ].filter(([k]) => !!k)
);

const PRODUCT_TO_PRICE = {
  all_access: STRIPE_PRICE_ALLACCESS,
  premium: STRIPE_PRICE_PREMIUM,
  themes_pack: STRIPE_PRICE_THEMES,
  survival: STRIPE_PRICE_SURVIVAL,
  premium_stats: STRIPE_PRICE_STATS,
  ad_free: STRIPE_PRICE_ADFREE,
  daily_hint: STRIPE_PRICE_DAILYHINT,
  monthly_pass: STRIPE_PRICE_MONTHLY,
};

function perksFor(uid) {
  const owned = purchases.get(uid) ?? new Set();
  const hasAll = owned.has("all_access") || owned.has("premium") || owned.has("monthly_pass");
  return {
    owned: [...owned],
    monthly: owned.has("monthly_pass"),
    active: hasAll,
    perks: {
      maxRows: hasAll ? 8 : 6,
      winBonus: hasAll ? 5 : 0,
      themesPack: hasAll || owned.has("themes_pack"),
      adFree: hasAll || owned.has("ad_free"),
      stats: hasAll || owned.has("premium_stats"),
      survival: hasAll || owned.has("survival"),
      dailyHint: hasAll || owned.has("daily_hint"),
      xpBoost: owned.has("monthly_pass") ? 1.05 : 1.0,
      accent: hasAll ? "#ffb400" : undefined,
    },
    totalPoints: totals.get(uid) || 0,
  };
}

// ───────────────────────────────────────────────────────────────────────────────
// Routes
// ───────────────────────────────────────────────────────────────────────────────
app.get("/api/health", (_req, res) => res.json({ ok: true }));

// Dictionary check endpoint (optional)
app.get("/api/isword/:w", (req, res) => {
  const w = String(req.params.w || "").toLowerCase();
  const ok = WORDS.some((x) => x.word === w);
  res.json({ ok });
});

// Create checkout
app.post("/api/pay/checkout", async (req, res) => {
  try {
    const uid = getOrSetUID(req, res);
    const { product } = req.body || {};
    const price = PRODUCT_TO_PRICE[product];
    if (!stripe) return res.status(500).json({ error: "stripe-not-configured" });
    if (!price) return res.status(400).json({ error: "Unknown product" });

    // For monthly, use mode: subscription
    const isMonthly = product === "monthly_pass";
    const session = await stripe.checkout.sessions.create({
      mode: isMonthly ? "subscription" : "payment",
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

// Optional “Donate”
app.get("/api/pay/support-link", (_req, res) => {
  if (!SUPPORT_LINK) return res.status(404).json({ error: "support-link-missing" });
  res.json({ url: SUPPORT_LINK });
});

// Webhook (raw body)
app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  if (!stripe) return res.status(500).send("stripe-not-configured");
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
          product = PRICE_TO_PRODUCT.get(session.line_items.data[0].price.id);
        }
        if (uid && product) {
          grant(uid, product);
          console.log(`✅ Granted ${product} to uid=${uid}`);
        }
        break;
      }
      case "invoice.payment_succeeded": {
        const inv = event.data.object;
        const subId = inv.subscription;
        // optional: retrieve subscription to read metadata uid/product
        break;
      }
      case "customer.subscription.updated":
      case "customer.subscription.created": {
        const sub = event.data.object;
        const uid = sub.metadata?.uid || null;
        if (uid) {
          grant(uid, "monthly_pass");
          console.log(`✅ Monthly active for uid=${uid}`);
        }
        break;
      }
      case "customer.subscription.deleted": {
        const sub = event.data.object;
        const uid = sub.metadata?.uid || null;
        if (uid) {
          revoke(uid, "monthly_pass");
          console.log(`⚠️ Monthly canceled for uid=${uid}`);
        }
        break;
      }
      case "charge.refunded": {
        // If you map charge->uid/product, revoke accordingly
        console.log("Refund received for charge", event.data.object.id);
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

// Status (purchases & perks)
app.get("/api/pay/status", (req, res) => {
  const uid = getOrSetUID(req, res);
  res.json(perksFor(uid));
});

// Leaderboards
function pushLB(entry) {
  lb.push(entry);
  if (lb.length > MAX_LB) lb.shift();
}
function top(scope = "global", mode = null, limit = 50) {
  // scope: "global" or region prefix (e.g., "America")
  let arr = lb.slice();
  if (mode) arr = arr.filter((x) => x.mode === mode);
  if (scope !== "global") arr = arr.filter((x) => (x.tz || "").startsWith(scope));
  arr.sort((a, b) => b.points - a.points || b.ts - a.ts);
  const out = [];
  const seen = new Set();
  for (const x of arr) {
    if (seen.has(x.uid)) continue;
    out.push(x);
    seen.add(x.uid);
    if (out.length >= limit) break;
  }
  return out;
}

app.post("/api/lb/submit", (req, res) => {
  const uid = getOrSetUID(req, res);
  const { name = "Player", mode = "beginner", points = 0, tz = "UTC" } = req.body || {};
  const total = (totals.get(uid) || 0) + Number(points || 0);
  totals.set(uid, total);
  pushLB({ uid, name, mode, points: total, tz, ts: Date.now() });
  res.json({ ok: true, total });
});

app.get("/api/lb/global", (req, res) => {
  const mode = req.query.mode || null;
  res.json({ top: top("global", mode, Number(req.query.limit) || 50) });
});

app.get("/api/lb/region", (req, res) => {
  const tz = String(req.query.tz || "UTC");
  const region = tz.split("/")[0] || "UTC";
  const mode = req.query.mode || null;
  res.json({ region, top: top(region, mode, Number(req.query.limit) || 50) });
});

// Multiplayer (Option A: in-memory queues, long-polling)
// Quick match
app.post("/api/match/queue", (req, res) => {
  const uid = getOrSetUID(req, res);
  const { queue = "solo:beginner:random" } = req.body || {};
  if (!queues[queue]) queues[queue] = [];
  const waiting = queues[queue].shift();
  if (waiting && waiting.uid !== uid) {
    // create room
    const roomId = crypto.randomBytes(6).toString("hex");
    const [mode, category] = queue.split(":").slice(1);
    const word = pickByCategory(category);
    rooms.set(roomId, { players: [waiting.uid, uid], mode, category, word, createdAt: Date.now() });
    return res.json({ matched: true, roomId, mode, category });
  }
  const ticket = crypto.randomUUID();
  queues[queue].push({ uid, ticket, ts: Date.now() });
  res.json({ queued: true, ticket });
});

app.post("/api/match/cancel", (req, res) => {
  const uid = getOrSetUID(req, res);
  const { queue = "solo:beginner:random", ticket } = req.body || {};
  if (!queues[queue]) return res.json({ ok: true });
  queues[queue] = queues[queue].filter((x) => !(x.uid === uid && (!ticket || x.ticket === ticket)));
  res.json({ ok: true });
});

app.get("/api/match/poll", (req, res) => {
  // naïve poll: if a match was created with this uid, return it
  const uid = getOrSetUID(req, res);
  for (const [id, r] of rooms) {
    if (r.players.includes(uid) && r.createdAt > Date.now() - 60000) {
      return res.json({ matched: true, roomId: id, mode: r.mode, category: r.category });
    }
  }
  res.json({ matched: false });
});

// Private rooms (friends)
app.post("/api/mp/create", (req, res) => {
  const uid = getOrSetUID(req, res);
  const { mode = "beginner", category = "random", isPublic = false } = req.body || {};
  const roomId = crypto.randomBytes(4).toString("hex").toUpperCase();
  const word = pickByCategory(category);
  rooms.set(roomId, { players: [uid], owner: uid, mode, category, word, createdAt: Date.now() });
  if (isPublic) publicRooms.add(roomId);
  res.json({ roomId });
});
app.post("/api/mp/join", (req, res) => {
  const uid = getOrSetUID(req, res);
  const { roomId } = req.body || {};
  const r = rooms.get(roomId);
  if (!r) return res.status(404).json({ error: "room-not-found" });
  if (!r.players.includes(uid)) r.players.push(uid);
  res.json({ ok: true, mode: r.mode, category: r.category });
});
app.get("/api/mp/room/:id", (req, res) => {
  const r = rooms.get(req.params.id);
  if (!r) return res.status(404).json({ error: "room-not-found" });
  res.json({ players: r.players.length, mode: r.mode, category: r.category });
});
app.get("/api/lobby/public", (_req, res) => {
  res.json({ rooms: [...publicRooms].slice(0, 50) });
});

// Lobby stats
app.get("/api/lobby/stats", (_req, res) => {
  const out = {};
  for (const k of Object.keys(queues)) out[k] = queues[k].length;
  res.json({ queues: out, onlineRooms: publicRooms.size });
});

// ───────────────────────────────────────────────────────────────────────────────
// Start
// ───────────────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`API listening on :${PORT} (${NODE_ENV})`);
});

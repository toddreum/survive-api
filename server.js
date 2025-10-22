// server.js
// npm i express cors cookie-parser stripe
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import Stripe from "stripe";
import crypto from "crypto";
import fs from "fs";

const {
  PORT = 3000,
  NODE_ENV = "production",

  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,

  // Stripe PRICE ids (must start with "price_")
  STRIPE_PRICE_ALLACCESS,
  STRIPE_PRICE_PREMIUM,
  STRIPE_PRICE_THEMES,
  STRIPE_PRICE_SURVIVAL,
  STRIPE_PRICE_STATS,
  STRIPE_PRICE_ADFREE,
  STRIPE_PRICE_DAILYHINT,

  // optional donate price id
  STRIPE_PRICE_DONATION,

  ALLOWED_ORIGIN = "https://survive.com",
} = process.env;

// ------------ Stripe ------------
if (!STRIPE_SECRET_KEY) console.warn("⚠️  STRIPE_SECRET_KEY missing");
if (!STRIPE_WEBHOOK_SECRET) console.warn("⚠️  STRIPE_WEBHOOK_SECRET missing");

const stripe = new Stripe(STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
});

// ------------ App / middleware ------------
const app = express();

app.use(
  cors({
    origin: ALLOWED_ORIGIN,
    credentials: true,
  })
);

app.use(cookieParser());
app.use("/api", express.json()); // IMPORTANT: webhook below uses express.raw

// ------------ UID helpers ------------
function getOrSetUID(req, res) {
  let uid = (req.headers["x-uid"] && String(req.headers["x-uid"])) || req.cookies?.uid;
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

// ------------ In-memory stores (replace with DB when ready) ------------
const purchases = new Map();               // Map<uid, Set<product>>
const dailyHintUsedAt = new Map();         // Map<uid, YYYY-MM-DD>
const intentIndex = new Map();             // Map<payment_intent_id, {uid,product}>
const globalLB = [];                       // Array<{uid,name,points}>
const regionLB = new Map();                // Map<region, Array<{uid,name,points}>>
const rooms = new Map();                   // Map<code, {members:Set, log:Array, createdAt:number}>

// helpers
function pushScore({ uid, name, points, region = "NA" }) {
  const capName = String(name || "Player").slice(0, 24);
  const pts = Number(points) || 0;

  // global
  const gi = globalLB.findIndex(r => r.uid === uid);
  if (gi >= 0) {
    globalLB[gi].points = Math.max(globalLB[gi].points, pts);
    globalLB[gi].name = capName;
  } else {
    globalLB.push({ uid, name: capName, points: pts });
  }
  globalLB.sort((a, b) => b.points - a.points);
  if (globalLB.length > 100) globalLB.length = 100;

  // region
  const arr = regionLB.get(region) || [];
  const ri = arr.findIndex(r => r.uid === uid);
  if (ri >= 0) {
    arr[ri].points = Math.max(arr[ri].points, pts);
    arr[ri].name = capName;
  } else {
    arr.push({ uid, name: capName, points: pts });
  }
  arr.sort((a, b) => b.points - a.points);
  if (arr.length > 100) arr.length = 100;
  regionLB.set(region, arr);
}

function randomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 4; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

// ------------ Product/price mapping ------------
const PRICE_TO_PRODUCT = new Map(
  [
    [STRIPE_PRICE_ALLACCESS, "all_access"],
    [STRIPE_PRICE_PREMIUM, "premium"],
    [STRIPE_PRICE_THEMES, "themes_pack"],
    [STRIPE_PRICE_SURVIVAL, "survival"],
    [STRIPE_PRICE_STATS, "premium_stats"],
    [STRIPE_PRICE_ADFREE, "ad_free"],
    [STRIPE_PRICE_DAILYHINT, "daily_hint"],
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
};

function grant(uid, product) {
  const set = purchases.get(uid) ?? new Set();
  set.add(product);

  if (product === "all_access") {
    ["premium", "themes_pack", "survival", "premium_stats", "ad_free", "daily_hint"].forEach(p => set.add(p));
  }
  if (product === "premium") {
    ["themes_pack", "premium_stats", "survival", "ad_free"].forEach(p => set.add(p));
  }
  purchases.set(uid, set);
}

function revoke(uid, product) {
  const set = purchases.get(uid);
  if (!set) return;
  if (product === "all_access") {
    ["all_access","premium","themes_pack","survival","premium_stats","ad_free","daily_hint"].forEach(p => set.delete(p));
  } else {
    set.delete(product);
  }
  purchases.set(uid, set);
}

function perksFor(uid) {
  const owned = purchases.get(uid) ?? new Set();
  const hasAll = owned.has("all_access");
  const hasPremium = hasAll || owned.has("premium");
  return {
    active: hasAll || hasPremium,
    owned: [...owned],
    perks: hasAll || hasPremium
      ? { maxRows: 8, winBonus: 5, accent: "#ffb400", themesPack: true }
      : { maxRows: 6, winBonus: 0, accent: undefined, themesPack: owned.has("themes_pack") },
  };
}

// ------------ Health ------------
app.get("/api/health", (_req, res) => res.json({ ok: true }));

// ------------ Payments: create checkout ------------
app.post("/api/pay/checkout", async (req, res) => {
  try {
    const uid = getOrSetUID(req, res);
    const { product } = req.body || {};
    const price = PRODUCT_TO_PRICE[product];
    if (!price) {
      return res.status(400).json({ error: `Unknown product: ${product}. Price not configured on server.` });
    }
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

// donation helper
app.get("/api/pay/support-link", async (req, res) => {
  try {
    const uid = getOrSetUID(req, res);
    if (!STRIPE_PRICE_DONATION) return res.json({ url: null, error: "donation-price-not-configured" });
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      client_reference_id: uid,
      line_items: [{ price: STRIPE_PRICE_DONATION, quantity: 1 }],
      success_url: `${ALLOWED_ORIGIN}/?donate=success`,
      cancel_url: `${ALLOWED_ORIGIN}/?donate=cancel`,
      metadata: { product: "donation", uid },
    });
    res.json({ url: session.url });
  } catch (e) {
    console.error("support-link error", e);
    res.json({ url: null });
  }
});

// ------------ Webhook (RAW body) ------------
app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), async (req, res) => {
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
        const s = await stripe.checkout.sessions.retrieve(event.data.object.id, {
          expand: ["line_items.data.price", "payment_intent"],
        });
        const uid = s.client_reference_id || s.metadata?.uid || null;
        let product = s.metadata?.product || null;
        if (!product && s.line_items?.data?.[0]?.price?.id) {
          product = PRICE_TO_PRODUCT.get(s.line_items.data[0].price.id) || null;
        }
        if (uid && product) {
          grant(uid, product);
          const pi = typeof s.payment_intent === "string" ? s.payment_intent : s.payment_intent?.id;
          if (pi) intentIndex.set(pi, { uid, product });
          console.log(`✅ Granted ${product} to uid=${uid}`);
        } else {
          console.warn("⚠️ Missing uid or product in webhook");
        }
        break;
      }
      case "charge.refunded": {
        const charge = event.data.object;
        const pi = charge.payment_intent;
        if (pi && intentIndex.has(pi)) {
          const { uid, product } = intentIndex.get(pi);
          revoke(uid, product);
          console.log(`↩️  Revoked ${product} from uid=${uid} (refund)`);
        } else {
          console.log("Refund received, no mapping for PI:", pi);
        }
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

// ------------ Status / daily hint ------------
app.get("/api/pay/status", (req, res) => {
  const uid = getOrSetUID(req, res);
  res.json(perksFor(uid));
});

app.post("/api/hint/free", (req, res) => {
  const uid = getOrSetUID(req, res);
  const today = new Date().toISOString().slice(0, 10);
  const last = dailyHintUsedAt.get(uid);
  if (last === today) return res.status(429).json({ ok: false, reason: "used" });
  dailyHintUsedAt.set(uid, today);
  res.json({ ok: true });
});

// ------------ Words API (5-letter list) ------------
let WORDS5 = null;
try {
  if (fs.existsSync("./words5.json")) {
    const raw = fs.readFileSync("./words5.json", "utf8");
    const list = JSON.parse(raw);
    if (Array.isArray(list)) {
      WORDS5 = list
        .filter((w) => /^[a-zA-Z]{5}$/.test(String(w || "")))
        .map((w) => String(w).toLowerCase());
      console.log(`📚 Loaded words5.json (${WORDS5.length} words)`);
    }
  }
} catch (e) {
  console.warn("Could not load words5.json, using fallback.", e?.message);
}

const FALLBACK5 = [
  "about","other","which","their","there","first","build","donut","smile","light","water",
  "array","shift","grape","apple","north","mouse","robot","laser","salad","bread"
];

app.get("/api/words5", (_req, res) => {
  if (WORDS5 && WORDS5.length) return res.json(WORDS5);
  res.json(FALLBACK5);
});

// ------------ Leaderboards ------------
app.get("/api/lb/global", (_req, res) => {
  res.json(globalLB.slice(0, 50));
});

app.get("/api/lb/region", (req, res) => {
  const region = (req.query.region && String(req.query.region)) || "";
  const tz = (req.query.tz && String(req.query.tz)) || "";
  let key = region;
  if (!key) {
    if (/America\//.test(tz)) key = "NA";
    else if (/Europe\//.test(tz)) key = "EU";
    else if (/Asia\//.test(tz)) key = "AS";
    else if (/Australia\/|Pacific\//.test(tz)) key = "OC";
    else if (/Africa\//.test(tz)) key = "AF";
    else if (/America\/(Argentina|Santiago|Sao_Paulo)/.test(tz)) key = "SA";
    else key = "NA";
  }
  res.json((regionLB.get(key) || []).slice(0, 50));
});

app.post("/api/lb/submit", (req, res) => {
  const uid = getOrSetUID(req, res);
  const { name = "Player", region = "NA", points = 0 } = req.body || {};
  pushScore({
    uid,
    name: String(name).slice(0, 24),
    region: String(region).slice(0, 4).toUpperCase(),
    points: Number(points) || 0,
  });
  res.json({ ok: true });
});

// ------------ Multiplayer (simple polling) ------------
app.post("/api/mp/create", (req, res) => {
  const uid = getOrSetUID(req, res);
  let code = "";
  for (let i = 0; i < 8; i++) {
    code = randomCode();
    if (!rooms.has(code)) break;
  }
  if (rooms.has(code)) return res.status(500).json({ error: "room-create-failed" });
  rooms.set(code, { members: new Set([uid]), log: [{ t: Date.now(), type: "created" }], createdAt: Date.now() });
  res.json({ room: code });
});

app.post("/api/mp/join", (req, res) => {
  const uid = getOrSetUID(req, res);
  const { room } = req.body || {};
  const r = rooms.get(String(room || "").toUpperCase());
  if (!r) return res.status(404).json({ error: "room-not-found" });
  r.members.add(uid);
  r.log.push({ t: Date.now(), type: "join", from: uid });
  res.json({ ok: true });
});

app.post("/api/mp/leave", (req, res) => {
  const uid = getOrSetUID(req, res);
  const { room } = req.body || {};
  const r = rooms.get(String(room || "").toUpperCase());
  if (r) {
    r.members.delete(uid);
    r.log.push({ t: Date.now(), type: "leave", from: uid });
    if (r.members.size === 0 && Date.now() - r.createdAt > 60_000) rooms.delete(room);
  }
  res.json({ ok: true });
});

app.get("/api/mp/poll", (req, res) => {
  const uid = getOrSetUID(req, res);
  const room = String(req.query.room || "").toUpperCase();
  const since = Number(req.query.since || 0) || 0;
  const r = rooms.get(room);
  if (!r || !r.members.has(uid)) return res.json([]);
  res.json(r.log.filter(m => m.t > since));
});

// ------------ Diagnostics (to kill 404 mystery) ------------
app.get("/api/version", (_req, res) => {
  res.json({
    env: NODE_ENV,
    node: process.version,
    commit: process.env.RENDER_GIT_COMMIT || null,
    builtAt: process.env.RENDER_GIT_COMMIT_TIMESTAMP || null,
  });
});

app.get("/api/_routes", (_req, res) => {
  const out = [];
  function collect(stack, prefix = "") {
    stack.forEach((l) => {
      if (l.route && l.route.path) {
        const methods = Object.keys(l.route.methods).join(",").toUpperCase();
        out.push(`${methods} ${prefix}${l.route.path}`);
      } else if (l.name === "router" && l.handle.stack) {
        collect(l.handle.stack, prefix);
      }
    });
  }
  collect(app._router.stack, "");
  res.json(out.sort());
});

// ------------ Start ------------
app.listen(PORT, () => {
  console.log(`API listening on :${PORT} (${NODE_ENV})`);
});

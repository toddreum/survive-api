// server.js
// npm i express cors cookie-parser stripe
// Optional: fs for loading words file if present

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

  // One-time purchase price IDs (Stripe "price_...")
  STRIPE_PRICE_ALLACCESS,
  STRIPE_PRICE_PREMIUM,
  STRIPE_PRICE_THEMES,
  STRIPE_PRICE_SURVIVAL,
  STRIPE_PRICE_STATS,
  STRIPE_PRICE_ADFREE,
  STRIPE_PRICE_DAILYHINT,

  // Donation (optional; Stripe price id)
  STRIPE_PRICE_DONATION,

  ALLOWED_ORIGIN = "https://survive.com",
} = process.env;

if (!STRIPE_SECRET_KEY) {
  console.warn("⚠️  STRIPE_SECRET_KEY missing");
}
if (!STRIPE_WEBHOOK_SECRET) {
  console.warn("⚠️  STRIPE_WEBHOOK_SECRET missing");
}

const stripe = new Stripe(STRIPE_SECRET_KEY, {
  // Use a recent stable API version. (If this logs warnings, remove apiVersion to default to your account's default.)
  apiVersion: "2024-06-20",
});

const app = express();

// ---------- CORS ----------
app.use(
  cors({
    origin: ALLOWED_ORIGIN,
    credentials: true,
  })
);

// ---------- Cookies & JSON (not for webhook) ----------
app.use(cookieParser());
app.use("/api", express.json());

// ---------- UID helpers (X-UID header or cookie 'uid') ----------
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

// ---------- In-memory "DB" (replace with your DB if you like) ----------
/** Map<uid, Set<product>> */
const purchases = new Map();
/** Map<uid, ISODateString> for daily hint usage */
const dailyHintUsedAt = new Map();
/** Map<payment_intent_id, { uid, product }] to support refunds */
const intentIndex = new Map();

// Leaderboards (very simple)
const globalLB = []; // Array<{uid,name,points}>
const regionLB = new Map(); // Map<region, Array<{uid,name,points}>>
function pushScore({ uid, name, points, region = "NA" }) {
  const capName = String(name || "Player").slice(0, 24);
  const pts = Number(points) || 0;

  // Global: keep top 100, dedupe by uid with max points
  {
    const i = globalLB.findIndex((r) => r.uid === uid);
    if (i >= 0) {
      globalLB[i].points = Math.max(globalLB[i].points, pts);
      globalLB[i].name = capName;
    } else {
      globalLB.push({ uid, name: capName, points: pts });
    }
    globalLB.sort((a, b) => b.points - a.points);
    if (globalLB.length > 100) globalLB.length = 100;
  }

  // Region
  {
    const arr = regionLB.get(region) || [];
    const i = arr.findIndex((r) => r.uid === uid);
    if (i >= 0) {
      arr[i].points = Math.max(arr[i].points, pts);
      arr[i].name = capName;
    } else {
      arr.push({ uid, name: capName, points: pts });
    }
    arr.sort((a, b) => b.points - a.points);
    if (arr.length > 100) arr.length = 100;
    regionLB.set(region, arr);
  }
}

// Multiplayer (basic polling)
const rooms = new Map(); // Map<code, { members:Set<uid>, log:Array<{t:number, type:string, from?:uid, data?:any}>, createdAt:number }>
function randomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 4; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

// ---------- Stripe price/product mapping ----------
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
  purchases.set(uid, set);

  // All-Access implies everything
  if (product === "all_access") {
    ["premium", "themes_pack", "survival", "premium_stats", "ad_free", "daily_hint"].forEach((p) =>
      set.add(p)
    );
  }
  // Premium bundle implies all features (keep this if you still want Premium to be a bundle)
  if (product === "premium") {
    ["themes_pack", "premium_stats", "survival", "ad_free"].forEach((p) => set.add(p));
  }
}

function revoke(uid, product) {
  const set = purchases.get(uid);
  if (!set) return;
  if (product === "all_access") {
    ["all_access", "premium", "themes_pack", "survival", "premium_stats", "ad_free", "daily_hint"].forEach(
      (p) => set.delete(p)
    );
  } else {
    set.delete(product);
  }
  purchases.set(uid, set);
}

// what perks look like for the client
function perksFor(uid) {
  const owned = purchases.get(uid) ?? new Set();
  const hasAll = owned.has("all_access");
  const hasPremium = owned.has("premium") || hasAll;

  return {
    active: hasPremium || hasAll,
    owned: [...owned],
    perks: hasPremium || hasAll
      ? { maxRows: 8, winBonus: 5, accent: "#ffb400", themesPack: true }
      : { maxRows: 6, winBonus: 0, accent: undefined, themesPack: owned.has("themes_pack") },
  };
}

// ---------- Routes ----------

// Health
app.get("/api/health", (_req, res) => res.json({ ok: true }));

// Pay: create checkout session
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
      // expand payment_intent on webhook instead
    });

    return res.json({ url: session.url });
  } catch (e) {
    console.error("checkout error", e);
    return res.status(500).json({ error: "checkout-failed" });
  }
});

// Pay: donation link (optional)
app.get("/api/pay/support-link", async (req, res) => {
  try {
    const uid = getOrSetUID(req, res);
    if (!STRIPE_PRICE_DONATION) {
      return res.json({ url: null, error: "donation-price-not-configured" });
    }
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      client_reference_id: uid,
      line_items: [{ price: STRIPE_PRICE_DONATION, quantity: 1 }],
      success_url: `${ALLOWED_ORIGIN}/?donate=success`,
      cancel_url: `${ALLOWED_ORIGIN}/?donate=cancel`,
      metadata: { product: "donation", uid },
    });
    return res.json({ url: session.url });
  } catch (e) {
    console.error("support-link error", e);
    return res.json({ url: null });
  }
});

// Webhook (must use raw body)
app.post(
  "/api/stripe/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
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
          const sessionId = event.data.object.id;
          const session = await stripe.checkout.sessions.retrieve(sessionId, {
            expand: ["line_items.data.price", "payment_intent"],
          });
          const uid = session.client_reference_id || session.metadata?.uid || null;

          let product = session.metadata?.product || null;
          // derive product from first item price id if not provided
          if (!product && session.line_items?.data?.[0]?.price?.id) {
            product = PRICE_TO_PRODUCT.get(session.line_items.data[0].price.id) || null;
          }

          if (uid && product) {
            grant(uid, product);

            // remember for refunds
            const pi = session.payment_intent && (typeof session.payment_intent === "string"
              ? session.payment_intent
              : session.payment_intent.id);
            if (pi) intentIndex.set(pi, { uid, product });

            console.log(`✅ Granted ${product} to uid=${uid}`);
          } else {
            console.warn("⚠️ Missing uid or product in webhook");
          }
          break;
        }

        case "charge.refunded": {
          const charge = event.data.object;
          // payment_intent can be in the charge
          const pi = charge.payment_intent;
          if (pi && intentIndex.has(pi)) {
            const { uid, product } = intentIndex.get(pi);
            revoke(uid, product);
            console.log(`↩️  Revoked ${product} from uid=${uid} due to refund`);
          } else {
            console.log("Refund received but no mapping found for payment_intent:", pi);
          }
          break;
        }

        default:
          // ignore other events
          break;
      }
      return res.json({ received: true });
    } catch (e) {
      console.error("Webhook handler error", e);
      return res.status(500).send("webhook-handler-error");
    }
  }
);

// Status → front-end perks
app.get("/api/pay/status", (req, res) => {
  const uid = getOrSetUID(req, res);
  res.json(perksFor(uid));
});

// Daily free hint (once per calendar day)
app.post("/api/hint/free", (req, res) => {
  const uid = getOrSetUID(req, res);
  const today = new Date().toISOString().slice(0, 10);
  const last = dailyHintUsedAt.get(uid);
  if (last === today) return res.status(429).json({ ok: false, reason: "used" });
  dailyHintUsedAt.set(uid, today);
  return res.json({ ok: true });
});

// -------- Words API (5-letter dictionary) --------
let WORDS5 = null;
try {
  // If you add a large words5.json beside server.js, it’ll be used automatically
  if (fs.existsSync("./words5.json")) {
    const raw = fs.readFileSync("./words5.json", "utf8");
    const list = JSON.parse(raw);
    if (Array.isArray(list)) {
      WORDS5 = list.filter((w) => /^[a-zA-Z]{5}$/.test(String(w || ""))).map((w) => String(w).toLowerCase());
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
  return res.json(FALLBACK5);
});

// -------- Leaderboards --------
app.get("/api/lb/global", (_req, res) => {
  return res.json(globalLB.slice(0, 50));
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
  const arr = regionLB.get(key) || [];
  return res.json(arr.slice(0, 50));
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
  return res.json({ ok: true });
});

// -------- Multiplayer (basic) --------
app.post("/api/mp/create", (req, res) => {
  const uid = getOrSetUID(req, res);
  let code = "";
  for (let i = 0; i < 8; i++) {
    code = randomCode();
    if (!rooms.has(code)) break;
  }
  if (rooms.has(code)) return res.status(500).json({ error: "room-create-failed" });

  rooms.set(code, {
    members: new Set([uid]),
    log: [{ t: Date.now(), type: "system", data: "created" }],
    createdAt: Date.now(),
  });
  return res.json({ room: code });
});

app.post("/api/mp/join", (req, res) => {
  const uid = getOrSetUID(req, res);
  const { room } = req.body || {};
  const r = rooms.get(String(room || "").toUpperCase());
  if (!r) return res.status(404).json({ error: "room-not-found" });
  r.members.add(uid);
  r.log.push({ t: Date.now(), type: "join", from: uid });
  return res.json({ ok: true });
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
  return res.json({ ok: true });
});

app.get("/api/mp/poll", (req, res) => {
  const uid = getOrSetUID(req, res);
  const room = String(req.query.room || "").toUpperCase();
  const since = Number(req.query.since || 0) || 0;
  const r = rooms.get(room);
  if (!r || !r.members.has(uid)) return res.json([]);
  const out = r.log.filter((m) => m.t > since);
  return res.json(out);
});

// --------------- start ---------------
app.listen(PORT, () => {
  console.log(`API listening on :${PORT} (${NODE_ENV})`);
});

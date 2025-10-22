// server.js
// npm i express cors cookie-parser stripe
// OPTIONAL DB: replace the in-memory Maps with your DB upserts.

import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import Stripe from "stripe";
import crypto from "crypto";

const {
  PORT = 3000,
  NODE_ENV = "production",
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  STRIPE_PRICE_PREMIUM,
  STRIPE_PRICE_THEMES,
  STRIPE_PRICE_SURVIVAL,
  STRIPE_PRICE_STATS,
  STRIPE_PRICE_ADFREE,
  STRIPE_PRICE_DAILYHINT,
  ALLOWED_ORIGIN = "https://survive.com",
} = process.env;

if (!STRIPE_SECRET_KEY) {
  console.warn("⚠️  STRIPE_SECRET_KEY missing");
}

const stripe = new Stripe(STRIPE_SECRET_KEY, {
  apiVersion: "2024-12-18.acacia",
});

const app = express();

// CORS
app.use(
  cors({
    origin: ALLOWED_ORIGIN,
    credentials: true,
  })
);

// Cookies
app.use(cookieParser());

// JSON (do NOT apply to webhook route; that one uses express.raw)
app.use("/api", express.json());

// --------- very simple user identification (cookie 'uid') ----------
function getOrSetUID(req, res) {
  let uid = req.cookies?.uid;
  if (!uid) {
    uid = crypto.randomUUID();
    // secure cookie for cross-site
    res.cookie("uid", uid, {
      httpOnly: false, // front-end just needs it sent back; not reading it via JS
      sameSite: "none",
      secure: true,
      path: "/",
      maxAge: 1000 * 60 * 60 * 24 * 365, // 1y
    });
  }
  return uid;
}

// --------- In-memory "DB" (replace with your database) -------------
/** Map<uid, Set<product>> */
const purchases = new Map();
/** Map<uid, ISODateString> for daily hint usage */
const dailyHintUsedAt = new Map();

function grant(uid, product) {
  const set = purchases.get(uid) ?? new Set();
  set.add(product);
  purchases.set(uid, set);
}

function revoke(uid, product) {
  const set = purchases.get(uid);
  if (set) {
    set.delete(product);
    purchases.set(uid, set);
  }
}

// --------- Helpers ------------------------------------------------
const PRICE_TO_PRODUCT = new Map(
  [
    [STRIPE_PRICE_PREMIUM, "premium"],
    [STRIPE_PRICE_THEMES, "themes_pack"],
    [STRIPE_PRICE_SURVIVAL, "survival"],
    [STRIPE_PRICE_STATS, "premium_stats"],
    [STRIPE_PRICE_ADFREE, "ad_free"],
    [STRIPE_PRICE_DAILYHINT, "daily_hint"],
  ].filter(([k]) => !!k)
);

const PRODUCT_TO_PRICE = {
  premium: STRIPE_PRICE_PREMIUM,
  themes_pack: STRIPE_PRICE_THEMES,
  survival: STRIPE_PRICE_SURVIVAL,
  premium_stats: STRIPE_PRICE_STATS,
  ad_free: STRIPE_PRICE_ADFREE,
  daily_hint: STRIPE_PRICE_DAILYHINT,
};

// what “premium” unlocks on the frontend
function perksFor(uid) {
  const owned = purchases.get(uid) ?? new Set();

  const hasPremium = owned.has("premium");
  return {
    active: hasPremium, // treat premium as “active” bundle
    owned: [...owned],
    perks: hasPremium
      ? {
          maxRows: 8,
          winBonus: 5,
          accent: "#ffb400",
          themesPack: true,
        }
      : { maxRows: 6, winBonus: 0, accent: undefined, themesPack: owned.has("themes_pack") },
  };
}

// --------- Routes -------------------------------------------------
app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.post("/api/pay/checkout", async (req, res) => {
  try {
    const uid = getOrSetUID(req, res);
    const { product } = req.body || {};
    const price = PRODUCT_TO_PRICE[product];

    if (!price) {
      return res.status(400).json({ error: "Unknown product" });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      client_reference_id: uid, // so the webhook knows who
      line_items: [{ price, quantity: 1 }],
      success_url: `${ALLOWED_ORIGIN}/?purchase=success`,
      cancel_url: `${ALLOWED_ORIGIN}/?purchase=cancel`,
      // optional redundancy:
      metadata: { product, uid },
    });

    res.json({ url: session.url });
  } catch (e) {
    console.error("checkout error", e);
    res.status(500).json({ error: "checkout-failed" });
  }
});

// Webhook must use the RAW body
app.post(
  "/api/stripe/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("❌ Webhook signature verification failed.", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      switch (event.type) {
        case "checkout.session.completed": {
          // Expand to read price if needed
          const session = await stripe.checkout.sessions.retrieve(
            event.data.object.id,
            { expand: ["line_items.data.price"] }
          );
          const uid =
            session.client_reference_id ||
            session.metadata?.uid ||
            "unknown";

          let product =
            session.metadata?.product || null;

          // derive from the first line item price if metadata not set
          if (!product && session.line_items?.data?.[0]?.price?.id) {
            product = PRICE_TO_PRODUCT.get(
              session.line_items.data[0].price.id
            );
          }

          if (uid && product) {
            grant(uid, product);
            if (product === "premium") {
              // premium implies themes pack + stats + survival + ad_free if you want
              grant(uid, "themes_pack");
              grant(uid, "premium_stats");
              grant(uid, "survival");
              grant(uid, "ad_free");
            }
            console.log(`✅ Granted ${product} to uid=${uid}`);
          } else {
            console.warn("⚠️ Missing uid or product in webhook");
          }
          break;
        }
        case "charge.refunded": {
          const charge = event.data.object;
          // If you store charge->uid/product mapping, revoke here.
          console.log("Refund received for charge", charge.id);
          break;
        }
        default:
          // Ignore the rest
          break;
      }
      res.json({ received: true });
    } catch (e) {
      console.error("Webhook handler error", e);
      res.status(500).send("webhook-handler-error");
    }
  }
);

app.get("/api/pay/status", (req, res) => {
  const uid = getOrSetUID(req, res);
  res.json(perksFor(uid));
});

app.post("/api/hint/free", (req, res) => {
  const uid = getOrSetUID(req, res);
  const last = dailyHintUsedAt.get(uid);
  const today = new Date().toISOString().slice(0, 10);
  if (last === today) return res.status(429).json({ ok: false, reason: "used" });
  dailyHintUsedAt.set(uid, today);
  res.json({ ok: true });
});

// --------------- start ---------------
app.listen(PORT, () => {
  console.log(`API listening on :${PORT} (${NODE_ENV})`);
});

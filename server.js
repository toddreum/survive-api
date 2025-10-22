// server.js
// npm i express cors cookie-parser stripe
// OPTIONAL DB: replace in-memory Maps with your DB upserts.

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
  STRIPE_PRICE_ALLACCESS, // NEW
  ALLOWED_ORIGIN = "https://survive.com",
  SUPPORT_PAYMENT_LINK, // optional: https://buy.stripe.com/...
} = process.env;

if (!STRIPE_SECRET_KEY) {
  console.warn("⚠️  STRIPE_SECRET_KEY missing");
}
const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

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

// ---------- user id helpers ----------
function resolveUID(req, res) {
  // Prefer explicit X-UID from frontend. Fallback to cookie. Finally, mint one.
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

// ---------- in-memory "DB" ----------
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

// ---------- price <-> product ----------
const PRICE_TO_PRODUCT = new Map(
  [
    [STRIPE_PRICE_PREMIUM, "premium"],
    [STRIPE_PRICE_THEMES, "themes_pack"],
    [STRIPE_PRICE_SURVIVAL, "survival"],
    [STRIPE_PRICE_STATS, "premium_stats"],
    [STRIPE_PRICE_ADFREE, "ad_free"],
    [STRIPE_PRICE_DAILYHINT, "daily_hint"],
    [STRIPE_PRICE_ALLACCESS, "all_access"], // NEW
  ].filter(([k]) => !!k)
);

const PRODUCT_TO_PRICE = {
  premium: STRIPE_PRICE_PREMIUM,
  themes_pack: STRIPE_PRICE_THEMES,
  survival: STRIPE_PRICE_SURVIVAL,
  premium_stats: STRIPE_PRICE_STATS,
  ad_free: STRIPE_PRICE_ADFREE,
  daily_hint: STRIPE_PRICE_DAILYHINT,
  all_access: STRIPE_PRICE_ALLACCESS, // NEW
};

// perks aggregator
function perksFor(uid) {
  const owned = purchases.get(uid) ?? new Set();
  const hasPremium = owned.has("premium") || owned.has("all_access");

  return {
    // treat premium or all_access as "active bundle"
    active: hasPremium,
    owned: [...owned],
    perks: hasPremium
      ? {
          maxRows: 8,
          winBonus: 5,
          accent: "#ffb400",
          themesPack: true,
        }
      : {
          maxRows: 6,
          winBonus: 0,
          accent: undefined,
          themesPack: owned.has("themes_pack"),
        },
  };
}

// ---------- Routes ----------
app.get("/api/health", (_req, res) => res.json({ ok: true }));

// Optional: front-end donate helper (if you prefer from API)
app.get("/api/pay/support-link", (_req, res) => {
  if (!SUPPORT_PAYMENT_LINK || !/^https?:\/\//i.test(SUPPORT_PAYMENT_LINK)) {
    return res.status(404).json({ error: "support-link-not-configured" });
  }
  res.json({ url: SUPPORT_PAYMENT_LINK });
});

app.post("/api/pay/checkout", async (req, res) => {
  try {
    const uid = resolveUID(req, res);
    const { product } = req.body || {};
    const price = PRODUCT_TO_PRICE[product];

    if (!price) {
      return res.status(400).json({ error: "Unknown product" });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment", // one-time
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

// Webhook must use the RAW body
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
          const session = await stripe.checkout.sessions.retrieve(event.data.object.id, {
            expand: ["line_items.data.price"],
          });

          const uid = session.client_reference_id || session.metadata?.uid || "unknown";
          let product = session.metadata?.product || null;

          if (!product && session.line_items?.data?.[0]?.price?.id) {
            product = PRICE_TO_PRODUCT.get(session.line_items.data[0].price.id);
          }

          if (uid && product) {
            // grant purchased item
            grant(uid, product);

            if (product === "premium") {
              grant(uid, "themes_pack");
              grant(uid, "premium_stats");
              grant(uid, "survival");
              grant(uid, "ad_free");
            }

            if (product === "all_access") {
              // unlock everything
              grant(uid, "premium");
              grant(uid, "themes_pack");
              grant(uid, "premium_stats");
              grant(uid, "survival");
              grant(uid, "ad_free");
              grant(uid, "daily_hint");
            }

            console.log(`✅ Granted ${product} to uid=${uid}`);
          } else {
            console.warn("⚠️ Missing uid or product in webhook");
          }
          break;
        }

        case "charge.refunded": {
          const charge = event.data.object;
          // If you store charge->(uid,product) mapping, revoke here.
          console.log("Refund received for charge", charge.id);
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
  }
);

app.get("/api/pay/status", (req, res) => {
  const uid = resolveUID(req, res);
  res.json(perksFor(uid));
});

app.post("/api/hint/free", (req, res) => {
  const uid = resolveUID(req, res);
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

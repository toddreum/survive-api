import express from "express";
import cors from "cors";
import Stripe from "stripe";

const app = express();
app.use(cors());
app.use(express.json());

// Health check
app.get("/health", (req, res) => res.json({ ok: true }));

/**
 * POST /api/boost/checkout
 * Body: { playerId: string }
 * Env vars:
 *  - HEALTH_BOOST  (Stripe secret key)
 *  - PRICE_ID      (Stripe Price ID)
 *  - FRONTEND_URL  (https://yourdomain.com)
 */
app.post("/api/boost/checkout", async (req, res) => {
  try {
    const stripeKey = process.env.HEALTH_BOOST;
    if (!stripeKey) return res.status(500).json({ error: "Stripe key not set" });

    const priceId = process.env.PRICE_ID || "price_1SKx5OFDHekJoy7r5qaffevP";
    const frontendUrl = process.env.FRONTEND_URL || "https://yourdomain.com";

    const stripe = new Stripe(stripeKey);
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${frontendUrl}/?boost=success`,
      cancel_url: `${frontendUrl}/?boost=cancel`
    });

    return res.json({ url: session.url });
  } catch (err) {
    console.error("Stripe error:", err);
    res.status(500).json({ error: "Checkout error" });
  }
});

const port = process.env.PORT || 3001;
app.listen(port, () => console.log(`Survive API listening on ${port}`));

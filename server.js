const express = require("express");
const app = express();
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

app.use(express.static("public"));
app.use(express.json());

app.post("/api/create-checkout-session", async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "subscription",
      line_items: [{
        price: process.env.STRIPE_UNLOCK, // Must be an active price ID from Stripe dashboard
        quantity: 1
      }],
      success_url: req.headers.origin + "/?success=true&session_id={CHECKOUT_SESSION_ID}",
      cancel_url: req.headers.origin + "/?canceled=true"
    });
    res.json({ checkoutUrl: session.url });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Survive.com backend running on " + PORT));

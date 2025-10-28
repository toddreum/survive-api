const express = require('express');
const router = express.Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

router.post('/create-checkout-session', async (req, res) => {
  const { playerName, gameId } = req.body;
  const session = await stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    line_items: [{
      price_data: {
        currency: 'usd',
        product_data: {
          name: 'Survive.com Health Boost',
          description: 'Buy 5 points for 99 cents (one per game)',
        },
        unit_amount: 99,
      },
      quantity: 1,
    }],
    mode: 'payment',
    success_url: `https://survive.com/success?gameId=${gameId}&playerName=${playerName}`,
    cancel_url: `https://survive.com/cancel`,
  });
  res.json({ url: session.url });
});

module.exports = router;

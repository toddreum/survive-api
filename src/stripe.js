const express = require('express');
const router = express.Router();
const stripe = require('stripe')(process.env.STRIPE_UNLOCK);

router.post('/create-checkout-session', async (req, res) => {
  const { playerName, gameId } = req.body;
  const session = await stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    line_items: [{
      price: 'price_1SMlCvFDHekJoy7rmlw6R6nK', // Your Stripe Price ID
      quantity: 1,
    }],
    mode: 'payment',
    success_url: `https://survive.com/success?gameId=${gameId}&playerName=${playerName}`,
    cancel_url: `https://survive.com/cancel`,
  });
  res.json({ url: session.url });
});

module.exports = router;

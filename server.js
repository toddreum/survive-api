const express = require('express');
const bodyParser = require('body-parser');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

// Stripe Price ID for monthly sub
const PRICE_ID = process.env.STRIPE_PRICE_ID;

app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.json());

// Create Stripe Checkout session for subscription
app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      line_items: [{price: PRICE_ID, quantity: 1}],
      mode: 'subscription',
      success_url: 'https://survive.com/?subscription=success',
      cancel_url: 'https://survive.com/?subscription=cancel',
    });
    res.json({checkoutUrl: session.url});
  } catch (err) {
    res.status(500).json({error: err.message});
  }
});

// Pro-Christian Conservative Advice API
app.post('/api/advice', (req, res) => {
  const q = (req.body.question||'').toLowerCase();
  let answer = "Seek wisdom from God, stand for truth, live boldly, and let your light shine for Christ in all you do!";
  if (q.includes("jesus") || q.includes("christ")) answer = "Jesus Christ is the way, the truth, and the life. Seek Him daily in prayer and Scripture. Stand firm in your faith and share His love!";
  else if (q.includes("family")) answer = "Put God first, and love your family second only to Him. Build up one another, forgive, encourage, and spend time together!";
  else if (q.includes("life")) answer = "Life is a sacred gift from God. Defend it at every stage, protect the vulnerable, and celebrate every moment.";
  else if (q.includes("freedom")) answer = "Freedom is God-given and precious. Defend free speech, worship, and conscience. Stand for liberty with courage!";
  else if (q.includes("culture")) answer = "Be salt and light in the culture. Stand for truth, call out evil, and always act with love and integrity.";
  else if (q.includes("bible")) answer = "Read your Bible daily, study it with others, and apply it to your life. God's Word is alive and powerful!";
  else if (q.includes("abortion")) answer = "Life begins at conception. Defend the unborn. Support mothers and families with compassion and truth.";
  else if (q.includes("marriage")) answer = "Marriage is a sacred covenant between one man and one woman, designed by God. Honor, protect, and cherish it.";
  else if (q.includes("gender")) answer = "God created male and female. Affirm biblical truth, love all people, and speak with compassion but clarity.";
  else if (q.includes("politics")) answer = "Engage politics as a Christian: seek justice, defend liberty, vote for truth, and pray for your leaders.";
  res.json({answer});
});

// Health check for Render.com
app.get('/health', (req, res) => res.send('OK'));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

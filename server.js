const express = require("express");
const app = express();
const bodyParser = require("body-parser");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
let chatVault = [];
app.use(express.static("public"));
app.use(bodyParser.json({limit: '10mb'}));

// Stripe checkout session
app.post("/api/create-checkout-session", async (req, res) => {
  const session = await stripe.checkout.sessions.create({
    payment_method_types: ["card"],
    mode: "subscription",
    line_items: [{
      price: process.env.STRIPE_UNLOCK,
      quantity: 1
    }],
    success_url: req.headers.origin + "/?success=true",
    cancel_url: req.headers.origin + "/?canceled=true"
  });
  res.json({ checkoutUrl: session.url });
});

// Vaulted chat sync
app.get("/api/chat", (req, res) => {
  res.json({ messages: chatVault.slice(-50) });
});
app.post("/api/chat", (req, res) => {
  const { to, msg } = req.body;
  chatVault.push({ to, msg, time: new Date().toISOString() });
  res.json({ ok: true });
});

// Contact Us form email endpoint -- HOW TO SET UP EMAIL:
// 1. Integrate with SendGrid, Nodemailer, or Mailgun, using your API key (not included here for security).
// 2. Replace the demo response with your mail-sending code.
// 3. Example with Nodemailer:
//    const nodemailer = require('nodemailer');
//    let transporter = nodemailer.createTransport({ ... });
//    transporter.sendMail({ to: 'support@survive.com', subject: 'Contact Form', text: req.body.message });
// 4. Demo only (does NOT send email):
app.post("/api/contact", (req, res) => {
  // TODO: Integrate with real email provider (SendGrid, Nodemailer, Mailgun)
  // For now, just returns ok
  res.json({ ok: true });
});

// Vaulted uploads (images/notes) - demo only
app.post("/api/vault-upload", (req, res) => {
  res.json({ ok: true });
});

app.get("/service-worker.js", (req,res) => {
  res.sendFile(__dirname + "/public/service-worker.js");
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Survive.com backend running on " + PORT));

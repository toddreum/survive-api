const express = require('express');
const nodemailer = require('nodemailer');
const path = require('path');
const app = express();

const PORT = process.env.PORT || 8080;

// Serve static files from /public
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Contact form endpoint
app.post('/api/contact', async (req, res) => {
  const { name, email, msg } = req.body;
  try {
    let transporter = nodemailer.createTransport({
      host: 'mail.survive.com',
      port: 587,
      secure: false,
      auth: {
        user: 'support@survive.com',
        pass: process.env.CPANEL_EMAIL_PASS // Set this in Render environment variables
      }
    });
    await transporter.sendMail({
      from: `"${name}" <${email}>`,
      to: 'support@survive.com',
      subject: 'Contact Us Form Submission',
      text: msg,
      html: `<b>From:</b> ${name} (${email})<br><b>Message:</b><br>${msg}`
    });
    res.json({ status: "Thank you for contacting support! We'll reply soon." });
  } catch (e) {
    res.json({ status: "Sorry, could not send email. Try again later." });
  }
});

// Example AI advice endpoint (replace logic as needed)
app.post('/api/advice', (req, res) => {
  res.json({ answer: "This is a placeholder. Connect to AI backend as needed." });
});

// Catch-all route for SPA (serves index.html for any GET request not handled above)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

const express = require('express');
const nodemailer = require('nodemailer');
const app = express();
app.use(express.json());

app.post('/api/contact', async (req, res) => {
  const {name, email, msg} = req.body;
  try {
    let transporter = nodemailer.createTransport({
      host: 'mail.survive.com',
      port: 587,
      secure: false,
      auth: {
        user: 'support@survive.com',
        pass: process.env.CPANEL_EMAIL_PASS // Set this in your Render environment
      }
    });
    await transporter.sendMail({
      from: `"${name}" <${email}>`,
      to: 'support@survive.com',
      subject: 'Contact Us Form Submission',
      text: msg,
      html: `<b>From:</b> ${name} (${email})<br><b>Message:</b><br>${msg}`
    });
    res.json({status: "Thank you for contacting support! We'll reply soon."});
  } catch (e) {
    res.json({status: "Sorry, could not send email. Try again later."});
  }
});

// ...other endpoints as needed...

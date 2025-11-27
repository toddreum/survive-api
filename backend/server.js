import express from "express";
import nodemailer from "nodemailer";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Parse form data
app.use(express.urlencoded({ extended: true }));

// Serve static files (index.html, logo.png, etc.) from /public
app.use(express.static(path.join(__dirname, "public")));

// Configure nodemailer transport using environment variables
// Set these in Render dashboard: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// Simple health check
app.get("/health", (req, res) => {
  res.send("OK");
});

// Webmail endpoint – ALWAYS sends to support@survive.com
app.post("/webmail", async (req, res) => {
  const { name = "", email = "", message = "" } = req.body;

  if (!name || !email || !message) {
    return res.status(400).send("Missing required fields");
  }

  const safeName = String(name).slice(0, 200);
  const safeEmail = String(email).slice(0, 200);
  const safeMessage = String(message).slice(0, 5000);

  const mailOptions = {
    from: `"Survive.com Webmail" <${process.env.SMTP_USER}>`, // from your SMTP account
    to: "support@survive.com", // forced recipient
    subject: `New message from Survive.com – ${safeName}`,
    text: `From: ${safeName} <${safeEmail}>\n\n${safeMessage}`,
    replyTo: safeEmail,
  };

  try {
    await transporter.sendMail(mailOptions);

    // If request came from fetch, send simple OK
    if (req.headers["accept"]?.includes("application/json")) {
      return res.json({ ok: true });
    }

    res.send("OK");
  } catch (err) {
    console.error("Error sending mail:", err);
    res.status(500).send("Error sending mail");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Survive.com server running on port ${PORT}`);
});

/**
 * Survive — Aardvark Call Chain
 * PRODUCTION-GRADE SERVER.JS
 * -------------------------------------------
 * Features:
 * - Static file serving
 * - Reverse proxy for /api to survive-api.onrender.com
 * - Helmet security headers
 * - CORS configuration
 * - Compression
 * - Request logging
 * - Rate limiting (optional)
 * - Error handling middleware
 * - Health check endpoint
 * - Graceful shutdown
 * -------------------------------------------
 */

require("dotenv").config();

const express = require("express");
const path = require("path");
const helmet = require("helmet");
const cors = require("cors");
const compression = require("compression");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const { createProxyMiddleware } = require("http-proxy-middleware");

const app = express();

const PORT = process.env.PORT || 3000;
const API_TARGET = "https://survive-api.onrender.com";

// --------------------------------------------------
// SECURITY HEADERS
// --------------------------------------------------
app.use(
  helmet({
    contentSecurityPolicy: false, // allow client.js inline dynamic DOM
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: false,
  })
);

// --------------------------------------------------
// CORS SETUP
// --------------------------------------------------
app.use(
  cors({
    origin: "*", // adjust if needed
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// --------------------------------------------------
// BODY PARSER + COMPRESSION
// --------------------------------------------------
app.use(express.json({ limit: "2mb" }));
app.use(compression());

// --------------------------------------------------
// ACCESS LOGGING
// --------------------------------------------------
app.use(morgan("combined"));

// --------------------------------------------------
// RATE LIMITING FOR /api
// --------------------------------------------------
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 180, // 180 calls/min per IP
  message: { error: "Too many API requests, slow down." },
});
app.use("/api", apiLimiter);

// --------------------------------------------------
// STATIC FILES
// --------------------------------------------------
const publicDir = path.join(__dirname, "public");

app.use(
  express.static(publicDir, {
    maxAge: "1d",
    etag: true,
    lastModified: true,
    setHeaders(res) {
      res.setHeader("Cache-Control", "public, max-age=86400");
    },
  })
);

// --------------------------------------------------
// HEALTH CHECK
// --------------------------------------------------
app.get("/health", (req, res) => {
  res.json({ status: "ok", uptime: process.uptime(), time: Date.now() });
});

// --------------------------------------------------
// REVERSE PROXY FOR /api
// --------------------------------------------------
app.use(
  "/api",
  createProxyMiddleware({
    target: API_TARGET,
    changeOrigin: true,
    secure: true,
    timeout: 8000,
    proxyTimeout: 8000,
    pathRewrite: {
      "^/api": "/api",
    },

    onError(err, req, res) {
      console.error("Proxy error:", err.message);
      res.status(502).json({ error: "API unreachable" });
    },

    onProxyReq(proxyReq, req, _res) {
      proxyReq.setHeader("x-survive-proxy", "active");
      console.log(
        `→ Proxying ${req.method} ${req.originalUrl} to ${API_TARGET}`
      );
    },

    onProxyRes(proxyRes, req, _res) {
      console.log(
        `← API responded ${proxyRes.statusCode} for ${req.method} ${req.originalUrl}`
      );
    },
  })
);

// --------------------------------------------------
// SPA FALLBACK — ALWAYS SERVE index.html
// --------------------------------------------------
app.get("*", (req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

// --------------------------------------------------
// ERROR HANDLER
// --------------------------------------------------
app.use((err, req, res, next) => {
  console.error("Server error:", err);
  res.status(500).json({
    error: "Internal server error",
    message: err.message || "Unknown error",
  });
});

// --------------------------------------------------
// START SERVER
// --------------------------------------------------
const server = app.listen(PORT, () => {
  console.log(`Survive server is running on port ${PORT}`);
});

// --------------------------------------------------
// GRACEFUL SHUTDOWN
// --------------------------------------------------
function shutdown() {
  console.log("Shutting down server gracefully...");
  server.close(() => {
    console.log("Closed out remaining connections.");
    process.exit(0);
  });

  // Force quit after 10s
  setTimeout(() => {
    console.error("Could not close connections in time, forcing shutdown.");
    process.exit(1);
  }, 10000);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// server.js
// Aardvark Call Chain Arena backend
// - Serves the front-end from /public
// - Proxies /api/* to https://survive-api.onrender.com (or BASE_API_URL env)
//
// Requires Node 18+ for global fetch.

const express = require("express");
const path = require("path");
const cors = require("cors");

const app = express();

// --- Basic config ----------------------------------------------------

const PORT = process.env.PORT || 3000;
const BASE_API_URL =
  process.env.BASE_API_URL || "https://survive-api.onrender.com";

// --- Middleware ------------------------------------------------------

// Simple request logger (minimal, but helpful)
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - start;
    console.log(
      `[${new Date().toISOString()}] ${req.method} ${req.originalUrl} ${res.statusCode} - ${ms}ms`
    );
  });
  next();
});

// Body parsing for JSON (used if front-end posts to /api via this server)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS: allow front-end origin(s). For local dev, this is usually fine:
app.use(
  "/api",
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"]
  })
);

// --- Health check ----------------------------------------------------

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    message: "Aardvark Call Chain Arena server is running.",
    backend: BASE_API_URL
  });
});

// --- API proxy -------------------------------------------------------
// Any request to /api/* is forwarded to BASE_API_URL + same path.
// For example: /api/scores -> https://survive-api.onrender.com/api/scores

app.all("/api/*", async (req, res) => {
  try {
    // Strip the "/api" prefix and forward the remainder
    const targetPath = req.originalUrl.replace(/^\/api/, "");
    const targetUrl = `${BASE_API_URL}${targetPath}`;

    // Build init/options for fetch
    const headers = { ...req.headers };
    delete headers.host; // host should not be forwarded directly

    const init = {
      method: req.method,
      headers
    };

    // Attach body for methods that support it
    if (req.method !== "GET" && req.method !== "HEAD") {
      // For JSON or urlencoded, express has already parsed into req.body
      if (req.is("application/json")) {
        init.body = JSON.stringify(req.body);
      } else if (req.is("application/x-www-form-urlencoded")) {
        // Rebuild form-encoded body if needed
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(req.body || {})) {
          params.append(key, value);
        }
        init.body = params.toString();
      } else {
        // Fallback: raw text (if you add raw body handling)
        // For now, we leave it out.
      }
    }

    const upstreamResponse = await fetch(targetUrl, init);

    // Forward status code
    res.status(upstreamResponse.status);

    // Forward headers (selectively, to avoid issues)
    upstreamResponse.headers.forEach((value, key) => {
      if (key.toLowerCase() === "transfer-encoding") return;
      res.setHeader(key, value);
    });

    const buffer = await upstreamResponse.arrayBuffer();
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error("Error proxying /api request:", err);
    res.status(502).json({
      error: "Bad gateway",
      message: "Failed to reach backend service.",
      detail: err.message
    });
  }
});

// --- Static front-end ------------------------------------------------

const publicPath = path.join(__dirname, "public");
app.use(express.static(publicPath));

// For SPA routing: any non-API, non-health route falls back to index.html
app.get("*", (req, res) => {
  res.sendFile(path.join(publicPath, "index.html"));
});

// --- Start server ----------------------------------------------------

app.listen(PORT, () => {
  console.log("==========================================");
  console.log(" Aardvark Call Chain Arena server started ");
  console.log(` Port       : ${PORT}`);
  console.log(` Backend API: ${BASE_API_URL}`);
  console.log("==========================================");
});

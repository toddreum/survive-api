// server.js
// Survive - Aardvark Call Chain Arena backend
// - Serves front-end from /public
// - Proxies /api/* to https://survive-api.onrender.com (or BASE_API_URL)
//
// Requires Node 18+ for global fetch.

const express = require("express");
const path = require("path");
const cors = require("cors");

const app = express();

// --- Config -----------------------------------------------------------

const PORT = process.env.PORT || 3000;
const BASE_API_URL =
  process.env.BASE_API_URL || "https://survive-api.onrender.com";

// --- Middleware -------------------------------------------------------

// Simple logger
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

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS only on /api
app.use(
  "/api",
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"]
  })
);

// --- Health check -----------------------------------------------------

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    message: "Survive server is running.",
    backend: BASE_API_URL
  });
});

// --- API proxy --------------------------------------------------------
//
// /api/game/animals     -> BASE_API_URL + /api/game/animals
// /api/game/session     -> BASE_API_URL + /api/game/session
// /api/game/leaderboard -> BASE_API_URL + /api/game/leaderboard
//
app.all("/api/*", async (req, res) => {
  try {
    const targetPath = req.originalUrl.replace(/^\/api/, "");
    const targetUrl = `${BASE_API_URL}${targetPath}`;

    const headers = { ...req.headers };
    delete headers.host;

    const init = {
      method: req.method,
      headers
    };

    if (req.method !== "GET" && req.method !== "HEAD") {
      if (req.is("application/json")) {
        init.body = JSON.stringify(req.body);
      } else if (req.is("application/x-www-form-urlencoded")) {
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(req.body || {})) {
          params.append(key, value);
        }
        init.body = params.toString();
      }
    }

    const upstreamResponse = await fetch(targetUrl, init);
    res.status(upstreamResponse.status);

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

// --- Static front-end -------------------------------------------------

const publicPath = path.join(__dirname, "public");
app.use(express.static(publicPath));

// SPA fallback
app.get("*", (req, res) => {
  res.sendFile(path.join(publicPath, "index.html"));
});

// --- Start ------------------------------------------------------------

app.listen(PORT, () => {
  console.log("======================================");
  console.log(" Survive - Aardvark Arena server up ");
  console.log(` Port       : ${PORT}`);
  console.log(` Backend API: ${BASE_API_URL}`);
  console.log("======================================");
});

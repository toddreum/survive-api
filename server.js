// server.js
// Express server for Survive — serves static front-end and proxies API calls
// to https://survive-api.onrender.com

const express = require("express");
const path = require("path");
const { createProxyMiddleware } = require("http-proxy-middleware");

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static assets from /public
const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir));

// Proxy /api/* to survive-api backend
app.use(
  "/api",
  createProxyMiddleware({
    target: "https://survive-api.onrender.com",
    changeOrigin: true,
    pathRewrite: {
      "^/api": "/api" // /api/... -> /api/... on survive-api
    },
    onProxyReq(proxyReq) {
      // Optionally add custom headers/logging here
    }
  })
);

// Fallback: always send index.html for SPA-style routing
app.get("*", (req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

app.listen(PORT, () => {
  console.log(`Survive server listening on port ${PORT}`);
});

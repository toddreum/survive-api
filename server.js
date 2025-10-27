const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

// Optional: Logging middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Serve static files from public_html
app.use(express.static(path.join(__dirname, 'public_html')));

// Serve manifest and SVG icon explicitly (for PWA/app install)
app.get('/manifest.json', (req, res) => {
  res.sendFile(path.join(__dirname, 'public_html/manifest.json'));
});
app.get('/icon.svg', (req, res) => {
  res.sendFile(path.join(__dirname, 'public_html/icon.svg'));
});

// Example API endpoint for future expansion (uncomment to use)
// app.get('/api/ping', (req, res) => {
//   res.json({status: "ok", time: new Date().toISOString()});
// });

// SPA fallback: always return index.html for unknown routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public_html/index.html'));
});

app.listen(PORT, () => {
  console.log(`Survive.com (Node.js) listening on port ${PORT}`);
});

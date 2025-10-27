const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files from public folder
app.use(express.static(path.join(__dirname, 'public')));

// Serve manifest and SVG icon explicitly (for PWA/app install)
app.get('/manifest.json', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/manifest.json'));
});
app.get('/icon.svg', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/icon.svg'));
});

// SPA fallback: always return index.html for unknown routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/index.html'));
});

app.listen(PORT, () => {
  console.log(`Survive.com (Node.js) listening on port ${PORT}`);
});

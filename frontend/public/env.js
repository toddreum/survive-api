// frontend/public/env.js
// At runtime this will usually be overwritten by your build/deploy process.
// Default behavior: in the browser, prefer the current page origin so production works
// without requiring build-time env vars. For local dev, set this file to http://localhost:3000

(function() {
  // If Render or your static-site pipeline writes a concrete backend URL, it can set window.__BACKEND_URL__.
  // Otherwise default to the current origin (works for https://survive.com and local testing).
  try {
    if (typeof window !== 'undefined') {
      if (!window.__BACKEND_URL__ || !window.__BACKEND_URL__.length) {
        window.__BACKEND_URL__ = window.location && window.location.origin ? window.location.origin : 'https://survive.com';
      }
    }
  } catch (e) {
    // fallback
    if (typeof window !== 'undefined') {
      window.__BACKEND_URL__ = 'https://survive.com';
    }
  }
})();

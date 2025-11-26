// frontend/public/env.js
// Ensure production frontend does NOT force localhost as the backend.
// Defaults to current page origin (works on Render and locally).
(function() {
  try {
    if (typeof window !== 'undefined') {
      if (!window.__BACKEND_URL__ || !window.__BACKEND_URL__.length) {
        window.__BACKEND_URL__ = (window.location && window.location.origin) ? window.location.origin : 'https://survive.com';
      }
    }
  } catch (e) {
    if (typeof window !== 'undefined') {
      window.__BACKEND_URL__ = 'https://survive.com';
    }
  }
})();

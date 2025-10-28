import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Proxy /api/* to backend in local dev (backend runs at repo root on :3001)
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true
      },
      '/health': {
        target: 'http://localhost:3001',
        changeOrigin: true
      }
    }
  }
})

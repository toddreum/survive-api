# Hide To Survive — Voxel Prototype

This repo includes a prototype browser voxel demo integrated with capture & shield gameplay.

Local run (backend):
- cd backend
- npm install
- npm start
- Open http://localhost:3000

Env (Render):
- FRONTEND_ORIGINS: allowed origins (comma separated)
- FRONTEND_URL: public URL for create-room links

How to test (quick):
- Open site, open DevTools Console (look for BACKEND_URL)
- JOIN MATCH in two windows, click the canvas to lock pointer and use WASD/mouse to move
- Q to place block, R to remove block, E to pickup shield, SHOOT button to fire
- Server logs show join, blockPlace, playerCaptured, shield events

Notes:
- This is an in-memory prototype — chunk state is not persisted across server restarts.
- For production: add persistent chunk storage, server authoritative physics, anti-cheat, and optimized mesh generation.

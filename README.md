# Hide To Survive – Voxel Prototype

Node.js + Socket.io authoritative server with browser-based voxel rendering for **Hide To Survive**, a 3D multiplayer hide & seek game with capture/shield gameplay mechanics.

## Features

- **Voxel World**: Chunked voxel rendering with greedy meshing for performance
- **First-Person Controls**: WASD movement, mouse look, jump, and basic collision
- **Block Placement/Removal**: Build and destroy blocks with a hotbar system
- **Multiplayer**: Real-time synchronization with Socket.io (polling transport)
- **Capture/Shield Gameplay**: 
  - Seekers capture hiders by proximity and hold time
  - Shield pickups block attacks with durability system
  - Shields spawn as world items
- **Room System**: Create private rooms with invite codes

## Run Locally

### Backend

```bash
cd backend
npm install
npm start
```

The server will start on port 3000 (or the `PORT` environment variable).

### Frontend

The frontend is served by the backend server. Visit:

```
http://localhost:3000
```

No separate frontend build step is required. The frontend uses CDN-hosted libraries (Three.js, Socket.io).

## Deploy to Render

### Backend Service

1. **Create a new Web Service** on [Render](https://render.com)
2. **Connect your GitHub repository** (toddreum/survive-api)
3. **Configure the service**:
   - **Name**: `survive-api` (or your preferred name)
   - **Region**: Choose closest to your users
   - **Branch**: `feature/voxel-prototype` (or `main` after merge)
   - **Root Directory**: `backend`
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: Free or Starter

4. **Environment Variables** (see below)

5. **Deploy**: Render will automatically deploy on every push to the branch

### Environment Variables

Configure these in Render Dashboard → Environment:

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `PORT` | Server port | `3000` | No (Render sets automatically) |
| `FRONTEND_ORIGINS` | Comma-separated allowed CORS origins | See below | Recommended |
| `FRONTEND_URL` | Base URL for invite links | Same as server | No |
| `DATA_FILE` | Path to persistence file | `./persist.json` | No |
| `CAPTURE_DISTANCE` | Distance for capture (units) | `2.0` | No |
| `CAPTURE_HOLD_MS` | Time to hold for capture (ms) | `1500` | No |
| `SHIELD_DURABILITY` | Shield hit points | `3` | No |

**Example `FRONTEND_ORIGINS`**:
```
https://survive-api.onrender.com,https://survive.com,https://www.survive.com
```

If not set, defaults to:
```
http://localhost:3000,http://127.0.0.1:3000,https://survive.com,https://www.survive.com
```

## Testing Instructions

### 1. Health Check

```bash
curl http://localhost:3000/health
```

Expected response:
```json
{
  "status": "ok",
  "now": 1234567890123
}
```

### 2. Create Room

```bash
curl -X POST http://localhost:3000/create-room -H "Content-Type: application/json"
```

Expected response:
```json
{
  "ok": true,
  "roomId": "ABC123",
  "url": "http://localhost:3000/?room=ABC123"
}
```

### 3. Test Voxel Rendering

1. Open `http://localhost:3000` in a browser
2. Enter a player name (use `#` suffix for single-word names, e.g., `Player#1234`)
3. Click **JOIN MATCH**
4. You should see:
   - Voxel world rendered with Three.js
   - Sky blue background with fog
   - Flat grass terrain
   - First-person camera
5. **Controls**:
   - **WASD**: Move
   - **Mouse**: Look around (click canvas to lock pointer)
   - **Space**: Jump
   - **Left Click**: Remove block
   - **Right Click**: Place block
   - **1-5**: Select block type in hotbar

### 4. Test Multiplayer

1. Open two browser windows/tabs
2. In first window:
   - Enter name `Alice#1111`
   - Click **Create Room** and copy room code
   - Click **JOIN MATCH**
3. In second window:
   - Enter name `Bob#2222`
   - Paste room code in **Room** field
   - Click **JOIN MATCH**
4. Verify:
   - Both clients connect (check browser console: "Connected", "BACKEND_URL =")
   - Position updates (players see each other's movements)
   - Block placement/removal syncs between clients
   - HUD shows "Players: 2"

### 5. Test Capture Mechanics

1. Set one player as seeker (currently manual in server code; will auto-assign in future)
2. Move seeker within 2 units of hider
3. Hold position for 1.5 seconds
4. Verify:
   - Console logs: `playerCaptured` with player IDs
   - Hider receives `becameSeeker` event
   - Seeker receives `captured` event
   - Roles swap

### 6. Test Shield System

1. Shield spawns automatically on room join (check server logs: "Shield spawned in...")
2. Move player near shield pickup
3. Emit `pickup` event with shield `itemId`
4. Verify:
   - Console logs: `shieldPicked` with player ID
   - Player receives `shieldPickedUp` event
   - HUD shows "Shield: 3"
5. Have seeker shoot player with shield:
   - Shield durability decreases
   - After 3 hits, shield is destroyed
   - Console logs: `shieldHit` and `shieldDestroyed`

## Architecture

### Backend (`backend/server.js`)

- **Express** serves static frontend and REST endpoints
- **Socket.io** handles real-time events with polling transport (proxy-safe)
- **In-memory chunk storage**: `Map<"cx,cz", chunk>` (not persisted; resets on restart)
- **Room state**: `Map<roomId, { players, shields, captureTimers }>`
- **Capture timer**: Checks distance every position update; triggers after hold time
- **Shield system**: World items with durability; blocks attacks until destroyed

### Frontend

#### `frontend/public/initVoxel.js`

- **Chunked voxel renderer** with Three.js
- **Greedy meshing**: Combines adjacent faces to reduce geometry
- **Texture atlas**: 256x256 PNG with 16x16 tiles for block types
- **First-person controls**: Pitch/yaw camera, WASD movement, jump physics
- **Block interaction**: Raycasting for placement/removal
- **Hotbar**: 5 block types, keyboard shortcuts 1-5

#### `frontend/public/game.js`

- **Socket.io client** with polling-only transport
- **Join flow**: Name validation, room creation, auto-reconnect
- **Event handlers**: `chunkData`, `blockUpdate`, capture/shield events
- **Position emit loop**: 10 Hz updates to server
- **HUD updates**: Role, shield status, player count

#### `frontend/public/env.js`

- Sets `window.__BACKEND_URL__` for frontend-backend communication
- Defaults to `window.location.origin` (works for Render, local dev)

## Known Limitations (Prototype)

- **Chunk persistence**: In-memory only; chunks reset on server restart
- **Chunk generation**: Simple flat world; no terrain generation
- **Collision**: Ground plane only (y <= 1); no block collision yet
- **Shield pickup**: Manual event emit required; no automatic proximity detection
- **Seeker assignment**: Manual in code; no automatic round start

## Development Roadmap

- [ ] Add block collision detection
- [ ] Implement terrain generation (hills, caves)
- [ ] Add chunk persistence (SQLite/PostgreSQL)
- [ ] Auto-assign seeker on round start
- [ ] Add proximity-based shield pickup
- [ ] Optimize greedy meshing (chunk borders, culling)
- [ ] Add more block types and textures
- [ ] Implement inventory system
- [ ] Add sound effects and music
- [ ] Mobile touch controls

## License

Proprietary - © Survive.com 2025

## Support

For issues or questions, use the in-app **Support** link or contact via GitHub issues.

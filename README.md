# Hide To Survive – Backend

Node.js + Socket.io authoritative server for **Hide To Survive**, a 3D multiplayer hide & seek game with server-authoritative capture mechanics, shields, and real-time gameplay.

## Features

- **Server-Authoritative Gameplay**: Position updates, capture mechanics, and shield system managed by server
- **Capture Mechanics**: Seeker must stay within 3.0 units for 800ms to capture a hider
- **Shield System**: Pickup shields with durability (3 hits) and time-based expiry (15 seconds)
- **Role Swapping**: When captured, hider becomes seeker and vice versa
- **Real-time Updates**: Game tick at 150ms intervals for smooth gameplay
- **Session Persistence**: Auto-reconnect and auto-join from saved session
- **Polling-First Socket.IO**: Works reliably behind proxies and load balancers

## Development

### Prerequisites

- Node.js >= 16
- npm

### Run Locally

1. Install backend dependencies:
```bash
cd backend
npm install
```

2. Start the server:
```bash
npm start
```

3. Open your browser to `http://localhost:3000`

### Environment Variables

- `PORT` - Server port (default: 3000)
- `FRONTEND_ORIGINS` - Comma-separated list of allowed CORS origins (default: localhost:3000, 127.0.0.1:3000, survive.com, www.survive.com)
- `FRONTEND_URL` - Frontend URL for generating invite links (default: derived from request)
- `DATA_FILE` - Path to persistence file (default: backend/persist.json)

## Testing

### Test Health Endpoint

```bash
curl -sS http://localhost:3000/health
```

Expected response:
```json
{"status":"ok","now":1234567890}
```

### Test Join Flow

1. Open the site at `http://localhost:3000`
2. Enter a name (with # suffix for single-word names, e.g., `Todd#1234`)
3. Click **JOIN MATCH**
4. Check browser console for:
   - `[client] BACKEND_URL = ...`
   - `[socket] connected`
   - `[client] joinGame ack received`
   - `[client] joinedRoom event received`
5. Check server logs for:
   - `[server] joinGame received`
   - `[server] joinedRoom emitted`

### Test Position Updates and Capture

1. Open two browser windows/tabs
2. Join the same room in both windows
3. Open browser console in both windows
4. Simulate position updates by typing:
   ```javascript
   window.playerPosition = { x: 1, y: 0, z: 1 };
   ```
5. The first player will be the seeker, second will be a hider
6. Move positions closer (within 3.0 units) and hold for 800ms
7. Observe server logs for `[server] playerCaptured`
8. Observe client events: `captured`, `becameSeeker`, `becameHider`

### Test Shield Mechanics

1. To test shields, you'll need to spawn shield items via server console or API
2. Use the `pickup` event to test shield pickup
3. Use the `shoot` event to test shield durability
4. Observe `shieldPicked`, `shieldHit`, and `shieldDestroyed` events

## Deployment

### Deploy to Render

1. Create a new Web Service on Render
2. Connect your GitHub repository
3. Configure:
   - **Build Command**: `cd backend && npm install`
   - **Start Command**: `cd backend && npm start`
   - **Environment Variables**:
     - `FRONTEND_ORIGINS`: Your production domain (e.g., `https://survive.com,https://www.survive.com`)
     - `FRONTEND_URL`: Your production URL (e.g., `https://survive.com`)
4. Deploy

### Post-Deployment

- Test the `/health` endpoint
- Verify CORS configuration by checking browser console for CORS errors
- Test join flow from production domain

## Game Mechanics

### Capture System

- **Distance**: Seeker must be within 3.0 units of a hider
- **Hold Time**: Seeker must stay within range for 800ms
- **Result**: Role swap - captured hider becomes seeker, seeker becomes hider
- **Scoring**: Seeker gains +1 score when capturing

### Shield System

- **Duration**: 15 seconds from pickup
- **Durability**: Blocks 3 dart hits
- **Expiry**: Shield expires after time runs out OR durability reaches 0
- **Pickup**: Player must be within 5.0 units of shield item

### Player State

Each player has:
- Position (x, y, z)
- Role (seeker or hider)
- Score
- Shield status (active/inactive, durability)
- Last update timestamp

### Game Tick

Server runs game logic at 150ms intervals:
1. Prune stale players (30s timeout)
2. Process shield expiry
3. Check capture conditions
4. Emit state updates to all clients

## Architecture

### Backend (Node.js + Socket.IO)

- `backend/server.js` - Main server with game logic
- `backend/package.json` - Dependencies

**REST Endpoints**:
- `GET /health` - Health check
- `POST /create-room` - Create invite room
- `POST /support` - Submit support message

**Socket Events** (server emits):
- `joinedRoom` - Player successfully joined
- `joinError` - Join failed
- `stateUpdate` - Game state snapshot
- `captured` - Player was captured
- `becameSeeker` - You are now seeker
- `becameHider` - You are now hider
- `shieldPicked` - Shield picked up
- `shieldHit` - Shield was hit
- `shieldDestroyed` - Shield expired/destroyed
- `playerJoined` - Another player joined
- `playerLeft` - Player disconnected

**Socket Events** (client emits):
- `joinGame` - Join with name and room
- `pos` - Position update
- `pickup` - Pickup item
- `shoot` - Shoot tranquilizer dart

### Frontend

- `frontend/public/index.html` - Main HTML
- `frontend/public/style.css` - Styles
- `frontend/public/env.js` - Environment config
- `frontend/public/game.js` - Main game client
- `frontend/public/initThree.js` - Three.js initialization helper
- `frontend/public/logo.svg` - Fallback logo

## Future: Migration to Unreal/Unity

### TODO for Engine Migration

1. **Replace initThree.js with engine-specific code**:
   - Use Unreal's Blueprint system or Unity's C# scripts
   - Implement same camera, lighting, and scene setup
   - Use engine's networking (Unreal's Online Subsystem or Unity's Netcode)

2. **Asset Migration**:
   - Replace placeholder cube models with proper character models
   - Import environment assets (buildings, props, terrain)
   - Add particle effects for tranquilizer darts
   - Add shield visual effect (glow, force field)
   - Import UI textures and fonts

3. **Networking Layer**:
   - Option A: Keep Socket.IO for web builds
   - Option B: Replace with engine's native networking
   - Maintain same event structure for compatibility

4. **Player Controller**:
   - First-person or third-person character controller
   - Movement with WASD/controller
   - Look with mouse/right stick
   - Shoot with click/trigger
   - Pickup with E/button

5. **Game Logic**:
   - Port capture distance checking to engine
   - Implement visual capture progress bar
   - Add shield visual indicator
   - Add tranquilizer dart projectile
   - Add hit detection and effects

### Asset Notes

**Current placeholders to replace**:
- Cubes in `initThree.js` → Character models (seeker/hider)
- Ground plane → Detailed environment mesh
- No shield model → Glowing shield pickup and player shield effect
- No dart model → Tranquilizer dart projectile model

**Required assets**:
- Character models with animations (idle, walk, run, shoot, captured)
- Environment models (city block, forest, mall, bunker themes)
- Particle effects (dart trail, hit effect, shield break)
- UI elements (HUD, crosshair, shields indicator)
- Sound effects (footsteps, dart fire, shield hit, capture)
- Music (ambient background tracks for each map)

### Engine-Specific Notes

**Unreal Engine**:
- Use Online Subsystem for Steam/EOS integration
- Implement Enhanced Input System
- Use Niagara for particle effects
- Use UMG for UI/HUD

**Unity**:
- Use Netcode for GameObjects or Mirror
- Implement New Input System
- Use Particle System or VFX Graph
- Use Unity UI or TextMeshPro for HUD

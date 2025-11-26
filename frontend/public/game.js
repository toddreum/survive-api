// Full client game logic for Photon Phase (Laser-Tag) mode.
// - Online via socket.io with robust reconnection + offline local-bots fallback
// - HUD: points, charge, Phase button, Show Hides toggle
// - Shooting: all players can shoot; left-click or SHOOT button triggers shoot
// - Phase activation: client sends usePhase, renderer receives phaseActivated event and sets local flag
// - Spawn protection + stunned UI handled via stateUpdate/playerHit events
// - Integrates with window.VoxelWorld renderer (instanced + human models). Defensive: if renderer missing, still works partly.
//
// Replace frontend/public/game.js with this full file and hard-refresh the page.

(function () {
  const BACKEND_URL = (typeof window !== 'undefined' && window.__BACKEND_URL__ && window.__BACKEND_URL__.length)
    ? window.__BACKEND_URL__ : (typeof window !== 'undefined' && window.location && window.location.origin ? window.location.origin : 'https://survive.com');

  const SESSION_KEY = 'survive.session.v1';
  const POS_SEND_MS = 120;
  const DEFAULT_BOT_COUNT = 8;

  function $ (id) { return document.getElementById(id); }
  function toast (msg, ms = 1800) { const el = $('connectionStatus'); if (!el) return; const prev = el.textContent; el.textContent = msg; if (ms) setTimeout(() => el.textContent = prev, ms); }

  // session helpers
  function saveSession(obj) { try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(obj || {})); } catch (e) {} }
  function loadSession() { try { const s = sessionStorage.getItem(SESSION_KEY); return s ? JSON.parse(s) : null; } catch (e) { return null; } }
  function clearSession() { try { sessionStorage.removeItem(SESSION_KEY); } catch (e) {} }

  // state
  let socket = null;
  let offlineMode = false;
  let localPlayers = null;
  let localTick = null;
  let myId = null;
  let myPoints = 0, myCharge = 0, myPhaseActive = false, myPhaseExpires = 0;
  let voxelStarted = false;
  let posLoopTimer = null;

  // Setup socket with fallback to offline mode if cannot connect
  async function tryConnect(timeout = 7000) {
    return new Promise((resolve) => {
      try {
        socket = io(BACKEND_URL, { timeout: timeout, transports: ['polling','websocket'], reconnectionAttempts: 5 });
      } catch (e) {
        console.warn('socket construct failed', e);
        resolve({ online: false, err: e });
        return;
      }
      let finished = false;
      const onConnected = () => { if (!finished) { finished = true; resolve({ online: true }); } };
      const onConnectError = (err) => { if (!finished) { finished = true; resolve({ online: false, err }); } };
      socket.once('connect', onConnected);
      socket.once('connect_error', onConnectError);
      setTimeout(() => { if (!finished) { finished = true; resolve({ online: false, err: new Error('connect timeout') }); } }, timeout + 150);
    });
  }

  // Wire socket events once connected
  function wireSocket() {
    if (!socket) return;
    socket.on('connect', () => { console.info('[socket] connected', socket.id); toast('Connected'); });
    socket.on('disconnect', (reason) => { console.info('[socket] disconnected', reason); toast('Disconnected'); });
    socket.on('joinedRoom', (p) => handleJoined(p));
    socket.on('stateUpdate', (s) => handleState(s));
    socket.on('playerHit', (info) => handlePlayerHit(info));
    socket.on('phaseActivated', (info) => {
      if (!info) return;
      if (info.id === myId) {
        myPhaseActive = true; myPhaseExpires = Date.now() + (info.duration || 6000); window._myPhaseActive = true;
        updateHUD();
        setTimeout(() => { myPhaseActive = false; window._myPhaseActive = false; updateHUD(); }, info.duration || 6000);
      } else {
        // show marker for other player if renderer supports it
        if (window.VoxelWorld && typeof window.VoxelWorld.showShooterMarker === 'function') {
          window.VoxelWorld.showShooterMarker(info.pos || { x:0,y:1.6,z:0 }, info.id, info.duration || 6000);
        }
      }
    });
    socket.on('chunkDiff', (d) => { if (window.VoxelWorld && typeof window.VoxelWorld.applyChunkDiff === 'function') window.VoxelWorld.applyChunkDiff(d); });
    socket.on('shieldPicked', (d) => { if (d && d.durability) $('shieldStatus') && ($('shieldStatus').textContent = `Shield: ${d.durability}`); });
    socket.on('serumPicked', (d) => { if (d && typeof d.count === 'number') { /* tracked server-side */ } });
    socket.on('serumUsed', (d) => { /* nothing special on client other than hud */ });
    socket.on('connect_error', (err) => { console.warn('[socket] connect_error', err); });
    socket.on('connect_timeout', () => { console.warn('[socket] connect_timeout'); });
  }

  // Attempt to start online; fallback to offline if not available
  async function startNetwork() {
    const result = await tryConnect();
    if (!result.online) {
      console.warn('Network offline, starting local mode', result.err);
      offlineMode = true;
      startLocalBots();
      return;
    }
    offlineMode = false;
    wireSocket();
  }

  // Join logic (online)
  async function attemptJoin(name, roomId = 'default', options = {}) {
    if (!name || !name.trim()) throw new Error('empty_name');
    if (!socket) throw new Error('socket_not_initialized');
    if (!socket.connected) {
      // wait up to 8s
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('socket_connect_timeout')), 8000);
        socket.once('connect', () => { clearTimeout(t); resolve(); });
      });
    }
    // persist
    saveSession({ name, roomId, botCount: options.botCount || DEFAULT_BOT_COUNT });
    return new Promise((resolve, reject) => {
      try {
        socket.timeout(10000).emit('joinGame', { name, roomId, options }, (ack) => {
          if (ack && ack.ok) resolve(ack); else reject(new Error((ack && ack.error) || 'join_failed'));
        });
      } catch (e) { reject(e); }
    });
  }

  // Safe spawn local bots & offline simulation
  function startLocalBots() {
    offlineMode = true;
    window.localPlayers = window.localPlayers || {};
    const id = window.localId || ('local-' + Math.floor(Math.random()*10000));
    window.localId = id;
    window.localPlayers[id] = { id, name: (document.getElementById('playerName') && document.getElementById('playerName').value) || 'You', x:0, y:2, z:0, role:'player', points:0, charge:0, type:'player', stunUntil:0, spawnTime: Date.now() };
    for (let i = 0; i < DEFAULT_BOT_COUNT; i++) {
      const bid = 'bot-off-' + i;
      window.localPlayers[bid] = { id: bid, name: `Bot${i}`, x:(Math.random()-0.5)*120, y:2, z:(Math.random()-0.5)*120, role:'player', points:0, charge:0, type:'player', isBot:true, spawnTime: Date.now() };
    }
    // feed renderer immediately
    if (window.VoxelWorld && typeof window.VoxelWorld.updatePlayers === 'function') window.VoxelWorld.updatePlayers(Object.values(window.localPlayers));
    // start sim tick
    if (!localTick) localTick = setInterval(localSimTick, 180);
  }

  function localSimTick() {
    const now = Date.now();
    const arr = Object.values(window.localPlayers || {});
    arr.forEach(p => {
      if (p.isBot) {
        p.x += (Math.random()-0.5)*0.8;
        p.z += (Math.random()-0.5)*0.8;
        if (Math.random() < 0.02) {
          // attempt local shoot
          const shooter = p;
          let best = null, bd = Infinity;
          arr.forEach(t => {
            if (!t || t.id === shooter.id) return;
            const dx = t.x - shooter.x, dz = t.z - shooter.z, dy = (t.y||0) - (shooter.y||0); const d2 = dx*dx + dy*dy + dz*dz;
            if (d2 < bd && d2 <= (SHOOT_RANGE_LOCAL() * SHOOT_RANGE_LOCAL())) { best = t; bd = d2; }
          });
          if (best) {
            const blocked = best.carrying && best.carrying.type === 'shield' && best.carrying.durability > 0;
            if (blocked) { best.carrying.durability -= 1; if (best.carrying.durability <= 0) best.carrying = null; } else { best.stunUntil = Date.now() + 2000; shooter.points = (shooter.points||0)+10; shooter.charge = (shooter.charge||0)+1; }
            if (window.VoxelWorld && typeof window.VoxelWorld.spawnShotEffect === 'function') window.VoxelWorld.spawnShotEffect({x:shooter.x,y:shooter.y+1,z:shooter.z},{x:best.x,y:best.y+1,z:best.z}, blocked?0x999999:0xffff88);
            if (best.id === window.localId) { toast('You were hit (local)', 2000); }
          }
        }
      }
    });
    if (window.VoxelWorld && typeof window.VoxelWorld.updatePlayers === 'function') window.VoxelWorld.updatePlayers(Object.values(window.localPlayers));
  }

  function SHOOT_RANGE_LOCAL() { return 50; }

  // handle server events
  function handleJoined(payload) {
    try {
      myId = payload && payload.playerId;
      // set brief grace (client-side) for spawn-protect visuals
      const grace = Date.now() + 1500;
      window._justJoinedUntil = grace;
      $('playerDisplayName') && ($('playerDisplayName').textContent = payload && payload.name || 'Player');
      myRole = payload && payload.role || 'player';
      document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
      $('pagePlay').classList.add('active');
      $('hud').classList.remove('hidden');
      updateHUD();
      // start renderer if available
      try {
        if (!voxelStarted && window.VoxelWorld && typeof window.VoxelWorld.start === 'function') {
          voxelStarted = !!window.VoxelWorld.start();
          if (voxelStarted) for (let cx=-2; cx<=2; cx++) for (let cz=-2; cz<=2; cz++) if (window.VoxelWorld.requestChunk) window.VoxelWorld.requestChunk(cx,cz);
        } else if (window.VoxelWorld && typeof window.VoxelWorld.requestChunk === 'function') {
          for (let cx=-2; cx<=2; cx++) for (let cz=-2; cz<=2; cz++) window.VoxelWorld.requestChunk(cx,cz);
        }
      } catch (e) { console.warn('renderer start failed', e); }
      startPosLoop();
    } catch (e) { console.warn('handleJoined error', e); }
  }

  function handleState(s) {
    if (!s || !Array.isArray(s.players)) return;
    $('playersLabel') && ($('playersLabel').textContent = `${s.players.length} players`);
    const me = s.players.find(p => p.id === myId);
    if (me) {
      myPoints = me.points || 0; myCharge = me.charge || 0; myPhaseActive = !!me.phaseActive;
      // stunned overlay
      const tranq = $('tranqOverlay');
      if (tranq) {
        if (me.stunnedUntil && me.stunnedUntil > Date.now() && Date.now() > (window._justJoinedUntil || 0)) tranq.classList.remove('hidden');
        else tranq.classList.add('hidden');
      }
      updateHUD();
    }
    if (window.VoxelWorld && typeof window.VoxelWorld.updatePlayers === 'function') window.VoxelWorld.updatePlayers(s.players);
  }

  function handlePlayerHit(info) {
    if (!info) return;
    // show visual effect
    if (window.VoxelWorld && typeof window.VoxelWorld.spawnShotEffect === 'function') window.VoxelWorld.spawnShotEffect(info.shooterPos || {x:0,y:1.6,z:0}, info.targetPos || {x:0,y:1.6,z:0}, info.blocked ? 0x999999 : 0xffff88);
    // if I'm target, show message and shooter marker
    if (info.target === myId) {
      toast(`Hit by ${info.shooter}`, 3000);
      if (window.VoxelWorld && typeof window.VoxelWorld.showShooterMarker === 'function') window.VoxelWorld.showShooterMarker(info.shooterPos || {x:0,y:1.6,z:0}, info.shooter, 6000);
      else if (window.VoxelWorld && typeof window.VoxelWorld.spawnShotEffect === 'function') window.VoxelWorld.spawnShotEffect(info.shooterPos || {x:0,y:1.6,z:0}, info.targetPos || {x:0,y:1.6,z:0}, 0xff6666);
    }
    if (info.shooter === myId) {
      myPoints = info.shooterPoints || myPoints;
      myCharge = info.shooterCharge || myCharge;
      updateHUD();
    }
  }

  // send position periodically to server
  function startPosLoop() {
    if (posLoopTimer) return;
    posLoopTimer = setInterval(() => {
      if (offlineMode) return;
      if (!socket || !socket.connected) return;
      try {
        const pos = (window.VoxelWorld && typeof window.VoxelWorld.getPlayerPosition === 'function') ? window.VoxelWorld.getPlayerPosition() : { x:0,y:0,z:0,crouch:false };
        socket.emit('pos', pos);
      } catch (e) {}
    }, POS_SEND_MS);
  }

  // UI actions
  async function onJoinClick() {
    const name = ($('playerName') && $('playerName').value && $('playerName').value.trim()) || '';
    const room = ($('roomId') && $('roomId').value && $('roomId').value.trim()) || 'default';
    const bc = Number(($('botCount') && $('botCount').value) || DEFAULT_BOT_COUNT);
    if (!name) { alert('Please enter name'); return; }
    $('joinBtn').disabled = true; $('joinBtn').textContent = 'Joining...';
    try {
      if (!socket) await startNetwork();
      if (!offlineMode) await attemptJoin(name, room, { botCount: Math.max(0, Math.min(64, bc)) });
      else {
        // offline: set local player name
        if (window.localPlayers && window.localPlayers[window.localId]) window.localPlayers[window.localId].name = name;
        if (window.VoxelWorld && window.VoxelWorld.updatePlayers) window.VoxelWorld.updatePlayers(Object.values(window.localPlayers));
        document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
        $('pagePlay').classList.add('active');
        $('hud').classList.remove('hidden');
      }
    } catch (err) {
      console.error('join failed', err);
      alert('Join failed: ' + (err && err.message ? err.message : 'error'));
    } finally {
      $('joinBtn').disabled = false; $('joinBtn').textContent = 'JOIN MATCH';
    }
  }

  async function onCreateRoomClick() {
    try {
      $('createRoomBtn').disabled = true; $('createRoomBtn').textContent = 'Creating...';
      const resp = await fetch(BACKEND_URL + '/create-room', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ botCount: DEFAULT_BOT_COUNT }) });
      const j = await resp.json();
      if (j && j.ok) {
        $('inviteArea').classList.remove('hidden');
        $('inviteText').textContent = `Invite: ${j.roomId} — ${j.url}`;
        $('roomId').value = j.roomId;
      } else { alert('Create room failed'); }
    } catch (e) { console.warn('create room failed', e); alert('Create room failed'); }
    finally { $('createRoomBtn').disabled = false; $('createRoomBtn').textContent = 'Create Room'; }
  }

  function onLeaveClick() {
    if (!confirm('Leave match?')) return;
    try { if (socket) socket.disconnect(); } catch (e) {}
    socket = null;
    offlineMode = false;
    clearSession();
    window.localPlayers = null;
    if (localTick) { clearInterval(localTick); localTick = null; }
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    $('pageLogin').classList.add('active');
    $('hud').classList.add('hidden');
  }

  function doShoot() {
    if (offlineMode) {
      // local shoot simulation
      if (!window.localPlayers || !window.localId) { toast('Not in local play'); return; }
      const shooter = window.localPlayers[window.localId];
      if (!shooter) return;
      let best = null, bd = Infinity;
      Object.values(window.localPlayers).forEach(t => {
        if (!t || t.id === shooter.id) return;
        const dx = t.x - shooter.x, dz = t.z - shooter.z, dy = (t.y||0) - (shooter.y||0); const d2 = dx*dx + dy*dy + dz*dz;
        if (d2 < bd && d2 <= SHOOT_RANGE_LOCAL()*SHOOT_RANGE_LOCAL()) { best = t; bd = d2; }
      });
      if (!best) { toast('No local target'); return; }
      const blocked = best.carrying && best.carrying.type === 'shield' && best.carrying.durability > 0;
      if (blocked) { best.carrying.durability -= 1; if (best.carrying.durability <= 0) best.carrying = null; } else { best.stunUntil = Date.now() + 2000; shooter.points = (shooter.points||0) + 10; shooter.charge = (shooter.charge||0) + 1; }
      if (window.VoxelWorld && typeof window.VoxelWorld.spawnShotEffect === 'function') window.VoxelWorld.spawnShotEffect({x:shooter.x,y:shooter.y+1,z:shooter.z},{x:best.x,y:best.y+1,z:best.z}, blocked ? 0x999999 : 0xffff88);
      if (best.id === window.localId) toast('You were hit (local)');
      if (window.VoxelWorld && typeof window.VoxelWorld.updatePlayers === 'function') window.VoxelWorld.updatePlayers(Object.values(window.localPlayers));
      return;
    }
    if (!socket || !socket.connected) { toast('Not connected'); return; }
    socket.emit('shoot', {}, (ack) => {
      if (ack && ack.ok) { /* success */ } else if (ack && ack.error === 'stunned') { toast('You are stunned'); } else { /* no target */ }
    });
  }

  function onPickup() {
    if (offlineMode) { toast('No pickup in offline mode'); return; }
    if (!socket || !socket.connected) return;
    socket.emit('pickup', {}, (ack) => { if (ack && ack.ok) toast('Picked up item'); else toast('No pickup nearby'); });
  }

  function onUseSerum() {
    if (offlineMode) {
      if (window.localPlayers && window.localPlayers[window.localId] && window.localPlayers[window.localId].inventory && window.localPlayers[window.localId].inventory.serum) {
        window.localPlayers[window.localId].inventory.serum -= 1; window.localPlayers[window.localId].stunUntil = 0; toast('Recovered (local)'); return;
      } else { alert('No serum (local)'); return; }
    }
    if (!socket || !socket.connected) return;
    socket.emit('useSerum', {}, (ack) => { if (ack && ack.ok) toast('Serum used'); else toast('Could not use serum'); });
  }

  // HUD + Phase / Hiding toggle
  function updateHUD() {
    $('scoreLabel') && ($('scoreLabel').textContent = `Points: ${myPoints}  Charge: ${myCharge}`);
    // phase button
    let phaseBtn = $('phaseBtn');
    if (!phaseBtn) {
      phaseBtn = document.createElement('button'); phaseBtn.id = 'phaseBtn'; phaseBtn.className = 'btn-secondary'; phaseBtn.style.marginTop = '6px';
      phaseBtn.textContent = 'Activate Phase';
      phaseBtn.addEventListener('click', () => {
        if (offlineMode) { toast('Phase not available in offline demo'); return; }
        if (!socket || !socket.connected) { toast('Not connected'); return; }
        socket.emit('usePhase', {}, (ack) => {
          if (ack && ack.ok) toast('Phase activated'); else toast('Cannot activate phase');
        });
      });
      $('hud').appendChild(phaseBtn);
    }
    phaseBtn.disabled = !(myCharge >= CHARGE_TO_PHASE) || myPhaseActive;
    phaseBtn.textContent = myPhaseActive ? 'Phased' : 'Activate Phase';

    // Show Hides toggle
    let hidesBtn = $('hidesBtn');
    if (!hidesBtn) {
      hidesBtn = document.createElement('button'); hidesBtn.id = 'hidesBtn'; hidesBtn.className = 'btn-secondary'; hidesBtn.style.marginTop = '6px'; hidesBtn.textContent = 'Show Hides';
      hidesBtn.addEventListener('click', () => {
        if (!window.VoxelWorld) { toast('Renderer not started'); return; }
        const p = (window.VoxelWorld && typeof window.VoxelWorld.getPlayerPosition === 'function') ? window.VoxelWorld.getPlayerPosition() : { x: 0, z: 0 };
        if (!window._showingHiding) {
          window._showingHiding = true; hidesBtn.textContent = 'Hide Hides';
          if (window.VoxelWorld && typeof window.VoxelWorld.scanHidingSpots === 'function') window.VoxelWorld.scanHidingSpots(p.x || 0, p.z || 0, 2);
        } else {
          window._showingHiding = false; hidesBtn.textContent = 'Show Hides';
          if (window.VoxelWorld && typeof window.VoxelWorld.clearHidingMarkers === 'function') window.VoxelWorld.clearHidingMarkers();
        }
      });
      $('hud').appendChild(hidesBtn);
    }
  }

  // init & bindings
  document.addEventListener('DOMContentLoaded', async () => {
    // wire buttons
    const joinBtn = $('joinBtn'), createRoomBtn = $('createRoomBtn'), leaveBtn = $('leaveBtn'), shootBtn = $('shootBtn');
    if (joinBtn) joinBtn.addEventListener('click', onJoinClick);
    if (createRoomBtn) createRoomBtn.addEventListener('click', onCreateRoomClick);
    if (leaveBtn) leaveBtn.addEventListener('click', onLeaveClick);
    if (shootBtn) { shootBtn.addEventListener('click', (e) => { e.preventDefault(); doShoot(); }); shootBtn.style.display = 'block'; }

    document.addEventListener('keydown', (e) => {
      if (e.code === 'KeyE') onPickup();
      if (e.code === 'KeyF') onUseSerum();
    });

    // attempt network connect; if fails, offline starts from join click or auto fallback below
    await startNetwork();

    // auto-fill name from session if present
    const sess = loadSession();
    if (sess && sess.name) { if ($('playerName')) $('playerName').value = sess.name; if ($('roomId')) $('roomId').value = sess.roomId || 'default'; }

    // auto-join if we have session and socket connected
    if (sess && sess.name && !offlineMode && socket && socket.connected) {
      try { await attemptJoin(sess.name, sess.roomId || 'default', { botCount: sess.botCount || DEFAULT_BOT_COUNT }); } catch (e) { console.warn('auto-join failed', e); }
    }

    // keyboard/mouse pointer lock hint: overlay click handled in renderer (initVoxel)
  });

  // expose functions for console/testing
  window.doLocalShoot = doShoot;
  window.attemptJoin = attemptJoin;
  window.useSerum = onUseSerum;
  window.tryPickup = onPickup;
  window.startLocalBots = startLocalBots;

})();

// Replace frontend/public/game.js with this file.
// This slightly extended copy of the robust client contains the startJoinFlow fix and explicit
// protection against UI navigation while in-game. It also exposes window.openProfile and
// ensures UI elements are enabled/disabled correctly during join failures.

(function () {
  const BACKEND_URL = (typeof window !== 'undefined' && window.__BACKEND_URL__ && window.__BACKEND_URL__.length)
    ? window.__BACKEND_URL__ : (typeof window !== 'undefined' && window.location && window.location.origin ? window.location.origin : 'https://survive.com');

  const SESSION_KEY = 'survive.session.v1';
  const POS_SEND_MS = 120;
  const DEFAULT_BOT_COUNT = 8;
  const CHARGE_TO_PHASE = 5;

  function $ (id) { return document.getElementById(id); }
  function toast (msg, ms = 1800) { const el = $('connectionStatus'); if (!el) return; const prev = el.textContent; el.textContent = msg; if (ms) setTimeout(() => el.textContent = prev, ms); }

  function saveSession(obj) { try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(obj || {})); } catch (e) {} }
  function loadSession() { try { const s = sessionStorage.getItem(SESSION_KEY); return s ? JSON.parse(s) : null; } catch (e) { return null; } }
  function clearSession() { try { sessionStorage.removeItem(SESSION_KEY); } catch (e) {} }

  let socket = null;
  let offlineMode = false;
  let localTick = null;
  let myId = null;
  let myPoints = 0, myCharge = 0, myPhaseActive = false;
  let voxelStarted = false;
  let posLoopTimer = null;
  let pendingJoinTimer = null;

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

  function wireSocket() {
    if (!socket) return;
    socket.on('connect', () => { console.info('[socket] connected', socket.id); toast('Connected'); });
    socket.on('disconnect', () => { console.info('[socket] disconnected'); toast('Disconnected'); });
    // Set permanent handlers
    socket.off('joinedRoom'); socket.on('joinedRoom', (p) => handleJoined(p));
    socket.off('stateUpdate'); socket.on('stateUpdate', (s) => handleState(s));
    socket.off('playerHit'); socket.on('playerHit', (info) => handlePlayerHit(info));
    socket.off('phaseActivated'); socket.on('phaseActivated', (info) => {
      if (!info) return;
      if (info.id === myId) {
        myPhaseActive = true; window._myPhaseActive = true;
        setTimeout(() => { myPhaseActive = false; window._myPhaseActive = false; updateHUD(); }, info.duration || 6000);
        updateHUD();
      } else {
        if (window.VoxelWorld && typeof window.VoxelWorld.showShooterMarker === 'function') {
          try { window.VoxelWorld.showShooterMarker(info.pos || { x:0,y:1.6,z:0 }, info.id, info.duration || 6000); } catch(e) { console.warn('showShooterMarker failed', e); }
        }
      }
    });
    socket.off('chunkDiff'); socket.on('chunkDiff', (d) => { if (window.VoxelWorld && typeof window.VoxelWorld.applyChunkDiff === 'function') window.VoxelWorld.applyChunkDiff(d); });
    socket.off('shieldPicked'); socket.on('shieldPicked', (d) => { if (d && d.durability) $('shieldStatus') && ($('shieldStatus').textContent = `Shield: ${d.durability}`); });
  }

  async function startNetwork() {
    const r = await tryConnect();
    if (!r.online) { offlineMode = true; startLocalBots(); return; }
    offlineMode = false;
    wireSocket();
  }

  // canonical join flow using joinedRoom event, with friendly timeout / error handling
  function startJoinFlow(name, room, botCount) {
    if (!socket) { return Promise.reject(new Error('not_connected')); }
    if (pendingJoinTimer) { clearTimeout(pendingJoinTimer); pendingJoinTimer = null; }

    return new Promise((resolve, reject) => {
      let resolved = false;

      function onJoinedOnce(payload) {
        if (resolved) return;
        resolved = true;
        clearTimeout(pendingJoinTimer); pendingJoinTimer = null;
        resolve(payload);
      }

      socket.once('joinedRoom', onJoinedOnce);

      try {
        socket.emit('joinGame', { name, roomId: room, options: { botCount } }, (ack) => {
          if (ack && ack.ok) {
            if (!resolved) { resolved = true; clearTimeout(pendingJoinTimer); pendingJoinTimer = null; resolve(ack); }
          } else if (ack && !ack.ok) {
            if (!resolved) { resolved = true; clearTimeout(pendingJoinTimer); pendingJoinTimer = null; reject(new Error(ack.error || 'join_failed')); }
          }
        });
      } catch (e) {
        if (!resolved) { resolved = true; clearTimeout(pendingJoinTimer); pendingJoinTimer = null; reject(e); }
      }

      pendingJoinTimer = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        try { socket.off('joinedRoom', onJoinedOnce); } catch(e){}
        reject(new Error('join_timeout'));
      }, 10000);
    });
  }

  async function onJoinClick() {
    const name = ($('playerName') && $('playerName').value && $('playerName').value.trim()) || '';
    const room = ($('roomId') && $('roomId').value && $('roomId').value.trim()) || 'default';
    const bc = Number(($('botCount') && $('botCount').value) || DEFAULT_BOT_COUNT);
    if (!name) { alert('Please enter name'); return; }
    const joinBtn = $('joinBtn');
    joinBtn.disabled = true; joinBtn.textContent = 'Joining...';
    try {
      if (!socket) await startNetwork();
      if (offlineMode) {
        startLocalBots();
        if (window.localPlayers && window.localPlayers[window.localId]) window.localPlayers[window.localId].name = name;
        if (window.VoxelWorld && typeof window.VoxelWorld.updatePlayers === 'function') window.VoxelWorld.updatePlayers(Object.values(window.localPlayers));
        document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
        $('pagePlay').classList.add('active');
        $('hud').classList.remove('hidden');
      } else {
        try {
          await startJoinFlow(name, room, Math.max(0, Math.min(64, bc)));
          // joinedRoom handler will run and set up UI
        } catch (err) {
          console.warn('join failed', err);
          alert('Join failed: ' + (err && err.message ? err.message : 'join_failed'));
        }
      }
    } catch (outerErr) {
      console.error('join flow error', outerErr);
      alert('Join failed: ' + (outerErr && outerErr.message ? outerErr.message : 'join_error'));
    } finally {
      joinBtn.disabled = false; joinBtn.textContent = 'JOIN MATCH';
    }
  }

  function startLocalBots() {
    offlineMode = true;
    window.localPlayers = window.localPlayers || {};
    const id = window.localId || ('local-' + Math.floor(Math.random()*10000));
    window.localId = id;
    window.localPlayers[id] = { id, name: ($('playerName') && $('playerName').value) || 'You', x:0, y:2, z:0, role:'player', points:0, charge:0, type:'player', stunUntil:0, spawnTime: Date.now() };
    for (let i=0;i<DEFAULT_BOT_COUNT;i++){
      const bid = 'bot-off-' + i;
      window.localPlayers[bid] = { id: bid, name: `Bot${i}`, x:(Math.random()-0.5)*120, y:2, z:(Math.random()-0.5)*120, role:'player', points:0, charge:0, type:'player', isBot:true, spawnTime: Date.now() };
    }
    if (window.VoxelWorld && typeof window.VoxelWorld.updatePlayers === 'function') window.VoxelWorld.updatePlayers(Object.values(window.localPlayers));
    if (!localTick) localTick = setInterval(localSimTick, 180);
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active')); $('pagePlay').classList.add('active'); $('hud').classList.remove('hidden');
  }

  function localSimTick(){
    const now = Date.now();
    const arr = Object.values(window.localPlayers || {});
    arr.forEach(p=>{
      if (p.isBot) {
        p.x += (Math.random()-0.5)*0.8; p.z += (Math.random()-0.5)*0.8;
        if (Math.random() < 0.02) {
          const shooter = p;
          let best = null, bd = Infinity;
          arr.forEach(t=>{
            if (!t || t.id === shooter.id) return;
            const dx = t.x - shooter.x, dz = t.z - shooter.z, dy = (t.y||0) - (shooter.y||0); const d2 = dx*dx + dy*dy + dz*dz;
            if (d2 < bd && d2 <= (50*50)) { best = t; bd = d2; }
          });
          if (best) {
            const blocked = best.carrying && best.carrying.type === 'shield' && best.carrying.durability > 0;
            if (blocked) { best.carrying.durability -= 1; if (best.carrying.durability <= 0) best.carrying = null; } else { best.stunUntil = Date.now() + 2000; shooter.points = (shooter.points||0)+10; shooter.charge = (shooter.charge||0)+1; }
            if (window.VoxelWorld && typeof window.VoxelWorld.spawnShotEffect === 'function') window.VoxelWorld.spawnShotEffect({x:shooter.x,y:shooter.y+1,z:shooter.z},{x:best.x,y:best.y+1,z:best.z}, blocked?0x999999:0xffff88);
            if (best.id === window.localId) toast('You were hit (local)', 2000);
          }
        }
      }
    });
    if (window.VoxelWorld && typeof window.VoxelWorld.updatePlayers === 'function') window.VoxelWorld.updatePlayers(Object.values(window.localPlayers));
  }

  function handleJoined(payload) {
    try {
      myId = payload && payload.playerId;
      window._justJoinedUntil = Date.now() + 1500;
      $('playerDisplayName') && ($('playerDisplayName').textContent = payload && payload.name || 'Player');
      document.querySelectorAll('.page').forEach(p => p.classList.remove('active')); $('pagePlay').classList.add('active'); $('hud').classList.remove('hidden');
      updateHUD();
      try {
        if (!voxelStarted && window.VoxelWorld && typeof window.VoxelWorld.start === 'function') {
          voxelStarted = !!window.VoxelWorld.start();
          if (voxelStarted) for (let cx=-2; cx<=2; cx++) for (let cz=-2; cz<=2; cz++) if (window.VoxelWorld.requestChunk) window.VoxelWorld.requestChunk(cx,cz);
        } else if (window.VoxelWorld && typeof window.VoxelWorld.requestChunk === 'function') {
          for (let cx=-2; cx<=2; cx++) for (let cz=-2; cz<=2; cz++) window.VoxelWorld.requestChunk(cx,cz);
        }
      } catch(e) { console.warn('renderer start failed', e); }
      startPosLoop();
    } catch (e) { console.warn('handleJoined error', e); }
  }

  function handleState(s) {
    if (!s || !Array.isArray(s.players)) return;
    $('playersLabel') && ($('playersLabel').textContent = `${s.players.length} players`);
    const me = s.players.find(p => p.id === myId);
    if (me) {
      myPoints = me.points || 0; myCharge = me.charge || 0; myPhaseActive = !!me.phaseActive;
      const tranq = $('tranqOverlay');
      if (tranq) {
        if (me.stunnedUntil && me.stunnedUntil > Date.now() && Date.now() > (window._justJoinedUntil || 0)) tranq.classList.remove('hidden'); else tranq.classList.add('hidden');
      }
      updateHUD();
    }
    if (window.VoxelWorld && typeof window.VoxelWorld.updatePlayers === 'function') window.VoxelWorld.updatePlayers(s.players);
  }

  function handlePlayerHit(info) {
    if (!info) return;
    try {
      if (window.VoxelWorld && typeof window.VoxelWorld.spawnShotEffect === 'function') {
        window.VoxelWorld.spawnShotEffect(info.shooterPos || {x:0,y:1.6,z:0}, info.targetPos || {x:0,y:1.6,z:0}, info.blocked ? 0x999999 : 0xffff88);
      }
    } catch(e) { console.warn('spawnShotEffect failed', e); }
    if (info.target === myId) {
      toast(`Hit by ${info.shooter}`, 3000);
      try {
        if (window.VoxelWorld && typeof window.VoxelWorld.showShooterMarker === 'function') {
          window.VoxelWorld.showShooterMarker(info.shooterPos || {x:0,y:1.6,z:0}, info.shooter, 6000);
        }
      } catch(e) { console.warn('showShooterMarker failed', e); }
    }
    if (info.shooter === myId) {
      myPoints = info.shooterPoints || myPoints;
      myCharge = info.shooterCharge || myCharge;
      updateHUD();
    }
  }

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

  async function onCreateRoomClick() {
    try {
      $('createRoomBtn').disabled = true; $('createRoomBtn').textContent = 'Creating...';
      const resp = await fetch(BACKEND_URL + '/create-room', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ botCount: DEFAULT_BOT_COUNT }) });
      const j = await resp.json();
      if (j && j.ok) { $('inviteArea').classList.remove('hidden'); $('inviteText').textContent = `Invite: ${j.roomId} — ${j.url}`; $('roomId').value = j.roomId; } else alert('Create room failed');
    } catch (e) { console.warn('create room failed', e); alert('Create room failed'); } finally { $('createRoomBtn').disabled = false; $('createRoomBtn').textContent = 'Create Room'; }
  }

  function onLeaveClick() {
    if (!confirm('Leave match?')) return;
    try { if (socket) socket.disconnect(); } catch (e) {}
    socket = null; offlineMode = false; clearSession(); window.localPlayers = null;
    if (localTick) { clearInterval(localTick); localTick = null; }
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active')); $('pageLogin').classList.add('active'); $('hud').classList.add('hidden');
  }

  function doShoot() {
    if (offlineMode) {
      if (!window.localPlayers || !window.localId) { toast('Not in local play'); return; }
      const shooter = window.localPlayers[window.localId]; if (!shooter) return;
      let best = null, bd = Infinity;
      Object.values(window.localPlayers).forEach(t => { if (!t || t.id === shooter.id) return; const dx = t.x - shooter.x, dz = t.z - shooter.z, dy = (t.y||0) - (shooter.y||0); const d2 = dx*dx + dy*dy + dz*dz; if (d2 < bd && d2 <= (50*50)) { best = t; bd = d2; } });
      if (!best) { toast('No local target'); return; }
      const blocked = best.carrying && best.carrying.type === 'shield' && best.carrying.durability > 0;
      if (blocked) { best.carrying.durability -= 1; if (best.carrying.durability <= 0) best.carrying = null; } else { best.stunUntil = Date.now() + 2000; shooter.points = (shooter.points||0)+10; shooter.charge = (shooter.charge||0)+1; }
      if (window.VoxelWorld && typeof window.VoxelWorld.spawnShotEffect === 'function') window.VoxelWorld.spawnShotEffect({x:shooter.x,y:shooter.y+1,z:shooter.z},{x:best.x,y:best.y+1,z:best.z}, blocked?0x999999:0xffff88);
      if (best.id === window.localId) toast('You were hit (local)');
      if (window.VoxelWorld && typeof window.VoxelWorld.updatePlayers === 'function') window.VoxelWorld.updatePlayers(Object.values(window.localPlayers));
      return;
    }
    if (!socket || !socket.connected) { toast('Not connected'); return; }
    socket.emit('shoot', {}, (ack) => { if (ack && ack.ok) {} else if (ack && ack.error === 'stunned') { toast('You are stunned'); } else {} });
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

  function updateHUD(){
    $('scoreLabel') && ($('scoreLabel').textContent = `Points: ${myPoints}  Charge: ${myCharge}`);
    let phaseBtn = $('phaseBtn');
    if (!phaseBtn) {
      phaseBtn = document.createElement('button'); phaseBtn.id = 'phaseBtn'; phaseBtn.className = 'btn-secondary'; phaseBtn.style.marginTop = '6px';
      phaseBtn.textContent = 'Activate Phase';
      phaseBtn.addEventListener('click', () => {
        if (offlineMode) { toast('Phase not available in offline demo'); return; }
        if (!socket || !socket.connected) { toast('Not connected'); return; }
        socket.emit('usePhase', {}, (ack) => { if (ack && ack.ok) toast('Phase activated'); else toast('Cannot activate phase'); });
      });
      $('hud').appendChild(phaseBtn);
    }
    phaseBtn.disabled = !(myCharge >= CHARGE_TO_PHASE) || myPhaseActive;
    phaseBtn.textContent = myPhaseActive ? 'Phased' : 'Activate Phase';
    let hidesBtn = $('hidesBtn');
    if (!hidesBtn) {
      hidesBtn = document.createElement('button'); hidesBtn.id = 'hidesBtn'; hidesBtn.className = 'btn-secondary'; hidesBtn.style.marginTop = '6px'; hidesBtn.textContent = 'Show Hides';
      hidesBtn.addEventListener('click', () => {
        if (!window.VoxelWorld) { toast('Renderer not started'); return; }
        const p = (window.VoxelWorld && typeof window.VoxelWorld.getPlayerPosition === 'function') ? window.VoxelWorld.getPlayerPosition() : { x: 0, z: 0 };
        if (!window._showingHiding) { window._showingHiding = true; hidesBtn.textContent = 'Hide Hides'; if (window.VoxelWorld && typeof window.VoxelWorld.scanHidingSpots === 'function') window.VoxelWorld.scanHidingSpots(p.x || 0, p.z || 0, 2); }
        else { window._showingHiding = false; hidesBtn.textContent = 'Show Hides'; if (window.VoxelWorld && typeof window.VoxelWorld.clearHidingMarkers === 'function') window.VoxelWorld.clearHidingMarkers(); }
      });
      $('hud').appendChild(hidesBtn);
    }
  }

  document.addEventListener('DOMContentLoaded', async () => {
    const joinBtn = $('joinBtn'), createRoomBtn = $('createRoomBtn'), leaveBtn = $('leaveBtn'), shootBtn = $('shootBtn');
    if (joinBtn) joinBtn.addEventListener('click', onJoinClick);
    if (createRoomBtn) createRoomBtn.addEventListener('click', onCreateRoomClick);
    if (leaveBtn) leaveBtn.addEventListener('click', onLeaveClick);
    if (shootBtn) { shootBtn.addEventListener('click', (e)=>{ e.preventDefault(); doShoot(); }); shootBtn.style.display = 'block'; }
    document.addEventListener('keydown', (e) => { if (e.code === 'KeyE') onPickup(); if (e.code === 'KeyF') onUseSerum(); });

    await startNetwork();

    const sess = loadSession();
    if (sess && sess.name) { if ($('playerName')) $('playerName').value = sess.name; if ($('roomId')) $('roomId').value = sess.roomId || 'default'; }
    if (sess && sess.name && !offlineMode && socket && socket.connected) {
      try { await startJoinFlow(sess.name, sess.roomId || 'default', { botCount: sess.botCount || DEFAULT_BOT_COUNT }); } catch (e) { console.warn('auto-join failed', e); }
    }
  });

  // expose helpers
  window.openProfile = function(){ if (myId) { document.querySelectorAll('.page').forEach(p => p.classList.remove('active')); $('pagePlay').classList.add('active'); } else { document.querySelectorAll('.page').forEach(p => p.classList.remove('active')); $('pageLogin').classList.add('active'); } };
  window.doLocalShoot = doShoot;
  window.attemptJoin = (name, room, opts) => startJoinFlow(name, room, opts && opts.botCount ? opts.botCount : DEFAULT_BOT_COUNT);
  window.useSerum = onUseSerum;
  window.tryPickup = onPickup;
  window.startLocalBots = startLocalBots;

})();

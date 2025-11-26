// Frontend game logic (advanced): integrates with the advanced renderer, supports online play and offline local bots,
// binds left-click to shooting (server when online, local simulation when offline), manages pickups & serum use,
// and updates HUD. This file replaces prior game.js with the "most advanced" client logic.

(function(){
  // try to reuse existing application code but replace core behaviors with advanced features
  const BACKEND_URL = (typeof window !== 'undefined' && window.__BACKEND_URL__ && window.__BACKEND_URL__.length)
    ? window.__BACKEND_URL__ : (typeof window !== 'undefined' && window.location && window.location.origin ? window.location.origin : 'https://survive.com');

  const POS_SEND_MS = 120;
  function $(id){ return document.getElementById(id); }

  let socket = null, voxelStarted=false, offlineMode=false, myRole='', myInventory={serum:0};

  async function tryConnect(timeoutMs = 6000){
    return new Promise((resolve) => {
      try {
        socket = io(BACKEND_URL, { timeout: timeoutMs, transports:['polling','websocket'], reconnectionAttempts: 3 });
        let resolved = false;
        socket.on('connect', ()=>{ if (!resolved){ resolved = true; resolve({ online:true }); }});
        socket.on('connect_error', (err)=>{ if (!resolved){ resolved = true; resolve({ online:false, err }); }});
        setTimeout(()=>{ if (!resolved){ resolved = true; resolve({ online:false, err: new Error('connect timeout') }); } }, timeoutMs + 150);
      } catch (e) { resolve({ online:false, err:e }); }
    });
  }

  async function startNetworkOrOffline(){
    const res = await tryConnect(7000);
    if (!res.online) { offlineMode = true; console.warn('Offline mode engaged:', res.err); startLocalBots(); return; }
    wireSocket();
  }

  function wireSocket(){
    socket.on('connect', ()=> console.info('[socket] connected', socket.id));
    socket.on('disconnect', ()=> console.info('[socket] disconnected'));
    socket.on('joinedRoom', (p)=> onJoined(p));
    socket.on('stateUpdate', (s)=> onState(s));
    socket.on('chunkDiff', (d)=> window.VoxelWorld && window.VoxelWorld.applyChunkDiff && window.VoxelWorld.applyChunkDiff(d));
    socket.on('shotFired', (info)=> {
      if (window.VoxelWorld && window.VoxelWorld.spawnShotEffect) window.VoxelWorld.spawnShotEffect(info.shooterPos, info.targetPos, info.blocked ? 0x999999 : 0xffff88);
      if (info.shooter && window.VoxelWorld && window.VoxelWorld.animateMuzzleAtEntity) window.VoxelWorld.animateMuzzleAtEntity(info.shooter);
      if (info.target === window.myId) { const el = $('tranqOverlay'); if (el) { el.classList.remove('hidden'); setTimeout(()=> el.classList.add('hidden'), 3000); } }
    });
    socket.on('shieldPicked', (d)=> { $('shieldStatus') && ($('shieldStatus').textContent = `Shield: ${d.durability}`); });
    socket.on('serumPicked', (d)=> { myInventory.serum = d.count || myInventory.serum || 0; updateInventoryHUD(); });
    socket.on('serumUsed', (d)=> { if (d && d.ok) { myInventory.serum = Math.max(0, (myInventory.serum||1)-1); updateInventoryHUD(); } });
  }

  function updateInventoryHUD(){ const el=$('shieldStatus'); if (el) el.textContent = `Serum: ${myInventory.serum}`; }

  function startPosLoopOnline(){
    setInterval(()=> {
      if (!socket || !socket.connected) return;
      try {
        const pos = (window.VoxelWorld && window.VoxelWorld.getPlayerPosition) ? window.VoxelWorld.getPlayerPosition() : { x:0,y:0,z:0,crouch:false };
        socket.emit('pos', pos);
      } catch(e){}
    }, POS_SEND_MS);
  }

  async function attemptJoin(name, roomId, options={}) {
    if (!socket) throw new Error('socket not initialized');
    if (!socket.connected) await new Promise((resolve,reject)=>{ const t=setTimeout(()=>reject(new Error('socket_connect_timeout')),8000); socket.once('connect', ()=>{ clearTimeout(t); resolve(); }); });
    return new Promise((resolve,reject)=> {
      socket.timeout(15000).emit('joinGame', { name, roomId, options }, (ack)=> {
        if (ack && ack.ok) resolve(ack); else reject(new Error((ack && ack.error) || 'join_failed'));
      });
    });
  }

  function onJoined(payload){
    window.myId = payload && payload.playerId;
    $('playerDisplayName') && ($('playerDisplayName').textContent = payload && payload.name || 'Player');
    myRole = payload && payload.role || '';
    document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
    $('pagePlay').classList.add('active');
    $('hud').classList.remove('hidden');
    if (window.VoxelWorld && window.VoxelWorld.start) { voxelStarted = !!window.VoxelWorld.start(); if (voxelStarted) for (let cx=-3; cx<=3; cx++) for (let cz=-3; cz<=3; cz++) window.VoxelWorld.requestChunk(cx,cz); }
    startPosLoopOnline();
  }

  function onState(s){
    if (!s || !s.players) return;
    $('playersLabel') && ($('playersLabel').textContent = `${s.players.length} players`);
    const me = s.players.find(p => p.id === window.myId);
    if (me) {
      myRole = me.role || myRole;
      const el = $('tranqOverlay');
      if (el) { if (me.tranqUntil && me.tranqUntil > Date.now()) el.classList.remove('hidden'); else el.classList.add('hidden'); }
    }
    const btn = $('shootBtn'); if (btn) btn.style.display = myRole === 'seeker' ? 'block' : 'none';
    if (window.VoxelWorld && window.VoxelWorld.updatePlayers) window.VoxelWorld.updatePlayers(s.players);
  }

  async function doShootOnline(){
    if (!socket || !socket.connected) { alert('not connected'); return; }
    socket.emit('shoot', {}, (ack)=> {
      if (ack && ack.ok) { if (ack.blocked) toast('Shot blocked'); else toast('Shot fired'); } else toast('No target');
    });
  }

  function doShootLocal(){
    // offline local simulation, find nearest player and apply tranq locally
    const playersLocal = window.localPlayers || {};
    const shooter = playersLocal[window.localId];
    if (!shooter) return;
    if (shooter.role !== 'seeker') { alert('Only Seekers can shoot'); return; }
    let best = null, bestD = Infinity;
    for (const id of Object.keys(playersLocal)) {
      if (id === shooter.id) continue;
      const t = playersLocal[id];
      if (!t || t.type !== 'player') continue;
      const dx = t.x - shooter.x, dy = (t.y||0) - (shooter.y||0), dz = t.z - shooter.z;
      const d2 = dx*dx + dy*dy + dz*dz;
      if (d2 < bestD && d2 <= SHOOT_RANGE*SHOOT_RANGE) { best = t; bestD = d2; }
    }
    if (!best) { toast('No target'); return; }
    const blocked = best.carrying && best.carrying.type === 'shield' && best.carrying.durability > 0;
    if (blocked) { best.carrying.durability -= 1; if (best.carrying.durability <= 0) best.carrying = null; } else { best.tranqUntil = Date.now() + 9000; }
    if (window.VoxelWorld && window.VoxelWorld.spawnShotEffect) window.VoxelWorld.spawnShotEffect({ x: shooter.x, y: shooter.y+1, z: shooter.z }, { x: best.x, y: best.y+1, z: best.z }, blocked ? 0x999999 : 0xffff88);
    if (window.VoxelWorld && window.VoxelWorld.animateMuzzleAtEntity) window.VoxelWorld.animateMuzzleAtEntity(shooter.id);
    toast('Shot fired (local)');
  }

  // wrapper that handles online/offline shooting
  window.doLocalShoot = function(){ if (!offlineMode) return doShootOnline(); return doShootLocal(); };

  // pickups & serum use wrappers
  function tryPickup() { if (offlineMode) { /* offline pickup not simulated fully */ toast('No pickup in offline mode'); return; } socket.emit('pickup', {}, (ack)=> { if (ack && ack.ok) { toast('Picked item'); } else toast('Nothing to pick up'); }); }
  function useSerum() { if (offlineMode) { if (window.localPlayers && window.localPlayers[window.localId] && window.localPlayers[window.localId].inventory && window.localPlayers[window.localId].inventory.serum) { window.localPlayers[window.localId].inventory.serum -= 1; window.localPlayers[window.localId].tranqUntil = 0; toast('Recovered (local)'); } else alert('No serum (local)'); return; } socket.emit('useSerum', {}, (ack)=> { if (ack && ack.ok) toast('Serum used'); else alert('Could not use serum'); }); }

  // UI and start
  document.addEventListener('DOMContentLoaded', async () => {
    await startNetworkOrOffline();
    // start renderer if available
    if (window.VoxelWorld && window.VoxelWorld.start) { voxelStarted = !!window.VoxelWorld.start(); if (voxelStarted) for (let cx=-3; cx<=3; cx++) for (let cz=-3; cz<=3; cz++) window.VoxelWorld.requestChunk(cx,cz); }

    const joinBtn = $('joinBtn'), createRoomBtn = $('createRoomBtn'), leaveBtn = $('leaveBtn'), shootBtn = $('shootBtn');
    const nameInput = $('playerName'), roomInput = $('roomId'), botCount = $('botCount');

    if (joinBtn) joinBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      const name = (nameInput && nameInput.value && nameInput.value.trim()) || 'Player';
      if (!offlineMode) {
        try {
          await attemptJoin(name, roomInput && roomInput.value || 'default', { botCount: Number(botCount && botCount.value || 12) });
          startPosLoopOnline();
        } catch (err) {
          console.error('join error', err);
          // fallback to offline
          offlineMode = true;
          startLocalBots();
        }
      } else {
        // offline: start local bots; local name set in local players structure by offline engine
        if (window.localPlayers && window.localPlayers[window.localId]) window.localPlayers[window.localId].name = name;
      }
    });

    if (createRoomBtn) createRoomBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      try {
        const resp = await fetch(`${BACKEND_URL}/create-room`, { method:'POST' });
        const j = await resp.json();
        if (j && j.ok) { $('inviteArea').classList.remove('hidden'); $('inviteText').textContent = `Invite: ${j.roomId} — ${j.url}`; roomInput && (roomInput.value = j.roomId); }
      } catch (err) { console.warn('create-room failed', err); }
    });

    if (leaveBtn) leaveBtn.addEventListener('click', (e)=> { e.preventDefault(); if (confirm('Leave?')) location.reload(); });
    if (shootBtn) { shootBtn.addEventListener('click', (e)=>{ e.preventDefault(); window.doLocalShoot(); }); shootBtn.style.display = 'none'; }

    document.addEventListener('keydown', (e) => { if (e.code === 'KeyE') tryPickup(); if (e.code === 'KeyF') useSerum(); });
  });

  // offline engine start (extracted here for clarity)
  function startLocalBots(){
    offlineMode = true;
    window.localPlayers = window.localPlayers || {};
    window.localId = window.localId || 'local-' + Math.floor(Math.random()*10000);
    window.localPlayers[window.localId] = { id: window.localId, name: (document.getElementById('playerName') && document.getElementById('playerName').value) || 'You', x:0, y:2, z:0, role:'hider', type:'player', inventory:{serum:0}, tranqUntil:0 };
    for (let i=0;i<16;i++){
      const id = 'offbot-'+i; const r=Math.random();
      if (r < 0.6) window.localPlayers[id] = { id, name:`Bot${i}`, x:(Math.random()-0.5)*160, y:2, z:(Math.random()-0.5)*160, role:(Math.random()>0.9?'seeker':'hider'), type:'player', tranqUntil:0, ai:{roamTick:Date.now()+Math.random()*3000} };
      else if (r < 0.85) window.localPlayers[id] = { id, name:`Bird${i}`, x:(Math.random()-0.5)*160, y:6+Math.random()*12, z:(Math.random()-0.5)*160, role:'bird', type:'bird', ai:{roamTick:Date.now()+Math.random()*900} };
      else window.localPlayers[id] = { id, name:`Truck${i}`, x:(Math.random()-0.5)*160, y:0.6, z:(Math.random()-0.5)*160, role:'vehicle', type:'vehicle', ai:{roamTick:Date.now()+Math.random()*1200}, path:null };
    }
    // call renderer to show them
    if (window.VoxelWorld && window.VoxelWorld.updatePlayers) window.VoxelWorld.updatePlayers(Object.values(window.localPlayers));
    // start local sim tick
    setInterval(()=> {
      // update simple AI movement and occasional shooting
      const vals = Object.values(window.localPlayers);
      vals.forEach(p => {
        p.ai = p.ai || { roamTick: Date.now()+1000 };
        if (Date.now() > p.ai.roamTick) {
          p.ai.roamTick = Date.now() + 800 + Math.random()*2200;
          if (p.type === 'vehicle') {
            p.x += (Math.random()-0.5)*1.6; p.z += (Math.random()-0.5)*1.6;
          } else if (p.type === 'bird') {
            p.x += (Math.random()-0.5)*1.0; p.y += (Math.random()-0.5)*0.6; p.z += (Math.random()-0.5)*1.0;
            if (p.y < 2) p.y = 2; if (p.y > 30) p.y = 30;
          } else {
            p.x += (Math.random()-0.5)*0.8; p.z += (Math.random()-0.5)*0.8;
          }
        }
      });
      // occasional bot shooting if seeker
      vals.forEach(shooter => {
        if (shooter.type==='player' && shooter.role==='seeker' && Math.random() < 0.02) {
          let best=null, bestD=Infinity;
          vals.forEach(t=>{
            if (t.id===shooter.id) return;
            if (t.type !== 'player') return;
            const dx=t.x-shooter.x, dz=t.z-shooter.z, dy=(t.y||0)-shooter.y;
            const d2=dx*dx+dy*dy+dz*dz;
            if (d2 < bestD && d2 <= SHOOT_RANGE*SHOOT_RANGE) { best=t; bestD=d2; }
          });
          if (best) {
            const blocked = best.carrying && best.carrying.type==='shield' && best.carrying.durability>0;
            if (blocked) { best.carrying.durability -= 1; if (best.carrying.durability<=0) best.carrying=null; } else { best.tranqUntil = Date.now() + 9000; }
            if (window.VoxelWorld && window.VoxelWorld.spawnShotEffect) window.VoxelWorld.spawnShotEffect({x:shooter.x,y:shooter.y+1,z:shooter.z},{x:best.x,y:best.y+1,z:best.z},blocked?0x999999:0xffff88);
            if (window.VoxelWorld && window.VoxelWorld.animateMuzzleAtEntity) window.VoxelWorld.animateMuzzleAtEntity(shooter.id);
          }
        }
      });
      if (window.VoxelWorld && window.VoxelWorld.updatePlayers) window.VoxelWorld.updatePlayers(Object.values(window.localPlayers));
    }, 180);
  }

  // expose some functions globally for renderer
  window.attemptJoin = window.attemptJoin || attemptJoin;
  window.tryPickup = window.tryPickup || tryPickup;
  window.useSerum = window.useSerum || useSerum;
  window.doLocalShoot = window.doLocalShoot || window.doLocalShoot;

  // minimal helper toast
  function toast(msg){ const el = document.getElementById('connectionStatus'); if (el) { el.textContent = msg; setTimeout(()=> { if (el) el.textContent=''; }, 1500); } }

  // export some functions
  window.__doOnlineShoot = doShootOnline;

})();

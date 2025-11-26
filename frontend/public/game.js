// Updated frontend/public/game.js
// Fixes:
// - Prevent "tranquilized on join" by ignoring tranq state for a short window immediately after join
// - Persist session (sessionStorage) and auto-rejoin on refresh so user stays in the room
//
// This file keeps previous behavior (online/offline support, shoot/pickup/useSerum wiring) but
// adds robust session persistence and a "just joined" grace period to avoid false tranq UI.

const BACKEND_URL = (typeof window !== 'undefined' && window.__BACKEND_URL__ && window.__BACKEND_URL__.length)
  ? window.__BACKEND_URL__ : (typeof window !== 'undefined' && window.location && window.location.origin ? window.location.origin : 'https://survive.com');

console.log('BACKEND_URL =', BACKEND_URL);

const SESSION_KEY = 'survive.session.v1';
const POS_SEND_MS = 120;

function $(id){ return document.getElementById(id); }
function toast(msg, ms=2000){ const s=$('connectionStatus'); if(!s) return; const prev=s.textContent; s.textContent=msg; if(ms) setTimeout(()=>s.textContent=prev,ms); }
function saveSession(o){ try{ sessionStorage.setItem(SESSION_KEY, JSON.stringify(o||{})); }catch(e){} }
function loadSession(){ try{ const r=sessionStorage.getItem(SESSION_KEY); return r?JSON.parse(r):null;}catch(e){return null;} }
function clearSession(){ try{ sessionStorage.removeItem(SESSION_KEY);}catch(e){} }

let socket=null, posInterval=null, voxelStarted=false, myRole='', myInventory={serum:0};
// justJoinedUntil: timestamp until which we ignore tranq overlay to avoid "tranquilized on join"
let justJoinedUntil = 0;

function setupSocket() {
  if (socket) return socket;
  socket = io(BACKEND_URL, { timeout:10000, reconnectionAttempts:10, transports:['polling','websocket'] });

  socket.on('connect', ()=>{ console.info('[socket] connected', socket.id); window.hts = window.hts || {}; window.hts.socketConnected = true; toast('Connected',1200); 
    // If we have a saved session but no myId, try to auto-join (useful after refresh)
    const sess = loadSession();
    if (sess && sess.name && !window.myId) {
      // attempt rejoin but don't spam if already joined
      attemptJoin(sess.name, sess.roomId || 'default', { botCount: sess.botCount || Number((document.getElementById('botCount') && document.getElementById('botCount').value) || 12) })
        .catch(err => { console.warn('auto-rejoin failed', err); });
    }
  });

  socket.on('disconnect', (reason)=>{ console.info('[socket] disconnected', reason); window.hts.socketConnected=false; toast('Disconnected',1200); });
  socket.on('connect_error', (err)=>{ console.warn('[socket] connect_error', err && err.message); toast('Socket error',2000); });
  socket.on('connect_timeout', ()=>{ console.warn('[socket] connect_timeout'); toast('Socket timeout',2000); });
  socket.on('reconnect_attempt', ()=>{ console.info('[socket] reconnect attempt'); });

  socket.on('joinedRoom', (p)=>{ console.log('joinedRoom', p); handleJoinedRoom(p); });
  socket.on('joinError', (err)=>{ console.warn('joinError', err); if (err && err.message) alert(err.message); });

  socket.on('stateUpdate', (s)=>{ handleStateUpdate(s); if (window.VoxelWorld && typeof window.VoxelWorld.updatePlayers === 'function') window.VoxelWorld.updatePlayers(s.players || []); });
  socket.on('chunkDiff', (d)=>{ if (window.VoxelWorld) window.VoxelWorld.applyChunkDiff(d); });
  socket.on('tranqApplied', (d)=>{ const t=$('tranqOverlay'); if(t){ t.classList.remove('hidden'); setTimeout(()=> t.classList.add('hidden'), (d && d.duration) || 8000); }});
  socket.on('shieldPicked', (d)=>{ $('shieldStatus') && ($('shieldStatus').textContent = `Shield: ${d.durability}`); });
  socket.on('shieldHit', (d)=>{ $('shieldStatus') && ($('shieldStatus').textContent = `Shield hit! remaining ${d.remaining}`); toast('Shield blocked a dart',1200); });
  socket.on('shieldDestroyed', (d)=>{ $('shieldStatus') && ($('shieldStatus').textContent = 'Shield lost'); });

  socket.on('shotFired', (info)=>{ // show visual
    try {
      const from = info.shooterPos || { x:0,y:1.6,z:0 };
      const to = info.targetPos || { x:0,y:1.6,z:0 };
      if (window.VoxelWorld && typeof window.VoxelWorld.spawnShotEffect === 'function') window.VoxelWorld.spawnShotEffect(from, to, info.blocked ? 0x999999 : 0xffff88);
      if (info.shooter && window.VoxelWorld && typeof window.VoxelWorld.animateMuzzleAtEntity === 'function') window.VoxelWorld.animateMuzzleAtEntity(info.shooter);
      if (info.target === window.myId) {
        // Show tranq overlay only if not fresh-join
        if (Date.now() > justJoinedUntil) {
          const el = document.getElementById('tranqOverlay'); if (el) { el.classList.remove('hidden'); setTimeout(()=> el.classList.add('hidden'), 3000); }
        }
        toast('You were hit!', 1800);
      }
    } catch (e) { console.warn('shotFired handler error', e); }
  });

  // support / other events handled elsewhere
  return socket;
}

function startPosLoop() { if (posInterval) return; posInterval = setInterval(()=>{ if (!socket || !socket.connected) return; let pos = { x:0,y:0,z:0,crouch:false }; try { if (window.VoxelWorld && typeof window.VoxelWorld.getPlayerPosition === 'function') pos = window.VoxelWorld.getPlayerPosition(); } catch(e){ pos = { x:0,y:0,z:0,crouch:false }; } socket.emit('pos', pos); }, POS_SEND_MS); }
function stopPosLoop(){ if (posInterval){ clearInterval(posInterval); posInterval=null; } }

async function attemptJoin(name, roomId, options={}) {
  if (!name || !name.trim()) throw new Error('empty_name');
  // encourage suffix but don't block
  if (/^[A-Za-z]{2,30}$/.test(name) && !name.includes('#')) {
    const ok = confirm(`${name} is a single-word base; append #1234?`);
    if (ok) name = `${name}#${('000'+Math.floor(Math.random()*10000)).slice(-4)}`;
  }
  const sock = setupSocket();
  if (!sock) throw new Error('socket_init_failed');
  if (!sock.connected) {
    await new Promise((resolve,reject)=>{ const t=setTimeout(()=>reject(new Error('socket_connect_timeout')),8000); sock.once('connect', ()=>{ clearTimeout(t); resolve(); }); });
  }

  // Save requested session early so refresh while waiting keeps values
  saveSession({ name, roomId, botCount: options && options.botCount ? options.botCount : undefined });

  showWaiting('Joining…');
  return new Promise((resolve,reject)=>{
    const cb = (ack) => { hideWaiting(); console.log('[client] join ack', ack); if (ack && ack.ok) resolve(ack); else reject(new Error((ack && ack.error) || 'join_failed')); };
    try { if (typeof sock.timeout === 'function') sock.timeout(10000).emit('joinGame', { name, roomId, options }, cb); else sock.emit('joinGame', { name, roomId, options }, cb); } catch (e) { hideWaiting(); reject(new Error('emit_error')); }
  });
}

function showWaiting(msg='Working…'){ let o=document.querySelector('.waiting-overlay'); if(!o){ o=document.createElement('div'); o.className='waiting-overlay'; Object.assign(o.style,{position:'fixed',left:'50%',top:'50%',transform:'translate(-50%,-50%)',background:'rgba(3,7,18,0.92)',padding:'12px 18px',color:'#e5e7eb',borderRadius:'8px',zIndex:999}); document.body.appendChild(o);} o.textContent=msg; o.style.display='block'; }
function hideWaiting(){ const o=document.querySelector('.waiting-overlay'); if(o) o.style.display='none'; }

function handleJoinedRoom(payload) {
  console.log('handleJoinedRoom', payload);
  window.myId = payload && payload.playerId;
  // mark justJoined window (ignore immediate tranq UI)
  justJoinedUntil = Date.now() + 1500; // 1.5s grace
  // persist session so refresh restores
  const sess = loadSession() || {};
  sess.name = payload && payload.name || sess.name;
  sess.roomId = (new URL(location)).searchParams.get('room') || sess.roomId || 'default';
  saveSession(sess);

  $('playerDisplayName') && ($('playerDisplayName').textContent = payload && payload.name || 'Player');
  $('roleLabel') && ($('roleLabel').textContent = payload && payload.role || '');
  myRole = payload && payload.role || '';
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const pagePlay = $('pagePlay'); if (pagePlay) pagePlay.classList.add('active');
  const hud = $('hud'); if (hud) hud.classList.remove('hidden');
  startPosLoop();

  // Start voxel renderer and request chunks - robust
  try {
    if (!voxelStarted && window.VoxelWorld && typeof window.VoxelWorld.start === 'function') {
      const ok = window.VoxelWorld.start();
      voxelStarted = !!ok;
      if (voxelStarted) {
        for (let cx=-2; cx<=2; cx++) for (let cz=-2; cz<=2; cz++) window.VoxelWorld.requestChunk(cx,cz);
        console.info('[client] VoxelWorld started and chunk requests issued');
      } else console.warn('[client] VoxelWorld.start returned false');
    } else if (window.VoxelWorld && typeof window.VoxelWorld.requestChunk === 'function') {
      for (let cx=-2; cx<=2; cx++) for (let cz=-2; cz<=2; cz++) window.VoxelWorld.requestChunk(cx,cz);
    }
  } catch (e) {
    console.error('[client] Failed to start VoxelWorld', e);
  }

  // adjust shoot button
  const shootBtn = $('shootBtn');
  if (shootBtn) shootBtn.style.display = (myRole === 'seeker') ? 'block' : 'none';

  // show hints
  const hints = $('hintsPanel'); if (hints) hints.classList.remove('hidden');
}

function handleStateUpdate(s) {
  try {
    const players = s.players || [];
    $('playersLabel') && ($('playersLabel').textContent = `${players.length} players`);
    const me = (Array.isArray(players) && players.find(p=>p.id === window.myId)) || null;
    const role = me && me.role || '';
    $('roleLabel') && ($('roleLabel').textContent = role ? role.toUpperCase() : '');
    // hide leaderboard to reduce clutter
    const lb = $('leaderboardList'); if (lb) { lb.innerHTML=''; }

    // Tranq overlay logic: show only if tranqUntil is in the future AND we're not in the just-joined grace period
    const tranqEl = $('tranqOverlay');
    if (me && me.tranqUntil && me.tranqUntil > Date.now() && Date.now() > justJoinedUntil) {
      if (tranqEl) tranqEl.classList.remove('hidden');
    } else {
      if (tranqEl) tranqEl.classList.add('hidden');
    }
    // update shoot button visibility
    const shootBtn = $('shootBtn'); if (shootBtn) shootBtn.style.display = (role === 'seeker') ? 'block' : 'none';

    // update remote players in VoxelWorld
    if (window.VoxelWorld && typeof window.VoxelWorld.updatePlayers === 'function') window.VoxelWorld.updatePlayers(players || []);
  } catch (e) { console.warn('HUD update failed', e); }
}

function doShoot() {
  if (!socket || !socket.connected) { alert('Not connected'); return; }
  if (myRole !== 'seeker') { alert('Only Seekers can shoot'); return; }
  socket.emit('shoot', {}, (ack) => {
    if (ack && ack.ok) {
      if (ack.blocked) toast('Shot blocked by shield', 1400);
      else toast('Shot fired', 900);
    } else toast('No target', 1000);
  });
}

async function placeBlockAt(cx,cz,x,y,z,blockId) { if (window.VoxelWorld) window.VoxelWorld.setBlockLocal(cx,cz,x,y,z,blockId); if (!socket || !socket.connected) return; socket.emit('blockPlace', { cx,cz,x,y,z,block:blockId }, (ack) => { if (ack && ack.ok) console.log('blockPlace ok'); else console.warn('blockPlace failed', ack); }); }
async function removeBlockAt(cx,cz,x,y,z) { if (window.VoxelWorld) window.VoxelWorld.setBlockLocal(cx,cz,x,y,z,0); if (!socket || !socket.connected) return; socket.emit('blockRemove', { cx,cz,x,y,z }, (ack) => { if (ack && ack.ok) console.log('blockRemove ok'); else console.warn('blockRemove failed', ack); }); }
async function tryPickup() { if (!socket || !socket.connected) return; socket.emit('pickup', {}, (ack) => { console.log('pickup ack', ack); if (ack && ack.ok) toast('Picked up item', 1200); else toast('No pickup nearby', 1200); }); }

function leaveMatch() {
  stopPosLoop();
  if (socket) {
    try { socket.disconnect(); } catch(e) {}
    socket = null;
  }
  voxelStarted = false;
  clearSession();
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.getElementById('pageLogin').classList.add('active');
  document.getElementById('hud') && document.getElementById('hud').classList.add('hidden');
  console.info('[client] left match and returned to login');
}

function initClickToPlayOverlay() {
  const overlay = document.getElementById('playOverlay');
  const canvas = document.getElementById('gameCanvas');
  if (!overlay || !canvas) return;
  overlay.addEventListener('click', (e) => {
    try { canvas.requestPointerLock && canvas.requestPointerLock(); overlay.classList.add('hidden'); } catch(e) { console.warn('pointer lock failed', e); overlay.classList.add('hidden'); }
  });
  document.addEventListener('pointerlockchange', () => {
    if (document.pointerLockElement === canvas) overlay.classList.add('hidden');
    else overlay.classList.remove('hidden');
  });
}

document.addEventListener('DOMContentLoaded', () => {
  setupSocket();
  initClickToPlayOverlay();

  const joinBtn = $('joinBtn'), createRoomBtn = $('createRoomBtn'), leaveBtn = $('leaveBtn');
  const nameInput = $('playerName'), roomInput = $('roomId'), botCount = $('botCount');
  const shootBtn = $('shootBtn');

  // Auto-fill name/room if session exists
  const sess = loadSession();
  if (sess && sess.name) {
    if (nameInput) nameInput.value = sess.name;
    if (roomInput) roomInput.value = sess.roomId || 'default';
    // If socket already connected, attempt auto-join (socket.connect handler also tries)
    if (socket && socket.connected) {
      attemptJoin(sess.name, sess.roomId || 'default', { botCount: sess.botCount || Number(botCount && botCount.value || 12) }).catch(err => { console.warn('auto-join failed', err); });
    }
  }

  if (joinBtn) joinBtn.addEventListener('click', async (e) => {
    e && e.preventDefault();
    const name = (nameInput && nameInput.value && nameInput.value.trim()) || '';
    const room = (roomInput && roomInput.value && roomInput.value.trim()) || 'default';
    const bc = Number(botCount && botCount.value || 12);
    if (!name) { alert('Please enter a name'); return; }
    joinBtn.disabled = true; joinBtn.textContent = 'Joining...';
    try {
      await attemptJoin(name, room, { botCount: Math.max(0, Math.min(64, bc)) });
    } catch (err) { console.error('join error', err); alert(err && err.message ? err.message : 'Join failed'); } finally { joinBtn.disabled = false; joinBtn.textContent = 'JOIN MATCH'; }
  });

  if (createRoomBtn) createRoomBtn.addEventListener('click', async (e)=> {
    e.preventDefault();
    createRoomBtn.disabled = true; createRoomBtn.textContent = 'Creating...';
    try {
      const resp = await fetch(`${BACKEND_URL}/create-room`, { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ botCount: Number(botCount && botCount.value || 12) }) });
      const j = await resp.json();
      if (!j.ok) throw new Error(j.error || 'create-room failed');
      $('inviteArea').classList.remove('hidden'); $('inviteText').textContent = `Invite: ${j.roomId} — ${j.url || (location.origin + '/?room=' + j.roomId)}`; roomInput && (roomInput.value = j.roomId);
    } catch (err) { console.error('create-room failed', err); alert('Could not create room: ' + (err && err.message ? err.message : 'error')); } finally { createRoomBtn.disabled = false; createRoomBtn.textContent = 'Create Room'; }
  });

  if (leaveBtn) leaveBtn.addEventListener('click', (e)=>{ e.preventDefault(); leaveMatch(); });

  if (shootBtn) { shootBtn.addEventListener('click', (e)=>{ e.preventDefault(); doShoot(); }); shootBtn.style.display='none'; }

  document.addEventListener('keydown', (e) => {
    if (e.code === 'KeyE') { tryPickup(); }
    if (e.code === 'KeyF') { if (typeof useSerum === 'function') useSerum(); }
  });
});

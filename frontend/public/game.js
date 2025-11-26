// Client: join + botCount, start voxel robustly, support Leave Match, click-to-play overlay integration.

const BACKEND_URL = (typeof window !== 'undefined' && window.__BACKEND_URL__ && window.__BACKEND_URL__.length)
  ? window.__BACKEND_URL__ : (typeof window !== 'undefined' && window.location && window.location.origin ? window.location.origin : 'https://survive.com');

console.log('BACKEND_URL =', BACKEND_URL);

const SESSION_KEY = 'survive.session.v1';
const POS_SEND_MS = 150;

function $(id){ return document.getElementById(id); }
function toast(msg, ms=2000){ const s=$('connectionStatus'); if(!s) return; const prev=s.textContent; s.textContent=msg; if(ms) setTimeout(()=>s.textContent=prev,ms); }
function saveSession(o){ try{ sessionStorage.setItem(SESSION_KEY, JSON.stringify(o||{})); }catch(e){} }
function loadSession(){ try{ const r=sessionStorage.getItem(SESSION_KEY); return r?JSON.parse(r):null;}catch(e){return null;} }
function clearSession(){ try{ sessionStorage.removeItem(SESSION_KEY);}catch(e){} }

let socket=null, posInterval=null, voxelStarted=false;

function setupSocket() {
  if (socket) return socket;
  socket = io(BACKEND_URL, { timeout: 7000, reconnectionAttempts: 6 });
  socket.on('connect', ()=>{ console.info('[socket] connected', socket.id); window.hts = window.hts || {}; window.hts.socketConnected = true; toast('Connected',1200); });
  socket.on('disconnect', ()=>{ console.info('[socket] disconnected'); window.hts.socketConnected=false; toast('Disconnected',1200); });
  socket.on('joinedRoom', (p)=>{ console.log('joinedRoom', p); handleJoinedRoom(p); });
  socket.on('joinError', (err)=>{ console.warn('joinError', err); if (err && err.message) alert(err.message); });
  socket.on('stateUpdate', (s)=>{ updateHUDFromState(s); });
  socket.on('chunkDiff', (d)=>{ console.log('chunkDiff', d); if (window.VoxelWorld) window.VoxelWorld.applyChunkDiff(d); });
  socket.on('tranqApplied', (d)=>{ const t=$('tranqOverlay'); if(t){ t.classList.remove('hidden'); setTimeout(()=> t.classList.add('hidden'), (d && d.duration) || 8000); }});
  socket.on('shieldPicked', (d)=>{ $('shieldStatus') && ($('shieldStatus').textContent = `Shield: ${d.durability}`); });
  socket.on('shieldHit', (d)=>{ $('shieldStatus') && ($('shieldStatus').textContent = `Shield hit! remaining ${d.remaining}`); toast('Shield blocked a dart',1200); });
  socket.on('shieldDestroyed', (d)=>{ $('shieldStatus') && ($('shieldStatus').textContent = 'Shield lost'); });
  return socket;
}

function startPosLoop() { if (posInterval) return; posInterval = setInterval(()=>{ if (!socket || !socket.connected) return; let pos = { x:0,y:0,z:0 }; try { if (typeof getPlayerPosition === 'function') pos = getPlayerPosition(); } catch(e) { pos = { x:0,y:0,z:0 }; } socket.emit('pos', pos); }, POS_SEND_MS); }
function stopPosLoop(){ if (posInterval){ clearInterval(posInterval); posInterval=null; } }

// attemptJoin now sends botCount in payload so server can spawn requested bots
async function attemptJoin(name, roomId, options={}) {
  if (!name || !name.trim()) throw new Error('empty_name');
  if (/^[A-Za-z]{2,30}$/.test(name) && !name.includes('#')) {
    const ok = confirm(`${name} is a single-word base; append #1234?`);
    if (!ok) throw new Error('name_requires_suffix');
    name = `${name}#${('000'+Math.floor(Math.random()*10000)).slice(-4)}`;
  }
  const sock = setupSocket();
  if (!sock) throw new Error('socket_init_failed');
  if (!sock.connected) {
    await new Promise((resolve,reject)=>{ const t=setTimeout(()=>reject(new Error('socket_connect_timeout')),6000); sock.once('connect', ()=>{ clearTimeout(t); resolve(); }); });
  }
  showWaiting('Joining…');
  return new Promise((resolve,reject)=>{
    const cb = (ack) => { hideWaiting(); console.log('[client] join ack', ack); if (ack && ack.ok) resolve(ack); else reject(new Error((ack && ack.error) || 'join_failed')); };
    try { if (typeof sock.timeout === 'function') sock.timeout(8000).emit('joinGame', { name, roomId, options }, cb); else sock.emit('joinGame', { name, roomId, options }, cb); } catch (e) { hideWaiting(); reject(new Error('emit_error')); }
  });
}

function showWaiting(msg='Working…'){ let o=document.querySelector('.waiting-overlay'); if(!o){ o=document.createElement('div'); o.className='waiting-overlay'; Object.assign(o.style,{position:'fixed',left:'50%',top:'50%',transform:'translate(-50%,-50%)',background:'rgba(3,7,18,0.92)',padding:'12px 18px',color:'#e5e7eb',borderRadius:'8px',zIndex:999}); document.body.appendChild(o);} o.textContent=msg; o.style.display='block'; }
function hideWaiting(){ const o=document.querySelector('.waiting-overlay'); if(o) o.style.display='none'; }

function handleJoinedRoom(payload) {
  console.log('handleJoinedRoom', payload);
  window.myId = payload && payload.playerId;
  saveSession({ name: payload && payload.name, roomId: (new URL(location)).searchParams.get('room') || 'default' });
  $('playerDisplayName') && ($('playerDisplayName').textContent = payload && payload.name || 'Player');
  $('roleLabel') && ($('roleLabel').textContent = payload && payload.role || '');
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const pagePlay = $('pagePlay'); if (pagePlay) pagePlay.classList.add('active');
  const hud = $('hud'); if (hud) hud.classList.remove('hidden');
  startPosLoop();

  // start voxel renderer and request nearby chunks
  try {
    if (!voxelStarted && window.VoxelWorld && typeof window.VoxelWorld.start === 'function') {
      const ok = window.VoxelWorld.start();
      voxelStarted = !!ok;
      if (voxelStarted) {
        for (let cx=-2; cx<=2; cx++) for (let cz=-2; cz<=2; cz++) window.VoxelWorld.requestChunk(cx,cz);
        console.info('[client] VoxelWorld started and chunk requests issued');
      } else {
        console.warn('[client] VoxelWorld.start returned false — not starting chunks');
      }
    } else if (window.VoxelWorld && typeof window.VoxelWorld.requestChunk === 'function') {
      for (let cx=-2; cx<=2; cx++) for (let cz=-2; cz<=2; cz++) window.VoxelWorld.requestChunk(cx,cz);
    }
  } catch (e) {
    console.error('[client] Failed to start VoxelWorld', e);
    const o = document.createElement('div'); o.className = 'waiting-overlay'; o.textContent = 'Could not start 3D scene: ' + (e && e.message || 'error'); document.body.appendChild(o);
  }
}

// HUD update
function updateHUDFromState(s) {
  try {
    const players = s.players || [];
    $('playersLabel') && ($('playersLabel').textContent = `${players.length} players`);
    const lb = $('leaderboardList'); if (lb) { lb.innerHTML=''; players.sort((a,b)=> (b.score||0)-(a.score||0)).slice(0,6).forEach(p=>{ const li=document.createElement('li'); li.textContent = `${p.name} ${p.isBot? '(bot)':''} — ${p.score||0}`; lb.appendChild(li); }); }
  } catch (e) { console.warn('HUD update failed', e); }
}

function doShoot() { if (!socket || !socket.connected) { alert('Not connected'); return; } socket.emit('shoot', {}, (ack) => { console.log('shoot ack', ack); if (ack && ack.ok && ack.target) toast('Shot hit: ' + ack.target, 2000); else toast('No target in range', 1200); }); }

// optimistic local block place + server event
async function placeBlockAt(cx,cz,x,y,z,blockId) { if (window.VoxelWorld) window.VoxelWorld.setBlockLocal(cx,cz,x,y,z,blockId); if (!socket || !socket.connected) return; socket.emit('blockPlace', { cx,cz,x,y,z,block:blockId }, (ack) => { if (ack && ack.ok) console.log('blockPlace ok'); else console.warn('blockPlace failed', ack); }); }
async function removeBlockAt(cx,cz,x,y,z) { if (window.VoxelWorld) window.VoxelWorld.setBlockLocal(cx,cz,x,y,z,0); if (!socket || !socket.connected) return; socket.emit('blockRemove', { cx,cz,x,y,z }, (ack) => { if (ack && ack.ok) console.log('blockRemove ok'); else console.warn('blockRemove failed', ack); }); }
async function tryPickup() { if (!socket || !socket.connected) return; socket.emit('pickup', {}, (ack) => { console.log('pickup ack', ack); if (ack && ack.ok) toast('Picked up shield', 1200); else toast('No shield nearby', 1200); }); }

// Leave match: disconnect and show login
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

// click-to-play overlay behavior (pointerlock request)
function initClickToPlayOverlay() {
  const overlay = document.getElementById('playOverlay');
  const canvas = document.getElementById('gameCanvas');
  if (!overlay || !canvas) return;
  overlay.addEventListener('click', (e) => {
    try { canvas.requestPointerLock && canvas.requestPointerLock(); overlay.classList.add('hidden'); } catch(e) { console.warn('pointer lock failed', e); overlay.classList.add('hidden'); }
  });
  // hide overlay when pointerlock enters
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

  const sess = loadSession();
  if (sess && sess.name) {
    if (nameInput) nameInput.value = sess.name;
    if (roomInput) roomInput.value = sess.roomId || 'default';
    attemptJoin(sess.name, sess.roomId || 'default', { botCount: sess.botCount || Number(botCount && botCount.value || 4) }).catch(err => { console.warn('auto-join failed', err); });
  }

  if (joinBtn) joinBtn.addEventListener('click', async (e) => {
    e && e.preventDefault();
    const name = (nameInput && nameInput.value && nameInput.value.trim()) || '';
    const room = (roomInput && roomInput.value && roomInput.value.trim()) || 'default';
    const bc = Number(botCount && botCount.value || 4);
    if (!name) { alert('Please enter a name'); return; }
    joinBtn.disabled = true; joinBtn.textContent = 'Joining...';
    try {
      await attemptJoin(name, room, { botCount: Math.max(0, Math.min(32, bc)) });
    } catch (err) { console.error('join error', err); alert(err && err.message ? err.message : 'Join failed'); } finally { joinBtn.disabled = false; joinBtn.textContent = 'JOIN MATCH'; }
  });

  if (createRoomBtn) createRoomBtn.addEventListener('click', async (e)=> {
    e.preventDefault();
    createRoomBtn.disabled = true; createRoomBtn.textContent = 'Creating...';
    try {
      const resp = await fetch(`${BACKEND_URL}/create-room`, { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ botCount: Number(botCount && botCount.value || 4) }) });
      const j = await resp.json();
      if (!j.ok) throw new Error(j.error || 'create-room failed');
      document.getElementById('inviteArea').classList.remove('hidden');
      document.getElementById('inviteText').textContent = `Invite: ${j.roomId} — ${j.url || (location.origin + '/?room=' + j.roomId)}`;
      roomInput && (roomInput.value = j.roomId);
    } catch (err) { console.error('create-room failed', err); alert('Could not create room: ' + (err && err.message ? err.message : 'error')); } finally { createRoomBtn.disabled = false; createRoomBtn.textContent = 'Create Room'; }
  });

  if (leaveBtn) leaveBtn.addEventListener('click', (e)=>{ e.preventDefault(); leaveMatch(); });

  if (shootBtn) { shootBtn.addEventListener('click', (e)=>{ e.preventDefault(); doShoot(); }); shootBtn.style.display='block'; }

  document.addEventListener('keydown', (e) => {
    if (e.code === 'KeyE') { tryPickup(); }
    if (e.code === 'KeyQ') {
      if (window.VoxelWorld) {
        const cam = window.VoxelWorld.getCamera ? window.VoxelWorld.getCamera() : null;
        if (cam) {
          const dir = new THREE.Vector3(); cam.getWorldDirection(dir);
          const pos = cam.position.clone().addScaledVector(dir, 3);
          const bx = Math.floor(pos.x), by = Math.floor(pos.y), bz = Math.floor(pos.z);
          const cx = Math.floor(bx / 16), cz = Math.floor(bz / 16);
          const lx = bx - cx*16, lz = bz - cz*16, ly = by;
          placeBlockAt(cx,cz,lx,ly,lz,1);
        }
      }
    }
    if (e.code === 'KeyR') {
      if (window.VoxelWorld) {
        const cam = window.VoxelWorld.getCamera ? window.VoxelWorld.getCamera() : null;
        if (cam) {
          const dir = new THREE.Vector3(); cam.getWorldDirection(dir);
          const pos = cam.position.clone().addScaledVector(dir, 3);
          const bx = Math.floor(pos.x), by = Math.floor(pos.y), bz = Math.floor(pos.z);
          const cx = Math.floor(bx / 16), cz = Math.floor(bz / 16);
          const lx = bx - cx*16, lz = bz - cz*16, ly = by;
          removeBlockAt(cx,cz,lx,ly,lz);
        }
      }
    }
  });
});

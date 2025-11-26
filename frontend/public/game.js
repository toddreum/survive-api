// Client: integrates mouse shooting (left-click), dash on right-click, shows shooter highlights,
// binds local shooting function window.doLocalShoot used by renderer, and manages serum use & HUD.

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

let socket=null, posInterval=null, voxelStarted=false, myRole='', myInventory = { serum:0 };

function setupSocket(){
  if (socket) return socket;
  socket = io(BACKEND_URL, { timeout:10000, reconnectionAttempts:10, transports:['polling','websocket'] });
  socket.on('connect', ()=>{ console.info('[socket] connected', socket.id); toast('Connected',1200); });
  socket.on('disconnect', (r)=>{ console.info('[socket] disconnected', r); toast('Disconnected',1200); });
  socket.on('joinedRoom', (p)=>{ handleJoinedRoom(p); });
  socket.on('stateUpdate', (s)=>{ handleStateUpdate(s); });
  socket.on('chunkDiff', (d)=>{ if (window.VoxelWorld) window.VoxelWorld.applyChunkDiff(d); });
  socket.on('shotFired', (info)=> {
    try {
      if (window.VoxelWorld && typeof window.VoxelWorld.spawnShotEffect === 'function') window.VoxelWorld.spawnShotEffect(info.shooterPos, info.targetPos, info.blocked ? 0x999999 : 0xffff88);
      if (info.shooter && window.VoxelWorld && typeof window.VoxelWorld.animateMuzzleAtEntity === 'function') window.VoxelWorld.animateMuzzleAtEntity(info.shooter);
      if (info.target === window.myId) { const el = $('tranqOverlay'); if (el) { el.classList.remove('hidden'); setTimeout(()=>el.classList.add('hidden'), 3000); } toast('You were hit!',1800); }
    } catch (e) { console.warn('shotFired', e); }
  });
  socket.on('shieldPicked', (d)=>{ $('shieldStatus') && ($('shieldStatus').textContent = `Shield: ${d.durability}`); });
  socket.on('serumPicked', (d)=>{ myInventory.serum = d.count || (myInventory.serum||0); updateInventoryHUD(); toast('Serum acquired',1400); });
  socket.on('serumUsed', (d)=>{ if (d && d.ok) { toast('You recovered', 1400); myInventory.serum = Math.max(0, (myInventory.serum||1)-1); updateInventoryHUD(); }});

  return socket;
}

function updateInventoryHUD(){ const s = $('shieldStatus'); if (s) s.textContent = `Serum: ${myInventory.serum}`; }

function startPosLoop(){ if (posInterval) return; posInterval = setInterval(()=>{ if (!socket || !socket.connected) return; let pos = { x:0,y:0,z:0,crouch:false }; try { if (window.VoxelWorld && typeof window.VoxelWorld.getPlayerPosition === 'function') pos = window.VoxelWorld.getPlayerPosition(); } catch(e){} socket.emit('pos', pos); }, POS_SEND_MS); }
function stopPosLoop(){ if (posInterval){ clearInterval(posInterval); posInterval=null; } }

async function attemptJoin(name, roomId, options={}) {
  if (!name || !name.trim()) throw new Error('empty_name');
  const sock = setupSocket();
  if (!sock) throw new Error('socket_init_failed');
  if (!sock.connected) { await new Promise((resolve,reject)=>{ const t=setTimeout(()=>reject(new Error('socket_connect_timeout')),10000); sock.once('connect', ()=>{ clearTimeout(t); resolve(); }); }); }
  showWaiting('Joining…');
  return new Promise((resolve,reject)=>{
    const cb = (ack) => { hideWaiting(); if (ack && ack.ok) resolve(ack); else reject(new Error((ack && ack.error) || 'join_failed')); };
    try { if (typeof sock.timeout === 'function') sock.timeout(15000).emit('joinGame', { name, roomId, options }, cb); else sock.emit('joinGame', { name, roomId, options }, cb); } catch(e){ hideWaiting(); reject(new Error('emit_error')); }
  });
}

function showWaiting(m='Working…'){ let o=document.querySelector('.waiting-overlay'); if(!o){ o=document.createElement('div'); o.className='waiting-overlay'; Object.assign(o.style,{position:'fixed',left:'50%',top:'50%',transform:'translate(-50%,-50%)',background:'rgba(3,7,18,0.92)',padding:'12px 18px',color:'#e5e7eb',borderRadius:'8px',zIndex:999}); document.body.appendChild(o);} o.textContent=m; o.style.display='block'; }
function hideWaiting(){ const o=document.querySelector('.waiting-overlay'); if(o) o.style.display='none'; }

function handleJoinedRoom(payload){
  window.myId = payload && payload.playerId;
  $('playerDisplayName') && ($('playerDisplayName').textContent = payload && payload.name || 'Player');
  myRole = payload && payload.role || '';
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  $('pagePlay').classList.add('active');
  $('hud').classList.remove('hidden');
  startPosLoop();
  if (!voxelStarted && window.VoxelWorld && typeof window.VoxelWorld.start === 'function') {
    voxelStarted = !!window.VoxelWorld.start();
    if (voxelStarted) for (let cx=-3; cx<=3; cx++) for (let cz=-3; cz<=3; cz++) window.VoxelWorld.requestChunk(cx,cz);
  }
  const shootBtn = $('shootBtn'); if (shootBtn) shootBtn.style.display = myRole === 'seeker' ? 'block' : 'none';
  updateInventoryHUD();
}

function handleStateUpdate(s){
  try {
    const players = s.players || [];
    $('playersLabel') && ($('playersLabel').textContent = `${players.length} players`);
    const me = players.find(p => p.id === window.myId);
    if (me) {
      myRole = me.role || myRole;
      if (me.tranqUntil && me.tranqUntil > Date.now()) { const el = $('tranqOverlay'); if (el) el.classList.remove('hidden'); } else { const el = $('tranqOverlay'); if (el) el.classList.add('hidden'); }
    }
    $('roleLabel') && ($('roleLabel').textContent = myRole ? myRole.toUpperCase() : '');
    const btn = $('shootBtn'); if (btn) btn.style.display = myRole === 'seeker' ? 'block' : 'none';
    if (window.VoxelWorld && typeof window.VoxelWorld.updatePlayers === 'function') window.VoxelWorld.updatePlayers(players);
  } catch (e) { console.warn('stateUpdate err', e); }
}

function doShoot(){ if (!socket || !socket.connected) { alert('Not connected'); return; } if (myRole !== 'seeker') { alert('Only Seekers can shoot'); return; } socket.emit('shoot', {}, (ack)=>{ if (ack && ack.ok) { if (ack.blocked) toast('Shot blocked',1200); else toast('Shot fired',900); } else toast('No target',1200); }); }

function tryPickup(){ if (!socket || !socket.connected) return; socket.emit('pickup', {}, (ack)=>{ if (ack && ack.ok) { if (ack.picked && ack.picked.type==='serum') { myInventory.serum = (myInventory.serum||0) + 1; updateInventoryHUD(); toast('Picked serum',1400); } else toast('Picked item',1200); } else toast('No pickup nearby',1200); }); }

function useSerum(){ if (!socket || !socket.connected) return; if (!myInventory.serum) { alert('No serum'); return; } socket.emit('useSerum', {}, (ack)=>{ if (ack && ack.ok) { myInventory.serum = Math.max(0, (myInventory.serum||1)-1); updateInventoryHUD(); toast('Serum used — recovered',1400); } else alert('Could not use serum'); }); }

function leaveMatch(){ stopPosLoop(); if (socket) try{ socket.disconnect(); }catch(e){} socket=null; voxelStarted=false; clearSession(); document.querySelectorAll('.page').forEach(p=>p.classList.remove('active')); $('pageLogin').classList.add('active'); $('hud') && $('hud').classList.add('hidden'); }

function initClickToPlayOverlay(){ const overlay = $('playOverlay'); const canvas = $('gameCanvas'); if(!overlay||!canvas) return; overlay.addEventListener('click', ()=>{ try { canvas.requestPointerLock && canvas.requestPointerLock(); overlay.classList.add('hidden'); } catch(e) { overlay.classList.add('hidden'); } }); document.addEventListener('pointerlockchange', ()=>{ if (document.pointerLockElement===canvas) overlay.classList.add('hidden'); else overlay.classList.remove('hidden'); }); }

// attach local shooting callable by renderer (left-click)
window.doLocalShoot = function(){ doShoot(); };

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
    attemptJoin(sess.name, sess.roomId || 'default', { botCount: sess.botCount || Number(botCount && botCount.value || 12) }).catch(err => { console.warn('auto-join failed', err); });
  }

  if (joinBtn) joinBtn.addEventListener('click', async (e)=> {
    e && e.preventDefault();
    const name = (nameInput && nameInput.value && nameInput.value.trim()) || '';
    const room = (roomInput && roomInput.value && roomInput.value.trim()) || 'default';
    const bc = Number(botCount && botCount.value || 12);
    if (!name) { alert('Please enter a name'); return; }
    joinBtn.disabled = true; joinBtn.textContent = 'Joining...';
    try { await attemptJoin(name, room, { botCount: Math.max(0, Math.min(64, bc)) }); } catch (err) { console.error('join error', err); alert(err && err.message ? err.message : 'Join failed'); } finally { joinBtn.disabled = false; joinBtn.textContent = 'JOIN MATCH'; }
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
  if (shootBtn) { shootBtn.addEventListener('click', (e)=>{ e.preventDefault(); doShoot(); }); shootBtn.style.display = 'none'; }

  document.addEventListener('keydown', (e) => {
    if (e.code === 'KeyE') tryPickup();
    if (e.code === 'KeyF') useSerum();
  });
});

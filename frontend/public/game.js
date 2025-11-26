// Client: unified control & HUD; binds window.doLocalShoot to send 'shoot' to server.
// Integrates with instanced renderer and handles serum/shield interactions.

const BACKEND_URL = (typeof window !== 'undefined' && window.__BACKEND_URL__ && window.__BACKEND_URL__.length)
  ? window.__BACKEND_URL__ : (typeof window !== 'undefined' && window.location && window.location.origin ? window.location.origin : 'https://survive.com');

const POS_SEND_MS = 120;
function $(id){ return document.getElementById(id); }

let socket = null, posInterval=null, voxelStarted=false, myRole='', myInventory={serum:0};

function setupSocket(){
  if (socket) return socket;
  socket = io(BACKEND_URL, { timeout:10000, reconnectionAttempts:10, transports:['polling','websocket'] });
  socket.on('connect', ()=>{ console.info('[socket] connected', socket.id); });
  socket.on('disconnect', ()=>{ console.info('[socket] disconnected'); });
  socket.on('joinedRoom', (p)=> handleJoined(p));
  socket.on('stateUpdate', (s)=> handleState(s));
  socket.on('chunkDiff', (d)=> { if (window.VoxelWorld) window.VoxelWorld.applyChunkDiff(d); });
  socket.on('shotFired', (info)=> { if (window.VoxelWorld) { window.VoxelWorld.spawnShotEffect(info.shooterPos, info.targetPos, info.blocked?0x999999:0xffff88); if (info.shooter && typeof window.VoxelWorld.animateMuzzleAtEntity==='function') window.VoxelWorld.animateMuzzleAtEntity(info.shooter); } if (info.target === window.myId) { const el=$('tranqOverlay'); if (el) { el.classList.remove('hidden'); setTimeout(()=>el.classList.add('hidden'),3000); } } });
  socket.on('serumPicked', (d)=> { myInventory.serum = d.count || (myInventory.serum||0); updateInvHUD(); });
  socket.on('serumUsed', (d)=> { if (d && d.ok) { myInventory.serum = Math.max(0, (myInventory.serum||1)-1); updateInvHUD(); } });
  return socket;
}

function updateInvHUD(){ const el=$('shieldStatus'); if (el) el.textContent = `Serum: ${myInventory.serum}`; }

function startPosLoop(){ if (posInterval) return; posInterval = setInterval(()=>{ if (!socket || !socket.connected) return; try { const pos = (window.VoxelWorld && window.VoxelWorld.getPlayerPosition) ? window.VoxelWorld.getPlayerPosition() : { x:0,y:0,z:0,crouch:false }; socket.emit('pos', pos); } catch(e){} }, POS_SEND_MS); }
function stopPosLoop(){ if (posInterval){ clearInterval(posInterval); posInterval=null; } }

async function attemptJoin(name, roomId, options={}){
  const sock = setupSocket();
  if (!sock) throw new Error('socket init failed');
  if (!sock.connected) { await new Promise((resolve,reject)=>{ const t=setTimeout(()=>reject(new Error('socket_connect_timeout')),10000); sock.once('connect', ()=>{ clearTimeout(t); resolve(); }); }); }
  return new Promise((resolve,reject)=>{ sock.emit('joinGame', { name, roomId, options }, (ack)=>{ if (ack && ack.ok) resolve(ack); else reject(new Error((ack && ack.error) || 'join_failed')); }); });
}

function handleJoined(payload){ window.myId = payload && payload.playerId; $('playerDisplayName') && ($('playerDisplayName').textContent = payload && payload.name || 'Player'); myRole = payload && payload.role || ''; document.querySelectorAll('.page').forEach(p=>p.classList.remove('active')); $('pagePlay').classList.add('active'); $('hud').classList.remove('hidden'); startPosLoop(); if (!voxelStarted && window.VoxelWorld && window.VoxelWorld.start) { voxelStarted = !!window.VoxelWorld.start(); if (voxelStarted) for (let cx=-3; cx<=3; cx++) for (let cz=-3; cz<=3; cz++) window.VoxelWorld.requestChunk(cx,cz); } const shootBtn = $('shootBtn'); if (shootBtn) shootBtn.style.display = myRole === 'seeker' ? 'block' : 'none'; updateInvHUD(); }

function handleState(s){ if (!s || !s.players) return; $('playersLabel') && ($('playersLabel').textContent = `${s.players.length} players`); const me = s.players.find(p => p.id === window.myId); if (me) { myRole = me.role || myRole; const el = $('tranqOverlay'); if (el) { if (me.tranqUntil && me.tranqUntil > Date.now()) el.classList.remove('hidden'); else el.classList.add('hidden'); } } $('roleLabel') && ($('roleLabel').textContent = myRole ? myRole.toUpperCase() : ''); const shootBtn = $('shootBtn'); if (shootBtn) shootBtn.style.display = myRole === 'seeker' ? 'block' : 'none'; if (window.VoxelWorld && window.VoxelWorld.updatePlayers) window.VoxelWorld.updatePlayers(s.players); }

function doShoot(){ if (!socket || !socket.connected) { alert('Not connected'); return; } if (myRole !== 'seeker') { alert('Only Seekers can shoot'); return; } socket.emit('shoot', {}, (ack) => { if (ack && ack.ok) { if (ack.blocked) toast('Shot blocked',1200); else toast('Shot fired',800); } else toast('No target',1200); }); }

function tryPickup(){ if (!socket || !socket.connected) return; socket.emit('pickup', {}, (ack)=>{ if (ack && ack.ok) { if (ack.picked && ack.picked.type==='serum') { myInventory.serum = (myInventory.serum||0) + 1; updateInvHUD(); toast('Serum picked',1400); } else toast('Picked item',1200); } else toast('No pickup',1200); }); }

function useSerum(){ if (!socket || !socket.connected) return; if (!myInventory.serum) { alert('No serum'); return; } socket.emit('useSerum', {}, (ack)=>{ if (ack && ack.ok) { myInventory.serum = Math.max(0, (myInventory.serum||1)-1); updateInvHUD(); toast('Serum used',1400); } else alert('Could not use serum'); }); }

window.doLocalShoot = function(){ doShoot(); };

document.addEventListener('DOMContentLoaded', () => {
  setupSocket();
  // UI bindings
  const joinBtn = $('joinBtn'), createRoomBtn = $('createRoomBtn'), leaveBtn = $('leaveBtn');
  const nameInput = $('playerName'), roomInput = $('roomId'), botCount = $('botCount');
  const shootBtn = $('shootBtn');
  if (joinBtn) joinBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    const name = (nameInput && nameInput.value && nameInput.value.trim()) || '';
    const room = (roomInput && roomInput.value && roomInput.value.trim()) || 'default';
    const bc = Number(botCount && botCount.value || 12);
    if (!name) { alert('Please enter name'); return; }
    joinBtn.disabled = true; joinBtn.textContent = 'Joining...';
    try { await attemptJoin(name, room, { botCount: Math.max(0, Math.min(64, bc)) }); } catch (err) { console.error('join error', err); alert(err && err.message ? err.message : 'Join failed'); } finally { joinBtn.disabled = false; joinBtn.textContent = 'JOIN MATCH'; }
  });
  if (createRoomBtn) createRoomBtn.addEventListener('click', async (e)=>{ e.preventDefault(); createRoomBtn.disabled = true; createRoomBtn.textContent = 'Creating...'; try { const resp = await fetch(`${BACKEND_URL}/create-room`, { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ botCount: Number(botCount && botCount.value || 12) }) }); const j = await resp.json(); if (!j.ok) throw new Error(j.error || 'create-room failed'); $('inviteArea').classList.remove('hidden'); $('inviteText').textContent = `Invite: ${j.roomId} — ${j.url || (location.origin + '/?room=' + j.roomId)}`; roomInput && (roomInput.value = j.roomId); } catch (err) { console.error('create-room failed', err); alert('Could not create room: ' + (err && err.message ? err.message : 'error')); } finally { createRoomBtn.disabled = false; createRoomBtn.textContent = 'Create Room'; } });
  if (leaveBtn) leaveBtn.addEventListener('click', (e)=>{ e.preventDefault(); if (confirm('Leave match?')) { if (socket) socket.disconnect(); location.reload(); }});
  if (shootBtn) { shootBtn.addEventListener('click', (e)=>{ e.preventDefault(); doShoot(); }); shootBtn.style.display = 'none'; }
  document.addEventListener('keydown', (e)=>{ if (e.code === 'KeyE') tryPickup(); if (e.code === 'KeyF') useSerum(); });
});

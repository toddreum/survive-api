// frontend/public/game.js
// Polling-first socket.io client and join/create flow.
// Uses window.__BACKEND_URL__ (env.js) or falls back to window.location.origin.

const BACKEND_URL = (typeof window !== 'undefined' && window.__BACKEND_URL__ && window.__BACKEND_URL__.length) ? window.__BACKEND_URL__ : (typeof window !== 'undefined' && window.location && window.location.origin ? window.location.origin : 'https://survive.com');

console.log('BACKEND_URL =', BACKEND_URL);

// small helpers
function $(id){ return document.getElementById(id); }
function toast(msg, ms=2500){ const el = $('connectionStatus'); if(!el) return; const prev = el.textContent; el.textContent = msg; setTimeout(()=>el.textContent = prev, ms); }
function show(el){ if(!el) return; el.classList.remove('hidden'); el.classList.add('active'); }
function hide(el){ if(!el) return; el.classList.add('hidden'); el.classList.remove('active'); }

// client-side single-word name detection
function isSingleWordAlpha(name){
  if(!name || typeof name !== 'string') return false;
  const base = name.split('#')[0].trim();
  return /^[A-Za-z]{2,30}$/.test(base) && !name.includes('#');
}

// waiting overlay helpers
function showWaiting(msg='Working…'){ let o=document.querySelector('.waiting-overlay'); if(!o){ o=document.createElement('div'); o.className='waiting-overlay'; Object.assign(o.style,{position:'fixed',left:'50%',top:'50%',transform:'translate(-50%,-50%)',background:'rgba(3,7,18,0.92)',padding:'12px 18px',color:'#e5e7eb',borderRadius:'8px',zIndex:999}); document.body.appendChild(o); } o.textContent = msg; o.style.display='block'; }
function hideWaiting(){ const o=document.querySelector('.waiting-overlay'); if(o) o.style.display='none'; }

// Polling-only socket setup (safe for proxies)
let socket = null;
function setupPollingSocket(){
  if(socket) return socket;
  try {
    socket = io(BACKEND_URL, {
      transports: ['polling'],
      upgrade: false,
      reconnectionAttempts: 6,
      timeout: 7000
    });

    socket.on('connect', () => { toast('Connected'); console.info('[socket] connected', socket.id); window.hts = window.hts || {}; window.hts.socketConnected = true; });
    socket.on('connect_error', (err) => { console.warn('[socket] connect_error', err && err.message); window.hts = window.hts || {}; window.hts.socketConnected = false; });
    socket.on('disconnect', (reason) => { console.info('[socket] disconnected', reason); window.hts = window.hts || {}; window.hts.socketConnected = false; });
    socket.on('joinedRoom', (p) => { try { handleJoinedRoom && handleJoinedRoom(p); } catch(e){ console.warn('joinedRoom handler missing', e);} });
    socket.on('joinError', (err) => { console.warn('joinError', err); alert(err && err.message ? err.message : 'Join failed'); });
    socket.on('stateUpdate', (snap) => { window.currentSnapshot = snap; updateHUD(snap); });
    socket.on('tranqApplied', ({id,duration}) => { if (id === window.myId){ $('tranqOverlay') && $('tranqOverlay').classList.remove('hidden'); setTimeout(()=> $('tranqOverlay') && $('tranqOverlay').classList.add('hidden'), duration || 8000); }});
    
    // Voxel events
    socket.on('chunkData', (chunk) => { if (typeof window.onChunkData === 'function') window.onChunkData(chunk); });
    socket.on('blockUpdate', (data) => { console.log('blockUpdate', data); });
    
    // Capture/shield events
    socket.on('becameSeeker', () => { toast('You are now the Seeker!', 3000); updateRole('seeker'); });
    socket.on('captured', () => { toast('You were captured!', 3000); updateRole('hider'); });
    socket.on('shieldPickedUp', (data) => { toast('Shield picked up!', 2000); updateShieldHUD(data.durability); });
    socket.on('shieldHit', (data) => { toast('Shield hit!', 1500); updateShieldHUD(data.durability); });
    socket.on('shieldDestroyed', () => { toast('Shield destroyed!', 2000); updateShieldHUD(0); });
    socket.on('shieldSpawned', (shield) => { console.log('Shield spawned', shield); });
    socket.on('shieldRemoved', (data) => { console.log('Shield removed', data.itemId); });
    
    // Make socket globally accessible
    window.socket = socket;
    return socket;
  } catch (err) {
    console.error('setupPollingSocket failed', err);
    return null;
  }
}

// join flow: enforce name rule client-side, wait for server event
async function attemptJoin(name, roomId, options = {}) {
  // client-side name enforcement: single-word alpha must have # suffix or user can auto-append
  if (isSingleWordAlpha(name) && !name.includes('#')) {
    const ok = confirm(`${name} is a single-word name. Single-word bases require a # suffix (e.g., ${name}#1234).\n\nPress OK to append a random suffix and continue, Cancel to edit your name.`);
    if (!ok) throw new Error('name_requires_suffix');
    name = `${name}#${('000' + Math.floor(Math.random()*10000)).slice(-4)}`;
  }

  const sock = setupPollingSocket();
  if(!sock) throw new Error('socket_init_failed');

  // ensure connected with timeout
  if(!sock.connected){
    try {
      await new Promise((resolve, reject) => {
        const t = setTimeout(()=> reject(new Error('socket_connect_timeout')), 6000);
        sock.once('connect', ()=> { clearTimeout(t); resolve(); });
      });
    } catch (err) {
      console.warn('socket connect failed', err);
      throw new Error('socket_connect_failed');
    }
  }

  showWaiting('Joining…');
  sock.emit('joinGame', { name, roomId, options });

  return new Promise((resolve, reject) => {
    const to = setTimeout(()=> { hideWaiting(); reject(new Error('join_timeout')); }, 8000);
    function onJoined(payload){ clearTimeout(to); sock.off('joinError', onError); hideWaiting(); resolve(payload); }
    function onError(err){ clearTimeout(to); sock.off('joinedRoom', onJoined); hideWaiting(); reject(err); }
    sock.once('joinedRoom', onJoined);
    sock.once('joinError', onError);
  });
}

// joinedRoom UI handler
function handleJoinedRoom(payload) {
  try {
    console.log('handleJoinedRoom', payload);
    window.myId = payload && payload.playerId;
    // show HUD, switch to play page
    $('playerDisplayName') && ($('playerDisplayName').textContent = payload && payload.name || 'Player');
    $('roleLabel') && ($('roleLabel').textContent = '');
    $('playersLabel') && ($('playersLabel').textContent = '');
    // switch pages
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById('pagePlay') && document.getElementById('pagePlay').classList.add('active');
    // show HUD
    document.getElementById('hud') && document.getElementById('hud').classList.remove('hidden');
    // Initialize voxel renderer
    try { 
      if (typeof initVoxel === 'function') initVoxel(); 
      else if (typeof initThree === 'function') initThree(); 
    } catch (e) { console.warn('initVoxel/initThree failed', e); }
    
    // Start position emit loop
    startPosEmitLoop();
    
    toast('Joined ' + (payload && payload.roomId));
  } catch (e) {
    console.warn('handleJoinedRoom failed', e);
  }
}

// Helper: update HUD with state snapshot
function updateHUD(snap) {
  if (!snap || !snap.players) return;
  const myPlayer = snap.players.find(p => p.id === window.myId);
  if (myPlayer) {
    updateRole(myPlayer.role);
    updateShieldHUD(myPlayer.hasShield ? 3 : 0);
  }
  $('playersLabel') && ($('playersLabel').textContent = `Players: ${snap.players.length}`);
}

// Helper: update role display
function updateRole(role) {
  const roleLabel = $('roleLabel');
  if (roleLabel) {
    roleLabel.textContent = role === 'seeker' ? 'Role: SEEKER' : 'Role: HIDER';
    roleLabel.style.color = role === 'seeker' ? '#f97316' : '#7dd3fc';
  }
}

// Helper: update shield HUD
function updateShieldHUD(durability) {
  let shieldEl = $('shieldStatus');
  if (!shieldEl) {
    const hud = $('hud');
    if (hud) {
      shieldEl = document.createElement('div');
      shieldEl.id = 'shieldStatus';
      shieldEl.className = 'hud-row';
      hud.appendChild(shieldEl);
    }
  }
  if (shieldEl) {
    if (durability > 0) {
      shieldEl.textContent = `Shield: ${durability}`;
      shieldEl.style.color = '#7dd3fc';
    } else {
      shieldEl.textContent = '';
    }
  }
}

// Helper: start position emit loop
let posEmitInterval = null;
function startPosEmitLoop() {
  if (posEmitInterval) clearInterval(posEmitInterval);
  posEmitInterval = setInterval(() => {
    if (socket && socket.connected && typeof getPlayerPosition === 'function') {
      const pos = getPlayerPosition();
      socket.emit('pos', pos);
    }
  }, 100); // 10 Hz
}

function stopPosEmitLoop() {
  if (posEmitInterval) {
    clearInterval(posEmitInterval);
    posEmitInterval = null;
  }
}

// DOM wiring
document.addEventListener('DOMContentLoaded', () => {
  setupPollingSocket();

  const joinBtn = $('joinBtn');
  const nameInput = $('playerName');
  const roomInput = $('roomId');
  const botCount = $('botCount');
  const createRoomBtn = $('createRoomBtn');
  const inviteArea = $('inviteArea');
  const inviteText = $('inviteText');
  const copyInviteBtn = $('copyInviteBtn');
  const autoJoinCheckbox = $('autoJoinCheckbox');

  // Defensive nav fallback wiring (ensures nav buttons work)
  const navLogin = $('navLogin'), navHow = $('navHow'), navPlay = $('navPlay');
  const pageLogin = $('pageLogin'), pageHow = $('pageHow'), pagePlay = $('pagePlay');
  if(navLogin) navLogin.addEventListener('click', (e)=>{ e.preventDefault(); pageLogin.classList.add('active'); pageHow.classList.remove('active'); pagePlay.classList.remove('active'); });
  if(navHow) navHow.addEventListener('click', (e)=>{ e.preventDefault(); pageHow.classList.add('active'); pageLogin.classList.remove('active'); pagePlay.classList.remove('active'); });
  if(navPlay) navPlay.addEventListener('click', (e)=>{ e.preventDefault(); if(window.myId) { pagePlay.classList.add('active'); pageLogin.classList.remove('active'); pageHow.classList.remove('active'); try{ if(typeof initThree === 'function') initThree(); }catch(_){} } else { toast('Please JOIN MATCH first'); pageLogin.classList.add('active'); pageHow.classList.remove('active'); pagePlay.classList.remove('active'); } });

  if(joinBtn){
    joinBtn.addEventListener('click', async (ev) => {
      ev && ev.preventDefault();
      const name = (nameInput && nameInput.value && nameInput.value.trim()) || 'Player';
      const room = (roomInput && roomInput.value && roomInput.value.trim()) || 'default';
      const bots = Math.max(0, Math.min(16, Number(botCount && botCount.value || 4)));
      joinBtn.disabled = true; joinBtn.textContent = 'Joining...';
      try {
        await attemptJoin(name, room, { botCount: bots });
        // joinedRoom handler will update UI
      } catch (err) {
        console.error('join error', err);
        if (err && err.message === 'name_requires_suffix') {
          alert('Please edit your name to include a # suffix or allow the auto-suffix.');
        } else if (err && err.message === 'socket_connect_failed') {
          alert('Could not connect to server; please check backend is running.');
        } else if (err && err.message === 'join_timeout') {
          alert('join_timeout — server did not respond. Check server logs.');
        } else {
          alert(err && err.message ? err.message : 'Join failed');
        }
      } finally {
        joinBtn.disabled = false; joinBtn.textContent = 'JOIN MATCH';
      }
    });
  }

  if(createRoomBtn){
    createRoomBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      createRoomBtn.disabled = true; createRoomBtn.textContent = 'Creating...';
      try {
        const resp = await fetch(`${BACKEND_URL}/create-room`, { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ botCount: Number(botCount && botCount.value || 4) }) });
        const j = await resp.json();
        if (!j.ok) throw new Error(j.error || 'create-room failed');
        inviteArea && inviteArea.classList.remove('hidden');
        inviteText && (inviteText.textContent = `Invite: ${j.roomId} — ${j.url || (location.origin + '/?room=' + j.roomId)}`);
        if (copyInviteBtn) copyInviteBtn.onclick = async ()=>{ try{ await navigator.clipboard.writeText(j.url || (location.origin + '/?room=' + j.roomId)); toast('Copied'); } catch(e){ toast('Copy failed'); } };
        roomInput && (roomInput.value = j.roomId);
        if (autoJoinCheckbox && autoJoinCheckbox.checked) joinBtn && joinBtn.click();
      } catch (err) {
        console.error('create-room failed', err);
        alert('Could not create room: ' + (err && err.message ? err.message : 'error'));
      } finally {
        createRoomBtn.disabled = false; createRoomBtn.textContent = 'Create Room';
      }
    });
  }

  // Support modal wiring (same as earlier)
  const supportLink = $('supportLink'), supportModal = $('supportModal'), supportForm = $('supportForm'), supportCancel = $('supportCancel'), supportResult = $('supportResult');
  if (supportLink && supportModal && supportForm && supportCancel) {
    supportLink.addEventListener('click', (ev) => { ev.preventDefault(); supportModal.classList.remove('hidden'); supportResult.textContent = ''; setTimeout(()=> $('supName') && $('supName').focus(), 50); });
    supportCancel.addEventListener('click', (ev) => { ev.preventDefault(); supportModal.classList.add('hidden'); supportForm.reset(); supportResult.textContent = ''; });
    supportForm.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      supportResult.style.color = '#9ca3af'; supportResult.textContent = 'Sending…';
      const payload = {
        name: $('supName').value.trim(),
        email: $('supEmail').value.trim(),
        subject: $('supSubject').value.trim(),
        message: $('supMessage').value.trim()
      };
      try {
        const res = await fetch(`${BACKEND_URL}/support`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        const txt = await res.text();
        let j = null;
        try { j = txt ? JSON.parse(txt) : null; } catch(e){}
        if (res.ok && j && j.ok) {
          supportResult.style.color = '#7dd3fc'; supportResult.textContent = 'Thanks — your message was sent.';
          setTimeout(()=> { supportModal.classList.add('hidden'); supportForm.reset(); supportResult.textContent=''; }, 1400);
        } else {
          supportResult.style.color = '#fca5a5'; supportResult.textContent = (j && j.error) ? ('Error: ' + j.error) : (txt || 'Unknown server response');
        }
      } catch (err) {
        console.error('support submit error', err);
        supportResult.style.color = '#fca5a5'; supportResult.textContent = 'Network error — please try again later.';
      }
    });
    supportModal.addEventListener('click', (ev) => { if (ev.target === supportModal) { supportModal.classList.add('hidden'); supportForm.reset(); supportResult.textContent=''; } });
    document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { supportModal.classList.add('hidden'); supportForm.reset(); supportResult.textContent=''; }});
  }
});

// frontend/public/game.js
// Robust polling-first socket.io client with:
// - Session persistence (sessionStorage)
// - Ack-based join flow
// - Periodic position updates (every 150ms)
// - Auto-reconnect & auto-join from saved session
// - Event handlers for all game events
// Uses window.__BACKEND_URL__ (env.js) or falls back to window.location.origin.

const BACKEND_URL = (typeof window !== 'undefined' && window.__BACKEND_URL__ && window.__BACKEND_URL__.length) ? window.__BACKEND_URL__ : (typeof window !== 'undefined' && window.location && window.location.origin ? window.location.origin : 'https://survive.com');

console.log('[client] BACKEND_URL =', BACKEND_URL);

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

// Session persistence helpers
function saveSession(data) {
  try {
    sessionStorage.setItem('hts_session', JSON.stringify(data));
    console.log('[client] session saved', data);
  } catch (e) {
    console.warn('[client] failed to save session', e);
  }
}

function loadSession() {
  try {
    const raw = sessionStorage.getItem('hts_session');
    if (raw) {
      const data = JSON.parse(raw);
      console.log('[client] session loaded', data);
      return data;
    }
  } catch (e) {
    console.warn('[client] failed to load session', e);
  }
  return null;
}

function clearSession() {
  try {
    sessionStorage.removeItem('hts_session');
    console.log('[client] session cleared');
  } catch (e) {
    console.warn('[client] failed to clear session', e);
  }
}

// Position updates
let positionUpdateInterval = null;

function startPositionUpdates() {
  if (positionUpdateInterval) return;
  
  positionUpdateInterval = setInterval(() => {
    if (socket && socket.connected && window.myId) {
      const pos = getPlayerPosition();
      socket.emit('pos', pos);
    }
  }, 150);
  
  console.log('[client] position updates started');
}

function stopPositionUpdates() {
  if (positionUpdateInterval) {
    clearInterval(positionUpdateInterval);
    positionUpdateInterval = null;
    console.log('[client] position updates stopped');
  }
}

// Placeholder for getting player position (to be replaced by three.js)
function getPlayerPosition() {
  // This would normally come from the three.js scene
  // For now, return a placeholder or stored position
  return window.playerPosition || { x: 0, y: 0, z: 0 };
}

// Polling-only socket setup (safe for proxies)
let socket = null;
function setupPollingSocket(){
  if(socket) return socket;
  try {
    socket = io(BACKEND_URL, {
      transports: ['polling'],
      upgrade: false,
      reconnectionAttempts: 10,
      reconnectionDelay: 2000,
      reconnectionDelayMax: 10000,
      timeout: 7000
    });

    socket.on('connect', () => {
      toast('Connected');
      console.info('[socket] connected', socket.id);
      window.hts = window.hts || {};
      window.hts.socketConnected = true;
      
      // Auto-rejoin if we have a saved session
      const session = loadSession();
      if (session && session.roomId && session.name) {
        console.log('[client] auto-rejoining from saved session');
        attemptJoin(session.name, session.roomId, session.options || {}).catch(err => {
          console.warn('[client] auto-rejoin failed', err);
        });
      }
    });

    socket.on('connect_error', (err) => {
      console.warn('[socket] connect_error', err && err.message);
      window.hts = window.hts || {};
      window.hts.socketConnected = false;
    });

    socket.on('disconnect', (reason) => {
      console.info('[socket] disconnected', reason);
      window.hts = window.hts || {};
      window.hts.socketConnected = false;
      stopPositionUpdates();
    });

    socket.on('joinedRoom', (p) => {
      try {
        handleJoinedRoom && handleJoinedRoom(p);
      } catch(e) {
        console.warn('[client] joinedRoom handler error', e);
      }
    });

    socket.on('joinError', (err) => {
      console.warn('[socket] joinError', err);
      alert(err && err.message ? err.message : 'Join failed');
    });

    socket.on('stateUpdate', (snap) => {
      window.currentSnapshot = snap;
      updateHUD(snap);
    });

    socket.on('captured', (data) => {
      console.log('[socket] captured event', data);
      if (data.hiderId === window.myId) {
        toast('You were captured! You are now the SEEKER', 5000);
      } else if (data.seekerId === window.myId) {
        toast('You captured a hider!', 3000);
      }
    });

    socket.on('becameSeeker', () => {
      console.log('[socket] becameSeeker event');
      const roleLabel = $('roleLabel');
      if (roleLabel) roleLabel.textContent = 'Role: SEEKER';
      toast('You are now the SEEKER!', 4000);
    });

    socket.on('becameHider', () => {
      console.log('[socket] becameHider event');
      const roleLabel = $('roleLabel');
      if (roleLabel) roleLabel.textContent = 'Role: HIDER';
      toast('You are now a HIDER!', 4000);
    });

    socket.on('shieldPicked', (data) => {
      console.log('[socket] shieldPicked event', data);
      toast(`Shield picked! Durability: ${data.durability}`, 3000);
      updateShieldUI(data.durability);
    });

    socket.on('shieldHit', (data) => {
      console.log('[socket] shieldHit event', data);
      toast(`Shield hit! Durability: ${data.durability}`, 2000);
      updateShieldUI(data.durability);
    });

    socket.on('shieldDestroyed', () => {
      console.log('[socket] shieldDestroyed event');
      toast('Shield destroyed!', 3000);
      updateShieldUI(0);
    });

    socket.on('tranqApplied', ({id, duration}) => {
      if (id === window.myId) {
        $('tranqOverlay') && $('tranqOverlay').classList.remove('hidden');
        setTimeout(() => {
          $('tranqOverlay') && $('tranqOverlay').classList.add('hidden');
        }, duration || 8000);
      }
    });

    socket.on('playerJoined', (data) => {
      console.log('[socket] playerJoined', data);
      toast(`${data.name} joined as ${data.role}`, 2000);
    });

    socket.on('playerLeft', (data) => {
      console.log('[socket] playerLeft', data);
      toast('A player left', 2000);
    });

    return socket;
  } catch (err) {
    console.error('[client] setupPollingSocket failed', err);
    return null;
  }
}

// Update shield UI
function updateShieldUI(durability) {
  // This could be expanded to show shield indicator in HUD
  const hud = $('hud');
  if (!hud) return;
  
  let shieldEl = hud.querySelector('#shieldIndicator');
  if (!shieldEl) {
    shieldEl = document.createElement('div');
    shieldEl.id = 'shieldIndicator';
    shieldEl.className = 'hud-row';
    hud.appendChild(shieldEl);
  }
  
  if (durability > 0) {
    shieldEl.textContent = `Shield: ${durability}`;
    shieldEl.style.display = 'block';
  } else {
    shieldEl.style.display = 'none';
  }
}

// Update HUD with game state
function updateHUD(snapshot) {
  if (!snapshot || !snapshot.players) return;
  
  const playersLabel = $('playersLabel');
  if (playersLabel) {
    playersLabel.textContent = `Players: ${snapshot.players.length}`;
  }
  
  const myPlayer = snapshot.players.find(p => p.id === window.myId);
  if (myPlayer) {
    const roleLabel = $('roleLabel');
    if (roleLabel) {
      roleLabel.textContent = `Role: ${myPlayer.role.toUpperCase()}`;
    }
    
    if (myPlayer.hasShield) {
      updateShieldUI(myPlayer.shieldDurability);
    }
  }
}

// join flow: enforce name rule client-side, wait for server event with ack
async function attemptJoin(name, roomId, options = {}) {
  // Validate name is not empty
  if (!name || !name.trim()) {
    throw new Error('Name cannot be empty');
  }

  name = name.trim();

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
    console.log('[client] waiting for socket connection...');
    try {
      await new Promise((resolve, reject) => {
        const t = setTimeout(()=> reject(new Error('socket_connect_timeout')), 10000);
        sock.once('connect', ()=> { clearTimeout(t); resolve(); });
        if (sock.connected) { clearTimeout(t); resolve(); }
      });
    } catch (err) {
      console.warn('[client] socket connect failed', err);
      throw new Error('socket_connect_failed');
    }
  }

  showWaiting('Joining…');
  console.log('[client] emitting joinGame with ack', { name, roomId, options });

  return new Promise((resolve, reject) => {
    const to = setTimeout(()=> {
      hideWaiting();
      reject(new Error('join_timeout'));
    }, 10000);

    // Use ack-based join
    sock.emit('joinGame', { name, roomId, options }, (ackData) => {
      console.log('[client] joinGame ack received', ackData);
      
      if (ackData && ackData.error) {
        clearTimeout(to);
        hideWaiting();
        reject(new Error(ackData.error));
        return;
      }

      if (ackData && ackData.ok) {
        // Save session
        saveSession({ name, roomId, options });
      }
    });

    function onJoined(payload){
      console.log('[client] joinedRoom event received', payload);
      clearTimeout(to);
      sock.off('joinError', onError);
      hideWaiting();
      
      // Save session
      saveSession({ name, roomId, options });
      
      resolve(payload);
    }

    function onError(err){
      console.warn('[client] joinError event received', err);
      clearTimeout(to);
      sock.off('joinedRoom', onJoined);
      hideWaiting();
      reject(err);
    }

    sock.once('joinedRoom', onJoined);
    sock.once('joinError', onError);
  });
}

// joinedRoom UI handler
function handleJoinedRoom(payload) {
  try {
    console.log('[client] handleJoinedRoom', payload);
    window.myId = payload && payload.playerId;
    window.myRole = payload && payload.role;
    
    // show HUD, switch to play page
    $('playerDisplayName') && ($('playerDisplayName').textContent = payload && payload.name || 'Player');
    $('roleLabel') && ($('roleLabel').textContent = 'Role: ' + ((payload && payload.role || 'hider').toUpperCase()));
    $('playersLabel') && ($('playersLabel').textContent = 'Players: 1');
    $('connectionStatus') && ($('connectionStatus').textContent = 'Connected');
    
    // switch pages
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById('pagePlay') && document.getElementById('pagePlay').classList.add('active');
    
    // show HUD
    document.getElementById('hud') && document.getElementById('hud').classList.remove('hidden');
    
    // Start position updates
    startPositionUpdates();
    
    // optional: initThree() if you have a three.js init function
    try {
      if (typeof initThree === 'function') {
        console.log('[client] calling initThree()');
        initThree();
      }
    } catch (e) {
      console.warn('[client] initThree failed', e);
    }
    
    toast('Joined ' + (payload && payload.roomId));
  } catch (e) {
    console.warn('[client] handleJoinedRoom failed', e);
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
      const name = (nameInput && nameInput.value && nameInput.value.trim());
      
      // Forbid empty name
      if (!name) {
        alert('Please enter a name before joining.');
        nameInput && nameInput.focus();
        return;
      }
      
      const room = (roomInput && roomInput.value && roomInput.value.trim()) || 'default';
      const bots = Math.max(0, Math.min(16, Number(botCount && botCount.value || 4)));
      
      joinBtn.disabled = true;
      joinBtn.textContent = 'Joining...';
      
      try {
        console.log('[client] attempting join', { name, room, bots });
        await attemptJoin(name, room, { botCount: bots });
        // joinedRoom handler will update UI
      } catch (err) {
        console.error('[client] join error', err);
        if (err && err.message === 'Name cannot be empty') {
          alert('Please enter a name before joining.');
          nameInput && nameInput.focus();
        } else if (err && err.message === 'name_requires_suffix') {
          alert('Please edit your name to include a # suffix or allow the auto-suffix.');
        } else if (err && err.message === 'socket_connect_failed') {
          alert('Could not connect to server; please check backend is running.');
        } else if (err && err.message === 'join_timeout') {
          alert('Join timeout — server did not respond. Check server logs or try again.');
        } else {
          alert(err && err.message ? err.message : 'Join failed');
        }
      } finally {
        joinBtn.disabled = false;
        joinBtn.textContent = 'JOIN MATCH';
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

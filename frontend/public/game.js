// frontend/public/game.js
// - Reads BACKEND_URL from env.js (window.__BACKEND_URL__) or falls back to same origin.
// - Polling + websocket transports allowed (Render supports websockets).
// - Handles create-room, joinGame, and support form POST to /support.

const BACKEND_URL = (window.__BACKEND_URL__ && window.__BACKEND_URL__.length) ? window.__BACKEND_URL__ : window.location.origin;
console.log('BACKEND_URL =', BACKEND_URL);

function $(id) { return document.getElementById(id); }
function show(el){ el && el.classList.remove('hidden'); }
function hide(el){ el && el.classList.add('hidden'); }
function toastStatus(msg, ms = 2000){ const s = $('connectionStatus'); if(!s) return; const prev = s.textContent; s.textContent = msg; setTimeout(()=> s.textContent = prev, ms); }

let socket = null;
function setupSocket(){
  if (socket) return socket;
  try {
    socket = io(BACKEND_URL, { transports: ['polling','websocket'], upgrade: true, timeout: 8000 });
    socket.on('connect', () => { console.info('[socket] connected', socket.id); $('connectionStatus').textContent = 'Connected'; });
    socket.on('disconnect', () => { console.warn('[socket] disconnected'); $('connectionStatus').textContent = 'Disconnected'; });
    socket.on('joinedRoom', (p) => { console.log('joinedRoom', p); toastStatus('Joined: ' + (p && p.name), 2500); });
    socket.on('joinError', (err) => { console.warn('joinError', err); alert(err && err.message ? err.message : 'Join failed'); });
    socket.on('stateUpdate', (snap) => { window.currentSnapshot = snap; });
    return socket;
  } catch (e) {
    console.error('socket setup failed', e);
    return null;
  }
}

// Wait until DOM ready
document.addEventListener('DOMContentLoaded', () => {
  // Elements
  const joinBtn = $('joinBtn'), createRoomBtn = $('createRoomBtn'), copyInviteBtn = $('copyInviteBtn');
  const nameInput = $('playerName'), roomInput = $('roomId'), botCountInput = $('botCount');
  const inviteArea = $('inviteArea'), inviteText = $('inviteText');
  const supportLink = $('supportLink'), supportModal = $('supportModal'), supportForm = $('supportForm'), supportResult = $('supportResult'), supportCancel = $('supportCancel');

  // wire socket
  setupSocket();

  // Join
  if (joinBtn) joinBtn.addEventListener('click', (e) => {
    e.preventDefault();
    const name = (nameInput.value || 'Player').trim();
    const roomId = (roomInput.value || 'default').trim();
    const bots = Math.max(0, Math.min(16, Number(botCountInput.value || 4)));
    if (!socket || !socket.connected) {
      toastStatus('Connecting…');
      setupSocket();
      // small delay to let socket connect then emit
      setTimeout(() => {
        if (!socket || !socket.connected) { alert('Could not connect to server'); return; }
        socket.emit('joinGame', { name, roomId, options: { botCount: bots } });
        toastStatus('Joining…');
      }, 500);
      return;
    }
    socket.emit('joinGame', { name, roomId, options: { botCount: bots } });
    toastStatus('Joining…');
  });

  // Create room
  if (createRoomBtn) createRoomBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    createRoomBtn.disabled = true; createRoomBtn.textContent = 'Creating...';
    try {
      const resp = await fetch(`${BACKEND_URL}/create-room`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ botCount: Number(botCountInput.value || 4) }) });
      const j = await resp.json();
      if (j && j.ok) {
        inviteArea.classList.remove('hidden');
        inviteText.textContent = `Invite: ${j.roomId} — ${j.url || (location.origin + '/?room=' + j.roomId)}`;
        roomInput.value = j.roomId;
        if (copyInviteBtn) copyInviteBtn.onclick = async ()=>{ try{ await navigator.clipboard.writeText(j.url || (location.origin + '/?room=' + j.roomId)); toastStatus('Copied'); } catch(e){ toastStatus('Copy failed'); } };
      } else {
        alert('Create room failed: ' + (j && j.error));
      }
    } catch (err) {
      console.error('create-room error', err);
      alert('Could not create room');
    } finally {
      createRoomBtn.disabled = false; createRoomBtn.textContent = 'Create Room';
    }
  });

  // Support modal wiring
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
        } else if (res.ok && j && j.simulated) {
          supportResult.style.color = '#7dd3fc'; supportResult.textContent = 'Saved — support will review it.';
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

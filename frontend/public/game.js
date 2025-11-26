// Client updates for Photon Phase laser-tag:
// - All players can shoot (left-click or SHOOT button).
// - HUD now shows points and charge meter, and Phase button when eligible.
// - On hit we show shooter marker and a short description; we no longer tranquilize.
// - When Phase is active we allow temporary "phase" movement (client-side bypass of collision).
// - Rules updated on the How To Play page (index.html).

const BACKEND_URL = (typeof window !== 'undefined' && window.__BACKEND_URL__ && window.__BACKEND_URL__.length)
  ? window.__BACKEND_URL__ : (typeof window !== 'undefined' && window.location && window.location.origin ? window.location.origin : 'https://survive.com');

const POS_SEND_MS = 120;
const SESSION_KEY = 'survive.session.v1';
function $(id){ return document.getElementById(id); }

let socket = null, voxelStarted=false, myId=null, myRole='', myPoints=0, myCharge=0, myPhaseActive=false, myPhaseExpires=0;
window._myPhaseActive = false;

function setupSocket(){
  if (socket) return socket;
  socket = io(BACKEND_URL, { timeout:10000, reconnectionAttempts:5, transports:['polling','websocket'] });
  socket.on('connect', ()=> { console.info('[socket] connected'); });
  socket.on('disconnect', ()=> { console.info('[socket] disconnected'); });
  socket.on('joinedRoom', (p) => onJoined(p));
  socket.on('stateUpdate', s => onState(s));
  socket.on('playerHit', info => onPlayerHit(info));
  socket.on('phaseActivated', info => {
    if (info && info.id === myId) {
      myPhaseActive = true;
      myPhaseExpires = Date.now() + (info.duration || 6000);
      window._myPhaseActive = true;
      updateHUD();
      setTimeout(()=>{ myPhaseActive = false; window._myPhaseActive = false; updateHUD(); }, info.duration || 6000);
    }
  });
  return socket;
}

function onJoined(p){
  myId = p && p.playerId;
  myRole = p && p.role || 'player';
  $('playerDisplayName') && ($('playerDisplayName').textContent = p && p.name || 'You');
  document.querySelectorAll('.page').forEach(x=>x.classList.remove('active'));
  $('pagePlay').classList.add('active');
  $('hud').classList.remove('hidden');
  if (!voxelStarted && window.VoxelWorld && window.VoxelWorld.start) {
    voxelStarted = !!window.VoxelWorld.start();
    if (voxelStarted) for (let cx=-2; cx<=2; cx++) for (let cz=-2; cz<=2; cz++) window.VoxelWorld.requestChunk(cx,cz);
  }
  startPosLoop();
}

function onState(s){
  const players = s.players || [];
  $('playersLabel') && ($('playersLabel').textContent = `${players.length} players`);
  const me = players.find(p=>p.id === myId) || null;
  if (me) {
    myPoints = me.points || 0;
    myCharge = me.charge || 0;
    myPhaseActive = !!me.phaseActive;
    updateHUD();
  }
  if (window.VoxelWorld && typeof window.VoxelWorld.updatePlayers === 'function') window.VoxelWorld.updatePlayers(players);
}

function onPlayerHit(info){
  if (!info) return;
  if (info.target === myId) {
    const shooterName = info.shooter;
    toast(`Hit by ${shooterName}`, 3000);
    if (window.VoxelWorld && typeof window.VoxelWorld.showShooterMarker === 'function') {
      window.VoxelWorld.showShooterMarker(info.shooterPos || {x:0,y:1.6,z:0}, info.shooter, 6000);
    } else if (window.VoxelWorld && typeof window.VoxelWorld.spawnShotEffect === 'function') {
      window.VoxelWorld.spawnShotEffect(info.shooterPos || {x:0,y:1.6,z:0}, info.targetPos || {x:0,y:1.6,z:0}, 0xff6666);
    }
  }
  if (info.shooter === myId) {
    myPoints = info.shooterPoints || myPoints;
    myCharge = info.shooterCharge || myCharge;
    updateHUD();
  }
}

function updateHUD(){
  const scoreEl = document.getElementById('scoreLabel');
  if (scoreEl) scoreEl.textContent = `Points: ${myPoints}  Charge: ${myCharge}`;
  let phaseBtn = document.getElementById('phaseBtn');
  if (!phaseBtn) {
    phaseBtn = document.createElement('button'); phaseBtn.id = 'phaseBtn'; phaseBtn.className='btn-secondary'; phaseBtn.textContent='Activate Phase';
    phaseBtn.style.marginTop = '6px';
    phaseBtn.addEventListener('click', ()=> {
      if (!socket || !socket.connected) { toast('Not connected'); return; }
      socket.emit('usePhase', {}, (ack)=> {
        if (ack && ack.ok) { toast('Phase activated', 1200); myCharge = 0; updateHUD(); } else toast('Cannot activate phase'); 
      });
    });
    document.getElementById('hud').appendChild(phaseBtn);
  }
  phaseBtn.disabled = !(myCharge >= CHARGE_TO_PHASE) || myPhaseActive;
  if (myPhaseActive) phaseBtn.textContent = 'Phased'; else phaseBtn.textContent = 'Activate Phase';
}

window.doLocalShoot = function(){
  if (!socket || !socket.connected) { toast('Not connected'); return; }
  if (!myId) { toast('Not in a room'); return; }
  socket.emit('shoot', {}, (ack)=>{ if (ack && ack.ok) {} });
};

function startPosLoop(){
  setInterval(()=> {
    if (!socket || !socket.connected) return;
    try {
      const pos = (window.VoxelWorld && window.VoxelWorld.getPlayerPosition) ? window.VoxelWorld.getPlayerPosition() : { x:0,y:0,z:0,crouch:false };
      socket.emit('pos', pos);
    } catch(e){}
  }, POS_SEND_MS);
}

document.addEventListener('DOMContentLoaded', ()=> {
  setupSocket();
  const shootBtn = $('shootBtn'); if (shootBtn) { shootBtn.addEventListener('click', (e)=>{ e.preventDefault(); window.doLocalShoot(); }); shootBtn.style.display = 'block'; }
  if (window.VoxelWorld && window.VoxelWorld.start) { voxelStarted = !!window.VoxelWorld.start(); if (voxelStarted) for (let cx=-2; cx<=2; cx++) for (let cz=-2; cz<=2; cz++) window.VoxelWorld.requestChunk(cx,cz); }
  const sessJson = sessionStorage.getItem(SESSION_KEY); if (sessJson) {
    try {
      const sess = JSON.parse(sessJson); if (sess && sess.name) {
        setupSocket();
        socket && socket.connected && socket.emit('joinGame', { name: sess.name, roomId: sess.roomId||'default', options:{ botCount: sess.botCount||8 } }, ()=>{});
      }
    } catch (e) {}
  }
});

function toast(msg, ms=2000){ const s=$('connectionStatus'); if(!s) return; const prev=s.textContent; s.textContent=msg; if(ms) setTimeout(()=>s.textContent=prev,ms); }
const CHARGE_TO_PHASE = 5;

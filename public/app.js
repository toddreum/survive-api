// Survive.com — Dazzling, Real-time, Dynamic Frontend (multiplayer, avatars, charts, parallax, PWA-ready)
const $ = id => document.getElementById(id);
let state = { xp: 0, level: 1, streak: 0, missions: [], userId: 'demo' };

// --- Socket.IO Real-time XP Sync (backend integration ready) ---
const socket = io('https://your-realtime-server.com');
socket.on('xpUpdate', ({userId, xp, level, streak}) => {
  if(userId === state.userId) {
    state.xp = xp;
    state.level = level;
    state.streak = streak;
    renderStats();
    showXP(xp);
  }
});
function sendMissionComplete(missionId) {
  socket.emit('missionComplete', {userId: state.userId, missionId});
}

// --- Chart.js XP Progress ---
function renderXPChart() {
  const ctx = $('xpChart').getContext('2d');
  new Chart(ctx, {
    type: 'doughnut',
    data: { labels: ['XP'], datasets: [{ data: [state.xp, 500], backgroundColor: ['#ffd600','#e91e63'], borderWidth: 2 }] },
    options: { cutout: '80%', plugins: { legend: {display: false} }, animation: {animateScale: true} }
  });
}

// --- Parallax Effect ---
window.addEventListener('scroll', () => {
  document.querySelector('.hero').style.backgroundPositionY = -(window.scrollY/2)+'px';
});

// --- XP Pop ---
function showXP(amount) {
  let xp = document.createElement('div');
  xp.className = 'xp-pop';
  xp.textContent = `+${amount} XP!`;
  document.body.appendChild(xp);
  setTimeout(()=>xp.remove(),1000);
}

// --- Stats Row ---
function renderStats() {
  $('level').textContent = state.level;
  $('xp').textContent = state.xp;
  $('streak').textContent = state.streak + ' 🔥';
  let next = 500 + (state.level-1)*150;
  $('xpBar').style.width = Math.min(100, Math.round((state.xp/next)*100)) + '%';
}

// --- Main UI Logic ---
document.addEventListener('DOMContentLoaded', function() {
  renderStats();
  renderXPChart();
  // Animate avatar svg (could be dynamic per user in future)
  // Add more app logic here...
  // Wire up mission, chat, games, etc. as needed
});

// --- PWA Install Prompt already included in index.html ---

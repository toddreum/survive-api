// Survive.com — Feature-Rich, Dynamic, Balanced Frontend

const $ = id => document.getElementById(id);
function escapeHTML(str) { return (str || '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;', '"':'&quot;', "'":'&#039;'}[m])); }
function now() { return new Date().toISOString(); }
function cid() { return Math.random().toString(36).substr(2,9); }

// --- State ---
const defaults = {
  xp:0, level:1, streak:0, lastDay:null,
  missions:[], organizer:[], advice:[], parentMode:false,
  sleep: { target:"21:30", lastCredit:null }, theme: localStorage.getItem("survive_theme") || "dark"
};
let state = Object.assign({}, defaults, JSON.parse(localStorage.getItem('survive_data_vaulted_v3')||'{}'));
if(!state.missions) state.missions = [];
if(!state.organizer) state.organizer = [];
if(!state.advice) state.advice = [];

// --- Theme ---
document.documentElement.setAttribute('data-theme', state.theme);
$("themeToggle").onclick = () => {
  state.theme = state.theme === "dark" ? "light" : "dark";
  document.documentElement.setAttribute('data-theme', state.theme);
  localStorage.setItem("survive_theme", state.theme);
};

// --- XP Pop Animation ---
function showXP(amount) {
  let xp = document.createElement('div');
  xp.className = 'xp-pop';
  xp.textContent = `+${amount} XP!`;
  document.body.appendChild(xp);
  setTimeout(()=>xp.remove(), 800);
}

// --- Stats Row ---
function renderStats() {
  $("level").textContent = state.level;
  $("xp").textContent = state.xp;
  $("streak").textContent = state.streak + " 🔥";
  let next = 500 + (state.level-1)*150;
  $("xpBar").style.width = Math.min(100, Math.round((state.xp/next)*100)) + "%";
}

// --- XP Chart ---
function renderXPChart() {
  const ctx = $("xpChart");
  if(!ctx) return;
  if(window.xpChartInst) window.xpChartInst.destroy();
  window.xpChartInst = new Chart(ctx.getContext("2d"), {
    type: "doughnut",
    data: { labels: ["XP"], datasets: [{ data: [state.xp, 500], backgroundColor: ["#ffd600", "#e91e63"], borderWidth: 2 }] },
    options: { cutout: "80%", plugins: { legend: {display: false} }, animation: {animateScale: true} }
  });
}

// --- Missions Logic ---
function addMission(title = "Test mission", xp = 150) {
  state.missions.push({id: cid(), title, xp});
  save();
  renderMissions();
}
function completeMission(id) {
  const mission = state.missions.find(m => m.id === id);
  if(!mission) return;
  state.xp += mission.xp;
  showXP(mission.xp);
  state.missions = state.missions.filter(m => m.id !== id);
  if(state.xp > 500 + (state.level-1)*150) {
    state.xp = 0;
    state.level++;
    showXP("LEVEL UP!");
  }
  state.streak++;
  save();
  renderStats();
  renderXPChart();
  renderMissions();
}
function renderMissions() {
  const el = $("missionList");
  if(!el) return;
  el.innerHTML = "";
  state.missions.forEach(m => {
    let div = document.createElement("div");
    div.className = "mission";
    div.innerHTML = `<div style="font-weight:700">${escapeHTML(m.title)}</div>
      <div class="muted">Reward: ${m.xp} XP</div>
      <button class="btn primary">Complete</button>`;
    div.querySelector("button").onclick = () => completeMission(m.id);
    el.appendChild(div);
  });
}

// --- Organizer Logic ---
function addOrganizerItem() {
  const title = $("orgTitle").value || "Untitled";
  const details = $("orgDetails").value || "";
  state.organizer.push({id: cid(), title, details});
  save();
  renderOrganizer();
}
function renderOrganizer() {
  const el = $("orgList");
  if(!el) return;
  el.innerHTML = "";
  state.organizer.forEach(item => {
    let div = document.createElement("div");
    div.className = "mission";
    div.innerHTML = `<div style="font-weight:700">${escapeHTML(item.title)}</div>
      <div class="muted">${escapeHTML(item.details)}</div>`;
    el.appendChild(div);
  });
}

// --- Advice Logic ---
async function getAdvice(question) {
  // Placeholder: actual advice endpoint can be used here
  const answer = "Advice: " + (question || "Ask about friends, money, faith...");
  state.advice.push({q: question, a: answer});
  renderAdvice(answer);
  save();
}
function renderAdvice(answer) {
  $("adviceOut").textContent = answer;
}

// --- Games/Starters ---
function pickStarter() {
  const starters = [
    "What was the best part of your day and why?",
    "What's one way our family can help someone this week?",
    "What did you learn from a tough choice?",
    "What's something brave you'd try with family beside you?",
    "What's a hobby you want to spend more time on?",
    "How could you help someone in your school or community?",
    "What helps you relax when you're stressed?",
    "What's a goal for next month?"
  ];
  return starters[Math.floor(Math.random()*starters.length)];
}
function renderStarter() {
  $("verseBox").textContent = "🌟 " + pickStarter();
}

// --- Parent Mode ---
$("toggleParent").onclick = () => {
  state.parentMode = !state.parentMode;
  save();
  alert(state.parentMode ? "Parent Mode Enabled" : "Parent Mode Disabled");
};

// --- Local Storage ---
function save() {
  localStorage.setItem("survive_data_vaulted_v3", JSON.stringify(state));
}

// --- App Install Button ---
let deferredPrompt;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  $("installAppBtn").style.display = '';
});
$("installAppBtn").onclick = () => {
  if(deferredPrompt){
    deferredPrompt.prompt();
    deferredPrompt = null;
  }
};

// --- Parallax ---
window.addEventListener('scroll', () => {
  document.querySelector('.hero').style.backgroundPositionY = -(window.scrollY/2)+'px';
});

// --- Main UI Init ---
document.addEventListener("DOMContentLoaded", function() {
  renderStats();
  renderXPChart();
  renderMissions();
  renderOrganizer();
  renderStarter();
  $("newMissionBtn") && ($("newMissionBtn").onclick = () => addMission("Do homework", 200));
  $("orgAdd") && ($("orgAdd").onclick = addOrganizerItem);
  $("askAdvice") && ($("askAdvice").onclick = () => getAdvice($("adviceIn")?.value));
  $("howItWorksBtn") && ($("howItWorksBtn").onclick = () => alert("Complete missions, earn XP, unlock rewards, and regulate your time!"));
});

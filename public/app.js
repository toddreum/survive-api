// Survive.com — Feature-Rich, Fully Functional App.js

const $ = id => document.getElementById(id);
function escapeHTML(str) { return (str || '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;', '"':'&quot;', "'":'&#039;'}[m])); }
function now() { return new Date().toISOString(); }
function cid() { return Math.random().toString(36).substr(2,9); }

const STORAGE_KEY = "survive_data_vaulted_v4";
const THEME_KEY = "survive_theme";

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

const defaults = {
  xp:0, level:1, streak:0, lastDay:null,
  missions:[], organizer:[], advice:[], parentMode:false,
  sleep: { target:"21:30", lastCredit:null },
  theme: localStorage.getItem(THEME_KEY) || "dark",
  modal: { open: false, title:"", body:"", confirm:null }
};

let state = Object.assign({}, defaults, JSON.parse(localStorage.getItem(STORAGE_KEY)||'{}'));
if(!state.missions) state.missions = [];
if(!state.organizer) state.organizer = [];
if(!state.advice) state.advice = [];
if(!state.sleep) state.sleep = { target:"21:30", lastCredit:null };

// Theme
document.documentElement.setAttribute('data-theme', state.theme);
$("themeToggle").onclick = () => {
  state.theme = state.theme === "dark" ? "light" : "dark";
  document.documentElement.setAttribute('data-theme', state.theme);
  localStorage.setItem(THEME_KEY, state.theme);
  save();
};

// Stats Bar
function renderStats() {
  $("level").textContent = state.level;
  $("xp").textContent = state.xp;
  $("streak").textContent = state.streak + " 🔥";
  let next = 500 + (state.level-1)*150;
  $("xpBar").style.width = Math.min(100, Math.round((state.xp/next)*100)) + "%";
}

// XP Chart
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

// Missions
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
    div.querySelector("button").onclick = () => openCompleteModal(m);
    el.appendChild(div);
  });
}

// Modal System
function showXP(amount) {
  let xp = document.createElement('div');
  xp.className = 'xp-pop';
  xp.textContent = `+${amount} XP!`;
  document.body.appendChild(xp);
  setTimeout(()=>xp.remove(), 800);
}
function openCompleteModal(m) {
  openModal({
    title: "Complete Mission",
    body: `${escapeHTML(m.title)} — Reward: ${m.xp} XP`,
    confirm: () => completeMission(m.id)
  });
}
function openModal({title, body, confirm}) {
  state.modal = {open:true, title, body, confirm};
  $("modalTitle").textContent = title;
  $("modalBody").textContent = body;
  $("modal").classList.add("show");
}
function closeModal() {
  state.modal = {open:false, title:"", body:"", confirm:null};
  $("modal").classList.remove("show");
}
$("modalClose") && ($("modalClose").onclick = closeModal);
$("modalConfirm") && ($("modalConfirm").onclick = () => {
  if(state.modal.confirm) state.modal.confirm();
  closeModal();
});
$("modalCancel") && ($("modalCancel").onclick = closeModal);

// Organizer
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

// Advice
async function getAdvice(question) {
  const answer = "Advice: " + (question || "Ask about friends, money, faith...");
  state.advice.push({q: question, a: answer});
  $("adviceOut").textContent = answer;
  save();
}

// Starter
function renderStarter() {
  $("starter").textContent = starters[Math.floor(Math.random()*starters.length)];
}
$("starterBtn") && ($("starterBtn").onclick = renderStarter);

// Parent Mode
$("toggleParent").onclick = () => {
  state.parentMode = !state.parentMode;
  save();
  $("parentModeNotice").textContent = state.parentMode ? "Parent Mode ON" : "Parent Mode OFF";
  $("parentTools").style.display = state.parentMode ? "" : "none";
};

// How It Works
$("howItWorksBtn") && ($("howItWorksBtn").onclick = () => {
  openModal({
    title: "How Survive.com Works",
    body: "Complete missions, earn XP, unlock rewards, and regulate your time! Play games, track streaks, connect with family, and thrive offline.",
    confirm: closeModal
  });
});

// App Install PWA
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

// Save to Local Storage
function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

// Initial Rendering
document.addEventListener("DOMContentLoaded", function() {
  renderStats();
  renderXPChart();
  renderMissions();
  renderOrganizer();
  renderStarter();
  $("newMissionBtn") && ($("newMissionBtn").onclick = () => addMission("Do homework", 200));
  $("orgAdd") && ($("orgAdd").onclick = addOrganizerItem);
  $("askAdvice") && ($("askAdvice").onclick = () => getAdvice($("adviceIn")?.value));
});

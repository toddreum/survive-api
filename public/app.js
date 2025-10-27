// Survive.com — Full Feature-Rich (cPanel-style) App JS
// All logic for Missions, Organizer, Advice, Chat, Recipes, Goals, Vault, Sleep, Memories, Journal, Faith/Bible, Modals, Parent Mode, etc.

const $ = id => document.getElementById(id);
function escapeHTML(str) { return (str || '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;', '"':'&quot;', "'":'&#039;'}[m])); }
function now() { return new Date().toISOString(); }
function cid() { return Math.random().toString(36).slice(2,10); }

const starters = [
  "How did faith help you this week?",
  "Share a favorite Bible verse.",
  "What's a way to show kindness today?",
  "What is one thing you are grateful for?",
  "Name a challenge and a prayer for it.",
  "What does forgiveness mean to you?",
  "How can you help someone in need?"
];
const verses = [
  "Philippians 4:13 — I can do all things through Christ who strengthens me.",
  "Matthew 7:7 — Ask, and it will be given to you; seek, and you will find.",
  "Psalm 23:1 — The Lord is my shepherd; I shall not want.",
  "Joshua 1:9 — Be strong and courageous; do not be afraid.",
  "Proverbs 3:5 — Trust in the Lord with all your heart.",
  "Romans 8:28 — All things work together for good to those who love God."
];

let state = {
  xp: 0, level: 1, streak: 0,
  missions: [],
  organizer: [],
  advice: [],
  chat: [],
  memories: [],
  journal: [],
  recipes: [],
  goals: [],
  sleep: {target:"21:30",lastCredit:null},
  vault: {status:"Locked"},
  parentMode: false,
  theme: localStorage.getItem("survive_theme") || "dark"
};

document.documentElement.setAttribute('data-theme', state.theme);

$("themeToggle").onclick = () => {
  state.theme = state.theme === "dark" ? "light" : "dark";
  document.documentElement.setAttribute('data-theme', state.theme);
  localStorage.setItem("survive_theme", state.theme);
};

function showXP(amount) {
  let xp = document.createElement('div');
  xp.className = 'xp-pop';
  xp.textContent = `+${amount} XP!`;
  document.body.appendChild(xp);
  setTimeout(()=>xp.remove(), 800);
}

function renderXPChart() {
  const ctx = $("xpChart");
  if(window.xpChartInst) window.xpChartInst.destroy?.();
  window.xpChartInst = new Chart(ctx.getContext("2d"), {
    type: "doughnut",
    data: {
      labels: ["XP"],
      datasets: [{ data: [state.xp, 500], backgroundColor: ["#ffd600", "#e91e63"], borderWidth: 2 }]
    },
    options: { cutout: "80%", plugins: { legend: {display: false} }, animation: {animateScale: true} }
  });
}

function renderStats() {
  $("level").textContent = state.level;
  $("xp").textContent = state.xp;
  $("streak").textContent = state.streak + " 🔥";
  let next = 500 + (state.level-1)*150;
  $("xpBar").style.width = Math.min(100, Math.round((state.xp/next)*100)) + "%";
}

function addMission(title = "Test mission", xp = 150) {
  state.missions.push({id: cid(), title, xp});
  renderMissions();
}
function completeMission(id) {
  const mission = state.missions.find(m => m.id === id);
  if(!mission) return;
  state.xp += mission.xp;
  showXP(mission.xp);
  state.missions = state.missions.filter(m => m.id !== id);
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

function addOrganizerItem() {
  const title = $("orgTitle").value || "Untitled";
  const details = $("orgDetails").value || "";
  state.organizer.push({id: cid(), title, details});
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

async function getAdvice(question) {
  $("adviceOut").textContent = "Advice: " + (question || "Ask about friends, money, faith...");
}

function renderStarter() {
  $("starter").textContent = starters[Math.floor(Math.random()*starters.length)];
}
$("starterBtn").onclick = renderStarter;

function renderBibleVerse() {
  $("bibleVerse").textContent = verses[Math.floor(Math.random()*verses.length)];
  $("faithQuestion").textContent = starters[Math.floor(Math.random()*starters.length)];
}
$("refreshVerse").onclick = renderBibleVerse;

$("toggleParent").onclick = () => {
  state.parentMode = !state.parentMode;
  $("parentModeNotice").textContent = state.parentMode ? "Parent Mode ON" : "Parent Mode OFF";
  $("parentTools").style.display = state.parentMode ? "" : "none";
};

function sendChat() {
  const to = $("chatTo").value || "family";
  const msg = $("chatMsg").value;
  if(!msg) return;
  state.chat.push({id: cid(), to, msg, time: now()});
  renderChat();
  $("chatMsg").value = "";
}
function renderChat() {
  const el = $("chatList");
  if(!el) return;
  el.innerHTML = "";
  state.chat.slice(-10).forEach(c => {
    let div = document.createElement("div");
    div.className = "mission";
    div.innerHTML = `<div><b>${escapeHTML(c.to)}</b> <span class="muted">${new Date(c.time).toLocaleTimeString()}</span></div>
      <div>${escapeHTML(c.msg)}</div>`;
    el.appendChild(div);
  });
}

$("sleepSet").onclick = () => {
  state.sleep.target = $("sleepTime").value || "21:30";
  renderSleep();
};
$("sleepImInBed").onclick = () => {
  state.sleep.lastCredit = now();
  state.streak++;
  renderStats();
  renderSleep();
};
function renderSleep() {
  $("sleepStatus").textContent = "Sleep Goal: " + (state.sleep.target||"Not set") + ". Last credit: " + (state.sleep.lastCredit||"Never");
}

function addMemory() {
  const title = $("memTitle").value || "Untitled";
  const note = $("memText").value || "";
  state.memories.push({id: cid(), title, note, time: now()});
  renderMemories();
}
function renderMemories() {
  const el = $("memList");
  if(!el) return;
  el.innerHTML = "";
  state.memories.slice(-10).forEach(m => {
    let div = document.createElement("div");
    div.className = "mission";
    div.innerHTML = `<div><b>${escapeHTML(m.title)}</b> <span class="muted">${new Date(m.time).toLocaleDateString()}</span></div>
      <div>${escapeHTML(m.note)}</div>`;
    el.appendChild(div);
  });
}

function saveJournal() {
  const text = $("jtext").value;
  if(!text) return;
  state.journal.push({id: cid(), text, time: now()});
  renderJournal();
  $("jtext").value = "";
}
function renderJournal() {
  const el = $("journal");
  if(!el) return;
  el.innerHTML = "";
  state.journal.slice(-10).forEach(j => {
    let div = document.createElement("div");
    div.className = "mission";
    div.innerHTML = `<div class="muted">${new Date(j.time).toLocaleDateString()}</div>
      <div>${escapeHTML(j.text)}</div>`;
    el.appendChild(div);
  });
}

function addRecipe() {
  const title = $("recTitle").value || "Untitled";
  const body = $("recBody").value || "";
  state.recipes.push({id: cid(), title, body, time: now()});
  renderRecipes();
}
function renderRecipes() {
  const el = $("recList");
  if(!el) return;
  el.innerHTML = "";
  state.recipes.slice(-10).forEach(r => {
    let div = document.createElement("div");
    div.className = "mission";
    div.innerHTML = `<div><b>${escapeHTML(r.title)}</b> <span class="muted">${new Date(r.time).toLocaleDateString()}</span></div>
      <div>${escapeHTML(r.body)}</div>`;
    el.appendChild(div);
  });
}

function addGoal() {
  const title = $("goalTitle").value || "Untitled";
  const due = $("goalDue").value || "";
  state.goals.push({id: cid(), title, due});
  renderGoals();
}
function renderGoals() {
  const el = $("goalList");
  if(!el) return;
  el.innerHTML = "";
  state.goals.slice(-10).forEach(g => {
    let div = document.createElement("div");
    div.className = "mission";
    div.innerHTML = `<div><b>${escapeHTML(g.title)}</b> <span class="muted">Due: ${escapeHTML(g.due)}</span></div>`;
    el.appendChild(div);
  });
}

$("genGuest").onclick = () => {
  $("guestCode").value = cid();
  $("guestPIN").value = Math.floor(1000+Math.random()*9000);
  $("guestLink").textContent = window.location.origin + "/?guest=" + $("guestCode").value;
};
$("copyLink").onclick = () => {
  navigator.clipboard.writeText($("guestLink").textContent||"");
};

function renderInbox() {
  $("inbox").textContent = "No new messages";
}

function renderVault() {
  $("vaultStatus").textContent = "Vault status: " + (state.vault.status || "Locked");
}
$("vaultSet").onclick = () => { state.vault.status="Set"; renderVault(); };
$("vaultUnlock").onclick = () => { state.vault.status="Unlocked"; renderVault(); };
$("vaultLock").onclick = () => { state.vault.status="Locked"; renderVault(); };
$("vaultSyncNow").onclick = () => {};
$("vaultFetch").onclick = () => {};

$("howItWorksBtn").onclick = () => {
  alert("Complete missions, earn XP, unlock rewards, regulate your time, play games, track streaks, connect with family, and thrive offline.");
};

function renderAll() {
  renderStats();
  renderXPChart();
  renderMissions();
  renderOrganizer();
  renderStarter();
  renderBibleVerse();
  renderChat();
  renderSleep();
  renderMemories();
  renderJournal();
  renderRecipes();
  renderGoals();
  renderInbox();
  renderVault();
}

document.addEventListener("DOMContentLoaded", function() {
  renderAll();
  $("newMissionBtn").onclick = () => addMission("Do homework", 200);
  $("orgAdd").onclick = addOrganizerItem;
  $("askAdvice").onclick = () => getAdvice($("adviceIn")?.value);
  $("sendChat").onclick = sendChat;
  $("memAdd").onclick = addMemory;
  $("saveJ").onclick = saveJournal;
  $("recAdd").onclick = addRecipe;
  $("goalAdd").onclick = addGoal;
});

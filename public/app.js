// Survive.com — Original cPanel-style, feature-complete frontend

const $ = id => document.getElementById(id);

let state = {
  xp: 0, level: 1, streak: 0,
  missions: [],
  organizer: [],
  advice: [],
  theme: localStorage.getItem("survive_theme") || "dark"
};

document.documentElement.setAttribute('data-theme', state.theme);

function toggleTheme() {
  state.theme = state.theme === "dark" ? "light" : "dark";
  document.documentElement.setAttribute('data-theme', state.theme);
  localStorage.setItem("survive_theme", state.theme);
}

$("themeToggle").onclick = toggleTheme;

function showXP(amount) {
  let xp = document.createElement('div');
  xp.className = 'xp-pop';
  xp.textContent = `+${amount} XP!`;
  document.body.appendChild(xp);
  setTimeout(()=>xp.remove(), 800);
}

function renderXPChart() {
  const ctx = $("xpChart");
  if(window.xpChartInst) window.xpChartInst.destroy();
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
  state.missions.push({id: Date.now(), title, xp});
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
    div.innerHTML = `<div style="font-weight:700">${m.title}</div>
      <div class="muted">Reward: ${m.xp} XP</div>
      <button class="btn primary">Complete</button>`;
    div.querySelector("button").onclick = () => completeMission(m.id);
    el.appendChild(div);
  });
}

function addOrganizerItem() {
  const title = $("orgTitle").value || "Untitled";
  const details = $("orgDetails").value || "";
  state.organizer.push({id: Date.now(), title, details});
  renderOrganizer();
}
function renderOrganizer() {
  const el = $("orgList");
  if(!el) return;
  el.innerHTML = "";
  state.organizer.forEach(item => {
    let div = document.createElement("div");
    div.className = "mission";
    div.innerHTML = `<div style="font-weight:700">${item.title}</div>
      <div class="muted">${item.details}</div>`;
    el.appendChild(div);
  });
}

async function getAdvice(question) {
  $("adviceOut").textContent = "Advice: " + (question || "Ask about friends, money, faith...");
}

document.addEventListener("DOMContentLoaded", function() {
  renderStats();
  renderXPChart();
  renderMissions();
  renderOrganizer();

  $("newMissionBtn") && ($("newMissionBtn").onclick = () => addMission("Do homework", 200));
  $("orgAdd") && ($("orgAdd").onclick = addOrganizerItem);
  $("askAdvice") && ($("askAdvice").onclick = () => getAdvice($("adviceIn")?.value));
});

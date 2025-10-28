// Survive.com — Rebuilt app.js based on your previous cPanel version

const $ = id => document.getElementById(id);
function escapeHTML(str) { return (str || '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;', '"':'&quot;', "'":'&#039;'}[m])); }
function cid() { return Math.random().toString(36).slice(2,10); }
function now() { return new Date().toISOString(); }

const verses = [
  "Philippians 4:13 — I can do all things through Christ who strengthens me.",
  "Matthew 7:7 — Ask, and it will be given to you; seek, and you will find.",
  "Psalm 23:1 — The Lord is my shepherd; I shall not want.",
  "Joshua 1:9 — Be strong and courageous; do not be afraid.",
  "Proverbs 3:5 — Trust in the Lord with all your heart.",
  "Romans 8:28 — All things work together for good to those who love God."
];
const studyGuide = [
  "Read a daily passage from the Gospels.",
  "Discuss a lesson from Proverbs.",
  "Pray as a family about something important.",
  "Find one way to serve others this week.",
  "Write a Bible note or journal reflection."
];
const oneYearPlan = [
  "Day 1: Genesis 1-3",
  "Day 2: Genesis 4-7",
  "Day 3: Genesis 8-11",
  "Day 4: Matthew 1-2",
  "Day 5: Matthew 3-4"
  // ... Add the rest of the plan as needed
];

let state = {
  xp: 0, missions: [], chores: [], bibleNotes: [],
  parentMode: false, subscription: false
};

function save() {
  localStorage.setItem("survive_v18", JSON.stringify(state));
}
function load() {
  const d = localStorage.getItem("survive_v18");
  if(d) state = Object.assign(state, JSON.parse(d));
}
window.onload = () => {
  load();
  renderAll();
};

function renderAll() {
  renderBibleVerse();
  renderBibleStudy();
  renderOneYearPlan();
  renderBibleNotes();
  renderMissions();
  renderChores();
  renderAdvice();
  renderParentDashboard();
  renderSubscription();
}

function renderBibleVerse() {
  $("verseBox").textContent = verses[Math.floor(Math.random() * verses.length)];
}
function renderBibleStudy() {
  $("bibleStudyGuide").innerHTML = studyGuide.map(s=>`<li>${escapeHTML(s)}</li>`).join("");
}
function renderOneYearPlan() {
  $("oneYearPlan").innerHTML = oneYearPlan.map(p=>`<li>${escapeHTML(p)}</li>`).join("");
}

$("completeBibleStudy").onclick = () => {
  state.xp += 50;
  save();
  alert("Bible study complete! +50 XP");
};

$("saveBibleNote").onclick = () => {
  const txt = $("bibleNoteText").value.trim();
  if(!txt) return;
  state.bibleNotes.push({id: cid(), text: txt, date: now()});
  $("bibleNoteText").value = "";
  save();
  renderBibleNotes();
};
function renderBibleNotes() {
  $("bibleNotesList").innerHTML = state.bibleNotes.slice(-8).map(n=>
    `<div class="muted" style="margin-bottom:6px;"><b>${new Date(n.date).toLocaleDateString()}</b>: ${escapeHTML(n.text)}</div>`
  ).join('');
}

// Missions
$("menuNewMission").onclick = () => {
  const title = prompt("Enter new mission title:");
  if(!title) return;
  state.missions.push({id: cid(), title, xp: 100});
  save();
  renderMissions();
};
function renderMissions() {
  $("missionList").innerHTML = state.missions.slice(-8).map(m=>
    `<div style="margin-bottom:8px;">
      <b>${escapeHTML(m.title)}</b> <span class="muted">${m.xp} XP</span>
      <button class="btn success" onclick="completeMission('${m.id}')">Done</button>
    </div>`
  ).join('');
}
window.completeMission = function(id) {
  const m = state.missions.find(x=>x.id==id);
  if(m) {
    state.xp += m.xp;
    state.missions = state.missions.filter(x=>x.id!=id);
    save();
    renderMissions();
    alert(`Mission completed! +${m.xp} XP`);
  }
};

// Chores
$("addChore").onclick = () => {
  const title = $("choreTitle").value.trim();
  if(!title) return;
  state.chores.push({id: cid(), title, done: false});
  $("choreTitle").value = "";
  save();
  renderChores();
};
function renderChores() {
  $("choresList").innerHTML = state.chores.slice(-10).map(c=>
    `<div style="margin-bottom:7px;">
      <input type="checkbox" onclick="completeChore('${c.id}')" ${c.done ? 'checked' : ''}> 
      <b>${escapeHTML(c.title)}</b>
    </div>`
  ).join('');
}
window.completeChore = function(id) {
  const c = state.chores.find(x=>x.id==id);
  if(c) {
    c.done = true;
    state.xp += 20;
    save();
    renderChores();
    alert("Chore completed! +20 XP");
  }
};

// Family Mode / Parent Dashboard
$("toggleParent").onclick = () => {
  state.parentMode = !state.parentMode;
  save();
  $("parentDashboard").style.display = state.parentMode ? '' : 'none';
  renderParentDashboard();
};
function renderParentDashboard() {
  $("parentStats").innerHTML = `<div class="muted">Total XP: <b>${state.xp}</b></div>`;
  $("xpRedemptions").innerHTML = "<li>Family Movie Night</li><li>Dessert Pass</li><li>Extra Screen Time</li><li>Charity Donation</li>";
  $("missionApprovals").innerHTML = state.missions.map(m=>
    `<div style="margin-bottom:7px;">
      <b>${escapeHTML(m.title)}</b> <span class="muted">${m.xp} XP</span>
      <button class="btn success" onclick="completeMission('${m.id}')">Approve & Complete</button>
    </div>`
  ).join('');
}
$("parentAddMission").onclick = () => {
  const title = $("parentMissionTitle").value.trim();
  const xp = parseInt($("parentMissionXP").value,10)||100;
  if(!title) return;
  state.missions.push({id: cid(), title, xp});
  save();
  renderMissions();
  renderParentDashboard();
};

// Parent Vault (dummy logic)
$("parentVaultLogin").onclick = () => {
  if($("parentVaultPass").value === "family123") {
    $("parentVaultArea").innerHTML = "<div class='muted'>Vault unlocked: All kids' XP and notes are viewable here.</div>";
  } else {
    $("parentVaultArea").innerHTML = "<div class='muted'>Incorrect password.</div>";
  }
};

// Advice API (dummy logic, replace with backend API as needed)
$("askAdvice").onclick = async () => {
  $("adviceOut").textContent = "Thinking...";
  const question = $("adviceIn").value.trim();
  if(!question) { $("adviceOut").textContent = ""; return;}
  // Simulate API or replace with real fetch
  setTimeout(()=>{
    $("adviceOut").textContent = "Pray about it, read relevant Bible verses, and seek counsel from family or church. Conservative Christian values recommend faith, family, and wisdom.";
  }, 1200);
};

// Subscription / Stripe (dummy logic, replace with Stripe integration as needed)
$("subscribeBtn").onclick = () => {
  state.subscription = true;
  save();
  $("subscriptionStatus").textContent = "Subscribed! Thank you for supporting Survive.com.";
};

function renderSubscription() {
  $("subscriptionStatus").textContent = state.subscription ? "You are a premium subscriber!" : "";
}

// Theme Toggle
$("themeToggle").onclick = () => {
  document.documentElement.setAttribute('data-theme',
    document.documentElement.getAttribute('data-theme') === "dark" ? "light" : "dark"
  );
  save();
};

// How It Works
$("howItWorksBtn").onclick = () => {
  alert("Survive.com helps families regulate, thrive offline, and grow in faith. Complete missions, chores, Bible study, and more to earn XP and rewards.");
};

// Offline Break (dummy)
$("startBreak").onclick = () => {
  alert("Take a healthy offline break! Go outside, read, play, or spend time with family.");
};

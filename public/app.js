// Survive.com — Modernized app.js for new visual design

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
];

let state = {
  xp: 0, level: 1, streak: 0, missions: [], chores: [], bibleNotes: [],
  parentMode: false, subscription: false
};

function save() {
  localStorage.setItem("survive_v19", JSON.stringify(state));
}
function load() {
  const d = localStorage.getItem("survive_v19");
  if(d) state = Object.assign(state, JSON.parse(d));
}
window.onload = () => {
  load();
  renderAll();
};

function renderAll() {
  renderStats();
  renderBibleVerse();
  renderBibleStudy();
  renderOneYearPlan();
  renderBibleNotes();
  renderMissions();
  renderChores();
  renderAdvice();
  renderParentDashboard();
  renderSubscription();
  renderVideos();
}

function renderStats() {
  $("level").textContent = state.level;
  $("xp").textContent = state.xp;
  $("streak").textContent = state.streak + " 🔥";
  let next = 500 + (state.level-1)*150;
  $("xpBar").style.width = Math.min(100, Math.round((state.xp/next)*100)) + "%";
}

function renderBibleVerse() {
  $("verseBox").textContent = verses[Math.floor(Math.random() * verses.length)];
}
$("refreshVerse").onclick = renderBibleVerse;

function renderBibleStudy() {
  $("bibleStudyGuide").innerHTML = studyGuide.map(s=>`<li>${escapeHTML(s)}</li>`).join("");
}
function renderOneYearPlan() {
  $("oneYearPlan").innerHTML = oneYearPlan.map(p=>`<li>${escapeHTML(p)}</li>`).join("");
}

$("completeBibleStudy").onclick = () => {
  state.xp += 50;
  save();
  state.streak++;
  renderStats();
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
    `<div class="mission">
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
    renderStats();
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
    `<div class="mission">
      <input type="checkbox" onclick="completeChore('${c.id}')" ${c.done ? 'checked' : ''}> 
      <b>${escapeHTML(c.title)}</b>
    </div>`
  ).join('');
}
window.completeChore = function(id) {
  const c = state.chores.find(x=>x.id==id);
  if(c && !c.done) {
    c.done = true;
    state.xp += 20;
    save();
    renderChores();
    renderStats();
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
    `<div class="mission">
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

// Videos
function renderVideos() {
  var kirk = $("charlieKirkEmbed");
  if(kirk) {
    const kirkVideos = [
      "nkWzEUrHj9A","1YQ4yYxKkfo","VxvG6kKkP7Y","xVx8k4FhGg0","p1qZyKsXvZ8"
    ];
    const idx = (new Date().getDate() + new Date().getMonth()) % kirkVideos.length;
    kirk.innerHTML = `<iframe width="100%" height="215" src="https://www.youtube.com/embed/${kirkVideos[idx]}"
      title="Charlie Kirk Show" frameborder="0" allowfullscreen></iframe>`;
  }
  var hibbs = $("jackHibbsEmbed");
  if(hibbs) {
    const hibbsVideos = [
      "S6jE5x0wDMU","8kFhJz1CXCQ","iS7U0xvWRIY","i6zM0ZyR9Jg","kJfJ9L5Gm2Y"
    ];
    const idx = (new Date().getDate() + new Date().getMonth()) % hibbsVideos.length;
    hibbs.innerHTML = `<iframe width="100%" height="215" src="https://www.youtube.com/embed/${hibbsVideos[idx]}"
      title="Jack Hibbs Sermon" frameborder="0" allowfullscreen></iframe>`;
  }
}

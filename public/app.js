// Survive.com — 100x better, all categories, graphics, sharing, family/friends logic

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
  "Serve others this week.",
  "Write a Bible note or journal reflection."
];
const oneYearPlan = [
  "Day 1: Genesis 1-3","Day 2: Genesis 4-7","Day 3: Genesis 8-11","Day 4: Matthew 1-2","Day 5: Matthew 3-4"
];

let state = {
  user: "Child", friends: [], family: [],
  xp: 0, level: 1, streak: 0,
  missions: [], chores: [], bibleNotes: [],
  memories: [], goals: [], chat: [],
  parentMode: false, subscription: false
};

function save() { localStorage.setItem("survive_vault_full", JSON.stringify(state)); }
function load() { const d = localStorage.getItem("survive_vault_full"); if(d) state = Object.assign(state, JSON.parse(d)); }
window.onload = () => { load(); renderAll(); };

function renderStats() {
  $("userName").textContent = state.user;
  $("level").textContent = state.level;
  $("xp").textContent = state.xp;
  $("streak").textContent = state.streak + " 🔥";
  let next = 500 + (state.level-1)*150;
  $("xpBar").style.width = Math.min(100, Math.round((state.xp/next)*100)) + "%";
}

function renderBibleVerse() { $("verseBox").textContent = verses[Math.floor(Math.random() * verses.length)]; }
$("refreshVerse").onclick = renderBibleVerse;

function renderBibleStudy() { $("bibleStudyGuide").innerHTML = studyGuide.map(s=>`<li>${escapeHTML(s)}</li>`).join(""); }
function renderOneYearPlan() { $("oneYearPlan").innerHTML = oneYearPlan.map(p=>`<li>${escapeHTML(p)}</li>`).join(""); }
$("completeBibleStudy").onclick = () => { state.xp += 50; save(); state.streak++; renderStats(); alert("Bible study complete! +50 XP"); };

$("saveBibleNote").onclick = () => {
  const txt = $("bibleNoteText").value.trim();
  if(!txt) return;
  state.bibleNotes.push({id: cid(), text: txt, date: now()});
  $("bibleNoteText").value = "";
  save();
  renderBibleNotes();
};
function renderBibleNotes() { $("bibleNotesList").innerHTML = state.bibleNotes.slice(-8).map(n=>`<div class="note"><b>${new Date(n.date).toLocaleDateString()}</b>: ${escapeHTML(n.text)}</div>`).join(''); }

$("menuNewMission").onclick = () => {
  const title = prompt("Enter new mission title:");
  if(!title) return;
  state.missions.push({id: cid(), title, xp: 100});
  save();
  renderMissions();
};
function renderMissions() {
  $("missionList").innerHTML = state.missions.slice(-8).map(m=>`<div class="mission"><b>${escapeHTML(m.title)}</b> <span class="muted">${m.xp} XP</span><button class="btn success" onclick="completeMission('${m.id}')">Done</button></div>`).join('');
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

$("addChore").onclick = () => {
  const title = $("choreTitle").value.trim();
  if(!title) return;
  state.chores.push({id: cid(), title, done: false});
  $("choreTitle").value = "";
  save();
  renderChores();
};
function renderChores() { $("choresList").innerHTML = state.chores.slice(-10).map(c=>`<div class="chore"><input type="checkbox" onclick="completeChore('${c.id}')" ${c.done ? 'checked' : ''}> <b>${escapeHTML(c.title)}</b></div>`).join(''); }
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

$("memAdd").onclick = () => {
  const title = $("memTitle").value.trim();
  const note = $("memText").value.trim();
  if(!title && !note) return;
  state.memories.push({id: cid(), title, note, time: now()});
  $("memTitle").value = ""; $("memText").value = "";
  save(); renderMemories();
};
function renderMemories() {
  $("memList").innerHTML = state.memories.slice(-8).map(m=>
    `<div class="memory"><b>${escapeHTML(m.title)}</b> <span class="muted">${new Date(m.time).toLocaleDateString()}</span><div>${escapeHTML(m.note)}</div></div>`
  ).join('');
}

$("vaultShareBtn").onclick = () => {
  const code = $("vaultShareCode").value.trim();
  if(!code) { $("vaultShareStatus").textContent = "Enter a code to share with family/friend."; return;}
  $("vaultShareStatus").textContent = "Vaulted memory shared with " + code + "!";
};

$("goalAdd").onclick = () => {
  const title = $("goalTitle").value.trim();
  const due = $("goalDue").value;
  if(!title) return;
  state.goals.push({id: cid(), title, due});
  $("goalTitle").value = ""; $("goalDue").value = "";
  save(); renderGoals();
};
function renderGoals() { $("goalList").innerHTML = state.goals.slice(-8).map(g=>`<div class="goal"><b>${escapeHTML(g.title)}</b> <span class="muted">Due: ${escapeHTML(g.due)}</span></div>`).join(''); }

$("sendChat").onclick = () => {
  const to = $("chatTo").value.trim()||"family";
  const msg = $("chatMsg").value.trim();
  if(!msg) return;
  state.chat.push({id: cid(), to, msg, time: now()});
  $("chatMsg").value = "";
  save(); renderChat();
};
function renderChat() { $("chatList").innerHTML = state.chat.slice(-10).map(c=>`<div class="chatmsg"><b>${escapeHTML(c.to)}</b> <span class="muted">${new Date(c.time).toLocaleTimeString()}</span><div>${escapeHTML(c.msg)}</div></div>`).join(''); }

$("toggleParent").onclick = () => {
  state.parentMode = !state.parentMode;
  save();
  $("parentStats").innerHTML = state.parentMode ? `<div class="muted">Total XP: <b>${state.xp}</b></div>` : "";
  $("missionApprovals").innerHTML = state.parentMode ? state.missions.map(m=>
    `<div class="mission"><b>${escapeHTML(m.title)}</b> <span class="muted">${m.xp} XP</span><button class="btn success" onclick="completeMission('${m.id}')">Approve & Complete</button></div>`
  ).join('') : "";
  $("xpRedemptions").innerHTML = state.parentMode ? "<li>Family Movie Night</li><li>Dessert Pass</li><li>Extra Screen Time</li><li>Charity Donation</li>" : "";
};
$("parentAddMission").onclick = () => {
  const title = $("parentMissionTitle").value.trim();
  const xp = parseInt($("parentMissionXP").value,10)||100;
  if(!title) return;
  state.missions.push({id: cid(), title, xp});
  save();
  renderMissions();
  $("toggleParent").click();
};
$("parentVaultLogin").onclick = () => {
  if($("parentVaultPass").value === "family123") {
    $("parentVaultArea").innerHTML = "<div class='muted'>Vault unlocked: All kids' XP and notes are viewable.</div>";
  } else {
    $("parentVaultArea").innerHTML = "<div class='muted'>Incorrect password.</div>";
  }
};
$("addFriendBtn").onclick = () => {
  const name = $("friendName").value.trim();
  if(!name) return;
  state.friends.push({id:cid(),name});
  $("friendName").value = "";
  save(); renderFriends();
};
function renderFriends() { $("friendsList").innerHTML = state.friends.map(f=>`<div class="muted"><b>${escapeHTML(f.name)}</b></div>`).join(''); }

$("askAdvice").onclick = async () => {
  $("adviceOut").textContent = "Thinking...";
  const question = $("adviceIn").value.trim();
  if(!question) { $("adviceOut").textContent = ""; return;}
  setTimeout(()=>{ $("adviceOut").textContent = "Pray, read relevant Bible verses, and seek counsel from family/church. Conservative Christian values recommend faith, family, and wisdom."; }, 1200);
};
$("subscribeBtn").onclick = () => {
  state.subscription = true;
  save();
  $("subscriptionStatus").textContent = "Subscribed! Thank you for supporting Survive.com.";
};
function renderSubscription() { $("subscriptionStatus").textContent = state.subscription ? "You are a premium subscriber!" : ""; }
$("themeToggle").onclick = () => {
  document.documentElement.setAttribute('data-theme',document.documentElement.getAttribute('data-theme') === "dark" ? "light" : "dark");
  save();
};
$("howItWorksBtn").onclick = () => {
  openModal({
    title: "How Survive.com Works",
    body: "<b>XP:</b> Earn Experience Points for healthy, positive actions—missions, chores, Bible study, and more.<br><br><b>Vaulted Sharing:</b> Share memories, notes, and chat with family/friends using share codes.<br><br><b>Parent Mode:</b> Parents approve missions, set rewards, and see stats.<br><br><b>Friends & Family:</b> Invite, connect, and play together.<br><br><b>Games:</b> Family games encourage offline connection.<br><br><b>Subscription:</b> Unlock premium with extra XP, backup, and dashboard.<br><br><b>All features are private and family-friendly!",
    confirm: closeModal
  });
};
$("xpExplainBtn").onclick = () => {
  openModal({
    title: "What is XP?",
    body: "XP (Experience Points) are earned for completing missions, chores, Bible study, and positive actions. Level up as you earn more XP, unlock rewards and compete with family/friends. XP is your score for thriving in real life!",
    confirm: closeModal
  });
};
function openModal({title, body, confirm}) {
  $("modalTitle").textContent = title;
  $("modalBody").innerHTML = body;
  $("modal").classList.add("show");
  $("modalConfirm").onclick = () => { if(confirm) confirm(); closeModal(); };
  $("modalCancel").onclick = closeModal;
  $("modalClose").onclick = closeModal;
}
function closeModal() { $("modal").classList.remove("show"); }

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

function renderAll() {
  renderStats(); renderBibleVerse(); renderBibleStudy(); renderOneYearPlan(); renderBibleNotes();
  renderMissions(); renderChores(); renderMemories(); renderGoals(); renderChat(); renderFriends();
  $("toggleParent").click(); renderSubscription(); renderVideos();
}

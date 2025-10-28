// Survive.com — ALL features/cards, Bible study, parent sync, Stripe subscription, vaulted notes/photos, dreams, etc.

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

// Bible Study Plan
const biblePlan = [
  { step: "Read: Matthew 5:1-12", type: "read" },
  { step: "Reflect: What does 'Blessed' mean?", type: "reflect" },
  { step: "Journal: Write your thoughts.", type: "journal" },
  { step: "Pray: Ask God for wisdom today.", type: "pray" }
];
let todayStudy = { steps: biblePlan.map(s=>({ ...s, done: false, note: "" })), submitted: false, parentConfirmed: false };

let state = {
  user: "Child",
  xp: 0, level: 1, streak: 0,
  missions: [], chores: [], bibleNotes: [],
  journal: [], dreams: [], memories: [], goals: [], chat: [],
  church: [], youth: [], sunday: [],
  pets: [], dinner: [], crafts: [], cleaning: [], dishes: [],
  jobs: [], school: [],
  reminders: [],
  friends: [], family: [], employers: [],
  vaultedNotes: [],
  vaultedPhotos: [],
  parentPendingStudies: [],
  subscription: false
};

function save() { localStorage.setItem("survive_allfeatures", JSON.stringify(state)); }
function load() { const d = localStorage.getItem("survive_allfeatures"); if(d) state = Object.assign(state, JSON.parse(d)); }
window.onload = () => { load(); renderAll(); };

function renderStats() {
  $("userName").textContent = state.user || "Child";
  $("level").textContent = state.level;
  $("xp").textContent = state.xp;
  $("streak").textContent = state.streak + " 🔥";
  let next = 500 + (state.level-1)*150;
  $("xpBar").style.width = Math.min(100, Math.round((state.xp/next)*100)) + "%";
}

function addXP(amount) {
  state.xp += amount;
  let next = 500 + (state.level-1)*150;
  if(state.xp >= next) {
    state.level++;
    state.xp = state.xp-next;
    alert("Level up! 🎉");
  }
  save();
  renderStats();
}

// Bible verse
function renderBibleVerse() { $("verseBox").textContent = verses[Math.floor(Math.random() * verses.length)]; }
$("refreshVerse").onclick = renderBibleVerse;

// Guided Bible Study
function renderBibleStudySteps() {
  $("bibleStudySteps").innerHTML = todayStudy.steps.map((s,i) => {
    if(s.type === "journal") {
      return `<div><label>${escapeHTML(s.step)}</label>
        <textarea data-step="${i}" class="studyNote" ${s.done?'readonly':''}>${escapeHTML(s.note||'')}</textarea>
        <button class="btn btn2" onclick="markStudyStep(${i})" ${s.done?'disabled':''}>Save Note</button></div>`;
    } else {
      return `<div><label><input type="checkbox" data-step="${i}" ${s.done?'checked':''} onclick="markStudyStep(${i})"> ${escapeHTML(s.step)}</label></div>`;
    }
  }).join('');
  $("submitStudyBtn").disabled = !todayStudy.steps.every(s=>s.done) || todayStudy.submitted;
  $("studyStatus").textContent = todayStudy.parentConfirmed ? "Parent confirmed! +50 XP awarded." : todayStudy.submitted ? "Waiting for parent review..." : "";
}
window.markStudyStep = function(i) {
  const s = todayStudy.steps[i];
  if(s.type === "journal") {
    s.note = document.querySelector(`textarea[data-step="${i}"]`).value;
    s.done = !!s.note.trim();
  } else {
    s.done = true;
  }
  renderBibleStudySteps();
};
$("submitStudyBtn").onclick = () => {
  todayStudy.submitted = true;
  state.parentPendingStudies.push({...todayStudy});
  save();
  renderBibleStudySteps();
  renderParentPendingStudies();
  alert("Submitted for parent review.");
};
function renderParentPendingStudies() {
  $("parentPendingStudies").innerHTML = state.parentPendingStudies.map((study, idx) =>
    `<div>
      <b>Child Study for Today</b>: ${study.steps.filter(s=>s.done).length}/${study.steps.length} steps done
      <button class="btn success" onclick="confirmStudy(${idx})" ${study.parentConfirmed?'disabled':''}>Confirm</button>
    </div>`
  ).join('');
}
window.confirmStudy = function(idx) {
  state.parentPendingStudies[idx].parentConfirmed = true;
  todayStudy.parentConfirmed = true;
  addXP(50); // award XP for study
  save();
  renderBibleStudySteps();
  renderParentPendingStudies();
};

// Faith/Church
$("addChurchXP").onclick = () => { state.church.push({id:cid(),time:now()}); addXP(100); };
$("addYouthXP").onclick = () => { state.youth.push({id:cid(),time:now()}); addXP(70); };
$("addSundaySchoolXP").onclick = () => { state.sunday.push({id:cid(),time:now()}); addXP(80); };

// Journal
$("saveJournal").onclick = () => {
  const txt = $("journalText").value.trim();
  if(!txt) return;
  state.journal.push({id:cid(),text:txt,time:now()});
  $("journalText").value = "";
  addXP(10);
  renderJournal();
};
function renderJournal() { $("journalList").innerHTML = state.journal.slice(-8).map(n=>`<div class="item"><b>${new Date(n.time).toLocaleDateString()}</b>: ${escapeHTML(n.text)}</div>`).join(''); }

// Dreams Vault
$("saveDream").onclick = () => {
  const txt = $("dreamText").value.trim();
  if(!txt) return;
  state.dreams.push({id:cid(),text:txt,time:now()});
  $("dreamText").value = "";
  addXP(15);
  renderDreams();
};
function renderDreams() { $("dreamList").innerHTML = state.dreams.slice(-8).map(n=>`<div class="item"><b>${new Date(n.time).toLocaleDateString()}</b>: ${escapeHTML(n.text)}</div>`).join(''); }

// Vaulted Notes
$("sendVaultedNote").onclick = () => {
  const sender = $("vaultedNoteSender").value.trim();
  const txt = $("vaultedNoteText").value.trim();
  if(!txt || !sender) return;
  state.vaultedNotes.push({id:cid(),sender,text:txt,time:now()});
  $("vaultedNoteSender").value = "";
  $("vaultedNoteText").value = "";
  renderVaultedNotes();
  save();
};
function renderVaultedNotes() {
  $("vaultedNotesList").innerHTML = state.vaultedNotes.slice(-8).map(n=>
    `<div class="item"><b>${escapeHTML(n.sender)}</b>: ${escapeHTML(n.text)} <span class="muted">${new Date(n.time).toLocaleDateString()}</span></div>`
  ).join('');
}

// Vaulted Photos
$("sendPhoto").onclick = () => {
  const sender = $("photoSender").value.trim();
  const file = $("photoUpload").files[0];
  if(!file || !sender) return;
  const reader = new FileReader();
  reader.onload = function (e) {
    state.vaultedPhotos.push({id:cid(),sender,src:e.target.result,time:now()});
    $("photoSender").value = "";
    $("photoUpload").value = "";
    renderVaultedPhotos();
    save();
  };
  reader.readAsDataURL(file);
};
function renderVaultedPhotos() {
  $("vaultedPhotosList").innerHTML = state.vaultedPhotos.slice(-8).map(p=>
    `<div class="item"><b>${escapeHTML(p.sender)}</b><img class="photo-thumb" src="${p.src}" alt="photo"><span class="muted">${new Date(p.time).toLocaleDateString()}</span></div>`
  ).join('');
}

// Missions
$("addMission").onclick = () => {
  const title = $("missionTitle").value.trim();
  const xp = parseInt($("missionXP").value,10)||100;
  if(!title) return;
  state.missions.push({id:cid(),title,xp,done:false});
  $("missionTitle").value = "";
  $("missionXP").value = "100";
  renderMissions();
  save();
};
function renderMissions() { $("missionList").innerHTML = state.missions.slice(-8).map(m=>`<div class="item"><b>${escapeHTML(m.title)}</b> <span class="muted">${m.xp} XP</span><button class="btn success" onclick="markMissionReady('${m.id}')" ${m.done?'disabled':''}>Ready to review</button></div>`).join(''); }
window.markMissionReady = function(id) {
  const m = state.missions.find(x=>x.id==id);
  if(m) {
    m.done = true;
    renderMissions();
    save();
  }
};

// Chores
$("addChore").onclick = () => {
  const title = $("choreTitle").value.trim();
  if(!title) return;
  state.chores.push({id:cid(),title,done:false});
  $("choreTitle").value = "";
  renderChores();
  save();
};
function renderChores() { $("choresList").innerHTML = state.chores.slice(-10).map(c=>`<div class="item"><input type="checkbox" onclick="markChoreReady('${c.id}')" ${c.done ? 'checked':''}> <b>${escapeHTML(c.title)}</b></div>`).join(''); }
window.markChoreReady = function(id) {
  const c = state.chores.find(x=>x.id==id);
  if(c && !c.done) {
    c.done = true;
    renderChores();
    save();
  }
};

// Pets
$("addPetXP").onclick = () => {
  const desc = $("petAction").value.trim();
  if(!desc) return;
  state.pets.push({id:cid(),desc,time:now()});
  $("petAction").value = "";
  addXP(15);
  renderPets();
};
function renderPets() { $("petList").innerHTML = state.pets.slice(-8).map(p=>`<div class="item"><b>${new Date(p.time).toLocaleDateString()}</b>: ${escapeHTML(p.desc)}</div>`).join(''); }

// Dinner
$("addDinnerXP").onclick = () => {
  const desc = $("dinnerDesc").value.trim();
  if(!desc) return;
  state.dinner.push({id:cid(),desc,time:now()});
  $("dinnerDesc").value = "";
  addXP(20);
  renderDinner();
};
function renderDinner() { $("dinnerList").innerHTML = state.dinner.slice(-8).map(d=>`<div class="item"><b>${new Date(d.time).toLocaleDateString()}</b>: ${escapeHTML(d.desc)}</div>`).join(''); }

// Crafts
$("addCraftXP").onclick = () => {
  const desc = $("craftDesc").value.trim();
  if(!desc) return;
  state.crafts.push({id:cid(),desc,time:now()});
  $("craftDesc").value = "";
  addXP(20);
  renderCrafts();
};
function renderCrafts() { $("craftList").innerHTML = state.crafts.slice(-8).map(c=>`<div class="item"><b>${new Date(c.time).toLocaleDateString()}</b>: ${escapeHTML(c.desc)}</div>`).join(''); }

// Cleaning
$("addCleanXP").onclick = () => {
  const desc = $("cleanDesc").value.trim();
  if(!desc) return;
  state.cleaning.push({id:cid(),desc,time:now()});
  $("cleanDesc").value = "";
  addXP(20);
  renderCleaning();
};
function renderCleaning() { $("cleanList").innerHTML = state.cleaning.slice(-8).map(c=>`<div class="item"><b>${new Date(c.time).toLocaleDateString()}</b>: ${escapeHTML(c.desc)}</div>`).join(''); }

// Dishes
$("addDishesXP").onclick = () => {
  const desc = $("dishesDesc").value.trim();
  if(!desc) return;
  state.dishes.push({id:cid(),desc,time:now()});
  $("dishesDesc").value = "";
  addXP(20);
  renderDishes();
};
function renderDishes() { $("dishesList").innerHTML = state.dishes.slice(-8).map(d=>`<div class="item"><b>${new Date(d.time).toLocaleDateString()}</b>: ${escapeHTML(d.desc)}</div>`).join(''); }

// Jobs
$("addJobXP").onclick = () => {
  const title = $("jobTitle").value.trim();
  const xp = parseInt($("jobXP").value,10)||100;
  if(!title) return;
  state.jobs.push({id:cid(),title,xp,time:now()});
  $("jobTitle").value = "";
  $("jobXP").value = "100";
  addXP(xp);
  renderJobs();
};
function renderJobs() { $("jobList").innerHTML = state.jobs.slice(-8).map(j=>`<div class="item"><b>${escapeHTML(j.title)}</b> <span class="muted">${j.xp} XP</span> <span class="muted">${new Date(j.time).toLocaleDateString()}</span></div>`).join(''); }

// School
$("addSchoolXP").onclick = () => {
  const desc = $("schoolDesc").value.trim();
  if(!desc) return;
  state.school.push({id:cid(),desc,time:now()});
  $("schoolDesc").value = "";
  addXP(30);
  renderSchool();
};
function renderSchool() { $("schoolList").innerHTML = state.school.slice(-8).map(s=>`<div class="item"><b>${new Date(s.time).toLocaleDateString()}</b>: ${escapeHTML(s.desc)}</div>`).join(''); }

// Reminders
$("addReminder").onclick = () => {
  const txt = $("reminderText").value.trim();
  if(!txt) return;
  state.reminders.push({id:cid(),txt,time:now()});
  $("reminderText").value = "";
  renderReminders();
  save();
};
function renderReminders() { $("reminderList").innerHTML = state.reminders.slice(-8).map(r=>`<div class="item"><b>${new Date(r.time).toLocaleDateString()}</b>: ${escapeHTML(r.txt)}</div>`).join(''); }

// Friends
$("addFriend").onclick = () => {
  const name = $("friendName").value.trim();
  if(!name) return;
  state.friends.push({id:cid(),name});
  $("friendName").value = "";
  renderFriends();
  save();
};
function renderFriends() { $("friendsList").innerHTML = state.friends.slice(-8).map(f=>`<div class="item"><b>${escapeHTML(f.name)}</b></div>`).join(''); }

// Family
$("addFamily").onclick = () => {
  const name = $("familyName").value.trim();
  if(!name) return;
  state.family.push({id:cid(),name});
  $("familyName").value = "";
  renderFamily();
  save();
};
function renderFamily() { $("familyList").innerHTML = state.family.slice(-8).map(f=>`<div class="item"><b>${escapeHTML(f.name)}</b></div>`).join(''); }

// Employers
$("addEmployer").onclick = () => {
  const name = $("employerName").value.trim();
  if(!name) return;
  state.employers.push({id:cid(),name});
  $("employerName").value = "";
  renderEmployers();
  save();
};
function renderEmployers() { $("employersList").innerHTML = state.employers.slice(-8).map(e=>`<div class="item"><b>${escapeHTML(e.name)}</b></div>`).join(''); }

// Goals
$("addGoal").onclick = () => {
  const title = $("goalTitle").value.trim();
  const due = $("goalDue").value;
  if(!title) return;
  state.goals.push({id:cid(),title,due});
  $("goalTitle").value = ""; $("goalDue").value = "";
  renderGoals();
  save();
};
function renderGoals() { $("goalList").innerHTML = state.goals.slice(-8).map(g=>`<div class="item"><b>${escapeHTML(g.title)}</b> <span class="muted">Due: ${escapeHTML(g.due)}</span></div>`).join(''); }

// Chat
$("sendChat").onclick = () => {
  const to = $("chatTo").value.trim()||"family";
  const msg = $("chatMsg").value.trim();
  if(!msg) return;
  state.chat.push({id:cid(),to,msg,time:now()});
  $("chatMsg").value = "";
  renderChat();
  save();
};
function renderChat() { $("chatList").innerHTML = state.chat.slice(-10).map(c=>`<div class="item"><b>${escapeHTML(c.to)}</b> <span class="muted">${new Date(c.time).toLocaleTimeString()}</span><div>${escapeHTML(c.msg)}</div></div>`).join(''); }

// Advice
$("askAdvice").onclick = async () => {
  $("adviceOut").textContent = "Thinking...";
  const question = $("adviceIn").value.trim();
  if(!question) { $("adviceOut").textContent = ""; return;}
  setTimeout(()=>{ $("adviceOut").textContent = "Pray, read relevant Bible verses, and seek counsel from family/church. Conservative Christian values recommend faith, family, and wisdom."; }, 1200);
};

// XP Explain
$("xpExplainBtn").onclick = () => {
  openModal({
    title: "What is XP?",
    body: "XP (Experience Points) are earned for missions, chores, faith, jobs, school, friends, and all positive actions. Level up, unlock achievements, and see progress as you thrive in real life!",
    confirm: closeModal
  });
};

// Theme
$("themeToggle").onclick = () => {
  document.documentElement.setAttribute('data-theme',document.documentElement.getAttribute('data-theme') === "dark" ? "light" : "dark");
  save();
};

// How It Works
$("howItWorksBtn").onclick = () => {
  openModal({
    title: "How Survive.com Works",
    body: "<b>XP:</b> Earn for healthy actions—missions, chores, faith, school, jobs, crafts, pets, and more.<br><b>Cards:</b> Everything is a card—click, add, complete, and earn XP.<br><b>Vault:</b> All notes, dreams, chats, memories, photos are private and can be shared by family, friends, and employers.<br><b>Progress:</b> Level up, keep streaks, unlock achievements.<br><b>Fun:</b> Play, connect, thrive offline & online!",
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

// Stripe Subscription Demo
$("subscribeBtn").onclick = async () => {
  openModal({
    title: "Stripe Subscription",
    body: "Subscribe to Survive.com Premium for $4.99/month. This will open Stripe checkout.<br><br><button class='btn primary' id='stripeGoBtn'>Go to Stripe</button>",
    confirm: closeModal
  });
  setTimeout(()=>{
    document.getElementById('stripeGoBtn').onclick = ()=>{
      window.open("https://buy.stripe.com/test_8wMbJp4xD4gU3yQeUU","_blank");
      state.subscription = true;
      $("subscriptionStatus").textContent = "Subscribed! Thank you for supporting Survive.com.";
      save(); closeModal();
    };
  },100);
};

function renderAll() {
  renderStats(); renderBibleVerse(); renderBibleStudySteps(); renderJournal(); renderDreams();
  renderVaultedNotes(); renderVaultedPhotos(); renderMissions(); renderChores();
  renderPets(); renderDinner(); renderCrafts(); renderCleaning(); renderDishes();
  renderJobs(); renderSchool(); renderReminders(); renderFriends(); renderFamily();
  renderEmployers(); renderGoals(); renderChat(); renderVideos(); renderParentPendingStudies();
  $("subscriptionStatus").textContent = state.subscription ? "You are a premium subscriber!" : "";
}

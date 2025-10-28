// Survive.com — Full mobile-first, interactive, Christian youth/family app logic
// All cards, vault/chat, Bible, prophecy, audio, video, reviews, testimonials, Stripe, offline/PWA

const $ = id => document.getElementById(id);
function escapeHTML(str) { return (str || '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;', '"':'&quot;', "'":'&#039;'}[m])); }
function cid() { return Math.random().toString(36).slice(2,10); }
function now() { return new Date().toISOString(); }

// Unique Bible verse logic
const bibleVerses = [
  "John 3:16 — For God so loved the world...",
  "Romans 8:28 — All things work together for good...",
  "Philippians 4:13 — I can do all things through Christ...",
  "Isaiah 41:10 — Fear not, for I am with you...",
  "Psalm 23:1 — The Lord is my shepherd...",
  "Matthew 5:9 — Blessed are the peacemakers...",
  "Proverbs 3:5 — Trust in the Lord with all your heart...",
  "James 1:5 — If any of you lacks wisdom...",
  "Matthew 22:37 — Love the Lord your God...",
  "Galatians 5:22 — The fruit of the Spirit is..."
];
let verseSeen = JSON.parse(localStorage.getItem("survive_verseSeen") || "[]");
function getNextVerse() {
  let pool = bibleVerses.filter(v => !verseSeen.includes(v));
  if (pool.length === 0) { verseSeen = []; pool = bibleVerses; }
  let v = pool[Math.floor(Math.random() * pool.length)];
  verseSeen.push(v);
  localStorage.setItem("survive_verseSeen", JSON.stringify(verseSeen));
  return v;
}
function renderBibleVerse() {
  const v = getNextVerse();
  $("verseBox").textContent = v;
  // Audio Bible (using ESV audio for demo)
  let audioSrc = "https://www.biblegateway.com/audio/mclean/esv/" + encodeURIComponent(v.split("—")[0].trim().replace(/ /g,""));
  $("verseAudio").src = audioSrc;
}
$("refreshVerse").onclick = renderBibleVerse;

// Youth Bible in a Year
const bibleYearPlan = [
  { day: 1, reading: "Genesis 1, John 1:1-5", audio: "https://www.biblegateway.com/audio/mclean/esv/Gen.1" },
  { day: 2, reading: "Genesis 2, John 1:6-14", audio: "https://www.biblegateway.com/audio/mclean/esv/Gen.2" },
  { day: 3, reading: "Genesis 3, Proverbs 1:1-7", audio: "https://www.biblegateway.com/audio/mclean/esv/Gen.3" },
  // ... add more days!
];
let bibleYearDone = JSON.parse(localStorage.getItem("survive_bibleYearDone") || "[]");
function renderBibleYear() {
  let day = (new Date().getDate() % bibleYearPlan.length);
  let plan = bibleYearPlan[day];
  $("bibleYearDay").textContent = "Day " + (day+1);
  $("bibleYearReading").textContent = plan.reading;
  $("bibleYearAudio").src = plan.audio;
  $("bibleYearStatus").textContent = bibleYearDone.includes(day) ? "Done ✅" : "";
  $("markYearDone").disabled = bibleYearDone.includes(day);
}
$("markYearDone").onclick = () => {
  let day = (new Date().getDate() % bibleYearPlan.length);
  if (!bibleYearDone.includes(day)) {
    bibleYearDone.push(day);
    localStorage.setItem("survive_bibleYearDone", JSON.stringify(bibleYearDone));
    addXP(30);
    renderBibleYear();
    alert("Bible in a Year marked done! +30 XP");
  }
};

// Daily Bible Quiz
const dailyQuiz = [
  {
    question: "Who was swallowed by a great fish?",
    options: ["Moses", "Jonah", "David", "Paul"],
    answer: 1
  },
  {
    question: "In what book do you find the story of creation?",
    options: ["Exodus", "Matthew", "Genesis", "Revelation"],
    answer: 2
  },
  {
    question: "Who denied Jesus three times?",
    options: ["Peter", "John", "Paul", "Judas"],
    answer: 0
  }
];
let quizDay = (new Date().getDate() % dailyQuiz.length);
function renderQuiz() {
  let quiz = dailyQuiz[quizDay];
  $("quizQuestion").textContent = quiz.question;
  $("quizOptions").innerHTML = quiz.options.map((opt, i) =>
    `<button class="btn btn2 quiz-option" onclick="answerQuiz(${i})">${escapeHTML(opt)}</button>`
  ).join('');
  $("quizStatus").textContent = "";
}
window.answerQuiz = function(idx) {
  let quiz = dailyQuiz[quizDay];
  if (idx === quiz.answer) {
    $("quizStatus").innerHTML = `<span class="quiz-correct">Correct! +10 XP</span>`;
    addXP(10);
  } else {
    $("quizStatus").innerHTML = `<span class="quiz-wrong">Try again!</span>`;
  }
  $("quizOptions").innerHTML = "";
};
renderQuiz();

// Bible Story
const bibleStories = [
  "Noah built an ark and saved his family and animals from the flood.",
  "David defeated Goliath with a sling and a stone.",
  "Daniel was thrown in the lions' den but God protected him.",
  "Jesus fed 5000 people with five loaves and two fish.",
  "Esther saved her people by courage and faith.",
  "Paul was shipwrecked but never lost hope."
];
let storyIdx = 0;
function renderBibleStory() {
  $("bibleStory").textContent = bibleStories[storyIdx];
}
$("nextStoryBtn").onclick = () => {
  storyIdx = (storyIdx+1) % bibleStories.length;
  renderBibleStory();
};

// Testimonials
const testimonials = [
  "I found hope and peace through Survive.com! — Joshua, 16",
  "Our youth group loves the missions and Bible quizzes! — Rachel, Youth Leader",
  "My family is closer and more positive thanks to XP rewards. — Mom of 3",
  "Learning about prophecy and Revelation is exciting and encouraging! — Caleb, 12",
  "We love sharing video testimonies and stories with friends! — Sarah, 14",
  "The audio Bible helps me study even when I'm out playing sports. — Michael, 15"
];
function renderTestimonials() {
  $("testimonialList").innerHTML = testimonials.map(t => `<div class="testimonial">${escapeHTML(t)}</div>`).join('');
  // Demo video testimonials
  $("videoTestimonialList").innerHTML = `
    <video controls src="https://www.christianvideo.org/testimony1.mp4"></video>
    <video controls src="https://www.christianvideo.org/testimony2.mp4"></video>
  `;
}

// Reviews
const reviews = [
  "⭐⭐⭐⭐⭐ This app is a game changer for Christian youth.",
  "⭐⭐⭐⭐⭐ Finally, a family-friendly, pro-life, pro-Jesus app!",
  "⭐⭐⭐⭐⭐ We use Survive.com every day in our homeschool.",
  "⭐⭐⭐⭐⭐ The chat and vault are private and secure!",
  "⭐⭐⭐⭐⭐ Stripe subscription is seamless and supports great work!",
  "⭐⭐⭐⭐⭐ The prophecy tracker is inspiring and educational.",
  "⭐⭐⭐⭐⭐ Teachers and youth leaders love sharing notes and images."
];
function renderReviews() {
  $("reviewList").innerHTML = reviews.map(r => `<div class="review">${escapeHTML(r)}</div>`).join('');
}

// Rapture Ready & Prophecy
const raptureFacts = [
  "The Bible teaches Jesus will return for believers (1 Thessalonians 4).",
  "Israel becoming a nation was predicted in Ezekiel 37.",
  "Many prophecies about the end times are being fulfilled now.",
  "Jesus said to 'watch and pray' and be ready at any time.",
  "Revelation describes signs, judgments, and hope for Christians."
];
let raptureIdx = 0;
function renderRaptureReady() {
  $("raptureReady").textContent = raptureFacts[raptureIdx];
  $("raptureStatus").textContent = "";
}
$("nextProphecyBtn").onclick = () => {
  raptureIdx = (raptureIdx+1) % raptureFacts.length;
  renderRaptureReady();
};
// Prophecy quiz
const prophecyQuiz = [
  {
    question: "What nation was reborn in 1948, fulfilling prophecy?",
    options: ["Egypt", "Israel", "Rome", "Greece"],
    answer: 1
  },
  {
    question: "Which book is most about end times?",
    options: ["Genesis", "Revelation", "Proverbs", "John"],
    answer: 1
  }
];
let prophecyDay = (new Date().getDate() % prophecyQuiz.length);
function renderProphecyQuiz() {
  let quiz = prophecyQuiz[prophecyDay];
  $("prophecyQuiz").innerHTML = `<div><b>${escapeHTML(quiz.question)}</b></div>` +
    quiz.options.map((opt, i) =>
      `<button class="btn btn2 quiz-option" onclick="answerProphecy(${i})">${escapeHTML(opt)}</button>`
    ).join('');
}
window.answerProphecy = function(idx) {
  let quiz = prophecyQuiz[prophecyDay];
  if (idx === quiz.answer) {
    $("raptureStatus").innerHTML = `<span class="quiz-correct">Right! +10 XP</span>`;
    addXP(10);
  } else {
    $("raptureStatus").innerHTML = `<span class="quiz-wrong">Try again!</span>`;
  }
  $("prophecyQuiz").innerHTML = "";
};
renderProphecyQuiz();

// Prophecy Tracker (Signs of the Times)
const prophecySigns = [
  "Wars and rumors of wars (Matthew 24:6)",
  "Increase in earthquakes (Luke 21:11)",
  "Israel regathered (Ezekiel 37)",
  "Gospel preached worldwide (Matthew 24:14)",
  "Rise of global technology (Revelation 13)",
  "Christian persecution increases (Matthew 24:9)"
];
function renderProphecyTracker() {
  $("prophecyTracker").innerHTML = prophecySigns.map(sign => `<div class="prophecy-sign">${escapeHTML(sign)}</div>`).join('');
}

// How Close Are We? (simple chart)
function renderEndTimesChart() {
  $("endTimesChart").innerHTML = `
    <div style="font-weight:700;color:var(--accent);margin-bottom:7px;">Signs Fulfilled:</div>
    <progress value="5" max="6" style="width:100%;height:20px"></progress>
    <div style="margin-top:4px;">Based on prophecy, we're very close!</div>
  `;
}

// Guided Bible Study Steps (same as previous, demo)
const bibleStudyPlan = [
  { step: "Read: Matthew 5:1-12", type: "read" },
  { step: "Reflect: What does 'Blessed' mean?", type: "reflect" },
  { step: "Journal: Write your thoughts.", type: "journal" },
  { step: "Pray: Ask God for wisdom today.", type: "pray" }
];
let todayStudy = { steps: bibleStudyPlan.map(s=>({ ...s, done: false, note: "" })), submitted: false, parentConfirmed: false };

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

// Family/Grandparent/Kidness/Crafts/Events/Activities Cards
function addEntry(list, inputId, xp, renderFunc) {
  const desc = $(inputId).value.trim();
  if(!desc) return;
  list.push({id:cid(),desc,time:now()});
  $(inputId).value = "";
  addXP(xp);
  renderFunc();
}
function renderList(list, elementId) {
  $(elementId).innerHTML = list.slice(-8).map(e => `<div class="item"><b>${new Date(e.time).toLocaleDateString()}</b>: ${escapeHTML(e.desc)}</div>`).join('');
}
$("addFamilyTimeXP").onclick = () => addEntry(state.familyTime = state.familyTime||[], "familyTimeDesc", 15, ()=>renderList(state.familyTime,"familyTimeList"));
$("addGrandparentXP").onclick = () => addEntry(state.grandparentTime = state.grandparentTime||[], "grandparentDesc", 15, ()=>renderList(state.grandparentTime,"grandparentList"));
$("addKindnessXP").onclick = () => addEntry(state.kindnessActs = state.kindnessActs||[], "kindnessDesc", 10, ()=>renderList(state.kindnessActs,"kindnessList"));
$("addCraftXP").onclick = () => addEntry(state.crafts = state.crafts||[], "craftDesc", 20, ()=>renderList(state.crafts,"craftList"));
$("addEventXP").onclick = () => addEntry(state.events = state.events||[], "eventDesc", 20, ()=>renderList(state.events,"eventList"));
$("addActivityXP").onclick = () => addEntry(state.activities = state.activities||[], "activityDesc", 20, ()=>renderList(state.activities,"activityList"));

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

// Vaulted Notes/Photos
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

// Missions/Chores/Pets/Dinner/Cleaning/Dishes/Jobs/School/Reminders/Friends/Family/Employers/Goals/Chat (similar to above)
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
$("addChore").onclick = () => { addEntry(state.chores = state.chores||[], "choreTitle", 20, ()=>renderList(state.chores,"choresList")); };
// Pets
$("addPetXP").onclick = () => { addEntry(state.pets = state.pets||[], "petAction", 15, ()=>renderList(state.pets,"petList")); };
// Dinner
$("addDinnerXP").onclick = () => { addEntry(state.dinner = state.dinner||[], "dinnerDesc", 20, ()=>renderList(state.dinner,"dinnerList")); };
// Cleaning
$("addCleanXP").onclick = () => { addEntry(state.cleaning = state.cleaning||[], "cleanDesc", 20, ()=>renderList(state.cleaning,"cleanList")); };
// Dishes
$("addDishesXP").onclick = () => { addEntry(state.dishes = state.dishes||[], "dishesDesc", 20, ()=>renderList(state.dishes,"dishesList")); };
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
$("addSchoolXP").onclick = () => { addEntry(state.school = state.school||[], "schoolDesc", 30, ()=>renderList(state.school,"schoolList")); };
// Reminders
$("addReminder").onclick = () => { addEntry(state.reminders = state.reminders||[], "reminderText", 0, ()=>renderList(state.reminders,"reminderList")); };
// Friends
$("addFriend").onclick = () => { addEntry(state.friends = state.friends||[], "friendName", 0, ()=>renderList(state.friends,"friendsList")); };
// Family
$("addFamily").onclick = () => { addEntry(state.family = state.family||[], "familyName", 0, ()=>renderList(state.family,"familyList")); };
// Employers
$("addEmployer").onclick = () => { addEntry(state.employers = state.employers||[], "employerName", 0, ()=>renderList(state.employers,"employersList")); };
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

// Chat (offline and backend sync)
$("sendChat").onclick = async () => {
  const to = $("chatTo").value.trim()||"family";
  const msg = $("chatMsg").value.trim();
  if(!msg) return;
  // Local save
  state.chat.push({id:cid(),to,msg,time:now()});
  $("chatMsg").value = "";
  renderChat();
  save();
  // Backend sync (demo for Render)
  fetch("/api/chat", {
    method:"POST",
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({to,msg})
  });
};
function renderChat() {
  $("chatList").innerHTML = state.chat.slice(-10).map(c=>`<div class="item"><b>${escapeHTML(c.to)}</b> <span class="muted">${new Date(c.time).toLocaleTimeString()}</span><div>${escapeHTML(c.msg)}</div></div>`).join('');
  // Fetch backend messages (demo)
  fetch("/api/chat").then(res=>res.json()).then(data=>{
    $("chatList").innerHTML += data.messages.map(c=>`<div class="item"><b>${escapeHTML(c.to)}</b> <span class="muted">${new Date(c.time).toLocaleTimeString()}</span><div>${escapeHTML(c.msg)}</div></div>`).join('');
  });
}

// Advice (dummy)
$("askAdvice").onclick = async () => {
  $("adviceOut").textContent = "Thinking...";
  const question = $("adviceIn").value.trim();
  if(!question) { $("adviceOut").textContent = ""; return;}
  setTimeout(()=>{ $("adviceOut").textContent = "Pray, read relevant Bible verses, and seek counsel from family/church. Conservative Christian values recommend faith, family, and wisdom."; }, 1200);
};

// XP
function addXP(amount) {
  state.xp = (state.xp||0)+amount;
  let next = 500 + ((state.level||1)-1)*150;
  if(state.xp >= next) {
    state.level = (state.level||1)+1;
    state.xp = state.xp-next;
    alert("Level up! 🎉");
  }
  save();
  renderStats();
}
function renderStats() {
  $("userName").textContent = state.user || "Child";
  $("level").textContent = state.level||1;
  $("xp").textContent = state.xp||0;
  $("streak").textContent = (state.streak||0) + " 🔥";
  let next = 500 + ((state.level||1)-1)*150;
  $("xpBar").style.width = Math.min(100, Math.round(((state.xp||0)/next)*100)) + "%";
}

// Theme
$("themeToggle").onclick = () => {
  document.documentElement.setAttribute('data-theme',document.documentElement.getAttribute('data-theme') === "dark" ? "light" : "dark");
  save();
};
// XP Tooltip
$("xpExplainBtn").onmouseenter = $("xpTooltip").onmouseenter = () => $("xpTooltip").style.display="block";
$("stat-xp").onmouseleave = $("xpTooltip").onmouseleave = () => $("xpTooltip").style.display="none";

// How It Works
$("howItWorksBtn").onclick = () => {
  openModal({
    title: "How Survive.com Works",
    body: "<b>XP:</b> Earn for healthy actions—missions, chores, faith, school, jobs, crafts, pets, and more.<br><b>Cards:</b> Everything is a card—click, add, complete, and earn XP.<br><b>Vault:</b> All notes, dreams, chats, memories, photos, and videos are private and can be shared by trusted family, friends, youth leaders, pastors, teachers, and employers.<br><b>Prophecy:</b> Daily teaching, quiz, tracker, and 'How close are we?' chart.<br><b>Progress:</b> Level up, keep streaks, unlock achievements.<br><b>Fun:</b> Play, connect, thrive offline & online!",
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
    ]; // All safe
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

// Stripe Subscription
$("subscribeBtn").onclick = async () => {
  const res = await fetch('/api/create-checkout-session', { method: 'POST' });
  const { checkoutUrl } = await res.json();
  window.location.href = checkoutUrl;
};

function save() { localStorage.setItem("survive_allfeatures", JSON.stringify(state)); }
function load() { const d = localStorage.getItem("survive_allfeatures"); if(d) state = Object.assign(state, JSON.parse(d)); }
window.onload = () => {
  load();
  renderStats();
  renderBibleVerse();
  renderBibleYear();
  renderQuiz();
  renderBibleStory();
  renderTestimonials();
  renderReviews();
  renderRaptureReady();
  renderProphecyQuiz();
  renderProphecyTracker();
  renderEndTimesChart();
  renderBibleStudySteps();
  renderParentPendingStudies();
  renderList(state.familyTime||[], "familyTimeList");
  renderList(state.grandparentTime||[], "grandparentList");
  renderList(state.kindnessActs||[], "kindnessList");
  renderList(state.crafts||[], "craftList");
  renderList(state.events||[], "eventList");
  renderList(state.activities||[], "activityList");
  renderJournal();
  renderDreams();
  renderVaultedNotes();
  renderVaultedPhotos();
  renderMissions();
  renderList(state.chores||[], "choresList");
  renderList(state.pets||[], "petList");
  renderList(state.dinner||[], "dinnerList");
  renderList(state.cleaning||[], "cleanList");
  renderList(state.dishes||[], "dishesList");
  renderJobs();
  renderList(state.school||[], "schoolList");
  renderList(state.reminders||[], "reminderList");
  renderList(state.friends||[], "friendsList");
  renderList(state.family||[], "familyList");
  renderList(state.employers||[], "employersList");
  renderGoals();
  renderChat();
  renderVideos();
  $("subscriptionStatus").textContent = state.subscription ? "You are a premium subscriber!" : "";
};

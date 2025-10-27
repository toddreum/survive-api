// Section Navigation
function showSection(sectionId) {
  document.querySelectorAll('.app-section').forEach(s => s.style.display = 'none');
  document.getElementById(sectionId).style.display = 'block';
}
showSection('dashboard');

// XP and Missions
let xp = Number(localStorage.getItem('xp') || 0);
function updateXPDisplay() {
  document.getElementById('xpDisplay').textContent = `XP: ${xp}`;
}
function addXRP(amt, reason) {
  xp += amt;
  localStorage.setItem('xp', xp);
  updateXPDisplay();
  if (reason) alert(`+${amt} XP: ${reason}`);
}
updateXPDisplay();

// Missions (including equipped/battle/WWJD)
const missions = [
  {name: "Morning Prayer", cat: "Faith", desc: "Begin your day with prayer", xp: 10},
  {name: "Bible Study", cat: "Study", desc: "Read today's scripture and journal", xp: 20},
  {name: "Are You Equipped for Battle?", cat: "Spiritual Warfare", desc: "Review Ephesians 6 armor of God checklist", xp: 15},
  {name: "What Would Jesus Do?", cat: "Reflection", desc: "Face a daily challenge, ask WWJD, and record your response", xp: 15},
  {name: "Tribulation Talk", cat: "End Times", desc: "Reflect on tribulation passages and journal thoughts", xp: 15},
  {name: "Offline Break", cat: "Discipline", desc: "Take a phone-free break", xp: 10},
  {name: "Help a Family Member", cat: "Family", desc: "Assist someone in your household", xp: 10},
];
function renderMissions() {
  document.getElementById('missionsList').innerHTML = missions.map((m,i) =>
    `<li>
      <b>${m.name}</b> (${m.cat})<br>${m.desc}
      <button onclick="addXRP(${m.xp},'${m.name}')">Complete Mission (+${m.xp} XP)</button>
    </li>`
  ).join('');
}
renderMissions();

// Bible in a Year Tracker
const bibleYearPlan = [
  "Genesis 1-3", "Exodus 12-14", "Psalms 1-5", "Matthew 1-2", // etc, expand for full year
];
function renderBibleYearList() {
  document.getElementById('bibleYearList').innerHTML = bibleYearPlan.map((p,i) =>
    `<li>${p} <span>${localStorage.getItem('bibleYear-'+i) ? '✅' : ''}</span></li>`).join('');
}
document.getElementById('markBibleReadBtn').onclick = function() {
  let day = new Date().getDay(); // simplistic: real logic should track actual day count
  localStorage.setItem('bibleYear-'+day, '1');
  renderBibleYearList();
  addXRP(5, "Bible in a Year reading");
};
renderBibleYearList();

document.getElementById('saveBibleStudyBtn').onclick = function() {
  let notes = document.getElementById('bibleStudyNotes').value.trim();
  if (!notes) return;
  let log = JSON.parse(localStorage.getItem('bibleStudyLog') || '[]');
  log.push({date: new Date().toLocaleString(), notes});
  localStorage.setItem('bibleStudyLog', JSON.stringify(log));
  document.getElementById('bibleStudyStatus').textContent = "Saved!";
  addXRP(20, "Deep Bible Study");
  document.getElementById('bibleStudyNotes').value = '';
};
function renderBibleYearPlan() {
  document.getElementById('bibleYearPlan').innerHTML = bibleYearPlan.map((p,i) =>
    `<li>${p} <span>${localStorage.getItem('bibleYear-'+i) ? '✅' : ''}</span></li>`).join('');
}
renderBibleYearPlan();

// Journal
document.getElementById('saveJournalBtn').onclick = function() {
  let entry = document.getElementById('journalEntry').value.trim();
  let photo = document.getElementById('journalPhoto').files[0];
  let log = JSON.parse(localStorage.getItem('journalLog') || '[]');
  let obj = {date: new Date().toLocaleString(), entry};
  if (photo) {
    let reader = new FileReader();
    reader.onload = function(e) {
      obj.photo = e.target.result;
      log.push(obj);
      localStorage.setItem('journalLog', JSON.stringify(log));
      document.getElementById('journalStatus').textContent = "Journal entry saved with photo!";
      renderJournalLog();
    };
    reader.readAsDataURL(photo);
  } else {
    log.push(obj);
    localStorage.setItem('journalLog', JSON.stringify(log));
    document.getElementById('journalStatus').textContent = "Journal entry saved!";
    renderJournalLog();
  }
  document.getElementById('journalEntry').value = '';
  document.getElementById('journalPhoto').value = '';
};
function renderJournalLog() {
  let log = JSON.parse(localStorage.getItem('journalLog') || '[]');
  let div = document.getElementById('journalLog');
  div.innerHTML = log.map(e => `<div><b>${e.date}:</b> ${e.entry} ${e.photo ? `<img src="${e.photo}" width="64">` : ''}</div>`).join('');
}
renderJournalLog();

// Organizer
document.getElementById('addTaskBtn').onclick = function() {
  let task = document.getElementById('taskInput').value.trim();
  if (!task) return;
  let list = JSON.parse(localStorage.getItem('taskList') || '[]');
  list.push({task, done: false});
  localStorage.setItem('taskList', JSON.stringify(list));
  renderTaskList();
  document.getElementById('taskInput').value = '';
};
function renderTaskList() {
  let list = JSON.parse(localStorage.getItem('taskList') || '[]');
  document.getElementById('taskList').innerHTML = list.map((t,i) =>
    `<li>${t.done ? '✅' : ''} ${t.task} <button onclick="toggleTaskDone(${i})">${t.done ? 'Undo' : 'Done'}</button></li>`
  ).join('');
}
function toggleTaskDone(idx) {
  let list = JSON.parse(localStorage.getItem('taskList') || '[]');
  list[idx].done = !list[idx].done;
  localStorage.setItem('taskList', JSON.stringify(list));
  renderTaskList();
}
renderTaskList();

document.getElementById('addReminderBtn').onclick = function() {
  let time = document.getElementById('reminderInput').value;
  if (!time) return;
  let list = JSON.parse(localStorage.getItem('reminderList') || '[]');
  list.push({time});
  localStorage.setItem('reminderList', JSON.stringify(list));
  renderReminderList();
};
function renderReminderList() {
  let list = JSON.parse(localStorage.getItem('reminderList') || '[]');
  document.getElementById('reminderList').innerHTML = list.map((r,i) =>
    `<li>${r.time}</li>`
  ).join('');
}
renderReminderList();

// Family Mode
document.getElementById('familyDashboard').innerHTML = `
  <h3>Send a Note/Task to Family</h3>
  <input id="familyNoteIn">
  <button id="sendFamilyNoteBtn">Send</button>
  <div id="familyNotesLog"></div>
  <h3>Approve Missions & Rewards</h3>
  <input id="familyRewardIn" placeholder="Reward for member">
  <button id="sendFamilyRewardBtn">Grant Reward</button>
  <div id="familyRewardsLog"></div>
`;
document.getElementById('sendFamilyNoteBtn').onclick = function() {
  let note = document.getElementById('familyNoteIn').value.trim();
  if (!note) return;
  let notes = JSON.parse(localStorage.getItem('familyNotesLog') || '[]');
  notes.push({date: new Date().toLocaleString(), note});
  localStorage.setItem('familyNotesLog', JSON.stringify(notes));
  renderFamilyNotesLog();
  document.getElementById('familyNoteIn').value = '';
};
function renderFamilyNotesLog() {
  let notes = JSON.parse(localStorage.getItem('familyNotesLog') || '[]');
  document.getElementById('familyNotesLog').innerHTML = notes.map(n =>
    `<div><b>${n.date}:</b> ${n.note}</div>`).join('');
}
renderFamilyNotesLog();

document.getElementById('sendFamilyRewardBtn').onclick = function() {
  let reward = document.getElementById('familyRewardIn').value.trim();
  if (!reward) return;
  let rewards = JSON.parse(localStorage.getItem('familyRewardsLog') || '[]');
  rewards.push({date: new Date().toLocaleString(), reward});
  localStorage.setItem('familyRewardsLog', JSON.stringify(rewards));
  renderFamilyRewardsLog();
  document.getElementById('familyRewardIn').value = '';
};
function renderFamilyRewardsLog() {
  let rewards = JSON.parse(localStorage.getItem('familyRewardsLog') || '[]');
  document.getElementById('familyRewardsLog').innerHTML = rewards.map(r =>
    `<div><b>${r.date}:</b> ${r.reward}</div>`).join('');
}
renderFamilyRewardsLog();

// AI Advice
document.getElementById('getAdviceBtn').onclick = async function() {
  let question = document.getElementById('adviceQuestion').value.trim();
  if (!question) return;
  document.getElementById('adviceAnswer').textContent = "Thinking...";
  let res = await fetch('/api/advice', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({question})
  });
  let data = await res.json();
  document.getElementById('adviceAnswer').textContent = data.answer || "No answer yet.";
};

// Offline Break
document.getElementById('offlineBreakBtn').onclick = function() {
  let minutes = prompt("How many minutes offline?");
  if (!minutes || isNaN(minutes) || minutes <= 0) return;
  let seconds = minutes * 60;
  let display = document.getElementById('offlineTimerDisplay');
  display.textContent = `Offline break started for ${minutes} minutes.`;
  let interval = setInterval(() => {
    if (seconds > 0) {
      display.textContent = `Time left: ${Math.floor(seconds/60)}m ${seconds%60}s`;
      seconds--;
    } else {
      clearInterval(interval);
      addXRP(50, "Offline break completed");
      display.textContent = "Offline break finished! Credited 50 XP.";
    }
  }, 1000);
};

// Mindfulness: Meditate on Jesus Christ
document.getElementById('meditateBtn').onclick = function() {
  let meditationStatus = document.getElementById('meditationStatus');
  meditationStatus.textContent = "Reflect and pray on Jesus Christ for 5 minutes.";
  setTimeout(() => {
    addXRP(30, "Meditated on Jesus Christ");
    meditationStatus.textContent = "Meditation complete! Credited 30 XP.";
  }, 5*60*1000); // 5 minutes
};

// Download App
document.getElementById('downloadAppBtn').onclick = function() {
  document.getElementById('downloadAppStatus').textContent =
    "On mobile, tap the browser menu and 'Add to Home Screen' to install as an app!";
};

// Contact Us form: send email via backend
document.getElementById('contactForm').onsubmit = async function(e) {
  e.preventDefault();
  let name = document.getElementById('contactName').value.trim();
  let email = document.getElementById('contactEmail').value.trim();
  let msg = document.getElementById('contactMsg').value.trim();
  let res = await fetch('/api/contact', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({name, email, msg})
  });
  let data = await res.json();
  document.getElementById('contactStatus').textContent = data.status || "Submitted!";
};

// --- Responsive YouTube embeds, valid public videos ---
const charlieKirkVideos = [
  "2L4aWbU1bdo","YX6QKZkNQ7I","i2F4X5lNqCo","vHwB9rDZlUg","5UQFKnqfT8w"
];
const jackHibbsVideos = [
  "O1rb0jYQklA","F0JKbYJdRjw","Tf3v2DgS8tE","6QwF8m2XkIU","3QEjTI4nQTs"
];
const today = new Date();
const dayNum = Math.floor((today - new Date(today.getFullYear(),0,0)) / 86400000);
const charlieIdx = dayNum % charlieKirkVideos.length;
const jackIdx = dayNum % jackHibbsVideos.length;
document.getElementById("charlieKirkVideo").innerHTML =
  `<iframe src="https://www.youtube.com/embed/${charlieKirkVideos[charlieIdx]}" allowfullscreen></iframe>`;
document.getElementById("jackHibbsVideo").innerHTML =
  `<iframe src="https://www.youtube.com/embed/${jackHibbsVideos[jackIdx]}" allowfullscreen></iframe>`;

// --- XP Earning & Approval System ---
let userRole = localStorage.getItem('survive_userRole') || 'child';
let userName = localStorage.getItem('survive_userName') || 'child123';
let parentName = localStorage.getItem('survive_parentName') || 'parent456';

if (!localStorage.getItem('survive_userRole')) {
  userRole = prompt("Enter your role (child, parent, employer, youth_pastor, pastor):", "child").trim().toLowerCase();
  localStorage.setItem('survive_userRole', userRole);
}
if (!localStorage.getItem('survive_userName')) {
  userName = prompt("Enter your username:", "child123").trim();
  localStorage.setItem('survive_userName', userName);
}
if (userRole === "child" && !localStorage.getItem('survive_parentName')) {
  parentName = prompt("Enter your parent's username:", "parent456").trim();
  localStorage.setItem('survive_parentName', parentName);
}

function earnXP(amount, reason) {
  if (userRole === "child") {
    let parentVault = JSON.parse(localStorage.getItem(`survive_xpVault_${parentName}`) || "[]");
    parentVault.push({ child: userName, xp: amount, reason, state: "pending", time: new Date().toISOString() });
    localStorage.setItem(`survive_xpVault_${parentName}`, JSON.stringify(parentVault));
    alert(`XP request sent to ${parentName} for approval!`);
  } else {
    alert("Only children can request XP.");
  }
}

function renderParentXPVault() {
  if (["parent", "employer", "youth_pastor", "pastor"].includes(userRole)) {
    document.getElementById("parentXPCard").style.display = "";
    let vault = JSON.parse(localStorage.getItem(`survive_xpVault_${userName}`) || "[]");
    let html = vault.map((entry, idx) => {
      if (entry.state === "pending") {
        return `<div class="item">
          <b>Child:</b> ${entry.child}<br>
          <b>XP:</b> ${entry.xp}<br>
          <b>Reason:</b> ${entry.reason}<br>
          <button onclick="approveXP(${idx})" class="btn2">Approve</button>
          <button onclick="denyXP(${idx})" class="btn">Deny</button>
        </div>`;
      } else {
        return `<div class="item"><b>${entry.child}</b> – ${entry.xp} XP – ${entry.reason} <span style="color:#ffd600">[${entry.state}]</span></div>`;
      }
    }).join('');
    document.getElementById("parentXPVault").innerHTML = html;
  }
}
window.approveXP = function(idx) {
  let vault = JSON.parse(localStorage.getItem(`survive_xpVault_${userName}`) || "[]");
  let entry = vault[idx];
  entry.state = "approved";
  vault[idx] = entry;
  localStorage.setItem(`survive_xpVault_${userName}`, JSON.stringify(vault));
  let childXP = parseInt(localStorage.getItem(`survive_xp_${entry.child}`) || "0");
  childXP += parseInt(entry.xp);
  localStorage.setItem(`survive_xp_${entry.child}`, childXP);
  renderParentXPVault();
  alert(`Approved XP for ${entry.child}`);
};
window.denyXP = function(idx) {
  let vault = JSON.parse(localStorage.getItem(`survive_xpVault_${userName}`) || "[]");
  vault[idx].state = "denied";
  localStorage.setItem(`survive_xpVault_${userName}`, JSON.stringify(vault));
  renderParentXPVault();
  alert(`Denied XP for ${vault[idx].child}`);
};

function renderChildXP() {
  if (userRole === "child") {
    let xp = parseInt(localStorage.getItem(`survive_xp_${userName}`) || "0");
    document.getElementById("childXPDisplay").textContent = `Current XP: ${xp}`;
  }
}

if (userRole === "child") renderChildXP();
if (["parent", "employer", "youth_pastor", "pastor"].includes(userRole)) renderParentXPVault();

window.onload = function() {
  if (userRole === "child") renderChildXP();
  if (["parent", "employer", "youth_pastor", "pastor"].includes(userRole)) renderParentXPVault();
};

// --- XP Reward System ---
let defaultRewards = [
  { name: "Ice Cream Night", xp: 25 },
  { name: "Movie with Family", xp: 30 },
  { name: "Extra Game Time", xp: 20 },
  { name: "Pizza Dinner", xp: 20 },
  { name: "Outdoor Adventure", xp: 40 }
];
let rewardList = JSON.parse(localStorage.getItem('survive_rewardList') || "null") || defaultRewards;
localStorage.setItem('survive_rewardList', JSON.stringify(rewardList));

function saveRewardList() {
  localStorage.setItem('survive_rewardList', JSON.stringify(rewardList));
  renderRewardList();
}
function renderRewardList() {
  let html = rewardList.map((r, idx) => `<div class="reward-item">
    <b>${r.name}</b> – ${r.xp} XP
    ${userRole === "child" ? `<button onclick="requestReward(${idx})" class="btn2">Request</button>` : ""}
    ${userRole === "parent" ? `<button onclick="editReward(${idx})" class="btn">Edit</button>` : ""}
  </div>`).join('');
  document.getElementById("rewardList").innerHTML = html;
}
window.requestReward = function(idx) {
  let xp = parseInt(localStorage.getItem(`survive_xp_${userName}`) || "0");
  if (xp < rewardList[idx].xp) {alert("Not enough XP!");return;}
  let requests = JSON.parse(localStorage.getItem(`survive_rewardRequests_${parentName}`) || "[]");
  requests.push({ child: userName, reward: rewardList[idx].name, xp: rewardList[idx].xp, state: "pending", time: new Date().toISOString() });
  localStorage.setItem(`survive_rewardRequests_${parentName}`, JSON.stringify(requests));
  alert("Reward request sent for parent approval!");
};

// --- Parent: Edit/Add Rewards ---
function renderParentRewardEdit() {
  if (userRole !== "parent") return;
  document.getElementById("parentRewardEdit").style.display = "";
  let html = rewardList.map((r, idx) => `
    <input value="${r.name}" id="rname${idx}" style="width:30%;margin:4px;" />
    <input value="${r.xp}" id="rxp${idx}" type="number" style="width:15%;margin:4px;" />
    <button onclick="saveRewardEdit(${idx})" class="btn2">Save</button>
    <button onclick="deleteReward(${idx})" class="btn">Delete</button><br>
  `).join('');
  html += `<input id="newRewardName" placeholder="New Reward Name" style="width:30%;margin:4px;" />
    <input id="newRewardXP" type="number" placeholder="XP" style="width:15%;margin:4px;" />
    <button onclick="addReward()" class="btn2">Add</button>`;
  document.getElementById("parentRewardEdit").innerHTML = html;
}
window.saveRewardEdit = function(idx) {
  rewardList[idx].name = document.getElementById(`rname${idx}`).value;
  rewardList[idx].xp = parseInt(document.getElementById(`rxp${idx}`).value);
  saveRewardList();
  renderParentRewardEdit();
};
window.deleteReward = function(idx) {
  rewardList.splice(idx, 1);
  saveRewardList();
  renderParentRewardEdit();
};
window.addReward = function() {
  let n = document.getElementById("newRewardName").value.trim();
  let x = parseInt(document.getElementById("newRewardXP").value);
  if(n && x > 0) {
    rewardList.push({ name: n, xp: x });
    saveRewardList();
    renderParentRewardEdit();
  }
};

// --- Parent: Approve/Deny Reward Requests ---
function renderParentRewardRequests() {
  if (userRole !== "parent") return;
  document.getElementById("parentRewardRequests").style.display = "";
  let requests = JSON.parse(localStorage.getItem(`survive_rewardRequests_${userName}`) || "[]");
  let html = requests.map((req, idx) => {
    if (req.state === "pending") {
      return `<div class="reward-item">
        <b>Child:</b> ${req.child}<br>
        <b>Reward:</b> ${req.reward} (${req.xp} XP)<br>
        <button onclick="approveReward(${idx})" class="btn2">Approve</button>
        <button onclick="denyReward(${idx})" class="btn">Deny</button>
      </div>`;
    } else {
      return `<div class="reward-item"><b>${req.child}</b> – ${req.reward} (${req.xp} XP) <span style="color:#ffd600">[${req.state}]</span></div>`;
    }
  }).join('');
  document.getElementById("parentRewardRequests").innerHTML = html;
}
window.approveReward = function(idx) {
  let requests = JSON.parse(localStorage.getItem(`survive_rewardRequests_${userName}`) || "[]");
  let req = requests[idx];
  req.state = "approved";
  requests[idx] = req;
  localStorage.setItem(`survive_rewardRequests_${userName}`, JSON.stringify(requests));
  let childXP = parseInt(localStorage.getItem(`survive_xp_${req.child}`) || "0");
  childXP -= parseInt(req.xp);
  localStorage.setItem(`survive_xp_${req.child}`, childXP);
  renderParentRewardRequests();
  alert(`Approved reward for ${req.child}`);
};
window.denyReward = function(idx) {
  let requests = JSON.parse(localStorage.getItem(`survive_rewardRequests_${userName}`) || "[]");
  requests[idx].state = "denied";
  localStorage.setItem(`survive_rewardRequests_${userName}`, JSON.stringify(requests));
  renderParentRewardRequests();
  alert(`Denied reward for ${requests[idx].child}`);
};

renderRewardList();
if(userRole==="parent") {renderParentRewardEdit();renderParentRewardRequests();}

// --- Bible Verse ---
const shownVerses = JSON.parse(localStorage.getItem('survive_shownVerses') || '[]');
async function getUniqueBibleVerse() {
  let tries = 0, verse = null, ref = "";
  while (tries < 12) {
    const books = ["Genesis","Exodus","John","Matthew","Psalms","Proverbs","Romans","Philippians","Isaiah","James"];
    const b = books[Math.floor(Math.random()*books.length)];
    const chapter = Math.ceil(Math.random()*50);
    const verseNum = Math.ceil(Math.random()*30);
    ref = `${b}+${chapter}:${verseNum}`;
    try {
      const resp = await fetch(`https://bible-api.com/${ref}`);
      const data = await resp.json();
      verse = data.text ? `${data.reference} — ${data.text.trim()}` : null;
      if (verse && !shownVerses.includes(verse)) break;
    } catch(e){ /* skip */ }
    tries++;
  }
  if (verse) {
    shownVerses.push(verse);
    localStorage.setItem('survive_shownVerses', JSON.stringify(shownVerses));
    document.getElementById("dailyVerse").textContent = verse;
    document.getElementById("verseAudio").src = "";
  } else {
    document.getElementById("dailyVerse").textContent = "No unique verses found!";
  }
}
document.getElementById("refreshVerse").onclick = getUniqueBibleVerse;
getUniqueBibleVerse();

// --- Guided Study ---
const bibleYearPlan = [
  { day: 1, reading: "Matthew 5:1-12", audio: "https://www.biblegateway.com/audio/mclean/esv/Matt.5" },
  { day: 2, reading: "Proverbs 3:1-10", audio: "https://www.biblegateway.com/audio/mclean/esv/Prov.3" }
];
let bibleYearDone = JSON.parse(localStorage.getItem("survive_bibleYearDone") || "[]");
function renderBibleYear() {
  let day = ((new Date().getMonth()*31) + new Date().getDate()) % bibleYearPlan.length;
  let plan = bibleYearPlan[day];
  document.getElementById("bibleYearDay").textContent = "Day " + (day+1);
  document.getElementById("bibleYearReading").textContent = "Read: "+plan.reading;
  document.getElementById("bibleYearAudio").src = plan.audio;
  document.getElementById("bibleYearStatus").textContent = bibleYearDone.includes(day) ? "Done ✅" : "";
  document.getElementById("markYearDone").disabled = bibleYearDone.includes(day);
}
document.getElementById("markYearDone").onclick = () => {
  let day = ((new Date().getMonth()*31) + new Date().getDate()) % bibleYearPlan.length;
  if (!bibleYearDone.includes(day)) {
    bibleYearDone.push(day);
    localStorage.setItem("survive_bibleYearDone", JSON.stringify(bibleYearDone));
    renderBibleYear();
    alert("Bible in a Year marked done!");
  }
};
renderBibleYear();

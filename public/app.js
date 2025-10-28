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

// --- User Role & XP ---
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
    renderChildXP();
  } else {
    alert("Only children can request XP.");
  }
}

function renderChildXP() {
  let xp = parseInt(localStorage.getItem(`survive_xp_${userName}`) || "0");
  document.getElementById("childXPDisplay").textContent = `Current XP: ${xp}`;

  // Show child's pending reward requests
  let requests = JSON.parse(localStorage.getItem(`survive_rewardRequests_${parentName}`) || "[]");
  let pending = requests.filter(r => r.child === userName && r.state === "pending");
  let html = pending.length ? "<div>Pending Rewards:</div>" + pending.map(r => `<div class="reward-item">${r.reward} (${r.xp} XP)</div>`).join("") : "";
  document.getElementById("childPendingRewards").innerHTML = html;
}

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
  let xp = parseInt(localStorage.getItem(`survive_xp_${userName}`) || "0");
  let html = rewardList.map((r, idx) => `<div class="reward-item">
    <b>${r.name}</b> – ${r.xp} XP
    ${userRole === "child" ? `<button onclick="requestReward(${idx})" class="btn2" ${xp<r.xp?"disabled":""}>Request</button>` : ""}
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
  renderChildXP();
};

renderRewardList();
renderChildXP();

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
  } else {
    document.getElementById("dailyVerse").textContent = "No unique verses found!";
  }
}
document.getElementById("refreshVerse").onclick = getUniqueBibleVerse;
getUniqueBibleVerse();

// --- Guided Study ---
const bibleYearPlan = [
  { day: 1, reading: "Matthew 5:1-12" },
  { day: 2, reading: "Proverbs 3:1-10" }
];
let bibleYearDone = JSON.parse(localStorage.getItem("survive_bibleYearDone") || "[]");
function renderBibleYear() {
  let day = ((new Date().getMonth()*31) + new Date().getDate()) % bibleYearPlan.length;
  let plan = bibleYearPlan[day];
  document.getElementById("bibleYearDay").textContent = "Day " + (day+1);
  document.getElementById("bibleYearReading").textContent = "Read: "+plan.reading;
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

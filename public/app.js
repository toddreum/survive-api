// --- Theme toggle ---
function setTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem('survive_theme', t);
}
const savedTheme = localStorage.getItem('survive_theme');
if(savedTheme) setTheme(savedTheme);
document.getElementById('themeToggle').onclick = () => {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  setTheme(current === 'dark' ? 'light' : 'dark');
};

// --- Infinite Bible verses (API, no repeats for user) ---
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
      verse = data.text ? `${data.reference} – ${data.text.trim()}` : null;
      if (verse && !shownVerses.includes(verse)) break;
    } catch(e){ /* skip */ }
    tries++;
  }
  if (verse) {
    shownVerses.push(verse);
    localStorage.setItem('survive_shownVerses', JSON.stringify(shownVerses));
    document.getElementById("dailyVerse").textContent = verse;
    document.getElementById("verseAudio").src = "";
    document.getElementById("studyVerse").textContent = verse;
  } else {
    document.getElementById("dailyVerse").textContent = "No unique verses found!";
    document.getElementById("studyVerse").textContent = "";
  }
}
document.getElementById("refreshVerse").onclick = getUniqueBibleVerse;
getUniqueBibleVerse();

// --- Bible in a Year guided study (expandable plan!) ---
const bibleYearPlan = [
  { day: 1, reading: "Genesis 1, John 1:1-5", audio: "https://www.biblegateway.com/audio/mclean/esv/Gen.1" },
  { day: 2, reading: "Genesis 2, John 1:6-14", audio: "https://www.biblegateway.com/audio/mclean/esv/Gen.2" },
  { day: 3, reading: "Genesis 3, Proverbs 1:1-7", audio: "https://www.biblegateway.com/audio/mclean/esv/Gen.3" }
  // Add more days for a full year!
];
let bibleYearDone = JSON.parse(localStorage.getItem("survive_bibleYearDone") || "[]");
function renderBibleYear() {
  let day = ((new Date().getMonth()*31) + new Date().getDate()) % bibleYearPlan.length;
  let plan = bibleYearPlan[day];
  document.getElementById("bibleYearDay").textContent = "Day " + (day+1);
  document.getElementById("bibleYearReading").textContent = plan.reading;
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

// --- Vaulted content: hide/unhide toggles ---
function setupVault(section) {
  const btn = document.getElementById('unhide'+section);
  const box = document.getElementById(section+'Content');
  if(btn && box) btn.onclick = () => box.classList.toggle('unhidden');
}
// If you have vault cards, uncomment the next lines
// setupVault('ChatVault');
// setupVault('NotesVault');
// setupVault('PhotosVault');

// --- Vaulted Chat storage ---
let chatVault = JSON.parse(localStorage.getItem('survive_chatVault')||'[]');
if(document.getElementById('sendChat')) {
  document.getElementById('sendChat').onclick = () => {
    let toSel = document.getElementById('chatTo').value;
    let toCustom = document.getElementById('chatToCustom').value.trim();
    let to = toCustom || toSel;
    let msg = document.getElementById('chatMsg').value.trim();
    if(to && msg) {
      chatVault.push({to,msg,time:new Date().toISOString()});
      localStorage.setItem('survive_chatVault',JSON.stringify(chatVault));
      renderChatVault();
      document.getElementById('chatMsg').value = '';
    }
  };
  function renderChatVault() {
    document.getElementById('chatList').innerHTML =
      chatVault.slice(-10).map(c=>`<div class="item"><b>${c.to}</b> <span style="color:#ffd600">${new Date(c.time).toLocaleTimeString()}</span><div>${c.msg}</div></div>`).join('');
  }
  renderChatVault();
}

// --- Vaulted Notes storage ---
let notesVault = JSON.parse(localStorage.getItem('survive_notesVault')||'[]');
if(document.getElementById('saveVaultNote')) {
  document.getElementById('saveVaultNote').onclick = () => {
    let note = document.getElementById('vaultNote').value.trim();
    if(note) {
      notesVault.push({note,time:new Date().toISOString()});
      localStorage.setItem('survive_notesVault',JSON.stringify(notesVault));
      renderNotesVault();
      document.getElementById('vaultNote').value = '';
    }
  };
  function renderNotesVault() {
    document.getElementById('vaultNotesList').innerHTML =
      notesVault.slice(-10).map(n=>`<div class="item"><span style="color:#ffd600">${new Date(n.time).toLocaleDateString()}</span>: ${n.note}</div>`).join('');
  }
  renderNotesVault();
}

// --- Vaulted Photos storage ---
let photoVault = JSON.parse(localStorage.getItem('survive_photoVault')||'[]');
if(document.getElementById('addPhotoBtn')) {
  document.getElementById('addPhotoBtn').onclick = () => {
    const file = document.getElementById('photoUpload').files[0];
    if(file) {
      const reader = new FileReader();
      reader.onload = function(e) {
        photoVault.push({
          title: document.getElementById('photoTitle').value,
          date: document.getElementById('photoDate').value,
          src: e.target.result
        });
        localStorage.setItem('survive_photoVault',JSON.stringify(photoVault));
        renderPhotoVault();
        document.getElementById('photoTitle').value='';
        document.getElementById('photoDate').value='';
        document.getElementById('photoUpload').value='';
      };
      reader.readAsDataURL(file);
    }
  };
  function renderPhotoVault() {
    document.getElementById('photoVaultList').innerHTML =
      photoVault.slice(-8).map(p=>
        `<div class="item"><b>${p.title}</b> <span style="color:#ffd600">${p.date}</span><br>
         <img class="photo-thumb" src="${p.src}" alt="photo"></div>`
      ).join('');
  }
  renderPhotoVault();
}

// --- Stripe Premium Membership Checkout ---
if(document.getElementById("subscribeBtn")) {
  document.getElementById("subscribeBtn").onclick = async () => {
    try {
      const res = await fetch('/api/create-checkout-session', { method: 'POST' });
      const data = await res.json();
      if (data.checkoutUrl) {
        window.location.href = data.checkoutUrl;
      } else {
        alert("Stripe checkout error: " + (data.error || "No checkout URL returned."));
      }
    } catch (err) {
      alert("Stripe checkout failed: " + err.message);
    }
  };
}

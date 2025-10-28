// THEME SWITCH
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

// Infinite unique Bible verses (via API)
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
  } else {
    document.getElementById("dailyVerse").textContent = "No unique verses found!";
  }
}
document.getElementById("refreshVerse").onclick = getUniqueBibleVerse;
getUniqueBibleVerse();

// Bible in a Year guided study (sample, expand for full plan!)
const bibleYearPlan = [
  { day: 1, reading: "Genesis 1, John 1:1-5", audio: "https://www.biblegateway.com/audio/mclean/esv/Gen.1" },
  { day: 2, reading: "Genesis 2, John 1:6-14", audio: "https://www.biblegateway.com/audio/mclean/esv/Gen.2" },
  { day: 3, reading: "Genesis 3, Proverbs 1:1-7", audio: "https://www.biblegateway.com/audio/mclean/esv/Gen.3" }
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

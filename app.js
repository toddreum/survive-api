const API_BASE = "";

document.addEventListener('DOMContentLoaded', function() {
  renderSubscription();
  document.getElementById('subscribeBtn').addEventListener('click', async function() {
    const res = await fetch(`${API_BASE}/api/create-checkout-session`, {method:'POST'});
    const {checkoutUrl} = await res.json();
    window.location.href = checkoutUrl;
  });

  document.getElementById('attendYouthGroupBtn').addEventListener('click', function() {
    let last = localStorage.getItem('lastYouthGroupXP');
    let today = new Date().toDateString();
    if (last === today) {
      document.getElementById('youthGroupXPStatus').textContent = 'Already credited for today!';
      return;
    }
    localStorage.setItem('lastYouthGroupXP', today);
    addXRP(150, "Youth Group");
    document.getElementById('youthGroupXPStatus').textContent = 'Credited 150 XRP for attending Youth Group!';
  });

  document.getElementById('churchBtn').addEventListener('click', function() {
    const today = new Date().toDateString();
    if (localStorage.getItem('churchXP') === today) {
      document.getElementById('faithActionsStatus').textContent = "Already credited for Church today!";
      return;
    }
    localStorage.setItem('churchXP', today);
    addXRP(200, "Church");
    document.getElementById('faithActionsStatus').textContent = "Credited 200 XRP for attending Church!";
  });

  document.getElementById('sundaySchoolBtn').addEventListener('click', function() {
    const today = new Date().toDateString();
    if (localStorage.getItem('sundaySchoolXP') === today) {
      document.getElementById('faithActionsStatus').textContent = "Already credited for Sunday School today!";
      return;
    }
    localStorage.setItem('sundaySchoolXP', today);
    addXRP(150, "Sunday School");
    document.getElementById('faithActionsStatus').textContent = "Credited 150 XRP for attending Sunday School!";
  });

  document.getElementById('droveSiblingBtn').addEventListener('click', function() {
    addXRP(100, "Drove sibling");
    document.getElementById('serviceStatus').textContent = "Credited 100 XRP for driving your sibling!";
  });

  document.getElementById('helpedSomeoneBtn').addEventListener('click', function() {
    addXRP(100, "Helped someone");
    document.getElementById('serviceStatus').textContent = "Credited 100 XRP for helping someone today!";
  });

  document.getElementById('logServiceBtn').addEventListener('click', function() {
    const desc = document.getElementById('serviceDesc').value.trim();
    if (!desc) return;
    addXRP(120, "Logged service: " + desc);
    let log = localStorage.getItem('serviceLog') || '';
    log += `<div>${new Date().toLocaleString()}: ${desc}</div>`;
    localStorage.setItem('serviceLog', log);
    document.getElementById('serviceLog').innerHTML = log;
    document.getElementById('serviceDesc').value = '';
    document.getElementById('serviceStatus').textContent = "Credited 120 XRP for logging your act of service!";
  });

  document.getElementById('extracurricularBtn').addEventListener('click', function() {
    addXRP(80, "Extracurricular");
    document.getElementById('extracurricularStatus').textContent = "Credited 80 XRP for attending an extracurricular activity!";
  });

  document.getElementById('addYouthEventBtn').addEventListener('click', function() {
    let eventText = document.getElementById('newYouthEventText').value.trim();
    if (!eventText) return;
    let events = JSON.parse(localStorage.getItem('youthLeaderEvents') || '[]');
    events.push(eventText);
    localStorage.setItem('youthLeaderEvents', JSON.stringify(events));
    renderYouthLeaderEvents();
  });

  function renderYouthLeaderEvents() {
    let events = JSON.parse(localStorage.getItem('youthLeaderEvents') || '[]');
    let ul = document.getElementById('youthLeaderEvents');
    ul.innerHTML = events.map(e => `<li>${e}</li>`).join('');
  }
  renderYouthLeaderEvents();

  document.getElementById('sendEncouragementBtn').addEventListener('click', function() {
    let msg = document.getElementById('encouragementText').value.trim();
    if (!msg) return;
    let messages = JSON.parse(localStorage.getItem('leaderMessages') || '[]');
    messages.push(msg);
    localStorage.setItem('leaderMessages', JSON.stringify(messages));
    renderLeaderMessages();
  });

  function renderLeaderMessages() {
    let messages = JSON.parse(localStorage.getItem('leaderMessages') || '[]');
    let div = document.getElementById('leaderMessages');
    div.innerHTML = messages.map(m => `<div>${m}</div>`).join('');
  }
  renderLeaderMessages();

  document.getElementById('youthLeaderArea').style.display = '';

  document.getElementById('askAdvice').addEventListener('click', async () => {
    let q = document.getElementById('adviceIn').value.trim();
    let adviceOut = document.getElementById('adviceOut');
    adviceOut.textContent = "Thinking…";
    const res = await fetch(`${API_BASE}/api/advice`, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({question:q})
    });
    const data = await res.json();
    adviceOut.textContent = data.answer;
  });

  if (window.location.search.includes('subscription=success')) {
    localStorage.setItem('subscriptionActive', 'true');
    renderSubscription();
    alert('Subscription activated! Premium features unlocked.');
  }
});

function renderSubscription() {
  const status = document.getElementById('subscriptionStatus');
  if (!status) return;
  if (localStorage.getItem('subscriptionActive') === 'true') {
    status.innerHTML = `<b style="color:green;">Premium Active</b>`;
    document.getElementById('subscribeBtn').disabled = true;
  } else {
    status.innerHTML = `<b style="color:red;">Not Subscribed</b>.<br>Subscribe to unlock all features!`;
    document.getElementById('subscribeBtn').disabled = false;
  }
}

function addXRP(amount, reason) {
  let xrp = parseInt(localStorage.getItem('xrp') || '0', 10);
  xrp += amount;
  localStorage.setItem('xrp', xrp);
}

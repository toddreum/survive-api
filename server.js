const express = require('express');
const path = require('path');
const axios = require('axios');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// AI-powered advice endpoint (Christian, conservative)
app.post('/api/advice', async (req, res) => {
  const question = req.body.question || "";
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
  if (OPENAI_API_KEY) {
    try {
      const prompt = `
You are an AI advice assistant for a conservative Christian family app. 
Your advice should be biblical, faith-based, and right-leaning. 
Question: "${question}" 
Advice:`;
      const response = await axios.post(
        "https://api.openai.com/v1/completions",
        {
          model: "text-davinci-003",
          prompt,
          max_tokens: 120,
          temperature: 0.5
        },
        {
          headers: {
            "Authorization": `Bearer ${OPENAI_API_KEY}`,
            "Content-Type": "application/json"
          }
        }
      );
      res.json({ advice: response.data.choices?.[0]?.text?.trim() || "Pray, seek wisdom in Scripture, and consult your pastor or parents." });
    } catch (e) {
      res.json({ advice: "AI advice service error. Please seek wisdom in Scripture and prayer." });
    }
  } else {
    res.json({ advice: "Seek wisdom in the Bible, pray about your decision, and talk to your parents or church leaders for guidance. 'Trust in the Lord with all your heart.' (Proverbs 3:5)" });
  }
});

app.get('/manifest.json', (req, res) => res.sendFile(path.join(__dirname, 'public/manifest.json')));
app.get('/icon.svg', (req, res) => res.sendFile(path.join(__dirname, 'public/icon.svg')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/index.html'));
});

app.listen(PORT, () => {
  console.log(`Survive.com server running on port ${PORT}`);
});

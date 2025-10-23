// server.js
// npm i express cors cookie-parser stripe

import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import Stripe from "stripe";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

/* ------------------ FS helpers ------------------ */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* ------------------ ENV ------------------ */
const {
  PORT = 3000,
  NODE_ENV = "production",
  ALLOWED_ORIGIN = "https://survive.com",

  // Stripe keys
  STRIPE_SECRET,
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,

  // One-time prices
  STRIPE_PRICE_PREMIUM,
  STRIPE_PRICE_THEMES,
  STRIPE_PRICE_SURVIVAL,
  STRIPE_PRICE_STATS,
  STRIPE_PRICE_ADFREE,
  STRIPE_PRICE_DAILYHINT,

  // All-access (normalize both spellings)
  STRIPE_PRICE_ALLACCESS,
  STRIPE_PRICE_ALL_ACCESS,

  // Subscription (monthly)
  STRIPE_PRICE_MONTHLY,

  // Donation payment link (Stripe Payment Link URL)
  SUPPORT_LINK,

  // Optional tuning
  ROOM_MAX_ENV,
  CHAT_ENABLED = "true",
  CHAT_RATE_MS = "3000",
  CHAT_MAX_MSG_LEN = "200",

  // Optional: auto-categorize words without a category (else -> general)
  AUTO_CATEGORIZE = "false",
} = process.env;

// Normalize keys / envs
const STRIPE_KEY = STRIPE_SECRET || STRIPE_SECRET_KEY || "";
const PRICE_ALLACCESS = STRIPE_PRICE_ALLACCESS || STRIPE_PRICE_ALL_ACCESS || null;
const ROOM_MAX = Number(ROOM_MAX_ENV || 10);
const CHAT_ON = String(CHAT_ENABLED).toLowerCase() !== "false";
const CHAT_RATE = Math.max(1000, Number(CHAT_RATE_MS) || 3000);
const CHAT_MAXLEN = Math.min(500, Math.max(50, Number(CHAT_MAX_MSG_LEN) || 200));
const DO_AUTO_CAT = String(AUTO_CATEGORIZE).toLowerCase() === "true";

const stripe = STRIPE_KEY ? new Stripe(STRIPE_KEY, { apiVersion: "2024-06-20" }) : null;

if (!STRIPE_KEY) console.warn("⚠️ Stripe secret key missing");
if (!STRIPE_WEBHOOK_SECRET) console.warn("⚠️ STRIPE_WEBHOOK_SECRET missing");

const app = express();
app.set("trust proxy", true);

// CORS
app.use(cors({ origin: ALLOWED_ORIGIN, credentials: true }));

// Cookies + JSON (note: webhook uses express.raw later)
app.use(cookieParser());
app.use("/api", express.json());

/* ------------------ Static files ------------------ */
// Serve everything next to server.js (index.html, /data/words5.txt, /sw.js, images, etc.)
app.use(express.static(__dirname, {
  setHeaders(res, p) {
    if (p.endsWith(".html")) res.setHeader("Cache-Control", "no-store");
  }
}));

/* ------------------ UID cookie ------------------ */
function uidMiddleware(req, res, next) {
  let uid = req.cookies?.uid;
  if (!uid) {
    uid = crypto.randomUUID();
    res.cookie("uid", uid, {
      httpOnly: false,
      sameSite: "none",
      secure: true,
      path: "/",
      maxAge: 1000 * 60 * 60 * 24 * 365, // 1y
    });
  }
  req.uid = uid;
  next();
}
app.use(uidMiddleware);

/* ------------------ Categories ------------------ */
// Classic (your list)
const CLASSIC_CATS = [
  "animals","plants","food","health","body","emotions","objects","business",
  "politics","technology","places","nature","sports","people","general"
];
// Educational (your list)
const EDU_CATS = ["math","sciences","biology","chemistry","physics","history","geography","socials"];
const CATS = new Set([...CLASSIC_CATS, ...EDU_CATS, "general"]);

/* ------------------ Words loader ------------------ */
function inferCategory(w) {
  if (!DO_AUTO_CAT) return "general";
  // lightweight heuristics; anything unknown -> general
  const hints = {
    animals: ["zebra","tiger","whale","horse","eagle","shark","panda"],
    plants: ["cacti","flora","olive","grass"],
    food: ["apple","bread","grape","onion","pizza","sushi","cocoa"],
    body: ["brain","heart","tooth","elbow"],
    nature: ["stone","river","beach","storm","cloud"],
    places: ["paris","tokyo","spain","plaza","delta"],
    sports: ["chess","skate","hockey","tenis","socer"],
    technology: ["laser","cable","fiber","robot"],
    math: ["angle","ratio","sigma","theta","minus"],
    geography: ["delta","atlas","plain","coast","ocean"]
  };
  for (const [cat, arr] of Object.entries(hints)) if (arr.includes(w)) return cat;
  return "general";
}

const WORDS = [];
try {
  const p = path.join(__dirname, "data", "words5.txt");
  if (fs.existsSync(p)) {
    const raw = fs.readFileSync(p, "utf8").split(/\r?\n/);
    for (const line of raw) {
      if (!line) continue;
      const [w0, cat0] = line.split(",").map(s => (s || "").trim());
      const w = (w0 || "").toLowerCase();
      let cat = (cat0 || "").toLowerCase();
      if (/^[a-z]{5}$/.test(w)) {
        if (!cat) cat = inferCategory(w);
        if (!CATS.has(cat)) cat = "general";
        WORDS.push({ word: w, cat });
      }
    }
    // FIX: Added missing backtick to close template literal
    console.log(`✅ Loaded ${WORDS.length} words from data/words5.txt`);
  } else {
    console.warn("⚠️ data/words5.txt not found — using fallback list");
    for (const w of ["apple","build","crane","zebra","mouse","donut","crown","flame","stone","tiger"]) {
      WORDS.push({ word: w, cat: "general" });
    }
  }
} catch (e) {
  console.error("Word load error", e);
}

/* ------------------ In-memory DB ------------------ */
const purchases = new Map();      // Map<uid, Set<product>>
const lastWordByUid = new Map();  // Map<uid, Set<recent words>>
const scores = [];                // {uid, pts, mode, tz, at, name}
const rooms = new Map();          // Map<roomId, {host, members:Set<uid>, createdAt, max, msgs:[], __last:Map<uid,ts>}

/* ------------------ Payments helpers ------------------ */
const PRICE_TO_PRODUCT = new Map(
  [
    [PRICE_ALLACCESS, "all_access"],
    [STRIPE_PRICE_PREMIUM, "premium"],
    [STRIPE_PRICE_THEMES, "themes_pack"],
    [STRIPE_PRICE_SURVIVAL, "survival"],
    [STRIPE_PRICE_STATS, "premium_stats"],
    [STRIPE_PRICE_ADFREE, "ad_free"],
    [STRIPE_PRICE_DAILYHINT, "daily_hint"],
    [STRIPE_PRICE_MONTHLY, "monthly_pass"],
  ].filter(([k]) => !!k)
);

const PRODUCT_TO_PRICE = {
  all_access: PRICE_ALLACCESS,
  premium: STRIPE_PRICE_PREMIUM,
  themes_pack: STRIPE_PRICE_THEMES,
  survival: STRIPE_PRICE_SURVIVAL,
  premium_stats: STRIPE_PRICE_STATS,
  ad_free: STRIPE_PRICE_ADFREE,
  daily_hint: STRIPE_PRICE_DAILYHINT,
  monthly_pass: STRIPE_PRICE_MONTHLY,
};

function grant(uid, product) {
  const set = purchases.get(uid) ?? new Set();
  set.add(product);
  // Bundles imply others
  if (product === "premium" || product === "all_access" || product === "monthly_pass") {
    set.add("themes_pack");
    set.add("premium_stats");
    set.add("survival");
    set.add("ad_free");
    set.add("daily_hint");
  }
  purchases.set(uid, set);
}
function hasMonthly(uid) {
  const set = purchases.get(uid) || new Set();
  return set.has("monthly_pass");
}
function looksLikeContact(str) {
  if (!str) return false;
  const s = String(str);
  const email = /@|mail\.|gmail|outlook|yahoo|icloud/i.test(s);
  const phone = /(\+\d{1,3}[-.\s]?)?(\(?\d{3}\)?[-.\s]?){2}\d{4}/.test(s);
  const handle = /@[\w]{3,}/.test(s);
  const link = /(https?:\/\/|www\.)/i.test(s);
  return email || phone || handle || link;
}

/* ------------------ Health + Categories ------------------ */
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, words: WORDS.length, stripe: !!STRIPE_KEY, chat: CHAT_ON, roomMax: ROOM_MAX });
});
app.get("/api/categories", (_req, res) => {
  res.json({ classic: CLASSIC_CATS, education: EDU_CATS });
});

/* ------------------ Dictionary + Random ------------------ */
app.get("/api/isword/:w", (req, res) => {
  const w = String(req.params.w || "").toLowerCase();
  res.json({ ok: WORDS.some(x => x.word === w) });
});

app.get("/api/random", (req, res) => {
  const uid = req.uid;
  const cat = String(req.query.cat || "random").toLowerCase();
  let pool = WORDS;
  if (cat !== "random") {
    if (!CATS.has(cat)) return res.status(400).json({ error: "unknown-category" });
    pool = WORDS.filter(x => x.cat === cat);
  }
  if (!pool.length) return res.status(404).json({ error: "no-words" });

  const recent = lastWordByUid.get(uid) ?? new Set();
  let pick = pool[(Math.random() * pool.length) | 0].word;
  let guard = 0;
  while (recent.has(pick) && guard < 40) {
    pick = pool[(Math.random() * pool.length) | 0].word;
    guard++;
  }
  recent.add(pick);
  if (recent.size > 12) recent.delete([...recent][0]);
  lastWordByUid.set(uid, recent);

  res.json({ word: pick, cat: cat === "random" ? "random" : cat });
});

/* ------------------ Leaderboards ------------------ */
function regionFromTZ(tz) {
  return String(tz || "").split("/")[0] || "Region";
}
app.post("/api/lb/submit", (req, res) => {
  const { points = 0, mode = "beginner", tz = "UTC", name = "Player" } = req.body || {};
  scores.push({ uid: req.uid, pts: Number(points) || 0, mode, tz, at: Date.now(), name: String(name).slice(0, 20) });
  res.json({ ok: true });
});
function topBy(filter) {
  return scores
    .filter(filter)
    .sort((a, b) => b.pts - a.pts)
    .slice(0, 20)
    .map(x => ({ points: x.pts, mode: x.mode, when: x.at, name: x.name || "Player" }));
}
app.get("/api/lb/global", (req, res) => {
  const mode = String(req.query.mode || "beginner");
  res.json({ top: topBy(x => x.mode === mode) });
});
app.get("/api/lb/region", (req, res) => {
  const { tz = "UTC", mode = "beginner" } = req.query;
  const region = regionFromTZ(tz);
  res.json({ top: topBy(x => regionFromTZ(x.tz) === region && x.mode === mode) });
});

/* ------------------ Rooms + Safe Chat ------------------ */
app.post("/api/mp/create", (req, res) => {
  const roomId =
    (Math.random().toString(36).slice(2, 6) + Math.random().toString(36).slice(2, 4)).toUpperCase();
  rooms.set(roomId, {
    host: req.uid,
    members: new Set([req.uid]),
    createdAt: Date.now(),
    max: ROOM_MAX,
    msgs: [],
    __last: new Map(),
  });
  res.json({ ok: true, roomId, max: ROOM_MAX });
});

app.post("/api/mp/join", (req, res) => {
  const { roomId } = req.body || {};
  const r = rooms.get(String(roomId || "").toUpperCase());
  if (!r) return res.status(404).json({ error: "no-room" });
  if (r.members.size >= r.max) return res.status(403).json({ error: "room-full" });
  r.members.add(req.uid);
  res.json({ ok: true, roomId });
});

app.post("/api/match/queue", (req, res) => {
  const roomId =
    (Math.random().toString(36).slice(2, 6) + Math.random().toString(36).slice(2, 4)).toUpperCase();
  rooms.set(roomId, {
    host: req.uid,
    members: new Set([req.uid]),
    createdAt: Date.now(),
    max: 2,
    msgs: [],
    __last: new Map(),
  });
  res.json({ matched: true, roomId });
});

/* --- Emotes --- */
app.post("/api/mp/emote", (req, res) => {
  const { roomId, kind } = req.body || {};
  const r = rooms.get(String(roomId || "").toUpperCase());
  if (!r || !r.members.has(req.uid)) return res.status(403).json({ error: "not-in-room" });
  const SAFE = new Set(["👍", "😮", "🔥", "gg", "ready", "nice", "again"]);
  if (!SAFE.has(String(kind || ""))) return res.status(400).json({ error: "bad-emote" });
  r.msgs.push({ ts: Date.now(), uid: req.uid, type: "emote", kind: String(kind) });
  if (r.msgs.length > 200) r.msgs.shift();
  res.json({ ok: true });
});

/* --- Text chat (pay & age gated) --- */
app.post("/api/mp/chat", (req, res) => {
  if (!CHAT_ON) return res.status(403).json({ error: "chat-disabled" });

  const over18 = String(req.headers["x-over-18"] || "").toLowerCase() === "true";
  if (!over18) return res.status(403).json({ error: "over18-required" });
  if (!hasMonthly(req.uid)) return res.status(402).json({ error: "subscription-required" });

  const { roomId, text } = req.body || {};
  const r = rooms.get(String(roomId || "").toUpperCase());
  if (!r || !r.members.has(req.uid)) return res.status(403).json({ error: "not-in-room" });

  const msg = String(text || "").slice(0, CHAT_MAXLEN);
  if (!msg) return res.status(400).json({ error: "empty" });
  if (looksLikeContact(msg)) return res.status(400).json({ error: "contact-info-blocked" });

  const now = Date.now();
  const last = r.__last.get(req.uid) || 0;
  if (now - last < CHAT_RATE) return res.status(429).json({ error: "slow-down" });
  r.__last.set(req.uid, now);

  r.msgs.push({ ts: now, uid: req.uid, type: "chat", text: msg });
  if (r.msgs.length > 200) r.msgs.shift();
  res.json({ ok: true });
});

/* --- Room feed --- */
app.get("/api/mp/feed", (req, res) => {
  const roomId = String(req.query.roomId || "").toUpperCase();
  const since = Number(req.query.since || 0);
  const r = rooms.get(roomId);
  if (!r || !r.members.has(req.uid)) return res.status(403).json({ error: "not-in-room" });
  const items = r.msgs.filter(x => x.ts > since);
  res.json({ items, now: Date.now() });
});

/* ------------------ Perks / Status ------------------ */
function perksFor(uid) {
  const owned = purchases.get(uid) ?? new Set();
  const hasPremium = owned.has("premium") || owned.has("all_access") || owned.has("monthly_pass");
  return {
    active: hasPremium,
    owned: [...owned],
    perks: hasPremium
      ? { maxRows: 8, winBonus: 5, accent: "#ffb400", themesPack: true, tag: "👑" }
      : { maxRows: 6, winBonus: 0, themesPack: owned.has("themes_pack") },
    canChat: owned.has("monthly_pass"),
  };
}
app.get("/api/pay/status", (req, res) => res.json(perksFor(req.uid)));

/* ------------------ Donate ------------------ */
app.get("/api/pay/support-link", (req, res) => {
  if (!SUPPORT_LINK) return res.json({ error: "support-link-missing" });
  res.json({ url: SUPPORT_LINK });
});

/* ------------------ Stripe Checkout ------------------ */
app.post("/api/pay/checkout", async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ error: "stripe-key-missing" });
    const uid = req.uid;
    const { product } = req.body || {};
    const price = PRODUCT_TO_PRICE[product];
    if (!price) return res.status(400).json({ error: "Unknown product" });

    const session = await stripe.checkout.sessions.create({
      mode: product === "monthly_pass" ? "subscription" : "payment",
      client_reference_id: uid,
      line_items: [{ price, quantity: 1 }],
      success_url: `${ALLOWED_ORIGIN}/?purchase=success`,
      cancel_url: `${ALLOWED_ORIGIN}/?purchase=cancel`,
      metadata: { product, uid },
    });

    res.json({ url: session.url });
  } catch (e) {
    console.error("checkout error", e);
    res.status(500).json({ error: "checkout-failed" });
  }
});

/* ------------------ Stripe Webhook ------------------ */
app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), (req, res) => {
  if (!stripe) return res.status(500).send("stripe-key-missing");
  const sig = req.headers["stripe-signature"];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    console.error("Webhook verify failed:", e.message);
    return res.status(400).send(`Webhook Error: ${e.message}`);
  }

  (async () => {
    try {
      switch (event.type) {
        case "checkout.session.completed": {
          const session = await stripe.checkout.sessions.retrieve(event.data.object.id, {
            expand: ["line_items.data.price"],
          });
          const uid = session.client_reference_id || session.metadata?.uid;
          let product = session.metadata?.product;

          if (!product && session.line_items?.data?.[0]?.price?.id) {
            product = PRICE_TO_PRODUCT.get(session.line_items.data[0].price.id);
          }

          if (uid && product) {
            grant(uid, product);
            console.log(`✅ Granted ${product} to ${uid}`);
          } else {
            console.warn("⚠️ Missing uid or product in webhook");
          }
          break;
        }
        default:
          break;
      }
      res.json({ received: true });
    } catch (e) {
      console.error("Webhook handler error", e);
      res.status(500).send("webhook-handler-error");
    }
  })();
});

/* ------------------ Root ------------------ */
app.get("/", (_req, res) => {
  const f = path.join(__dirname, "index.html");
  if (fs.existsSync(f)) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    fs.createReadStream(f).pipe(res);
  } else {
    res.status(200).send("<h1>Survive API</h1>");
  }
});

/* ------------------ Service Worker at /sw.js ------------------ */
// Network-first; falls back to offline words if /api/random fails.
app.get("/sw.js", (_req, res) => {
  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.setHeader("Service-Worker-Allowed", "/");
  const VERSION = `v${Date.now()}`;
  const sw = `/* Survive SW ${VERSION} */
const CACHE = "survive-${VERSION}";
const APP_SHELL = ["/","/index.html","/sw.js","/survive-logo.png","/data/words5.txt","/words5.txt"];

const OFFLINE_WORDS = {
  general:["apple","chair","crown","zebra","tiger","cable","nurse","plant","brain","heart"],
  animals:["zebra","tiger","panda","whale","eagle"],
  plants:["plant","grass","olive","cacti","flora"],
  food:["apple","bread","grape","onion","pizza"],
  health:["nurse","vital","salts","clean","medic"],
  body:["brain","tooth","elbow","knees","hands"],
  emotions:["happy","angry","proud","smile","scare"],
  objects:["chair","table","couch","phone","clock"],
  business:["money","sales","stock","trade","loans"],
  politics:["voter","party","union","civic","bills"],
  technology:["laser","cable","fiber","robot","chips"],
  places:["paris","tokyo","spain","plaza","delta"],
  nature:["stone","river","beach","storm","cloud"],
  sports:["chess","skate","tenis","hockey","socer"],
  people:["human","adult","pilot","guard","nurse"],
  math:["angle","ratio","sigma","theta","minus"],
  sciences:["cells","atoms","field","light","waves"],
  biology:["flora","fauna","spore","organ","genes"],
  chemistry:["ionic","oxide","ester","atoms","amine"],
  physics:["force","quark","boson","laser","field"],
  history:["roman","noble","union","empir","spain"],
  geography:["delta","atlas","plain","coast","ocean"],
  socials:["group","class","norms","ethic","civix"],
};

self.addEventListener("install", e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(APP_SHELL)).catch(()=>{}));
  self.skipWaiting();
});
self.addEventListener("activate", e=>{
  e.waitUntil((async()=>{
    const keys = await caches.keys();
    await Promise.all(keys.map(k=>k===CACHE?null:caches.delete(k)));
    self.clients.claim();
  })());
});

function offlineRandom(cat){
  const list = OFFLINE_WORDS[cat] || OFFLINE_WORDS.general || ["apple"];
  const word = list[(Math.random()*list.length)|0] || "apple";
  return new Response(JSON.stringify({ word, cat, offline:true }), { headers:{ "Content-Type":"application/json" }});
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // API: network-first; /api/random has offline fallback
  if (url.pathname.startsWith("/api/")) {
    if (url.pathname === "/api/random") {
      event.respondWith((async()=>{
        try {
          const net = await fetch(req);
          if (net && net.ok) return net;
          const cat = (url.searchParams.get("cat") || "general").toLowerCase();
          return offlineRandom(cat);
        } catch {
          const cat = (url.searchParams.get("cat") || "general").toLowerCase();
          return offlineRandom(cat);
        }
      })());
      return;
    }
    event.respondWith((async()=>{
      try {
        const net = await fetch(req);
        if (net && net.ok) return net;
        const cache = await caches.open(CACHE);
        const cached = await cache.match(req);
        return cached || net;
      } catch {
        const cache = await caches.open(CACHE);
        const cached = await cache.match(req);
        return cached || new Response(JSON.stringify({error:"offline"}), {status:503});
      }
    })());
    return;
  }

  // Navigations: network-first with cached fallback
  if (req.mode === "navigate") {
    event.respondWith((async()=>{
      try {
        const net = await fetch(req);
        const cache = await caches.open(CACHE);
        cache.put("/index.html", net.clone());
        return net;
      } catch {
        const cache = await caches.open(CACHE);
        const cached = await cache.match("/index.html");
        return cached || new Response("<h1>Offline</h1>",{headers:{"Content-Type":"text/html"}});
      }
    })());
    return;
  }

  // Other same-origin GET: stale-while-revalidate
  if (req.method === "GET") {
    event.respondWith((async()=>{
      const cache = await caches.open(CACHE);
      const cached = await cache.match(req);
      const netP = fetch(req).then(resp=>{
        if (resp && resp.ok) cache.put(req, resp.clone());
        return resp;
      }).catch(()=>null);
      return cached || (await netP) || Response.error();
    })());
  }
});`;
  res.end(sw);
});

/* ------------------ Start ------------------ */
app.listen(PORT, () => {
  console.log(`API listening on :${PORT} (${NODE_ENV})`);
});

// server.js
// npm i express cors cookie-parser stripe crypto
// Directory: add "data/words5.txt" (one word or word,category per line; lowercase)

import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import Stripe from "stripe";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* ---------- ENV ---------- */
const {
  PORT = 3000,
  NODE_ENV = "production",

  // accept either name for the Stripe key
  STRIPE_SECRET,
  STRIPE_SECRET_KEY,

  STRIPE_WEBHOOK_SECRET,

  STRIPE_PRICE_ALLACCESS,
  STRIPE_PRICE_PREMIUM,
  STRIPE_PRICE_THEMES,
  STRIPE_PRICE_SURVIVAL,
  STRIPE_PRICE_STATS,
  STRIPE_PRICE_ADFREE,
  STRIPE_PRICE_DAILYHINT,
  STRIPE_PRICE_MONTHLY,         // monthly subscription (optional)

  SUPPORT_LINK,                 // Stripe payment link for Donate

  ALLOWED_ORIGIN = "https://survive.com",
  SESSION_SECRET = crypto.randomBytes(24).toString("hex"),
} = process.env;

const STRIPE_KEY = STRIPE_SECRET || STRIPE_SECRET_KEY || "";
if (!STRIPE_KEY) console.warn("⚠️  STRIPE secret key missing");
if (!STRIPE_WEBHOOK_SECRET) console.warn("⚠️  STRIPE_WEBHOOK_SECRET missing");

const stripe = STRIPE_KEY ? new Stripe(STRIPE_KEY, { apiVersion: "2024-06-20" }) : null;

const app = express();
app.set("trust proxy", true);

app.use(
  cors({
    origin: ALLOWED_ORIGIN,
    credentials: true,
  })
);
app.use(cookieParser(SESSION_SECRET));
app.use("/api", express.json());

/* ---------- UID cookie ---------- */
function uidMiddleware(req, res, next) {
  let uid = req.cookies?.uid;
  if (!uid) {
    uid = crypto.randomUUID();
    res.cookie("uid", uid, {
      httpOnly: false,
      sameSite: "none",
      secure: true,
      path: "/",
      maxAge: 1000 * 60 * 60 * 24 * 365,
    });
  }
  req.uid = uid;
  next();
}
app.use(uidMiddleware);

/* ---------- Words loader ---------- */
const WORDS = []; // { word, cat }
const CATS = new Set(["animals","science","geography","food","history","math","language","general"]);
try {
  const p = path.join(__dirname, "data", "words5.txt");
  if (fs.existsSync(p)) {
    const raw = fs.readFileSync(p, "utf8").split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
    for (const line of raw) {
      const [w,cat] = line.split(",").map(x=>x?.trim()||"");
      if (/^[a-z]{5}$/.test(w)) {
        WORDS.push({ word:w, cat: (cat && CATS.has(cat)?cat:"general") });
      }
    }
    console.log(`✅ Loaded ${WORDS.length} words from data/words5.txt`);
  } else {
    console.warn("⚠️  data/words5.txt not found, fallback mini list");
    for (const w of ["apple","build","crane","zebra","mouse","donut","crown"]) {
      WORDS.push({ word:w, cat:"general" });
    }
  }
} catch (e) {
  console.error("Word load error", e);
}

/* ---------- In-memory DB (replace with real DB later) ---------- */
const purchases = new Map();          // Map<uid, Set<product>>
const scores = [];                    // {uid, pts, mode, tz, at}
const regions = new Map();            // Map<uid, tz>
const lastWordByUid = new Map();      // Map<uid, Set<recentWords>>
const rooms = new Map();              // Map<roomId, {host, members:Set<uid>, createdAt, feed:[], max:10}>
const emoteFeed = new Map();          // Map<roomId, Array<{ts, uid, kind}>>

/* ---------- Helpers ---------- */
const PRICE_TO_PRODUCT = new Map(
  [
    [STRIPE_PRICE_ALLACCESS, "all_access"],
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
  all_access: STRIPE_PRICE_ALLACCESS,
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
  if (product === "premium" || product === "all_access") {
    set.add("themes_pack"); set.add("premium_stats"); set.add("survival"); set.add("ad_free"); set.add("daily_hint");
  }
  purchases.set(uid, set);
}
function revoke(uid, product) {
  const set = purchases.get(uid); if (!set) return;
  set.delete(product); purchases.set(uid, set);
}
function countryFromTZ(tz){ return String(tz||"").split("/")[0] || "Region"; }

/* ---------- Health ---------- */
app.get("/api/health", (_req,res) => res.json({ ok:true, words:WORDS.length, stripe: !!STRIPE_KEY }));

/* ---------- Dictionary & random word ---------- */
app.get("/api/isword/:w", (req,res)=>{
  const w = String(req.params.w||"").toLowerCase();
  const ok = WORDS.some(x=>x.word===w);
  res.json({ ok });
});

app.get("/api/words5", (_req,res)=>{
  res.type("text/plain").send(WORDS.map(x=>x.word).join("\n"));
});

app.get("/api/random", (req,res)=>{
  const cat = String(req.query.cat||"random");
  const uid = req.uid;

  let pool = WORDS;
  if (cat !== "random") pool = WORDS.filter(x=>x.cat===cat);
  if (!pool.length) return res.status(404).json({ error:"no-words" });

  // avoid immediate repeats per uid
  const recent = lastWordByUid.get(uid) ?? new Set();
  let pick = pool[Math.floor(Math.random()*pool.length)].word;
  let guard = 0;
  while (recent.has(pick) && guard<30) {
    pick = pool[Math.floor(Math.random()*pool.length)].word;
    guard++;
  }
  recent.add(pick); if (recent.size>8) recent.delete([...recent][0]);
  lastWordByUid.set(uid, recent);

  res.json({ word: pick });
});

/* ---------- Leaderboards ---------- */
app.post("/api/lb/submit", (req,res)=>{
  const { points=0, mode="beginner", tz="UTC", name="Player" } = req.body || {};
  const uid = req.uid;
  regions.set(uid, tz);
  scores.push({ uid, pts: Number(points)||0, mode, tz, at: Date.now(), name: String(name).slice(0,20) });
  res.json({ ok:true });
});
function topBy(filter){
  return scores
    .filter(filter)
    .sort((a,b)=>b.pts-a.pts)
    .slice(0,20)
    .map(x=>({ points:x.pts, mode:x.mode, when:x.at, name:x.name||"Player" }));
}
app.get("/api/lb/global",(req,res)=>{
  const mode = String(req.query.mode||"beginner");
  res.json({ top: topBy(x=>x.mode===mode) });
});
app.get("/api/lb/region",(req,res)=>{
  const { tz="UTC", mode="beginner" } = req.query;
  const region = countryFromTZ(tz);
  res.json({ top: topBy(x=>countryFromTZ(x.tz)===region && x.mode===mode) });
});

/* ---------- Minimal “rooms” & safe emotes ---------- */
function sanitizeEmotePayload(kind){
  // allow only known emotes / canned phrases
  const SAFE = new Set(["👍","😮","🔥","gg","ready","nice","again"]);
  if (!SAFE.has(kind)) return null;
  return kind;
}
// Reject contact info if we ever allow text (we don't here)
function looksLikeContact(s){
  const hasEmail = /@|mail\.|gmail|outlook|yahoo|icloud/i.test(s);
  const hasPhone = /(\+\d{1,3}[-.\s]?)?(\(?\d{3}\)?[-.\s]?){2}\d{4}/.test(s);
  const hasHandle = /@[\w]{3,}/.test(s);
  return hasEmail || hasPhone || hasHandle;
}

const ROOM_MAX = 10;

app.post("/api/mp/create",(req,res)=>{
  const roomId = (Math.random().toString(36).slice(2,6)+Math.random().toString(36).slice(2,4)).toUpperCase();
  rooms.set(roomId,{ host:req.uid, members:new Set([req.uid]), createdAt:Date.now(), max:ROOM_MAX });
  emoteFeed.set(roomId,[]);
  res.json({ ok:true, roomId, max:ROOM_MAX });
});
app.post("/api/mp/join",(req,res)=>{
  const { roomId } = req.body||{};
  const r = rooms.get(String(roomId||"").toUpperCase());
  if (!r) return res.status(404).json({ error:"no-room" });
  if (r.members.size >= (r.max||ROOM_MAX)) return res.status(403).json({ error:"room-full" });
  r.members.add(req.uid);
  res.json({ ok:true, roomId });
});
app.post("/api/match/queue",(req,res)=>{
  // demo: instantly returns a fake match room
  const roomId = (Math.random().toString(36).slice(2,6)+Math.random().toString(36).slice(2,4)).toUpperCase();
  rooms.set(roomId,{ host:req.uid, members:new Set([req.uid]), createdAt:Date.now(), max:2 });
  emoteFeed.set(roomId,[]);
  res.json({ matched:true, roomId });
});
app.post("/api/mp/emote",(req,res)=>{
  const { roomId, kind } = req.body||{};
  const r = rooms.get(String(roomId||"").toUpperCase());
  if (!r || !r.members.has(req.uid)) return res.status(403).json({ error:"not-in-room" });
  const safe = sanitizeEmotePayload(String(kind||""));
  if (!safe) return res.status(400).json({ error:"bad-emote" });
  emoteFeed.get(roomId).push({ ts:Date.now(), uid:req.uid, kind:safe });
  if (emoteFeed.get(roomId).length>60) emoteFeed.get(roomId).shift();
  res.json({ ok:true });
});
app.get("/api/mp/feed",(req,res)=>{
  const roomId = String(req.query.roomId||"").toUpperCase();
  const since = Number(req.query.since||0);
  const r = rooms.get(roomId);
  if (!r || !r.members.has(req.uid)) return res.status(403).json({ error:"not-in-room" });
  const feed = (emoteFeed.get(roomId)||[]).filter(x=>x.ts>since);
  res.json({ items: feed, now: Date.now() });
});

/* ---------- Perks status ---------- */
function perksFor(uid){
  const owned = purchases.get(uid) ?? new Set();
  const hasPremium = owned.has("premium") || owned.has("all_access") || owned.has("monthly_pass");
  return {
    active: hasPremium,
    owned: [...owned],
    perks: hasPremium
      ? { maxRows: 8, winBonus: 5, accent:"#ffb400", themesPack:true, tag:"👑" }
      : { maxRows: 6, winBonus: 0, themesPack: owned.has("themes_pack") }
  };
}
app.get("/api/pay/status",(req,res)=> res.json(perksFor(req.uid)));

/* ---------- Donate redirect ---------- */
app.get("/api/pay/support-link",(req,res)=>{
  if (!SUPPORT_LINK) return res.json({ error:"support-link-missing" });
  res.json({ url: SUPPORT_LINK });
});

/* ---------- Checkout ---------- */
app.post("/api/pay/checkout", async (req,res)=>{
  try {
    if (!stripe) return res.status(500).json({ error:"stripe-key-missing" });
    const uid = req.uid;
    const { product } = req.body||{};
    const price = PRODUCT_TO_PRICE[product];
    if (!price) return res.status(400).json({ error:"Unknown product" });

    const session = await stripe.checkout.sessions.create({
      mode: product==="monthly_pass" ? "subscription" : "payment",
      client_reference_id: uid,
      line_items: [{ price, quantity:1 }],
      success_url: `${ALLOWED_ORIGIN}/?purchase=success`,
      cancel_url: `${ALLOWED_ORIGIN}/?purchase=cancel`,
      metadata: { product, uid }
    });
    return res.json({ url: session.url });
  } catch (e) {
    console.error("checkout error", e);
    return res.status(500).json({ error:"checkout-failed" });
  }
});

/* ---------- Webhook ---------- */
app.post("/api/stripe/webhook", express.raw({ type:"application/json" }), (req,res)=>{
  if (!stripe) return res.status(500).send("stripe-key-missing");
  const sig = req.headers["stripe-signature"];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    console.error("Webhook verify failed", e.message);
    return res.status(400).send(`Webhook Error: ${e.message}`);
  }

  (async ()=>{
    try{
      switch (event.type) {
        case "checkout.session.completed": {
          const session = await stripe.checkout.sessions.retrieve(event.data.object.id, { expand:["line_items.data.price"] });
          const uid = session.client_reference_id || session.metadata?.uid;
          let product = session.metadata?.product;
          if (!product && session.line_items?.data?.[0]?.price?.id) {
            product = PRICE_TO_PRODUCT.get(session.line_items.data[0].price.id);
          }
          if (uid && product) {
            grant(uid, product);
            console.log(`✅ Granted ${product} to ${uid}`);
          } else {
            console.warn("⚠️ Missing uid or product");
          }
          break;
        }
        case "charge.refunded": {
          // optional: look up original session -> product and revoke
          console.log("Refund", event.data.object.id);
          break;
        }
        default: break;
      }
      res.json({ received:true });
    } catch (e) {
      console.error("Webhook handler error", e);
      res.status(500).send("webhook-handler-error");
    }
  })();
});

/* ---------- Start ---------- */
app.listen(PORT, ()=> {
  console.log(`API listening on :${PORT} (${NODE_ENV})`);
});

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
  const w = String(req.params

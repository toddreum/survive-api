import express from "express";
import http from "http";
import { Server as IOServer } from "socket.io";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new IOServer(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---------- STATIC: resolve public directory robustly ----------
const PUBLIC_DIR = process.env.PUBLIC_DIR
  ? path.resolve(process.env.PUBLIC_DIR)
  : path.join(__dirname, "public");

// Log once on boot (useful in Render logs)
console.log("[BOOT] __dirname =", __dirname);
console.log("[BOOT] PUBLIC_DIR =", PUBLIC_DIR);
try {
  const listing = fs.readdirSync(PUBLIC_DIR);
  console.log("[BOOT] public/ contents:", listing);
} catch (e) {
  console.warn("[BOOT] public/ not found yet:", e.message);
}

app.use(express.static(PUBLIC_DIR));

// server.js
import express from "express";
import Datastore from "nedb";
import dotenv from "dotenv";
import mysql from "mysql2/promise";

dotenv.config();

const app = express();
app.use(express.json());

// --- Existing NeDB logs (keep) ---
import path from "path";
const db = new Datastore({
  filename: path.join(process.cwd(), "logs.db"),
  autoload: true
});
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.static(path.join(__dirname, "public")));

// --- NEW: MySQL pool for 'players' table ---
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  connectionLimit: 10,
});

// ---------------- Existing routes (keep) ----------------
app.get("/logs", (req, res) => {
  res.sendFile("logs.html", { root: "public" });
});

app.get("/api/logs", (req, res) => {
  const type = req.query.type;
  const limit = parseInt(req.query.limit) || 100;
  const query = type ? { type } : {};
  db.find(query).sort({ ts: -1 }).limit(limit).exec((err, docs) => {
  if (err) return res.status(500).json({ error: err });
  console.log("[DB] fetched", docs.length, "logs");
  res.json(docs);
});
});
// --------------------------------------------------------

// Search accounts by userId OR by character name
app.get("/api/players", async (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    if (!q) return res.json([]);

    // Match either by userId or by character name
    const [matches] = await pool.query(
      `SELECT userId, name
       FROM players
       WHERE userId LIKE CONCAT('%', ?, '%')
          OR name LIKE CONCAT('%', ?, '%')
       LIMIT 20`,
      [q, q]
    );

    if (!matches.length) return res.json([]);

    // Group by userId and pick the first matching character name
    const seen = new Set();
    const results = [];
    for (const row of matches) {
      if (!seen.has(row.userId)) {
        seen.add(row.userId);
        results.push({
          id: row.userId,
          name: row.name, // just show the character name
        });
      }
    }

    res.json(results);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Search failed" });
  }
});

// Fetch all characters for a given userId
app.get("/api/account/:userId", async (req, res) => {
  try {
    const uid = req.params.userId;

    const [rows] = await pool.query(
      "SELECT * FROM players WHERE userId = ?",
      [uid]
    );

    if (!rows.length) return res.status(404).json({ error: "No characters found" });

    const parseJSON = (x) => {
      try { return typeof x === "string" ? JSON.parse(x) : x; }
      catch { return null; }
    };

    const characters = rows.map(row => ({
      citizenid: row.citizenid,
      name: row.name,
      money: parseJSON(row.money) || {},
      job: parseJSON(row.job) || {},
      info: parseJSON(row.info ?? row.charinfo) || {}
    }));

    res.json({ userId: uid, characters });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Lookup failed" });
  }
});


// NEW: player details page JSON from *MySQL* players table
app.get("/api/player/:citizenid", async (req, res) => {
  try {
    const cid = req.params.citizenid;

    // Query from table `players` in database `qbox_862f7b`
    const [rows] = await pool.query(
      "SELECT * FROM players WHERE citizenid = ? LIMIT 1",
      [cid]
    );

    if (!rows.length) {
      return res.status(404).json({ error: "Player not found" });
    }

    const row = rows[0];

    const parseJSON = (x) => {
      try { return typeof x === "string" ? JSON.parse(x) : x; }
      catch { return null; }
    };

    const money = parseJSON(row.money) || {};
    const job   = parseJSON(row.job)   || {};

    // Some frameworks use `info`, others `charinfo`
    const infoRaw = row.info ?? row.charinfo ?? null;
    const info    = parseJSON(infoRaw) || {};

    res.json({
      citizenid: row.citizenid,
      name: row.name,
      money,
      job,
      info,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Lookup failed" });
  }
});


//job and jobgrades
app.get("/api/jobs", async (req, res) => {
  try {
    const [jobs] = await pool.query("SELECT name, label FROM jobs ORDER BY label ASC");
    const [grades] = await pool.query(
      "SELECT job_name, grade, name AS grade_name, payment, isboss FROM job_grades ORDER BY job_name, grade"
    );

    const byJob = new Map();
    for (const j of jobs) byJob.set(j.name, { name: j.name, label: j.label, grades: [] });
    for (const g of grades) {
      const job = byJob.get(g.job_name);
      if (job) {
        job.grades.push({
        level: Number(g.grade),
        name: g.grade_name,
        label: g.grade_name, // fallback since no separate label column
        isboss: g.isboss === 1
      });
      }
    }
    res.json(Array.from(byJob.values()));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to load jobs" });
  }
});


// Change a character's job
app.post("/api/player/:citizenid/job", async (req, res) => {
  try {
    const cid = req.params.citizenid;
    const { jobName, gradeLevel } = req.body || {};

    if (!jobName || gradeLevel == null) {
      return res.status(400).json({ error: "jobName and gradeLevel are required" });
    }

    // Validate player exists
    const [players] = await pool.query("SELECT citizenid FROM players WHERE citizenid = ? LIMIT 1", [cid]);
    if (!players.length) return res.status(404).json({ error: "Player not found" });

    // Validate job exists
    const [[job]] = await pool.query("SELECT name, label FROM jobs WHERE name = ? LIMIT 1", [jobName]);
    if (!job) return res.status(400).json({ error: "Invalid job" });

    // Validate grade exists for job
    const [[grade]] = await pool.query(
      "SELECT grade, name AS grade_name, payment, isboss FROM job_grades WHERE job_name = ? AND grade = ? LIMIT 1",
      [jobName, gradeLevel]
    );
    if (!grade) return res.status(400).json({ error: "Invalid grade for this job" });

    // Build QBCore/QBox-style job JSON
    const jobObj = {
    name: job.name,
    label: job.label,
    grade: {
      level: Number(grade.grade),
      name: grade.grade_name,
    },
    payment: Number(grade.payment ?? 0),
    onduty: false,
    isboss: grade.isboss === 1
  };


    // Update players.job
    await pool.query("UPDATE players SET job = ? WHERE citizenid = ? LIMIT 1", [JSON.stringify(jobObj), cid]);

    res.json({ ok: true, job: jobObj });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to change job" });
  }
});


// server logs
app.post("/api/ingest", (req, res) => {
  const apiKey = req.get("x-api-key");
  if (process.env.LOGGER_KEY && apiKey !== process.env.LOGGER_KEY) {
    return res.status(403).json({ error: "invalid api key" });
  }

  const log = { ...req.body, ts: Date.now() };
  console.log("[INGEST]", log); // add debug print

  db.insert(log, (err, doc) => {
    if (err) {
      console.error("Failed to insert log:", err);
      return res.status(500).json({ error: "insert failed" });
    }
    console.log("[DB] inserted:", doc);   // 👈 confirm save
    res.json({ ok: true });
  });
});


const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));


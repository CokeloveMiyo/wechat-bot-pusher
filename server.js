const express = require("express");
const Database = require("better-sqlite3");
const cron = require("node-cron");
const axios = require("axios");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3456;
const WEBHOOK_URL = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=51afe73c-e354-4543-896c-f5468e4bb4a3";

const db = new Database(path.join(__dirname, "data.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

const SQL = [
"CREATE TABLE IF NOT EXISTS messages (",
"  id INTEGER PRIMARY KEY AUTOINCREMENT,",
"  name TEXT NOT NULL, msgtype TEXT NOT NULL DEFAULT 'text',",
"  content TEXT NOT NULL DEFAULT '{}',",
"  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,",
"  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP",
");",
"CREATE TABLE IF NOT EXISTS schedules (",
"  id INTEGER PRIMARY KEY AUTOINCREMENT,",
"  message_id INTEGER NOT NULL, cron_expression TEXT NOT NULL,",
"  enabled INTEGER NOT NULL DEFAULT 1,",
"  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,",
"  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,",
"  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE",
");",
"CREATE TABLE IF NOT EXISTS send_logs (",
"  id INTEGER PRIMARY KEY AUTOINCREMENT,",
"  message_id INTEGER, status TEXT NOT NULL,",
"  response TEXT, sent_at DATETIME DEFAULT CURRENT_TIMESTAMP",
");"
].join("\n");
db.exec(SQL);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

async function sendToWechatBot(message) {
  const content = JSON.parse(message.content);
  let payload;
  switch (message.msgtype) {
    case "text":
      payload = { msgtype: "text", text: { content: content.text || "" } };
      break;
    case "markdown":
      payload = { msgtype: "markdown", markdown: { content: content.markdown || "" } };
      break;
    case "news":
      payload = { msgtype: "news", news: { articles: (content.articles || []).slice(0, 8) } };
      break;
    case "image":
      payload = { msgtype: "image", image: { base64: content.base64 || "", md5: content.md5 || "" } };
      break;
    default:
      throw new Error("Unsupported msgtype: " + message.msgtype);
  }
  const response = await axios.post(WEBHOOK_URL, payload, {
    headers: { "Content-Type": "application/json" }, timeout: 10000
  });
  return response.data;
}

// Messages API
app.get("/api/messages", (req, res) => {
  res.json(db.prepare("SELECT * FROM messages ORDER BY updated_at DESC").all());
});
app.get("/api/messages/:id", (req, res) => {
  const msg = db.prepare("SELECT * FROM messages WHERE id = ?").get(req.params.id);
  if (!msg) return res.status(404).json({ error: "Not found" });
  res.json(msg);
});
app.post("/api/messages", (req, res) => {
  const { name, msgtype, content } = req.body;
  if (!name || !msgtype) return res.status(400).json({ error: "Name and type required" });
  const r = db.prepare("INSERT INTO messages (name, msgtype, content) VALUES (?, ?, ?)")
    .run(name, msgtype, JSON.stringify(content || {}));
  res.status(201).json(db.prepare("SELECT * FROM messages WHERE id = ?").get(r.lastInsertRowid));
});
app.put("/api/messages/:id", (req, res) => {
  const { name, msgtype, content } = req.body;
  if (!db.prepare("SELECT id FROM messages WHERE id=?").get(req.params.id))
    return res.status(404).json({ error: "Not found" });
  db.prepare("UPDATE messages SET name=COALESCE(?,name), msgtype=COALESCE(?,msgtype), content=COALESCE(?,content), updated_at=CURRENT_TIMESTAMP WHERE id=?")
    .run(name||null, msgtype||null, content?JSON.stringify(content):null, req.params.id);
  res.json(db.prepare("SELECT * FROM messages WHERE id = ?").get(req.params.id));
});
app.delete("/api/messages/:id", (req, res) => {
  if (!db.prepare("SELECT id FROM messages WHERE id=?").get(req.params.id))
    return res.status(404).json({ error: "Not found" });
  db.prepare("DELETE FROM messages WHERE id=?").run(req.params.id);
  res.json({ success: true });
});

// Schedules API
app.get("/api/messages/:id/schedules", (req, res) => {
  res.json(db.prepare("SELECT * FROM schedules WHERE message_id=? ORDER BY created_at DESC").all(req.params.id));
});
app.get("/api/schedules", (req, res) => {
  res.json(db.prepare("SELECT s.*, m.name as message_name FROM schedules s JOIN messages m ON s.message_id=m.id ORDER BY s.created_at DESC").all());
});
app.post("/api/messages/:id/schedules", (req, res) => {
  const { cron_expression } = req.body;
  if (!cron_expression || !cron.validate(cron_expression))
    return res.status(400).json({ error: "Invalid cron expression" });
  if (!db.prepare("SELECT id FROM messages WHERE id=?").get(req.params.id))
    return res.status(404).json({ error: "Message not found" });
  const r = db.prepare("INSERT INTO schedules (message_id, cron_expression) VALUES (?,?)")
    .run(req.params.id, cron_expression);
  const schedule = db.prepare("SELECT * FROM schedules WHERE id=?").get(r.lastInsertRowid);
  registerSchedule(schedule);
  res.status(201).json(schedule);
});
app.put("/api/schedules/:id", (req, res) => {
  const { cron_expression, enabled } = req.body;
  if (!db.prepare("SELECT id FROM schedules WHERE id=?").get(req.params.id))
    return res.status(404).json({ error: "Not found" });
  if (cron_expression && !cron.validate(cron_expression))
    return res.status(400).json({ error: "Invalid cron expression" });
  db.prepare("UPDATE schedules SET cron_expression=COALESCE(?,cron_expression), enabled=COALESCE(?,enabled), updated_at=CURRENT_TIMESTAMP WHERE id=?")
    .run(cron_expression||null, enabled!==undefined?enabled:null, req.params.id);
  unregisterSchedule(req.params.id);
  const updated = db.prepare("SELECT * FROM schedules WHERE id=?").get(req.params.id);
  if (updated.enabled) registerSchedule(updated);
  res.json(updated);
});
app.delete("/api/schedules/:id", (req, res) => {
  if (!db.prepare("SELECT id FROM schedules WHERE id=?").get(req.params.id))
    return res.status(404).json({ error: "Not found" });
  unregisterSchedule(req.params.id);
  db.prepare("DELETE FROM schedules WHERE id=?").run(req.params.id);
  res.json({ success: true });
});

// Send & Logs
app.post("/api/messages/:id/send", async (req, res) => {
  const msg = db.prepare("SELECT * FROM messages WHERE id=?").get(req.params.id);
  if (!msg) return res.status(404).json({ error: "Not found" });
  try {
    const response = await sendToWechatBot(msg);
    db.prepare("INSERT INTO send_logs (message_id, status, response) VALUES (?,?,?)")
      .run(msg.id, "success", JSON.stringify(response));
    res.json({ success: true, response });
  } catch (err) {
    db.prepare("INSERT INTO send_logs (message_id, status, response) VALUES (?,?,?)")
      .run(msg.id, "error", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});
app.get("/api/logs", (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json(db.prepare("SELECT l.*, m.name as message_name FROM send_logs l LEFT JOIN messages m ON l.message_id=m.id ORDER BY l.sent_at DESC LIMIT ?").all(limit));
});

// Cron Manager
const cronJobs = new Map();
function registerSchedule(schedule) {
  if (!schedule.enabled || cronJobs.has(schedule.id)) return;
  try {
    const job = cron.schedule(schedule.cron_expression, async () => {
      const msg = db.prepare("SELECT * FROM messages WHERE id=?").get(schedule.message_id);
      if (!msg) return;
      try {
        const response = await sendToWechatBot(msg);
        db.prepare("INSERT INTO send_logs (message_id, status, response) VALUES (?,?,?)")
          .run(msg.id, "success", JSON.stringify(response));
        console.log("[Cron] Sent:", msg.name);
      } catch (err) {
        db.prepare("INSERT INTO send_logs (message_id, status, response) VALUES (?,?,?)")
          .run(msg.id, "error", err.message);
        console.error("[Cron] Error:", err.message);
      }
    });
    cronJobs.set(schedule.id, job);
    console.log("[Cron] Registered #" + schedule.id + " " + schedule.cron_expression);
  } catch (err) {
    console.error("[Cron] Register error:", err.message);
  }
}
function unregisterSchedule(id) {
  const job = cronJobs.get(id);
  if (job) { job.stop(); cronJobs.delete(id); }
}
function restoreSchedules() {
  const schedules = db.prepare("SELECT * FROM schedules WHERE enabled=1").all();
  schedules.forEach(s => registerSchedule(s));
  console.log("[Cron] Restored " + schedules.length + " schedules");
}

app.listen(PORT, () => {
  console.log("Server: http://localhost:" + PORT);
  restoreSchedules();
});
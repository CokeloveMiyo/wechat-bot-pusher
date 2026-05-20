try { require("dotenv").config(); } catch (e) { console.warn("dotenv not loaded:", e.message); }
const express = require("express");
const Database = require("better-sqlite3");
const axios = require("axios");
const path = require("path");
const multer = require("multer");
const FormData = require("form-data");
const fs = require("fs");
const crypto = require("crypto");
const app = express();
const PORT = process.env.PORT || 3456;

const WEBHOOK_KEY = process.env.WEBHOOK_KEY || "";
const WEBHOOK_URL = WEBHOOK_KEY
  ? `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${WEBHOOK_KEY}`
  : "";
const IMAGE_HOST_TOKEN = process.env.IMAGE_HOST_TOKEN || "";
const API_TOKEN = process.env.API_TOKEN || "";

function authMiddleware(req, res, next) {
  if (!API_TOKEN) return next();
  const t = req.headers.authorization?.replace(/^Bearer\s+/i, "")
    || req.headers["x-api-token"] || req.query.token;
  if (t === API_TOKEN) return next();
  return res.status(401).json({ error: "Unauthorized" });
}

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
"  message_id INTEGER NOT NULL,",
"  scheduled_at TEXT NOT NULL,",
"  enabled INTEGER NOT NULL DEFAULT 1,",
"  sent INTEGER NOT NULL DEFAULT 0,",
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

try {
  const cols = db.prepare("PRAGMA table_info(schedules)").all().map(c => c.name);
  if (!cols.includes("scheduled_at")) db.exec("ALTER TABLE schedules ADD COLUMN scheduled_at TEXT");
  if (!cols.includes("sent")) db.exec("ALTER TABLE schedules ADD COLUMN sent INTEGER NOT NULL DEFAULT 0");
} catch (_) {}

try {
  const colInfo = db.prepare("PRAGMA table_info(schedules)").all();
  const hasCron = colInfo.find(c => c.name === "cron_expression" && c.notnull === 1);
  if (hasCron) {
    db.exec("BEGIN");
    db.exec(`
      CREATE TABLE schedules_v2 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id INTEGER NOT NULL,
        scheduled_at TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        sent INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
      )
    `);
    db.exec("INSERT INTO schedules_v2 (id,message_id,enabled,created_at,updated_at,scheduled_at,sent) SELECT id,message_id,enabled,created_at,updated_at,scheduled_at,sent FROM schedules");
    db.exec("DROP TABLE schedules");
    db.exec("ALTER TABLE schedules_v2 RENAME TO schedules");
    db.exec("COMMIT");
  }
} catch (_) {}

try {
  db.prepare(
    "UPDATE schedules SET scheduled_at = REPLACE(scheduled_at, 'T', ' ') " +
    "WHERE scheduled_at LIKE '%T%'"
  ).run();
} catch (_) {}

app.use(express.json({ limit: "50mb" }));
app.use("/api", authMiddleware);
const upload = multer({ dest: path.join(__dirname, "uploads"), limits: { fileSize: 10 * 1024 * 1024 } });
app.use(express.static(path.join(__dirname, "public")));

function toDbDatetime(date) {
  return date.toISOString().replace("T", " ").slice(0, 19);
}

async function sendToWechatBot(message) {
  if (!WEBHOOK_URL) throw new Error("WEBHOOK_KEY not configured");
  const c = JSON.parse(message.content);
  let p;
  const post = (payload) => axios.post(WEBHOOK_URL, payload, { headers: { "Content-Type": "application/json" }, timeout: 10000 });
  switch (message.msgtype) {
    case "text": p = { msgtype: "text", text: { content: c.text || "" } }; break;
    case "markdown": p = { msgtype: "markdown", markdown: { content: c.markdown || "" } }; break;
    case "image_text": {
      let b64 = c.base64 || "";
      let md5 = c.md5 || "";
      if (!b64 && c.url) {
        const resp = await axios.get(c.url, { responseType: "arraybuffer", timeout: 30000 });
        const buf = Buffer.from(resp.data);
        b64 = buf.toString("base64");
        md5 = crypto.createHash("md5").update(buf).digest("hex");
      }
      if (!b64) throw new Error("image_text requires base64 or image URL");
      const r1 = await post({ msgtype: "image", image: { base64: b64, md5 } });
      if (!c.text) return r1.data;
      const r2 = await post({ msgtype: "text", text: { content: c.text } });
      return { image_response: r1.data, text_response: r2.data };
    }
    default: throw new Error("Unsupported msgtype: " + message.msgtype);
  }
  const r = await post(p);
  return r.data;
}

function logSend(mid, st, resp) {
  db.prepare("INSERT INTO send_logs (message_id, status, response) VALUES (?,?,?)")
    .run(mid, st, typeof resp === "string" ? resp : JSON.stringify(resp));
}

app.get("/api/messages", (_, res) => {
  res.json(db.prepare("SELECT * FROM messages ORDER BY updated_at DESC").all());
});
app.get("/api/messages/:id", (req, res) => {
  const m = db.prepare("SELECT * FROM messages WHERE id = ?").get(req.params.id);
  if (!m) return res.status(404).json({ error: "Not found" });
  res.json(m);
});
app.post("/api/messages", (req, res) => {
  const { name, msgtype, content } = req.body;
  if (!name || !msgtype) return res.status(400).json({ error: "Name and type required" });
  if (!["text","markdown","image_text"].includes(msgtype))
    return res.status(400).json({ error: "Invalid msgtype" });
  const r = db.prepare("INSERT INTO messages (name, msgtype, content) VALUES (?, ?, ?)")
    .run(name, msgtype, JSON.stringify(content || {}));
  res.status(201).json(db.prepare("SELECT * FROM messages WHERE id = ?").get(r.lastInsertRowid));
});
app.put("/api/messages/:id", (req, res) => {
  const { name, msgtype, content } = req.body;
  if (!db.prepare("SELECT id FROM messages WHERE id=?").get(req.params.id))
    return res.status(404).json({ error: "Not found" });
  if (msgtype && !["text","markdown","image_text"].includes(msgtype))
    return res.status(400).json({ error: "Invalid msgtype" });
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

app.get("/api/schedules", (_, res) => {
  res.json(db.prepare("SELECT s.*, m.name as message_name FROM schedules s JOIN messages m ON s.message_id=m.id ORDER BY s.scheduled_at ASC").all());
});
app.get("/api/messages/:id/schedules", (req, res) => {
  res.json(db.prepare("SELECT * FROM schedules WHERE message_id=? ORDER BY scheduled_at ASC").all(req.params.id));
});
app.post("/api/messages/:id/schedules", (req, res) => {
  const { scheduled_at } = req.body;
  if (!scheduled_at) return res.status(400).json({ error: "scheduled_at is required" });
  const dt = new Date(scheduled_at);
  if (isNaN(dt.getTime())) return res.status(400).json({ error: "Invalid datetime" });
  if (dt <= new Date()) return res.status(400).json({ error: "Must be in the future" });
  if (!db.prepare("SELECT id FROM messages WHERE id=?").get(req.params.id))
    return res.status(404).json({ error: "Message not found" });
  const r = db.prepare("INSERT INTO schedules (message_id, scheduled_at) VALUES (?,?)")
    .run(req.params.id, toDbDatetime(dt));
  res.status(201).json(db.prepare("SELECT * FROM schedules WHERE id=?").get(r.lastInsertRowid));
});
app.put("/api/schedules/:id", (req, res) => {
  const { scheduled_at, enabled } = req.body;
  if (!db.prepare("SELECT id FROM schedules WHERE id=?").get(req.params.id))
    return res.status(404).json({ error: "Not found" });
  if (scheduled_at) {
    const dt = new Date(scheduled_at);
    if (isNaN(dt.getTime())) return res.status(400).json({ error: "Invalid datetime" });
    db.prepare("UPDATE schedules SET scheduled_at=?, sent=0, updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(toDbDatetime(dt), req.params.id);
  }
  if (enabled !== undefined)
    db.prepare("UPDATE schedules SET enabled=?, updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(enabled ? 1 : 0, req.params.id);
  res.json(db.prepare("SELECT * FROM schedules WHERE id=?").get(req.params.id));
});
app.delete("/api/schedules/:id", (req, res) => {
  if (!db.prepare("SELECT id FROM schedules WHERE id=?").get(req.params.id))
    return res.status(404).json({ error: "Not found" });
  db.prepare("DELETE FROM schedules WHERE id=?").run(req.params.id);
  res.json({ success: true });
});

app.post("/api/messages/:id/send", async (req, res) => {
  const m = db.prepare("SELECT * FROM messages WHERE id=?").get(req.params.id);
  if (!m) return res.status(404).json({ error: "Not found" });
  try {
    const r = await sendToWechatBot(m);
    if (m.msgtype === "image_text" && r && r.image_response && r.text_response) {
      logSend(m.id, "success", r.image_response);
      logSend(m.id, "success", r.text_response);
    } else {
      logSend(m.id, "success", r);
    }
    res.json({ success: true, response: r });
  } catch (e) {
    logSend(m.id, "error", e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});
app.get("/api/logs", (req, res) => {
  const lim = parseInt(req.query.limit) || 50;
  res.json(db.prepare("SELECT l.*, m.name as message_name FROM send_logs l LEFT JOIN messages m ON l.message_id=m.id ORDER BY l.sent_at DESC LIMIT ?").all(lim));
});

app.post("/api/upload", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const token = req.body.token || IMAGE_HOST_TOKEN;
  const fp = req.file.path;
  try {
    const form = new FormData();
    form.append("file", fs.createReadStream(fp), req.file.originalname);
    const result = await axios.post("https://7bu.top/api/v1", form, {
      headers: { ...form.getHeaders(), ...(token ? { Authorization: "Bearer " + token } : {}) },
      timeout: 30000
    });
    fs.unlink(fp, () => {});
    const url = result.data?.data?.links?.url || result.data?.url || "";
    res.json(url ? { success: true, url } : { success: false, error: result.data?.message || "Upload failed" });
  } catch (e) {
    fs.unlink(fp, () => {});
    res.status(500).json({ success: false, error: e.message });
  }
});

let pr = false;
function checkSchedules() {
  if (pr) return;
  pr = true;
  const sec = new Date().getSeconds();
  const ms = ((60 - sec) % 60) * 1000;
  setTimeout(async () => {
    try {
      const due = db.prepare(
        "SELECT s.* FROM schedules s JOIN messages m ON s.message_id=m.id " +
        "WHERE s.enabled=1 AND s.sent=0 AND " +
        "substr(REPLACE(s.scheduled_at, 'T', ' '), 1, 19) <= datetime('now')"
      ).all();
      for (const s of due) {
        const m = db.prepare("SELECT * FROM messages WHERE id=?").get(s.message_id);
        if (!m) continue;
        try {
          const r = await sendToWechatBot(m);
          if (m.msgtype === "image_text" && r && r.image_response && r.text_response) {
            logSend(m.id, "success", r.image_response);
            logSend(m.id, "success", r.text_response);
          } else {
            logSend(m.id, "success", r);
          }
          db.prepare("UPDATE schedules SET sent=1, enabled=0, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(s.id);
        } catch (e) { logSend(m.id, "error", e.message); }
      }
    } catch (_) {}
    pr = false;
    checkSchedules();
  }, ms);
}

app.listen(PORT, () => {
  console.log("Server: http://localhost:" + PORT);
  console.log("Webhook:", WEBHOOK_KEY ? "configured" : "NOT SET");
  console.log("ImgHost:", IMAGE_HOST_TOKEN ? "configured" : "NOT SET");
  console.log("Auth:", API_TOKEN ? "enabled" : "open");
  checkSchedules();
});

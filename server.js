const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const db = require("./src/db");
const { buildShortageMail, sendShortageEmail } = require("./src/mail");

function loadEnvFile() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] == null || process.env[key] === "") process.env[key] = value;
  }
}
loadEnvFile();

const PORT = Number(process.env.PORT) || 3000;

const attempts = new Map();

function tooManyAttempts(ip) {
  const now = Date.now();
  const recent = (attempts.get(ip) || []).filter((t) => now - t < 15 * 60 * 1000);
  attempts.set(ip, recent);
  return recent.length >= 8;
}

function markAttempt(ip) {
  const recent = attempts.get(ip) || [];
  recent.push(Date.now());
  attempts.set(ip, recent);
}

const app = express();
const production = process.env.NODE_ENV === "production";
if (production) app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});
app.use(express.json({ limit: "200kb" }));
app.use(
  session({
    name: "checklist.sid",
    secret: process.env.SESSION_SECRET || crypto.randomBytes(24).toString("hex"),
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: production,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  })
);

function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

app.get("/api/me", asyncRoute(async (req, res) => {
  res.json({ user: db.publicUser(await db.currentUser(req)) });
}));

app.post("/api/login", asyncRoute(async (req, res) => {
  const ip = req.ip || "local";
  if (tooManyAttempts(ip)) return res.status(429).json({ error: "locked" });
  const username = String(req.body.username || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const user = db.withoutId(await db.usersCol.findOne({ username }));
  if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
    markAttempt(ip);
    return res.status(401).json({ error: "bad_login" });
  }
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: "server" });
    req.session.userId = user.id;
    res.json({ user: db.publicUser(user) });
  });
}));

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("checklist.sid");
    res.json({ ok: true });
  });
});

app.get("/api/bootstrap", db.requireUser, asyncRoute(async (req, res) => {
  const settings = await db.getSettings();
  res.json({
    user: db.publicUser(req.user),
    items: await db.listItems(),
    stationName: settings.stationName,
    emailConfigured: await db.smtpReady(),
  });
}));

app.get("/api/checks", db.requireUser, asyncRoute(async (req, res) => {
  const query = {};
  if (req.user.role !== "admin") query.userId = req.user.id;
  if (typeof req.query.month === "string" && /^\d{4}-\d{2}$/.test(req.query.month)) {
    query.date = { $regex: `^${req.query.month}` };
  }
  if (typeof req.query.date === "string" && db.parseDate(req.query.date)) {
    query.date = req.query.date;
  }
  const list = await db.checksCol.find(query).sort({ updatedAt: -1 }).toArray();
  res.json(list.map((check) => db.presentCheck(db.withoutId(check), req.user)));
}));

app.post("/api/checks", db.requireUser, asyncRoute(async (req, res) => {
  const date = db.parseDate(req.body.date);
  const paramedicName = String(req.body.paramedicName || "").trim();
  const notes = String(req.body.notes || "").trim();
  if (!date || paramedicName.length < 2 || paramedicName.length > 80 || notes.length > 500) {
    return res.status(400).json({ error: "invalid" });
  }
  const built = db.buildLines(req.body, await db.listItems());
  if (built.error) return res.status(400).json({ error: built.error });

  const now = new Date().toISOString();
  const existing = db.withoutId(await db.checksCol.findOne({ userId: req.user.id, date }));
  const check = {
    id: existing ? existing.id : db.newId(),
    userId: req.user.id,
    username: req.user.username,
    userName: req.user.name,
    paramedicName,
    date,
    notes,
    lines: built.lines,
    shortages: built.shortages,
    email: { sent: false, skipped: false, reason: "pending", error: null, to: "" },
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now,
  };
  await db.checksCol.replaceOne({ id: check.id }, { ...check, _id: check.id }, { upsert: true });
  check.email = await sendShortageEmail(check);
  await db.checksCol.updateOne({ id: check.id }, { $set: { email: check.email } });
  res.json({ check: db.presentCheck(check, req.user) });
}));

app.delete("/api/checks/:id", db.requireAdmin, asyncRoute(async (req, res) => {
  const id = String(req.params.id || "").trim();
  let result = await db.checksCol.deleteOne({ $or: [{ id }, { _id: id }] });
  const date = db.parseDate(req.query.date);
  const userId = String(req.query.userId || "").trim();
  if (!result.deletedCount && date && userId) {
    result = await db.checksCol.deleteOne({ date, userId });
  }
  if (!result.deletedCount) return res.status(404).json({ error: "not_found" });
  res.json({ ok: true });
}));

app.post("/api/checks/:id/resend", db.requireAdmin, asyncRoute(async (req, res) => {
  const check = db.withoutId(await db.checksCol.findOne({ id: req.params.id }));
  if (!check) return res.status(404).json({ error: "not_found" });
  if (!check.shortages.length) return res.status(400).json({ error: "nothing_missing" });
  check.email = await sendShortageEmail(check);
  check.updatedAt = new Date().toISOString();
  await db.checksCol.replaceOne({ id: check.id }, { ...check, _id: check.id });
  res.json({ check: db.presentCheck(check, req.user) });
}));

app.put("/api/items", db.requireAdmin, asyncRoute(async (req, res) => {
  if (!Array.isArray(req.body.items) || !req.body.items.length || req.body.items.length > 500) {
    return res.status(400).json({ error: "invalid" });
  }
  const current = await db.listItems();
  const next = [];
  const seen = new Set();
  for (const incoming of req.body.items) {
    if (!incoming || typeof incoming !== "object") return res.status(400).json({ error: "invalid" });
    const nameAr = String(incoming.nameAr || "").trim();
    const nameEn = String(incoming.nameEn || "").trim();
    const primaryAr = (nameAr || nameEn).slice(0, 80);
    const primaryEn = (nameEn || nameAr).slice(0, 80);
    if (!primaryAr) return res.status(400).json({ error: "invalid" });
    const prev = current.find((item) => item.id === incoming.id);
    let id = prev ? prev.id : db.newId();
    if (seen.has(id)) id = db.newId();
    seen.add(id);
    const type = prev ? prev.type : incoming.type === "interval" ? "interval" : "qty";
    const item = {
      id,
      nameAr: primaryAr,
      nameEn: primaryEn,
      noteAr: String(incoming.noteAr || "").trim().slice(0, 80),
      type,
    };
    if (type === "qty") {
      const required = db.clampInt(incoming.required, 0, 9999);
      if (required === null) return res.status(400).json({ error: "invalid" });
      item.required = required;
    } else {
      const intervalHours = db.clampInt(incoming.intervalHours ?? (prev && prev.intervalHours) ?? 72, 1, 24 * 30);
      if (intervalHours === null) return res.status(400).json({ error: "invalid" });
      item.intervalHours = intervalHours;
      item.required = 1;
    }
    next.push(item);
  }
  await db.itemsCol.deleteMany({});
  await db.itemsCol.insertMany(next.map((item, index) => ({ ...item, _id: item.id, order: index })));
  res.json({ items: next });
}));

async function publicSettings() {
  const settings = await db.getSettings();
  const smtp = settings.smtp || {};
  return {
    stationName: settings.stationName,
    adminEmail: settings.adminEmail,
    smtp: {
      host: smtp.host || "",
      port: Number(smtp.port) || 587,
      secure: Boolean(smtp.secure),
      user: smtp.user || "",
      from: smtp.from || "",
      hasPassword: Boolean(smtp.pass),
    },
    gmailRelay: {
      url: (settings.gmailRelay && settings.gmailRelay.url) || "",
      hasSecret: Boolean(settings.gmailRelay && settings.gmailRelay.secret),
    },
    emailConfigured: await db.smtpReady(),
  };
}

function gmailLinkUrl(value) {
  const url = String(value || "").trim().slice(0, 300);
  if (!url) return "";
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "script.google.com") return null;
  if (!/\/macros\/s\/[^/]+\/exec$/.test(parsed.pathname)) return null;
  return `${parsed.origin}${parsed.pathname}`;
}

app.get("/api/settings", db.requireAdmin, asyncRoute(async (req, res) => {
  res.json(await publicSettings());
}));

app.put("/api/settings", db.requireAdmin, asyncRoute(async (req, res) => {
  const stationName = String(req.body.stationName || "").trim();
  const adminEmail = String(req.body.adminEmail || "").trim();
  const smtp = req.body.smtp || {};
  if (!stationName || stationName.length > 80) return res.status(400).json({ error: "invalid" });
  if (adminEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)) {
    return res.status(400).json({ error: "invalid" });
  }
  const port = db.clampInt(smtp.port, 1, 65535);
  if (port === null) return res.status(400).json({ error: "invalid" });
  const gmailUrl = gmailLinkUrl(req.body.gmailRelay && req.body.gmailRelay.url);
  if (gmailUrl === null) return res.status(400).json({ error: "invalid" });
  const current = await db.getSettings();
  const currentRelay = current.gmailRelay || {};
  const gmailSecret = req.body.gmailRelay && req.body.gmailRelay.secret
    ? String(req.body.gmailRelay.secret).slice(0, 200)
    : currentRelay.secret || "";
  if (gmailUrl && gmailSecret.length < 8) return res.status(400).json({ error: "invalid" });
  await db.settingsCol.updateOne(
    { _id: "app" },
    {
      $set: {
        stationName,
        adminEmail,
        gmailRelay: gmailUrl ? { url: gmailUrl, secret: gmailSecret } : { url: "", secret: "" },
        smtp: {
          host: String(smtp.host || "").trim().slice(0, 120),
          port,
          secure: Boolean(smtp.secure),
          user: String(smtp.user || "").trim().slice(0, 120),
          pass: smtp.pass ? String(smtp.pass).slice(0, 200) : (current.smtp && current.smtp.pass) || "",
          from: String(smtp.from || "").trim().slice(0, 120),
        },
      },
    },
    { upsert: true }
  );
  res.json(await publicSettings());
}));

app.post("/api/settings/test-email", db.requireAdmin, asyncRoute(async (req, res) => {
  if (!(await db.smtpReady())) return res.status(400).json({ error: "smtp_incomplete" });
  const probe = {
    date: new Date().toISOString().slice(0, 10),
    paramedicName: req.user.name || "Admin",
    notes: "",
    shortages: [
      {
        type: "qty",
        nameAr: "رسالة تجربة",
        nameEn: "Test message",
        required: 1,
        actual: 0,
        shortage: 1,
        intervalHours: 72,
      },
    ],
  };
  const result = await sendShortageEmail(probe);
  if (!result.sent) return res.status(502).json({ error: "email_failed", message: result.error || "" });
  res.json({ ok: true });
}));

app.get("/api/users", db.requireAdmin, asyncRoute(async (req, res) => {
  res.json((await db.listUsers()).map(db.publicUser));
}));

app.post("/api/users", db.requireAdmin, asyncRoute(async (req, res) => {
  const username = String(req.body.username || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const name = String(req.body.name || "").trim();
  const role = req.body.role === "admin" ? "admin" : "user";
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) return res.status(400).json({ error: "invalid" });
  if (password.length < 6 || password.length > 72) return res.status(400).json({ error: "weak_password" });
  if (!name || name.length > 80) return res.status(400).json({ error: "invalid" });
  if (await db.usersCol.findOne({ username })) return res.status(400).json({ error: "user_exists" });
  const user = { id: db.newId(), username, passwordHash: bcrypt.hashSync(password, 10), role, name };
  await db.usersCol.insertOne({ ...user, _id: user.id });
  res.json({ user: db.publicUser(user) });
}));

app.post("/api/users/:id/password", db.requireAdmin, asyncRoute(async (req, res) => {
  const user = await db.usersCol.findOne({ id: req.params.id });
  if (!user) return res.status(404).json({ error: "not_found" });
  const password = String(req.body.password || "");
  if (password.length < 6 || password.length > 72) return res.status(400).json({ error: "weak_password" });
  await db.usersCol.updateOne({ id: user.id }, { $set: { passwordHash: bcrypt.hashSync(password, 10) } });
  res.json({ ok: true });
}));

app.delete("/api/users/:id", db.requireAdmin, asyncRoute(async (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: "cannot_delete_self" });
  const user = await db.usersCol.findOne({ id: req.params.id });
  if (!user) return res.status(404).json({ error: "not_found" });
  const admins = await db.usersCol.countDocuments({ role: "admin" });
  if (user.role === "admin" && admins < 2) return res.status(400).json({ error: "last_admin" });
  await db.usersCol.deleteOne({ id: user.id });
  res.json({ ok: true });
}));

app.post("/api/me/password", db.requireUser, asyncRoute(async (req, res) => {
  const current = String(req.body.current || "");
  const next = String(req.body.next || "");
  const user = await db.usersCol.findOne({ id: req.user.id });
  if (!user || !bcrypt.compareSync(current, user.passwordHash)) {
    return res.status(400).json({ error: "wrong_password" });
  }
  if (next.length < 6 || next.length > 72) return res.status(400).json({ error: "weak_password" });
  await db.usersCol.updateOne({ id: user.id }, { $set: { passwordHash: bcrypt.hashSync(next, 10) } });
  res.json({ ok: true });
}));

app.use(express.static(path.join(__dirname, "public")));
app.use((req, res) => {
  if (req.path.startsWith("/api")) return res.status(404).json({ error: "not_found" });
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.use((err, req, res, next) => {
  const message = String(err && err.message || err).replace(/mongodb(\+srv)?:\/\/\S+/gi, "mongodb://***");
  console.error(message);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "server" });
});

if (require.main === module) {
  db.connectDb()
    .then(() => {
      const server = app.listen(PORT, () => {
        console.log(`Checklist running at http://localhost:${PORT}`);
      });
      server.on("error", (err) => {
        if (err.code === "EADDRINUSE") console.error(`Port ${PORT} is already in use.`);
        else console.error(String(err.message || err).replace(/mongodb(\+srv)?:\/\/\S+/gi, "mongodb://***"));
        process.exit(1);
      });
    })
    .catch((err) => {
      console.error(String(err.message || err).replace(/mongodb(\+srv)?:\/\/\S+/gi, "mongodb://***"));
      console.error("Set MONGODB_URI to your MongoDB connection string and start again.");
      process.exit(1);
    });
}

module.exports = { buildShortageMail };

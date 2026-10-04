const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { MongoClient } = require("mongodb");

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, "..", "data");
const DATA_FILE = path.join(DATA_DIR, "db.json");

let usersCol;
let itemsCol;
let checksCol;
let settingsCol;

const SEED_ITEMS = [
  { id: "gauze", nameAr: "شاش", nameEn: "Gauze", noteAr: "ع 40", type: "qty", required: 40 },
  { id: "bandage", nameAr: "Bondage", nameEn: "Bandage", noteAr: "S/M/L", type: "qty", required: 4 },
  { id: "binder", nameAr: "مشد", nameEn: "Support binder", noteAr: "S/M/L", type: "qty", required: 2 },
  { id: "burn", nameAr: "مرهم حرق", nameEn: "Burn ointment", noteAr: "ع 1", type: "qty", required: 1 },
  { id: "kash", nameAr: "مرهم كش", nameEn: "Ointment", noteAr: "ع 1", type: "qty", required: 2 },
  { id: "sofratulle", nameAr: "Sofratulle", nameEn: "Sofratulle dressing", noteAr: "tulle dressing", type: "qty", required: 12 },
  { id: "serum", nameAr: "مصل", nameEn: "Serum", noteAr: "saline / IV", type: "qty", required: 1 },
  { id: "betadine", nameAr: "بيتادين", nameEn: "Betadine", noteAr: "ع 1", type: "qty", required: 1 },
  { id: "wound-tape", nameAr: "تلزيق جرح", nameEn: "Wound plaster", noteAr: "", type: "qty", required: 5 },
  { id: "gauze-roll", nameAr: "رولو شاش", nameEn: "Gauze roll", noteAr: "ع 1", type: "qty", required: 10 },
  { id: "elz", nameAr: "إلز", nameEn: "Elastic adhesive", noteAr: "ع 6", type: "qty", required: 6 },
  { id: "hypo", nameAr: "تلزيق ضد الحساسية", nameEn: "Hypoallergenic plaster", noteAr: "", type: "qty", required: 1 },
  { id: "pressure", nameAr: "ضماد ضاغط", nameEn: "Pressure dressing", noteAr: "ع 12", type: "qty", required: 1 },
  { id: "ice", nameAr: "كيس ثلج", nameEn: "Ice pack", noteAr: "ع 4", type: "qty", required: 1 },
  { id: "cleanisept", nameAr: "CLEANISEPT", nameEn: "CLEANISEPT change", noteAr: "كل 72 ساعة", type: "interval", required: 1, intervalHours: 72 },
];

function freshDb() {
  return {
    users: [
      { id: "admin", username: "admin", passwordHash: bcrypt.hashSync("admin", 10), role: "admin", name: "المسؤول" },
      { id: "user", username: "user", passwordHash: bcrypt.hashSync("user", 10), role: "user", name: "المسعف" },
    ],
    settings: {
      stationName: "لمى بتم الدين",
      adminEmail: "",
      smtp: { host: "", port: 587, secure: false, user: "", pass: "", from: "" },
      gmailRelay: { url: "", secret: "" },
    },
    items: SEED_ITEMS,
    checks: [],
  };
}

function withoutId(doc) {
  if (!doc) return null;
  const copy = { ...doc };
  delete copy._id;
  return copy;
}

function publicItem(item) {
  const copy = withoutId(item);
  delete copy.order;
  return copy;
}

function readLegacyFile() {
  if (!fs.existsSync(DATA_FILE)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    if (!parsed || !Array.isArray(parsed.users) || !parsed.users.length) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function seedIfEmpty() {
  if (await usersCol.countDocuments()) return;
  const fresh = freshDb();
  const source = readLegacyFile() || fresh;
  const users = (source.users || fresh.users).map((user) => ({ ...user, _id: user.id }));
  const rawItems = Array.isArray(source.items) && source.items.length ? source.items : fresh.items;
  const items = rawItems.map((item, index) => {
    const next = { ...item, _id: item.id, order: index };
    if (!next.noteAr && next.noteEn) next.noteAr = String(next.noteEn);
    delete next.noteEn;
    return next;
  });
  const settings = source.settings || fresh.settings;
  await usersCol.insertMany(users);
  await itemsCol.insertMany(items);
  const checks = Array.isArray(source.checks) ? source.checks.filter((check) => check && check.id) : [];
  if (checks.length) await checksCol.insertMany(checks.map((check) => ({ ...check, _id: check.id })));
  await settingsCol.insertOne({
    _id: "app",
    stationName: settings.stationName || fresh.settings.stationName,
    adminEmail: settings.adminEmail || "",
    smtp: settings.smtp || fresh.settings.smtp,
  });
}

async function connectDb() {
  const uri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/sion-checklist";
  const client = new MongoClient(uri);
  await client.connect();
  const database = client.db();
  usersCol = database.collection("users");
  itemsCol = database.collection("items");
  checksCol = database.collection("checks");
  settingsCol = database.collection("settings");
  await usersCol.createIndex({ username: 1 }, { unique: true });
  await checksCol.createIndex({ userId: 1, date: 1 }, { unique: true });
  await seedIfEmpty();
}

async function listUsers() {
  return (await usersCol.find({}).toArray()).map(withoutId);
}

async function listItems() {
  return (await itemsCol.find({}).sort({ order: 1, _id: 1 }).toArray()).map(publicItem);
}

async function getSettings() {
  const doc = await settingsCol.findOne({ _id: "app" });
  if (!doc) return freshDb().settings;
  return {
    stationName: doc.stationName,
    adminEmail: doc.adminEmail || "",
    smtp: doc.smtp || freshDb().settings.smtp,
    gmailRelay: doc.gmailRelay || { url: "", secret: "" },
  };
}

function newId() {
  return crypto.randomBytes(8).toString("hex");
}

function publicUser(user) {
  if (!user) return null;
  return { id: user.id, username: user.username, role: user.role, name: user.name };
}

async function currentUser(req) {
  if (!req.session || !req.session.userId) return null;
  return withoutId(await usersCol.findOne({ id: req.session.userId }));
}

async function requireUser(req, res, next) {
  try {
    const user = await currentUser(req);
    if (!user) return res.status(401).json({ error: "forbidden" });
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

function requireAdmin(req, res, next) {
  requireUser(req, res, () => {
    if (req.user.role !== "admin") return res.status(403).json({ error: "forbidden" });
    next();
  });
}

function clampInt(value, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n)) return null;
  if (n < min || n > max) return null;
  return n;
}

function parseDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  if (y < 2020 || y > 2100) return null;
  return value;
}

function maskEmail(email) {
  const raw = String(email || "");
  const at = raw.indexOf("@");
  if (at < 1) return "";
  return `${raw.slice(0, 1)}***${raw.slice(at)}`;
}

function presentCheck(check, viewer) {
  const copy = JSON.parse(JSON.stringify(check));
  if (viewer.role !== "admin" && copy.email && copy.email.to) copy.email.to = maskEmail(copy.email.to);
  return copy;
}

async function smtpReady() {
  const settings = await getSettings();
  if (!settings.adminEmail) return false;
  const relay = settings.gmailRelay || {};
  if (relay.url && relay.secret) return true;
  const smtp = settings.smtp || {};
  return Boolean(smtp.host && smtp.user && smtp.pass);
}

function buildLines(body, items) {
  const counts = body.counts && typeof body.counts === "object" ? body.counts : null;
  if (!counts) return { error: "invalid" };

  let lastChange = null;
  if (body.cleaniseptLastChange) {
    const parsed = new Date(body.cleaniseptLastChange);
    if (Number.isNaN(parsed.getTime())) return { error: "invalid" };
    lastChange = parsed.toISOString();
  }

  const lines = [];
  for (const item of items) {
    if (item.type === "qty") {
      if (!Object.prototype.hasOwnProperty.call(counts, item.id)) return { error: "invalid" };
      const actual = clampInt(counts[item.id], 0, 99999);
      if (actual === null) return { error: "invalid" };
      const shortage = Math.max(0, item.required - actual);
      lines.push({
        itemId: item.id,
        nameAr: item.nameAr,
        nameEn: item.nameEn,
        noteAr: item.noteAr || "",
        type: "qty",
        required: item.required,
        actual,
        shortage,
      });
    } else {
      const hours = item.intervalHours || 72;
      const elapsed = lastChange ? (Date.now() - new Date(lastChange).getTime()) / 36e5 : Infinity;
      const overdue = !lastChange || elapsed > hours;
      lines.push({
        itemId: item.id,
        nameAr: item.nameAr,
        nameEn: item.nameEn,
        noteAr: item.noteAr || "",
        type: "interval",
        intervalHours: hours,
        lastChange,
        overdue,
        required: hours,
        actual: lastChange ? Math.floor(elapsed) : null,
        shortage: overdue ? 1 : 0,
      });
    }
  }
  return { lines, shortages: lines.filter((line) => line.shortage > 0) };
}

module.exports = {
  connectDb,
  listUsers,
  listItems,
  getSettings,
  newId,
  publicUser,
  withoutId,
  currentUser,
  requireUser,
  requireAdmin,
  clampInt,
  parseDate,
  presentCheck,
  smtpReady,
  buildLines,
  get usersCol() { return usersCol; },
  get itemsCol() { return itemsCol; },
  get checksCol() { return checksCol; },
  get settingsCol() { return settingsCol; },
};

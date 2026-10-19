require("dotenv").config();
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");
const Razorpay = require("razorpay");

const app = express();
const PORT = Number(process.env.PORT || 4000);
const JWT_SECRET = process.env.JWT_SECRET || "";

if (process.env.NODE_ENV === "production" && JWT_SECRET.length < 32) {
  throw new Error("Set a strong JWT_SECRET (32+ characters) in production.");
}
const secret = JWT_SECRET || "local-development-only-change-this-secret";

const uploadDir = path.resolve(process.env.UPLOAD_DIR || "./uploads");
const dbPath = path.resolve(process.env.DATABASE_FILE || "./data/printnest.sqlite");
fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

app.use(helmet());
app.use(
  cors({
    origin: (process.env.FRONTEND_ORIGIN || "http://localhost:5173")
      .split(",")
      .map((s) => s.trim()),
    credentials: false,
  })
);
app.use(express.json({ limit: "1mb" }));
app.use(
  "/api",
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 300,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// Database Setup
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'customer',
    shop_name TEXT,
    plan TEXT NOT NULL DEFAULT 'free',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    shop_id INTEGER,
    product TEXT NOT NULL,
    size TEXT,
    quantity INTEGER NOT NULL,
    color_mode TEXT NOT NULL DEFAULT 'color',
    sides TEXT NOT NULL DEFAULT 'single',
    notes TEXT,
    file_name TEXT,
    stored_file TEXT,
    total_paise INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'received',
    payment_status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    order_id TEXT,
    provider_order_id TEXT,
    provider_payment_id TEXT,
    amount_paise INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'INR',
    status TEXT NOT NULL DEFAULT 'created',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    plan TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    provider_subscription_id TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

// Helpers & Middleware
const plans = [
  { id: "starter", name: "Starter", priceINR: 199, interval: "month", features: ["Shop profile", "Basic order management", "Up to 50 orders/month"] },
  { id: "growth", name: "Growth", priceINR: 499, interval: "month", features: ["All Starter features", "Order status updates", "Up to 300 orders/month"] },
  { id: "pro", name: "Pro", priceINR: 999, interval: "month", features: ["All Growth features", "Team access", "Reports and customer history"] },
  { id: "business", name: "Business", priceINR: 2499, interval: "month", features: ["Multi-branch workflow", "Priority support", "Higher usage limits"] }
];

function signToken(user) {
  return jwt.sign({ sub: user.id, role: user.role }, secret, { expiresIn: "7d" });
}

function safeUser(user) {
  return { id: user.id, name: user.name, email: user.email, role: user.role, shopName: user.shop_name, plan: user.plan };
}

function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return res.status(401).json({ error: "Sign in to continue." });
  try {
    const payload = jwt.verify(token, secret);
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(payload.sub);
    if (!user) return res.status(401).json({ error: "Account not found." });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: "Session expired or invalid. Please sign in again." });
  }
}

function admin(req, res, next) {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Admin access required." });
  next();
}

function priceOrder({ product, quantity, color_mode, sides }) {
  const rates = { document: 2, flyer: 5, poster: 20, business_card: 1.5, photo: 12, other: 5 };
  const base = rates[product] || rates.other;
  const color = color_mode === "bw" ? 0.55 : 1;
  const double = sides === "double" ? 1.65 : 1;
  return Math.max(100, Math.round(base * color * double * quantity * 100));
}

function getRazorpay() {
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) return null;
  return new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
}

// Multer Upload
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => cb(null, crypto.randomUUID() + path.extname(file.originalname).toLowerCase()),
});
const allowedExt = new Set([".pdf", ".jpg", ".jpeg", ".png", ".doc", ".docx"]);
const upload = multer({
  storage,
  limits: { fileSize: Number(process.env.MAX_UPLOAD_MB || 25) * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!allowedExt.has(ext)) return cb(new Error("Unsupported file type. Upload PDF, JPG, PNG, DOC or DOCX."));
    cb(null, true);
  },
});

// API Routes
app.get("/api/health", (_req, res) => res.json({ ok: true, service: "PrintNest API", time: new Date().toISOString() }));
app.get("/api/plans", (_req, res) => res.json({ plans }));

app.get("/api/pricing/estimate", (req, res) => {
  const product = String(req.query.product || "document");
  const quantity = Math.max(1, Math.min(100000, Number.parseInt(req.query.quantity || "1", 10) || 1));
  const color_mode = req.query.color_mode === "bw" ? "bw" : "color";
  const sides = req.query.sides === "double" ? "double" : "single";
  const totalPaise = priceOrder({ product, quantity, color_mode, sides });
  res.json({ currency: "INR", totalPaise, totalINR: (totalPaise / 100).toFixed(2), assumptions: "Starter rates" });
});

app.post("/api/auth/register", async (req, res) => {
  const { name, email, password, accountType, shopName } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: "Name, email and password are required." });
  if (String(password).length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });
  const normalizedEmail = String(email).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) return res.status(400).json({ error: "Enter a valid email address." });

  try {
    const hash = await bcrypt.hash(String(password), 12);
    const role = accountType === "merchant" ? "merchant" : "customer";
    const info = db.prepare("INSERT INTO users (name,email,password_hash,role,shop_name) VALUES (?,?,?,?,?)")
      .run(String(name).trim(), normalizedEmail, hash, role, shopName ? String(shopName).trim() : null);
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(info.lastInsertRowid);
    return res.status(201).json({ token: signToken(user), user: safeUser(user) });
  } catch (e) {
    if (String(e.code || "").includes("SQLITE_CONSTRAINT")) return res.status(409).json({ error: "An account with this email already exists." });
    return res.status(500).json({ error: "Could not create account." });
  }
});

app.post("/api/auth/login", async (req, res) => {
  const email = String((req.body || {}).email || "").trim().toLowerCase();
  const password = String((req.body || {}).password || "");
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  if (!user || !(await bcrypt.compare(password, user.password_hash))) return res.status(401).json({ error: "Email or password is incorrect." });
  res.json({ token: signToken(user), user: safeUser(user) });
});

app.get("/api/auth/me", auth, (req, res) => res.json({ user: safeUser(req.user) }));

app.post("/api/orders", auth, upload.single("file"), (req, res) => {
  const body = req.body || {};
  const product = String(body.product || "document");
  const quantity = Math.max(1, Math.min(100000, Number.parseInt(body.quantity || "1", 10) || 1));
  const color_mode = body.color_mode === "bw" ? "bw" : "color";
  const sides = body.sides === "double" ? "double" : "single";
  const totalPaise = priceOrder({ product, quantity, color_mode, sides });
  const id = "PN-" + crypto.randomBytes(5).toString("hex").toUpperCase();

  db.prepare(`INSERT INTO orders (id,user_id,product,size,quantity,color_mode,sides,notes,file_name,stored_file,total_paise) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, req.user.id, product, body.size || null, quantity, color_mode, sides, body.notes ? String(body.notes).slice(0, 2000) : null, req.file ? req.file.originalname.slice(0, 255) : null, req.file ? req.file.filename : null, totalPaise);

  const order = db.prepare("SELECT id,product,size,quantity,color_mode,sides,notes,file_name,total_paise,status,payment_status,created_at FROM orders WHERE id=?").get(id);
  res.status(201).json({ order: { ...order, totalINR: (order.total_paise / 100).toFixed(2) } });
});

app.get("/api/orders", auth, (req, res) => {
  const rows = req.user.role === "admin"
    ? db.prepare(`SELECT o.id,o.product,o.quantity,o.total_paise,o.status,o.payment_status,o.created_at,u.name AS customer_name,u.email AS customer_email FROM orders o JOIN users u ON u.id=o.user_id ORDER BY o.created_at DESC LIMIT 500`).all()
    : db.prepare("SELECT id,product,quantity,total_paise,status,payment_status,created_at FROM orders WHERE user_id=? ORDER BY created_at DESC LIMIT 200").all(req.user.id);
  res.json({ orders: rows.map((o) => ({ ...o, totalINR: (o.total_paise / 100).toFixed(2) })) });
});

app.patch("/api/orders/:id/status", auth, (req, res) => {
  if (!["admin", "merchant"].includes(req.user.role)) return res.status(403).json({ error: "Merchant or admin access required." });
  const allowed = new Set(["received", "design_check", "printing", "ready", "dispatched", "cancelled"]);
  const status = String((req.body || {}).status || "");
  if (!allowed.has(status)) return res.status(400).json({ error: "Invalid order status." });
  const result = db.prepare("UPDATE orders SET status=? WHERE id=?").run(status, req.params.id);
  if (!result.changes) return res.status(404).json({ error: "Order not found." });
  res.json({ ok: true, id: req.params.id, status });
});

app.post("/api/payments/create-order", auth, async (req, res) => {
  const orderId = String((req.body || {}).orderId || "");
  const order = db.prepare("SELECT * FROM orders WHERE id=? AND user_id=?").get(orderId, req.user.id);
  if (!order) return res.status(404).json({ error: "Order not found." });
  const razorpay = getRazorpay();
  if (!razorpay) return res.status(503).json({ error: "Payment gateway is not configured yet. Add Razorpay test keys to .env." });

  try {
    const rpOrder = await razorpay.orders.create({ amount: order.total_paise, currency: "INR", receipt: order.id, notes: { printnest_order_id: order.id } });
    db.prepare("INSERT INTO payments (user_id,order_id,provider_order_id,amount_paise,status) VALUES (?,?,?,?,?)").run(req.user.id, order.id, rpOrder.id, order.total_paise, "created");
    res.json({ keyId: process.env.RAZORPAY_KEY_ID, razorpayOrder: rpOrder, amountPaise: order.total_paise, currency: "INR" });
  } catch {
    res.status(502).json({ error: "Payment provider could not create an order." });
  }
});

app.post("/api/payments/verify", auth, (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
  if (!process.env.RAZORPAY_KEY_SECRET) return res.status(503).json({ error: "Payment gateway is not configured." });
  const payment = db.prepare("SELECT * FROM payments WHERE provider_order_id=? AND user_id=?").get(razorpay_order_id, req.user.id);
  if (!payment || !razorpay_payment_id || !razorpay_signature) return res.status(400).json({ error: "Payment details are incomplete." });

  const expected = crypto.createHmac("sha256", process.env.RAZORPAY_KEY_SECRET).update(razorpay_order_id + "|" + razorpay_payment_id).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(String(razorpay_signature));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(400).json({ error: "Payment signature verification failed." });

  db.prepare("UPDATE payments SET provider_payment_id=?,status='paid' WHERE id=?").run(razorpay_payment_id, payment.id);
  if (payment.order_id) db.prepare("UPDATE orders SET payment_status='paid' WHERE id=?").run(payment.order_id);
  res.json({ ok: true, status: "paid" });
});

app.post("/api/payments/webhook", express.raw({ type: "application/json" }), (req, res) => {
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!webhookSecret) return res.status(503).send("Webhook not configured");
  const signature = req.headers["x-razorpay-signature"];
  const expected = crypto.createHmac("sha256", webhookSecret).update(req.body).digest("hex");
  if (!signature || signature !== expected) return res.status(400).send("Invalid signature");

  let event;
  try {
    event = JSON.parse(req.body.toString("utf8"));
  } catch {
    return res.status(400).send("Invalid JSON");
  }

  if (event.event === "payment.captured") {
    const entity = event.payload && event.payload.payment && event.payload.payment.entity;
    if (entity) {
      db.prepare("UPDATE payments SET provider_payment_id=?,status='paid' WHERE provider_order_id=?").run(entity.id, entity.order_id);
      db.prepare("UPDATE orders SET payment_status='paid' WHERE id=(SELECT order_id FROM payments WHERE provider_order_id=?)").run(entity.order_id);
    }
  }
  res.json({ received: true });
});

app.get("/api/admin/summary", auth, admin, (_req, res) => {
  const users = db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
  const orders = db.prepare("SELECT COUNT(*) AS n FROM orders").get().n;
  const pending = db.prepare("SELECT COUNT(*) AS n FROM orders WHERE status NOT IN ('ready','dispatched','cancelled')").get().n;
  const paidPaise = db.prepare("SELECT COALESCE(SUM(amount_paise),0) AS n FROM payments WHERE status='paid'").get().n;
  res.json({ users, orders, pendingOrders: pending, paidINR: (paidPaise / 100).toFixed(2) });
});

app.get("/api/admin/users", auth, admin, (_req, res) => {
  const users = db.prepare("SELECT id,name,email,role,shop_name,plan,created_at FROM users ORDER BY created_at DESC LIMIT 500").all();
  res.json({ users });
});

// Static frontend serving (Optional agar backend se frontend serve karna ho)
const publicDir = path.join(__dirname, "public");
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
  app.get("*", (req, res) => {
    res.sendFile(path.join(publicDir, "index.html"));
  });
} else {
  app.get("/", (req, res) => {
    res.status(200).send("Printnest backend is running successfully!");
  });
}

// Error handling middleware
app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.code === "LIMIT_FILE_SIZE" ? "File is too large." : "Upload failed." });
  }
  if (err) return res.status(400).json({ error: err.message || "Request failed." });
  res.status(500).json({ error: "Unexpected server error." });
});

// Server Listen
app.listen(PORT, () => console.log(`PrintNest API listening on http://localhost:${PORT}`));

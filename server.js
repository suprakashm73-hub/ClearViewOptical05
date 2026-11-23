require("dotenv").config();
const express = require("express"), bcrypt = require("bcryptjs");
const { DatabaseSync } = require("node:sqlite"); // built into Node, nothing extra to install
const jwt = require("jsonwebtoken"), cookieParser = require("cookie-parser"), rateLimit = require("express-rate-limit");
const path = require("path"), crypto = require("crypto");

const PORT = process.env.PORT || 3000, PROD = process.env.NODE_ENV === "production";
let SECRET = process.env.JWT_SECRET;
if (!SECRET || SECRET.startsWith("change-this")) {
  SECRET = crypto.randomBytes(32).toString("hex");
  console.warn("JWT_SECRET is not set in .env: everyone is logged out whenever the server restarts.");
}

// ---------- Database ----------
const db = new DatabaseSync(process.env.DB_FILE || path.join(__dirname, "shop.db"));
db.exec("PRAGMA journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, mobile TEXT UNIQUE NOT NULL, name TEXT NOT NULL, hash TEXT NOT NULL, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY, name TEXT NOT NULL, cat TEXT NOT NULL, price INTEGER NOT NULL, stock INTEGER NOT NULL, shape TEXT NOT NULL, color TEXT NOT NULL, descr TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, name TEXT NOT NULL, address TEXT NOT NULL, items TEXT NOT NULL, total INTEGER NOT NULL, payment TEXT NOT NULL, txn TEXT, status TEXT NOT NULL DEFAULT 'Placed', created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT NOT NULL);
`);
const pcols = db.prepare("PRAGMA table_info(products)").all().map(c => c.name);
if (!pcols.includes("image")) db.exec("ALTER TABLE products ADD COLUMN image TEXT NOT NULL DEFAULT ''");
if (!pcols.includes("colors")) db.exec("ALTER TABLE products ADD COLUMN colors TEXT NOT NULL DEFAULT ''"); // colour choices of one model, JSON
db.exec(`CREATE TABLE IF NOT EXISTS reviews(id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL, user_id INTEGER NOT NULL, name TEXT NOT NULL, rating INTEGER NOT NULL, text TEXT NOT NULL DEFAULT '', image TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL, UNIQUE(product_id, user_id))`);
const get = k => { const r = db.prepare("SELECT v FROM settings WHERE k=?").get(k); return r ? r.v : ""; };
const put = (k, v) => db.prepare("INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(k, v);

if (!db.prepare("SELECT COUNT(*) c FROM products").get().c) {
  const ins = db.prepare("INSERT INTO products(name,cat,price,stock,shape,color,descr) VALUES(?,?,?,?,?,?,?)");
  [["Aria Round","Eyeglasses",1499,25,"round","#b45309","Lightweight acetate, anti-glare lenses"],
   ["Urban Rect","Eyeglasses",1299,30,"rect","#1e3a8a","Everyday office frame, flexible hinges"],
   ["Nova Cat-Eye","Eyeglasses",1799,12,"cat","#9d174d","Bold cat-eye for a statement look"],
   ["Sky Aviator","Sunglasses",1999,18,"avi","#a16207","UV400 polarised, metal frame"],
   ["Shade Round","Sunglasses",1599,20,"round","#111827","Retro round, scratch-resistant"],
   ["BlueGuard Pro","Computer",999,40,"rect","#0f766e","Blue-light filter for long screen hours"],
   ["ScreenSafe Round","Computer",1099,35,"round","#4338ca","Reduces eye strain, lightweight"],
   ["Little Champ","Kids",899,22,"round","#dc2626","Flexible, unbreakable frame for kids"]].forEach(p => ins.run(...p));
}
if (!get("admin_hash")) {
  const u = process.env.ADMIN_USER || "admin";
  let pw = process.env.ADMIN_PASSWORD;
  if (!pw) { pw = crypto.randomBytes(6).toString("base64url"); console.log(`\n*** First run: admin username "${u}", password "${pw}" (change it in Admin > Settings) ***\n`); }
  put("admin_user", u); put("admin_hash", bcrypt.hashSync(pw, 10));
}

// ---------- Helpers ----------
class UserError extends Error {}
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const setTok = (res, p) => res.cookie("tok", jwt.sign(p, SECRET, { expiresIn: "7d" }), { httpOnly: true, sameSite: "lax", secure: PROD, maxAge: 7 * 864e5 });
const need = role => (req, res, next) => (req.u && req.u.role === role ? next() : bad(res, "Please login first", 401));
const CATS = ["Eyeglasses", "Sunglasses", "Computer", "Kids"], SHAPES = ["round", "rect", "cat", "avi"];
const STATUS = ["Placed", "Packed", "Shipped", "Delivered", "Cancelled"];
const loginLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, message: { error: "Too many attempts. Try again in 15 minutes." } });
const HEX = /^#[0-9a-f]{6}$/i;
const parseColors = p => { try { const a = JSON.parse(p.colors || "[]"); if (Array.isArray(a) && a.length) return a; } catch (e) {} return [{ n: "Standard", h: p.color }]; };
const cleanColors = a => { // null = invalid
  if (a === undefined) return [];
  if (!Array.isArray(a) || a.length > 8) return null;
  const out = [];
  for (const c of a) { const n = str(c && c.n, 30), h = c && c.h; if (!n || !HEX.test(h || "") || out.some(x => x.n.toLowerCase() === n.toLowerCase())) return null; out.push({ n, h }); }
  return out;
};
const prodBody = b => {
  const name = str(b.name, 80), price = Math.round(+b.price), stock = Math.max(0, Math.floor(+b.stock || 0)), cs = cleanColors(b.colors);
  const color = cs && cs.length ? cs[0].h : b.color;
  if (!name || !(price > 0) || price > 1e7 || !CATS.includes(b.cat) || !SHAPES.includes(b.shape) || !HEX.test(color || "") || cs === null) return null;
  return [name, b.cat, price, stock, b.shape, color, str(b.desc, 200), cs.length ? JSON.stringify(cs) : ""];
};
const sendImg = (res, d) => { const [h, b] = d.split(","); res.type(h.slice(5, h.indexOf(";"))).set("Cache-Control", "public, max-age=300").send(Buffer.from(b, "base64")); };
const getSupport = () => { try { const a = JSON.parse(get("support") || "[]"); return Array.isArray(a) ? a : []; } catch (e) { return []; } };
const reviewLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false, message: { error: "Too many attempts. Try again later." } });
const delivered = (uid, p) => db.prepare("SELECT items FROM orders WHERE user_id=? AND status='Delivered'").all(uid).some(o => JSON.parse(o.items).some(i => i.id === p.id || i.n === p.name));
const revImg = "CASE WHEN image<>'' THEN '/api/reviews/'||id||'/image?v='||length(image) ELSE '' END";
const orderOut = o => ({ ...o, items: JSON.parse(o.items) });
const IMG_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
// undefined = keep current photo, "" = remove photo, data URL = new photo, null = invalid
const imgVal = b => b.image === undefined ? undefined : b.image === "" ? "" : (typeof b.image === "string" && b.image.length <= 300000 && IMG_RE.test(b.image) ? b.image : null);

// ---------- App ----------
const app = express();
if (PROD) app.set("trust proxy", 1);
app.use((req, res, next) => { res.set({ "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "same-origin" }); next(); });
app.use(express.json({ limit: "400kb" }), cookieParser());
app.use((req, res, next) => { try { req.u = jwt.verify(req.cookies.tok, SECRET); } catch (e) { req.u = null; } next(); });

app.get("/api/me", (req, res) => res.json(req.u ? { role: req.u.role, name: req.u.name, mobile: req.u.mobile } : {}));
app.post("/api/logout", (req, res) => { res.clearCookie("tok"); res.json({ ok: true }); });

app.post("/api/signup", loginLimit, (req, res) => {
  const m = str(req.body.mobile, 20), name = str(req.body.name, 60) || "Customer", pw = typeof req.body.password === "string" ? req.body.password : "";
  if (!/^[6-9]\d{9}$/.test(m)) return bad(res, "Enter a valid 10-digit mobile number");
  if (pw.length < 6 || pw.length > 100) return bad(res, "Password needs at least 6 characters");
  if (db.prepare("SELECT 1 FROM users WHERE mobile=?").get(m)) return bad(res, "This number is already registered – please login");
  const r = db.prepare("INSERT INTO users(mobile,name,hash,created) VALUES(?,?,?,?)").run(m, name, bcrypt.hashSync(pw, 10), Date.now());
  const u = { role: "user", id: Number(r.lastInsertRowid), name, mobile: m };
  setTok(res, u); res.json({ role: "user", name, mobile: m });
});
app.post("/api/login", loginLimit, (req, res) => {
  const row = db.prepare("SELECT * FROM users WHERE mobile=?").get(str(req.body.mobile, 20));
  const pw = typeof req.body.password === "string" ? req.body.password : "";
  if (!row || !bcrypt.compareSync(pw, row.hash)) return bad(res, "Wrong mobile number or password", 401);
  setTok(res, { role: "user", id: row.id, name: row.name, mobile: row.mobile }); res.json({ role: "user", name: row.name, mobile: row.mobile });
});
app.post("/api/admin/login", loginLimit, (req, res) => {
  const pw = typeof req.body.password === "string" ? req.body.password : "";
  if (str(req.body.username, 60) !== get("admin_user") || !bcrypt.compareSync(pw, get("admin_hash"))) return bad(res, "Wrong username or password", 401);
  setTok(res, { role: "admin", name: "Admin" }); res.json({ role: "admin", name: "Admin" });
});

app.get("/api/products", (req, res) => res.json(db.prepare(`SELECT id,name,cat,price,stock,shape,color,colors,descr AS "desc",
  CASE WHEN image<>'' THEN '/api/products/'||id||'/image?v='||length(image) ELSE '' END AS img,
  (SELECT ROUND(AVG(rating),1) FROM reviews WHERE product_id=products.id) AS rating,
  (SELECT COUNT(*) FROM reviews WHERE product_id=products.id) AS rc FROM products ORDER BY id`).all().map(r => ({ ...r, colors: parseColors(r) }))));
app.get("/api/products/:id/image", (req, res) => {
  const r = db.prepare("SELECT image FROM products WHERE id=?").get(+req.params.id);
  if (!r || !r.image) return res.status(404).end();
  const [h, d] = r.image.split(",");
  res.type(h.slice(5, h.indexOf(";"))).set("Cache-Control", "public, max-age=300").send(Buffer.from(d, "base64"));
});
app.get("/api/settings", (req, res) => res.json({ upi: get("upi"), qr: get("qr") ? "/api/qr?v=" + (get("qr_v") || "1") : "", support: getSupport() }));
app.get("/api/qr", (req, res) => { const q = get("qr"); if (!q) return res.status(404).end(); sendImg(res, q); });

// ---------- Reviews ----------
app.get("/api/products/:id/reviews", (req, res) => {
  const p = db.prepare("SELECT id,name FROM products WHERE id=?").get(+req.params.id);
  if (!p) return bad(res, "Not found", 404);
  const rows = db.prepare(`SELECT id,user_id,name,rating,text,created,${revImg} AS img FROM reviews WHERE product_id=? ORDER BY created DESC LIMIT 100`).all(p.id);
  const uid = req.u && req.u.role === "user" ? req.u.id : 0, mine = rows.find(r => r.user_id === uid);
  res.json({ reviews: rows.map(({ user_id, ...r }) => ({ ...r, name: r.name.split(" ")[0] })), canReview: !!uid && delivered(uid, p), mine: mine ? { rating: mine.rating, text: mine.text, img: mine.img } : null });
});
app.get("/api/reviews/:id/image", (req, res) => {
  const r = db.prepare("SELECT image FROM reviews WHERE id=?").get(+req.params.id);
  if (!r || !r.image) return res.status(404).end();
  sendImg(res, r.image);
});
app.post("/api/products/:id/reviews", need("user"), reviewLimit, (req, res) => {
  const p = db.prepare("SELECT id,name FROM products WHERE id=?").get(+req.params.id);
  if (!p) return bad(res, "Product not found", 404);
  if (!delivered(req.u.id, p)) return bad(res, "You can review a product after your order has been delivered", 403);
  const rating = Math.floor(+req.body.rating), text = str(req.body.text, 500), img = imgVal(req.body);
  if (!(rating >= 1 && rating <= 5)) return bad(res, "Please choose a rating from 1 to 5");
  if (img === null) return bad(res, "Photo must be a PNG, JPG or WebP image under 200 KB");
  const old = db.prepare("SELECT id FROM reviews WHERE product_id=? AND user_id=?").get(p.id, req.u.id);
  if (old) {
    db.prepare("UPDATE reviews SET rating=?,text=?,created=? WHERE id=?").run(rating, text, Date.now(), old.id);
    if (img !== undefined) db.prepare("UPDATE reviews SET image=? WHERE id=?").run(img, old.id);
  } else db.prepare("INSERT INTO reviews(product_id,user_id,name,rating,text,image,created) VALUES(?,?,?,?,?,?,?)").run(p.id, req.u.id, req.u.name, rating, text, img || "", Date.now());
  res.json({ ok: true });
});
app.delete("/api/products/:id/reviews", need("user"), (req, res) => { db.prepare("DELETE FROM reviews WHERE product_id=? AND user_id=?").run(+req.params.id, req.u.id); res.json({ ok: true }); });

const place = (u, b, items) => { db.exec("BEGIN IMMEDIATE"); try {
  let total = 0; const lines = [];
  for (const it of items) {
    const p = db.prepare("SELECT * FROM products WHERE id=?").get(+it.id), q = Math.floor(+it.q);
    if (!p || !(q > 0) || p.stock < q) throw new UserError((p ? p.name : "An item") + " is not available in that quantity");
    const cols = parseColors(p), col = it.c === undefined || it.c === "" ? cols[0] : cols.find(x => x.n === str(it.c, 30));
    if (!col) throw new UserError(p.name + ": please choose an available colour");
    total += p.price * q; lines.push({ id: p.id, n: p.name, q, p: p.price, c: col.n });
    db.prepare("UPDATE products SET stock=stock-? WHERE id=?").run(q, p.id);
  }
  const id = "CV" + Date.now().toString().slice(-7) + crypto.randomInt(10, 99);
  db.prepare("INSERT INTO orders(id,user_id,name,address,items,total,payment,txn,status,created) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run(id, u.id, b.name, b.address, JSON.stringify(lines), total, b.payment, b.txn, "Placed", Date.now());
  db.exec("COMMIT"); return id;
} catch (e) { db.exec("ROLLBACK"); throw e; } };
app.post("/api/orders", need("user"), (req, res) => {
  const b = req.body, name = str(b.name, 80), address = str(b.address, 300) + " – " + str(b.pin, 6);
  const online = b.payment === "Online" || b.payment === "QR", payment = b.payment === "COD" ? "Cash on delivery" : online ? "Online payment (QR / UPI)" : null;
  if (!name || str(b.address, 300).length < 8 || !/^\d{6}$/.test(str(b.pin, 6)) || !payment) return bad(res, "Please fill in name, full address, PIN code and payment method");
  if (!Array.isArray(b.items) || !b.items.length || b.items.length > 50) return bad(res, "Your cart is empty");
  if (online) {
    if (!get("qr")) return bad(res, "Online payment is not available right now. Please choose Cash on delivery.");
    if (str(b.txn, 40).length < 6) return bad(res, "Enter the UPI transaction ID after paying");
  }
  try { res.json({ id: place(req.u, { name, address, payment, txn: str(b.txn, 40) }, b.items) }); }
  catch (e) { if (e instanceof UserError) return bad(res, e.message); throw e; }
});
app.get("/api/orders/mine", need("user"), (req, res) =>
  res.json(db.prepare("SELECT * FROM orders WHERE user_id=? ORDER BY created DESC").all(req.u.id).map(orderOut)));

// ---------- Admin ----------
app.get("/api/admin/stats", need("admin"), (req, res) => res.json({
  products: db.prepare("SELECT COUNT(*) c FROM products").get().c,
  orders: db.prepare("SELECT COUNT(*) c FROM orders").get().c,
  customers: db.prepare("SELECT COUNT(*) c FROM users").get().c,
  sales: db.prepare("SELECT COALESCE(SUM(total),0) s FROM orders WHERE status<>'Cancelled'").get().s }));
app.post("/api/admin/products", need("admin"), (req, res) => {
  const v = prodBody(req.body); if (!v) return bad(res, "Please check the product details");
  const img = imgVal(req.body); if (img === null) return bad(res, "Photo must be a PNG, JPG or WebP image under 200 KB");
  db.prepare("INSERT INTO products(name,cat,price,stock,shape,color,descr,colors,image) VALUES(?,?,?,?,?,?,?,?,?)").run(...v, img || ""); res.json({ ok: true });
});
app.put("/api/admin/products/:id", need("admin"), (req, res) => {
  const v = prodBody(req.body); if (!v) return bad(res, "Please check the product details");
  const img = imgVal(req.body); if (img === null) return bad(res, "Photo must be a PNG, JPG or WebP image under 200 KB");
  db.prepare("UPDATE products SET name=?,cat=?,price=?,stock=?,shape=?,color=?,descr=?,colors=? WHERE id=?").run(...v, +req.params.id);
  if (img !== undefined) db.prepare("UPDATE products SET image=? WHERE id=?").run(img, +req.params.id);
  res.json({ ok: true });
});
app.delete("/api/admin/products/:id", need("admin"), (req, res) => {
  db.prepare("DELETE FROM reviews WHERE product_id=?").run(+req.params.id);
  db.prepare("DELETE FROM products WHERE id=?").run(+req.params.id); res.json({ ok: true });
});
app.get("/api/admin/reviews", need("admin"), (req, res) => res.json(db.prepare(`SELECT r.id,r.rating,r.text,r.name,r.created,p.name AS product,u.mobile,
  CASE WHEN r.image<>'' THEN '/api/reviews/'||r.id||'/image?v='||length(r.image) ELSE '' END AS img
  FROM reviews r JOIN products p ON p.id=r.product_id JOIN users u ON u.id=r.user_id ORDER BY r.created DESC LIMIT 200`).all()));
app.delete("/api/admin/reviews/:id", need("admin"), (req, res) => { db.prepare("DELETE FROM reviews WHERE id=?").run(+req.params.id); res.json({ ok: true }); });
app.get("/api/admin/orders", need("admin"), (req, res) =>
  res.json(db.prepare("SELECT o.*,u.mobile FROM orders o JOIN users u ON u.id=o.user_id ORDER BY o.created DESC").all().map(orderOut)));
app.patch("/api/admin/orders/:id", need("admin"), (req, res) => {
  if (!STATUS.includes(req.body.status)) return bad(res, "Unknown status");
  db.prepare("UPDATE orders SET status=? WHERE id=?").run(req.body.status, req.params.id); res.json({ ok: true });
});
app.put("/api/admin/settings", need("admin"), (req, res) => {
  const { upi, qr, newPassword, support } = req.body;
  if (typeof upi === "string") put("upi", upi.trim().slice(0, 60));
  if (support !== undefined) {
    if (!Array.isArray(support) || support.length > 5) return bad(res, "Please check the customer service numbers");
    const out = [];
    for (const s of support) {
      const phone = str(s && s.phone, 20).replace(/[\s-]/g, ""), label = str(s && s.label, 30) || "Customer service";
      if (!/^\+?\d{8,15}$/.test(phone)) return bad(res, "Phone numbers need 8 to 15 digits, for example 9876543210");
      out.push({ label, phone });
    }
    put("support", JSON.stringify(out));
  }
  if (qr !== undefined) {
    if (typeof qr !== "string" || qr.length > 300000 || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(qr)) return bad(res, "QR must be a PNG, JPG or WebP image under 200 KB");
    put("qr", qr); put("qr_v", String(Date.now()));
  }
  if (newPassword) {
    if (typeof newPassword !== "string" || newPassword.length < 8) return bad(res, "New password needs at least 8 characters");
    put("admin_hash", bcrypt.hashSync(newPassword, 10));
  }
  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, "public")));
app.use("/api", (req, res) => bad(res, "Not found", 404));
app.use((e, req, res, next) => { console.error(e); res.status(e.status && e.status < 500 ? e.status : 500).json({ error: e.status && e.status < 500 ? "Bad request" : "Server error" }); });

app.listen(PORT, () => console.log(`Shop running at http://localhost:${PORT}`));

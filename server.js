const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ---------- tiny JSON "database" ----------
function readDB() {
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}
function writeDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
}

// ---------- uploads ----------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, crypto.randomUUID() + ext);
  }
});
const upload = multer({ storage });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- helpers ----------
const PAGES = ['catalog', 'production', 'inventory', 'customer'];

function nextMaxOrder(db, page, customerId) {
  const items = db.products.filter(p =>
    p.page === page && (page !== 'customer' || p.customerId === customerId)
  );
  return items.length ? Math.max(...items.map(p => p.order || 0)) + 1 : 0;
}

// ================= AUTH =================
app.post('/api/auth/customers', (req, res) => {
  const db = readDB();
  const { password } = req.body;
  if (password === db.passwords.customersPassword) return res.json({ ok: true });
  res.status(401).json({ ok: false, error: 'סיסמה שגויה' });
});

app.post('/api/auth/edit', (req, res) => {
  const db = readDB();
  const { code } = req.body;
  if (code === db.passwords.editCode) return res.json({ ok: true });
  res.status(401).json({ ok: false, error: 'קוד שגוי' });
});

// ================= ADMIN =================
// Admin panel itself is gated client-side by the edit code; these endpoints
// require the current edit code to be re-sent as a safety check.
app.post('/api/admin/passwords', (req, res) => {
  const db = readDB();
  const { editCode, customersPassword, newEditCode } = req.body;
  if (editCode !== db.passwords.editCode) {
    return res.status(401).json({ ok: false, error: 'קוד עריכה שגוי' });
  }
  if (customersPassword) db.passwords.customersPassword = customersPassword;
  if (newEditCode) db.passwords.editCode = newEditCode;
  writeDB(db);
  res.json({ ok: true, passwords: db.passwords });
});

app.get('/api/admin/passwords/status', (req, res) => {
  // never return actual password values to the client
  res.json({ ok: true });
});

// ================= TOPICS =================
app.get('/api/topics', (req, res) => {
  const db = readDB();
  res.json(db.topics);
});

app.post('/api/topics', (req, res) => {
  const db = readDB();
  const { topic } = req.body;
  if (topic && !db.topics.includes(topic)) {
    db.topics.push(topic);
    writeDB(db);
  }
  res.json(db.topics);
});

app.delete('/api/topics', (req, res) => {
  const db = readDB();
  const { topic } = req.body;
  db.topics = db.topics.filter(t => t !== topic);
  // products that had this topic lose the tag, but are not deleted
  db.products.forEach(p => { if (p.topic === topic) p.topic = ''; });
  writeDB(db);
  res.json(db.topics);
});

// ================= CUSTOMERS =================
app.get('/api/customers', (req, res) => {
  const db = readDB();
  res.json(db.customers);
});

app.post('/api/customers', (req, res) => {
  const db = readDB();
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'שם חסר' });
  const customer = { id: crypto.randomUUID(), name };
  db.customers.push(customer);
  writeDB(db);
  res.json(customer);
});

// ================= PRODUCTS =================

// list products for a given page (+ optional customerId, topic filter, free search)
app.get('/api/products', (req, res) => {
  const db = readDB();
  const { page, customerId, topic, search } = req.query;

  let items = db.products;
  if (page) {
    items = items.filter(p => p.page === page);
    if (page === 'customer' && customerId) {
      items = items.filter(p => p.customerId === customerId);
    }
  }
  if (topic) items = items.filter(p => p.topic === topic);
  if (search) {
    const s = search.trim().toLowerCase();
    items = items.filter(p => p.serial.toLowerCase().includes(s));
  }
  items = items.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  res.json(items);
});

// add a new image to the catalog (page 1 only - this is where new models are born)
// add a new image - either to the catalog (auto serial number) or directly
// to production/inventory/a specific customer (manual serial + sku required)
app.post('/api/products', upload.single('image'), (req, res) => {
  const db = readDB();
  const { topic, page, customerId, serial: manualSerial, sku } = req.body;
  if (!req.file) return res.status(400).json({ error: 'לא הועלתה תמונה' });

  const targetPage = PAGES.includes(page) ? page : 'catalog';

  let serial;
  if (targetPage === 'catalog') {
    serial = 'NAP-' + String(db.nextSerial).padStart(3, '0');
    db.nextSerial += 1;
  } else {
    serial = (manualSerial || '').trim();
    if (!serial) return res.status(400).json({ error: 'יש להזין מספר דגם' });
  }

  const targetCustomerId = targetPage === 'customer' ? (customerId || null) : null;
  if (targetPage === 'customer' && !targetCustomerId) {
    return res.status(400).json({ error: 'יש לבחור לקוח' });
  }

  const product = {
    id: crypto.randomUUID(),
    serial,
    sku: targetPage === 'catalog' ? '' : (sku || ''),
    topic: topic || '',
    page: targetPage,
    customerId: targetCustomerId,
    image: req.file.filename,
    order: nextMaxOrder(db, targetPage, targetCustomerId)
  };
  db.products.push(product);
  writeDB(db);
  res.json(product);
});

// edit model number / sku / topic
app.put('/api/products/:id', (req, res) => {
  const db = readDB();
  const product = db.products.find(p => p.id === req.params.id);
  if (!product) return res.status(404).json({ error: 'לא נמצא' });

  const { serial, sku, topic } = req.body;
  if (serial !== undefined) product.serial = serial;
  if (sku !== undefined) product.sku = sku;
  if (topic !== undefined) product.topic = topic;
  writeDB(db);
  res.json(product);
});

// replace the image file of an existing product
app.put('/api/products/:id/image', upload.single('image'), (req, res) => {
  const db = readDB();
  const product = db.products.find(p => p.id === req.params.id);
  if (!product) return res.status(404).json({ error: 'לא נמצא' });
  if (!req.file) return res.status(400).json({ error: 'לא הועלתה תמונה' });

  const oldImage = product.image;
  product.image = req.file.filename;
  writeDB(db);

  const oldPath = path.join(UPLOADS_DIR, oldImage);
  fs.unlink(oldPath, () => {});
  res.json(product);
});

// move a product to another page (and, if relevant, a specific customer).
// when moving to a customer, "copy" can be used to leave the original in place
// and create a duplicate assigned to that customer instead.
app.post('/api/products/:id/move', (req, res) => {
  const db = readDB();
  const product = db.products.find(p => p.id === req.params.id);
  if (!product) return res.status(404).json({ error: 'לא נמצא' });

  const { page, customerId, copy } = req.body;
  if (!PAGES.includes(page)) return res.status(400).json({ error: 'דף יעד לא תקין' });
  if (page === 'customer' && !customerId) return res.status(400).json({ error: 'יש לבחור לקוח' });

  if (copy) {
    const duplicate = {
      id: crypto.randomUUID(),
      serial: product.serial,
      sku: product.sku,
      topic: product.topic,
      page,
      customerId: page === 'customer' ? customerId : null,
      image: product.image,
      order: nextMaxOrder(db, page, page === 'customer' ? customerId : null)
    };
    db.products.push(duplicate);
    writeDB(db);
    return res.json(duplicate);
  }

  product.page = page;
  product.customerId = page === 'customer' ? (customerId || null) : null;
  product.order = nextMaxOrder(db, page, product.customerId);
  writeDB(db);
  res.json(product);
});

// reorder items within a page (drag & drop) - body: { ids: [id1, id2, ...] } in new order
app.post('/api/products/reorder', (req, res) => {
  const db = readDB();
  const { ids } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'רשימה לא תקינה' });

  ids.forEach((id, index) => {
    const product = db.products.find(p => p.id === id);
    if (product) product.order = index;
  });
  writeDB(db);
  res.json({ ok: true });
});

// delete a product permanently (serial number is never reused)
app.delete('/api/products/:id', (req, res) => {
  const db = readDB();
  const idx = db.products.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'לא נמצא' });

  const [removed] = db.products.splice(idx, 1);
  writeDB(db);
  const imgPath = path.join(UPLOADS_DIR, removed.image);
  fs.unlink(imgPath, () => {});
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`שרת הקטלוג פועל על פורט ${PORT}`);
});

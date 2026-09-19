const { DatabaseSync } = require('node:sqlite');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;
const DIR = __dirname;
const DB_PATH = path.join(DIR, 'bom-recheio.db');
const KEY_PATH = path.join(DIR, '.secret.key');

const MAX_USERS = 3;
const PAYMENT_METHODS = ['dinheiro', 'pix', 'cartao'];
const CATEGORIES = ['ingredientes', 'gas', 'embalagem', 'transporte', 'outros'];
const MAX_QUANTITY = 100000;
const MAX_AMOUNT = 1000000;
const MAX_BUYER = 200;
const MAX_DESC = 200;
const MAX_EMAIL = 254;
const RATE_WINDOW_MS = 60000;
const RATE_MAX = 12;

let SECRET;
if (fs.existsSync(KEY_PATH)) {
  SECRET = fs.readFileSync(KEY_PATH, 'utf8').trim();
} else {
  SECRET = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(KEY_PATH, SECRET);
}

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  package_size INTEGER NOT NULL,
  quantity INTEGER NOT NULL,
  units INTEGER NOT NULL,
  buyer TEXT NOT NULL,
  payment_method TEXT NOT NULL,
  amount REAL NOT NULL,
  registered_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  amount REAL NOT NULL,
  registered_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sales_created ON sales(created_at);
CREATE INDEX IF NOT EXISTS idx_expenses_created ON expenses(created_at);
`);

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'same-origin');
  res.set(
    'Content-Security-Policy',
    "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; script-src 'self'; connect-src 'self'"
  );
  next();
});
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(DIR, 'public')));

function isValidEmail(email) {
  if (email.length > MAX_EMAIL) return false;
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return false;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (!local || !domain) return false;
  if (local[0] === '.' || local[local.length - 1] === '.') return false;
  if (local.includes('..')) return false;
  if (!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)) return false;
  if (domain.startsWith('.') || domain.endsWith('.') || domain.includes('..')) return false;
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(domain)) return false;
  return true;
}

const rateHits = {};
setInterval(() => {
  const now = Date.now();
  for (const key of Object.keys(rateHits)) {
    if (now - rateHits[key].t > 2 * RATE_WINDOW_MS) delete rateHits[key];
  }
}, RATE_WINDOW_MS);

function rateLimit(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || 'local';
  const now = Date.now();
  const key = ip;
  const hit = rateHits[key] || { n: 0, t: now };
  if (now - hit.t > RATE_WINDOW_MS) {
    hit.n = 0;
    hit.t = now;
  }
  hit.n += 1;
  rateHits[key] = hit;
  if (hit.n > RATE_MAX) {
    return res.status(429).json({ error: 'Muitas tentativas. Aguarde 1 minuto.' });
  }
  next();
}

function auth(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Faça login para continuar.' });
  }
  try {
    const payload = jwt.verify(header.slice(7), SECRET);
    const user = db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(Number(payload.id));
    if (!user) return res.status(401).json({ error: 'Usuário não encontrado.' });
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: 'Sessão expirada. Entre novamente.' });
  }
}

function buildUser(row) {
  return { id: Number(row.id), name: row.name, email: row.email };
}

function issueToken(user) {
  return jwt.sign({ id: Number(user.id) }, SECRET, { expiresIn: '365d' });
}

app.post('/api/register', rateLimit, (req, res) => {
  const { name, email, password } = req.body || {};
  const cleanName = String(name || '').trim();
  const cleanEmail = String(email || '').trim().toLowerCase();

  if (!cleanName || cleanName.length > 80) {
    return res.status(400).json({ error: 'Informe um nome válido (até 80 caracteres).' });
  }
  if (!isValidEmail(cleanEmail)) {
    return res.status(400).json({ error: 'E-mail inválido.' });
  }
  if (!password || String(password).length < 6) {
    return res.status(400).json({ error: 'A senha deve ter pelo menos 6 caracteres.' });
  }

  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count >= MAX_USERS) {
    return res.status(400).json({ error: `Este negócio já tem ${MAX_USERS} usuários cadastrados.` });
  }
  const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(cleanEmail);
  if (exists) return res.status(400).json({ error: 'Este e-mail já está cadastrado.' });

  const hash = bcrypt.hashSync(String(password), 10);
  const now = new Date().toISOString();
  const info = db
    .prepare('INSERT INTO users (name, email, password_hash, created_at) VALUES (?, ?, ?, ?)')
    .run(cleanName, cleanEmail, hash, now);
  const user = buildUser({ id: info.lastInsertRowid, name: cleanName, email: cleanEmail });
  res.json({ token: issueToken(user), user });
});

app.post('/api/login', rateLimit, (req, res) => {
  const { email, password } = req.body || {};
  const cleanEmail = String(email || '').trim().toLowerCase();
  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(cleanEmail);
  if (!row || !bcrypt.compareSync(String(password || ''), row.password_hash)) {
    return res.status(401).json({ error: 'E-mail ou senha incorretos.' });
  }
  const user = buildUser(row);
  res.json({ token: issueToken(user), user });
});

app.get('/api/me', auth, (req, res) => {
  res.json({ user: req.user });
});

app.post('/api/sales', auth, (req, res) => {
  const { package_size, quantity, buyer, payment_method, amount } = req.body || {};
  const pkg = Number(package_size);
  const qty = Number(quantity);
  const val = Number(amount);
  const cleanBuyer = String(buyer || '').trim();

  if (pkg !== 50 && pkg !== 100) {
    return res.status(400).json({ error: 'Escolha pacote de 50 ou 100 unidades.' });
  }
  if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QUANTITY) {
    return res.status(400).json({ error: `Quantidade deve ser um número inteiro de 1 até ${MAX_QUANTITY} pacotes.` });
  }
  if (!cleanBuyer || cleanBuyer.length > MAX_BUYER) {
    return res.status(400).json({ error: `Informe quem comprou (até ${MAX_BUYER} caracteres).` });
  }
  if (!PAYMENT_METHODS.includes(payment_method)) {
    return res.status(400).json({ error: 'Forma de pagamento inválida.' });
  }
  if (!Number.isFinite(val) || val <= 0 || val > MAX_AMOUNT) {
    return res.status(400).json({ error: `Informe o valor recebido (de R$ 0,01 até R$ ${MAX_AMOUNT.toLocaleString('pt-BR')}).` });
  }

  const now = new Date().toISOString();
  const info = db
    .prepare(
      'INSERT INTO sales (package_size, quantity, units, buyer, payment_method, amount, registered_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(pkg, Math.floor(qty), pkg * Math.floor(qty), cleanBuyer, payment_method, val, req.user.name, now);
  res.json({ id: Number(info.lastInsertRowid), created_at: now });
});

app.post('/api/expenses', auth, (req, res) => {
  const { category, description, amount } = req.body || {};
  const val = Number(amount);
  const cleanCategory = String(category || '').trim();
  const cleanDesc = String(description || '').trim();

  if (!CATEGORIES.includes(cleanCategory)) {
    return res.status(400).json({ error: 'Categoria inválida.' });
  }
  if (!cleanDesc || cleanDesc.length > MAX_DESC) {
    return res.status(400).json({ error: `Descreva a despesa (até ${MAX_DESC} caracteres).` });
  }
  if (!Number.isFinite(val) || val <= 0 || val > MAX_AMOUNT) {
    return res.status(400).json({ error: `Informe o valor gasto (de R$ 0,01 até R$ ${MAX_AMOUNT.toLocaleString('pt-BR')}).` });
  }

  const now = new Date().toISOString();
  const info = db
    .prepare('INSERT INTO expenses (category, description, amount, registered_by, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(cleanCategory, cleanDesc, val, req.user.name, now);
  res.json({ id: Number(info.lastInsertRowid), created_at: now });
});

app.delete('/api/sales/:id', auth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'ID inválido.' });
  const info = db.prepare('DELETE FROM sales WHERE id = ?').run(id);
  if (!info.changes) return res.status(404).json({ error: 'Venda não encontrada.' });
  res.json({ ok: true });
});

app.delete('/api/expenses/:id', auth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'ID inválido.' });
  const info = db.prepare('DELETE FROM expenses WHERE id = ?').run(id);
  if (!info.changes) return res.status(404).json({ error: 'Despesa não encontrada.' });
  res.json({ ok: true });
});

function periodStart(period, from = new Date()) {
  const start = new Date(from);
  start.setHours(0, 0, 0, 0);
  if (period === 'week') {
    const day = start.getDay();
    const diff = day === 0 ? 6 : day - 1;
    start.setDate(start.getDate() - diff);
  } else if (period === 'month') {
    start.setDate(1);
  }
  return start;
}

app.get('/api/transactions', auth, (req, res) => {
  const period = ['day', 'week', 'month'].includes(req.query.period) ? req.query.period : 'day';
  const start = periodStart(period).toISOString();

  let sales;
  let expenses;
  try {
    sales = db
      .prepare(
        'SELECT id, package_size, quantity, units, buyer, payment_method, amount, registered_by, created_at FROM sales WHERE created_at >= ? ORDER BY created_at DESC'
      )
      .all(start);
    expenses = db
      .prepare('SELECT id, category, description, amount, registered_by, created_at FROM expenses WHERE created_at >= ? ORDER BY created_at DESC')
      .all(start);
  } catch (e) {
    console.error('Falha ao ler lançamentos:', e);
    return res.status(500).json({ error: 'Falha ao ler lançamentos.' });
  }

  const items = [
    ...sales.map((s) => ({
      key: `venda-${s.id}`,
      id: Number(s.id),
      type: 'entrada',
      title: s.buyer,
      subtitle: `${s.quantity} pacote${s.quantity > 1 ? 's' : ''} de ${s.package_size} unidades`,
      category: null,
      payment_method: s.payment_method,
      amount: Number(s.amount),
      created_at: s.created_at,
      registered_by: s.registered_by,
    })),
    ...expenses.map((e) => ({
      key: `despesa-${e.id}`,
      id: Number(e.id),
      type: 'saida',
      title: e.description || 'Despesa',
      subtitle: null,
      category: e.category,
      payment_method: null,
      amount: Number(e.amount),
      created_at: e.created_at,
      registered_by: e.registered_by,
    })),
  ].sort((a, b) => b.created_at.localeCompare(a.created_at));

  const entradas = sales.reduce((s, x) => s + Number(x.amount), 0);
  const saidas = expenses.reduce((s, x) => s + Number(x.amount), 0);
  const unidades = sales.reduce((s, x) => s + Number(x.units), 0);

  res.json({ period, entradas, saidas, saldo: entradas - saidas, unidades, items });
});

app.use((req, res) => res.status(404).json({ error: 'Não encontrado.' }));

app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Requisição grande demais.' });
  }
  if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
    return res.status(400).json({ error: 'JSON inválido.' });
  }
  if (err && typeof err.status === 'number' && err.status < 500) {
    return res.status(err.status).json({ error: err.message || 'Erro na requisição.' });
  }
  console.error(err);
  res.status(500).json({ error: 'Erro interno do servidor.' });
});

app.listen(PORT, () => {
  console.log(`Bom Recheio rodando em http://localhost:${PORT}`);
  console.log(`Banco de dados: ${DB_PATH}`);
});
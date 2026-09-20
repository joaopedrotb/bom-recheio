import { SignJWT, jwtVerify } from 'jose';
import * as bcrypt from 'bcryptjs';

const MAX_USERS = 3;
const PAYMENT_METHODS = ['dinheiro', 'pix', 'cartao'];

const PRICES = {
  100: { dinheiro: 60, pix: 60, cartao: 63 },
  50: { dinheiro: 30, pix: 30, cartao: 33 },
};
const CATEGORIES = ['ingredientes', 'gas', 'embalagem', 'transporte', 'outros'];
const SABORES = ['coxinha', 'bolinha_presunto_queijo', 'bolinha_queijo', 'bolinha_salsicha', 'kibe', 'empada', 'risole_carne'];
const MAX_QUANTITY = 100000;
const MAX_AMOUNT = 1000000;
const MAX_BUYER = 200;
const MAX_DESC = 200;
const MAX_EMAIL = 254;
const MAX_BODY_BYTES = 102400;
const RATE_MAX = 12;

const CSP =
  "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; script-src 'self'; connect-src 'self'";

const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': CSP,
};

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, SEC_HEADERS),
  });
}

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

async function readJson(request) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > MAX_BODY_BYTES) return { __tooLarge: true };
  let data;
  try {
    data = await request.json();
  } catch (e) {
    return { __parseError: true };
  }
  return data || {};
}

async function issueToken(env, id) {
  const s = env.JWT_SECRET;
  if (!s) return null;
  return new SignJWT({ id: Number(id) })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('365d')
    .sign(new TextEncoder().encode(s));
}

async function auth(request, env) {
  const header = request.headers.get('Authorization') || '';
  if (!header.startsWith('Bearer ')) {
    return { error: 'Faça login para continuar.', status: 401 };
  }
  const s = env.JWT_SECRET;
  if (!s) return { error: 'Segredo JWT não configurado no Worker.', status: 503 };
  try {
    const { payload } = await jwtVerify(header.slice(7), new TextEncoder().encode(s));
    const row = await env.DB.prepare('SELECT id, name, email FROM users WHERE id = ?').bind(Number(payload.id)).first();
    if (!row) return { error: 'Usuário não encontrado.', status: 401 };
    return { user: { id: Number(row.id), name: row.name, email: row.email } };
  } catch (e) {
    return { error: 'Sessão expirada. Entre novamente.', status: 401 };
  }
}

async function rateLimited(env, request) {
  if (!env.RATE) return false;
  const ip = request.headers.get('CF-Connecting-IP') || 'desconhecido';
  const bucket = Math.floor(Date.now() / 60000);
  const key = 'rl:' + ip + ':' + bucket;
  const cur = Number((await env.RATE.get(key)) || 0);
  if (cur >= RATE_MAX) return true;
  await env.RATE.put(key, String(cur + 1), { expirationTtl: 70 });
  return false;
}

function periodStart(period, from = new Date()) {
  const start = new Date(from);
  start.setHours(0, 0, 0, 0);
  if (period === 'week') {
    const day = start.getDay();
    start.setDate(start.getDate() - (day === 0 ? 6 : day - 1));
  } else if (period === 'month') {
    start.setDate(1);
  }
  return start;
}

let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  schemaReady = true;
  try {
    await env.DB.prepare("ALTER TABLE sales ADD COLUMN flavor TEXT NOT NULL DEFAULT ''").run();
  } catch (e) {
    // coluna já existe em bancos já migrados
  }
}

/* ---------------- handlers ---------------- */

async function register(request, env) {
  const body = await readJson(request);
  if (body.__tooLarge) return json(413, { error: 'Requisição grande demais.' });
  if (body.__parseError) return json(400, { error: 'JSON inválido.' });

  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');

  if (!name || name.length > 80) return json(400, { error: 'Informe um nome válido (até 80 caracteres).' });
  if (!isValidEmail(email)) return json(400, { error: 'E-mail inválido.' });
  if (!password || password.length < 6) return json(400, { error: 'A senha deve ter pelo menos 6 caracteres.' });

  const countRow = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
  if (Number(countRow.n) >= MAX_USERS) {
    return json(400, { error: 'Este negócio já tem ' + MAX_USERS + ' usuários cadastrados.' });
  }
  const exists = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (exists) return json(400, { error: 'Este e-mail já está cadastrado.' });

  const hash = bcrypt.hashSync(password, 10);
  const now = new Date().toISOString();
  const res = await env.DB.prepare('INSERT INTO users (name, email, password_hash, created_at) VALUES (?, ?, ?, ?)')
    .bind(name, email, hash, now)
    .run();
  const id = Number(res.meta.last_row_id);
  const token = await issueToken(env, id);
  if (!token) return json(503, { error: 'Segredo JWT não configurado no Worker.' });
  return json(200, { token, user: { id, name, email } });
}

async function login(request, env) {
  const body = await readJson(request);
  if (body.__tooLarge) return json(413, { error: 'Requisição grande demais.' });
  if (body.__parseError) return json(400, { error: 'JSON inválido.' });

  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');

  const row = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  if (!row || !bcrypt.compareSync(password, row.password_hash)) {
    return json(401, { error: 'E-mail ou senha incorretos.' });
  }
  const user = { id: Number(row.id), name: row.name, email: row.email };
  const token = await issueToken(env, user.id);
  if (!token) return json(503, { error: 'Segredo JWT não configurado no Worker.' });
  return json(200, { token, user });
}

async function createSale(request, env, user) {
  const body = await readJson(request);
  if (body.__tooLarge) return json(413, { error: 'Requisição grande demais.' });
  if (body.__parseError) return json(400, { error: 'JSON inválido.' });

  const pkg = Number(body.package_size);
  const qty = Number(body.quantity);
  const entrega =
    body.delivery === undefined || body.delivery === null || body.delivery === ''
      ? 0
      : Number(String(body.delivery).replace(',', '.'));
  const buyer = String(body.buyer || '').trim();
  const flavor = String(body.flavor || '').trim();

  if (pkg !== 50 && pkg !== 100) return json(400, { error: 'Escolha pacote de 50 ou 100 unidades.' });
  if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QUANTITY) {
    return json(400, { error: 'Quantidade deve ser um número inteiro de 1 até ' + MAX_QUANTITY + ' pacotes.' });
  }
  if (!buyer || buyer.length > MAX_BUYER) {
    return json(400, { error: 'Informe quem comprou (até ' + MAX_BUYER + ' caracteres).' });
  }
  if (!PAYMENT_METHODS.includes(body.payment_method)) return json(400, { error: 'Forma de pagamento inválida.' });
  if (!Number.isFinite(entrega) || entrega < 0 || entrega > MAX_AMOUNT) {
    return json(400, { error: 'Informe um valor de entrega válido.' });
  }
  if (!SABORES.includes(flavor)) return json(400, { error: 'Escolha o sabor do salgado.' });

  const unit = PRICES[pkg][body.payment_method] || PRICES[pkg].dinheiro;
  const val = unit * qty + entrega;
  if (!Number.isFinite(val) || val <= 0 || val > MAX_AMOUNT) {
    return json(400, { error: 'O valor da venda ultrapassou o limite (R$ 1.000.000,00).' });
  }

  const now = new Date().toISOString();
  const res = await env.DB.prepare(
    'INSERT INTO sales (package_size, quantity, units, buyer, payment_method, amount, flavor, registered_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  )
    .bind(pkg, qty, pkg * qty, buyer, body.payment_method, val, flavor, user.name, now)
    .run();
  return json(200, { id: Number(res.meta.last_row_id), created_at: now });
}

async function createExpense(request, env, user) {
  const body = await readJson(request);
  if (body.__tooLarge) return json(413, { error: 'Requisição grande demais.' });
  if (body.__parseError) return json(400, { error: 'JSON inválido.' });

  const val = Number(body.amount);
  const category = String(body.category || '').trim();
  const desc = String(body.description || '').trim();

  if (!CATEGORIES.includes(category)) return json(400, { error: 'Categoria inválida.' });
  if (!desc || desc.length > MAX_DESC) {
    return json(400, { error: 'Descreva a despesa (até ' + MAX_DESC + ' caracteres).' });
  }
  if (!Number.isFinite(val) || val <= 0 || val > MAX_AMOUNT) {
    return json(400, { error: 'Informe o valor gasto (de R$ 0,01 até R$ 1.000.000).' });
  }

  const now = new Date().toISOString();
  const res = await env.DB.prepare(
    'INSERT INTO expenses (category, description, amount, registered_by, created_at) VALUES (?, ?, ?, ?, ?)'
  )
    .bind(category, desc, val, user.name, now)
    .run();
  return json(200, { id: Number(res.meta.last_row_id), created_at: now });
}

async function removeRow(env, table, rawId) {
  const id = Number(rawId);
  if (!Number.isInteger(id) || id < 1) return json(400, { error: 'ID inválido.' });
  const res = await env.DB.prepare('DELETE FROM ' + table + ' WHERE id = ?').bind(id).run();
  if (!res.meta.changes) return json(404, { error: 'Registro não encontrado.' });
  return json(200, { ok: true });
}

async function transactions(request, env) {
  const url = new URL(request.url);
  const reqPeriod = url.searchParams.get('period') || '';
  const period = ['day', 'week', 'month'].includes(reqPeriod) ? reqPeriod : 'day';
  const start = periodStart(period).toISOString();

  const sales = await env.DB.prepare(
    'SELECT id, package_size, quantity, units, buyer, payment_method, amount, flavor, registered_by, created_at FROM sales WHERE created_at >= ? ORDER BY created_at DESC'
  )
    .bind(start)
    .all();
  const expenses = await env.DB.prepare(
    'SELECT id, category, description, amount, registered_by, created_at FROM expenses WHERE created_at >= ? ORDER BY created_at DESC'
  )
    .bind(start)
    .all();

  const items = [
    ...sales.results.map((s) => ({
      key: 'venda-' + s.id,
      id: Number(s.id),
      type: 'entrada',
      title: s.buyer,
      subtitle: s.quantity + ' pacote' + (s.quantity > 1 ? 's' : '') + ' de ' + s.package_size + ' unidades',
      category: null,
      flavor: s.flavor || '',
      payment_method: s.payment_method,
      amount: Number(s.amount),
      created_at: s.created_at,
      registered_by: s.registered_by,
    })),
    ...expenses.results.map((e) => ({
      key: 'despesa-' + e.id,
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

  const entradas = sales.results.reduce((s, x) => s + Number(x.amount), 0);
  const saidas = expenses.results.reduce((s, x) => s + Number(x.amount), 0);
  const unidades = sales.results.reduce((s, x) => s + Number(x.units), 0);

  return json(200, { period, entradas, saidas, saldo: entradas - saidas, unidades, items });
}

async function stats(request, env) {
  const url = new URL(request.url);
  const reqPeriod = url.searchParams.get('period') || '';
  const period = ['day', 'week', 'month'].includes(reqPeriod) ? reqPeriod : 'day';
  const start = periodStart(period).toISOString();

  const sabores = await env.DB.prepare(
    'SELECT flavor, SUM(quantity) AS qtd, COUNT(*) AS vendas, SUM(amount) AS faturamento FROM sales WHERE created_at >= ? GROUP BY flavor ORDER BY qtd DESC, vendas DESC'
  )
    .bind(start)
    .all();
  const tamanhos = await env.DB.prepare(
    'SELECT package_size, SUM(quantity) AS qtd, COUNT(*) AS vendas, SUM(amount) AS faturamento FROM sales WHERE created_at >= ? GROUP BY package_size ORDER BY package_size DESC'
  )
    .bind(start)
    .all();

  return json(200, {
    period,
    sabores: sabores.results.map((r) => ({
      flavor: r.flavor || 'Sem sabor',
      packages: Number(r.qtd),
      sales: Number(r.vendas),
      total: Number(r.faturamento),
    })),
    tamanhos: tamanhos.results.map((r) => ({
      package_size: Number(r.package_size),
      packages: Number(r.qtd),
      sales: Number(r.vendas),
      total: Number(r.faturamento),
    })),
  });
}

/* ---------------- roteamento ---------------- */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      await ensureSchema(env);
    } catch (e) {
      // migração é tolerante a falhas
    }

    if (method === 'POST' && path === '/api/register') {
      if (await rateLimited(env, request)) return json(429, { error: 'Muitas tentativas. Aguarde 1 minuto.' });
      return register(request, env);
    }
    if (method === 'POST' && path === '/api/login') {
      if (await rateLimited(env, request)) return json(429, { error: 'Muitas tentativas. Aguarde 1 minuto.' });
      return login(request, env);
    }
    if (method === 'GET' && path === '/api/me') {
      return withUser(request, env, (user) => json(200, { user }));
    }
    if (method === 'POST' && path === '/api/sales') {
      return withUser(request, env, (user) => createSale(request, env, user));
    }
    if (method === 'POST' && path === '/api/expenses') {
      return withUser(request, env, (user) => createExpense(request, env, user));
    }
    if (method === 'DELETE' && path.startsWith('/api/sales/')) {
      return withUser(request, env, () => removeRow(env, 'sales', decodeURIComponent(path.slice('/api/sales/'.length))));
    }
    if (method === 'DELETE' && path.startsWith('/api/expenses/')) {
      return withUser(request, env, () => removeRow(env, 'expenses', decodeURIComponent(path.slice('/api/expenses/'.length))));
    }
    if (method === 'GET' && path === '/api/transactions') {
      return withUser(request, env, () => transactions(request, env));
    }
    if (method === 'GET' && path === '/api/stats') {
      return withUser(request, env, () => stats(request, env));
    }

    return json(404, { error: 'Não encontrado.' });
  },
};

async function withUser(request, env, handler) {
  const a = await auth(request, env);
  if (a.error) return json(a.status, { error: a.error });
  return handler(a.user);
}
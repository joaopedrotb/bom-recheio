const BASE = 'http://localhost:3000';
let failures = 0;
function log(ok, msg) {
  if (!ok) failures++;
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + msg);
}

async function req(method, path, body, headers) {
  const opts = { method, headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}) };
  if (body !== undefined) opts.body = typeof body === 'string' ? body : JSON.stringify(body);
  const res = await fetch(BASE + path, opts);
  let data = {};
  try { data = await res.json(); } catch (e) {}
  return { status: res.status, data, headers: res.headers };
}

(async () => {
  // headers de seguranca
  const h = await req('GET', '/');
  log(h.headers.get('x-powered-by') === null, 'Sem X-Powered-By');
  log(/nosniff/i.test(h.headers.get('x-content-type-options')), 'X-Content-Type-Options: nosniff');
  log(/default-src/.test(h.headers.get('content-security-policy')), 'CSP presente');

  // cadastro QA temporario
  const wrong = await req('POST', '/api/register', { email: 'a..b@c.com', password: '12345a', name: 'X' });
  log(wrong.status === 400, 'Email invalido a..b@c.com -> ' + wrong.status);
  const short = await req('POST', '/api/register', { email: 'qa-deploy@teste', password: '123', name: 'X' });
  log(short.status === 400, 'Senha curta -> ' + short.status);

  const reg = await req('POST', '/api/register', { email: 'qa-deploy@teste.local', password: 'segredo1', name: 'QA Deploy' });
  log(reg.status === 200, 'Cadastro QA ok: ' + reg.status);
  const token = reg.data && reg.data.token;

  // validacoes de venda (F-01/F-04/F-05/F-06)
  const bad = (body, label) =>
    req('POST', '/api/sales', body, { Authorization: 'Bearer ' + token }).then((r) => {
      log(r.status === 400, label + ' -> ' + r.status);
    });

  await bad({ package_size: 50, quantity: 9007199254740992, buyer: 'T', payment_method: 'dinheiro', amount: 10 }, 'qty 2^53 -> 400');
  await bad({ package_size: 50, quantity: 1e308, buyer: 'T', payment_method: 'dinheiro', amount: 10 }, 'qty 1e308 -> 400');
  await bad({ package_size: 50, quantity: 2.7, buyer: 'T', payment_method: 'dinheiro', amount: 10 }, 'qty 2.7 -> 400');
  await bad({ package_size: 50, quantity: 100001, buyer: 'T', payment_method: 'dinheiro', amount: 10 }, 'qty 100001 -> 400');
  await bad({ package_size: 50, quantity: 126751, buyer: 'T', payment_method: 'dinheiro', amount: 10 }, 'qty 126751 -> 400');
  await bad({ package_size: 50, quantity: 2, buyer: 'T', payment_method: 'dinheiro', amount: 0 }, 'amount 0 -> 400');
  await bad({ package_size: 50, quantity: 2, buyer: 'T', payment_method: 'dinheiro', amount: 1000001 }, 'amount >1M -> 400');
  await bad({ package_size: 50, quantity: 2, buyer: 'T'.repeat(201), payment_method: 'dinheiro', amount: 10 }, 'buyer 201 chars -> 400');

  // cria venda valida para testar delete
  const sale = await req('POST', '/api/sales', { package_size: 50, quantity: 3, buyer: 'QA Delete', payment_method: 'pix', amount: 99.9, flavor: 'coxinha' }, { Authorization: 'Bearer ' + token });
  log(sale.status === 200 && sale.data.id, 'Venda valida criada id=' + sale.data.id);
  const del = await req('DELETE', '/api/sales/' + sale.data.id, undefined, { Authorization: 'Bearer ' + token });
  log(del.status === 200, 'DELETE venda ok -> ' + del.status);
  const del2 = await req('DELETE', '/api/sales/' + sale.data.id, undefined, { Authorization: 'Bearer ' + token });
  log(del2.status === 404, 'DELETE repetido -> 404');
  const delBad = await req('DELETE', '/api/sales/abc', undefined, { Authorization: 'Bearer ' + token });
  log(delBad.status === 400, 'DELETE id invalido -> 400');

  // transactions continua ok (F-01 nao derrubou)
  const tx = await req('GET', '/api/transactions?period=month', undefined, { Authorization: 'Bearer ' + token });
  log(tx.status === 200, 'transactions ainda 200 -> ' + tx.status);

  // 413 e JSON malformado (L-01)
  const big = await req('POST', '/api/sales', JSON.stringify({ quantity: 2, amount: 10 }) + 'x'.repeat(150000), { Authorization: 'Bearer ' + token });
  log(big.status === 413, 'payload 150kb -> 413 (foi ' + big.status + ')');
  const mal = await req('POST', '/api/login', '{ "email": ');
  log(mal.status === 400, 'JSON malformado -> 400 (foi ' + mal.status + ')');

  // rate limit (P-02) - ULTIMO por causa da janela de 60s
  let got429 = false;
  for (let i = 0; i < 13; i++) {
    const r = await req('POST', '/api/login', { email: 'qa-deploy@teste.local', password: 'errada' + i });
    if (r.status === 429) { got429 = true; break; }
  }
  log(got429, 'Rate limit atinge 429 em logins invalidos');

  console.log('\nFalhas: ' + failures);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
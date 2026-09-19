(function () {
  'use strict';

  const TOKEN_KEY = 'br_token';
  const FORMAT_BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

  const PAY_LABELS = { dinheiro: 'Dinheiro', pix: 'PIX', cartao: 'Cartão' };
  const CAT_LABELS = {
    ingredientes: 'Ingredientes',
    gas: 'Gás',
    embalagem: 'Embalagem',
    transporte: 'Transporte',
    outros: 'Outros',
  };

  const MAX_QUANTITY = 100000;

  const $ = (id) => document.getElementById(id);

  let token = localStorage.getItem(TOKEN_KEY) || '';
  let currentUser = null;
  let period = 'day';

  const authView = $('auth-view');
  const appView = $('app-view');
  const toastEl = $('toast');

  let toastTimer = null;
  function toast(msg, kind) {
    clearTimeout(toastTimer);
    toastEl.textContent = msg;
    toastEl.className = 'toast ' + (kind || '');
    toastEl.classList.remove('hidden');
    toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 2600);
  }

  function parseMoney(v) {
    const n = parseFloat(String(v).replace(/\s/g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : NaN;
  }

  function formatMoney(v) {
    return FORMAT_BRL.format(v || 0);
  }

  async function api(path, options) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    const res = await fetch(path, Object.assign({}, options, { headers }));
    let data = {};
    try { data = await res.json(); } catch (e) { /* corpo vazio */ }
    if (!res.ok) {
      const err = new Error(data.error || 'Erro no servidor.');
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function wireTabKeys(listEl) {
    listEl.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const tabs = Array.from(listEl.querySelectorAll('[role="tab"]:not([disabled])'));
      const idx = tabs.indexOf(document.activeElement);
      if (idx === -1) return;
      e.preventDefault();
      const next = (idx + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      tabs[next].focus();
      tabs[next].click();
    });
  }

  /* ---------------- AUTH ---------------- */

  function showView(view) {
    authView.classList.toggle('hidden', view !== 'auth');
    appView.classList.toggle('hidden', view !== 'app');
  }

  function switchTab(which) {
    $('tab-login').setAttribute('aria-selected', which === 'login' ? 'true' : 'false');
    $('tab-register').setAttribute('aria-selected', which === 'register' ? 'true' : 'false');
    $('tab-login').classList.toggle('active', which === 'login');
    $('tab-register').classList.toggle('active', which === 'register');
    $('login-form').classList.toggle('hidden', which !== 'login');
    $('register-form').classList.toggle('hidden', which !== 'register');
    hideMsg();
  }

  function showMsg(text, ok) {
    const el = $('auth-msg');
    el.textContent = text;
    el.className = 'msg' + (ok ? ' ok' : '');
    el.classList.remove('hidden');
  }

  function hideMsg() {
    const el = $('auth-msg');
    el.classList.add('hidden');
    el.textContent = '';
  }

  $('tab-login').addEventListener('click', () => switchTab('login'));
  $('tab-register').addEventListener('click', () => switchTab('register'));
  wireTabKeys($('auth-tabs'));

  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    hideMsg();
    try {
      const data = await api('/api/login', {
        method: 'POST',
        body: JSON.stringify({ email: $('login-email').value, password: $('login-password').value }),
      });
      enterApp(data);
    } catch (err) {
      showMsg(err.message);
    }
  });

  $('register-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    hideMsg();
    try {
      const data = await api('/api/register', {
        method: 'POST',
        body: JSON.stringify({
          name: $('reg-name').value,
          email: $('reg-email').value,
          password: $('reg-password').value,
        }),
      });
      enterApp(data);
    } catch (err) {
      showMsg(err.message);
    }
  });

  $('logout').addEventListener('click', () => {
    token = '';
    currentUser = null;
    localStorage.removeItem(TOKEN_KEY);
    ['login-email', 'login-password', 'reg-name', 'reg-email', 'reg-password'].forEach((id) => {
      $(id).value = '';
    });
    switchTab('login');
    showView('auth');
    toast('Você saiu da conta.', 'ok');
  });

  function enterApp(data) {
    token = data.token || localStorage.getItem(TOKEN_KEY);
    currentUser = data.user;
    localStorage.setItem(TOKEN_KEY, token);
    $('user-name').textContent = 'Olá, ' + currentUser.name.split(' ')[0] + ' 🧡';
    showView('app');
    refresh();
  }

  async function init() {
    if (!token) { showView('auth'); return; }
    try {
      const data = await api('/api/me');
      enterApp({ user: data.user, token });
    } catch (err) {
      token = '';
      localStorage.removeItem(TOKEN_KEY);
      showView('auth');
      showMsg('Sua sessão expirou. Entre novamente.');
    }
  }

  /* ---------------- FORMULÁRIOS ---------------- */

  let salePkg = 100;
  let salePay = 'dinheiro';

  function bindSeg(containerId, onChange) {
    const container = $(containerId);
    container.addEventListener('click', (e) => {
      const btn = e.target.closest('.seg-btn');
      if (!btn) return;
      container.querySelectorAll('.seg-btn').forEach((b) => {
        b.classList.remove('active');
        b.setAttribute('aria-pressed', 'false');
      });
      btn.classList.add('active');
      btn.setAttribute('aria-pressed', 'true');
      onChange(btn.dataset.val);
    });
  }

  bindSeg('pkg-seg', (v) => { salePkg = Number(v); });
  bindSeg('pay-seg', (v) => { salePay = v; });

  function toggleForm(formId, exceptId) {
    const other = $(exceptId);
    const form = $(formId);
    const willOpen = form.classList.contains('hidden');
    other.classList.add('hidden');
    form.classList.toggle('hidden', !willOpen);
    if (willOpen) {
      if (formId === 'sale-form') {
        $('sale-buyer').focus();
      } else {
        $('expense-desc').focus();
      }
    }
  }

  $('btn-sale').addEventListener('click', () => toggleForm('sale-form', 'expense-form'));
  $('btn-expense').addEventListener('click', () => toggleForm('expense-form', 'sale-form'));

  $('sale-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const rawQty = Number($('sale-qty').value);
    const amount = parseMoney($('sale-amount').value);
    const buyer = $('sale-buyer').value.trim();
    if (!Number.isInteger(rawQty)) return toast('Quantidade deve ser um número inteiro.', 'err');
    if (rawQty < 1 || rawQty > MAX_QUANTITY) return toast('Quantidade deve ser de 1 até ' + MAX_QUANTITY + ' pacotes.', 'err');
    if (!buyer) return toast('Informe quem comprou.', 'err');
    if (!Number.isFinite(amount) || amount <= 0) return toast('Informe o valor recebido (maior que zero).', 'err');

    const btn = $('sale-submit');
    btn.disabled = true;
    try {
      await api('/api/sales', {
        method: 'POST',
        body: JSON.stringify({ package_size: salePkg, quantity: rawQty, buyer, payment_method: salePay, amount }),
      });
      toast('Venda registrada ✔', 'ok');
      $('sale-amount').value = '';
      $('sale-buyer').value = '';
      $('sale-qty').value = '1';
      $('sale-form').classList.add('hidden');
      refresh();
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      btn.disabled = false;
    }
  });

  $('expense-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const category = $('expense-category').value;
    const description = $('expense-desc').value.trim();
    const amount = parseMoney($('expense-amount').value);
    if (!description) return toast('Descreva a despesa.', 'err');
    if (!Number.isFinite(amount) || amount <= 0) return toast('Informe o valor gasto.', 'err');

    const btn = $('expense-submit');
    btn.disabled = true;
    try {
      await api('/api/expenses', {
        method: 'POST',
        body: JSON.stringify({ category, description, amount }),
      });
      toast('Despesa registrada ✔', 'ok');
      $('expense-desc').value = '';
      $('expense-amount').value = '';
      $('expense-form').classList.add('hidden');
      refresh();
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      btn.disabled = false;
    }
  });

  /* ---------------- PERÍODO E LISTA ---------------- */

  $('period-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.ptab');
    if (!btn) return;
    document.querySelectorAll('.ptab').forEach((b) => {
      b.classList.remove('active');
      b.setAttribute('aria-selected', 'false');
    });
    btn.classList.add('active');
    btn.setAttribute('aria-selected', 'true');
    $('period-panel').setAttribute('aria-labelledby', btn.id);
    period = btn.dataset.period;
    refresh();
  });
  wireTabKeys($('period-tabs'));

  function formatWhen(iso) {
    const d = new Date(iso);
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    const time = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    if (sameDay) return 'Hoje · ' + time;
    const date = d.toLocaleDateString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric',
    });
    return date + ' · ' + time;
  }

  function renderList(data) {
    $('tot-in').textContent = formatMoney(data.entradas);
    $('tot-out').textContent = formatMoney(data.saidas);
    $('tot-bal').textContent = formatMoney(data.saldo);
    const periodWord = { day: 'Hoje', week: 'Esta semana', month: 'Este mês' }[period] || 'No período';
    $('units-note').textContent = periodWord + ': ' + data.unidades + ' unidades vendidas';

    const list = $('list');
    list.innerHTML = '';
    $('empty').classList.toggle('hidden', data.items.length > 0);

    data.items.forEach((item) => {
      const li = document.createElement('li');
      li.className = item.type === 'entrada' ? 'entrada' : 'saida';

      const sign = document.createElement('span');
      sign.className = 'item-sign';
      sign.textContent = item.type === 'entrada' ? '+' : '−';
      sign.setAttribute('aria-hidden', 'true');

      const main = document.createElement('div');
      main.className = 'item-main';

      const head = document.createElement('div');
      head.className = 'item-head';

      const title = document.createElement('span');
      title.className = 'item-title';
      title.textContent = item.title;
      title.title = item.title;

      const amount = document.createElement('span');
      amount.className = 'item-amount';
      amount.textContent = formatMoney(item.amount);

      head.appendChild(title);
      head.appendChild(amount);

      const meta = document.createElement('div');
      meta.className = 'item-meta';

      const time = document.createElement('span');
      time.className = 'chip';
      time.textContent = formatWhen(item.created_at);

      meta.appendChild(time);

      if (item.type === 'entrada' && item.payment_method) {
        const chip = document.createElement('span');
        chip.className = 'chip chip-method';
        chip.textContent = PAY_LABELS[item.payment_method] || item.payment_method;
        meta.appendChild(chip);
      }
      if (item.type === 'saida' && item.category) {
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.textContent = CAT_LABELS[item.category] || item.category;
        meta.appendChild(chip);
      }
      if (item.subtitle) {
        const s = document.createElement('span');
        s.className = 'chip';
        s.textContent = item.subtitle;
        meta.appendChild(s);
      }

      main.appendChild(head);
      main.appendChild(meta);

      const kind = item.type === 'entrada' ? 'venda' : 'despesa';
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'item-del';
      del.textContent = '×';
      del.setAttribute('aria-label', 'Excluir ' + kind + ' de ' + item.title + ' (' + formatMoney(item.amount) + ')');
      del.addEventListener('click', async () => {
        if (!window.confirm('Excluir este lançamento?\n\n' + kind + ' de ' + item.title + ' (' + formatMoney(item.amount) + ')?')) return;
        try {
          await api('/api/' + (item.type === 'entrada' ? 'sales' : 'expenses') + '/' + item.id, { method: 'DELETE' });
          toast('Lançamento excluído.', 'ok');
          refresh();
        } catch (err) {
          toast(err.message, 'err');
        }
      });

      li.appendChild(sign);
      li.appendChild(main);
      li.appendChild(del);
      list.appendChild(li);
    });
  }

  async function refresh() {
    try {
      const data = await api('/api/transactions?period=' + encodeURIComponent(period));
      renderList(data);
    } catch (err) {
      toast(err.message, 'err');
      if (err.status === 401) {
        token = '';
        localStorage.removeItem(TOKEN_KEY);
        showView('auth');
        showMsg('Sua sessão expirou. Entre novamente.');
      }
    }
  }

  init();
})();
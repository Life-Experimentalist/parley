const CURRENCIES = ['USD', 'EUR', 'GBP', 'AUD', 'CAD', 'SGD'];
const $ = (sel) => document.querySelector(sel);

function h(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, '');
    else if (v !== false && v != null) node.setAttribute(k, v);
  }
  for (const kid of kids.flat()) node.append(kid instanceof Node ? kid : document.createTextNode(String(kid ?? '')));
  return node;
}

const todayLocal = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in the user's own timezone

const money = (value, currency) => {
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(value); }
  catch { return `${currency} ${Number(value).toFixed(2)}`; }
};
const shortDate = (iso) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '');

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify({ today: todayLocal(), ...body }) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Request failed (${res.status}).`);
  return data;
}

let toastTimer;
function toast(message, { good = false, ms = 6000 } = {}) {
  const t = $('#toast');
  t.textContent = message;
  t.className = good ? 'toast good' : 'toast';
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

async function busy(button, label, fn) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = label;
  try { return await fn(); }
  finally { button.disabled = false; button.textContent = original; }
}

/* ---------- status ---------- */

let status = { mode: 'mock', ai: false };

async function loadStatus() {
  status = await api('GET', '/api/status');
  const mode = $('#mode');
  mode.replaceChildren(
    status.mode === 'sandbox'
      ? h('span', {}, h('b', {}, 'Connected to the PayPal sandbox.'), ' Invoices go to PayPal’s test environment.')
      : h('span', {}, h('b', {}, 'Demo data.'), ' Nothing here is sent to anyone. Add PayPal sandbox keys to use the real thing.'),
  );
  if (!status.ai) toast('No AI key is set, so I cannot read invoices or write reminders yet. Add GEMINI_API_KEYS or ANTHROPIC_API_KEYS and restart.', { ms: 12000 });
}

/* ---------- compose and check ---------- */

let draft = null;
let requestId = null;

const currencySelect = $('#f-currency');
for (const c of CURRENCIES) currencySelect.append(h('option', { value: c }, c));

function lineCents(it) { return Math.round(Number(it.quantity || 0) * Math.round(Number(it.unit_price || 0) * 100)); }

function renderTotals() {
  const cents = draft.items.reduce((s, it) => s + lineCents(it), 0);
  $('#total').textContent = `Total ${money(cents / 100, draft.currency || 'USD')}`;
  draft.items.forEach((it, i) => {
    const cell = document.querySelector(`#lines tbody tr[data-i="${i}"] .line-total`);
    if (cell) cell.textContent = money(lineCents(it) / 100, draft.currency || 'USD');
  });
}

function renderLines() {
  const body = $('#lines tbody');
  body.replaceChildren(...draft.items.map((it, i) => h('tr', { 'data-i': i },
    h('td', {}, h('input', { value: it.name, 'aria-label': `Line ${i + 1} description`, oninput: (e) => { it.name = e.target.value; } })),
    h('td', {}, h('input', { class: 'num', type: 'number', min: '0', step: 'any', value: it.quantity, 'aria-label': `Line ${i + 1} quantity`, oninput: (e) => { it.quantity = e.target.value; renderTotals(); } })),
    h('td', {}, h('input', { class: 'num', type: 'number', min: '0', step: '0.01', value: it.unit_price, 'aria-label': `Line ${i + 1} price`, oninput: (e) => { it.unit_price = e.target.value; renderTotals(); } })),
    h('td', { class: 'line-total' }),
    h('td', {}, h('button', { type: 'button', class: 'plain', onclick: () => { draft.items.splice(i, 1); renderLines(); } }, 'Remove')),
  )));
  renderTotals();
}

function showDraft(d, notes = []) {
  draft = { ...d, items: d.items.map((i) => ({ ...i })) };
  requestId = crypto.randomUUID();
  $('#f-name').value = draft.client_name;
  $('#f-company').value = draft.client_company;
  $('#f-email').value = draft.client_email;
  currencySelect.value = draft.currency || 'USD';
  $('#f-due').value = draft.due_date;
  $('#notes').replaceChildren(...notes.map((n) => h('li', {}, n)));
  renderLines();
  $('#check').hidden = false;
  $('#check').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
}

$('#f-name').addEventListener('input', (e) => { draft.client_name = e.target.value; });
$('#f-company').addEventListener('input', (e) => { draft.client_company = e.target.value; });
$('#f-email').addEventListener('input', (e) => { draft.client_email = e.target.value; });
$('#f-due').addEventListener('input', (e) => { draft.due_date = e.target.value; });
currencySelect.addEventListener('change', (e) => { draft.currency = e.target.value; renderTotals(); });
$('#add-line').addEventListener('click', () => { draft.items.push({ name: '', quantity: 1, unit_price: '' }); renderLines(); });
$('#reset').addEventListener('click', () => { $('#check').hidden = true; draft = null; $('#said').focus(); });

$('#prepare').addEventListener('click', (e) => busy(e.currentTarget, 'Reading…', async () => {
  try {
    const { draft: d, notes, problems } = await api('POST', '/api/invoices/parse', { text: $('#said').value });
    showDraft(d, [...problems, ...notes]);
  } catch (err) { toast(err.message); }
}));

$('#send').addEventListener('click', (e) => busy(e.currentTarget, 'Sending…', async () => {
  try {
    const { row } = await api('POST', '/api/invoices', { draft, requestId });
    toast(`Invoice ${row.number} sent to ${row.email} for ${money(row.total, row.currency)}.`, { good: true });
    freshId = row.id;
    pendingRows.set(row.id, row);
    chaseUntilListed();
    $('#check').hidden = true;
    $('#said').value = '';
    draft = null;
    await refresh();
    $('#owed-h').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) { toast(err.message, { ms: 10000 }); }
}));

/* ---------- voice ---------- */

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
if (Recognition) {
  const speak = $('#speak');
  speak.hidden = false;
  $('#lang-wrap').hidden = false;
  let rec = null;
  let base = '';

  const stop = () => { rec?.stop(); };
  speak.addEventListener('click', () => {
    if (rec) return stop();
    rec = new Recognition();
    rec.lang = $('#lang').value;
    rec.interimResults = true;
    rec.continuous = true;
    base = $('#said').value ? `${$('#said').value.trim()} ` : '';
    rec.onresult = (ev) => {
      let heard = '';
      for (const r of ev.results) heard += r[0].transcript;
      $('#said').value = base + heard;
    };
    rec.onerror = (ev) => {
      if (ev.error === 'not-allowed') toast('The microphone is blocked for this site. Allow it in the address bar and try again.');
      else if (ev.error !== 'no-speech' && ev.error !== 'aborted') toast(`Speech input stopped (${ev.error}). You can keep typing.`);
    };
    rec.onend = () => { rec = null; speak.textContent = 'Speak'; speak.classList.remove('listening'); };
    rec.start();
    speak.textContent = 'Stop listening';
    speak.classList.add('listening');
  });
}

/* ---------- the ledger ---------- */

let grid;
let freshId = null;
const STAMP = { draft: 'Draft', open: 'Sent', late: 'Late', paid: 'Paid', closed: 'Closed' };

function stampCell(p) { return h('span', { class: `stamp ${p.value}` }, STAMP[p.value] || p.value); }

function actionCell(p) {
  const r = p.data;
  if (r.state !== 'open' && r.state !== 'late') return h('span');
  const box = h('div', { class: 'row-actions' },
    h('button', { type: 'button', class: 'plain', onclick: () => draftOne(r, box.firstChild) }, 'Draft reminder'));
  if (status.mode === 'mock') {
    box.append(h('button', { type: 'button', class: 'plain', title: 'Demo only: pretend the client paid', onclick: async () => {
      try { await api('POST', `/api/mock/${r.id}/pay`, {}); await refresh(); } catch (err) { toast(err.message); }
    } }, 'Mark paid'));
  }
  return box;
}

function initGrid() {
  grid = agGrid.createGrid($('#grid'), {
    domLayout: 'autoHeight',
    rowData: [],
    suppressCellFocus: true,
    suppressMovableColumns: true,
    animateRows: false,
    getRowId: (p) => p.data.id,
    getRowClass: (p) => (p.data.id === freshId ? 'fresh-row' : ''),
    overlayNoRowsTemplate: '<span>No invoices yet. Describe one above.</span>',
    defaultColDef: { sortable: true, resizable: false },
    columnDefs: [
      { headerName: 'No.', field: 'number', width: 76 },
      { headerName: 'Client', flex: 1.5, minWidth: 150, valueGetter: (p) => (p.data.company ? `${p.data.client}, ${p.data.company}` : p.data.client) },
      { headerName: 'Owed', field: 'due', width: 122, type: 'rightAligned', cellClass: 'num-cell', valueFormatter: (p) => (p.data.due ? money(p.data.due, p.data.currency) : '') },
      { headerName: 'Due', field: 'dueDate', width: 84, valueFormatter: (p) => shortDate(p.value) },
      { headerName: 'Days late', field: 'daysLate', width: 104, type: 'rightAligned', cellClass: 'num-cell', valueFormatter: (p) => (p.value > 0 ? p.value : '') },
      { headerName: 'Status', field: 'state', width: 112, cellRenderer: stampCell, comparator: (a, b) => ['late', 'open', 'draft', 'paid', 'closed'].indexOf(a) - ['late', 'open', 'draft', 'paid', 'closed'].indexOf(b) },
      { headerName: 'Reminders', width: 112, sortable: false, valueGetter: (p) => (p.data.reminders ? `${p.data.reminders} sent` : 'None yet') },
      { headerName: '', width: 250, sortable: false, cellRenderer: actionCell },
    ],
    initialState: { sort: { sortModel: [{ colId: 'state', sort: 'asc' }] } },
  });
}

function renderSummary(summary) {
  const entries = Object.entries(summary).sort((a, b) => CURRENCIES.indexOf(a[0]) - CURRENCIES.indexOf(b[0]));
  const box = $('#summary');
  if (!entries.length) { box.replaceChildren(h('p', {}, 'Nothing is waiting on payment.')); return; }
  box.replaceChildren(...entries.map(([cur, s]) => h('p', {},
    `${money(s.open, cur)} is waiting. `,
    s.late ? h('span', { class: 'late' }, `${money(s.late, cur)} of it is late (${s.lateCount} ${s.lateCount === 1 ? 'invoice' : 'invoices'}).`) : 'None of it is late.')));
}

// PayPal's invoice list can take a few seconds to show an invoice that was just sent.
// Keep the new row on screen meanwhile, and ask again until PayPal includes it.
const pendingRows = new Map();

async function refresh() {
  try {
    const { rows, summary } = await api('GET', `/api/invoices?today=${todayLocal()}`);
    const seen = new Set(rows.map((r) => r.id));
    for (const id of pendingRows.keys()) if (seen.has(id)) pendingRows.delete(id);
    const shown = [...pendingRows.values(), ...rows];
    grid.setGridOption('rowData', shown);
    renderSummary(pendingRows.size ? summarizeRows(shown) : summary);
  } catch (err) { toast(err.message, { ms: 10000 }); }
}

function summarizeRows(rows) {
  const out = {};
  for (const r of rows) {
    if (r.state !== 'open' && r.state !== 'late') continue;
    const s = (out[r.currency] ||= { open: 0, late: 0, lateCount: 0 });
    s.open += r.due;
    if (r.state === 'late') { s.late += r.due; s.lateCount += 1; }
  }
  return out;
}

function chaseUntilListed() {
  for (const ms of [2500, 6000, 12000, 25000]) {
    setTimeout(() => { if (pendingRows.size) refresh(); }, ms);
  }
}

$('#refresh').addEventListener('click', (e) => busy(e.currentTarget, 'Refreshing…', refresh));
setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 60000);

/* ---------- reminders ---------- */

function reminderCard(d) {
  const subject = h('input', { type: 'text', value: d.subject, 'aria-label': `Subject for invoice ${d.number}` });
  const note = h('textarea', { 'aria-label': `Message for invoice ${d.number}` });
  note.value = d.note;
  const after = h('div', { class: 'after actions' });
  const send = h('button', { type: 'button', class: 'primary' }, 'Send reminder');
  const skip = h('button', { type: 'button', class: 'plain' }, 'Skip');
  const card = h('article', { class: 'reminder' },
    h('h3', {}, `Invoice ${d.number} to ${d.client}`,
      d.daysLate != null ? h('span', {}, `, ${d.daysLate} days late${d.due != null ? `, ${money(d.due, d.currency)}` : ''}`) : ''),
    subject, note, after);
  after.append(send, skip);
  send.addEventListener('click', () => busy(send, 'Sending…', async () => {
    try {
      await api('POST', `/api/invoices/${encodeURIComponent(d.id)}/remind`, { subject: subject.value, note: note.value });
      card.classList.add('done');
      subject.disabled = true; note.disabled = true;
      after.replaceChildren(h('span', { class: 'stamp open' }, 'Sent'));
      toast(`Reminder sent for invoice ${d.number}.`, { good: true });
      refresh();
    } catch (err) { toast(err.message, { ms: 10000 }); }
  }));
  skip.addEventListener('click', () => { card.remove(); if (!$('#rem-list').children.length) $('#reminders').hidden = true; });
  return card;
}

function showReminders(cards, hint) {
  $('#rem-list').replaceChildren(...cards);
  $('#rem-hint').textContent = hint;
  $('#reminders').hidden = false;
  $('#reminders').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
}

async function draftOne(row, button) {
  await busy(button, 'Writing…', async () => {
    try {
      const d = await api('POST', `/api/invoices/${encodeURIComponent(row.id)}/reminder-draft`, {});
      showReminders([reminderCard({ ...d, daysLate: row.daysLate, due: row.due, currency: row.currency })], 'Read it, change anything you like, then send. Nothing goes out until you press the button.');
    } catch (err) { toast(err.message, { ms: 10000 }); }
  });
}

$('#chase').addEventListener('click', (e) => busy(e.currentTarget, 'Writing drafts…', async () => {
  try {
    const { drafts, skipped, lateCount } = await api('POST', '/api/chase/plan', {});
    if (!drafts.length) {
      toast(lateCount ? 'Every late invoice has already had its two reminders today.' : 'Nothing is late right now.', { good: !lateCount });
      return;
    }
    const tail = skipped ? ` ${skipped} more late ${skipped === 1 ? 'invoice was' : 'invoices were'} left out to keep this list short.` : '';
    showReminders(drafts.map(reminderCard), `The oldest debts come first, and their tone is firmer.${tail} Nothing goes out until you press Send reminder.`);
  } catch (err) { toast(err.message, { ms: 10000 }); }
}));

/* ---------- start ---------- */

initGrid();
loadStatus().then(refresh).catch((err) => toast(err.message, { ms: 10000 }));

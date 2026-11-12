import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp, TODAY } from './helpers.js';
import { shareToken } from '../src/access.js';

test('lists seeded invoices with late ones flagged and totals per currency', async () => {
  const t = await startApp();
  try {
    const { status, body } = await t.call('GET', `/api/invoices?today=${TODAY}`);
    assert.equal(status, 200);
    const late = body.rows.filter((r) => r.state === 'late');
    assert.equal(late.length, 3);
    assert.ok(body.summary.USD.late > 0);
    assert.ok(body.rows.some((r) => r.state === 'paid'));
  } finally { t.close(); }
});

test('parse turns a model result into a checked draft', async () => {
  const t = await startApp({
    anthropicInput: { client_name: 'Dana Whitfield', client_company: 'Northwind', client_email: null, currency: 'USD', items: [{ name: 'Logo design', quantity: 1, unit_price: 450 }], due_in_days: 15 },
  });
  try {
    const r = await t.call('POST', '/api/invoices/parse', { text: 'Invoiced Dana at Northwind 450 dollars for logo design, 15 days', today: TODAY });
    assert.equal(r.status, 200);
    assert.equal(r.body.draft.due_date, '2026-11-27');
    assert.equal(r.body.draft.client_email, '');
    assert.ok(r.body.notes.some((n) => n.includes('no email')));
    // The text goes to the model as quoted data, with today's date, and a forced tool call.
    const sent = t.client.calls[0];
    assert.equal(sent.tool_choice.name, 'create_invoice');
    assert.ok(sent.messages[0].content.includes('Today is 2026-11-12'));
  } finally { t.close(); }
});

test('parse refuses nearly empty input before spending a model call', async () => {
  const t = await startApp();
  try {
    const r = await t.call('POST', '/api/invoices/parse', { text: 'hi' });
    assert.equal(r.status, 400);
    assert.equal(t.client.calls.length, 0);
  } finally { t.close(); }
});

test('creating an invoice validates server side, then creates and sends it', async () => {
  const t = await startApp({ seed: false });
  try {
    const bad = await t.call('POST', '/api/invoices', { draft: { client_name: 'Dana', items: [] }, today: TODAY });
    assert.equal(bad.status, 422);

    const good = await t.call('POST', '/api/invoices', {
      today: TODAY,
      draft: { client_name: 'Dana Whitfield', client_email: 'dana@northwind.example', currency: 'USD', due_date: '2026-11-27', items: [{ name: 'Logo', quantity: 1, unit_price: 450 }] },
    });
    assert.equal(good.status, 201);
    assert.equal(good.body.row.status, 'SENT');
    assert.equal(good.body.row.total, 450);
    assert.equal(good.body.total, '450.00');
  } finally { t.close(); }
});

test('chase plan drafts only for late invoices, harder tone for older ones, and sends nothing', async () => {
  const t = await startApp({ anthropicInput: (args) => ({ subject: 'Invoice past due', note: `Draft for ${args.system.includes('Direct and professional') ? 'firm' : 'soft'}` }) });
  try {
    const r = await t.call('POST', '/api/chase/plan', { today: TODAY });
    assert.equal(r.status, 200);
    assert.equal(r.body.drafts.length, 3);
    assert.deepEqual(r.body.drafts.map((d) => d.daysLate), [37, 15, 2]);
    assert.deepEqual(r.body.drafts.map((d) => d.level), [3, 2, 1]);
    assert.equal(await t.reminders.countOn(r.body.drafts[0].id, TODAY), 0);
  } finally { t.close(); }
});

test('sending a reminder records it, and the third one in a day is refused', async () => {
  const t = await startApp();
  try {
    const list = await t.call('GET', `/api/invoices?today=${TODAY}`);
    const target = list.body.rows.find((r) => r.state === 'late');
    const msg = { subject: 'Invoice past due', note: 'Please let me know when to expect payment. Thanks', today: TODAY };
    assert.equal((await t.call('POST', `/api/invoices/${target.id}/remind`, msg)).status, 200);
    assert.equal((await t.call('POST', `/api/invoices/${target.id}/remind`, msg)).status, 200);
    const third = await t.call('POST', `/api/invoices/${target.id}/remind`, msg);
    assert.equal(third.status, 429);
    const after = await t.call('GET', `/api/invoices?today=${TODAY}`);
    assert.equal(after.body.rows.find((r) => r.id === target.id).reminders, 2);
  } finally { t.close(); }
});

test('paid invoices cannot be chased', async () => {
  const t = await startApp();
  try {
    const list = await t.call('GET', `/api/invoices?today=${TODAY}`);
    const paid = list.body.rows.find((r) => r.state === 'paid');
    const r = await t.call('POST', `/api/invoices/${paid.id}/remind`, { subject: 's', note: 'n', today: TODAY });
    assert.equal(r.status, 422);
    const d = await t.call('POST', `/api/invoices/${paid.id}/reminder-draft`, { today: TODAY });
    assert.equal(d.status, 422);
  } finally { t.close(); }
});

test('an app password gates everything when one is set', async () => {
  const t = await startApp({ appPassword: 'open-sesame' });
  try {
    assert.equal((await t.call('GET', '/api/status')).status, 401);
    assert.equal((await fetch(`http://127.0.0.1:${t.port}/healthz`)).status, 200);
    const ok = await t.call('GET', '/api/status', null, { Authorization: `Basic ${Buffer.from('x:open-sesame').toString('base64')}` });
    assert.equal(ok.status, 200);
  } finally { t.close(); }
});

test('errors from the model come back as readable messages, not stack traces', async () => {
  const t = await startApp();
  try {
    t.client.messages.create = async () => { throw Object.assign(new Error('overloaded'), { status: 529 }); };
    const r = await t.call('POST', '/api/invoices/parse', { text: 'Invoiced Dana 450 dollars for a logo', today: TODAY });
    assert.equal(r.status, 502);
    assert.match(r.body.error.message, /No AI provider could answer.*529/);
  } finally { t.close(); }
});

test('secret link sets a cookie that skips the password, strangers still need it', async () => {
  const t = await startApp({ appPassword: 'hunter2', accessKey: 'judge-link-key' });
  try {
    const base = `http://127.0.0.1:${t.port}`;
    assert.equal((await fetch(`${base}/api/status`)).status, 401);
    assert.equal((await fetch(`${base}/api/status?key=wrong`)).status, 401);
    assert.equal((await fetch(`${base}/healthz`)).status, 200);

    const hop = await fetch(`${base}/?key=${shareToken('judge-link-key')}`, { redirect: 'manual' });
    assert.equal(hop.status, 302);
    assert.equal(hop.headers.get('location'), '/');
    const cookie = hop.headers.get('set-cookie').split(';')[0];
    assert.doesNotMatch(cookie, /judge-link-key/);
    assert.equal((await fetch(`${base}/?key=judge-link-key`, { redirect: 'manual' })).status, 401, 'the raw ACCESS_KEY is not a valid link');

    assert.equal((await fetch(`${base}/api/status`, { headers: { cookie } })).status, 200);
    assert.equal((await fetch(`${base}/api/status`, { headers: { cookie: 'parley_access=nope' } })).status, 401);
    const basic = Buffer.from('x:hunter2').toString('base64');
    assert.equal((await fetch(`${base}/api/status`, { headers: { authorization: `Basic ${basic}` } })).status, 200);
  } finally { t.close(); }
});

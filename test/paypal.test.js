import test from 'node:test';
import assert from 'node:assert/strict';
import { PayPalClient, PayPalError } from '../src/paypal.js';

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url, ...opts });
    const key = `${opts.method || 'GET'} ${url.replace('https://api-m.sandbox.paypal.com', '').split('?')[0]}`;
    const handler = routes[key];
    if (!handler) return new Response(JSON.stringify({ name: 'NOT_FOUND', message: key }), { status: 404 });
    const out = typeof handler === 'function' ? handler(opts, url) : handler;
    return new Response(JSON.stringify(out.body ?? {}), { status: out.status ?? 200 });
  };
  fn.calls = calls;
  return fn;
}

const client = (routes) => new PayPalClient({ clientId: 'id', secret: 'sec', baseUrl: 'https://api-m.sandbox.paypal.com', fetchImpl: fakeFetch(routes) });

test('gets a token once and reuses it, sending basic auth', async () => {
  const c = client({
    'POST /v1/oauth2/token': { body: { access_token: 'tok', expires_in: 3600 } },
    'POST /v2/invoicing/generate-next-invoice-number': { body: { invoice_number: '0042' } },
  });
  assert.equal(await c.nextInvoiceNumber(), '0042');
  assert.equal(await c.nextInvoiceNumber(), '0042');
  const tokenCalls = c.fetch.calls.filter((x) => x.url.endsWith('/v1/oauth2/token'));
  assert.equal(tokenCalls.length, 1);
  assert.equal(tokenCalls[0].headers.Authorization, `Basic ${Buffer.from('id:sec').toString('base64')}`);
  assert.equal(c.fetch.calls.at(-1).headers.Authorization, 'Bearer tok');
});

test('bad credentials give a plain explanation', async () => {
  const c = client({ 'POST /v1/oauth2/token': { status: 401, body: { error: 'invalid_client' } } });
  await assert.rejects(c.nextInvoiceNumber(), (e) => e instanceof PayPalError && /sandbox credentials/.test(e.message));
});

test('createDraft finds the id whether PayPal returns id or a self link', async () => {
  const token = { 'POST /v1/oauth2/token': { body: { access_token: 't', expires_in: 3600 } } };
  const a = client({ ...token, 'POST /v2/invoicing/invoices': { status: 201, body: { id: 'INV2-AAA' } } });
  assert.equal(await a.createDraft({}), 'INV2-AAA');
  const b = client({ ...token, 'POST /v2/invoicing/invoices': { status: 201, body: { rel: 'self', href: 'https://api.sandbox.paypal.com/v2/invoicing/invoices/INV2-BBB', method: 'GET' } } });
  assert.equal(await b.createDraft({}), 'INV2-BBB');
  assert.ok(a.fetch.calls.at(-1).headers['PayPal-Request-Id']);
});

test('errors carry PayPal details and the debug id', async () => {
  const c = client({
    'POST /v1/oauth2/token': { body: { access_token: 't', expires_in: 3600 } },
    'POST /v2/invoicing/invoices/INV2-X/remind': { status: 422, body: { name: 'UNPROCESSABLE_ENTITY', message: 'bad', debug_id: 'abc123', details: [{ issue: 'INVOICE_NOT_PAYABLE', description: 'Invoice is not payable.' }] } },
  });
  await assert.rejects(c.remind('INV2-X', { subject: 's', note: 'n' }), (e) => e.debugId === 'abc123' && /INVOICE_NOT_PAYABLE/.test(e.message));
});

test('send and remind post the documented fields', async () => {
  const c = client({
    'POST /v1/oauth2/token': { body: { access_token: 't', expires_in: 3600 } },
    'POST /v2/invoicing/invoices/INV2-X/send': {},
    'POST /v2/invoicing/invoices/INV2-X/remind': {},
  });
  await c.send('INV2-X');
  await c.remind('INV2-X', { subject: 'Past due', note: 'Please pay' });
  const [send, remind] = c.fetch.calls.filter((x) => x.url.includes('/INV2-X/')).map((x) => JSON.parse(x.body));
  assert.deepEqual(send, { send_to_recipient: true, send_to_invoicer: false });
  assert.deepEqual(remind, { subject: 'Past due', note: 'Please pay', send_to_invoicer: false });
});

test('list walks pages until total_pages', async () => {
  const c = client({
    'POST /v1/oauth2/token': { body: { access_token: 't', expires_in: 3600 } },
    'GET /v2/invoicing/invoices': (_o, url) => (url.includes('page=1') ? { body: { items: [{ id: 'a' }], total_pages: 2 } } : { body: { items: [{ id: 'b' }], total_pages: 2 } }),
  });
  assert.deepEqual((await c.list()).map((i) => i.id), ['a', 'b']);
});

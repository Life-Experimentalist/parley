import test from 'node:test';
import assert from 'node:assert/strict';
import { addDays, centsToString, daysBetween, toCents, totalCents } from '../src/money.js';
import { DraftError, normalizeDraft, toPayPalInvoice } from '../src/draft.js';
import { reminderLevel, summarize, toRow } from '../src/invoices.js';
import { TODAY } from './helpers.js';

test('money works in cents, not floats', () => {
  assert.equal(toCents(0.1) + toCents(0.2), 30);
  assert.equal(centsToString(123456), '1234.56');
  assert.equal(centsToString(5), '0.05');
  assert.equal(totalCents([{ quantity: 2.5, unit_price: 45 }, { quantity: 1, unit_price: 0.1 }]), 11260);
});

test('date helpers', () => {
  assert.equal(addDays('2026-11-30', 1), '2026-12-01');
  assert.equal(daysBetween('2026-11-01', '2026-11-12'), 11);
});

test('normalizeDraft fills sensible defaults and says so', () => {
  const { draft, notes } = normalizeDraft(
    { client_name: 'Dana Whitfield', client_email: 'dana@northwind.example', currency: null, items: [{ name: 'Logo', quantity: 1, unit_price: 450 }] },
    { today: TODAY },
  );
  assert.equal(draft.currency, 'USD');
  assert.equal(draft.due_date, '2026-11-27');
  assert.ok(notes.some((n) => n.includes('assumed USD')));
  assert.ok(notes.some((n) => n.includes('15 days')));
});

test('normalizeDraft flags a missing email and refuses it when strict', () => {
  const raw = { client_name: 'Dana', items: [{ name: 'Logo', quantity: 1, unit_price: 450 }] };
  const loose = normalizeDraft(raw, { today: TODAY });
  assert.equal(loose.draft.client_email, '');
  assert.ok(loose.notes.some((n) => n.includes('no email')));
  assert.throws(() => normalizeDraft(raw, { today: TODAY, strict: true }), DraftError);
});

test('normalizeDraft rejects junk amounts and unsupported currencies', () => {
  const r = normalizeDraft(
    { client_name: 'Dana', client_email: 'd@x.example', currency: 'INR', items: [{ name: 'A', quantity: 1, unit_price: -5 }, { name: 'B', quantity: 0, unit_price: 10 }] },
    { today: TODAY },
  );
  assert.equal(r.draft.items.length, 0);
  assert.ok(r.problems.length >= 3);
});

test('normalizeDraft does not trust html or giant strings', () => {
  const r = normalizeDraft(
    { client_name: `<img src=x onerror=alert(1)>${'a'.repeat(500)}`, client_email: 'd@x.example', items: [{ name: 'x'.repeat(900), quantity: 1, unit_price: 5 }] },
    { today: TODAY },
  );
  assert.ok(r.draft.client_name.length <= 120);
  assert.ok(r.draft.items[0].name.length <= 200);
});

test('toPayPalInvoice matches the Invoicing v2 shape', () => {
  const { draft } = normalizeDraft(
    { client_name: 'Dana Whitfield', client_company: 'Northwind', client_email: 'dana@northwind.example', currency: 'USD', due_in_days: 15, items: [{ name: 'Logo', quantity: 1, unit_price: 450 }, { name: 'Revisions', quantity: 2, unit_price: 60 }] },
    { today: TODAY },
  );
  const body = toPayPalInvoice(draft, { invoiceNumber: '0007', today: TODAY });
  assert.equal(body.detail.invoice_number, '0007');
  assert.equal(body.detail.currency_code, 'USD');
  assert.deepEqual(body.detail.payment_term, { term_type: 'DUE_ON_DATE_SPECIFIED', due_date: '2026-11-27' });
  assert.deepEqual(body.primary_recipients[0].billing_info.name, { given_name: 'Dana', surname: 'Whitfield' });
  assert.equal(body.primary_recipients[0].billing_info.business_name, 'Northwind');
  assert.equal(body.items[1].quantity, '2');
  assert.equal(body.items[1].unit_amount.value, '60.00');
});

test('rows know when an invoice is late, paid, or still a draft', () => {
  const base = { id: 'A', detail: { invoice_number: '1', payment_term: { due_date: '2026-11-01' } }, amount: { currency_code: 'USD', value: '100.00' }, due_amount: { currency_code: 'USD', value: '100.00' }, primary_recipients: [{ billing_info: { name: { given_name: 'Z' }, email_address: 'z@x.example' } }] };
  assert.equal(toRow({ ...base, status: 'SENT' }, { today: TODAY }).state, 'late');
  assert.equal(toRow({ ...base, status: 'SENT' }, { today: TODAY }).daysLate, 11);
  assert.equal(toRow({ ...base, status: 'SENT', detail: { ...base.detail, payment_term: { due_date: TODAY } } }, { today: TODAY }).state, 'open');
  assert.equal(toRow({ ...base, status: 'PAID' }, { today: TODAY }).state, 'paid');
  assert.equal(toRow({ ...base, status: 'DRAFT' }, { today: TODAY }).state, 'draft');
});

test('reminder tone steps up with lateness and earlier reminders', () => {
  assert.equal(reminderLevel({ daysLate: 3, reminders: 0 }), 1);
  assert.equal(reminderLevel({ daysLate: 10, reminders: 0 }), 2);
  assert.equal(reminderLevel({ daysLate: 3, reminders: 1 }), 2);
  assert.equal(reminderLevel({ daysLate: 30, reminders: 0 }), 3);
  assert.equal(reminderLevel({ daysLate: 3, reminders: 2 }), 3);
});

test('summary only counts money still owed, per currency', () => {
  const rows = [
    { state: 'late', currency: 'USD', due: 100 },
    { state: 'open', currency: 'USD', due: 50 },
    { state: 'paid', currency: 'USD', due: 0 },
    { state: 'late', currency: 'EUR', due: 10 },
  ];
  assert.deepEqual(summarize(rows), { USD: { open: 150, late: 100, lateCount: 1 }, EUR: { open: 10, late: 10, lateCount: 1 } });
});

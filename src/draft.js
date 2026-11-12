import { CURRENCIES, DEFAULT_TERMS_DAYS } from './config.js';
import { addDays, isIsoDate, toCents, totalCents } from './money.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export class DraftError extends Error {
  constructor(problems) {
    super(problems.join(' '));
    this.problems = problems;
  }
}

const clean = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * Turns whatever the model (or the browser) hands us into an invoice draft we trust.
 * Nothing downstream reads the raw input. Returns { draft, notes } where notes are
 * plain sentences for the person to read before they send.
 */
export function normalizeDraft(raw, { today, strict = false }) {
  const notes = [];
  const problems = [];
  const input = raw && typeof raw === 'object' ? raw : {};

  const name = clean(input.client_name ?? input.client?.name, 120);
  const company = clean(input.client_company ?? input.client?.company, 120);
  if (!name && !company) problems.push('Add who the invoice is for.');

  let email = clean(input.client_email ?? input.client?.email, 200).toLowerCase();
  if (!EMAIL_RE.test(email)) {
    if (email) notes.push(`"${email}" doesn't look like an email address.`);
    else notes.push('There was no email address. PayPal needs one to send the invoice.');
    email = '';
  }

  let currency = clean(input.currency, 3).toUpperCase();
  if (!CURRENCIES.includes(currency)) {
    if (currency) notes.push(`${currency} isn't supported here. Pick one of ${CURRENCIES.join(', ')}.`);
    else notes.push('No currency was mentioned, so I assumed USD.');
    currency = currency && !CURRENCIES.includes(currency) ? '' : 'USD';
  }
  if (!currency) problems.push('Pick a currency from the list.');

  const items = [];
  for (const it of Array.isArray(input.items) ? input.items.slice(0, 20) : []) {
    const itemName = clean(it?.name, 200);
    const quantity = Number(it?.quantity ?? 1);
    const price = Number(it?.unit_price);
    if (!itemName) continue;
    if (!(quantity > 0 && quantity <= 10000)) {
      problems.push(`"${itemName}" needs a quantity above zero.`);
      continue;
    }
    if (!(price > 0 && price <= 1000000)) {
      problems.push(`"${itemName}" needs a price above zero.`);
      continue;
    }
    items.push({
      name: itemName,
      quantity: Math.round(quantity * 1000) / 1000,
      unit_price: toCents(price) / 100,
    });
  }
  if (items.length === 0) problems.push('Add at least one line with a price.');

  let dueDate = '';
  if (isIsoDate(input.due_date)) {
    dueDate = input.due_date;
  } else if (Number.isFinite(Number(input.due_in_days)) && input.due_in_days !== null && Number(input.due_in_days) >= 0) {
    dueDate = addDays(today, Math.min(Math.round(Number(input.due_in_days)), 365));
  } else {
    dueDate = addDays(today, DEFAULT_TERMS_DAYS);
    notes.push(`No due date was given, so I set it ${DEFAULT_TERMS_DAYS} days out.`);
  }
  if (dueDate < today) {
    if (strict) problems.push('The due date is already in the past.');
    else notes.push('That due date is already in the past.');
  }

  const note = clean(input.note, 500);

  const draft = {
    client_name: name,
    client_company: company,
    client_email: email,
    currency,
    items,
    due_date: dueDate,
    note,
  };

  if (strict) {
    if (!email) problems.push('Add an email address for the client.');
    if (problems.length) throw new DraftError(problems);
  }
  const total = totalCents(items);
  return { draft, notes, problems, total_cents: total };
}

/** Builds the body PayPal's Invoicing v2 create endpoint expects. */
export function toPayPalInvoice(draft, { invoiceNumber, today }) {
  const parts = draft.client_name.split(' ').filter(Boolean);
  const billingName = parts.length > 1
    ? { given_name: parts.slice(0, -1).join(' '), surname: parts[parts.length - 1] }
    : parts.length === 1 ? { given_name: parts[0] } : undefined;

  const billing_info = { email_address: draft.client_email };
  if (billingName) billing_info.name = billingName;
  if (draft.client_company) billing_info.business_name = draft.client_company;

  const detail = {
    invoice_number: invoiceNumber,
    invoice_date: today,
    currency_code: draft.currency,
    payment_term: { term_type: 'DUE_ON_DATE_SPECIFIED', due_date: draft.due_date },
  };
  if (draft.note) detail.note = draft.note;

  return {
    detail,
    primary_recipients: [{ billing_info }],
    items: draft.items.map((it) => ({
      name: it.name,
      quantity: String(it.quantity),
      unit_amount: { currency_code: draft.currency, value: (toCents(it.unit_price) / 100).toFixed(2) },
      unit_of_measure: 'QUANTITY',
    })),
    configuration: {
      allow_tip: false,
      partial_payment: { allow_partial_payment: false },
    },
  };
}

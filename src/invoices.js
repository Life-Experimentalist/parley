import { daysBetween } from './money.js';

const PAID = new Set(['PAID', 'MARKED_AS_PAID']);
const CLOSED = new Set(['CANCELLED', 'REFUNDED', 'MARKED_AS_REFUNDED', 'PARTIALLY_REFUNDED']);

function clientName(inv) {
  const bi = inv.primary_recipients?.[0]?.billing_info || {};
  const n = bi.name || {};
  const person = n.full_name || [n.given_name, n.surname].filter(Boolean).join(' ');
  return { name: person || bi.business_name || bi.email_address || 'Unknown client', business: bi.business_name || '', email: bi.email_address || '' };
}

/** Flattens a PayPal invoice into the row the screen shows. */
export function toRow(inv, { today, reminders = [] }) {
  const detail = inv.detail || {};
  const who = clientName(inv);
  const currency = inv.amount?.currency_code || detail.currency_code || 'USD';
  const total = Number(inv.amount?.value ?? 0);
  const due = Number(inv.due_amount?.value ?? inv.amount?.value ?? 0);
  const dueDate = detail.payment_term?.due_date || '';
  const status = inv.status || 'DRAFT';

  let state = 'open';
  if (status === 'DRAFT') state = 'draft';
  else if (PAID.has(status)) state = 'paid';
  else if (CLOSED.has(status)) state = 'closed';

  let daysLate = 0;
  if (state === 'open' && dueDate) {
    daysLate = Math.max(0, daysBetween(dueDate, today));
    if (daysLate > 0) state = 'late';
  }

  return {
    id: inv.id,
    number: detail.invoice_number || '',
    client: who.name,
    company: who.business,
    email: who.email,
    currency,
    total,
    due: state === 'paid' || state === 'closed' ? 0 : due,
    dueDate,
    daysLate,
    status,
    state,
    reminders: reminders.length,
    lastReminder: reminders.length ? reminders[reminders.length - 1].at : null,
    items: (inv.items || []).map((i) => i.name).slice(0, 3),
  };
}

export function summarize(rows) {
  const byCurrency = {};
  for (const r of rows) {
    if (r.state !== 'open' && r.state !== 'late') continue;
    const c = (byCurrency[r.currency] ||= { open: 0, late: 0, lateCount: 0 });
    c.open += r.due;
    if (r.state === 'late') {
      c.late += r.due;
      c.lateCount += 1;
    }
  }
  return byCurrency;
}

/** How firm a reminder should be. Decided here, not by the model. */
export function reminderLevel(row) {
  if (row.reminders >= 2 || row.daysLate > 21) return 3;
  if (row.reminders >= 1 || row.daysLate > 7) return 2;
  return 1;
}

// Money is handled in integer minor units (cents) so 0.1 + 0.2 never shows up on an invoice.

export function toCents(value) {
  const n = typeof value === 'string' ? Number(value.replace(/,/g, '')) : value;
  if (!Number.isFinite(n)) return NaN;
  return Math.round(n * 100);
}

export function centsToString(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

export function lineCents(item) {
  return Math.round(Number(item.quantity) * toCents(item.unit_price));
}

export function totalCents(items) {
  return items.reduce((sum, it) => sum + lineCents(it), 0);
}

export function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(fromIso, toIso) {
  const ms = new Date(`${toIso}T00:00:00Z`) - new Date(`${fromIso}T00:00:00Z`);
  return Math.round(ms / 86400000);
}

export function isIsoDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
}

export function todayIso(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

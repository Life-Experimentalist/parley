// Puts a few sample invoices in your PayPal sandbox, some already past due, so the
// ledger has something to chase. Run it once: `npm run seed`.
import { config } from '../src/config.js';
import { PayPalClient } from '../src/paypal.js';
import { toPayPalInvoice, normalizeDraft } from '../src/draft.js';
import { addDays, todayIso } from '../src/money.js';

if (config.paypalMode !== 'sandbox') {
  console.error('No PayPal sandbox keys found in .env, so there is nothing to seed.');
  process.exit(1);
}

const pp = new PayPalClient({ clientId: config.paypalClientId, secret: config.paypalSecret, baseUrl: config.paypalBase });
const today = todayIso();

const samples = [
  { name: 'Northwind Traders', email: 'accounts@northwind.example', currency: 'USD', item: 'Logo and brand sheet', price: 1200, billedDaysAgo: 52, terms: 15 },
  { name: 'Harbor Finch', email: 'billing@harborfinch.example', currency: 'GBP', item: 'Landing page copy', price: 640, billedDaysAgo: 30, terms: 15 },
  { name: 'Lena Okafor', email: 'lena@okaforstudio.example', currency: 'USD', item: 'Six spot illustrations', price: 510, billedDaysAgo: 9, terms: 7 },
  { name: 'Tidewell Labs', email: 'ap@tidewell.example', currency: 'EUR', item: 'API documentation, 20 hours', price: 900, billedDaysAgo: 5, terms: 30 },
];

for (const s of samples) {
  const invoiceDate = addDays(today, -s.billedDaysAgo);
  const { draft } = normalizeDraft({
    client_name: s.name,
    client_email: s.email,
    currency: s.currency,
    items: [{ name: s.item, quantity: 1, unit_price: s.price }],
    due_date: addDays(invoiceDate, s.terms),
  }, { today: invoiceDate });
  try {
    const number = await pp.nextInvoiceNumber();
    const id = await pp.createDraft(toPayPalInvoice(draft, { invoiceNumber: number, today: invoiceDate }));
    await pp.send(id);
    console.log(`  sent ${number} to ${s.name}, due ${draft.due_date}`);
  } catch (err) {
    console.log(`  skipped ${s.name}: ${err.message}`);
    console.log('        If PayPal refuses a past date, edit billedDaysAgo in scripts/seed.js to a smaller number.');
  }
}

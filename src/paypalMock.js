import { PayPalError } from './paypal.js';
import { addDays, centsToString, todayIso, totalCents, toCents } from './money.js';

/**
 * In-memory stand-in with the same methods as PayPalClient. Used when no sandbox
 * keys are set, and in the tests. The data is made up and the UI says so.
 */
export class MockPayPal {
  constructor({ now = () => todayIso(), seed = true } = {}) {
    this.mode = 'mock';
    this.now = now;
    this.invoices = new Map();
    this.counter = 0;
    this.remindersToday = new Map();
    if (seed) this.seedDemo();
  }

  seedDemo() {
    const t = this.now();
    const rows = [
      ['Northwind Traders', 'accounts@northwind.example', 'USD', [['Logo and brand sheet', 1, 1200]], -52, 15, 'SENT'],
      ['Harbor & Finch', 'billing@harborfinch.example', 'GBP', [['Landing page copy', 1, 640]], -30, 15, 'SENT'],
      ['Lena Okafor', 'lena@okaforstudio.example', 'USD', [['Illustration, 6 spot drawings', 6, 85]], -9, 7, 'SENT'],
      ['Tidewell Labs', 'ap@tidewell.example', 'EUR', [['API documentation, 20 hours', 20, 45]], -5, 30, 'SENT'],
      ['Brightpath Co', 'pay@brightpath.example', 'USD', [['Monthly retainer, October', 1, 900]], -40, 15, 'PAID'],
    ];
    for (const [name, email, currency, items, offset, terms, status] of rows) {
      const invoiceDate = addDays(t, offset);
      const id = this.insert({
        draft: {
          client_name: name,
          client_email: email,
          currency,
          items: items.map(([n, q, p]) => ({ name: n, quantity: q, unit_price: p })),
          due_date: addDays(invoiceDate, terms),
        },
        invoiceDate,
        status,
      });
      this.invoices.get(id).seeded = true;
    }
  }

  insert({ draft, invoiceDate, status }) {
    this.counter += 1;
    const id = `INV2-MOCK-${String(this.counter).padStart(4, '0')}`;
    const parts = draft.client_name.split(' ');
    const total = totalCents(draft.items);
    this.invoices.set(id, {
      id,
      status,
      detail: {
        invoice_number: String(this.counter).padStart(4, '0'),
        invoice_date: invoiceDate,
        currency_code: draft.currency,
        payment_term: { term_type: 'DUE_ON_DATE_SPECIFIED', due_date: draft.due_date },
      },
      primary_recipients: [{
        billing_info: {
          name: parts.length > 1 ? { given_name: parts.slice(0, -1).join(' '), surname: parts.at(-1) } : { given_name: parts[0] },
          email_address: draft.client_email,
          business_name: draft.client_company || undefined,
        },
      }],
      items: draft.items.map((i) => ({ name: i.name, quantity: String(i.quantity), unit_amount: { currency_code: draft.currency, value: centsToString(toCents(i.unit_price)) } })),
      amount: { currency_code: draft.currency, value: centsToString(total) },
      due_amount: { currency_code: draft.currency, value: status === 'PAID' ? '0.00' : centsToString(total) },
    });
    return id;
  }

  async nextInvoiceNumber() {
    return String(this.counter + 1).padStart(4, '0');
  }

  async createDraft(invoice) {
    const items = invoice.items.map((i) => ({ name: i.name, quantity: Number(i.quantity), unit_price: Number(i.unit_amount.value) }));
    const bi = invoice.primary_recipients[0].billing_info;
    const name = [bi.name?.given_name, bi.name?.surname].filter(Boolean).join(' ') || bi.business_name;
    return this.insert({
      draft: {
        client_name: name,
        client_company: bi.business_name,
        client_email: bi.email_address,
        currency: invoice.detail.currency_code,
        items,
        due_date: invoice.detail.payment_term.due_date,
      },
      invoiceDate: invoice.detail.invoice_date,
      status: 'DRAFT',
    });
  }

  async send(id) {
    const inv = this.require(id);
    if (inv.status !== 'DRAFT') throw new PayPalError('PayPal said no (422): INVOICE_ALREADY_SENT', { status: 422 });
    inv.status = 'SENT';
    return {};
  }

  async remind(id) {
    const inv = this.require(id);
    if (inv.status !== 'SENT') throw new PayPalError('PayPal said no (422): INVOICE_NOT_PAYABLE', { status: 422 });
    const key = `${id}:${this.now()}`;
    const n = (this.remindersToday.get(key) || 0) + 1;
    if (n > 2) throw new PayPalError('PayPal said no (422): only two reminders a day per invoice.', { status: 422 });
    this.remindersToday.set(key, n);
    return {};
  }

  async get(id) {
    return this.require(id);
  }

  async list() {
    return [...this.invoices.values()].reverse();
  }

  // Demo-only: stands in for the client paying from their own PayPal account.
  async markPaid(id) {
    const inv = this.require(id);
    inv.status = 'PAID';
    inv.due_amount = { ...inv.due_amount, value: '0.00' };
  }

  require(id) {
    const inv = this.invoices.get(id);
    if (!inv) throw new PayPalError('PayPal said no (404): INVOICE_NOT_FOUND', { status: 404 });
    return inv;
  }
}

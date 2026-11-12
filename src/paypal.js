import { randomUUID } from 'node:crypto';

export class PayPalError extends Error {
  constructor(message, { status, name, debugId, details } = {}) {
    super(message);
    this.status = status;
    this.paypalName = name;
    this.debugId = debugId;
    this.details = details;
  }
}

/**
 * Thin client for the PayPal Invoicing v2 API (sandbox).
 * Every method here maps to exactly one documented endpoint.
 */
export class PayPalClient {
  constructor({ clientId, secret, baseUrl, fetchImpl = fetch }) {
    this.clientId = clientId;
    this.secret = secret;
    this.baseUrl = baseUrl;
    this.fetch = fetchImpl;
    this.cached = null;
    this.mode = 'sandbox';
  }

  async token() {
    if (this.cached && this.cached.expiresAt > Date.now() + 60_000) return this.cached.value;
    const basic = Buffer.from(`${this.clientId}:${this.secret}`).toString('base64');
    const res = await this.fetch(`${this.baseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new PayPalError('PayPal rejected the client ID and secret. Check they are sandbox credentials.', {
        status: res.status,
        name: body.error,
      });
    }
    this.cached = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    return this.cached.value;
  }

  async call(method, path, body, headers = {}) {
    const token = await this.token();
    const res = await this.fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }
    if (!res.ok) {
      const first = json.details?.[0];
      const detail = first ? `${first.issue || ''} ${first.description || ''}`.trim() : '';
      throw new PayPalError(`PayPal said no (${res.status}): ${json.message || json.name || 'unknown error'}${detail ? `. ${detail}` : ''}`, {
        status: res.status,
        name: json.name,
        debugId: json.debug_id,
        details: json.details,
      });
    }
    return json;
  }

  async nextInvoiceNumber() {
    const r = await this.call('POST', '/v2/invoicing/generate-next-invoice-number', {});
    return r.invoice_number;
  }

  /** Creates a draft. Returns the new invoice id. */
  async createDraft(invoice, requestId = randomUUID()) {
    const r = await this.call('POST', '/v2/invoicing/invoices', invoice, { 'PayPal-Request-Id': requestId });
    const fromHref = (h) => (typeof h === 'string' ? h.split('/').pop() : '');
    return r.id || fromHref(r.href) || fromHref(r.links?.find((l) => l.rel === 'self')?.href);
  }

  async send(id, { subject, note } = {}) {
    const body = { send_to_recipient: true, send_to_invoicer: false };
    if (subject) body.subject = subject;
    if (note) body.note = note;
    return this.call('POST', `/v2/invoicing/invoices/${encodeURIComponent(id)}/send`, body);
  }

  async remind(id, { subject, note }) {
    return this.call('POST', `/v2/invoicing/invoices/${encodeURIComponent(id)}/remind`, {
      subject,
      note,
      send_to_invoicer: false,
    });
  }

  async get(id) {
    return this.call('GET', `/v2/invoicing/invoices/${encodeURIComponent(id)}`);
  }

  /** Newest first. Pulls up to 300 invoices, which is plenty for one freelancer. */
  async list() {
    const out = [];
    for (let page = 1; page <= 3; page += 1) {
      const r = await this.call('GET', `/v2/invoicing/invoices?page=${page}&page_size=100&total_required=true`);
      out.push(...(r.items || []));
      if (page >= (r.total_pages || 1)) break;
    }
    return out;
  }
}

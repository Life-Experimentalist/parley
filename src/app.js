import crypto from 'node:crypto';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_REMINDERS_PER_DAY } from './config.js';
import { DraftError, normalizeDraft, toPayPalInvoice } from './draft.js';
import { reminderLevel, summarize, toRow } from './invoices.js';
import { centsToString, todayIso, isIsoDate } from './money.js';
import { PayPalError } from './paypal.js';
import { AiError } from './ai.js';
import { cookieToken, shareToken } from './access.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const modules = path.join(root, '..', 'node_modules');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function timingSafeEqual(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/** Keeps a leaked URL from becoming a free model endpoint. */
function rateLimit(limit, windowMs = 3600_000) {
  const hits = new Map();
  return (req, _res, next) => {
    const now = Date.now();
    const key = req.ip;
    const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (recent.length >= limit) return next(new HttpError(429, 'Too many model requests from this address this hour. Try again later.'));
    recent.push(now);
    hits.set(key, recent);
    next();
  };
}

export function createApp({ paypal, ai, reminders, config, now = () => new Date() }) {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '50kb' }));

  // Render's health check cannot send a password, so this one path stays open.
  app.get('/healthz', (_req, res) => res.type('text').send('ok'));

  if (config.appPassword) {
    const cookieValue = config.accessKey ? cookieToken(config.accessKey) : '';
    const linkToken = config.accessKey ? shareToken(config.accessKey) : '';
    const readCookie = (req, name) => {
      for (const part of String(req.headers.cookie || '').split(';')) {
        const [k, ...v] = part.trim().split('=');
        if (k === name) return v.join('=');
      }
      return '';
    };
    app.use((req, res, next) => {
      if (config.accessKey) {
        // Visiting the secret link once sets a cookie, then the key is dropped from the address bar.
        if (typeof req.query.key === 'string' && timingSafeEqual(req.query.key, linkToken)) {
          res.cookie('parley_access', cookieValue, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 30 * 24 * 3600 * 1000 });
          return res.redirect(302, req.path);
        }
        if (timingSafeEqual(readCookie(req, 'parley_access'), cookieValue)) return next();
      }
      const header = req.headers.authorization || '';
      const [scheme, encoded] = header.split(' ');
      if (scheme === 'Basic' && encoded) {
        const pass = Buffer.from(encoded, 'base64').toString().split(':').slice(1).join(':');
        if (timingSafeEqual(pass, config.appPassword)) return next();
      }
      res.set('WWW-Authenticate', 'Basic realm="Parley"');
      res.status(401).send('Password needed.');
    });
  }

  const today = (req) => {
    const fromClient = req.body?.today || req.query?.today;
    return isIsoDate(fromClient) ? fromClient : todayIso(now());
  };

  const loadRows = async (day) => {
    const [list, log] = await Promise.all([paypal.list(), reminders.all()]);
    return list.map((inv) => toRow(inv, { today: day, reminders: log[inv.id] || [] }));
  };

  // Static files
  app.use(express.static(path.join(root, '..', 'public')));
  app.use('/vendor/ag', express.static(path.join(modules, 'ag-grid-community', 'dist')));
  app.use('/vendor/ag-styles', express.static(path.join(modules, 'ag-grid-community', 'styles')));
  app.use('/vendor/hind', express.static(path.join(modules, '@fontsource', 'hind')));
  app.use('/vendor/yatra', express.static(path.join(modules, '@fontsource', 'yatra-one')));

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  app.get('/api/status', (_req, res) => {
    res.json({ mode: paypal.mode, ai: ai.ready, model: ai.model, providers: ai.describe?.() || [], last: ai.last || null });
  });

  app.get('/api/invoices', wrap(async (req, res) => {
    const rows = await loadRows(today(req));
    res.json({ rows, summary: summarize(rows) });
  }));

  app.post('/api/invoices/parse', rateLimit(config.aiCallsPerHour), wrap(async (req, res) => {
    const text = String(req.body?.text || '').trim();
    if (text.length < 8) throw new HttpError(400, 'Say or type a bit more: who you billed, for what, and how much.');
    const day = today(req);
    const raw = await ai.parseInvoice(text, { today: day });
    const { draft, notes, problems } = normalizeDraft(raw, { today: day });
    res.json({ draft, notes, problems });
  }));

  app.post('/api/invoices', wrap(async (req, res) => {
    const day = today(req);
    let checked;
    try {
      checked = normalizeDraft(req.body?.draft, { today: day, strict: true });
    } catch (err) {
      if (err instanceof DraftError) throw new HttpError(422, err.problems.join(' '));
      throw err;
    }
    const requestId = String(req.body?.requestId || crypto.randomUUID()).slice(0, 60);
    const number = await paypal.nextInvoiceNumber();
    const id = await paypal.createDraft(toPayPalInvoice(checked.draft, { invoiceNumber: number, today: day }), requestId);
    await paypal.send(id);
    const sent = await paypal.get(id);
    res.status(201).json({ row: toRow(sent, { today: day }), total: centsToString(checked.total_cents) });
  }));

  app.post('/api/invoices/:id/reminder-draft', rateLimit(config.aiCallsPerHour), wrap(async (req, res) => {
    const day = today(req);
    const rows = await loadRows(day);
    const row = rows.find((r) => r.id === req.params.id);
    if (!row) throw new HttpError(404, 'That invoice is not in your list.');
    if (row.state !== 'open' && row.state !== 'late') throw new HttpError(422, 'Only unpaid, sent invoices can get a reminder.');
    const level = reminderLevel(row);
    res.json({ id: row.id, number: row.number, client: row.client, ...(await ai.draftReminder(row, { level, today: day })) });
  }));

  // Looks at every late invoice and prepares a draft for each. Nothing is sent from here.
  app.post('/api/chase/plan', rateLimit(config.aiCallsPerHour), wrap(async (req, res) => {
    const day = today(req);
    const rows = (await loadRows(day)).filter((r) => r.state === 'late');
    const log = reminders;
    const eligible = [];
    for (const r of rows) {
      if ((await log.countOn(r.id, day)) < MAX_REMINDERS_PER_DAY) eligible.push(r);
    }
    eligible.sort((a, b) => b.daysLate - a.daysLate);
    const picked = eligible.slice(0, 6);
    const drafts = await Promise.all(picked.map(async (r) => {
      const level = reminderLevel(r);
      const d = await ai.draftReminder(r, { level, today: day });
      return { id: r.id, number: r.number, client: r.client, email: r.email, currency: r.currency, due: r.due, daysLate: r.daysLate, ...d };
    }));
    res.json({ drafts, skipped: eligible.length - picked.length, lateCount: rows.length });
  }));

  app.post('/api/invoices/:id/remind', wrap(async (req, res) => {
    const day = today(req);
    const subject = String(req.body?.subject || '').trim().slice(0, 200);
    const note = String(req.body?.note || '').trim().slice(0, 4000);
    if (!subject || !note) throw new HttpError(400, 'A reminder needs a subject and a message.');
    const rows = await loadRows(day);
    const row = rows.find((r) => r.id === req.params.id);
    if (!row) throw new HttpError(404, 'That invoice is not in your list.');
    if (row.state !== 'open' && row.state !== 'late') throw new HttpError(422, 'That invoice is not waiting on payment.');
    if ((await reminders.countOn(row.id, day)) >= MAX_REMINDERS_PER_DAY) {
      throw new HttpError(429, 'PayPal allows two reminders a day for one invoice, and both are used. Try tomorrow.');
    }
    await paypal.remind(row.id, { subject, note });
    // The reminder is already out. If the local log cannot be written, say so in the server log
    // but do not tell the person it failed.
    try {
      await reminders.add(row.id, { at: now().toISOString(), subject, note });
    } catch (err) {
      console.error('Reminder was sent but could not be logged:', err.message);
    }
    res.json({ ok: true, reminders: row.reminders + 1 });
  }));

  // Mock mode only: pretend the client paid, so the demo can show a paid invoice.
  app.post('/api/mock/:id/pay', wrap(async (req, res) => {
    if (paypal.mode !== 'mock') throw new HttpError(404, 'Not found.');
    await paypal.markPaid(req.params.id);
    res.json({ ok: true });
  }));

  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'No such endpoint.')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    let status = err.status || 500;
    let message = err.message || 'Something went wrong.';
    if (err instanceof PayPalError) {
      status = err.status && err.status >= 400 && err.status < 500 ? 422 : 502;
      if (err.debugId) message += ` (PayPal debug id ${err.debugId})`;
    } else if (err instanceof AiError) {
      status = 502;
    } else if (!err.status) {
      console.error(err);
      message = 'Something broke on the server. The details are in its log.';
    }
    if (err.type === 'entity.parse.failed') {
      status = 400;
      message = 'That request was not valid JSON.';
    }
    res.status(status).json({ error: { message } });
  });

  return app;
}

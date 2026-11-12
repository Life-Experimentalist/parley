# Parley

Parley is a small invoicing tool for freelancers who bill clients abroad. You say or type what you billed, check the invoice it prepares, and send it through PayPal. When invoices go late, it writes the reminders for you, firmer each time, and sends them only after you read them.

*Parley* is the old word for a talk to settle terms, which is the job: ask for the money politely, and keep asking until it arrives.

Built for the PayPal AI Hackathon.

## Why this exists

PayPal still works in India for one thing: getting paid from abroad. It stopped domestic payments in 2021, so a freelancer in Pune invoicing a studio in Leeds is exactly the case it serves. The invoice is the easy part. The hard part is the third email asking about the same unpaid invoice, which nobody enjoys writing and everybody puts off.

## What it does

1. **Say it or type it.** "Invoiced Dana at Northwind, 450 dollars for logo design plus two revision rounds at 60 each, due in 15 days." English, Hindi and Hinglish all work.
2. **Check it.** Claude turns that into a proper invoice. Anything it had to assume (no email given, no due date) is listed in plain words, and every field is editable. The server checks the invoice again before anything is created.
3. **Send it.** The app creates the invoice through the PayPal Invoicing API and sends it to the client.
4. **See who owes you.** A ledger shows every invoice with a stamp: Sent, Late, Paid. Totals are kept per currency.
5. **Chase, politely.** "Draft reminders for late invoices" looks at every late invoice and writes a message for each. The tone is picked from how late the invoice is and how many reminders it already had. A first nudge is friendly. A third reminder asks for a payment date. You can edit each draft. Nothing is sent until you press Send reminder.

## Try it in two minutes, no PayPal account needed

You need Node 20 or newer and at least one AI key (Gemini or Anthropic).

```bash
git clone https://github.com/Life-Experimentalist/parley.git
cd parley
npm install
cp .env.example .env      # then put GEMINI_API_KEYS and/or ANTHROPIC_API_KEYS in it
npm start
```

Open http://localhost:3000. With no PayPal keys, the app runs on made-up demo data and says so at the top of the page. Nothing is sent anywhere. Claude still does real work: reading your invoices and writing the reminders.

## Use the real PayPal sandbox

1. At [developer.paypal.com](https://developer.paypal.com), open **Apps & Credentials**, switch to **Sandbox**, and create an app. Copy the client ID and secret into `.env`.
2. Run `npm run doctor`. It checks PayPal and every AI key one at a time and tells you what to fix.
3. Optional: `npm run seed` puts a few sample invoices into your sandbox, some already past due.
4. `npm start`. The banner at the top now says it is connected to the sandbox.

To watch an invoice get paid, open the invoice link from the client email with a sandbox personal account and pay it, then press Refresh.

## How it fits together

```
browser (plain JS + AG Grid)
   |  speech or text
   v
Express server
   |-- AI router (Gemini, then Anthropic)  reads the invoice, drafts reminders
   |-- draft.js           re-checks every field, builds the PayPal body
   |-- PayPal Invoicing v2  create, send, remind, list
   '-- reminders.json     remembers which reminders went out
```

A few decisions worth knowing about:

- **The AI never sends anything.** It returns structured data (a forced tool call), and the server treats that data as untrusted: lengths capped, amounts checked, currencies limited to a fixed list, emails validated.
- **Money is handled in cents.** No floating point on an invoice.
- **Tone is decided in code, not by the model.** `reminderLevel` in `src/invoices.js` picks how firm the message should be. The model only writes it.
- **PayPal limits reminders** to two a day per invoice. The app enforces that and says so.
- **Overdue is worked out locally**, since PayPal's statuses have no "late" value. An invoice is late when it is unpaid and past its due date.
- **Voice input** uses the browser's built-in speech recognition (Chrome, Edge, Safari), so audio goes to the browser vendor's service, not to this server. Where that is missing, typing and any system dictation tool still work.

## Tests

```bash
npm test
```

35 tests cover the money math, invoice checking, PayPal request shapes (with a fake `fetch`), the late/paid logic, the reminder limits, and the HTTP API with scripted stand-ins for the model providers. They do not call PayPal or Anthropic, so they run offline. `npm run doctor` is the check that does.

## Deploy

`render.yaml` describes a free Render web service. Create it from this repo, then fill in the three secrets in the dashboard. Set `APP_PASSWORD` if the link will be public, so strangers cannot use your keys. Also set `ACCESS_KEY` to a long random string and keep it secret. Run `npm run link -- https://your-app.onrender.com` (with the same `ACCESS_KEY` in `.env`) to print a share link. That link carries a token derived from the key, not the key itself. Opening it once sets a cookie that skips the password, so you can give judges that one link while everyone else is asked for the password. Render's free tier sleeps after about 15 minutes idle (the first load then takes up to a minute) and wipes its disk, so the reminder log resets on each deploy. To keep it awake, point a free uptime monitor (UptimeRobot or cron-job.org) at `/healthz` every 10 minutes.

## Limits, honestly

- Sandbox only. There is no live mode on purpose.
- PayPal's invoicing API needs a business account. Your sandbox business account has to have invoicing available.
- The reminder log is a JSON file. A real product would use a database.
- Payment status comes from polling PayPal every minute, not from webhooks.
- Currencies are limited to USD, EUR, GBP, AUD, CAD and SGD.
- It does not handle taxes, discounts or recurring invoices.

## What's next

Webhooks so "Paid" appears the moment a client pays, a WhatsApp or email way to log work as it happens, and a weekly "who should I chase" summary.

## Credits

Ledger table by [AG Grid Community](https://www.ag-grid.com/). Fonts are Hind and Yatra One (SIL Open Font License), served through Fontsource.

## License

MIT. See `LICENSE`.

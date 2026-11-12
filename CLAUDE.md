# Parley

Invoicing tool for freelancers billing clients abroad, built for the PayPal AI Hackathon (Devpost deadline 1:30 AM IST, 13 Nov 2026). You say or type what you billed, check the parsed invoice, send it through PayPal Invoicing v2 (sandbox), and chase late invoices with AI-written reminders that a human reads and sends.

## Run
- `npm install`, copy `.env.example` to `.env`, then `npm run doctor` (checks PayPal and every AI key), `npm run seed` (sample sandbox invoices), `npm start`, `npm test`.
- No PayPal keys means mock mode with demo data. There is deliberately no live mode.

## Layout
- `src/llm.js`: provider router. Order is `LLM_ORDER` (default anthropic, then gemini; Haiku 5.5 is the default Claude model). Keys come from `GEMINI_API_KEYS` and `ANTHROPIC_API_KEYS` (comma separated). 401/403 kills a key, 429 rests it for a minute, 5xx/network moves on. Gemini is plain `fetch` to `generateContent`; tool schemas are converted to Gemini's OpenAPI subset (`toGeminiSchema`).
- `src/ai.js`: prompts, the two tool schemas (`create_invoice`, `write_reminder`), `Ai` wrapper.
- `src/config.js`: env parsing and `buildProviders()`. `src/app.js`: Express routes. `src/paypal.js`, `src/paypalMock.js`, `src/draft.js`, `src/invoices.js`, `src/money.js`, `src/reminders.js`.
- `public/`: vanilla JS + AG Grid Community (noStyle build). Ledger-paper look; keep it plain and human.
- `../parley-submission/` (outside the repo): Devpost text, video script, handoff checklist.

## Rules that must stay true
- Money is integer cents. Model output is untrusted: cap lengths, whitelist currencies, validate emails, re-validate before any PayPal call.
- The AI never sends anything; a human clicks every send. Reminder tone is chosen in code (`reminderLevel`), not by the model.
- PayPal allows two reminders per invoice per day. PayPal has no "late" status, so lateness is computed locally.
- Never commit `.env`. Error messages must not include API keys.

## Not yet verified against real services
Real PayPal sandbox calls, real Gemini calls (request shape follows Google's docs, `x-goog-api-key` header, `toolConfig` mode ANY) and real Claude calls. Model ids move quickly; if `doctor` reports a model error set `GEMINI_MODELS` or `ANTHROPIC_MODEL`.

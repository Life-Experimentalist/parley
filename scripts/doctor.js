// Run `npm run doctor` after filling in .env. It checks each outside service once
// and says plainly what to fix.
import { config, buildProviders } from '../src/config.js';
import { Ai } from '../src/ai.js';
import { PayPalClient } from '../src/paypal.js';

let failed = false;
const ok = (msg) => console.log(`  ok    ${msg}`);
const bad = (msg, fix) => { failed = true; console.log(`  FAIL  ${msg}${fix ? `\n        ${fix}` : ''}`); };

console.log('PayPal sandbox');
if (!config.paypalClientId || !config.paypalSecret) {
  bad('PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET is empty.', 'Create a sandbox REST app at developer.paypal.com and copy both values into .env.');
} else {
  const pp = new PayPalClient({ clientId: config.paypalClientId, secret: config.paypalSecret, baseUrl: config.paypalBase });
  try {
    await pp.token();
    ok('got an access token');
    try {
      const n = await pp.nextInvoiceNumber();
      ok(`invoicing works, next invoice number is ${n}`);
      const list = await pp.list();
      ok(`can list invoices (${list.length} found)`);
    } catch (err) {
      bad(`invoicing call failed: ${err.message}`, 'Make sure the sandbox business account behind this app has invoicing available.');
    }
  } catch (err) {
    bad(err.message);
  }
}

console.log('AI providers');
const { geminiProvider, anthropicProvider } = await import('../src/llm.js');
const checks = [
  ...config.geminiModels.flatMap((m) => config.geminiKeys.map((k) => ({ p: geminiProvider({ keys: [k], model: m }), k }))),
  ...config.anthropicKeys.map((k) => ({ p: anthropicProvider({ keys: [k], model: config.anthropicModel }), k })),
];
if (!checks.length) {
  bad('No AI keys found.', 'Put at least one key in .env as GEMINI_API_KEYS or ANTHROPIC_API_KEYS (comma separated for several).');
}
for (const { p, k } of checks) {
  const label = `${p.name} ${p.model} key ending ${k.slice(-4)}`;
  try {
    const ai = new Ai({ providers: [{ ...p, keys: [k] }] });
    const out = await ai.parseInvoice('Invoiced Sam at Acme, sam@acme.example, 100 dollars for a logo', { today: '2026-11-12' });
    const first = out.items?.[0];
    if (first && Number(first.unit_price) === 100) ok(`${label} read a test invoice correctly`);
    else bad(`${label} answered, but not as expected: ${JSON.stringify(out).slice(0, 160)}`);
  } catch (err) {
    bad(`${label}: ${err.message}`, 'A model name that is wrong or retired is the usual cause. Set GEMINI_MODELS or ANTHROPIC_MODEL in .env.');
  }
}
if (checks.length) console.log(`Order used by the app: ${(await buildProviders()).filter((p) => p.keys.length).map((p) => p.name + ' ' + p.model).join(' > ')}`);

console.log(failed ? '\nFix the lines marked FAIL, then run this again.' : '\nAll good. Run npm start.');
process.exit(failed ? 1 : 0);

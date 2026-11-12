import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { splitKeys } from './llm.js';

const env = process.env;

// "sandbox" talks to PayPal's sandbox. "mock" keeps everything in memory so the
// app can be tried without any PayPal account. There is deliberately no "live".
const hasPayPalKeys = Boolean(env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET);
const requested = (env.PAYPAL_MODE || '').toLowerCase();

export const config = {
  port: Number(env.PORT) || 3000,
  paypalMode: requested === 'mock' ? 'mock' : hasPayPalKeys ? 'sandbox' : 'mock',
  paypalBase: 'https://api-m.sandbox.paypal.com',
  paypalClientId: env.PAYPAL_CLIENT_ID || '',
  paypalSecret: env.PAYPAL_CLIENT_SECRET || '',
  // Several keys per provider are fine: comma or newline separated. The singular
  // names still work. Providers are tried in LLM_ORDER. To switch which one goes
  // first, set LLM_ORDER=gemini,anthropic or LLM_ORDER=anthropic,gemini.
  geminiKeys: splitKeys(env.GEMINI_API_KEYS, env.GEMINI_API_KEY),
  geminiModels: splitKeys(env.GEMINI_MODELS || env.GEMINI_MODEL || 'gemini-3.5-flash-lite,gemini-3.8-flash,gemini-flash-latest'),
  anthropicKeys: splitKeys(env.ANTHROPIC_API_KEYS, env.ANTHROPIC_API_KEY),
  anthropicModel: env.ANTHROPIC_MODEL || 'claude-haiku-5-5',
  llmOrder: splitKeys(env.LLM_ORDER || 'anthropic,gemini'),
  dataDir: env.DATA_DIR || fileURLToPath(new URL('../data/', import.meta.url)),
  appPassword: env.APP_PASSWORD || '',
  // A secret link for judges: https://your-app/?key=<ACCESS_KEY> skips the password prompt.
  accessKey: env.ACCESS_KEY || '',
  aiCallsPerHour: Number(env.AI_CALLS_PER_HOUR) || 30,
};

export const CURRENCIES = ['USD', 'EUR', 'GBP', 'AUD', 'CAD', 'SGD'];
export const DEFAULT_TERMS_DAYS = 15;
export const MAX_REMINDERS_PER_DAY = 2; // PayPal allows two reminders a day per invoice

/** Build the ordered provider list from config. Imported lazily to keep config.js free of cycles. */
export async function buildProviders(cfg = config) {
  const { geminiProvider, anthropicProvider } = await import('./llm.js');
  const groups = {
    gemini: () => cfg.geminiModels.map((model) => geminiProvider({ keys: cfg.geminiKeys, model })),
    anthropic: () => [anthropicProvider({ keys: cfg.anthropicKeys, model: cfg.anthropicModel })],
  };
  const order = cfg.llmOrder.filter((n) => groups[n]);
  for (const n of Object.keys(groups)) if (!order.includes(n)) order.push(n);
  return order.flatMap((n) => groups[n]());
}

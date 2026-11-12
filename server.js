import { config, buildProviders } from './src/config.js';
import { shareToken } from './src/access.js';
import { Ai } from './src/ai.js';
import { createApp } from './src/app.js';
import { PayPalClient } from './src/paypal.js';
import { MockPayPal } from './src/paypalMock.js';
import { ReminderLog } from './src/reminders.js';

const paypal = config.paypalMode === 'sandbox'
  ? new PayPalClient({ clientId: config.paypalClientId, secret: config.paypalSecret, baseUrl: config.paypalBase })
  : new MockPayPal();

const ai = new Ai({ providers: await buildProviders() });
const reminders = new ReminderLog(config.dataDir);

const app = createApp({ paypal, ai, reminders, config });

app.listen(config.port, () => {
  console.log(`Parley is running at http://localhost:${config.port}`);
  console.log(`PayPal: ${paypal.mode === 'sandbox' ? 'sandbox' : 'demo data (no sandbox keys found)'}`);
  if (config.appPassword && config.accessKey) console.log(`Share link path: /?key=${shareToken(config.accessKey)}`);
  const chain = ai.describe().map((p) => `${p.provider} ${p.model} x${p.keys}`).join(' > ');
  console.log(`AI: ${ai.ready ? chain : 'no GEMINI_API_KEYS or ANTHROPIC_API_KEYS, invoice reading and reminder drafts are off'}`);
});

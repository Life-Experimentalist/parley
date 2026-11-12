// Starts the real app with a scripted stand-in for Claude, for clicking through the UI
// without any keys. Used for screenshots and the browser check, not shipped to users.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Ai } from '../src/ai.js';
import { createApp } from '../src/app.js';
import { MockPayPal } from '../src/paypalMock.js';
import { ReminderLog } from '../src/reminders.js';

const client = {
  messages: {
    async create(args) {
      const name = args.tool_choice.name;
      if (name === 'create_invoice') {
        return { content: [{ type: 'tool_use', name, input: {
          client_name: 'Dana Whitfield', client_company: 'Northwind', client_email: 'dana@northwind.example', currency: 'USD',
          items: [{ name: 'Logo design', quantity: 1, unit_price: 450 }, { name: 'Revision round', quantity: 2, unit_price: 60 }], due_in_days: 15 } }] };
      }
      const level = /Direct and professional/.test(args.system) ? 3 : /Polite but clear/.test(args.system) ? 2 : 1;
      const lines = {
        1: 'Hi, a quick note that this invoice is a few days past its due date. If it has already gone out, please ignore this. Otherwise, could you let me know when I can expect it?\n\nThanks',
        2: 'Hi, invoice is now past due and I have not seen the payment yet. Could you confirm the date you plan to pay it?\n\nThanks',
        3: 'Hi, this is my third message about this invoice, which is well past due. Could you pay it or give me a payment date within three working days? Happy to answer any questions.\n\nThanks',
      };
      return { content: [{ type: 'tool_use', name, input: { subject: `Invoice past due (reminder ${level})`, note: lines[level] } }] };
    },
  },
};

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'parley-browser-'));
const app = createApp({
  paypal: new MockPayPal(),
  ai: new Ai({ client, model: 'scripted' }),
  reminders: new ReminderLog(dir),
  config: { appPassword: '', aiCallsPerHour: 1000 },
});
const port = Number(process.env.PORT) || 4173;
app.listen(port, () => console.log(`ready on ${port}`));

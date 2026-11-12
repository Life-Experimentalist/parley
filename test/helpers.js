import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { Ai } from '../src/ai.js';
import { MockPayPal } from '../src/paypalMock.js';
import { ReminderLog } from '../src/reminders.js';

export const TODAY = '2026-11-12';

/** A stand-in for the Anthropic SDK that returns whatever tool input we hand it. */
export function fakeAnthropic(inputs) {
  const calls = [];
  return {
    calls,
    messages: {
      async create(args) {
        calls.push(args);
        const input = typeof inputs === 'function' ? inputs(args) : inputs;
        return { content: [{ type: 'tool_use', name: args.tool_choice.name, input }] };
      },
    },
  };
}

export async function startApp({ anthropicInput = {}, seed = true, appPassword = '', accessKey = '' } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'parley-'));
  const paypal = new MockPayPal({ now: () => TODAY, seed });
  const client = fakeAnthropic(anthropicInput);
  const ai = new Ai({ client, model: 'test-model' });
  const reminders = new ReminderLog(dir);
  const app = createApp({
    paypal,
    ai,
    reminders,
    config: { appPassword, accessKey, aiCallsPerHour: 100 },
    now: () => new Date(`${TODAY}T10:00:00Z`),
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, headers = {}) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { call, paypal, client, reminders, port: server.address().port, close: () => server.close() };
}

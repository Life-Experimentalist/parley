import Anthropic from '@anthropic-ai/sdk';

export class AiError extends Error {}

/** Error from one provider call. `status` is the HTTP status, or 0 for network/timeout. */
export class ProviderError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

const COOLDOWN_MS = 60_000;
const MODEL_REST_MS = 20_000;
const TIMEOUT_MS = 15_000;

/** "a, b\nc" -> ['a','b','c'], blanks and duplicates dropped. */
export function splitKeys(...values) {
  const out = [];
  for (const v of values) {
    for (const part of String(v || '').split(/[\s,]+/)) {
      if (part && !out.includes(part)) out.push(part);
    }
  }
  return out;
}

/**
 * Gemini's Schema is an OpenAPI subset. Our tool schemas are written the
 * Anthropic way (type: ['string','null'], enum with null), so translate:
 * a null in the type or enum becomes nullable: true.
 */
export function toGeminiSchema(schema) {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  let nullable = false;
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'type' && Array.isArray(v)) {
      const types = v.filter((t) => t !== 'null');
      if (types.length !== v.length) nullable = true;
      out.type = types[0];
    } else if (k === 'enum') {
      const vals = v.filter((x) => x !== null);
      if (vals.length !== v.length) nullable = true;
      out.enum = vals;
    } else if (k === 'properties') {
      out.properties = Object.fromEntries(Object.entries(v).map(([n, s]) => [n, toGeminiSchema(s)]));
    } else if (k === 'items') {
      out.items = toGeminiSchema(v);
    } else {
      out[k] = v;
    }
  }
  if (nullable) out.nullable = true;
  return out;
}

export function anthropicProvider({ keys, model, client }) {
  const clients = new Map();
  const clientFor = (key) => {
    if (client) return client; // injected in tests
    if (!clients.has(key)) clients.set(key, new Anthropic({ apiKey: key, timeout: TIMEOUT_MS, maxRetries: 0 }));
    return clients.get(key);
  };
  return {
    name: 'anthropic',
    model,
    keys: client && !keys.length ? ['injected'] : keys,
    async call({ key, system, tool, content, maxTokens }) {
      let res;
      try {
        res = await clientFor(key).messages.create({
          model,
          max_tokens: maxTokens,
          system,
          tools: [tool],
          tool_choice: { type: 'tool', name: tool.name },
          messages: [{ role: 'user', content }],
        });
      } catch (err) {
        throw new ProviderError(err?.message || 'request failed', Number(err?.status) || 0);
      }
      const block = res.content?.find((b) => b.type === 'tool_use' && b.name === tool.name);
      if (!block) throw new ProviderError('no structured output', 502);
      return block.input;
    },
  };
}

export function geminiProvider({ keys, model, fetchImpl = globalThis.fetch, baseUrl = 'https://generativelanguage.googleapis.com/v1beta' }) {
  return {
    name: 'gemini',
    model,
    keys,
    async call({ key, system, tool, content, maxTokens }) {
      const body = {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: content }] }],
        tools: [{ functionDeclarations: [{ name: tool.name, description: tool.description, parameters: toGeminiSchema(tool.input_schema) }] }],
        toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [tool.name] } },
        generationConfig: { maxOutputTokens: maxTokens, temperature: 0.2 },
      };
      let res;
      try {
        res = await fetchImpl(`${baseUrl}/models/${encodeURIComponent(model)}:generateContent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (err) {
        throw new ProviderError(err?.message || 'network error', 0);
      }
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new ProviderError(data?.error?.message || `HTTP ${res.status}`, res.status);
      const parts = data?.candidates?.[0]?.content?.parts || [];
      const call = parts.find((p) => p.functionCall && p.functionCall.name === tool.name);
      if (!call) throw new ProviderError('no structured output', 502);
      return call.functionCall.args || {};
    },
  };
}

/**
 * Tries each provider in order, and each of its keys in order, until one
 * returns structured output.
 *  - 401/403: the key is bad, stop using it for this run of the server.
 *  - 429: the key is rate limited, skip it for a minute.
 *  - 5xx, timeouts, network errors, empty output: just try the next one.
 */
export class LlmRouter {
  constructor(providers, { now = () => Date.now() } = {}) {
    this.providers = providers.filter((p) => p.keys.length);
    this.now = now;
    this.dead = new Set();
    this.coolUntil = new Map();
    this.modelCool = new Map();
    this.last = null;
  }

  get ready() {
    return this.providers.length > 0;
  }

  get model() {
    return this.providers[0]?.model;
  }

  describe() {
    return this.providers.map((p) => ({
      provider: p.name,
      model: p.model,
      keys: p.keys.length,
      usable: p.keys.filter((k) => this.usable(p, k)).length,
    }));
  }

  id(p, key) {
    return `${p.name}:${p.model}:${key}`;
  }

  usable(p, key) {
    const id = this.id(p, key);
    if (this.dead.has(`${p.name}:${key}`)) return false;
    return (this.coolUntil.get(id) || 0) <= this.now();
  }

  async run(args) {
    if (!this.ready) {
      throw new AiError('No AI key is set, so I cannot read the invoice. Add GEMINI_API_KEYS or ANTHROPIC_API_KEYS and restart.');
    }
    const failures = [];
    const secrets = this.providers.flatMap((p) => p.keys);
    const clean = (m) => secrets.reduce((t, k) => t.split(k).join('[key]'), String(m || '')).slice(0, 140);
    for (const p of this.providers) {
      const mid = `${p.name}:${p.model}`;
      if ((this.modelCool.get(mid) || 0) > this.now()) continue;
      let modelFails = 0;
      for (const key of p.keys) {
        if (!this.usable(p, key)) continue;
        try {
          const input = await p.call({ ...args, key });
          this.last = { provider: p.name, model: p.model };
          return input;
        } catch (err) {
          const status = err.status || 0;
          if (status === 401 || status === 403) this.dead.add(`${p.name}:${key}`);
          else if (status === 429) this.coolUntil.set(this.id(p, key), this.now() + COOLDOWN_MS);
          const why = status >= 500 || status === 0 ? '' : `: ${clean(err.message)}`;
          failures.push(`${p.name} ${p.model} (${status || 'no response'})${why}`);
          // 503s and timeouts are often one unlucky request, so a second key gets a try.
          // Two in a row means the model is struggling: rest it for a bit and move on.
          if (status === 0 || status === 404 || status >= 500) {
            modelFails += 1;
            if (status === 404 || modelFails >= 2) {
              this.modelCool.set(mid, this.now() + MODEL_REST_MS);
              break;
            }
          }
        }
      }
    }
    const tried = failures.length ? failures.join(', ') : 'every key is cooling down or was rejected';
    throw new AiError(`No AI provider could answer. Tried: ${tried}. Check your keys with npm run doctor.`);
  }
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { LlmRouter, geminiProvider, anthropicProvider, toGeminiSchema, splitKeys, AiError } from '../src/llm.js';

const args = { system: 'sys', content: 'hello', maxTokens: 100, tool: { name: 't', description: 'd', input_schema: { type: 'object', properties: { a: { type: ['string', 'null'] } } } } };
const fake = (name, keys, behave) => ({ name, model: `${name}-m`, keys, calls: [], async call(a) { this.calls.push(a.key); return behave(a.key, this.calls.length); } });
const fail = (status) => { const e = new Error('x'); e.status = status; throw e; };

test('splitKeys handles commas, newlines, blanks and repeats', () => {
  assert.deepEqual(splitKeys('a, b\nc,,a', 'd', ''), ['a', 'b', 'c', 'd']);
});

test('toGeminiSchema turns null types and enums into nullable', () => {
  const out = toGeminiSchema({ type: 'object', properties: { c: { type: ['string', 'null'], enum: ['USD', null] }, n: { type: 'number' }, l: { type: 'array', items: { type: ['number', 'null'] } } }, required: ['n'] });
  assert.deepEqual(out.properties.c, { type: 'string', enum: ['USD'], nullable: true });
  assert.equal(out.properties.n.type, 'number');
  assert.deepEqual(out.properties.l.items, { type: 'number', nullable: true });
  assert.deepEqual(out.required, ['n']);
});

test('router uses the first provider when it works', async () => {
  const g = fake('gemini', ['g1'], () => ({ ok: 1 }));
  const a = fake('anthropic', ['a1'], () => ({ ok: 2 }));
  const r = new LlmRouter([g, a]);
  assert.deepEqual(await r.run(args), { ok: 1 });
  assert.equal(a.calls.length, 0);
  assert.equal(r.last.provider, 'gemini');
});

test('router moves to the next key, then the next provider', async () => {
  const g = fake('gemini', ['g1', 'g2'], () => fail(429));
  const a = fake('anthropic', ['a1'], () => ({ ok: 2 }));
  const r = new LlmRouter([g, a]);
  assert.deepEqual(await r.run(args), { ok: 2 });
  assert.deepEqual(g.calls, ['g1', 'g2']);
});

test('a rejected key is not tried again, a rate limited key rests', async () => {
  let t = 0;
  const g = fake('gemini', ['bad', 'slow', 'good'], (k) => (k === 'bad' ? fail(403) : k === 'slow' ? fail(429) : { ok: 1 }));
  const r = new LlmRouter([g], { now: () => t });
  await r.run(args);
  g.calls.length = 0;
  await r.run(args);
  assert.deepEqual(g.calls, ['good']);
  t = 61_000;
  g.calls.length = 0;
  await r.run(args);
  assert.deepEqual(g.calls, ['slow', 'good']);
});

test('when everything fails the error names providers but never keys', async () => {
  const r = new LlmRouter([fake('gemini', ['SECRETKEY'], () => fail(429)), fake('anthropic', ['SECRET2'], () => fail(401))]);
  await assert.rejects(r.run(args), (e) => e instanceof AiError && /gemini/.test(e.message) && !/SECRET/.test(e.message));
});

test('router with no providers explains what to set', async () => {
  const r = new LlmRouter([geminiProvider({ keys: [], model: 'm' })]);
  assert.equal(r.ready, false);
  await assert.rejects(r.run(args), /GEMINI_API_KEYS/);
});

test('gemini provider sends the expected request and reads the function call', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init, body: JSON.parse(init.body) };
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ functionCall: { name: 't', args: { a: 'x' } } }] } }] }) };
  };
  const p = geminiProvider({ keys: ['k1'], model: 'gemini-test', fetchImpl });
  const out = await p.call({ ...args, key: 'k1' });
  assert.deepEqual(out, { a: 'x' });
  assert.match(seen.url, /models\/gemini-test:generateContent$/);
  assert.equal(seen.init.headers['x-goog-api-key'], 'k1');
  assert.equal(seen.body.toolConfig.functionCallingConfig.mode, 'ANY');
  assert.deepEqual(seen.body.toolConfig.functionCallingConfig.allowedFunctionNames, ['t']);
  assert.equal(seen.body.tools[0].functionDeclarations[0].parameters.properties.a.nullable, true);
  assert.equal(seen.body.systemInstruction.parts[0].text, 'sys');
});

test('gemini provider turns HTTP errors and empty answers into provider errors', async () => {
  const err = async () => ({ ok: false, status: 429, json: async () => ({ error: { message: 'quota' } }) });
  await assert.rejects(geminiProvider({ keys: ['k'], model: 'm', fetchImpl: err }).call({ ...args, key: 'k' }), (e) => e.status === 429);
  const empty = async () => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'hi' }] } }] }) });
  await assert.rejects(geminiProvider({ keys: ['k'], model: 'm', fetchImpl: empty }).call({ ...args, key: 'k' }), (e) => e.status === 502);
});

test('anthropic provider keeps its own request shape', async () => {
  let seen;
  const client = { messages: { async create(a) { seen = a; return { content: [{ type: 'tool_use', name: 't', input: { a: 'y' } }] }; } } };
  const p = anthropicProvider({ keys: [], model: 'claude-test', client });
  assert.deepEqual(await p.call({ ...args, key: 'injected' }), { a: 'y' });
  assert.equal(seen.tool_choice.name, 't');
  assert.deepEqual(seen.tools[0].input_schema.properties.a.type, ['string', 'null']);
});

test('one 503 tries a second key, two in a row rest the model', async () => {
  let t = 0;
  const flaky = fake('gemini', ['g1', 'g2', 'g3'], (k) => (k === 'g1' ? fail(503) : { ok: 1 }));
  const r1 = new LlmRouter([flaky]);
  assert.deepEqual(await r1.run(args), { ok: 1 });
  assert.deepEqual(flaky.calls, ['g1', 'g2']);

  const g = fake('gemini', ['g1', 'g2', 'g3'], () => fail(503));
  const a = fake('anthropic', ['a1'], () => ({ ok: 2 }));
  const r = new LlmRouter([g, a], { now: () => t });
  assert.deepEqual(await r.run(args), { ok: 2 });
  assert.deepEqual(g.calls, ['g1', 'g2']);
  await r.run(args);
  assert.deepEqual(g.calls, ['g1', 'g2']);
  t = 21_000;
  await r.run(args);
  assert.deepEqual(g.calls, ['g1', 'g2', 'g1', 'g2']);
});

test('a 400 shows the provider reason with keys removed', async () => {
  const r = new LlmRouter([fake('anthropic', ['sk-secret-123'], () => { const e = new Error('credit balance too low sk-secret-123'); e.status = 400; throw e; })]);
  await assert.rejects(r.run(args), (e) => /credit balance too low/.test(e.message) && !/sk-secret/.test(e.message));
});

import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AiProviderError,
  AiRefusalError,
  AnthropicProvider,
  chunkText,
  extractJson,
  htmlToText,
  MockEmbeddings,
  MockProvider,
  OpenAiCompatProvider,
  type StreamEvent,
} from '../src/index.ts';
import { fakeServer, json, sse } from './fake-server.ts';

const Schema = z.object({ title: z.string(), score: z.number().int() });
const base = { model: 'm', system: 'sys', maxTokens: 1000 };
const ask = [{ role: 'user' as const, content: 'hi' }];
const collect = async (it: AsyncIterable<StreamEvent>) => {
  const out: StreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
};

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const message = (text: string, stop = 'end_turn', model = 'claude-sonnet-5-5') => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model,
  content: [
    { type: 'thinking', thinking: '', signature: 'x' },
    { type: 'text', text },
  ],
  stop_reason: stop,
  stop_sequence: null,
  usage: {
    input_tokens: 10,
    output_tokens: 5,
    cache_read_input_tokens: 7,
    cache_creation_input_tokens: 3,
  },
});

describe('AnthropicProvider', () => {
  it('parses structured output, caches the system prefix and sets effort', async () => {
    const s = await fakeServer((_b, _r, res) =>
      json(res, 200, message(JSON.stringify({ title: 'A', score: 3 }))),
    );
    close = s.close;
    const p = new AnthropicProvider({ apiKey: 'k', baseUrl: s.url });
    const r = await p.generateObject({
      ...base,
      model: 'claude-sonnet-5-5',
      cacheablePrefix: 'course overview',
      messages: ask,
      schema: Schema,
      effort: 'medium',
    });
    expect(r.object).toEqual({ title: 'A', score: 3 });
    expect(r.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 7,
      cacheWriteTokens: 3,
    });
    const body = s.requests[0]!;
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('fallbacks'); // custom base URL → no server fallback
    expect(body.system).toEqual([
      { type: 'text', text: 'sys' },
      { type: 'text', text: 'course overview', cache_control: { type: 'ephemeral' } },
    ]);
    expect(body.output_config).toMatchObject({ effort: 'medium', format: { type: 'json_schema' } });
  });

  it('opts Opus/Sonnet into server-side refusal fallback on the Claude API', async () => {
    const s = await fakeServer((_b, _r, res) => json(res, 200, message('ok')));
    close = s.close;
    process.env.ANTHROPIC_BASE_URL = s.url; // stands in for api.anthropic.com
    try {
      const p = new AnthropicProvider({ apiKey: 'k' });
      await p.generateText({ ...base, model: 'claude-opus-5-5', messages: ask });
      await p.generateText({ ...base, model: 'claude-haiku-5-5', messages: ask });
    } finally {
      delete process.env.ANTHROPIC_BASE_URL;
    }
    expect(s.requests[0]).toMatchObject({ fallbacks: 'default' });
    expect(String((s.requests[0]!.$headers as Record<string, string>)['anthropic-beta'])).toContain(
      'server-side-fallback-2026-07-01',
    );
    expect(s.requests[1]).not.toHaveProperty('fallbacks');
  });

  it('maps refusals and API errors', async () => {
    let mode = 'refusal';
    const s = await fakeServer((_b, _r, res) =>
      mode === 'refusal'
        ? json(res, 200, message('', 'refusal'))
        : json(res, 400, {
            type: 'error',
            error: { type: 'invalid_request_error', message: 'bad' },
          }),
    );
    close = s.close;
    const p = new AnthropicProvider({ apiKey: 'k', baseUrl: s.url });
    await expect(p.generateText({ ...base, messages: ask })).rejects.toBeInstanceOf(AiRefusalError);
    mode = 'error';
    await expect(p.generateText({ ...base, messages: ask })).rejects.toBeInstanceOf(
      AiProviderError,
    );
  });

  it('reports cut-off and refused structured output with its usage', async () => {
    let reply = message('{"title": "Кор', 'max_tokens');
    const s = await fakeServer((_b, _r, res) => json(res, 200, reply));
    close = s.close;
    const p = new AnthropicProvider({ apiKey: 'k', baseUrl: s.url });
    const req = { ...base, messages: ask, schema: Schema };
    await expect(p.generateObject(req)).rejects.toMatchObject({
      message: expect.stringContaining('max_tokens'),
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    reply = message('', 'refusal');
    await expect(p.generateObject(req)).rejects.toBeInstanceOf(AiRefusalError);
    reply = message('{"title": "x", "score": "high"}');
    await expect(p.generateObject(req)).rejects.toMatchObject({
      message: 'Model output did not match the schema',
      usage: { outputTokens: 5 },
    });
  });

  it('streams text deltas and reports usage', async () => {
    const s = await fakeServer((_b, _r, res) =>
      sse(res, [
        [
          'message_start',
          { type: 'message_start', message: { ...message(''), content: [], stop_reason: null } },
        ],
        [
          'content_block_start',
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        ],
        [
          'content_block_delta',
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'При' } },
        ],
        [
          'content_block_delta',
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'вет' } },
        ],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        [
          'message_delta',
          {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: 2 },
          },
        ],
        ['message_stop', { type: 'message_stop' }],
      ]),
    );
    close = s.close;
    const p = new AnthropicProvider({ apiKey: 'k', baseUrl: s.url });
    const ev = await collect(p.streamText({ ...base, messages: ask, effort: 'low' }));
    expect(
      ev
        .filter((e) => e.type === 'delta')
        .map((e) => (e as { text: string }).text)
        .join(''),
    ).toBe('Привет');
    expect(ev.at(-1)).toMatchObject({ type: 'done', stopReason: 'end_turn' });
    expect(s.requests[0]).toMatchObject({ stream: true, output_config: { effort: 'low' } });
  });
});

describe('OpenAiCompatProvider', () => {
  const completion = (content: string) => ({
    id: 'c',
    object: 'chat.completion',
    created: 0,
    model: 'qwen',
    choices: [
      { index: 0, finish_reason: 'stop', message: { role: 'assistant', content, refusal: null } },
    ],
    usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
  });

  it('repairs invalid JSON once using the validation error', async () => {
    let n = 0;
    const s = await fakeServer((_b, _r, res) =>
      json(
        res,
        200,
        completion(n++ === 0 ? 'Вот: {"title": "A"}' : '```json\n{"title":"A","score":2}\n```'),
      ),
    );
    close = s.close;
    const p = new OpenAiCompatProvider({ baseUrl: s.url });
    const r = await p.generateObject({ ...base, messages: ask, schema: Schema });
    expect(r.object).toEqual({ title: 'A', score: 2 });
    expect(r.usage.inputTokens).toBe(8);
    expect(String((s.requests[0]!.messages as { content: string }[])[0]!.content)).toContain(
      'JSON Schema',
    );
    expect(s.requests[1]!.messages).toHaveLength(4);
  });

  it('gives up after one repair and uses json_schema when supported', async () => {
    const s = await fakeServer((_b, _r, res) => json(res, 200, completion('{"nope":1}')));
    close = s.close;
    const p = new OpenAiCompatProvider({ baseUrl: s.url, capabilities: { jsonSchema: true } });
    await expect(p.generateObject({ ...base, messages: ask, schema: Schema })).rejects.toThrow(
      /schema/,
    );
    expect(s.requests).toHaveLength(2);
    expect(s.requests[0]!.response_format).toMatchObject({ type: 'json_schema' });
  });

  it('streams chunks with usage', async () => {
    const chunk = (content: string | null, finish: string | null, usage?: object) => ({
      id: 'c',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'qwen',
      choices: usage
        ? []
        : [{ index: 0, delta: content ? { content } : {}, finish_reason: finish }],
      ...(usage ? { usage } : {}),
    });
    const s = await fakeServer((_b, _r, res) =>
      sse(res, [
        [null, chunk('Hel', null)],
        [null, chunk('lo', 'stop')],
        [null, chunk(null, null, { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 })],
        [null, '[DONE]'],
      ]),
    );
    close = s.close;
    const ev = await collect(
      new OpenAiCompatProvider({ baseUrl: s.url }).streamText({ ...base, messages: ask }),
    );
    expect(ev).toEqual([
      { type: 'delta', text: 'Hel' },
      { type: 'delta', text: 'lo' },
      {
        type: 'done',
        usage: { inputTokens: 3, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
        stopReason: 'stop',
        model: 'qwen',
      },
    ]);
  });
});

describe('helpers', () => {
  it('extracts JSON from chatty replies', () => {
    expect(extractJson('Sure! ```json\n[1,2]\n``` done')).toEqual([1, 2]);
    expect(extractJson('{"a":{"b":1}} trailing')).toEqual({ a: { b: 1 } });
    expect(() => extractJson('no json')).toThrow();
  });

  it('mock provider is deterministic and simulates refusals', async () => {
    const p = new MockProvider({ t: (r) => ({ title: r.messages[0]!.content, score: 1 }) });
    const a = await p.generateObject({ ...base, tag: 't', messages: ask, schema: Schema });
    expect(a.object).toEqual({ title: 'hi', score: 1 });
    await expect(
      p.generateText({ ...base, messages: [{ role: 'user', content: 'x [[refuse]]' }] }),
    ).rejects.toBeInstanceOf(AiRefusalError);
  });

  it('mock embeddings rank lexical matches higher', async () => {
    const e = new MockEmbeddings(256);
    const [q, a, b] = await e.embed(
      ['списки в Python', 'Списки Python: append и pop', 'Рецепт борща'],
      'document',
    );
    const dot = (x: number[], y: number[]) => x.reduce((s, v, i) => s + v * y[i]!, 0);
    expect(dot(q!, a!)).toBeGreaterThan(dot(q!, b!));
    expect(q).toHaveLength(256);
  });

  it('chunks by headings with overlap', () => {
    const long = Array.from({ length: 40 }, (_, i) => `Предложение номер ${i} о циклах for.`).join(
      ' ',
    );
    const text = htmlToText(
      `<h1>Циклы</h1><p>${long}</p><h2>while</h2><p>Цикл while &amp; условие.</p>`,
    );
    const chunks = chunkText(text, { maxTokens: 120, overlapTokens: 20, title: 'Урок 3' });
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks[0]!.heading).toBe('Урок 3 › Циклы');
    expect(chunks.at(-1)).toMatchObject({
      heading: 'Урок 3 › Циклы › while',
      text: 'Цикл while & условие.',
    });
    for (const c of chunks) expect(c.tokenCount).toBeLessThanOrEqual(150);
    // consecutive chunks of one section overlap
    expect(chunks[1]!.text.slice(0, 20)).not.toBe('');
    expect(chunks[0]!.text).toContain(chunks[1]!.text.split('\n\n')[0]!.slice(0, 15));
  });
});

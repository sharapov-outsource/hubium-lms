import {
  AiRefusalError,
  type EmbeddingProvider,
  type LlmProvider,
  type ObjectReq,
  type StreamEvent,
  type TextReq,
  type Usage,
} from './types.ts';

// Deterministic provider for tests, CI and demo installs without an API key.
// Fixtures are keyed by the request tag and derive their output from the input, so the
// same request always yields the same answer. A message containing "[[refuse]]"
// simulates a safety refusal.

export type MockFixture = (r: TextReq) => unknown;

export const estimateTokens = (s: string) => Math.ceil(s.length / 4);

function usageFor(r: TextReq, out: string): Usage {
  const input = r.system + (r.cacheablePrefix ?? '') + r.messages.map((m) => m.content).join('');
  return {
    inputTokens: estimateTokens(input),
    outputTokens: estimateTokens(out),
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

export class MockProvider implements LlmProvider {
  readonly kind = 'MOCK' as const;
  constructor(private fixtures: Record<string, MockFixture> = {}) {}

  private run(r: TextReq): unknown {
    if (r.messages.some((m) => m.content.includes('[[refuse]]')))
      throw new AiRefusalError(undefined, usageFor(r, ''));
    const f = (r.tag && this.fixtures[r.tag]) || this.fixtures.default;
    if (!f) return `mock:${r.messages.at(-1)?.content.slice(0, 80) ?? ''}`;
    return f(r);
  }

  async generateObject<T>(r: ObjectReq<T>) {
    const raw = this.run(r);
    const object = r.schema.parse(raw);
    return { object, usage: usageFor(r, JSON.stringify(raw)), model: r.model };
  }

  async generateText(r: TextReq) {
    const text = String(this.run(r));
    return { text, usage: usageFor(r, text), model: r.model };
  }

  async *streamText(r: TextReq): AsyncIterable<StreamEvent> {
    const text = String(this.run(r));
    for (const piece of text.match(/\S+\s*|\s+/g) ?? []) yield { type: 'delta', text: piece };
    yield { type: 'done', usage: usageFor(r, text), stopReason: 'end_turn', model: r.model };
  }
}

const WORD = /[\p{L}\p{N}]{2,}/gu;

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * Hashed bag-of-stems embedding: lexical, but deterministic, offline and good enough to
 * exercise retrieval in tests (documents sharing words with the query rank higher).
 */
export class MockEmbeddings implements EmbeddingProvider {
  readonly model = 'mock-hash';
  constructor(readonly dims = 1024) {}

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const v = new Array<number>(this.dims).fill(0);
      for (const w of t.toLowerCase().match(WORD) ?? []) v[hash(w.slice(0, 5)) % this.dims]! += 1;
      const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
      return v.map((x) => x / norm);
    });
  }
}

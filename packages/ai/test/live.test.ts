import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AnthropicProvider } from '../src/index.ts';

// Opt-in smoke test against the real Claude API (nightly CI with a secret, or locally):
//   ANTHROPIC_API_KEY=... pnpm --filter @hubium/ai test
const key = process.env.ANTHROPIC_API_KEY;
const model = process.env.HUBIUM_LIVE_MODEL ?? 'claude-opus-5-5';

describe.skipIf(!key)('live Claude API', () => {
  const p = new AnthropicProvider({ apiKey: key ?? '' });

  it('returns schema-valid structured output with usage', async () => {
    const r = await p.generateObject({
      model,
      system: 'You extract facts from course text.',
      messages: [
        {
          role: 'user',
          content: 'Text: "A Python list is mutable; a tuple is not." Name both types.',
        },
      ],
      schema: z.object({ types: z.array(z.string()) }),
      maxTokens: 4000,
      effort: 'low',
    });
    expect(r.object.types.map((t) => t.toLowerCase()).join(' ')).toMatch(/list.*tuple|tuple.*list/);
    expect(r.usage.inputTokens).toBeGreaterThan(0);
  }, 120_000);

  it('streams text', async () => {
    let text = '';
    for await (const ev of p.streamText({
      model,
      system: 'Answer in one short sentence.',
      messages: [{ role: 'user', content: 'What does print() do in Python?' }],
      maxTokens: 2000,
      effort: 'low',
    }))
      if (ev.type === 'delta') text += ev.text;
    expect(text.length).toBeGreaterThan(5);
  }, 120_000);
});

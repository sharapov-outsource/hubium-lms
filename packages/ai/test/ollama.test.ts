import { describe, expect, it } from 'vitest';
import { OpenAiCompatEmbeddings } from '../src/index.ts';

// Opt-in check of the ai-local compose profile (nightly CI, or locally after
// `docker compose --profile ai-local up -d ollama-pull` with port 11434 published):
//   OLLAMA_URL=http://127.0.0.1:11434/v1 pnpm --filter @hubium/ai test
const url = process.env.OLLAMA_URL;

describe.skipIf(!url)('ai-local: bge-m3 on Ollama', () => {
  const e = new OpenAiCompatEmbeddings({ baseUrl: url ?? '' }, 'bge-m3', 1024);

  it('embeds Russian and English text into comparable 1024-dimensional vectors', async () => {
    const [ru, en, other] = await e.embed([
      'Список в Python можно изменять, а кортеж нельзя.',
      'A Python list is mutable, a tuple is not.',
      'Фотосинтез идёт в хлоропластах растений.',
    ]);
    expect(ru).toHaveLength(1024);
    const cos = (a: number[], b: number[]) => {
      let dot = 0;
      let na = 0;
      let nb = 0;
      for (const [i, x] of a.entries()) {
        dot += x * b[i]!;
        na += x * x;
        nb += b[i]! * b[i]!;
      }
      return dot / Math.sqrt(na * nb);
    };
    // the same statement in two languages is closer than an unrelated one
    expect(cos(ru!, en!)).toBeGreaterThan(cos(ru!, other!));
  }, 120_000);
});

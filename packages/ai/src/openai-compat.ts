import OpenAI from 'openai';
import { z } from 'zod';
import {
  AiProviderError,
  AiRefusalError,
  type EmbeddingProvider,
  emptyUsage,
  type LlmProvider,
  type ObjectReq,
  type StreamEvent,
  type TextReq,
  type Usage,
} from './types.ts';

// Any OpenAI-compatible chat endpoint (Ollama, vLLM, YandexGPT gateways, ...).
// Servers differ: `jsonSchema` says whether response_format json_schema is honoured;
// without it we ask for JSON in the prompt, validate with zod and retry once with the
// validation errors.

export interface OpenAiCompatOptions {
  baseUrl: string;
  apiKey?: string | null;
  capabilities?: { jsonSchema?: boolean; streaming?: boolean };
  timeoutMs?: number;
  /** Custom fetch (core passes an SSRF-guarded one). */
  fetch?: typeof fetch;
}

function usageOf(u: OpenAI.CompletionUsage | null | undefined): Usage {
  return {
    inputTokens: u?.prompt_tokens ?? 0,
    outputTokens: u?.completion_tokens ?? 0,
    cacheReadTokens: u?.prompt_tokens_details?.cached_tokens ?? 0,
    cacheWriteTokens: 0,
  };
}

const add = (a: Usage, b: Usage): Usage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
});

/** Pulls the first JSON value out of a reply that may be fenced or chatty. */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced ? fenced[1]! : text).trim();
  const start = body.search(/[[{]/);
  if (start < 0) throw new Error('No JSON found in the reply');
  const open = body[start]!;
  const close = open === '{' ? '}' : ']';
  const end = body.lastIndexOf(close);
  return JSON.parse(body.slice(start, end + 1));
}

export class OpenAiCompatProvider implements LlmProvider {
  readonly kind = 'OPENAI_COMPAT' as const;
  private client: OpenAI;
  private caps: { jsonSchema: boolean; streaming: boolean };

  constructor(opts: OpenAiCompatOptions) {
    this.client = new OpenAI({
      baseURL: opts.baseUrl,
      apiKey: opts.apiKey || 'none',
      timeout: opts.timeoutMs ?? 120_000,
      maxRetries: 2,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
    this.caps = {
      jsonSchema: opts.capabilities?.jsonSchema ?? false,
      streaming: opts.capabilities?.streaming ?? true,
    };
  }

  private messages(r: TextReq, extraSystem = ''): OpenAI.ChatCompletionMessageParam[] {
    const system = [r.system, r.cacheablePrefix, extraSystem].filter(Boolean).join('\n\n');
    return [{ role: 'system', content: system }, ...r.messages];
  }

  private async complete(
    r: TextReq,
    messages: OpenAI.ChatCompletionMessageParam[],
    responseFormat?: OpenAI.ChatCompletionCreateParams['response_format'],
  ) {
    try {
      const c = await this.client.chat.completions.create(
        {
          model: r.model,
          max_tokens: r.maxTokens,
          messages,
          ...(responseFormat ? { response_format: responseFormat } : {}),
        },
        { signal: r.signal },
      );
      const choice = c.choices[0];
      if (choice?.message.refusal)
        throw new AiRefusalError(choice.message.refusal, usageOf(c.usage));
      if (choice?.finish_reason === 'content_filter')
        throw new AiRefusalError(undefined, usageOf(c.usage));
      return { text: choice?.message.content ?? '', usage: usageOf(c.usage), model: c.model };
    } catch (e) {
      if (e instanceof AiRefusalError) throw e;
      if (e instanceof OpenAI.APIError) {
        const retryable = e.status === 429 || (e.status ?? 0) >= 500;
        throw new AiProviderError(
          `Provider API ${e.status ?? ''}: ${e.message}`,
          undefined,
          retryable,
        );
      }
      throw new AiProviderError(e instanceof Error ? e.message : String(e), undefined, true);
    }
  }

  async generateObject<T>(r: ObjectReq<T>) {
    const jsonSchema = z.toJSONSchema(r.schema, { target: 'draft-7' });
    const format: OpenAI.ChatCompletionCreateParams['response_format'] = this.caps.jsonSchema
      ? { type: 'json_schema', json_schema: { name: 'output', schema: jsonSchema, strict: true } }
      : undefined;
    const instruction = this.caps.jsonSchema
      ? ''
      : `Reply with a single JSON value that validates against this JSON Schema, and nothing else:\n${JSON.stringify(jsonSchema)}`;
    const messages = this.messages(r, instruction);
    let res = await this.complete(r, messages, format);
    let usage = res.usage;
    for (let attempt = 0; ; attempt++) {
      let problem: string;
      try {
        const parsed = r.schema.safeParse(extractJson(res.text));
        if (parsed.success) return { object: parsed.data, usage, model: res.model };
        problem = z.prettifyError(parsed.error);
      } catch (e) {
        problem = e instanceof Error ? e.message : String(e);
      }
      if (attempt >= 1)
        throw new AiProviderError(`Model output did not match the schema: ${problem}`, usage);
      res = await this.complete(
        r,
        [
          ...messages,
          { role: 'assistant', content: res.text },
          {
            role: 'user',
            content: `That reply is not valid: ${problem}\nReturn only the corrected JSON.`,
          },
        ],
        format,
      );
      usage = add(usage, res.usage);
    }
  }

  async generateText(r: TextReq) {
    return this.complete(r, this.messages(r));
  }

  async *streamText(r: TextReq): AsyncIterable<StreamEvent> {
    if (!this.caps.streaming) {
      const res = await this.generateText(r);
      yield { type: 'delta', text: res.text };
      yield { type: 'done', usage: res.usage, stopReason: 'end_turn', model: res.model };
      return;
    }
    let usage: Usage | undefined;
    let stop = 'end_turn';
    let model = r.model;
    try {
      const stream = await this.client.chat.completions.create(
        {
          model: r.model,
          max_tokens: r.maxTokens,
          messages: this.messages(r),
          stream: true,
          stream_options: { include_usage: true },
        },
        { signal: r.signal },
      );
      for await (const chunk of stream) {
        model = chunk.model || model;
        if (chunk.usage) usage = usageOf(chunk.usage);
        const choice = chunk.choices[0];
        if (choice?.delta?.content) yield { type: 'delta', text: choice.delta.content };
        if (choice?.finish_reason) stop = choice.finish_reason;
      }
    } catch (e) {
      if (e instanceof OpenAI.APIError)
        throw new AiProviderError(`Provider API ${e.status ?? ''}: ${e.message}`);
      throw e;
    }
    if (stop === 'content_filter') throw new AiRefusalError(undefined, usage);
    yield {
      type: 'done',
      usage: usage ?? emptyUsage(),
      stopReason: stop,
      model,
    };
  }
}

/** OpenAI-compatible /v1/embeddings (bge-m3 via Ollama/TEI, OpenAI, Voyage gateways). */
export class OpenAiCompatEmbeddings implements EmbeddingProvider {
  private client: OpenAI;
  constructor(
    opts: { baseUrl: string; apiKey?: string | null; fetch?: typeof fetch },
    readonly model: string,
    readonly dims: number,
  ) {
    this.client = new OpenAI({
      baseURL: opts.baseUrl,
      apiKey: opts.apiKey || 'none',
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!texts.length) return [];
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += 64) {
      const res = await this.client.embeddings.create({
        model: this.model,
        input: texts.slice(i, i + 64),
        dimensions: this.dims,
        encoding_format: 'float',
      });
      for (const d of res.data.sort((a, b) => a.index - b.index)) {
        if (d.embedding.length !== this.dims)
          throw new AiProviderError(
            `Embedding has ${d.embedding.length} dimensions, expected ${this.dims}`,
          );
        out.push(d.embedding);
      }
    }
    return out;
  }
}

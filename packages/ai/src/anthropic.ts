import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import {
  AiProviderError,
  AiRefusalError,
  type LlmProvider,
  type ObjectReq,
  type StreamEvent,
  type TextReq,
  type Usage,
} from './types.ts';

// Claude via the official SDK. Thinking stays adaptive (the model default); depth is
// steered with output_config.effort. No temperature and no assistant prefill: current
// models reject both. The system prompt (+ optional stable prefix) carries a cache
// breakpoint so repeated calls for one course reuse it.

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export interface AnthropicOptions {
  apiKey: string;
  baseUrl?: string | null;
  /**
   * Server-side refusal fallback (`fallbacks: "default"`). Only the Claude API accepts it,
   * and only for Opus/Sonnet/Fable; it is skipped for other models and custom base URLs.
   */
  serverFallback?: boolean;
  timeoutMs?: number;
  /** Custom fetch (core passes an SSRF-guarded one). */
  fetch?: typeof fetch;
}

type BetaMessage = Anthropic.Beta.BetaMessage;

function usageOf(u: Anthropic.Beta.BetaUsage | undefined): Usage {
  return {
    inputTokens: u?.input_tokens ?? 0,
    outputTokens: u?.output_tokens ?? 0,
    cacheReadTokens: u?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u?.cache_creation_input_tokens ?? 0,
  };
}

function textOf(m: BetaMessage): string {
  let out = '';
  for (const b of m.content) if (b.type === 'text') out += b.text;
  return out;
}

export class AnthropicProvider implements LlmProvider {
  readonly kind = 'ANTHROPIC' as const;
  private client: Anthropic;
  private fallback: boolean;

  constructor(opts: AnthropicOptions) {
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      baseURL: opts.baseUrl || undefined,
      timeout: opts.timeoutMs ?? 120_000,
      maxRetries: 2,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
    this.fallback = (opts.serverFallback ?? true) && !opts.baseUrl;
  }

  private common(r: TextReq) {
    const system: Anthropic.Beta.BetaTextBlockParam[] = [{ type: 'text', text: r.system }];
    if (r.cacheablePrefix) system.push({ type: 'text', text: r.cacheablePrefix });
    system[system.length - 1]!.cache_control = { type: 'ephemeral' };
    const withFallback = this.fallback && /^claude-(opus|sonnet|fable)/.test(r.model);
    return {
      model: r.model,
      max_tokens: r.maxTokens,
      system,
      messages: r.messages.map((m) => ({ role: m.role, content: m.content })),
      ...(withFallback ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const } : {}),
    };
  }

  private check(m: BetaMessage) {
    if (m.stop_reason === 'refusal') throw new AiRefusalError(undefined, usageOf(m.usage));
    if (m.stop_reason === 'max_tokens')
      throw new AiProviderError('Response was cut off (max_tokens)', usageOf(m.usage));
  }

  private wrap(e: unknown): never {
    if (e instanceof AiRefusalError || e instanceof AiProviderError) throw e;
    if (e instanceof Anthropic.APIError) {
      const retryable = e.status === 429 || (e.status ?? 0) >= 500;
      throw new AiProviderError(
        `Anthropic API ${e.status ?? ''}: ${e.message}`,
        undefined,
        retryable,
      );
    }
    throw new AiProviderError(e instanceof Error ? e.message : String(e), undefined, true);
  }

  async generateObject<T>(r: ObjectReq<T>) {
    try {
      // create + our own parse (not messages.parse): a refusal or a cut-off answer must be
      // reported as such, with its usage, rather than as a JSON error.
      const format = betaZodOutputFormat(r.schema);
      const m = await this.client.beta.messages.create(
        {
          ...this.common(r),
          output_config: { format, ...(r.effort ? { effort: r.effort } : {}) },
        },
        { signal: r.signal },
      );
      this.check(m);
      let object: T;
      try {
        object = format.parse(textOf(m)) as T;
      } catch {
        throw new AiProviderError('Model output did not match the schema', usageOf(m.usage));
      }
      return { object, usage: usageOf(m.usage), model: m.model };
    } catch (e) {
      this.wrap(e);
    }
  }

  async generateText(r: TextReq) {
    try {
      const m = await this.client.beta.messages.create(
        {
          ...this.common(r),
          ...(r.effort ? { output_config: { effort: r.effort } } : {}),
        },
        { signal: r.signal },
      );
      this.check(m);
      return { text: textOf(m), usage: usageOf(m.usage), model: m.model };
    } catch (e) {
      this.wrap(e);
    }
  }

  async *streamText(r: TextReq): AsyncIterable<StreamEvent> {
    try {
      const stream = this.client.beta.messages.stream(
        {
          ...this.common(r),
          ...(r.effort ? { output_config: { effort: r.effort } } : {}),
        },
        { signal: r.signal },
      );
      for await (const ev of stream)
        if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta')
          yield { type: 'delta', text: ev.delta.text };
      const m = await stream.finalMessage();
      if (m.stop_reason === 'refusal') throw new AiRefusalError(undefined, usageOf(m.usage));
      yield {
        type: 'done',
        usage: usageOf(m.usage),
        stopReason: m.stop_reason ?? 'end_turn',
        model: m.model,
      };
    } catch (e) {
      this.wrap(e);
    }
  }
}

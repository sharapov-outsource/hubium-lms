import type { z } from 'zod';

// Provider-neutral request/response shapes. Adapters translate these to their SDKs;
// features in core never see SDK types.

export type Effort = 'low' | 'medium' | 'high';

export interface Msg {
  role: 'user' | 'assistant';
  content: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface TextReq {
  model: string;
  /** Stable instructions; cached where the provider supports it. */
  system: string;
  /** Optional stable context placed after `system` and before messages (cached too). */
  cacheablePrefix?: string;
  messages: Msg[];
  maxTokens: number;
  effort?: Effort;
  /** Lets the mock provider pick a fixture; ignored by real providers. */
  tag?: string;
  signal?: AbortSignal;
}

export interface ObjectReq<T> extends TextReq {
  schema: z.ZodType<T>;
}

export type StreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; usage: Usage; stopReason: string; model: string };

export interface LlmProvider {
  readonly kind: 'ANTHROPIC' | 'OPENAI_COMPAT' | 'MOCK';
  generateObject<T>(r: ObjectReq<T>): Promise<{ object: T; usage: Usage; model: string }>;
  generateText(r: TextReq): Promise<{ text: string; usage: Usage; model: string }>;
  streamText(r: TextReq): AsyncIterable<StreamEvent>;
}

export interface EmbeddingProvider {
  readonly model: string;
  readonly dims: number;
  embed(texts: string[], kind: 'query' | 'document'): Promise<number[][]>;
}

/** The model declined the request (safety refusal). Logged as REFUSED. */
export class AiRefusalError extends Error {
  constructor(
    message = 'The model declined this request',
    readonly usage?: Usage,
  ) {
    super(message);
    this.name = 'AiRefusalError';
  }
}

/** Provider/transport failure or unusable output. Logged as ERROR. */
export class AiProviderError extends Error {
  constructor(
    message: string,
    readonly usage?: Usage,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'AiProviderError';
  }
}

export const emptyUsage = (): Usage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

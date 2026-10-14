import {
  AnthropicProvider,
  type EmbeddingProvider,
  type LlmProvider,
  MockEmbeddings,
  MockProvider,
  OpenAiCompatEmbeddings,
  OpenAiCompatProvider,
} from '@hubium/ai';
import type { AiFeature, AiFeatureConfig, AiProvider, Db } from '@hubium/db';
import { assertPublicUrl, checkUrlShape, safeFetch } from '@hubium/module-sdk/net';
import { z } from 'zod';
import type { RequestContext } from '../context.ts';
import { decryptSecret, encryptSecret } from '../crypto.ts';
import { getEnv } from '../env.ts';
import { NotFoundError, ValidationError } from '../errors.ts';
import { logEvent } from '../events/log.ts';
import { defineOperation } from '../operation.ts';
import { getSetting } from '../settings/settings.ts';
import { mockFixtures } from './mock-fixtures.ts';

// Site-level AI configuration: providers (with sealed API keys), per-feature settings and
// limits, per-course switches, and the embedding endpoint.

export const AI_FEATURES = ['QUIZGEN', 'GRADING_ASSIST', 'TUTOR'] as const satisfies AiFeature[];

export const featureCapability: Record<AiFeature, 'ai:quizgen' | 'ai:gradingassist' | 'ai:tutor'> =
  {
    QUIZGEN: 'ai:quizgen',
    GRADING_ASSIST: 'ai:gradingassist',
    TUTOR: 'ai:tutor',
  };

/** Default effort per feature (see architecture §Phase 7). */
export const defaultEffort: Record<AiFeature, 'low' | 'medium' | 'high'> = {
  QUIZGEN: 'medium',
  GRADING_ASSIST: 'high',
  TUTOR: 'low',
};

export const ProviderModels = z.object({
  generation: z.string().trim().min(1),
  cheap: z.string().trim().min(1),
  premium: z.string().trim().min(1),
});
export type ProviderModels = z.infer<typeof ProviderModels>;

export const FeatureLimits = z.object({
  userDailyTokens: z.number().int().min(0).nullable().default(null),
  courseMonthlyTokens: z.number().int().min(0).nullable().default(null),
  perMinute: z.number().int().min(0).nullable().default(null),
});
export type FeatureLimits = z.infer<typeof FeatureLimits>;

const seal = (s: string) => encryptSecret(s, getEnv().APP_SECRET);
const unseal = (s: string) => decryptSecret(s, getEnv().APP_SECRET);

// ── provider instances ───────────────────────────────────────────────────────

// Provider endpoints are admin-supplied: refuse internal addresses unless allowlisted.
const guardedFetch = ((input: string | URL | Request, init?: RequestInit) =>
  safeFetch(input instanceof Request ? input : String(input), init)) as typeof fetch;

function checkEndpoint(field: string, url: string | undefined) {
  if (!url) return;
  try {
    checkUrlShape(url);
  } catch (e) {
    throw new ValidationError({ [field]: [e instanceof Error ? e.message : String(e)] });
  }
}

const instances = new Map<string, { stamp: number; p: LlmProvider }>();

export function providerInstance(row: AiProvider): LlmProvider {
  const hit = instances.get(row.id);
  if (hit && hit.stamp === row.updatedAt.getTime()) return hit.p;
  const caps = (row.capabilities ?? {}) as { jsonSchema?: boolean; streaming?: boolean };
  const apiKey = row.apiKeyEnc ? unseal(row.apiKeyEnc) : null;
  let p: LlmProvider;
  if (row.kind === 'ANTHROPIC') {
    if (!apiKey) throw new ValidationError({ apiKey: ['An API key is required'] });
    p = new AnthropicProvider({ apiKey, baseUrl: row.baseUrl, fetch: guardedFetch });
  } else if (row.kind === 'OPENAI_COMPAT') {
    if (!row.baseUrl) throw new ValidationError({ baseUrl: ['A base URL is required'] });
    p = new OpenAiCompatProvider({
      baseUrl: row.baseUrl,
      apiKey,
      capabilities: caps,
      fetch: guardedFetch,
    });
  } else {
    p = new MockProvider(mockFixtures);
  }
  instances.set(row.id, { stamp: row.updatedAt.getTime(), p });
  return p;
}

let embedCache: { stamp: number; e: EmbeddingProvider | null } | undefined;

/** The configured embedding provider, or null (retrieval then uses full-text only). */
export async function embeddingProvider(db: Db): Promise<EmbeddingProvider | null> {
  const row = await db.aiEmbeddingConfig.findUnique({ where: { id: 'default' } });
  const stamp = row?.updatedAt.getTime() ?? 0;
  if (embedCache?.stamp === stamp) return embedCache.e;
  let e: EmbeddingProvider | null = null;
  if (row?.kind === 'MOCK') e = new MockEmbeddings(row.dims);
  else if (row?.kind === 'OPENAI_COMPAT' && row.baseUrl)
    e = new OpenAiCompatEmbeddings(
      {
        baseUrl: row.baseUrl,
        apiKey: row.apiKeyEnc ? unseal(row.apiKeyEnc) : null,
        fetch: guardedFetch,
      },
      row.model,
      row.dims,
    );
  embedCache = { stamp, e };
  return e;
}

// ── resolution ───────────────────────────────────────────────────────────────

export interface ResolvedFeature {
  feature: AiFeature;
  config: AiFeatureConfig;
  provider: AiProvider;
  llm: LlmProvider;
  limits: FeatureLimits;
  effort: 'low' | 'medium' | 'high';
  /** Model id for a role ('generation' | 'cheap' | 'premium') or the configured one. */
  model(role?: keyof ProviderModels): string;
  /** PENDING usage row held by aiGate; the first recorded outcome replaces it. */
  reservationId?: string | null;
}

/** Feature config if AI is on site-wide, the feature is enabled and has a provider. */
export async function resolveFeature(db: Db, feature: AiFeature): Promise<ResolvedFeature | null> {
  if (!(await getSetting(db, 'ai.enabled'))) return null;
  const config = await db.aiFeatureConfig.findUnique({
    where: { feature },
    include: { provider: true },
  });
  if (!config?.enabled || !config.provider?.enabled) return null;
  const provider = config.provider;
  const models = ProviderModels.parse(provider.models);
  const pick = (m: string) => (m in models ? models[m as keyof ProviderModels] : m);
  return {
    feature,
    config,
    provider,
    llm: providerInstance(provider),
    limits: FeatureLimits.parse(config.limits ?? {}),
    effort: (config.effort as 'low' | 'medium' | 'high' | null) ?? defaultEffort[feature],
    model: (role) => (role ? models[role] : pick(config.model)),
  };
}

/** Is the feature usable in this course (site + feature + course switch)? */
export async function featureEnabledForCourse(
  db: Db,
  feature: AiFeature,
  courseId: string,
): Promise<boolean> {
  if (!(await resolveFeature(db, feature))) return false;
  const row = await db.aiCourseFeature.findUnique({
    where: { courseId_feature: { courseId, feature } },
  });
  return row?.enabled ?? true;
}

/** Which AI features the actor can use in a course (drives UI visibility). */
export async function aiFeaturesFor(
  ctx: RequestContext,
  courseId: string,
): Promise<Record<AiFeature, boolean>> {
  const out = { QUIZGEN: false, GRADING_ASSIST: false, TUTOR: false };
  if (!(await getSetting(ctx.db, 'ai.enabled'))) return out;
  for (const f of AI_FEATURES)
    out[f] =
      (await featureEnabledForCourse(ctx.db, f, courseId)) &&
      (await ctx.perm.can(featureCapability[f], courseId));
  return out;
}

// ── admin operations ─────────────────────────────────────────────────────────

const requireAdmin = async (ctx: RequestContext) => {
  await ctx.perm.require('site:config');
};

export const saveAiProvider = defineOperation({
  name: 'ai.provider.save',
  mutation: true,
  input: z.object({
    id: z.string().uuid().optional(),
    kind: z.enum(['ANTHROPIC', 'OPENAI_COMPAT', 'MOCK']),
    name: z.string().trim().min(1).max(100),
    baseUrl: z
      .string()
      .trim()
      .url()
      .refine((u) => /^https?:\/\//.test(u), 'Only http(s) URLs')
      .optional()
      .or(z.literal('').transform(() => undefined)),
    /** Empty keeps the stored key. */
    apiKey: z.string().trim().max(500).optional(),
    models: ProviderModels,
    jsonSchema: z.boolean().default(false),
    streaming: z.boolean().default(true),
    enabled: z.boolean().default(true),
  }),
  authorize: requireAdmin,
  async handler(ctx, i) {
    if (i.kind === 'OPENAI_COMPAT' && !i.baseUrl)
      throw new ValidationError({ baseUrl: ['A base URL is required'] });
    if (i.kind !== 'MOCK') checkEndpoint('baseUrl', i.baseUrl);
    const prev = i.id ? await ctx.tx.aiProvider.findUnique({ where: { id: i.id } }) : null;
    if (i.id && !prev) throw new NotFoundError('AI provider');
    if (i.kind === 'ANTHROPIC' && !i.apiKey && !prev?.apiKeyEnc)
      throw new ValidationError({ apiKey: ['An API key is required'] });
    const data = {
      kind: i.kind,
      name: i.name,
      baseUrl: i.baseUrl ?? null,
      models: i.models,
      capabilities: { jsonSchema: i.jsonSchema, streaming: i.streaming },
      enabled: i.enabled,
      ...(i.apiKey ? { apiKeyEnc: seal(i.apiKey) } : {}),
    };
    const row = prev
      ? await ctx.tx.aiProvider.update({ where: { id: prev.id }, data })
      : await ctx.tx.aiProvider.create({ data });
    await logEvent(ctx.tx, {
      name: 'ai.provider.saved',
      actorId: ctx.perm.userId,
      objectType: 'aiProvider',
      objectId: row.id,
      origin: ctx.origin,
      ip: ctx.ip,
    });
    return { id: row.id };
  },
});

export const deleteAiProvider = defineOperation({
  name: 'ai.provider.delete',
  mutation: true,
  input: z.object({ id: z.string().uuid() }),
  authorize: requireAdmin,
  async handler(ctx, { id }) {
    await ctx.tx.aiProvider.delete({ where: { id } });
    return { id };
  },
});

export const saveAiFeature = defineOperation({
  name: 'ai.feature.save',
  mutation: true,
  input: z.object({
    feature: z.enum(AI_FEATURES),
    enabled: z.boolean(),
    providerId: z.string().uuid().nullable(),
    model: z.string().trim().min(1).max(200).default('generation'),
    effort: z.enum(['low', 'medium', 'high']).nullable().default(null),
    limits: FeatureLimits,
    /** Bump to make everyone accept the privacy notice again. */
    bumpNotice: z.boolean().default(false),
  }),
  authorize: requireAdmin,
  async handler(ctx, i) {
    if (i.enabled && !i.providerId)
      throw new ValidationError({ providerId: ['Choose a provider to enable the feature'] });
    const data = {
      enabled: i.enabled,
      providerId: i.providerId,
      model: i.model,
      effort: i.effort,
      limits: i.limits,
    };
    await ctx.tx.aiFeatureConfig.upsert({
      where: { feature: i.feature },
      create: { feature: i.feature, ...data },
      update: { ...data, ...(i.bumpNotice ? { noticeVersion: { increment: 1 } } : {}) },
    });
    return { feature: i.feature };
  },
});

export const setCourseAiFeature = defineOperation({
  name: 'ai.course.feature',
  mutation: true,
  input: z.object({
    courseId: z.string().uuid(),
    feature: z.enum(AI_FEATURES),
    enabled: z.boolean(),
  }),
  async authorize(ctx, i) {
    await ctx.perm.require('course:update', i.courseId);
  },
  async handler(ctx, i) {
    await ctx.tx.aiCourseFeature.upsert({
      where: { courseId_feature: { courseId: i.courseId, feature: i.feature } },
      create: i,
      update: { enabled: i.enabled },
    });
    return i;
  },
});

export const saveEmbeddingConfig = defineOperation({
  name: 'ai.embeddings.save',
  mutation: true,
  input: z.object({
    kind: z.enum(['OPENAI_COMPAT', 'MOCK']).nullable(),
    baseUrl: z
      .string()
      .trim()
      .url()
      .optional()
      .or(z.literal('').transform(() => undefined)),
    model: z.string().trim().max(200).default(''),
    apiKey: z.string().trim().max(500).optional(),
  }),
  authorize: requireAdmin,
  async handler(ctx, i) {
    if (!i.kind) {
      await ctx.tx.aiEmbeddingConfig.deleteMany({});
      return { kind: null };
    }
    if (i.kind === 'OPENAI_COMPAT' && (!i.baseUrl || !i.model))
      throw new ValidationError({ baseUrl: ['Base URL and model are required'] });
    if (i.kind === 'OPENAI_COMPAT') checkEndpoint('baseUrl', i.baseUrl);
    const prev = await ctx.tx.aiEmbeddingConfig.findUnique({ where: { id: 'default' } });
    const model = i.kind === 'MOCK' ? 'mock-hash' : i.model;
    const data = {
      kind: i.kind,
      baseUrl: i.baseUrl ?? null,
      model,
      dims: 1024,
      ...(i.apiKey ? { apiKeyEnc: seal(i.apiKey) } : {}),
    };
    await ctx.tx.aiEmbeddingConfig.upsert({
      where: { id: 'default' },
      create: { id: 'default', ...data },
      update: data,
    });
    // A new model makes stored vectors meaningless: drop them, reindexing refills.
    if (prev && prev.model !== model)
      await ctx.tx.$executeRaw`UPDATE "ContentChunk" SET "embedding" = NULL`;
    return { kind: i.kind };
  },
});

/**
 * The embedding endpoint from the environment: AI_EMBEDDINGS_URL, AI_EMBEDDINGS_MODEL and
 * optionally AI_EMBEDDINGS_API_KEY (the ai-local compose profile points them at its Ollama).
 * Applied by the seed only while no endpoint is configured, so a choice made later in
 * Administration → AI is kept. An internal host must be listed in SSRF_ALLOW_HOSTS.
 */
export async function seedEmbeddingsFromEnv(
  db: Db,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ status: 'none' | 'created' | 'kept' | 'refused'; reason?: string }> {
  const baseUrl = env.AI_EMBEDDINGS_URL?.trim();
  const model = env.AI_EMBEDDINGS_MODEL?.trim();
  if (!baseUrl || !model) return { status: 'none' };
  if (await db.aiEmbeddingConfig.findUnique({ where: { id: 'default' } }))
    return { status: 'kept' };
  try {
    await assertPublicUrl(baseUrl);
  } catch (e) {
    return { status: 'refused', reason: e instanceof Error ? e.message : String(e) };
  }
  const apiKey = env.AI_EMBEDDINGS_API_KEY?.trim();
  await db.aiEmbeddingConfig.create({
    data: {
      id: 'default',
      kind: 'OPENAI_COMPAT',
      baseUrl,
      model,
      dims: 1024,
      apiKeyEnc: apiKey ? seal(apiKey) : null,
    },
  });
  return { status: 'created' };
}

/** Admin view: providers without secrets. */
export async function listAiProviders(db: Db) {
  const rows = await db.aiProvider.findMany({ orderBy: { createdAt: 'asc' } });
  return rows.map(({ apiKeyEnc, ...r }) => ({ ...r, hasKey: !!apiKeyEnc }));
}

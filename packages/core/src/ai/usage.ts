import { AiProviderError, AiRefusalError, type Usage } from '@hubium/ai';
import type { AiFeature, AiUsageStatus, Db, Prisma } from '@hubium/db';
import type { RequestContext } from '../context.ts';
import { AppError, ForbiddenError, NotFoundError } from '../errors.ts';
import {
  featureCapability,
  featureEnabledForCourse,
  type ResolvedFeature,
  resolveFeature,
} from './config.ts';

// Every AI call goes through `runAi`: it checks the feature is on for the course, the
// actor's capability and consent, enforces quotas, and writes one AiUsage row whatever
// happens (OK, ERROR, REFUSED or LIMITED).

export type AiLimitKind = 'perMinute' | 'userDaily' | 'courseMonthly';

/** A quota is exhausted. `kind` selects the localised message (`ai.limit.<kind>`). */
export class AiLimitError extends AppError {
  constructor(readonly kind: AiLimitKind) {
    super('RATE_LIMITED', `AI limit reached: ${kind}`, { details: { kind } });
    this.name = 'AiLimitError';
  }
}

/** The user has not accepted the current privacy notice for this feature. */
export class AiConsentRequiredError extends AppError {
  constructor(readonly noticeVersion: number) {
    super('FORBIDDEN', 'AI consent required', { details: { consent: noticeVersion } });
    this.name = 'AiConsentRequiredError';
  }
}

/** The model declined; shown to the user as a neutral "can't help with that". */
export class AiRefusedError extends AppError {
  constructor() {
    super('BAD_REQUEST', 'The AI declined this request');
    this.name = 'AiRefusedError';
  }
}

export class AiUnavailableError extends AppError {
  constructor(message = 'The AI service is unavailable, try again later') {
    super('INTERNAL', message);
    this.name = 'AiUnavailableError';
  }
}

const tokens = (u: { inputTokens: number; outputTokens: number }) => u.inputTokens + u.outputTokens;

type Tx = Db | Prisma.TransactionClient;

export async function recordUsage(
  db: Tx,
  r: {
    feature: AiFeature;
    userId: string | null;
    courseId: string | null;
    providerId: string | null;
    model: string;
    usage?: Usage;
    durationMs: number;
    status: AiUsageStatus;
    error?: string;
    /** A PENDING reservation to complete instead of adding a row. */
    reservationId?: string | null;
  },
) {
  const data = {
    feature: r.feature,
    userId: r.userId,
    courseId: r.courseId,
    providerId: r.providerId,
    model: r.model,
    inputTokens: r.usage?.inputTokens ?? 0,
    outputTokens: r.usage?.outputTokens ?? 0,
    cacheReadTokens: r.usage?.cacheReadTokens ?? 0,
    cacheWriteTokens: r.usage?.cacheWriteTokens ?? 0,
    durationMs: r.durationMs,
    status: r.status,
    error: r.error?.slice(0, 1000) ?? null,
  };
  return r.reservationId
    ? db.aiUsage.update({ where: { id: r.reservationId }, data })
    : db.aiUsage.create({ data });
}

/** Hands out the gate's reservation once; later calls on the same feature add rows. */
export function takeReservation(f: ResolvedFeature): string | null {
  const id = f.reservationId ?? null;
  f.reservationId = null;
  return id;
}

/** Gives back the gate's reservation when the call it was for is not made after all. */
export async function dropReservation(db: Tx, f: ResolvedFeature): Promise<void> {
  const id = takeReservation(f);
  if (id) await db.aiUsage.deleteMany({ where: { id, status: 'PENDING' } });
}

async function sumTokens(db: Tx, where: object): Promise<number> {
  const agg = await db.aiUsage.aggregate({
    where,
    _sum: { inputTokens: true, outputTokens: true },
  });
  return (agg._sum.inputTokens ?? 0) + (agg._sum.outputTokens ?? 0);
}

/**
 * Throws AiLimitError (after logging LIMITED) when any quota is exhausted. Checks for one
 * user and feature run one at a time and, with `reserve`, leave a PENDING row behind, so
 * parallel requests cannot all slip under the per-minute limit.
 */
export async function checkLimits(
  db: Db,
  f: ResolvedFeature,
  userId: string | null,
  courseId: string | null,
  now = new Date(),
  opts: { reserve?: boolean } = {},
): Promise<string | null> {
  const { perMinute, userDailyTokens, courseMonthlyTokens } = f.limits;
  const r = await db.$transaction(async (tx) => {
    if (userId)
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ai:${f.feature}:${userId}`}))`;
    let hit: AiLimitKind | null = null;
    if (perMinute !== null && userId) {
      const n = await tx.aiUsage.count({
        where: {
          feature: f.feature,
          userId,
          status: { not: 'LIMITED' },
          createdAt: { gte: new Date(now.getTime() - 60_000) },
        },
      });
      if (n >= perMinute) hit = 'perMinute';
    }
    if (!hit && userDailyTokens !== null && userId) {
      const day = new Date(now);
      day.setUTCHours(0, 0, 0, 0);
      const used = await sumTokens(tx, { feature: f.feature, userId, createdAt: { gte: day } });
      if (used >= userDailyTokens) hit = 'userDaily';
    }
    if (!hit && courseMonthlyTokens !== null && courseId) {
      const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const used = await sumTokens(tx, { feature: f.feature, courseId, createdAt: { gte: month } });
      if (used >= courseMonthlyTokens) hit = 'courseMonthly';
    }
    const base = {
      feature: f.feature,
      userId,
      courseId,
      providerId: f.provider.id,
      model: f.model(),
      durationMs: 0,
    };
    if (hit) {
      await recordUsage(tx, { ...base, status: 'LIMITED', error: hit });
      return { hit, id: null };
    }
    if (!opts.reserve) return { hit: null, id: null };
    return { hit: null, id: (await recordUsage(tx, { ...base, status: 'PENDING' })).id };
  });
  if (r.hit) throw new AiLimitError(r.hit);
  return r.id;
}

// ── consent ──────────────────────────────────────────────────────────────────

export async function consentStatus(db: Db, userId: string, feature: AiFeature) {
  const cfg = await db.aiFeatureConfig.findUnique({ where: { feature } });
  const version = cfg?.noticeVersion ?? 1;
  const row = await db.aiConsent.findUnique({
    where: { userId_feature_noticeVersion: { userId, feature, noticeVersion: version } },
  });
  return { noticeVersion: version, accepted: !!row };
}

export async function acceptConsent(ctx: RequestContext, feature: AiFeature) {
  if (ctx.actor.kind !== 'user') throw new ForbiddenError();
  const { noticeVersion } = await consentStatus(ctx.db, ctx.actor.userId, feature);
  await ctx.db.aiConsent.upsert({
    where: {
      userId_feature_noticeVersion: { userId: ctx.actor.userId, feature, noticeVersion },
    },
    create: { userId: ctx.actor.userId, feature, noticeVersion },
    update: {},
  });
  return { noticeVersion };
}

// ── the gate ─────────────────────────────────────────────────────────────────

export interface AiCall {
  feature: AiFeature;
  courseId: string;
  /** Skip the per-user consent check (background work the user already consented to). */
  skipConsent?: boolean;
  /** Hold a usage row for the call that follows (false when the work is queued). */
  reserve?: boolean;
}

/** Feature/permission/consent/limit checks; returns the resolved feature. 404 when off. */
export async function aiGate(ctx: RequestContext, call: AiCall): Promise<ResolvedFeature> {
  const f = await resolveFeature(ctx.db, call.feature);
  if (!f || !(await featureEnabledForCourse(ctx.db, call.feature, call.courseId)))
    throw new NotFoundError('AI feature');
  await ctx.perm.require(featureCapability[call.feature], call.courseId);
  const userId = ctx.actor.kind === 'user' ? ctx.actor.userId : null;
  if (userId && !call.skipConsent) {
    const c = await consentStatus(ctx.db, userId, call.feature);
    if (!c.accepted) throw new AiConsentRequiredError(c.noticeVersion);
  }
  f.reservationId = await checkLimits(ctx.db, f, userId, call.courseId, ctx.now, {
    reserve: call.reserve ?? true,
  });
  return f;
}

/**
 * Runs one provider call with usage logging. `fn` returns the result plus usage/model;
 * provider errors become AppErrors the UI can show.
 */
export async function runAi<T>(
  ctx: RequestContext,
  f: ResolvedFeature,
  call: { courseId: string | null; userId?: string | null },
  fn: () => Promise<{ value: T; usage: Usage; model: string }>,
): Promise<T & { usageId: string }> {
  const started = Date.now();
  const base = {
    feature: f.feature,
    userId:
      call.userId !== undefined ? call.userId : ctx.actor.kind === 'user' ? ctx.actor.userId : null,
    courseId: call.courseId,
    providerId: f.provider.id,
  };
  const reservationId = takeReservation(f);
  try {
    const r = await fn();
    const row = await recordUsage(ctx.db, {
      ...base,
      reservationId,
      model: r.model,
      usage: r.usage,
      durationMs: Date.now() - started,
      status: 'OK',
    });
    return Object.assign(r.value as object, { usageId: row.id }) as T & { usageId: string };
  } catch (e) {
    const refused = e instanceof AiRefusalError;
    await recordUsage(ctx.db, {
      ...base,
      reservationId,
      model: f.model(),
      usage: e instanceof AiRefusalError || e instanceof AiProviderError ? e.usage : undefined,
      durationMs: Date.now() - started,
      status: refused ? 'REFUSED' : 'ERROR',
      error: e instanceof Error ? e.message : String(e),
    });
    if (refused) throw new AiRefusedError();
    if (e instanceof AppError) throw e;
    throw new AiUnavailableError();
  }
}

// ── reporting ────────────────────────────────────────────────────────────────

/** Usage dashboard: totals per feature and status for the last `days` days. */
export async function usageSummary(db: Db, days = 30, now = new Date()) {
  const since = new Date(now.getTime() - days * 86_400_000);
  const rows = await db.aiUsage.groupBy({
    by: ['feature', 'status'],
    where: { createdAt: { gte: since } },
    _count: { _all: true },
    _sum: { inputTokens: true, outputTokens: true, cacheReadTokens: true },
  });
  const topCourses = await db.aiUsage.groupBy({
    by: ['courseId'],
    where: { createdAt: { gte: since }, courseId: { not: null } },
    _sum: { inputTokens: true, outputTokens: true },
    orderBy: { _sum: { outputTokens: 'desc' } },
    take: 10,
  });
  return {
    since,
    rows: rows.map((r) => ({
      feature: r.feature,
      status: r.status,
      requests: r._count._all,
      inputTokens: r._sum.inputTokens ?? 0,
      outputTokens: r._sum.outputTokens ?? 0,
      cacheReadTokens: r._sum.cacheReadTokens ?? 0,
    })),
    topCourses: topCourses.map((c) => ({
      courseId: c.courseId!,
      tokens: tokens({
        inputTokens: c._sum.inputTokens ?? 0,
        outputTokens: c._sum.outputTokens ?? 0,
      }),
    })),
  };
}

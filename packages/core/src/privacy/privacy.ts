import type { Db, Prisma } from '@hubium/db';
import { z } from 'zod';
import type { RequestContext } from '../context.ts';
import { ForbiddenError, NotFoundError, ValidationError } from '../errors.ts';
import { logEvent } from '../events/log.ts';
import { type Localized, localizedText } from '../lib/localized.ts';
import { buildModuleCtx } from '../modules/module-ctx.ts';
import { listModules } from '../modules/registry.ts';
import { defineOperation } from '../operation.ts';
import { listProfileFields, profileFieldLabel, profileValueText } from '../users/profile-fields.ts';

// Personal data: export ("download my data") and erasure on account deletion, plus
// site policies (privacy policy, terms) that users accept before using the site.

async function canManage(ctx: RequestContext, userId: string) {
  if (ctx.actor.kind === 'user' && ctx.actor.userId === userId) return;
  await ctx.perm.require('user:update');
}

/** Everything Hubium stores about a user, as JSON (files are listed, not embedded). */
export async function exportUserData(ctx: RequestContext, userId: string) {
  await canManage(ctx, userId);
  const db = ctx.db;
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      username: true,
      name: true,
      firstName: true,
      lastName: true,
      locale: true,
      timezone: true,
      createdAt: true,
      lastLoginAt: true,
      customFields: true,
      messagePrivacy: true,
    },
  });
  if (!user) throw new NotFoundError('User');
  const [
    enrolments,
    roles,
    grades,
    completions,
    events,
    messages,
    notifications,
    preferences,
    files,
    tutor,
    aiConsents,
    policies,
    tokens,
    log,
    suggestions,
    devices,
  ] = await Promise.all([
    db.enrolment.findMany({
      where: { userId },
      select: { course: { select: { id: true, fullName: true } }, status: true, createdAt: true },
    }),
    db.roleAssignment.findMany({
      where: { userId },
      select: { contextId: true, role: { select: { shortName: true } } },
    }),
    db.grade.findMany({
      where: { userId },
      select: {
        item: { select: { name: true, courseId: true } },
        finalGrade: true,
        feedback: true,
      },
    }),
    db.activityCompletion.findMany({
      where: { userId },
      select: { activityId: true, state: true, completedAt: true },
    }),
    db.calendarEvent.findMany({
      where: { userId, scope: 'USER' },
      select: { title: true, description: true, startsAt: true, endsAt: true },
    }),
    db.message.findMany({
      where: { senderId: userId, deletedAt: null },
      select: { conversationId: true, body: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    }),
    db.notification.findMany({
      where: { userId },
      select: { type: true, title: true, body: true, createdAt: true, readAt: true },
    }),
    db.notificationPreference.findMany({ where: { userId } }),
    db.file.findMany({
      where: { uploadedById: userId },
      select: {
        name: true,
        mimeType: true,
        size: true,
        createdAt: true,
        component: true,
        area: true,
      },
    }),
    db.tutorConversation.findMany({
      where: { userId },
      select: {
        courseId: true,
        title: true,
        messages: { select: { role: true, content: true, createdAt: true } },
      },
    }),
    db.aiConsent.findMany({ where: { userId } }),
    db.policyAcceptance.findMany({
      where: { userId },
      select: { acceptedAt: true, version: { select: { policy: { select: { key: true } } } } },
    }),
    db.apiToken.findMany({
      where: { userId },
      select: { name: true, scopes: true, createdAt: true, lastUsedAt: true, revokedAt: true },
    }),
    db.eventLog.findMany({
      where: { actorId: userId },
      select: { name: true, createdAt: true, courseId: true, ip: true },
      orderBy: { createdAt: 'desc' },
      take: 1000,
    }),
    // AI grading drafts written about the user's submissions
    db.gradingSuggestion.findMany({
      where: { userId },
      select: {
        activityId: true,
        suggestedGrade: true,
        feedbackDraft: true,
        status: true,
        createdAt: true,
      },
    }),
    db.pushSubscription.findMany({
      where: { userId },
      select: { userAgent: true, createdAt: true, lastUsedAt: true },
    }),
  ]);
  const modules: Record<string, unknown> = {};
  const mctx = buildModuleCtx(ctx);
  for (const m of listModules())
    if (m.privacy?.export) modules[m.key] = await m.privacy.export(mctx, userId);
  await logEvent(db, {
    name: 'privacy.exported',
    actorId: ctx.actor.kind === 'user' ? ctx.actor.userId : null,
    relatedUserId: userId,
    origin: ctx.origin,
  });
  // custom profile fields under their names, as the person saw them on the profile
  const stored = (user.customFields ?? {}) as Record<string, string | boolean>;
  const customFields = (await listProfileFields(db))
    .filter((f) => f.shortName in stored)
    .map((f) => ({
      field: profileFieldLabel(f, ctx.locale),
      value: profileValueText(stored[f.shortName]),
    }));
  return JSON.parse(
    JSON.stringify({
      exportedAt: ctx.now.toISOString(),
      user: { ...user, customFields },
      enrolments,
      roles,
      grades,
      completions,
      calendar: events,
      messages,
      notifications,
      notificationPreferences: preferences,
      files: files.map((f) => ({ ...f, size: Number(f.size) })),
      ai: { tutorConversations: tutor, consents: aiConsents, gradingSuggestions: suggestions },
      pushDevices: devices,
      policies,
      apiTokens: tokens,
      activityLog: log,
      modules,
    }),
  );
}

/**
 * Removes personal content when an account is deleted. Identity fields are anonymised by
 * `deleteUser`; grades, attempts and completion records stay for course statistics.
 */
export async function erasePersonalData(
  ctx: RequestContext,
  tx: Prisma.TransactionClient,
  userId: string,
) {
  await tx.apiToken.deleteMany({ where: { userId } });
  await tx.aiConsent.deleteMany({ where: { userId } });
  await tx.tutorConversation.deleteMany({ where: { userId } });
  await tx.gradingSuggestion.deleteMany({ where: { userId } });
  await tx.pushSubscription.deleteMany({ where: { userId } });
  await tx.notification.deleteMany({ where: { userId } });
  await tx.notificationPreference.deleteMany({ where: { userId } });
  await tx.calendarEvent.deleteMany({ where: { userId, scope: 'USER' } });
  // Webhook deliveries carry the person's name and email until they are pruned.
  await tx.$executeRaw`DELETE FROM "WebhookDelivery" WHERE payload -> 'user' ->> 'id' = ${userId}`;
  await tx.message.updateMany({
    where: { senderId: userId, deletedAt: null },
    data: { body: '', deletedAt: ctx.now },
  });
  await tx.userBlock.deleteMany({ where: { OR: [{ userId }, { blockedUserId: userId }] } });
  const mctx = buildModuleCtx(ctx, tx);
  for (const m of listModules()) if (m.privacy?.erase) await m.privacy.erase(mctx, userId);
}

// ── policies ─────────────────────────────────────────────────────────────────

export const savePolicy = defineOperation({
  name: 'policy.save',
  mutation: true,
  input: z.object({
    id: z.string().uuid().optional(),
    key: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9-]{1,40}$/, 'Lowercase letters, digits and dashes'),
    name: localizedText(200),
  }),
  authorize: (ctx) => ctx.perm.require('site:config'),
  async handler(ctx, i) {
    const p = i.id
      ? await ctx.tx.policy.update({ where: { id: i.id }, data: { key: i.key, name: i.name } })
      : await ctx.tx.policy.create({ data: { key: i.key, name: i.name } });
    return { id: p.id };
  },
});

export const publishPolicyVersion = defineOperation({
  name: 'policy.publish',
  mutation: true,
  input: z.object({
    policyId: z.string().uuid(),
    content: localizedText(500_000),
    mandatory: z.boolean().default(true),
  }),
  authorize: (ctx) => ctx.perm.require('site:config'),
  async handler(ctx, i) {
    const v = await ctx.tx.policyVersion.create({
      data: {
        policyId: i.policyId,
        content: i.content,
        mandatory: i.mandatory,
        publishedAt: ctx.now,
      },
    });
    await logEvent(ctx.tx, {
      name: 'policy.published',
      actorId: ctx.perm.userId,
      objectType: 'policyVersion',
      objectId: v.id,
      origin: ctx.origin,
    });
    return { id: v.id };
  },
});

export async function listPolicies(db: Db) {
  const policies = await db.policy.findMany({
    orderBy: { createdAt: 'asc' },
    include: {
      versions: {
        where: { publishedAt: { not: null } },
        orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
        take: 1,
        include: { _count: { select: { acceptances: true } } },
      },
    },
  });
  return policies.map((p) => ({ ...p, current: p.versions[0] ?? null }));
}

/** Latest published mandatory versions the user has not accepted yet. */
export async function pendingPolicies(db: Db, userId: string) {
  const policies = await listPolicies(db);
  const current = policies.flatMap((p) =>
    p.current?.mandatory ? [{ policy: p, version: p.current }] : [],
  );
  if (!current.length) return [];
  const accepted = new Set(
    (
      await db.policyAcceptance.findMany({
        where: { userId, versionId: { in: current.map((c) => c.version.id) } },
        select: { versionId: true },
      })
    ).map((a) => a.versionId),
  );
  return current
    .filter((c) => !accepted.has(c.version.id))
    .map((c) => ({
      versionId: c.version.id,
      key: c.policy.key,
      name: c.policy.name as Localized,
      content: c.version.content as Localized,
      publishedAt: c.version.publishedAt!,
    }));
}

export async function acceptPolicies(ctx: RequestContext, versionIds: string[]) {
  if (ctx.actor.kind !== 'user') throw new ForbiddenError();
  const userId = ctx.actor.userId;
  const pending = await pendingPolicies(ctx.db, userId);
  const ids = new Set(pending.map((p) => p.versionId));
  const missing = [...ids].filter((id) => !versionIds.includes(id));
  if (missing.length)
    throw new ValidationError({ versionIds: ['Accept every policy to continue'] });
  await ctx.db.policyAcceptance.createMany({
    data: [...ids].map((versionId) => ({ userId, versionId })),
    skipDuplicates: true,
  });
  return { accepted: ids.size };
}

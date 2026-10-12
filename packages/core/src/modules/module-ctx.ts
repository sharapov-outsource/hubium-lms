import type { Activity, Prisma } from '@hubium/db';
import type { ActivityRef, ModuleCtx, ModuleFile } from '@hubium/module-sdk';
import { parseSettings } from '@hubium/module-sdk';
import type { Capability } from '../access/capabilities.ts';
import { usersWithCap } from '../access/permissions.ts';
import { contentUrl } from '../content.ts';
import type { RequestContext } from '../context.ts';
import { logEvent } from '../events/log.ts';
import { deleteFiles, fileUrl, listFiles, storeFile, storeFileFromPath } from '../files/files.ts';
import { getStorage } from '../files/storage.ts';
import { consumeUpload } from '../files/uploads.ts';
import { enqueue } from '../jobs/jobs.ts';
import { publishRealtime } from '../realtime.ts';
import { requireModule } from './registry.ts';

// Late-bound services implemented in later layers (grades, notifications, completion)
// to avoid import cycles inside core.
export interface ModuleServices {
  setGrades: ModuleCtx['grades']['setGrades'];
  syncGradeItems: ModuleCtx['grades']['syncItems'];
  markViewed: ModuleCtx['completion']['markViewed'];
  recomputeCompletion: ModuleCtx['completion']['recompute'];
  notify: ModuleCtx['notify']['send'];
  activityAccess: ModuleCtx['activities']['get'];
  ai: ModuleCtx['ai'];
}

const services: Partial<Record<keyof ModuleServices, unknown>> = {};

export function provideModuleServices(
  s: Partial<{
    [K in keyof ModuleServices]: (
      ctx: RequestContext,
      tx: Prisma.TransactionClient,
    ) => ModuleServices[K];
  }>,
): void {
  Object.assign(services, s);
}

function service<K extends keyof ModuleServices>(
  name: K,
  ctx: RequestContext,
  tx: Prisma.TransactionClient,
): ModuleServices[K] {
  const factory = services[name] as
    | ((c: RequestContext, t: Prisma.TransactionClient) => ModuleServices[K])
    | undefined;
  if (!factory) {
    return (async () => {
      throw new Error(`Module service ${name} is not available`);
    }) as unknown as ModuleServices[K];
  }
  return factory(ctx, tx);
}

export function toActivityRef<S = unknown>(a: Activity): ActivityRef<S> {
  const m = requireModule(a.moduleKey);
  return {
    id: a.id,
    courseId: a.courseId,
    sectionId: a.sectionId,
    moduleKey: a.moduleKey,
    name: a.name,
    intro: a.intro,
    settings: parseSettings(m, a.settings) as S,
    completionMode: a.completionMode,
    completionRules: (a.completionRules ?? {}) as Record<string, unknown>,
    groupMode: a.groupMode,
    visibility: a.visibility,
  };
}

function toModuleFile(f: {
  id: string;
  name: string;
  mimeType: string;
  size: bigint;
  path: string;
  itemId: string;
}): ModuleFile {
  return {
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    size: f.size,
    path: f.path,
    itemId: f.itemId,
    url: fileUrl(f),
  };
}

function moduleKey(key: string): string {
  if (!/^mod\/[a-z][a-z0-9_-]*\/[\w./-]+$/.test(key) || key.includes('..')) {
    throw new Error(`Invalid module storage key: ${key}`);
  }
  return key;
}

export function buildModuleCtx(
  ctx: RequestContext,
  tx: Prisma.TransactionClient = ctx.db,
): ModuleCtx {
  const component = (moduleKey: string) => `mod.${moduleKey}`;
  const activityKey = async (activityId: string) => {
    const a = await tx.activity.findUniqueOrThrow({
      where: { id: activityId },
      select: { moduleKey: true },
    });
    return component(a.moduleKey);
  };
  return {
    db: tx,
    actor: ctx.actor,
    now: ctx.now,
    locale: ctx.locale,
    perm: {
      can: (cap, contextId) => ctx.perm.can(cap as Capability, contextId),
      require: (cap, contextId) => ctx.perm.require(cap as Capability, contextId),
      usersWithCap: async (cap, contextId, opts) => {
        const a = await tx.activity.findUnique({
          where: { id: contextId },
          select: { courseId: true },
        });
        const courseId = a?.courseId ?? contextId;
        return usersWithCap(ctx.db, cap as Capability, courseId, {
          contextId,
          groupId: opts?.groupId,
        });
      },
    },
    files: {
      async list(activityId, area, itemId) {
        const files = await listFiles(tx, {
          contextId: activityId,
          component: await activityKey(activityId),
          area,
          itemId,
        });
        return files.map(toModuleFile);
      },
      async store(activityId, area, file, opts) {
        const f = await storeFile(tx, {
          contextId: activityId,
          component: await activityKey(activityId),
          area,
          itemId: file.itemId,
          path: file.path,
          name: file.name,
          mimeType: file.mimeType,
          data: file.data,
          uploadedById: ctx.actor.kind === 'user' ? ctx.actor.userId : null,
          maxBytes: opts?.maxBytes,
          replace: opts?.replace,
        });
        return toModuleFile(f);
      },
      async storeUpload(activityId, area, uploadId, opts) {
        if (ctx.actor.kind !== 'user') throw new Error('Sign in required');
        const component = await activityKey(activityId);
        const f = await consumeUpload(tx, ctx.actor.userId, uploadId, (u) =>
          storeFileFromPath(tx, {
            contextId: activityId,
            component,
            area,
            itemId: opts?.itemId,
            name: u.name,
            mimeType: u.mimeType,
            filePath: u.path,
            uploadedById: ctx.actor.kind === 'user' ? ctx.actor.userId : null,
            maxBytes: opts?.maxBytes,
            allowedTypes: opts?.allowedTypes,
            replace: opts?.replace,
          }),
        );
        return toModuleFile(f);
      },
      async open(fileId) {
        const f = await tx.file.findUniqueOrThrow({
          where: { id: fileId },
          include: { blob: true },
        });
        return {
          stream: await getStorage().getStream(f.blob.storageKey),
          name: f.name,
          mimeType: f.mimeType,
          size: Number(f.size),
        };
      },
      async remove(activityId, area, ids, itemId) {
        await deleteFiles(tx, {
          contextId: activityId,
          component: await activityKey(activityId),
          area,
          itemId,
          ids,
        });
      },
    },
    grades: {
      setGrades: (activityId, grades) => service('setGrades', ctx, tx)(activityId, grades),
      syncItems: (activityId) => service('syncGradeItems', ctx, tx)(activityId),
    },
    completion: {
      markViewed: (activityId, userId) => service('markViewed', ctx, tx)(activityId, userId),
      recompute: (activityId, userId) =>
        service('recomputeCompletion', ctx, tx)(activityId, userId),
    },
    notify: {
      send: (userIds, n) => service('notify', ctx, tx)(userIds, n),
    },
    storage: {
      put: (key, body, type) => getStorage().put(moduleKey(key), body, type),
      get: (key) => getStorage().getStream(moduleKey(key)),
      head: (key) => getStorage().head(moduleKey(key)),
      async delete(keys) {
        for (const k of keys) await getStorage().delete(moduleKey(k));
      },
    },
    jobs: {
      async enqueue(name, data, opts) {
        await enqueue(name, data, { tx, ...opts });
      },
    },
    realtime: {
      publish: (userIds, type, data) => publishRealtime(tx, userIds, type, data),
    },
    activities: {
      get: (activityId) => service('activityAccess', ctx, tx)(activityId),
    },
    get ai() {
      return services.ai
        ? service('ai', ctx, tx)
        : {
            status: async () => ({ available: false, consentRequired: false, notice: '' }),
            acceptConsent: async () => {},
            suggestGrade: async () => {
              throw new Error('AI is not available');
            },
            markSuggestion: async () => {},
          };
    },
    content: {
      url(activityId, path, opts) {
        const userId = opts?.userId ?? (ctx.actor.kind === 'user' ? ctx.actor.userId : '');
        return contentUrl({ a: activityId, u: userId, d: opts?.data }, path, opts?.ttlSec);
      },
      appOrigin: () => (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/+$/, ''),
    },
    async log(event, data) {
      await logEvent(tx, {
        name: event,
        actorId: ctx.actor.kind === 'user' ? ctx.actor.userId : null,
        data: (data ?? {}) as Prisma.InputJsonValue,
        origin: ctx.origin,
        ip: ctx.ip,
      });
    },
  };
}

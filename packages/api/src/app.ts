import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  type ApiScope,
  AppError,
  actionInputFromForm,
  appendUploadChunk,
  authenticateApiToken,
  categoryFractions,
  createCourse,
  createUpload,
  createUser,
  createWebhook,
  deleteWebhook,
  enrolUsers,
  flattenTree,
  getActivityAccess,
  getCategoryTree,
  getCourseAccess,
  getCourseOutline,
  getUpload,
  getWebhook,
  type gradebookStructure,
  graderReport,
  listApiTokens,
  listConversations,
  listGroupings,
  listGroups,
  listMessages,
  listMyCourses,
  listNotifications,
  listParticipants,
  listUserEvents,
  listUsers,
  listWebhookDeliveries,
  listWebhooks,
  markNotificationsRead,
  pingWebhook,
  type RequestContext,
  redeliverWebhook,
  revokeApiToken,
  rotateWebhookSecret,
  runModuleAction,
  searchCatalog,
  sendMessage,
  toActionError,
  updateWebhook,
  userReport,
  WEBHOOK_EVENTS,
} from '@hubium/core';
import type { Db, Grade } from '@hubium/db';
import { fromAcceptLanguage, locales } from '@hubium/i18n';
import { log } from '@hubium/log';
import type { Context, MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { documentModuleActions } from './actions-doc.ts';
import { DOCS_CSP, docsPage, scalarBundle } from './docs.ts';
import { rateLimit } from './rate-limit.ts';

const logger = log('api');

// REST API v1: a thin transport over core operations. Every request is authenticated
// with a personal access token and runs as its user, narrowed by the token's scopes.

type Env = { Variables: { ctx: RequestContext; scopes: ApiScope[] } };

const STATUS = {
  VALIDATION: 400,
  BAD_REQUEST: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  INTERNAL: 500,
} as const;

const ErrorSchema = z
  .object({
    code: z.string().openapi({ example: 'NOT_FOUND' }),
    message: z.string(),
    fieldErrors: z.record(z.string(), z.array(z.string())).optional(),
  })
  .openapi('Error');

const err = (description: string) => ({
  content: { 'application/json': { schema: ErrorSchema } },
  description,
});
const ok = <T extends z.ZodType>(schema: T, description = 'OK') => ({
  content: { 'application/json': { schema } },
  description,
});
const errors = {
  400: err('Invalid input'),
  401: err('Missing or invalid token'),
  403: err('Not allowed'),
  404: err('Not found'),
  429: err('Rate limit exceeded'),
};
/** Changes may also collide with existing data (a taken short name, an existing enrolment). */
const writeErrors = { ...errors, 409: err('Conflicts with existing data') };
const security = [{ bearerAuth: [] }];
const Id = z.string().uuid();
const IdParam = z.object({ id: Id.openapi({ param: { name: 'id', in: 'path' } }) });
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

// ── schemas ──────────────────────────────────────────────────────────────────

const CustomFields = z.record(z.string(), z.union([z.string(), z.boolean()])).openapi({
  description: 'Custom profile fields by short name (Administration → Profile fields)',
});

const Me = z
  .object({
    id: Id,
    username: z.string().nullable(),
    email: z.string().nullable().openapi({ description: 'Null for accounts without an email' }),
    name: z.string(),
    firstName: z.string(),
    lastName: z.string(),
    locale: z.string().nullable(),
    timezone: z.string().nullable(),
    isSiteAdmin: z.boolean(),
    customFields: CustomFields,
  })
  .openapi('Me');

const User = z
  .object({
    id: Id,
    username: z.string().nullable(),
    email: z.string().nullable(),
    name: z.string(),
    status: z.string(),
    lastLoginAt: z.string().nullable(),
    customFields: CustomFields,
  })
  .openapi('User');

const Category = z
  .object({
    id: Id,
    parentId: Id.nullable(),
    name: z.string(),
    depth: z.number().int(),
    courseCount: z.number().int(),
  })
  .openapi('Category');

const Course = z
  .object({
    id: Id,
    fullName: z.string(),
    shortName: z.string(),
    idNumber: z.string().nullable(),
    summary: z.string(),
    categoryId: Id,
    visible: z.boolean(),
    startDate: z.string().nullable(),
    endDate: z.string().nullable(),
    progress: z.number().nullable().optional().openapi({ description: 'Your completion, %' }),
    role: z.string().nullable().optional().openapi({ description: 'Your role in the course' }),
  })
  .openapi('Course');

const courseJson = (x: {
  id: string;
  fullName: string;
  shortName: string;
  idNumber: string | null;
  summary: string;
  categoryId: string;
  visible: boolean;
  startDate: Date | null;
  endDate: Date | null;
}) => ({
  id: x.id,
  fullName: x.fullName,
  shortName: x.shortName,
  idNumber: x.idNumber,
  summary: x.summary,
  categoryId: x.categoryId,
  visible: x.visible,
  startDate: iso(x.startDate),
  endDate: iso(x.endDate),
});

const CatalogCourse = Course.omit({ progress: true, role: true })
  .extend({
    categoryName: z.string(),
    enrolmentMethods: z
      .array(z.string())
      .openapi({ description: 'Enabled ways to join, e.g. `self`, `guest`' }),
  })
  .openapi('CatalogCourse');

const Grouping = z
  .object({
    id: Id,
    name: z.string(),
    description: z.string(),
    groupIds: z.array(Id),
    activityCount: z.number().int(),
  })
  .openapi('Grouping');

const Activity = z
  .object({
    id: Id,
    moduleKey: z.string(),
    name: z.string(),
    intro: z.string(),
    visibility: z.string(),
    available: z.boolean(),
    completion: z.string().nullable(),
    url: z.string(),
  })
  .openapi('Activity');

const Section = z
  .object({
    id: Id,
    title: z.string(),
    summary: z.string(),
    visible: z.boolean(),
    activities: z.array(Activity),
  })
  .openapi('Section');

const Participant = z
  .object({
    userId: Id,
    name: z.string(),
    email: z.string().nullable(),
    roles: z.array(z.string()),
    groups: z.array(z.string()),
    status: z.string().nullable(),
  })
  .openapi('Participant');

const Group = z
  .object({ id: Id, name: z.string(), idNumber: z.string().nullable(), memberCount: z.number() })
  .openapi('Group');

const CalendarEvent = z
  .object({
    id: z.string(),
    title: z.string(),
    kind: z.string(),
    startsAt: z.string(),
    endsAt: z.string().nullable(),
    courseId: Id.nullable(),
    url: z.string().nullable(),
  })
  .openapi('CalendarEvent');

const Conversation = z
  .object({
    id: Id,
    kind: z.string(),
    name: z.string().nullable(),
    unread: z.number().int(),
    lastMessageAt: z.string().nullable(),
  })
  .openapi('Conversation');

const Message = z
  .object({ id: Id, senderId: Id.nullable(), body: z.string(), createdAt: z.string() })
  .openapi('Message');

const Notification = z
  .object({
    id: Id,
    type: z.string(),
    title: z.string(),
    body: z.string(),
    url: z.string().nullable(),
    readAt: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi('Notification');

const Token = z
  .object({
    id: Id,
    name: z.string(),
    prefix: z.string(),
    scopes: z.array(z.string()),
    expiresAt: z.string().nullable(),
    lastUsedAt: z.string().nullable(),
    revokedAt: z.string().nullable(),
  })
  .openapi('Token');

const GradeCategory = z
  .object({
    id: Id,
    parentId: Id.nullable().openapi({ description: 'Null for the course category (the root)' }),
    name: z.string(),
    aggregation: z.string().openapi({ example: 'WEIGHTED_MEAN' }),
    weight: z.number(),
    dropLowest: z.number().int(),
    keepHighest: z.number().int(),
    aggregateOnlyGraded: z.boolean(),
  })
  .openapi('GradeCategory');

const GradeItem = z
  .object({
    id: Id,
    name: z.string(),
    kind: z.enum(['MODULE', 'MANUAL', 'CATEGORY', 'COURSE']),
    activityId: Id.nullable(),
    categoryId: Id.nullable(),
    gradeType: z.enum(['VALUE', 'SCALE', 'TEXT', 'NONE']),
    gradeMin: z.number(),
    gradeMax: z.number(),
    gradePass: z.number().nullable(),
    scale: z.array(z.string()).nullable().openapi({
      description: 'For scale items: the grade is the 1-based position in this list',
    }),
    hidden: z.boolean(),
  })
  .openapi('GradeItem');

const GradesReport = z
  .object({
    categories: z.array(GradeCategory),
    items: z.array(GradeItem),
    users: z.array(z.object({ id: Id, name: z.string() })).optional(),
    grades: z.array(
      z.object({
        userId: Id,
        itemId: Id,
        finalGrade: z.number().nullable(),
        feedback: z.string().nullable(),
        overridden: z.boolean(),
        excluded: z.boolean(),
        gradedAt: z.string().nullable(),
      }),
    ),
    categoryTotals: z
      .array(z.object({ userId: Id, categoryId: Id, percent: z.number().nullable() }))
      .optional()
      .openapi({
        description:
          "With ?all=1: every category's total per student, as shown in the grader report",
      }),
  })
  .openapi('GradesReport');

const WebhookEvent = z.enum(WEBHOOK_EVENTS).openapi('WebhookEvent');

const Webhook = z
  .object({
    id: Id,
    name: z.string(),
    url: z.string(),
    events: z.array(WebhookEvent),
    enabled: z.boolean(),
    disabledReason: z.string().nullable(),
    consecutiveFailures: z.number().int(),
    lastDeliveryAt: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi('Webhook');

const WebhookWithSecret = Webhook.extend({
  secret: z.string().openapi({ description: 'Signing secret. Shown only in this response.' }),
}).openapi('WebhookWithSecret');

const WebhookInput = z
  .object({
    name: z.string(),
    url: z.string().openapi({ example: 'https://hr.example.org/hubium-events' }),
    events: z.array(WebhookEvent).min(1),
    enabled: z.boolean().optional(),
  })
  .openapi('WebhookInput');

const WebhookDelivery = z
  .object({
    id: Id,
    event: z.string(),
    status: z.enum(['PENDING', 'SUCCESS', 'FAILED']),
    attempts: z.number().int(),
    responseStatus: z.number().int().nullable(),
    responseBody: z.string().nullable(),
    createdAt: z.string(),
    lastAttemptAt: z.string().nullable(),
  })
  .openapi('WebhookDelivery');

const webhookJson = (w: Awaited<ReturnType<typeof getWebhook>>) => ({
  ...w,
  events: w.events as (typeof WEBHOOK_EVENTS)[number][],
  lastDeliveryAt: iso(w.lastDeliveryAt),
  createdAt: w.createdAt.toISOString(),
  updatedAt: w.updatedAt.toISOString(),
});

const Page = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), total: z.number().int(), page: z.number().int() });

// ── app ──────────────────────────────────────────────────────────────────────

export interface ApiOptions {
  db: Db;
  /** Public origin for links in responses, e.g. https://lms.example.org */
  origin?: string;
  rateLimitPerMinute?: number;
}

export function createApi(opts: ApiOptions) {
  const app = new OpenAPIHono<Env>({
    defaultHook: (r, c) => {
      if (!r.success) {
        const fieldErrors: Record<string, string[]> = {};
        for (const i of r.error.issues)
          (fieldErrors[i.path.join('.') || '_'] ??= []).push(i.message);
        return c.json({ code: 'VALIDATION', message: 'Validation failed', fieldErrors }, 400);
      }
    },
  }).basePath('/api/v1');

  app.onError((e, c) => {
    // malformed JSON, an unsupported Content-Type
    if (e instanceof HTTPException && e.status < 500)
      return c.json(
        { code: e.status === 415 ? 'UNSUPPORTED_MEDIA_TYPE' : 'BAD_REQUEST', message: e.message },
        e.status,
      );
    const r = toActionError(e);
    const status = STATUS[r.code as keyof typeof STATUS] ?? 500;
    if (status === 500 && !(e instanceof AppError))
      logger.error({ err: e, method: c.req.method, path: c.req.path }, 'API request failed');
    return c.json(
      {
        code: r.code,
        message: status === 500 ? 'Internal error' : r.message,
        fieldErrors: r.fieldErrors,
      },
      status,
    );
  });

  // Access log: one record per request, with the token's user once authenticated.
  app.use('*', async (c, next) => {
    const started = performance.now();
    await next();
    const ctx = c.get('ctx') as RequestContext | undefined;
    logger.info(
      {
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        ms: Math.round(performance.now() - started),
        userId: ctx?.actor.kind === 'user' ? ctx.actor.userId : undefined,
      },
      'API request',
    );
  });

  app.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    description: 'Personal access token (`hub_…`), created in Settings → API tokens.',
  });

  // ── auth + rate limit ──
  const limiter = rateLimit(opts.rateLimitPerMinute ?? 120);
  const auth: MiddlewareHandler<Env> = async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const raw = header.match(/^Bearer\s+(\S+)$/i)?.[1];
    const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
    const locale = fromAcceptLanguage(c.req.header('accept-language'));
    const r = raw ? await authenticateApiToken(opts.db, raw, { ip, locale }) : null;
    if (!r)
      return c.json({ code: 'UNAUTHENTICATED', message: 'Missing or invalid token' }, 401, {
        'WWW-Authenticate': 'Bearer',
      });
    const rl = limiter(r.tokenId);
    c.header('X-RateLimit-Limit', String(rl.limit));
    c.header('X-RateLimit-Remaining', String(rl.remaining));
    if (!rl.allowed) {
      c.header('Retry-After', String(rl.retryAfterSec));
      return c.json({ code: 'RATE_LIMITED', message: 'Rate limit exceeded' }, 429);
    }
    const write = !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method);
    if (!r.scopes.includes(write ? 'write' : 'read'))
      return c.json(
        { code: 'FORBIDDEN', message: `This token lacks the "${write ? 'write' : 'read'}" scope` },
        403,
      );
    c.set('ctx', r.ctx);
    c.set('scopes', r.scopes);
    await next();
  };
  // Everything but the spec and its reference page needs a token, new routes included.
  const PUBLIC = /^\/api\/v1\/(openapi\.json|docs(\/scalar\.js)?)$/;
  app.use('*', (c, next) => (PUBLIC.test(c.req.path) ? next() : auth(c, next)));

  const ctxOf = (c: Context<Env>) => c.get('ctx');
  const uid = (c: Context<Env>) => {
    const a = ctxOf(c).actor;
    return a.kind === 'user' ? a.userId : '';
  };

  // ── /me ──
  app.openapi(
    createRoute({
      method: 'get',
      path: '/me',
      tags: ['Users'],
      summary: 'The token owner',
      security,
      responses: { 200: ok(Me), 401: errors[401] },
    }),
    async (c) => {
      const u = await opts.db.user.findUniqueOrThrow({ where: { id: uid(c) } });
      return c.json(
        {
          id: u.id,
          username: u.username,
          email: u.emailPlaceholder ? null : u.email,
          name: u.name,
          firstName: u.firstName,
          lastName: u.lastName,
          locale: u.locale,
          timezone: u.timezone,
          isSiteAdmin: u.isSiteAdmin,
          customFields: (u.customFields ?? {}) as Record<string, string | boolean>,
        },
        200,
      );
    },
  );

  // ── /users ──
  app.openapi(
    createRoute({
      method: 'get',
      path: '/users',
      tags: ['Users'],
      summary: 'Search users (administrators)',
      security,
      request: {
        query: z.object({
          q: z.string().optional(),
          page: z.coerce.number().int().min(1).default(1),
          pageSize: z.coerce.number().int().min(1).max(100).default(50),
        }),
      },
      responses: { 200: ok(Page(User)), ...errors },
    }),
    async (c) => {
      const q = c.req.valid('query');
      const r = await listUsers(ctxOf(c), q);
      return c.json(
        {
          items: r.items.map((u) => ({
            id: u.id,
            username: u.username,
            email: u.emailPlaceholder ? null : u.email,
            name: u.name,
            status: u.status,
            lastLoginAt: iso(u.lastLoginAt),
            customFields: (u.customFields ?? {}) as Record<string, string | boolean>,
          })),
          total: r.total,
          page: q.page,
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/users',
      tags: ['Users'],
      summary: 'Create a user (administrators)',
      security,
      request: {
        body: {
          content: {
            'application/json': {
              schema: z
                .object({
                  username: z.string().optional(),
                  email: z.string().email().optional(),
                  firstName: z.string(),
                  lastName: z.string(),
                  password: z.string().min(8),
                  locale: z.enum(locales).optional(),
                  timezone: z.string().optional().openapi({ example: 'Europe/Moscow' }),
                  mustChangePassword: z.boolean().optional(),
                  customFields: CustomFields.optional(),
                })
                .openapi({ description: 'A username, an email or both' }),
            },
          },
        },
      },
      responses: { 201: ok(z.object({ id: Id }), 'Created'), ...writeErrors },
    }),
    async (c) => c.json(await createUser.run(ctxOf(c), c.req.valid('json')), 201),
  );

  // ── /categories ──
  app.openapi(
    createRoute({
      method: 'get',
      path: '/categories',
      tags: ['Courses'],
      summary: 'Course categories visible to the user',
      security,
      responses: { 200: ok(z.object({ items: z.array(Category) })), 401: errors[401] },
    }),
    async (c) => {
      const all = await ctxOf(c).perm.can('category:manage');
      const flat = flattenTree(await getCategoryTree(opts.db, { includeHidden: all }));
      return c.json(
        {
          items: flat.map((x) => ({
            id: x.id,
            parentId: x.parentId,
            name: x.name,
            depth: x.depth,
            courseCount: x.courseCount,
          })),
        },
        200,
      );
    },
  );

  // ── /courses ──
  app.openapi(
    createRoute({
      method: 'get',
      path: '/courses',
      tags: ['Courses'],
      summary: 'Courses the user is enrolled in',
      security,
      responses: { 200: ok(z.object({ items: z.array(Course) })), 401: errors[401] },
    }),
    async (c) => {
      const items = await listMyCourses(opts.db, uid(c));
      return c.json(
        {
          items: items.map((x) => ({ ...courseJson(x), progress: x.progress, role: x.role })),
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/courses',
      tags: ['Courses'],
      summary: 'Create a course',
      security,
      request: {
        body: {
          content: {
            'application/json': {
              schema: z.object({
                categoryId: Id,
                fullName: z.string(),
                shortName: z.string(),
                idNumber: z.string().optional().openapi({ description: "Your system's key" }),
                summary: z.string().optional(),
                startDate: z.string().datetime({ offset: true }).optional(),
                endDate: z.string().datetime({ offset: true }).optional(),
                visible: z.boolean().optional(),
              }),
            },
          },
        },
      },
      responses: { 201: ok(z.object({ id: Id }), 'Created'), ...writeErrors },
    }),
    async (c) => {
      const r = await createCourse.run(ctxOf(c), c.req.valid('json'));
      return c.json({ id: r.id }, 201);
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/catalog',
      tags: ['Courses'],
      summary: 'Search the course catalog: word forms, prefixes and typos, best match first',
      security,
      request: {
        query: z.object({
          q: z.string().max(100).optional(),
          categoryId: Id.optional().openapi({ description: 'Also its subcategories' }),
          page: z.coerce.number().int().min(1).default(1),
          pageSize: z.coerce.number().int().min(1).max(60).default(12),
        }),
      },
      responses: { 200: ok(Page(CatalogCourse)), ...errors },
    }),
    async (c) => {
      const r = await searchCatalog(ctxOf(c), c.req.valid('query'));
      return c.json(
        {
          items: r.items.map((x) => ({
            ...courseJson(x),
            categoryName: x.category.name,
            // the methods' keys (enrolment passwords) stay out
            enrolmentMethods: [...new Set(x.enrolmentMethods.map((m) => m.type.toLowerCase()))],
          })),
          total: r.total,
          page: r.page,
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/courses/{id}',
      tags: ['Courses'],
      summary: 'A course',
      security,
      request: { params: IdParam },
      responses: { 200: ok(Course), ...errors },
    }),
    async (c) => {
      const ctx = ctxOf(c);
      const access = await getCourseAccess(ctx, c.req.valid('param').id);
      // a course in the recycle bin is gone for everyone but site administrators
      if (!access.canView || (access.course.deletedAt && !ctx.perm.isSiteAdmin))
        throw new AppError('NOT_FOUND', 'Course not found');
      return c.json(courseJson(access.course), 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/courses/{id}/contents',
      tags: ['Courses'],
      summary: 'Sections and activities the user can see',
      security,
      request: { params: IdParam },
      responses: { 200: ok(z.object({ sections: z.array(Section) })), ...errors },
    }),
    async (c) => {
      const id = c.req.valid('param').id;
      const outline = await getCourseOutline(ctxOf(c), id);
      const base = opts.origin ?? '';
      return c.json(
        {
          sections: outline.map((s) => ({
            id: s.id,
            title: s.title,
            summary: s.summary,
            visible: s.visible,
            activities: s.activities.map((e) => ({
              id: e.activity.id,
              moduleKey: e.activity.moduleKey,
              name: e.activity.name,
              intro: e.activity.intro,
              visibility: e.activity.visibility,
              available: e.available,
              completion: e.completion,
              url: `${base}/course/${id}/a/${e.activity.id}`,
            })),
          })),
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/courses/{id}/enrolments',
      tags: ['Enrolment'],
      summary: 'Participants of a course',
      security,
      request: {
        params: IdParam,
        query: z.object({
          q: z.string().optional(),
          page: z.coerce.number().int().min(1).default(1),
          pageSize: z.coerce.number().int().min(1).max(500).default(50),
        }),
      },
      responses: { 200: ok(Page(Participant)), ...errors },
    }),
    async (c) => {
      const q = c.req.valid('query');
      const r = await listParticipants(ctxOf(c), { courseId: c.req.valid('param').id, ...q });
      return c.json(
        {
          items: r.users.map((p) => ({
            userId: p.id,
            name: p.name,
            email: p.emailPlaceholder ? null : p.email,
            roles: p.roleAssignments.map((x) => x.role.shortName),
            groups: p.groupMembers.map((g) => g.group.name),
            status: p.enrolments[0]?.status ?? null,
          })),
          total: r.total,
          page: q.page,
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/courses/{id}/enrolments',
      tags: ['Enrolment'],
      summary: 'Enrol users manually',
      security,
      request: {
        params: IdParam,
        body: {
          content: {
            'application/json': {
              schema: z.object({ userIds: z.array(Id).min(1).max(500), roleId: Id }),
            },
          },
        },
      },
      responses: { 200: ok(z.object({ enrolled: z.number().int() })), ...errors },
    }),
    async (c) => {
      const b = c.req.valid('json');
      await enrolUsers.run(ctxOf(c), { courseId: c.req.valid('param').id, ...b });
      return c.json({ enrolled: b.userIds.length }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/courses/{id}/groups',
      tags: ['Enrolment'],
      summary: 'Groups of a course',
      security,
      request: { params: IdParam },
      responses: { 200: ok(z.object({ items: z.array(Group) })), ...errors },
    }),
    async (c) => {
      const groups = await listGroups(ctxOf(c), c.req.valid('param').id);
      return c.json(
        {
          items: groups.map((g) => ({
            id: g.id,
            name: g.name,
            idNumber: g.idNumber,
            memberCount: g.members.length,
          })),
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/courses/{id}/groupings',
      tags: ['Enrolment'],
      summary: 'Groupings of a course: sets of groups an activity can be limited to',
      security,
      request: { params: IdParam },
      responses: { 200: ok(z.object({ items: z.array(Grouping) })), ...errors },
    }),
    async (c) => {
      const items = await listGroupings(ctxOf(c), c.req.valid('param').id);
      return c.json(
        {
          items: items.map((g) => ({
            id: g.id,
            name: g.name,
            description: g.description,
            groupIds: g.groups.map((x) => x.groupId),
            activityCount: g._count.activities,
          })),
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/courses/{id}/grades',
      tags: ['Grades'],
      summary: 'Grades: own report, another user (?userId) or the whole course (?all=1)',
      security,
      request: {
        params: IdParam,
        query: z.object({ userId: Id.optional(), all: z.enum(['0', '1']).optional() }),
      },
      responses: { 200: ok(GradesReport), ...errors },
    }),
    async (c) => {
      const id = c.req.valid('param').id;
      const q = c.req.valid('query');
      const ctx = ctxOf(c);
      const dec = (v: unknown) => (v === null || v === undefined ? null : Number(v));
      const itemOut = (i: Awaited<ReturnType<typeof gradebookStructure>>['items'][number]) => ({
        id: i.id,
        name: i.name,
        kind: i.kind,
        activityId: i.activityId,
        categoryId: i.categoryId,
        gradeType: i.gradeType,
        gradeMin: Number(i.gradeMin),
        gradeMax: Number(i.gradeMax),
        gradePass: dec(i.gradePass),
        scale: i.gradeType === 'SCALE' ? (i.scale?.items ?? []) : null,
        hidden: i.hidden,
      });
      const gradeOut = (g: Grade) => ({
        userId: g.userId,
        itemId: g.gradeItemId,
        finalGrade: dec(g.finalGrade),
        feedback: g.feedback,
        overridden: g.overridden,
        excluded: g.excluded,
        gradedAt: iso(g.gradedAt),
      });
      const categoryOut = (
        k: Awaited<ReturnType<typeof gradebookStructure>>['categories'][number],
      ) => ({
        id: k.id,
        parentId: k.parentId,
        name: k.name,
        aggregation: k.aggregation,
        weight: Number(k.weight),
        dropLowest: k.dropLowest,
        keepHighest: k.keepHighest,
        aggregateOnlyGraded: k.aggregateOnlyGraded,
      });
      if (q.all === '1') {
        const r = await graderReport(ctx, id);
        // category totals are worked out on display, like the grader report does
        const counted = r.items.filter(
          (i) =>
            (i.kind === 'MODULE' || i.kind === 'MANUAL') &&
            (i.gradeType === 'VALUE' || i.gradeType === 'SCALE'),
        );
        const categoryTotals = r.users.flatMap((u) => {
          const own = counted.flatMap((i) => r.cell.get(`${u.id}:${i.id}`) ?? []);
          return [...categoryFractions(r.categories, counted, own)].map(([categoryId, f]) => ({
            userId: u.id,
            categoryId,
            percent: f === null ? null : Math.round(f * 1e7) / 1e5,
          }));
        });
        return c.json(
          {
            categories: r.categories.map(categoryOut),
            items: r.items.map(itemOut),
            users: r.users.map((u) => ({ id: u.id, name: u.name })),
            grades: [...r.cell.values()].map(gradeOut),
            categoryTotals,
          },
          200,
        );
      }
      const r = await userReport(ctx, id, q.userId ?? uid(c));
      const all = await ctx.perm.can('grade:viewall', id);
      return c.json(
        {
          categories: r.categories.filter((k) => all || !k.hidden).map(categoryOut),
          items: r.items.map(itemOut),
          grades: [...r.grades.values()].map(gradeOut),
        },
        200,
      );
    },
  );

  // ── activities ──
  app.openapi(
    createRoute({
      method: 'get',
      path: '/activities/{id}',
      tags: ['Activities'],
      summary: 'An activity, if the user can open it',
      security,
      request: { params: IdParam },
      responses: {
        200: ok(Activity.extend({ courseId: Id, settings: z.record(z.string(), z.unknown()) })),
        ...errors,
      },
    }),
    async (c) => {
      const r = await getActivityAccess(ctxOf(c), c.req.valid('param').id);
      if (!r.canOpen) throw new AppError('NOT_FOUND', 'Activity not found');
      const a = r.activity;
      const manage = r.access.canManageActivities;
      return c.json(
        {
          id: a.id,
          courseId: a.courseId,
          moduleKey: a.moduleKey,
          name: a.name,
          intro: a.intro,
          visibility: a.visibility,
          available: r.available,
          completion: r.completion,
          url: `${opts.origin ?? ''}/course/${a.courseId}/a/${a.id}`,
          // settings can hold answers/keys: only course editors get them
          settings: manage ? (a.settings as Record<string, unknown>) : {},
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/activities/{id}/actions/{name}',
      tags: ['Activities'],
      summary: 'Run a module action (e.g. assign "saveSubmission", forum "reply")',
      description:
        'The actions an activity offers depend on its module (`moduleKey`). Send the input as JSON, or as multipart/form-data with the JSON in `input` when the action takes files (`files` parts, at most 10 MB per request; use POST /uploads for video and SCORM packages).',
      security,
      request: {
        params: IdParam.extend({
          name: z
            .string()
            .regex(/^[a-zA-Z][\w-]*$/)
            .openapi({ param: { name: 'name', in: 'path' } }),
        }),
        body: {
          content: {
            'application/json': { schema: z.record(z.string(), z.unknown()) },
            'multipart/form-data': {
              schema: z.object({
                input: z.string().optional().openapi({ description: 'The input as JSON' }),
                files: z
                  .any()
                  .optional()
                  .openapi({ type: 'array', items: { type: 'string', format: 'binary' } }),
                filesField: z.string().optional().openapi({
                  description: 'Input field that receives the files (default `files`)',
                }),
              }),
            },
          },
        },
      },
      responses: { 200: ok(z.object({ data: z.unknown() })), ...writeErrors },
    }),
    async (c) => {
      const p = c.req.valid('param');
      const multipart = c.req.header('content-type')?.toLowerCase().startsWith('multipart/');
      const input = multipart
        ? await actionInputFromForm(c.req.valid('form'))
        : c.req.valid('json');
      const data = await runModuleAction(ctxOf(c), p.id, p.name, input);
      return c.json({ data: JSON.parse(JSON.stringify(data ?? null)) }, 200);
    },
  );

  // ── calendar ──
  app.openapi(
    createRoute({
      method: 'get',
      path: '/calendar/events',
      tags: ['Calendar'],
      summary: 'Events visible to the user in a date range (max 400 days)',
      security,
      request: {
        query: z.object({
          from: z.string().datetime({ offset: true }),
          to: z.string().datetime({ offset: true }),
          courseId: Id.optional(),
        }),
      },
      responses: { 200: ok(z.object({ items: z.array(CalendarEvent) })), ...errors },
    }),
    async (c) => {
      const q = c.req.valid('query');
      const from = new Date(q.from);
      const to = new Date(q.to);
      if (to <= from || to.getTime() - from.getTime() > 400 * 86_400_000)
        throw new AppError('VALIDATION', 'Invalid range', {
          fieldErrors: { to: ['Invalid range'] },
        });
      const items = await listUserEvents(opts.db, uid(c), { from, to, courseId: q.courseId });
      return c.json(
        {
          items: items.map((e) => ({
            id: e.id,
            title: e.title,
            kind: e.kind,
            startsAt: e.startsAt.toISOString(),
            endsAt: iso(e.endsAt),
            courseId: e.courseId ?? null,
            url:
              e.activityId && e.courseId
                ? `${opts.origin ?? ''}/course/${e.courseId}/a/${e.activityId}`
                : null,
          })),
        },
        200,
      );
    },
  );

  // ── messaging ──
  app.openapi(
    createRoute({
      method: 'get',
      path: '/conversations',
      tags: ['Messaging'],
      summary: 'Conversations of the user',
      security,
      responses: { 200: ok(z.object({ items: z.array(Conversation) })), 401: errors[401] },
    }),
    async (c) => {
      const items = await listConversations(opts.db, uid(c), { limit: 100 });
      return c.json(
        {
          items: items.map((x) => ({
            id: x.id,
            kind: x.kind,
            name: x.name,
            unread: x.unread,
            lastMessageAt: iso(x.lastMessageAt),
          })),
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/conversations/{id}/messages',
      tags: ['Messaging'],
      summary: 'Messages of a conversation (newest page; ?before= for older)',
      security,
      request: { params: IdParam, query: z.object({ before: Id.optional() }) },
      responses: { 200: ok(z.object({ items: z.array(Message) })), ...errors },
    }),
    async (c) => {
      const r = await listMessages(opts.db, uid(c), c.req.valid('param').id, {
        before: c.req.valid('query').before,
        limit: 50,
      });
      return c.json(
        {
          items: r.items.map((m) => ({
            id: m.id,
            senderId: m.senderId,
            body: m.body,
            createdAt: m.createdAt.toISOString(),
          })),
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/conversations/{id}/messages',
      tags: ['Messaging'],
      summary: 'Send a message',
      security,
      request: {
        params: IdParam,
        body: {
          content: { 'application/json': { schema: z.object({ body: z.string().min(1) }) } },
        },
      },
      responses: { 201: ok(z.object({ id: Id }), 'Created'), ...errors },
    }),
    async (c) => {
      const r = await sendMessage.run(ctxOf(c), {
        conversationId: c.req.valid('param').id,
        body: c.req.valid('json').body,
      });
      return c.json({ id: r.id }, 201);
    },
  );

  // ── notifications ──
  app.openapi(
    createRoute({
      method: 'get',
      path: '/notifications',
      tags: ['Notifications'],
      summary: 'Notifications of the user',
      security,
      request: { query: z.object({ unread: z.enum(['0', '1']).optional() }) },
      responses: { 200: ok(z.object({ items: z.array(Notification) })), 401: errors[401] },
    }),
    async (c) => {
      const items = await listNotifications(opts.db, uid(c), {
        unreadOnly: c.req.valid('query').unread === '1',
        limit: 100,
      });
      return c.json(
        {
          items: items.items.map((n) => ({
            id: n.id,
            type: n.type,
            title: n.title,
            body: n.body,
            url: n.url ?? null,
            readAt: iso(n.readAt),
            createdAt: n.createdAt.toISOString(),
          })),
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/notifications/read',
      tags: ['Notifications'],
      summary: 'Mark notifications read (all when ids are omitted)',
      security,
      request: {
        body: {
          content: {
            'application/json': { schema: z.object({ ids: z.array(Id).max(500).optional() }) },
          },
        },
      },
      responses: { 200: ok(z.object({ ok: z.boolean() })), ...errors },
    }),
    async (c) => {
      const { ids } = c.req.valid('json');
      await markNotificationsRead.run(ctxOf(c), ids?.length ? { ids } : { all: true });
      return c.json({ ok: true }, 200);
    },
  );

  // ── resumable uploads (large files for module actions) ──
  const UploadState = z
    .object({ id: Id, size: z.number().int(), received: z.number().int(), done: z.boolean() })
    .openapi('Upload');
  const UploadProgress = z.object({ received: z.number().int() }).openapi('UploadProgress');

  app.openapi(
    createRoute({
      method: 'post',
      path: '/uploads',
      tags: ['Files'],
      summary: 'Start a resumable upload (up to 4 GB), e.g. a video for video "attachUpload"',
      description:
        'Send the file in chunks with PATCH /uploads/{id}, then pass the id to the module action. Unfinished uploads expire after 24 hours.',
      security,
      request: {
        body: {
          content: {
            'application/json': {
              schema: z.object({
                name: z.string().min(1),
                size: z.number().int().positive(),
                mimeType: z.string().optional(),
              }),
            },
          },
        },
      },
      responses: {
        201: ok(
          z.object({ id: Id, chunkSize: z.number().int(), received: z.number().int() }),
          'Created',
        ),
        ...errors,
      },
    }),
    async (c) => c.json(await createUpload(opts.db, uid(c), c.req.valid('json')), 201),
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/uploads/{id}',
      tags: ['Files'],
      summary: 'Where an upload stands: resume from `received`',
      security,
      request: { params: IdParam },
      responses: { 200: ok(UploadState), ...errors },
    }),
    async (c) => c.json(await getUpload(opts.db, uid(c), c.req.valid('param').id), 200),
  );

  app.openapi(
    createRoute({
      method: 'patch',
      path: '/uploads/{id}',
      tags: ['Files'],
      summary: 'Append the next chunk (at most `chunkSize` bytes) at `Upload-Offset`',
      security,
      request: {
        params: IdParam,
        headers: z.object({
          'upload-offset': z.coerce
            .number()
            .int()
            .min(0)
            .openapi({ description: 'Bytes already received' }),
        }),
        body: {
          content: {
            'application/octet-stream': { schema: z.string().openapi({ format: 'binary' }) },
          },
        },
      },
      responses: {
        200: ok(UploadProgress),
        409: ok(UploadProgress, 'The offset does not match: resume from `received`'),
        ...errors,
      },
    }),
    async (c) => {
      const chunk = Buffer.from(await c.req.arrayBuffer());
      const r = await appendUploadChunk(
        opts.db,
        uid(c),
        c.req.valid('param').id,
        c.req.valid('header')['upload-offset'],
        chunk,
      );
      if (r.conflict) return c.json({ received: r.received }, 409);
      return c.json({ received: r.received }, 200);
    },
  );

  // ── tokens ──
  app.openapi(
    createRoute({
      method: 'get',
      path: '/tokens',
      tags: ['Tokens'],
      summary: 'Personal access tokens of the user (without secrets)',
      security,
      responses: { 200: ok(z.object({ items: z.array(Token) })), 401: errors[401] },
    }),
    async (c) => {
      const items = await listApiTokens(ctxOf(c));
      return c.json(
        {
          items: items.map((t) => ({
            id: t.id,
            name: t.name,
            prefix: t.prefix,
            scopes: t.scopes,
            expiresAt: iso(t.expiresAt),
            lastUsedAt: iso(t.lastUsedAt),
            revokedAt: iso(t.revokedAt),
          })),
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/tokens/{id}',
      tags: ['Tokens'],
      summary: 'Revoke a token',
      security,
      request: { params: IdParam },
      responses: { 200: ok(z.object({ id: Id })), ...errors },
    }),
    async (c) => c.json(await revokeApiToken(ctxOf(c), c.req.valid('param').id), 200),
  );

  // ── /webhooks (administrators) ──
  const json = { body: { content: { 'application/json': { schema: WebhookInput } } } };

  app.openapi(
    createRoute({
      method: 'get',
      path: '/webhook-events',
      tags: ['Webhooks'],
      summary: 'Event types a webhook can subscribe to',
      security,
      responses: { 200: ok(z.object({ items: z.array(WebhookEvent) })), ...errors },
    }),
    (c) => c.json({ items: [...WEBHOOK_EVENTS] }, 200),
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/webhooks',
      tags: ['Webhooks'],
      summary: 'List webhooks (administrators)',
      security,
      responses: { 200: ok(z.object({ items: z.array(Webhook) })), ...errors },
    }),
    async (c) => c.json({ items: (await listWebhooks(ctxOf(c))).map(webhookJson) }, 200),
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/webhooks',
      tags: ['Webhooks'],
      summary: 'Create a webhook; the response carries its signing secret once',
      security,
      request: json,
      responses: { 201: ok(WebhookWithSecret, 'Created'), ...errors },
    }),
    async (c) => {
      const w = await createWebhook.run(ctxOf(c), c.req.valid('json'));
      return c.json({ ...webhookJson(w), secret: w.secret }, 201);
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/webhooks/{id}',
      tags: ['Webhooks'],
      summary: 'One webhook',
      security,
      request: { params: IdParam },
      responses: { 200: ok(Webhook), ...errors },
    }),
    async (c) => c.json(webhookJson(await getWebhook(ctxOf(c), c.req.valid('param').id)), 200),
  );

  app.openapi(
    createRoute({
      method: 'patch',
      path: '/webhooks/{id}',
      tags: ['Webhooks'],
      summary: 'Change a webhook (switching it on again resets its failure count)',
      security,
      request: {
        params: IdParam,
        body: { content: { 'application/json': { schema: WebhookInput.partial() } } },
      },
      responses: { 200: ok(Webhook), ...errors },
    }),
    async (c) => {
      const w = await updateWebhook.run(ctxOf(c), {
        ...c.req.valid('json'),
        id: c.req.valid('param').id,
      });
      return c.json(webhookJson(w), 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/webhooks/{id}',
      tags: ['Webhooks'],
      summary: 'Delete a webhook and its delivery log',
      security,
      request: { params: IdParam },
      responses: { 200: ok(z.object({ id: Id })), ...errors },
    }),
    async (c) => c.json(await deleteWebhook.run(ctxOf(c), { id: c.req.valid('param').id }), 200),
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/webhooks/{id}/rotate-secret',
      tags: ['Webhooks'],
      summary: 'Replace the signing secret; the response carries the new one once',
      security,
      request: { params: IdParam },
      responses: { 200: ok(z.object({ id: Id, secret: z.string() })), ...errors },
    }),
    async (c) =>
      c.json(await rotateWebhookSecret.run(ctxOf(c), { id: c.req.valid('param').id }), 200),
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/webhooks/{id}/ping',
      tags: ['Webhooks'],
      summary: 'Send a test "ping" event now (one attempt)',
      security,
      request: { params: IdParam },
      responses: { 200: ok(z.object({ deliveryId: Id })), ...errors },
    }),
    async (c) => c.json(await pingWebhook.run(ctxOf(c), { id: c.req.valid('param').id }), 200),
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/webhooks/{id}/deliveries',
      tags: ['Webhooks'],
      summary: 'Delivery log, newest first (kept for 30 days)',
      security,
      request: {
        params: IdParam,
        query: z.object({
          page: z.coerce.number().int().min(1).default(1),
          pageSize: z.coerce.number().int().min(1).max(100).default(50),
        }),
      },
      responses: { 200: ok(Page(WebhookDelivery)), ...errors },
    }),
    async (c) => {
      const r = await listWebhookDeliveries(
        ctxOf(c),
        c.req.valid('param').id,
        c.req.valid('query'),
      );
      return c.json(
        {
          items: r.items.map((d) => ({
            id: d.id,
            event: d.event,
            status: d.status,
            attempts: d.attempts,
            responseStatus: d.responseStatus,
            responseBody: d.responseBody,
            createdAt: d.createdAt.toISOString(),
            lastAttemptAt: iso(d.lastAttemptAt),
          })),
          total: r.total,
          page: r.page,
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/webhooks/deliveries/{id}/redeliver',
      tags: ['Webhooks'],
      summary: 'Send a past delivery again (as a new delivery)',
      security,
      request: { params: IdParam },
      responses: { 200: ok(z.object({ deliveryId: Id })), ...errors },
    }),
    async (c) =>
      c.json(await redeliverWebhook.run(ctxOf(c), { deliveryId: c.req.valid('param').id }), 200),
  );

  // ── spec + docs (public) ──
  const specConfig = {
    openapi: '3.1.0',
    info: {
      title: 'Hubium LMS REST API',
      version: '1.0.0',
      description:
        'Authenticate with `Authorization: Bearer <token>`. Tokens act as their user, limited by scopes (`read`, `write`). Versioning: breaking changes go to /api/v2; deprecated endpoints carry a `Deprecation` header for at least 6 months.',
      license: { name: 'AGPL-3.0-only', url: 'https://www.gnu.org/licenses/agpl-3.0.html' },
    },
    servers: [{ url: opts.origin ?? '/' }],
  };
  // Built on first use: modules register their actions when the app starts.
  let spec: Record<string, unknown> | undefined;
  app.get('/openapi.json', (c) => {
    spec ??= documentModuleActions(
      app.getOpenAPI31Document(specConfig) as unknown as Record<string, unknown>,
    );
    return c.json(spec);
  });
  app.get('/docs', async (c) => {
    const { hash } = await scalarBundle();
    const page = docsPage({
      specUrl: '/api/v1/openapi.json',
      scriptUrl: `/api/v1/docs/scalar.js?v=${hash}`,
      title: 'Hubium LMS API',
    });
    return c.html(page, 200, { 'Content-Security-Policy': DOCS_CSP, 'Cache-Control': 'no-cache' });
  });
  app.get('/docs/scalar.js', async (c) => {
    const { js } = await scalarBundle();
    return c.body(js, 200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
  });
  return app;
}

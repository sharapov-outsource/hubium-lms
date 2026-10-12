import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  type ApiScope,
  AppError,
  authenticateApiToken,
  createCourse,
  createUser,
  enrolUsers,
  flattenTree,
  getActivityAccess,
  getCategoryTree,
  getCourseAccess,
  getCourseOutline,
  graderReport,
  listApiTokens,
  listConversations,
  listGroups,
  listMessages,
  listMyCourses,
  listNotifications,
  listParticipants,
  listUserEvents,
  listUsers,
  markNotificationsRead,
  type RequestContext,
  revokeApiToken,
  runModuleAction,
  sendMessage,
  toActionError,
  userReport,
} from '@hubium/core';
import type { Db } from '@hubium/db';
import { Scalar } from '@scalar/hono-api-reference';
import type { Context, MiddlewareHandler } from 'hono';
import { rateLimit } from './rate-limit.ts';

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
const security = [{ bearerAuth: [] }];
const Id = z.string().uuid();
const IdParam = z.object({ id: Id.openapi({ param: { name: 'id', in: 'path' } }) });
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

// ── schemas ──────────────────────────────────────────────────────────────────

const Me = z
  .object({
    id: Id,
    username: z.string().nullable(),
    email: z.string(),
    name: z.string(),
    firstName: z.string(),
    lastName: z.string(),
    locale: z.string().nullable(),
    timezone: z.string().nullable(),
    isSiteAdmin: z.boolean(),
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
    summary: z.string(),
    categoryId: Id.optional(),
    visible: z.boolean(),
    progress: z.number().nullable().optional(),
    role: z.string().nullable().optional(),
  })
  .openapi('Course');

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
    const r = toActionError(e);
    const status = STATUS[r.code as keyof typeof STATUS] ?? 500;
    if (status === 500 && !(e instanceof AppError)) console.error('[api]', e);
    return c.json(
      {
        code: r.code,
        message: status === 500 ? 'Internal error' : r.message,
        fieldErrors: r.fieldErrors,
      },
      status,
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
    const lang = c.req.header('accept-language')?.toLowerCase().startsWith('en') ? 'en' : undefined;
    const r = raw ? await authenticateApiToken(opts.db, raw, { ip, locale: lang }) : null;
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
  for (const p of [
    '/me',
    '/users/*',
    '/users',
    '/categories',
    '/courses',
    '/courses/*',
    '/activities/*',
    '/calendar/*',
    '/conversations',
    '/conversations/*',
    '/notifications',
    '/notifications/*',
    '/tokens',
    '/tokens/*',
  ])
    app.use(p, auth);

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
          email: u.email,
          name: u.name,
          firstName: u.firstName,
          lastName: u.lastName,
          locale: u.locale,
          timezone: u.timezone,
          isSiteAdmin: u.isSiteAdmin,
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
              schema: z.object({
                username: z.string(),
                email: z.string().email(),
                firstName: z.string(),
                lastName: z.string(),
                password: z.string().optional(),
              }),
            },
          },
        },
      },
      responses: { 201: ok(z.object({ id: Id }), 'Created'), ...errors },
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
          items: items.map((x) => ({
            id: x.id,
            fullName: x.fullName,
            shortName: x.shortName,
            summary: x.summary,
            visible: x.visible,
            progress: x.progress,
            role: x.role,
          })),
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
                summary: z.string().optional(),
                visible: z.boolean().optional(),
              }),
            },
          },
        },
      },
      responses: { 201: ok(z.object({ id: Id }), 'Created'), ...errors },
    }),
    async (c) => {
      const r = await createCourse.run(ctxOf(c), c.req.valid('json'));
      return c.json({ id: r.id }, 201);
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
      const access = await getCourseAccess(ctxOf(c), c.req.valid('param').id);
      if (!access.canView) throw new AppError('NOT_FOUND', 'Course not found');
      const x = access.course;
      return c.json(
        {
          id: x.id,
          fullName: x.fullName,
          shortName: x.shortName,
          summary: x.summary,
          categoryId: x.categoryId,
          visible: x.visible,
        },
        200,
      );
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
      path: '/courses/{id}/grades',
      tags: ['Grades'],
      summary: 'Grades: own report, another user (?userId) or the whole course (?all=1)',
      security,
      request: {
        params: IdParam,
        query: z.object({ userId: Id.optional(), all: z.enum(['0', '1']).optional() }),
      },
      responses: { 200: ok(z.object({ report: z.unknown() })), ...errors },
    }),
    async (c) => {
      const id = c.req.valid('param').id;
      const q = c.req.valid('query');
      const report =
        q.all === '1'
          ? await graderReport(ctxOf(c), id)
          : await userReport(ctxOf(c), id, q.userId ?? uid(c));
      return c.json({ report: JSON.parse(JSON.stringify(report)) }, 200);
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
          available: true,
          completion: null,
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
      summary: 'Run a module action (e.g. assign "saveSubmission", forum "post")',
      security,
      request: {
        params: IdParam.extend({
          name: z
            .string()
            .regex(/^[a-zA-Z][\w-]*$/)
            .openapi({ param: { name: 'name', in: 'path' } }),
        }),
        body: { content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } } },
      },
      responses: { 200: ok(z.object({ data: z.unknown() })), ...errors },
    }),
    async (c) => {
      const p = c.req.valid('param');
      const data = await runModuleAction(ctxOf(c), p.id, p.name, c.req.valid('json'));
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

  // ── spec + docs (public) ──
  app.doc31('/openapi.json', {
    openapi: '3.1.0',
    info: {
      title: 'Hubium REST API',
      version: '1.0.0',
      description:
        'Authenticate with `Authorization: Bearer <token>`. Tokens act as their user, limited by scopes (`read`, `write`). Versioning: breaking changes go to /api/v2; deprecated endpoints carry a `Deprecation` header for at least 6 months.',
      license: { name: 'AGPL-3.0-only', url: 'https://www.gnu.org/licenses/agpl-3.0.html' },
    },
    servers: [{ url: opts.origin ?? '/' }],
  });
  app.get('/docs', Scalar({ url: '/api/v1/openapi.json', pageTitle: 'Hubium API' }));
  return app;
}

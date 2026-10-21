# Hubium LMS — architecture and technical design

Hubium LMS is an open-source learning management system (AGPL-3.0), a modern alternative to Moodle. This document is the technical design, built in the phases described below. It was written before any code existed. Library APIs it mentions (Prisma 7, Better Auth, Next 16, the Anthropic SDK, scorm-again, etc.) must be verified against the installed versions during implementation.

---

## 0. Stack baseline and conventions

| Concern | Decision | Notes |
|---|---|---|
| Runtime | Node 24 LTS, pnpm 12 workspaces, ESM everywhere | `.nvmrc`, `packageManager` field in root `package.json` |
| Orchestration | Turborepo 2 (one `turbo.json`) | Gives a task graph and cache for CI. Nx would be too heavy. |
| Lint/format | Biome 2, with its a11y rules on | No typescript-eslint, so nothing depends on the TS compiler API. This keeps a later TS 7 switch cheap. |
| TypeScript | **`typescript@~7.0`** (native compiler) | Next.js 16.4 type-checks through the `tsc` CLI. dependency-cruiser still needs the compiler's JS API, so `tools/depcruise` pins TypeScript 6 for it alone. See risk R2. |
| Web | next 16.4 (App Router, Turbopack, `output: 'standalone'`, `typedRoutes`), react 19.3 | **`cacheComponents` off in v1.** Nearly every LMS page is personalised and permission-dependent. |
| DB | PostgreSQL 18 + pgvector 0.8 (`pgvector/pgvector:pg18`). Support PG >= 16 for external DBs. | Extensions: `vector`, `citext`, `pg_trgm`, `unaccent` |
| ORM | prisma 7.10 + `@prisma/adapter-pg`. Multi-file schema. `prisma-client` generator outputs to `packages/db/src/generated/prisma`. | Not 8.0 RC. `prisma.config.ts` must load `.env` itself (`import 'dotenv/config'`). Run `generate` and seed explicitly; Prisma 7 no longer chains them. |
| Validation | zod 4.6 | One schema drives forms, actions, REST/OpenAPI, module settings and AI structured output. |
| Auth | Better Auth 1.x | Section 2 |
| Jobs | pg-boss (latest major) | Section 5 |
| UI | Tailwind 4.3 (CSS-first `@theme`), Radix primitives with shadcn-style components owned in `packages/ui`, lucide-react, next-themes, sonner, TanStack Table + Virtual, dnd-kit, react-hook-form + zod resolver | TanStack Query only in client-heavy screens (messages, grader report, quiz autosave) |
| i18n | next-intl **without locale URL prefix**. Locale order: `user.locale` → cookie → course forced lang → site default (`ru`) → Accept-Language. | ICU plurals cover Russian one/few/many |
| REST | Hono + `@hono/zod-openapi`, mounted in a Next catch-all route. Scalar for docs. | Section 1.4 |
| Email | nodemailer (SMTP) + React Email templates, rendered in the worker | |
| Tests | vitest 5 against PostgreSQL (a template database copied per test file), Playwright + `@axe-core/playwright` | Section 10 |
| Worker build | `tsx watch` in dev, `tsdown` bundle in prod | |

**Data conventions**
- Primary keys are UUIDv7: `@id @default(uuid(7)) @db.Uuid`. They sort by time and can't be enumerated.
- Timestamps are `@db.Timestamptz(3)`. Grades use `Decimal(12,5)`.
- JSON columns are always parsed with zod at the boundary.
- Soft delete applies only to User (anonymisation), Course and Activity (recycle bin). Filters are written explicitly in repositories; Prisma 7 has no `$use` middleware.

**Packages are source-only.** Internal packages point `exports` at `src/*.ts`. Next compiles them via `transpilePackages`; the worker bundles them with tsdown. There is no per-package build step.

---

## 1. Monorepo layout

```
hubium/
  turbo.json  biome.json  pnpm-workspace.yaml  tsconfig.json  .dependency-cruiser.cjs
  docker/  compose.yml  compose.dev.yml  Caddyfile  Dockerfile (targets: web, worker, worker-media, bundle)
  apps/
    web/                        # Next.js: UI (RSC), server actions, REST /api/v1, SSE, file/content routes, module route dispatcher
    worker/                     # pg-boss consumers + cron; WORKER_QUEUES env selects roles (default | media)
  packages/
    tooling/                    # tsconfig presets, build info
    db/                         # Prisma schema (multi-file), migrations, generated client, createDb(), seed, raw-SQL helpers (pgvector, tsvector)
    core/                       # domain services + operation framework (framework-agnostic: no next/react imports)
    module-sdk/                 # ActivityModule contract, defineModule/defineModuleUI, ModuleCtx interfaces, capability/notification/job defs
    ui/                         # design system only (no domain): tokens, theming, primitives, shell, data table, form controls
    editor/                     # Tiptap: ./client (React editor), ./server (validate JSON, render HTML, extract text, HTML→JSON for imports)
    i18n/                       # ru/en core messages, locale utils, server translator (used by worker emails too)
    questions/                  # question types registry, grading engine, deterministic shuffle, GIFT + Moodle XML import/export
    ai/                         # low-level: LLM providers (Anthropic, OpenAI-compatible), embedding providers, chunker, prompt templates
    interchange/                # own backup/restore format, course duplicate, .mbz importer (heavy deps isolated from web bundle)
  modules/
    content/                    # exports 4 modules: page, file (single/folder), url (link/embed), label (inline)
    assign/  quiz/  forum/  video/  livesession/  scorm/  lti/
```

### 1.1 Why each package exists
- **db**: one migration history and one generated client. Prisma requires back-relation fields on both sides of a relation, so **first-party module tables also live here** (`prisma/schema/modules/*.prisma`) to keep real FK integrity.
- **core**: holds all business rules: auth context, permissions, courses, enrolment, groups, completion, gradebook, calendar, files, notifications, messaging, settings, event log, AI features. It is shared by server actions, REST and the worker.
- **module-sdk**: lets modules depend on interfaces rather than on core. This avoids cycles, and core implements the `ModuleCtx` interfaces.
- **ui**: reusable design system. Domain components (CourseCard, GraderTable) live in `apps/web` or in modules.
- **editor**: Tiptap and KaTeX are heavy and needed on both client and server (render, sanitise, import), so they get their own package.
- **i18n**: the worker needs translations for emails and notifications without importing the web app.
- **questions**: used by the quiz module, AI generation, GIFT/XML import and backup. Keeping it separate keeps `mod-quiz` thin and lets a future practice or lesson module reuse it.
- **ai**: provider adapters only, with no DB access. AI features (quotas, RAG retrieval, tutor) sit in `core/src/ai/*` because they need permissions and data.
- **interchange**: sits above core because restore needs core services. It isolates tar, XML and zip dependencies.

### 1.2 Dependency rules (enforced by dependency-cruiser in CI)
- `core` may import db, module-sdk, i18n, questions, ai, editor/server. It may never import next or react.
- `modules/*` may import module-sdk, db (types plus their own tables), ui, editor, i18n and questions. **They never import core.** Services arrive through `ctx`.
- Each module has three entry points:
  - `./shared`: zod schemas and constants.
  - `./server`: the ActivityModule definition. It has no React and no `server-only` import, because that package throws in a plain Node worker.
  - `./ui`: RSC and client components. It may import `./server`; the reverse is forbidden.
- `apps/worker` must never resolve any `*/ui` entry.

### 1.3 Plugin registration (compile-time)

Each app lists the modules it runs: `apps/web/src/modules/server.ts` and `apps/worker/src/modules.ts` import every module's `./server` entry and pass them to `registerModules`; `apps/web/src/modules/ui.tsx` maps module keys to their `./ui` entries.

- A unit test asserts that the key sets of the two registries match.
- Runtime enable/disable is a site setting (`mod.<key>.enabled`). Every module's tables always exist.
- **Third-party plugins** (post-v1, designed for now):
  - Add the dependency, add the two import lines, run `pnpm hubium plugins:sync`, rebuild.
  - The sync script copies the plugin's `prisma/*.prisma` fragment into `packages/db/prisma/schema/plugins/`.
  - Fragments may reference core rows only as plain scalar `@db.Uuid` columns, not `@relation`. Cleanup happens through lifecycle and privacy hooks.
  - Plugins that need no tables use `Activity.settings` and file areas.

### 1.4 One operation, three transports (fixes server action vs REST duplication)

```ts
// packages/core/src/operation.ts
export const updateCourse = defineOperation({
  name: 'course.update',
  offline: 'guarded',                   // what a local node does with it offline (below)
  input: CourseUpdateInput,             // zod
  output: CourseDTO,                    // zod (drives OpenAPI)
  mutation: true,                       // run inside db.$transaction
  authorize: (ctx, i) => ctx.perm.require('course:update', i.courseId),
  handler: async (ctx, i) => { /* ... */ ctx.events.emit('course.updated', {...}); return dto; },
});
```

- **`RequestContext`** carries: `actor`, `db` (a tx inside mutations), `now`, `locale`, `perm`, `files`, `jobs`, `realtime`, `events`, `settings`, `t`, `log`, `afterCommit(fn)`.
- **Server actions.** `apps/web/src/server/actions/*.ts` contain `'use server'` plus `export const updateCourseAction = toAction(updateCourse)`. `toAction`:
  - builds the context from the session cookie (React `cache()` per request);
  - validates input and maps `AppError` to `{ ok:false, code, fieldErrors }`;
  - calls `revalidatePath` / `refresh()` as declared.
- **REST.** `apps/web/src/app/api/v1/[[...route]]/route.ts` runs the Hono app from `packages/api` (`createApi`). Its routes are thin: bearer auth and rate limiting in front, zod schemas that also make the OpenAPI spec at `/api/v1/openapi.json`, then the same core operations and queries as the UI. The reference page `/api/v1/docs` serves Scalar's bundle from the app itself under its own CSP.
- **Worker.** Jobs call the same operations with `actor: { kind:'system' }`, or on behalf of a user for audit purposes.
- **RSC reads.** Plain query functions (`getCourseOutline(ctx, id)`) are called directly from server components. There is no action and no HTTP hop.
- **Transactional side effects:**
  - pg-boss `send(..., { db: txAdapter })` enqueues jobs inside the Prisma transaction (outbox for free).
  - `pg_notify` inside the transaction delivers only on commit.
  - Non-transactional effects (S3 deletes) go through `afterCommit`.
- **Registry and offline policy.** `defineOperation` registers the operation by name (`getOperation`, `listOperations`); a test fails on a name defined twice, and module action names (`<module>.<action>`) never match an operation's. Each operation and module action declares `offline`, what a local node does with it while it cannot reach the cloud: `replay` (run, and replayed in the cloud as it is), `guarded` (run, and replayed only when what it changed is unchanged in the cloud) or `online` (refused).
- **Write scopes.** Every write to the database belongs to a scope (`withWriteScope` in `packages/db`):
  - operations and module actions open `operation`, the worker's jobs `job`, the CLI and the seed `system`, and Better Auth's adapter writes in `auth`;
  - side records of page views belong to `touch`, data that can be computed again to `derived`;
  - the registry of stored blobs and the sessions of uploads belong to `files`, and the records of exchanges with systems outside Hubium (an AI provider, an LTI tool, a webinar server) to `external`.

  A local node records the operations it runs to replay them in the cloud, so a write outside any scope would be lost there. `HUBIUM_WRITE_GUARD=report` logs each kind of write found outside a scope once, and `strict` refuses it.
- **Module actions and queries.** `ActivityModule.actions` are exposed through one web endpoint (`/api/mod/action`) and one REST route, `POST /api/v1/activities/{id}/actions/{name}`; both take JSON or multipart with files. `ActivityModule.queries` are the reads behind them, `GET /api/v1/activities/{id}/queries/{name}`: the module's pages and the queries call the same functions, so the visibility rules live in one place. The OpenAPI spec documents every action from its zod input and every query from its input and output, with their `summary`. Mobile gets module features without per-module endpoints.

### 1.5 `ActivityModule` contract

```ts
// packages/module-sdk/src/activity-module.ts
export interface ActivityModule<S extends z.ZodObject = z.ZodObject> {
  key: string;                         // 'assign' — persisted in Activity.moduleKey, immutable
  version: string; dataVersion: number;// dataVersion bumps when settings/backup shape changes
  archetype: 'activity' | 'resource' | 'inline';
  icon: LucideIconName;
  supports: { groups?: boolean; grading?: boolean; intro?: boolean; backup: boolean; ai?: boolean };
  notifications?: Record<string, NotificationTypeDef>;                // default channels, user-overridable?
  settings: { schema: S; defaults(): z.input<S>; migrate?(raw: unknown, from: number): unknown };
  siteSettings?: z.ZodObject;                                         // /admin/settings/modules/:key

  lifecycle?: {
    onCreate?(ctx: ModuleCtx, a: ActivityRef<S>): Promise<void>;
    onUpdate?(ctx: ModuleCtx, a: ActivityRef<S>, prev: z.output<S>): Promise<void>;
    onDelete?(ctx: ModuleCtx, a: ActivityRef<S>): Promise<void>;     // on recycle-bin purge
    onCourseReset?(ctx: ModuleCtx, courseId: string, o: ResetOptions): Promise<void>;
    onUserEnrolled?(ctx: ModuleCtx, courseId: string, userId: string): Promise<void>;
    onUserUnenrolled?(ctx: ModuleCtx, courseId: string, userId: string): Promise<void>;
  };
  grading?: {
    items(a: ActivityRef<S>): GradeItemSpec[];                        // [{ itemNumber:0, name, type, max, pass }]
    regrade?(ctx: ModuleCtx, a: ActivityRef<S>, userIds?: string[]): Promise<void>;
  };
  completion?: {
    rules: z.ZodObject;                                               // e.g. { minWatchPercent: number }
    evaluate(ctx: ModuleCtx, a: ActivityRef<S>, userId: string, rules: unknown):
      Promise<'complete' | 'incomplete' | 'pass' | 'fail'>;
    describe(rules: unknown, t: Translator): string[];
  };
  calendar?: { events(a: ActivityRef<S>): CalendarEventSpec[] };     // core syncs rows on create/update
  todo?(ctx: ModuleCtx, viewer: Actor, courseIds: string[]): Promise<TodoItem[]>; // dashboard "to grade / due"
  actions?: Record<string, ModuleAction>;                             // { input: zod, capability, mutation, handler }
  routes?: ModuleRoute[];                                             // mounted at /api/mod/:key/* (Web Request→Response)
  jobs?: JobDef[]; cron?: CronDef[];                                  // queue: 'default' | 'media'
  on?: Partial<DomainEventHandlers>;                                  // 'grade.updated', 'group.member.removed', ...
  files?: Record<string /*area*/, { canRead(ctx: ModuleCtx, f: FileRef): Promise<boolean>; maxBytes?: number }>;
  backup?: {
    export(ctx: ModuleCtx, a: ActivityRef<S>, o: { userData: boolean }): Promise<{ data: unknown; files: FileRef[] }>;
    import(ctx: ModuleCtx, a: ActivityRef<S>, p: { data: unknown; dataVersion: number }, ids: IdMapper): Promise<void>;
  };
  importers?: { moodle?: { modnames: string[]; import(ctx: ModuleCtx, src: MbzActivity, ids: IdMapper): Promise<ImportResult> } };
  ai?: { extract(ctx: ModuleCtx, a: ActivityRef<S>): Promise<ContentSource[]>; tutorPolicy?: 'include' | 'exclude' | 'exclude-while-open' };
  privacy?: { exportUserData(ctx: ModuleCtx, userId: string): Promise<unknown>; deleteUserData(ctx: ModuleCtx, userId: string): Promise<void> };
  api?: { dto: z.ZodType; toDTO(ctx: ModuleCtx, a: ActivityRef<S>, viewer: Actor): Promise<unknown> };
  messages: Record<'ru' | 'en', () => Promise<Messages>>;            // namespace `mod.<key>`
}

// packages/module-sdk/src/ui.ts — imported only by apps/web
export interface ActivityModuleUI {
  key: string;
  SettingsFields: ComponentType<SettingsFieldsProps>;   // client; core form renders name/intro/availability/completion/grade
  CompletionRulesFields?: ComponentType<RulesFieldsProps>;
  View(p: ViewProps): Promise<ReactNode>;               // RSC at /course/:cid/a/:aid
  tabs?: { key: string; labelKey: string; capability: string; Page(p: ViewProps): Promise<ReactNode> }[];
  Inline?(p: InlineProps): Promise<ReactNode>;          // label body / rich card on course page
}
```

`ModuleCtx` exposes the following, all implemented by core:
- `actor`, `db`, `now`, `t`, `log`
- `perm` (`can`, `require`, `usersWithCap`)
- `grades` (`syncItems`, `setGrades`)
- `completion` (`markViewed`, `recompute`)
- `files` (`list`, `commitDraft`, `copy`, `signedUrl`)
- `calendar`, `notify`, `jobs`, `events`, `settings`

### 1.6 Route map (apps/web)

```
(auth)/login, register, forgot-password, reset-password, verify-email, two-factor
(app)/dashboard, my-courses, catalog, catalog/[categoryId], calendar, messages/[[...conversationId]],
      notifications, profile/[userId], settings/{account,security,notifications,language,ai}
(app)/course/[courseId]/{,content,participants,groups,grades,grades/setup,reports/[report],settings,
      enrolment,completion,question-bank,backup}
(app)/course/[courseId]/a/[activityId]/{,edit,[tab]}      (app)/course/[courseId]/a/new?module=&section=
(app)/admin/{users,users/[id],users/upload,cohorts,roles,roles/[id],permissions/check,categories,courses,
      settings/[section],modules,ai,lti-tools,tasks,reports/logs,reports/system,environment}
api/auth/[...all]  api/v1/[[...route]]  api/realtime  api/files/upload/*  api/mod/[module]/[...path]
api/calendar/ical/[token]  api/health
files/[fileId]/[...name]           # ACL-checked downloads
c/[token]/[...path]                # untrusted content (SCORM, raw HTML) — only answered on CONTENT_HOST
proxy.ts                           # (Next 16 replacement for middleware) host split + optimistic session redirect only
```

---

## 2. Authentication: Better Auth confirmed

Better Auth is the right choice. Auth.js has effectively folded into it, and Lucia is deprecated. Keycloak would add a heavy external service to a single-compose install. Configuration:

- **Database and IDs.**
  - Prisma adapter with DB sessions.
  - `advanced.database.generateId` returns UUIDv7, so `User.id` matches every other `@db.Uuid` FK.
  - `rateLimit.storage = 'database'`, since there is no Redis.
- **Plugins:**
  - `username`: schools need login without email.
  - `twoFactor`: TOTP plus backup codes. Admins can require it for chosen roles.
  - `bearer`: for the mobile app.
  - `admin`: only for impersonation and ban primitives, wrapped by our `user:loginas` capability. Its role field is **not** used; all authorization is ours.
  - `sso` (`@better-auth/sso`): OIDC and SAML providers kept in `SsoProvider` and managed in Administration; the plugin's own provider endpoints are closed. Hubium's `resolveUser` decides between a linked account, an account with the same email and a new one. The adapter runs in transactions because the plugin needs them.
- **Social login.**
  - Google is built-in. VK ID is built-in in recent versions; verify it uses the current id.vk.com OAuth 2.1 + PKCE flow.
  - Yandex ID goes through the `genericOAuth` plugin (`oauth.yandex.ru/authorize`, userinfo `login.yandex.ru/info`).
  - Keycloak goes through `genericOAuth` too (its `keycloak` helper, discovery from the realm URL).
  - Client secrets of these built-in providers come from env vars (`AUTH_GOOGLE_*`, `AUTH_YANDEX_*`, `AUTH_VK_*`, `AUTH_KEYCLOAK_*`); the admin UI toggles them and shows the callback URLs.
  - Custom OAuth 2 providers are rows of `SsoProvider` (protocol `oauth2`) passed to `genericOAuth`, which takes its providers when the instance is created. `createAuthHolder` (core/auth/holder.ts) therefore rebuilds the Better Auth instance when any process publishes the `auth` cache topic, and `auth` in the web app forwards to the current instance.
- **Users without email** (children, bulk-created accounts).
  - Better Auth requires `email`. Store a placeholder `<username>@users.invalid` with `emailPlaceholder=true`.
  - Notifications skip email for these users, and the profile asks them to add a real address.
- **Moodle migrations.** A custom `password.verify` also accepts bcrypt (`$2y$`) hashes and rehashes to scrypt on first login. Users imported from Moodle keep their passwords.
- **Emails.** The `sendVerificationEmail` and `sendResetPassword` hooks enqueue the `email.send` job, with localised React Email templates.
- **Authorization boundary.** `proxy.ts` does only an optimistic cookie-presence redirect. Every page, action and route re-validates via `auth.api.getSession` and core permission checks.
- **API tokens (Phase 8).** Implemented in-house as an `ApiToken` table: sha256-hashed `hub_…` tokens with read/write scopes, expiry and last use. A token acts with its owner's capabilities and never more, which is simpler than bending Better Auth's apiKey plugin to our RBAC.
- **Consent at registration.** Personal-data processing consent (required under Russia's personal data law, 152-ФЗ) uses `Policy`/`PolicyAcceptance`. A checkbox is in Phase 1; full policy management is in Phase 8.
- **Later SSO.** SAML/OIDC through the Better Auth `sso` plugin. LDAP as a custom credential sign-in endpoint using `ldapts`, with just-in-time user creation.

---

## 3. Permission model

### 3.1 Contexts
- Levels are `SYSTEM → CATEGORY (nested) → COURSE → ACTIVITY`.
- **Shared primary key:** `Course.id == Context.id`, and the same for categories and activities. There is one fixed UUID for the system context, so there is no join to get from an entity to its context.
- `Context { id, level, parentId, ancestorIds uuid[] (GIN), depth }`
  - Ancestors: `id = ANY(ancestorIds)`.
  - Descendants: `ancestorIds @> ARRAY[id]`.
  - Moving a category rewrites its descendants with one SQL statement.

### 3.2 Tables
- `Role { shortName, archetype, assignableLevels[], sortOrder, isProtected }`
- `RoleCapability { roleId, capability, permission: ALLOW|PROHIBIT }`: the role definition.
- `RoleOverride { contextId, roleId, capability, permission: ALLOW|DENY|PROHIBIT }`
- `RoleAssignment { userId, roleId, contextId, component: manual|enrol|cohort, enrolmentId? }`
- `RoleAssignRule { roleId, assignableRoleId }`

**Site admins** are `User.isSiteAdmin`, not a role (as in Moodle). They bypass checks except for capabilities flagged `excludeAdmin` (participation caps such as `mod.quiz:attempt` and `mod.assign:submit`), so admins never show up as "students to grade".

**Capabilities are code-defined** in `packages/core/src/access/capabilities.ts`, the modules' (`mod.<key>:<name>`) among the core's, with archetype defaults. `syncCapabilities()` runs on boot, after migrations, and grants new capabilities to roles by archetype, never touching existing edits. The `Capability` type is a string-literal union, so typos fail to compile.

### 3.3 Seeded roles (A = ALLOW)

| Capability (examples) | manager | coursecreator | editingteacher | teacher (assistant) | student | observer | guest | user (implicit, system) |
|---|---|---|---|---|---|---|---|---|
| user:create/update, cohort:manage, category:manage | A | | | | | | | |
| course:create | A | A | | | | | | |
| course:update, course:viewhidden, course:manageactivities | A | | A | | | | | |
| course:viewparticipants | A | | A | A | A | A | | |
| enrol:manage, role:assign (per RoleAssignRule) | A | | A | | | | | |
| group:manage / group:accessall | A | | A | A (accessall) | | | | |
| grade:viewall, completion:viewreports, report:view | A | | A | A | | A | | |
| grade:edit, mod.*:grade | A | | A | A | | | | |
| mod.assign:submit, mod.quiz:attempt, mod.forum:post (excludeAdmin) | | | | | A | | | |
| mod.*:view | A | | A | A | A | A | A | |
| announcement:post, calendar:managecourse, question:manage | A | | A | | | | | |
| backup:create, restore:course, import:moodle | A | | A | | | | | |
| ai:quizgen / ai:gradingassist | A | | A | A (gradingassist) | | | | |
| message:send, calendar:manageown, ai:tutor | | | | | | | | A |

- **observer** is a course-level read-only "inspector" role (methodist, HR). **Parents** use `UserRelation(mentor→mentee)` instead. `canViewUserData(actor, target, aspect, courseId?)` allows: self, a site administrator, `grade:viewall` in the course (grades), `user:update` (the overview, not grades), or being the target's mentor while `mentors.enabled` is on and the target is active. A mentor sees what the learner would see: module hooks run with a read-only context carrying the learner's permissions, so hidden grade items stay hidden.
- **guest** is implicit for anonymous visitors and for logged-in non-enrolled users on courses with guest access enabled.
- **coursecreator**: the course's creator automatically gets `editingteacher` in the new course (a site setting).

### 3.4 `can()` resolution

```ts
async function can(actor: Actor, cap: Capability, contextId: string): Promise<boolean> {
  if (actor.kind === 'system') return true;
  const def = capabilities.get(cap);                         // throws on unknown cap in dev/test
  if (actor.kind === 'user' && actor.isSiteAdmin && !def.excludeAdmin) return true;
  if (actor.kind === 'token' && !scopeAllows(actor.scopes, cap)) return false;
  if (actor.switchedRole) /* "view as student": only that role, at that course */;

  const ctx = await contexts.get(contextId);                 // LRU, NOTIFY-invalidated
  const chain = [...ctx.ancestorIds, ctx.id];                // root → leaf
  const roles = await access.rolesInChain(actor, chain);     // user's RAs on chain, enrolment ACTIVE & in time window,
                                                             // + implicit 'user' (authenticated) / 'guest' role
  const defs = await roleDefs.get();                         // all RoleCapability + RoleOverride in memory
  let allowed = false;
  for (const r of roles) {
    let p = defs.cap(r, cap);                                // ALLOW | PROHIBIT | undefined
    if (p === 'PROHIBIT') return false;
    for (const c of chain) {                                 // deeper override wins…
      const o = defs.override(c, r, cap);
      if (o === 'PROHIBIT') return false;                    // …except PROHIBIT is sticky for everyone
      if (o) p = o;                                          // ALLOW | DENY
    }
    if (p === 'ALLOW') allowed = true;                       // any role allowing suffices
  }
  return allowed;
}
```

**Supporting functions**
- `require()` throws `ForbiddenError`.
- `rolesWithCap(cap, ctx)` is user-independent and memoised. It feeds `usersWithCap(cap, ctx, { groupId })`, a single SQL query over role assignments filtered to the allowed roles and excluding prohibited ones. This powers "students who can submit", "graders" and "who to notify".
- `coursesWithCap(ctx, cap, { where, select, take })` serves listings such as "courses I can back up": it narrows the courses to those within reach of the person's role assignments (the course, a category above it, the site when a role there allows the capability) in SQL, and `can()` decides only among those. Never loop `can()` over a list of the site's courses.

**Gating outside `can()`.** Activity access is `canAccessActivity()`:
- capability, plus
- course and activity visibility (stealth),
- the availability tree (date, completion, grade, group, profile; an AND/OR JSON tree evaluated by a pure function that also produces a human-readable explanation),
- active enrolment,
- separate-groups mode.

**Caching.** Each request loads all of the user's role assignments once (usually under 100 rows). Role definitions and overrides are cached in process memory and invalidated through the `hubium_cache` NOTIFY channel, so web and worker replicas stay consistent.

**Tooling.** `/admin/permissions/check` explains for any user, capability and context which roles applied, which overrides matched, and the result. This is essential for support.

---

## 4. Data model outline (Prisma, multi-file)

All tables use the same id, timestamp and Decimal conventions (Section 0). `C*` marks a shared-PK context entity.

```
// ── core/identity.prisma (Better Auth managed + extensions)
User              email(citext uniq) emailVerified emailPlaceholder username(citext uniq) displayUsername name firstName lastName
                  locale timezone status(ACTIVE|SUSPENDED|DELETED) kind(PERSON|SERVICE) isSiteAdmin mustChangePassword
                  twoFactorEnabled avatarFileId? customFields Json lastLoginAt lastAccessAt deletedAt
Session           token(uniq) userId expiresAt ipAddress userAgent impersonatedBy?
Account           userId providerId accountId password? accessToken? refreshToken? idToken?   @@unique(providerId,accountId)
Verification · TwoFactor(secret, backupCodes) · RateLimit
UserRelation      mentorId menteeId kind(PARENT|MENTOR)                                       @@unique(mentorId,menteeId)
UserProfileField  shortName type options Json required visibleToOthers
ApiToken          userId name prefix tokenHash(uniq) scopes[] expiresAt lastUsedAt lastUsedIp revokedAt
Policy · PolicyVersion(content Json, mandatory) · PolicyAcceptance(userId, versionId, acceptedAt)

// ── core/site.prisma
SiteSetting       key(PK) value Json updatedById                       // branding, registration, email, modules, security…
EventLog          id BigInt autoincrement · name actorId realActorId contextId courseId objectType objectId
                  relatedUserId data Json origin(WEB|API|WORKER|CLI) ip createdAt   — BRIN(createdAt), (courseId,createdAt), (actorId,createdAt)
BackgroundTask    type(BACKUP|RESTORE|DUPLICATE|IMPORT_MBZ|IMPORT_QUESTIONS|EXPORT_REPORT|BULK_USERS) status progress
                  contextId createdById input Json result Json resultFileId log Json error startedAt finishedAt

// ── core/access.prisma
Context           id level(SYSTEM|CATEGORY|COURSE|ACTIVITY) parentId ancestorIds uuid[] (GIN) depth
Role · RoleCapability · RoleOverride · RoleAssignment · RoleAssignRule          (see §3)

// ── core/course.prisma
Category    C*    parentId name description Json idNumber sortOrder visible
Course      C*    categoryId fullName shortName(uniq) idNumber summary Json summaryHtml imageFileId format(TOPICS|WEEKS|SINGLE)
                  formatOptions Json startDate endDate visible lang? enableCompletion completionSettings Json
                  groupMode(NONE|SEPARATE|VISIBLE) groupModeForced defaultGroupingId guestAccess settings Json
                  search tsvector (Unsupported, generated) createdById deletedAt
CourseSection     courseId rank(fractional index) title summary Json visible availability Json
Activity    C*    courseId sectionId moduleKey rank name intro Json introHtml showIntro visibility(SHOWN|HIDDEN|STEALTH)
                  availability Json completionMode(NONE|MANUAL|AUTO) completionRules Json completionExpectedAt
                  groupMode groupingId settings Json idNumber version Int createdById deletedAt
CourseAccess      userId courseId lastAccessAt lastActivityId                      // "continue learning"

// ── core/enrol.prisma
EnrolmentMethod   courseId type(MANUAL|SELF|COHORT|GUEST) enabled name roleId key? useGroupKeys startsAt endsAt durationDays
                  maxEnrolled cohortId? groupId? welcome Json sortOrder
Enrolment         methodId courseId userId status(ACTIVE|SUSPENDED) startsAt endsAt createdById  @@unique(methodId,userId)
Group             courseId name idNumber description enrolmentKey? pictureFileId visibility
GroupMember(groupId,userId,component) · Grouping · GroupingGroup
Cohort            contextId(system|category) name idNumber(uniq) description visible · CohortMember

// ── core/completion.prisma
ActivityCompletion  PK(activityId,userId) state(INCOMPLETE|COMPLETE|COMPLETE_PASS|COMPLETE_FAIL) viewedAt overriddenById completedAt
CourseCompletion    PK(courseId,userId) progressPercent startedAt completedAt      // completedAt stays once set; job completion.course recomputes a course

// ── core/calendar.prisma
CalendarEvent     scope(SITE|CATEGORY|COURSE|GROUP|USER) categoryId? courseId? groupId? userId? activityId? moduleKey?
                  kind(OPEN|CLOSE|DUE|CUTOFF|SESSION|CUSTOM) title description Json startsAt endsAt allDay repeatId visible
CalendarFeedToken userId tokenHash scope

// ── core/files.prisma
FileBlob          storageKey(uniq) size BigInt mimeType sha256? scannedAt? createdAt      // refcount by query, GC'd; scannedAt: passed ClamAV
File              blobId contextId component area itemId? path name mimeType size uploadedById status(PENDING|READY|QUARANTINED)
                  sortOrder      @@unique(contextId,component,area,itemId,path,name)
UploadSession     userId storageKey size received name mime expiresAt completedAt

// ── core/grades.prisma
Scale(courseId?, name, items[]) · GradeLetter(contextId, lowerBound, letter)
GradeCategory     courseId parentId name aggregation(NATURAL|WEIGHTED_MEAN|MEAN|HIGHEST|LOWEST|MEDIAN) dropLowest keepHighest
                  aggregateOnlyGraded hidden
GradeItem         courseId categoryId kind(MODULE|MANUAL|CATEGORY|COURSE|EXTERNAL) activityId? moduleKey? itemNumber
                  name idNumber gradeType(VALUE|SCALE|TEXT|NONE) gradeMin gradeMax gradePass scaleId weight weightOverridden
                  multFactor decimals display hidden hiddenUntil locked sortOrder needsUpdate   @@unique(activityId,itemNumber)
Grade             gradeItemId userId rawGrade rawGradeMin rawGradeMax finalGrade feedback Json overridden excluded hidden
                  locked gradedById gradedAt                                              @@unique(gradeItemId,userId)
GradeHistory      gradeId snapshot Json source changedById changedAt

// ── core/comms.prisma
Announcement      courseId? groupId? authorId title content Json contentHtml pinned publishAt notify
Conversation      kind(DIRECT|GROUP|SELF) name? courseId? groupId? directKey(uniq, sorted user ids) lastMessageAt
ConversationMember PK(conversationId,userId) lastReadAt mutedUntil archivedAt joinedAt leftAt
Message           conversationId senderId body format(PLAIN|MARKDOWN) createdAt editedAt deletedAt   (conversationId, createdAt DESC)
UserBlock(userId, blockedUserId) · MessagingPrefs on User.customFields or own table
Notification      userId type actorId? contextId? courseId? title body url data Json readAt emailState(NONE|PENDING|SENT|DIGEST|FAILED)
                  createdAt                                                             (userId, readAt, createdAt DESC)
NotificationPreference PK(userId,type) inApp email(OFF|IMMEDIATE|DIGEST) push
PushSubscription(Phase 8) · EmailLog(to, template, status, messageId, error)

// ── core/ai.prisma
AiProvider        kind(ANTHROPIC|OPENAI_COMPAT) name baseUrl? apiKeyEnc? models Json{generation,cheap,premium} capabilities Json enabled
AiEmbeddingConfig kind baseUrl model dims(default 1024) apiKeyEnc?
AiFeatureConfig   feature(PK: QUIZGEN|GRADING_ASSIST|TUTOR) enabled providerId model effort limits Json noticeVersion
AiCourseFeature   PK(courseId,feature) enabled
AiConsent         userId feature noticeVersion acceptedAt
AiUsage           feature userId? courseId? providerId model inputTokens outputTokens cacheReadTokens cacheWriteTokens
                  costMicroUsd? durationMs status(OK|ERROR|REFUSED|LIMITED) createdAt     (userId,createdAt) (courseId,createdAt)
ContentChunk      courseId activityId? sourceType sourceId chunkIndex title text tokenCount contentHash embeddingModel
                  embedding Unsupported("vector(1024)") (HNSW cosine) · tsv Unsupported("tsvector") (GIN)
AiGeneration      feature courseId activityId? requestedById status input Json output Json acceptedCount
GradingSuggestion activityId submissionId userId suggestedGrade breakdown Json feedbackDraft model status(PENDING|APPLIED|DISCARDED)
TutorConversation userId courseId title · TutorMessage(role, content, citations Json, usageId, rating)

// ── questions.prisma (owned by packages/questions)
QuestionCategory  contextId parentId name info sortOrder
Question          categoryId type(MULTICHOICE|TRUEFALSE|SHORTANSWER|NUMERICAL|MATCH|ESSAY|DESCRIPTION) name text Json textHtml
                  generalFeedback Json defaultMark penalty data Json(zod per type) status(DRAFT|READY|HIDDEN)
                  source(MANUAL|IMPORT|AI) aiGenerationId? idNumber createdById

// ── modules/assign.prisma
AssignSubmission  activityId userId attemptNumber status(NEW|DRAFT|SUBMITTED|REOPENED) onlineText Json submittedAt latest
                  @@unique(activityId,userId,attemptNumber)      // files: component 'mod.assign', area 'submission', itemId
AssignGrade       activityId userId attemptNumber grade graderId feedback Json gradedAt   // feedback files: area 'feedback'
AssignOverride    activityId userId? groupId? dueAt cutoffAt allowSubmissionsFrom (extensions)

// ── modules/quiz.prisma
QuizSlot          activityId page slot kind(FIXED|RANDOM) questionId? categoryId? includeSubcats tagIds[] maxMark requirePrevious
QuizAttempt       activityId userId attemptNumber state(IN_PROGRESS|OVERDUE|FINISHED|ABANDONED) startedAt dueAt finishedAt
                  layout Json sumGrades needsManualGrading preview
QuestionAttempt   attemptId slot questionId snapshot Json(frozen question) maxMark seed response Json fraction mark
                  state flagged comment Json
QuestionAttemptStep questionAttemptId seq state data Json fraction userId createdAt          // audit + manual grading
QuizOverride      activityId userId? groupId? openAt closeAt timeLimitSec attempts

// ── modules/forum.prisma
ForumDiscussion   activityId groupId? authorId title pinned locked timedStart timedEnd lastPostAt postCount
ForumPost         discussionId parentId authorId content Json contentHtml privateToUserId? mailed createdAt editedAt deletedAt
ForumSubscription activityId userId discussionId? · ForumReadState(userId, discussionId, lastReadAt)

// ── modules/video.prisma
VideoAsset        sourceFileId status(UPLOADED|PROBING|TRANSCODING|READY|FAILED) durationSec width height renditions Json
                  masterKey thumbnailFileId spriteVttKey progress error attempts
VideoCaption      assetId lang label kind fileId
VideoProgress     PK(activityId,userId) watchedRanges Json watchedSeconds durationSec lastPositionSec percent completedAt

// ── modules/livesession.prisma
LiveSession       activityId provider(BBB|JITSI) providerMeetingId startsAt endsAt status(SCHEDULED|LIVE|ENDED)
LiveAttendance    sessionId userId joinedAt leftAt durationSec role
LiveRecording     sessionId providerRecordingId url format durationSec published

// ── modules/scorm.prisma
ScormPackage      activityId fileId version(SCORM_12|SCORM_2004) manifest Json storagePrefix status sha256
ScormSco          packageId identifier title launchHref parameters isSco sortOrder masteryScore
ScormAttempt      activityId userId attemptNumber startedAt finishedAt
ScormTrack        attemptId scoId cmi Json lessonStatus completionStatus successStatus scoreRaw scoreMin scoreMax scoreScaled totalTimeSec

// ── modules/lti.prisma
LtiTool           name clientId(uniq) oidcLoginUrl targetLinkUri redirectUris[] jwksUrl? publicKeyPem? deepLinkingUrl
                  customParams Json privacy Json(sendName,sendEmail) services Json(ags,nrps) scope(SITE|COURSE) courseId? status
LtiDeployment     toolId deploymentId contextId?
LtiPlatformKey    kid publicJwk Json privateKeyEnc alg active rotatedAt
LtiLaunchState    state nonce toolId userId messageHint Json expiresAt usedAt
LtiLineItem       toolId courseId activityId? gradeItemId label scoreMaximum resourceId tag startDate endDate
LtiAccessToken    toolId tokenHash scopes[] expiresAt

// content modules (page/file/url/label): no tables — Activity.settings + file areas
```

The FK cascade policy: activity → module rows cascade on purge, user → content is anonymised via privacy hooks rather than cascade-deleted. Heavy reports use `$queryRaw` (or Prisma TypedSQL) parsed with zod.

---

## 5. Background jobs: pg-boss confirmed

- **Why pg-boss.** No Redis, which rules out BullMQ. It has SKIP LOCKED queues, retries with backoff, `startAfter`, singleton/debounce keys, cron `schedule()`, dead-letter queues and expiration. The deciding feature is **transactional enqueue** through the `db` executor option, adapted from a Prisma interactive transaction.
- **Alternatives.** Graphile Worker is a close second (LISTEN-based latency, SQL `add_job`), but our jobs are latency-insensitive. Realtime does not go through jobs.
- **Worker structure.**
  - `apps/worker/src/main.ts` registers the core jobs (`handlers.ts`) and the modules' jobs and cron tasks (`registry.ts`) for the queues named in `WORKER_QUEUES`, and removes cron schedules no handler has any more.
  - It shuts down gracefully (`stop({ graceful })`) and exposes `/healthz` for compose.
  - A second container, `worker-media` (ffmpeg image, CPU/memory limits), runs only the `media` queue.
- **User-visible tasks** (backup, imports, exports) get a `BackgroundTask` row with progress, pushed over SSE.

| Area | Jobs (cron in UTC where scheduled) |
|---|---|
| Email and notifications | `email.send`, `email.digest` (hourly, sends at each user's chosen hour), `notification.email`, `notification.push`, `notification.fanout` (chunked), `announcements.publish`, `notifications.prune` |
| Media | `video.transcode` (media queue) |
| Standards | `scorm.extract`, `lti.cleanup` |
| Interchange | `interchange.import` (.hubium and .mbz), `interchange.backup`, `interchange.lost` (fails tasks a stopped worker left) |
| Assessment | `quiz.overdue.sweep`, `lesson.overdue.sweep`, `workshop.phase.switch`, `grades.recalc.course` (large courses, in batches) |
| Completion | `completion.recompute` (one activity for everyone), `completion.course` (a course's progress) |
| Reminders and sync | `assign.due.reminder`, `calendar.reminders`, `calendar.subscriptions`, `enrol.expire`, `competency.plans.sync`, `livesession.remind`, `livesession.poll`, `livesession.recordings.sync`, `auth.ldapSync` |
| Achievements and reports | `badges.review`, `certificates.review`, `reports.schedules` |
| AI | `ai.index.activity` (reads document files through `ctx.files.text`: PDF via unpdf, DOCX/PPTX/ODT/ODP from their XML parts, text and HTML, cached per blob in `FileBlobText`), `ai.index.course`, `ai.index.all` (a reindex of every course, from Administration), `ai.quizgen` |
| Users and integrations | `users.bulk`, `webhook.deliver`, `webhooks.prune` |
| Housekeeping | `system.heartbeat`, `files.gc` (unreferenced files, stray objects, expired uploads), `recyclebin.purge`, `eventlog.prune`, `auth.sessions.cleanup` |


---

## 6. File storage

### 6.1 Driver
`StorageDriver` interface:
- `put`, `getStream`, `head`, `delete`, `copy`
- `createMultipartUpload` / `signPart` / `complete`
- `signedReadUrl(key, { ttl, disposition, filename })`

Two implementations:
- **S3**: `@aws-sdk/client-s3` + `s3-request-presigner`. It uses two clients: an internal endpoint for server operations, and the public endpoint `S3_PUBLIC_URL` for presigning, because signatures cover the host.
- **FS**: dev and small installs. "Signed URLs" are HMAC tokens served by our `/files/blob/[token]` route.

### 6.2 Model
- `File` follows Moodle's addressing: `context/component/area/itemId/path/name`. It points to an immutable `FileBlob`.
- Duplicating or restoring a course copies `File` rows, not bytes.
- Blobs are GC'd when unreferenced.

### 6.3 Uploads
- **Under 50 MB:** streamed through a Node route handler. We sniff the type with `file-type`, re-encode images with sharp (stripping EXIF/GPS) and compute sha256.
- **Large files** (video, SCORM): resumable S3 multipart via Uppy `@uppy/aws-s3` against our init/sign/complete endpoints.
- Uploads land in **draft areas** (`area='draft'`, `itemId=draftId`). Saving the form calls `files.commitDraft(draftId → component/area/itemId)` (Moodle's draft pattern), so there are no orphans and ACLs attach to the target.

### 6.4 Download access control
- The bucket is never public. Every download goes through `GET /files/[fileId]/[name]`:
  1. Resolve the owning component's `canRead(ctx, file)`:
     - core areas: course overview needs `course:view` or enrolment; avatars are visible to any logged-in user; branding is public;
     - module areas: e.g. assign submissions are visible to the owner or a grader in the same group.
  2. Respond with a **302 to a 60-second presigned URL** that has `response-content-disposition` set, or stream it for the FS driver.
- Inline HTML/SVG gets `Content-Security-Policy: sandbox`, `X-Content-Type-Options: nosniff`, and is otherwise forced to download.
- **HLS:** the master and variant `.m3u8` are served by our route after the ACL check, with segment URIs rewritten to presigned URLs (TTL of video duration + 2h). Segments stay private.
- **Untrusted HTML (SCORM)** is served from a separate **content origin** (Section 9, Phase 6).

### 6.5 Compose hostnames (Caddy)
- `LMS_HOST` → web
- `CONTENT_HOST` → web (`proxy.ts` only allows `/c/*` there; the LMS session cookie is host-only so it never reaches this host)
- `S3_PUBLIC_URL` → the S3 service (RustFS in compose; presigned URLs only)

In dev, `localhost:3000` versus `127.0.0.1:3000` gives two distinct origins for free.

---

## 7. Realtime: SSE + Postgres LISTEN/NOTIFY

**Choice: SSE.** Push is one-directional; client→server traffic uses server actions and POST. SSE runs in a normal Next route handler, auto-reconnects with `Last-Event-ID`, and works through Caddy over HTTP/2. WebSockets would need a custom server or a separate service, because App Router route handlers can't upgrade connections. That buys us nothing here.

**Design**
- **Publisher.** `ctx.realtime.publish(userIds, event)` runs `SELECT pg_notify('hubium_rt', json)` inside the transaction, so events fire only on commit.
  - NOTIFY payloads are limited to 8 KB: send `{u:[ids], t:type, id, small payload?}`, and clients fetch details as needed.
  - Fan-out to large audiences (an announcement to 3,000 users) is chunked by the notification job.
- **Hub.**
  - Each web instance holds one dedicated `pg.Client` running `LISTEN hubium_rt, hubium_cache` (outside Prisma's pool).
  - An in-process `Map<userId, Set<Controller>>` dispatches events.
  - Heartbeat comment every 25 s.
- **Route.** `GET /api/realtime` (Node runtime, dynamic):
  - authenticated by session cookie or bearer;
  - headers `Cache-Control: no-store`, `X-Accel-Buffering: no`, and Caddy `flush_interval -1`.
- **Client.** One EventSource per browser, not per tab: a `BroadcastChannel` leader election keeps HTTP/1.1 connection limits in check. Events update TanStack Query caches (messages), the notification bell, and task progress.
- **Events:** `message.new`, `message.read`, `typing` (NOTIFY only, never stored), `notification.new`, `task.progress`, `video.status`, `livesession.status`.
- **AI tutor streaming** does not use the bus. It is a direct streamed response from its own route handler.
- **Mobile:** SSE via `react-native-sse`, plus push notifications in Phase 8.

---

## 8. Rich content editor

- **Tiptap 3**, with these extensions:
  - StarterKit, Link (protocol allowlist), Table, Image (our file API only), Placeholder, CharacterCount, CodeBlock (lowlight), Details, TaskList;
  - **Mathematics** (KaTeX, inline and block);
  - custom nodes: `embed` (provider allowlist: YouTube via `youtube-nocookie`, RuTube, VK Video, Vimeo, plus admin-added domains; URL → canonical embed src), `fileAttachment`, `callout`, `htmlBlock` (sanitised legacy HTML from Moodle imports; read-only in the editor).
  - Use only MIT-licensed extensions; check each one, avoid Pro.
- **Storage:** `content Json` (ProseMirror doc with `v` schema version; the source of truth) plus `contentHtml`, rendered and sanitised on write. The HTML is used for emails, search, AI and fast display.
- **Write path** (`@hubium/editor/server`):
  1. Validate JSON against the schema: unknown nodes and marks are rejected; attributes are validated (href protocols, image src must be `/files/...`, embed host on the allowlist).
  2. Render with `@tiptap/static-renderer` (no DOM on the server; KaTeX `renderToString` with `output:'htmlAndMathml'` for accessibility).
  3. Run `sanitize-html` as defence in depth.
  4. `extractText()` for tsvector and RAG.
- **Read path:** RSC renders the static-renderer React output. Embeds use lazy iframes, with an optional click-to-load privacy mode.
- **Imports:** HTML → JSON via `@tiptap/html` server parsing. Anything unrepresentable is wrapped in `htmlBlock`, so nothing is lost.
- **Lighter surfaces:** messages and the AI tutor use Markdown rendered with react-markdown + remark-gfm + remark-math + rehype-katex, with a restricted element allowlist. No raw HTML.
- Collaborative editing (Yjs) is out of scope for v1.

---

## 9. Phased roadmap

**Definition of Done for every phase (the gate)**
1. CI is green: `turbo lint typecheck test build`, and `prisma migrate diff --exit-code` is clean.
2. A clean `docker compose up --build` is healthy. Migrations run in a one-shot `migrate` service with `depends_on: service_completed_successfully`. `pnpm db:seed --profile demo` produces that phase's demo data.
3. Playwright e2e for the phase's flows is green (Chromium desktop and a 375px WebKit viewport for the key flow).
4. axe shows zero serious or critical issues on new pages. Keyboard-only walkthrough of new flows.
5. ru/en key-parity test passes. Light/dark reviewed.
6. A 15-minute manual browser smoke checklist (ru/en, light/dark, mobile).
7. ADRs for decisions taken, short user docs, and a `v0.N.0` tag.

### Phase 1: Foundation (size L)

**Start with four spikes on days 1–3:**
1. Better Auth + Prisma 7 `prisma-client` + adapter-pg, with UUIDv7 IDs.
2. Next 16 + Turbopack consuming source-only workspace packages, plus standalone output in a pnpm monorepo (`outputFileTracingRoot`).
3. pg-boss transactional `send` inside a Prisma transaction.
4. next-intl without routing.

**Deliverables**
- **Repo:** workspace, Turbo, Biome, dependency-cruiser, `LICENSE` (AGPL-3.0), compose files (db, s3, mailpit, caddy, migrate, web, worker), multi-target Dockerfile (`turbo prune`), GitHub Actions.
- **db:** `prisma.config.ts`, schema files `identity`, `site`, `access`, `files`. Initial migration creates the extensions and the GIN index. `createDb()`, seed (admin, demo users), the template-database helper for tests (`@hubium/db/testing`).
- **core:**
  - env (zod), `crypto` (AES-256-GCM envelope with `APP_SECRET` for stored secrets), `AppError`, the operation framework and transports, actor/context;
  - permissions (contexts, capability registry, `can`, caches with NOTIFY invalidation, `syncCapabilities`), seeded roles;
  - settings registry (`defineSetting` + memory cache), storage drivers, draft areas, ACL resolver registry, file routes;
  - EventLog, users service (CRUD, suspend, CSV bulk upload), mail (React Email + nodemailer), jobs wrapper.
- **ui:**
  - tokens (OKLCH), theme provider (next-themes);
  - accent palette generator: admin hex → scale, with automatic lightness adjustment to reach 4.5:1 contrast and a warning shown to the admin;
  - app shell (sidebar, topbar, mobile bottom nav, skip link) and core primitives.
- **web:**
  - auth pages (login with email or username, register, verify, reset, 2FA, OAuth buttons), profile and settings (language, timezone, 2FA, active sessions);
  - admin: users, roles editor (capability matrix), permission checker, general/branding/registration/auth/email settings, environment page.
- **worker:** boot, `email.send`, health.

**Key files:**
- `packages/db/prisma.config.ts`
- `packages/core/src/{operation.ts,access/can.ts,access/capabilities.ts,files/*,settings/*}`
- `apps/web/src/{proxy.ts,server/ctx.ts,server/to-action.ts}`
- `apps/web/src/app/api/auth/[...all]/route.ts`
- `docker/compose.yml`, `docker/Caddyfile`

**Acceptance**
- A clean compose run serves `https://lms.localhost`. The seeded admin logs in.
- Registration sends a verification mail visible in Mailpit. TOTP enrolment and login work. Google/Yandex/VK work with test credentials (manual).
- Changing the accent colour and logo applies after reload, and a low-contrast colour gets auto-adjusted with a notice. Dark mode and ru/en switching persist on the profile.
- At least 40 `can()` unit scenarios pass: overrides, prohibit, suspended or expired enrolment, admin exclusion, token scopes.
- Integration tests cover the files ACL against both FS and S3 (RustFS).
- e2e covers login, 2FA, admin creating a user and assigning a role, and branding.

### Phase 2: Core LMS (size XL)

**Deliverables**
- **module-sdk v1**, and **mod-content** (page, file/folder, url/embed, label) as the reference modules.
- **editor** package (Tiptap + KaTeX + embeds + uploads).
- **Course structure:** category tree admin (move with ancestor rewrite), courses (create from category, settings, formats topics/weeks/single, a course picture), sections and activities with edit mode (dnd-kit drag-and-drop plus a keyboard-accessible "Move to…" menu), visibility/stealth, generic activity form with module `SettingsFields`.
- **Access:** availability conditions (date, completion, group, profile; grade arrives in Phase 3), recycle bin, "view as student" role switch, impersonation (`user:loginas`).
- **Enrolment:** manual, self (with or without a key; group keys auto-add to the group), cohort sync, guest access, enrolment expiry.
- **People:** participants (filters, role assignment, bulk actions), groups/groupings, cohorts admin.
- **Progress:** activity completion (manual, view) and module rules; course completion and progress percentage.
- **Navigation:** dashboard (my courses with progress, "continue", upcoming deadlines, `todo` hook), catalog (category browse, search via tsvector + pg_trgm, course landing with enrol button), calendar (month/week/agenda, site/course/group/user events, iCal feed).
- **Reports:** participation and activity-completion matrix.

**Key files/routes:**
- `packages/module-sdk/src/{activity-module.ts,ui.ts,ctx.ts}`
- `modules/content/*`, `packages/editor/src/{client,server}/*`
- `packages/core/src/{courses,enrol,groups,completion,availability,calendar}/*`
- Routes `/catalog`, `/course/[courseId]/*`, `/course/[courseId]/a/[activityId]`, `/calendar`, `/admin/{categories,courses,cohorts}`

**Acceptance**
- e2e: a teacher builds a two-section course (page with a formula, file, YouTube/RuTube embed, label) and creates a key enrolment with a group key.
- The student self-enrols with the key, lands in the group, sees the hidden activity disappear under "view as student", completes everything, and reaches 100% progress and course completion. The calendar shows the course event. The iCal feed validates.
- Unit tests cover the availability evaluator, fractional ranks and enrolment windows.

### Phase 3: Assessment (size XL)

**Deliverables**
- **Gradebook (core):**
  - setup tree (categories, aggregation, weights, drop-lowest, hidden/locked, scales, letters);
  - pure aggregation engine on `decimal.js`;
  - grader report (virtualised TanStack Table, inline edit, overrides, history), user report, overview report;
  - CSV/XLSX export (`exceljs` streaming in the worker) and CSV grade import;
  - grade availability condition, completion by grade/pass.
- **mod-assign:**
  - online text and files, allow-from/due/cut-off/grading-due dates, submission statement, attempts with reopen modes;
  - per-user/group extensions (overrides), grading table and side-by-side grading panel (feedback text and files);
  - bulk download of submissions as zip, calendar events, `todo` "needs grading".
- **Question bank (`packages/questions`):**
  - category tree per context, 6 types plus description, per-type zod data schemas, editor with preview, tags, move/copy;
  - attempts freeze a **snapshot** of the question, so later edits never corrupt history;
  - formulas of calculated questions and of gradebook calculations go through `@hubium/formula`: its own lexer, parser and evaluator (no `eval`), with Moodle's function sets and limits on length, size and nesting.
- **mod-quiz:**
  - pages/slots, random-from-category slots, shuffle of questions and answers (deterministic seed);
  - time limit enforced server-side (`dueAt` plus a scheduled `quiz.attempt.close` job and a sweeper); autosave every 30 s and on page change;
  - grading methods, review-options matrix, overrides, deferred and immediate feedback, password;
  - manual grading queue for essays, results report with basic item statistics (facility, discrimination), regrade.

**Key files:** `packages/core/src/grades/{aggregate.ts,service.ts}`, `packages/questions/src/{types/*,engine.ts}`, `modules/assign/*`, `modules/quiz/*`

**Acceptance**
- Aggregation fixtures reproduce totals computed by Moodle for the same setups (natural with weights, weighted mean, drop lowest).
- e2e: a timed quiz with all six types auto-submits when time runs out with the browser closed. The essay is graded manually and updates the course total. A student submits an assignment after its extension date and the teacher grades it with a feedback file.
- The XLSX export is parsed back in the test.
- k6 smoke: 200 concurrent attempt autosaves at p95 under 300 ms on the compose stack.

### Phase 4: Communications (size L)

**Deliverables**
- **Realtime hub:** SSE route, LISTEN client, BroadcastChannel leader.
- **Notifications:**
  - type registry (core and module), in-app centre and bell (live unread count);
  - preference matrix per type and channel, email immediate or daily digest;
  - one-click `List-Unsubscribe`, localised React Email templates.
- **Messaging:**
  - direct and group conversations, including course-group chats; unread state, typing indicator, attachments;
  - blocking and privacy setting ("who can message me"), infinite scroll.
- **mod-forum:** standard and Q&A types, group modes, subscriptions (optional/forced/auto/off), unread tracking, attachments, pin/lock, private replies, moderation, completion rules (posts/discussions/replies), digests.
- **Announcements:** course stream (Classroom-like) plus site announcements; scheduled publishing.
- **Wiring:** notifications for assign (submitted, graded, due soon), quiz (graded, essay needs grading), enrolment, calendar reminders and forum.

**Acceptance**
- Two browser contexts exchange messages with under 1 s latency (Playwright). Reconnect resumes without loss (`Last-Event-ID` plus refetch).
- The forum digest arrives at the configured hour. Muting a type stops both channels. Unsubscribe works without login.
- An announcement to 2,000 seeded users fans out in under 60 s.

### Phase 5: Media & webinars (size L)

**Deliverables**
- **mod-video, uploads:** resumable multipart upload, `video.probe` (ffprobe).
- **mod-video, transcoding** (`video.transcode`, ffmpeg via `child_process.spawn`; fluent-ffmpeg is archived):
  - H.264/AAC HLS with fMP4 segments, ladder capped at the source resolution: 360p/800k, 720p/2.8M, 1080p/5M;
  - `-preset veryfast`, `-g`/`-keyint_min` aligned to 6 s segments, `-sc_threshold 0`, `-var_stream_map`, master playlist;
  - progress via `-progress pipe:1`, pushed over SSE.
- **mod-video, assets:** poster, scrubbing sprite + VTT, caption upload (VTT, with SRT converted), optional deletion of the source after transcode.
- **Player:** `hls.js` + `media-chrome` (accessible controls, captions, keyboard). Embed adapters behind one `PlayerAdapter` interface:
  - YouTube IFrame API;
  - RuTube `postMessage` API;
  - VK Video JS API;
  - providers without an API fall back to "viewed" completion only.
- **Watch progress:** merged watched intervals, heartbeat every 15 s plus `sendBeacon` on page hide, optional "no seeking ahead", completion at a minimum watch percentage, watch report.
- **mod-livesession:** `LiveProvider` interface (`createMeeting`, `joinUrl(user, role)`, `end`, `getRecordings`, `handleCallback`).
  - **BBB:** SHA-256 checksums, `create`/`join`/`getMeetingInfo`/`getRecordings`, `meta_endCallbackUrl` and recording-ready callbacks.
  - **Jitsi:** self-hosted with JWT (jose HS256, `context.user.moderator`), or meet.jit.si without moderation control.
  - Scheduling with calendar events, join window, moderator/attendee mapping from capabilities, attendance (BBB polling and callbacks; Jitsi join clicks), recordings list, attendance report.

**Acceptance**
- A 200 MB 1080p MP4 is playable in under 3× realtime on a 4-vCPU `worker-media`. The web container stays responsive during transcoding (CPU limits verified).
- 90% watch completion works, and seek-ahead blocking works.
- Captions toggle via keyboard.
- The BBB flow works end-to-end against a test BBB server: create, join as teacher and student, end, attendance, recording link.
- Jitsi JWT join works as moderator versus participant (manual QA against docker-jitsi-meet).

### Phase 6: Standards & import (size XL)

**SCORM 1.2/2004 (`mod-scorm`)**
- **Upload** → `scorm.extract`:
  - streaming unzip with yauzl, zip-slip and zip-bomb limits (file count, total size, compression ratio);
  - parse `imsmanifest.xml` with fast-xml-parser;
  - store files under `scorm/<packageId>/`.
- **Content origin:** files are served from `CONTENT_HOST` via `/c/<signed token>/scorm/<pkg>/<path>`. The token in the path keeps relative URLs working. The response is streamed from storage with correct MIME types.
- **Runtime host:** a page on the content origin hosts **scorm-again** (`Scorm12API`/`Scorm2004API`) and loads the SCO in a same-origin child iframe, so `window.parent.API` discovery works.
  - CMI is restored with `loadFromJSON`.
  - Commits go to `/api/mod/scorm/commit` with a launch token (CORS restricted to the LMS origin), with autocommit plus a keepalive fetch on unload. Verify option names against the pinned scorm-again version.
- **Tracking:** full CMI JSON plus extracted status and score fields; attempts, grading method, completion from status/score, SCORM report, and an admin CMI debug view.

**LTI 1.3 platform (`mod-lti`, using `jose`)**
- **Keys:** platform RS256 keys with rotation; `GET /api/mod/lti/jwks`.
- **Tool registry:** manual registration, plus Dynamic Registration as a stretch goal.
- **Launch:**
  - OIDC third-party login initiation, with a signed `login_hint` and `lti_message_hint`;
  - authorization endpoint `/api/mod/lti/auth` validates `redirect_uri` by exact match, then state, nonce, client_id and deployment;
  - sends an auto-POST `id_token` with LTI claims: message_type, version, deployment_id, target_link_uri, resource_link, LIS role URIs mapped from our roles, context, tool_platform, launch_presentation (locale, return_url), custom, plus AGS and NRPS claims.
- **Deep Linking:** request → return endpoint verifies the tool JWT through a cached `createRemoteJWKSet`, then creates activities and line items.
- **AGS:** client_credentials token endpoint with JWT client assertion; line items, scores and results map onto `GradeItem(kind=EXTERNAL)`.
- **NRPS:** memberships endpoint.
- **LTI client-side postMessage storage** (`lti.put_data`/`get_data`) for tools in iframes when third-party cookies are blocked.

**Backup / restore / import (`packages/interchange`)**
- **Own `.hubium` format:** a zip containing `manifest.json` (formatVersion, appVersion, module versions/dataVersions, userData flag), `course.json`, `activities/<id>/…` from module `backup.export`, `questions/`, `files.json` + `files/<blobId>`. Per-version zod schemas with migrations.
- **Restore:** to a new or existing course with an `IdMapper`. Course duplicate, activity duplicate and "import from another course" use the same pipeline without an archive: the copy's `File` rows point to the same blobs, so no bytes are read or stored. An archive is written as a stream, file by file; pictures, media and other compressed content go in stored, not deflated.
- **.mbz import:**
  - tar.gz (newer) or zip (older) via `tar-stream`;
  - reads `moodle_backup.xml`, course, sections, `activities/*/{module.xml,<mod>.xml,grades.xml,inforef.xml}`, `files.xml`, `questions.xml`, `gradebook.xml`, `groups.xml`;
  - rewrites `@@PLUGINFILE@@` and converts HTML to Tiptap JSON (`htmlBlock` fallback);
  - each module's `importers.moodle` maps its own modnames (page, label, url, resource, folder, assign, quiz + 14 question types, forum structure, scorm, lti → needs admin tool mapping, bigbluebuttonbn → livesession);
  - anything unsupported becomes a placeholder label, plus an import report.
- **Questions:** GIFT import via `gift-pegjs` mapped to our types; Moodle XML import and export (category paths, base64 images, feedback, fractions).

**Acceptance**
- **SCORM:**
  - Rustici "Golf Examples" (1.2 and 2004 3rd/4th edition) record completion, score and suspend/resume.
  - An iSpring and an Articulate Storyline export work (iSpring is very common in Russia).
  - The SCO cannot read LMS cookies (test asserts `document.cookie` on the content origin lacks the session).
- **LTI:** e2e against an **ltijs-based test tool** in `tools/lti-test-tool` (test-only, Apache-2.0): launch → deep link → score passback lands in the gradebook → NRPS roster. Manual run against saLTIre.
- **Moodle:** fixture `.mbz` files generated from Moodle 4.1 LTS, 4.5 LTS and 5.x (our own sample courses) import with expected counts. 3.11 is best-effort.
- **Round trip:** backup → restore yields an equal normalised snapshot.
- **GIFT/XML:** a corpus test covers all supported constructs.

### Phase 7: AI (size L)

**Provider layer (`packages/ai`)**

```ts
interface LlmProvider {
  generateObject<T>(r: { model: string; system: string; messages: Msg[]; schema: z.ZodType<T>; maxTokens: number;
                         effort?: 'low'|'medium'|'high'; cacheablePrefix?: string }): Promise<{ object: T; usage: Usage }>;
  generateText(r: TextReq): Promise<{ text: string; usage: Usage }>;
  streamText(r: TextReq): AsyncIterable<{ type: 'delta'; text: string } | { type: 'done'; usage: Usage; stopReason: string }>;
}
interface EmbeddingProvider { model: string; dims: number; embed(texts: string[], kind: 'query'|'document'): Promise<number[][]> }
```

**Anthropic adapter** (`@anthropic-ai/sdk`, official SDK):
- **Models** are configured in `AiProvider.models`, never hard-coded: `claude-sonnet-5-5` for generation, `claude-haiku-5-5` for cheap tasks (chunk summaries, conversation titles, query rewriting), `claude-opus-5-5` as an option for the grading assistant.
- **Structured output** uses `client.messages.parse` with `output_config.format: zodOutputFormat(schema)`. Forced `tool_choice` returns a 400 on these models; don't use it. Verify the SDK zod helper works with zod 4.6 in the spike.
- **Thinking** stays at the default adaptive mode. Set `output_config.effort` explicitly per feature:
  - quiz generation `medium`, grading `high`, tutor `low`, Haiku tasks `low`;
  - Haiku 5.5 and Opus 5.5 default to `medium`, Sonnet 5.5 to `high`.
- **Request shape:**
  - send no `temperature` (non-default sampling values return a 400);
  - no assistant prefill;
  - read content blocks by `type`, because responses may start with thinking blocks;
  - size `max_tokens` with room for thinking;
  - stream the tutor via `messages.stream`.
- **Refusals:** check `stop_reason === 'refusal'` and map it to `AiUsage.status=REFUSED`. On the Claude API, Sonnet/Opus requests opt into server-side `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`). Haiku 5.5 has no server-side fallback, so handle it gracefully.
- **Prompt caching:** `cache_control` on the stable prefix (system prompt plus course overview). Volatile retrieved chunks go after the breakpoint. Verify with `usage.cache_read_input_tokens`.
- **Usage logging:** `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`. Optionally use the Message Batches API (50% cheaper) for bulk generation.

**OpenAI-compatible adapter** (`openai` SDK with `baseURL`; covers Ollama, vLLM, YandexGPT and similar):
- capability flags per provider: `jsonSchema`, `streaming`;
- fallback is prompt-instructed JSON → zod validation → one repair retry.

**Embeddings:** Anthropic offers no embeddings API, so this is a separate provider. Default is an OpenAI-compatible `/v1/embeddings` endpoint:
- recommended: self-hosted **bge-m3** (multilingual including Russian, 1024 dims) via an optional compose profile `ai-local` (Ollama or TEI);
- alternatives: Voyage (1024 output dims) or OpenAI `text-embedding-3-small` with `dimensions:1024`;
- changing the model clears the stored vectors; `hubium ai reindex` (or **Administration → AI → Reindex courses**) embeds the course text again, through the worker or with `--sync` in place.

**Features (`packages/core/src/ai/*`)**
- **Admin and limits:**
  - per-feature enable, provider/model/effort, per-course toggle;
  - quotas: per-user daily tokens, per-course monthly tokens, requests per minute (computed from `AiUsage`);
  - usage dashboard;
  - editable privacy notice (versioned) with `AiConsent` before first use.
  - When AI is disabled site-wide, every AI UI element is hidden and every AI endpoint returns 404.
- **Indexing:**
  - module `ai.extract` feeds a chunker (about 500 tokens with overlap, heading-aware) and embeddings;
  - `ContentChunk` uses an HNSW cosine index with `hnsw.iterative_scan` for filtered queries;
  - **hybrid retrieval:** vector plus `tsvector` (russian/english config), merged with reciprocal rank fusion.
- **Quiz generation:**
  - pick activities, types, count, difficulty and language;
  - long sources are summarised by Haiku first, then Sonnet generates `QuestionDraft[]`;
  - mapped through the `packages/questions` zod schemas and saved as `status=DRAFT, source=AI`;
  - review UI to accept, edit or reject in bulk.
- **Grading assistant** (in the assign grading panel):
  - input is the assignment description plus the teacher's criteria plus the submission text (PDF, Word, slide and text attachments through the cached document extraction, 60,000 characters per file and 150,000 in all; other files are listed to the teacher as not analysed);
  - **pseudonymised**: no names or emails;
  - output is `{ suggestedGrade, criteria[], feedbackDraft, confidence }`, shown as a suggestion;
  - "Apply" only fills the form, and the teacher must save. It is never auto-saved.
  - The system prompt treats submission text as data (prompt-injection resistance).
- **Tutor chat:**
  - retrieval is restricted to activities the student can currently access, computed by `canAccessActivity`;
  - quiz content is excluded, and the tutor is disabled while a quiz attempt is in progress, per `tutorPolicy`;
  - answers carry citations (activity links), with an "I don't know" policy;
  - history is stored; thumbs up/down feedback.

**Acceptance**
- CI uses a deterministic mock provider (recorded fixtures) for all AI e2e tests.
- A nightly opt-in live smoke test against Claude runs when a secret is present.
- Tests prove a hidden activity's chunks are never retrieved, and that the tutor is unavailable during an in-progress quiz.
- Exceeding a quota returns a localised limit message and logs `LIMITED`.
- Every call creates an `AiUsage` row with token counts.

### Phase 8: Hardening & API (size L)

**Deliverables**
- **REST API v1:** Hono + OpenAPI 3.1 + Scalar docs at `/api/v1/docs`.
  - Endpoints: `/me`, `/users`, `/categories`, `/courses`, `/courses/{id}/contents|enrolments|groups|grades`, `/activities/{id}` + `/actions/{name}`, `/calendar/events`, `/conversations`, `/notifications`, `/files` (upload), `/cohorts`, `/tokens`.
  - Auth: PAT (scopes) or Better Auth bearer; per-token rate limits; versioning and deprecation policy; optional outgoing webhooks (HMAC-signed, delivered by jobs).
- **PWA:** manifest, a hand-written `public/sw.js` (offline fallback, push handler; no heavy offline caching for an authenticated, dynamic app), Web Push (`web-push`, VAPID) as a notification channel.
- **Security:**
  - CSP built per request (frame-src allowlist from embed providers, BBB/Jitsi hosts, registered LTI tool domains, content origin); `frame-ancestors`; HSTS;
  - Origin/`Sec-Fetch-Site` checks on cookie-authenticated route handlers;
  - SSRF guard for server-side fetches of JWKS, embeds and AI base URLs (block private ranges unless allowlisted);
  - upload limits; optional ClamAV scan of every upload before it is stored (`CLAMAV_URL`, compose profile `clamav`), failing closed while the scanner is down;
  - secret rotation commands; security headers test; dependency audit (osv-scanner); CodeQL.
- **Privacy:** data export and deletion/anonymisation using module `privacy` hooks; policy management UI.
- **Accessibility:** axe in every e2e; manual NVDA and VoiceOver passes on core flows; reduced motion; quiz timer aria-live announcing only at thresholds; focus management audit.
- **Performance and operations:**
  - k6 scenarios (1,000 concurrent quiz attempts; dashboard at 500 rps);
  - query review (`pg_stat_statements`);
  - pino structured logs, optional OpenTelemetry tracing (`@hubium/telemetry`: OTLP/HTTP export when `OTEL_EXPORTER_OTLP_ENDPOINT` is set, Prisma and pg-boss spans, W3C trace context carried into jobs, `trace_id` in log records), `/api/health` and `/metrics`;
  - backup/restore runbook (`pg_dump` plus bucket sync), upgrade guide, admin environment checks (content origin configured, SMTP, cron heartbeat, storage).

**Acceptance**
- The OpenAPI spec validates (Spectral), and a generated TypeScript client passes contract tests.
- Lighthouse PWA installable; push received.
- Zero axe serious/critical across the full e2e suite.
- k6 targets met on the reference box (8 vCPU / 16 GB).
- Security checklist signed off. Tag `v1.0.0`.

---

## 10. Testing strategy and CI

**Test layers**
- **Unit** (vitest, node): permissions resolution, availability evaluator, grade aggregation (Moodle-parity fixtures), question grading and shuffle, GIFT/XML parsers, SCORM manifest and CMI mapping, LTI claim builder and JWT validation (including negative cases: wrong alg, kid, aud, nonce replay, expired), Tiptap JSON validator and sanitiser, fractional ranks, i18n key parity, capability registry consistency.
- **Integration** (vitest against PostgreSQL with pgvector: `docker/compose.dev.yml` locally, a service container in CI; S3 is RustFS):
  - `globalSetup` migrates a template DB once; each test file runs `CREATE DATABASE … TEMPLATE` (about 50 ms), so parallel workers are fully isolated;
  - core operations run against real Prisma;
  - pg-boss is real, with a `drainJobs()` helper;
  - storage drivers are tested against RustFS (S3) and FS.
- **Component tests:** minimal; happy-dom + Testing Library for complex client widgets only (grader table, quiz navigation).
- **E2E** (Playwright):
  - runs against `next build && next start` plus the worker, with PostgreSQL, Mailpit, OpenLDAP and Keycloak as CI services and the `demo` seed profile;
  - auth state is stored per role;
  - Mailpit API asserts emails;
  - fixtures include a small MP4, Golf SCORM packages, `.mbz` files and the ltijs tool;
  - `@axe-core/playwright` runs on each visited page;
  - traces are kept on failure.

**GitHub Actions**
- **PR pipeline** (`.github/workflows/ci.yml`, each job with a time limit):
  - `check`: Biome, shellcheck, dependency-cruiser (`apps`, `packages`, `modules`), the licence allowlist, migrations applied to a fresh database and compared with the schema (with the hand-made indexes), typecheck, unit and integration tests, build;
  - `e2e`: Playwright in one job against the built app;
  - `docker` and `native`: the production images and the release archive installed with `install-hubium.sh`, then `e2e/stack` and an upgrade in place;
  - CodeQL and osv-scanner run in their own workflows.
- **Nightly** (`nightly.yml`): a dependency audit with osv-scanner, the live Claude API smoke test (when its secret is set), and the local embeddings test against Ollama.
- **Release** (`release.yml`, see `docs/releasing.md`): a `vX.Y.Z` tag equal to `package.json`'s version runs the whole CI, builds the images for amd64 and arm64 and the release archives, and publishes them, with a GitHub release, only once the checks and installations of these builds have passed. Dependencies are updated by hand.

---

## 11. Top technical risks and mitigations

| # | Risk | Mitigation |
|---|---|---|
| R1 | **v1 scope** (core plus every extra) | Phase gates each ship a usable 0.x release. Modules are runtime-toggleable. Phases 5–7 can reorder without touching core. Keep v2 items (calculated grades, workshop, H5P, multilang filter, collaborative editing) out. |
| R2 | **Next 16 / TS 7 / React 19.3 tooling churn** | TypeScript 7 since Next.js 16.4 type-checks through the `tsc` CLI; tools that still need the compiler's JS API get TypeScript 6 in their own workspace package. Biome avoids typescript-eslint. `cacheComponents` stays off. `proxy.ts` is used only for host split and optimistic redirect. Business logic lives in framework-free `core`, so framework upgrades touch only adapters. Don't put `server-only` in shared server entries, because it throws in the worker. |
| R3 | **Prisma 7 newness**: pgvector unsupported, Better Auth adapter vs the new generator | Spike on day 1. Vector and tsvector access goes only through a small raw-SQL module in `packages/db` with zod-parsed results. Fallback: Better Auth's built-in Kysely adapter on the same `pg` pool. Extensions and GIN/HNSW indexes live in migration SQL. |
| R4 | **Server actions vs REST duplication and security** | One `defineOperation` used by all three transports (§1.4). Authorisation always happens inside the operation, never through UI hiding. Every action is a public POST endpoint, so check this in code review. Cookie-authenticated route handlers check Origin. |
| R5 | **SCORM runtime quirks**: API discovery, unload commits, oversized `suspend_data`, authoring-tool idiosyncrasies, XSS from uploaded HTML | Separate content origin with a same-origin runtime-host iframe. Lenient mode that doesn't enforce the SCORM 1.2 4,096-character limit. Keepalive commits. CMI debug view. Corpus of Rustici Golf, iSpring, Storyline and Captivate packages in CI. |
| R6 | **.mbz variance** across Moodle versions, plugins and question types | Tolerant parser with per-entity try/catch and a detailed import report. Module-owned mappers. Versioned fixture corpus. Documented "best effort" with placeholders for unknown activities. Never copy Moodle code (GPL); implement from the format. |
| R7 | **LTI security** | RS256 only (pinned `alg`), `kid` lookup with cached and size-limited JWKS fetch behind the SSRF guard, exact `redirect_uri` match, single-use state and nonce with 10-minute TTL, deployment_id checks, clock skew of 60 s or less, scoped short-lived access tokens, key rotation. ltijs e2e plus saLTIre; aim for 1EdTech certification after v1. |
| R8 | **HLS transcoding resources** (CPU, disk ×3) | Dedicated `worker-media` container with CPU/memory limits and concurrency 1. Ladder capped at source resolution, `veryfast` preset, upload size and duration limits, per-site storage quota, optional deletion of the source. Hardware acceleration (VAAPI/NVENC) later. |
| R9 | **Realtime at scale**: NOTIFY 8 KB limit, proxy buffering, connection limits | Notify ids rather than payloads. Chunked fan-out jobs. Caddy `flush_interval -1`. One EventSource per browser via BroadcastChannel. Heartbeats. Refetch on reconnect. |
| R10 | **Permission correctness and performance** | Code-defined capabilities with typed names. In-memory role definitions with NOTIFY invalidation. `usersWithCap` in SQL, and `coursesWithCap` narrowed in SQL, rather than `can()` loops over the site. A large scenario test suite. The "check permissions" explainer. |
| R11 | **AI availability and compliance in Russia** | Anthropic's API isn't offered in some regions, including Russia, and 152-ФЗ restricts cross-border transfer of personal data. Make the provider an explicit admin choice at setup. Keep the OpenAI-compatible adapter first-class (YandexGPT, vLLM, Ollama). Pseudonymise grading input, require consent, and degrade gracefully with no provider configured. Model IDs live in settings for deprecations. Prompt injection: submissions and course text are treated as data, outputs are structured, and a human confirms. |
| R12 | **Infrastructure licensing and distribution** | MinIO's community distribution changed in 2025 and its images are no longer published, so compose ships RustFS (Apache-2.0) and the driver stays generic. Garage, SeaweedFS, RustFS or a cloud S3 (Yandex Object Storage, VK Cloud, Selectel) should work through configuration alone. Use only MIT Tiptap extensions. ffmpeg runs as a separate binary. A CI licence allowlist protects AGPL compatibility. |
| R13 | **Users without email** (schools) under Better Auth's required email | Placeholder email plus flag, username login, and notification routing that skips email for those users. |
| R14 | **Timezones and deadlines** | Store UTC (`timestamptz`), render in the user's timezone, show a "your time / course time" hint on due dates, and have tests cover DST transitions. |

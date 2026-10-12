# Writing an activity module

Every course activity in Hubium — page, assignment, quiz, forum, video, SCORM, LTI — is a module built on `@hubium/module-sdk`. A module owns its settings, tables, UI and actions; core provides permissions, files, grades, completion, notifications, jobs, AI and privacy plumbing through `ctx`.

Modules **never import `@hubium/core`** (dependency-cruiser enforces it). Everything they need arrives in `ModuleCtx`.

## Layout

```
modules/glossary/
  package.json          # name @hubium/mod-glossary, exports ./server, ./ui, ./messages/*
  messages/{ru,en}.json # strings under "mod.glossary.*"
  src/server.ts         # defineModule(...) — loaded by web and worker
  src/ui/*.tsx          # settings form and activity view (React server/client components)
packages/db/prisma/schema/modules/glossary.prisma   # tables, if any
```

Register the module in `apps/web/src/modules/{server.ts,ui.tsx,messages.ts}`, `apps/worker/src/modules.ts` and the core test helpers (`packages/core/test/helpers.ts`).

## Minimal module

```ts
import { defineAction, defineModule } from '@hubium/module-sdk';
import { z } from 'zod';

export const glossary = defineModule({
  key: 'glossary',
  archetype: 'activity',          // 'resource' | 'inline' for passive content
  icon: 'BookA',                  // lucide-react icon name
  supports: { viewCompletion: true, backup: true },
  settings: {
    schema: z.object({ allowStudentEntries: z.boolean().default(true) }),
    defaults: () => ({ allowStudentEntries: true }),
  },
  actions: {
    addEntry: defineAction({
      capability: 'mod.glossary:write',
      input: z.object({ term: z.string().min(1), definition: z.string() }),
      async handler(ctx, a, input) {
        return ctx.db.glossaryEntry.create({
          data: { activityId: a.id, userId: ctx.actor.userId, ...input },
        });
      },
    }),
  },
});
export const glossaryModules = [glossary];
```

Actions run in a transaction by default (`mutation: false` opts out, e.g. for slow AI calls). The UI calls them with `callModuleAction(activityId, 'addEntry', input)` from `@hubium/module-sdk/form`; the REST API exposes the same actions at `POST /api/v1/activities/{id}/actions/{name}`.

## Hooks

| Hook | Purpose |
|---|---|
| `settings.schema` | zod schema for `Activity.settings`; also drives validation of the settings form |
| `completion` | custom completion rules (`evaluate(ctx, a, userId, rules)`) |
| `grading.items(a)` | grade items in the gradebook; write grades with `ctx.grades.setGrades` |
| `calendar.events(a)` | open/due dates shown in calendars |
| `lifecycle` | `onCreate`, `onUpdate`, `onDelete`, `onUserUnenrolled` |
| `actions` | typed, capability-checked operations |
| `http(ctx, req, path)` | endpoints under `/api/mod/<key>/…` (streaming, callbacks) |
| `content(ctx, grant, req, path)` | untrusted content served from `CONTENT_HOST` with a signed token (SCORM) |
| `jobs`, `cron` | background work on the `default` or `media` queue |
| `notifications` | notification types `<key>.<name>`, labels `mod.<key>.notify.<name>` |
| `files` | file areas and who may read them |
| `backup` | user file areas to skip, `export`/`import` of module tables for `.hubium` archives |
| `ai` | `extract` text for the tutor and quiz generation; `tutorPolicy` (`include`, `exclude`, `exclude-while-open`) and `blocksTutor` |
| `privacy` | `export(ctx, userId)` for "Download my data", `erase(ctx, userId)` when an account is deleted |
| `todo` | items for the dashboard "To do" list |

## ModuleCtx

`db` (Prisma, transactional inside actions), `actor`, `perm` (`can`, `require`, `usersWithCap`), `files`, `grades`, `completion`, `notify`, `storage` (keys under `mod/<key>/`), `jobs`, `realtime.publish`, `activities.get`, `ai` (grading assistant), `content.url`, `log`.

## Capabilities

Declare module capabilities as `mod.<key>:<name>` with archetype defaults; administrators can override them per role and context like core ones. Check them with `capability` on actions or `ctx.perm.require` in handlers.

## Tests

Put integration tests next to core's (`packages/core/src/modules/<key>.test.ts`) using `useTestDb()` and `courseFixture()`, and add a Playwright scenario in `e2e/tests` for the main user flow, including `expectAccessible(page)`.

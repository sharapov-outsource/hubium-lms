<p align="center">
  <img src="apps/web/public/icons/icon-192.png" width="72" height="72" alt="">
</p>

<h1 align="center">Hubium LMS</h1>

<p align="center">
  An open-source learning management system, a modern alternative to Moodle.<br>
  <b>English</b> · <a href="README.ru.md">Русский</a>
</p>

Hubium LMS covers what schools, universities and companies run Moodle for. That includes courses, roles and permissions, assignments, quizzes, a gradebook, forums, SCORM and LTI, video and webinars, and importing courses from Moodle. On top of that it has an AI assistant, real-time messaging and a calm interface that works on a phone. One `docker compose up` starts the whole stack. The code is TypeScript, licensed under AGPL-3.0.

## Highlights

- **Moodle-grade permissions.** Contexts (site → category → course → activity), roles stored in the database, typed capabilities, view-as-role, and a page that explains why a person can or cannot do something.
- **Every activity is a module.** Page, assignment, quiz, forum, video, SCORM and LTI all implement one contract: settings, views, grading, completion, calendar, backup, Moodle import, privacy and AI text. A third-party module is a package plus one line of configuration.
- **One operation, three transports.** Business logic lives in `packages/core` operations with built-in authorization. The UI, the REST API and the background worker call the same code.
- **AI with privacy in mind.**
  - Works with Claude or any OpenAI-compatible server, such as Ollama, vLLM or YandexGPT.
  - Off until an administrator picks a provider.
  - Asks people for consent, enforces quotas, and pseudonymises student work before grading.
- **Standards and migration.** SCORM 1.2/2004, LTI 1.3 Advantage, `.mbz` import from Moodle 4.1–5.x, and GIFT and Moodle XML questions.
- **Ready to run.** A Docker stack with HTTPS (Caddy), S3 storage, separate workers for jobs and video, JSON logs, health checks and Prometheus metrics. CI tests the production images end to end on every commit.

## Features

### Courses and learning

- Category tree, course formats (topics, weeks, single page), cover images, a catalog with search and a course landing page.
- Sections and activities you can reorder by drag and drop or with the keyboard ("Move to…"). Items can be shown, hidden or stealth, and deleted ones go to a recycle bin with restore.
- Access restrictions by date, completion, grade, group and profile field, for activities and sections.
- Manual or automatic completion with a teacher override, a completion matrix and course progress.
- Enrolment:
  - manual, self-enrolment with a course key, group keys, enrolment window and duration;
  - cohort sync and guest access;
  - expiry handled by a scheduled job.
- Groups, site-wide cohorts, and a participants page with filters and bulk actions.
- A dashboard with "continue", a to-do list and upcoming deadlines, plus a course stream like Google Classroom.
- Course reports: participation and an event log.

### Activities

| Module | What it does |
|---|---|
| Page, link, file, label | Rich-text pages with tables and images; links shown inline, in a new tab or embedded; multi-file resources; YouTube, RuTube and VK Video embeds |
| Assignment | Online text and files, word limit, open, due and cut-off dates, per-student extensions, reopened attempts, feedback with files, download all submissions as a zip |
| Quiz | A question bank with 7 types, random questions from a category, shuffling, a time limit enforced on the server (closes even if the browser is gone), autosave, grading methods, review options, manual essay grading, question statistics |
| Forum | General and Q&A types, subscriptions (optional, auto, forced), group modes, pinned and locked threads, private replies, unread tracking, completion by posts |
| Video | Resumable upload, HLS transcoding to 360/720/1080p (never above the source), poster and scrubbing previews, VTT/SRT captions, optional no-skip-ahead, completion at N% watched |
| Live session | BigBlueButton (with recordings) and Jitsi, schedule in the calendar, moderator or attendee role from permissions, attendance |
| SCORM | SCORM 1.2 and 2004 served from a separate origin, attempts, grading method, report and a CMI debug view |
| LTI | LTI 1.3 platform: OIDC launch, Deep Linking, Assignment and Grade Services into the gradebook, Names and Roles; RS256 keys with rotation and JWKS |

### Assessment

- Gradebook with six aggregation methods:
  - natural, mean, weighted mean, highest, lowest, median;
  - weights, drop lowest, aggregate only graded items;
  - display as points, percentage or letter.
- Grader report with inline overrides, a user report, and CSV import and export.
- Question bank:
  - multiple choice, true/false, short answer, numerical, matching, essay and description;
  - tags and drafts;
  - import and export in GIFT and Moodle XML.

### Communication

- **Notifications:** in the app, by email (immediately or as a digest at the person's local hour) and as Web Push. Each type can be configured, and email has a one-click unsubscribe.
- **Messages:**
  - direct, group and course-group conversations in real time (SSE);
  - typing indicator and attachments;
  - blocking and privacy settings.
- **Announcements:** site and course announcements, pinned or scheduled.
- **Calendar:** site, course, group and personal events, month and agenda views, reminders, and an iCal feed.

### AI assistant

- **Course tutor:**
  - answers from course materials with numbered citations, using hybrid search (full text + pgvector);
  - never sees hidden material or quiz questions;
  - is unavailable during a quiz attempt.
- **Question generation** from pages and uploaded documents (PDF, DOCX, PPTX, ODT, ODP). The results land in the bank as drafts for the teacher to review.
- **Grading assistant:**
  - reads the submission, including attached PDF, DOCX, PPTX, ODT and text files;
  - proposes a grade and feedback, which the teacher reviews before saving.
- **Controls:** per-feature and per-course switches, quotas per user and per course, a usage summary, and a consent notice for people.

### Course migration

- `.hubium` backup and restore, and course duplication.
- Import of Moodle `.mbz` backups (4.1–5.x):
  - pages, labels, links, files and folders, assignments, quizzes with their question bank, forums, SCORM and BigBlueButton;
  - other activities become labels, so nothing is silently dropped;
  - every import ends with a report.

### Administration

- Users: create and edit, suspend, upload from CSV, export personal data, delete with anonymisation.
- Roles editor with a capability matrix, and a permission checker.
- Categories and courses (with a recycle bin), cohorts, LTI tools, webhooks, the AI provider, site policies that people must accept, and site announcements.
- Settings: general, branding (accent colour with automatic contrast correction, plus a logo), registration, sign-in methods, and email with a test send.
- An environment page that checks the database, worker, job queue, storage, SMTP, content origin, Web Push, AI and ffmpeg.

### Integrations

- REST API v1 with an OpenAPI 3.1 description and interactive docs at `/api/v1/docs`, plus personal access tokens with read or write scope.
- Webhooks for users, courses, enrolments, grades, completions, submissions and quiz attempts, signed with HMAC-SHA256 and retried with backoff.
- `/api/health` and Prometheus metrics at `/api/metrics`.

### Platform

- Sign-in by email or username (for learners without email), email verification, two-factor authentication (TOTP), sign-in with Google, Yandex ID and VK ID, and active session management.
- An installable PWA with an offline page and push notifications.
- Russian and English, light and dark themes, and a mobile layout with bottom navigation.
- Accessibility: every end-to-end scenario is checked with axe for serious and critical violations.
- Security:
  - a CSP with a nonce on every request, and Origin checks;
  - SSRF protection for outgoing requests;
  - upload limits, and untrusted content isolated on its own domain.
  - Details are in [docs/security.md](docs/security.md).

## Installation

### Requirements

- A Linux server with Docker Engine and the Compose plugin. Video transcoding runs in its own container, limited to 2 CPU cores and 2 GB of memory (`docker/compose.yml`).
- Three domain names pointing at the server:
  - the application, for example `lms.example.org`;
  - untrusted content, for example `content.example.org`;
  - file downloads, for example `files.example.org`.

### Docker Compose

```bash
git clone https://github.com/sharapov-outsource/hubium.git && cd hubium
cp .env.production.example .env
# set APP_URL, CONTENT_HOST, S3_PUBLIC_URL, APP_SECRET, S3_SECRET_KEY,
# POSTGRES_PASSWORD, SMTP_URL, MAIL_FROM and SEED_ADMIN_* in .env
BUILD_COMMIT=$(git rev-parse HEAD) docker compose -f docker/compose.yml --env-file .env up -d --build
```

This starts PostgreSQL with pgvector, RustFS (S3), migrations, `web`, `worker`, `worker-media` and Caddy, which gets HTTPS certificates for all three domains. Without your own addresses the stack runs on `https://lms.localhost`, which is handy for a trial on one machine. Add `SEED_PROFILE=demo` to load sample courses and users.

### After installation

1. Sign in as the administrator from `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` and change the password.
2. Open **Administration → Environment**: every check should be green.
3. Set the site name, branding, registration and mail settings, and connect an AI provider if you want one.

Backups, updates, secret rotation, monitoring and scaling are covered in [docs/operations.md](docs/operations.md) (in Russian).

## Development

Requires Node.js 22.12+ (24 LTS recommended), pnpm 12 (`npm install -g pnpm@12`), Docker and ffmpeg for video.

```bash
cp .env.example .env                              # set APP_SECRET: openssl rand -base64 32
docker compose -f docker/compose.dev.yml up -d    # PostgreSQL, RustFS (S3), Mailpit
pnpm install
pnpm db:migrate
pnpm db:seed --profile demo
pnpm dev                                          # http://localhost:3000
```

- Administrator: `admin@hubium.local` / `Admin12345!`.
- Demo users `teacher`, `assistant`, `student1`…`student3` and `manager`, password `Demo12345!`.
- Outgoing mail: http://localhost:8025 (Mailpit).

| Command | What it does |
|---|---|
| `pnpm dev` | web app and worker in watch mode |
| `pnpm lint` / `pnpm format` | Biome |
| `pnpm typecheck` | TypeScript in every package |
| `pnpm test` | unit and integration tests on PostgreSQL (S3 tests run with `S3_TEST_ENDPOINT`) |
| `pnpm --filter @hubium/e2e e2e` | Playwright scenarios against a running app, with axe checks |
| `pnpm --filter @hubium/e2e stack` | checks against the production Docker stack (see [CONTRIBUTING.md](CONTRIBUTING.md)) |
| `pnpm depcruise` | architecture boundaries |
| `pnpm licenses:check` | dependency licences compatible with AGPL-3.0 |

## Project structure

| Path | Contents |
|---|---|
| `apps/web` | Next.js 16: interface, server actions, REST API, SSE, file routes |
| `apps/worker` | pg-boss jobs: email, notifications, video transcoding, imports, AI indexing, schedules |
| `packages/core` | business logic, permissions and operations; no Next.js or React |
| `packages/db` | Prisma schema, migrations and client |
| `packages/module-sdk` | the contract activity modules implement |
| `packages/ui`, `packages/editor` | design system and the Tiptap editor |
| `packages/ai`, `packages/questions`, `packages/interchange` | LLM providers and text extraction, question types and formats, backup and Moodle import |
| `packages/api`, `packages/i18n`, `packages/log` | REST API, translations, structured logs |
| `modules/*` | activity modules: content, assign, quiz, forum, video, livesession, scorm, lti |
| `docker/` | Dockerfile, production and development Compose files, Caddyfile |

The stack is Node.js 24, Next.js 16, React 19, PostgreSQL 18 with pgvector, Prisma 7, Better Auth, pg-boss (no Redis), Tailwind CSS 4 and Biome.

## Documentation

- [docs/operations.md](docs/operations.md): installation, configuration, backups, updates, monitoring (in Russian).
- [docs/api.md](docs/api.md): REST API, tokens and webhooks.
- [docs/modules.md](docs/modules.md): writing an activity module.
- [docs/security.md](docs/security.md): built-in protections and an operator checklist.
- [docs/architecture.md](docs/architecture.md): technical design. [docs/PLAN.md](docs/PLAN.md): roadmap and status (in Russian).
- [CONTRIBUTING.md](CONTRIBUTING.md): how to contribute. [SECURITY.md](SECURITY.md): how to report a vulnerability.

## License

[AGPL-3.0](LICENSE). If you run a modified Hubium LMS as a service, make the source of your changes available to its users.

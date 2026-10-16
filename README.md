<p align="center">
  <img src="apps/web/public/icons/icon-192.png" width="72" height="72" alt="">
</p>

<h1 align="center">Hubium LMS</h1>

<p align="center">
  An open-source learning management system, a modern alternative to Moodle.<br>
  <b>English</b> · <a href="README.ru.md">Русский</a>
</p>

Hubium LMS covers what schools, universities and companies run Moodle for. That includes courses, roles and permissions, assignments, quizzes, a gradebook, forums, SCORM, H5P and LTI, video and webinars, and importing courses from Moodle. On top of that it has an AI assistant, real-time messaging and a calm interface that works on a phone. One `docker compose up` starts the whole stack. The code is TypeScript, licensed under AGPL-3.0.

## Highlights

- **Moodle-grade permissions.** Contexts (site → category → course → activity), roles stored in the database, typed capabilities, view-as-role, and a page that explains why a person can or cannot do something.
- **Every activity is a module.** Page, assignment, quiz, forum, video, SCORM, H5P and LTI all implement one contract: settings, views, grading, completion, calendar, backup, Moodle import, privacy and AI text. A third-party module is a package plus one line of configuration.
- **One operation, three transports.** Business logic lives in `packages/core` operations with built-in authorization. The UI, the REST API and the background worker call the same code.
- **AI with privacy in mind.**
  - Works with Claude or any OpenAI-compatible server, such as Ollama, vLLM or YandexGPT.
  - Off until an administrator picks a provider.
  - Asks people for consent, enforces quotas, and pseudonymises student work before grading.
- **Standards and migration.** SCORM 1.2/2004, H5P, LTI 1.3 Advantage, `.mbz` import from Moodle 4.1–5.x, and GIFT and Moodle XML questions.
- **Ready to run.** One script installs a release in Docker or natively with systemd, with HTTPS (Caddy), separate workers for jobs and video, JSON logs, health checks and Prometheus metrics. CI installs both kinds of release the way users do and tests them end to end on every commit.

## Features

### Courses and learning

- Category tree, course formats (topics, weeks, single page), cover images, a catalog with full-text search (word forms, prefixes, typos) and a course landing page.
- Sections and activities you can reorder by drag and drop or with the keyboard ("Move to…"). Subsections inside a section, among its activities, fold away. Items can be shown, hidden or stealth, and deleted ones go to a recycle bin with restore.
- Access restrictions by date, completion, grade, group, grouping and profile field (custom fields included), for activities and sections.
- Manual or automatic completion with a teacher override, a completion matrix and course progress.
- Enrolment:
  - manual, self-enrolment with a course key, group keys, enrolment window and duration;
  - cohort sync and guest access;
  - expiry handled by a scheduled job.
- Groups and groupings (an activity can be limited to one), site-wide cohorts, and a participants page with filters and bulk actions.
- A dashboard with "continue", a to-do list and upcoming deadlines, plus a course stream like Google Classroom.
- Course reports: participation and an event log.
- A report builder: reports on users, courses, participants, completion, grades, badges, certificates, competencies and learning plans, with columns from predefined fields (custom profile and course fields included), aggregation, conditions, filters for viewers and sorting, shared with chosen roles, cohorts or people, downloaded as CSV or XLSX and emailed on a schedule.
- Badges (Open Badges 2.0) of the site and of courses: earned by completing the course, activities or other courses, by a course grade, by cohort membership or awarded by hand by chosen roles; each award can be verified at public addresses, downloaded with the assertion baked into its image, and revoked with a reason.
- Course certificates as PDF: a background with fields placed by coordinates (name, course, completion date, grade, verification code and address, free text), issued on course completion or by hand, downloaded by the learner, checked by anyone at `/verify` by the code printed on them, revoked with a reason, and listed in an issue report with CSV export.
- Competencies and learning plans as in Moodle: frameworks (a tree with level terms, scales, parent rules and cross-references, imported and exported as Moodle's CSV), competencies of courses and activities completed with them or rated by teachers, a course breakdown, plan templates for people and cohorts, learners' own plans reviewed and approved, review requests, evidence of prior learning and comments.
- Mentors and parents (optional): an administrator links them to learners, and they follow the learners' courses, progress, grades and deadlines without acting for them.

### Activities

| Module | What it does |
|---|---|
| Page, link, file, label | Rich-text pages with tables, images and math formulas (KaTeX); links shown inline, in a new tab or embedded; multi-file resources; YouTube, RuTube and VK Video embeds |
| Book | Chapters and subchapters with a table of contents, numbering, hidden chapters, previous and next, and the whole book on one page for printing |
| Choice | One or several options with limited places, changing the answer, dates, results after answering, after closing or always, with or without names, separate groups, answers to CSV |
| Feedback | Surveys of info texts, short and long answers, choices, numbers and page breaks, required questions, anonymous or with names, dates, a summary with charts (for students too if wished), responses to CSV and XLSX |
| Glossary | Entries by teachers and students with other forms of the concept and categories, approval of students' entries, search and browsing by letter, entry ratings into the gradebook, completion by entries; the course's texts link the concepts to their entries |
| Lesson | Content pages with buttons and question pages (multiple choice, true/false, short answer, numerical, matching, essay) joined by jumps that depend on the answers, branches and clusters, tries per question, custom points, retakes (best or mean), a time limit, a password, dates, a menu and a progress bar, essay grading and a report of attempts; the grade goes to the gradebook |
| Wiki | Collaborative or individual, a wiki per group in group mode, links between pages written as [[Title]] (a missing page is written from its link), all pages and orphaned ones, the history of versions with comparison and restoring, a page locked while someone edits it, completion by edits |
| Database | Fields the teacher defines (text, rich text, number, date, menu, radio buttons, checkboxes, URL, file, picture), templates with [[Field]] for the list and an entry's page, search and sorting, approval, entry limits, entries required before seeing others', group mode, ratings into the gradebook, export to CSV and XLSX, import from CSV |
| Workshop | Peer assessment in phases switched by the teacher or by date: an assessment form (accumulative, comments, number of errors, rubric), work handed in, reviewers allocated by hand or at random (apart from groupmates, with self-assessment), grades for the work from weighted assessments and grades for assessing by comparison with the best assessment, teacher overrides, published work; both grades go to the gradebook |
| Assignment | Online text and files, word limit, open, due and cut-off dates, dates for students and groups, team submissions, a statement of authorship, a late penalty per day with a cap, reopened attempts, grading in points or on a scale, rubrics and marking guides, a marking workflow with allocated markers, blind marking, feedback with files, download all submissions as a zip |
| Quiz | A question bank with 14 types (ordering, select missing words, drag and drop into text, embedded answers (Cloze) and calculated questions with datasets among them), random questions from a category, shuffling, a time limit enforced on the server (closes even if the browser is gone), autosave, deferred, immediate or interactive feedback (hints between tries, a penalty for each wrong one), a password, network addresses and waits between attempts, pages in order, grading methods, review options, dates, time and attempts per student or group, manual essay grading, regrading with a dry run, question statistics |
| Forum | General and Q&A types, subscriptions (optional, auto, forced), group modes, pinned and locked threads, private replies, unread tracking, completion by posts, post ratings (by teachers, and by students when allowed) and a grade for the whole forum, each in the gradebook |
| Video | Resumable upload, HLS transcoding to 360/720/1080p (never above the source), poster and scrubbing previews, VTT/SRT captions, optional no-skip-ahead, completion at N% watched |
| Live session | BigBlueButton (with recordings) and Jitsi, schedule in the calendar, moderator or attendee role from permissions, attendance |
| SCORM | SCORM 1.2 and 2004 served from a separate origin, attempts, grading method, report and a CMI debug view |
| H5P | `.h5p` packages with their libraries, played from a separate origin by h5p-standalone (content is made in H5P or Moodle: there is no editor); each result the content reports over xAPI is an attempt, grading method into the gradebook, completion by finishing, passing or a score, the player's bar and rights of use on or off, a report of attempts |
| LTI | LTI 1.3 platform: OIDC launch, Deep Linking, Assignment and Grade Services into the gradebook, Names and Roles; RS256 keys with rotation and JWKS |

### Assessment

- Gradebook with a category tree and six aggregation methods:
  - natural, mean, weighted mean, highest, lowest, median;
  - weights of items and categories, drop lowest, keep highest, aggregate only graded items;
  - display as points, percentage or letter, with letter boundaries for the site and per course.
- Scales of the site and of a course, for manual items and assignments.
- Calculated items: a formula over other items and categories, referred to by ID number (`=([[hw1]] + [[hw2]]) / 2`), recomputed with every grade.
- Grader report with inline overrides and category totals, a user report, a grade history with filters, import from CSV, XLSX or ODS (columns mapped to items, with a preview), and CSV, XLSX and ODS export.
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
- **Calendar:** site, course, group and personal events with a location, day, week, month and agenda views, reminders, an iCal feed, and .ics files imported or calendars subscribed by address (refreshed hourly, daily or weekly, repeating events expanded).

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

- `.hubium` backup and restore, course duplication, importing chosen activities from another course, and a course reset for a new intake that moves every date.
- Import of Moodle `.mbz` backups (4.1–5.x):
  - pages, labels, links, files and folders, books, assignments, quizzes with their question bank, forums, choices, feedback, lessons with their pages, SCORM, H5P and BigBlueButton;
  - the settings of glossaries, wikis, databases (with fields and templates) and workshops (with the assessment form);
  - assignment teams, marking workflow, blind marking, rubrics and marking guides, and the dates of groups; forum ratings and whole-forum grades;
  - groups and groupings (without members), scales, and the gradebook: categories, manual items, ID numbers, formulas and letters;
  - other activities become labels, so nothing is silently dropped;
  - every import ends with a report.

### Administration

- Users: create and edit, custom profile fields, suspend, log in as another user (and return), upload from CSV (users, course groups and cohorts, with a preview), bulk actions on the selected (suspend, delete, require a password change, add to a cohort, enrol, message, export to CSV, XLSX and ODS), export personal data, delete with anonymisation.
- Roles editor with a capability matrix, permission overrides per category, course and activity, and a permission checker.
- Categories and courses (with a recycle bin and custom course fields that show in the catalog and filter it), cohorts, LTI tools, webhooks, the AI provider, site policies that people must accept, and site announcements.
- Activity modules turned on or off for the whole site; a module that is off keeps its activities and grades until it is turned on again.
- Settings: general, branding (accent colour with automatic contrast correction, plus a logo), registration, sign-in methods, email with a test send, and maintenance mode, in which only administrators use the site and everyone else gets a message (also `hubium maintenance on|off`).
- An environment page that checks the database, worker, job queue, storage, SMTP, content origin, Web Push, AI and ffmpeg.
- A tasks page: scheduled tasks with their last run and a run-now button, and a 30-day log of every run with retry for failed ones.

### Integrations

- REST API v1 with an OpenAPI 3.1 description and an interactive reference at `/api/v1/docs` (served by the site, works offline): users, courses and catalog search, enrolments, groups, gradebook, every module action with file uploads, calendar, messages, webhooks. Personal access tokens with read or write scope.
- Webhooks for users, courses, enrolments, grades, completions, submissions and quiz attempts, signed with HMAC-SHA256 and retried with backoff.
- `/api/health` and Prometheus metrics at `/api/metrics`.

### Platform

- Sign-in by email or username (for learners without email), email verification, two-factor authentication (TOTP) with backup codes and recovery phrases for a lost phone, a password policy (length, character classes, no reuse, expiry), lockout after failed sign-ins with an unlock link by email, notices of sign-ins from a new device with an "it wasn't me" link, sign-in with Google, Yandex ID, VK ID, Keycloak and custom OAuth 2 providers, single sign-on over OpenID Connect and SAML 2.0 (Keycloak, Microsoft Entra ID, ADFS, Okta and others) with profile field mapping, LDAP sign-in (OpenLDAP, Active Directory, FreeIPA) with a nightly sync, and active session management.
- An installable PWA with an offline page and push notifications.
- Russian, English, French, German and Italian; a language is a set of JSON files ([docs/i18n.md](docs/i18n.md)) that administrators install from the admin area as a pack (a new language or a newer version of a bundled one, without a rebuild), enable, and make the site language. Light and dark themes, and a mobile layout with bottom navigation.
- Accessibility: every end-to-end scenario is checked with axe for serious and critical violations.
- Security:
  - a CSP with a nonce on every request, and Origin checks;
  - SSRF protection for outgoing requests;
  - upload limits, and untrusted content isolated on its own domain.
  - Details are in [docs/security.md](docs/security.md).

## Installation

Every release is published three ways:

- Docker images `ghcr.io/sharapov-outsource/hubium-lms` and `hubium-lms-media` for amd64 and arm64;
- an archive, `hubium-<version>-linux-x64.tar.gz` or `-linux-arm64.tar.gz`, holding the whole system with Node.js inside;
- `install-hubium.sh`, which installs either of them.

### Requirements

- A Linux server, x86_64 or arm64, with 2 CPU cores, 4 GB of memory and 10 GB of disk or more. Video transcoding takes up to 2 more cores and 2 GB while it runs.
- **Docker installation:** any distribution with Docker Engine 24+ and Compose 2.20+. The installer can install Docker on Debian and Ubuntu.
- **Native installation:** Debian 12/13 or Ubuntu 22.04/24.04/26.04 with systemd. Other distributions work with `--skip-packages` if you install the dependencies yourself:
  - PostgreSQL 16+ with pgvector;
  - Caddy or another reverse proxy;
  - ffmpeg for video.
- **Domain names** pointing at the server:
  - the site, for example `lms.example.org`;
  - untrusted SCORM and H5P content, for example `content.example.org`;
  - file downloads, for example `files.example.org`. Needed only when Docker runs its own S3 storage.
- Ports 80 and 443 free, when Caddy should get HTTPS certificates.

### Quick start

```bash
curl -fsSLO https://github.com/sharapov-outsource/hubium-lms/releases/latest/download/install-hubium.sh
sudo bash install-hubium.sh
```

The script checks the server and then asks:

1. Docker or native installation.
2. The site address and the content host.
3. HTTPS: Caddy with automatic certificates, or your own proxy.
4. Which activity modules to install. Assignments, quizzes, forums, video, live sessions, SCORM, H5P and LTI can each be left out; the other activities are always there.
5. The database: installed on the server, or an existing PostgreSQL. An existing one is checked first, and the script prints the SQL a DBA needs to run if rights or extensions are missing.
6. Where files are kept: on the server, or in S3.
7. Mail (SMTP).
8. The first administrator, and whether to add demo courses.

After a summary and a confirmation, it does the rest:

- generates the secrets;
- downloads the release and verifies its checksum;
- installs PostgreSQL, Caddy and ffmpeg where needed;
- creates the database;
- starts the services and waits until they answer.

At the end it prints the address and the administrator's password.

A module left out is turned off, not missing. It can be turned on later in **Administration → Modules** or with `hubium modules enable <name>`.

### Unattended installation

Every question has an option (`bash install-hubium.sh --help`), and `--yes` takes defaults for the rest:

```bash
sudo bash install-hubium.sh --yes --mode native --domain lms.example.org \
  --modules assign,quiz,forum --smtp-url smtp://user:pass@smtp.example.org:587 \
  --mail-from "LMS <no-reply@example.org>" --admin-email admin@example.org
```

`--dry-run` shows the steps without changing anything.

### What gets installed

| | Docker | Native |
|---|---|---|
| Programs | images, `/opt/hubium/compose.yml` | `/opt/hubium/releases/<version>`, `/opt/hubium/current`, `/usr/local/bin/hubium` |
| Settings | `/opt/hubium/.env` | `/etc/hubium/hubium.env` |
| Data | Docker volumes `db`, `data` (and `s3`) | PostgreSQL, `/var/lib/hubium` |
| Services | `docker compose --project-directory /opt/hubium ps` | `systemctl status hubium-web hubium-worker` |
| Logs | `docker compose --project-directory /opt/hubium logs -f` | `journalctl -u 'hubium-*' -f` |

The `hubium` command checks and maintains an installation. In Docker, run it as `docker compose --project-directory /opt/hubium exec web hubium …`.

| Command | What it does |
|---|---|
| `hubium doctor` | checks the configuration, the database, the worker, storage, mail, ffmpeg and the virus scanner |
| `hubium modules list\|enable\|disable` | shows activity modules, or turns them on or off |
| `hubium migrate --seed minimal` | applies migrations; Docker runs it on every start |
| `hubium secrets rotate` | re-encrypts stored secrets after `APP_SECRET` changes |
| `hubium ai reindex [--course <id>] [--sync]` | rebuilds what the AI tutor searches, e.g. after changing the embedding model |
| `hubium version` | prints the version and the commit |

### Upgrading

```bash
sudo bash install-hubium.sh upgrade                    # to the script's release
sudo bash install-hubium.sh upgrade --version 1.2.0
```

The upgrade does the following:

1. Stops the application and backs up the database to `/var/backups/hubium`, keeping the three latest copies.
2. Fetches the new release.
3. Applies its migrations.
4. Restarts the services.

A native installation keeps the previous releases next to the new one.

### Without the script

- **Docker:** take `compose.yml`, `Caddyfile` and `env.production.example` from a release. Save the last one as `.env` next to `compose.yml` and fill it in. Optional services are compose profiles: `db`, `s3`, `caddy`, `media`, `mailpit`, `clamav` (virus scanning of uploads) and `ai-local` (Ollama with bge-m3 for the AI tutor's search). Then run:

  ```bash
  docker compose pull && docker compose up -d --wait
  ```

- **Archive:** unpack it and follow its `README.txt`. In short:
  1. Fill in `/etc/hubium/hubium.env` from `deploy/hubium.env.example`.
  2. Run `hubium doctor db`, then `hubium migrate --seed minimal`.
  3. Install the systemd units from `deploy/systemd`.
  4. Put a reverse proxy in front.
- **From source:** in a checkout, copy `.env.production.example` to `.env.production`, fill it in, and run `docker compose -f docker/compose.yml --env-file .env.production up -d --build`. It builds the images instead of pulling them. Do not pass the root `.env`: it is the development file, with `localhost` addresses.

### After installation

1. Sign in as the administrator and change the password.
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
- Demo users `teacher`, `assistant`, `student1`…`student3`, `manager` and `parent` (student1's parent), password `Demo12345!`.
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
| `apps/cli` | the `hubium` command: migrations, checks, modules, maintenance |
| `packages/core` | business logic, permissions and operations; no Next.js or React |
| `packages/db` | Prisma schema, migrations and client |
| `packages/module-sdk` | the contract activity modules implement |
| `packages/ui`, `packages/editor` | design system and the Tiptap editor |
| `packages/ai`, `packages/questions`, `packages/interchange` | LLM providers and text extraction, question types and formats, backup and Moodle import |
| `packages/api`, `packages/i18n`, `packages/log` | REST API, translations, structured logs |
| `modules/*` | activity modules: content, book, choice, feedback, glossary, lesson, wiki, data, workshop, assign, quiz, forum, video, livesession, scorm, h5p, lti |
| `docker/`, `deploy/` | Dockerfile, Compose files and Caddyfile; the launcher and systemd units of the archive |
| `install-hubium.sh` | the installer published with every release |

The stack is Node.js 24, Next.js 16, React 19, PostgreSQL 18 with pgvector, Prisma 7, Better Auth, pg-boss (no Redis), Tailwind CSS 4 and Biome.

## Documentation

- [docs/guide/](docs/guide/README.md): user guide for learners, teachers, managers and administrators (in Russian).
- [docs/operations.md](docs/operations.md): installation, configuration, backups, updates, monitoring (in Russian).
- [docs/releasing.md](docs/releasing.md): how releases are built and published.
- [docs/i18n.md](docs/i18n.md): languages, language packs, fallback and how to add a language.
- [docs/api.md](docs/api.md): REST API, tokens and webhooks.
- [docs/modules.md](docs/modules.md): writing an activity module.
- [docs/security.md](docs/security.md): built-in protections and an operator checklist.
- [docs/architecture.md](docs/architecture.md): technical design.
- [docs/moodle-comparison.md](docs/moodle-comparison.md): feature comparison with Moodle 5.3 LTS (in Russian).
- [CONTRIBUTING.md](CONTRIBUTING.md): how to contribute. [SECURITY.md](SECURITY.md): how to report a vulnerability.

## License

[AGPL-3.0](LICENSE). If you run a modified Hubium LMS as a service, make the source of your changes available to its users.

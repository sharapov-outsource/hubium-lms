# Hubium LMS

**Hubium LMS** — открытая система дистанционного обучения, современная альтернатива Moodle: спокойный интерфейс, тёмная тема, русский и английский языки, удобная работа с телефона.

[English version below](#english)

## Возможности

- **Пользователи и доступ:** вход по почте или логину, подтверждение почты, восстановление пароля, двухфакторная аутентификация (TOTP), вход через Google, Яндекс ID и VK ID, активные сеансы, вход от имени пользователя.
- **Права как в Moodle:** роли с архетипами, матрица прав, переопределения на уровне категории, курса и элемента, проверка «почему можно / нельзя», режим «смотреть как студент».
- **Курсы:** категории, разделы, условия доступа, отслеживание завершения, группы и потоки, самостоятельная запись по ключу, корзина, каталог.
- **Элементы курса:** страница, ссылка, файл, метка, задание, тест с банком вопросов (GIFT, Moodle XML), форум, видео с адаптивным HLS и защитой от перемотки, вебинар (BigBlueButton, Jitsi), SCORM 1.2/2004, внешние инструменты LTI 1.3 (AGS, NRPS, Deep Linking).
- **Оценивание:** журнал оценок с категориями и формулами агрегирования, отчёт преподавателя, импорт и экспорт CSV, буквенные шкалы.
- **Коммуникации:** уведомления в приложении, по почте (сразу или дайджестом) и push на телефон, личные и групповые сообщения в реальном времени, объявления, календарь с напоминаниями и подпиской iCal.
- **AI:** тьютор курса со ссылками на источники, генерация вопросов по материалам курса, помощник проверки заданий; Claude API или любой OpenAI-совместимый сервер (Ollama, vLLM, YandexGPT), квоты, согласие пользователей, псевдонимизация.
- **Перенос курсов:** резервная копия `.hubium`, копирование курса, импорт курсов из Moodle (`.mbz`).
- **Интеграции:** REST API v1 с документацией OpenAPI 3.1 и персональными токенами.
- **Приложение и безопасность:** PWA с офлайн-страницей и push-уведомлениями, CSP с nonce, защита от CSRF и SSRF, экспорт своих данных, обезличивание при удалении, версионные политики с принятием.
- **Удобство:** спокойный интерфейс, тёмная тема, русский и английский, мобильная навигация, доступность (axe без серьёзных нарушений во всех e2e-сценариях).

## Быстрый старт (разработка)

Нужны Node.js 22.12+ (рекомендуется 24 LTS), pnpm 12 (`npm install -g pnpm@12`) и Docker.

```bash
cp .env.example .env                      # и задайте APP_SECRET: openssl rand -base64 32
docker compose -f docker/compose.dev.yml up -d   # PostgreSQL, Mailpit, RustFS (S3)
pnpm install
pnpm db:migrate
pnpm db:seed --profile demo
pnpm dev                                  # http://localhost:3000
```

- Администратор: `admin@hubium.local` / `Admin12345!` (меняется через `SEED_ADMIN_*`).
- Демо-пользователи: `teacher`, `assistant`, `student1..3`, `manager`, пароль `Demo12345!`.
- Письма: http://localhost:8025 (Mailpit).

## Продакшн

```bash
cp .env.production.example .env   # адреса, APP_SECRET, S3_SECRET_KEY, пароли
docker compose -f docker/compose.yml --env-file .env up -d --build
```

Поднимаются PostgreSQL (pgvector), S3-хранилище RustFS, миграции, web, worker, worker-media и Caddy с HTTPS. Подробности — в [docs/operations.md](docs/operations.md).

## Разработка

| Команда | Что делает |
|---|---|
| `pnpm dev` | web и worker в режиме разработки |
| `pnpm lint` / `pnpm format` | Biome |
| `pnpm typecheck` | TypeScript во всех пакетах |
| `pnpm test` | unit и интеграционные тесты (нужен PostgreSQL; тесты S3 — с `S3_TEST_ENDPOINT`) |
| `pnpm --filter @hubium/e2e e2e` | Playwright e2e против запущенного приложения (браузер: `pnpm --filter @hubium/e2e exec playwright install chromium`) |
| `pnpm depcruise` | проверка архитектурных границ |

Документация:

- [docs/operations.md](docs/operations.md) — установка, настройка, резервное копирование, обновление, мониторинг;
- [docs/api.md](docs/api.md) — REST API;
- [docs/modules.md](docs/modules.md) — как написать свой модуль;
- [docs/security.md](docs/security.md) — встроенная защита и чек-лист администратора;
- [docs/architecture.md](docs/architecture.md) — устройство проекта, [docs/PLAN.md](docs/PLAN.md) — план;
- правила участия — [CONTRIBUTING.md](CONTRIBUTING.md), сообщения об уязвимостях — [SECURITY.md](SECURITY.md).

## Лицензия

[AGPL-3.0](LICENSE). Если вы запускаете изменённый Hubium как сервис, исходный код изменений должен быть доступен пользователям.

---

## English

**Hubium LMS** is an open-source learning management system — a modern alternative to Moodle with a calm interface, dark mode, Russian and English UI, and a mobile-friendly layout.

### Quick start

Requires Node.js 22.12+ (24 LTS recommended), pnpm 12 (`npm install -g pnpm@12`) and Docker.

```bash
cp .env.example .env            # set APP_SECRET (openssl rand -base64 32)
docker compose -f docker/compose.dev.yml up -d
pnpm install && pnpm db:migrate && pnpm db:seed --profile demo
pnpm dev                        # http://localhost:3000
```

Sign in as `admin@hubium.local` / `Admin12345!`. Demo users (`teacher`, `student1`, …) use `Demo12345!`.

Production: `cp .env.production.example .env`, fill it in, then `docker compose -f docker/compose.yml --env-file .env up -d --build` (PostgreSQL, RustFS S3 storage, web, workers, Caddy with HTTPS).

### Features

Courses with sections, access restrictions and completion; pages, files, assignments, quizzes with a question bank (GIFT, Moodle XML), forums, adaptive HLS video, live sessions (BigBlueButton, Jitsi), SCORM 1.2/2004 and LTI 1.3 tools; a gradebook; notifications by in-app, email digest and Web Push; real-time messaging; an AI course tutor, question generation and grading assistant (Claude API or any OpenAI-compatible server); course backup/restore and Moodle `.mbz` import; a REST API with OpenAPI docs; an installable PWA; Moodle-style roles and capabilities.

Docs: [operations](docs/operations.md) · [REST API](docs/api.md) · [modules](docs/modules.md) · [security](docs/security.md) · [architecture](docs/architecture.md) · [roadmap](docs/PLAN.md). Licensed under [AGPL-3.0](LICENSE).

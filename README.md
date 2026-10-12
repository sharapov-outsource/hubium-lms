# Hubium

**Hubium** — открытая система дистанционного обучения (LMS), современная альтернатива Moodle: спокойный интерфейс, тёмная тема, русский и английский языки, удобная работа с телефона.

[English version below](#english)

## Возможности

Проект развивается по этапам (см. [docs/PLAN.md](docs/PLAN.md)):

- **Пользователи и доступ:** вход по почте или логину, регистрация с подтверждением почты, восстановление пароля, двухфакторная аутентификация (TOTP), вход через Google, Яндекс ID и VK ID, активные сеансы.
- **Права как в Moodle:** роли с архетипами, матрица прав, переопределения на уровне категории, курса и элемента, проверка прав «почему можно / нельзя».
- **Администрирование:** пользователи (создание, блокировка, обезличивание, загрузка из CSV), роли, настройки сайта, фирменный цвет с автоматической проверкой контраста, логотип.
- **Курсы, задания, тесты, журнал оценок, форумы, сообщения, видео, SCORM, LTI, импорт из Moodle, AI-помощник** — по мере выхода этапов.

## Быстрый старт (разработка)

Нужны Node.js 22.12+ (рекомендуется 24), pnpm 10 и Docker.

```bash
cp .env.example .env                      # и задайте APP_SECRET: openssl rand -base64 32
docker compose -f docker/compose.dev.yml up -d   # PostgreSQL, MinIO, Mailpit
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
cp .env.example .env   # APP_SECRET, APP_URL, пароли
docker compose -f docker/compose.yml --env-file .env up -d --build
```

Поднимаются PostgreSQL (pgvector), MinIO, миграции, web, worker, worker-media и Caddy с HTTPS.

## Разработка

| Команда | Что делает |
|---|---|
| `pnpm dev` | web и worker в режиме разработки |
| `pnpm lint` / `pnpm format` | Biome |
| `pnpm typecheck` | TypeScript во всех пакетах |
| `pnpm test` | unit и интеграционные тесты (нужен PostgreSQL) |
| `pnpm --filter @hubium/e2e e2e` | Playwright e2e против запущенного приложения |
| `pnpm depcruise` | проверка архитектурных границ |

Устройство проекта описано в [docs/architecture.md](docs/architecture.md), правила участия — в [CONTRIBUTING.md](CONTRIBUTING.md).

## Лицензия

[AGPL-3.0](LICENSE). Если вы запускаете изменённый Hubium как сервис, исходный код изменений должен быть доступен пользователям.

---

## English

**Hubium** is an open-source learning management system — a modern alternative to Moodle with a calm interface, dark mode, Russian and English UI, and a mobile-friendly layout.

### Quick start

```bash
cp .env.example .env            # set APP_SECRET (openssl rand -base64 32)
docker compose -f docker/compose.dev.yml up -d
pnpm install && pnpm db:migrate && pnpm db:seed --profile demo
pnpm dev                        # http://localhost:3000
```

Sign in as `admin@hubium.local` / `Admin12345!`. Demo users (`teacher`, `student1`, …) use `Demo12345!`.

See [docs/architecture.md](docs/architecture.md) for the technical design and [docs/PLAN.md](docs/PLAN.md) for the roadmap. Licensed under [AGPL-3.0](LICENSE).

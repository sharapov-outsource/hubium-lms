# Эксплуатация Hubium LMS

Руководство администратора сервера: установка, настройка, резервное копирование, обновление и мониторинг.

## Состав

| Сервис | Назначение |
|---|---|
| `web` | Next.js: интерфейс, server actions, REST API `/api/v1`, SSE |
| `worker` | фоновые задачи (`WORKER_QUEUES=default`): почта, уведомления, расписание, AI, импорт курсов |
| `worker-media` | перекодирование видео ffmpeg (`WORKER_QUEUES=media`), можно вынести на отдельную машину |
| `db` | PostgreSQL 18 с расширениями `pgvector`, `pg_trgm`, `citext`, `unaccent` (образ `pgvector/pgvector:0.8.7-pg18-bookworm`) |
| `s3` | S3-совместимое хранилище файлов [RustFS](https://github.com/rustfs/rustfs) (подойдёт любое S3: Yandex Object Storage, VK Cloud, Selectel) |
| `mailpit` | перехватывает почту, пока не задан `SMTP_URL`; интерфейс только на `127.0.0.1:8025` сервера |
| `caddy` | HTTPS-прокси для основного домена, домена контента и домена файлов |

Очереди работают на pg-boss в той же базе — Redis не нужен.

## Установка

```bash
git clone https://github.com/sharapov-outsource/hubium && cd hubium
cp .env.production.example .env
# обязательно: APP_URL, CONTENT_HOST, S3_PUBLIC_URL, APP_SECRET и S3_SECRET_KEY (openssl rand -base64 32),
# POSTGRES_PASSWORD, SMTP_URL, MAIL_FROM
BUILD_COMMIT=$(git rev-parse HEAD) docker compose -f docker/compose.yml --env-file .env up -d --build
```

`BUILD_COMMIT` необязателен: с ним в левом нижнем углу и на странице «Окружение» рядом с версией виден коммит сборки.

`.env.example` предназначен для разработки и для этого стека не подходит. Без своих адресов стек поднимается на `https://lms.localhost`, `https://content.localhost` и `https://files.localhost` — это удобно для пробного запуска на одной машине.

Сервис `migrate` при каждом запуске применяет миграции, создаёт бакет в S3, если его ещё нет, и идемпотентно наполняет базу (`SEED_PROFILE=minimal`; `demo` добавит учебные курсы и пользователей). Первый администратор создаётся из `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` — смените пароль после входа.

### Домены

- `APP_URL` — основной адрес, например `https://lms.example.org`.
- `CONTENT_HOST` — **отдельный домен** для недоверенного контента (SCORM), например `https://content.example.org`. Cookie LMS туда не попадают. Без отдельного домена страница «Окружение» показывает ошибку.
- `S3_PUBLIC_URL` — домен, по которому браузеры скачивают файлы по подписанным ссылкам, например `https://files.example.org`. Бакет закрыт: без подписи ничего не отдаётся.

Caddy использует эти же три адреса как имена сайтов и сам получает для них сертификаты. Все три домена должны указывать на сервер.

### Переменные окружения

| Переменная | Назначение |
|---|---|
| `DATABASE_URL` | строка подключения PostgreSQL |
| `APP_URL`, `CONTENT_HOST` | публичные адреса (см. выше) |
| `APP_SECRET` | ключ для подписей и шифрования секретов в БД, 32+ символа |
| `STORAGE_DRIVER` | `fs` (по умолчанию) или `s3`; для S3 — `S3_ENDPOINT`, `S3_PUBLIC_URL`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_REGION`. В `docker/compose.yml` — всегда `s3`, ключи обязательны |
| `SMTP_URL`, `MAIL_FROM` | отправка почты |
| `WORKER_QUEUES` | какие очереди обрабатывает воркер: `default`, `media` или оба через запятую |
| `FFMPEG_PATH`, `FFPROBE_PATH` | пути к ffmpeg для видео |
| `BBB_URL`, `BBB_SECRET` / `JITSI_*` | вебинары |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Web Push (`npx web-push generate-vapid-keys`) |
| `SSRF_ALLOW_HOSTS` | внутренние хосты, к которым серверу разрешено обращаться (локальный Ollama, внутренний LTI-инструмент) |
| `API_RATE_LIMIT_PER_MIN` | лимит REST API на токен в минуту (120) |
| `METRICS_TOKEN` | включает `/api/metrics` для Prometheus |

## Настройка после установки

1. **Администрирование → Настройки**: название, язык и часовой пояс по умолчанию, регистрация, вход через Google/Яндекс/VK.
2. **Оформление**: фирменный цвет (контраст проверяется автоматически) и логотип.
3. **Политики**: опубликуйте политику конфиденциальности и правила сайта. Обязательные документы пользователи принимают при следующем входе.
4. **AI** (по желанию): провайдер (Claude API или OpenAI-совместимый сервер), функции, лимиты и текст уведомления о конфиденциальности. Для локальной модели в той же сети добавьте её хост в `SSRF_ALLOW_HOSTS`. Для поиска по курсам подключите эмбеддинги (рекомендуется `bge-m3`, 1024 измерения) и нажмите «Переиндексировать курсы».
5. **LTI**: зарегистрируйте внешние инструменты; адреса платформы (issuer, JWKS, token) показаны там же.

## Резервное копирование

Состояние системы — это база данных и хранилище файлов. Копируйте оба одновременно. Том `data` хранит только незавершённые загрузки, его копировать не нужно.

```bash
# база (сжатый custom-формат)
docker compose -f docker/compose.yml exec -T db pg_dump -U hubium -Fc hubium > hubium-$(date +%F).dump
# файлы: встроенное S3 (RustFS) — том s3 целиком; для внешнего S3 подойдёт любой клиент, например rclone sync
docker run --rm -v hubium_s3:/data -v "$PWD/backup":/backup debian:trixie-slim tar czf /backup/s3-$(date +%F).tgz -C /data .
# файлы: драйвер fs
rsync -a --delete ./.storage/ ./backup/files/
```

Отдельные курсы можно сохранить из интерфейса: **Курс → Настройки → Скачать резервную копию** (`.hubium`).

### Восстановление

```bash
docker compose -f docker/compose.yml stop web worker worker-media
docker compose -f docker/compose.yml exec -T db pg_restore -U hubium -d hubium --clean --if-exists < hubium-2026-10-12.dump
docker compose -f docker/compose.yml stop s3
docker run --rm -v hubium_s3:/data -v "$PWD/backup":/backup debian:trixie-slim sh -c 'rm -rf /data/* && tar xzf /backup/s3-2026-10-12.tgz -C /data'
# драйвер fs: rsync обратно в .storage
docker compose -f docker/compose.yml up -d
```

Проверьте страницу **Администрирование → Окружение**: все проверки должны быть в норме. `APP_SECRET` должен совпадать с тем, что был при создании копии, иначе сохранённые ключи AI-провайдеров не расшифруются.

## Обновление

```bash
git pull
BUILD_COMMIT=$(git rev-parse HEAD) docker compose -f docker/compose.yml --env-file .env up -d --build
```

Сервис `migrate` применяет новые миграции до запуска `web` и `worker`. Перед обновлением сделайте резервную копию. Миграции только добавляют изменения; откат выполняется восстановлением копии.

## Ротация секретов

```bash
OLD_APP_SECRET=<текущий> APP_SECRET=<новый> pnpm --filter @hubium/core secrets:rotate
```

Команда перешифровывает ключи AI-провайдеров и эмбеддингов, а также секреты двухфакторной аутентификации (TOTP). Затем замените `APP_SECRET` в `.env`, перезапустите сервисы и выполните **LTI → Сменить ключ**. Ранее выданные подписанные ссылки (отписка от писем, контент SCORM) перестанут действовать.

## Мониторинг

- `GET /api/health` — живость web и доступность базы (для балансировщика).
- `GET /api/metrics` с `Authorization: Bearer $METRICS_TOKEN` — метрики Prometheus: пользователи, курсы, очередь писем, задачи по очередям, использование AI, возраст heartbeat воркера.
- **Администрирование → Окружение** — живые проверки: база и pgvector, heartbeat воркера, очередь задач и ошибки за сутки, запись в хранилище, SMTP, отдельный домен контента, Web Push, AI, ffmpeg.
- Воркер обновляет heartbeat раз в минуту; тревога, если `hubium_worker_heartbeat_age_seconds > 180`.

## Логи

Все сервисы пишут в stdout по одной JSON-записи на строку: `docker compose -f docker/compose.yml logs -f web worker`. Такие строки без настройки разбирают Loki, Elastic, Graylog и Vector.

```json
{"level":"warn","time":"2026-10-13T12:04:05.123Z","service":"worker","component":"webhooks","webhookId":"…","event":"enrolment.created","host":"hr.example.org","status":503,"attempt":9,"msg":"webhook delivery failed for good"}
```

- `service` — `web`, `worker`, `worker-media` или `migrate`; `component` — часть системы (`jobs`, `api`, `webhooks`, `notifications`, `next`…). Ошибки идут с полем `err` (тип, сообщение, стек).
- Воркер пишет каждую неудачную задачу (`job`, `jobId`, `ms`, `err`). Ожидаемые повторы, например недоступный получатель вебхука, пишутся как `warn`, остальное как `error`. Успешные задачи видны на уровне `debug`.
- REST API пишет каждый запрос: метод, путь, статус, время и пользователя токена. Серверные ошибки страниц приходят от `next` с маршрутом и `digest`: по нему ошибку находят из сообщения, которое увидел пользователь.
- Caddy пишет журнал доступа в JSON. Токены в URL (ссылки на контент, отписка, календарь, `?token=` из писем) заменены на `[redacted]`, заголовок Referer не пишется, cookies и `Authorization` скрыты.
- Пароли, секреты, токены и ключи API в записи не попадают: эти поля вырезаются.
- `LOG_LEVEL` в `.env`: `debug`, `info` (по умолчанию), `warn`, `error`. При разработке (`NODE_ENV` не `production`) строки выводятся в читаемом виде; `LOG_FORMAT=json` или `pretty` выбирает формат явно.

## Масштабирование

- `web` можно запускать в нескольких экземплярах: сеансы в базе, realtime через `LISTEN/NOTIFY`, кэши сбрасываются через канал `hubium_cache`. Лимит REST API считается в каждом экземпляре. Незавершённые загрузки лежат в томе `data` (`/data`): экземплярам на разных машинах нужен общий каталог (NFS) или привязка клиента к экземпляру на балансировщике.
- Воркеров тоже может быть несколько; pg-boss распределяет задачи (`SKIP LOCKED`).
- Видео перекодируется только `worker-media`; ему нужны ffmpeg и доступ к хранилищу.

## Нагрузочное тестирование

Сценарии k6 лежат в [`tools/k6`](../tools/k6): 1000 одновременных попыток теста и дашборд с 500 запросами в секунду. Цели и запуск описаны в README каталога.

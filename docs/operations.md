# Эксплуатация Hubium

Руководство администратора сервера: установка, настройка, резервное копирование, обновление и мониторинг.

## Состав

| Сервис | Назначение |
|---|---|
| `web` | Next.js: интерфейс, server actions, REST API `/api/v1`, SSE |
| `worker` | фоновые задачи (`WORKER_QUEUES=default`): почта, уведомления, расписание, AI, импорт курсов |
| `worker-media` | перекодирование видео ffmpeg (`WORKER_QUEUES=media`), можно вынести на отдельную машину |
| `db` | PostgreSQL 16+ с расширениями `pgvector`, `pg_trgm`, `citext` (образ `pgvector/pgvector:pg18`) |
| `minio` | S3-совместимое хранилище файлов (подойдёт любое S3: Yandex Object Storage, VK Cloud, Selectel) |
| `caddy` | HTTPS-прокси для основного домена и домена контента |

Очереди работают на pg-boss в той же базе — Redis не нужен.

## Установка

```bash
git clone https://github.com/sharapov-outsource/hubium && cd hubium
cp .env.example .env
# обязательно: APP_URL, CONTENT_HOST, APP_SECRET (openssl rand -base64 32), SMTP_URL, MAIL_FROM
docker compose -f docker/compose.yml --env-file .env up -d --build
```

Сервис `migrate` при каждом запуске применяет миграции и идемпотентно наполняет базу (`SEED_PROFILE=minimal`; `demo` добавит учебные курсы и пользователей). Первый администратор создаётся из `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` — смените пароль после входа.

### Домены

- `APP_URL` — основной адрес, например `https://lms.example.org`.
- `CONTENT_HOST` — **отдельный домен** для недоверенного контента (SCORM), например `https://content.example.org`. Cookie LMS туда не попадают. Без отдельного домена страница «Окружение» показывает ошибку.

### Переменные окружения

| Переменная | Назначение |
|---|---|
| `DATABASE_URL` | строка подключения PostgreSQL |
| `APP_URL`, `CONTENT_HOST` | публичные адреса (см. выше) |
| `APP_SECRET` | ключ для подписей и шифрования секретов в БД, 32+ символа |
| `STORAGE_DRIVER` | `fs` (по умолчанию) или `s3`; для S3 — `S3_ENDPOINT`, `S3_PUBLIC_URL`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_REGION` |
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

Состояние системы — это база данных и хранилище файлов. Копируйте оба одновременно.

```bash
# база (сжатый custom-формат)
docker compose -f docker/compose.yml exec -T db pg_dump -U hubium -Fc hubium > hubium-$(date +%F).dump
# файлы: S3/MinIO
mc mirror --overwrite hubium/hubium ./backup/files
# файлы: драйвер fs
rsync -a --delete ./.storage/ ./backup/files/
```

Отдельные курсы можно сохранить из интерфейса: **Курс → Настройки → Скачать резервную копию** (`.hubium`).

### Восстановление

```bash
docker compose -f docker/compose.yml stop web worker worker-media
docker compose -f docker/compose.yml exec -T db pg_restore -U hubium -d hubium --clean --if-exists < hubium-2026-10-12.dump
mc mirror --overwrite ./backup/files hubium/hubium      # или rsync обратно в .storage
docker compose -f docker/compose.yml up -d
```

Проверьте страницу **Администрирование → Окружение**: все проверки должны быть в норме. `APP_SECRET` должен совпадать с тем, что был при создании копии, иначе сохранённые ключи AI-провайдеров не расшифруются.

## Обновление

```bash
git pull
docker compose -f docker/compose.yml --env-file .env up -d --build
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

## Масштабирование

- `web` можно запускать в нескольких экземплярах: сеансы в базе, realtime через `LISTEN/NOTIFY`, кэши сбрасываются через канал `hubium_cache`. Лимит REST API считается в каждом экземпляре.
- Воркеров тоже может быть несколько; pg-boss распределяет задачи (`SKIP LOCKED`).
- Видео перекодируется только `worker-media`; ему нужны ffmpeg и доступ к хранилищу.

## Нагрузочное тестирование

Сценарии k6 лежат в [`tools/k6`](../tools/k6): 1000 одновременных попыток теста и дашборд с 500 запросами в секунду. Цели и запуск описаны в README каталога.

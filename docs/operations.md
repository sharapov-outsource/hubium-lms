# Эксплуатация Hubium LMS

Руководство администратора сервера: установка, настройка, резервное копирование, обновление и мониторинг.

## Состав

| Сервис | Назначение |
|---|---|
| `web` | Next.js: интерфейс, server actions, REST API `/api/v1`, SSE |
| `worker` | фоновые задачи (`WORKER_QUEUES=default`): почта, уведомления, расписание, AI, импорт курсов |
| `worker-media` | перекодирование видео ffmpeg (`WORKER_QUEUES=media`), можно вынести на отдельную машину |
| `migrate` | в Docker перед каждым запуском: миграции, бакет S3, идемпотентное наполнение (`hubium migrate`) |
| PostgreSQL | 16 или новее с расширениями `vector` (pgvector 0.5+), `pg_trgm`, `citext`, `unaccent`; в Docker — образ `pgvector/pgvector:0.8.7-pg18-bookworm` |
| файлы | на диске сервера (`STORAGE_DRIVER=fs`) или в S3: встроенный [RustFS](https://github.com/rustfs/rustfs) в Docker, или любое S3 — Yandex Object Storage, VK Cloud, Selectel |
| Caddy | HTTPS для основного домена, домена контента и (с S3 в Docker) домена файлов |
| Mailpit | в Docker перехватывает почту, пока не задан `SMTP_URL`; интерфейс только на `127.0.0.1:8025` сервера |

Очереди работают на pg-boss в той же базе — Redis не нужен.

## Установка

Релиз выходит в трёх видах:

- образы `ghcr.io/sharapov-outsource/hubium-lms` (web, worker и команда `hubium`) и `hubium-lms-media` (с ffmpeg) для amd64 и arm64;
- архив `hubium-<версия>-linux-<x64|arm64>.tar.gz` — вся система вместе с Node.js;
- `install-hubium.sh`, который ставит любой из них.

Как выпускается релиз, описано в [releasing.md](releasing.md).

### install-hubium.sh

```bash
curl -fsSLO https://github.com/sharapov-outsource/hubium-lms/releases/latest/download/install-hubium.sh
sudo bash install-hubium.sh            # вопросы; --help — все параметры, --yes — без вопросов
```

**Проверки.** Скрипт проверяет:

- права root, процессор (x86_64 или aarch64) и дистрибутив;
- свободное место (от 3 ГБ) и память (от 2 ГБ);
- свободны ли порты 80/443 и порт web-сервера;
- указывают ли домены на сервер — только предупреждение.

**Вопросы:**

1. Способ установки.
2. Адреса.
3. HTTPS.
4. Модули элементов курса.
5. Сервер вебинаров.
6. База данных.
7. Хранилище файлов.
8. Почта.
9. Первый администратор.
10. Демо-данные.

Существующую базу перед установкой проверяет `hubium doctor db`. Если чего-то не хватает, команда печатает SQL для администратора БД:

- версия PostgreSQL ниже 16;
- кодировка не UTF8;
- на сервере нет нужных расширений;
- у роли нет прав их создать или создавать таблицы в схеме `public`;
- в базе уже есть чужие таблицы.

**Установка в Docker** (любой Linux с Docker 24+ и Compose 2.20+; на Debian/Ubuntu скрипт может поставить Docker сам):

- в `/opt/hubium` появляются `compose.yml`, `Caddyfile` из релиза и `.env` с секретами и профилями;
- скрипт скачивает образы, выключает невыбранные модули и запускает стек командой `docker compose up -d --wait`.

**Установка в систему** (Debian 12/13, Ubuntu 22.04/24.04/26.04):

- пакеты:
  - PostgreSQL 18 с pgvector из репозитория PGDG; если уже запущен PostgreSQL 16+, используется он;
  - Caddy из официального репозитория;
  - ffmpeg, если выбрано видео;
- пользователь `hubium`;
- база `hubium` с расширениями;
- архив распаковывается в `/opt/hubium/releases/<версия>`, на него ссылается `/opt/hubium/current`;
- команда `/usr/local/bin/hubium`;
- настройки `/etc/hubium/hubium.env` (права 0640, группа `hubium`);
- данные `/var/lib/hubium`;
- юниты `hubium-web`, `hubium-worker` и `hubium-worker-media`.

  Юниты работают от пользователя `hubium` с ограничениями: `ProtectSystem=strict`, запись только в `/var/lib/hubium`, `NoNewPrivileges`. Медиа-воркер ограничен `MemoryMax=2G` и `CPUQuota=200%`.

Ответы сохраняются в `/etc/hubium/install.conf`: их читает обновление. Журнал установки — `/var/log/hubium-install.log`. Пароль первого администратора удаляется из файла настроек, как только администратор создан.

### Docker вручную

Из релиза нужны `compose.yml`, `Caddyfile` и `env.production.example`. Последний положите рядом с `compose.yml` как `.env` и заполните.

```bash
docker compose pull
docker compose up -d --wait
```

Необязательные сервисы — профили, их перечисляет `COMPOSE_PROFILES` в `.env`:

| Профиль | Что добавляет |
|---|---|
| `db` | PostgreSQL; без него задайте `DATABASE_URL` своего сервера |
| `s3` | RustFS для `STORAGE_DRIVER=s3`; с внешним S3 задайте `S3_ENDPOINT` и ключи |
| `caddy` | HTTPS на портах 80/443; без него проксируйте `127.0.0.1:3000` (`HUBIUM_WEB_BIND`) сами |
| `media` | `worker-media` для модуля «Видео» |
| `mailpit` | перехват почты до настройки SMTP |

`HUBIUM_VERSION` выбирает релиз (тег образа). Из клона репозитория тот же файл собирает образы: `BUILD_COMMIT=$(git rev-parse HEAD) docker compose -f docker/compose.yml --env-file .env up -d --build`. `BUILD_COMMIT` необязателен: с ним в левом нижнем углу и на странице «Окружение» рядом с версией виден коммит сборки.

Переменные окружения оболочки важнее `.env`: не экспортируйте в ней `DATABASE_URL` и подобные переменные, иначе они попадут в контейнеры.

Сервис `migrate` при каждом запуске применяет миграции, создаёт бакет в S3, если его ещё нет, и идемпотентно наполняет базу: `SEED_PROFILE=minimal`, а `demo` добавит учебные курсы и пользователей. Первый администратор создаётся из `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`; без пароля в production он не создаётся.

### Архив вручную

См. `README.txt` в архиве. Коротко:

1. PostgreSQL 16+ с pgvector и пустая база.
2. Архив распаковывается в `/opt/hubium/releases/<версия>`, на него указывает ссылка `/opt/hubium/current`.
3. `/etc/hubium/hubium.env` заполняется по `deploy/hubium.env.example`.
4. `hubium doctor db`, затем `hubium migrate --seed minimal`.
5. Юниты из `deploy/systemd` копируются в `/etc/systemd/system`.
6. Перед `127.0.0.1:3000` ставится обратный прокси с HTTPS. Для Caddy подходит `deploy/Caddyfile`: его S3-часть не нужна, а `HUBIUM_WEB=127.0.0.1:3000`.

Лаунчер `bin/hubium` берёт Node.js из `node/` архива и читает настройки из `HUBIUM_ENV_FILE` (по умолчанию `/etc/hubium/hubium.env`). Переменные окружения важнее файла.

### Команда hubium

| Команда | Что делает |
|---|---|
| `hubium web`, `hubium worker` | запускает web-сервер или воркер |
| `hubium migrate --seed minimal\|demo\|none [--disable-modules a,b]` | применяет миграции, готовит хранилище, наполняет базу |
| `hubium doctor [db] [--json]` | проверяет настройки, базу (и пустую), воркер, очереди, хранилище, SMTP, домен контента, ffmpeg; код выхода 0 — порядок, 1 — ошибки, 2 — предупреждения |
| `hubium modules list\|enable\|disable <ключи>` | модули элементов курса, как в **Администрирование → Модули** |
| `hubium secrets rotate` | перешифровывает секреты после смены `APP_SECRET` |
| `hubium version` | версия, коммит и время сборки |

В Docker: `docker compose --project-directory /opt/hubium exec web hubium doctor`. В системе: `sudo -u hubium hubium doctor` (файл настроек читают root и группа `hubium`).

Миграции релиз применяет сам. Учёт ведётся в той же таблице `_prisma_migrations`, с теми же контрольными суммами и блокировкой, что у `prisma migrate deploy`. Поэтому команды Prisma продолжают работать с базой, а в релиз не входят ни CLI Prisma, ни его нативный движок.

### Домены

- `APP_URL` — основной адрес, например `https://lms.example.org`.
- `CONTENT_HOST` — **отдельный домен** для недоверенного контента (SCORM), например `https://content.example.org`. Cookie LMS туда не попадают. Без отдельного домена страница «Окружение» показывает ошибку.
- `S3_PUBLIC_URL` — домен, по которому браузеры скачивают файлы по подписанным ссылкам, например `https://files.example.org`. Нужен только с S3. Бакет закрыт: без подписи ничего не отдаётся. С хранилищем `fs` файлы отдаёт приложение.

Caddy использует эти адреса как имена сайтов и сам получает для них сертификаты, поэтому все они должны указывать на сервер.

### Переменные окружения

| Переменная | Назначение |
|---|---|
| `DATABASE_URL` | строка подключения PostgreSQL |
| `APP_URL`, `CONTENT_HOST` | публичные адреса (см. выше) |
| `APP_SECRET` | ключ для подписей и шифрования секретов в БД, 32+ символа |
| `STORAGE_DRIVER` | `fs` (по умолчанию; каталог `STORAGE_FS_ROOT`, в Docker — том `data`) или `s3`: `S3_ENDPOINT`, `S3_PUBLIC_URL`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_REGION` |
| `SMTP_URL`, `MAIL_FROM` | отправка почты |
| `HOSTNAME`, `PORT` | где слушает web-сервер в системной установке (`127.0.0.1:3000`) |
| `WORKER_QUEUES` | какие очереди обрабатывает воркер: `default`, `media` или оба через запятую |
| `FFMPEG_PATH`, `FFPROBE_PATH` | пути к ffmpeg для видео |
| `BBB_URL`, `BBB_SECRET` / `JITSI_*` | вебинары |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Web Push (`npx web-push generate-vapid-keys`) |
| `SSRF_ALLOW_HOSTS` | внутренние хосты, к которым серверу разрешено обращаться (локальный Ollama, внутренний LTI-инструмент) |
| `API_RATE_LIMIT_PER_MIN` | лимит REST API на токен в минуту (120) |
| `METRICS_TOKEN` | включает `/api/metrics` для Prometheus |
| `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`, `SEED_PROFILE` | первый администратор и демо-данные |
| `HUBIUM_VERSION`, `HUBIUM_IMAGE`, `COMPOSE_PROFILES`, `HUBIUM_WEB_BIND` | только Docker: релиз, образ, профили, адрес web-сервера без Caddy |

## Настройка после установки

1. **Администрирование → Настройки**: название, часовой пояс по умолчанию, регистрация, вход через Google/Яндекс/VK. **Администрирование → Языки**: язык сайта, доступные пользователям языки и определение языка гостя по браузеру. **Администрирование → Модули**: какие типы элементов курса доступны. Выключенный тип сохраняет свои элементы и оценки, студенты их не видят.
2. **Оформление**: фирменный цвет (контраст проверяется автоматически) и логотип.
3. **Политики**: опубликуйте политику конфиденциальности и правила сайта. Обязательные документы пользователи принимают при следующем входе.
4. **AI** (по желанию): провайдер (Claude API или OpenAI-совместимый сервер), функции, лимиты и текст уведомления о конфиденциальности. Для локальной модели в той же сети добавьте её хост в `SSRF_ALLOW_HOSTS`. Для поиска по курсам подключите эмбеддинги (рекомендуется `bge-m3`, 1024 измерения) и нажмите «Переиндексировать курсы».
5. **LTI**: зарегистрируйте внешние инструменты; адреса платформы (issuer, JWKS, token) показаны там же.

## Резервное копирование

Состояние системы — это база данных и файлы. Копируйте их одновременно и храните `APP_SECRET`: без него сохранённые ключи не расшифровать.

**Docker** (каталог `/opt/hubium`):

```bash
cd /opt/hubium
# база (сжатый custom-формат)
docker compose exec -T db pg_dump -U hubium -Fc hubium > hubium-$(date +%F).dump
# файлы, STORAGE_DRIVER=fs: том data
docker run --rm -v hubium_data:/data -v "$PWD/backup":/backup debian:trixie-slim tar czf /backup/files-$(date +%F).tgz -C /data .
# файлы во встроенном S3 (RustFS): том s3; для внешнего S3 подойдёт любой клиент, например rclone sync
docker run --rm -v hubium_s3:/data -v "$PWD/backup":/backup debian:trixie-slim tar czf /backup/s3-$(date +%F).tgz -C /data .
```

**Установка в систему:**

```bash
sudo -u postgres pg_dump -p 5432 -Fc hubium > hubium-$(date +%F).dump   # порт — в /etc/hubium/install.conf (PGPORT)
sudo tar czf files-$(date +%F).tgz -C /var/lib/hubium files
```

`install-hubium.sh upgrade` перед обновлением сам кладёт дамп базы в `/var/backups/hubium`.

Отдельные курсы можно сохранить из интерфейса: **Курс → Настройки → Скачать резервную копию** (`.hubium`).

### Восстановление

Docker:

```bash
cd /opt/hubium
docker compose stop web worker worker-media
docker compose exec -T db pg_restore -U hubium -d hubium --clean --if-exists < hubium-2026-10-12.dump
docker run --rm -v hubium_data:/data -v "$PWD/backup":/backup debian:trixie-slim sh -c 'rm -rf /data/* && tar xzf /backup/files-2026-10-12.tgz -C /data'
docker compose up -d --wait
```

В системе:

```bash
sudo systemctl stop hubium-web hubium-worker hubium-worker-media
sudo -u postgres pg_restore -p 5432 -d hubium --clean --if-exists < hubium-2026-10-12.dump
sudo tar xzf files-2026-10-12.tgz -C /var/lib/hubium
sudo systemctl start hubium-web hubium-worker hubium-worker-media
```

Проверьте страницу **Администрирование → Окружение** или `hubium doctor`: все проверки должны быть в норме. `APP_SECRET` должен совпадать с тем, что был при создании копии.

## Обновление

```bash
sudo bash install-hubium.sh upgrade                 # до релиза этого скрипта (свежий — из последнего релиза)
sudo bash install-hubium.sh upgrade --version 1.2.0
```

Обновление:

1. Делает копию базы (`--backup no` отключает).
2. Скачивает релиз и сверяет контрольные суммы.
3. Обновляет сам релиз:
   - в Docker — `compose.yml`, `Caddyfile` и `HUBIUM_VERSION`; затем `docker compose pull` и `up -d --wait`, миграции применяет сервис `migrate`;
   - в системе — распаковывает релиз рядом с прежними, останавливает сервисы, применяет миграции и переключает `/opt/hubium/current`. Затем запускает сервисы и ждёт ответа. Две предыдущие версии остаются в `/opt/hubium/releases`.

Если миграция не прошла, прежняя версия запускается снова, а скрипт подсказывает, какую копию восстановить. Миграции только добавляют изменения; откат выполняется восстановлением копии и переключением `current` на прежний релиз.

Вручную в Docker: поменяйте `HUBIUM_VERSION` в `.env`, затем `docker compose pull && docker compose up -d --wait`. Из исходников: `git pull` и `up -d --build`.

## Ротация секретов

```bash
# Docker: OLD_APP_SECRET и новый APP_SECRET передаются в контейнер
docker compose exec -e OLD_APP_SECRET='<текущий>' -e APP_SECRET='<новый>' web hubium secrets rotate
# В системе
sudo -u hubium env OLD_APP_SECRET='<текущий>' APP_SECRET='<новый>' hubium secrets rotate
```

Команда перешифровывает ключи AI-провайдеров и эмбеддингов, а также секреты двухфакторной аутентификации (TOTP). Затем замените `APP_SECRET` в `.env` или `/etc/hubium/hubium.env`, перезапустите сервисы и выполните **LTI → Сменить ключ**. Ранее выданные подписанные ссылки (отписка от писем, контент SCORM) перестанут действовать.

## Мониторинг

- `GET /api/health` — живость web и доступность базы (для балансировщика).
- `GET /api/metrics` с `Authorization: Bearer $METRICS_TOKEN` — метрики Prometheus: пользователи, курсы, очередь писем, задачи по очередям, использование AI, возраст heartbeat воркера.
- **Администрирование → Окружение** — живые проверки: база и pgvector, heartbeat воркера, очередь задач и ошибки за сутки, запись в хранилище, SMTP, отдельный домен контента, Web Push, AI, ffmpeg.
- Воркер обновляет heartbeat раз в минуту; тревога, если `hubium_worker_heartbeat_age_seconds > 180`.

## Логи

Все сервисы пишут в stdout по одной JSON-записи на строку: в Docker — `docker compose logs -f web worker`, в системе — `journalctl -u 'hubium-*' -f`. Такие строки без настройки разбирают Loki, Elastic, Graylog и Vector.

```json
{"level":"warn","time":"2026-10-13T12:04:05.123Z","service":"worker","component":"webhooks","webhookId":"…","event":"enrolment.created","host":"hr.example.org","status":503,"attempt":9,"msg":"webhook delivery failed for good"}
```

- `service` — `web`, `worker`, `worker-media` или `migrate`; `component` — часть системы (`jobs`, `api`, `webhooks`, `notifications`, `next`…). Ошибки идут с полем `err` (тип, сообщение, стек).
- Воркер пишет каждую неудачную задачу (`job`, `jobId`, `ms`, `err`). Ожидаемые повторы, например недоступный получатель вебхука, пишутся как `warn`, остальное как `error`. Успешные задачи видны на уровне `debug`.
- REST API пишет каждый запрос: метод, путь, статус, время и пользователя токена. Серверные ошибки страниц приходят от `next` с маршрутом и `digest`: по нему ошибку находят из сообщения, которое увидел пользователь.
- Caddy пишет журнал доступа в JSON. Токены в URL (ссылки на контент, отписка, календарь, `?token=` из писем) заменены на `[redacted]`, заголовок Referer не пишется, cookies и `Authorization` скрыты.
- Пароли, секреты, токены и ключи API в записи не попадают: эти поля вырезаются.
- `LOG_LEVEL` в `.env` или `/etc/hubium/hubium.env`: `debug`, `info` (по умолчанию), `warn`, `error`. При разработке (`NODE_ENV` не `production`) строки выводятся в читаемом виде; `LOG_FORMAT=json` или `pretty` выбирает формат явно.

## Масштабирование

- `web` можно запускать в нескольких экземплярах: сеансы в базе, realtime через `LISTEN/NOTIFY`, кэши сбрасываются через канал `hubium_cache`. Лимит REST API считается в каждом экземпляре. Незавершённые загрузки (и файлы с `STORAGE_DRIVER=fs`) лежат в `STORAGE_FS_ROOT` — в Docker это том `data`: экземплярам на разных машинах нужен общий каталог (NFS) или S3 и привязка клиента к экземпляру на балансировщике.
- Воркеров тоже может быть несколько; pg-boss распределяет задачи (`SKIP LOCKED`).
- Видео перекодируется только `worker-media`; ему нужны ffmpeg и доступ к хранилищу.

## Нагрузочное тестирование

Сценарии k6 лежат в [`tools/k6`](../tools/k6): 1000 одновременных попыток теста и дашборд с 500 запросами в секунду. Цели и запуск описаны в README каталога.

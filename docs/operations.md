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
| ClamAV | по желанию: проверяет загружаемые файлы на вирусы (`CLAMAV_URL`), см. «Антивирус» |

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
8. Антивирус.
9. Поиск для AI: Ollama с bge-m3 в Docker или свой сервер эмбеддингов.
10. Почта.
11. Первый администратор.
12. Демо-данные.

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
  - `clamav-daemon` и `clamav-freshclam` из репозитория дистрибутива, если выбран антивирус;
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
| `clamav` | ClamAV для проверки загрузок; задайте также `CLAMAV_URL=tcp://clamav:3310` |
| `ai-local` | Ollama с моделью bge-m3 для поиска AI-тьютора; задайте также `AI_EMBEDDINGS_URL=http://ollama:11434/v1`, `AI_EMBEDDINGS_MODEL=bge-m3` и `SSRF_ALLOW_HOSTS=ollama` |

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
| `hubium maintenance on\|off\|status [--message <текст>] [--until <дата и время>]` | режим обслуживания, как в **Настройки сайта → Обслуживание** |
| `hubium version` | версия, коммит и время сборки |

В Docker: `docker compose --project-directory /opt/hubium exec web hubium doctor`. В системе: `sudo -u hubium hubium doctor` (файл настроек читают root и группа `hubium`).

Миграции релиз применяет сам. Учёт ведётся в той же таблице `_prisma_migrations`, с теми же контрольными суммами и блокировкой, что у `prisma migrate deploy`. Поэтому команды Prisma продолжают работать с базой, а в релиз не входят ни CLI Prisma, ни его нативный движок.

### Домены

- `APP_URL` — основной адрес, например `https://lms.example.org`.
- `CONTENT_HOST` — **отдельный домен** для недоверенного контента (SCORM, H5P), например `https://content.example.org`. Cookie LMS туда не попадают. Без отдельного домена страница «Окружение» показывает ошибку.
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
| `TRUSTED_PROXY_HOPS` | сколько прокси перед web-сервером дописывают адрес в `X-Forwarded-For`: 1 для Caddy или nginx, 2, если перед ними CDN. Адрес клиента (журнал, ограничение теста по сети, лимиты попыток входа, адрес сеанса) берётся столько позиций справа; левее адреса подставляет сам клиент. 0 — прокси нет, заголовок не читается |
| `SSRF_ALLOW_HOSTS` | внутренние хосты, к которым серверу разрешено обращаться (локальный Ollama, внутренний LTI-инструмент, провайдер единого входа во внутренней сети) |
| `API_RATE_LIMIT_PER_MIN` | лимит REST API на токен в минуту (120) |
| `METRICS_TOKEN` | включает `/api/metrics` для Prometheus |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_TRACES_SAMPLER_ARG`, `OTEL_RESOURCE_ATTRIBUTES` | трассировка OpenTelemetry, см. «Трассировка» |
| `AI_EMBEDDINGS_URL`, `AI_EMBEDDINGS_MODEL`, `AI_EMBEDDINGS_API_KEY` | сервер эмбеддингов (OpenAI-совместимый, 1024 измерения), который первый запуск записывает в **Администрирование → AI**; дальше настройка меняется там |
| `CLAMAV_URL`, `CLAMAV_MAX_SCAN_MB`, `CLAMAV_TIMEOUT_MS` | проверка загрузок на вирусы: адрес clamd (`tcp://host:3310` или `unix:///путь/к/сокету`), предельный размер проверяемого файла (100 МБ) и время проверки (20 с) |
| `AUTH_GOOGLE_ID`/`_SECRET`, `AUTH_YANDEX_ID`/`_SECRET`, `AUTH_VK_ID`/`_SECRET`, `AUTH_KEYCLOAK_ID`/`_SECRET`/`_ISSUER` | вход через Google, Яндекс ID, VK ID и Keycloak (для Keycloak `_ISSUER` — адрес realm); кнопки включаются в **Настройки → Вход** |
| `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`, `SEED_PROFILE` | первый администратор и демо-данные |
| `HUBIUM_VERSION`, `HUBIUM_IMAGE`, `COMPOSE_PROFILES`, `HUBIUM_WEB_BIND` | только Docker: релиз, образ, профили, адрес web-сервера без Caddy |

## Настройка после установки

1. **Администрирование → Настройки**: название, часовой пояс по умолчанию, регистрация, вход через Google/Яндекс/VK/Keycloak (ключи задаются переменными `AUTH_*`). **Администрирование → Языки**: язык сайта, доступные пользователям языки и определение языка гостя по браузеру. **Администрирование → Модули**: какие типы элементов курса доступны. Выключенный тип сохраняет свои элементы и оценки, студенты их не видят.
2. **Оформление**: фирменный цвет (контраст проверяется автоматически) и логотип.
3. **Политики**: опубликуйте политику конфиденциальности и правила сайта. Обязательные документы пользователи принимают при следующем входе.
4. **AI** (по желанию): провайдер (Claude API или OpenAI-совместимый сервер), функции, лимиты и текст уведомления о конфиденциальности. Для локальной модели в той же сети добавьте её хост в `SSRF_ALLOW_HOSTS`. Для поиска по курсам нужны эмбеддинги (рекомендуется `bge-m3`, 1024 измерения): их ставит профиль `ai-local` (`install-hubium.sh --ai-local yes`), или укажите свой сервер. Затем нажмите «Переиндексировать курсы» или выполните `hubium ai reindex`.
5. **LTI**: зарегистрируйте внешние инструменты; адреса платформы (issuer, JWKS, token) показаны там же.
6. **Единый вход** (по желанию): **Администрирование → Единый вход** подключает корпоративного провайдера по OpenID Connect или SAML 2.0. Форма показывает адреса, которые нужно указать у провайдера: Redirect URI для OIDC, Entity ID и ACS для SAML, а метаданные сервис-провайдера с сертификатом подписи можно сразу загрузить в него. Для провайдера выбирается, входить ли в существующую учётную запись с той же почтой и создавать ли новые; имя и сопоставленные поля профиля обновляются при каждом входе. **Администрирование → LDAP** подключает каталог (OpenLDAP, Active Directory, FreeIPA): адрес, служебная учётная запись, базовый DN и фильтр поиска; кнопка «Проверить подключение» ищет указанный логин. Каталог проверяется первым, локальные пароли — после него. Каждую ночь (задача `auth.ldapSync`, 02:47 UTC) имена, почта и поля профиля обновляются из каталога, а при включённой настройке приостанавливаются те, кого в каталоге больше нет. Там же добавляется свой провайдер OAuth 2 для сервисов без OpenID Connect: адреса авторизации, токена и информации о пользователе. Провайдер во внутренней сети добавьте в `SSRF_ALLOW_HOSTS`.
7. **Наставники и родители** (по желанию): включите в **Настройки → Общие**, затем свяжите их с учениками в карточке пользователя или загрузите CSV со столбцами `mentor,mentee,kind,action`. Наставник видит пункт «Мои подопечные» с курсами, прогрессом, оценками и сроками учеников.

## Поиск для AI

AI-тьютор и генератор вопросов ищут по тексту курса: полнотекстовый поиск работает всегда, а с эмбеддингами к нему добавляется поиск по смыслу. Для эмбеддингов нужен OpenAI-совместимый сервер с моделью на 1024 измерения. Рекомендуется `bge-m3`: она понимает русский и английский и работает на CPU.

- **Docker, на той же машине:** профиль `ai-local` запускает Ollama и один раз скачивает bge-m3 (1,2 ГБ) в том `ollama`. В `.env` нужны:

  ```bash
  COMPOSE_PROFILES=…,ai-local
  AI_EMBEDDINGS_URL=http://ollama:11434/v1
  AI_EMBEDDINGS_MODEL=bge-m3
  SSRF_ALLOW_HOSTS=ollama
  ```

  Ollama нужно около 2 ГБ памяти. Видеокарта не требуется.
- **Свой сервер** (Ollama, TEI, vLLM или облачный сервис): `install-hubium.sh --embeddings-url http://10.0.0.5:11434/v1 --embeddings-model bge-m3`, либо те же переменные в `.env` или `/etc/hubium/hubium.env`. Ключ, если он нужен, передаётся в `AI_EMBEDDINGS_API_KEY`. Внутренний адрес должен быть указан в `SSRF_ALLOW_HOSTS`.

Переменные `AI_EMBEDDINGS_*` читает наполнение базы при запуске, и только пока эмбеддинги не настроены. Выбор, сделанный потом в **Администрирование → AI**, они не перезаписывают. Если адрес внутренний, а хост не указан в `SSRF_ALLOW_HOSTS`, `hubium migrate` сообщает об этом и настройку не создаёт.

После смены модели сохранённые векторы стираются. Индекс перестраивает `hubium ai reindex`: по умолчанию ставит задачу на каждый курс воркеру, `--course <id>` выбирает один курс, `--sync` строит индекс сразу и печатает итог по курсам. В Docker команда выполняется так: `docker compose --project-directory /opt/hubium exec web hubium ai reindex`.

## Антивирус

Загружаемые файлы можно проверять ClamAV. Проверка включается переменной `CLAMAV_URL`; её можно задать и позже, после установки.

- **Docker:** добавьте `clamav` в `COMPOSE_PROFILES` и задайте `CLAMAV_URL=tcp://clamav:3310` в `.env`, затем выполните `docker compose up -d`. Сигнатуры входят в образ, а `freshclam` в контейнере обновляет их.
- **В системе:** `apt-get install clamav-daemon clamav-freshclam`. В `/etc/clamav/clamd.conf` задайте `StreamMaxLength 110M` и `MaxFileSize 110M`, затем `CLAMAV_URL=unix:///run/clamav/clamd.ctl` в `/etc/hubium/hubium.env`. Именно это делает `install-hubium.sh --antivirus yes`.

Как работает проверка:

- Файл отправляется в clamd до сохранения, через команду INSTREAM. Через неё проходят все загрузки: файлы заданий, форумов и сообщений, видео и SCORM, логотип, восстановление курса. Распакованный SCORM и видео в HLS отдельно не проверяются: проверяется исходный файл.
- Файл с вирусом отклоняется с сообщением «Malware detected: <сигнатура>». В журнал пишется запись `Malware rejected` с именем файла и сигнатурой.
- Файлы больше `CLAMAV_MAX_SCAN_MB` (100 МБ) сохраняются без проверки, в журнал пишется предупреждение. Лимиты clamd должны быть больше этого значения, иначе проверка таких файлов завершится ошибкой.
- Если `CLAMAV_URL` задан, но clamd не отвечает, загрузки отклоняются с кодом 503 (`UNAVAILABLE`), пока clamd снова не заработает. Состояние clamd видно в **Администрирование → Окружение** и в `hubium doctor`.
- У проверенного содержимого запоминается время проверки (`FileBlob.scannedAt`). Если тот же файл уже сохранили до включения антивируса, при повторной загрузке он проверяется.
- Памяти clamd нужно около 1,5 ГБ, а пока он перезагружает обновлённые сигнатуры — вдвое больше. Контейнер ограничен 3 ГБ.

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

### Режим обслуживания

На время работ, которые пользователям лучше не видеть (обновление, перенос данных, проверка после восстановления), включите режим обслуживания: **Администрирование → Настройки сайта → Обслуживание** или

```bash
hubium maintenance on --message "Обновляем Hubium, вернёмся к 18:00" --until 2026-10-20T18:00:00+03:00
hubium maintenance off
```

Пока режим включён, сайтом пользуются только администраторы сайта (и их сеансы «войти как»); у них на каждой странице напоминание. Остальные получают страницу с сообщением и кодом 503, REST API отвечает `503 {"code":"MAINTENANCE"}`. Заголовок `Retry-After` — время до ожидаемого окончания (без него — 10 минут). Вход, `/api/health` и `/api/metrics` остаются открытыми, воркер продолжает работу. Web-серверы замечают переключение в течение 5 секунд.

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
- **Администрирование → Окружение** — живые проверки: база и pgvector, heartbeat воркера, очередь задач и ошибки за сутки, запись в хранилище, антивирус, SMTP, отдельный домен контента, Web Push, AI, ffmpeg.
- Воркер обновляет heartbeat раз в минуту; тревога, если `hubium_worker_heartbeat_age_seconds > 180`.
- **Администрирование → Задачи** — задачи по расписанию (cron в UTC) с последним запуском, длительностью и последней ошибкой; «Запустить сейчас» ставит задачу в очередь вне расписания. Ниже журнал всех запусков за 30 дней — по расписанию и разовых (письма, импорт, вебхуки) — с фильтром по задаче и состоянию; неудачный запуск можно повторить с теми же данными. Журнал — это таблицы pg-boss: воркер при старте настраивает очереди хранить завершённые задания 30 дней.

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

## Трассировка

Hubium отправляет трассы OpenTelemetry по OTLP/HTTP (protobuf) в ваш коллектор: Jaeger, Grafana Tempo, OpenTelemetry Collector или облачный сервис с приёмом OTLP. Трассировка включается переменной `OTEL_EXPORTER_OTLP_ENDPOINT`, без неё ничего не запускается.

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318   # базовый адрес; трассы уходят на /v1/traces
OTEL_EXPORTER_OTLP_HEADERS=authorization=Bearer%20…      # для сервиса с авторизацией
OTEL_TRACES_SAMPLER_ARG=0.1                              # доля новых трасс, 0…1 (по умолчанию 1)
OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=production
```

Что попадает в трассы:

- `service.name` — `web`, `worker`, `worker-media`, `migrate` или `cli`, а также `service.namespace=hubium` и `service.version`. Переопределить имя можно через `OTEL_SERVICE_NAME`.
- **Web.** Next.js сам строит спаны запросов, отрисовки и `fetch`. Для REST API в спане обработчика указан маршрут, например `http.route=/api/v1/courses/:id`.
- **Запросы к базе.** Спаны Prisma: операция, компиляция и сам SQL-запрос (`db_query`).
- **Фоновые задачи.** Задача продолжает трассу запроса, который её поставил: pg-boss хранит в задаче контекст W3C (`traceparent`). Воркер выполняет задачу в спане `process <очередь>`, исходящие HTTP-запросы (вебхуки, AI, LTI) — в спанах undici.
- **Логи.** У строк журнала внутри трассы есть поля `trace_id`, `span_id` и `trace_flags`, так что из записи можно перейти к трассе и обратно. В читаемом формате для разработки эти поля не печатаются.
- **Семплирование.** Решение вызывающей стороны соблюдается: если входящий запрос с `traceparent` записывается, его трасса продолжается. Новые трассы сохраняются с долей `OTEL_TRACES_SAMPLER_ARG`. Переменная `OTEL_TRACES_SAMPLER` задаёт другой семплер по спецификации.

Свой Jaeger на той же машине (порт 4318 — приём OTLP, 16686 — интерфейс):

```bash
docker run -d --name jaeger -p 127.0.0.1:4318:4318 -p 127.0.0.1:16686:16686 jaegertracing/jaeger:2.22.0
```

В Docker укажите `OTEL_EXPORTER_OTLP_ENDPOINT=http://<адрес хоста>:4318` в `.env` и выполните `docker compose up -d`. В системной установке задайте `http://127.0.0.1:4318` в `/etc/hubium/hubium.env` и выполните `systemctl restart 'hubium-*'`.

## Масштабирование

- `web` можно запускать в нескольких экземплярах: сеансы в базе, realtime через `LISTEN/NOTIFY`, кэши сбрасываются через канал `hubium_cache`. Лимит REST API считается в каждом экземпляре. Незавершённые загрузки (и файлы с `STORAGE_DRIVER=fs`) лежат в `STORAGE_FS_ROOT` — в Docker это том `data`: экземплярам на разных машинах нужен общий каталог (NFS) или S3 и привязка клиента к экземпляру на балансировщике.
- Воркеров тоже может быть несколько; pg-boss распределяет задачи (`SKIP LOCKED`).
- Видео перекодируется только `worker-media`; ему нужны ffmpeg и доступ к хранилищу.

## Нагрузочное тестирование

Сценарии k6 лежат в [`tools/k6`](../tools/k6): 1000 одновременных попыток теста и дашборд с 500 запросами в секунду. Цели и запуск описаны в README каталога.

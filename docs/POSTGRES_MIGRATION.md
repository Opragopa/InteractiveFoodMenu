# PostgreSQL и обновление меню по событиям

## Что меняется

API поддерживает PostgreSQL 18 через `DATABASE_PROVIDER=postgres`. Каждая сущность хранится в отдельной таблице схемы `ifm` с типизированными столбцами, первичными ключами, проверками диапазонов и индексами из `schema.ts`. Пул ограничен `DATABASE_POOL_SIZE` (по умолчанию 10 соединений, одно занято LISTEN). Остаток и `menuVersion` меняются атомарным SQL UPDATE, в том числе при нескольких API.

Небольшие логотипы хранятся в `ifm.assets` (bytea, максимум 10 МБ). Это позволяет переносить файлы вместе с данными и делать единую резервную копию. Для большого объёма медиа следующим шагом будет отдельное объектное хранилище.

Существующие установки остаются на Appwrite, пока явно не переключены. SDK Appwrite пока используется для совместимости запросов и импорта; при `DATABASE_PROVIDER=postgres` рабочие запросы и файлы обслуживаются PostgreSQL. Новые адаптеры используют существующий API, поэтому идентификаторы, хэши паролей, ссылки и секреты экранов сохраняются.

## Как обновляется меню

1. Кабинет загружает данные при открытии, по кнопке обновления и после действий пользователя.
2. Экран открывает один авторизованный SSE-поток через XHR. React использует `/api/menu/events`, серверный HTML — `/tv/events`, старые прямые ссылки — `?events=1`.
3. Изменение данных вызывает транзакционное PostgreSQL `NOTIFY`; каждый API получает событие через собственный `LISTEN`. Событие сбрасывает ограниченный кэш меню (до 128 точек) и уведомляет только соответствующие экраны. Близкие изменения объединяются в течение 100 мс.
4. React получает меню с `If-None-Match`; сервер возвращает SHA-256 ETag и `304`, если данные прежние. Серверный HTML сравнивает хэш и перезагружается при изменении.
5. В простое SQL-запросов меню нет. Раз в 25 секунд отправляется комментарий в уже открытый сокет, без чтения БД. Таймер часов, перелистывание страниц и отсчёт перерыва работают локально.
6. После обрыва соединение восстанавливается с увеличением задержки до 60 секунд. При подключении приходит текущий снимок: пропущенное уведомление не теряет обновление. Раз в 30 минут поток переподключается, чтобы ограничить память старых XHR-клиентов и повторно проверить сессию. Отзыв доступа также доставляется событием.

При недоступности LISTEN готовность API становится отрицательной, кэш очищается, потоки закрываются. После восстановления LISTEN кэш снова очищается. `/menu/version` и `/tv/state` оставлены для совместимости, но новые веб-клиенты их периодически не вызывают. На странице первоначального QR-подключения короткий опрос сохраняется до подключения/истечения кода. Health checks сервера не относятся к опросу меню.

`lastSeenAt` теперь означает последний запрос экрана, а не постоянное доказательство присутствия. Статистика контактов не является мониторингом доступности ТВ. Appwrite-режим доставляет события внутри одного API; несколько API с согласованным кэшем и событиями требуют PostgreSQL.

## Подготовка на Windows-сервере

Статус подготовки и границы проверок на 22.10.2026: [POSTGRES_MIGRATION_STATUS.md](POSTGRES_MIGRATION_STATUS.md).
Команды ниже предназначены для отдельно согласованного окна переноса. Подготовка кода не означает публикацию, переключение рабочего API или готовую резервную копию рабочих данных.

Выполнять в каталоге `C:\InteractiveFoodMenu` в PowerShell с работающим Docker Desktop. Перед началом рабочий Appwrite должен быть доступен, `/ready` рабочего API должен успешно отвечать. Если исходная БД остановлена, сначала отдельно восстановить доступность источника; импорт не является способом восстановления Appwrite.

1. Сохранить исходные секреты и идентификаторы. Не менять `BACKEND_SESSION_SECRET`, `BACKEND_HUB_ACCESS_KEY`, Appwrite project/database/bucket IDs или хэши паролей. До переключения оставить `DATABASE_PROVIDER=appwrite` в `.env.backend`.
2. В приватную `.env.deploy` добавить `POSTGRES_USER=foodmenu`, `POSTGRES_DB=foodmenu`, новый случайный `POSTGRES_PASSWORD` из 64 hex-символов, `DATABASE_POOL_SIZE=10`, `MIGRATION_TAG=<идентификатор проверенной сборки>`. Hex-пароль не требует URL-кодирования. Эти значения не коммитить.
3. Подготовить только новую БД и отдельный образ инструмента миграции:

   ```powershell
   $migrationCompose=@('-p','interactivefoodmenu','-f','compose.yaml','-f','compose.postgres.yaml','-f','compose.migration.yaml','--env-file','.env.deploy')
   docker compose @migrationCompose --profile migration config --quiet
   if($LASTEXITCODE){throw 'Compose configuration failed'}
   docker compose @migrationCompose up -d postgres
   if($LASTEXITCODE){throw 'Target PostgreSQL did not start'}
   docker compose @migrationCompose --profile migration build migration
   if($LASTEXITCODE){throw 'Migration image build failed'}
   docker compose @migrationCompose --profile migration run --rm --no-deps migration
   if($LASTEXITCODE){throw 'Read-only preflight failed; do not start import'}
   ```

   PostgreSQL не публикует порт на хост; том — `interactivefoodmenu_menu_postgres`. Задача `migration` по умолчанию запускает только `migration:preflight`: читает схему и счётчики Appwrite, инвентаризирует файлы, проверяет PostgreSQL 18/UTF8 и отсутствие данных в целевой схеме `ifm`. Схему и данные preflight не создаёт. Эта проверка не останавливает API и не является согласованным снимком источника. Сохранить JSON-вывод в приватный файл.

   `compose.postgres.yaml` задаёт `DATABASE_PROVIDER=postgres` для сервиса **api**, поэтому до успешного импорта запускать через него только явно названные `postgres` и `migration`. Не выполнять общий `up -d` и не поднимать через override рабочий API. У задачи `migration` источник всегда `appwrite`.
4. Подготовить конфигурацию Nginx из `docker/host-nginx-*.conf.example`: для событий нужны `proxy_buffering off`, `gzip off`, `proxy_read_timeout 75s`. Сохранить текущую конфигурацию для отката. Применение и перезагрузку прокси выполнить в согласованном окне после `nginx -t`.

## Окно переноса данных

Appwrite не предоставляет здесь межтабличный снимок через SDK. На весь интервал резервного копирования и импорта остановить **все** экземпляры прикладного API, задания и прямые записи в Appwrite Console. Сам Appwrite должен продолжать обслуживать чтение. Контроль `--source-frozen` — подтверждение оператора, он не останавливает писателей автоматически.

```powershell
# Только в согласованное окно. Учесть дополнительные API и прямых писателей.
docker compose -p interactivefoodmenu -f compose.yaml --env-file .env.deploy stop api
if($LASTEXITCODE){throw 'API stop failed'}

# Новый каталог вне Git. Указать реальные конфигурационные файлы внешнего Nginx.
powershell -NoProfile -File scripts/backup-appwrite-migration.ps1 `
  -RepoPath 'C:\InteractiveFoodMenu' `
  -OutputDirectory 'C:\ifm-backups\BEFORE-MIGRATION' `
  -AdditionalConfig 'C:\PATH\nginx.conf' -SourceFrozen
if($LASTEXITCODE){throw 'Backup failed; do not migrate'}
```

Скрипт проверяет точные Compose-проекты, отказывается работать при запущенном прикладном API или остановленной исходной PostgreSQL, не останавливает сервисы и не очищает данные. Сохраняет бинарный `pg_dump -Fc`, смонтированные `/storage`-тома Appwrite через read-only mounts, приватные конфигурации, исходные образы API/web/proxy, `rollback.compose.json` и SHA-256 всех файлов. Каталог получает ограниченный ACL и содержит секреты. `AdditionalConfig` должен включать действительные конфигурации внешнего прокси и связанные файлы, нужные для восстановления. Копию хранить также вне Docker-хоста.

Чтение каталога архива `pg_restore --list` не доказывает восстановление. До импорта восстановить dump и storage на отдельном изолированном экземпляре Appwrite, проверить чтение точек/меню, паролей и файлов. Не репетировать восстановление поверх рабочих томов. Сопоставить восстановленные счётчики и файлы с источником и сохранить протокол.

После подтверждения резервной копии, её восстановления и пустой цели:

```powershell
docker compose @migrationCompose --profile migration run --rm --no-deps migration npm run migrate:appwrite -- --source-frozen
if($LASTEXITCODE){throw 'Migration failed. Keep Appwrite as provider.'}
```

Сохранить JSON-отчёт импортёра. Он содержит число строк и SHA-256 по каждой таблице и файлам. Переносятся все 11 прикладных таблиц из `schema.ts` и весь настроенный bucket; Appwrite Auth/прочие проекты и служебная БД Appwrite не становятся частью прикладной схемы PostgreSQL. Прикладные staff/operator accounts хранятся в этих таблицах, их хэши сохраняются.

Импорт проверяет исходные счётчики страниц, каждое исходное поле, целевое количество строк, содержимое файлов, связи меню и существование логотипов/изображений блюд. Неизвестные столбцы, неполная выгрузка, изменение счётчиков, отсутствующие файлы или SQL-ошибка откатывают целевую транзакцию. Заполненная цель отклоняется; автоматической очистки нет. DDL пустой схемы может сохраниться после неудачного импорта, сами импортируемые строки и файлы откатываются. Проверки счётчиков не заменяют остановку писателей: изменение значений при том же количестве строк так не обнаруживается.

После успешного импорта и проверки отчёта заменить только `DATABASE_PROVIDER=postgres` в `.env.backend`, затем собрать проверенную версию API/web и запустить её с PostgreSQL override:

```powershell
$postgresCompose=@('-p','interactivefoodmenu','-f','compose.yaml','-f','compose.postgres.yaml','--env-file','.env.deploy')
docker compose @postgresCompose build api web
if($LASTEXITCODE){throw 'API/web build failed'}
docker compose @postgresCompose run --rm --no-deps api npm run bootstrap
if($LASTEXITCODE){throw 'PostgreSQL schema is not ready'}
docker compose @postgresCompose up -d api web proxy
if($LASTEXITCODE){throw 'PostgreSQL API start failed'}
powershell -NoProfile -File scripts/check-production.ps1
if($LASTEXITCODE){throw 'Production smoke failed; do not open writes'}
```

Не допускать обычных записей в новый API до завершения приёмки. Контрольные действия приёмки также создают записи — сохранить их отдельно и учитывать при откате. Исходный Appwrite/тома и образы остаются сохранёнными. `deploy-production.ps1` выбирает PostgreSQL override по провайдеру в `.env.backend`; сам импорт он не запускает. `compose.backend.yaml` — отдельный старый Appwrite-вариант, для этого переноса его не использовать.

## Приёмка перед открытием записи

- `/ready` возвращает `datastore: postgres`, а опубликованный `build-version.txt` соответствует сборке.
- Вход оператора и сотрудника работают со старыми паролями; количество точек, категорий, блюд и экранов совпадает с отчётом.
- Логотипы и старые ссылки экранов открываются.
- Изменить наличие/количество/цену, начать и остановить перерыв, проверить React и серверный HTML на реальных ТВ. Оставить меню на минуту: нет повторяющихся `/menu/version`, `/tv/state` и загрузок меню.
- Проверить обрыв и восстановление сети, отзыв одного экрана и отсутствие обновлений чужой точки.
- Сделать резервную копию PostgreSQL и проверить восстановление на отдельной БД.

На macOS локально проверены PostgreSQL 18, перенос синтетических данных и файлов, откат при ошибке, конкурентные остатки, стабильная пагинация, ETag, уведомления между двумя экземплярами и отсутствие SQL меню во время 26 секунд простоя с heartbeat. В браузере проверены сохранение нулевого остатка и запуск перерыва из кабинета, 30 секунд простоя без новых API-запросов, сохранение последнего меню при обрыве сети и восстановление пропущенного изменения на React, прямой legacy-ссылке и `/tv/menu`. Эта проверка не заменяет приёмку рабочих данных и физических телевизоров.

## Откат

До появления новых данных в PostgreSQL: остановить новый API, вернуть `DATABASE_PROVIDER=appwrite`, проверить доступность исходного Appwrite и использовать сохранённые **исходные образы** из `rollback.compose.json`. Не включать PostgreSQL override при запуске старого API:

```powershell
docker compose @postgresCompose stop api
if($LASTEXITCODE){throw 'New API stop failed'}
# Вернуть DATABASE_PROVIDER=appwrite в .env.backend.
docker compose -p interactivefoodmenu -f compose.yaml -f C:\ifm-backups\BEFORE-MIGRATION\rollback.compose.json --env-file .env.deploy up -d --no-build --force-recreate api web proxy
if($LASTEXITCODE){throw 'Rollback failed'}
```

Если исходных образов на хосте уже нет, сначала `docker image load --input C:\ifm-backups\BEFORE-MIGRATION\rollback-images.tar`. Сверить `/ready`, версию и старые сессии. После начала записей в PostgreSQL возврат на Appwrite требует сохранения PostgreSQL и отдельного обратного переноса изменений; автоматической двусторонней синхронизации нет.

## Резервные копии PostgreSQL

Не перенаправлять бинарный `pg_dump -Fc` через старую Windows PowerShell. Создать файл внутри контейнера и скопировать его:

```powershell
docker compose -f compose.yaml -f compose.postgres.yaml --env-file .env.deploy exec postgres pg_dump -U foodmenu -d foodmenu -Fc -f /tmp/foodmenu.dump
docker compose -f compose.yaml -f compose.postgres.yaml --env-file .env.deploy cp postgres:/tmp/foodmenu.dump ./foodmenu.dump
```

Хранить копию вне Docker-хоста. Восстанавливать для проверки в отдельную пустую БД командой `pg_restore --exit-on-error`; не выполнять пробное восстановление поверх рабочей БД.

## Проверки разработки

```sh
npm test --prefix backend-api
npm test --prefix web-display
npm run build --prefix web-display
TEST_POSTGRES_URL=postgresql://test_user:test_password@127.0.0.1:5432/postgres npm run test:postgres --prefix backend-api
```

PostgreSQL-тест создаёт отдельную БД с уникальным именем и удаляет только её; тестовому пользователю нужно право CREATEDB. Без `TEST_POSTGRES_URL` интеграционный тест явно пропускается. Один прогон включает 26 секунд проверки простоя.

Архитектура использует официальную семантику [PostgreSQL LISTEN](https://www.postgresql.org/docs/18/sql-listen.html) и [NOTIFY](https://www.postgresql.org/docs/18/sql-notify.html): уведомление доставляется после commit, но не хранится для отключённых клиентов. Поэтому при каждом переподключении клиент получает актуальный снимок.

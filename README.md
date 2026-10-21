# Меню в наличии

Система меню для заведения: Android-приложение сотрудника, веб-кабинет, экран для ТВ и self-hosted backend. Сотрудник управляет категориями и позициями, отмечает недоступные блюда, импортирует CSV и выпускает ссылку/QR для экрана.

Firebase не используется. Данные и файлы хранятся в self-hosted Appwrite, а web и Android обращаются к нему только через `backend-api`.

## Состав проекта

- `backend-api/` — Node.js API, авторизация, pairing, legacy-TV renderer и работа с Appwrite;
- `web-display/` — React/Vite: кабинет сотрудника (`/staff`), экран ТВ (`/connect`) и операторский хаб (`/hub`);
- `android/` — Kotlin и Jetpack Compose, приложение сотрудника;
- `compose.yaml` — production API, web и внутренний Nginx proxy;
- `compose.backend.yaml` — изолированный запуск API;
- `docs/APPWRITE_DEPLOYMENT.md` — установка и обновление production backend.

## Требования

- Node.js 22 и npm;
- JDK 17+ и Android SDK 37 для Android;
- Docker Desktop с Docker Compose v2;
- self-hosted Appwrite.

## Локальная разработка

Установите зависимости:

```bash
npm run install:all
cp docker/backend-api.env.example .env.backend
cp web-display/.env.example web-display/.env.local
```

Заполните `.env.backend`. Для локального Vite укажите полный адрес API:

```env
VITE_BACKEND_API_URL=http://127.0.0.1:8091/api
VITE_DISPLAY_BASE_URL=http://192.168.1.10:5173
```

Создайте или обновите схему Appwrite и запустите API:

```bash
npm run api:bootstrap
npm run api:dev
```

Во втором терминале запустите web:

```bash
npm run web:dev
```

Для доступа ТВ из локальной сети:

```bash
npm run web:dev:lan
```

## Проверки

```bash
npm test
npm run build
./gradlew :android:testDebugUnitTest :android:assembleDebug
```

Для UI-тестов на подключённом Android-устройстве:

```bash
./gradlew :android:connectedDebugAndroidTest
```

## Production

Пошаговая установка Appwrite и API описана в [`docs/APPWRITE_DEPLOYMENT.md`](docs/APPWRITE_DEPLOYMENT.md).

Создайте `.env.deploy` и `.env.backend` по примерам в `docker/`, затем выполните:

```bash
export BUILD_VERSION="$(git rev-parse --short HEAD)"
docker compose -f compose.yaml --env-file .env.deploy build api web
docker compose -f compose.yaml --env-file .env.deploy run --rm api npm run bootstrap
docker compose -f compose.yaml --env-file .env.deploy up -d --force-recreate api web proxy
docker compose -f compose.yaml --env-file .env.deploy ps
```

API слушает `127.0.0.1:8091`, а web proxy — `127.0.0.1:8088`. Внешний HTTPS завершается host Nginx; примеры находятся в `docker/host-nginx-appwrite.conf.example` и `docker/host-nginx-menu.conf.example`.

Для старых ТВ конфигурация menu-домена должна проксировать `/tv/` и `/api/venue-assets/` к API. `/tv/connect` выдаёт QR-код, `/tv/activate#token.secret` принимает ранее выданную ссылку, после чего меню работает через cookie и `/tv/menu` без секрета в адресе. Перед включением маршрутов выполните `npm run bootstrap` для новой таблицы `statistics_events`. Хаб показывает статистику по точке и периоду; сброс создаёт архивный период, а не удаляет события. Сравнение аналогичных сервисов — в [`docs/competitors.md`](docs/competitors.md).

Проверка после обновления:

```bash
curl http://127.0.0.1:8091/health
curl http://127.0.0.1:8091/ready
curl http://127.0.0.1:8088/
curl https://api.foodmenu.cloudopragopa.online/health
curl https://api.foodmenu.cloudopragopa.online/ready
curl https://foodmenu.cloudopragopa.online/build-version.txt
```

Для release APK передайте публичный адрес API:

```bash
./gradlew :android:assembleRelease -PbackendApiUrl=https://api.foodmenu.cloudopragopa.online/api
```

## Backend Hub

Хаб доступен по адресу `/hub`. Он позволяет создавать точки, менять код/PIN, отзывать сессии, настраивать оформление и просматривать клиентские ошибки и аудит действий.

Основной вход в хаб — личный логин и пароль оператора. Первый оператор создаётся закрытой командой `npm run operator:create -- owner` после `npm run bootstrap`; команда запрашивает пароль в терминале без вывода символов. `BACKEND_HUB_ACCESS_KEY` остаётся резервным ключом. Оба способа входа в хаб выдают `HttpOnly` cookie вместо сохранения нового токена в браузерном хранилище. В хабе оператор создаёт одноразовые приглашения сотрудников, отключает их учётные записи и выдаёт ссылки для сброса пароля. Сотрудник выбирает личный логин и пароль по приглашению.

Веб-кабинет больше не предлагает вход по общему PIN. Старый Android-клиент и подключение экранов пока используют PIN точки. После обновления Android этот переходный вход отключается параметром `ALLOW_LEGACY_STAFF_PIN=false`.

## Импорт CSV

Веб-кабинет принимает UTF-8 CSV с разделителем `,` или `;` и обязательными столбцами `Категория`/`category`, `Название`/`name`, `Цена`/`price`, `Количество`/`quantity`. Количество — целое число от 0 до 2000000000. Если категория и название совпадают с существующей позицией без учёта регистра и лишних пробелов, обновляется только её остаток; иначе позиция добавляется. При неоднозначном совпадении строка отклоняется. Android-приложение пока использует прежний формат импорта.

```csv
Категория;Название;Цена;Количество
Напитки;Капучино;250,50;12
Десерты;Чизкейк;320;0
```

В `menu-import.csv` количество заполнено нулями как шаблон: перед импортом замените их на фактический завоз. В кабинете остаток можно задать вручную или изменить на одну штуку кнопками «−1» и «+1». При нуле позиция автоматически становится недоступной на ТВ; у старых позиций без остатка прежний статус сохраняется до первого ввода количества.


### PostgreSQL и обновления меню

Перенос с Appwrite на PostgreSQL 18, проверка данных, переключение и откат описаны в [инструкции миграции](docs/POSTGRES_MIGRATION.md).
Существующие установки сохраняют `DATABASE_PROVIDER=appwrite` до переноса. Новая установка может сразу использовать `compose.postgres.yaml`.
Меню обновляется по серверным уведомлениям после сохранения. В простое экраны не опрашивают `/menu/version`; SHA-256 ETag позволяет отвечать `304` на повторное получение неизменившегося меню.

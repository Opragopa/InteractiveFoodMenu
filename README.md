# Меню в наличии

Система меню для заведения: Android-приложение сотрудника, веб-кабинет, экран для ТВ и выделенный backend. Сотрудник управляет категориями и позициями, отмечает недоступные блюда, импортирует CSV и выпускает ссылку/QR для экрана.

## Состав проекта

- `android/` — Kotlin и Jetpack Compose, приложение сотрудника.
- `web-display/` — React/Vite: веб-кабинет (`/staff`) и экран ТВ (`/connect`).
- `functions/` — Firebase Functions: вход, pairing, server-rendered экран и диагностические события.
- `backend-api/` — backend-neutral Node.js API для бесплатного self-hosted Appwrite.
- `/hub` — защищённый операторский хаб: точки, серверные функции, ошибки клиентов и аудит действий.
- `firestore.rules`, `storage.rules` — доступ к данным по ролям сотрудника и экрана.
- `compose.yaml` — production web/proxy и изолированный профиль локальных эмуляторов.

## Требования

- Node.js 22 и npm — для локальной разработки без Docker.
- JDK 17+ и Android SDK 37 — для Android.
- Docker Desktop — для Docker-режимов.
- Self-hosted Appwrite — бесплатный production backend; инструкция в `docs/APPWRITE_DEPLOYMENT.md`.

## Быстрый локальный запуск

Установите зависимости и добавьте локальную Firebase-конфигурацию:

```bash
npm install
npm --prefix functions install
npm --prefix web-display install
cp .firebaserc.example .firebaserc
cp web-display/.env.example web-display/.env.local
```

Заполните в `web-display/.env.local` значения `VITE_FIREBASE_*`, затем включите эмуляторы:

```env
VITE_USE_EMULATORS=true
VITE_FIREBASE_EMULATOR_HOST=127.0.0.1
```

В первом терминале, из корня репозитория, запустите Firebase Emulator Suite:

```bash
ENFORCE_APP_CHECK=false npm run emulators
```

В другом терминале запустите веб-интерфейс:

```bash
npm run web:dev
```

После сообщения `All emulators ready!` в третьем терминале создайте демо-точку:

```bash
npm run seed:demo
```

Откройте кабинет сотрудника: `http://127.0.0.1:5173/staff`. Войдите кодом `my-cafe` и PIN `123456`. Экран ТВ: `http://127.0.0.1:5173/connect`.

## Отладка через Docker

Локальный Firebase backend запускается отдельно от production web/proxy:

```bash
docker compose --profile emulators up --build -d backend
docker compose --profile emulators logs -f backend
```

Emulator UI: `http://localhost:4000`. Порты: Functions `5001`, Firestore `8080`, Auth `9099`, Storage `9199`.

Создание тестовой точки в контейнере:

```bash
docker compose --profile emulators exec \
  -e FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 \
  -e USE_FIREBASE_EMULATORS=true \
  backend npm run seed -- --project=interactivefoodmenu --id=main \
  --code=my-cafe --pin=123456 --name="Кафе" --demo-menu=true
```

Пересобрать debug backend после изменения Functions:

```bash
docker compose --profile emulators up --build --force-recreate -d backend
```

Остановить только debug backend, не затрагивая production-контейнеры:

```bash
docker compose --profile emulators stop backend
```

Firebase Emulator Suite предназначен только для разработки. Не публикуйте его порты в интернет.

## Android

Для Android Emulator соберите debug APK и пробросьте порты Firebase:

```bash
./gradlew :android:installDebug \
  -PuseFirebaseEmulators=true \
  -PfirebaseEmulatorHost=127.0.0.1

adb reverse tcp:9099 tcp:9099
adb reverse tcp:5001 tcp:5001
adb reverse tcp:8080 tcp:8080
adb reverse tcp:9199 tcp:9199
```

Для физического телефона замените `127.0.0.1` на LAN-IP компьютера с эмуляторами. `adb reverse` в этом случае не нужен.

## ТВ и веб-экран

Для доступа ТВ из локальной сети запустите Vite на всех интерфейсах:

```bash
npm run web:dev:lan
```

В `.env.local` задайте LAN-IP в `VITE_FIREBASE_EMULATOR_HOST` и `VITE_DISPLAY_BASE_URL`. Для старых webOS/Tizen включите server-rendered экран в `functions/.env`:

```env
DISPLAY_RENDERER=server
```

После изменения Functions перезапустите Emulator Suite и выпустите новую ссылку экрана.

## Проверки

```bash
npm --prefix functions test
npm --prefix web-display run build
npm --prefix web-display test
./gradlew :android:testDebugUnitTest :android:assembleDebug -PuseFirebaseEmulators=true
```

Для UI-тестов на подключённом Android-устройстве:

```bash
./gradlew :android:connectedDebugAndroidTest
```

## Production

Новый бесплатный backend разворачивается на своём сервере через Appwrite и отдельный API. Пошаговая инструкция: [`docs/APPWRITE_DEPLOYMENT.md`](docs/APPWRITE_DEPLOYMENT.md). Firebase-конфигурация ниже временно сохранена для локальной разработки и плавного переноса существующих клиентов.

Старый Firebase-вариант требует Blaze. Он не является целевым production backend после перехода на Appwrite.

Развёртывание Firebase:

```bash
npm --prefix functions run build
npm --prefix web-display run build
npx firebase deploy --only firestore:rules,storage,functions,hosting
```

### Self-hosted web в Docker

Docker-стек содержит `web` и `proxy`; Firebase Auth, Firestore, Storage и Functions остаются облачными. Создайте `.env.deploy` по шаблону `docker/.env.deploy.example`, укажите Firebase Web config и публичный HTTPS-адрес в `VITE_DISPLAY_BASE_URL`.

```bash
docker compose --env-file .env.deploy up --build -d
docker compose ps
```

Контейнерный proxy слушает только `127.0.0.1:8088`. Настройте внешний reverse proxy и TLS по шаблону `docker/host-nginx-menu.conf.example`; он должен направлять публичный домен на этот loopback-порт.

Для release APK передайте тот же публичный адрес:

```bash
./gradlew :android:assembleRelease -PdisplayBaseUrl=https://menu.example.com
```

## Диагностика

- Логи Docker: `docker compose logs -f`.
- Логи локального Firebase: Emulator UI (`clientLogs`).
- Production-ошибки клиентов: Firestore collection `clientLogs` и Cloud Logging.
- При `No matching client found` сопоставьте `applicationId` с `package_name` в `android/google-services.json`.
- При ошибках входа проверьте активный Firebase project ID, регион Functions и запущенные эмуляторы.

## Backend Hub

Хаб доступен по адресу `/hub`. Он предназначен для владельца платформы, а не для сотрудников отдельных точек. Через него можно создавать точки, менять код/PIN, отзывать сессии, видеть реестр Functions и последние клиентские ошибки.

Создайте секрет длиной не менее 24 символов. Для production используйте Secret Manager:

```bash
npx firebase functions:secrets:set BACKEND_HUB_ACCESS_KEY
```

Для локального Emulator Suite добавьте значение в `functions/.secret.local` (файл не должен попадать в Git):

```env
BACKEND_HUB_ACCESS_KEY=replace-with-a-long-random-operator-key
```

После изменения секрета перезапустите Functions Emulator. Все опасные операции хаба выполняются только сервером, требуют роли `platform_admin` и записываются в `adminAuditLogs`.

## Импорт CSV

Импорт доступен в Android и веб-кабинете на вкладке позиций. Он добавляет новые позиции и недостающие категории, не удаляя существующие данные. Поддерживаются UTF-8 CSV с разделителем `,` или `;`, русскими или английскими заголовками `category`, `name`, `price`, а также необязательным `available`.

```csv
Категория;Название;Цена;В наличии
Напитки;Капучино;250,50;Да
Десерты;Чизкейк;320;Нет
```

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

Доступ защищён значением `BACKEND_HUB_ACCESS_KEY` из `.env.backend`. Используйте отдельный случайный секрет длиной не менее 24 символов.

## Импорт CSV

Импорт доступен в Android и веб-кабинете на вкладке позиций. Он добавляет новые позиции и недостающие категории, не удаляя существующие данные. Поддерживаются UTF-8 CSV с разделителем `,` или `;`, русскими или английскими заголовками `category`, `name`, `price`, а также необязательным `available`.

```csv
Категория;Название;Цена;В наличии
Напитки;Капучино;250,50;Да
Десерты;Чизкейк;320;Нет
```

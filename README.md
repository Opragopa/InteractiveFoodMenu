# Меню в наличии

Приложение состоит из Android-приложения сотрудника, веб-кабинета сотрудника, web-экрана для телевизора и Firebase backend. Сотрудник управляет позициями, отмечает крестиком товары, которых нет в наличии, и может добавлять меню из CSV. Такие позиции становятся серыми, зачёркиваются и перемещаются вниз своей категории; категория остаётся на экране, даже когда всё закончилось.

## Структура

- `android/` — Kotlin, Jetpack Compose, minSdk 26.
- `web-display/` — React/Vite: экран телевизора и кабинет сотрудника по адресу `/staff`.
- `functions/` — callable-функции входа и перевыпуска display-ссылки.
- `firestore.rules`, `storage.rules` — изоляция точки и ролей `staff`/`display`.

## Что нужно установить

- JDK 17 или новее и Android Studio с Android SDK 37.
- Node.js 22 и npm.
- Firebase-проект на Blaze plan для развёртывания Functions.
- Google Application Default Credentials для setup-скрипта production-точки.

## Локальный запуск

1. Установите JavaScript-зависимости:

   ```bash
   npm install
   npm --prefix functions install
   npm --prefix web-display install
   ```

2. Создайте `.firebaserc` из `.firebaserc.example`. Для локальных эмуляторов можно оставить demo project ID.
3. Скопируйте `web-display/.env.example` в `web-display/.env.local`, заполните Firebase web config и установите `VITE_USE_EMULATORS=true`.
4. Скопируйте реальный Android config в `android/google-services.json`. Файл не коммитится.

## Публичный веб в Docker и Firebase

Production-вариант изолирует веб-интерфейс в Docker, но оставляет Auth, Firestore, Storage и Functions в Firebase. В Compose запускаются `web` (собранный TV/кабинет) и `proxy`; наружу доступен только `127.0.0.1:8088`. Существующий Nginx Windows продолжает владеть `80/443` для Jellyfin и нового поддомена меню, передавая запросы меню на этот loopback-порт.

1. На сервере скопируйте `docker/.env.deploy.example` в `.env.deploy`, заполните Firebase Web config и свой HTTPS-домен.
2. В настройках DNS направьте поддомен, например `menu.example.com`, на белый IP дома; добавьте сертификат и новый server block по `docker/host-nginx-menu.conf.example` в уже работающий Nginx.
3. Запустите из корня репозитория:

   ```bash
   docker compose --env-file .env.deploy up --build -d
   ```

4. Проверьте контейнеры и локальный proxy:

   ```bash
   docker compose ps
   curl -I http://127.0.0.1:8088/
   ```

Веб-кабинет будет выпускать QR-ссылки на `VITE_DISPLAY_BASE_URL`. Для Android release укажите тот же адрес при сборке: `./gradlew :android:assembleRelease -PdisplayBaseUrl=https://menu.example.com`.

Ни Docker, ни Windows Firewall не должны публиковать `4000`, `5001`, `8080`, `9099` или `9199`. Публичным остаётся только Nginx на HTTPS. Команда `docker compose down` останавливает только контейнеры меню и не влияет на Jellyfin или системный Nginx.

## Локальная отладка: Firebase Emulator Suite

Для разработки используются Firebase Authentication, Firestore, Storage и Functions Emulator. Это не production backend и его нельзя публиковать в интернет. Production-веб из раздела выше использует Firebase Cloud; локальный `backend` запускается только с Compose-профилем `emulators` и не стартует случайно вместе с `web`/`proxy`.

HTTP разрешён только в debug-сборках и локальной сети. В release Android требует HTTPS; не выставляйте порты Emulator Suite наружу на домашнем сервере.

### Вариант 1: эмуляторы без Docker

Подходит для обычной разработки на Mac/Windows при установленном Node.js. В первом терминале из корня проекта:

```bash
ENFORCE_APP_CHECK=false npx firebase emulators:start \
  --project interactivefoodmenu \
  --only auth,functions,firestore,storage
```

Дождитесь `All emulators ready!`. Во втором терминале можно создать тестовую точку:

```bash
USE_FIREBASE_EMULATORS=true FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 \
DISPLAY_BASE_URL=http://127.0.0.1:5173 \
npm run seed -- --project=interactivefoodmenu --id=main \
  --code=my-cafe --pin=123456 --name="Кафе" --demo-menu=true
```

### Вариант 2: эмуляторы в Docker

Этот вариант не требует Node.js или Java на хосте: образ содержит Firebase CLI и нужные эмуляторы. Требуется только Docker Desktop с запущенным Linux Engine.

```bash
# запуск и сборка только debug backend, без production web/proxy
docker compose --profile emulators up --build -d backend

# ждать готовности и смотреть ошибки
docker compose --profile emulators logs -f backend
```

После строки `All emulators ready!` Emulator UI доступен на `http://localhost:4000`. Порты отладки: Functions `5001`, Firestore `8080`, Auth `9099`, Storage `9199`. Данные хранятся в Docker volume `firebase-emulator-data` и переживают перезапуск.

Для первичной тестовой точки выполните:

```bash
docker compose --profile emulators exec \
  -e FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 \
  -e USE_FIREBASE_EMULATORS=true \
  -e DISPLAY_BASE_URL=http://127.0.0.1:5173 \
  backend npm run seed -- --project=interactivefoodmenu --id=main \
  --code=my-cafe --pin=123456 --name="Кафе" --demo-menu=true
```

Перезапуск backend после изменения Functions:

```bash
docker compose --profile emulators up --build --force-recreate -d backend
```

Остановить только debug backend, не затрагивая production `web`/`proxy` в этом же Compose-проекте:

```bash
docker compose --profile emulators stop backend
```

На macOS/Linux вместо `docker compose` можно использовать `./scripts/install-backend.sh`; на Windows CMD — `scripts\install-backend.bat`. Оба скрипта запускают только профиль `emulators`.

### Диагностический журнал

Веб-интерфейс и Android отправляют ошибки операций и необработанные ошибки в callable `reportClientLog`. Функция привязывает запись к проверенному пользователю и заведению, сохраняет её в коллекции Firestore `clientLogs` и дублирует в серверный журнал. Секреты, PIN, токены и фрагменты ссылок перед отправкой скрываются; клиентам чтение `clientLogs` запрещено. В локальном Docker-наборе смотрите записи через Emulator UI: `http://localhost:4000/firestore/clientLogs`; в production — в Firestore Console и Cloud Logging.

Для диагностики остановившегося контейнера используйте `docker compose --profile emulators logs --tail=150 backend`. При работе с физическим телефоном или ТВ замените `127.0.0.1` в `FIRESTORE_EMULATOR_HOST` и `DISPLAY_BASE_URL` на LAN-IP машины, где запущены эмуляторы и Vite.

### Вариант A: Android Emulator

Запустите эмуляторы:

   ```bash
   ENFORCE_APP_CHECK=false npx firebase emulators:start \
     --project interactivefoodmenu \
     --only auth,functions,firestore,storage
   ```

Соберите APK. В debug-сборке используется `adb reverse`, поэтому emulator-host — `127.0.0.1`:

   ```bash
   ./gradlew :android:installDebug -PuseFirebaseEmulators=true -PfirebaseEmulatorHost=127.0.0.1
   adb reverse tcp:9099 tcp:9099
   adb reverse tcp:5001 tcp:5001
   adb reverse tcp:8080 tcp:8080
   adb reverse tcp:9199 tcp:9199
   ```

Создайте тестовую точку и меню:

   ```bash
 USE_FIREBASE_EMULATORS=true FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 \
     npm run seed -- --project=interactivefoodmenu --id=main \
     --code=mycafe --pin=123456 --name="Зимний сад" --demo-menu=true
   ```

Установите APK и войдите с кодом `my-cafe` и PIN `123456`.

### Вариант B: физический Android-телефон в локальной Wi‑Fi сети

Узнайте LAN-IP Mac (`ifconfig`, например `192.168.0.183`). Телефон и Mac должны быть в одной сети, а macOS Firewall должен разрешать входящие подключения Node. Для диагностики старого ТВ откройте `http://<LAN-IP>:5173/connect-debug.html`; при `VITE_FUNCTIONS_PROXY=true` проверочный callable идёт через порт Vite и не требует прямого доступа ТВ к порту 5001.

Запустите эмуляторы и соберите APK с LAN-IP Mac:

```bash
ENFORCE_APP_CHECK=false npx firebase emulators:start \
  --project interactivefoodmenu \
  --only auth,functions,firestore,storage

./gradlew :android:installDebug \
  -PuseFirebaseEmulators=true \
  -PfirebaseEmulatorHost=192.168.0.183 \
  -PdisplayBaseUrl=http://192.168.0.183:5173
```

В этом варианте `adb reverse` не используется. Подключите телефон по USB только для установки APK (`adb devices`), затем запускайте приложение и вводите `my-cafe` / `123456`.

### Web-экран ТВ в локальной сети

Заполните `web-display/.env.local` значениями Firebase web config, укажите `VITE_FIREBASE_PROJECT_ID=interactivefoodmenu`, `VITE_USE_EMULATORS=true` и `VITE_FIREBASE_EMULATOR_HOST=192.168.0.183`, затем запустите:

```bash
cd web-display
npm run dev -- --host 0.0.0.0
```

На Mac экран доступен по `http://127.0.0.1:5173`, а на телефоне/ТВ — по `http://192.168.0.183:5173`. Откройте на ТВ `/connect`: QR автоматически будет вести на `http://192.168.0.183:5173/pair#…`, даже если сама страница открыта на Mac через `127.0.0.1`. TV-ссылка берётся с фрагментом `#token.secret`, который выдаёт seed или экран управления. Секрет находится только во фрагменте URL и не передаётся в обычных hosting-логах.

### LG webOS

Экран собирается также в ES5-варианте с полифилами для webOS 1–4 (WebKit и Chromium 38/53). Для webOS и Samsung Tizen до 6.0 (включая Tizen 5.0 / Chromium 63) ссылка экрана с токеном автоматически перенаправляется на серверную страницу без React и Firebase-клиента. На старых ТВ не используются reCAPTCHA Enterprise и IndexedDB-постоянство Firebase: ссылка экрана защищена одноразовым секретом. После изменения фронтенда перезапустите dev-сервер либо разверните новую сборку Hosting; телевизор не получает обновление исходного кода сам.

Если старый ТВ всё равно не выполняет JavaScript, включите серверный рендеринг в `functions/.env`:

```env
DISPLAY_RENDERER=server
```

После пересборки и деплоя ссылки экрана будут вести на `/display/<token>.<secret>`. Телевизор получает готовый HTML без React, Firebase SDK и JavaScript; меню обновляется автоматически с интервалом, настроенным для точки. Для локального запуска перезапустите Functions Emulator и web dev server.

Полный локальный порядок для OLED55E6V:

```bash
# functions/.env
DISPLAY_RENDERER=server
DISPLAY_BASE_URL=http://192.168.0.183:5173

# перезапустить эмуляторы после изменения .env
ENFORCE_APP_CHECK=false npx firebase emulators:start \
  --project interactivefoodmenu --only auth,functions,firestore,storage

# в отдельном терминале
cd web-display
npm run dev -- --host 0.0.0.0
```

Затем откройте на ТВ `http://192.168.0.183:5173/connect`, выпустите новый QR и завершите подключение. Для production включение такое же, но после изменения `functions/.env` нужно выполнить `npm --prefix functions run build` и `npx firebase deploy --only functions,hosting`.

Для проверки production-сборки web-экрана на локальной сети используйте `cd web-display && npm run tv`. Команда собирает приложение и запускает preview на `http://<LAN-IP>:5174`; используйте LAN-IP компьютера, а не `localhost`, на телевизоре.

### Отображение меню и настройки

В Android-приложении и веб-кабинете (`/staff` → «Настройки») доступны название точки, фон и акцентный цвет, интервал перелистывания страниц и масштаб ТВ-меню. Масштаб задаётся от 80% до 160% с шагом 5%; при увеличении шрифта на странице автоматически размещается меньше строк, чтобы меню оставалось читаемым. Новые точки начинают с масштаба 100%.

Для экрана и кабинета локально встроен шрифт Onest с системным запасным вариантом для старых браузеров. Серверный экран запрашивает тот же шрифт с Firebase Hosting без внешних CDN. Перемещение позиции при изменении наличия анимировано в Android и веб-кабинете; состояние обновляется сразу, а при ошибке записи Android/веб показывают ошибку и восстанавливают предыдущее значение.

Веб-кабинет сотрудника доступен по `http://127.0.0.1:5173/staff`. Войдите кодом заведения и PIN, затем на вкладке «Позиции» выберите CSV и подтвердите импорт.

Код точки сохраняется в браузере и Android-приложении. В веб-кабинете PIN запоминается только до закрытия браузера; его можно удалить кнопкой «Забыть данные точки». Android сохраняет авторизованную Firebase-сессию, поэтому данные не потребуется вводить вновь, пока сотрудник не выйдет из приложения.

## Импорт меню из CSV

Импорт доступен в Android-приложении («Управление» → «Позиции» → «Импортировать CSV») и в веб-кабинете сотрудника (`/staff` → «Позиции» → «Загрузить CSV»). Он добавляет позиции, не удаляя ранее введённые данные, и создаёт отсутствующие категории. Для каждой категории новые позиции добавляются в конец списка.

Поддерживаются UTF-8 CSV с запятой или точкой с запятой в качестве разделителя. Нужны заголовки `category`, `name`, `price` либо их русские аналоги `Категория`, `Название`, `Цена`. Необязательный столбец `available`/`В наличии` принимает `Да` или `Нет`; если его нет, позиция будет доступна.

```csv
Категория;Название;Цена;В наличии
Напитки;Капучино;250,50;Да
Десерты;Чизкейк;320;Нет
```

Запятые в названии нужно заключать в двойные кавычки. Саму двойную кавычку внутри значения записывайте дважды:

```csv
Вторые блюда,"Свинина запечённая ""По-французски""",250
```

Готовый пример находится в [`menu-import.csv`](menu-import.csv).

## Запуск и пересборка APK

### Android Emulator

После изменения Kotlin/Compose-кода пересоберите и установите debug APK:

```bash
./gradlew :android:installDebug \
  -PuseFirebaseEmulators=true \
  -PfirebaseEmulatorHost=127.0.0.1
```

Пробросьте порты Firebase к Android Emulator:

```bash
adb reverse tcp:9099 tcp:9099
adb reverse tcp:5001 tcp:5001
adb reverse tcp:8080 tcp:8080
adb reverse tcp:9199 tcp:9199
```

Перезапустите приложение с очисткой локального состояния:

```bash
adb shell pm clear com.interactivemenuSpbpu
adb shell monkey -p com.interactivemenuSpbpu 1
```

### Физический Android-телефон

Телефон и Mac должны находиться в одной Wi‑Fi сети. Узнайте IP Mac:

```bash
ifconfig | awk '/^[a-z].*flags/{i=$1} /inet /{print i,$2}'
```

Соберите APK с LAN-IP Mac вместо `127.0.0.1`:

```bash
./gradlew :android:installDebug \
  -PuseFirebaseEmulators=true \
  -PfirebaseEmulatorHost=192.168.0.183 \
  -PdisplayBaseUrl=http://192.168.0.183:5173
```

Замените `192.168.0.183` на фактический IP Mac. Для физического телефона `adb reverse` не нужен:

```bash
adb shell pm clear com.interactivemenuSpbpu
adb shell monkey -p com.interactivemenuSpbpu 1
```

### Android Studio

Откройте корень проекта `/Users/opragopa/InteractiveFoodMenu_Project`, выберите конфигурацию `android` и нужное устройство. Для локального Android Emulator используйте Gradle properties:

```text
-PuseFirebaseEmulators=true -PfirebaseEmulatorHost=127.0.0.1
```

Для физического телефона укажите LAN-IP Mac:

```text
-PuseFirebaseEmulators=true -PfirebaseEmulatorHost=192.168.0.183
```

Для QR из Android также задайте адрес web-экрана:

```text
-PdisplayBaseUrl=http://192.168.0.183:5173
```

После изменения этих параметров нажмите `Sync Project with Gradle Files`, затем `Run ▶`.

PIN не передавайте в shell history на общей машине. Для production предпочтительно временно отключить history или передать команду непосредственно владельцу точки.

## Проверки

```bash
npm test
npm run test:rules
./gradlew :android:testDebugUnitTest :android:assembleDebug
```

Правила тестируются через Firestore Emulator. Android instrumented UI-тест запускается отдельно на устройстве: `./gradlew :android:connectedDebugAndroidTest`.

## Production-настройка

1. Зарегистрируйте Android-приложение `ru.interactivefoodmenu.staff` и web-приложение в Firebase.
2. Включите Authentication, Firestore, Storage, Functions, Hosting и App Check. Для Android release используйте Play Integrity; для вручную установленной debug-сборки зарегистрируйте debug token. Для web укажите reCAPTCHA Enterprise site key.
3. Для Functions задайте `DISPLAY_BASE_URL` в `functions/.env` при использовании собственного домена (например, `https://menu.example.com`). Иначе production-ссылки используют `https://<Firebase-project-ID>.web.app`. В локальной сети QR-код берёт LAN-IP: для веб-экрана — `VITE_FIREBASE_EMULATOR_HOST`, а для Android — `-PfirebaseEmulatorHost`; оба варианта используют порт открытого экрана. При нестандартном адресе укажите `VITE_DISPLAY_BASE_URL=http://192.168.0.183:5173` для веба и `-PdisplayBaseUrl=http://192.168.0.183:5173` для Android. `127.0.0.1` и `localhost` намеренно не попадают в QR, так как на ТВ и телефоне они указывают на само устройство. Задайте также значения `VITE_FIREBASE_*`/`VITE_RECAPTCHA_ENTERPRISE_SITE_KEY` при web-сборке.
4. Разверните backend и экран:

   ```bash
   npm --prefix functions run build
   npm --prefix web-display run build
   npx firebase deploy --only firestore:rules,storage,functions,hosting
   ```

5. Создайте production-точку через `npm run seed`. Повторный запуск меняет PIN, повышает версию staff-сессий и отключает прежнюю TV-ссылку.

Для release APK создайте `android/keystore.properties` по примеру. Файл keystore, Firebase service account, `.env` и `google-services.json` не коммитятся.

## Формат данных

Цена хранится в `priceMinor` как целое число копеек. Клиенты сортируют категории и позиции по `sortOrder`, поэтому дополнительные composite indexes не нужны. Изменения при офлайн-работе Android остаются в локальной очереди Firestore; при конфликте применяется последнее записанное значение.

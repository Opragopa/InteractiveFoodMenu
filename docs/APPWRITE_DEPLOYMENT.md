# Бесплатный production backend: Appwrite

Новый backend состоит из двух изолированных частей:

- self-hosted Appwrite хранит данные и файлы;
- `backend-api` — единственная точка входа для web и Android, поэтому клиенты не зависят от конкретной базы данных.

Appwrite и API слушают только loopback-порты сервера. Публичный HTTPS завершается host Nginx на `https://api.foodmenu.cloudopragopa.online:8443`.

## 1. Требования к серверу

- Docker Desktop с Docker Compose v2;
- не менее 2 CPU, 4 GB RAM и 2 GB swap;
- DNS A-запись `api.foodmenu.cloudopragopa.online`, направленная на сервер;
- DNS A-запись должна указывать на внешний WAN-IP, а не LAN-IP `192.168.x.x`;
- на роутере пробросьте WAN `8090` и `8443` на те же порты Windows-сервера;
- не публикуйте в интернет порты 8089, 8091 и 20080.

## 2. Установка Appwrite

В PowerShell от имени обычного пользователя из корня проекта:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-appwrite.ps1
```

Откройте на самом сервере `http://127.0.0.1:20080` и выберите:

- Hostname: `api.foodmenu.cloudopragopa.online`;
- Use HTTPS: включено;
- Database: PostgreSQL;
- Workers: Combined;
- HTTP port: `8089`;
- HTTPS port: `8433` (его занимает внутренний Traefik Appwrite; это не public Nginx).

После установки порт мастера `20080` больше не нужен.

Откройте локальную консоль Appwrite через `http://127.0.0.1:8089`, создайте проект `Interactive Food Menu` и API key для серверного API. Минимальные scopes:

- databases, tables, columns, rows, indexes — read и write;
- buckets, files — read и write.

Сохраните Project ID и секрет API key. Ключ нельзя добавлять в Git или передавать браузеру/Android-приложению.

## 3. Настройка API

```powershell
Copy-Item .\docker\backend-api.env.example .\.env.backend
notepad .\.env.backend
```

Заполните `APPWRITE_PROJECT_ID`, `APPWRITE_API_KEY`, публичный адрес web/ТВ в `DISPLAY_BASE_URL` и тот же origin в `CORS_ORIGINS`. Для двух backend-секретов создайте разные случайные значения:

```powershell
$bytes = New-Object byte[] 48
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
[Convert]::ToBase64String($bytes)
```

Повторите команду дважды и вставьте результаты в `BACKEND_SESSION_SECRET` и `BACKEND_HUB_ACCESS_KEY`.

Соберите API и один раз создайте структуру базы:

```powershell
docker compose -f compose.backend.yaml build api
docker compose -f compose.backend.yaml run --rm api npm run bootstrap
docker compose -f compose.backend.yaml up -d api
docker compose -f compose.backend.yaml logs --tail 100 api
```

Локальная проверка на сервере:

```powershell
curl.exe http://127.0.0.1:8091/health
curl.exe http://127.0.0.1:8091/ready
```

Ожидаемые ответы: `status: ok` и `status: ready`.

## 4. Nginx и HTTPS

Скопируйте server block из `docker/host-nginx-appwrite.conf.example` в конфигурацию host Nginx, замените пути к сертификату и ключу, затем проверьте конфигурацию и перезагрузите Nginx.

Публичная проверка:

```powershell
curl.exe -k https://api.foodmenu.cloudopragopa.online:8443/health
curl.exe -k https://api.foodmenu.cloudopragopa.online:8443/ready
```

## 5. Обновление

```powershell
git pull
docker compose -f compose.backend.yaml build api
docker compose -f compose.backend.yaml run --rm api npm run bootstrap
docker compose -f compose.backend.yaml up -d api
```

`bootstrap` идемпотентен: существующие database, tables и bucket не удаляются.

## 6. Резервное копирование

До наполнения production-данными настройте регулярную копию каталога Appwrite и его Docker volumes. Проверяйте восстановление на отдельной машине. Сам backup без тестового восстановления не считается рабочим.

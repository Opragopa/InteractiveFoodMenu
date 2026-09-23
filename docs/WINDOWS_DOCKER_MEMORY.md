# Память Docker Desktop на Windows

`vmmemWSL` — это не отдельный контейнер, а вся WSL2-виртуальная машина Docker Desktop. Сначала проверьте реальное потребление контейнеров:

```powershell
docker stats --no-stream
docker system df
wsl --version
```

В проекте ограничения уже заданы для собственных контейнеров:

- API — 512 МБ RAM и до 768 МБ с учётом swap;
- web — 128 МБ RAM и до 192 МБ с учётом swap;
- внутренний proxy — 64 МБ RAM и до 96 МБ с учётом swap;
- логи контейнеров ограничены по размеру и количеству файлов.

Appwrite установлен отдельным стеком, поэтому его контейнеры нужно проверить через `docker stats`. Для небольшой установки Appwrite обычно достаточно 4 ГБ RAM и 2 ГБ swap, но ClickHouse, PostgreSQL и очереди могут временно использовать больше при обслуживании данных.

Чтобы ограничить всю WSL2-виртуальную машину, создайте файл `%USERPROFILE%\\.wslconfig` в PowerShell:

```powershell
@"
[wsl2]
memory=8GB
processors=4
swap=4GB
"@ | Set-Content -Encoding ascii "$env:USERPROFILE\\.wslconfig"

wsl --shutdown
```

После этого запустите Docker Desktop снова. Если сервер имеет меньше 12 ГБ RAM, используйте `memory=6GB` и `processors=2`. Не ставьте лимит ниже 4 ГБ для Appwrite.

Если после ограничения контейнеры начинают перезапускаться, найдите конкретный сервис:

```powershell
docker ps
docker compose -f compose.yaml --env-file .env.deploy logs --tail 100 api
```

Не запускайте `docker system prune -a` без отдельной проверки: он удаляет неиспользуемые образы и может потребовать повторной загрузки большого Appwrite-стека.

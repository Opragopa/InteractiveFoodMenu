# Нагрузочная проверка

Запускается против уже поднятого API и не изменяет данные:

```bash
BASE_URL=https://api.foodmenu.cloudopragopa.online LOAD_REQUESTS=1000 LOAD_CONCURRENCY=25 npm run load
```

Проверяется только liveness endpoint `/health`. Для production не превышайте согласованный лимит запросов и запускайте тест в окне обслуживания.

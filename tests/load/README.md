# Нагрузочная проверка

Сценарий `npm run load:scenario` предназначен для отдельного стенда. Он блокирует производственный домен и требует JSON-файл `LOAD_FIXTURE` вне репозитория. Стенд должен содержать не менее 100 точек, 1000 личных учётных записей и 500 подключённых экранов. Формат файла:

```json
{
  "origin": "https://menu.staging.example.test",
  "hub": { "username": "operator", "password": "from-secret-store" },
  "venueIds": ["venue-id"],
  "screens": [{ "cookie": "ifm_tv_session=...", "width": 1920, "height": 1080 }],
  "staff": [{ "venueCode": "cafe-one", "username": "worker", "password": "from-secret-store", "itemId": "staging-item-id", "stockQuantity": 10 }]
}
```

Для полной проверки в массивах нужны 100 ID точек и 500 отдельных cookie экранов. Сценарий считает учётные записи через хаб, равномерно опрашивает состояния ТВ, открывает меню при изменении версии, читает меню сотрудника, запрашивает статистику и периодически записывает заданный остаток тестовой позиции. Тестовую позицию и её начальное значение следует подготовить на стенде; после проверки сверить остаток. Пароли и cookie не выводятся в отчёт. Запуск:

```bash
LOAD_BASE_URL=https://api.staging.example.test LOAD_FIXTURE=/secure/path/load-fixture.json LOAD_DURATION_SECONDS=90 npm run load:scenario
```

Отчёт содержит p50/p95/p99 и ошибки по маршрутам. В JSON-логах API у каждого запроса есть `appwriteCalls` и `appwriteDurationMs`; вместе с `docker stats` и метриками базы они показывают причину задержек. Снимите базовый результат, исправьте подтверждённое узкое место и повторите сценарий с теми же данными. Без отдельного стенда этот репозиторий не содержит измеренного предела нагрузки.

Запускается против уже поднятого API и не изменяет данные:

```bash
BASE_URL=https://api.foodmenu.cloudopragopa.online LOAD_REQUESTS=1000 LOAD_CONCURRENCY=25 npm run load
```

Проверяется только liveness endpoint `/health`. Для production не превышайте согласованный лимит запросов и запускайте тест в окне обслуживания.

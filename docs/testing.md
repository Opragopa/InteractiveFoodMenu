# Testing and quality gates

Проект использует пирамиду проверок: быстрые unit-тесты для чистых функций и UI, API-интеграционный тест с in-memory Appwrite-адаптерами, health-only нагрузочный smoke и мутационный анализ критичной backend-логики.

## Команды

```bash
npm test                         # backend + web unit/component
npm run integration              # HTTP health, CORS, staff login
npm run coverage                 # c8 + Vitest V8; HTML-отчёты в coverage/
npm run mutation                 # Stryker: rateLimit.ts + security.ts
LOAD_REQUESTS=1000 LOAD_CONCURRENCY=25 npm run load
./gradlew :android:testDebugUnitTest :android:assembleDebug
```

Нагрузочный сценарий намеренно вызывает только `/health` и по умолчанию локальный адрес. Перед запуском на production нужно указать `BASE_URL`, согласовать окно проверки и держать небольшой `LOAD_CONCURRENCY`; это smoke-проверка доступности, а не стресс-тест.

## Покрытие

Отчёт backend создаётся в `backend-api/coverage/`, web — в `web-display/coverage/`. В web в расчёт входят исходные runtime-модули и React flow кабинета; сборочные артефакты, legacy bootstrap и декларации исключены. Текущие baseline после добавления интеграционного и component-тестов: backend 43,75% statements / 44,73% functions, web 33,47% statements / 43,39% functions, branches web 76,8%. Порог Vitest: 30% statements/lines, 40% functions, 70% branches. Он фиксирует улучшение и не выдаёт искусственно высокий процент за счёт generated-кода.

Основные зоны следующего повышения — `routes.ts`, `BackendHub.tsx`, `DisplayScreen.tsx` и сетевой `api.ts`; они требуют отдельных контрактных тестов, а не подмены реализаций.

## Мутационный анализ

Stryker запускается только на `src/rateLimit.ts` и `src/security.ts`, потому что это наиболее рискованные чистые модули. Последний прогон: 98 мутантов, 81 killed, 17 survived, 0 timeout/error, mutation score 82,65%; quality gate — 75%. Выжившие мутанты сохранены в HTML/JSON отчёте и относятся в основном к эквивалентным ветвлениям декодирования JWT/повреждённых base64 и к условию очистки bucket на границе времени. Новые тесты покрывают malformed secrets, роли/expiry/optional claims и reset boundary. При изменении security-контракта мутационный прогон обязателен.

HTML/JSON отчёты Stryker находятся в `backend-api/reports/mutation/` после запуска.

## CI и ручная выкладка

CI выполняет unit, build, Docker build и Android unit/debug build. Перед production дополнительно выполняются `npm run integration`, `npm run coverage`, `npm run mutation`, затем health-only load smoke и проверки `/health`/`/ready` по [production runbook](./production-runbook.md).

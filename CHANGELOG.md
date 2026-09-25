# Changelog

Все заметные изменения проекта фиксируются здесь. Формат — краткие записи для выкладки и поддержки.

## [Unreleased] — 2026-09-26

### Added

- Добавлены UX-доступность и feedback-состояния для Staff, Backend Hub и Connect: loading/skeleton, retry, progress импорта CSV и production build marker.
- Добавлены HTTP-интеграционные проверки API: health, CORS preflight и staff login.
- Добавлен health-only load smoke с p50/p95/p99 и безопасными параметрами по умолчанию.
- Добавлены c8/Vitest coverage scripts и HTML/JSON отчёты.
- Добавлен Stryker mutation gate для rate limiting и session security.
- Добавлен component-flow тест staff dashboard: вход, onboarding, поиск и массовое наличие.

### Changed

- Backend экспортирует `createApp`, поэтому интеграционные тесты не требуют запуска отдельного процесса или реальных секретов.
- Порог покрытия web закреплён на 30% statements/lines, 40% functions и 70% branches после исключения generated/legacy артефактов.
- Документация тестирования и эксплуатационные команды собраны в `docs/testing.md`.

### Fixed

- Исправлены вложенные интерактивные labels в наличии Staff, динамические aria-label переключателей и focus-visible для control screens.
- В display недоступные позиции зачёркивают только название и цену; таймер перерыва больше не объявляет каждую секунду через `aria-live`.
- Снижена когнитивная нагрузка Backend Hub: вторичные действия точки убраны в меню «Действия», операции экранов получили busy-state.
- Исправлена Vitest mock-hoisting проблема в тесте staff flow.
- Усилены проверки malformed secret encodings, JWT claims/expiry и rate-limit reset boundary.

## [0.1.0]

- Базовая версия меню, кабинета сотрудника, display/connect flow и Appwrite backend.

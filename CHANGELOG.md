# Changelog

Все заметные изменения проекта фиксируются здесь. Формат — краткие записи для выкладки и поддержки.

## [Unreleased] — 2026-09-26

### Added

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

- Исправлена Vitest mock-hoisting проблема в тесте staff flow.
- Усилены проверки malformed secret encodings, JWT claims/expiry и rate-limit reset boundary.

## [0.1.0]

- Базовая версия меню, кабинета сотрудника, display/connect flow и Appwrite backend.

# Appwrite audit stand

The audit is based on deployed commit `d542fe8` plus separately reviewed fixes.
Do not bring uncommitted PostgreSQL/event-stream migration work into this stand.
Do not change the production API provider or production data.

## Prepare and record

Read-only discovery must record Windows CPU/RAM, WSL CPU/RAM/swap limits,
Docker/Compose versions, actual Appwrite API/worker/database/cache image IDs,
container limits and production commit. Appwrite 2.2.0 may use its own PostgreSQL
internally; this does not mean this application's `DATABASE_PROVIDER` switched.
Image versions in examples are never a substitute for actual discovery.

Use an approved downtime window. Keep production running, with only one
liveness probe per 30 s and a retry after 5 s on failure. Clone the installed
official Appwrite Compose into a separate directory with Compose project
`ifm-audit-appwrite`; change **every** project/network/volume/hostname/published
port, use independent secrets, and verify the rendered config before `up`.
Use the same discovered image digests. Never merge or run the production
Compose for the audit; never attach the audit API to production Appwrite.
Fresh audit volumes are required. Reserve separate loopback HTTP/TLS ports,
for example 20089/28433, and retain existing production port bindings.

Create a separate Appwrite project with ID `ifm-audit-RUN_ID`, a test-only API
key and the normal backend schema/bucket with the same prefix. Set independent
backend session/hub secrets, test URLs/CORS, the dedicated Appwrite endpoint and
`REDIS_URL=redis://redis:6379`. On this polling baseline the provider selection
is implicit Appwrite; later code must explicitly remain on Appwrite.

`compose.audit.yaml` is a standalone API/web/Redis composition with required
external configuration:

| Variable | Meaning |
| --- | --- |
| `AUDIT_API_IMAGE`, `AUDIT_WEB_IMAGE` | Pinned baseline images or locally built candidate images |
| `AUDIT_REDIS_IMAGE` | Discovered production Redis digest |
| `AUDIT_BACKEND_ENV` | Absolute private test environment file outside repositories |
| `AUDIT_APPWRITE_NETWORK` | Dedicated audit Appwrite network |
| `AUDIT_RESOURCE_DIR` | Absolute directory containing resource telemetry only |
| `AUDIT_BIND_ADDRESS` | Loopback by default; approved private LAN address for LAN generator |
| `AUDIT_API_PORT`, `AUDIT_WEB_PORT` | 18091/18088 defaults, distinct from production |

Use Compose project `ifm-audit-menu` consistently for API/web/Redis. The web
configuration proxies `/api/` and `/tv/` to test API; its resource directory is
read-only and public only on the test surface. Never place fixture/env/key files
in that directory. API memory remains 512 MiB to match the deployed baseline.

Perform backend bootstrap against test env, then use the guarded stand CLI in
[tests/load](../tests/load/README.md). Its first marker proves API/database
identity before bulk seed. Maintain seed fingerprint/software image IDs and
start values for repeatability. Allow adequate indexing and database warmup.

## Resource sampling and execution

Start on Windows before load, outside the repository:

```powershell
powershell -NoProfile -File scripts/sample-audit-resources.ps1 `
  -OutputDirectory C:\ifm-audit-results\baseline-resources `
  -RunId 20261020 `
  -Phase baseline `
  -ProductionHealthUrl http://127.0.0.1:8091/health
```

When invoking through another native process, pass the array through a
PowerShell `-Command` wrapper with `-ComposeProjects @('ifm-audit-menu',
'ifm-audit-appwrite')`; shell argument parsing must not combine both names into
one string. Mount that resource directory in audit web. Confirm `status.json`
returns the expected runId and fresh UTC timestamp through the same route used
by the generator, then pass `--resource-status-url` to the harness.

Collect host CPU/RAM/free memory/page pressure/disk queue and per-test-container
CPU/RAM/IO/network/restarts with a 5 s wait between samples. Collection overhead
adds to that interval; use the recorded UTC timestamps for actual spacing. Retain API JSON logs for Appwrite request
counts/durations and worker/DB error logs. Align clocks to UTC. Production
background consumption shares the host and remains part of the test conditions.

Generate load from the separate Mac in LAN if reachable; otherwise a disclosed
SSH tunnel is acceptable and must stay identical between comparisons. A local
Windows generator is a separately labelled mode, not interchangeable evidence.
Run full baseline, apply only reviewed audit changes to isolated API/web images,
restore the same test seed/start state, and repeat. Do not publish or deploy the
candidate to production as part of testing.

## Review and retain

Verify target-50 nominal SLOs, exact stock deltas, menu content receipts, error
mix, resource headroom, and regression results independently. Stress-100/200
failure establishes a limit under this setup; it does not invalidate a passing
50-screen target unless corruption/recovery affects that target. If thresholds
are never crossed, report a lower bound rather than an invented maximum.

Inspect real Hub/Staff/mobile-sized UI and server TV at 1366×768 and 1920×1080,
including long/large menus, multiple tabs, stale forms, duplicate actions,
network loss/recovery, expired/revoked sessions, and breaks. Browser simulations
do not prove physical old-TV behavior. Keep Android/device evidence separate.

Archive safe JSON/CSV/HTML, Windows resources, redacted API logs, image IDs,
config/seed fingerprints, screenshots and all defects including failed runs.
Operational counters describe menu operations and screen contact; they cannot
measure revenue, orders or visitor views. Credentials remain in private files.
After review use guarded test-row cleanup if needed; remove audit infrastructure
only by explicit exact project/volume identity. No production cutover is included.


## Раздельные фазы сбора ресурсов

Для baseline и candidate использовать новые отдельные каталоги под смонтированным
`resources/`, например `baseline-20261021-r2` и `fixed-20261021`.
`sample-audit-resources.ps1` требует `-RunId` и `-Phase`; перед запуском проверить
его синтаксис Windows PowerShell Parser.ParseFile. В генератор передать URL именно
этой фазы: `/audit-resources/<phase>/status.json`. Статус содержит PID и время старта.

После завершения генератора и итогового snapshot создать `STOP-SAMPLER` в каталоге
фазы и дождаться `sampler-finished.json`. Только затем выполнять преднамеренные
перезапуски и восстановление тестовой БД. Не отключать аварийный stop ради такого
перезапуска. Сборщик отслеживает исходный набор запущенных сервисов, исключая
завершённые одноразовые bootstrap-контейнеры.

При восстановлении поднимать API и проверять `/ready` до запуска nginx: иначе
одновременная замена контейнеров может дать `host not found in upstream api`.
Для ClickHouse имя пользователя должно быть допустимым именем XML-элемента;
генератор секретов не должен заменять его произвольным hex, начинающимся с цифры.
Изменения конфигурации и секретов выполняются только у отдельного стенда.


## Свежесть контроля и транспорт

Генератор принимает только статус своего runId. При временном отказе HTTP-чтения
он сохраняет последний валидный статус, но никогда не продлевает его 25-секундный
срок. Отказ чтения фиксируется отдельно в events.jsonl и summary.resourceReadFailures;
сигнал stop или смена identity останавливают нагрузку сразу. Ошибки пользовательских
запросов считаются отдельно. Этот контроль не повторяет изменения меню.

Не менять VPN, маршруты или сетевые настройки во время сравнения. Для SSH-туннеля
записать время старта, выбранный интерфейс, keepalive и фактические разрывы; сам
туннель не равен LAN-замеру. После разрыва сохранить прерванный запуск, восстановить
исходный seed и начать фазу заново. Скрипт сравнения требует одинаковые transport,
fixtureFingerprint и harnessSha256.

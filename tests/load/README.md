# Appwrite audit and load testing

This suite targets the deployed `d542fe8` polling behavior and its audit fixes.
Pending PostgreSQL/SSE work is excluded. Appwrite remains the API provider even
when the installed Appwrite distribution internally uses PostgreSQL.

Run tooling checks first:

```sh
node --test tests/load/harness.test.mjs
```

These tests use fake loopback HTTP and prove harness behavior only. They do not
measure Appwrite capacity. `npm run load` remains the separate `/health` smoke.

## Isolated stand and fixture

Follow [the audit runbook](../../docs/audit-runbook.md). Copy
`audit.config.example.json` to a private directory **outside every repository**,
replace all example values, and use independent test secrets. `runId=20261020`
requires project/database/bucket IDs `ifm-audit-20261020`. The CLI accepts only
loopback/private LAN/reserved `.test` URLs and blocks production domains.

Bootstrap the normal backend schema against that test project before preflight.
The database must be empty for initial seed; the first marker venue is checked
through `/api/hub/overview` before bulk writes, linking API and Appwrite identity.

```sh
node tests/load/stand.mjs preflight --config /private/audit/config.json
node tests/load/stand.mjs seed --config /private/audit/config.json --allow-seed
node tests/load/stand.mjs verify --config /private/audit/config.json
```

Seed creates 10 venues, 100 personal accounts, 1,780 items (eight menus of 60,
one of 300, one of 1,000), 200 distinct screen sessions, and 10,000 events per
venue over the preceding 30 days. First 50 screens form the target; remaining
150 support stress stages. `statisticsPerVenue` can be set explicitly before
both compared runs. Interrupted seed may be resumed with `--resume-seed` only
on that same test database. Keep the fixture private: it contains cookies,
bearer tokens and one synthetic staff password. Never copy it into reports.

Initial authentication is intentionally excluded from capacity testing. The
production limiter allows 12 authentication attempts/IP/15 minutes, including
successful attempts, and five/account. Test activation, negative authentication,
429 and `Retry-After` separately without disabling the limiter.

## Run

Use a separate generator computer and record transport. LAN is preferred. An
SSH tunnel includes tunnel latency/CPU and must be labelled `ssh-tunnel`;
localhost on the Windows server shares host resources with the generator.
Run baseline and candidate with the same fixture, initial data, hardware,
container limits, transport and profile. Create a new output directory each run.

```sh
node tests/load/scenario.mjs \
  --fixture /private/audit/fixture.json --output /private/audit/baseline \
  --allow-load --allow-writes --confirm-run 20261020 --profile full \
  --transport ssh-tunnel \
  --resource-status-url http://127.0.0.1:28088/audit-resources/status.json
```

`full`: 3 min warmup; 10/25/50 screens for 10 min each; synchronized 50-screen
reload for 1 min; 50-screen soak for 60 min; 100/200-screen stress for 5 min
each. `quick`: 30-second warmup plus 90-second target-50 harness/stand smoke;
it is not the full soak. Accelerated `harness` is restricted to loopback fake
HTTP and labelled as such in every output.

Each five-screen group per venue is three server TVs (`/tv/state` every 15 s,
HTML after version change), one modern client (version every 5 s, JSON menu
after change), and one React legacy client (full JSON menu every 5 s).
The target has ten active staff and two operators. Every employee reads twice
and changes once per 30 s; changes cycle through stock ±1, availability of an
untracked item, price, and break. Operators request venue statistics every 30 s.
Screens are simulated HTTP sessions; real browser/device checks remain separate.

Every request consumes the full body, checks its payload, records TTFB/full-body
latency and bytes, uses a 10 s timeout, and refuses redirects. Global in-flight
limit is 64; skipped actor slots remain visible as dropped work. SIGINT/SIGTERM
or creating `OUTPUT/STOP` stops dispatch and aborts requests. No network request
is retried automatically, preventing duplicate stock writes after ambiguity.

The Windows sampler publishes `status.json` in a dedicated non-secret directory
mounted at `/audit-resources/` by `compose.audit.yaml`. The optional resource URL
fails closed on missing/stale/mismatched status and stops on sampler alarms.
Without that URL resource stop decisions need an explicit external bridge to
`OUTPUT/STOP`; the manifest records that no resource bridge was attached.

Nominal route acceptance: p95 ≤500 ms for JSON reads, ≤1,000 ms for writes,
≤2,000 ms for server HTML/statistics, unexpected errors <1%. Warmup and stress
are excluded from nominal SLO gates. Integrity, route SLOs and delivery are
reported separately. A content receipt requires a complete updated menu, not
just a changed version: JSON stock/availability/price/break or corresponding
visible HTML. Stock quantity is not shown on TV, so server HTML checks visible
availability. Every expected active screen must acknowledge; missing or late
receipts (polling interval +2 s), negative/lost stock or dropped work fail a run.
A final 17 s grace window allows the last legitimate server poll to complete.

Automatic software stop: >5% errors or p95 >3 s in a minute. Host stop alarms:
RAM >90% for 60 s, CPU >95% for 120 s, audit container OOM/restart/exit, two
failed production liveness probes. Alarms stop test traffic; they never restart,
delete or change production containers.

## Evidence and cleanup

```sh
node tests/load/report.mjs --input /private/audit/baseline \
  --resources /private/audit/windows-resources.jsonl
node tests/load/report.mjs --input /private/audit/fixed \
  --resources /private/audit/fixed-resources.jsonl --baseline /private/audit/baseline
```

Outputs: safe `manifest.json`, `summary.json`, `requests.jsonl`, `events.jsonl`,
CSV and standalone `report.html` with latency/error/resource graphs. Collect
API JSON logs separately by `requestId` for `appwriteCalls/appwriteDurationMs`.
The SDK duration is a sum and can exceed wall time under parallelism; it is not
pure database execution time. Preserve failed runs. Data correctness and real
UI observations must accompany latency claims.

Cleanup deletes only rows in the guarded isolated database after fixture/API
identity checks, retaining schema and volumes. It is explicit and irreversible
for test data; archive safe reports first. Project/volume removal remains a
separate, manually scoped infrastructure operation.

```sh
node tests/load/stand.mjs cleanup --config /private/audit/config.json \
  --allow-cleanup --confirm-run 20261020
```

## Operational statistics reconciliation

Take source/API snapshots while all test writers and browser clients are stopped,
first before the complete workload and then after its completion. Snapshot is
read-only. A fixed Moscow-date window covers all seeded events; it does not
confuse source totals with the ordinary current-30-day UI default.

```sh
node tests/load/reconcile.mjs snapshot --config /private/audit/config.json \
  --output /private/audit/before.json --confirm-run 20261020
# Run the full workload and let it finish; stop additional test writers.
node tests/load/reconcile.mjs snapshot --config /private/audit/config.json \
  --output /private/audit/after.json --confirm-run 20261020
node tests/load/reconcile.mjs compare --before /private/audit/before.json \
  --after /private/audit/after.json --run /private/audit/baseline \
  --output /private/audit/reconciliation.json
```

The comparison checks SDK source counters against API aggregates by venue,
`stockChanges` against successful stock adjustments, `menuChanges` against
successful item PATCH/break actions, exact stock start/end values, and distinct
screen/UTC-15-minute contact intervals including deduplication IDs. Initial
pre-provisioned sessions generate no staff-login or display-connection events.
Contact intervals describe system activity, not visitors, views or sales.
Versioned successful mutation evidence records only venue/item IDs, operation,
resulting stock/availability/price/break state and stock delta. Credentials and
arbitrary bodies never enter the journal. Reconciliation replays those states
from the before-snapshot, checks exact availability transitions (including
no-op writes), all final tracked/untracked item states and break states, and
fails on missing/duplicate events or missing mutation evidence. The full baseline
and candidate must use the same new harness fingerprint; the older quick journal
has no such evidence and is not interchangeable.
Snapshots must bracket the whole workload; overlapping/non-quiescent captures
are not atomic and must not be used to claim convergence. Reset epochs on audit
venues are rejected. Failed/ambiguous workload writes remain reconciliation
failures. Keep other regressions/manual changes outside the snapshot interval.

## Candidate foreground staff sync supplement

The corrected browser additionally checks staff menu versions every five seconds
while the staff screen is in the foreground. Ten active staff add about two
version requests per second plus full menu refreshes after changes. The frozen
baseline/candidate harness deliberately keeps identical traffic for comparison.
Measure that added behavior in a **separate** candidate supplemental run:

```sh
node tests/load/staff-sync-probe.mjs --fixture /private/audit/fixed-fixture.json \
  --output /private/audit/staff-sync-supplement --duration-seconds 120 \
  --allow-load --confirm-run 20261020
```

This tool is read-only and uses the real personal staff sessions, initial menu
loads, version checks and refresh-on-change. If combined with a second short
screen workload, label both as a supplemental profile and retain both logs;
do not include its extra traffic in the matched full baseline comparison.
Expired fixtures must be refreshed from the isolated test secret before either
probe. Local fake-HTTP tests remain separate from actual Appwrite results:

```sh
node --test tests/load/harness.test.mjs tests/load/reconcile.test.mjs tests/load/staff-sync-probe.test.mjs
```

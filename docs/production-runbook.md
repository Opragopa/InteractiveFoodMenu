# Production runbook

## Deploy

Run from the physical server terminal where Docker Desktop has an active session:

```powershell
git checkout main
git pull --ff-only origin main
$env:BUILD_VERSION = git rev-parse --short HEAD
docker compose -f compose.yaml --env-file .env.deploy build --pull api web
docker compose -f compose.yaml --env-file .env.deploy up -d --force-recreate api web proxy
```

## Smoke check

```powershell
powershell -ExecutionPolicy Bypass -File scripts/check-production.ps1
docker compose -f compose.yaml ps
Invoke-WebRequest https://foodmenu.cloudopragopa.online/build-version.txt | Select-Object -ExpandProperty Content
```

The API `/ready` endpoint must report Appwrite readiness, not only process liveness.

## Backups

Before a release and at least daily, export the Appwrite database and copy the Appwrite storage volume to a separate disk or host. Keep at least 7 daily and 4 weekly copies. Verify a restore monthly in a disposable Appwrite project. The backup target and Appwrite container names are installation-specific, so do not put production credentials or guessed volume names in this repository.

## Incident response

1. Check `docker compose ps` and `/health`/`/ready`.
2. Inspect `docker compose logs --tail=200 api web proxy`.
3. If only web changed, recreate `web proxy`; if API changed, recreate `api web proxy`.
4. Roll back with `git checkout <known-good-commit>` and repeat the build/recreate commands.

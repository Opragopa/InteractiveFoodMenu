# Production runbook

## Deploy

GitHub Actions deploys every successful push to `main` after both CI jobs pass.
Configure a GitHub Actions environment named `production` with these secrets:

| Secret | Value |
| --- | --- |
| `PROD_HOST` | Public host name or IP for Windows OpenSSH |
| `PROD_SSH_PORT` | OpenSSH port (optional; defaults to `22`) |
| `PROD_USER` | Windows account that owns the project checkout and Docker Desktop session |
| `PROD_PATH` | Project checkout path, for example `C:\InteractiveFoodMenu` |
| `PROD_SSH_KEY` | Private Ed25519 key used by Actions; install its public key for `PROD_USER` |
| `PROD_KNOWN_HOSTS` | Pinned `known_hosts` entry for the server (obtain and verify its fingerprint out of band) |

The server must have Windows OpenSSH Server, Git, Docker Desktop with Compose v2, and the production `.env.deploy` / `.env.backend` files. The SSH account needs non-interactive GitHub read access to this repository and must be able to run Docker Compose. Keep Docker Desktop signed in for that account; test the exact SSH command interactively before enabling the environment. The workflow pins the commit from the triggering push, builds API and web, runs the idempotent Appwrite bootstrap, recreates services, then verifies public health, readiness, CORS, and `/build-version.txt`.

Do not place private keys or environment files in the repository. Protect the `production` environment with the approval and branch rules appropriate for the server.

Manual deployment from the physical server terminal:

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

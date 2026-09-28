param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9a-f]{40}$')]
  [string]$ExpectedCommit
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Join-Path $PSScriptRoot '..')

git fetch origin main
if ($LASTEXITCODE -ne 0) { throw 'git fetch failed' }
git checkout main
if ($LASTEXITCODE -ne 0) { throw 'git checkout main failed' }
git pull --ff-only origin main
if ($LASTEXITCODE -ne 0) { throw 'git pull failed' }

$actualCommit = (git rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $actualCommit -ne $ExpectedCommit) {
  throw "Server checked out $actualCommit, expected $ExpectedCommit"
}

$env:BUILD_VERSION = $actualCommit.Substring(0, 7)
docker compose -f compose.yaml --env-file .env.deploy build --pull api web
if ($LASTEXITCODE -ne 0) { throw 'Docker image build failed' }
docker compose -f compose.yaml --env-file .env.deploy run --rm api npm run bootstrap
if ($LASTEXITCODE -ne 0) { throw 'Appwrite bootstrap failed' }
docker compose -f compose.yaml --env-file .env.deploy up -d --force-recreate api web proxy
if ($LASTEXITCODE -ne 0) { throw 'Container recreation failed' }

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File scripts/check-production.ps1
if ($LASTEXITCODE -ne 0) { throw 'Production smoke checks failed' }

$publishedVersion = (Invoke-WebRequest -Uri 'https://foodmenu.cloudopragopa.online/build-version.txt' -UseBasicParsing).Content.Trim()
if ($publishedVersion -ne $env:BUILD_VERSION) {
  throw "Published version is $publishedVersion, expected $env:BUILD_VERSION"
}
Write-Host "Production deployed and verified: $publishedVersion"

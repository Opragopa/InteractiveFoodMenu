param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9a-f]{40}$')]
  [string]$ExpectedCommit,

  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$RepoPath
)

$ErrorActionPreference = 'Stop'

# A Windows runner service can have a different PATH from the desktop session.
# Resolve Git explicitly before touching the production checkout.
$gitCommand = Get-Command git.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
$gitExecutable = if ($gitCommand) { $gitCommand.Source } else { $null }
if (-not $gitExecutable) {
  $gitCandidates = @(
    "$env:ProgramFiles\Git\cmd\git.exe",
    "${env:ProgramFiles(x86)}\Git\cmd\git.exe",
    "$env:LOCALAPPDATA\Programs\Git\cmd\git.exe"
  )
  $gitExecutable = $gitCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
}
if (-not $gitExecutable) {
  throw 'Git for Windows was not found. Install Git for the runner account or add its cmd directory to the runner service PATH.'
}

Set-Location -LiteralPath $RepoPath

& $gitExecutable fetch origin main
if ($LASTEXITCODE -ne 0) { throw 'git fetch failed' }
& $gitExecutable checkout main
if ($LASTEXITCODE -ne 0) { throw 'git checkout main failed' }
& $gitExecutable pull --ff-only origin main
if ($LASTEXITCODE -ne 0) { throw 'git pull failed' }

$actualCommit = (& $gitExecutable rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $actualCommit -ne $ExpectedCommit) {
  throw "Server checked out $actualCommit, expected $ExpectedCommit"
}

# Migration is a separate maintenance operation; deployment never imports data.
$composeFiles = @('-f', 'compose.yaml')
if (Select-String -LiteralPath '.env.backend' -Pattern '^\s*DATABASE_PROVIDER\s*=\s*postgres\s*$' -Quiet) {
  $composeFiles += @('-f', 'compose.postgres.yaml')
}

$env:BUILD_VERSION = $actualCommit.Substring(0, 7)
docker compose @composeFiles --env-file .env.deploy build --pull api web
if ($LASTEXITCODE -ne 0) { throw 'Docker image build failed' }
docker compose @composeFiles --env-file .env.deploy run --rm api npm run bootstrap
if ($LASTEXITCODE -ne 0) { throw 'Database bootstrap failed' }
docker compose @composeFiles --env-file .env.deploy up -d --force-recreate api web proxy
if ($LASTEXITCODE -ne 0) { throw 'Container recreation failed' }

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File scripts/check-production.ps1
if ($LASTEXITCODE -ne 0) { throw 'Production smoke checks failed' }

$publishedVersion = (Invoke-WebRequest -Uri 'https://foodmenu.cloudopragopa.online/build-version.txt' -UseBasicParsing).Content.Trim()
if ($publishedVersion -ne $env:BUILD_VERSION) {
  throw "Published version is $publishedVersion, expected $env:BUILD_VERSION"
}
Write-Host "Production deployed and verified: $publishedVersion"

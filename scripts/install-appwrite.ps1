param(
    [string]$Version = "2.2.0",
    [string]$InstallDirectory = "C:\InteractiveFoodMenu\appwrite"
)

$ErrorActionPreference = "Stop"

docker info | Out-Null
docker compose version | Out-Null

New-Item -ItemType Directory -Force -Path $InstallDirectory | Out-Null
$resolved = (Resolve-Path $InstallDirectory).Path

Write-Host "Starting Appwrite $Version installer on http://127.0.0.1:20080"
Write-Host "Use api.foodmenu.cloudopragopa.online as the hostname."
Write-Host "In advanced settings bind Appwrite HTTP to port 8089 because host Nginx owns 80/443."

docker run --interactive --tty --rm `
    --publish 127.0.0.1:20080:20080 `
    --volume //var/run/docker.sock:/var/run/docker.sock `
    --mount "type=bind,source=$resolved,target=/usr/src/code/appwrite" `
    --entrypoint install `
    "appwrite/appwrite:$Version"

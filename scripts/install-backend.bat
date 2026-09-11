@echo off
REM Starts the complete local Firebase backend on Windows.
setlocal

cd /d "%~dp0.."

docker info >nul 2>&1
if errorlevel 1 (
  echo Docker is not running or is not installed. Install and start Docker Desktop, then try again.
  exit /b 1
)

docker compose version >nul 2>&1
if not errorlevel 1 (
  set "COMPOSE=docker compose"
) else (
  docker-compose version >nul 2>&1
  if errorlevel 1 (
    echo Docker Compose was not found. Install Docker Desktop with Compose v2, then try again.
    exit /b 1
  )
  set "COMPOSE=docker-compose"
)

echo Building and starting the Firebase backend...
%COMPOSE% up --build -d
if errorlevel 1 exit /b 1

echo.
echo Backend is running.
echo Emulator Suite UI: http://localhost:4000
echo Logs:             %COMPOSE% logs -f backend
echo Stop:             %COMPOSE% down
echo.
echo See README.md, section "Backend in Docker", to create the first venue.

#!/bin/sh
# Starts the complete local Firebase backend on macOS and Linux.
set -eu

PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$PROJECT_DIR"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker не найден. Установите Docker Desktop или Docker Engine и повторите запуск." >&2
  exit 1
fi

if docker compose version >/dev/null 2>&1; then
  compose() { docker compose "$@"; }
elif command -v docker-compose >/dev/null 2>&1; then
  compose() { docker-compose "$@"; }
else
  echo "Docker Compose не найден. Установите Docker Compose v2 и повторите запуск." >&2
  exit 1
fi

echo "Собираю и запускаю Firebase backend..."
compose up --build -d

cat <<'EOF'

Backend запущен.
Emulator Suite UI: http://localhost:4000
Логи:              docker compose logs -f backend
Остановка:         docker compose down

Инструкции по созданию первой точки находятся в README.md (раздел «Backend в Docker»).
EOF

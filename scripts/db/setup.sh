#!/usr/bin/env bash
# Idempotent local/CI database setup:
#   - creates the runtime role (NOSUPERUSER, NOBYPASSRLS) used by api/worker/tests
#   - creates the dev and test databases
#   - grants DML privileges (current + future tables) to the runtime role
#
# Requires an admin connection (POSTGRES_ADMIN_URL, defaulting to the docker-compose superuser).
# Production roles are provisioned by infrastructure tooling, not by this script.
set -euo pipefail

ADMIN_URL="${POSTGRES_ADMIN_URL:-postgres://businessos:businessos@localhost:5432/postgres}"
OWNER_ROLE="${DB_OWNER_ROLE:-businessos}"
APP_ROLE="${DB_APP_ROLE:-businessos_app}"
APP_PASSWORD="${DB_APP_PASSWORD:-businessos_app}"
DATABASES="${DB_NAMES:-businessos_dev businessos_test}"

psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -q <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
    CREATE ROLE ${APP_ROLE} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '${APP_PASSWORD}';
  END IF;
END
\$\$;
SQL

for DB in $DATABASES; do
  if ! psql "$ADMIN_URL" -tAc "SELECT 1 FROM pg_database WHERE datname = '${DB}'" | grep -q 1; then
    psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE ${DB} OWNER ${OWNER_ROLE}"
  fi
  DB_URL="${ADMIN_URL%/*}/${DB}"
  psql "$DB_URL" -v ON_ERROR_STOP=1 -q \
    -v owner="$OWNER_ROLE" -v app="$APP_ROLE" \
    -f "$(dirname "$0")/grant-app-role.sql"
  echo "Configured database ${DB}"
done

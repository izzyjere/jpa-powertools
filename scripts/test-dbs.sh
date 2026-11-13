#!/usr/bin/env bash
# Starts, seeds and stops the databases used by `npm run test:db` and the VS Code integration tests.
#
#   scripts/test-dbs.sh up   [pg mysql maria mssql oracle db2]   # default: all but db2
#   scripts/test-dbs.sh down [names…]
#
# Ports match src/test/db/dialects.test.ts. Requires Docker. Db2 needs --privileged and takes ~5–10 minutes.
set -euo pipefail
cd "$(dirname "$0")/.."
export MSYS_NO_PATHCONV=1 # Git Bash on Windows: keep container paths as-is

cmd="${1:-up}"
shift || true
dbs=("$@")
if [ ${#dbs[@]} -eq 0 ]; then
  dbs=(pg mysql maria mssql oracle)
fi

start() {
  local name=$1
  shift
  if docker ps -a --format '{{.Names}}' | grep -qx "$name"; then
    docker start "$name" >/dev/null
  else
    docker run -d --name "$name" "$@" >/dev/null
  fi
}

# wait_for <label> <timeout-seconds> <command…>
wait_for() {
  local label=$1 timeout=$2
  shift 2
  local start_ts=$SECONDS
  printf 'Waiting for %s' "$label"
  until "$@" >/dev/null 2>&1; do
    if (( SECONDS - start_ts > timeout )); then
      echo " timed out after ${timeout}s"
      return 1
    fi
    printf '.'
    sleep 3
  done
  echo " ready ($(( SECONDS - start_ts ))s)"
}

up_pg() {
  start jpt-pg -e POSTGRES_PASSWORD=secret -e POSTGRES_DB=shop -p 55432:5432 postgres:16-alpine
  wait_for PostgreSQL 180 docker exec jpt-pg psql -U postgres -d shop -h 127.0.0.1 -c 'select 1'
  docker exec -i jpt-pg psql -q -U postgres -d shop -v ON_ERROR_STOP=1 < test-db/postgres.sql
}

up_mysql() {
  start jpt-mysql -e MYSQL_ROOT_PASSWORD=secret -e MYSQL_DATABASE=shop -p 53306:3306 mysql:8.4
  wait_for MySQL 300 docker exec jpt-mysql mysql -h127.0.0.1 --protocol=tcp -uroot -psecret -e 'select 1' shop
  docker exec -i jpt-mysql mysql -h127.0.0.1 --protocol=tcp -uroot -psecret < test-db/mysql.sql
}

up_maria() {
  start jpt-maria -e MARIADB_ROOT_PASSWORD=secret -e MARIADB_DATABASE=shop -p 53307:3306 mariadb:11.4
  wait_for MariaDB 300 docker exec jpt-maria mariadb -h127.0.0.1 --protocol=tcp -uroot -psecret -e 'select 1' shop
  docker exec -i jpt-maria mariadb -h127.0.0.1 --protocol=tcp -uroot -psecret < test-db/mysql.sql
}

up_mssql() {
  start jpt-mssql -e ACCEPT_EULA=Y -e 'MSSQL_SA_PASSWORD=Secret#2026' -p 51433:1433 mcr.microsoft.com/mssql/server:2022-latest
  wait_for 'SQL Server' 300 docker exec jpt-mssql /opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa -P 'Secret#2026' -Q 'select 1'
  docker cp test-db/sqlserver.sql jpt-mssql:/tmp/seed.sql
  docker exec jpt-mssql /opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa -P 'Secret#2026' -b -i /tmp/seed.sql
}

up_oracle() {
  start jpt-oracle -e ORACLE_PASSWORD=secret -e APP_USER=shop -e APP_USER_PASSWORD=secret -p 51521:1521 gvenzl/oracle-free:23-slim-faststart
  # Query the database: container logs survive restarts, so a log line can be stale.
  wait_for Oracle 600 sh -c 'echo "select 1 from dual;" | docker exec -i jpt-oracle sqlplus -s -L shop/secret@//localhost/FREEPDB1 | grep -q "^[[:space:]]*1$"'
  # Re-seeding: drop existing objects first so the script is idempotent.
  { echo 'whenever sqlerror continue'
    echo 'begin for t in (select table_name from user_tables) loop execute immediate '"'"'drop table "'"'"' || t.table_name || '"'"'" cascade constraints purge'"'"'; end loop; end;'
    echo '/'
    echo 'drop view order_summary;'
    echo 'whenever sqlerror exit failure'
    cat test-db/oracle.sql; } | docker exec -i jpt-oracle sqlplus -s shop/secret@//localhost/FREEPDB1
}

up_db2() {
  start jpt-db2 --privileged -e LICENSE=accept -e DB2INST1_PASSWORD=secret -e DBNAME=SHOP -e SAMPLEDB=false -e ARCHIVE_LOGS=false -e AUTOCONFIG=false -p 55000:50000 icr.io/db2_community/db2:11.5.9.0
  wait_for Db2 900 docker exec jpt-db2 su - db2inst1 -c 'db2 connect to SHOP'
  local existing
  existing=$(docker exec jpt-db2 su - db2inst1 -c "db2 connect to SHOP >/dev/null && db2 -x \"select count(*) from syscat.tables where tabschema = 'DB2INST1' and tabname = 'CUSTOMERS'\"" | tr -d '[:space:]')
  if [ "$existing" = "1" ]; then
    echo 'Db2 schema already seeded'
    return
  fi
  docker cp test-db/db2.sql jpt-db2:/tmp/seed.sql
  # db2 CLP exit codes: 1 = no rows, 2 = warning, 4 = SQL error, 8 = system error.
  local rc=0
  docker exec jpt-db2 su - db2inst1 -c 'db2 connect to SHOP >/dev/null && db2 -tvf /tmp/seed.sql' >/dev/null || rc=$?
  if [ "$rc" -ge 4 ]; then
    echo "Seeding Db2 failed (exit $rc)" >&2
    return 1
  fi
}

case "$cmd" in
  up)
    for db in "${dbs[@]}"; do
      "up_$db"
    done
    ;;
  down)
    for db in "${dbs[@]}"; do
      docker rm -f "jpt-$db" >/dev/null 2>&1 || true
    done
    ;;
  *)
    echo "usage: $0 up|down [pg mysql maria mssql oracle db2]" >&2
    exit 2
    ;;
esac

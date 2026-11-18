#!/usr/bin/env bash
set -euo pipefail
umask 077
fixture=$(cd -- "$(dirname -- "$0")" && pwd)
project=backend-next-cutover-smoke-$(date +%s)-$$
artifacts=$(mktemp -d /tmp/backend-next-cutover-smoke.XXXXXX)
compose() { docker compose -p "$project" -f "$fixture/compose.yml" "$@"; }
cleanup() {
  compose --profile '*' down -v --remove-orphans > /dev/null 2>&1
  rm -rf -- "$artifacts"
}
trap cleanup EXIT
compose up -d --wait postgres redis redis-pubsub redis-jobs redis-timelines redis-reactions storage
compose run --rm probe
compose exec -T postgres psql -U postgres -d cutover -v ON_ERROR_STOP=1 <<'SQL'
CREATE TABLE recovery_marker(id integer PRIMARY KEY, value text NOT NULL);
INSERT INTO recovery_marker VALUES (1, 'before');
SQL
for service in redis redis-pubsub redis-jobs redis-timelines redis-reactions; do
  compose exec -T "$service" redis-cli SET cutover-marker before > /dev/null
  compose exec -T "$service" redis-cli -n 1 SET other-db-marker before > /dev/null
done
compose exec -T storage sh -c 'printf before > /data/marker'
# One-off writers count as running processes too, even outside `compose up`.
export CUTOVER_CANDIDATE_IMAGE=node:24.22.3-trixie
compose run --name "$project-writer" -d candidate node -e 'setInterval(() => {}, 1000)' > /dev/null
if bash "$fixture/snapshot.sh" "$project" backup "$artifacts/unsafe"; then
  echo 'running candidate was not refused' >&2
  exit 1
fi
compose stop candidate
# stop also covers the one-off candidate; remove it to avoid reusing it below.
docker rm -f "$project-writer" > /dev/null
bash "$fixture/snapshot.sh" "$project" backup "$artifacts/stopped"
# Simulate an upstream change committed before a later internal transaction fails.
compose exec -T postgres psql -U postgres -d cutover -v ON_ERROR_STOP=1 -c 'CREATE TABLE committed_migration(id integer)'
if compose exec -T postgres psql -U postgres -d cutover -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
UPDATE recovery_marker SET value = 'partial';
SELECT 1/0;
COMMIT;
SQL
then
  echo 'controlled migration failure did not fail' >&2
  exit 1
fi
bash "$fixture/snapshot.sh" "$project" restore "$artifacts/stopped"
[[ $(compose exec -T postgres psql -U postgres -d cutover -Atc "SELECT to_regclass('committed_migration') IS NULL") == t ]]
# Simulate newer application writes and lost/replaced Redis work and storage objects.
compose exec -T postgres psql -U postgres -d cutover -v ON_ERROR_STOP=1 -c "UPDATE recovery_marker SET value='after'"
for service in redis redis-pubsub redis-jobs redis-timelines redis-reactions; do
  compose exec -T "$service" redis-cli SET cutover-marker after > /dev/null
  compose exec -T "$service" redis-cli -n 1 DEL other-db-marker > /dev/null
done
compose exec -T storage sh -c 'printf after > /data/marker; printf newer > /data/extra'
bash "$fixture/snapshot.sh" "$project" restore "$artifacts/stopped"
[[ $(compose exec -T postgres psql -U postgres -d cutover -Atc 'SELECT value FROM recovery_marker WHERE id=1') == before ]]
for service in redis redis-pubsub redis-jobs redis-timelines redis-reactions; do
  [[ $(compose exec -T "$service" redis-cli --raw GET cutover-marker) == before ]]
  [[ $(compose exec -T "$service" redis-cli -n 1 --raw GET other-db-marker) == before ]]
done
[[ $(compose exec -T storage cat /data/marker) == before ]]
compose exec -T storage test ! -e /data/extra
# A shortened manifest plus a missing archive must be refused before dropdb.
cp "$artifacts/stopped/SHA256SUMS" "$artifacts/original-sums"
cp "$artifacts/stopped/postgres.dump" "$artifacts/original-dump"
sed '/postgres.dump$/d' "$artifacts/original-sums" > "$artifacts/stopped/SHA256SUMS"
rm "$artifacts/stopped/postgres.dump"
compose exec -T postgres psql -U postgres -d cutover -v ON_ERROR_STOP=1 -c "UPDATE recovery_marker SET value='retain-on-invalid-backup'"
if bash "$fixture/snapshot.sh" "$project" restore "$artifacts/stopped"; then
  echo 'incomplete snapshot was not refused' >&2
  exit 1
fi
[[ $(compose exec -T postgres psql -U postgres -d cutover -Atc 'SELECT value FROM recovery_marker WHERE id=1') == retain-on-invalid-backup ]]
cp "$artifacts/original-sums" "$artifacts/stopped/SHA256SUMS"
cp "$artifacts/original-dump" "$artifacts/stopped/postgres.dump"
# Unexpected storage contents also invalidate the saved inventory.
printf newer > "$artifacts/stopped/storage/unexpected"
if bash "$fixture/snapshot.sh" "$project" restore "$artifacts/stopped"; then
  echo 'changed storage inventory was not refused' >&2
  exit 1
fi
[[ $(compose exec -T postgres psql -U postgres -d cutover -Atc 'SELECT value FROM recovery_marker WHERE id=1') == retain-on-invalid-backup ]]
rm "$artifacts/stopped/storage/unexpected"
# Corrupt backup contents must be refused before touching any dependency.
printf corrupted >> "$artifacts/stopped/redis-jobs.rdb"
compose exec -T postgres psql -U postgres -d cutover -v ON_ERROR_STOP=1 -c "UPDATE recovery_marker SET value='retain-on-invalid-backup'"
if bash "$fixture/snapshot.sh" "$project" restore "$artifacts/stopped"; then
  echo 'corrupt snapshot was not refused' >&2
  exit 1
fi
[[ $(compose exec -T postgres psql -U postgres -d cutover -Atc 'SELECT value FROM recovery_marker WHERE id=1') == retain-on-invalid-backup ]]
printf '%s\n' CUTOVER_FIXTURE_RECOVERY_OK

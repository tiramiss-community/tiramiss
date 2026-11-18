#!/usr/bin/env bash
# Only operate on this synthetic fixture; the production runbook uses operator-owned backup tooling.
set -euo pipefail
umask 077
if [[ $# != 3 || ! $1 =~ ^backend-next-cutover-[a-z0-9-]+$ || ( $2 != backup && $2 != restore ) || $3 != /* ]]; then
  echo 'usage: snapshot.sh backend-next-cutover-<id> backup|restore /absolute/snapshot-directory' >&2
  exit 1
fi
project=$1
operation=$2
snapshot=$3
fixture=$(cd -- "$(dirname -- "$0")" && pwd)
compose() { docker compose -p "$project" -f "$fixture/compose.yml" "$@"; }
redis_services=(redis redis-pubsub redis-jobs redis-timelines redis-reactions)
snapshot_manifest() {
  local files=(postgres.dump)
  local service file
  for service in "${redis_services[@]}"; do
    files+=("$service.rdb")
  done
  for file in "${files[@]}"; do
    [[ -f "$snapshot/$file" && ! -L "$snapshot/$file" ]] || return 1
  done
  [[ -d "$snapshot/storage" && ! -L "$snapshot/storage" ]] || return 1
  (cd "$snapshot" && find "${files[@]}" storage -type f -print0 | sort -z | xargs -0 sha256sum)
}
# This also sees profile services; migration/HTTP/worker/producer containers must have exited.
running=$(docker ps --filter "label=com.docker.compose.project=$project" --format '{{.Label "com.docker.compose.service"}}')
while read -r service; do
  case "$service" in
    ''|postgres|redis|redis-pubsub|redis-jobs|redis-timelines|redis-reactions|storage) ;;
    *) echo 'STOP_ALL_CANDIDATE_PROCESSES_FIRST' >&2; exit 1 ;;
  esac
done <<< "$running"
if [[ $operation == backup ]]; then
  mkdir -- "$snapshot"
  compose exec -T postgres pg_dump -U postgres -d cutover -Fc > "$snapshot/postgres.dump"
  for service in "${redis_services[@]}"; do
    compose exec -T "$service" redis-cli --rdb /tmp/cutover.rdb > /dev/null
    compose cp "$service:/tmp/cutover.rdb" "$snapshot/$service.rdb" > /dev/null
  done
  mkdir "$snapshot/storage"
  compose cp storage:/data/. "$snapshot/storage/" > /dev/null
  snapshot_manifest > "$snapshot/SHA256SUMS"
  printf '%s\n' "$project" > "$snapshot/COMPLETE"
else
  [[ $(cat "$snapshot/COMPLETE") == "$project" ]]
  # Recompute the full inventory: a shortened checksum file must not authorize a partial restore.
  manifest=$(snapshot_manifest)
  [[ $(cat "$snapshot/SHA256SUMS") == "$manifest" ]] || { echo 'SNAPSHOT_MANIFEST_MISMATCH' >&2; exit 1; }
  # A stopped application is required even though the fixture dependencies stay available.
  compose exec -T postgres dropdb -U postgres --if-exists cutover
  compose exec -T postgres createdb -U postgres cutover
  compose exec -T postgres pg_restore -U postgres -d cutover --exit-on-error < "$snapshot/postgres.dump"
  compose stop "${redis_services[@]}" storage
  for service in "${redis_services[@]}"; do
    compose run --rm --no-deps -T -v "$snapshot:/snapshot:ro" --entrypoint sh "$service" -c "cp /snapshot/$service.rdb /data/dump.rdb"
  done
  # Replace fixture storage, rather than merging files created after the recovery point.
  compose run --rm --no-deps -T -v "$snapshot/storage:/snapshot:ro" --entrypoint sh storage -c 'find /data -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; cp -a /snapshot/. /data/'
  compose up -d --wait postgres "${redis_services[@]}" storage
fi

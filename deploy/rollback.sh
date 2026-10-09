#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/11scat-web}"
ENV_FILE="${ENV_FILE:-$APP_DIR/identity.env}"
DATA_DIR="${DATA_DIR:-/opt/11scat-data}"
STATE_FILE="$APP_DIR/deploy-state"
CONTAINER="11scat-web"
CANDIDATE="11scat-web-candidate"

if [[ ! -f "$STATE_FILE" ]]; then
  echo "No deployment state is available for rollback." >&2
  exit 2
fi

# deploy-state contains image references only; identity.env is never sourced.
# shellcheck disable=SC1090
source "$STATE_FILE"
: "${CURRENT_IMAGE:?Missing CURRENT_IMAGE in deploy-state}"
: "${PREVIOUS_IMAGE:?Missing PREVIOUS_IMAGE in deploy-state}"

case "$CURRENT_IMAGE" in 11scat-web:*|ghcr.io/yuumi-11/11scat-web:*|ghcr.io/yuumiqwq/11scat-web:*) ;; *) echo "Unsafe current image reference" >&2; exit 3;; esac
case "$PREVIOUS_IMAGE" in 11scat-web:*|ghcr.io/yuumi-11/11scat-web:*|ghcr.io/yuumiqwq/11scat-web:*) ;; *) echo "Unsafe previous image reference" >&2; exit 3;; esac

health_check() {
  local url="$1"
  for (( attempt=1; attempt<=30; attempt++ )); do
    curl --fail --silent --show-error --max-time 4 "$url" >/dev/null && return 0
    sleep 2
  done
  return 1
}

run_container() {
  local name="$1" image="$2" port="$3" restart="$4"
  docker run -d --name "$name" --env-file "$ENV_FILE" \
    --mount "type=bind,src=$DATA_DIR,dst=/data" \
    --publish "127.0.0.1:$port:3000" --restart "$restart" \
    --log-driver json-file --log-opt max-size=20m --log-opt max-file=3 \
    --label com.11scat.deployed-image="$image" \
    "$image" >/dev/null
}

docker image inspect "$PREVIOUS_IMAGE" >/dev/null
docker rm -f "$CANDIDATE" >/dev/null 2>&1 || true
trap 'docker rm -f "$CANDIDATE" >/dev/null 2>&1 || true' EXIT
run_container "$CANDIDATE" "$PREVIOUS_IMAGE" 3101 no
health_check "http://127.0.0.1:3101/access"
docker rm -f "$CANDIDATE" >/dev/null
trap - EXIT

docker stop --time 20 "$CONTAINER" >/dev/null
docker rm "$CONTAINER" >/dev/null
if ! run_container "$CONTAINER" "$PREVIOUS_IMAGE" 3100 unless-stopped \
  || ! health_check "http://127.0.0.1:3100/access" \
  || ! health_check "https://study.11scat.xyz/access"; then
  echo "Rollback target failed verification; restoring $CURRENT_IMAGE" >&2
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  if ! run_container "$CONTAINER" "$CURRENT_IMAGE" 3100 unless-stopped \
    || ! health_check "http://127.0.0.1:3100/access"; then
    echo "Restoring $CURRENT_IMAGE failed; manual recovery is required." >&2
    exit 5
  fi
  exit 4
fi

cat > "$STATE_FILE" <<EOF
CURRENT_IMAGE=$PREVIOUS_IMAGE
PREVIOUS_IMAGE=$CURRENT_IMAGE
CURRENT_VERSION=rollback
EOF
chmod 600 "$STATE_FILE"
echo "Rollback complete: $PREVIOUS_IMAGE"

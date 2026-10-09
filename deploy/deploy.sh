#!/usr/bin/env bash
set -Eeuo pipefail

IMAGE_REPOSITORY="${IMAGE_REPOSITORY:-ghcr.io/yuumiqwq/11scat-web}"
VERSION="${1:-}"
APP_DIR="${APP_DIR:-/opt/11scat-web}"
ENV_FILE="${ENV_FILE:-$APP_DIR/identity.env}"
DATA_DIR="${DATA_DIR:-/opt/11scat-data}"
STATE_FILE="$APP_DIR/deploy-state"
CONTAINER="11scat-web"
CANDIDATE="11scat-web-candidate"
PUBLIC_PORT="3100"
CANDIDATE_PORT="3101"
HEALTH_PATH="/access"

if [[ ! "$VERSION" =~ ^[0-9a-f]{7,40}$ ]]; then
  echo "Usage: $0 <git-commit-sha>" >&2
  exit 2
fi
if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing protected environment file: $ENV_FILE" >&2
  exit 3
fi
if [[ ! -d "$DATA_DIR" ]]; then
  echo "Missing persistent data directory: $DATA_DIR" >&2
  exit 4
fi

TARGET_IMAGE="$IMAGE_REPOSITORY:$VERSION"
CANDIDATE_STARTED=0

cleanup_candidate() {
  if (( CANDIDATE_STARTED )); then
    docker rm -f "$CANDIDATE" >/dev/null 2>&1 || true
  fi
}
trap cleanup_candidate EXIT

health_check() {
  local url="$1"
  local attempts="${2:-30}"
  for (( attempt=1; attempt<=attempts; attempt++ )); do
    if curl --fail --silent --show-error --max-time 4 "$url" >/dev/null \
      && curl --fail --silent --show-error --max-time 4 "${url%/access}/api/access/runtime" >/dev/null; then
      return 0
    fi
    sleep 2
  done
  return 1
}

run_container() {
  local name="$1" image="$2" port="$3" restart="$4"
  docker run -d \
    --name "$name" \
    --env-file "$ENV_FILE" \
    --mount "type=bind,src=$DATA_DIR,dst=/data" \
    --publish "127.0.0.1:$port:3000" \
    --restart "$restart" \
    --log-driver json-file \
    --log-opt max-size=20m \
    --log-opt max-file=3 \
    --label com.11scat.deployed-image="$image" \
    "$image" >/dev/null
}

assert_data_mount() {
  local name="$1"
  local mount
  mount="$(docker inspect "$name" --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}|{{.RW}}{{end}}{{end}}')"
  [[ "$mount" == "$DATA_DIR|true" ]] || {
    echo "Data mount verification failed for $name: $mount" >&2
    return 1
  }
}

remove_stopped_app_containers() {
  while IFS= read -r name; do
    case "$name" in
      11scat-web-before-*|11scat-web-rollback-*|11scat-web-broken-*|11scat-web-candidate*)
        if [[ "$(docker inspect "$name" --format '{{.State.Running}}')" == "false" ]]; then
          docker rm "$name" >/dev/null
        fi
        ;;
    esac
  done < <(docker ps -a --format '{{.Names}}')
}

remove_old_app_images() {
  local current_id="$1" previous_id="$2"
  while IFS='|' read -r ref id; do
    [[ -n "$ref" && "$ref" != *':<none>' ]] || continue
    case "$ref" in
      11scat-web:*|"$IMAGE_REPOSITORY":*)
        id="$(docker image inspect "$ref" --format '{{.Id}}' 2>/dev/null || true)"
        if [[ "$id" != "$current_id" && "$id" != "$previous_id" ]]; then
          docker image rm "$ref" >/dev/null 2>&1 || true
        fi
        ;;
    esac
  done < <(docker images --format '{{.Repository}}:{{.Tag}}|{{.ID}}')
}

remove_scoped_build_artifacts() {
  find /tmp -maxdepth 1 -mindepth 1 -name '11scat-*' -exec rm -rf -- {} +
  find "$APP_DIR" -maxdepth 1 -mindepth 1 \
    \( -name 'deploy-*.tgz' -o -name 'release-*' -o -name '.next' \) \
    -exec rm -rf -- {} +
}

mkdir -p "$APP_DIR"
"$APP_DIR/check-disk.sh" --before-deploy

CURRENT_IMAGE="$(docker inspect "$CONTAINER" --format '{{.Config.Image}}' 2>/dev/null || true)"
if [[ -z "$CURRENT_IMAGE" ]]; then
  echo "The current $CONTAINER container is missing; refusing an unattended first deployment." >&2
  exit 5
fi

echo "Pulling $TARGET_IMAGE"
docker pull "$TARGET_IMAGE"

docker rm -f "$CANDIDATE" >/dev/null 2>&1 || true
run_container "$CANDIDATE" "$TARGET_IMAGE" "$CANDIDATE_PORT" "no"
CANDIDATE_STARTED=1
assert_data_mount "$CANDIDATE"
health_check "http://127.0.0.1:$CANDIDATE_PORT$HEALTH_PATH" 30

echo "Candidate passed; switching the production container."
docker stop --time 20 "$CONTAINER" >/dev/null
docker rm "$CONTAINER" >/dev/null
docker rm -f "$CANDIDATE" >/dev/null
CANDIDATE_STARTED=0

if ! run_container "$CONTAINER" "$TARGET_IMAGE" "$PUBLIC_PORT" "unless-stopped"; then
  echo "New container failed to start; restoring $CURRENT_IMAGE" >&2
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  run_container "$CONTAINER" "$CURRENT_IMAGE" "$PUBLIC_PORT" "unless-stopped"
  exit 6
fi

if ! assert_data_mount "$CONTAINER" \
  || ! health_check "http://127.0.0.1:$PUBLIC_PORT$HEALTH_PATH" 30 \
  || ! health_check "https://study.11scat.xyz$HEALTH_PATH" 15; then
  echo "Production verification failed; restoring $CURRENT_IMAGE" >&2
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  run_container "$CONTAINER" "$CURRENT_IMAGE" "$PUBLIC_PORT" "unless-stopped"
  health_check "http://127.0.0.1:$PUBLIC_PORT$HEALTH_PATH" 30 || true
  exit 7
fi

CURRENT_ID="$(docker image inspect "$TARGET_IMAGE" --format '{{.Id}}')"
PREVIOUS_ID="$(docker image inspect "$CURRENT_IMAGE" --format '{{.Id}}')"
cat > "$STATE_FILE" <<EOF
CURRENT_IMAGE=$TARGET_IMAGE
PREVIOUS_IMAGE=$CURRENT_IMAGE
CURRENT_VERSION=$VERSION
EOF
chmod 600 "$STATE_FILE"

remove_stopped_app_containers
remove_old_app_images "$CURRENT_ID" "$PREVIOUS_ID"
remove_scoped_build_artifacts

echo "Deployment complete: $TARGET_IMAGE"
"$APP_DIR/check-disk.sh"
df -h /
docker system df

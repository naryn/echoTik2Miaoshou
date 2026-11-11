#!/usr/bin/env bash
# 发布服务端代码和 Chrome 插件包；不会接触远端 SQLite 数据库。
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_HOST="${DEPLOY_HOST:-ops@myblog}"
REMOTE_DIR="${REMOTE_DIR:-/opt/mx-pop-pricing}"
SERVICE_NAME="${SERVICE_NAME:-mx-pop-pricing}"
SKIP_TESTS=false

if [[ "${1:-}" == "--skip-tests" ]]; then
  SKIP_TESTS=true
elif [[ $# -gt 0 ]]; then
  echo "Usage: $0 [--skip-tests]" >&2
  exit 2
fi

command -v rsync >/dev/null
command -v ssh >/dev/null
command -v zip >/dev/null
command -v unzip >/dev/null

if ! $SKIP_TESTS; then
  (cd "$ROOT_DIR/server" && .venv/bin/python -m pytest -q)
  (cd "$ROOT_DIR/extension" && npm run typecheck)
fi

(cd "$ROOT_DIR/extension" && npm run build)
VERSION="$(node -p "require('$ROOT_DIR/extension/package.json').version")"
ARCHIVE_NAME="echotik-miaoshou-collector-${VERSION}-chrome.zip"
ARCHIVE_DIR="$(mktemp -d -t echotik-plugin)"
ARCHIVE_PATH="$ARCHIVE_DIR/$ARCHIVE_NAME"
trap 'rm -rf "$ARCHIVE_DIR"' EXIT
(cd "$ROOT_DIR/extension/.output/chrome-mv3" && zip -qr "$ARCHIVE_PATH" .)
unzip -tq "$ARCHIVE_PATH" >/dev/null

# 不使用 --delete：远端 app/data 可能保存已上传图片，不能被发布流程误删。
rsync -az --exclude='__pycache__/' --exclude='*.pyc' --exclude='static/plugins/' \
  "$ROOT_DIR/server/app/" "$DEPLOY_HOST:$REMOTE_DIR/app/"
rsync -az "$ROOT_DIR/server/requirements.txt" "$ROOT_DIR/server/Dockerfile" "$DEPLOY_HOST:$REMOTE_DIR/"
rsync -az "$ARCHIVE_PATH" "$DEPLOY_HOST:$REMOTE_DIR/app/static/plugins/$ARCHIVE_NAME"

ssh "$DEPLOY_HOST" "set -e; cd $REMOTE_DIR; .venv/bin/pip install -r requirements.txt; sudo -i bash -lc 'set -e; systemctl restart $SERVICE_NAME; systemctl is-active --quiet $SERVICE_NAME; for attempt in {1..15}; do curl -fsS http://127.0.0.1:8010/healthz >/dev/null 2>&1 && break; sleep 1; done; curl -fsS http://127.0.0.1:8010/healthz; echo; curl -fsS http://127.0.0.1:8010/v1/plugin-update; echo; test -s $REMOTE_DIR/app/static/plugins/$ARCHIVE_NAME'"

echo "发布完成:${DEPLOY_HOST}:${REMOTE_DIR} 插件包:${ARCHIVE_NAME}"

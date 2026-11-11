#!/usr/bin/env bash
# 在新服务器完成首次目录和 systemd 服务安装，然后调用常规发布流程。
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_HOST="${DEPLOY_HOST:-ops@myblog}"
REMOTE_DIR="${REMOTE_DIR:-/opt/mx-pop-pricing}"
SERVICE_NAME="${SERVICE_NAME:-mx-pop-pricing}"
UNIT_FILE="$ROOT_DIR/deploy/systemd/$SERVICE_NAME.service"

ssh "$DEPLOY_HOST" "sudo -i bash -lc 'install -d -o ops -g ops $REMOTE_DIR/app/static/plugins /var/lib/$SERVICE_NAME; chown -R ops:ops $REMOTE_DIR /var/lib/$SERVICE_NAME'"
scp "$UNIT_FILE" "$DEPLOY_HOST:/tmp/$SERVICE_NAME.service"
ssh "$DEPLOY_HOST" "sudo -i bash -lc 'install -m 0644 /tmp/$SERVICE_NAME.service /etc/systemd/system/$SERVICE_NAME.service; rm -f /tmp/$SERVICE_NAME.service; systemctl daemon-reload; systemctl enable $SERVICE_NAME'"
"$ROOT_DIR/deploy/update.sh" "$@"

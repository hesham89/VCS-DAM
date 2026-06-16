#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/atm-vcs}"
SERVICE_USER="${SERVICE_USER:-atm-vcs}"
SERVICE_FILE="/etc/systemd/system/atm-vcs.service"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root: sudo $0"
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required. Install Node.js 20 LTS or newer first."
  exit 1
fi

id "${SERVICE_USER}" >/dev/null 2>&1 || useradd --system --home "${APP_DIR}" --shell /usr/sbin/nologin "${SERVICE_USER}"
mkdir -p "${APP_DIR}/logs"

rsync -a --exclude logs --exclude node_modules --exclude .git ./ "${APP_DIR}/"
chown -R "${SERVICE_USER}:${SERVICE_USER}" "${APP_DIR}"
install -m 0644 "${APP_DIR}/deploy/atm-vcs.service" "${SERVICE_FILE}"

systemctl daemon-reload
systemctl enable atm-vcs.service
systemctl restart atm-vcs.service
systemctl status atm-vcs.service --no-pager

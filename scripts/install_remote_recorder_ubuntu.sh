#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/atm-recorder}"
SERVICE_USER="${SERVICE_USER:-atm-recorder}"
SERVICE_NAME="atm-remote-recorder.service"
NODE_MAJOR_MIN="${NODE_MAJOR_MIN:-20}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run from the project folder with sudo:"
  echo "  sudo bash ./scripts/install_remote_recorder_ubuntu.sh"
  exit 1
fi

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${PROJECT_DIR}"

apt-get update
apt-get install -y ca-certificates curl gnupg rsync ffmpeg

install_nodejs() {
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL "https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key" \
    | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR_MIN}.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update
  apt-get install -y nodejs
}

if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
  if [[ "${NODE_MAJOR}" -lt "${NODE_MAJOR_MIN}" ]]; then
    install_nodejs
  fi
else
  install_nodejs
fi

if ! id "${SERVICE_USER}" >/dev/null 2>&1; then
  useradd --system --home "${APP_DIR}" --shell /usr/sbin/nologin "${SERVICE_USER}"
fi

mkdir -p "${APP_DIR}/logs" "${APP_DIR}/remote-recordings" "${APP_DIR}/remote-recordings/exports"
rsync -a atm_remote_recorder.mjs package.json "${APP_DIR}/"
install -m 0644 deploy/atm-remote-recorder.service "/etc/systemd/system/${SERVICE_NAME}"
chown -R "${SERVICE_USER}:${SERVICE_USER}" "${APP_DIR}"

systemctl daemon-reload
systemctl enable "${SERVICE_NAME}"
systemctl restart "${SERVICE_NAME}"
sleep 2
systemctl --no-pager --full status "${SERVICE_NAME}" || true

SERVER_IP="$(hostname -I | awk '{print $1}')"
echo
echo "ATM remote recorder is installed."
echo "UDP ingest: ${SERVER_IP:-SERVER_IP}:45000"
echo "Health:     http://${SERVER_IP:-SERVER_IP}:45080/api/health"
echo "Recordings: http://${SERVER_IP:-SERVER_IP}:45080/api/recordings"

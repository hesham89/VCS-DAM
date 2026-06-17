#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/atm-local-recorder}"
REC_DIR="${REC_DIR:-/recordings/atm-vcs}"
SERVICE_USER="${SERVICE_USER:-atm-recorder}"
SERVICE_NAME="atm-local-recorder.service"
NODE_MAJOR_MIN="${NODE_MAJOR_MIN:-20}"
VCS_WS_URL="${VCS_WS_URL:-wss://5.1.1.243:3443/ws}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run from the project folder with sudo:"
  echo "  sudo bash ./scripts/install_local_recorder_ubuntu.sh"
  exit 1
fi

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${PROJECT_DIR}"

apt-get update
apt-get install -y ca-certificates curl gnupg rsync ffmpeg openssl

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

mkdir -p "${APP_DIR}/logs" "${REC_DIR}/audio" "${REC_DIR}/certs"
rsync -a atm_local_recorder.mjs package.json "${APP_DIR}/"
install -m 0644 deploy/atm-local-recorder.service "/etc/systemd/system/${SERVICE_NAME}"
sed -i "s#Environment=LOCAL_RECORDER_DIR=.*#Environment=LOCAL_RECORDER_DIR=${REC_DIR}#" "/etc/systemd/system/${SERVICE_NAME}"
sed -i "s#Environment=VCS_WS_URL=.*#Environment=VCS_WS_URL=${VCS_WS_URL}#" "/etc/systemd/system/${SERVICE_NAME}"

if [[ ! -f "${REC_DIR}/certs/recorder.key" || ! -f "${REC_DIR}/certs/recorder.crt" ]]; then
  openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout "${REC_DIR}/certs/recorder.key" \
    -out "${REC_DIR}/certs/recorder.crt" \
    -days 3650 \
    -subj "/CN=$(hostname -I | awk '{print $1}')" \
    -addext "subjectAltName=IP:$(hostname -I | awk '{print $1}'),DNS:$(hostname)"
fi

chown -R "${SERVICE_USER}:${SERVICE_USER}" "${APP_DIR}" "${REC_DIR}"
chmod 0750 "${REC_DIR}" "${REC_DIR}/audio" "${REC_DIR}/certs"
chmod 0640 "${REC_DIR}/certs/recorder.key" "${REC_DIR}/certs/recorder.crt"

systemctl daemon-reload
systemctl enable "${SERVICE_NAME}"
systemctl restart "${SERVICE_NAME}"
sleep 2
systemctl --no-pager --full status "${SERVICE_NAME}" || true

SERVER_IP="$(hostname -I | awk '{print $1}')"
echo
echo "ATM local recorder is installed."
echo "UI:     https://${SERVER_IP:-SERVER_IP}:8443/"
echo "Health: http://${SERVER_IP:-SERVER_IP}:8080/api/health"
echo "Store:  ${REC_DIR}"

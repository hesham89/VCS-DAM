#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/atm-vcs}"
SERVICE_USER="${SERVICE_USER:-atm-vcs}"
SERVICE_NAME="atm-vcs.service"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}"
NODE_MAJOR_MIN="${NODE_MAJOR_MIN:-20}"
PORT="${PORT:-3000}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this from the project folder with sudo:"
  echo "  sudo bash ./run_ubuntu.sh"
  exit 1
fi

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${PROJECT_DIR}"

echo "[1/7] Installing required Ubuntu packages..."
apt-get update
apt-get install -y ca-certificates curl gnupg rsync ffmpeg

install_nodejs() {
  echo "Installing Node.js ${NODE_MAJOR_MIN}.x from NodeSource..."
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL "https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key" \
    | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR_MIN}.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update
  apt-get install -y nodejs
}

echo "[2/7] Checking Node.js..."
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
  if [[ "${NODE_MAJOR}" -lt "${NODE_MAJOR_MIN}" ]]; then
    install_nodejs
  fi
else
  install_nodejs
fi
node --version

echo "[3/7] Preparing service user and app folder..."
if ! id "${SERVICE_USER}" >/dev/null 2>&1; then
  useradd --system --home "${APP_DIR}" --shell /usr/sbin/nologin "${SERVICE_USER}"
fi
mkdir -p "${APP_DIR}/logs" "${APP_DIR}/recordings" "${APP_DIR}/recordings/exports"

echo "[4/7] Copying project to ${APP_DIR}..."
rsync -a \
  --exclude ".git" \
  --exclude "node_modules" \
  --exclude "logs/*" \
  --exclude "recordings/*.pcma" \
  --exclude "recordings/exports/*" \
  --exclude "prototype-backup-*" \
  --exclude "vcshusam-backups" \
  "${PROJECT_DIR}/" "${APP_DIR}/"
chown -R "${SERVICE_USER}:${SERVICE_USER}" "${APP_DIR}"

if ss -ltn "sport = :${PORT}" | grep -q ":${PORT}"; then
  if [[ "${PORT}" == "3000" ]] && ! ss -ltn "sport = :3001" | grep -q ":3001"; then
    echo "Port 3000 is already in use; using PORT=3001 for ATM VCS."
    PORT=3001
  else
    echo "Port ${PORT} is already in use. Set another port, for example: sudo PORT=3001 bash ./run_ubuntu.sh"
    exit 1
  fi
fi

echo "[5/7] Writing systemd service..."
cat > "${SERVICE_FILE}" <<EOF
[Unit]
Description=ATM VCS Jotron VoIP Service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${APP_DIR}
Environment=HOST=0.0.0.0
Environment=PORT=${PORT}
ExecStart=/usr/bin/node ${APP_DIR}/atm_vcs_server.mjs
Restart=always
RestartSec=3
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=${APP_DIR}
StandardOutput=append:${APP_DIR}/logs/service.out.log
StandardError=append:${APP_DIR}/logs/service.err.log

[Install]
WantedBy=multi-user.target
EOF

echo "[6/7] Starting service..."
systemctl daemon-reload
systemctl enable "${SERVICE_NAME}"
systemctl restart "${SERVICE_NAME}"
sleep 2

echo "[7/7] Service status..."
systemctl --no-pager --full status "${SERVICE_NAME}" || true

if ! systemctl is-active --quiet "${SERVICE_NAME}"; then
  echo
  echo "Service did not become active. Recent logs:"
  journalctl -u "${SERVICE_NAME}" -n 80 --no-pager || true
  echo
  echo "Service stderr log:"
  tail -n 120 "${APP_DIR}/logs/service.err.log" 2>/dev/null || true
  exit 1
fi

SERVER_IP="$(hostname -I | awk '{print $1}')"
echo
echo "ATM VCS is installed and running."
echo "Controller: http://${SERVER_IP:-SERVER_IP}:${PORT}/controller"
echo "Engineering: http://${SERVER_IP:-SERVER_IP}:${PORT}/admin"
echo "Health:     http://${SERVER_IP:-SERVER_IP}:${PORT}/api/health"
echo
echo "Useful commands:"
echo "  sudo systemctl status ${SERVICE_NAME}"
echo "  sudo journalctl -u ${SERVICE_NAME} -f"
echo "  sudo tail -f ${APP_DIR}/logs/service.out.log"

#!/usr/bin/env bash
set -euo pipefail

APP_NAME="emerald-streaming"
APP_USER="emerald"
APP_GROUP="emerald"
APP_DIR="/opt/emerald-streaming"
CONFIG_DIR="/etc/emerald-streaming"
SERVICE_FILE="/etc/systemd/system/emerald.service"
NGINX_SITE="/etc/nginx/sites-available/emerald"
NGINX_SITE_LINK="/etc/nginx/sites-enabled/emerald"
SOURCE_DIR=""
DOMAIN_NAME=""
CONFIGURE_NGINX="false"
INSTALL_PACKAGES="false"

usage() {
  cat <<EOF
Usage:
  sudo ./install-emerald.sh --source /path/to/publish [options]

Options:
  --source PATH          Required. Published Emerald.Streaming folder.
  --app-dir PATH         Default: /opt/emerald-streaming
  --domain NAME         Configure Nginx server_name. Enables Nginx config.
  --with-nginx          Configure Nginx reverse proxy on port 80.
  --install-packages    Install nginx, ffmpeg, and rsync with apt.
  -h, --help            Show this help.

Example:
  sudo ./install-emerald.sh --source ./publish --install-packages --with-nginx --domain recorder.example.com
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source)
      SOURCE_DIR="${2:-}"
      shift 2
      ;;
    --app-dir)
      APP_DIR="${2:-}"
      shift 2
      ;;
    --domain)
      DOMAIN_NAME="${2:-}"
      CONFIGURE_NGINX="true"
      shift 2
      ;;
    --with-nginx)
      CONFIGURE_NGINX="true"
      shift
      ;;
    --install-packages)
      INSTALL_PACKAGES="true"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this installer with sudo." >&2
  exit 1
fi

if [[ -z "${SOURCE_DIR}" || ! -d "${SOURCE_DIR}" ]]; then
  echo "--source must point to a published Emerald.Streaming folder." >&2
  exit 1
fi

if [[ ! -f "${SOURCE_DIR}/Emerald.Streaming.dll" ]]; then
  echo "Emerald.Streaming.dll was not found in ${SOURCE_DIR}. Run dotnet publish first." >&2
  exit 1
fi

if [[ "${INSTALL_PACKAGES}" == "true" ]]; then
  apt-get update
  apt-get install -y nginx ffmpeg rsync
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg was not found. Install ffmpeg or set the FFmpeg Path field in the app." >&2
fi

if ! getent group "${APP_GROUP}" >/dev/null; then
  groupadd --system "${APP_GROUP}"
fi

if ! id "${APP_USER}" >/dev/null 2>&1; then
  useradd --system --gid "${APP_GROUP}" --home-dir "${APP_DIR}" --shell /usr/sbin/nologin "${APP_USER}"
fi

systemctl stop emerald.service >/dev/null 2>&1 || true

mkdir -p "${APP_DIR}" "${CONFIG_DIR}" "${APP_DIR}/Recordings"
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete \
    --exclude "Recordings/" \
    --exclude "wwwroot/hls/" \
    "${SOURCE_DIR}/" "${APP_DIR}/"
else
  find "${APP_DIR}" -mindepth 1 \
    ! -path "${APP_DIR}/Recordings" \
    ! -path "${APP_DIR}/Recordings/*" \
    ! -path "${APP_DIR}/wwwroot/hls" \
    ! -path "${APP_DIR}/wwwroot/hls/*" \
    -exec rm -rf {} +
  tar -C "${SOURCE_DIR}" \
    --exclude "./Recordings" \
    --exclude "./wwwroot/hls" \
    -cf - . | tar -C "${APP_DIR}" -xf -
fi
mkdir -p "${APP_DIR}/Recordings" "${APP_DIR}/wwwroot/hls/obs-preview"

if [[ -f "${APP_DIR}/Emerald.Streaming" ]]; then
  chmod +x "${APP_DIR}/Emerald.Streaming"
  EXEC_START="${APP_DIR}/Emerald.Streaming"
elif command -v dotnet >/dev/null 2>&1; then
  EXEC_START="/usr/bin/dotnet ${APP_DIR}/Emerald.Streaming.dll"
else
  echo "dotnet was not found and this publish is not self-contained. Install ASP.NET Core Runtime 10 or rebuild the .run as self-contained." >&2
  exit 1
fi

if [[ -f "./emerald.env" ]]; then
  install -m 0644 "./emerald.env" "${CONFIG_DIR}/emerald.env"
elif [[ ! -f "${CONFIG_DIR}/emerald.env" ]]; then
  cat > "${CONFIG_DIR}/emerald.env" <<EOF
ASPNETCORE_ENVIRONMENT=Production
ASPNETCORE_URLS=http://127.0.0.1:5000
EOF
fi

cat > "${SERVICE_FILE}" <<EOF
[Unit]
Description=Emerald Streaming Recorder
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${APP_USER}
Group=${APP_GROUP}
WorkingDirectory=${APP_DIR}
EnvironmentFile=${CONFIG_DIR}/emerald.env
ExecStart=${EXEC_START}
Restart=always
RestartSec=10
KillSignal=SIGINT
SyslogIdentifier=emerald-streaming

[Install]
WantedBy=multi-user.target
EOF

chown -R "${APP_USER}:${APP_GROUP}" "${APP_DIR}"
chown -R root:root "${CONFIG_DIR}"
chmod 0755 "${APP_DIR}"
chmod 0750 "${APP_DIR}/Recordings" "${APP_DIR}/wwwroot/hls" "${APP_DIR}/wwwroot/hls/obs-preview"

systemctl daemon-reload
systemctl enable emerald.service
systemctl restart emerald.service

if [[ "${CONFIGURE_NGINX}" == "true" ]]; then
  if ! command -v nginx >/dev/null 2>&1; then
    echo "nginx was not found. Re-run with --install-packages or install nginx manually." >&2
  else
    SERVER_NAME="${DOMAIN_NAME:-_}"
    cat > "${NGINX_SITE}" <<EOF
server {
    listen 80;
    server_name ${SERVER_NAME};

    client_max_body_size 2048m;

    location / {
        proxy_pass http://127.0.0.1:5000;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF
    ln -sfn "${NGINX_SITE}" "${NGINX_SITE_LINK}"
    nginx -t
    systemctl reload nginx
  fi
fi

echo ""
echo "Emerald Streaming is installed."
echo "Service status:"
systemctl --no-pager --full status emerald.service || true
echo ""
echo "Local app URL: http://127.0.0.1:5000"
if [[ "${CONFIGURE_NGINX}" == "true" ]]; then
  echo "Nginx URL: http://${DOMAIN_NAME:-your-server-ip}/"
fi
echo "Recordings directory: ${APP_DIR}/Recordings"

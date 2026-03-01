#!/bin/bash
# =============================================================================
# Translucid Entrypoint: CHROMIUM
#
# Dedicated startup script for the Chromium image.
# It reads runtime env vars and generates Chromium-specific configs.
# =============================================================================

set -e

echo "[Translucid] Starting Chromium session setup..."
echo "[Translucid] Session: ${TRANSLUCID_SESSION_ID:-unset}"

mkdir -p /opt/translucid /var/log/neko /etc/neko/supervisord /etc/chromium/policies/managed

# 1. Install .crx extension via Chromium external extensions mechanism
#    This is the reliable way to pre-install local .crx files (used by all Linux distros).
#    Chromium reads JSON files from /usr/share/chromium/extensions/ on startup.
if [ -f /opt/translucid/extension.crx ] && [ -f /opt/translucid/extension.id ]; then
  EXT_ID=$(cat /opt/translucid/extension.id)
  mkdir -p /usr/share/chromium/extensions
  echo "{\"external_crx\":\"/opt/translucid/extension.crx\",\"external_version\":\"1.0.0\"}" > "/usr/share/chromium/extensions/${EXT_ID}.json"
  echo "[Translucid] Extension .crx installed via external extensions: ID=${EXT_ID}"
else
  echo "[Translucid] WARNING: No .crx found at /opt/translucid/extension.crx — extension will not be installed"
fi

# 2. Extension Config Server
if [ -n "$TRANSLUCID_SESSION_ID" ] && [ -n "$TRANSLUCID_BACKEND_URL" ]; then
  echo "{\"sessionId\":\"${TRANSLUCID_SESSION_ID}\",\"backendUrl\":\"${TRANSLUCID_BACKEND_URL}\"}" > /opt/translucid/config.json
  echo "[Translucid] Config: sessionId=${TRANSLUCID_SESSION_ID}, backendUrl=${TRANSLUCID_BACKEND_URL}"
else
  echo "{\"sessionId\":\"unknown\",\"backendUrl\":\"\"}" > /opt/translucid/config.json
  echo "[Translucid] WARNING: Missing TRANSLUCID_SESSION_ID or TRANSLUCID_BACKEND_URL"
fi

cat > /etc/neko/supervisord/activity-config-server.conf << 'EOF'
[program:activity-config-server]
command=python3 -m http.server 3200 --bind 127.0.0.1 --directory /opt/translucid
autostart=true
autorestart=true
priority=200
stdout_logfile=/dev/null
stderr_logfile=/dev/null
EOF

# 2. Chromium Supervisord Config
TARGET_URL="${TRANSLUCID_TARGET_URL:-about:blank}"
CHROMIUM_BIN=$(which chromium 2>/dev/null || which chromium-browser 2>/dev/null || echo "/usr/bin/chromium")

cat > /etc/neko/supervisord/chromium.conf << CREOF
[program:chromium]
environment=HOME="/home/%(ENV_USER)s",USER="%(ENV_USER)s",DISPLAY="%(ENV_DISPLAY)s"
command=${CHROMIUM_BIN} --window-position=0,0 --display=%(ENV_DISPLAY)s --user-data-dir=/home/neko/.config/chromium --no-first-run --start-maximized --no-default-browser-check --force-dark-mode --disable-file-system --disable-dev-shm-usage --use-fake-ui-for-media-stream --enable-features=WebRTCPipeWireCapturer ${TARGET_URL}
stopsignal=INT
autorestart=true
priority=800
user=%(ENV_USER)s
stdout_logfile=/var/log/neko/chromium.log
stdout_logfile_maxbytes=100MB
redirect_stderr=true

[program:openbox]
environment=HOME="/home/%(ENV_USER)s",USER="%(ENV_USER)s",DISPLAY="%(ENV_DISPLAY)s"
command=/usr/bin/openbox --config-file /etc/neko/openbox.xml
autorestart=true
priority=300
user=%(ENV_USER)s
stdout_logfile=/var/log/neko/openbox.log
stdout_logfile_maxbytes=100MB
redirect_stderr=true
CREOF

echo "[Translucid] Chromium entrypoint setup complete. Starting supervisord..."
exec /usr/bin/supervisord -c /etc/neko/supervisord.conf

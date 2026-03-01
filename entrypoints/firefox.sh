#!/bin/bash
# =============================================================================
# Translucid Entrypoint: FIREFOX
#
# Dedicated startup script for the Firefox image.
# It reads runtime env vars and generates Firefox-specific configs.
# =============================================================================

set -e

echo "[Translucid] Starting Firefox session setup..."
echo "[Translucid] Session: ${TRANSLUCID_SESSION_ID:-unset}"

mkdir -p /opt/translucid /var/log/neko /etc/neko/supervisord /usr/lib/firefox/distribution

# 1. Extension Config Server
if [ -n "$TRANSLUCID_SESSION_ID" ] && [ -n "$TRANSLUCID_BACKEND_URL" ]; then
  echo "{\"sessionId\":\"${TRANSLUCID_SESSION_ID}\",\"backendUrl\":\"${TRANSLUCID_BACKEND_URL}\"}" > /opt/translucid/config.json
else
  echo "{\"sessionId\":\"unknown\",\"backendUrl\":\"\"}" > /opt/translucid/config.json
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

# 2. Firefox Supervisord Config
TARGET_URL="${TRANSLUCID_TARGET_URL:-about:blank}"

cat > /etc/neko/supervisord/firefox.conf << FFEOF
[program:firefox]
environment=HOME="/home/%(ENV_USER)s",USER="%(ENV_USER)s",DISPLAY="%(ENV_DISPLAY)s"
command=/usr/bin/firefox --no-remote -P default --display=%(ENV_DISPLAY)s -setDefaultBrowser ${TARGET_URL}
stopsignal=INT
autorestart=true
priority=800
user=%(ENV_USER)s
stdout_logfile=/var/log/neko/firefox.log
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
FFEOF

# Copy .xpi if template exists
if [ -f /opt/translucid/vm-activity-template.xpi ]; then
  cp /opt/translucid/vm-activity-template.xpi /opt/translucid/vm-activity.xpi
fi

echo "[Translucid] Firefox entrypoint setup complete. Starting supervisord..."
exec /usr/bin/supervisord -c /etc/neko/supervisord.conf

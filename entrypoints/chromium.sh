#!/bin/bash
# =============================================================================
# Translucid Entrypoint: CHROMIUM
#
# Dedicated startup script for the Chromium image.
# Reads runtime env vars and generates Chromium-specific configs.
# =============================================================================

set -e

echo "[Translucid] Starting Chromium session setup..."
echo "[Translucid] Session: ${TRANSLUCID_SESSION_ID:-unset}"

mkdir -p /opt/translucid /var/log/neko /etc/neko/supervisord

# =============================================================================
# 1. NUKE all Chromium policies from the Neko base image
#    The base image ships restrictive policies that block ALL extensions.
#    We must completely remove them and write our own permissive policy.
# =============================================================================
rm -rf /etc/chromium/policies /etc/chromium-browser/policies /etc/opt/chrome/policies
mkdir -p /etc/chromium/policies/managed /etc/chromium/policies/recommended

# Write our permissive policy: empty blocklist, wildcard allowlist
EXT_ID=""
if [ -f /opt/translucid/extension.id ]; then
  EXT_ID=$(cat /opt/translucid/extension.id)
fi

cat > /etc/chromium/policies/managed/translucid.json << POLICY
{
  "ExtensionInstallBlocklist": [],
  "ExtensionInstallAllowlist": ["*"],
  "BlockExternalExtensions": false,
  "AutofillAddressEnabled": false,
  "AutofillCreditCardEnabled": false,
  "BrowserSignin": 0,
  "DefaultNotificationsSetting": 2,
  "FullscreenAllowed": true,
  "SyncDisabled": true,
  "AutoplayAllowed": true,
  "DownloadRestrictions": 3,
  "AllowFileSelectionDialogs": false,
  "PromptForDownloadLocation": false,
  "PasswordManagerEnabled": false,
  "AudioCaptureAllowed": true,
  "VideoCaptureAllowed": true,
  "AudioCaptureAllowedUrls": ["https://*", "http://*"],
  "VideoCaptureAllowedUrls": ["https://*", "http://*"]
}
POLICY

echo "[Translucid] Policies nuked and rebuilt (extensions ALLOWED)"

# Also install .crx via external extensions JSON (backup mechanism)
if [ -n "$EXT_ID" ] && [ -f /opt/translucid/extension.crx ]; then
  mkdir -p /usr/share/chromium/extensions
  echo "{\"external_crx\":\"/opt/translucid/extension.crx\",\"external_version\":\"1.0.0\"}" > "/usr/share/chromium/extensions/${EXT_ID}.json"
  echo "[Translucid] Extension .crx registered via external extensions JSON: ID=${EXT_ID}"
fi

# =============================================================================
# 2. Extension Config Server (serves config.json on port 3200)
# =============================================================================
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

# =============================================================================
# 3. Chromium Supervisord Config (with --load-extension since policies are now clean)
#    TRANSLUCID_KIOSK=true  → kiosk mode (no browser UI, for embeds)
#    TRANSLUCID_KIOSK=false → normal mode (full browser, for desktop sessions)
# =============================================================================
TARGET_URL="${TRANSLUCID_TARGET_URL:-about:blank}"
CHROMIUM_BIN=$(which chromium 2>/dev/null || which chromium-browser 2>/dev/null || echo "/usr/bin/chromium")

KIOSK_FLAGS=""
if [ "${TRANSLUCID_KIOSK}" = "true" ]; then
  KIOSK_FLAGS="--kiosk --disable-pinch --overscroll-history-navigation=0"
  echo "[Translucid] Kiosk mode ENABLED (no browser UI)"
fi

cat > /etc/neko/supervisord/chromium.conf << CREOF
[program:chromium]
environment=HOME="/home/%(ENV_USER)s",USER="%(ENV_USER)s",DISPLAY="%(ENV_DISPLAY)s"
command=${CHROMIUM_BIN} --window-position=0,0 --display=%(ENV_DISPLAY)s --user-data-dir=/home/neko/.config/chromium --no-first-run --start-maximized --no-default-browser-check --force-dark-mode --disable-file-system --disable-dev-shm-usage --use-fake-ui-for-media-stream --enable-features=WebRTCPipeWireCapturer --load-extension=/opt/translucid/extension ${KIOSK_FLAGS} ${TARGET_URL}
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

# Debug: list what's in the policy directory
echo "[Translucid] Policy files:"
ls -la /etc/chromium/policies/managed/ 2>/dev/null || echo "  (none)"
echo "[Translucid] Chromium entrypoint setup complete. Starting supervisord..."
exec /usr/bin/supervisord -c /etc/neko/supervisord.conf

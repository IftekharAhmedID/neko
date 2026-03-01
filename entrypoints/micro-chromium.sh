#!/bin/bash
# =============================================================================
# Translucid Entrypoint: MICRO-CHROMIUM (Embed/Kiosk)
#
# Lightweight kiosk-only Chromium. No browser UI, no tabs, no URL bar,
# no right-click, no keyboard shortcuts, no mic/webcam. Just the webpage.
# =============================================================================
set -e
echo "[Micro] Session: ${TRANSLUCID_SESSION_ID:-unset}"
mkdir -p /opt/translucid /var/log/neko /etc/neko/supervisord

# Nuke base image policies, write locked-down kiosk policy
rm -rf /etc/chromium/policies /etc/chromium-browser/policies /etc/opt/chrome/policies
mkdir -p /etc/chromium/policies/managed

cat > /etc/chromium/policies/managed/translucid.json << 'POLICY'
{
  "ExtensionInstallBlocklist": [],
  "ExtensionInstallAllowlist": ["*"],
  "BlockExternalExtensions": false,
  "BrowserSignin": 0,
  "SyncDisabled": true,
  "AutoplayAllowed": true,
  "DownloadRestrictions": 3,
  "AudioCaptureAllowed": false,
  "VideoCaptureAllowed": false,
  "AllowFileSelectionDialogs": false,
  "PromptForDownloadLocation": false,
  "PasswordManagerEnabled": false,
  "BookmarkBarEnabled": false,
  "DeveloperToolsAvailability": 2,
  "IncognitoModeAvailability": 1,
  "URLBlocklist": ["chrome://*", "chrome-extension://*"],
  "URLAllowlist": ["chrome://extensions"]
}
POLICY

# Extension config server
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

TARGET_URL="${TRANSLUCID_TARGET_URL:-about:blank}"
CHROMIUM_BIN=$(which chromium 2>/dev/null || echo "/usr/bin/chromium")

cat > /etc/neko/supervisord/chromium.conf << CREOF
[program:chromium]
environment=HOME="/home/%(ENV_USER)s",USER="%(ENV_USER)s",DISPLAY="%(ENV_DISPLAY)s"
command=${CHROMIUM_BIN} --kiosk --window-position=0,0 --display=%(ENV_DISPLAY)s --user-data-dir=/home/neko/.config/chromium --no-first-run --disable-infobars --disable-session-crashed-bubble --disable-dev-shm-usage --disable-pinch --overscroll-history-navigation=0 --disable-translate --disable-features=TranslateUI --ash-no-nudges --disable-background-networking --disable-client-side-phishing-detection --disable-default-apps --disable-hang-monitor --disable-popup-blocking --disable-prompt-on-repost --disable-sync --metrics-recording-only --no-default-browser-check --load-extension=/opt/translucid/extension ${TARGET_URL}
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

echo "[Micro] Kiosk mode setup complete. Starting supervisord..."
exec /usr/bin/supervisord -c /etc/neko/supervisord.conf

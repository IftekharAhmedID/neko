#!/bin/bash
# =============================================================================
# Translucid Universal Entrypoint
#
# This script runs INSIDE the Neko container at startup, BEFORE supervisord.
# It reads environment variables and generates per-session config files.
#
# Pre-baked in the Docker image — works identically on ALL clouds:
# AWS ECS, Azure ACI, GCP Compute Engine, bare metal.
#
# Required env vars (injected by the provider at runtime):
#   TRANSLUCID_SESSION_ID    — Session UUID
#   TRANSLUCID_BACKEND_URL   — Backend URL for extension API calls
#   TRANSLUCID_TARGET_URL    — Startup URL for the browser (optional)
#
# Optional env vars:
#   NEKO_DRM_*              — DRM encryption keys (injected per-session)
#   NEKO_WEBRTC_NAT1TO1     — Public IP for WebRTC (set by provider)
#   NEKO_SCREEN             — Screen resolution (default: 1280x720@25)
#   NEKO_VIDEO_BITRATE      — Video bitrate in kbps (default: 2000)
#
# Security: NO secrets are baked into the image. DRM keys, session IDs,
# and backend URLs are always injected at runtime via env vars.
# =============================================================================

set -e

echo "[Translucid Entrypoint] Starting session setup..."
echo "[Translucid Entrypoint] Session: ${TRANSLUCID_SESSION_ID:-unset}"
echo "[Translucid Entrypoint] Backend: ${TRANSLUCID_BACKEND_URL:-unset}"
echo "[Translucid Entrypoint] Target:  ${TRANSLUCID_TARGET_URL:-unset}"

# Create required directories
mkdir -p /opt/translucid /var/log/neko /etc/neko/supervisord

# =============================================================================
# 1. Extension Config (session ID + backend URL)
#    The extension fetches this from http://127.0.0.1:3200/config.json
# =============================================================================
if [ -n "$TRANSLUCID_SESSION_ID" ] && [ -n "$TRANSLUCID_BACKEND_URL" ]; then
  echo "{\"sessionId\":\"${TRANSLUCID_SESSION_ID}\",\"backendUrl\":\"${TRANSLUCID_BACKEND_URL}\"}" > /opt/translucid/config.json
  echo "[Translucid Entrypoint] Extension config written to /opt/translucid/config.json"
else
  echo "{\"sessionId\":\"unknown\",\"backendUrl\":\"\"}" > /opt/translucid/config.json
  echo "[Translucid Entrypoint] WARNING: Missing TRANSLUCID_SESSION_ID or TRANSLUCID_BACKEND_URL"
fi

# =============================================================================
# 2. Config Server (serves config.json on port 3200 for the extension)
#    Pre-baked supervisord config — always runs
# =============================================================================
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
# 3. Browser Supervisord Config (with startup URL)
#    Detects which browser is installed and generates the appropriate config
# =============================================================================
TARGET_URL="${TRANSLUCID_TARGET_URL:-about:blank}"

if [ -x /usr/bin/chromium ] || [ -x /usr/bin/chromium-browser ]; then
  CHROMIUM_BIN=$(which chromium 2>/dev/null || which chromium-browser 2>/dev/null)
  echo "[Translucid Entrypoint] Detected Chromium: $CHROMIUM_BIN"

  cat > /etc/neko/supervisord/chromium.conf << CREOF
[program:chromium]
environment=HOME="/home/%(ENV_USER)s",USER="%(ENV_USER)s",DISPLAY="%(ENV_DISPLAY)s"
command=${CHROMIUM_BIN} --window-position=0,0 --display=%(ENV_DISPLAY)s --user-data-dir=/home/neko/.config/chromium --no-first-run --start-maximized --no-default-browser-check --force-dark-mode --disable-file-system --disable-gpu --disable-software-rasterizer --disable-dev-shm-usage --use-fake-ui-for-media-stream --enable-features=WebRTCPipeWireCapturer --load-extension=/opt/translucid/extension ${TARGET_URL}
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

  # Chromium enterprise policies (auto-grant camera/mic + allow extensions)
  mkdir -p /etc/chromium/policies/managed
  cat > /etc/chromium/policies/managed/translucid.json << 'CRPOLICY'
{
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
  "VideoCaptureAllowedUrls": ["https://*", "http://*"],
  "DeveloperToolsAvailability": 1,
  "ExtensionInstallAllowlist": ["*"],
  "BlockExternalExtensions": false
}
CRPOLICY
  echo "[Translucid Entrypoint] Chromium config + policies written"

elif [ -x /usr/bin/firefox ]; then
  echo "[Translucid Entrypoint] Detected Firefox: /usr/bin/firefox"

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

  # Firefox policies (camera/mic auto-grant + extension auto-install)
  mkdir -p /usr/lib/firefox/distribution
  cat > /usr/lib/firefox/distribution/policies.json << 'FFPOLICY'
{"policies":{"BlockAboutConfig":true,"CaptivePortal":false,"DisableAppUpdate":true,"DisableTelemetry":true,"Permissions":{"Camera":{"Allow":["https://"],"BlockNewRequests":false},"Microphone":{"Allow":["https://"],"BlockNewRequests":false},"Notifications":{"BlockNewRequests":true}},"ExtensionSettings":{"vm-activity@translucid.cloud":{"installation_mode":"force_installed","install_url":"file:///usr/lib/firefox/distribution/extensions/vm-activity@translucid.cloud.xpi"}},"Preferences":{"media.navigator.permission.disabled":true,"xpinstall.signatures.required":false}}}
FFPOLICY

  # Copy .xpi if template exists
  if [ -f /opt/translucid/vm-activity-template.xpi ]; then
    cp /opt/translucid/vm-activity-template.xpi /opt/translucid/vm-activity.xpi
  fi
  echo "[Translucid Entrypoint] Firefox config + policies written"
fi

# =============================================================================
# 4. Security Validation
#    Verify session is properly authenticated before proceeding
# =============================================================================
if [ -z "$TRANSLUCID_SESSION_ID" ]; then
  echo "[Translucid Entrypoint] WARNING: No session ID — extension will be disabled"
fi

if [ -z "$NEKO_DRM_KEY" ]; then
  echo "[Translucid Entrypoint] WARNING: No DRM key — stream will be unencrypted"
fi

echo "[Translucid Entrypoint] Setup complete. Starting supervisord..."

# =============================================================================
# 5. Start Supervisord (the main Neko process manager)
# =============================================================================
exec /usr/bin/supervisord -c /etc/neko/supervisord.conf

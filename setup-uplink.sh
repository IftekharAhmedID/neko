#!/bin/bash
# ============================================================================
# Translucid Mic/Webcam Uplink Setup Script
#
# This script sets up the host VM for receiving mic and webcam streams from
# the browser and piping them to virtual devices inside the Neko container.
#
# Run this on the EC2 host (18.224.27.76) with sudo
# ============================================================================

set -e

echo "═══════════════════════════════════════════════════════════════════════"
echo "Translucid Mic/Webcam Uplink Setup"
echo "═══════════════════════════════════════════════════════════════════════"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# ============================================================================
# Step 1: Install v4l2loopback (Virtual Webcam)
# ============================================================================
echo ""
echo "Step 1: Installing v4l2loopback for virtual webcam..."
echo "─────────────────────────────────────────────────────"

if ! dpkg -l | grep -q v4l2loopback-dkms; then
    log_info "Installing v4l2loopback-dkms..."
    apt-get update
    apt-get install -y v4l2loopback-dkms v4l2loopback-utils
else
    log_info "v4l2loopback-dkms already installed"
fi

# Install kernel headers if needed
KERNEL_VERSION=$(uname -r)
if ! dpkg -l | grep -q "linux-headers-$KERNEL_VERSION"; then
    log_info "Installing kernel headers for $KERNEL_VERSION..."
    apt-get install -y linux-headers-$KERNEL_VERSION || log_warn "Could not install headers"
fi

# Install extra kernel modules if available
if apt-cache show linux-modules-extra-$KERNEL_VERSION &> /dev/null; then
    if ! dpkg -l | grep -q "linux-modules-extra-$KERNEL_VERSION"; then
        log_info "Installing linux-modules-extra-$KERNEL_VERSION..."
        apt-get install -y linux-modules-extra-$KERNEL_VERSION || log_warn "Could not install extra modules"
    fi
fi

# ============================================================================
# Step 2: Load v4l2loopback kernel module
# ============================================================================
echo ""
echo "Step 2: Loading v4l2loopback kernel module..."
echo "─────────────────────────────────────────────"

# Unload if already loaded (to reset configuration)
if lsmod | grep -q v4l2loopback; then
    log_info "Unloading existing v4l2loopback module..."
    modprobe -r v4l2loopback || true
fi

# Load with exclusive_caps=1 (required for Chrome/Firefox to recognize as camera)
log_info "Loading v4l2loopback with exclusive_caps=1..."
modprobe v4l2loopback exclusive_caps=1 video_nr=0 card_label="Translucid Virtual Camera"

# Verify
if [ -e /dev/video0 ]; then
    log_info "✓ /dev/video0 created successfully"
    v4l2-ctl --device=/dev/video0 --all 2>/dev/null | head -5 || true
else
    log_error "✗ /dev/video0 not found!"
    exit 1
fi

# ============================================================================
# Step 3: Make v4l2loopback persistent across reboots
# ============================================================================
echo ""
echo "Step 3: Making v4l2loopback persistent..."
echo "──────────────────────────────────────────"

# Add to modules to load on boot
if ! grep -q v4l2loopback /etc/modules 2>/dev/null; then
    log_info "Adding v4l2loopback to /etc/modules..."
    echo "v4l2loopback" >> /etc/modules
fi

# Create modprobe configuration
log_info "Creating modprobe configuration..."
cat > /etc/modprobe.d/v4l2loopback.conf << 'EOF'
# Translucid Virtual Camera Configuration
# exclusive_caps=1 - Required for browsers to detect as real camera
# video_nr=0 - Use /dev/video0
# card_label - Friendly name shown in applications
options v4l2loopback exclusive_caps=1 video_nr=0 card_label="Translucid Virtual Camera"
EOF

log_info "✓ v4l2loopback will persist across reboots"

# ============================================================================
# Step 4: Create updated docker-compose for Neko with uplink support
# ============================================================================
echo ""
echo "Step 4: Creating docker-compose with uplink support..."
echo "──────────────────────────────────────────────────────"

COMPOSE_DIR="/opt/translucid"
mkdir -p $COMPOSE_DIR

cat > $COMPOSE_DIR/docker-compose.uplink.yaml << 'EOF'
# ============================================================================
# Translucid Neko with Mic/Webcam Uplink Support
# ============================================================================
version: "3.8"

services:
  neko:
    image: "ghcr.io/m1k1o/neko/firefox:latest"
    restart: "unless-stopped"
    shm_size: "2gb"
    ports:
      - "8080:8080"
      - "52000-52100:52000-52100/udp"

    # ═══════════════════════════════════════════════════════════════════════
    # CRITICAL: Device mapping for virtual webcam
    # The host's /dev/video0 (v4l2loopback) is mapped into the container
    # ═══════════════════════════════════════════════════════════════════════
    devices:
      - /dev/video0:/dev/video0

    # Required for video device access
    privileged: false
    cap_add:
      - SYS_ADMIN

    environment:
      # ─────────────────────────────────────────────────────────────────────
      # Desktop Configuration
      # ─────────────────────────────────────────────────────────────────────
      NEKO_DESKTOP_SCREEN: 1280x720@30

      # ─────────────────────────────────────────────────────────────────────
      # Authentication
      # ─────────────────────────────────────────────────────────────────────
      NEKO_MEMBER_MULTIUSER_USER_PASSWORD: translucid
      NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD: admin

      # ─────────────────────────────────────────────────────────────────────
      # WebRTC Configuration
      # ─────────────────────────────────────────────────────────────────────
      NEKO_WEBRTC_EPR: 52000-52100
      NEKO_WEBRTC_ICELITE: "1"

      # ─────────────────────────────────────────────────────────────────────
      # ⭐ WEBCAM UPLINK CONFIGURATION ⭐
      # Enables receiving webcam stream from browser
      # ─────────────────────────────────────────────────────────────────────
      NEKO_CAPTURE_WEBCAM_ENABLED: "true"
      NEKO_CAPTURE_WEBCAM_DEVICE: /dev/video0
      NEKO_CAPTURE_WEBCAM_WIDTH: "640"
      NEKO_CAPTURE_WEBCAM_HEIGHT: "480"

      # ─────────────────────────────────────────────────────────────────────
      # ⭐ MICROPHONE UPLINK CONFIGURATION ⭐
      # Enables receiving microphone stream from browser
      # Default is already enabled, but we set it explicitly
      # ─────────────────────────────────────────────────────────────────────
      NEKO_CAPTURE_MICROPHONE_ENABLED: "true"
      NEKO_CAPTURE_MICROPHONE_DEVICE: audio_input

      # ─────────────────────────────────────────────────────────────────────
      # Member Permissions - Allow media sharing
      # ─────────────────────────────────────────────────────────────────────
      NEKO_MEMBER_PROVIDER: multiuser

    # Logging for debugging
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"
EOF

log_info "✓ Created $COMPOSE_DIR/docker-compose.uplink.yaml"

# ============================================================================
# Step 5: Display next steps
# ============================================================================
echo ""
echo "═══════════════════════════════════════════════════════════════════════"
echo "                    SETUP COMPLETE!"
echo "═══════════════════════════════════════════════════════════════════════"
echo ""
echo "Next steps:"
echo ""
echo "1. Stop the current Neko container:"
echo "   docker stop \$(docker ps -q --filter ancestor=ghcr.io/m1k1o/neko/firefox)"
echo ""
echo "2. Start Neko with uplink support:"
echo "   cd $COMPOSE_DIR"
echo "   docker-compose -f docker-compose.uplink.yaml up -d"
echo ""
echo "3. Verify the container is running:"
echo "   docker ps"
echo "   docker logs \$(docker ps -q --filter ancestor=ghcr.io/m1k1o/neko/firefox) --tail 50"
echo ""
echo "4. Test in browser:"
echo "   - Open Translucid player"
echo "   - Open browser console (F12)"
echo "   - Run: startMicUplink()"
echo "   - Run: startWebcamUplink()"
echo "   - Watch logs for [UPLINK] [RENEGOTIATION] messages"
echo ""
echo "5. Verify inside container:"
echo "   docker exec -it \$(docker ps -q --filter ancestor=ghcr.io/m1k1o/neko/firefox) bash"
echo "   # Check virtual camera"
echo "   ls -la /dev/video0"
echo "   # Check PulseAudio sources"
echo "   pactl list sources short"
echo ""
echo "═══════════════════════════════════════════════════════════════════════"

#!/bin/bash
# ============================================================================
# TRANSLUCID NEKO with Mic/Webcam Uplink Support
# Matches orchestratorService.ts configuration + uplink features
# ============================================================================
set -eux

exec > >(tee /var/log/user-data.log|logger -t user-data -s 2>/dev/console) 2>&1
echo "=== Starting Translucid Neko Uplink Setup ==="
date

# System updates - Ubuntu 22.04
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y docker.io unzip ca-certificates curl

# Enable Docker
systemctl enable docker
systemctl start docker

# Install v4l2loopback for virtual webcam
apt-get install -y v4l2loopback-dkms v4l2loopback-utils linux-modules-extra-$(uname -r) || true

# Load v4l2loopback module
modprobe v4l2loopback exclusive_caps=1 video_nr=0 card_label="Translucid Virtual Camera" || echo "v4l2loopback load failed - may need kernel headers"

# Make persistent
echo "v4l2loopback" >> /etc/modules
cat > /etc/modprobe.d/v4l2loopback.conf << 'MODCONF'
options v4l2loopback exclusive_caps=1 video_nr=0 card_label="Translucid Virtual Camera"
MODCONF

# Verify /dev/video0 exists
ls -la /dev/video0 && echo "Virtual webcam device ready" || echo "Warning: /dev/video0 not created"

# Create directories
mkdir -p /opt/translucid

# Get public IP for WebRTC NAT traversal (CRITICAL)
PUBLIC_IP=$(curl -s http://169.254.169.254/latest/meta-data/public-ipv4)
echo "Public IP: $PUBLIC_IP"

# Pull Neko image
echo "Pulling Neko Firefox image..."
docker pull ghcr.io/m1k1o/neko/firefox:latest

# ============================================================================
# Run Neko with FULL configuration matching orchestratorService.ts
# + Mic/Webcam uplink support
# ============================================================================
echo "Starting Neko with mic/webcam uplink support..."

# Check if /dev/video0 exists for device mapping
DEVICE_ARGS=""
if [ -e /dev/video0 ]; then
  DEVICE_ARGS="--device /dev/video0:/dev/video0"
  echo "Adding virtual webcam device mapping"
fi

docker run -d \
  --name translucid-neko \
  --restart unless-stopped \
  --shm-size="2g" \
  -p 8080:8080 \
  -p 52000:52000/udp \
  -p 52000:52000/tcp \
  $DEVICE_ARGS \
  -e NEKO_WEBRTC_UDPMUX=52000 \
  -e NEKO_WEBRTC_TCPMUX=52000 \
  -e NEKO_WEBRTC_ICELITE=true \
  -e NEKO_WEBRTC_NAT1TO1=$PUBLIC_IP \
  -e NEKO_MEMBER_MULTIUSER_USER_PASSWORD=translucid \
  -e NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD=admin \
  -e NEKO_SESSION_IMPLICIT_HOSTING=true \
  -e NEKO_SESSION_MERCIFUL_RECONNECT=true \
  -e NEKO_SCREEN=1280x720@25 \
  -e NEKO_VIDEO_CODEC=h264 \
  -e NEKO_VIDEO_BITRATE=2000 \
  -e NEKO_MAX_FPS=25 \
  -e NEKO_AUDIO_CODEC=opus \
  -e NEKO_CAPTURE_WEBCAM_ENABLED=true \
  -e NEKO_CAPTURE_WEBCAM_DEVICE=/dev/video0 \
  -e NEKO_CAPTURE_WEBCAM_WIDTH=640 \
  -e NEKO_CAPTURE_WEBCAM_HEIGHT=480 \
  -e NEKO_CAPTURE_MICROPHONE_ENABLED=true \
  -e NEKO_CAPTURE_MICROPHONE_DEVICE=audio_input \
  ghcr.io/m1k1o/neko/firefox:latest

echo "Waiting for Neko startup (30 seconds)..."
sleep 30

# Check if container is running
if docker ps | grep -q translucid-neko; then
  echo "Neko container is running!"
  docker logs translucid-neko --tail 30
else
  echo "ERROR: Neko container failed to start"
  docker logs translucid-neko 2>&1 || true
fi

echo "=== Translucid Neko Uplink Setup Complete ==="
date
echo "Neko URL: http://$PUBLIC_IP:8080"
echo "User: translucid | Admin: admin"
echo "Mic/Webcam uplink: ENABLED"
docker ps

# Translucid Mic/Webcam Uplink Deployment Guide

## Quick Deploy Commands (Copy-Paste to SSH)

### Step 1: SSH into the VM
```bash
ssh ubuntu@18.224.27.76
```

### Step 2: Run the One-Liner Setup
```bash
# Download and run setup script (or copy-paste the commands below)
sudo bash -c '
echo "═══════════════════════════════════════════════════════════════════════"
echo "Translucid Uplink Setup - Starting..."
echo "═══════════════════════════════════════════════════════════════════════"

# Install v4l2loopback
apt-get update -qq
apt-get install -y v4l2loopback-dkms v4l2loopback-utils

# Load kernel module with virtual camera settings
modprobe -r v4l2loopback 2>/dev/null || true
modprobe v4l2loopback exclusive_caps=1 video_nr=0 card_label="Translucid Virtual Camera"

# Verify /dev/video0 exists
if [ -e /dev/video0 ]; then
    echo "✓ /dev/video0 created"
else
    echo "✗ Failed to create /dev/video0"
    exit 1
fi

# Make persistent
echo "v4l2loopback" >> /etc/modules 2>/dev/null || true
cat > /etc/modprobe.d/v4l2loopback.conf << EOF
options v4l2loopback exclusive_caps=1 video_nr=0 card_label="Translucid Virtual Camera"
EOF

# Stop current Neko container
echo "Stopping current Neko container..."
docker stop $(docker ps -q --filter ancestor=ghcr.io/m1k1o/neko/firefox) 2>/dev/null || true
docker rm $(docker ps -aq --filter ancestor=ghcr.io/m1k1o/neko/firefox) 2>/dev/null || true

# Create docker-compose with uplink support
mkdir -p /opt/translucid
cat > /opt/translucid/docker-compose.yaml << EOF
version: "3.8"
services:
  neko:
    image: "ghcr.io/m1k1o/neko/firefox:latest"
    restart: "unless-stopped"
    shm_size: "2gb"
    ports:
      - "8080:8080"
      - "52000-52100:52000-52100/udp"
    devices:
      - /dev/video0:/dev/video0
    environment:
      NEKO_DESKTOP_SCREEN: 1280x720@30
      NEKO_MEMBER_MULTIUSER_USER_PASSWORD: translucid
      NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD: admin
      NEKO_WEBRTC_EPR: 52000-52100
      NEKO_WEBRTC_ICELITE: "1"
      # ⭐ UPLINK CONFIG ⭐
      NEKO_CAPTURE_WEBCAM_ENABLED: "true"
      NEKO_CAPTURE_WEBCAM_DEVICE: /dev/video0
      NEKO_CAPTURE_WEBCAM_WIDTH: "640"
      NEKO_CAPTURE_WEBCAM_HEIGHT: "480"
      NEKO_CAPTURE_MICROPHONE_ENABLED: "true"
      NEKO_CAPTURE_MICROPHONE_DEVICE: audio_input
EOF

# Start new container
echo "Starting Neko with uplink support..."
cd /opt/translucid
docker-compose up -d

# Wait for container to start
sleep 5

# Verify
echo ""
echo "═══════════════════════════════════════════════════════════════════════"
echo "SETUP COMPLETE!"
echo "═══════════════════════════════════════════════════════════════════════"
docker ps --filter ancestor=ghcr.io/m1k1o/neko/firefox
echo ""
echo "Checking container logs for webcam/mic config..."
docker logs $(docker ps -q --filter ancestor=ghcr.io/m1k1o/neko/firefox) 2>&1 | grep -i "webcam\|microphone\|capture" | head -10
'
```

### Step 3: Verify Setup
```bash
# Check container is running
docker ps

# Check webcam device is accessible inside container
docker exec $(docker ps -q --filter ancestor=ghcr.io/m1k1o/neko/firefox) ls -la /dev/video0

# Check Neko logs for webcam/mic initialization
docker logs $(docker ps -q --filter ancestor=ghcr.io/m1k1o/neko/firefox) 2>&1 | grep -E "webcam|microphone|capture" | head -20
```

## Browser Testing

After the server is configured, test in browser console:

```javascript
// 1. Start microphone uplink
startMicUplink()
// Watch for: [UPLINK] [RENEGOTIATION] onnegotiationneeded fired!
// Watch for: [UPLINK] ✓ Renegotiation answer received

// 2. Start webcam uplink
startWebcamUplink()

// 3. Check status
getUplinkStatus()

// 4. Open Google Meet inside VM - mic/webcam should now work!
```

## Expected Server Logs

When uplink is working, you should see in docker logs:
```
INF received new remote track kind=audio mime=audio/opus
INF received new remote track kind=video mime=video/VP8
```

## Troubleshooting

### No /dev/video0
```bash
# Check if module loaded
lsmod | grep v4l2loopback

# Load manually
sudo modprobe v4l2loopback exclusive_caps=1 video_nr=0
```

### Container can't access /dev/video0
```bash
# Check device permissions
ls -la /dev/video0

# Fix permissions
sudo chmod 666 /dev/video0
```

### Renegotiation offer sent but no answer
Check that webcam/mic is enabled in container:
```bash
docker exec $(docker ps -q --filter ancestor=ghcr.io/m1k1o/neko/firefox) env | grep NEKO_CAPTURE
```

Should show:
```
NEKO_CAPTURE_WEBCAM_ENABLED=true
NEKO_CAPTURE_MICROPHONE_ENABLED=true
```

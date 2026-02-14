#!/bin/bash
# ============================================================================
# Build ALL Neko DRM images and push to ECR
# This builds both Firefox and Chromium images with VM activity extension
#
# Usage:
#   ./build-and-push-ec2.sh              # Build ALL images
#   ./build-and-push-ec2.sh firefox      # Build only Firefox
#   ./build-and-push-ec2.sh chromium     # Build only Chromium
#   ./build-and-push-ec2.sh --no-deploy  # Build + push, skip local deploy
#
# ECR Tags:
#   :latest          → Firefox DRM (Dockerfile.drm)
#   :chromium-latest → Chromium DRM (Dockerfile.drm.chromium)
# ============================================================================

set -e

# Configuration
ECR_REPO="289259596817.dkr.ecr.us-east-2.amazonaws.com/translucid-neko-drm"
AWS_REGION="us-east-2"
BUILD_TARGET="${1:-all}"
NO_DEPLOY=false

# Parse flags
for arg in "$@"; do
  case $arg in
    --no-deploy) NO_DEPLOY=true ;;
  esac
done

echo "============================================"
echo "  Translucid Neko DRM Image Builder"
echo "============================================"
echo "ECR Repo:     $ECR_REPO"
echo "Build Target: $BUILD_TARGET"
echo "Deploy Local: $([ "$NO_DEPLOY" = true ] && echo 'NO' || echo 'YES')"
echo "Date:         $(date)"
echo "============================================"
echo ""

# ============================================================================
# STEP 1: Authenticate to ECR
# ============================================================================
echo "=== Authenticating to ECR ==="
aws ecr get-login-password --region $AWS_REGION | docker login --username AWS --password-stdin $ECR_REPO
echo "ECR login successful"
echo ""

# ============================================================================
# STEP 2: Build Firefox DRM Image (Dockerfile.drm → :latest)
# Base: ghcr.io/m1k1o/neko/firefox:latest
# Includes: DRM encryption, VM activity extension (.xpi for Firefox)
# ============================================================================
if [ "$BUILD_TARGET" = "all" ] || [ "$BUILD_TARGET" = "firefox" ]; then
  echo "=== Building Firefox DRM Image ==="
  echo "Dockerfile: Dockerfile.drm"
  echo "Tag:        $ECR_REPO:latest"
  echo ""

  docker build -f Dockerfile.drm -t $ECR_REPO:latest .

  echo ""
  echo "=== Pushing Firefox DRM Image ==="
  docker push $ECR_REPO:latest

  echo "✓ Firefox DRM image pushed: $ECR_REPO:latest"
  echo ""
fi

# ============================================================================
# STEP 3: Build Chromium DRM Image (Dockerfile.drm.chromium → :chromium-latest)
# Base: ghcr.io/m1k1o/neko/chromium:latest
# Includes: DRM encryption, webcam/mic support, VM activity extension
# ============================================================================
if [ "$BUILD_TARGET" = "all" ] || [ "$BUILD_TARGET" = "chromium" ]; then
  echo "=== Building Chromium DRM Image ==="
  echo "Dockerfile: Dockerfile.drm.chromium"
  echo "Tag:        $ECR_REPO:chromium-latest"
  echo ""

  docker build -f Dockerfile.drm.chromium -t $ECR_REPO:chromium-latest .

  echo ""
  echo "=== Pushing Chromium DRM Image ==="
  docker push $ECR_REPO:chromium-latest

  echo "✓ Chromium DRM image pushed: $ECR_REPO:chromium-latest"
  echo ""
fi

# ============================================================================
# STEP 4: Cleanup old Docker images to save disk space
# ============================================================================
echo "=== Cleaning up dangling images ==="
docker image prune -f 2>/dev/null || true
echo ""

# ============================================================================
# STEP 5: (Optional) Local test deployment
# ============================================================================
if [ "$NO_DEPLOY" = false ] && [ "$BUILD_TARGET" != "firefox" ]; then
  echo "=== Setting up v4l2loopback ==="
  sudo modprobe -r v4l2loopback 2>/dev/null || true
  sudo modprobe v4l2loopback video_nr=0 card_label="NekoCam" exclusive_caps=1 2>/dev/null || echo "v4l2loopback not available (skip)"
  echo ""

  echo "=== Deploying Chromium Container for Testing ==="
  PUBLIC_IP=$(curl -s http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || echo "127.0.0.1")
  echo "Public IP: $PUBLIC_IP"

  docker stop translucid-neko 2>/dev/null || true
  docker rm translucid-neko 2>/dev/null || true

  DEVICE_FLAG=""
  if [ -e /dev/video0 ]; then
    DEVICE_FLAG="--device /dev/video0:/dev/video0 -e NEKO_CAPTURE_WEBCAM_ENABLED=true -e NEKO_CAPTURE_WEBCAM_DEVICE=/dev/video0"
  fi

  docker run -d \
    --name translucid-neko \
    --restart unless-stopped \
    --shm-size=2g \
    --cap-add=SYS_ADMIN \
    -p 8080:8080 \
    -p 52000:52000/udp \
    -p 52000:52000/tcp \
    -e NEKO_WEBRTC_UDPMUX=52000 \
    -e NEKO_WEBRTC_TCPMUX=52000 \
    -e NEKO_WEBRTC_ICELITE=true \
    -e NEKO_WEBRTC_NAT1TO1=$PUBLIC_IP \
    -e NEKO_MEMBER_MULTIUSER_USER_PASSWORD=translucid \
    -e NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD=admin \
    -e NEKO_SESSION_IMPLICIT_HOSTING=true \
    -e NEKO_SCREEN=1280x720@25 \
    -e NEKO_VIDEO_CODEC=h264 \
    -e NEKO_VIDEO_BITRATE=2000 \
    -e NEKO_MAX_FPS=25 \
    -e NEKO_AUDIO_CODEC=opus \
    -e NEKO_DRM_ENABLED=true \
    -e NEKO_DRM_MODE=cbc \
    -e NEKO_DRM_KEY=3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c \
    -e NEKO_DRM_KEY_ID=00000000000000000000000000000001 \
    -e NEKO_DRM_IV=d5fbd6b82ed93e4ef98ae40931ee33b7 \
    -e NEKO_CAPTURE_MICROPHONE_ENABLED=true \
    -e NEKO_CAPTURE_MICROPHONE_DEVICE=audio_input \
    $DEVICE_FLAG \
    $ECR_REPO:chromium-latest

  echo ""
  echo "Test container deployed: http://$PUBLIC_IP:8080"
fi

echo ""
echo "============================================"
echo "  BUILD COMPLETE"
echo "============================================"
echo "Firefox DRM:  $ECR_REPO:latest"
echo "Chromium DRM: $ECR_REPO:chromium-latest"
echo ""
echo "Orchestrator mapping:"
echo "  browserType=firefox  → :latest"
echo "  browserType=chromium → :chromium-latest"
echo "============================================"

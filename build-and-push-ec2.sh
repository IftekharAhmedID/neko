#!/bin/bash
# Build Neko Chromium DRM image on EC2 and push to ECR
# Run this script on the EC2 instance after transferring neko-fork directory

set -e

# Configuration
ECR_REPO="289259596817.dkr.ecr.us-east-2.amazonaws.com/translucid-neko-drm"
IMAGE_TAG="chromium-latest"
AWS_REGION="us-east-2"

echo "=== Building Neko Chromium DRM Image ==="
echo "ECR Repo: $ECR_REPO"
echo "Tag: $IMAGE_TAG"

# Authenticate to ECR
echo ""
echo "=== Authenticating to ECR ==="
aws ecr get-login-password --region $AWS_REGION | docker login --username AWS --password-stdin $ECR_REPO

# Build the image
echo ""
echo "=== Building Docker Image ==="
docker build -f Dockerfile.drm -t $ECR_REPO:$IMAGE_TAG .

# Also tag as latest
docker tag $ECR_REPO:$IMAGE_TAG $ECR_REPO:latest

# Push to ECR
echo ""
echo "=== Pushing to ECR ==="
docker push $ECR_REPO:$IMAGE_TAG
docker push $ECR_REPO:latest

echo ""
echo "=== Build Complete ==="
echo "Image: $ECR_REPO:$IMAGE_TAG"
echo "Image: $ECR_REPO:latest"

# Setup v4l2loopback properly
echo ""
echo "=== Setting up v4l2loopback ==="
sudo modprobe -r v4l2loopback 2>/dev/null || true
sudo modprobe v4l2loopback video_nr=0 card_label="NekoCam" exclusive_caps=1
echo "v4l2loopback configured with exclusive_caps=1"

# Deploy the new container
echo ""
echo "=== Deploying Container ==="
PUBLIC_IP=$(curl -s http://169.254.169.254/latest/meta-data/public-ipv4)
echo "Public IP: $PUBLIC_IP"

docker stop translucid-neko 2>/dev/null || true
docker rm translucid-neko 2>/dev/null || true

docker run -d \
  --name translucid-neko \
  --restart unless-stopped \
  --shm-size=2g \
  --cap-add=SYS_ADMIN \
  -p 8080:8080 \
  -p 52000:52000/udp \
  -p 52000:52000/tcp \
  --device /dev/video0:/dev/video0 \
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
  -e NEKO_CAPTURE_WEBCAM_ENABLED=true \
  -e NEKO_CAPTURE_WEBCAM_DEVICE=/dev/video0 \
  -e NEKO_CAPTURE_WEBCAM_WIDTH=1280 \
  -e NEKO_CAPTURE_WEBCAM_HEIGHT=720 \
  -e NEKO_CAPTURE_MICROPHONE_ENABLED=true \
  -e NEKO_CAPTURE_MICROPHONE_DEVICE=audio_input \
  $ECR_REPO:latest

echo ""
echo "=== Deployment Complete ==="
echo "Access at: http://$PUBLIC_IP:8080"
echo "Password: translucid"

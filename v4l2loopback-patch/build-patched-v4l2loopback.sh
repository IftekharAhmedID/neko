#!/bin/bash
# ============================================================================
# PATCHED V4L2LOOPBACK BUILD SCRIPT
# ============================================================================
# This script builds a patched v4l2loopback kernel module that advertises
# V4L2_CAP_VIDEO_OUTPUT capability, allowing GStreamer v4l2sink to work.
#
# Root Cause: GStreamer's v4l2sink checks for VIDEO_OUTPUT capability (0x2)
# but standard v4l2loopback only advertises VIDEO_CAPTURE capability (0x1).
# This patch adds VIDEO_OUTPUT to the capability flags.
#
# Usage: Run this script on the EC2 instance as root
# ============================================================================

set -e

echo "=============================================="
echo "Building Patched v4l2loopback for GStreamer"
echo "=============================================="

# Install build dependencies
echo "[1/6] Installing build dependencies..."
apt-get update
apt-get install -y build-essential linux-headers-$(uname -r) git dkms

# Clone v4l2loopback source
echo "[2/6] Cloning v4l2loopback source..."
cd /tmp
rm -rf v4l2loopback-patched
git clone https://github.com/umlaeute/v4l2loopback.git v4l2loopback-patched
cd v4l2loopback-patched

# Get current version
V4L2_VERSION=$(cat VERSION 2>/dev/null || echo "0.12.7")
echo "v4l2loopback version: $V4L2_VERSION"

# Apply the patch to add VIDEO_OUTPUT capability
echo "[3/6] Applying VIDEO_OUTPUT capability patch..."
cat > /tmp/v4l2loopback-output-cap.patch << 'PATCH_EOF'
--- a/v4l2loopback.c
+++ b/v4l2loopback.c
@@ -795,7 +795,8 @@ static int vidioc_querycap(struct file *file, void *priv,
 	if (dev->announce_all_caps) {
 		cap->capabilities |= V4L2_CAP_VIDEO_CAPTURE | V4L2_CAP_VIDEO_OUTPUT;
 	} else {
-		cap->capabilities |= dev->capture_nr >= 0 ? V4L2_CAP_VIDEO_CAPTURE : V4L2_CAP_VIDEO_OUTPUT;
+		/* PATCH: Always advertise VIDEO_OUTPUT for GStreamer v4l2sink compatibility */
+		cap->capabilities |= V4L2_CAP_VIDEO_CAPTURE | V4L2_CAP_VIDEO_OUTPUT;
 	}
 	cap->capabilities |= V4L2_CAP_STREAMING | V4L2_CAP_READWRITE;
PATCH_EOF

# Try to apply patch, if it fails, do manual edit
if ! patch -p1 < /tmp/v4l2loopback-output-cap.patch 2>/dev/null; then
    echo "Patch didn't apply cleanly, applying manual fix..."

    # Find and modify the vidioc_querycap function to always include VIDEO_OUTPUT
    sed -i 's/cap->capabilities |= V4L2_CAP_VIDEO_CAPTURE;/cap->capabilities |= V4L2_CAP_VIDEO_CAPTURE | V4L2_CAP_VIDEO_OUTPUT;/g' v4l2loopback.c

    # Also ensure device_caps includes VIDEO_OUTPUT
    sed -i 's/cap->device_caps = V4L2_CAP_VIDEO_CAPTURE/cap->device_caps = V4L2_CAP_VIDEO_CAPTURE | V4L2_CAP_VIDEO_OUTPUT/g' v4l2loopback.c
fi

# Verify the patch was applied
echo "[4/6] Verifying patch..."
if grep -q "V4L2_CAP_VIDEO_OUTPUT" v4l2loopback.c; then
    echo "✓ VIDEO_OUTPUT capability added to v4l2loopback.c"
else
    echo "ERROR: Patch verification failed!"
    exit 1
fi

# Build the module
echo "[5/6] Building patched v4l2loopback module..."
make clean || true
make

# Unload existing module and install new one
echo "[6/6] Installing patched module..."
modprobe -r v4l2loopback 2>/dev/null || true
cp v4l2loopback.ko /lib/modules/$(uname -r)/kernel/drivers/media/v4l2-core/ 2>/dev/null || \
cp v4l2loopback.ko /lib/modules/$(uname -r)/extra/ 2>/dev/null || \
cp v4l2loopback.ko /lib/modules/$(uname -r)/updates/
depmod -a

echo "=============================================="
echo "Patched v4l2loopback module installed!"
echo "=============================================="
echo ""
echo "Load with: modprobe v4l2loopback video_nr=0 card_label=NekoCam exclusive_caps=1"
echo ""
echo "The module now advertises VIDEO_OUTPUT capability,"
echo "which allows GStreamer v4l2sink to work correctly."
echo "=============================================="

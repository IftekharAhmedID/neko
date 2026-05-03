#!/bin/bash
set -euo pipefail

GHCR_REPO="${GHCR_REPO:-ghcr.io/iftekharahmedid/translucid-neko-drm}"
BETA_TAG="${BETA_TAG:-chromium-latest-beta}"
SOURCE_TAG="${SOURCE_TAG:-chromium-latest}"

if [ -z "${GHCR_TOKEN:-}" ]; then
  echo "ERROR: GHCR_TOKEN is required for docker login/push" >&2
  exit 1
fi

echo "============================================"
echo "  Translucid Chromium CDP Beta Image Builder"
echo "============================================"
echo "Source image: ${GHCR_REPO}:${SOURCE_TAG}"
echo "Beta image:   ${GHCR_REPO}:${BETA_TAG}"
echo "Dockerfile:   Dockerfile.cdp.chromium-beta"
echo "Date:         $(date)"
echo "============================================"
echo ""

echo "=== Authenticating to GHCR ==="
printf '%s' "$GHCR_TOKEN" | docker login ghcr.io -u IftekharAhmedID --password-stdin
echo "GHCR login successful"
echo ""

echo "=== Pulling battle-tested source Chromium image ==="
docker pull "${GHCR_REPO}:${SOURCE_TAG}"
echo ""

echo "=== Building beta overlay image ==="
docker build \
  -f Dockerfile.cdp.chromium-beta \
  -t "${GHCR_REPO}:${BETA_TAG}" \
  .
echo ""

echo "=== Pushing beta image ==="
docker push "${GHCR_REPO}:${BETA_TAG}"
echo ""

echo "=== Build complete ==="
docker image inspect "${GHCR_REPO}:${BETA_TAG}" --format '{{.Id}} {{.Size}}'
echo "Beta image pushed: ${GHCR_REPO}:${BETA_TAG}"

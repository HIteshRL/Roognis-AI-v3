#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# Download Stable Diffusion v1.5 checkpoint into the comfy_models Docker volume
# Run this ONCE on the host machine — approximately 4GB download
#
# Usage: sh scripts/comfyui-model-download.sh
# ─────────────────────────────────────────────────────────────────────────────
set -e

MODEL_URL="https://huggingface.co/runwayml/stable-diffusion-v1-5/resolve/main/v1-5-pruned-emaonly.ckpt"
VOLUME_NAME="roognis_comfy_models"
DEST_PATH="checkpoints/v1-5-pruned-emaonly.ckpt"

echo "[comfyui-setup] Downloading SD v1.5 checkpoint (~4GB)..."

docker run --rm \
  -v "${VOLUME_NAME}:/models" \
  curlimages/curl:latest \
  -L "${MODEL_URL}" \
  -o "/models/${DEST_PATH}" \
  --create-dirs \
  --progress-bar

echo "[comfyui-setup] Model downloaded to ${DEST_PATH} inside ${VOLUME_NAME}."
echo "[comfyui-setup] ComfyUI is ready for image generation."

#!/bin/sh
set -e

# Start Ollama server in the background
ollama serve &
OLLAMA_PID=$!

# Wait until the REST API is accepting connections
echo "[ollama-init] Waiting for Ollama API to become ready..."
until curl -sf http://localhost:11434/api/tags > /dev/null 2>&1; do
  sleep 2
done
echo "[ollama-init] Ollama API is up."

# Pull required models — idempotent, skips if already in the volume
echo "[ollama-init] Pulling nomic-embed-text (RAG embeddings)..."
ollama pull nomic-embed-text

echo "[ollama-init] Pulling qwen2.5 (text inference fallback)..."
ollama pull qwen2.5

echo "[ollama-init] All models ready. Roognis AI is fully loaded."

# Keep the container alive — Docker tracks this PID as PID 1's child
wait $OLLAMA_PID

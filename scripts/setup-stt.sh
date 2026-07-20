#!/usr/bin/env bash
# setup-stt.sh — sets up local speech-to-text: whisper.cpp + the ggml-small model.
# Idempotent: a second run detects what is present and downloads nothing again.
set -euo pipefail

MODEL_DIR="$HOME/.spectro/models"
MODEL_FILE="$MODEL_DIR/ggml-small.bin"
MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin"

# Fixed version, fixed checksum: on the FIRST verified download, paste the real sum
# (the script prints it) and never change it again afterwards.
# Verified 2026-07-12 against the Hugging Face LFS oid of
# ggerganov/whisper.cpp:ggml-small.bin AND a fresh local download.
PLACEHOLDER="PASTE-ON-THE-FIRST-VERIFIED-DOWNLOAD"
EXPECTED_SHA256="1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b"

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

verify_model() {
  local actual
  actual="$(sha256_of "$MODEL_FILE")"
  if [ "$EXPECTED_SHA256" = "$PLACEHOLDER" ]; then
    echo "EXPECTED_SHA256 is still the placeholder. Computed sum: $actual"
    echo "Verify the sum against the official source, paste it into scripts/setup-stt.sh"
    echo "and run the script again."
    exit 1
  fi
  if [ "$actual" != "$EXPECTED_SHA256" ]; then
    echo "ERROR: SHA256 mismatch for $MODEL_FILE" >&2
    echo "  expected: $EXPECTED_SHA256" >&2
    echo "  actual:   $actual" >&2
    echo "Deleting the file (incomplete download or tampering)." >&2
    rm -f "$MODEL_FILE"
    exit 1
  fi
}

# --- 1. install whisper.cpp and ffmpeg (OS-dependent) ---
OS="$(uname -s)"
case "$OS" in
  Darwin)
    if ! command -v brew >/dev/null 2>&1; then
      echo "ERROR: Homebrew missing (https://brew.sh) — install it first." >&2
      exit 1
    fi
    if command -v whisper-cli >/dev/null 2>&1; then
      echo "whisper-cli already present."
    else
      brew install whisper-cpp
    fi
    if command -v ffmpeg >/dev/null 2>&1; then
      echo "ffmpeg already present."
    else
      brew install ffmpeg
    fi
    ;;
  Linux)
    if ! command -v whisper-cli >/dev/null 2>&1; then
      echo "ERROR: whisper-cli missing. Install it via the package manager, if packaged," >&2
      echo "or build it: https://github.com/ggerganov/whisper.cpp" >&2
      echo "(cmake -B build && cmake --build build; put build/bin/whisper-cli on the PATH)." >&2
      exit 1
    fi
    if ! command -v ffmpeg >/dev/null 2>&1; then
      echo "ERROR: ffmpeg missing — use the package manager (e.g. apt install ffmpeg)." >&2
      exit 1
    fi
    echo "whisper-cli and ffmpeg already present."
    ;;
  *)
    echo "ERROR: unsupported OS '$OS'. On Windows: use WSL2." >&2
    exit 1
    ;;
esac

# --- 2. download + verify the model (idempotent) ---
mkdir -p "$MODEL_DIR"

if [ -f "$MODEL_FILE" ]; then
  verify_model
  echo "Model already present, checksum ok: $MODEL_FILE"
else
  echo "Downloading ggml-small.bin (~460 MB) into $MODEL_DIR ..."
  curl -L --fail --progress-bar -o "$MODEL_FILE.download" "$MODEL_URL"
  mv "$MODEL_FILE.download" "$MODEL_FILE"
  verify_model
  echo "Model downloaded and verified: $MODEL_FILE"
fi

echo "Setup done — /voice in the spectroscope CLI is ready to use."

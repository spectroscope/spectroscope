#!/usr/bin/env bash
# setup-tts.sh — reproducible TTS setup for spectroscope. Downloads the
# piper binary (GitHub release rhasspy/piper, matching OS/arch) and the voice
# en_US-lessac-medium (Hugging Face, rhasspy/piper-voices) into ~/.spectro/models/.
# Idempotent: a second run only verifies, downloads nothing again.
set -euo pipefail

PIPER_VERSION="2023.11.14-2"
VOICE="en_US-lessac-medium"
MODELS_DIR="$HOME/.spectro/models"
PIPER_DIR="$MODELS_DIR/piper"
PIPER_RELEASE_BASE="https://github.com/rhasspy/piper/releases/download/$PIPER_VERSION"
VOICE_BASE="https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/lessac/medium"

# SHA256 checksums of the fixed versions. Pinned 2026-07-20 from the official
# release assets (piper 2023.11.14-2 tarballs, hashed after download) and the
# Hugging Face LFS metadata / v1.0.0 resolve URLs for the voice files.
SHA256_PIPER_MACOS_ARM64="6b1eb03b3735946cb35216e063e7eebcc33a6bbf5dd96ec0217959bf1cdcb0cc"
SHA256_PIPER_MACOS_X64="ced85c0a3df13945b1e623b878a48fdc2854d5c485b4b67f62857cf551deaf8b"
SHA256_PIPER_LINUX_X64="a50cb45f355b7af1f6d758c1b360717877ba0a398cc8cbe6d2a7a3a26e225992"
SHA256_PIPER_LINUX_ARM64="fea0fd2d87c54dbc7078d0f878289f404bd4d6eea6e7444a77835d1537ab88eb"
SHA256_VOICE_ONNX="5efe09e69902187827af646e1a6e9d269dee769f9877d17b16b1b46eeaaf019f"
SHA256_VOICE_JSON="efe19c417bed055f2d69908248c6ba650fa135bc868b0e6abb3da181dab690a0"

OS="$(uname -s)"; ARCH="$(uname -m)"
case "$OS/$ARCH" in
  Darwin/arm64)  PIPER_ASSET="piper_macos_aarch64.tar.gz"; SHA256_PIPER="$SHA256_PIPER_MACOS_ARM64" ;;
  Darwin/x86_64) PIPER_ASSET="piper_macos_x64.tar.gz";     SHA256_PIPER="$SHA256_PIPER_MACOS_X64" ;;
  Linux/x86_64)  PIPER_ASSET="piper_linux_x86_64.tar.gz";  SHA256_PIPER="$SHA256_PIPER_LINUX_X64" ;;
  Linux/aarch64) PIPER_ASSET="piper_linux_aarch64.tar.gz"; SHA256_PIPER="$SHA256_PIPER_LINUX_ARM64" ;;
  *) echo "ERROR: Unsupported platform: $OS/$ARCH (Windows: run under WSL)."; exit 1 ;;
esac

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}

check_sha256() { # $1 file, $2 expected sum, $3 display name
  local actual; actual="$(sha256_of "$1")"
  if [ "$2" = "PLACEHOLDER_SHA256" ]; then
    echo "ERROR: Checksum for $3 is not yet entered."
    echo "  Computed sum: $actual — verify the source, enter it above, run again."
    exit 1
  fi
  if [ "$actual" != "$2" ]; then
    echo "ERROR: SHA256 mismatch for $3 — file tampered with or incomplete."
    echo "  expected: $2"
    echo "  received: $actual"
    rm -f "$1"; exit 1
  fi
}

download() { # $1 url, $2 target file — idempotent: do not re-download an existing file
  if [ -f "$2" ]; then echo "$(basename "$2") already downloaded — skipped."; return; fi
  echo "Downloading $1 ..."
  curl -fL --retry 3 -o "$2.part" "$1"
  mv "$2.part" "$2"
}

fetch_checked() { # $1 file name, $2 url, $3 expected sum
  local target="$MODELS_DIR/$1"
  download "$2" "$target"
  check_sha256 "$target" "$3" "$1"
  echo "$1 present and verified."
}

mkdir -p "$MODELS_DIR"

# 1) piper binary
if [ -x "$PIPER_DIR/piper" ]; then
  echo "piper already installed: $PIPER_DIR/piper — skipped."
else
  fetch_checked "$PIPER_ASSET" "$PIPER_RELEASE_BASE/$PIPER_ASSET" "$SHA256_PIPER"
  tar -xzf "$MODELS_DIR/$PIPER_ASSET" -C "$MODELS_DIR"   # extracts into $PIPER_DIR
  rm -f "$MODELS_DIR/$PIPER_ASSET"
  chmod +x "$PIPER_DIR/piper"
  echo "piper installed: $PIPER_DIR/piper"
fi

# 2) Voice (ONNX model + JSON config)
fetch_checked "$VOICE.onnx"      "$VOICE_BASE/$VOICE.onnx"      "$SHA256_VOICE_ONNX"
fetch_checked "$VOICE.onnx.json" "$VOICE_BASE/$VOICE.onnx.json" "$SHA256_VOICE_JSON"

# 3) Smoke test
echo "Test: synthesizing a sample sentence ..."
echo "The setup is complete." | "$PIPER_DIR/piper" \
  --model "$MODELS_DIR/$VOICE.onnx" --output_file "$MODELS_DIR/setup-test.wav" >/dev/null 2>&1
echo "OK. Listen: afplay (macOS) or aplay (Linux) $MODELS_DIR/setup-test.wav"

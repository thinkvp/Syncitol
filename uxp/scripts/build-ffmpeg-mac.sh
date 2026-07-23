#!/usr/bin/env bash
# CI-friendly macOS FFmpeg static build — audio-only, LGPL-safe config.
# Downloads FFmpeg source if not found, builds universal (arm64+x86_64).
#
# Usage: bash scripts/build-ffmpeg-mac.sh [arm64|x86_64|universal]
#   Default: universal
set -euo pipefail

ARCH="${1:-universal}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# FFmpeg source: try env var, then look for a local dir, then download.
FFMPEG_VER="8.1.2"
FFMPEG_SRC="${FFMPEG_SRC_DIR:-}"
if [ -z "$FFMPEG_SRC" ]; then
  if [ -d "$REPO_ROOT/ffmpeg-${FFMPEG_VER}" ]; then
    FFMPEG_SRC="$REPO_ROOT/ffmpeg-${FFMPEG_VER}"
  fi
fi
PREFIX_BASE="${PREFIX_BASE:-$REPO_ROOT/ffmpeg-out}"

COMMON_FLAGS=(
  --disable-shared --enable-static
  --enable-small --disable-debug
  --disable-programs --disable-doc
  --disable-avdevice --disable-avfilter
  --disable-network --disable-everything
  --enable-protocol=file,pipe
  --enable-demuxer=mov,mxf,wav,w64,aiff,mp3,mpegts,matroska,flac,ogg,caf,aac,ac3,eac3,asf,dts
  --enable-decoder=aac,aac_latm,ac3,eac3,mp1,mp1float,mp2,mp2float,mp3,mp3float,pcm_s16le,pcm_s16be,pcm_s24le,pcm_s24be,pcm_s32le,pcm_s32be,pcm_s8,pcm_u8,pcm_f32le,pcm_f32be,pcm_f64le,pcm_alaw,pcm_mulaw,alac,flac,vorbis,opus,dca,pcm_dvd,pcm_bluray
  --enable-parser=aac,aac_latm,ac3,mpegaudio,flac,vorbis,opus,dca
  --pkg-config-flags=--static
)

download_ffmpeg() {
  if [ -n "$FFMPEG_SRC" ] && [ -d "$FFMPEG_SRC" ]; then
    echo "Using FFmpeg source at $FFMPEG_SRC"
    return
  fi
  FFMPEG_SRC="$REPO_ROOT/ffmpeg-${FFMPEG_VER}"
  if [ -d "$FFMPEG_SRC" ]; then
    echo "Found FFmpeg source at $FFMPEG_SRC"
    return
  fi
  echo "Downloading FFmpeg ${FFMPEG_VER}..."
  curl -fsSL -o "$REPO_ROOT/ffmpeg.tar.xz" \
    "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VER}.tar.xz"
  tar xf "$REPO_ROOT/ffmpeg.tar.xz" -C "$REPO_ROOT"
  rm "$REPO_ROOT/ffmpeg.tar.xz"
  echo "FFmpeg source ready at $FFMPEG_SRC"
}

build_arch() {
  local arch="$1"
  local prefix="$PREFIX_BASE/$arch"

  echo "=== Building FFmpeg for $arch ==="
  cd "$FFMPEG_SRC"
  make distclean >/dev/null 2>&1 || true

  # FFmpeg 8.1.2 x86 inline asm (__asm__ in mathops.h) uses the "c"
  # register constraint rejected by Clang 16+ (macOS 15+). --disable-inline-asm
  # drops only those handwritten GCC-asm blocks; nasm SIMD (hot paths) and
  # arm64 NEON are unaffected. Audio-only, so perf impact is zero.
  local x86_flag=""
  if [ "$arch" = "x86_64" ]; then
    x86_flag="--disable-inline-asm"
  fi

  # On Apple Silicon runners, --arch alone doesn't force cross-compilation;
  # clang defaults to the host arch. Explicit -arch flags ensure the right
  # slices for lipo later. Harmless (redundant) for arm64-on-arm64.
  ./configure \
    --prefix="$prefix" \
    --arch="$arch" \
    --cc=clang \
    --extra-cflags="-arch $arch" \
    --extra-ldflags="-arch $arch" \
    $x86_flag \
    "${COMMON_FLAGS[@]}"

  make -j"$(sysctl -n hw.logicalcpu 2>/dev/null || echo 4)"
  make install

  echo "=== $arch done ==="
  ls -l "$prefix/lib/libav"*.a
}

lipo_libs() {
  local arm64_dir="$PREFIX_BASE/arm64/lib"
  local x64_dir="$PREFIX_BASE/x86_64/lib"
  local uni_dir="$PREFIX_BASE/universal/lib"

  echo "=== lipo: creating universal static libs ==="
  mkdir -p "$uni_dir"
  for lib in libavformat.a libavcodec.a libavutil.a libswresample.a; do
    echo "  lipo $lib → universal"
    lipo -create "$arm64_dir/$lib" "$x64_dir/$lib" -output "$uni_dir/$lib"
  done
  cp -R "$PREFIX_BASE/arm64/include" "$PREFIX_BASE/universal/"
  echo "=== universal libs ==="
  ls -l "$uni_dir"
}

download_ffmpeg

case "$ARCH" in
  arm64)   build_arch arm64 ;;
  x86_64)  build_arch x86_64 ;;
  universal)
    build_arch arm64
    build_arch x86_64
    lipo_libs
    ;;
  *) echo "Unknown arch: $ARCH"; exit 1 ;;
esac

echo "BUILD_FFMPEG_MAC_DONE"

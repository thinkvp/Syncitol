#!/usr/bin/env bash
# Static, audio-only FFmpeg for the Windows addon (MSVC toolchain, run from an
# MSYS2 shell started inside a VS 2022 x64 developer environment):
#   FFMPEG_SRC_DIR=/f/ffbuild/ffmpeg-8.1.2 PREFIX=/f/ffbuild/out-static bash scripts/build-ffmpeg-win.sh
# Then: scripts/build-addon-win.bat <PREFIX as a Windows path>
# Audio decoders and demuxers only: no video decoding is ever needed, and it
# keeps the addon (and so the plugin download) small.
set -e
cd "${FFMPEG_SRC_DIR:?set FFMPEG_SRC_DIR to the unpacked ffmpeg-8.1.2 source}"

export PATH="$(dirname "$(which cl.exe)"):$PATH"

echo "=== configure (STATIC) ==="
make distclean >/dev/null 2>&1 || true
./configure \
  --toolchain=msvc \
  --target-os=win64 \
  --arch=x86_64 \
  --prefix="${PREFIX:-/f/ffbuild/out-static}" \
  --disable-shared \
  --enable-static \
  --enable-small \
  --disable-debug \
  --disable-programs \
  --disable-doc \
  --disable-avdevice \
  --disable-avfilter \
  --disable-network \
  --disable-everything \
  --enable-protocol=file,pipe \
  --enable-demuxer=mov,mxf,wav,w64,aiff,mp3,mpegts,matroska,flac,ogg,caf,aac,ac3,eac3,asf,dts \
  --enable-decoder=aac,aac_latm,ac3,eac3,mp1,mp1float,mp2,mp2float,mp3,mp3float,pcm_s16le,pcm_s16be,pcm_s24le,pcm_s24be,pcm_s32le,pcm_s32be,pcm_s8,pcm_u8,pcm_f32le,pcm_f32be,pcm_f64le,pcm_alaw,pcm_mulaw,alac,flac,vorbis,opus,dca,pcm_dvd,pcm_bluray \
  --enable-parser=aac,aac_latm,ac3,mpegaudio,flac,vorbis,opus,dca

echo "=== make ==="
make -j"$(nproc)"

echo "=== install ==="
make install

echo "=== static libs ==="
ls -l "${PREFIX:-/f/ffbuild/out-static}/lib"
echo "=== static link deps (.pc Libs.private) ==="
grep -h "Libs.private" "${PREFIX:-/f/ffbuild/out-static}"/lib/pkgconfig/*.pc 2>/dev/null | sort -u
echo BUILD_STATIC_DONE

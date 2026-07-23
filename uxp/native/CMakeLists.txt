# CMake build for the Syncitol UXP hybrid addon — macOS.
#
# Produces syncitol.uxpaddon (a .dylib). Links FFmpeg statically for a
# self-contained addon — no ffmpeg-on-PATH required at runtime.
#
# Source files live alongside this CMakeLists.txt under src/ and uxp/src/.
# These are the same C++ files used by the Windows .vcxproj build.
#
# Prereqs:
#   1. FFmpeg static libs at FFMPEG_ROOT (build with scripts/build-ffmpeg-mac.sh)
#   2. macOS with Xcode CLT (clang, lipo)
#
# Usage:
#   cmake -S native -B native/build \
#     -DFFMPEG_ROOT=./ffmpeg-out/universal \
#     -DCMAKE_BUILD_TYPE=Release
#   cmake --build native/build
#   # Output: native/build/syncitol.uxpaddon

cmake_minimum_required(VERSION 3.20)
project(syncitol_addon_mac LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# Default to exporting all symbols (the UXP macros don't annotate visibility).
set(CMAKE_C_VISIBILITY_PRESET default)
set(CMAKE_CXX_VISIBILITY_PRESET default)

# --- Paths ---------------------------------------------------------------
set(FFMPEG_ROOT "" CACHE PATH "FFmpeg static install prefix (contains include/ and lib/)")
if(NOT FFMPEG_ROOT)
  message(FATAL_ERROR "Set -DFFMPEG_ROOT=/path/to/ffmpeg-out/universal")
endif()

# Source roots relative to this CMakeLists.txt.
set(DECODE_SRC  "${CMAKE_CURRENT_SOURCE_DIR}/src")
set(UXP_SRC     "${CMAKE_CURRENT_SOURCE_DIR}/uxp/src")

# --- Source files (same as the Windows .vcxproj) -------------------------
add_library(syncitol_uxpaddon SHARED
  ${UXP_SRC}/utilities/UxpAddon.cpp
  ${UXP_SRC}/utilities/UxpTask.cpp
  ${UXP_SRC}/utilities/UxpValue.cpp
  ${UXP_SRC}/module_syncitol.cpp
  ${DECODE_SRC}/syncitol_decode.cpp
)

target_include_directories(syncitol_uxpaddon PRIVATE
  ${FFMPEG_ROOT}/include
  ${UXP_SRC}/api
  ${UXP_SRC}/utilities
  ${DECODE_SRC}
)

# --- Static FFmpeg -------------------------------------------------------
find_library(AVFORMAT    avformat    PATHS ${FFMPEG_ROOT}/lib NO_DEFAULT_PATH REQUIRED)
find_library(AVCODEC     avcodec     PATHS ${FFMPEG_ROOT}/lib NO_DEFAULT_PATH REQUIRED)
find_library(AVUTIL      avutil      PATHS ${FFMPEG_ROOT}/lib NO_DEFAULT_PATH REQUIRED)
find_library(SWRESAMPLE  swresample  PATHS ${FFMPEG_ROOT}/lib NO_DEFAULT_PATH REQUIRED)

find_library(ICONV_LIB   iconv  REQUIRED)
find_library(Z_LIB       z      REQUIRED)
find_library(BZ2_LIB     bz2    REQUIRED)

# FFmpeg static libs pull in these system frameworks (visible in configure
# output under "External libraries"); link them all at once to avoid
# whack-a-mole linker errors.
target_link_libraries(syncitol_uxpaddon PRIVATE
  ${AVFORMAT} ${AVCODEC} ${SWRESAMPLE} ${AVUTIL}
  "-framework CoreFoundation"
  "-framework CoreVideo"
  "-framework CoreMedia"
  "-framework CoreImage"
  "-framework Security"
  "-framework AudioToolbox"
  "-framework VideoToolbox"
  "-framework Metal"
  "-framework AppKit"
  "-framework AVFoundation"
  ${ICONV_LIB} ${Z_LIB} ${BZ2_LIB}
)

# --- Output: syncitol.uxpaddon -------------------------------------------
set_target_properties(syncitol_uxpaddon PROPERTIES
  PREFIX ""
  SUFFIX ".uxpaddon"
  OUTPUT_NAME "syncitol"
  MACOSX_RPATH OFF
  INSTALL_RPATH "@loader_path"
)

# Ad-hoc code-sign so Premiere Pro's hardened runtime accepts it.
if(APPLE AND CMAKE_BUILD_TYPE STREQUAL "Release")
  add_custom_command(TARGET syncitol_uxpaddon POST_BUILD
    COMMAND codesign --sign - "$<TARGET_FILE:syncitol_uxpaddon>"
    COMMENT "Ad-hoc signing syncitol.uxpaddon"
  )
endif()

// syncitol_decode.h — interface for the FFmpeg decode/probe core.
#pragma once
#include <string>
#include <vector>
#include <cstdint>

namespace syncitol {

struct ProbeResult {
    bool ok = false;
    std::string error;
    double durationSec = 0.0;
    double frameRate = 0.0;       // from the video stream, for TC frame conversion
    bool hasAudio = false;
    std::string creationTime;     // container "creation_time" (MP4/MOV)
    std::string modificationDate; // container "modification_date" (MXF)
    std::string timecode;         // start timecode, if present
};

struct DecodeResult {
    bool ok = false;
    std::string error;
    int sampleRate = 0;
    std::vector<int16_t> samples; // mono s16
};

// Read container/stream metadata. Replaces the ffprobe call.
ProbeResult probeFile(const std::string& path);

// Decode [startSec, startSec+durationSec) of the primary audio stream, downmixed
// to mono and resampled to `sampleRate`, as signed 16-bit samples. Replaces the
// `ffmpeg -ss .. -t .. -ac 1 -ar R -f s16le` call.
DecodeResult decodeMonoPcm(const std::string& path, double startSec,
                           double durationSec, int sampleRate);

} // namespace syncitol

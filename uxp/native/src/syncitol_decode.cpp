// syncitol_decode.cpp — FFmpeg (libav*) audio decode + metadata probe.
//
// Pure C++, no UXP/N-API here — this is the part that replaces the ffmpeg/ffprobe
// command-line calls from the CEP build. The UXP addon glue (syncitol_addon.cpp)
// wraps these two functions.
//
// decodeMonoPcm(): decode [startSec, startSec+durationSec) of a file's primary
//   audio stream, downmix to mono, resample to `sampleRate`, return signed 16-bit
//   samples. Mirrors the old `ffmpeg -ss .. -t .. -ac 1 -ar R -f s16le` call.
//
// probeFile(): read container/stream metadata (duration, embedded record-start
//   timestamps, start timecode, video frame rate). Mirrors the old ffprobe call.

#include "syncitol_decode.h"

extern "C" {
#include <libavformat/avformat.h>
#include <libavcodec/avcodec.h>
#include <libavutil/opt.h>
#include <libavutil/dict.h>
#include <libswresample/swresample.h>
#include <libavutil/channel_layout.h>
}

#include <string>
#include <vector>
#include <cmath>

namespace syncitol {

static std::string dictGet(AVDictionary* d, const char* key) {
    if (!d) return std::string();
    AVDictionaryEntry* e = av_dict_get(d, key, nullptr, 0);
    return e && e->value ? std::string(e->value) : std::string();
}

ProbeResult probeFile(const std::string& path) {
    ProbeResult r;
    AVFormatContext* fmt = nullptr;
    if (avformat_open_input(&fmt, path.c_str(), nullptr, nullptr) < 0) {
        r.ok = false;
        r.error = "could not open file";
        return r;
    }
    if (avformat_find_stream_info(fmt, nullptr) < 0) {
        avformat_close_input(&fmt);
        r.ok = false;
        r.error = "could not read stream info";
        return r;
    }

    r.ok = true;
    if (fmt->duration > 0) r.durationSec = (double)fmt->duration / AV_TIME_BASE;

    // Container-level metadata: creation_time (MP4/MOV) and modification_date (MXF).
    r.creationTime = dictGet(fmt->metadata, "creation_time");
    r.modificationDate = dictGet(fmt->metadata, "modification_date");
    r.timecode = dictGet(fmt->metadata, "timecode");

    // Stream-level: a timecode track, and the video frame rate to convert TC frames.
    for (unsigned i = 0; i < fmt->nb_streams; i++) {
        AVStream* st = fmt->streams[i];
        if (r.timecode.empty()) {
            std::string stc = dictGet(st->metadata, "timecode");
            if (!stc.empty()) r.timecode = stc;
        }
        if (st->codecpar && st->codecpar->codec_type == AVMEDIA_TYPE_VIDEO && r.frameRate <= 0.0) {
            AVRational fr = st->avg_frame_rate.num ? st->avg_frame_rate : st->r_frame_rate;
            if (fr.num > 0 && fr.den > 0) r.frameRate = (double)fr.num / fr.den;
        }
        if (st->codecpar && st->codecpar->codec_type == AVMEDIA_TYPE_AUDIO) {
            r.hasAudio = true;
        }
    }

    avformat_close_input(&fmt);
    return r;
}

DecodeResult decodeMonoPcm(const std::string& path, double startSec,
                           double durationSec, int sampleRate) {
    DecodeResult out;
    out.sampleRate = sampleRate;

    AVFormatContext* fmt = nullptr;
    if (avformat_open_input(&fmt, path.c_str(), nullptr, nullptr) < 0) {
        out.error = "open failed"; return out;
    }
    if (avformat_find_stream_info(fmt, nullptr) < 0) {
        avformat_close_input(&fmt); out.error = "stream info failed"; return out;
    }

    int audioStream = av_find_best_stream(fmt, AVMEDIA_TYPE_AUDIO, -1, -1, nullptr, 0);
    if (audioStream < 0) {
        avformat_close_input(&fmt); out.error = "no audio stream"; return out;
    }
    AVStream* st = fmt->streams[audioStream];

    const AVCodec* dec = avcodec_find_decoder(st->codecpar->codec_id);
    if (!dec) { avformat_close_input(&fmt); out.error = "no decoder"; return out; }
    AVCodecContext* cdc = avcodec_alloc_context3(dec);
    avcodec_parameters_to_context(cdc, st->codecpar);
    if (avcodec_open2(cdc, dec, nullptr) < 0) {
        avcodec_free_context(&cdc); avformat_close_input(&fmt);
        out.error = "decoder open failed"; return out;
    }

    // Resampler: whatever comes in -> mono s16 @ sampleRate.
    SwrContext* swr = nullptr;
    AVChannelLayout inLayout;
    av_channel_layout_copy(&inLayout, &cdc->ch_layout);
    if (inLayout.nb_channels == 0) av_channel_layout_default(&inLayout, 2);
    AVChannelLayout monoLayout;
    av_channel_layout_default(&monoLayout, 1); // mono (avoids the C99 designated-init macro)
    swr_alloc_set_opts2(&swr, &monoLayout, AV_SAMPLE_FMT_S16, sampleRate,
                        &inLayout, cdc->sample_fmt, cdc->sample_rate, 0, nullptr);
    if (!swr || swr_init(swr) < 0) {
        if (swr) swr_free(&swr);
        avcodec_free_context(&cdc); avformat_close_input(&fmt);
        out.error = "resampler init failed"; return out;
    }

    // Input seek (fast — like `-ss` before `-i`): jump near startSec.
    int64_t seekTs = (int64_t)(startSec / av_q2d(st->time_base));
    av_seek_frame(fmt, audioStream, seekTs, AVSEEK_FLAG_BACKWARD);
    avcodec_flush_buffers(cdc);

    const double endSec = startSec + durationSec;
    const int wantSamples = (int)std::llround(durationSec * sampleRate);
    out.samples.reserve(wantSamples > 0 ? wantSamples : 0);

    AVPacket* pkt = av_packet_alloc();
    AVFrame* frame = av_frame_alloc();
    std::vector<int16_t> conv;
    bool done = false;

    while (!done && av_read_frame(fmt, pkt) >= 0) {
        if (pkt->stream_index == audioStream) {
            if (avcodec_send_packet(cdc, pkt) == 0) {
                while (avcodec_receive_frame(cdc, frame) == 0) {
                    double ptsSec = (frame->pts == AV_NOPTS_VALUE)
                        ? startSec
                        : frame->pts * av_q2d(st->time_base);
                    if (ptsSec + (double)frame->nb_samples / cdc->sample_rate < startSec) {
                        continue; // still before the window
                    }
                    if (ptsSec >= endSec) { done = true; break; }

                    int maxOut = (int)av_rescale_rnd(
                        swr_get_delay(swr, cdc->sample_rate) + frame->nb_samples,
                        sampleRate, cdc->sample_rate, AV_ROUND_UP);
                    conv.resize(maxOut);
                    uint8_t* outBuf = reinterpret_cast<uint8_t*>(conv.data());
                    int got = swr_convert(swr, &outBuf, maxOut,
                                          (const uint8_t**)frame->data, frame->nb_samples);
                    if (got > 0) out.samples.insert(out.samples.end(), conv.begin(), conv.begin() + got);
                }
            }
        }
        av_packet_unref(pkt);
    }

    av_frame_free(&frame);
    av_packet_free(&pkt);
    swr_free(&swr);
    avcodec_free_context(&cdc);
    avformat_close_input(&fmt);

    out.ok = !out.samples.empty();
    if (!out.ok && out.error.empty()) out.error = "no samples decoded";
    return out;
}

} // namespace syncitol

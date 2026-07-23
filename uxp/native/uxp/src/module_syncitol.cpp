/*
 * Syncitol UXP hybrid addon — exposes the FFmpeg decode core to JS.
 *   probe(path) -> { ok, error, durationSec, frameRate, hasAudio,
 *                    creationTime, modificationDate, timecode }
 *   decodePcm(path, startSec, durationSec, sampleRate) -> ArrayBuffer (int16 mono LE)
 *
 * Synchronous (runs on the UXP scripting thread). The decode core
 * (syncitol_decode.*) is the same code already smoke-tested via the Node addon.
 * Glue follows the bolt-uxp / Adobe UXP addon C API (UxpAddonShared.h).
 */
#include <string>
#include <vector>
#include <cstring>

#include "utilities/UxpAddon.h"
#include "../../src/syncitol_decode.h"

namespace {

bool getStringArg(addon_env env, addon_value v, std::string& out) {
    size_t len = 0;
    if (UxpAddonApis.uxp_addon_get_value_string_utf8(env, v, nullptr, 0, &len) != addon_ok) return false;
    out.resize(len + 1);
    size_t copied = 0;
    if (UxpAddonApis.uxp_addon_get_value_string_utf8(env, v, &out[0], len + 1, &copied) != addon_ok) return false;
    out.resize(copied);
    return true;
}

void setStr(addon_env env, addon_value obj, const char* name, const std::string& s) {
    addon_value v = nullptr;
    UxpAddonApis.uxp_addon_create_string_utf8(env, s.c_str(), s.size(), &v);
    UxpAddonApis.uxp_addon_set_named_property(env, obj, name, v);
}
void setNum(addon_env env, addon_value obj, const char* name, double d) {
    addon_value v = nullptr;
    UxpAddonApis.uxp_addon_create_double(env, d, &v);
    UxpAddonApis.uxp_addon_set_named_property(env, obj, name, v);
}
void setBool(addon_env env, addon_value obj, const char* name, bool b) {
    addon_value v = nullptr;
    UxpAddonApis.uxp_addon_get_boolean(env, b, &v);
    UxpAddonApis.uxp_addon_set_named_property(env, obj, name, v);
}

// probe(path) -> object
addon_value Probe(addon_env env, addon_callback_info info) {
    try {
        size_t argc = 1;
        addon_value argv[1];
        Check(UxpAddonApis.uxp_addon_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
        std::string path;
        if (argc < 1 || !getStringArg(env, argv[0], path)) {
            UxpAddonApis.uxp_addon_throw_error(env, nullptr, "probe(path) expects a string");
            return nullptr;
        }
        syncitol::ProbeResult r = syncitol::probeFile(path);
        addon_value o = nullptr;
        Check(UxpAddonApis.uxp_addon_create_object(env, &o));
        setBool(env, o, "ok", r.ok);
        setStr(env, o, "error", r.error);
        setNum(env, o, "durationSec", r.durationSec);
        setNum(env, o, "frameRate", r.frameRate);
        setBool(env, o, "hasAudio", r.hasAudio);
        setStr(env, o, "creationTime", r.creationTime);
        setStr(env, o, "modificationDate", r.modificationDate);
        setStr(env, o, "timecode", r.timecode);
        return o;
    } catch (...) {
        return CreateErrorFromException(env);
    }
}

// decodePcm(path, startSec, durationSec, sampleRate) -> ArrayBuffer (int16 mono)
addon_value DecodePcm(addon_env env, addon_callback_info info) {
    try {
        size_t argc = 4;
        addon_value argv[4];
        Check(UxpAddonApis.uxp_addon_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
        std::string path;
        if (argc < 4 || !getStringArg(env, argv[0], path)) {
            UxpAddonApis.uxp_addon_throw_error(env, nullptr, "decodePcm(path, startSec, durationSec, sampleRate)");
            return nullptr;
        }
        double startSec = 0, durSec = 0;
        int32_t sampleRate = 0;
        Check(UxpAddonApis.uxp_addon_get_value_double(env, argv[1], &startSec));
        Check(UxpAddonApis.uxp_addon_get_value_double(env, argv[2], &durSec));
        Check(UxpAddonApis.uxp_addon_get_value_int32(env, argv[3], &sampleRate));

        syncitol::DecodeResult r = syncitol::decodeMonoPcm(path, startSec, durSec, sampleRate);
        if (!r.ok) {
            UxpAddonApis.uxp_addon_throw_error(env, nullptr, r.error.empty() ? "decode failed" : r.error.c_str());
            return nullptr;
        }
        size_t bytes = r.samples.size() * sizeof(int16_t);
        void* data = nullptr;
        addon_value buf = nullptr;
        Check(UxpAddonApis.uxp_addon_create_arraybuffer(env, bytes, &data, &buf));
        if (data && bytes) std::memcpy(data, r.samples.data(), bytes);
        return buf;
    } catch (...) {
        return CreateErrorFromException(env);
    }
}

addon_value Init(addon_env env, addon_value exports, const addon_apis& api) {
    addon_value fn = nullptr;
    api.uxp_addon_create_function(env, nullptr, 0, Probe, nullptr, &fn);
    api.uxp_addon_set_named_property(env, exports, "probe", fn);
    api.uxp_addon_create_function(env, nullptr, 0, DecodePcm, nullptr, &fn);
    api.uxp_addon_set_named_property(env, exports, "decodePcm", fn);
    return exports;
}

void Terminate(addon_env /*env*/) {}

} // namespace

UXP_ADDON_INIT(Init)
UXP_ADDON_TERMINATE(Terminate)

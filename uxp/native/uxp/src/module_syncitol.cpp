/*
 * Syncitol UXP hybrid addon — exposes the FFmpeg decode core to JS.
 *   probe(path) -> { ok, error, durationSec, frameRate, hasAudio,
 *                    creationTime, modificationDate, timecode }
 *   decodePcm(path, startSec, durationSec, sampleRate) -> ArrayBuffer (int16 mono LE)
 *       synchronous, on the UXP scripting thread
 *   decodePcmAsync(path, startSec, durationSec, sampleRate) -> Promise<ArrayBuffer>
 *       on a background decode pool, so several decode at once and the panel
 *       stays responsive
 *   decodeThreads() -> size of that pool;  cpuCount() -> logical CPU threads
 *
 * The decode core (syncitol_decode.*) is shared by both paths. Glue follows the
 * bolt-uxp / Adobe UXP addon C API (UxpAddonShared.h).
 */
#include <algorithm>
#include <atomic>
#include <condition_variable>
#include <cstring>
#include <deque>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "utilities/UxpAddon.h"
#include "../../src/syncitol_decode.h"

namespace {

// ─── Background decode pool ──────────────────────────────────────────────────
// How many slices decode at once scales with the machine: about half its
// logical CPU threads, less two left for Premiere itself, and never more than
// six. Measured on a NAS share, throughput stopped climbing at five or six
// concurrent decodes (the network, not the CPU, was then the limit), and a
// small machine keeps one — the same as the old one-at-a-time behaviour.
//   4 threads -> 1 · 8 -> 3 · 12 -> 5 · 16 and up -> 6
unsigned logicalCpus() {
    unsigned hw = std::thread::hardware_concurrency();
    return hw ? hw : 4;
}
unsigned decodeThreadCount() {
    int n = ((int)logicalCpus() - 2) / 2;
    return (unsigned)std::max(1, std::min(n, 6));
}

struct DecodeJob {
    std::string path;
    double startSec = 0, durSec = 0;
    int sampleRate = 0;
    addon_env env = nullptr;
    addon_deferred deferred = nullptr;
    syncitol::DecodeResult result;
};

// Results go back to JavaScript only while the addon is alive: once
// Terminate has run, the env is gone and a finished job is simply dropped.
std::mutex gAliveMutex;
bool gAlive = true;

addon_value makeError(addon_env env, const std::string& message) {
    addon_value code = nullptr, msg = nullptr, err = nullptr;
    UxpAddonApis.uxp_addon_create_string_utf8(env, "-1", 2, &code);
    UxpAddonApis.uxp_addon_create_string_utf8(env, message.c_str(), message.size(), &msg);
    UxpAddonApis.uxp_addon_create_error(env, code, msg, &err);
    return err;
}

// Runs on the scripting thread: hand the samples (or the error) to the promise.
void resolveJob(addon_task_data data) {
    DecodeJob* job = reinterpret_cast<DecodeJob*>(data);
    try {
        HandlerScope scope(job->env);
        if (!job->result.ok) {
            const std::string& e = job->result.error;
            UxpAddonApis.uxp_addon_reject_deferred(job->env, job->deferred, makeError(job->env, e.empty() ? "decode failed" : e));
            return;
        }
        size_t bytes = job->result.samples.size() * sizeof(int16_t);
        void* buf = nullptr;
        addon_value ab = nullptr;
        if (UxpAddonApis.uxp_addon_create_arraybuffer(job->env, bytes, &buf, &ab) != addon_ok) {
            UxpAddonApis.uxp_addon_reject_deferred(job->env, job->deferred, makeError(job->env, "out of memory for decoded audio"));
            return;
        }
        if (buf && bytes) std::memcpy(buf, job->result.samples.data(), bytes);
        UxpAddonApis.uxp_addon_resolve_deferred(job->env, job->deferred, ab);
    } catch (...) {
        // Nothing more can be done for this promise from here.
    }
}
void deleteJob(addon_task_data data) {
    try { delete reinterpret_cast<DecodeJob*>(data); } catch (...) {}
}

class DecodePool {
 public:
    void post(DecodeJob* job) {
        {
            std::lock_guard<std::mutex> lk(mMutex);
            if (mThreads.empty() && !mStopping) {
                unsigned n = decodeThreadCount();
                for (unsigned i = 0; i < n; i++) mThreads.emplace_back(&DecodePool::run, this);
            }
            mQueue.push_back(job);
        }
        mCv.notify_one();
    }

    // A panel reload can Init the addon again without unloading it.
    void allowRestart() {
        std::lock_guard<std::mutex> lk(mMutex);
        mStopping = false;
    }

    // Finish what is decoding, drop what is queued, and stop the threads.
    void stop() {
        std::vector<std::thread> threads;
        std::deque<DecodeJob*> queued;
        {
            std::lock_guard<std::mutex> lk(mMutex);
            mStopping = true;
            threads.swap(mThreads);
            queued.swap(mQueue);
        }
        mCv.notify_all();
        for (auto& t : threads) if (t.joinable()) t.join();
        for (DecodeJob* j : queued) delete j;
    }

 private:
    void run() {
        for (;;) {
            DecodeJob* job = nullptr;
            {
                std::unique_lock<std::mutex> lk(mMutex);
                mCv.wait(lk, [this] { return mStopping || !mQueue.empty(); });
                if (mStopping) return;
                job = mQueue.front();
                mQueue.pop_front();
            }
            try {
                job->result = syncitol::decodeMonoPcm(job->path, job->startSec, job->durSec, job->sampleRate);
            } catch (...) {
                job->result = syncitol::DecodeResult();
                job->result.error = "decode crashed";
            }
            std::lock_guard<std::mutex> alive(gAliveMutex);
            if (!gAlive) { delete job; continue; }
            UxpAddonApis.uxp_addon_schedule_on_javascript_queue(job->env, resolveJob, job, deleteJob);
        }
    }

    std::mutex mMutex;
    std::condition_variable mCv;
    std::deque<DecodeJob*> mQueue;
    std::vector<std::thread> mThreads;
    bool mStopping = false;
};

DecodePool& pool() {
    static DecodePool p;
    return p;
}

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

// decodePcmAsync(path, startSec, durationSec, sampleRate) -> Promise<ArrayBuffer>
addon_value DecodePcmAsync(addon_env env, addon_callback_info info) {
    try {
        size_t argc = 4;
        addon_value argv[4];
        Check(UxpAddonApis.uxp_addon_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
        std::string path;
        if (argc < 4 || !getStringArg(env, argv[0], path)) {
            UxpAddonApis.uxp_addon_throw_error(env, nullptr, "decodePcmAsync(path, startSec, durationSec, sampleRate)");
            return nullptr;
        }
        DecodeJob* job = new DecodeJob;
        job->path = path;
        job->env = env;
        int32_t rate = 0;
        if (UxpAddonApis.uxp_addon_get_value_double(env, argv[1], &job->startSec) != addon_ok ||
            UxpAddonApis.uxp_addon_get_value_double(env, argv[2], &job->durSec) != addon_ok ||
            UxpAddonApis.uxp_addon_get_value_int32(env, argv[3], &rate) != addon_ok) {
            delete job;
            UxpAddonApis.uxp_addon_throw_error(env, nullptr, "decodePcmAsync: startSec, durationSec and sampleRate must be numbers");
            return nullptr;
        }
        job->sampleRate = rate;
        addon_value promise = nullptr;
        if (UxpAddonApis.uxp_addon_create_promise(env, &job->deferred, &promise) != addon_ok) {
            delete job;
            UxpAddonApis.uxp_addon_throw_error(env, nullptr, "decodePcmAsync: could not create a promise");
            return nullptr;
        }
        pool().post(job);
        return promise;
    } catch (...) {
        return CreateErrorFromException(env);
    }
}

addon_value DecodeThreads(addon_env env, addon_callback_info /*info*/) {
    addon_value v = nullptr;
    UxpAddonApis.uxp_addon_create_double(env, (double)decodeThreadCount(), &v);
    return v;
}

addon_value CpuCount(addon_env env, addon_callback_info /*info*/) {
    addon_value v = nullptr;
    UxpAddonApis.uxp_addon_create_double(env, (double)logicalCpus(), &v);
    return v;
}

addon_value Init(addon_env env, addon_value exports, const addon_apis& api) {
    {
        std::lock_guard<std::mutex> alive(gAliveMutex);
        gAlive = true;
    }
    pool().allowRestart();
    addon_value fn = nullptr;
    api.uxp_addon_create_function(env, nullptr, 0, Probe, nullptr, &fn);
    api.uxp_addon_set_named_property(env, exports, "probe", fn);
    api.uxp_addon_create_function(env, nullptr, 0, DecodePcm, nullptr, &fn);
    api.uxp_addon_set_named_property(env, exports, "decodePcm", fn);
    api.uxp_addon_create_function(env, nullptr, 0, DecodePcmAsync, nullptr, &fn);
    api.uxp_addon_set_named_property(env, exports, "decodePcmAsync", fn);
    api.uxp_addon_create_function(env, nullptr, 0, DecodeThreads, nullptr, &fn);
    api.uxp_addon_set_named_property(env, exports, "decodeThreads", fn);
    api.uxp_addon_create_function(env, nullptr, 0, CpuCount, nullptr, &fn);
    api.uxp_addon_set_named_property(env, exports, "cpuCount", fn);
    return exports;
}

// The panel is going away: stop handing results back first, then let the
// pool finish what it is decoding and drop the rest.
void Terminate(addon_env /*env*/) {
    {
        std::lock_guard<std::mutex> alive(gAliveMutex);
        gAlive = false;
    }
    pool().stop();
}

} // namespace

UXP_ADDON_INIT(Init)
UXP_ADDON_TERMINATE(Terminate)

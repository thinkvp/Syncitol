/**
 * Syncitol — audio.js
 * Wraps the bundled FFmpeg native addon and turns decoded PCM into envelopes
 * for the DSP: decodePcm() decodes audio slices, probe() reads container and
 * stream metadata. No external ffmpeg/ffprobe install is involved.
 *
 * The addon's decode is synchronous on UXP's scripting thread, so:
 *  - a cancel check (installed by main.js via setCancelCheck) runs before each
 *    decode, giving between-decode cancel granularity;
 *  - a setTimeout(0) yield before each decode lets the panel repaint and the
 *    Cancel click be processed. A future async/threaded addon would slot in
 *    below this API without callers changing.
 *
 * Envelopes are ALSO cached on disk (plugin data folder), keyed by the media
 * file's identity (path + mtime + size) plus the exact slice/resolution: a
 * changed file changes the key, so stale audio can never be served, while a
 * re-run of Auto Sync skips decoding entirely for unchanged media.
 */

const dsp = require("./dsp");
const fs = require("fs");

// ─── Native addon (lazy) ──────────────────────────────────────────────────────
let _addon = null;
let _addonError = null;
let _addonPromise = null;
function addon() {
    if (_addon) return Promise.resolve(_addon);
    if (_addonError) return Promise.reject(_addonError);
    if (!_addonPromise) {
        _addonPromise = (async () => {
            try {
                const mod = require("syncitol.uxpaddon");
                _addon = (mod && typeof mod.then === "function") ? await mod : mod;
                if (!_addon || typeof _addon.decodePcm !== "function") {
                    const keys = _addon ? Object.keys(_addon).join(",") : "(falsy)";
                    throw new Error("addon loaded but decodePcm missing — exports: [" + keys + "]");
                }
                return _addon;
            } catch (e) {
                // Surface the raw error every way we can — UXP's native loader often
                // throws something whose .message is empty, so capture name/string.
                let detail = "";
                try {
                    detail = [
                        e && e.message ? "msg=" + e.message : "",
                        e && e.name ? "name=" + e.name : "",
                        e && e.code ? "code=" + e.code : "",
                        "str=" + String(e)
                    ].filter(Boolean).join(" | ");
                } catch (_) { detail = "(uncapturable)"; }
                try { console.error("[syncitol] addon load failed:", e); } catch (_) {}
                _addonError = new Error(
                    "Syncitol audio addon failed to load (syncitol.uxpaddon). " + detail);
                throw _addonError;
            }
        })();
    }
    return _addonPromise;
}

async function ensureAddon() { await addon(); } // throws a clear error if unavailable

// ─── Cancellation + UI yields ─────────────────────────────────────────────────
// main.js installs its throwIfCancelled here so decode loops unwind cleanly.
let cancelCheck = null;
function setCancelCheck(fn) { cancelCheck = fn; }
function throwIfCancelled() { if (cancelCheck) cancelCheck(); }
function yieldToUI() { return new Promise(resolve => setTimeout(resolve, 0)); }

// ─── Persistent envelope cache (disk) ─────────────────────────────────────────
const ENV_CACHE_MAX_AGE_DAYS = 30;
let cacheDirPromise = null;
function envCacheDir() {
    if (cacheDirPromise) return cacheDirPromise;
    cacheDirPromise = (async () => {
        try {
            const lfs = require("uxp").storage.localFileSystem;
            const dataFolder = await lfs.getDataFolder();
            const dir = String(dataFolder.nativePath).replace(/\\/g, "/") + "/envelope-cache";
            try { await fs.mkdir(dir); } catch (e) { /* exists */ }
            pruneEnvelopeCacheDir(dir); // fire-and-forget
            return dir;
        } catch (e) {
            return null; // cache is an optimization only — never block the panel on it
        }
    })();
    return cacheDirPromise;
}

// Drop entries not touched in ENV_CACHE_MAX_AGE_DAYS so the cache tracks the
// projects actually being worked on instead of growing forever.
async function pruneEnvelopeCacheDir(dir) {
    try {
        const names = await fs.readdir(dir);
        const cutoffMs = Date.now() - (ENV_CACHE_MAX_AGE_DAYS * 86400 * 1000);
        for (const name of names) {
            const p = dir + "/" + name;
            try {
                const st = await fs.lstat(p);
                const m = st && (st.mtime !== undefined ? st.mtime : st.mtimeMs);
                const ms = (m instanceof Date) ? m.getTime() : Number(m);
                if (ms < cutoffMs) await fs.unlink(p);
            } catch (e) { /* skip */ }
        }
    } catch (e) { /* no cache dir yet */ }
}

// FNV-1a over the key string, twice with different seeds → 16 hex chars.
// (UXP has no crypto module; collisions at this keyspace are negligible.)
function hashKey(s) {
    function fnv(seed) {
        let h = seed >>> 0;
        for (let i = 0; i < s.length; i += 1) {
            h ^= s.charCodeAt(i);
            h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
        }
        return ("00000000" + h.toString(16)).slice(-8);
    }
    return fnv(0x811c9dc5) + fnv(0x01000193);
}

async function envelopeDiskPath(filePath, cacheKey) {
    const dir = await envCacheDir();
    if (!dir) return null;
    try {
        const st = await fs.lstat(filePath);
        const m = st && (st.mtime !== undefined ? st.mtime : st.mtimeMs);
        const mtimeMs = (m instanceof Date) ? m.getTime() : Number(m);
        return dir + "/" + hashKey(`${cacheKey}|${mtimeMs}|${st.size}`) + ".env";
    } catch (e) {
        return null;
    }
}

async function readEnvelopeFromDisk(diskPath) {
    try {
        const buf = await fs.readFile(diskPath); // ArrayBuffer
        if (!buf || !buf.byteLength || buf.byteLength % 4 !== 0) return null;
        return new Float32Array(buf);
    } catch (e) {
        return null; // missing or unreadable — just re-decode
    }
}

function writeEnvelopeToDisk(diskPath, envelope) {
    try {
        const bytes = envelope.buffer.slice(envelope.byteOffset, envelope.byteOffset + envelope.byteLength);
        fs.writeFile(diskPath, bytes).catch(() => {}); // best-effort, off the hot path
    } catch (e) { /* ignore */ }
}

// ─── Envelope extraction (cached per file|offset|dur|rate|window) ─────────────
const envelopeCache = new Map();

function getEnvelope(filePath, sourceOffsetSec, durationSec, opts) {
    opts = opts || {};
    const sampleRate = opts.sampleRate || dsp.AUDIO_SAMPLE_RATE;
    const windowSamples = opts.windowSamples || dsp.ENVELOPE_WINDOW_SAMPLES;
    const cacheKey = `${filePath}|${sourceOffsetSec.toFixed(3)}|${durationSec.toFixed(3)}|${sampleRate}|${windowSamples}`;
    if (envelopeCache.has(cacheKey)) return envelopeCache.get(cacheKey);

    const task = (async () => {
        const diskPath = await envelopeDiskPath(filePath, cacheKey);
        if (diskPath) {
            const cached = await readEnvelopeFromDisk(diskPath);
            if (cached && cached.length) return cached;
        }

        throwIfCancelled();
        await yieldToUI(); // let the panel repaint before a blocking decode
        throwIfCancelled();

        const a = await addon();
        const buf = a.decodePcm(filePath, sourceOffsetSec, durationSec, sampleRate);
        const samples = new Int16Array(buf); // little-endian int16 mono
        if (!samples.length) throw new Error(`No audio samples: ${baseName(filePath)}`);
        const envelope = dsp.buildEnvelope(samples, windowSamples);
        if (!envelope.length) throw new Error(`Audio slice too short: ${baseName(filePath)}`);

        if (diskPath) writeEnvelopeToDisk(diskPath, envelope);
        return envelope;
    })();

    envelopeCache.set(cacheKey, task);
    return task;
}

function clearCache() { envelopeCache.clear(); }

// ─── Metadata probe (cached per file) ─────────────────────────────────────────
const probeCache = new Map();

// Returns { recordStartMs, durationSec, timingSource, timecodeSec, frameRate }
// or throws. Sourced from the addon's container/stream metadata.
async function probeRecordStart(filePath) {
    if (probeCache.has(filePath)) return probeCache.get(filePath);
    const p = (async () => {
        const a = await addon();
        const r = a.probe(filePath);
        if (!r || !r.ok) throw new Error(r && r.error ? r.error : "probe failed");

        const frameRate = r.frameRate || null;
        const timecodeSec = r.timecode ? dsp.parseTimecodeToSeconds(r.timecode, frameRate) : null;

        // Prefer an embedded record-start datetime:
        //   creation_time (MP4/MOV) → modification_date (Sony MXF, verified to
        //   be the recording start). Both survive copying.
        let recordStartMs = null;
        let timingSource = null;
        if (r.creationTime) {
            const ms = Date.parse(r.creationTime);
            if (!Number.isNaN(ms)) { recordStartMs = ms; timingSource = "creation_time"; }
        }
        if (recordStartMs === null && r.modificationDate) {
            const ms = Date.parse(r.modificationDate);
            if (!Number.isNaN(ms)) { recordStartMs = ms; timingSource = "modification_date"; }
        }
        // mtime fallback comes from the UXP fs layer (premiere.statMtimeMs);
        // the addon doesn't stat the file.
        return {
            recordStartMs,
            durationSec: r.durationSec || 0,
            timingSource,
            timecodeSec,
            frameRate
        };
    })();
    probeCache.set(filePath, p);
    return p;
}

function clearProbeCache() { probeCache.clear(); }

function baseName(p) {
    const m = /[^\\/]+$/.exec(p || "");
    return m ? m[0] : (p || "");
}

module.exports = {
    ensureAddon,
    setCancelCheck,
    getEnvelope,
    clearCache,
    probeRecordStart,
    clearProbeCache,
    baseName
};

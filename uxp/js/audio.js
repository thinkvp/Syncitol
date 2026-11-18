/**
 * Syncitol — audio.js
 * Wraps the bundled FFmpeg native addon and turns decoded PCM into envelopes
 * for the DSP: decodePcm() decodes audio slices, probe() reads container and
 * stream metadata. No external ffmpeg/ffprobe install is involved.
 *
 * Decoding runs on the addon's background pool (decodePcmAsync) when it has
 * one: several slices decode at once, sized to the machine's CPU threads, and
 * the panel stays responsive. An older addon, or the "syncitol-decode" =
 * "sync" localStorage switch, falls back to the synchronous decodePcm on the
 * scripting thread, one slice at a time. Either way:
 *  - a cancel check (installed by main.js via setCancelCheck) runs before each
 *    decode, giving between-decode cancel granularity;
 *  - a setTimeout(0) yield before each decode lets the panel repaint and the
 *    Cancel click be processed.
 *
 * Envelopes are ALSO cached on disk (plugin data folder), keyed by the media
 * file's identity (path + mtime + size) plus the exact slice/resolution: a
 * changed file changes the key, so stale audio can never be served, while a
 * re-run of Auto Sync skips decoding entirely for unchanged media.
 */

const dsp = require("./dsp");
const fs = require("fs");

// ─── Platform ─────────────────────────────────────────────────────────────────
// UXP's os module reports "darwin" on macOS; the user agent is the fallback.
function isMac() {
    try {
        const p = require("os").platform();
        if (p) return String(p).toLowerCase() === "darwin";
    } catch (e) { /* no os module in this host */ }
    try { return /mac/i.test((navigator && (navigator.platform || navigator.userAgent)) || ""); } catch (e) { return false; }
}

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
                // On a Mac the usual cause is Gatekeeper: the addon is not
                // signed by a paid Apple Developer ID, so macOS blocks it until
                // the user allows it once. Say so where the error is seen.
                _addonError = new Error(isMac()
                    ? "Syncitol's audio decoder (syncitol.uxpaddon) didn't load. On a Mac this is usually macOS " +
                      "blocking it the first time: open System Settings → Privacy & Security, click Allow Anyway " +
                      "next to the message about syncitol.uxpaddon, then restart Premiere Pro. (" + detail + ")"
                    : "Syncitol audio addon failed to load (syncitol.uxpaddon). " + detail);
                throw _addonError;
            }
        })();
    }
    return _addonPromise;
}

async function ensureAddon() { await addon(); } // throws a clear error if unavailable

// Background decoding: available in this addon, and not switched off.
function useAsyncDecode(a) {
    if (!a || typeof a.decodePcmAsync !== "function") return false;
    try { if (localStorage.getItem("syncitol-decode") === "sync") return false; } catch (e) { /* no storage: default on */ }
    return true;
}

// How many slices decode at once — the addon sizes its pool from the CPU
// thread count — and that count, for the log. Before the addon loads, or
// when decoding is synchronous: one.
function decodeConcurrency() {
    if (!useAsyncDecode(_addon)) return 1;
    try { return Math.max(1, Number(_addon.decodeThreads()) || 1); } catch (e) { return 1; }
}
function cpuCount() {
    try { return _addon && typeof _addon.cpuCount === "function" ? Number(_addon.cpuCount()) || null : null; } catch (e) { return null; }
}

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

// Delete every cached envelope on disk (the panel's Clear cache button).
// Returns { files, bytes } removed.
async function clearDiskCache() {
    const out = { files: 0, bytes: 0 };
    const dir = await envCacheDir();
    if (!dir) return out;
    let names = [];
    try { names = await fs.readdir(dir); } catch (e) { return out; }
    for (const name of names) {
        const p = dir + "/" + name;
        try {
            const st = await fs.lstat(p);
            await fs.unlink(p);
            out.files += 1;
            out.bytes += (st && st.size) || 0;
        } catch (e) { /* in use or gone — skip */ }
    }
    return out;
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
// What getEnvelope actually did, for the log: decodes are the expensive part.
// decodeMs is WALL time with at least one decode running, not the sum of the
// decodes: with several at once, the sum would overstate how long it took.
let decodeStats = { decodes: 0, audioSec: 0, decodeMs: 0, diskHits: 0 };
let inFlight = 0, busySince = 0;
function resetDecodeStats() { decodeStats = { decodes: 0, audioSec: 0, decodeMs: 0, diskHits: 0 }; }
function getDecodeStats() {
    const out = Object.assign({}, decodeStats);
    if (inFlight > 0) out.decodeMs += Date.now() - busySince;
    return out;
}
function decodeStarted() { if (inFlight++ === 0) busySince = Date.now(); }
function decodeEnded() { if (--inFlight === 0) decodeStats.decodeMs += Date.now() - busySince; }

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
            if (cached && cached.length) { decodeStats.diskHits += 1; return cached; }
        }

        throwIfCancelled();
        await yieldToUI(); // let the panel repaint before a blocking decode
        throwIfCancelled();

        const a = await addon();
        let buf;
        decodeStarted();
        try {
            buf = useAsyncDecode(a)
                ? await a.decodePcmAsync(filePath, sourceOffsetSec, durationSec, sampleRate)
                : a.decodePcm(filePath, sourceOffsetSec, durationSec, sampleRate);
        } finally {
            decodeEnded();
        }
        decodeStats.decodes += 1;
        decodeStats.audioSec += durationSec;
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

// Returns { recordStartMs, durationSec, timingSource, timecodeSec, frameRate,
// hasAudio } or throws. Sourced from the addon's container/stream metadata.
// hasAudio is false only when the container holds no audio stream at all
// (drone footage, screen recordings) — anything else counts as audio.
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
            frameRate,
            hasAudio: r.hasAudio !== false
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
    decodeConcurrency,
    cpuCount,
    setCancelCheck,
    getEnvelope,
    clearCache,
    resetDecodeStats,
    getDecodeStats,
    clearDiskCache,
    probeRecordStart,
    clearProbeCache,
    baseName
};

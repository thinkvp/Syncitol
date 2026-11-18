/**
 * Syncitol — pek.js
 * Premiere peak-file (.pek) fast path. Premiere pre-computes an audio peak
 * cache for every imported media file — effectively the envelope the coarse
 * pass spends time decoding, already sitting on disk (parser in dsp.js,
 * validated against FFmpeg ground truth). Media → .pek mapping comes from
 * Adobe's media-cache database records (.mcdb), which store the original
 * media path alongside each cache entry path.
 *
 * Everything here is opportunistic: any failure or doubt (missing cache,
 * stale mtime, duration mismatch, unparseable header) returns null and the
 * caller falls back to the addon decode path.
 *
 * File access goes through UXP's fs (fullAccess), and the media-cache
 * directory is derived from the plugin data folder's native path (UXP has
 * no os.homedir()).
 */

const dsp = require("./dsp");
const audio = require("./audio");
const fs = require("fs");

// ─── Media cache location ─────────────────────────────────────────────────────
// %APPDATA%\Adobe\Common\Media Cache on Windows (macOS: ~/Library/Application
// Support/...). UXP exposes no home dir, but the plugin data folder's native
// path runs through the same profile root — carve it out of that.
let cacheDbDirPromise = null;
function mediaCacheDbDir() {
    if (cacheDbDirPromise) return cacheDbDirPromise;
    cacheDbDirPromise = (async () => {
        try {
            const lfs = require("uxp").storage.localFileSystem;
            const dataFolder = await lfs.getDataFolder();
            const p = String(dataFolder.nativePath).replace(/\\/g, "/");
            const winIdx = p.toLowerCase().indexOf("/appdata/roaming/");
            if (winIdx !== -1) {
                return p.slice(0, winIdx) + "/AppData/Roaming/Adobe/Common/Media Cache";
            }
            const macIdx = p.toLowerCase().indexOf("/library/application support/");
            if (macIdx !== -1) {
                return p.slice(0, macIdx) + "/Library/Application Support/Adobe/Common/Media Cache";
            }
            return null;
        } catch (e) {
            return null;
        }
    })();
    return cacheDbDirPromise;
}

// Premiere sometimes records paths with the Windows long-path prefix (\\?\).
function normalizeMediaPath(p) {
    return String(p || "").replace(/^\\\\\?\\/, "").toLowerCase();
}

// ─── .mcdb index ──────────────────────────────────────────────────────────────
// Map<normalized media path, pek path>, read in full once per session and then
// topped up by refreshPekIndex(): Premiere keeps writing records as it builds
// peaks in the background, and a record already read never needs reading again.
const pekIndex = new Map();
const readRecords = new Set();   // .mcdb names already read into pekIndex
let pekIndexPromise = null;

async function mcdbNames(dir) {
    try {
        return (await fs.readdir(dir)).filter(n => String(n).endsWith(".mcdb"));
    } catch (e) {
        return null; // no media cache database — no pek fast path
    }
}

async function readRecordsInto(dir, names) {
    const BATCH = 64;
    for (let i = 0; i < names.length; i += BATCH) {
        await Promise.all(names.slice(i, i + BATCH).map(async (name) => {
            readRecords.add(name);
            await readRecord(dir, name);
        }));
    }
}

function getPekIndex() {
    if (pekIndexPromise) return pekIndexPromise;
    pekIndexPromise = (async () => {
        const dir = await mediaCacheDbDir();
        if (!dir) return pekIndex;
        const names = await mcdbNames(dir);
        if (!names) return pekIndex;
        await readRecordsInto(dir, names);
        if (typeof module.exports.onDiag === "function") {
            module.exports.onDiag(`pek index: ${pekIndex.size} media file(s) mapped from ${names.length} .mcdb record(s)`);
        }
        return pekIndex;
    })();
    return pekIndexPromise;
}

// Read only the records Premiere has written since the last read. Cheap enough
// to run every few seconds while a sequence is waiting on its peaks.
let refreshing = null;
function refreshPekIndex() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
        await getPekIndex();
        const dir = await mediaCacheDbDir();
        const names = dir ? await mcdbNames(dir) : null;
        if (names) await readRecordsInto(dir, names.filter(n => !readRecords.has(n)));
        return pekIndex;
    })().finally(() => { refreshing = null; });
    return refreshing;
}

// One .mcdb record: the media path it describes and, when it holds peaks,
// the .pek path. A record can hold several items (index, peaks, …) — Item.KeyN
// pairs with Item.WinPathN / Item.PathN by index.
async function readRecord(dir, name) {
    let text;
    try {
        text = String(await fs.readFile(dir + "/" + name, "utf-8"));
    } catch (e) {
        readRecords.delete(name); // try again next refresh
        return;
    }
    if (text.indexOf("pek") === -1) return;
    const orig = /<OriginalWinPath>([^<]+)<\/OriginalWinPath>/.exec(text) ||
                 /<OriginalPath>([^<]+)<\/OriginalPath>/.exec(text);
    if (!orig) return;
    const keyRe = /<Item\.Key(\d+)>pek\d+<\/Item\.Key\1>/g;
    let m;
    while ((m = keyRe.exec(text)) !== null) {
        const n = m[1];
        const win = new RegExp(`<Item\\.WinPath${n}>([^<]+)</Item\\.WinPath${n}>`).exec(text) ||
                    new RegExp(`<Item\\.Path${n}>([^<]+)</Item\\.Path${n}>`).exec(text);
        if (win && /\.pek$/i.test(win[1])) {
            pekIndex.set(normalizeMediaPath(orig[1]), win[1]);
            break;
        }
    }
}

async function statMtimeMs(filePath) {
    const st = await fs.lstat(filePath);
    const m = st && (st.mtime !== undefined ? st.mtime : st.mtimeMs);
    return (m instanceof Date) ? m.getTime() : Number(m);
}

// ─── Resolve a media file to its trusted .pek ─────────────────────────────────
// Mapped in the cache DB, not older than the media, header parseable, and
// matching the media's probed duration. Returns { pekPath, info } or null.
const pekCache = new Map();
function resolvePek(mediaPath) {
    if (pekCache.has(mediaPath)) return pekCache.get(mediaPath);
    const task = (async () => {
        const index = await getPekIndex();
        const pekPath = index.get(normalizeMediaPath(mediaPath));
        if (!pekPath) return null;

        let pekMtime, mediaMtime;
        try {
            pekMtime = await statMtimeMs(pekPath);
            mediaMtime = await statMtimeMs(mediaPath);
        } catch (e) {
            return null;
        }
        // Media modified after its peaks were generated → the peaks describe
        // old audio. (Premiere regenerates the .pek on reimport, so a healthy
        // cache entry is always newer than its media.)
        if (mediaMtime > pekMtime) return null;

        let buffer;
        try {
            buffer = await fs.readFile(pekPath); // ArrayBuffer
        } catch (e) {
            return null;
        }
        const info = dsp.parsePekInfo(buffer);
        if (!info) return null;

        // Duration cross-check via the addon's metadata probe.
        try {
            const probe = await audio.probeRecordStart(mediaPath);
            if (probe.durationSec && Math.abs(probe.durationSec - info.durationSec) > 2) {
                return null; // wrong file behind this name — don't trust it
            }
        } catch (e) {
            // probe is best-effort; an unprobeable file can still use its peaks
        }
        return { pekPath, info };
    })();
    pekCache.set(mediaPath, task);
    // Only a found peak file is remembered: "none yet" can change while
    // Premiere builds peaks in the background.
    task.then(r => { if (!r && pekCache.get(mediaPath) === task) pekCache.delete(mediaPath); }, () => pekCache.delete(mediaPath));
    return task;
}

// Quick presence check for the panel's pre-sync status: mapped in the cache
// DB and not older than the media. No parse and no probe, so it is cheap to
// run over a whole sequence; resolvePek still makes the full check before a
// sync uses the peaks.
async function hasPek(mediaPath) {
    const index = await getPekIndex();
    const pekPath = index.get(normalizeMediaPath(mediaPath));
    if (!pekPath) return false;
    try {
        return (await statMtimeMs(mediaPath)) <= (await statMtimeMs(pekPath));
    } catch (e) {
        return false;
    }
}

// ─── Envelopes from resolved peaks ────────────────────────────────────────────
// Deduped per run (the reference window is shared by every track). The raw
// .pek bytes are cached per path so multi-window reads hit disk once.
const runCache = new Map();   // envelope tasks per slice key
const bytesCache = new Map(); // pekPath -> Promise<ArrayBuffer>

function readPekBytes(pekPath) {
    if (bytesCache.has(pekPath)) return bytesCache.get(pekPath);
    const task = fs.readFile(pekPath);
    bytesCache.set(pekPath, task);
    return task;
}

// `channel` picks a single channel plane (null = the averaged mix).
function getPekEnvelope(resolved, startSec, durSec, envelopeRate, channel) {
    const chanKey = (typeof channel === "number") ? channel : "mix";
    const key = `pek|${resolved.pekPath}|${startSec.toFixed(3)}|${durSec.toFixed(3)}|${envelopeRate}|${chanKey}`;
    if (runCache.has(key)) return runCache.get(key);
    const task = readPekBytes(resolved.pekPath)
        .then(buffer => dsp.pekToEnvelope(buffer, resolved.info, envelopeRate, startSec, durSec, channel));
    runCache.set(key, task);
    return task;
}

function clearRunCache() {
    runCache.clear();
    bytesCache.clear();
}

module.exports = {
    resolvePek,
    hasPek,
    refreshPekIndex,
    getPekEnvelope,
    clearRunCache,
    onDiag: null
};

/**
 * Syncitol — main.js
 * CEP panel logic: talks to ExtendScript via CSInterface,
 * uses Node.js (via __adobe_cep__) to read file mtime.
 */

/* global CSInterface, SystemPath */

const csInterface = new CSInterface();

// ─── Node.js bridge (CEP exposes a limited Node via window.__adobe_cep__) ───
// We use cep_node which is injected by the CEP runtime when --enable-nodejs
// is set and mixed-context is on.
const fs   = typeof cep_node !== "undefined" ? cep_node.require("fs")   : null;
const path = typeof cep_node !== "undefined" ? cep_node.require("path") : null;
const childProcess = typeof cep_node !== "undefined" ? cep_node.require("child_process") : null;
const crypto = typeof cep_node !== "undefined" ? cep_node.require("crypto") : null;
const os     = typeof cep_node !== "undefined" ? cep_node.require("os")     : null;

// Constants (TICKS_PER_SECOND, MAX_SPAN_SEC, AUDIO_SAMPLE_RATE, FINE_TUNE_*, …)
// and the pure DSP/format helpers are defined in js/dsp.js, which is loaded
// before this file and publishes them as globals. Only host-coupled state and
// logic live here.
const envelopeCache = new Map();

// How many clips' ffmpeg passes to run concurrently. Fine tune and coarse align
// spend nearly all their wall-clock in independent per-clip ffmpeg decodes, so
// running several at once is the biggest speedup. Cap modestly so we don't spawn
// dozens of ffmpeg processes on busy machines.
const SYNC_CONCURRENCY = Math.max(
    2,
    Math.min(6, (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 4)
);

// ─── State ───────────────────────────────────────────────────────────────────
let clipPayload = null; // enriched clip list after mtime lookup
let opDepth = 0;         // >0 while an operation (scan/build/fine/auto) is running
let scannedSeqName = null;   // name of the sequence the panel last scanned
let lastLiveSeqName;         // last active-sequence name the idle poll reflected
let cancelRequested = false; // set by the Cancel button; checked at every async seam
let lastFineTuneRevert = null; // inverse payload that undoes the last applied fine tune
const activeProcs = new Set(); // in-flight ffmpeg/ffprobe children, killed on cancel

// ─── DOM refs ────────────────────────────────────────────────────────────────
const btnAuto           = document.getElementById("btn-auto");
const btnRefresh        = document.getElementById("btn-refresh");
const btnSync           = document.getElementById("btn-sync");
const btnFineTune       = document.getElementById("btn-fine-tune");
const btnInstructions   = document.getElementById("btn-instructions");
const btnInstClose      = document.getElementById("btn-instructions-close");
const instructionsPanel = document.getElementById("instructions-panel");
const seqInfo      = document.getElementById("seq-info");
const busyRow      = document.getElementById("busy-row");
const busyText     = document.getElementById("busy-text");
const logContainer = document.getElementById("log");
const clipTable    = document.getElementById("clip-table");
const clipBody     = document.getElementById("clip-body");
const progressWrap = document.getElementById("progress-wrap");
const progressBar  = document.getElementById("progress-bar");
const btnCancel    = document.getElementById("btn-cancel");
const btnRevert    = document.getElementById("btn-revert");
const resultsSection = document.getElementById("results-section");
const resultsBody  = document.getElementById("results-body");
const toolStatusEl = document.getElementById("tool-status");

// ─── Instructions toggle ──────────────────────────────────────────────────────────────────
function showInstructions() {
    instructionsPanel.hidden = false;
    // Force reflow so the transition fires
    void instructionsPanel.offsetWidth;
    instructionsPanel.classList.add("visible");
}

function hideInstructions() {
    instructionsPanel.classList.remove("visible");
    instructionsPanel.addEventListener("transitionend", () => {
        instructionsPanel.hidden = true;
    }, { once: true });
}

btnInstructions.addEventListener("click", showInstructions);
btnInstClose.addEventListener("click", hideInstructions);

// ─── Logging ─────────────────────────────────────────────────────────────────
function log(msg, type = "info") {
    const entry = document.createElement("div");
    entry.className = "log-entry log-" + type;
    const ts = new Date().toLocaleTimeString();
    entry.textContent = `[${ts}] ${msg}`;
    logContainer.appendChild(entry);
    logContainer.scrollTop = logContainer.scrollHeight;
}

function clearLog() {
    logContainer.innerHTML = "";
}

// ─── Progress ────────────────────────────────────────────────────────────────
function setProgress(pct, visible = true) {
    progressWrap.style.display = visible ? "block" : "none";
    progressBar.style.width = pct + "%";
}

// ─── Busy state ──────────────────────────────────────────────────────────────
// A spinner + phase label that stays up for the whole operation (the progress bar
// shimmers, this names the phase). opDepth is a counter so nested calls — e.g.
// Auto Sync → Build → its internal re-scan — don't clear it early.
function setBusy(text) {
    if (text) {
        busyText.textContent = text;
        busyRow.hidden = false;
    } else {
        busyRow.hidden = true;
    }
}

function beginOp(text) {
    if (opDepth === 0) {
        cancelRequested = false;     // a fresh top-level operation resets Cancel
        btnCancel.disabled = false;
    }
    opDepth += 1;
    setBusy(text);
}

function endOp() {
    opDepth = Math.max(0, opDepth - 1);
    if (opDepth === 0) setBusy(null);
}

// ─── Cancellation ────────────────────────────────────────────────────────────
// The long phases are all child ffmpeg/ffprobe decodes plus the pools that feed
// them. Cancel kills every in-flight child and raises a flagged error at each
// async seam (pool loop, spawn start/close) so the operation unwinds cleanly.
// evalScript calls into Premiere cannot be interrupted; the flag is checked
// between pipeline steps instead.
function cancellationError() {
    const e = new Error("Cancelled by user.");
    e.cancelled = true;
    return e;
}

function throwIfCancelled() {
    if (cancelRequested) throw cancellationError();
}

function requestCancel() {
    if (opDepth === 0 || cancelRequested) return;
    cancelRequested = true;
    btnCancel.disabled = true;
    log("Cancelling — stopping audio decodes…", "warn");
    for (const proc of activeProcs) {
        try { proc.kill(); } catch (e) { /* already exited */ }
    }
}
btnCancel.addEventListener("click", requestCancel);

// ─── Active-sequence freshness ───────────────────────────────────────────────
// The active sequence can change under the panel (the user switches sequences in
// Premiere, or Build opens the -SYNC). Poll lightly while idle so the header always
// reflects the real active sequence and flags when the scanned clip data is stale.
async function pollActiveSequence() {
    if (opDepth > 0) return;                 // never poll mid-operation
    let liveName = null;
    try {
        const info = JSON.parse(await evalScript("getActiveSequenceInfo()"));
        liveName = info.name || null;
    } catch (e) {
        liveName = null;                     // no active sequence (evalScript rejects on { error })
    }
    if (liveName === lastLiveSeqName) return; // nothing changed since the last tick
    lastLiveSeqName = liveName;

    if (!liveName) {
        seqInfo.textContent = "Open a sequence, then click \"Auto Sync\" or follow the manual steps.";
    } else if (liveName !== scannedSeqName) {
        // A different sequence is active than the one we scanned → data is stale.
        seqInfo.innerHTML =
            `<span class="seq-name">${escapeHtml(liveName)}</span>` +
            `<span class="seq-meta seq-stale">active — click "Auto Sync", or follow the manual steps</span>`;
    }
    // When liveName === scannedSeqName, leave the rich scanned info in place.
}
setInterval(pollActiveSequence, 3000);

// ─── Evaluate ExtendScript ────────────────────────────────────────────────────
// Every JSX entry point returns either a JSON value or, on failure, a JSON
// object shaped { error: "..." }. We surface both kinds of failure here so
// callers can rely on a resolved result being a usable success value:
//   1. The CEP runtime's generic "EvalScript error." sentinel (an uncaught JSX
//      throw or a syntax error — note this string is not localized by CEP).
//   2. A JSON { error } object returned by our own try/catch wrappers.
function evalScript(script) {
    return new Promise((resolve, reject) => {
        csInterface.evalScript(script, (result) => {
            if (result === "EvalScript error.") {
                reject(new Error("ExtendScript evaluation failed (uncaught error or syntax error in JSX)."));
                return;
            }
            // Detect a structured { error } payload without disturbing results
            // that are not JSON (e.g. a bare assignment statement's value).
            if (typeof result === "string" && result.charAt(0) === "{") {
                let parsed;
                try { parsed = JSON.parse(result); } catch (e) { parsed = null; }
                if (parsed && parsed.error) {
                    reject(new Error(parsed.error));
                    return;
                }
            }
            resolve(result);
        });
    });
}

// ─── Load ExtendScript file ───────────────────────────────────────────────────
function loadJSX() {
    const extDir = csInterface.getSystemPath(SystemPath.EXTENSION).replace(/\\/g, "/");
    // Load the guarded JSON polyfill first (no-op on hosts with native JSON),
    // then the main ExtendScript.
    csInterface.evalScript(`$.evalFile("${extDir}/jsx/json2.js")`);
    csInterface.evalScript(`$.evalFile("${extDir}/jsx/sync.jsx")`);
}

// Format helpers (formatDuration / formatTime / formatDate / formatSignedSeconds)
// live in js/dsp.js.

function runCommandCapture(command, args) {
    return new Promise((resolve, reject) => {
        if (cancelRequested) {
            reject(cancellationError());
            return;
        }
        const proc = childProcess.spawn(command, args, { windowsHide: true });
        activeProcs.add(proc);
        const stdout = [];
        const stderr = [];

        proc.stdout.on("data", chunk => stdout.push(chunk));
        proc.stderr.on("data", chunk => stderr.push(chunk));
        proc.on("error", err => {
            activeProcs.delete(proc);
            reject(err);
        });
        proc.on("close", code => {
            activeProcs.delete(proc);
            if (cancelRequested) {
                reject(cancellationError());
                return;
            }
            if (code !== 0) {
                const errText = Buffer.concat(stderr).toString("utf8").trim();
                reject(new Error(errText || `${command} exited with code ${code}`));
                return;
            }
            resolve(Buffer.concat(stdout));
        });
    });
}

// Run `worker(item, index)` over `items` with at most `limit` in flight, returning
// results in input order. Used to parallelize the per-clip ffmpeg passes, which
// are mutually independent (every clip aligns to the immutable reference layer).
// Stops dispatching (and rejects) as soon as Cancel is requested.
async function mapPool(items, limit, worker) {
    const results = new Array(items.length);
    let next = 0;
    async function run() {
        while (next < items.length) {
            throwIfCancelled();
            const index = next;
            next += 1;
            results[index] = await worker(items[index], index);
        }
    }
    const runners = [];
    const lanes = Math.max(1, Math.min(limit, items.length));
    for (let i = 0; i < lanes; i += 1) runners.push(run());
    await Promise.all(runners);
    return results;
}

// ─── ffmpeg / ffprobe detection ──────────────────────────────────────────────
// Detected once, asynchronously, at panel load — so a missing tool is reported
// in the footer (with an install hint) before the user ever clicks a button,
// instead of erroring mid-run. On macOS, GUI apps don't inherit the shell PATH,
// so a Homebrew install isn't visible via the bare name — the usual install
// locations are probed as fallbacks.
const toolPath = { ffmpeg: null, ffprobe: null }; // string = resolved, false = missing, null = checking

function checkBinary(bin) {
    return new Promise((resolve) => {
        let proc;
        try {
            proc = childProcess.spawn(bin, ["-version"], { windowsHide: true });
        } catch (e) {
            resolve(false);
            return;
        }
        proc.on("error", () => resolve(false));
        proc.on("close", code => resolve(code === 0));
    });
}

async function findTool(name) {
    const candidates = [name];
    if (os && os.platform() === "darwin") {
        candidates.push(`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`);
    }
    for (const candidate of candidates) {
        if (await checkBinary(candidate)) return candidate;
    }
    return false;
}

function installHint() {
    return (os && os.platform() === "darwin")
        ? "brew install ffmpeg"
        : "winget install ffmpeg";
}

function updateToolStatus() {
    const chip = (name) => {
        const state = toolPath[name];
        if (state === null) return `<span class="tool-chip">${name} …</span>`;
        return state
            ? `<span class="tool-chip tool-ok" title="${escapeHtml(String(state))}">${name} ✓</span>`
            : `<span class="tool-chip tool-missing" title="Not found — install with: ${escapeHtml(installHint())}">${name} ✗</span>`;
    };
    toolStatusEl.innerHTML = chip("ffmpeg") + " " + chip("ffprobe");
}

async function detectTools() {
    if (!childProcess) {
        toolPath.ffmpeg = false;
        toolPath.ffprobe = false;
        updateToolStatus();
        return;
    }
    updateToolStatus();
    const [ffmpeg, ffprobe] = await Promise.all([findTool("ffmpeg"), findTool("ffprobe")]);
    toolPath.ffmpeg = ffmpeg;
    toolPath.ffprobe = ffprobe;
    updateToolStatus();
    if (!ffprobe) {
        log(`ffprobe not found — clip timing falls back to file dates (less precise) and start-timecode prediction is unavailable. Install: ${installHint()}`, "warn");
    }
    if (!ffmpeg) {
        log(`ffmpeg not found — Fine Tune and Auto Sync's audio alignment are unavailable. Install (${installHint()}), then reopen the panel.`, "warn");
    }
}
const toolsReady = detectTools();

async function ensureFfmpeg() {
    if (!childProcess) {
        throw new Error("Node child_process is unavailable in this CEP runtime.");
    }
    await toolsReady;
    if (!toolPath.ffmpeg) {
        throw new Error(`ffmpeg was not found. Install it (${installHint()}), then reopen the panel to use audio alignment.`);
    }
}

// ─── Timing source: embedded record-start datetime vs. file mtime ─────────────
// mtime is a weak proxy for record time — it marks when the file finished writing
// (record END), and any copy without date preservation rewrites it. When ffprobe
// is available we prefer an embedded record-START datetime:
//   - creation_time   (MP4 / MOV atom)
//   - modification_date (Sony MXF) — verified to be the recording start:
//     filesystem mtime − modification_date == clip duration.
// Both are accurate and survive copying. ffprobe is optional: with no embedded
// tag we fall back to mtime − duration, so Build never hard-depends on it.
//
// One ffprobe invocation per file fetches BOTH the record-start tags and the
// start timecode (they used to be two separate spawns). The cache stores the
// in-flight promise so concurrent scan workers never double-probe a file.
const mediaProbeCache = new Map(); // filePath -> Promise<{ embeddedStart, startTimecodeSec }>

// Returns { raw, kind } for the first embedded record-start datetime found.
function extractEmbeddedStart(probe) {
    const fmt = (probe && probe.format && probe.format.tags) || {};
    if (fmt.creation_time) return { raw: fmt.creation_time, kind: "creation_time" };
    if (probe && Array.isArray(probe.streams)) {
        for (const stream of probe.streams) {
            if (stream.tags && stream.tags.creation_time) {
                return { raw: stream.tags.creation_time, kind: "creation_time" };
            }
        }
    }
    if (fmt.modification_date) return { raw: fmt.modification_date, kind: "modification_date" };
    return null;
}

// One probe per file for everything main.js wants from ffprobe. Returns
// { embeddedStart: { ms, kind } | null, startTimecodeSec: number | null }.
// Failures (unreadable file, no tags, no ffprobe) resolve to nulls so callers
// can fall back; a cancelled probe is NOT cached so the next run retries.
function probeMedia(filePath) {
    if (mediaProbeCache.has(filePath)) return mediaProbeCache.get(filePath);

    const task = (async () => {
        await toolsReady;
        if (!childProcess || !toolPath.ffprobe) {
            return { embeddedStart: null, startTimecodeSec: null };
        }
        try {
            const out = await runCommandCapture(toolPath.ffprobe, [
                "-v", "quiet",
                "-print_format", "json",
                "-show_entries",
                "format_tags=creation_time,modification_date,timecode:stream_tags=creation_time,timecode:stream=timecode,codec_type,r_frame_rate",
                "-i", filePath
            ]);
            const probe = JSON.parse(out.toString("utf8"));

            let embeddedStart = null;
            const startFound = extractEmbeddedStart(probe);
            if (startFound) {
                const ms = Date.parse(startFound.raw);
                if (!Number.isNaN(ms)) embeddedStart = { ms, kind: startFound.kind };
            }

            let startTimecodeSec = null;
            const tcFound = extractStartTimecode(probe);
            if (tcFound) {
                const sec = parseTimecodeToSeconds(tcFound.tc, tcFound.fps);
                if (sec !== null) startTimecodeSec = sec;
            }

            return { embeddedStart, startTimecodeSec };
        } catch (e) {
            if (e && e.cancelled) {
                mediaProbeCache.delete(filePath); // don't poison the cache with a cancel
                throw e;
            }
            return { embeddedStart: null, startTimecodeSec: null };
        }
    })();

    mediaProbeCache.set(filePath, task);
    return task;
}

// Returns { ms, kind } for the embedded record-start time, or null when
// unavailable (ffprobe absent, no tag, or an unparseable value).
async function probeEmbeddedStart(filePath) {
    return (await probeMedia(filePath)).embeddedStart;
}

// True for the embedded record-start sources (precise), false for the mtime
// fallback (less precise). Used to decide when to warn about mixed sources.
function isEmbeddedSource(timingSource) {
    return timingSource === "creation_time" || timingSource === "modification_date";
}

// Resolve a clip's record-start time once, here in the panel, so the JSX build
// can consume it directly instead of recomputing from mtime.
async function resolveRecordStart(clip) {
    const durationSec = clip.durationTicks / TICKS_PER_SECOND;

    const embedded = await probeEmbeddedStart(clip.filePath);
    if (embedded) {
        // Embedded datetimes are the recording start itself — no subtraction.
        return { recordStartMs: embedded.ms, durationSec, timingSource: embedded.kind, mtimeMs: null };
    }

    const stats = fs.statSync(clip.filePath);
    const mtimeMs = stats.mtimeMs;
    return { recordStartMs: mtimeMs - (durationSec * 1000), durationSec, timingSource: "mtime", mtimeMs };
}

// ─── Embedded start timecode (cheap offset predictor, no audio decode) ─────────
// Pro cameras stamp a start SMPTE timecode in metadata. When two files share a
// clock (jam-synced multicam, or free-run time-of-day TC) the difference of their
// start TCs IS the record offset — found from an ffprobe metadata read, no audio
// touched. We don't try to classify whether the TC is genuinely shared here: the
// coarse pass uses it only to PREDICT a tight search window and confirms with
// audio, so a rec-run TC (starts at 0) just yields a window that fails to match
// and we fall through to the other signals. Read from the same single cached
// ffprobe pass as the record-start tags (probeMedia). Returns seconds from
// midnight, or null when ffprobe/the tag is unavailable.

function parseFrameRate(rate) {
    if (!rate) return null;
    const parts = String(rate).split("/");
    const num = parseFloat(parts[0]);
    const den = parts.length > 1 ? parseFloat(parts[1]) : 1;
    if (!num || !den) return null;
    return num / den;
}

// Find the first start-timecode string and a video frame rate to convert it.
function extractStartTimecode(probe) {
    let tc = (probe && probe.format && probe.format.tags && probe.format.tags.timecode) || null;
    let fps = null;
    if (probe && Array.isArray(probe.streams)) {
        for (const stream of probe.streams) {
            if (!fps && stream.codec_type === "video") fps = parseFrameRate(stream.r_frame_rate);
            if (!tc && stream.tags && stream.tags.timecode) tc = stream.tags.timecode;
            if (!tc && stream.timecode) tc = stream.timecode;
        }
    }
    return tc ? { tc, fps } : null;
}

async function probeStartTimecode(filePath) {
    return (await probeMedia(filePath)).startTimecodeSec;
}

// buildEnvelope() lives in js/dsp.js.

// ─── Persistent envelope cache (disk) ────────────────────────────────────────
// The in-memory cache is cleared per run (correctness on changed files, bounded
// growth) — which used to mean every re-run re-decoded everything, and decode is
// the dominant cost. Envelopes are therefore ALSO cached on disk, keyed by the
// media file's identity (path + mtime + size) plus the exact slice/resolution:
// a changed file changes the key, so stale audio can never be served, while a
// re-run of Auto Sync skips ffmpeg entirely for unchanged media.
const ENV_CACHE_MAX_AGE_DAYS = 30;
let envCacheDir = null;
try {
    if (fs && path && crypto) {
        envCacheDir = path.join(
            csInterface.getSystemPath(SystemPath.USER_DATA), "Syncitol", "envelope-cache");
        fs.mkdirSync(envCacheDir, { recursive: true });
        pruneEnvelopeCacheDir();
    }
} catch (e) {
    envCacheDir = null; // cache is an optimization only — never block the panel on it
}

// Fire-and-forget: drop entries not touched in ENV_CACHE_MAX_AGE_DAYS so the
// cache tracks the projects actually being worked on instead of growing forever.
function pruneEnvelopeCacheDir() {
    fs.readdir(envCacheDir, (err, names) => {
        if (err) return;
        const cutoffMs = Date.now() - (ENV_CACHE_MAX_AGE_DAYS * 86400 * 1000);
        for (const name of names) {
            const entry = path.join(envCacheDir, name);
            fs.stat(entry, (statErr, st) => {
                if (!statErr && st.mtimeMs < cutoffMs) fs.unlink(entry, () => {});
            });
        }
    });
}

function envelopeDiskPath(filePath, cacheKey) {
    if (!envCacheDir) return null;
    try {
        const st = fs.statSync(filePath);
        const hash = crypto.createHash("md5")
            .update(`${cacheKey}|${st.mtimeMs}|${st.size}`)
            .digest("hex");
        return path.join(envCacheDir, hash + ".env");
    } catch (e) {
        return null;
    }
}

function readEnvelopeFromDisk(diskPath) {
    try {
        const buf = fs.readFileSync(diskPath);
        if (!buf.length || buf.length % 4 !== 0) return null;
        // Copy out of the Buffer: its byteOffset isn't guaranteed 4-byte aligned.
        return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
    } catch (e) {
        return null; // missing or unreadable — just re-decode
    }
}

// opts.sampleRate / opts.windowSamples select the envelope resolution. The fine
// pass uses the defaults (8 kHz / 80 → 100 Hz envelope); the coarse auto-align
// pass requests a lower-rate envelope so it can search a much wider lag range
// over long windows cheaply.
function getEnvelope(filePath, sourceOffsetSec, durationSec, opts) {
    opts = opts || {};
    const sampleRate = opts.sampleRate || AUDIO_SAMPLE_RATE;
    const windowSamples = opts.windowSamples || ENVELOPE_WINDOW_SAMPLES;
    const cacheKey = `${filePath}|${sourceOffsetSec.toFixed(3)}|${durationSec.toFixed(3)}|${sampleRate}|${windowSamples}`;
    if (envelopeCache.has(cacheKey)) {
        return envelopeCache.get(cacheKey);
    }

    const task = (async () => {
        const diskPath = envelopeDiskPath(filePath, cacheKey);
        if (diskPath) {
            const cached = readEnvelopeFromDisk(diskPath);
            if (cached && cached.length) return cached;
        }

        const buffer = await runCommandCapture(toolPath.ffmpeg || "ffmpeg", [
            "-hide_banner",
            "-loglevel", "error",
            "-ss", sourceOffsetSec.toFixed(3),
            "-t", durationSec.toFixed(3),
            "-i", filePath,
            "-map", "0:a:0",
            "-ac", "1",
            "-ar", String(sampleRate),
            "-f", "s16le",
            "pipe:1"
        ]);
        if (!buffer.length) throw new Error(`No audio samples: ${path.basename(filePath)}`);
        const envelope = buildEnvelope(buffer, windowSamples);
        if (!envelope.length) throw new Error(`Audio slice too short: ${path.basename(filePath)}`);

        if (diskPath) {
            const bytes = Buffer.from(envelope.buffer, envelope.byteOffset, envelope.byteLength);
            fs.writeFile(diskPath, bytes, () => {}); // best-effort, off the hot path
        }
        return envelope;
    })();

    envelopeCache.set(cacheKey, task);
    return task;
}

// findBestLag(), buildFineTuneAnchors(), buildCompareWindow(), describeAnchor()
// and formatRange() live in js/dsp.js.

// ─── Coarse auto-align (whole-track, large offsets) ───────────────────────────
// Device clocks routinely differ by minutes (and embedded timestamps disagree
// across camera makes), so two tracks may sit far apart even after timestamp-based
// Build — beyond the fine pass's ±5 s. For each track this matches ONE clip (the
// longest) against the reference recording and shifts the WHOLE track by the
// offset found. Decoding hours of audio is the real cost, so instead of scanning
// the whole reference we search a bounded window chosen from the cheapest reliable
// PREDICTOR available, widening only on failure:
//   1. start timecode delta (metadata only, no audio) — tiny confirm window;
//   2. the timestamp-based Build position — a few-minute window around it;
//   3. offsets LEARNED from tracks that already matched — devices from one shoot
//      share the same clock-error family, so one track's confirmed offset is a
//      near-free prediction for the rest;
//   4. head region — the first HEAD_SEC of each file, for two long recordings that
//      rolled near the same time when timestamps can't be trusted at all;
//   5. the full reference — last resort.
// The stages run ACROSS tracks (every track's cheap windows before any track's
// blind scan) so a learned offset is available before the expensive fallbacks.
// The fine pass then polishes the residual.
const COARSE_SAMPLE_RATE = 2000;       // Hz of extracted PCM — low rate for speed
const COARSE_WINDOW_SAMPLES = 200;     // → 10 Hz envelope
const COARSE_ENVELOPE_RATE = COARSE_SAMPLE_RATE / COARSE_WINDOW_SAMPLES;
const COARSE_TARGET_MAX_SEC = 120;     // analyze up to this much of the matched clip
const COARSE_REF_MAX_SEC = 3 * 3600;   // cap full-reference extraction (memory/time)
const COARSE_MIN_OVERLAP_SEC = 8;      // need at least this much target inside the ref
const COARSE_MIN_SCORE = 0.3;          // confidence required to shift a whole track
// A bounded predictor window can hold a weak spurious peak while the real, strong
// match sits further out (e.g. metadata off by more than the window). So a match
// only earns the right to OVERRIDE the metadata prediction — or to stop the search
// early — if it's this strong. Anything weaker is trusted only when it agrees with
// the prediction (see analyzeCoarseAlign). Real same-event matches score ~0.6–0.85.
const COARSE_STRONG_SCORE = 0.5;
const COARSE_CONFIRM_NEAR_SEC = 90;    // if a predictor match lands this close to its
                                       // predicted spot, the metadata is confirmed —
                                       // skip the costly full-reference scan (the cheap
                                       // head pass still runs as a safety net)
const COARSE_MIN_APPLY_SEC = 0.25;     // below this, leave it to the fine pass
const COARSE_TC_CONFIRM_SEC = 30;      // half-width of the audio confirm around a TC prediction
const COARSE_PREDICT_MARGIN_SEC = 300; // ± window searched around the timestamp prediction
const COARSE_HEAD_SEC = 12 * 60;       // head-region length when no predictor is trustworthy
// A bounded search window has artificial edges (mid-reference) where a probe can
// overlap only a few seconds of unrelated audio and score a spurious peak. Requiring
// a confident match to overlap at least this much (or the whole probe, if shorter)
// keeps those edge matches from hijacking a whole-track shift. A real offset — even
// a large one — overlaps the full probe and clears this easily.
const COARSE_MATCH_OVERLAP_SEC = 60;
// ± confirm window around an offset learned from another track. Devices started
// within minutes of each other, so their offsets agree to well under this (22 s
// apart in the real-world log that motivated the feature).
const COARSE_LEARNED_MARGIN_SEC = 120;

const COARSE_CFG = {
    minOverlapSec: COARSE_MIN_OVERLAP_SEC,
    targetMaxSec: COARSE_TARGET_MAX_SEC,
    tcConfirmSec: COARSE_TC_CONFIRM_SEC,
    predictMarginSec: COARSE_PREDICT_MARGIN_SEC,
    headSec: COARSE_HEAD_SEC,
    minScore: COARSE_MIN_SCORE,
    strongScore: COARSE_STRONG_SCORE,
    confirmNearSec: COARSE_CONFIRM_NEAR_SEC,
    learnedMarginSec: COARSE_LEARNED_MARGIN_SEC
};

function trackKeyOf(anchor) {
    return `${anchor.trackType}_${anchor.trackIndex}`;
}

function longestAnchor(list) {
    let best = null;
    let bestDur = -1;
    for (const a of list) {
        const dur = a.resolvedEndSec - a.resolvedStartSec;
        if (dur > bestDur) { bestDur = dur; best = a; }
    }
    return best;
}

// Shift whole tracks by one large offset found from a single representative clip.
// Mutates each anchor's resolvedStart/End so the fine pass sees aligned positions,
// and returns a per-anchor-key map of the coarse delta applied plus a structured
// per-track result row for the Sync Results table.
async function analyzeCoarseAlign(anchors, onProgress) {
    const deltaByKey = new Map();
    const notes = [];
    const results = [];
    if (anchors.length < 2) return { deltaByKey, notes, results };

    const baseLayer = anchors[0].layerOrder;

    // Group non-base anchors by their real track identity (not layerOrder, which
    // can collide between a video track and an audio-only track).
    const trackGroups = new Map();
    for (const anchor of anchors) {
        if (anchor.layerOrder === baseLayer) continue;
        const key = trackKeyOf(anchor);
        if (!trackGroups.has(key)) trackGroups.set(key, []);
        trackGroups.get(key).push(anchor);
    }

    notes.push(`Coarse align: staged search — start timecode and Build-position windows for every track first, then offsets learned from already-matched tracks, then the head region, then the full file — at ${COARSE_ENVELOPE_RATE}Hz.`);

    const envOpts = { sampleRate: COARSE_SAMPLE_RATE, windowSamples: COARSE_WINDOW_SAMPLES };
    const cfg = COARSE_CFG;

    // ── One job per track ─────────────────────────────────────────────────────
    // Tracks whose setup fails (no reference, too short) are reported immediately;
    // the rest carry per-track search state through the stages below.
    const jobs = [];
    for (const group of trackGroups.values()) {
        const trackLabel = `${group[0].trackType} track ${group[0].trackIndex + 1}`;
        const targetLayer = group[0].layerOrder;

        // Reference = longest recording on any lower layer (the continuous
        // program/board recording in a typical multicam setup).
        const reference = longestAnchor(anchors.filter(a => a.layerOrder < targetLayer));
        // Representative target = longest clip on this track (most audio to match).
        const target = longestAnchor(group);

        if (!reference || !target) {
            log(`Coarse align: ${trackLabel} — no reference recording, leaving to fine pass.`);
            results.push({ scope: "track", label: trackLabel, status: "skipped", detail: "no reference recording — left to fine pass" });
            continue;
        }

        const refDurationFull = Math.min(reference.resolvedEndSec - reference.resolvedStartSec, COARSE_REF_MAX_SEC);
        const tgtAvail = target.resolvedEndSec - target.resolvedStartSec;
        const probeShort = Math.min(tgtAvail, COARSE_TARGET_MAX_SEC);
        if (probeShort < COARSE_MIN_OVERLAP_SEC || refDurationFull < COARSE_MIN_OVERLAP_SEC) {
            log(`Coarse align: ${trackLabel} — clips too short to match, leaving to fine pass.`);
            results.push({ scope: "track", label: trackLabel, status: "skipped", detail: "clips too short to match — left to fine pass" });
            continue;
        }

        jobs.push({
            group, trackLabel, reference, target, refDurationFull, tgtAvail,
            geom: null, plans: null,
            state: createCoarseState(),
            lines: [],                // buffered log lines, flushed as one block
            triedLearned: new Set(),  // learned offsets this track has already checked
            done: false,              // matched strongly — stop searching
            failed: false,            // decode error — leave to the fine pass
            finalized: false
        });
    }
    if (!jobs.length) return { deltaByKey, notes, results };

    // Metadata-only geometry + plan list per job (cheap ffprobe reads). All of the
    // window math and selection policy is pure and lives (tested) in dsp.js; this
    // function only drives the async ffmpeg matcher.
    await Promise.all(jobs.map(async (job) => {
        // Start-timecode delta (no audio): when both files carry a usable TC, this
        // is the reference source offset that lines up with the target's in-point.
        let tcDelta = null;
        try {
            const [tcRef, tcTgt] = await Promise.all([
                probeStartTimecode(job.reference.filePath),
                probeStartTimecode(job.target.filePath)
            ]);
            if (tcRef !== null && tcTgt !== null) tcDelta = tcTgt - tcRef;
        } catch (e) {
            if (e && e.cancelled) throw e; // timecode is otherwise optional
        }
        job.geom = {
            refInPointSec: job.reference.inPointSec,
            refDurationFull: job.refDurationFull,
            refResolvedStartSec: job.reference.resolvedStartSec,
            targetInPointSec: job.target.inPointSec,
            targetResolvedStartSec: job.target.resolvedStartSec,
            targetAvailSec: job.tgtAvail,
            tcDelta
        };
        job.plans = planCoarseSearch(job.geom, cfg);
    }));

    // Whole-track offsets confirmed STRONGLY on some track — near-free search
    // hints for the others, since devices from one shoot share a clock-error
    // family (two cameras in the motivating log were 22 s apart at ~-630 s).
    const learnedDeltas = [];

    function matchPlan(job, plan) {
        return Promise.all([
            getEnvelope(job.reference.filePath, plan.winStart, plan.winDur, envOpts),
            getEnvelope(job.target.filePath, job.target.inPointSec, plan.probeDur, envOpts)
        ]).then(([refEnvelope, targetEnvelope]) => slideMatch(refEnvelope, targetEnvelope, {
            envelopeRate: COARSE_ENVELOPE_RATE,
            // Demand real overlap so a window's artificial mid-reference edge
            // can't win with a few seconds of spurious correlation.
            minOverlapSec: Math.min(plan.probeDur, COARSE_MATCH_OVERLAP_SEC)
        }));
    }

    // Check every learned offset this job hasn't tried yet; true = strong match.
    async function tryLearnedHints(job) {
        for (const learned of [...learnedDeltas]) {
            const hintKey = Math.round(learned / 10); // offsets within ~10s are one lead
            if (job.triedLearned.has(hintKey)) continue;
            job.triedLearned.add(hintKey);
            const plan = planLearnedSearch(job.geom, cfg, learned);
            if (!plan) continue;
            if (coarseConsider(job.state, plan, await matchPlan(job, plan), job.geom, cfg)) return true;
        }
        return false;
    }

    // Resolve a finished job: apply the chosen shift, flush its buffered log lines
    // as one block, and publish a strong delta as a hint for the remaining tracks.
    function finalizeJob(job) {
        job.finalized = true;
        if (!job.failed) {
            const result = coarseResolve(job.state, job.geom, cfg);
            if (!result.chosen) {
                job.lines.push([`Coarse align: ${job.trackLabel} — no confident match for ${job.target.clipName} (best score ${result.best ? result.best.score.toFixed(2) : "n/a"}), leaving to fine pass.`, "warn"]);
                results.push({
                    scope: "track", label: job.trackLabel, status: "unmatched",
                    score: result.best ? result.best.score : null,
                    detail: `no confident match for ${job.target.clipName}`
                });
            } else if (Math.abs(result.coarseDelta) < COARSE_MIN_APPLY_SEC) {
                job.lines.push([`Coarse align: ${job.trackLabel} already aligned (match score ${result.chosen.score.toFixed(2)}).`]);
                results.push({
                    scope: "track", label: job.trackLabel, status: "aligned",
                    score: result.chosen.score, method: result.chosen.label
                });
            } else {
                for (const anchor of job.group) {
                    anchor.resolvedStartSec += result.coarseDelta;
                    anchor.resolvedEndSec += result.coarseDelta;
                    deltaByKey.set(anchor.key, (deltaByKey.get(anchor.key) || 0) + result.coarseDelta);
                }
                job.lines.push([`Coarse align: ${job.trackLabel} shifted ${formatSignedSeconds(result.coarseDelta)} to match ${job.target.clipName} against ${job.reference.clipName} via ${result.chosen.label} (score ${result.chosen.score.toFixed(2)}).`, "success"]);
                results.push({
                    scope: "track", label: job.trackLabel, status: "shifted",
                    deltaSec: result.coarseDelta, score: result.chosen.score, method: result.chosen.label
                });
                if (result.chosen.score >= COARSE_STRONG_SCORE) learnedDeltas.push(result.coarseDelta);
            }
        }
        for (const [msg, type] of job.lines) log(msg, type);
        job.lines.length = 0;
    }

    // ── Staged execution across tracks ────────────────────────────────────────
    // Every track runs its cheap metadata windows before ANY track pays for a
    // blind scan, and blind stages first check offsets learned from tracks that
    // already matched. Within a stage tracks still run concurrently; reference
    // windows shared across tracks (e.g. the head region) are decoded once and
    // reused via the envelope cache.
    const stages = [["timecode", "timestamp"], ["head"], ["full"]];
    let units = 0;
    const totalUnits = jobs.length * stages.length;

    for (const stageLabels of stages) {
        const blind = stageLabels[0] !== "timecode";
        const pending = jobs.filter(j => !j.done && !j.failed);
        units += jobs.length - pending.length;   // already-resolved tracks skip the stage
        if (onProgress) onProgress(units, totalUnits);
        if (!pending.length) continue;

        await mapPool(pending, SYNC_CONCURRENCY, async (job) => {
            try {
                if (blind && learnedDeltas.length && await tryLearnedHints(job)) {
                    job.done = true;
                }
                if (!job.done) {
                    for (const plan of job.plans) {
                        if (stageLabels.indexOf(plan.label) === -1) continue;
                        if (plan.label === "full" && job.state.skipFull) continue; // prediction confirmed — skip the costly full scan
                        if (coarseConsider(job.state, plan, await matchPlan(job, plan), job.geom, cfg)) {
                            job.done = true;
                            break;
                        }
                    }
                }
            } catch (e) {
                if (e && e.cancelled) throw e;
                job.failed = true;
                job.lines.push([`Coarse align: ${job.target.clipName} — ${e.message}; leaving to fine pass.`, "warn"]);
                results.push({ scope: "track", label: job.trackLabel, status: "skipped", detail: e.message });
            }
            units += 1;
            if (onProgress) onProgress(units, totalUnits);
        });

        // Publish freshly-confident offsets before the next (blind) stage.
        for (const job of jobs) {
            if ((job.done || job.failed) && !job.finalized) finalizeJob(job);
        }
    }

    // Tracks that exhausted every stage: accept a near-prediction match or give up.
    for (const job of jobs) {
        if (!job.finalized) finalizeJob(job);
    }

    return { deltaByKey, notes, results };
}

async function comparePair(reference, target) {
    const comparePlan = buildCompareWindow(reference, target);
    if (!comparePlan) {
        return {
            reference,
            target,
            usable: false,
            reason: `timeline overlap ${Math.max(0, Math.min(reference.resolvedEndSec, target.resolvedEndSec) - Math.max(reference.resolvedStartSec, target.resolvedStartSec)).toFixed(2)}s is below minimum ${FINE_TUNE_MIN_OVERLAP_SEC}s`,
            attempts: []
        };
    }

    let best = null;
    const attempts = [];
    let lastError = "";
    let railRejected = false; // a window matched, but only at the ±max-shift limit

    for (let index = 0; index < comparePlan.windows.length; index += 1) {
        const window = comparePlan.windows[index];
        try {
            const [refEnvelope, targetEnvelope] = await Promise.all([
                getEnvelope(reference.filePath, window.refSourceOffsetSec, window.compareDurationSec),
                getEnvelope(target.filePath, window.targetSourceOffsetSec, window.compareDurationSec)
            ]);

            const lag = findBestLag(refEnvelope, targetEnvelope);
            if (!lag) {
                attempts.push({
                    attemptIndex: index + 1,
                    window,
                    reason: "flat or low-variance audio in this slice"
                });
                continue;
            }
            // A match jammed against the ±max-shift limit is almost always spurious;
            // discarding it keeps a confident coarse alignment from being dragged to
            // the boundary. Other windows (or just the coarse position) win instead.
            if (lag.atRail) {
                railRejected = true;
                attempts.push({
                    attemptIndex: index + 1,
                    window,
                    reason: `best match pinned to the ±${FINE_TUNE_MAX_SHIFT_SEC}s search limit (likely spurious)`
                });
                continue;
            }

            const attemptResult = {
                attemptIndex: index + 1,
                window,
                score: lag.score,
                lagSec: lag.lagSec,
                overlapSec: lag.overlapSec
            };
            attempts.push(attemptResult);

            if (!best || attemptResult.score > best.score) {
                best = attemptResult;
            }

            // If the first (centered) window is already a strong match,
            // skip alternate windows to keep fine tune fast.
            if (index === 0 && attemptResult.score >= FINE_TUNE_DECENT_SCORE) {
                break;
            }
        } catch (e) {
            if (e && e.cancelled) throw e;
            lastError = e.message;
            attempts.push({
                attemptIndex: index + 1,
                window,
                reason: e.message
            });
        }
    }

    if (!best) {
        // Distinguish "found a match but it was a spurious ±max-shift peak" (in
        // which case the coarse alignment is kept on purpose) from a genuine miss.
        return {
            reference,
            target,
            usable: false,
            railRejected: railRejected && !lastError,
            reason: (railRejected && !lastError)
                ? `fine-tune match pinned to the ±${FINE_TUNE_MAX_SHIFT_SEC}s limit (unreliable) — keeping coarse alignment`
                : (lastError || "no lag candidate from attempted windows"),
            attempts
        };
    }

    return {
        reference,
        target,
        usable: true,
        score: best.score,
        lagSec: best.lagSec,
        overlapSec: best.overlapSec,
        overlapWindowSec: comparePlan.overlapSec,
        selectedWindow: best.window,
        attempts
    };
}

// ─── Clock-drift check ────────────────────────────────────────────────────────
// A single offset can't fix devices whose clocks run at different RATES; on long
// recordings the tail drifts audibly even when the head is aligned. Measure the
// residual lag near both ends of a long overlap (window math in dsp.js) and
// report the divergence — we can't rate-stretch via the API, but naming the
// drift explains "slightly off at the end" and suggests the fix (split clips).
async function measureDrift(reference, target) {
    const probe = buildDriftProbe(reference, target);
    if (!probe) return null; // overlap too short for drift to matter

    const [refEarly, tgtEarly, refLate, tgtLate] = await Promise.all([
        getEnvelope(reference.filePath, probe.early.refSourceOffsetSec, probe.early.compareDurationSec),
        getEnvelope(target.filePath, probe.early.targetSourceOffsetSec, probe.early.compareDurationSec),
        getEnvelope(reference.filePath, probe.late.refSourceOffsetSec, probe.late.compareDurationSec),
        getEnvelope(target.filePath, probe.late.targetSourceOffsetSec, probe.late.compareDurationSec)
    ]);

    const early = findBestLag(refEarly, tgtEarly);
    const late = findBestLag(refLate, tgtLate);
    // Both ends must match confidently and inside the search range, or the
    // difference means nothing.
    if (!early || !late || early.atRail || late.atRail) return null;
    if (early.score < FINE_TUNE_MIN_SCORE || late.score < FINE_TUNE_MIN_SCORE) return null;

    const driftSec = late.lagSec - early.lagSec;
    if (Math.abs(driftSec) < DRIFT_MIN_REPORT_SEC) return null;
    return {
        driftSec: Math.round(driftSec * 1000) / 1000,
        ppm: Math.round((driftSec / probe.spanSec) * 1e6),
        spanSec: probe.spanSec
    };
}

async function analyzeFineTune(anchors, onProgress) {
    const adjustments = [];
    const notes = [];
    const results = [];

    if (!anchors.length) return { adjustments, notes, results };

    const baseLayer = anchors[0].layerOrder;

    // Targets are every non-base clip; each aligns only to lower (base) layers,
    // which the fine pass never mutates — so the clips are independent and can be
    // compared concurrently. Keep each clip's original index for its references.
    const targets = [];
    for (let i = 0; i < anchors.length; i += 1) {
        if (anchors[i].layerOrder !== baseLayer) targets.push({ target: anchors[i], targetIndex: i });
    }
    const nonBaseTotal = targets.length;
    let doneCount = 0;

    notes.push(`Fine tune compare window: up to ${FINE_TUNE_MAX_COMPARE_SEC}s per pair, max shift ±${FINE_TUNE_MAX_SHIFT_SEC}s, retries on an alternate window when first-window score is below ${FINE_TUNE_DECENT_SCORE.toFixed(2)}; ${SYNC_CONCURRENCY} clips at a time.`);

    const outcomes = await mapPool(targets, SYNC_CONCURRENCY, async ({ target, targetIndex }) => {
        let bestPair = null;
        const pairDiagnostics = [];
        let railKept = false; // a comparison matched only at the ±max-shift rail
        for (let refIndex = 0; refIndex < targetIndex; refIndex += 1) {
            const reference = anchors[refIndex];
            if (reference.layerOrder >= target.layerOrder) continue;

            const result = await comparePair(reference, target);
            if (!result || !result.usable) {
                if (result && result.reason) {
                    pairDiagnostics.push(`${describeAnchor(reference)}: ${result.reason}`);
                }
                if (result && result.railRejected) railKept = true;
                continue;
            }

            if (!bestPair || result.score > bestPair.score) {
                bestPair = result;
            }
        }

        // Buffer this clip's lines so concurrent clips stay as intact blocks.
        const lines = [];
        let adjustment = null;
        const row = { scope: "clip", label: target.clipName };

        if (!bestPair && railKept) {
            // Not a failure: the fine pass declined a spurious boundary match and
            // left the clip on its (strong) coarse alignment.
            lines.push([`↳ ${target.clipName}: kept coarse alignment — fine-tune match was unreliable (pinned to ±${FINE_TUNE_MAX_SHIFT_SEC}s limit)`, "info"]);
            row.status = "kept";
            row.detail = "fine match unreliable — kept coarse alignment";
        } else if (!bestPair) {
            const detail = pairDiagnostics.length ? ` (${pairDiagnostics[0]})` : "";
            lines.push([`⚠ Skip ${target.clipName}: no usable overlap/match${detail}`, "warn"]);
            row.status = "unmatched";
            row.detail = pairDiagnostics.length ? pairDiagnostics[0] : "no usable overlap or match";
        } else if (bestPair.score < FINE_TUNE_MIN_SCORE) {
            lines.push([`⚠ Skip ${target.clipName}: weak match score ${bestPair.score.toFixed(2)} vs ${bestPair.reference.clipName}`, "warn"]);
            row.status = "weak";
            row.score = bestPair.score;
            row.method = bestPair.reference.clipName;
        } else {
            // Positive lag means target starts later than reference in extracted
            // windows, so move target earlier by that amount.
            const deltaSec = -(bestPair.lagSec);
            row.score = bestPair.score;
            row.method = bestPair.reference.clipName;
            if (Math.abs(deltaSec) < FINE_TUNE_MIN_APPLY_SEC) {
                lines.push([`${target.clipName} already aligned (delta < 20 ms)`, "info"]);
                row.status = "aligned";
            } else {
                const roundedDelta = Math.round(deltaSec * 1000) / 1000;
                adjustment = {
                    clipName: target.clipName,
                    filePath: target.filePath,
                    startTicks: target.startTicks,
                    deltaSec: roundedDelta,
                    referenceName: bestPair.reference.clipName,
                    score: bestPair.score
                };
                target.resolvedStartSec += roundedDelta;
                target.resolvedEndSec += roundedDelta;
                lines.push([`✓ ${target.clipName}: shift ${formatSignedSeconds(roundedDelta)} vs ${bestPair.reference.clipName} (score ${bestPair.score.toFixed(2)}, ${bestPair.attempts.length} window${bestPair.attempts.length !== 1 ? "s" : ""})`, "success"]);
                row.status = "shifted";
                row.deltaSec = roundedDelta;
            }

            // Long overlap and a solid match: also check whether the two devices'
            // clocks RUN at different rates (drift), which one offset can't fix.
            try {
                const drift = await measureDrift(bestPair.reference, target);
                if (drift) {
                    row.driftSec = drift.driftSec;
                    row.driftPpm = drift.ppm;
                    lines.push([`⚠ ${target.clipName}: clock drift ${formatSignedSeconds(drift.driftSec)} across ${formatDuration(drift.spanSec * 1000)} (~${drift.ppm} ppm) vs ${bestPair.reference.clipName} — the tail may be audibly off; consider splitting long clips before syncing.`, "warn"]);
                }
            } catch (e) {
                if (e && e.cancelled) throw e;
                // Drift measurement is best-effort — never fail the clip over it.
            }
        }

        doneCount += 1;
        log(`Fine tune: [${doneCount}/${nonBaseTotal}] ${target.clipName} (${target.trackType.toUpperCase()} ${target.trackIndex + 1})`);
        for (const [msg, type] of lines) log(msg, type);
        if (onProgress) onProgress(doneCount, nonBaseTotal);

        return { adjustment, row };
    });

    for (const outcome of outcomes) {
        if (outcome.adjustment) adjustments.push(outcome.adjustment);
        results.push(outcome.row);
    }

    return { adjustments, notes, results };
}

// ─── Sync Results summary ─────────────────────────────────────────────────────
// The log is a stream; this is the glanceable verdict. One row per coarse track
// and per fine-tuned clip: what happened, matched via what, and how confident —
// so "which track failed and why" is answered without scrolling the log.
function scoreBadge(score) {
    if (score === null || score === undefined) return `<span class="score-badge score-none">—</span>`;
    const cls = score >= 0.5 ? "score-high" : (score >= 0.25 ? "score-mid" : "score-low");
    return `<span class="score-badge ${cls}">${score.toFixed(2)}</span>`;
}

function renderSyncSummary(rows) {
    if (!rows.length) {
        clearSyncSummary();
        return;
    }
    const statusText = {
        shifted: r => formatSignedSeconds(r.deltaSec),
        aligned: () => "in sync",
        kept: () => "kept coarse",
        weak: () => "weak match",
        unmatched: () => "no match",
        skipped: () => "skipped"
    };
    const statusClass = {
        shifted: "res-ok", aligned: "res-ok", kept: "res-info",
        weak: "res-warn", unmatched: "res-bad", skipped: "res-warn"
    };
    resultsBody.innerHTML = "";
    for (const row of rows) {
        const tr = document.createElement("tr");
        const result = (statusText[row.status] || (() => row.status))(row);
        const driftFlag = (row.driftSec !== undefined)
            ? ` <span class="drift-flag" title="Clock drift ${escapeHtml(formatSignedSeconds(row.driftSec))} (~${row.driftPpm} ppm) between the devices — one offset can't fix both ends; consider splitting long clips.">drift</span>`
            : "";
        tr.innerHTML = `
            <td class="cell-name" title="${escapeHtml(row.detail || "")}">${row.scope === "track" ? "⇉ " : ""}${escapeHtml(row.label)}</td>
            <td class="${statusClass[row.status] || ""}">${escapeHtml(result)}${driftFlag}</td>
            <td class="cell-via" title="${escapeHtml(row.method || "")}">${escapeHtml(row.method || "—")}</td>
            <td>${scoreBadge(row.score)}</td>
        `;
        resultsBody.appendChild(tr);
    }
    resultsSection.hidden = false;
}

function clearSyncSummary() {
    resultsSection.hidden = true;
    resultsBody.innerHTML = "";
}

// ─── Revert last fine tune ────────────────────────────────────────────────────
// Premiere's scripting API has no undo grouping, but we know every delta we
// applied — apply's `moved` list (with post-move start ticks) plus the boundary
// compensation invert exactly. Cleared when a Build replaces the timeline.
function setRevertAvailable(payload) {
    lastFineTuneRevert = payload;
    btnRevert.hidden = !payload;
}

async function revertFineTune() {
    if (!lastFineTuneRevert) return;
    beginOp("Reverting fine tune…");
    btnRevert.disabled = true;
    btnSync.disabled = true;
    btnRefresh.disabled = true;
    btnFineTune.disabled = true;

    try {
        const payloadJSON = JSON.stringify(lastFineTuneRevert);
        await evalScript(`$.fineTunePayload = ${JSON.stringify(payloadJSON)};`);
        const applyRaw = await evalScript("applyFineTuneAdjustments($.fineTunePayload)");
        const apply = JSON.parse(applyRaw);
        if (apply.error) throw new Error(apply.error);
        if (apply.errors && apply.errors.length) {
            apply.errors.forEach(msg => log(`⚠ ${msg}`, "warn"));
        }
        log(`↩ Reverted the last fine tune (${apply.moved.length} clip${apply.moved.length !== 1 ? "s" : ""} restored).`, "success");
        setRevertAvailable(null);
        clearSyncSummary();
    } catch (e) {
        log(`✗ Revert failed: ${e.message}`, "error");
    } finally {
        btnRevert.disabled = false;
        btnSync.disabled = false;
        btnRefresh.disabled = false;
        btnFineTune.disabled = false;
        endOp();
    }
}
btnRevert.addEventListener("click", revertFineTune);

// ─── Refresh: read active sequence ───────────────────────────────────────────
async function refreshSequence() {
    beginOp("Scanning sequence…");
    clearLog();
    clearSyncSummary();
    clipPayload = null;
    btnSync.disabled = true;
    btnFineTune.disabled = true;
    clipTable.style.display = "none";
    seqInfo.textContent = "Reading sequence…";
    setProgress(10);

    try {
        // 1. Get sequence info for header
        const infoRaw = await evalScript("getActiveSequenceInfo()");
        const info = JSON.parse(infoRaw);
        if (info.error) throw new Error(info.error);

        seqInfo.innerHTML = `
            <span class="seq-name">${escapeHtml(info.name)}</span>
            <span class="seq-meta">${info.videoClips} video clip${info.videoClips !== 1 ? "s" : ""} · ${info.audioClips} audio clip${info.audioClips !== 1 ? "s" : ""}</span>
        `;
        scannedSeqName = info.name;   // mark this sequence as the scanned one
        lastLiveSeqName = info.name;  // keep the idle poll from re-flagging it
        log(`Sequence: "${info.name}" — ${info.videoClips} video, ${info.audioClips} audio clips`);
        setProgress(30);

        // 2. Get clip file paths
        const clipsRaw = await evalScript("getClipFileInfo()");
        const clipsResp = JSON.parse(clipsRaw);
        if (clipsResp.error) throw new Error(clipsResp.error);
        const clips = clipsResp.clips;
        if (clipsResp.skipped > 0) {
            log(`⚠ ${clipsResp.skipped} clip${clipsResp.skipped !== 1 ? "s" : ""} skipped — offline media or no file path. Relink offline media if they should be synced.`, "warn");
        }
        if (!clips.length) throw new Error("No readable clips found in sequence.");

        log(`Found ${clips.length} unique source file(s). Reading timestamps (${SYNC_CONCURRENCY} at a time)…`);
        setProgress(50);

        // 3. Resolve each file's record start via Node.js — the per-file ffprobe/
        //    stat work is independent, so run it through the pool (results stay in
        //    input order; log lines are emitted afterwards so they read stably).
        if (!fs) throw new Error("Node.js not available. Ensure --enable-nodejs and --mixed-context are set in manifest.");

        let probed = 0;
        const outcomes = await mapPool(clips, SYNC_CONCURRENCY, async (clip) => {
            try {
                const r = await resolveRecordStart(clip);
                return { clip, r };
            } catch (e) {
                if (e && e.cancelled) throw e;
                return { clip, errorMessage: e.message };
            } finally {
                probed += 1;
                setProgress(50 + Math.round((probed / clips.length) * 30));
            }
        });

        const enriched = [];
        const sourceCounts = {};
        for (const { clip, r, errorMessage } of outcomes) {
            if (errorMessage !== undefined) {
                log(`⚠ Could not read "${clip.filePath}": ${errorMessage}`, "warn");
                continue;
            }
            enriched.push({
                ...clip,
                mtimeMs: r.mtimeMs,
                recordStartMs: r.recordStartMs,
                durationSec: r.durationSec,
                timingSource: r.timingSource
            });
            sourceCounts[r.timingSource] = (sourceCounts[r.timingSource] || 0) + 1;
            const srcLabel = isEmbeddedSource(r.timingSource) ? `embedded ${r.timingSource}` : "file mtime";
            log(`✓ ${path.basename(clip.filePath)} — start ${formatTime(r.recordStartMs)} via ${srcLabel}, duration ${formatDuration(r.durationSec * 1000)}`);
        }

        if (!enriched.length) throw new Error("Could not read timestamps for any clips.");

        // Mixed timing sources have different semantics (embedded record-start vs.
        // mtime-derived), so clips from different sources may not agree on the
        // absolute clock. Warn; Fine Tune Audio can correct the residual drift.
        // Only warn when a precise embedded source is mixed with the mtime
        // fallback — two embedded sources (creation_time + modification_date) are
        // both accurate record starts and don't conflict.
        const usedSources = Object.keys(sourceCounts);
        const hasEmbedded = usedSources.some(isEmbeddedSource);
        const hasMtime = usedSources.includes("mtime");
        if (hasEmbedded && hasMtime) {
            const breakdown = usedSources.map(s => `${s}: ${sourceCounts[s]}`).join(", ");
            log(`⚠ Mixed timing sources (${breakdown}). mtime-derived starts are less precise than embedded ones; use Fine Tune Audio to correct residual drift.`, "warn");
        }

        // Global earliest recording — every clip is placed relative to this one
        // shared wall-clock anchor (matches the Build logic).
        let globalEarliestMs = Infinity;
        for (const clip of enriched) {
            if (clip.recordStartMs < globalEarliestMs) globalEarliestMs = clip.recordStartMs;
        }

        setProgress(80);

        // 4. Populate clip table (offset shown relative to the global earliest)
        clipBody.innerHTML = "";
        enriched.forEach(clip => {
            const offsetMs = clip.recordStartMs - globalEarliestMs;
            const tr = document.createElement("tr");
            const srcTag = isEmbeddedSource(clip.timingSource) ? "meta" : "mtime";
            tr.innerHTML = `
                <td class="cell-name" title="${escapeHtml(clip.filePath)}">${escapeHtml(path.basename(clip.filePath))}</td>
                <td class="cell-type ${clip.trackType}">${clip.trackType === "video" ? "🎬" : "🎵"} ${clip.trackType}</td>
                <td class="cell-time" title="timing source: ${escapeHtml(clip.timingSource)}">${formatTime(clip.recordStartMs)} <span class="cell-src">${srcTag}</span></td>
                <td class="cell-offset">${formatDuration(offsetMs)}</td>
            `;
            clipBody.appendChild(tr);
        });
        clipTable.style.display = "table";

        // 5. 24-hour span guard (whole sequence runs from the global earliest)
        const maxEndMs = Math.max(...enriched.map(c => c.recordStartMs + c.durationSec * 1000));
        const spanSec = (maxEndMs - globalEarliestMs) / 1000;
        const hasSpanViolation = spanSec > MAX_SPAN_SEC;
        if (hasSpanViolation) {
            log(`\u26a0 Sequence spans ${(spanSec / 3600).toFixed(1)}h \u2014 exceeds Premiere\u2019s 24-hour maximum.`, "warn");
        }

        clipPayload = enriched;
        btnFineTune.disabled = false;
        setProgress(100);
        setTimeout(() => setProgress(0, false), 600);

        if (hasSpanViolation) {
            log("Build Sync Sequence is disabled \u2014 the sequence must fit within 24 hours. Process one recording day at a time.", "error");
        } else {
            btnSync.disabled = false;
            log(`Ready. Click \"Build Sync Sequence\" to create ${info.name}-SYNC.`, "success");
        }

        return !hasSpanViolation;

    } catch (e) {
        if (e && e.cancelled) {
            seqInfo.textContent = "Scan cancelled.";
            log("Scan cancelled.", "warn");
        } else {
            seqInfo.textContent = "Error reading sequence.";
            log(`✗ ${e.message}`, "error");
        }
        setProgress(0, false);
        return false;
    } finally {
        endOp();
    }
}

// ─── Build sync sequence ──────────────────────────────────────────────────────
async function buildSync() {
    if (!clipPayload) return false;

    beginOp("Building sync sequence…");
    setRevertAvailable(null); // the timeline is about to be replaced
    btnSync.disabled = true;
    btnRefresh.disabled = true;
    btnFineTune.disabled = true;
    setProgress(20);
    if (scannedSeqName && /-SYNC$/.test(scannedSeqName)) {
        log(`⚠ "${scannedSeqName}" looks like an already-built sync sequence — building it again creates "${scannedSeqName}-SYNC". Run from the original sequence unless this is intentional.`, "warn");
    }
    log("Building sync sequence…");

    try {
        // Store payload in a global the JSX can read directly
        // This avoids ALL string escaping issues with Windows paths
        const payloadJSON = JSON.stringify(clipPayload);
        await evalScript(`$.timeSyncPayload = ${JSON.stringify(payloadJSON)};`);
        
        const result = await evalScript(`buildSyncSequence($.timeSyncPayload)`);
        const parsed = JSON.parse(result);

        if (parsed.error) throw new Error(parsed.error);

        setProgress(90);

        log(`✓ Created sequence: "${parsed.sequenceName}"`, "success");
        parsed.placed.forEach(p => {
            log(`  Placed "${p.clipName}" at +${formatDuration(p.offsetSec * 1000)} (${p.offsetTicks} ticks)`);
        });
        if (parsed.multiAudioGroups > 0) {
            if (parsed.relinkSupported) {
                log(`Re-linked ${parsed.relinked} multi-track audio clip${parsed.relinked !== 1 ? "s" : ""} (video + audio that Premiere unlinks when repositioning).`, "success");
            } else {
                log(`⚠ ${parsed.multiAudioGroups} clip(s) with multi-track audio were placed but this Premiere version can't re-link them via script — select the video + its audio and Link manually if needed.`, "warn");
            }
        }
        if (parsed.errors && parsed.errors.length) {
            parsed.errors.forEach(e => log(`⚠ ${e}`, "warn"));
        }

        setProgress(100);
        setTimeout(() => setProgress(0, false), 800);
        log(`Done! "${parsed.sequenceName}" is now open.`, "success");

        // Refresh UI state so ACTIVE SEQUENCE reflects the newly opened sequence.
        await refreshSequence();
        return true;

    } catch (e) {
        log(`✗ ${e.message}`, "error");
        setProgress(0, false);
        return false;
    } finally {
        btnSync.disabled = false;
        btnRefresh.disabled = false;
        btnFineTune.disabled = false;
        endOp();
    }
}

// ─── Fine tune by waveform comparison ────────────────────────────────────────
async function fineTuneAudio(opts = {}) {
    const runCoarse = opts.coarse === true; // Auto Sync passes true; the manual button is fine-only
    beginOp(runCoarse ? "Fine tuning…" : "Fine tuning (fast)…");
    clearSyncSummary();
    btnRefresh.disabled = true;
    btnSync.disabled = true;
    btnFineTune.disabled = true;
    setProgress(5);
    log("Fine tune: analyzing waveform overlaps…");

    // Envelopes are cached per (file, offset, duration) within a run; clear at
    // the start of each run so the cache cannot grow for the panel's lifetime
    // and so a re-run re-reads files that may have changed on disk.
    envelopeCache.clear();

    try {
        await ensureFfmpeg();

        const clipInfoRaw = await evalScript("getFineTuneClipInfo()");
        const clipInfo = JSON.parse(clipInfoRaw);
        if (clipInfo.error) throw new Error(clipInfo.error);
        if (clipInfo.skipped > 0) {
            log(`⚠ ${clipInfo.skipped} clip${clipInfo.skipped !== 1 ? "s" : ""} skipped — offline media or no file path.`, "warn");
        }

        const anchors = buildFineTuneAnchors(clipInfo.clips);
        if (anchors.length < 2) {
            throw new Error("Need at least two clips with accessible audio for fine tune.");
        }

        const refAnchor = anchors.find(a => a.isReference);
        if (refAnchor) {
            const refCount = anchors.filter(a => a.isReference).length;
            log(`Reference track: ${refAnchor.trackType.toUpperCase()} ${refAnchor.trackIndex + 1} — longest coverage (${refCount} clip${refCount !== 1 ? "s" : ""}). All other tracks align to it.`);
        }

        log(`Fine tune: evaluating ${anchors.length} clips.`);
        setProgress(10);

        // Phase 1 — coarse auto-align (Auto Sync only). It shifts whole tracks into
        // the fine pass's ±5 s range, handling large clock offsets. The manual Fine
        // Tune button skips it: you're hands-on and have already aligned clips, so
        // only the small residual is left — no minute-long whole-file scan.
        const syncRows = [];
        const coarseDeltaByKey = new Map();
        if (runCoarse) {
            setBusy("Fine tuning — coarse align…");
            log("Coarse align: scanning audio to find each track's offset — this can take a minute on long clips…");
            const coarse = await analyzeCoarseAlign(anchors, (done, total) => {
                setProgress(10 + Math.round((done / total) * 25));
            });
            coarse.notes.forEach(msg => log(msg));
            for (const [key, d] of coarse.deltaByKey) coarseDeltaByKey.set(key, d);
            syncRows.push(...coarse.results);
        } else {
            log(`Fine tune: per-clip pass only (±${FINE_TUNE_MAX_SHIFT_SEC}s). Assumes tracks are already within ${FINE_TUNE_MAX_SHIFT_SEC}s — use Auto Sync for larger offsets.`);
        }

        // Phase 2 — fine residual via per-clip waveform correlation.
        setBusy("Fine tuning — per-clip pass…");
        const fineBase = runCoarse ? 35 : 10;
        const fineSpan = runCoarse ? 50 : 75;
        const fine = await analyzeFineTune(anchors, (done, total) => {
            setProgress(fineBase + Math.round((done / total) * fineSpan));
        });
        fine.notes.forEach(msg => log(msg));
        syncRows.push(...fine.results);

        // Merge coarse + fine deltas per clip so each clip moves exactly once.
        const totalByKey = new Map();
        for (const [key, d] of coarseDeltaByKey) {
            totalByKey.set(key, (totalByKey.get(key) || 0) + d);
        }
        for (const adj of fine.adjustments) {
            const key = `${adj.filePath}|${adj.startTicks}`;
            totalByKey.set(key, (totalByKey.get(key) || 0) + adj.deltaSec);
        }

        const anchorByKey = new Map(anchors.map(a => [a.key, a]));
        const adjustments = [];
        for (const [key, total] of totalByKey) {
            const rounded = Math.round(total * 1000) / 1000;
            if (Math.abs(rounded) < FINE_TUNE_MIN_APPLY_SEC) continue;
            const anchor = anchorByKey.get(key);
            if (!anchor) continue;
            adjustments.push({ filePath: anchor.filePath, startTicks: anchor.startTicks, deltaSec: rounded });
        }

        if (!adjustments.length) {
            setProgress(100);
            setTimeout(() => setProgress(0, false), 600);
            renderSyncSummary(syncRows);
            log("Fine tune: no shifts needed.", "success");
            return;
        }

        const payloadJSON = JSON.stringify(adjustments);

        await evalScript(`$.fineTunePayload = ${JSON.stringify(payloadJSON)};`);
        setProgress(90);

        const applyRaw = await evalScript("applyFineTuneAdjustments($.fineTunePayload)");
        const apply = JSON.parse(applyRaw);
        if (apply.error) throw new Error(apply.error);

        if (apply.errors && apply.errors.length) {
            apply.errors.forEach(msg => log(`⚠ ${msg}`, "warn"));
        }

        if (apply.compensateSec > 0) {
            log(`Fine tune: shifted entire sequence forward by ${formatSignedSeconds(apply.compensateSec)} to keep boundary clip at position 0.`, "info");
        }

        // Stash the exact inverse so one click can undo this fine tune: each
        // moved clip gets −delta (matched by its post-move start ticks), and the
        // whole sequence un-shifts the boundary compensation.
        if (apply.moved && apply.moved.length) {
            setRevertAvailable({
                globalShiftSec: -(apply.compensateSec || 0),
                adjustments: apply.moved.map(m => ({
                    filePath: m.filePath,
                    startTicks: m.newStartTicks,
                    deltaSec: -m.deltaSec
                }))
            });
        }

        renderSyncSummary(syncRows);
        setProgress(100);
        setTimeout(() => setProgress(0, false), 800);
        log(`Fine tune complete: adjusted ${adjustments.length} clips.`, "success");

    } catch (e) {
        if (e && e.cancelled) {
            log("Fine tune cancelled — no adjustments were applied.", "warn");
        } else {
            log(`✗ ${e.message}`, "error");
        }
        setProgress(0, false);
    } finally {
        btnSync.disabled = false;
        btnRefresh.disabled = false;
        btnFineTune.disabled = false;
        endOp();
    }
}

// ─── Auto Sync: Scan → Build → Fine Tune in one click ─────────────────────────
// Hands-off path. Run it on the ORIGINAL sequence (not an already-built -SYNC):
// it scans the active sequence, builds the -SYNC clone (which becomes active),
// then fine tunes that. Stops early with a clear message if a step can't proceed.
async function autoSync() {
    beginOp("Auto Sync…");
    btnAuto.disabled = true;
    log("Auto Sync: starting (scan → build → fine tune)…");

    try {
        // Refuse to run on an already-built -SYNC sequence: the pipeline would
        // clone it into X-SYNC-SYNC and re-shift already-aligned clips. (The
        // manual Build button still allows it, with a warning, for edge cases.)
        try {
            const info = JSON.parse(await evalScript("getActiveSequenceInfo()"));
            if (info.name && /-SYNC$/.test(info.name)) {
                log(`✗ Auto Sync: "${info.name}" is already a built sync sequence. Make the ORIGINAL sequence active (double-click it in the Project panel), then run Auto Sync again.`, "error");
                return;
            }
        } catch (e) {
            // No active sequence / read failure — let the scan report it properly.
        }

        const ready = await refreshSequence();
        if (!ready || cancelRequested) {
            log(cancelRequested
                ? "Auto Sync cancelled."
                : "Auto Sync stopped: the sequence is not ready to build (see above).", "warn");
            return;
        }

        const built = await buildSync();
        if (!built) {
            log("Auto Sync stopped: building the sync sequence failed (see above).", "warn");
            return;
        }
        if (cancelRequested) {
            log("Auto Sync cancelled — the -SYNC sequence was built but not fine tuned.", "warn");
            return;
        }

        await fineTuneAudio({ coarse: true });
        log(cancelRequested ? "Auto Sync cancelled." : "Auto Sync complete.", cancelRequested ? "warn" : "success");
    } catch (e) {
        if (e && e.cancelled) log("Auto Sync cancelled.", "warn");
        else log(`✗ Auto Sync: ${e.message}`, "error");
    } finally {
        btnAuto.disabled = false;
        endOp();
    }
}

// ─── Button click handlers ───────────────────────────────────────────────────
btnAuto.addEventListener("click", autoSync);
btnRefresh.addEventListener("click", refreshSequence);
btnSync.addEventListener("click", buildSync);
btnFineTune.addEventListener("click", () => fineTuneAudio({ coarse: false }));

// ─── Initialize ──────────────────────────────────────────────────────────────
loadJSX();

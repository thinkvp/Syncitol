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
    opDepth += 1;
    setBusy(text);
}

function endOp() {
    opDepth = Math.max(0, opDepth - 1);
    if (opDepth === 0) setBusy(null);
}

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
            `<span class="seq-name">${liveName}</span>` +
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
        const proc = childProcess.spawn(command, args, { windowsHide: true });
        const stdout = [];
        const stderr = [];

        proc.stdout.on("data", chunk => stdout.push(chunk));
        proc.stderr.on("data", chunk => stderr.push(chunk));
        proc.on("error", reject);
        proc.on("close", code => {
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
async function mapPool(items, limit, worker) {
    const results = new Array(items.length);
    let next = 0;
    async function run() {
        while (next < items.length) {
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

function ensureFfmpeg() {
    if (ensureFfmpeg.checked) return;
    if (!childProcess) {
        throw new Error("Node child_process is unavailable in this CEP runtime.");
    }

    const probe = childProcess.spawnSync("ffmpeg", ["-version"], { windowsHide: true });
    if (probe.error || probe.status !== 0) {
        throw new Error("ffmpeg was not found on PATH. Install ffmpeg to use Fine Tune Audio.");
    }
    ensureFfmpeg.checked = true;
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
const embeddedStartCache = new Map();
let ffprobeAvailable = null; // null = untested, false = confirmed absent

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

// Returns { ms, kind } for the embedded record-start time, or null when
// unavailable (ffprobe absent, no tag, or an unparseable value).
async function probeEmbeddedStart(filePath) {
    if (!childProcess || ffprobeAvailable === false) return null;
    if (embeddedStartCache.has(filePath)) return embeddedStartCache.get(filePath);

    let result = null;
    try {
        const out = await runCommandCapture("ffprobe", [
            "-v", "quiet",
            "-print_format", "json",
            "-show_entries", "format_tags=creation_time,modification_date:stream_tags=creation_time",
            "-i", filePath
        ]);
        ffprobeAvailable = true;
        const found = extractEmbeddedStart(JSON.parse(out.toString("utf8")));
        if (found) {
            const ms = Date.parse(found.raw);
            if (!Number.isNaN(ms)) result = { ms, kind: found.kind };
        }
    } catch (e) {
        // A spawn ENOENT means ffprobe is not installed — stop trying for this
        // session. Any other failure (unreadable file, etc.) just yields null.
        if (e && /ENOENT/.test(e.message)) ffprobeAvailable = false;
        result = null;
    }

    embeddedStartCache.set(filePath, result);
    return result;
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
// and we fall through to the other signals. Cached per file. Returns seconds from
// midnight, or null when ffprobe/the tag is unavailable.
const startTimecodeCache = new Map();

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
    if (!childProcess || ffprobeAvailable === false) return null;
    if (startTimecodeCache.has(filePath)) return startTimecodeCache.get(filePath);

    let result = null;
    try {
        const out = await runCommandCapture("ffprobe", [
            "-v", "quiet",
            "-print_format", "json",
            "-show_entries", "format_tags=timecode:stream_tags=timecode:stream=timecode,codec_type,r_frame_rate",
            "-i", filePath
        ]);
        ffprobeAvailable = true;
        const found = extractStartTimecode(JSON.parse(out.toString("utf8")));
        if (found) {
            const sec = parseTimecodeToSeconds(found.tc, found.fps);
            if (sec !== null) result = sec;
        }
    } catch (e) {
        if (e && /ENOENT/.test(e.message)) ffprobeAvailable = false;
        result = null;
    }

    startTimecodeCache.set(filePath, result);
    return result;
}

// buildEnvelope() lives in js/dsp.js.

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

    const task = runCommandCapture("ffmpeg", [
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
    ]).then(buffer => {
        if (!buffer.length) throw new Error(`No audio samples: ${path.basename(filePath)}`);
        const envelope = buildEnvelope(buffer, windowSamples);
        if (!envelope.length) throw new Error(`Audio slice too short: ${path.basename(filePath)}`);
        return envelope;
    });

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
//   3. head region — the first HEAD_SEC of each file, for two long recordings that
//      rolled near the same time when timestamps can't be trusted at all;
//   4. the full reference — last resort.
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
// and returns a per-anchor-key map of the coarse delta applied.
async function analyzeCoarseAlign(anchors, onProgress) {
    const deltaByKey = new Map();
    const notes = [];
    if (anchors.length < 2) return { deltaByKey, notes };

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

    notes.push(`Coarse align: matching one clip per track to the reference using the cheapest reliable predictor first — start timecode, then the Build position, then the head region — at ${COARSE_ENVELOPE_RATE}Hz, widening to the full file only if needed.`);

    const envOpts = { sampleRate: COARSE_SAMPLE_RATE, windowSamples: COARSE_WINDOW_SAMPLES };
    const groups = [...trackGroups.values()];

    // Per-track work is independent and dominated by ffmpeg, so run several tracks
    // at once. Reference windows shared across tracks (e.g. the head region) are
    // decoded once and reused via the envelope cache, even under concurrency.
    let done = 0;
    await mapPool(groups, SYNC_CONCURRENCY, async (group) => {
        const trackLabel = `${group[0].trackType} track ${group[0].trackIndex + 1}`;
        const targetLayer = group[0].layerOrder;

        // Reference = longest recording on any lower layer (the continuous
        // program/board recording in a typical multicam setup).
        const reference = longestAnchor(anchors.filter(a => a.layerOrder < targetLayer));
        // Representative target = longest clip on this track (most audio to match).
        const target = longestAnchor(group);

        // Buffer this track's log lines so concurrent tracks don't interleave;
        // flush them as one block when the track finishes.
        const lines = [];
        const buf = (msg, type) => lines.push([msg, type]);
        const finish = () => {
            done += 1;
            for (const [msg, type] of lines) log(msg, type);
            if (onProgress) onProgress(done, groups.length);
        };

        if (!reference || !target) {
            buf(`Coarse align: ${trackLabel} — no reference recording, leaving to fine pass.`);
            return finish();
        }

        const refDurationFull = Math.min(reference.resolvedEndSec - reference.resolvedStartSec, COARSE_REF_MAX_SEC);
        const tgtAvail = target.resolvedEndSec - target.resolvedStartSec;
        const probeShort = Math.min(tgtAvail, COARSE_TARGET_MAX_SEC);
        if (probeShort < COARSE_MIN_OVERLAP_SEC || refDurationFull < COARSE_MIN_OVERLAP_SEC) {
            buf(`Coarse align: ${trackLabel} — clips too short to match, leaving to fine pass.`);
            return finish();
        }

        // Start-timecode delta (no audio): when both files carry a usable TC, this
        // is the reference source offset that lines up with the target's in-point.
        let tcDelta = null;
        try {
            const [tcRef, tcTgt] = await Promise.all([
                probeStartTimecode(reference.filePath),
                probeStartTimecode(target.filePath)
            ]);
            if (tcRef !== null && tcTgt !== null) tcDelta = tcTgt - tcRef;
        } catch (e) { /* timecode is optional */ }

        // All of the window math and selection policy is pure and lives (tested) in
        // dsp.js. Here we just build the plans and drive the async ffmpeg matcher.
        const geom = {
            refInPointSec: reference.inPointSec,
            refDurationFull,
            refResolvedStartSec: reference.resolvedStartSec,
            targetInPointSec: target.inPointSec,
            targetResolvedStartSec: target.resolvedStartSec,
            targetAvailSec: tgtAvail,
            tcDelta
        };
        const cfg = {
            minOverlapSec: COARSE_MIN_OVERLAP_SEC,
            targetMaxSec: COARSE_TARGET_MAX_SEC,
            tcConfirmSec: COARSE_TC_CONFIRM_SEC,
            predictMarginSec: COARSE_PREDICT_MARGIN_SEC,
            headSec: COARSE_HEAD_SEC,
            minScore: COARSE_MIN_SCORE,
            strongScore: COARSE_STRONG_SCORE,
            confirmNearSec: COARSE_CONFIRM_NEAR_SEC
        };

        const plans = planCoarseSearch(geom, cfg);
        const state = createCoarseState();
        for (const plan of plans) {
            if (plan.label === "full" && state.skipFull) continue; // metadata confirmed — skip the costly full scan
            let candidate;
            try {
                const [refEnvelope, targetEnvelope] = await Promise.all([
                    getEnvelope(reference.filePath, plan.winStart, plan.winDur, envOpts),
                    getEnvelope(target.filePath, target.inPointSec, plan.probeDur, envOpts)
                ]);
                candidate = slideMatch(refEnvelope, targetEnvelope, {
                    envelopeRate: COARSE_ENVELOPE_RATE,
                    // Demand real overlap so a window's artificial mid-reference edge
                    // can't win with a few seconds of spurious correlation.
                    minOverlapSec: Math.min(plan.probeDur, COARSE_MATCH_OVERLAP_SEC)
                });
            } catch (e) {
                buf(`Coarse align: ${target.clipName} — ${e.message}; leaving to fine pass.`, "warn");
                return finish();
            }
            if (coarseConsider(state, plan, candidate, geom, cfg)) break;
        }

        const result = coarseResolve(state, geom, cfg);
        if (!result.chosen) {
            buf(`Coarse align: ${trackLabel} — no confident match for ${target.clipName} (best score ${result.best ? result.best.score.toFixed(2) : "n/a"}), leaving to fine pass.`, "warn");
            return finish();
        }

        const coarseDelta = result.coarseDelta;
        if (Math.abs(coarseDelta) < COARSE_MIN_APPLY_SEC) {
            buf(`Coarse align: ${trackLabel} already aligned (match score ${result.chosen.score.toFixed(2)}).`);
            return finish();
        }

        for (const anchor of group) {
            anchor.resolvedStartSec += coarseDelta;
            anchor.resolvedEndSec += coarseDelta;
            deltaByKey.set(anchor.key, (deltaByKey.get(anchor.key) || 0) + coarseDelta);
        }
        buf(`Coarse align: ${trackLabel} shifted ${formatSignedSeconds(coarseDelta)} to match ${target.clipName} against ${reference.clipName} via ${result.chosen.label} (score ${result.chosen.score.toFixed(2)}).`, "success");
        return finish();
    });

    return { deltaByKey, notes };
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

async function analyzeFineTune(anchors, onProgress) {
    const adjustments = [];
    const notes = [];

    if (!anchors.length) return { adjustments, notes };

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

    const results = await mapPool(targets, SYNC_CONCURRENCY, async ({ target, targetIndex }) => {
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

        if (!bestPair && railKept) {
            // Not a failure: the fine pass declined a spurious boundary match and
            // left the clip on its (strong) coarse alignment.
            lines.push([`↳ ${target.clipName}: kept coarse alignment — fine-tune match was unreliable (pinned to ±${FINE_TUNE_MAX_SHIFT_SEC}s limit)`, "info"]);
        } else if (!bestPair) {
            const detail = pairDiagnostics.length ? ` (${pairDiagnostics[0]})` : "";
            lines.push([`⚠ Skip ${target.clipName}: no usable overlap/match${detail}`, "warn"]);
        } else if (bestPair.score < FINE_TUNE_MIN_SCORE) {
            lines.push([`⚠ Skip ${target.clipName}: weak match score ${bestPair.score.toFixed(2)} vs ${bestPair.reference.clipName}`, "warn"]);
        } else {
            // Positive lag means target starts later than reference in extracted
            // windows, so move target earlier by that amount.
            const deltaSec = -(bestPair.lagSec);
            if (Math.abs(deltaSec) < FINE_TUNE_MIN_APPLY_SEC) {
                lines.push([`${target.clipName} already aligned (delta < 20 ms)`, "info"]);
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
            }
        }

        doneCount += 1;
        log(`Fine tune: [${doneCount}/${nonBaseTotal}] ${target.clipName} (${target.trackType.toUpperCase()} ${target.trackIndex + 1})`);
        for (const [msg, type] of lines) log(msg, type);
        if (onProgress) onProgress(doneCount, nonBaseTotal);

        return adjustment;
    });

    for (const adj of results) {
        if (adj) adjustments.push(adj);
    }

    return { adjustments, notes };
}

// ─── Refresh: read active sequence ───────────────────────────────────────────
async function refreshSequence() {
    beginOp("Scanning sequence…");
    clearLog();
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
            <span class="seq-name">${info.name}</span>
            <span class="seq-meta">${info.videoClips} video clip${info.videoClips !== 1 ? "s" : ""} · ${info.audioClips} audio clip${info.audioClips !== 1 ? "s" : ""}</span>
        `;
        scannedSeqName = info.name;   // mark this sequence as the scanned one
        lastLiveSeqName = info.name;  // keep the idle poll from re-flagging it
        log(`Sequence: "${info.name}" — ${info.videoClips} video, ${info.audioClips} audio clips`);
        setProgress(30);

        // 2. Get clip file paths
        const clipsRaw = await evalScript("getClipFileInfo()");
        const clips = JSON.parse(clipsRaw);
        if (clips.error) throw new Error(clips.error);
        if (!clips.length) throw new Error("No clips found in sequence.");

        log(`Found ${clips.length} unique source file(s). Reading file timestamps…`);
        setProgress(50);

        // 3. Read mtime for each file via Node.js
        if (!fs) throw new Error("Node.js not available. Ensure --enable-nodejs and --mixed-context are set in manifest.");

        const enriched = [];
        const sourceCounts = {};
        for (const clip of clips) {
            try {
                const r = await resolveRecordStart(clip);
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
            } catch (e) {
                log(`⚠ Could not read "${clip.filePath}": ${e.message}`, "warn");
            }
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
                <td class="cell-name" title="${clip.filePath}">${path.basename(clip.filePath)}</td>
                <td class="cell-type ${clip.trackType}">${clip.trackType === "video" ? "🎬" : "🎵"} ${clip.trackType}</td>
                <td class="cell-time" title="timing source: ${clip.timingSource}">${formatTime(clip.recordStartMs)} <span class="cell-src">${srcTag}</span></td>
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
        seqInfo.textContent = "Error reading sequence.";
        log(`✗ ${e.message}`, "error");
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
    btnSync.disabled = true;
    btnRefresh.disabled = true;
    btnFineTune.disabled = true;
    setProgress(20);
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
        ensureFfmpeg();

        const clipInfoRaw = await evalScript("getFineTuneClipInfo()");
        const clipInfo = JSON.parse(clipInfoRaw);
        if (clipInfo.error) throw new Error(clipInfo.error);

        const anchors = buildFineTuneAnchors(clipInfo);
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
        const coarseDeltaByKey = new Map();
        if (runCoarse) {
            setBusy("Fine tuning — coarse align…");
            log("Coarse align: scanning audio to find each track's offset — this can take a minute on long clips…");
            const coarse = await analyzeCoarseAlign(anchors, (done, total) => {
                setProgress(10 + Math.round((done / total) * 25));
            });
            coarse.notes.forEach(msg => log(msg));
            for (const [key, d] of coarse.deltaByKey) coarseDeltaByKey.set(key, d);
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

        setProgress(100);
        setTimeout(() => setProgress(0, false), 800);
        log(`Fine tune complete: adjusted ${adjustments.length} clips.`, "success");

    } catch (e) {
        log(`✗ ${e.message}`, "error");
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
        const ready = await refreshSequence();
        if (!ready) {
            log("Auto Sync stopped: the sequence is not ready to build (see above).", "warn");
            return;
        }

        const built = await buildSync();
        if (!built) {
            log("Auto Sync stopped: building the sync sequence failed (see above).", "warn");
            return;
        }

        await fineTuneAudio({ coarse: true });
        log("Auto Sync complete.", "success");
    } catch (e) {
        log(`✗ Auto Sync: ${e.message}`, "error");
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

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

// ─── State ───────────────────────────────────────────────────────────────────
let clipPayload = null; // enriched clip list after mtime lookup

// ─── DOM refs ────────────────────────────────────────────────────────────────
const btnAuto           = document.getElementById("btn-auto");
const btnRefresh        = document.getElementById("btn-refresh");
const btnSync           = document.getElementById("btn-sync");
const btnFineTune       = document.getElementById("btn-fine-tune");
const btnInstructions   = document.getElementById("btn-instructions");
const btnInstClose      = document.getElementById("btn-instructions-close");
const instructionsPanel = document.getElementById("instructions-panel");
const seqInfo      = document.getElementById("seq-info");
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

// ─── Timing source: embedded creation_time (preferred) vs. file mtime ─────────
// mtime is a weak proxy for record time — many cameras stamp it at record-start
// (not end) and any copy without date preservation rewrites it. When ffprobe is
// available we read the media's embedded creation_time, which is the actual
// recording start and survives copying. ffprobe is optional: if it is missing or
// the file carries no creation_time tag we fall back to mtime, so Build never
// hard-depends on it.
const creationTimeCache = new Map();
let ffprobeAvailable = null; // null = untested, false = confirmed absent

function extractCreationTime(probe) {
    if (probe && probe.format && probe.format.tags && probe.format.tags.creation_time) {
        return probe.format.tags.creation_time;
    }
    if (probe && Array.isArray(probe.streams)) {
        for (const stream of probe.streams) {
            if (stream.tags && stream.tags.creation_time) return stream.tags.creation_time;
        }
    }
    return null;
}

// Returns the embedded recording-start time in epoch ms, or null when
// unavailable (ffprobe absent, no tag, or an unparseable value).
async function probeCreationTimeMs(filePath) {
    if (!childProcess || ffprobeAvailable === false) return null;
    if (creationTimeCache.has(filePath)) return creationTimeCache.get(filePath);

    let result = null;
    try {
        const out = await runCommandCapture("ffprobe", [
            "-v", "quiet",
            "-print_format", "json",
            "-show_entries", "format_tags=creation_time:stream_tags=creation_time",
            "-i", filePath
        ]);
        ffprobeAvailable = true;
        const raw = extractCreationTime(JSON.parse(out.toString("utf8")));
        if (raw) {
            const ms = Date.parse(raw);
            if (!Number.isNaN(ms)) result = ms;
        }
    } catch (e) {
        // A spawn ENOENT means ffprobe is not installed — stop trying for this
        // session. Any other failure (unreadable file, etc.) just yields null.
        if (e && /ENOENT/.test(e.message)) ffprobeAvailable = false;
        result = null;
    }

    creationTimeCache.set(filePath, result);
    return result;
}

// Resolve a clip's record-start time once, here in the panel, so the JSX build
// can consume it directly instead of recomputing from mtime.
async function resolveRecordStart(clip) {
    const durationSec = clip.durationTicks / TICKS_PER_SECOND;

    const creationMs = await probeCreationTimeMs(clip.filePath);
    if (creationMs !== null) {
        // creation_time is the recording start itself — no duration subtraction.
        return { recordStartMs: creationMs, durationSec, timingSource: "creation_time", mtimeMs: null };
    }

    const stats = fs.statSync(clip.filePath);
    const mtimeMs = stats.mtimeMs;
    return { recordStartMs: mtimeMs - (durationSec * 1000), durationSec, timingSource: "mtime", mtimeMs };
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
// Device clocks can differ by minutes, so two tracks may sit far apart even after
// timestamp-based Build — far beyond the fine pass's ±5 s. This pass does what the
// old manual drag did: for each track it matches ONE clip (the longest, most
// distinctive one) against the full reference recording by sliding a low-rate
// envelope across it, finds the single large offset, and shifts the WHOLE track by
// it. The fine pass then polishes the residual. Low resolution keeps even a
// full-recording search fast.
const COARSE_SAMPLE_RATE = 2000;     // Hz of extracted PCM — low rate for speed
const COARSE_WINDOW_SAMPLES = 200;   // → 10 Hz envelope
const COARSE_ENVELOPE_RATE = COARSE_SAMPLE_RATE / COARSE_WINDOW_SAMPLES;
const COARSE_TARGET_MAX_SEC = 120;   // analyze up to this much of the matched clip
const COARSE_REF_MAX_SEC = 3 * 3600; // cap reference extraction (memory/time)
const COARSE_MIN_OVERLAP_SEC = 8;    // need at least this much target inside the ref
const COARSE_MIN_SCORE = 0.3;        // confidence required to shift a whole track
const COARSE_MIN_APPLY_SEC = 0.25;   // below this, leave it to the fine pass

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

    notes.push(`Coarse align: matching one clip per track against the longest lower-layer recording at ${COARSE_ENVELOPE_RATE}Hz — finds large whole-track offsets that the fine pass can't reach.`);

    const envOpts = { sampleRate: COARSE_SAMPLE_RATE, windowSamples: COARSE_WINDOW_SAMPLES };

    let done = 0;
    for (const [, group] of trackGroups) {
        done += 1;
        const trackLabel = `${group[0].trackType} track ${group[0].trackIndex + 1}`;
        const targetLayer = group[0].layerOrder;

        // Reference = longest recording on any lower layer (the continuous
        // program/board recording in a typical multicam setup).
        const reference = longestAnchor(anchors.filter(a => a.layerOrder < targetLayer));
        // Representative target = longest clip on this track (most audio to match).
        const target = longestAnchor(group);

        if (onProgress) onProgress(done, trackGroups.size);

        if (!reference || !target) {
            log(`Coarse align: ${trackLabel} — no reference recording, leaving to fine pass.`);
            continue;
        }

        const refDuration = Math.min(reference.resolvedEndSec - reference.resolvedStartSec, COARSE_REF_MAX_SEC);
        const tgtDuration = Math.min(target.resolvedEndSec - target.resolvedStartSec, COARSE_TARGET_MAX_SEC);
        if (tgtDuration < COARSE_MIN_OVERLAP_SEC || refDuration < COARSE_MIN_OVERLAP_SEC) {
            log(`Coarse align: ${trackLabel} — clips too short to match, leaving to fine pass.`);
            continue;
        }

        let lag;
        try {
            const [refEnvelope, targetEnvelope] = await Promise.all([
                getEnvelope(reference.filePath, reference.inPointSec, refDuration, envOpts),
                getEnvelope(target.filePath, target.inPointSec, tgtDuration, envOpts)
            ]);
            lag = slideMatch(refEnvelope, targetEnvelope, {
                envelopeRate: COARSE_ENVELOPE_RATE,
                minOverlapSec: COARSE_MIN_OVERLAP_SEC
            });
        } catch (e) {
            log(`Coarse align: ${target.clipName} — ${e.message}; leaving to fine pass.`, "warn");
            continue;
        }

        if (!lag || lag.score < COARSE_MIN_SCORE) {
            log(`Coarse align: ${trackLabel} — no confident match for ${target.clipName} (best score ${lag ? lag.score.toFixed(2) : "n/a"}), leaving to fine pass.`, "warn");
            continue;
        }

        // The target's first analyzed frame (its in-point) should sit on the
        // timeline at reference.resolvedStart + lagSec. Shift the whole track.
        const desiredTargetStart = reference.resolvedStartSec + lag.lagSec;
        const coarseDelta = Math.round((desiredTargetStart - target.resolvedStartSec) * 1000) / 1000;

        if (Math.abs(coarseDelta) < COARSE_MIN_APPLY_SEC) {
            log(`Coarse align: ${trackLabel} already aligned (match score ${lag.score.toFixed(2)}).`);
            continue;
        }

        for (const anchor of group) {
            anchor.resolvedStartSec += coarseDelta;
            anchor.resolvedEndSec += coarseDelta;
            deltaByKey.set(anchor.key, (deltaByKey.get(anchor.key) || 0) + coarseDelta);
        }
        log(`Coarse align: ${trackLabel} shifted ${formatSignedSeconds(coarseDelta)} to match ${target.clipName} against ${reference.clipName} (score ${lag.score.toFixed(2)}).`, "success");
    }

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
        return {
            reference,
            target,
            usable: false,
            reason: lastError || "no lag candidate from attempted windows",
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
    const nonBaseTotal = anchors.filter(a => a.layerOrder !== baseLayer).length;
    let doneCount = 0;

    notes.push(`Fine tune compare window: up to ${FINE_TUNE_MAX_COMPARE_SEC}s per pair, max shift ±${FINE_TUNE_MAX_SHIFT_SEC}s, retries on alternate windows when overlap > ${FINE_TUNE_MAX_COMPARE_SEC}s and first-window score is below ${FINE_TUNE_DECENT_SCORE.toFixed(2)}.`);

    for (let targetIndex = 0; targetIndex < anchors.length; targetIndex += 1) {
        const target = anchors[targetIndex];
        if (target.layerOrder === baseLayer) {
            log(`Fine tune: base layer — ${target.clipName}`);
            continue;
        }

        doneCount += 1;
        log(`Fine tune: [${doneCount}/${nonBaseTotal}] comparing ${target.clipName} (${target.trackType.toUpperCase()} ${target.trackIndex + 1})…`);

        let bestPair = null;
        const pairDiagnostics = [];
        for (let refIndex = 0; refIndex < targetIndex; refIndex += 1) {
            const reference = anchors[refIndex];
            if (reference.layerOrder >= target.layerOrder) continue;

            const result = await comparePair(reference, target);
            if (!result || !result.usable) {
                if (result && result.reason) {
                    pairDiagnostics.push(`${describeAnchor(reference)}: ${result.reason}`);
                }
                continue;
            }

            if (!bestPair || result.score > bestPair.score) {
                bestPair = result;
            }
        }

        if (onProgress) onProgress(doneCount, nonBaseTotal);

        if (!bestPair) {
            const detail = pairDiagnostics.length ? ` (${pairDiagnostics[0]})` : "";
            log(`⚠ Skip ${target.clipName}: no usable overlap/match${detail}`, "warn");
            continue;
        }

        if (bestPair.score < FINE_TUNE_MIN_SCORE) {
            log(`⚠ Skip ${target.clipName}: weak match score ${bestPair.score.toFixed(2)} vs ${bestPair.reference.clipName}`, "warn");
            continue;
        }

        // Positive lag means target starts later than reference in extracted windows,
        // so move target earlier by that amount.
        const deltaSec = -(bestPair.lagSec);
        if (Math.abs(deltaSec) < FINE_TUNE_MIN_APPLY_SEC) {
            log(`${target.clipName} already aligned (delta < 20 ms)`);
            continue;
        }

        const roundedDelta = Math.round(deltaSec * 1000) / 1000;
        adjustments.push({
            clipName: target.clipName,
            filePath: target.filePath,
            startTicks: target.startTicks,
            deltaSec: roundedDelta,
            referenceName: bestPair.reference.clipName,
            score: bestPair.score
        });

        target.resolvedStartSec += roundedDelta;
        target.resolvedEndSec += roundedDelta;
        log(`✓ ${target.clipName}: shift ${formatSignedSeconds(roundedDelta)} vs ${bestPair.reference.clipName} (score ${bestPair.score.toFixed(2)}, ${bestPair.attempts.length} window${bestPair.attempts.length !== 1 ? "s" : ""})`, "success");
    }

    return { adjustments, notes };
}

// ─── Refresh: read active sequence ───────────────────────────────────────────
async function refreshSequence() {
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
                const srcLabel = r.timingSource === "creation_time" ? "embedded metadata" : "file mtime";
                log(`✓ ${path.basename(clip.filePath)} — start ${formatTime(r.recordStartMs)} via ${srcLabel}, duration ${formatDuration(r.durationSec * 1000)}`);
            } catch (e) {
                log(`⚠ Could not read "${clip.filePath}": ${e.message}`, "warn");
            }
        }

        if (!enriched.length) throw new Error("Could not read timestamps for any clips.");

        // Mixed timing sources have different semantics (embedded record-start vs.
        // mtime-derived), so clips from different sources may not agree on the
        // absolute clock. Warn; Fine Tune Audio can correct the residual drift.
        const usedSources = Object.keys(sourceCounts);
        if (usedSources.length > 1) {
            const breakdown = usedSources.map(s => `${s}: ${sourceCounts[s]}`).join(", ");
            log(`⚠ Mixed timing sources (${breakdown}). Alignment across these clips may be off; use Fine Tune Audio to correct residual drift.`, "warn");
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
            const srcTag = clip.timingSource === "creation_time" ? "meta" : "mtime";
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
    }
}

// ─── Build sync sequence ──────────────────────────────────────────────────────
async function buildSync() {
    if (!clipPayload) return false;

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
    }
}

// ─── Fine tune by waveform comparison ────────────────────────────────────────
async function fineTuneAudio() {
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

        // Phase 1 — coarse auto-align: shift whole tracks into the fine pass's
        // ±5 s range (removes the old manual drag step). It mutates the anchors'
        // resolved positions so Phase 2 sees the pre-aligned layout.
        const coarse = await analyzeCoarseAlign(anchors, (done, total) => {
            setProgress(10 + Math.round((done / total) * 25));
        });
        coarse.notes.forEach(msg => log(msg));

        // Phase 2 — fine residual via per-clip waveform correlation.
        const fine = await analyzeFineTune(anchors, (done, total) => {
            setProgress(35 + Math.round((done / total) * 50));
        });
        fine.notes.forEach(msg => log(msg));

        // Merge coarse + fine deltas per clip so each clip moves exactly once.
        const totalByKey = new Map();
        for (const [key, d] of coarse.deltaByKey) {
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
            log(`Fine tune: shifted entire sequence forward by +${formatSignedSeconds(apply.compensateSec)} to keep boundary clip at position 0.`, "info");
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
    }
}

// ─── Auto Sync: Scan → Build → Fine Tune in one click ─────────────────────────
// Hands-off path. Run it on the ORIGINAL sequence (not an already-built -SYNC):
// it scans the active sequence, builds the -SYNC clone (which becomes active),
// then fine tunes that. Stops early with a clear message if a step can't proceed.
async function autoSync() {
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

        await fineTuneAudio();
        log("Auto Sync complete.", "success");
    } catch (e) {
        log(`✗ Auto Sync: ${e.message}`, "error");
    } finally {
        btnAuto.disabled = false;
    }
}

// ─── Button click handlers ───────────────────────────────────────────────────
btnAuto.addEventListener("click", autoSync);
btnRefresh.addEventListener("click", refreshSequence);
btnSync.addEventListener("click", buildSync);
btnFineTune.addEventListener("click", fineTuneAudio);

// ─── Initialize ──────────────────────────────────────────────────────────────
loadJSX();

/**
 * DateModSync — main.js
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

const AUDIO_SAMPLE_RATE = 8000;
const ENVELOPE_WINDOW_SAMPLES = 80;
const ENVELOPE_RATE = AUDIO_SAMPLE_RATE / ENVELOPE_WINDOW_SAMPLES;
const FINE_TUNE_MAX_SHIFT_SEC = 5;
const FINE_TUNE_MIN_OVERLAP_SEC = 3;
const FINE_TUNE_MAX_COMPARE_SEC = 20;
const FINE_TUNE_MIN_SCORE = 0.2;
const FINE_TUNE_MIN_APPLY_SEC = 0.02;
const FINE_TUNE_WINDOW_POSITIONS = [0.5, 0.2, 0.8];
const FINE_TUNE_DECENT_SCORE = 0.7;
const envelopeCache = new Map();

// ─── State ───────────────────────────────────────────────────────────────────
let clipPayload = null; // enriched clip list after mtime lookup

// ─── DOM refs ────────────────────────────────────────────────────────────────
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
function evalScript(script) {
    return new Promise((resolve, reject) => {
        csInterface.evalScript(script, (result) => {
            if (result === "EvalScript error.") {
                reject(new Error("ExtendScript evaluation error"));
            } else {
                resolve(result);
            }
        });
    });
}

// ─── Load ExtendScript file ───────────────────────────────────────────────────
function loadJSX() {
    const extDir = csInterface.getSystemPath(SystemPath.EXTENSION);
    const jsxPath = extDir + "/jsx/sync.jsx";
    csInterface.evalScript(`$.evalFile("${jsxPath.replace(/\\/g, "/")}")`);
}

// ─── Format helpers ───────────────────────────────────────────────────────────
function formatDuration(ms) {
    const totalSec = Math.round(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

function formatTime(ms) {
    const d = new Date(ms);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatDate(ms) {
    const d = new Date(ms);
    return d.toLocaleDateString([], { month: "short", day: "numeric" }) +
           " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatSignedSeconds(seconds) {
    const rounded = Math.round(seconds * 1000) / 1000;
    return `${rounded >= 0 ? "+" : ""}${rounded}s`;
}

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

function buildEnvelope(buffer) {
    const sampleCount = Math.floor(buffer.length / 2);
    const frameCount = Math.floor(sampleCount / ENVELOPE_WINDOW_SAMPLES);
    const envelope = new Float32Array(frameCount);

    for (let frame = 0; frame < frameCount; frame += 1) {
        let sum = 0;
        const frameByteOffset = frame * ENVELOPE_WINDOW_SAMPLES * 2;
        for (let s = 0; s < ENVELOPE_WINDOW_SAMPLES; s += 1) {
            const byteOffset = frameByteOffset + (s * 2);
            sum += Math.abs(buffer.readInt16LE(byteOffset));
        }
        envelope[frame] = sum / ENVELOPE_WINDOW_SAMPLES;
    }

    return envelope;
}

function getEnvelope(filePath, sourceOffsetSec, durationSec) {
    const cacheKey = `${filePath}|${sourceOffsetSec.toFixed(3)}|${durationSec.toFixed(3)}`;
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
        "-ar", String(AUDIO_SAMPLE_RATE),
        "-f", "s16le",
        "pipe:1"
    ]).then(buffer => {
        if (!buffer.length) throw new Error(`No audio samples: ${path.basename(filePath)}`);
        const envelope = buildEnvelope(buffer);
        if (!envelope.length) throw new Error(`Audio slice too short: ${path.basename(filePath)}`);
        return envelope;
    });

    envelopeCache.set(cacheKey, task);
    return task;
}

function findBestLag(refEnvelope, targetEnvelope) {
    const maxLagFrames = Math.round(FINE_TUNE_MAX_SHIFT_SEC * ENVELOPE_RATE);
    const minOverlapFrames = Math.round(FINE_TUNE_MIN_OVERLAP_SEC * ENVELOPE_RATE);
    let best = null;

    for (let lag = -maxLagFrames; lag <= maxLagFrames; lag += 1) {
        const refStart = lag < 0 ? -lag : 0;
        const targetStart = lag > 0 ? lag : 0;
        const overlap = Math.min(refEnvelope.length - refStart, targetEnvelope.length - targetStart);
        if (overlap < minOverlapFrames) continue;

        let refSum = 0;
        let targetSum = 0;
        for (let i = 0; i < overlap; i += 1) {
            refSum += refEnvelope[refStart + i];
            targetSum += targetEnvelope[targetStart + i];
        }

        const refMean = refSum / overlap;
        const targetMean = targetSum / overlap;
        let dot = 0;
        let refEnergy = 0;
        let targetEnergy = 0;

        for (let i = 0; i < overlap; i += 1) {
            const rv = refEnvelope[refStart + i] - refMean;
            const tv = targetEnvelope[targetStart + i] - targetMean;
            dot += rv * tv;
            refEnergy += rv * rv;
            targetEnergy += tv * tv;
        }

        if (!refEnergy || !targetEnergy) continue;
        const score = dot / Math.sqrt(refEnergy * targetEnergy);
        if (!best || score > best.score) {
            best = {
                score,
                lagSec: lag / ENVELOPE_RATE,
                overlapSec: overlap / ENVELOPE_RATE
            };
        }
    }

    return best;
}

function buildFineTuneAnchors(clips) {
    const byKey = new Map();

    for (const clip of clips) {
        if (!clip.filePath || !clip.startTicks) continue;
        const key = `${clip.filePath}|${clip.startTicks}`;

        if (!byKey.has(key)) {
            byKey.set(key, {
                key,
                filePath: clip.filePath,
                startTicks: clip.startTicks,
                clipName: clip.clipName,
                trackType: clip.trackType,
                trackIndex: clip.trackIndex,
                layerOrder: clip.trackType === "video" ? clip.trackIndex : 1000 + clip.trackIndex,
                startSec: clip.startSec,
                endSec: clip.endSec,
                inPointSec: clip.inPointSec,
                resolvedStartSec: clip.startSec,
                resolvedEndSec: clip.endSec
            });
            continue;
        }

        const existing = byKey.get(key);
        if (clip.trackType === "video" && existing.trackType !== "video") {
            existing.clipName = clip.clipName;
            existing.trackType = clip.trackType;
            existing.trackIndex = clip.trackIndex;
            existing.layerOrder = clip.trackIndex;
            existing.startSec = clip.startSec;
            existing.endSec = clip.endSec;
            existing.inPointSec = clip.inPointSec;
            existing.resolvedStartSec = clip.startSec;
            existing.resolvedEndSec = clip.endSec;
        }
    }

    return Array.from(byKey.values()).sort((a, b) => {
        if (a.layerOrder !== b.layerOrder) return a.layerOrder - b.layerOrder;
        if (a.startSec !== b.startSec) return a.startSec - b.startSec;
        return a.clipName.localeCompare(b.clipName);
    });
}

function describeAnchor(anchor) {
    return `${anchor.clipName} [${anchor.trackType.toUpperCase()} ${anchor.trackIndex + 1}, t=${anchor.startSec.toFixed(2)}s, startTicks=${anchor.startTicks}]`;
}

function formatRange(startSec, durationSec) {
    const endSec = startSec + durationSec;
    return `${startSec.toFixed(2)}s-${endSec.toFixed(2)}s (${durationSec.toFixed(2)}s)`;
}

function buildCompareWindow(reference, target) {
    const compareStart = Math.max(reference.resolvedStartSec, target.resolvedStartSec);
    const compareEnd = Math.min(reference.resolvedEndSec, target.resolvedEndSec);
    const overlap = compareEnd - compareStart;
    if (overlap < FINE_TUNE_MIN_OVERLAP_SEC) return null;

    const compareDuration = Math.min(overlap, FINE_TUNE_MAX_COMPARE_SEC);
    const slack = overlap - compareDuration;
    const windows = [];
    const seenStarts = new Set();

    for (const position of FINE_TUNE_WINDOW_POSITIONS) {
        const start = compareStart + (slack * position);
        const roundedStart = Number(start.toFixed(3));
        if (seenStarts.has(roundedStart)) continue;
        seenStarts.add(roundedStart);

        windows.push({
            compareStartSec: start,
            compareDurationSec: compareDuration,
            compareEndSec: start + compareDuration,
            refSourceOffsetSec: reference.inPointSec + (start - reference.resolvedStartSec),
            targetSourceOffsetSec: target.inPointSec + (start - target.resolvedStartSec)
        });
    }

    return {
        overlapSec: overlap,
        compareDurationSec: compareDuration,
        windows
    };
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
        for (const clip of clips) {
            try {
                const stats = fs.statSync(clip.filePath);
                const mtimeMs = stats.mtimeMs;
                const durationSec = clip.durationTicks / 254016000000;
                const recordStartMs = mtimeMs - (durationSec * 1000);
                enriched.push({ ...clip, mtimeMs, recordStartMs, durationSec });
                log(`✓ ${path.basename(clip.filePath)} — modified ${formatDate(mtimeMs)}, duration ${formatDuration(durationSec * 1000)}, est. start ${formatTime(recordStartMs)}`);
            } catch (e) {
                log(`⚠ Could not read "${clip.filePath}": ${e.message}`, "warn");
            }
        }

        if (!enriched.length) throw new Error("Could not read timestamps for any clips.");

        // Per-track earliest (each track independently starts at t=0)
        const perTrackEarliest = new Map();
        for (const clip of enriched) {
            const key = `${clip.trackType}_${clip.trackIndex}`;
            const cur = perTrackEarliest.get(key);
            if (cur === undefined || clip.recordStartMs < cur) {
                perTrackEarliest.set(key, clip.recordStartMs);
            }
        }

        setProgress(80);

        // 4. Populate clip table (offset shown relative to that clip's own track)
        clipBody.innerHTML = "";
        enriched.forEach(clip => {
            const trackKey = `${clip.trackType}_${clip.trackIndex}`;
            const offsetMs = clip.recordStartMs - perTrackEarliest.get(trackKey);
            const tr = document.createElement("tr");
            tr.innerHTML = `
                <td class="cell-name" title="${clip.filePath}">${path.basename(clip.filePath)}</td>
                <td class="cell-type ${clip.trackType}">${clip.trackType === "video" ? "🎬" : "🎵"} ${clip.trackType}</td>
                <td class="cell-time">${formatTime(clip.recordStartMs)}</td>
                <td class="cell-offset">${formatDuration(offsetMs)}</td>
            `;
            clipBody.appendChild(tr);
        });
        clipTable.style.display = "table";

        // 5. 24-hour span guard
        let hasSpanViolation = false;
        for (const [key, anchorMs] of perTrackEarliest) {
            const trackClips = enriched.filter(c => `${c.trackType}_${c.trackIndex}` === key);
            const maxEndMs = Math.max(...trackClips.map(c => c.recordStartMs + c.durationSec * 1000));
            const spanSec = (maxEndMs - anchorMs) / 1000;
            if (spanSec > 86400) {
                const label = key.replace("_", " track ");
                log(`\u26a0 ${label} spans ${(spanSec / 3600).toFixed(1)}h \u2014 exceeds Premiere\u2019s 24-hour maximum.`, "warn");
                hasSpanViolation = true;
            }
        }

        clipPayload = enriched;
        btnFineTune.disabled = false;
        setProgress(100);
        setTimeout(() => setProgress(0, false), 600);

        if (hasSpanViolation) {
            log("Build Sync Sequence is disabled \u2014 each track must fit within 24 hours. Process one recording day at a time.", "error");
        } else {
            btnSync.disabled = false;
            log(`Ready. Click \"Build Sync Sequence\" to create ${info.name}-SYNC.`, "success");
        }

    } catch (e) {
        seqInfo.textContent = "Error reading sequence.";
        log(`✗ ${e.message}`, "error");
        setProgress(0, false);
    }
}

// ─── Build sync sequence ──────────────────────────────────────────────────────
async function buildSync() {
    if (!clipPayload) return;

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

    } catch (e) {
        log(`✗ ${e.message}`, "error");
        setProgress(0, false);
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

    try {
        ensureFfmpeg();

        const clipInfoRaw = await evalScript("getFineTuneClipInfo()");
        const clipInfo = JSON.parse(clipInfoRaw);
        if (clipInfo.error) throw new Error(clipInfo.error);

        const anchors = buildFineTuneAnchors(clipInfo);
        if (anchors.length < 2) {
            throw new Error("Need at least two clips with accessible audio for fine tune.");
        }

        log(`Fine tune: evaluating ${anchors.length} clips layer-by-layer.`);
        setProgress(10);

        const analysis = await analyzeFineTune(anchors, (done, total) => {
            setProgress(10 + Math.round((done / total) * 75));
        });
        analysis.notes.forEach(msg => log(msg));

        if (!analysis.adjustments.length) {
            setProgress(100);
            setTimeout(() => setProgress(0, false), 600);
            log("Fine tune: no shifts needed.", "success");
            return;
        }

        const payloadJSON = JSON.stringify(analysis.adjustments.map(adj => ({
            filePath: adj.filePath,
            startTicks: adj.startTicks,
            deltaSec: adj.deltaSec
        })));

        await evalScript(`$.fineTunePayload = ${JSON.stringify(payloadJSON)};`);
        setProgress(90);

        const applyRaw = await evalScript("applyFineTuneAdjustments($.fineTunePayload)");
        const apply = JSON.parse(applyRaw);
        if (apply.error) throw new Error(apply.error);

        if (apply.errors && apply.errors.length) {
            apply.errors.forEach(msg => log(`⚠ ${msg}`, "warn"));
        }

        setProgress(100);
        setTimeout(() => setProgress(0, false), 800);
        log(`Fine tune complete: adjusted ${analysis.adjustments.length} clips.`, "success");

    } catch (e) {
        log(`✗ ${e.message}`, "error");
        setProgress(0, false);
    } finally {
        btnSync.disabled = false;
        btnRefresh.disabled = false;
        btnFineTune.disabled = false;
    }
}

// ─── Button click handlers ───────────────────────────────────────────────────
btnRefresh.addEventListener("click", refreshSequence);
btnSync.addEventListener("click", buildSync);
btnFineTune.addEventListener("click", fineTuneAudio);

// ─── Initialize ──────────────────────────────────────────────────────────────
loadJSX();

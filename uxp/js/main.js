/**
 * Syncitol — main.js
 * Panel logic: orchestration + analysis engine + UI, layered over:
 *   - premiere.js — host edits via the UXP DOM (transactional actions)
 *   - audio.js    — audio decode + metadata via the bundled native addon
 *   - pek.js      — Premiere peak-file (.pek) fast path via UXP fs
 * The pure DSP/policy (window math, coarse selection, pek parsing) lives in
 * dsp.js, where it is unit-tested.
 */

// NOTE: main.js is loaded via <script src="js/main.js">, so UXP resolves its
// require() base at the plugin ROOT (not js/).
const dsp = require("./js/dsp");
const audio = require("./js/audio");
const premiere = require("./js/premiere");
const pek = require("./js/pek");

// How many clips' decode passes to run concurrently. The addon decode itself is
// synchronous on the scripting thread, so this mostly overlaps cache/disk reads
// and keeps the pool structure ready for a future async addon.
const SYNC_CONCURRENCY = 4;

// ─── Coarse auto-align tuning ─────────────────────────────────────────────────
const COARSE_SAMPLE_RATE = 2000;       // Hz of extracted PCM — low rate for speed
const COARSE_WINDOW_SAMPLES = 200;     // → 10 Hz envelope
const COARSE_ENVELOPE_RATE = COARSE_SAMPLE_RATE / COARSE_WINDOW_SAMPLES;
const COARSE_TARGET_MAX_SEC = 120;     // analyze up to this much of the matched clip
const COARSE_REF_MAX_SEC = 3 * 3600;   // cap full-reference extraction (memory/time)
const COARSE_MIN_OVERLAP_SEC = 8;      // need at least this much target inside the ref
const COARSE_MIN_SCORE = 0.3;          // confidence required to shift a whole track
const COARSE_STRONG_SCORE = 0.5;       // strong enough to override the metadata / stop early
const COARSE_CONFIRM_NEAR_SEC = 90;    // predictor match this close to its claim confirms it
const COARSE_MIN_APPLY_SEC = 0.25;     // below this, leave it to the fine pass
const COARSE_TC_CONFIRM_SEC = 30;      // half-width of the audio confirm around a TC prediction
const COARSE_PREDICT_MARGIN_SEC = 300; // ± window searched around the timestamp prediction
const COARSE_HEAD_SEC = 12 * 60;       // head-region length when no predictor is trustworthy
const COARSE_MATCH_OVERLAP_SEC = 60;   // required overlap so window edges can't fake a match
const COARSE_LEARNED_MARGIN_SEC = 120; // ± confirm window around an offset learned from another track

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

// ─── State ────────────────────────────────────────────────────────────────────
let clipPayload = null;        // enriched per-file list after record-start lookup
let opDepth = 0;               // >0 while an operation runs
let scannedSeqName = null;     // name of the sequence the panel last scanned
let lastLiveSeqName;           // last active-sequence name the idle poll reflected
let cancelRequested = false;   // set by the Cancel button; checked at every async seam
let lastFineTuneRevert = null; // inverse shift list that undoes the last applied fine tune

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const btnAuto = $("btn-auto");
const btnRefresh = $("btn-refresh");
const btnSync = $("btn-sync");
const btnFineTune = $("btn-fine-tune");
const btnInstructions = $("btn-instructions");
const btnInstClose = $("btn-instructions-close");
const instructionsPanel = $("instructions-panel");
const seqInfo = $("seq-info");
const busyRow = $("busy-row");
const busyText = $("busy-text");
const logContainer = $("log");
const clipTable = $("clip-table");
const clipBody = $("clip-body");
const progressWrap = $("progress-wrap");
const progressBar = $("progress-bar");
const btnCancel = $("btn-cancel");
const btnRevert = $("btn-revert");
const resultsSection = $("results-section");
const resultsBody = $("results-body");
const toolStatusEl = $("tool-status");

// Actions are styled <div class="btn"> elements (UXP's native <button> widget
// ignores author backgrounds), so disabled state is a class, not a property.
function setDisabled(el, d) { el.classList.toggle("is-disabled", !!d); }
function isDisabled(el) { return el.classList.contains("is-disabled"); }

const escapeHtml = dsp.escapeHtml;
const formatDuration = dsp.formatDuration;
const formatTime = dsp.formatTime;
const formatSignedSeconds = dsp.formatSignedSeconds;

// ─── Instructions toggle ──────────────────────────────────────────────────────
btnInstructions.addEventListener("click", () => instructionsPanel.classList.add("visible"));
btnInstClose.addEventListener("click", () => instructionsPanel.classList.remove("visible"));

const footerTips = $("footer-tips");
if (footerTips) {
    footerTips.addEventListener("click", (e) => {
        e.preventDefault();
        require("uxp").shell.openExternal(footerTips.href);
    });
}

// ─── Tips card (shown once per install after a successful Auto Sync) ─────────
const TIPS_DISMISSED_KEY = "syncitol-tips-dismissed";
const tipsCard = $("tips-card");
const tipsCardClose = $("tips-card-close");
const tipsCardLink = $("tips-card-link");

function tipsDismissed() {
    try { return localStorage.getItem(TIPS_DISMISSED_KEY) === "1"; }
    catch (_) { return false; }
}
function dismissTipsCard() {
    try { localStorage.setItem(TIPS_DISMISSED_KEY, "1"); } catch (_) {}
    if (tipsCard) tipsCard.style.display = "none";
}
function maybeShowTipsCard() {
    if (tipsCard && !tipsDismissed()) tipsCard.style.display = "flex";
}
if (tipsCardClose) tipsCardClose.addEventListener("click", dismissTipsCard);
if (tipsCardLink) {
    tipsCardLink.addEventListener("click", (e) => {
        e.preventDefault();
        require("uxp").shell.openExternal(tipsCardLink.href);
    });
}

// ─── Logging ──────────────────────────────────────────────────────────────────
function log(msg, type = "info") {
    const entry = document.createElement("div");
    entry.className = "log-entry log-" + type;
    entry.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    logContainer.appendChild(entry);
    logContainer.scrollTop = logContainer.scrollHeight;
}
function clearLog() { logContainer.innerHTML = ""; }

// Host-layer diagnostics go to the developer console; flip this on to mirror
// them into the panel log when debugging in the field.
const HOST_DEBUG = false;
premiere.scanSequence.onDiag = (m) => { if (HOST_DEBUG) log("scan: " + m); };
premiere.buildSyncSequence.onStep = (m) => { if (HOST_DEBUG) log("build: " + m); };
premiere.applyStarts.onStep = (m) => { if (HOST_DEBUG) log("apply: " + m); };
pek.onDiag = (m) => log(m);

// ─── Progress / busy ──────────────────────────────────────────────────────────
function setProgress(pct, visible = true) {
    progressWrap.style.display = visible ? "block" : "none";
    progressBar.style.width = pct + "%";
}
function setBusy(text) {
    if (text) {
        busyText.textContent = text;
        busyRow.style.display = "flex";
    } else {
        busyRow.style.display = "none";
    }
}
function beginOp(text) {
    if (opDepth === 0) {
        cancelRequested = false; // a fresh top-level operation resets Cancel
        setDisabled(btnCancel, false);
    }
    opDepth += 1;
    setBusy(text);
}
function endOp() {
    opDepth = Math.max(0, opDepth - 1);
    if (opDepth === 0) setBusy(null);
}

// ─── Cancellation ─────────────────────────────────────────────────────────────
// The long phases are the per-clip addon decodes plus the pools that feed them.
// The decode itself is synchronous, so cancel takes effect between decodes: the
// flag raises a marked error at every async seam (pool loop, envelope fetch)
// and the operation unwinds cleanly. Host edits are transactional and quick;
// the flag is checked between pipeline steps instead.
function cancellationError() {
    const e = new Error("Cancelled by user.");
    e.cancelled = true;
    return e;
}
function throwIfCancelled() {
    if (cancelRequested) throw cancellationError();
}
audio.setCancelCheck(throwIfCancelled);

function requestCancel() {
    if (opDepth === 0 || cancelRequested) return;
    cancelRequested = true;
    setDisabled(btnCancel, true);
    log("Cancelling — stopping after the current decode…", "warn");
}
btnCancel.addEventListener("click", requestCancel);

// ─── Worker pool ──────────────────────────────────────────────────────────────
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

// ─── Active-sequence freshness ────────────────────────────────────────────────
// The active sequence can change under the panel (the user switches sequences,
// or Build opens the -SYNC). Poll lightly while idle so the header always
// reflects the real active sequence and flags when the scanned data is stale.
async function pollActiveSequence() {
    if (opDepth > 0) return;                  // never poll mid-operation
    const liveName = await premiere.getActiveSequenceName();
    if (liveName === lastLiveSeqName) return; // nothing changed since the last tick
    lastLiveSeqName = liveName;

    if (!liveName) {
        seqInfo.textContent = "Open a sequence, then click \"Auto Sync\" or follow the manual steps.";
    } else if (liveName !== scannedSeqName) {
        seqInfo.innerHTML =
            `<span class="seq-name">${escapeHtml(liveName)}</span>` +
            `<span class="seq-meta seq-stale">active — click "Auto Sync", or follow the manual steps</span>`;
    }
    // When liveName === scannedSeqName, leave the rich scanned info in place.
}
setInterval(pollActiveSequence, 3000);

// ─── Decoder availability (footer chip) ───────────────────────────────────────
function updateToolStatus(ok, detail) {
    if (ok === null) {
        toolStatusEl.innerHTML = `<span class="tool-chip">decoder …</span>`;
    } else if (ok) {
        toolStatusEl.innerHTML = `<span class="tool-chip tool-ok" title="Bundled FFmpeg decoder loaded">decoder ✓</span>`;
    } else {
        toolStatusEl.innerHTML = `<span class="tool-chip tool-missing" title="${escapeHtml(detail || "The bundled audio decoder failed to load.")}">decoder ✗</span>`;
    }
}
updateToolStatus(null);
audio.ensureAddon().then(
    () => updateToolStatus(true),
    (e) => {
        updateToolStatus(false, e.message);
        log(`✗ ${e.message}`, "error");
    }
);

// ─── Timing sources ───────────────────────────────────────────────────────────
function isEmbeddedSource(timingSource) {
    return timingSource === "creation_time" || timingSource === "modification_date";
}

// Resolve a file's record-start once: embedded metadata via the bundled probe,
// else file mtime minus duration (record END → START).
async function resolveRecordStart(file) {
    let probe = null;
    try {
        probe = await audio.probeRecordStart(file.filePath);
    } catch (e) {
        if (e && e.cancelled) throw e; // metadata probe is otherwise optional
    }
    const durationSec = (probe && probe.durationSec) || file.durationSec || 0;
    if (probe && probe.recordStartMs !== null) {
        return { recordStartMs: probe.recordStartMs, durationSec, timingSource: probe.timingSource, mtimeMs: null };
    }
    const mtimeMs = await premiere.statMtimeMs(file.filePath);
    if (mtimeMs === null) throw new Error("no embedded record time and the file's date is unreadable");
    return { recordStartMs: mtimeMs - (durationSec * 1000), durationSec, timingSource: "mtime", mtimeMs };
}

async function probeStartTimecode(filePath) {
    try {
        return (await audio.probeRecordStart(filePath)).timecodeSec;
    } catch (e) {
        if (e && e.cancelled) throw e;
        return null;
    }
}

// ─── Coarse auto-align (whole-track, large offsets) ───────────────────────────
// Staged search per track, cheapest signal first: Premiere peak files → start
// timecode → Build-position window → offsets learned from already-matched
// tracks → head region → full reference. Policy/window math is pure and tested
// in dsp.js; this drives the async matcher.
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

async function analyzeCoarseAlign(anchors, onProgress) {
    const deltaByKey = new Map();
    const notes = [];
    const results = [];
    if (anchors.length < 2) return { deltaByKey, notes, results };

    const baseLayer = anchors[0].layerOrder;

    // Group non-base anchors by their real track identity.
    const trackGroups = new Map();
    for (const anchor of anchors) {
        if (anchor.layerOrder === baseLayer) continue;
        const key = trackKeyOf(anchor);
        if (!trackGroups.has(key)) trackGroups.set(key, []);
        trackGroups.get(key).push(anchor);
    }

    notes.push(`Coarse align: staged search — Premiere peak files first (no audio decode), then start timecode and Build-position windows, then offsets learned from already-matched tracks, then the head region, then the full file — at ${COARSE_ENVELOPE_RATE}Hz.`);

    const envOpts = { sampleRate: COARSE_SAMPLE_RATE, windowSamples: COARSE_WINDOW_SAMPLES };
    const cfg = COARSE_CFG;

    // One job per track; setup failures are reported immediately.
    const jobs = [];
    for (const group of trackGroups.values()) {
        const trackLabel = `${group[0].trackType} track ${group[0].trackIndex + 1}`;
        const targetLayer = group[0].layerOrder;
        const reference = longestAnchor(anchors.filter(a => a.layerOrder < targetLayer));
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
            state: dsp.createCoarseState(),
            lines: [],                // buffered log lines, flushed as one block
            triedLearned: new Set(),  // learned offsets this track has already checked
            done: false,              // matched strongly — stop searching
            failed: false,            // decode error — leave to the fine pass
            finalized: false
        });
    }
    if (!jobs.length) return { deltaByKey, notes, results };

    // Metadata-only geometry + plan list per job (cheap probe reads).
    await Promise.all(jobs.map(async (job) => {
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
        job.plans = dsp.planCoarseSearch(job.geom, cfg);
    }));

    // Whole-track offsets confirmed STRONGLY on some track — near-free search
    // hints for the others (devices from one shoot share a clock-error family).
    const learnedDeltas = [];

    function matchPlan(job, plan) {
        return Promise.all([
            audio.getEnvelope(job.reference.filePath, plan.winStart, plan.winDur, envOpts),
            audio.getEnvelope(job.target.filePath, job.target.inPointSec, plan.probeDur, envOpts)
        ]).then(([refEnvelope, targetEnvelope]) => dsp.slideMatch(refEnvelope, targetEnvelope, {
            envelopeRate: COARSE_ENVELOPE_RATE,
            minOverlapSec: Math.min(plan.probeDur, COARSE_MATCH_OVERLAP_SEC)
        }));
    }

    // Premiere peak-file fast path: when BOTH files carry a trusted .pek, match
    // the probe against the whole reference straight from the cached peaks — no
    // audio decode at all. Returns true on a strong match.
    async function tryPekCoarse(job) {
        const [refPek, tgtPek] = await Promise.all([
            pek.resolvePek(job.reference.filePath),
            pek.resolvePek(job.target.filePath)
        ]);
        if (!refPek || !tgtPek) return false;

        const probeDur = Math.min(job.geom.targetAvailSec, COARSE_TARGET_MAX_SEC);
        const plan = {
            label: "pek", winStart: job.geom.refInPointSec, winDur: job.geom.refDurationFull,
            probeDur, predicts: false, predictedDeltaSec: 0
        };
        const [refEnv, tgtEnv] = await Promise.all([
            pek.getPekEnvelope(refPek, plan.winStart, plan.winDur, COARSE_ENVELOPE_RATE),
            pek.getPekEnvelope(tgtPek, job.geom.targetInPointSec, probeDur, COARSE_ENVELOPE_RATE)
        ]);
        if (!refEnv.length || !tgtEnv.length) return false;

        const candidate = dsp.slideMatch(refEnv, tgtEnv, {
            envelopeRate: COARSE_ENVELOPE_RATE,
            minOverlapSec: Math.min(probeDur, COARSE_MATCH_OVERLAP_SEC)
        });
        return dsp.coarseConsider(job.state, plan, candidate, job.geom, cfg);
    }

    // Check every learned offset this job hasn't tried yet; true = strong match.
    async function tryLearnedHints(job) {
        for (const learned of [...learnedDeltas]) {
            const hintKey = Math.round(learned / 10); // offsets within ~10s are one lead
            if (job.triedLearned.has(hintKey)) continue;
            job.triedLearned.add(hintKey);
            const plan = dsp.planLearnedSearch(job.geom, cfg, learned);
            if (!plan) continue;
            if (dsp.coarseConsider(job.state, plan, await matchPlan(job, plan), job.geom, cfg)) return true;
        }
        return false;
    }

    // Resolve a finished job: apply the chosen shift, flush its buffered log
    // lines, and publish a strong delta as a hint for the remaining tracks.
    function finalizeJob(job) {
        job.finalized = true;
        if (!job.failed) {
            const result = dsp.coarseResolve(job.state, job.geom, cfg);
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

    // ── Stage 0 — Premiere peak files ─────────────────────────────────────────
    await mapPool(jobs, SYNC_CONCURRENCY, async (job) => {
        try {
            if (await tryPekCoarse(job)) job.done = true;
        } catch (e) {
            if (e && e.cancelled) throw e;
            // peaks are opportunistic — fall through to the audio stages
        }
    });
    let pekMatched = 0;
    for (const job of jobs) {
        if (job.done && !job.finalized) {
            finalizeJob(job);
            pekMatched += 1;
        }
    }
    if (pekMatched > 0) {
        notes.push(`Coarse align: ${pekMatched} of ${jobs.length} track${jobs.length !== 1 ? "s" : ""} matched from Premiere's peak-file cache — no audio decoded.`);
    }

    // ── Staged execution across tracks ────────────────────────────────────────
    // Every track runs its cheap metadata windows before ANY track pays for a
    // blind scan, and blind stages first check offsets learned from tracks that
    // already matched.
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
                        if (dsp.coarseConsider(job.state, plan, await matchPlan(job, plan), job.geom, cfg)) {
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

// ─── Fine pass: per-clip comparison ───────────────────────────────────────────
async function comparePair(reference, target) {
    const comparePlan = dsp.buildCompareWindow(reference, target);
    if (!comparePlan) {
        return {
            reference, target, usable: false,
            reason: `timeline overlap ${Math.max(0, Math.min(reference.resolvedEndSec, target.resolvedEndSec) - Math.max(reference.resolvedStartSec, target.resolvedStartSec)).toFixed(2)}s is below minimum ${dsp.FINE_TUNE_MIN_OVERLAP_SEC}s`,
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
                audio.getEnvelope(reference.filePath, window.refSourceOffsetSec, window.compareDurationSec),
                audio.getEnvelope(target.filePath, window.targetSourceOffsetSec, window.compareDurationSec)
            ]);

            const lag = dsp.findBestLag(refEnvelope, targetEnvelope);
            if (!lag) {
                attempts.push({ attemptIndex: index + 1, window, reason: "flat or low-variance audio in this slice" });
                continue;
            }
            // A match jammed against the ±max-shift limit is almost always spurious.
            if (lag.atRail) {
                railRejected = true;
                attempts.push({
                    attemptIndex: index + 1, window,
                    reason: `best match pinned to the ±${dsp.FINE_TUNE_MAX_SHIFT_SEC}s search limit (likely spurious)`
                });
                continue;
            }

            const attemptResult = {
                attemptIndex: index + 1, window,
                score: lag.score, lagSec: lag.lagSec, overlapSec: lag.overlapSec
            };
            attempts.push(attemptResult);
            if (!best || attemptResult.score > best.score) best = attemptResult;

            // If the first (centered) window is already a strong match, skip
            // alternate windows to keep fine tune fast.
            if (index === 0 && attemptResult.score >= dsp.FINE_TUNE_DECENT_SCORE) break;
        } catch (e) {
            if (e && e.cancelled) throw e;
            lastError = e.message;
            attempts.push({ attemptIndex: index + 1, window, reason: e.message });
        }
    }

    if (!best) {
        return {
            reference, target, usable: false,
            railRejected: railRejected && !lastError,
            reason: (railRejected && !lastError)
                ? `fine-tune match pinned to the ±${dsp.FINE_TUNE_MAX_SHIFT_SEC}s limit (unreliable) — keeping coarse alignment`
                : (lastError || "no lag candidate from attempted windows"),
            attempts
        };
    }

    return {
        reference, target, usable: true,
        score: best.score, lagSec: best.lagSec, overlapSec: best.overlapSec,
        overlapWindowSec: comparePlan.overlapSec, selectedWindow: best.window, attempts
    };
}

// ─── Clock-drift check ────────────────────────────────────────────────────────
// A single offset can't fix devices whose clocks run at different RATES. Measure
// the residual lag near both ends of a long overlap and report the divergence.
async function measureDrift(reference, target) {
    const probe = dsp.buildDriftProbe(reference, target);
    if (!probe) return null; // overlap too short for drift to matter

    const [refEarly, tgtEarly, refLate, tgtLate] = await Promise.all([
        audio.getEnvelope(reference.filePath, probe.early.refSourceOffsetSec, probe.early.compareDurationSec),
        audio.getEnvelope(target.filePath, probe.early.targetSourceOffsetSec, probe.early.compareDurationSec),
        audio.getEnvelope(reference.filePath, probe.late.refSourceOffsetSec, probe.late.compareDurationSec),
        audio.getEnvelope(target.filePath, probe.late.targetSourceOffsetSec, probe.late.compareDurationSec)
    ]);

    const early = dsp.findBestLag(refEarly, tgtEarly);
    const late = dsp.findBestLag(refLate, tgtLate);
    if (!early || !late || early.atRail || late.atRail) return null;
    if (early.score < dsp.FINE_TUNE_MIN_SCORE || late.score < dsp.FINE_TUNE_MIN_SCORE) return null;

    const driftSec = late.lagSec - early.lagSec;
    if (Math.abs(driftSec) < dsp.DRIFT_MIN_REPORT_SEC) return null;
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
    const targets = [];
    for (let i = 0; i < anchors.length; i += 1) {
        if (anchors[i].layerOrder !== baseLayer) targets.push({ target: anchors[i], targetIndex: i });
    }
    const nonBaseTotal = targets.length;
    let doneCount = 0;

    notes.push(`Fine tune compare window: up to ${dsp.FINE_TUNE_MAX_COMPARE_SEC}s per pair, max shift ±${dsp.FINE_TUNE_MAX_SHIFT_SEC}s, retries on an alternate window when first-window score is below ${dsp.FINE_TUNE_DECENT_SCORE.toFixed(2)}; ${SYNC_CONCURRENCY} clips at a time.`);

    const outcomes = await mapPool(targets, SYNC_CONCURRENCY, async ({ target, targetIndex }) => {
        let bestPair = null;
        const pairDiagnostics = [];
        let railKept = false; // a comparison matched only at the ±max-shift rail
        for (let refIndex = 0; refIndex < targetIndex; refIndex += 1) {
            const reference = anchors[refIndex];
            if (reference.layerOrder >= target.layerOrder) continue;

            const result = await comparePair(reference, target);
            if (!result || !result.usable) {
                if (result && result.reason) pairDiagnostics.push(`${dsp.describeAnchor(reference)}: ${result.reason}`);
                if (result && result.railRejected) railKept = true;
                continue;
            }
            if (!bestPair || result.score > bestPair.score) bestPair = result;
        }

        // Buffer this clip's lines so concurrent clips stay as intact blocks.
        const lines = [];
        let adjustment = null;
        const row = { scope: "clip", label: target.clipName };

        if (!bestPair && railKept) {
            lines.push([`↳ ${target.clipName}: kept coarse alignment — fine-tune match was unreliable (pinned to ±${dsp.FINE_TUNE_MAX_SHIFT_SEC}s limit)`, "info"]);
            row.status = "kept";
            row.detail = "fine match unreliable — kept coarse alignment";
        } else if (!bestPair) {
            const detail = pairDiagnostics.length ? ` (${pairDiagnostics[0]})` : "";
            lines.push([`⚠ Skip ${target.clipName}: no usable overlap/match${detail}`, "warn"]);
            row.status = "unmatched";
            row.detail = pairDiagnostics.length ? pairDiagnostics[0] : "no usable overlap or match";
        } else if (bestPair.score < dsp.FINE_TUNE_MIN_SCORE) {
            lines.push([`⚠ Skip ${target.clipName}: weak match score ${bestPair.score.toFixed(2)} vs ${bestPair.reference.clipName}`, "warn"]);
            row.status = "weak";
            row.score = bestPair.score;
            row.method = bestPair.reference.clipName;
        } else {
            // Positive lag means target starts later than reference — move it earlier.
            const deltaSec = -(bestPair.lagSec);
            row.score = bestPair.score;
            row.method = bestPair.reference.clipName;
            if (Math.abs(deltaSec) < dsp.FINE_TUNE_MIN_APPLY_SEC) {
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
    resultsSection.style.display = "block";
}

function clearSyncSummary() {
    resultsSection.style.display = "none";
    resultsBody.innerHTML = "";
}

// ─── Revert last fine tune ────────────────────────────────────────────────────
// One undoable transaction applied the shifts, and we recorded the exact
// inverse (matched by each clip's post-move start ticks) — one click restores.
function setRevertAvailable(payload) {
    lastFineTuneRevert = payload;
    btnRevert.style.display = payload ? "inline-block" : "none";
}

async function revertFineTune() {
    if (!lastFineTuneRevert || isDisabled(btnRevert)) return;
    beginOp("Reverting fine tune…");
    setDisabled(btnRevert, true);
    setButtonsDisabled(true);
    try {
        const r = await premiere.applyShifts(lastFineTuneRevert.adjustments, {});
        log(`↩ Reverted the last fine tune (${r.applied} clip${r.applied !== 1 ? "s" : ""} restored).`, "success");
        setRevertAvailable(null);
        clearSyncSummary();
    } catch (e) {
        log(`✗ Revert failed: ${e.message}`, "error");
    } finally {
        setDisabled(btnRevert, false);
        setButtonsDisabled(false);
        endOp();
    }
}
btnRevert.addEventListener("click", revertFineTune);

function setButtonsDisabled(d) {
    setDisabled(btnAuto, d);
    setDisabled(btnRefresh, d);
    setDisabled(btnSync, d || !clipPayload);
    setDisabled(btnFineTune, d || !scannedSeqName);
}

// ─── Scan: read active sequence ───────────────────────────────────────────────
async function refreshSequence() {
    beginOp("Scanning sequence…");
    clearLog();
    clearSyncSummary();
    clipPayload = null;
    setDisabled(btnSync, true);
    setDisabled(btnFineTune, true);
    clipTable.style.display = "none";
    seqInfo.textContent = "Reading sequence…";
    setProgress(10);

    try {
        const scan = await premiere.scanActiveSequence();
        const videoClips = scan.clips.filter(c => c.trackType === "video").length;
        const audioClips = scan.clips.length - videoClips;

        seqInfo.innerHTML = `
            <span class="seq-name">${escapeHtml(scan.name)}</span>
            <span class="seq-meta">${videoClips} video clip${videoClips !== 1 ? "s" : ""} · ${audioClips} audio clip${audioClips !== 1 ? "s" : ""}</span>
        `;
        scannedSeqName = scan.name;   // mark this sequence as the scanned one
        lastLiveSeqName = scan.name;  // keep the idle poll from re-flagging it
        log(`Sequence: "${scan.name}" — ${videoClips} video, ${audioClips} audio clips`);
        setProgress(30);

        // Collapse timeline instances to unique source FILES (video preferred).
        const fileByPath = new Map();
        for (const c of scan.clips) {
            const cur = fileByPath.get(c.filePath);
            const durationSec = c.endSec - c.startSec;
            if (!cur) {
                fileByPath.set(c.filePath, { filePath: c.filePath, trackType: c.trackType, durationSec });
            } else {
                if (c.trackType === "video") cur.trackType = "video";
                if (durationSec > cur.durationSec) cur.durationSec = durationSec;
            }
        }
        const files = [...fileByPath.values()];
        if (!files.length) throw new Error("No readable clips found in sequence.");

        log(`Found ${files.length} unique source file(s). Reading timestamps (${SYNC_CONCURRENCY} at a time)…`);
        setProgress(50);

        let probed = 0;
        const outcomes = await mapPool(files, SYNC_CONCURRENCY, async (file) => {
            try {
                const r = await resolveRecordStart(file);
                return { file, r };
            } catch (e) {
                if (e && e.cancelled) throw e;
                return { file, errorMessage: e.message };
            } finally {
                probed += 1;
                setProgress(50 + Math.round((probed / files.length) * 30));
            }
        });

        const enriched = [];
        const sourceCounts = {};
        for (const { file, r, errorMessage } of outcomes) {
            if (errorMessage !== undefined) {
                log(`⚠ Could not read "${file.filePath}": ${errorMessage}`, "warn");
                continue;
            }
            enriched.push({ ...file, recordStartMs: r.recordStartMs, durationSec: r.durationSec, timingSource: r.timingSource });
            sourceCounts[r.timingSource] = (sourceCounts[r.timingSource] || 0) + 1;
            const srcLabel = isEmbeddedSource(r.timingSource) ? `embedded ${r.timingSource}` : "file mtime";
            log(`✓ ${audio.baseName(file.filePath)} — start ${formatTime(r.recordStartMs)} via ${srcLabel}, duration ${formatDuration(r.durationSec * 1000)}`);
        }

        if (!enriched.length) throw new Error("Could not read timestamps for any clips.");

        // Mixed precise + mtime sources may not agree on the absolute clock.
        const usedSources = Object.keys(sourceCounts);
        const hasEmbedded = usedSources.some(isEmbeddedSource);
        const hasMtime = usedSources.includes("mtime");
        if (hasEmbedded && hasMtime) {
            const breakdown = usedSources.map(s => `${s}: ${sourceCounts[s]}`).join(", ");
            log(`⚠ Mixed timing sources (${breakdown}). mtime-derived starts are less precise than embedded ones; use Fine Tune Audio to correct residual drift.`, "warn");
        }

        // Global earliest recording — the shared wall-clock anchor.
        let globalEarliestMs = Infinity;
        for (const f of enriched) {
            if (f.recordStartMs < globalEarliestMs) globalEarliestMs = f.recordStartMs;
        }

        setProgress(80);

        // Populate the Detected Clips table (offset relative to the earliest).
        clipBody.innerHTML = "";
        enriched.forEach(f => {
            const offsetMs = f.recordStartMs - globalEarliestMs;
            const tr = document.createElement("tr");
            const srcTag = isEmbeddedSource(f.timingSource) ? "meta" : "mtime";
            tr.innerHTML = `
                <td class="cell-name" title="${escapeHtml(f.filePath)}">${escapeHtml(audio.baseName(f.filePath))}</td>
                <td class="cell-type ${f.trackType}">${f.trackType === "video" ? "🎬" : "🎵"} ${f.trackType}</td>
                <td class="cell-time" title="timing source: ${escapeHtml(f.timingSource)}">${formatTime(f.recordStartMs)} <span class="cell-src">${srcTag}</span></td>
                <td class="cell-offset">${formatDuration(offsetMs)}</td>
            `;
            clipBody.appendChild(tr);
        });
        clipTable.style.display = "table";

        // 24-hour span guard.
        const maxEndMs = Math.max(...enriched.map(f => f.recordStartMs + f.durationSec * 1000));
        const spanSec = (maxEndMs - globalEarliestMs) / 1000;
        const hasSpanViolation = spanSec > dsp.MAX_SPAN_SEC;
        if (hasSpanViolation) {
            log(`⚠ Sequence spans ${(spanSec / 3600).toFixed(1)}h — exceeds Premiere's 24-hour maximum.`, "warn");
        }

        clipPayload = enriched;
        setDisabled(btnFineTune, false);
        setProgress(100);
        setTimeout(() => setProgress(0, false), 600);

        if (hasSpanViolation) {
            log("Build Sync Sequence is disabled — the sequence must fit within 24 hours. Process one recording day at a time.", "error");
        } else {
            setDisabled(btnSync, false);
            log(`Ready. Click "Build Sync" to create ${scan.name}-SYNC.`, "success");
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
    setButtonsDisabled(true);
    setProgress(20);
    if (scannedSeqName && /-SYNC$/.test(scannedSeqName)) {
        log(`⚠ "${scannedSeqName}" looks like an already-built sync sequence — building it again creates "${scannedSeqName}-SYNC". Run from the original sequence unless this is intentional.`, "warn");
    }
    log("Building sync sequence…");

    try {
        const recordStartByPath = {};
        let globalEarliestMs = Infinity;
        for (const f of clipPayload) {
            recordStartByPath[f.filePath] = f.recordStartMs;
            if (f.recordStartMs < globalEarliestMs) globalEarliestMs = f.recordStartMs;
        }

        const built = await premiere.buildSyncSequence(recordStartByPath, globalEarliestMs, scannedSeqName);
        setProgress(80);

        // Rename the clone to "<original>-SYNC".
        const wantName = `${scannedSeqName}-SYNC`;
        let finalName = built.name;
        try {
            const project = await premiere.getActiveProject();
            finalName = await premiere.renameSequence(project, built.sequence, wantName);
        } catch (e) { /* keep the clone's default name */ }

        log(`✓ Created sequence: "${finalName}" — placed ${built.placed}/${built.total} clips by record time.`, "success");
        setProgress(100);
        setTimeout(() => setProgress(0, false), 800);
        log(`Done! "${finalName}" is now open.`, "success");

        // Refresh UI state so ACTIVE SEQUENCE reflects the newly opened sequence.
        await refreshSequence();
        return true;

    } catch (e) {
        log(`✗ ${e.message}`, "error");
        setProgress(0, false);
        return false;
    } finally {
        setButtonsDisabled(false);
        endOp();
    }
}

// ─── Fine tune by waveform comparison ─────────────────────────────────────────
async function fineTuneAudio(opts = {}) {
    const runCoarse = opts.coarse === true; // Auto Sync passes true; the manual button is fine-only
    beginOp(runCoarse ? "Fine tuning…" : "Fine tuning (fast)…");
    clearSyncSummary();
    setButtonsDisabled(true);
    setProgress(5);
    log("Fine tune: analyzing waveform overlaps…");

    // Per-run caches: clear so a re-run re-reads files that may have changed.
    audio.clearCache();
    pek.clearRunCache();

    try {
        await audio.ensureAddon();

        const scan = await premiere.scanActiveSequence();
        const anchors = dsp.buildFineTuneAnchors(scan.clips);
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

        // Phase 1 — coarse auto-align (Auto Sync only).
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
            log(`Fine tune: per-clip pass only (±${dsp.FINE_TUNE_MAX_SHIFT_SEC}s). Assumes tracks are already within ${dsp.FINE_TUNE_MAX_SHIFT_SEC}s — use Auto Sync for larger offsets.`);
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
            if (Math.abs(rounded) < dsp.FINE_TUNE_MIN_APPLY_SEC) continue;
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

        throwIfCancelled();
        setProgress(90);

        // Boundary compensation: if a shift would push a clip before t=0, shift
        // EVERY clip forward by the deficit so relative alignment is preserved.
        const byKey = new Map(adjustments.map(a => [`${a.filePath}|${a.startTicks}`, a.deltaSec]));
        let minStart = Infinity;
        for (const c of scan.clips) {
            const d = byKey.get(`${c.filePath}|${c.startTicks}`) || 0;
            if (c.startSec + d < minStart) minStart = c.startSec + d;
        }
        const compensateSec = minStart < -1e-9 ? -minStart : 0;

        let shifts;
        if (compensateSec > 0) {
            shifts = scan.clips.map(c => ({
                filePath: c.filePath,
                startTicks: c.startTicks,
                deltaSec: (byKey.get(`${c.filePath}|${c.startTicks}`) || 0) + compensateSec
            })).filter(s => Math.abs(s.deltaSec) >= 0.0005);
        } else {
            shifts = adjustments;
        }

        const r = await premiere.applyShifts(shifts, {});
        if (compensateSec > 0) {
            log(`Fine tune: shifted entire sequence forward by ${formatSignedSeconds(compensateSec)} to keep boundary clip at position 0.`, "info");
        }

        // Stash the exact inverse so one click can undo this fine tune: re-scan
        // and match each shifted clip at its post-move position.
        try {
            const after = await premiere.scanActiveSequence();
            const revert = [];
            for (const s of shifts) {
                const oldStartSec = scan.clips.find(c => c.filePath === s.filePath && c.startTicks === s.startTicks);
                if (!oldStartSec) continue;
                const expect = oldStartSec.startSec + s.deltaSec;
                const now = after.clips.find(c => c.filePath === s.filePath && Math.abs(c.startSec - expect) < 0.002);
                if (now) revert.push({ filePath: s.filePath, startTicks: now.startTicks, deltaSec: -s.deltaSec });
            }
            setRevertAvailable(revert.length ? { adjustments: revert } : null);
        } catch (e) {
            setRevertAvailable(null);
        }

        renderSyncSummary(syncRows);
        setProgress(100);
        setTimeout(() => setProgress(0, false), 800);
        log(`Fine tune complete: adjusted ${r.applied} clip${r.applied !== 1 ? "s" : ""}.`, "success");

    } catch (e) {
        if (e && e.cancelled) {
            log("Fine tune cancelled — no adjustments were applied.", "warn");
        } else {
            log(`✗ ${e.message}`, "error");
        }
        setProgress(0, false);
    } finally {
        setButtonsDisabled(false);
        endOp();
    }
}

// ─── Auto Sync: Scan → Build → Fine Tune in one click ─────────────────────────
async function autoSync() {
    if (isDisabled(btnAuto)) return;
    beginOp("Auto Sync…");
    setDisabled(btnAuto, true);
    log("Auto Sync: starting (scan → build → fine tune)…");

    try {
        // Refuse to run on an already-built -SYNC sequence: the pipeline would
        // clone it into X-SYNC-SYNC and re-shift already-aligned clips.
        const liveName = await premiere.getActiveSequenceName();
        if (liveName && /-SYNC$/.test(liveName)) {
            log(`✗ Auto Sync: "${liveName}" is already a built sync sequence. Make the ORIGINAL sequence active (double-click it in the Project panel), then run Auto Sync again.`, "error");
            return;
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
        if (!cancelRequested) maybeShowTipsCard();
    } catch (e) {
        if (e && e.cancelled) log("Auto Sync cancelled.", "warn");
        else log(`✗ Auto Sync: ${e.message}`, "error");
    } finally {
        setDisabled(btnAuto, false);
        endOp();
    }
}

// ─── Button click handlers ────────────────────────────────────────────────────
btnAuto.addEventListener("click", autoSync);
btnRefresh.addEventListener("click", refreshSequence);
btnSync.addEventListener("click", buildSync);
btnFineTune.addEventListener("click", () => fineTuneAudio({ coarse: false }));

log("Syncitol UXP ready.");

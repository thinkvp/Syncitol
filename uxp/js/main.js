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
const COARSE_MAX_REF_CANDIDATES = 4;   // reference clips tried per track, longest first
const COARSE_PROBE_SCAN_SEC = 30 * 60; // how far into a clip to hunt for distinctive audio
const COARSE_VERIFY_MARGIN_SEC = 120;  // ± reference searched around the confirmation point
const COARSE_VERIFY_TOL_SEC = 10;      // second probe must agree with the first within this
const COARSE_VERIFY_MIN_SCORE = 0.25;  // the confirmation only has to corroborate, not be pristine
const COARSE_MAX_RELAY_CANDIDATES = 24; // reference channels scanned per probe window in the relay pass (pek-only, ~0.2s each)
const COARSE_RELAY_PROBE_SEGMENTS = 4;  // relay probe windows spread across the target (best per quarter)

const COARSE_CFG = {
    minOverlapSec: COARSE_MIN_OVERLAP_SEC,
    targetMaxSec: COARSE_TARGET_MAX_SEC,
    tcConfirmSec: COARSE_TC_CONFIRM_SEC,
    predictMarginSec: COARSE_PREDICT_MARGIN_SEC,
    headSec: COARSE_HEAD_SEC,
    minScore: COARSE_MIN_SCORE,
    strongScore: COARSE_STRONG_SCORE,
    confirmNearSec: COARSE_CONFIRM_NEAR_SEC,
    learnedMarginSec: COARSE_LEARNED_MARGIN_SEC,
    verifyMarginSec: COARSE_VERIFY_MARGIN_SEC
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
const btnCopyLog = $("btn-copy-log");
const resultsSection = $("results-section");
const resultsBody = $("results-body");
const toolStatusEl = $("tool-status");
const refTrigger = $("ref-trigger");
const refTriggerText = $("ref-trigger-text");
const refMenu = $("ref-menu");

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
const tipsCardStats = $("tips-card-stats");
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
function maybeShowTipsCard(statsText) {
    if (!tipsCard || tipsDismissed()) return;
    if (tipsCardStats) tipsCardStats.textContent = statsText || "Synced!";
    tipsCard.style.display = "flex";
}
if (tipsCardClose) tipsCardClose.addEventListener("click", dismissTipsCard);
if (tipsCardLink) {
    tipsCardLink.addEventListener("click", (e) => {
        e.preventDefault();
        require("uxp").shell.openExternal(tipsCardLink.href);
    });
}

// ─── Logging ──────────────────────────────────────────────────────────────────
// Every line is kept as plain text as well, so "⧉ Copy" hands over exactly what
// is on screen: UXP's text selection inside a scrolling div is unreliable, and a
// pasteable log is what makes a sync problem reportable.
const logLines = [];

function log(msg, type = "info") {
    const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
    logLines.push(line);
    const entry = document.createElement("div");
    entry.className = "log-entry log-" + type;
    entry.textContent = line;
    logContainer.appendChild(entry);
    logContainer.scrollTop = logContainer.scrollHeight;
}
function clearLog() {
    logLines.length = 0;
    logContainer.innerHTML = "";
}

async function copyLog() {
    const text = logLines.join("\n");
    if (!text) return;
    let ok = false;
    try {
        // UXP's own clipboard is the documented one; newer builds also carry the
        // web API, so fall through to that rather than failing silently.
        const uxp = require("uxp");
        if (uxp && uxp.clipboard && typeof uxp.clipboard.setContent === "function") {
            await uxp.clipboard.setContent({ "text/plain": text });
            ok = true;
        }
    } catch (e) { ok = false; }
    if (!ok) {
        try {
            if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(text);
                ok = true;
            }
        } catch (e) { ok = false; }
    }
    // Feedback on the button itself — a log line about copying the log would be
    // both noise and instantly stale.
    btnCopyLog.textContent = ok ? "✓ Copied" : "✗ Failed";
    setTimeout(() => { btnCopyLog.textContent = "⧉ Copy"; }, 1400);
    if (!ok) log("Could not reach the clipboard — select the log text and copy manually.", "warn");
}

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
    closeRefMenu();
    setDisabled(refTrigger, true);
    setBusy(text);
}
function endOp() {
    opDepth = Math.max(0, opDepth - 1);
    if (opDepth === 0) {
        setDisabled(refTrigger, false);
        setBusy(null);
    }
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
    refreshTrackOptions();                    // the reference dropdown follows the sequence

    if (!liveName) {
        seqInfo.textContent = "Open a sequence, then click \"Auto Sync\".";
    } else if (liveName !== scannedSeqName) {
        seqInfo.innerHTML =
            `<span class="seq-name">${escapeHtml(liveName)}</span>` +
            `<span class="seq-meta seq-stale">active — click "Auto Sync"</span>`;
    }
    // When liveName === scannedSeqName, leave the rich scanned info in place.
}
setInterval(pollActiveSequence, 3000);

// ─── Audio reference picker ───────────────────────────────────────────────────
// "Auto" leaves the reference to the analysis (the track with the most recorded
// coverage); any populated track can be forced instead, which selects the
// RECORDINGS on that track — every other clip is then aligned to them.
//
// The choice is session-only and deliberately NOT persisted: a track index means
// nothing in the next project, and a stale forced reference would silently
// mis-sync it. It does survive Auto Sync's original → -SYNC switch, because the
// Build clone keeps the track layout.
//
// UXP renders native <select> widgets that ignore author styling (the same
// reason the actions are <div class="btn">), so this is a div-built dropdown with
// its own absolutely-positioned menu.
let forcedRefTrackKey = null;  // null = Auto
let refTrackOptions = [];      // [{ key, short, meta, trigger }]
let refMenuOpen = false;
let refOptionsGen = 0;         // discards the result of a superseded refresh

function shortTrackLabel(track) {
    return (track.trackType === "video" ? "V" : "A") + (track.trackIndex + 1);
}

// The track's own name, but only when the user renamed it to something more
// useful than Premiere's defaults ("V1" / "Video 1").
function customTrackName(track) {
    const name = (track.trackName || "").trim();
    if (!name) return null;
    const n = track.trackIndex + 1;
    const defaults = [`${track.trackType === "video" ? "v" : "a"}${n}`, `${track.trackType} ${n}`];
    return defaults.includes(name.toLowerCase()) ? null : name;
}

// Walk up the parent chain instead of using contains()/closest(), which UXP's
// DOM subset doesn't reliably implement.
function isInside(node, root) {
    while (node) {
        if (node === root) return true;
        node = node.parentNode;
    }
    return false;
}

function updateRefTrigger() {
    if (!forcedRefTrackKey) {
        refTriggerText.textContent = "Auto";
        return;
    }
    const opt = refTrackOptions.find(o => o.key === forcedRefTrackKey);
    refTriggerText.textContent = opt ? opt.trigger : dsp.trackKeyLabel(forcedRefTrackKey);
}

function renderRefMenu() {
    refMenu.innerHTML = "";
    const rows = [{ key: null, short: "Auto", meta: "most recorded coverage" }, ...refTrackOptions];
    for (const opt of rows) {
        const item = document.createElement("div");
        item.className = "picker-item" + (opt.key === forcedRefTrackKey ? " is-selected" : "");
        item.innerHTML =
            `<span class="picker-item-key">${escapeHtml(opt.short)}</span>` +
            `<span class="picker-item-meta">${escapeHtml(opt.meta)}</span>`;
        item.addEventListener("click", () => selectRefTrack(opt.key));
        refMenu.appendChild(item);
    }
    if (!refTrackOptions.length) {
        const note = document.createElement("div");
        note.className = "picker-empty";
        note.textContent = "No tracks with clips — open a sequence.";
        refMenu.appendChild(note);
    }
}

function openRefMenu() {
    renderRefMenu();
    refMenu.style.display = "block";
    refTrigger.classList.add("is-open");
    refMenuOpen = true;
}
function closeRefMenu() {
    if (!refMenu) return;
    refMenu.style.display = "none";
    refTrigger.classList.remove("is-open");
    refMenuOpen = false;
}

function selectRefTrack(key) {
    closeRefMenu();
    if (key === forcedRefTrackKey) return;
    forcedRefTrackKey = key;
    updateRefTrigger();
    log(key
        ? `Audio reference: ${dsp.trackKeyLabel(key)} — every other clip will be aligned to the recordings on that track.`
        : "Audio reference: Auto — the track with the most recorded coverage will be used.");
}

// Read the active sequence's tracks. Cheap enough (no media-path lookups) to run
// on every sequence change; never throws — no sequence open just means no
// options.
async function refreshTrackOptions() {
    const gen = refOptionsGen + 1;
    refOptionsGen = gen;
    let tracks = [];
    try {
        const info = await premiere.listActiveSequenceTracks();
        tracks = (info.tracks || []).filter(t => t.clipCount > 0);
    } catch (e) {
        tracks = [];
    }
    if (gen !== refOptionsGen) return; // a later refresh already landed

    refTrackOptions = tracks.map(t => {
        const short = shortTrackLabel(t);
        const name = customTrackName(t) || t.firstClipName;
        const count = `${t.clipCount} clip${t.clipCount !== 1 ? "s" : ""}`;
        return {
            key: t.key,
            short,
            meta: name ? `${count} · ${name}` : count,
            trigger: name ? `${short} · ${name}` : short
        };
    });

    // A forced track the current sequence doesn't have would silently fall back
    // mid-run, so drop it here where the panel can say so.
    if (forcedRefTrackKey && !refTrackOptions.some(o => o.key === forcedRefTrackKey)) {
        log(`Audio reference ${dsp.trackKeyLabel(forcedRefTrackKey)} is not in this sequence — back to Auto.`, "warn");
        forcedRefTrackKey = null;
    }
    updateRefTrigger();
    if (refMenuOpen) renderRefMenu();
}

refTrigger.addEventListener("click", (e) => {
    e.stopPropagation();
    if (refMenuOpen) {
        closeRefMenu();
        return;
    }
    openRefMenu();
    if (!refTrackOptions.length) refreshTrackOptions(); // first open: fetch, then re-render
});
// Click-away. Bound to body (not document, whose event support UXP does not
// guarantee) and written so the menu still stays open if stopPropagation above
// is a no-op on some build.
(document.body || document).addEventListener("click", (e) => {
    if (refMenuOpen && !isInside(e.target, refMenu) && !isInside(e.target, refTrigger)) closeRefMenu();
});

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

function byDurationDesc(a, b) {
    return (b.resolvedEndSec - b.resolvedStartSec) - (a.resolvedEndSec - a.resolvedStartSec);
}

// Files whose record-start is not trustworthy evidence of WHERE they belong:
// mtime-derived starts in a sequence whose devices disagree about the date (a
// factory reset or dead clock battery puts one recorder years off). Build can
// only place such a clip arbitrarily, so a weak match at its Build position is
// coincidence, not confirmation — the coarse pass must demand a strong score.
// Returns an empty set when the payload is unavailable or when every clock
// agrees, leaving the normal thresholds in force.
function untrustedTimingPaths() {
    const out = new Set();
    if (!clipPayload || !clipPayload.length) return out;
    let earliestMs = Infinity;
    let latestEndMs = -Infinity;
    for (const f of clipPayload) {
        if (f.recordStartMs < earliestMs) earliestMs = f.recordStartMs;
        const endMs = f.recordStartMs + (f.durationSec || 0) * 1000;
        if (endMs > latestEndMs) latestEndMs = endMs;
    }
    if ((latestEndMs - earliestMs) / 1000 <= dsp.MAX_SPAN_SEC) return out; // clocks agree
    for (const f of clipPayload) {
        if (!isEmbeddedSource(f.timingSource)) out.add(f.filePath);
    }
    return out;
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

    // Clips whose Build position rests on an untrusted clock (see helper).
    const untrustedPaths = untrustedTimingPaths();

    // One job per track; setup failures are reported immediately.
    //
    // Each job carries SEVERAL reference candidates — the clips on the reference
    // track, longest first — and scores every one independently. Matching against
    // only the longest reference clip silently fails whenever a track's recording
    // belongs to a different session than that clip: a second recorder that only
    // ran in the afternoon could only ever be compared against a morning
    // reference, so the search had no correct answer available and settled on the
    // best noise peak. Trying each candidate lets the right session win on merit.
    const jobs = [];
    for (const group of trackGroups.values()) {
        const trackLabel = `${group[0].trackType} track ${group[0].trackIndex + 1}`;
        const targetLayer = group[0].layerOrder;
        const target = longestAnchor(group);
        const pool = anchors.filter(a => a.layerOrder < targetLayer).sort(byDurationDesc);

        if (!pool.length || !target) {
            log(`Coarse align: ${trackLabel} — no reference recording, leaving to fine pass.`);
            results.push({ scope: "track", label: trackLabel, status: "skipped", detail: "no reference recording — left to fine pass" });
            continue;
        }

        const tgtAvail = target.resolvedEndSec - target.resolvedStartSec;
        const probeShort = Math.min(tgtAvail, COARSE_TARGET_MAX_SEC);
        const usable = pool.filter(r =>
            Math.min(r.resolvedEndSec - r.resolvedStartSec, COARSE_REF_MAX_SEC) >= COARSE_MIN_OVERLAP_SEC);
        if (probeShort < COARSE_MIN_OVERLAP_SEC || !usable.length) {
            log(`Coarse align: ${trackLabel} — clips too short to match, leaving to fine pass.`);
            results.push({ scope: "track", label: trackLabel, status: "skipped", detail: "clips too short to match — left to fine pass" });
            continue;
        }

        const candidates = usable.slice(0, COARSE_MAX_REF_CANDIDATES);
        if (usable.length > candidates.length) {
            const dropped = usable.length - candidates.length;
            log(`Coarse align: ${trackLabel} — searching the ${candidates.length} longest of ${usable.length} reference clips; ${dropped} shorter one${dropped !== 1 ? "s" : ""} not searched.`, "info");
        }

        // No trustworthy Build position → a weak "timestamp" prediction is not
        // evidence. Raising minScore to strongScore makes the prediction branch of
        // coarseResolve demand the same confidence as a blind match.
        const distrusted = untrustedPaths.has(target.filePath);
        if (distrusted) {
            log(`Coarse align: ${trackLabel} — ${target.clipName} has an unreliable clock; its Build position won't be trusted on a weak score.`, "info");
        }

        jobs.push({
            group, trackLabel, target, tgtAvail,
            cfg: distrusted ? Object.assign({}, cfg, { minScore: cfg.strongScore }) : cfg,
            cands: candidates.map(reference => ({
                reference,
                refDurationFull: Math.min(reference.resolvedEndSec - reference.resolvedStartSec, COARSE_REF_MAX_SEC),
                geom: null, plans: null,
                state: dsp.createCoarseState(),
                triedLearned: new Set()  // learned offsets this candidate has checked
            })),
            lines: [],                // buffered log lines, flushed as one block
            done: false,              // matched strongly — stop searching
            failed: false,            // decode error — leave to the fine pass
            finalized: false
        });
    }
    if (!jobs.length) return { deltaByKey, notes, results };

    // Envelope of the target's opening stretch, for choosing where to probe.
    // Premiere's peak cache gives it away free; otherwise decode at the coarse rate.
    async function targetScanEnvelope(job, scanSec) {
        try {
            const p = await pek.resolvePek(job.target.filePath);
            if (p) {
                const env = await pek.getPekEnvelope(p, job.target.inPointSec, scanSec, COARSE_ENVELOPE_RATE);
                if (env && env.length) return env;
            }
        } catch (e) {
            if (e && e.cancelled) throw e; // peaks are opportunistic
        }
        return audio.getEnvelope(job.target.filePath, job.target.inPointSec, scanSec, envOpts);
    }

    // Metadata-only geometry + plan list per candidate (cheap, cached probe reads),
    // plus the content-picked probe position for this track.
    await Promise.all(jobs.map(async (job) => {
        // Probe the most distinctive audio in the clip rather than its head — a
        // silent lead-in has no structure to match and yields confident nonsense.
        const probeShort = Math.min(job.tgtAvail, COARSE_TARGET_MAX_SEC);
        job.probeWindows = [];
        try {
            const env = await targetScanEnvelope(job, Math.min(job.tgtAvail, COARSE_PROBE_SCAN_SEC));
            if (env && env.length) {
                job.probeWindows = dsp.pickProbeWindows(env, COARSE_ENVELOPE_RATE, probeShort, 2);
            }
        } catch (e) {
            if (e && e.cancelled) throw e;
            // Fall back to probing the head — no worse than the old behaviour.
        }
        const probeOffset = job.probeWindows.length ? job.probeWindows[0].offsetSec : 0;
        job.probeOffsetSec = probeOffset;
        if (probeOffset >= 1) {
            log(`Coarse align: ${job.trackLabel} — probing ${job.target.clipName} from +${formatDuration(probeOffset * 1000)} in (its most distinctive audio; the clip opens quietly).`, "info");
        }

        // Geometry is expressed as if the clip STARTED at the probe point, so the
        // existing lag→delta math needs no changes.
        const tcTgt = await probeStartTimecode(job.target.filePath);
        for (const cand of job.cands) {
            let tcDelta = null;
            const tcRef = await probeStartTimecode(cand.reference.filePath);
            if (tcRef !== null && tcTgt !== null) tcDelta = tcTgt - tcRef;
            cand.geom = {
                refInPointSec: cand.reference.inPointSec,
                refDurationFull: cand.refDurationFull,
                refResolvedStartSec: cand.reference.resolvedStartSec,
                targetInPointSec: job.target.inPointSec + probeOffset,
                targetResolvedStartSec: job.target.resolvedStartSec + probeOffset,
                targetAvailSec: job.tgtAvail - probeOffset,
                tcDelta
            };
            cand.plans = dsp.planCoarseSearch(cand.geom, job.cfg);
        }
    }));

    // Whole-track offsets confirmed STRONGLY on some track — near-free search
    // hints for the others (devices from one shoot share a clock-error family).
    const learnedDeltas = [];

    // Relay candidates read from Premiere's peak cache (and possibly a single
    // channel of it); ordinary candidates decode audio. Peak-derived and
    // decode-derived envelopes must never be correlated against each other — they
    // measure different things — so a candidate's kind drives BOTH sides.
    function refEnvFor(cand, winStart, winDur) {
        return cand.pek
            ? pek.getPekEnvelope(cand.pek, winStart, winDur, COARSE_ENVELOPE_RATE, cand.channel)
            : audio.getEnvelope(cand.reference.filePath, winStart, winDur, envOpts);
    }
    function tgtEnvFor(job, cand, startSec, durSec) {
        return (cand.pek && job.targetPek)
            ? pek.getPekEnvelope(job.targetPek, startSec, durSec, COARSE_ENVELOPE_RATE, null)
            : audio.getEnvelope(job.target.filePath, startSec, durSec, envOpts);
    }

    function matchPlan(job, cand, plan) {
        return Promise.all([
            refEnvFor(cand, plan.winStart, plan.winDur),
            tgtEnvFor(job, cand, cand.geom.targetInPointSec, plan.probeDur)
        ]).then(([refEnvelope, targetEnvelope]) => dsp.slideMatch(refEnvelope, targetEnvelope, {
            envelopeRate: COARSE_ENVELOPE_RATE,
            minOverlapSec: Math.min(plan.probeDur, COARSE_MATCH_OVERLAP_SEC)
        }));
    }

    // Premiere peak-file fast path: when BOTH files carry a trusted .pek, match
    // the probe against the whole reference straight from the cached peaks — no
    // audio decode at all. Tries each reference candidate; true on a strong match.
    async function tryPekCoarse(job) {
        const tgtPek = await pek.resolvePek(job.target.filePath);
        if (!tgtPek) return false;

        for (const cand of job.cands) {
            const refPek = await pek.resolvePek(cand.reference.filePath);
            if (!refPek) continue;

            const probeDur = Math.min(cand.geom.targetAvailSec, COARSE_TARGET_MAX_SEC);
            const plan = {
                label: "pek", winStart: cand.geom.refInPointSec, winDur: cand.geom.refDurationFull,
                probeDur, predicts: false, predictedDeltaSec: 0
            };
            const [refEnv, tgtEnv] = await Promise.all([
                pek.getPekEnvelope(refPek, plan.winStart, plan.winDur, COARSE_ENVELOPE_RATE),
                pek.getPekEnvelope(tgtPek, cand.geom.targetInPointSec, probeDur, COARSE_ENVELOPE_RATE)
            ]);
            if (!refEnv.length || !tgtEnv.length) continue;

            const candidate = dsp.slideMatch(refEnv, tgtEnv, {
                envelopeRate: COARSE_ENVELOPE_RATE,
                minOverlapSec: Math.min(probeDur, COARSE_MATCH_OVERLAP_SEC)
            });
            if (dsp.coarseConsider(cand.state, plan, candidate, cand.geom, job.cfg)) return true;
        }
        return false;
    }

    // Check every learned offset each candidate hasn't tried yet; true = strong match.
    async function tryLearnedHints(job) {
        for (const cand of job.cands) {
            for (const learned of [...learnedDeltas]) {
                const hintKey = Math.round(learned / 10); // offsets within ~10s are one lead
                if (cand.triedLearned.has(hintKey)) continue;
                cand.triedLearned.add(hintKey);
                const plan = dsp.planLearnedSearch(cand.geom, job.cfg, learned);
                if (!plan) continue;
                if (dsp.coarseConsider(cand.state, plan, await matchPlan(job, cand, plan), cand.geom, job.cfg)) return true;
            }
        }
        return false;
    }

    // ── Relay matching ────────────────────────────────────────────────────────
    // A track that matched nothing on the reference track gets a second attempt
    // against the tracks that DID resolve. Two lav mics on different people
    // correlate poorly — each is dominated by its own wearer — but a lav recorder
    // correlates almost perfectly with the camera channel that recorded the same
    // mic. Those camera tracks are already positioned, so they are sound
    // references even though they aren't the reference track.
    //
    // Multi-channel sources are searched ONE CHANNEL AT A TIME: a 4-channel camera
    // mix buries any single lav under the other three, which is exactly why the
    // averaged comparison scored 0.25.
    //
    // Peak-file only, on both sides. That keeps a whole-file scan cheap enough to
    // run across many channels, and peak-derived envelopes must not be correlated
    // against decoded ones anyway.
    async function relayMatch(job, relayRefs) {
        job.targetPek = await pek.resolvePek(job.target.filePath);
        if (!job.targetPek) {
            job.relayNote = `no peak file for ${job.target.clipName} — open it in Premiere to build one`;
            return;
        }

        const probeDur = Math.min(job.tgtAvail, COARSE_TARGET_MAX_SEC);

        // Probe windows spread across the WHOLE recording, not just its loudest
        // stretch. The most distinctive audio can predate every other device — a
        // recorder started 20 minutes before the cameras is at its liveliest
        // while nothing else was rolling, and a probe from there can never match
        // any reference. The peak file makes a full-length envelope nearly free.
        const fullEnv = await pek.getPekEnvelope(job.targetPek, job.target.inPointSec, job.tgtAvail, COARSE_ENVELOPE_RATE, null);
        if (!fullEnv || !fullEnv.length) { job.relayNote = "target peak file held no usable audio"; return; }
        const windows = dsp.pickProbeWindowsSpread(fullEnv, COARSE_ENVELOPE_RATE, probeDur, COARSE_RELAY_PROBE_SEGMENTS);
        if (!windows.length) { job.relayNote = "no usable probe window in the target"; return; }
        job.probeWindows = windows; // verification draws its second point from these

        // Resolve peak files up front so channels can be scanned ROUND-ROBIN —
        // channel 1 of every file before channel 2 of any. Walking one file's
        // channels exhaustively before moving on lets long wrong-session files
        // burn the whole budget first (observed: a morning MXF's channels plus
        // the wavs consumed every slot and the afternoon MXF that actually held
        // the matching mic channel was never compared).
        const files = [];
        for (const ref of relayRefs) {
            const refPek = await pek.resolvePek(ref.filePath);
            if (!refPek) continue;
            const refDurationFull = Math.min(ref.resolvedEndSec - ref.resolvedStartSec, COARSE_REF_MAX_SEC);
            if (refDurationFull < COARSE_MIN_OVERLAP_SEC) continue;
            files.push({
                ref, refPek, refDurationFull,
                chanCount: Math.max(1, (refPek.info && refPek.info.channels) || 1)
            });
        }
        if (!files.length) { job.relayNote = "no peak files on the already-aligned tracks"; return; }
        log(`Coarse align: ${job.trackLabel} — relay references: ${files.map(f => `${f.ref.clipName} (${f.chanCount}ch)`).join(", ")}.`, "info");
        log(`Coarse align: ${job.trackLabel} — relay probe windows at ${windows.map(w => `+${formatDuration(w.offsetSec * 1000)}`).join(", ")} into ${job.target.clipName}.`, "info");

        const queue = [];
        const maxChan = Math.max(...files.map(f => f.chanCount));
        for (let c = 0; c < maxChan; c += 1) {
            for (const f of files) {
                if (c < f.chanCount) queue.push({ file: f, channel: f.chanCount > 1 ? c : null });
            }
        }

        const cands = [];
        let strong = false;
        let scannedTotal = 0;
        for (const win of windows) {
            if (strong) break;
            const probeStart = job.target.inPointSec + win.offsetSec;
            const tgtEnv = await pek.getPekEnvelope(job.targetPek, probeStart, probeDur, COARSE_ENVELOPE_RATE, null);
            if (!tgtEnv || !tgtEnv.length) continue;

            let scanned = 0;
            for (const item of queue) {
                if (strong || scanned >= COARSE_MAX_RELAY_CANDIDATES) break;
                scanned += 1;
                scannedTotal += 1;
                const file = item.file;
                const channel = item.channel;
                const geom = {
                    refInPointSec: file.ref.inPointSec,
                    refDurationFull: file.refDurationFull,
                    refResolvedStartSec: file.ref.resolvedStartSec,
                    targetInPointSec: probeStart,
                    targetResolvedStartSec: job.target.resolvedStartSec + win.offsetSec,
                    targetAvailSec: job.tgtAvail - win.offsetSec,
                    tcDelta: null
                };

                const refEnv = await pek.getPekEnvelope(file.refPek, geom.refInPointSec, geom.refDurationFull, COARSE_ENVELOPE_RATE, channel);
                if (!refEnv || !refEnv.length) continue;

                const m = dsp.slideMatch(refEnv, tgtEnv, {
                    envelopeRate: COARSE_ENVELOPE_RATE,
                    minOverlapSec: Math.min(probeDur, COARSE_MATCH_OVERLAP_SEC)
                });
                // predicts:false — a blind scan, so coarseResolve demands a STRONG
                // score. Relay must not resurrect the weak matches we just rejected.
                const plan = {
                    label: channel === null ? "relay" : `relay ch${channel + 1}`,
                    winStart: geom.refInPointSec, winDur: geom.refDurationFull,
                    probeDur, predicts: false, predictedDeltaSec: 0
                };
                const state = dsp.createCoarseState();
                if (dsp.coarseConsider(state, plan, m, geom, job.cfg)) strong = true;
                cands.push({ reference: file.ref, channel, pek: file.refPek, geom, state, plans: [plan] });
            }
        }

        if (!cands.length) { job.relayNote = "no peak files on the already-aligned tracks"; return; }
        if (!strong && scannedTotal < windows.length * queue.length) {
            log(`Coarse align: ${job.trackLabel} — relay stopped after ${scannedTotal} of ${windows.length * queue.length} window×channel comparisons (the cap); the rest were not searched.`, "warn");
        }
        if (!strong) {
            const ranked = cands
                .filter(c => c.state.best)
                .sort((a, b) => b.state.best.score - a.state.best.score)
                .slice(0, 3)
                .map(c => `${c.reference.clipName}${(c.channel === null || c.channel === undefined) ? "" : ` ch${c.channel + 1}`} ${c.state.best.score.toFixed(2)}`);
            if (ranked.length) log(`Coarse align: ${job.trackLabel} — relay best candidates: ${ranked.join(" · ")}.`, "info");
        }

        // Hand the job its relay candidates and re-run confirmation on them.
        job.cands = cands;
        job.relayScanned = scanned;
        job.verified = false;
        job.verifyOk = null;
        job.verifyRejected = null;
        job.verifyNote = null;
        await verifyJob(job);
    }

    // Confirm a job's winning offset against a SECOND, independent stretch of the
    // same recording. A peak that came from room tone rather than shared content
    // won't reproduce the same offset elsewhere in the file, so this is what turns
    // a confidently-wrong shift into an honest "couldn't match". Best-effort: when
    // there's no usable second window we accept the offset and say so.
    async function verifyJob(job) {
        if (job.failed || job.verified) return;
        job.verified = true;

        const pick = dsp.coarseResolveBest(job.cands, job.cfg);
        if (!pick.result || Math.abs(pick.result.coarseDelta) < COARSE_MIN_APPLY_SEC) return;

        const cand = job.cands[pick.index];
        // The confirmation must come from a window OTHER than the one the winning
        // candidate matched with. Candidates can be probed from different windows
        // (the relay retries several spread across the clip), so derive each
        // candidate's own probe origin from its geometry instead of assuming the
        // first window.
        const originOffset = cand.geom.targetInPointSec - job.target.inPointSec;
        const second = (job.probeWindows || []).find(w => Math.abs(w.offsetSec - originOffset) > 1);
        if (!second) { job.verifyNote = "no second window with usable content"; return; }

        const probeDur = Math.min(cand.geom.targetAvailSec, COARSE_TARGET_MAX_SEC);
        // probeWindows offsets are measured from the clip's in-point; geom's probe
        // origin already includes the winning window's offset.
        const probe2Rel = second.offsetSec - originOffset;
        const plan = dsp.planCoarseVerify(cand.geom, job.cfg, pick.result.coarseDelta, probe2Rel, probeDur);
        if (!plan) { job.verifyNote = "the second window falls outside the reference"; return; }

        try {
            const [refEnv, tgtEnv] = await Promise.all([
                refEnvFor(cand, plan.winStart, plan.winDur),
                tgtEnvFor(job, cand, job.target.inPointSec + second.offsetSec, probeDur)
            ]);
            const m = dsp.slideMatch(refEnv, tgtEnv, {
                envelopeRate: COARSE_ENVELOPE_RATE,
                minOverlapSec: Math.min(probeDur, COARSE_MATCH_OVERLAP_SEC)
            });
            if (!m) { job.verifyNote = "the second window produced no usable match"; return; }
            const disagreeSec = Math.abs(m.lagSec - plan.expectedLagSec);
            if (m.score >= COARSE_VERIFY_MIN_SCORE && disagreeSec <= COARSE_VERIFY_TOL_SEC) {
                job.verifyOk = { score: m.score, disagreeSec };
            } else {
                job.verifyRejected = { score: m.score, disagreeSec };
            }
        } catch (e) {
            if (e && e.cancelled) throw e;
            job.verifyNote = e.message; // confirmation is best-effort
        }
    }

    // Resolve a finished job: apply the chosen shift, flush its buffered log
    // lines, and publish a strong delta as a hint for the remaining tracks.
    function finalizeJob(job) {
        job.finalized = true;
        if (!job.failed) {
            // Score every reference candidate and keep the most confident one — the
            // right session wins on audio content, not on being the longest clip.
            const pick = dsp.coarseResolveBest(job.cands, job.cfg);

            if (pick.result && job.verifyRejected) {
                // The offset looked confident but didn't hold up elsewhere in the
                // recording — almost always a match on room tone. Leave the track
                // where it is rather than move it somewhere confidently wrong.
                const v = job.verifyRejected;
                job.lines.push([`Coarse align: ${job.trackLabel} — ${job.target.clipName} matched ${job.cands[pick.index].reference.clipName} at ${formatSignedSeconds(pick.result.coarseDelta)} (score ${pick.result.chosen.score.toFixed(2)}), but a second stretch of the recording disagrees by ${formatDuration(v.disagreeSec * 1000)} (score ${v.score.toFixed(2)}) — rejecting it and leaving the track to the fine pass.`, "warn"]);
                results.push({
                    scope: "track", label: job.trackLabel, status: "unmatched",
                    score: pick.result.chosen.score,
                    detail: `offset failed second-window confirmation (${v.disagreeSec.toFixed(1)}s apart)`
                });
            } else if (!pick.result) {
                job.lines.push([`Coarse align: ${job.trackLabel} — no confident match for ${job.target.clipName} (best score ${pick.best ? pick.best.score.toFixed(2) : "n/a"} across ${job.cands.length} reference clip${job.cands.length !== 1 ? "s" : ""}), leaving to fine pass.`, "warn"]);
                results.push({
                    scope: "track", label: job.trackLabel, status: "unmatched",
                    score: pick.best ? pick.best.score : null,
                    detail: `no confident match for ${job.target.clipName}`
                });
            } else if (Math.abs(pick.result.coarseDelta) < COARSE_MIN_APPLY_SEC) {
                job.matched = true;
                job.lines.push([`Coarse align: ${job.trackLabel} already aligned (match score ${pick.result.chosen.score.toFixed(2)}).`]);
                results.push({
                    scope: "track", label: job.trackLabel, status: "aligned",
                    score: pick.result.chosen.score, method: pick.result.chosen.label
                });
            } else {
                job.matched = true;
                const delta = pick.result.coarseDelta;
                const winner = job.cands[pick.index];
                const refName = winner.channel === null || winner.channel === undefined
                    ? winner.reference.clipName
                    : `${winner.reference.clipName} ch${winner.channel + 1}`;
                for (const anchor of job.group) {
                    anchor.resolvedStartSec += delta;
                    anchor.resolvedEndSec += delta;
                    deltaByKey.set(anchor.key, (deltaByKey.get(anchor.key) || 0) + delta);
                }
                const confirm = job.verifyOk
                    ? `, confirmed at a second point (score ${job.verifyOk.score.toFixed(2)})`
                    : (job.verifyNote ? `, unconfirmed — ${job.verifyNote}` : "");
                job.lines.push([`Coarse align: ${job.trackLabel} shifted ${formatSignedSeconds(delta)} to match ${job.target.clipName} against ${refName} via ${pick.result.chosen.label} (score ${pick.result.chosen.score.toFixed(2)}${confirm}).`, "success"]);
                results.push({
                    scope: "track", label: job.trackLabel, status: "shifted",
                    deltaSec: delta, score: pick.result.chosen.score,
                    method: `${pick.result.chosen.label} · ${refName}`
                });
                if (pick.result.chosen.score >= COARSE_STRONG_SCORE) learnedDeltas.push(delta);
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
    const pekDone = jobs.filter(j => j.done && !j.finalized);
    await mapPool(pekDone, SYNC_CONCURRENCY, verifyJob);
    let pekMatched = 0;
    for (const job of pekDone) {
        finalizeJob(job);
        pekMatched += 1;
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
                    for (const cand of job.cands) {
                        for (const plan of cand.plans) {
                            if (stageLabels.indexOf(plan.label) === -1) continue;
                            if (plan.label === "full" && cand.state.skipFull) continue; // prediction confirmed — skip the costly full scan
                            if (dsp.coarseConsider(cand.state, plan, await matchPlan(job, cand, plan), cand.geom, job.cfg)) {
                                job.done = true;
                                break;
                            }
                        }
                        if (job.done) break;
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

        // Confirm, then publish freshly-confident offsets before the next (blind)
        // stage — an unconfirmed offset must not become a hint for other tracks.
        const settled = jobs.filter(j => (j.done || j.failed) && !j.finalized);
        await mapPool(settled, SYNC_CONCURRENCY, verifyJob);
        for (const job of settled) finalizeJob(job);
    }

    // Tracks that exhausted every stage: accept a near-prediction match or give up.
    const remaining = jobs.filter(j => !j.finalized);
    await mapPool(remaining, SYNC_CONCURRENCY, verifyJob);

    // ── Relay pass ────────────────────────────────────────────────────────────
    // Anything still unmatched (or whose match failed confirmation) is retried
    // against the tracks that DID resolve, channel by channel.
    const resolvedAnchors = [];
    for (const job of jobs) {
        if (job.finalized && job.matched) resolvedAnchors.push(...job.group);
    }
    // The reference track's own clips are positioned by definition — include them
    // so their individual channels get a per-channel retry too (the main pass
    // only ever compared their downmixed mix).
    resolvedAnchors.push(...anchors.filter(a => a.layerOrder === baseLayer));
    resolvedAnchors.sort(byDurationDesc);

    const needsRelay = remaining.filter(job => {
        if (job.failed) return false;
        const pick = dsp.coarseResolveBest(job.cands, job.cfg);
        return !pick.result || !!job.verifyRejected;
    });

    if (needsRelay.length && resolvedAnchors.length) {
        for (const job of needsRelay) {
            const refs = resolvedAnchors.filter(a => trackKeyOf(a) !== trackKeyOf(job.target));
            if (!refs.length) continue;
            log(`Coarse align: ${job.trackLabel} — retrying ${job.target.clipName} against the tracks that did align, one channel at a time.`, "info");
            try {
                await relayMatch(job, refs);
            } catch (e) {
                if (e && e.cancelled) throw e;
                job.relayNote = e.message;
            }
            if (job.relayNote) log(`Coarse align: ${job.trackLabel} — relay unavailable: ${job.relayNote}`, "warn");
        }
    }

    for (const job of remaining) finalizeJob(job);

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
            let appliedDelta = 0;
            if (Math.abs(deltaSec) < dsp.FINE_TUNE_MIN_APPLY_SEC) {
                lines.push([`${target.clipName} already aligned (delta < 20 ms)`, "info"]);
                row.status = "aligned";
            } else {
                const roundedDelta = Math.round(deltaSec * 1000) / 1000;
                adjustment = {
                    clipName: target.clipName,
                    filePath: target.filePath,
                    deltaSec: roundedDelta,
                    referenceName: bestPair.reference.clipName,
                    score: bestPair.score
                };
                appliedDelta = roundedDelta;
                target.resolvedStartSec += roundedDelta;
                target.resolvedEndSec += roundedDelta;
                lines.push([`✓ ${target.clipName}: shift ${formatSignedSeconds(roundedDelta)} vs ${bestPair.reference.clipName} (score ${bestPair.score.toFixed(2)}, ${bestPair.attempts.length} window${bestPair.attempts.length !== 1 ? "s" : ""})`, "success"]);
                row.status = "shifted";
                row.deltaSec = roundedDelta;
            }

            // Long overlap and a solid match: also check whether the two devices'
            // clocks RUN at different rates (drift), which one offset can't fix.
            // Beyond DRIFT_IMPLAUSIBLE_PPM the two ends disagree by more than any
            // real device pair can, which means the windows matched noise rather
            // than shared audio — discard the shift instead of locking it in.
            try {
                const drift = await measureDrift(bestPair.reference, target);
                if (drift) {
                    row.driftSec = drift.driftSec;
                    row.driftPpm = drift.ppm;
                    if (Math.abs(drift.ppm) >= dsp.DRIFT_IMPLAUSIBLE_PPM) {
                        if (appliedDelta) {
                            target.resolvedStartSec -= appliedDelta;
                            target.resolvedEndSec -= appliedDelta;
                        }
                        adjustment = null;
                        lines.push([`⚠ Skip ${target.clipName}: the match vs ${bestPair.reference.clipName} implies ${drift.ppm} ppm drift across ${formatDuration(drift.spanSec * 1000)} — far beyond any real device, so it is not the same audio. Left in place.`, "warn"]);
                        row.status = "unmatched";
                        delete row.deltaSec;
                        row.detail = `rejected: implausible ${drift.ppm} ppm drift vs ${bestPair.reference.clipName}`;
                    } else {
                        lines.push([`⚠ ${target.clipName}: clock drift ${formatSignedSeconds(drift.driftSec)} across ${formatDuration(drift.spanSec * 1000)} (~${drift.ppm} ppm) vs ${bestPair.reference.clipName} — the tail may be audibly off; consider splitting long clips before syncing.`, "warn"]);
                    }
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
        reportApplyIntegrity(r, null);
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
}

// ─── A/V integrity reporting ──────────────────────────────────────────────────
// Syncitol asks for ONE delta per source file and hands it to every timeline
// instance of that file, so a clip's video and its linked audio are never asked
// to move apart. The host can still refuse or alter a single move — a locked
// track, a destination that would overlap a neighbour on that track, an item
// whose action could not be built — and that is what pulls A/V apart on some
// clips while their neighbours on the same track are fine. premiere.js now reads
// the timeline back after every apply; this turns the report into log lines and
// Sync Results rows.
//
// Nothing here is cosmetic: an unreported tear is a permanent, silent edit.
function reportApplyIntegrity(result, rows) {
    if (!result) return true;
    let clean = true;

    if (result.scanDropped && (result.scanDropped.noPath || result.scanDropped.itemErr)) {
        const d = result.scanDropped;
        const lost = d.noPath + d.itemErr;
        clean = false;
        log(`⚠ ${lost} of ${d.raw} timeline items could not be read (${d.noPath} with no media path, ` +
            `${d.itemErr} that errored). They were left where they are — if one of them is the audio half ` +
            `of a clip, that clip is now out of sync with its video.`, "warn");
        if (rows) rows.push({
            scope: "track", label: "Unreadable timeline items", status: "unmatched",
            detail: `${lost} item(s) skipped — check those clips`
        });
    }

    for (const sk of (result.skipped || [])) {
        clean = false;
        const name = audio.baseName(sk.filePath);
        log(`⚠ ${name} was left unsynced: ${sk.reason}. All ${sk.instances} of its timeline items were skipped ` +
            `together, so its video and audio are still linked.`, "warn");
        if (rows) rows.push({ scope: "clip", label: name, status: "unmatched", detail: `not moved — ${sk.reason}` });
    }

    for (const p of (result.partial || [])) {
        clean = false;
        const name = audio.baseName(p.filePath);
        log(`✗ ${name}: the host accepted only ${p.added} of ${p.instances} moves for this file — its video and ` +
            `audio may now be out of sync. Undo (Ctrl/Cmd+Z) restores the timeline.`, "error");
        if (rows) rows.push({ scope: "clip", label: name, status: "unmatched", detail: "host refused part of the move — A/V may be torn" });
    }

    const integrity = result.integrity;
    if (integrity) {
        for (const t of integrity.torn) {
            clean = false;
            const name = audio.baseName(t.filePath);
            const where = t.instances
                .map(i => `${i.trackType.toUpperCase()} ${i.trackIndex + 1} moved ${formatSignedSeconds(i.movedSec)}`)
                .join("; ");
            log(`✗ A/V TORN — ${name}: every instance was asked to move ${formatSignedSeconds(t.requestedSec)}, but they ` +
                `landed ${formatSignedSeconds(t.spreadSec)} apart (${where}). Undo (Ctrl/Cmd+Z) restores the timeline; ` +
                `then check whether that clip's audio track is locked, or whether a neighbouring clip blocks where it ` +
                `needed to land.`, "error");
            if (rows) rows.push({
                scope: "clip", label: name, status: "unmatched",
                detail: `A/V torn by ${formatSignedSeconds(t.spreadSec)} — undo and check that track`
            });
        }
        for (const m of integrity.missing) {
            clean = false;
            const name = audio.baseName(m.filePath);
            const where = m.tracks
                .map(t => `${t.trackType.toUpperCase()} ${t.trackIndex + 1}: ${t.beforeCount}→${t.afterCount}`)
                .join(", ");
            log(`✗ ${name}: the timeline holds a different number of its items after the move (${where}). ` +
                `Undo (Ctrl/Cmd+Z) and re-run.`, "error");
        }
        if (integrity.quantized.length) {
            // Every instance of these files agreed, so A/V is intact — the host
            // simply did not land exactly where it was asked.
            const worst = integrity.quantized.reduce((a, b) =>
                Math.abs(b.actualSec - b.requestedSec) > Math.abs(a.actualSec - a.requestedSec) ? b : a);
            log(`ℹ ${integrity.quantized.length} file(s) landed slightly off the requested shift (worst: ` +
                `${audio.baseName(worst.filePath)}, asked ${formatSignedSeconds(worst.requestedSec)}, got ` +
                `${formatSignedSeconds(worst.actualSec)}) — the host snapped them. Every instance of each file moved ` +
                `by the same amount, so A/V stayed together.`, "info");
        }
        if (integrity.dropped && (integrity.dropped.noPath || integrity.dropped.itemErr)) {
            const lost = integrity.dropped.noPath + integrity.dropped.itemErr;
            log(`⚠ The verification pass could not read ${lost} timeline item(s); those were not checked for A/V drift.`, "warn");
        }
    }

    return clean;
}

// ─── Scan: read active sequence ───────────────────────────────────────────────
async function refreshSequence() {
    beginOp("Scanning sequence…");
    clearLog();
    clearSyncSummary();
    clipPayload = null;
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
        await refreshTrackOptions(); // the reference dropdown follows the sequence
        setProgress(30);

        // Deduplicate to unique source FILES while preserving the FIRST instance's
        // track info (needed for per-track anchoring). Video is preferred.
        const fileByPath = new Map();
        for (const c of scan.clips) {
            const cur = fileByPath.get(c.filePath);
            const durationSec = c.endSec - c.startSec;
            if (!cur) {
                fileByPath.set(c.filePath, {
                    filePath: c.filePath, trackType: c.trackType, trackIndex: c.trackIndex, durationSec
                });
            } else {
                if (c.trackType === "video" && cur.trackType !== "video") { cur.trackType = "video"; cur.trackIndex = c.trackIndex; }
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

        // Per-track earliest recording — each track anchors to its own earliest
        // clip, not a global anchor. This way a device whose clock is set to the
        // wrong date (factory reset, dead battery) doesn't push correctly-dated
        // clips beyond the 24-hour limit. Cross-track alignment is handled by
        // the audio coarse + fine tune passes.
        const trackEarliestMs = {};
        for (const f of enriched) {
            const tk = `${f.trackType}_${f.trackIndex}`;
            if (!(tk in trackEarliestMs) || f.recordStartMs < trackEarliestMs[tk]) {
                trackEarliestMs[tk] = f.recordStartMs;
            }
        }

        // Compute global earliest for the info log only.
        let globalEarliestMs = Infinity;
        for (const f of enriched) {
            if (f.recordStartMs < globalEarliestMs) globalEarliestMs = f.recordStartMs;
        }

        setProgress(80);

        // Populate the Detected Clips table (offset relative to that track's earliest).
        clipBody.innerHTML = "";
        enriched.forEach(f => {
            const tk = `${f.trackType}_${f.trackIndex}`;
            const offsetMs = f.recordStartMs - trackEarliestMs[tk];
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

        // 24-hour span guard (per track, matching the Build logic).
        // When one device has a wildly wrong clock (years off) the per-track
        // anchor keeps each track compact; the audio pass aligns tracks later.
        let hasSpanViolation = false;
        for (const f of enriched) {
            const tk = `${f.trackType}_${f.trackIndex}`;
            const endSec = (f.recordStartMs - trackEarliestMs[tk]) / 1000 + f.durationSec;
            if (endSec > dsp.MAX_SPAN_SEC) {
                hasSpanViolation = true;
                break;
            }
        }
        const globalSpanSec = (Math.max(...enriched.map(f => f.recordStartMs + f.durationSec * 1000)) - globalEarliestMs) / 1000;
        if (hasSpanViolation) {
            log(`\u26a0 A track exceeds Premiere\u2019s 24-hour maximum — process one recording day at a time.`, "warn");
        }
        if (!hasSpanViolation && globalSpanSec > dsp.MAX_SPAN_SEC) {
            log(`\u2139 Device clocks differ by ${(globalSpanSec / 3600).toFixed(0)}h (likely a wrong date on one device) — per-track anchoring keeps each track compact; audio alignment will sync them.`, "info");
        }

        clipPayload = enriched;
        setProgress(100);
        setTimeout(() => setProgress(0, false), 600);

        if (hasSpanViolation) {
            log("Cannot build the sync sequence \u2014 it must fit within Premiere\u2019s 24-hour maximum. Process one recording day at a time.", "error");
        } else {
            log(`Ready to build "${scan.name}-SYNC".`, "success");
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
        const built = await premiere.buildSyncSequence(clipPayload, scannedSeqName);
        setProgress(80);

        // Rename the clone to "<original>-SYNC".
        const wantName = `${scannedSeqName}-SYNC`;
        let finalName = built.name;
        try {
            const project = await premiere.getActiveProject();
            finalName = await premiere.renameSequence(project, built.sequence, wantName);
        } catch (e) { /* keep the clone's default name */ }

        log(`✓ Created sequence: "${finalName}" — placed ${built.placed}/${built.total} clips by record time.`, "success");
        reportApplyIntegrity(built, null);
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
async function fineTuneAudio() {
    beginOp("Fine tuning…");
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
        const anchors = dsp.buildFineTuneAnchors(scan.clips, forcedRefTrackKey);
        if (anchors.length < 2) {
            throw new Error("Need at least two clips with accessible audio for fine tune.");
        }

        // Same pure decision the anchors were marked with — read back for the log.
        const refPlan = dsp.planReferenceLayer(anchors, scan.clips, forcedRefTrackKey);
        if (refPlan.fallbackReason) {
            log(`Audio reference ${dsp.trackKeyLabel(refPlan.rejectedTrackKey)} can't be the reference — ${refPlan.fallbackReason}. Falling back to Auto.`, "warn");
        }
        if (refPlan.refTrackKey) {
            const refCount = anchors.filter(a => a.isReference).length;
            const how = refPlan.forced ? "chosen in the panel" : "longest coverage";
            log(`Reference track: ${dsp.trackKeyLabel(refPlan.refTrackKey)} — ${how} (${refCount} clip${refCount !== 1 ? "s" : ""}). All other tracks align to it.`);
        }

        log(`Fine tune: evaluating ${anchors.length} clips.`);
        setProgress(10);

        // Phase 1 — coarse auto-align (whole-track).
        const syncRows = [];
        const coarseDeltaByKey = new Map();
        setBusy("Fine tuning — coarse align…");
        log("Coarse align: scanning audio to find each track's offset — this can take a minute on long clips…");
        const coarse = await analyzeCoarseAlign(anchors, (done, total) => {
            setProgress(10 + Math.round((done / total) * 25));
        });
        coarse.notes.forEach(msg => log(msg));
        for (const [key, d] of coarse.deltaByKey) coarseDeltaByKey.set(key, d);
        syncRows.push(...coarse.results);

        // Phase 2 — fine residual via per-clip waveform correlation.
        setBusy("Fine tuning — per-clip pass…");
        const fine = await analyzeFineTune(anchors, (done, total) => {
            setProgress(35 + Math.round((done / total) * 50));
        });
        fine.notes.forEach(msg => log(msg));
        syncRows.push(...fine.results);

        // Merge coarse + fine deltas per FILE so each file moves exactly once.
        // (Anchor keys are file paths — one shift covers every timeline instance
        // of the file, keeping linked A/V together.)
        const totalByKey = new Map();
        for (const [key, d] of coarseDeltaByKey) {
            totalByKey.set(key, (totalByKey.get(key) || 0) + d);
        }
        for (const adj of fine.adjustments) {
            totalByKey.set(adj.filePath, (totalByKey.get(adj.filePath) || 0) + adj.deltaSec);
        }

        const anchorByKey = new Map(anchors.map(a => [a.key, a]));
        const adjustments = [];
        for (const [key, total] of totalByKey) {
            const rounded = Math.round(total * 1000) / 1000;
            if (Math.abs(rounded) < dsp.FINE_TUNE_MIN_APPLY_SEC) continue;
            const anchor = anchorByKey.get(key);
            if (!anchor) continue;
            adjustments.push({ filePath: anchor.filePath, deltaSec: rounded });
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
        // EVERY file forward by the deficit so relative alignment is preserved.
        const byPath = new Map(adjustments.map(a => [a.filePath, a.deltaSec]));
        let minStart = Infinity;
        for (const c of scan.clips) {
            const d = byPath.get(c.filePath) || 0;
            if (c.startSec + d < minStart) minStart = c.startSec + d;
        }
        const compensateSec = minStart < -1e-9 ? -minStart : 0;

        let shifts;
        if (compensateSec > 0) {
            const allPaths = [...new Set(scan.clips.map(c => c.filePath))];
            shifts = allPaths.map(p => ({
                filePath: p,
                deltaSec: (byPath.get(p) || 0) + compensateSec
            })).filter(s => Math.abs(s.deltaSec) >= 0.0005);
        } else {
            shifts = adjustments;
        }

        const r = await premiere.applyShifts(shifts, {});
        reportApplyIntegrity(r, syncRows);
        if (compensateSec > 0) {
            log(`Fine tune: shifted entire sequence forward by ${formatSignedSeconds(compensateSec)} to keep boundary clip at position 0.`, "info");
        }

        // Stash the exact inverse so one click can undo this fine tune. Shifts
        // are matched by file path, so the inverse is simply every delta negated.
        setRevertAvailable({
            adjustments: shifts.map(s => ({ filePath: s.filePath, deltaSec: -s.deltaSec }))
        });

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
    const startedAt = Date.now();

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

        await fineTuneAudio();
        log(cancelRequested ? "Auto Sync cancelled." : "Auto Sync complete.", cancelRequested ? "warn" : "success");
        if (!cancelRequested) {
            const clipCount = (clipPayload || []).length;
            const footageMs = (clipPayload || []).reduce((sum, f) => sum + (f.durationSec || 0) * 1000, 0);
            const elapsedMs = Date.now() - startedAt;
            maybeShowTipsCard(footageMs > 0
                ? `Synced ${formatDuration(footageMs)} of footage across ${clipCount} clip${clipCount !== 1 ? "s" : ""} in ${formatDuration(elapsedMs)}!`
                : "Synced!");
        }
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

if (btnCopyLog) btnCopyLog.addEventListener("click", copyLog);

refreshTrackOptions();
log("Syncitol UXP ready.");

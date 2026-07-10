/**
 * Syncitol — premiere.js
 * Host operations via the Premiere UXP DOM API (require("premierepro")).
 *
 * Editing is transactional: build Actions, run them in
 * project.executeTransaction(cb, undoString); add each via compoundAction.addAction(action).
 *
 * Signatures used (verified live on PPro 26.3):
 *   Project.getActiveProject(); project.getActiveSequence()/getSequences()/setActiveSequence()
 *   project.openSequence(seq); executeTransaction(cb, undo); lockedAccess(cb)
 *   sequence.getVideoTrackCount()/getVideoTrack(i)/getAudioTrack(i)/name
 *   sequence.createCloneAction(): Action
 *   track.getTrackItems(TrackItemType, includeEmpty)
 *   trackItem.getStartTime()/getEndTime()/getInPoint() -> TickTime; getProjectItem(); getName()
 *   trackItem.createMoveAction(TickTime delta): Action   ← the move primitive
 *   clipProjectItem.getMediaFilePath(): string
 *   TickTime.createWithSeconds(s); .seconds; .ticks
 *   compoundAction.addAction(action): boolean
 *
 * Verified behavior: getters may return values or Promises (we await
 * defensively); moving an item does NOT drag its linked items (callers shift
 * every member of a link group by the same delta), and A/V links — including
 * multi-track audio groups — survive clone + move.
 */

const ppro = require("premierepro");

async function val(x) { return (x && typeof x.then === "function") ? await x : x; }
function tSec(t) { return t ? t.seconds : 0; }
function tTicks(t) { return t ? String(t.ticks) : "0"; }
// Edits MUST run inside project.lockedAccess(...) or host objects go "no longer
// valid". Build/add actions synchronously inside `builder`.
async function lockedTransaction(project, label, builder) {
    if (typeof project.lockedAccess === "function") {
        let result;
        project.lockedAccess(() => { result = project.executeTransaction(builder, label); });
        return val(result);
    }
    return val(project.executeTransaction(builder, label));
}

// Best-effort, synchronous, never-throws sequence identity for clone detection.
function seqId(s) {
    try {
        if (!s) return "null";
        if (s.guid !== undefined && s.guid !== null) return (s.guid.toString) ? s.guid.toString() : String(s.guid);
        if (s.name !== undefined) return "name:" + String(s.name);
        return String(s);
    } catch (e) { return "err:" + Math.random(); }
}

async function getActiveProject() {
    if (!ppro || !ppro.Project || typeof ppro.Project.getActiveProject !== "function") {
        throw new Error('require("premierepro").Project.getActiveProject is unavailable — module shape mismatch.');
    }
    const project = await val(ppro.Project.getActiveProject());
    if (!project) throw new Error("No active project — open a project in Premiere first.");
    return project;
}

async function getActiveSequence() {
    const project = await getActiveProject();
    if (typeof project.getActiveSequence !== "function") {
        throw new Error("project.getActiveSequence is not a function — API shape mismatch (got keys: " + describe(project) + ").");
    }
    const seq = await val(project.getActiveSequence());
    if (!seq) {
        // Fall back to the project's sequence list so a freshly-opened-but-not-yet-"active"
        // timeline still resolves.
        let list = [];
        try { list = (await val(project.getSequences())) || []; } catch (e) {}
        if (list.length === 1) return list[0];
        throw new Error(
            "No active sequence. Open a sequence in the Timeline and click into it, then retry." +
            (list.length ? " (project has " + list.length + " sequences; none reported active)" : ""));
    }
    return seq;
}

// Light read for the idle poll: active sequence's name (or null), no scan.
async function getActiveSequenceName() {
    try {
        const project = await val(ppro.Project.getActiveProject());
        if (!project) return null;
        const seq = await val(project.getActiveSequence());
        if (!seq) return null;
        return String(await val(seq.name));
    } catch (e) {
        return null;
    }
}

// Rename a sequence (used to give the Build clone its "-SYNC" name). Premiere's
// UXP Sequence has no setName, but its project item does carry a rename action
// on most builds; fall back to assigning .name. Returns the name read back.
async function renameSequence(project, sequence, newName) {
    try {
        const item = await val(sequence.getProjectItem());
        if (item && typeof item.createSetNameAction === "function") {
            await lockedTransaction(project, "Syncitol: rename sequence", (compound) => {
                compound.addAction(item.createSetNameAction(newName));
            });
        }
    } catch (e) { /* fall through */ }
    let name = String(await val(sequence.name));
    if (name !== newName) {
        try { sequence.name = newName; name = String(await val(sequence.name)); } catch (e) { }
    }
    return name;
}

function describe(obj) {
    try {
        const own = Object.getOwnPropertyNames(obj || {});
        const proto = obj ? Object.getOwnPropertyNames(Object.getPrototypeOf(obj) || {}) : [];
        return [...own, ...proto].filter(k => k !== "constructor").slice(0, 25).join(", ");
    } catch (e) { return "?"; }
}

// Verified on PPro 26.3: TrackItemType = { EMPTY:0, CLIP:1, TRANSITION:2, PREVIEW:3, FEEDBACK:4 }.
const TRACK_ITEM_CLIP =
    (ppro.Constants && ppro.Constants.TrackItemType && ppro.Constants.TrackItemType.CLIP) || 1;

// ─── Read a sequence's clips ──────────────────────────────────────────────────
// Returns { name, sequence, clips:[{ filePath, clipName, trackType, trackIndex,
//   startSec, endSec, inPointSec, startTicks, item, projectItem }] }.
async function scanSequence(sequence) {
    if (!sequence) sequence = await getActiveSequence();
    if (!sequence) throw new Error("No active sequence.");
    const name = await val(sequence.name);
    const vCount = await val(sequence.getVideoTrackCount());
    const aCount = await val(sequence.getAudioTrackCount());

    // PASS 1 — for each track item, await the "cheap" async getters (these do NOT
    // invalidate the timeline snapshot) and convert every TickTime to a plain
    // number IMMEDIATELY. We deliberately do NOT call getMediaFilePath() here: it
    // yields to the host and invalidates transient TickTime/trackItem objects.
    const pending = [];
    let rawItems = 0, itemErr = 0;
    async function collect(track, trackType, trackIndex) {
        const items = track.getTrackItems(TRACK_ITEM_CLIP, false) || []; // sync
        rawItems += items.length;
        for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
            const item = items[itemIndex];
            try {
                const startT = await val(item.getStartTime());
                const startSec = tSec(startT), startTicks = tTicks(startT);
                const endSec = tSec(await val(item.getEndTime()));
                const inPointSec = tSec(await val(item.getInPoint()));
                const clipName = await val(item.getName());
                const projectItem = await val(item.getProjectItem());
                const clipPI = (projectItem && ppro.ClipProjectItem && ppro.ClipProjectItem.cast)
                    ? ppro.ClipProjectItem.cast(projectItem) : projectItem;
                pending.push({ clipPI, item, projectItem, trackType, trackIndex, itemIndex,
                    clipName, startSec, endSec, inPointSec, startTicks });
            } catch (e) {
                itemErr++;
                if (itemErr <= 3) { try { console.log("[syncitol] item error:", e && (e.message || String(e))); } catch (_) {} }
            }
        }
    }
    for (let v = 0; v < vCount; v++) await collect(await val(sequence.getVideoTrack(v)), "video", v);
    for (let a = 0; a < aCount; a++) await collect(await val(sequence.getAudioTrack(a)), "audio", a);

    // PASS 2 — resolve media paths via the durable ClipProjectItem refs only.
    const clips = [];
    let noPath = 0;
    for (const p of pending) {
        let filePath = null;
        try {
            if (p.clipPI && typeof p.clipPI.getMediaFilePath === "function") filePath = await val(p.clipPI.getMediaFilePath());
        } catch (e) {}
        if (!filePath) { noPath++; continue; }
        clips.push({
            filePath, clipName: p.clipName, trackType: p.trackType, trackIndex: p.trackIndex,
            itemIndex: p.itemIndex, startSec: p.startSec, endSec: p.endSec, inPointSec: p.inPointSec,
            startTicks: p.startTicks, item: p.item, projectItem: p.projectItem
        });
    }

    if (typeof scanSequence.onDiag === "function") {
        scanSequence.onDiag(`tracks v${vCount}/a${aCount} · raw ${rawItems} · keptClips ${clips.length} · noPath ${noPath} · itemErr ${itemErr}`);
    }
    return { name, sequence, clips };
}

async function scanActiveSequence() { return scanSequence(await getActiveSequence()); }

// ─── Apply per-clip time shifts (one undoable transaction) ────────────────────
// `targets`: [{ trackType, trackIndex, itemIndex, deltaSec }]. We match items by
// track POSITION + index — never carrying a transient trackItem ref across an
// await. Track objects are collected up front; the trackItems themselves are
// re-fetched fresh inside the (synchronous) transaction callback.
//
// Verified on PPro 26.3: createSetStartAction throws "Invalid parameter" whenever
// the new start lands inside another clip's span, so we use the DELTA-based
// createMoveAction(TickTime), which moves the
// item independently and tolerates transient overlaps. Moving an item does NOT
// drag its linked audio/video along — callers must shift every item of a group.
// IMPORTANT: `project` and `sequence` must come from the SAME getActiveProject()
// call — mixing wrappers from different calls makes host objects "no longer valid".
async function applyStarts(project, sequence, targets, undoLabel) {
    if (!targets.length) return 0;
    const step = (m) => { try { console.log("[apply] " + m); } catch (e) {} if (typeof applyStarts.onStep === "function") applyStarts.onStep(m); };
    const byTrack = new Map(); // "type:index" -> Map(itemIndex -> deltaSec)
    let skippedBad = 0;
    for (const t of targets) {
        if (!isFinite(t.deltaSec)) { skippedBad++; continue; }
        const k = `${t.trackType}:${t.trackIndex}`;
        if (!byTrack.has(k)) byTrack.set(k, new Map());
        byTrack.get(k).set(t.itemIndex, t.deltaSec);
    }
    {
        const fv = targets.map(t => t.deltaSec).filter(isFinite);
        step(`targets ${targets.length} · bad ${skippedBad} · Δmin ${fv.length ? Math.min.apply(null, fv).toFixed(2) : "-"} · Δmax ${fv.length ? Math.max.apply(null, fv).toFixed(2) : "-"}`);
    }
    const vCount = await val(sequence.getVideoTrackCount());
    const aCount = await val(sequence.getAudioTrackCount());
    const tracks = [];
    for (let v = 0; v < vCount; v++) tracks.push({ track: await val(sequence.getVideoTrack(v)), type: "video", index: v });
    for (let a = 0; a < aCount; a++) tracks.push({ track: await val(sequence.getAudioTrack(a)), type: "audio", index: a });

    let applied = 0, failVal = null, failMsg = null, failStage = null;
    const perTrack = [];
    await lockedTransaction(project, undoLabel || "Syncitol", (compound) => {
        for (const { track, type, index } of tracks) {
            const map = byTrack.get(`${type}:${index}`);
            if (!map || !map.size) continue;
            const items = track.getTrackItems(TRACK_ITEM_CLIP, false) || []; // sync
            let trackApplied = 0;
            for (let i = 0; i < items.length; i++) {
                if (!map.has(i)) continue;
                const dSec = map.get(i);
                let delta;
                try { delta = ppro.TickTime.createWithSeconds(dSec); }
                catch (e) { if (failVal === null) { failVal = dSec; failStage = "createWithSeconds"; failMsg = e && (e.message || String(e)); } continue; }
                try { compound.addAction(items[i].createMoveAction(delta)); applied++; trackApplied++; }
                catch (e) { if (failVal === null) { failVal = dSec; failStage = "createMoveAction"; failMsg = e && (e.message || String(e)); } }
            }
            perTrack.push(`${type}${index}: items=${items.length} wanted=${map.size} added=${trackApplied}`);
        }
    });
    step("tracks: " + perTrack.join(" | "));
    if (failVal !== null) step(`first error @ ${failStage} Δ=${failVal}: ${failMsg}`);
    return applied;
}

// Match shifts (filePath|startTicks -> deltaSec) to scanned clips, then move them
// by track position.
async function applyShifts(shifts, opts) {
    opts = opts || {};
    const project = await getActiveProject();
    const sequence = await val(project.getActiveSequence());
    const scan = await scanSequence(sequence);
    const byKey = new Map();
    for (const s of shifts) byKey.set(`${s.filePath}|${s.startTicks}`, s.deltaSec);

    const targets = [];
    for (const c of scan.clips) {
        const d = byKey.get(`${c.filePath}|${c.startTicks}`);
        if (d === undefined || Math.abs(d) < 0.0005) continue;
        if (c.startSec + d < 0) continue; // never move a clip before t=0
        targets.push({ trackType: c.trackType, trackIndex: c.trackIndex, itemIndex: c.itemIndex, deltaSec: d });
    }
    const applied = await applyStarts(project, sequence, targets, "Syncitol: align clips");
    return { applied, total: targets.length };
}

// ─── Build a synced sequence ──────────────────────────────────────────────────
// Clone the active sequence (preserves track layout + A/V links), make it active,
// then reposition every clip to its record-time offset in ONE transaction.
// `recordStartByPath`: { filePath -> recordStartMs }; globalEarliestMs anchors t=0.
async function buildSyncSequence(recordStartByPath, globalEarliestMs, baseName) {
    const step = (m) => { try { console.log("[build] " + m); } catch (e) {} if (typeof buildSyncSequence.onStep === "function") buildSyncSequence.onStep(m); };

    step("1 getActiveProject");
    const project = await getActiveProject();
    step("2 getSequences (before)");
    const before = await val(project.getSequences());
    const beforeIds = new Set(before.map(s => seqId(s)));

    step("3 getActiveSequence");
    const active = await val(project.getActiveSequence());
    step("4 clone transaction");
    await lockedTransaction(project, "Syncitol: clone for sync", (compound) => {
        compound.addAction(active.createCloneAction());
    });

    // Find the newly created sequence.
    step("5 getSequences (after) + find clone");
    const after = await val(project.getSequences());
    let clone = after.find(s => !beforeIds.has(seqId(s)));
    if (!clone) clone = active; // fallback: clone became active in place
    step("6 setActiveSequence(clone)");
    try { await val(project.openSequence(clone)); } catch (e) {} // surface its timeline tab
    try { await val(project.setActiveSequence(clone)); } catch (e) {}

    // Reposition clips in the clone by record time.
    step("7 scan clone");
    const scan = await scanSequence(clone);
    step("8 applyStarts (" + scan.clips.length + " clips)");
    const targets = [];
    for (const c of scan.clips) {
        const rs = recordStartByPath[c.filePath];
        if (rs === undefined || rs === null) continue;
        const targetSec = (rs - globalEarliestMs) / 1000;
        if (Math.abs(targetSec - c.startSec) < 0.001) continue;
        targets.push({ trackType: c.trackType, trackIndex: c.trackIndex, itemIndex: c.itemIndex, deltaSec: targetSec - c.startSec });
    }
    const moved = await applyStarts(project, clone, targets, "Syncitol: place by record time");
    return { sequence: clone, name: await val(clone.name), placed: moved, total: scan.clips.length };
}

// File modification time (ms) — fallback record-start source when a file carries
// no embedded creation_time/modification_date. UXP fs is promise-based with
// fullAccess (manifest). Returns null on any failure (it's only a fallback).
async function statMtimeMs(filePath) {
    try {
        const fs = require("fs"); // verified on PPro 26.3: lstat resolves { mtime: <epoch ms number>, ... }
        const stats = await fs.lstat(filePath);
        const m = stats && (stats.mtime || stats.mtimeMs);
        if (m === undefined || m === null) return null;
        return (m instanceof Date) ? m.getTime() : Number(m);
    } catch (e) {
        return null;
    }
}

module.exports = {
    getActiveProject, getActiveSequence, getActiveSequenceName, renameSequence,
    scanSequence, scanActiveSequence,
    applyStarts, applyShifts, buildSyncSequence, statMtimeMs
};

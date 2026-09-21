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
const dsp = require("./dsp");

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
//   startSec, endSec, inPointSec, startTicks, item, projectItem }], dropped }.
// `dropped` counts the timeline items this scan could NOT represent — an item
// whose getters threw, or whose media path would not resolve. Those items are
// invisible to every later step, so if one of them is the audio half of a link
// group its video half moves without it. Callers surface a non-zero count.
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
    const opaque = [];   // readable position, unreadable identity — see below
    let noPath = 0;
    for (const p of pending) {
        let filePath = null;
        try {
            if (p.clipPI && typeof p.clipPI.getMediaFilePath === "function") filePath = await val(p.clipPI.getMediaFilePath());
        } catch (e) {}
        if (!filePath) {
            noPath++;
            // We know exactly WHERE this item is and how to address it (track +
            // index), just not which file it came from. That is enough to carry
            // it along with a linked partner, which is the difference between a
            // silent tear and an intact clip — so keep it.
            opaque.push({
                clipName: p.clipName, trackType: p.trackType, trackIndex: p.trackIndex,
                itemIndex: p.itemIndex, startSec: p.startSec, endSec: p.endSec
            });
            continue;
        }
        clips.push({
            filePath, clipName: p.clipName, trackType: p.trackType, trackIndex: p.trackIndex,
            itemIndex: p.itemIndex, startSec: p.startSec, endSec: p.endSec, inPointSec: p.inPointSec,
            startTicks: p.startTicks, item: p.item, projectItem: p.projectItem
        });
    }

    if (typeof scanSequence.onDiag === "function") {
        scanSequence.onDiag(`tracks v${vCount}/a${aCount} · raw ${rawItems} · keptClips ${clips.length} · noPath ${noPath} · itemErr ${itemErr}`);
    }
    return { name, sequence, clips, opaque, dropped: { noPath, itemErr, raw: rawItems } };
}

async function scanActiveSequence() { return scanSequence(await getActiveSequence()); }

// ─── Track inventory (reference-track picker) ─────────────────────────────────
// Light read for the panel's audio-reference dropdown: which tracks carry clips,
// how many, the track's own name when the host exposes one, and the first clip's
// name so a track is recognizable ("A3 · REC_0042.wav"). Deliberately cheaper
// than scanSequence — it never calls getMediaFilePath(), the expensive getter
// that yields to the host — so it is safe to run whenever the active sequence
// changes. Returns { name, tracks:[{ key, trackType, trackIndex, trackName,
// clipCount, firstClipName }] } with EVERY track, empty ones included (the
// caller filters).
async function listTracks(sequence) {
    if (!sequence) sequence = await getActiveSequence();
    const name = await val(sequence.name);
    const vCount = await val(sequence.getVideoTrackCount());
    const aCount = await val(sequence.getAudioTrackCount());
    const tracks = [];

    async function collect(track, trackType, trackIndex) {
        let clipCount = 0;
        let firstClipName = null;
        let trackName = null;
        let items = [];
        try { items = track.getTrackItems(TRACK_ITEM_CLIP, false) || []; } catch (e) {} // sync
        clipCount = items.length;
        if (items.length) {
            try { const n = await val(items[0].getName()); if (n) firstClipName = String(n); } catch (e) {}
        }
        // Track.name is a plain property on PPro 26.x; getName() exists on some
        // builds. Either is optional — the caller falls back to "V1"/"A1".
        try {
            let n = await val(track.name);
            if (!n && typeof track.getName === "function") n = await val(track.getName());
            if (n) trackName = String(n);
        } catch (e) {}
        tracks.push({
            key: `${trackType}_${trackIndex}`, trackType, trackIndex,
            trackName, clipCount, firstClipName
        });
    }

    for (let v = 0; v < vCount; v++) await collect(await val(sequence.getVideoTrack(v)), "video", v);
    for (let a = 0; a < aCount; a++) await collect(await val(sequence.getAudioTrack(a)), "audio", a);
    return { name, tracks };
}

async function listActiveSequenceTracks() { return listTracks(await getActiveSequence()); }

// ─── Apply per-clip time shifts (one undoable transaction) ────────────────────
// `targets`: [{ filePath, trackType, trackIndex, itemIndex, deltaSec }]. We match
// items by
// track POSITION + index — never carrying a transient trackItem ref across an
// await — and group them by filePath so a file moves as one piece or not at all. Track objects are collected up front; the trackItems themselves are
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
    if (!targets.length) return { applied: 0, requested: 0, skipped: [], partial: [] };
    const step = (m) => { try { console.log("[apply] " + m); } catch (e) {} if (typeof applyStarts.onStep === "function") applyStarts.onStep(m); };
    const msgOf = (e) => (e && (e.message || String(e))) || "unknown error";

    // Group by FILE first: a file's instances move together or not at all. Moving
    // only some of them is what tears a clip's video from its linked audio, and
    // it is never better than leaving that file unsynced.
    const byFile = new Map();  // filePath -> [target]
    let skippedBad = 0;
    for (const t of targets) {
        if (!isFinite(t.deltaSec)) { skippedBad++; continue; }
        const key = t.filePath || `${t.trackType}:${t.trackIndex}:${t.itemIndex}`;
        if (!byFile.has(key)) byFile.set(key, []);
        byFile.get(key).push(t);
    }
    {
        const fv = targets.map(t => t.deltaSec).filter(isFinite);
        step(`targets ${targets.length} · files ${byFile.size} · bad ${skippedBad} · Δmin ${fv.length ? Math.min.apply(null, fv).toFixed(2) : "-"} · Δmax ${fv.length ? Math.max.apply(null, fv).toFixed(2) : "-"}`);
    }

    const needed = new Set(targets.map(t => `${t.trackType}:${t.trackIndex}`));
    const tracks = [];
    const vCount = await val(sequence.getVideoTrackCount());
    const aCount = await val(sequence.getAudioTrackCount());
    for (let v = 0; v < vCount; v++) {
        if (needed.has(`video:${v}`)) tracks.push({ track: await val(sequence.getVideoTrack(v)), key: `video:${v}` });
    }
    for (let a = 0; a < aCount; a++) {
        if (needed.has(`audio:${a}`)) tracks.push({ track: await val(sequence.getAudioTrack(a)), key: `audio:${a}` });
    }

    let applied = 0;
    const skipped = [];   // [{ filePath, instances, reason }] — nothing was moved
    const partial = [];   // [{ filePath, instances, added }] — the host refused mid-file
    await lockedTransaction(project, undoLabel || "Syncitol", (compound) => {
        const itemsByTrack = new Map();
        for (const { track, key } of tracks) {
            itemsByTrack.set(key, track.getTrackItems(TRACK_ITEM_CLIP, false) || []); // sync
        }

        for (const [filePath, list] of byFile) {
            // Phase 1 — build every action for this file. Any failure and the
            // whole file is left alone.
            const actions = [];
            let reason = null;
            for (const t of list) {
                const items = itemsByTrack.get(`${t.trackType}:${t.trackIndex}`) || [];
                const item = items[t.itemIndex];
                if (!item) {
                    reason = `its ${t.trackType} ${t.trackIndex + 1} item is no longer at index ${t.itemIndex}`;
                    break;
                }
                let delta;
                try { delta = ppro.TickTime.createWithSeconds(t.deltaSec); }
                catch (e) { reason = `TickTime(${t.deltaSec}s) rejected: ${msgOf(e)}`; break; }
                try { actions.push(item.createMoveAction(delta)); }
                catch (e) { reason = `move action rejected on ${t.trackType} ${t.trackIndex + 1}: ${msgOf(e)}`; break; }
            }
            if (reason) {
                skipped.push({ filePath, instances: list.length, reason });
                continue;
            }

            // Phase 2 — queue them. addAction returns a boolean, and a false
            // means the host dropped that one move: the file would come out
            // half-shifted, which is precisely how a clip's audio ends up hanging
            // off its video. Actions cannot be pulled back out of a compound, but
            // a move is a DELTA, so queueing the inverse for everything already
            // accepted nets the file back to zero. The file ends up unsynced and
            // said so in the log — which beats a silent tear every time.
            let added = 0;
            let refused = false;
            for (let ai = 0; ai < actions.length; ai += 1) {
                let ok = true;
                try { ok = compound.addAction(actions[ai]); }
                catch (e) { ok = false; }
                if (ok === false) { refused = true; break; }
                added += 1;
            }
            if (refused) {
                let undone = 0;
                for (let ui = 0; ui < added; ui += 1) {
                    try {
                        const back = list[ui].deltaSec;
                        const items = itemsByTrack.get(`${list[ui].trackType}:${list[ui].trackIndex}`) || [];
                        const item = items[list[ui].itemIndex];
                        if (!item) continue;
                        if (compound.addAction(item.createMoveAction(ppro.TickTime.createWithSeconds(-back))) !== false) undone += 1;
                    } catch (e) { /* counted below */ }
                }
                if (undone === added) {
                    skipped.push({
                        filePath, instances: list.length,
                        reason: `the host refused one of its ${list.length} moves, so the whole file was rolled back to keep its A/V together`
                    });
                } else {
                    // Could not take them all back — the post-apply read-back is
                    // the safety net, and it repairs what it can.
                    applied += added;
                    partial.push({ filePath, instances: actions.length, added });
                }
                continue;
            }
            applied += added;
        }
    });

    step(`applied ${applied} · skipped files ${skipped.length} · partial files ${partial.length}`);
    for (const sk of skipped.slice(0, 5)) step(`skipped ${sk.filePath}: ${sk.reason}`);
    return { applied, requested: targets.length, skipped, partial };
}

// Read the timeline back after an apply and confirm every file moved as ONE
// piece. This is the only way to catch a move the host accepted and then did not
// perform (or performed differently) — the failure mode that silently pulls a
// clip's video away from its linked audio. Pure comparison lives in dsp.js.
async function verifyMovement(sequence, beforeClips, deltaByPath) {
    const after = await scanSequence(sequence);
    const report = dsp.diffInstanceMovement(beforeClips, after.clips, deltaByPath, 0.001);
    report.dropped = after.dropped;
    return report;
}

// Put a torn file back together. Detection on its own still leaves the user
// with a broken timeline and a note about it, so this is the part that acts:
//
//   1. COMPLETE — nudge the instances that did not make it the rest of the way.
//      If the host takes them, the file is both intact and synced.
//   2. RESTORE  — if a tear survives that, move every instance of the file back
//      to where it started. Unsynced but whole; the user can retry after
//      unlocking the track or clearing whatever blocked the landing.
//
// Each attempt is its own transaction, so each is its own undo step — a user
// undoing a repaired sync by hand needs one Ctrl/Cmd+Z per attempt. Returns
// { attempts, repaired, restored, integrity }, where `integrity` is the
// read-back after the last attempt: its `torn` list is what survived.
// Costs nothing when nothing tore — it returns before the first re-scan.
async function repairTornFiles(project, sequence, beforeClips, deltaByPath, integrity, minMoveSec) {
    const floor = (minMoveSec === undefined) ? dsp.TEAR_REPAIR_MIN_SEC : minMoveSec;
    const outcome = { attempts: [], repaired: [], restored: [], integrity };
    let current = integrity;
    let pending = (current.torn || []).filter(t => t.spreadSec > floor);
    if (!pending.length) return outcome;

    for (const mode of ["complete", "restore"]) {
        // Always re-plan from the LATEST report: after an attempt the instances
        // have moved, so last round's numbers no longer describe them.
        const targets = dsp.planTearRepair(pending, mode, floor);
        if (!targets.length) break;
        const before = pending.map(t => t.filePath);

        // planTearRepair addresses items individually on purpose — the whole
        // point is to move one file's instances by DIFFERENT amounts so they end
        // up level — so applyStarts' per-file all-or-nothing grouping must not
        // apply here. A unique key per target switches it off.
        const result = await applyStarts(
            project, sequence,
            targets.map((t, i) => Object.assign({}, t, { filePath: `${t.filePath}#repair${i}` })),
            mode === "complete" ? "Syncitol: repair A/V sync" : "Syncitol: restore torn clips");

        // Re-read the timeline and re-run the same comparison that found the
        // tear, against the same original positions, so "fixed" means fixed by
        // the one measure that matters.
        current = await verifyMovement(sequence, beforeClips, deltaByPath);
        pending = (current.torn || []).filter(t => t.spreadSec > floor);
        const stillTorn = new Set(pending.map(t => t.filePath));
        for (const filePath of before) {
            if (stillTorn.has(filePath)) continue;
            (mode === "complete" ? outcome.repaired : outcome.restored).push(filePath);
        }
        outcome.attempts.push({
            mode, targets: targets.length, applied: result.applied,
            fixed: before.length - pending.length
        });
        if (!pending.length) break;
    }

    outcome.integrity = current;
    return outcome;
}

// Put every clip's sound back under its picture.
//
// The movement check (diffInstanceMovement) asks whether a file's instances
// moved by the same amount. That is the right question about a move and the
// wrong one about the timeline: instances can move together and still be in the
// wrong place relative to each other, and a host that clamps or drops one move
// — a destination blocked by a neighbour on THAT track but clear on the other —
// produces exactly that. So after every apply we also look at where the video
// and audio of each file actually sit, and slide the audio back under the
// picture where they have come apart.
//
// Only files this apply broke are touched. A clip that arrived out of step is
// reported, not silently "corrected" — that offset may well be deliberate.
async function mendLinkAlignment(project, sequence, beforeAudit) {
    const after = await scanSequence(sequence);
    const afterAudit = dsp.auditLinkAlignment(after.clips);
    const diff = dsp.diffLinkAlignment(beforeAudit, afterAudit);
    const broke = diff.created.concat(diff.worsened);

    const out = {
        before: beforeAudit, after: afterAudit,
        created: diff.created, worsened: diff.worsened, preexisting: diff.preexisting,
        mended: [], remaining: []
    };
    if (!broke.length) return out;

    const targets = dsp.planLinkRepair(broke);
    if (!targets.length) return out;

    // Each move is its own all-or-nothing group: these are corrections to
    // individual items, not a file moving as one piece.
    await applyStarts(
        project, sequence,
        targets.map((t, i) => Object.assign({}, t, { filePath: `${t.filePath}#link${i}` })),
        "Syncitol: re-align clip audio");

    const settled = await scanSequence(sequence);
    const settledAudit = dsp.auditLinkAlignment(settled.clips);
    const stillOff = new Set(settledAudit.misaligned.map(m => m.filePath));
    for (const m of broke) {
        (stillOff.has(m.filePath) ? out.remaining : out.mended).push(m);
    }
    out.after = settledAudit;
    return out;
}

// The one road every move takes: plan the link groups, apply, read the timeline
// back, and repair anything that came apart. `deltaByPath` is one delta per
// source FILE; `scan` is the scan those deltas were computed against.
//
// The link-group step is what covers the A/V the per-file rule cannot see: a
// video item linked to audio from a DIFFERENT file (merged clips, Synchronize,
// a manual Clip > Link) and items whose media path would not resolve. Both used
// to be moved apart from their partners, silently.
const MIN_MOVE_SEC = 0.0005;

async function planApplyVerify(project, sequence, scan, deltaByPath, undoLabel) {
    const plan = dsp.planLinkGroups(scan.clips, scan.opaque, deltaByPath, 0.002);
    // Where every clip's sound sat relative to its picture BEFORE we touched
    // anything, so afterwards we can tell what this apply broke from what it
    // merely inherited.
    const beforeAudit = dsp.auditLinkAlignment(scan.clips);

    // t=0 guard per FILE, run on the POST-plan deltas: unifying a group can
    // change where a file lands. If any instance would go before zero, the whole
    // file stays put — moving only some of its instances is the split we are
    // here to prevent. And because a unified group only holds together while all
    // of it moves, blocking one member blocks the group, which can block a file
    // shared with another group: settle that before building any targets.
    const blocked = new Set();
    for (const c of scan.clips) {
        const d = plan.deltas[c.filePath];
        if (d !== undefined && c.startSec + d < 0) blocked.add(c.filePath);
    }
    for (let pass = 0; pass < plan.unified.length + 1; pass += 1) {
        let grew = false;
        for (const g of plan.unified) {
            if (!g.paths.some(fp => blocked.has(fp))) continue;
            for (const fp of g.paths) { if (!blocked.has(fp)) { blocked.add(fp); grew = true; } }
        }
        if (!grew) break;
    }

    const targets = [];
    const requestedByPath = {};
    for (const c of scan.clips) {
        if (blocked.has(c.filePath)) continue;
        const d = plan.deltas[c.filePath];
        if (d === undefined || Math.abs(d) < MIN_MOVE_SEC) continue;
        targets.push({ filePath: c.filePath, trackType: c.trackType, trackIndex: c.trackIndex, itemIndex: c.itemIndex, deltaSec: d });
        requestedByPath[c.filePath] = d;
    }
    // Unreadable items travelling with a linked partner. They are keyed by their
    // position so applyStarts can still address them; they have no file path, so
    // the read-back cannot check them — moving them is the whole win.
    for (const t of plan.opaqueTargets) {
        if ((t.groupPaths || []).some(fp => blocked.has(fp))) continue;
        targets.push({
            // Keyed by the file it travels with, so applyStarts treats the pair
            // as one all-or-nothing move. A group of its own could be refused on
            // its own and leave its partner behind — the exact split we are here
            // to prevent.
            filePath: t.anchorPath || `opaque:${t.trackType}:${t.trackIndex}:${t.itemIndex}`,
            trackType: t.trackType, trackIndex: t.trackIndex, itemIndex: t.itemIndex, deltaSec: t.deltaSec
        });
    }

    const result = await applyStarts(project, sequence, targets, undoLabel);
    // Files applyStarts refused were never moved, so they are not expected to
    // have shifted — drop them from the verification set.
    for (const sk of result.skipped) delete requestedByPath[sk.filePath];

    let integrity = await verifyMovement(sequence, scan.clips, requestedByPath);
    const repair = await repairTornFiles(project, sequence, scan.clips, requestedByPath, integrity);
    integrity = repair.integrity;

    const links = await mendLinkAlignment(project, sequence, beforeAudit);

    return {
        applied: result.applied, total: targets.length,
        skipped: result.skipped, partial: result.partial,
        integrity, repair, links, linkPlan: plan, scanDropped: scan.dropped
    };
}

// Match shifts (filePath -> deltaSec) to scanned clips, then move them by track
// position. EVERY timeline instance of a file gets the same delta — a clip's
// video and its linked audio must never move separately.
async function applyShifts(shifts, opts) {
    opts = opts || {};
    const project = await getActiveProject();
    const sequence = await val(project.getActiveSequence());
    const scan = await scanSequence(sequence);
    const deltaByPath = {};
    for (const s of shifts) deltaByPath[s.filePath] = s.deltaSec;
    return planApplyVerify(project, sequence, scan, deltaByPath, "Syncitol: align clips");
}

// ─── Build a synced sequence ──────────────────────────────────────────────────
// Clone the active sequence (preserves track layout + A/V links), make it active,
// then reposition every clip to its record-time offset in ONE transaction.
// `clipPayload`: array of { filePath, trackType, trackIndex, recordStartMs, durationSec, … }
//
// Where a track's anchor sits is dsp.planBuildAnchors' decision: tracks whose
// recordings overlap in clock time corroborate each other, so they share one
// anchor and land at their true offsets from each other; a track nobody can
// vouch for anchors to its own earliest clip and starts at 0:00, which keeps a
// device with a wrong clock (factory reset, dead battery) from pushing
// correctly-dated clips beyond 24 h. Either way the audio coarse + fine passes
// have the last word — a shared anchor just starts them much closer in.
const MAX_SPAN_SEC = 86400; // Premiere timelines cannot exceed 24 hours
const MIN_PLACE_SEC = 0.001; // below this, a build placement delta is "already placed"

async function buildSyncSequence(clipPayload, baseName) {
    const step = (m) => { try { console.log("[build] " + m); } catch (e) {} if (typeof buildSyncSequence.onStep === "function") buildSyncSequence.onStep(m); };

    step("1 getActiveProject");
    const project = await getActiveProject();
    step("2 getSequences (before)");
    const before = await val(project.getSequences());
    const beforeIds = new Set(before.map(s => seqId(s)));

    step("3 getActiveSequence");
    const active = await val(project.getActiveSequence());

    // ── Per-track earliest recording ─────────────────────────────────────────
    // Where each track's 0:00 sits. Pure and deterministic, so the panel can run
    // the same plan when it draws the Detected Clips table and get the same
    // answer without having to be handed this one.
    const trackKeyOf = (c) => `${c.trackType}_${c.trackIndex}`;
    const layout = dsp.planBuildAnchors(clipPayload);
    const trackEarliestMs = layout.anchorMsByTrack;
    step(`layout: ${layout.groups.length} shared-clock group(s), ${layout.ungrouped.length} track(s) on their own`);

    // ── 24-hour span guard (per track) ───────────────────────────────────────
    for (const c of clipPayload) {
        const tk = trackKeyOf(c);
        const endSec = (c.recordStartMs - trackEarliestMs[tk]) / 1000 + (c.durationSec || 0);
        if (endSec > MAX_SPAN_SEC) {
            const typeLabel = c.trackType === "video" ? "Video" : "Audio";
            throw new Error(
                `${typeLabel} track ${c.trackIndex + 1} spans ${Math.round(endSec / 3600)}h — ` +
                `exceeds Premiere's 24-hour maximum. Process one recording day at a time.`);
        }
    }

    // ── Clone + resolve ──────────────────────────────────────────────────────
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

    // clipPayload is one entry per source FILE (video-preferred), so its own
    // track key is always present in trackEarliestMs.
    const entryByPath = {};
    for (const c of clipPayload) {
        if (!(c.filePath in entryByPath)) entryByPath[c.filePath] = c;
    }

    // Reposition by record time with ONE delta per FILE: anchor each file to
    // its payload track's earliest recording, derive the delta from the file's
    // primary timeline instance, then move EVERY instance of that file by that
    // same delta. Moving instances rigidly keeps a clip's video and its linked
    // audio together — anchoring each timeline track independently (v1.1.0)
    // skipped or misplaced camera audio on tracks the deduped payload never
    // mentioned, splitting A/V.
    step("7 scan clone");
    const scan = await scanSequence(clone);

    // Primary instance per file: earliest instance on the payload entry's own
    // track; fallback to the earliest instance on any track.
    const primaryByPath = {};
    for (const c of scan.clips) {
        const entry = entryByPath[c.filePath];
        if (!entry) continue;
        const onEntryTrack = c.trackType === entry.trackType && c.trackIndex === entry.trackIndex;
        const cur = primaryByPath[c.filePath];
        if (!cur || (onEntryTrack && !cur.onEntryTrack) ||
            (onEntryTrack === cur.onEntryTrack && c.startSec < cur.startSec)) {
            primaryByPath[c.filePath] = { startSec: c.startSec, onEntryTrack };
        }
    }

    const deltaByPath = {};
    for (const path in entryByPath) {
        const entry = entryByPath[path];
        const primary = primaryByPath[path];
        if (!primary) continue; // file not present in the clone
        const targetSec = (entry.recordStartMs - trackEarliestMs[trackKeyOf(entry)]) / 1000;
        deltaByPath[path] = targetSec - primary.startSec;
    }

    step("8 applyStarts (" + scan.clips.length + " clips)");
    // Drop placements too small to be worth a move before the link-group pass
    // sees them, so a sub-millisecond delta cannot look like a disagreement.
    const placements = {};
    for (const path in deltaByPath) {
        if (Math.abs(deltaByPath[path]) >= MIN_PLACE_SEC) placements[path] = deltaByPath[path];
    }
    const applied = await planApplyVerify(project, clone, scan, placements, "Syncitol: place by record time");
    return {
        sequence: clone, name: await val(clone.name), placed: applied.applied, total: scan.clips.length,
        skipped: applied.skipped, partial: applied.partial,
        integrity: applied.integrity, repair: applied.repair, linkPlan: applied.linkPlan,
        layout, scanDropped: applied.scanDropped
    };
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
    scanSequence, scanActiveSequence, listTracks, listActiveSequenceTracks,
    applyStarts, applyShifts, buildSyncSequence, verifyMovement, repairTornFiles,
    mendLinkAlignment, statMtimeMs
};

/**
 * Syncitol — ExtendScript (sync.jsx)
 * Runs inside Premiere Pro's scripting engine.
 * Called from the CEP panel via CSInterface.evalScript()
 */

// ─── Constants ──────────────────────────────────────────────────────────────
// Premiere's internal timebase: ticks per second.
var TICKS_PER_SECOND = 254016000000;
// Premiere timelines cannot exceed 24 hours; a track spanning more is rejected.
var MAX_SPAN_SEC = 86400;
// Below this (seconds) a fine-tune move is treated as "already aligned".
var MIN_MOVE_SEC = 0.0001;
// Below this (seconds) a build placement delta is treated as "already placed".
var MIN_PLACE_SEC = 0.0005;

// ─── Helpers ────────────────────────────────────────────────────────────────

function ticksToSeconds(ticks) {
    return ticks / TICKS_PER_SECOND;
}

function secondsToTicks(seconds) {
    return seconds * TICKS_PER_SECOND;
}

function timeToSeconds(timeObj) {
    if (!timeObj) return 0;
    if (timeObj.seconds !== undefined && timeObj.seconds !== null && timeObj.seconds !== "") {
        return Number(timeObj.seconds);
    }
    if (timeObj.ticks !== undefined && timeObj.ticks !== null && timeObj.ticks !== "") {
        return ticksToSeconds(Number(timeObj.ticks));
    }
    return 0;
}

/** Return name and basic stats of the active sequence (for UI display) */
function getActiveSequenceInfo() {
    try {
        return _getActiveSequenceInfoImpl();
    } catch (e) {
        return JSON.stringify({
            error: "Failed to read active sequence info: " + e.message + " (line " + e.line + ")"
        });
    }
}

function _getActiveSequenceInfoImpl() {
    var seq = app.project.activeSequence;
    if (!seq) return JSON.stringify({ error: "No active sequence open." });
    var videoCount = 0, audioCount = 0;
    for (var v = 0; v < seq.videoTracks.numTracks; v++) {
        videoCount += seq.videoTracks[v].clips.numItems;
    }
    for (var a = 0; a < seq.audioTracks.numTracks; a++) {
        audioCount += seq.audioTracks[a].clips.numItems;
    }
    return JSON.stringify({
        name:        seq.name,
        videoTracks: seq.videoTracks.numTracks,
        audioTracks: seq.audioTracks.numTracks,
        videoClips:  videoCount,
        audioClips:  audioCount
    });
}

/**
 * Collect clip info from the active sequence.
 * Returns a JSON string: array of { filePath, trackIndex, trackType, clipName, durationTicks }
 * The panel's Node.js layer will stat() each file for mtime.
 */
function getClipFileInfo() {
    try {
        return _getClipFileInfoImpl();
    } catch (e) {
        return JSON.stringify({
            error: "Failed to read clip file info: " + e.message + " (line " + e.line + ")"
        });
    }
}

function _getClipFileInfoImpl() {
    var seq = app.project.activeSequence;
    if (!seq) return JSON.stringify({ error: "No active sequence." });

    var result = [];
    var seenPaths = [];
    // Clips we could not read (offline media, placeholders, no media path).
    // Reported so missing clips don't just silently vanish from the scan.
    var skipped = 0;

    function alreadySeen(p) {
        for (var i = 0; i < seenPaths.length; i++) {
            if (seenPaths[i] === p) return true;
        }
        return false;
    }

    function findLinkedAudioTrackIndex(filePath, startTicks) {
        for (var ai = 0; ai < seq.audioTracks.numTracks; ai++) {
            var audioTrack = seq.audioTracks[ai];
            for (var aci = 0; aci < audioTrack.clips.numItems; aci++) {
                var audioClip = audioTrack.clips[aci];
                try {
                    if (audioClip.projectItem.getMediaPath() === filePath &&
                        String(audioClip.start.ticks) === String(startTicks)) {
                        return ai;
                    }
                } catch (e) {}
            }
        }
        return -1;
    }

    // Iterate video tracks
    for (var v = 0; v < seq.videoTracks.numTracks; v++) {
        var track = seq.videoTracks[v];
        for (var c = 0; c < track.clips.numItems; c++) {
            var clip = track.clips[c];
            try {
                var filePath = clip.projectItem.getMediaPath();
                if (!filePath) { skipped++; continue; }
                if (!alreadySeen(filePath)) {
                    seenPaths.push(filePath);
                    result.push({
                        filePath:      filePath,
                        clipName:      clip.name,
                        trackIndex:    v,
                        trackType:     "video",
                        audioTrackIndex: findLinkedAudioTrackIndex(filePath, clip.start.ticks),
                        durationTicks: clip.duration.ticks
                    });
                }
            } catch (e) { skipped++; /* offline/placeholder clip */ }
        }
    }

    // Iterate audio-only tracks (no linked video counterpart)
    for (var a = 0; a < seq.audioTracks.numTracks; a++) {
        var atrack = seq.audioTracks[a];
        for (var ac = 0; ac < atrack.clips.numItems; ac++) {
            var aclip = atrack.clips[ac];
            try {
                var aPath = aclip.projectItem.getMediaPath();
                if (!aPath) { skipped++; continue; }
                if (!alreadySeen(aPath)) {
                    seenPaths.push(aPath);
                    result.push({
                        filePath:      aPath,
                        clipName:      aclip.name,
                        trackIndex:    a,
                        trackType:     "audio",
                        durationTicks: aclip.duration.ticks
                    });
                }
            } catch (e) { skipped++; }
        }
    }

    return JSON.stringify({ clips: result, skipped: skipped });
}

/**
 * Collect timeline clip data for audio fine-tuning.
 * Returns all visible clip instances from video + audio tracks.
 */
function getFineTuneClipInfo() {
    try {
        return _getFineTuneClipInfoImpl();
    } catch (e) {
        return JSON.stringify({
            error: "Failed to inspect active sequence for fine tune: " + e.message + " (line " + e.line + ")"
        });
    }
}

function _getFineTuneClipInfoImpl() {
    var seq = app.project.activeSequence;
    if (!seq) return JSON.stringify({ error: "No active sequence." });

    var result = [];
    var skipped = 0;

    function collect(trackCollection, trackType) {
        for (var t = 0; t < trackCollection.numTracks; t++) {
            var track = trackCollection[t];
            for (var c = 0; c < track.clips.numItems; c++) {
                var clip = track.clips[c];
                try {
                    var filePath = clip.projectItem.getMediaPath();
                    if (!filePath) { skipped++; continue; }

                    result.push({
                        clipName:   clip.name,
                        filePath:   filePath,
                        trackType:  trackType,
                        trackIndex: t,
                        startSec:   timeToSeconds(clip.start),
                        endSec:     timeToSeconds(clip.end),
                        inPointSec: timeToSeconds(clip.inPoint),
                        startTicks: String(clip.start.ticks)
                    });
                } catch (e) { skipped++; }
            }
        }
    }

    collect(seq.videoTracks, "video");
    collect(seq.audioTracks, "audio");

    return JSON.stringify({ clips: result, skipped: skipped });
}

/**
 * Apply fine-tune shifts to matching timeline clips.
 * adjustmentsJSON: either the legacy array [{ filePath, startTicks, deltaSec }]
 * or { globalShiftSec, adjustments } where globalShiftSec moves EVERY clip
 * (used by the panel's Revert to undo a previous boundary compensation).
 */
function applyFineTuneAdjustments(adjustmentsJSON) {
    try {
        return _applyFineTuneAdjustmentsImpl(adjustmentsJSON);
    } catch (e) {
        return JSON.stringify({
            error: "Failed to apply fine tune adjustments: " + e.message + " (line " + e.line + ")"
        });
    }
}

function _applyFineTuneAdjustmentsImpl(adjustmentsJSON) {
    var payload;
    try {
        payload = JSON.parse(adjustmentsJSON);
    } catch (e) {
        return JSON.stringify({ error: "Failed to parse fine tune payload JSON: " + e.message });
    }

    // Accept both the legacy bare array and { globalShiftSec, adjustments }.
    var adjustments = (payload && payload.adjustments) ? payload.adjustments : payload;
    var globalShiftSec = (payload && payload.globalShiftSec) ? Number(payload.globalShiftSec) : 0;

    if ((!adjustments || adjustments.length === 0) && Math.abs(globalShiftSec) < MIN_MOVE_SEC) {
        return JSON.stringify({ success: true, moved: [], errors: [] });
    }

    var seq = app.project.activeSequence;
    if (!seq) return JSON.stringify({ error: "No active sequence." });

    var adjustmentMap = {};
    for (var i = 0; i < (adjustments ? adjustments.length : 0); i++) {
        var adj = adjustments[i];
        if (adj && adj.filePath && adj.startTicks) {
            adjustmentMap[adj.filePath + "|" + String(adj.startTicks)] = Number(adj.deltaSec);
        }
    }

    // ── Scan every clip to find how far the whole sequence must shift forward
    //    so no clip lands before position 0 after its (global + per-clip) move ─
    var compensateSec = 0;
    function scanForCompensation(trackCollection) {
        for (var t = 0; t < trackCollection.numTracks; t++) {
            var track = trackCollection[t];
            for (var c = 0; c < track.clips.numItems; c++) {
                var clip = track.clips[c];
                try {
                    var fp = clip.projectItem.getMediaPath();
                    if (!fp) continue;
                    var key = fp + "|" + String(clip.start.ticks);
                    var delta = (key in adjustmentMap) ? adjustmentMap[key] : 0;
                    var resultSec = timeToSeconds(clip.start) + globalShiftSec + delta;
                    if (resultSec < 0) compensateSec = Math.max(compensateSec, -resultSec);
                } catch (e) {}
            }
        }
    }
    scanForCompensation(seq.videoTracks);
    scanForCompensation(seq.audioTracks);

    var moved = [];
    var errors = [];

    // ── Apply moves: fine-tuned clips get (globalShift + delta + compensate),
    //    every other clip gets (globalShift + compensate) so relative timing is
    //    preserved. newStartTicks (read back after the move) is the exact key a
    //    later Revert needs to find these clips again — computing it panel-side
    //    would lose precision (tick counts exceed 2^53 past ~10 h).
    function moveTrackCollection(trackCollection, trackType) {
        for (var t = 0; t < trackCollection.numTracks; t++) {
            var track = trackCollection[t];
            for (var c = 0; c < track.clips.numItems; c++) {
                var clip = track.clips[c];
                try {
                    var filePath = clip.projectItem.getMediaPath();
                    if (!filePath) continue;

                    var key = filePath + "|" + String(clip.start.ticks);
                    var inMap = (key in adjustmentMap);
                    var delta = inMap ? adjustmentMap[key] : 0;
                    var totalDelta = globalShiftSec + delta + compensateSec;

                    if (Math.abs(totalDelta) < MIN_MOVE_SEC) continue;

                    var deltaTime = new Time();
                    deltaTime.seconds = totalDelta;
                    clip.move(deltaTime);

                    if (inMap) {
                        moved.push({
                            clipName:      clip.name,
                            filePath:      filePath,
                            trackType:     trackType,
                            trackIndex:    t,
                            deltaSec:      delta,
                            newStartTicks: String(clip.start.ticks)
                        });
                    }
                } catch (e) {
                    errors.push("Failed to move " + clip.name + " on " + trackType + " track " + (t + 1) + ": " + e.message);
                }
            }
        }
    }

    moveTrackCollection(seq.videoTracks, "video");
    moveTrackCollection(seq.audioTracks, "audio");

    return JSON.stringify({
        success: true,
        moved: moved,
        errors: errors,
        compensateSec: compensateSec,
        globalShiftSec: globalShiftSec
    });
}

/**
 * Outer wrapper — catches any uncaught JSX errors and returns them
 * as a proper JSON error object so the panel can display them.
 */
function buildSyncSequence(payloadJSON) {
    try {
        return _buildSyncSequenceImpl(payloadJSON);
    } catch (e) {
        return JSON.stringify({
            error: "Uncaught JSX error: " + e.message + " (line " + e.line + ")"
        });
    }
}

/**
 * Core implementation — builds the -SYNC sequence.
 * payloadJSON: array of { filePath, clipName, trackIndex, trackType, durationTicks, mtimeMs }
 */
function _buildSyncSequenceImpl(payloadJSON) {
    var payload;
    try {
        payload = JSON.parse(payloadJSON);
    } catch (e) {
        return JSON.stringify({ error: "Failed to parse payload JSON: " + e.message });
    }

    if (!payload || payload.length === 0) {
        return JSON.stringify({ error: "Payload is empty." });
    }

    var seq = app.project.activeSequence;
    if (!seq) return JSON.stringify({ error: "No active sequence." });

    // ── 1. Calculate record-start times ───────────────────────────────────
    var enriched = [];
    for (var i = 0; i < payload.length; i++) {
        var p = payload[i];
        var durationSec   = p.durationTicks / TICKS_PER_SECOND;
        // The panel resolves record-start once (embedded creation_time when
        // available, else mtime − duration) and sends it as recordStartMs.
        // Fall back to recomputing from mtime for older/partial payloads.
        var recordStartMs = (p.recordStartMs !== undefined && p.recordStartMs !== null)
            ? p.recordStartMs
            : (p.mtimeMs - (durationSec * 1000));
        enriched.push({
            filePath:      p.filePath,
            clipName:      p.clipName,
            trackIndex:    p.trackIndex,
            trackType:     p.trackType,
            audioTrackIndex: p.audioTrackIndex,
            durationTicks: p.durationTicks,
            mtimeMs:       p.mtimeMs,
            durationSec:   durationSec,
            recordStartMs: recordStartMs
        });
    }

    // ── 2. Per-track record-start anchoring ─────────────────────────────────
    // Each track is anchored to its own earliest clip, not a global anchor
    // across all tracks. This way a device whose clock is set to the wrong
    // date (common after a factory reset or dead internal battery) doesn't
    // push clips from correctly-dated devices beyond the 24-hour limit.
    //
    // Within a single track the timestamps are always consistent (clips from
    // the same device share the same clock, right or wrong), so the relative
    // placement is correct. Cross-track alignment is handled by the audio-
    // based coarse + fine tune passes, which find the real offset between
    // tracks regardless of where Build initially places them.
    var trackKeyOf = function(clip) {
        return clip.trackType + "_" + clip.trackIndex;
    };
    var trackEarliestMs = {};
    for (var j = 0; j < enriched.length; j++) {
        var tk = trackKeyOf(enriched[j]);
        if (!trackEarliestMs.hasOwnProperty(tk) || enriched[j].recordStartMs < trackEarliestMs[tk]) {
            trackEarliestMs[tk] = enriched[j].recordStartMs;
        }
    }

    // ── 2a. 24-hour span guard (per track) ────────────────────────────────────
    var spanError = null;
    for (var sp = 0; sp < enriched.length; sp++) {
        var spClip = enriched[sp];
        var spk = trackKeyOf(spClip);
        var spEndSec = (spClip.recordStartMs - trackEarliestMs[spk]) / 1000 + spClip.durationSec;
        if (spEndSec > MAX_SPAN_SEC) {
            spanError = (spClip.trackType === "video" ? "Video" : "Audio") +
                " track " + (spClip.trackIndex + 1) + " spans " +
                Math.round(spEndSec / 3600) + "h — exceeds Premiere\u2019s 24-hour maximum. " +
                "Process one recording day at a time.";
            break;
        }
    }
    if (spanError) {
        return JSON.stringify({ error: spanError });
    }

    // ── 3. Clone source sequence to preserve exact track layout ────────────
    // Then move existing clip instances in the clone. This avoids re-insert
    // routing issues for sources that fan out to multiple audio tracks.
    var syncName  = seq.name + "-SYNC";
    var existingSequenceIDs = {};
    for (var es = 0; es < app.project.sequences.numSequences; es++) {
        existingSequenceIDs[app.project.sequences[es].sequenceID] = true;
    }

    var cloned;
    try {
        cloned = seq.clone();
    } catch (e) {
        return JSON.stringify({ error: "sequence clone failed: " + e.message });
    }

    if (!cloned) {
        return JSON.stringify({ error: "sequence clone returned false." });
    }

    var syncSeq = null;
    for (var ns = 0; ns < app.project.sequences.numSequences; ns++) {
        var candidate = app.project.sequences[ns];
        if (!existingSequenceIDs[candidate.sequenceID]) {
            syncSeq = candidate;
            break;
        }
    }

    if (!syncSeq) {
        return JSON.stringify({ error: "Could not resolve cloned sequence." });
    }

    try {
        syncSeq.name = syncName;
    } catch (e) {}

    // ── 4. Move each existing clip instance to its calculated offset ───────
    var recordStartByPath = {};
    for (var rp = 0; rp < enriched.length; rp++) {
        var rec = enriched[rp];
        if (!recordStartByPath.hasOwnProperty(rec.filePath) || rec.recordStartMs < recordStartByPath[rec.filePath]) {
            recordStartByPath[rec.filePath] = rec.recordStartMs;
        }
    }

    var clipInstances = [];

    for (var vv = 0; vv < syncSeq.videoTracks.numTracks; vv++) {
        var vTrack = syncSeq.videoTracks[vv];
        for (var vc = 0; vc < vTrack.clips.numItems; vc++) {
            clipInstances.push({ clip: vTrack.clips[vc], trackType: "video", trackIndex: vv });
        }
    }

    for (var aa = 0; aa < syncSeq.audioTracks.numTracks; aa++) {
        var aTrack = syncSeq.audioTracks[aa];
        for (var ac = 0; ac < aTrack.clips.numItems; ac++) {
            clipInstances.push({ clip: aTrack.clips[ac], trackType: "audio", trackIndex: aa });
        }
    }

    var placed = [];
    var errors = [];
    var avGroups = {}; // path -> { video: [trackItems], audio: [trackItems] }

    for (var k = 0; k < clipInstances.length; k++) {
        var clipInfo = clipInstances[k];
        var timelineClip = clipInfo.clip;

        try {
            var path = timelineClip.projectItem.getMediaPath();
            if (!path || !recordStartByPath.hasOwnProperty(path)) {
                continue;
            }

            // Remember each source's video + audio track items so we can re-link them
            // after moving (move() repositions items independently, which unlinks A/V
            // whose audio spans multiple tracks). Captured before the MIN_PLACE skip
            // so items that don't need moving are still part of their group.
            if (!avGroups[path]) avGroups[path] = { video: [], audio: [] };
            avGroups[path][clipInfo.trackType].push(timelineClip);

            // Per-track anchoring: place each clip relative to its own track's
            // earliest recording. Cross-track offsets are resolved by the
            // audio-based coarse + fine tune passes.
            var targetOffsetSec = (recordStartByPath[path] - trackEarliestMs[trackKeyOf(clipInfo)]) / 1000;
            var currentStartSec = timeToSeconds(timelineClip.start);
            var deltaSec = targetOffsetSec - currentStartSec;

            if (Math.abs(deltaSec) < MIN_PLACE_SEC) {
                continue;
            }

            var deltaTime = new Time();
            deltaTime.seconds = deltaSec;
            timelineClip.move(deltaTime);

            placed.push({
                clipName:      timelineClip.name,
                trackType:     clipInfo.trackType,
                trackIndex:    clipInfo.trackIndex,
                offsetSec:     targetOffsetSec,
                offsetTicks:   String(Math.round(targetOffsetSec * TICKS_PER_SECOND)),
                recordStartMs: recordStartByPath[path]
            });
        } catch (e3) {
            errors.push("Failed to move clip on " + clipInfo.trackType + " track " + (clipInfo.trackIndex + 1) + ": " + e3.message);
        }
    }

    // ── 4a. Re-link video + audio per source ────────────────────────────────
    // move() repositions each track item on its own, which unlinks linked A/V when
    // the audio spans multiple tracks (e.g. multichannel camera audio). Re-link each
    // such group via the sequence selection. Two-item links survive move() intact,
    // so we only touch groups whose audio is on 2+ tracks.
    function setAllSelected(value) {
        var ti, ci, tr;
        for (ti = 0; ti < syncSeq.videoTracks.numTracks; ti++) {
            tr = syncSeq.videoTracks[ti];
            for (ci = 0; ci < tr.clips.numItems; ci++) {
                try { tr.clips[ci].setSelected(value, false); } catch (eSel) {}
            }
        }
        for (ti = 0; ti < syncSeq.audioTracks.numTracks; ti++) {
            tr = syncSeq.audioTracks[ti];
            for (ci = 0; ci < tr.clips.numItems; ci++) {
                try { tr.clips[ci].setSelected(value, false); } catch (eSel2) {}
            }
        }
    }

    var canLink = (typeof syncSeq.linkSelection === "function");
    var relinked = 0;
    var multiAudioGroups = 0;
    for (var gp in avGroups) {
        if (!avGroups.hasOwnProperty(gp)) continue;
        var grp = avGroups[gp];
        if (grp.video.length < 1 || grp.audio.length < 2) continue; // only the multi-track case unlinks
        multiAudioGroups++;
        if (!canLink) continue;
        try {
            setAllSelected(false);
            var members = grp.video.concat(grp.audio);
            for (var mi = 0; mi < members.length; mi++) {
                members[mi].setSelected(true, false);
            }
            syncSeq.linkSelection();
            relinked++;
        } catch (eLink) {
            errors.push("Re-link failed for " + gp + ": " + eLink.message);
        }
    }
    if (canLink) { try { setAllSelected(false); } catch (eClr) {} }

    try { syncSeq.open(); } catch(e) {}

    return JSON.stringify({
        success:          true,
        sequenceName:     syncSeq.name,
        placed:           placed,
        errors:           errors,
        relinked:         relinked,
        relinkSupported:  canLink,
        multiAudioGroups: multiAudioGroups
    });
}


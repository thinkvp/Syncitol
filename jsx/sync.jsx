/**
 * DateModSync — ExtendScript (sync.jsx)
 * Runs inside Premiere Pro's scripting engine.
 * Called from the CEP panel via CSInterface.evalScript()
 */

// ─── Helpers ────────────────────────────────────────────────────────────────

function ticksToSeconds(ticks) {
    return ticks / 254016000000;
}

function secondsToTicks(seconds) {
    return seconds * 254016000000;
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
    var seq = app.project.activeSequence;
    if (!seq) return JSON.stringify({ error: "No active sequence." });

    var result = [];
    var seenPaths = [];

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
                if (filePath && !alreadySeen(filePath)) {
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
            } catch (e) { /* skip offline/placeholder clips */ }
        }
    }

    // Iterate audio-only tracks (no linked video counterpart)
    for (var a = 0; a < seq.audioTracks.numTracks; a++) {
        var atrack = seq.audioTracks[a];
        for (var ac = 0; ac < atrack.clips.numItems; ac++) {
            var aclip = atrack.clips[ac];
            try {
                var aPath = aclip.projectItem.getMediaPath();
                if (aPath && !alreadySeen(aPath)) {
                    seenPaths.push(aPath);
                    result.push({
                        filePath:      aPath,
                        clipName:      aclip.name,
                        trackIndex:    a,
                        trackType:     "audio",
                        durationTicks: aclip.duration.ticks
                    });
                }
            } catch (e) {}
        }
    }

    return JSON.stringify(result);
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

    function collect(trackCollection, trackType) {
        for (var t = 0; t < trackCollection.numTracks; t++) {
            var track = trackCollection[t];
            for (var c = 0; c < track.clips.numItems; c++) {
                var clip = track.clips[c];
                try {
                    var filePath = clip.projectItem.getMediaPath();
                    if (!filePath) continue;

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
                } catch (e) {}
            }
        }
    }

    collect(seq.videoTracks, "video");
    collect(seq.audioTracks, "audio");

    return JSON.stringify(result);
}

/** Recursively search bins for a project item by file path */
function findProjectItemByPath(folder, targetPath) {
    for (var i = 0; i < folder.children.numItems; i++) {
        var child = folder.children[i];
        if (child.type === ProjectItemType.BIN) {
            var found = findProjectItemByPath(child, targetPath);
            if (found) return found;
        } else {
            try {
                if (child.getMediaPath() === targetPath) return child;
            } catch (e) {}
        }
    }
    return null;
}

/**
 * Apply fine-tune shifts to matching timeline clips.
 * adjustmentsJSON: [{ filePath, startTicks, deltaSec }]
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
    var adjustments;
    try {
        adjustments = JSON.parse(adjustmentsJSON);
    } catch (e) {
        return JSON.stringify({ error: "Failed to parse fine tune payload JSON: " + e.message });
    }

    if (!adjustments || adjustments.length === 0) {
        return JSON.stringify({ success: true, moved: [], errors: [] });
    }

    var seq = app.project.activeSequence;
    if (!seq) return JSON.stringify({ error: "No active sequence." });

    var adjustmentMap = {};
    for (var i = 0; i < adjustments.length; i++) {
        var adj = adjustments[i];
        if (adj && adj.filePath && adj.startTicks) {
            adjustmentMap[adj.filePath + "|" + String(adj.startTicks)] = Number(adj.deltaSec);
        }
    }

    var moved = [];
    var errors = [];

    function moveTrackCollection(trackCollection, trackType) {
        for (var t = 0; t < trackCollection.numTracks; t++) {
            var track = trackCollection[t];
            for (var c = 0; c < track.clips.numItems; c++) {
                var clip = track.clips[c];
                try {
                    var filePath = clip.projectItem.getMediaPath();
                    if (!filePath) continue;

                    var key = filePath + "|" + String(clip.start.ticks);
                    if (!(key in adjustmentMap)) continue;

                    var delta = adjustmentMap[key];
                    var deltaTime = new Time();
                    deltaTime.seconds = delta;
                    clip.move(deltaTime);

                    moved.push({
                        clipName:   clip.name,
                        filePath:   filePath,
                        trackType:  trackType,
                        trackIndex: t,
                        deltaSec:   delta
                    });
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
        errors: errors
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
        var durationSec   = p.durationTicks / 254016000000;
        var recordStartMs = p.mtimeMs - (durationSec * 1000);
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

    // ── 2. Per-track earliest: each track independently starts at t=0 ───────
    // Clips on different tracks are NOT spaced relative to each other by date.
    // Use Fine Tune Audio to align tracks against each other via waveform.
    var videoTrackEarliest = {};
    var fileToVideoTrackIdx = {};
    for (var j = 0; j < enriched.length; j++) {
        var ej = enriched[j];
        if (ej.trackType === "video") {
            var vtKey = "v" + ej.trackIndex;
            if (!videoTrackEarliest.hasOwnProperty(vtKey) || ej.recordStartMs < videoTrackEarliest[vtKey]) {
                videoTrackEarliest[vtKey] = ej.recordStartMs;
            }
            fileToVideoTrackIdx[ej.filePath] = ej.trackIndex;
        }
    }
    var audioTrackEarliest = {};
    for (var j2 = 0; j2 < enriched.length; j2++) {
        var ej2 = enriched[j2];
        if (ej2.trackType === "audio") {
            var atKey = "a" + ej2.trackIndex;
            if (!audioTrackEarliest.hasOwnProperty(atKey) || ej2.recordStartMs < audioTrackEarliest[atKey]) {
                audioTrackEarliest[atKey] = ej2.recordStartMs;
            }
        }
    }

    // ── 2a. 24-hour span guard (per track) ────────────────────────────────────
    var MAX_SPAN_SEC = 86400;
    var spanError = null;
    for (var sp = 0; sp < enriched.length; sp++) {
        var spClip = enriched[sp];
        var spAnchor;
        if (spClip.trackType === "video") {
            spAnchor = videoTrackEarliest["v" + spClip.trackIndex];
        } else if (fileToVideoTrackIdx.hasOwnProperty(spClip.filePath)) {
            spAnchor = videoTrackEarliest["v" + fileToVideoTrackIdx[spClip.filePath]];
        } else {
            spAnchor = audioTrackEarliest["a" + spClip.trackIndex];
        }
        if (spAnchor === undefined) continue;
        var spEndSec = (spClip.recordStartMs - spAnchor) / 1000 + spClip.durationSec;
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

    for (var k = 0; k < clipInstances.length; k++) {
        var clipInfo = clipInstances[k];
        var timelineClip = clipInfo.clip;

        try {
            var path = timelineClip.projectItem.getMediaPath();
            if (!path || !recordStartByPath.hasOwnProperty(path)) {
                continue;
            }

            var trackAnchorMs;
            if (clipInfo.trackType === "video") {
                trackAnchorMs = videoTrackEarliest["v" + clipInfo.trackIndex];
            } else if (fileToVideoTrackIdx.hasOwnProperty(path)) {
                trackAnchorMs = videoTrackEarliest["v" + fileToVideoTrackIdx[path]];
            } else {
                trackAnchorMs = audioTrackEarliest["a" + clipInfo.trackIndex];
            }
            if (trackAnchorMs === undefined) continue;
            var targetOffsetSec = (recordStartByPath[path] - trackAnchorMs) / 1000;
            var currentStartSec = timeToSeconds(timelineClip.start);
            var deltaSec = targetOffsetSec - currentStartSec;

            if (Math.abs(deltaSec) < 0.0005) {
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
                offsetTicks:   String(Math.round(targetOffsetSec * 254016000000)),
                recordStartMs: recordStartByPath[path]
            });
        } catch (e3) {
            errors.push("Failed to move clip on " + clipInfo.trackType + " track " + (clipInfo.trackIndex + 1) + ": " + e3.message);
        }
    }

    try { syncSeq.open(); } catch(e) {}

    return JSON.stringify({
        success:      true,
        sequenceName: syncSeq.name,
        placed:       placed,
        errors:       errors
    });
}


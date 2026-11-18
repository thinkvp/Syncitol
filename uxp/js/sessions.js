/**
 * Syncitol — sessions.js
 * Pure, host-independent: footage shot over more than one day.
 *
 * The build lays clips out by their recording clock, so a two-day shoot puts
 * day 2 a full night after day 1 — past Premiere's 24-hour timecode (the
 * timeline itself accepts it, but the timecode display wraps back to 00:00 and
 * the editor is left scrolling across 16 empty hours). Instead, recording
 * SESSIONS are found — runs of footage, across every device, with no break
 * longer than SESSION_GAP_SEC — and the gaps between them are closed up to
 * SESSION_PAD_SEC. Within a session nothing moves relative to anything else,
 * so every device keeps its real offset from every other, and each device's
 * clock error is the same on both days, which is what the coarse pass needs.
 *
 * With the gaps closed, a device's clock can no longer push its clips days
 * away from everyone else's, so the build lays every clock-dated track out on
 * ONE shared anchor (dsp.planBuildAnchors shareAnchor) — day 2's cameras land
 * after day 1's instead of each day starting at 0:00. A long shoot can run past
 * 24 hours; Premiere accepts that (verified to ~50 h on 26.3.2), only its
 * timecode display rolls over, and a marker names each day.
 *
 * The mapping is a pure shift per session, applied to every file's
 * recordStartMs before anything else plans on it. Overlaps are preserved
 * exactly (a closed gap held no recording), so the timing plausibility checks
 * and device detection see what they would have seen.
 *
 * Loadable as a CommonJS module (UXP `require()` and node:test).
 */

"use strict";

const SESSION_GAP_SEC = 2 * 3600; // a break longer than this ends a recording session
const SESSION_PAD_SEC = 300;      // what is left of a closed-up gap
const MAX_SPAN_SEC = 86400;       // Premiere's 24-hour timecode

const EMBEDDED = new Set(["creation_time", "modification_date", "timecode"]);

// files: [{ filePath, recordStartMs, durationSec, timingSource }]
// Returns {
//   sessions: [{ index, startMs, endMs, files:[path], embedded, shiftMs }]
//   shiftByPath: { path: ms subtracted from its recordStartMs }
//   closedSec:  total time removed
// }
function planSessions(files, opts) {
    opts = opts || {};
    const gapMs = (opts.gapSec === undefined ? SESSION_GAP_SEC : opts.gapSec) * 1000;
    const padMs = (opts.padSec === undefined ? SESSION_PAD_SEC : opts.padSec) * 1000;

    const list = (files || [])
        .filter(f => f && isFinite(f.recordStartMs))
        .map(f => ({
            filePath: f.filePath, startMs: f.recordStartMs,
            endMs: f.recordStartMs + Math.max(0, f.durationSec || 0) * 1000,
            embedded: EMBEDDED.has(f.timingSource)
        }))
        .sort((a, b) => (a.startMs - b.startMs) || String(a.filePath).localeCompare(String(b.filePath)));

    const sessions = [];
    let cur = null;
    for (const f of list) {
        if (cur && f.startMs - cur.endMs <= gapMs) {
            cur.files.push(f.filePath);
            if (f.endMs > cur.endMs) cur.endMs = f.endMs;
            if (f.embedded) cur.embedded = true;
        } else {
            cur = { index: sessions.length, startMs: f.startMs, endMs: f.endMs, files: [f.filePath], embedded: f.embedded, shiftMs: 0 };
            sessions.push(cur);
        }
    }

    let shift = 0;
    for (let i = 1; i < sessions.length; i += 1) {
        const gap = sessions[i].startMs - sessions[i - 1].endMs;
        shift += Math.max(0, gap - padMs);
        sessions[i].shiftMs = shift;
    }

    const shiftByPath = {};
    for (const s of sessions) for (const p of s.files) shiftByPath[p] = s.shiftMs;
    return { sessions, shiftByPath, closedSec: shift / 1000 };
}

// The payload with each file's recordStartMs moved by its session's shift.
// The clock reading is kept as rawRecordStartMs for display.
function closeGaps(files, plan) {
    return (files || []).map(f => {
        const shift = plan.shiftByPath[f.filePath] || 0;
        return Object.assign({}, f, {
            rawRecordStartMs: f.rawRecordStartMs !== undefined ? f.rawRecordStartMs : f.recordStartMs,
            recordStartMs: isFinite(f.recordStartMs) ? f.recordStartMs - shift : f.recordStartMs
        });
    });
}

// Does the footage span more than one day? Only embedded clocks are asked: a
// file date is when the file was copied or processed, and a recorder whose
// files were downloaded two days later is not a two-day shoot.
function spansDays(files, opts) {
    opts = opts || {};
    const limit = (opts.maxSpanSec === undefined ? MAX_SPAN_SEC : opts.maxSpanSec) * 1000;
    const timed = (files || []).filter(f => f && isFinite(f.recordStartMs) && EMBEDDED.has(f.timingSource));
    if (timed.length < 2) return false;
    let lo = Infinity, hi = -Infinity;
    for (const f of timed) {
        lo = Math.min(lo, f.recordStartMs);
        hi = Math.max(hi, f.recordStartMs + Math.max(0, f.durationSec || 0) * 1000);
    }
    return hi - lo > limit && planSessions(timed, opts).sessions.length > 1;
}

// The evidence for a multi-day shoot, from the embedded clocks:
//   overDay       — they span more than 24 h across more than one session
//   sharedDevice  — a device (opts.deviceOf: path → device key) with files in
//                   more than one session, or null. Without one, every
//                   "day" is a separate set of devices — exactly what a camera
//                   with the wrong date produces — so it proves nothing.
//   sessions      — [{ startMs, devices:[key] }] for the log
function dayEvidence(files, opts) {
    opts = opts || {};
    const deviceOf = opts.deviceOf || null;
    const timed = (files || []).filter(f => f && isFinite(f.recordStartMs) && EMBEDDED.has(f.timingSource));
    const out = { overDay: spansDays(files, opts), sharedDevice: null, sessions: [] };
    if (timed.length < 2) return out;
    const plan = planSessions(timed, opts);
    const seenIn = {};
    for (const s of plan.sessions) {
        const devices = [];
        for (const p of s.files) {
            const d = deviceOf ? deviceOf[p] : null;
            if (d === null || d === undefined) continue;
            if (devices.indexOf(d) < 0) devices.push(d);
            if (seenIn[d] !== undefined && seenIn[d] !== s.index && out.sharedDevice === null) out.sharedDevice = d;
            if (seenIn[d] === undefined) seenIn[d] = s.index;
        }
        out.sessions.push({ startMs: s.startMs, devices });
    }
    return out;
}

// ─── Tighten the gaps between days, after the sync ────────────────────────────
// The closed-up gaps are planned from the recording CLOCKS, before the audio
// pass corrects them, so the finished gap is the pad plus whatever the clocks
// were wrong by: a day ending on a camera 10 minutes fast and the next day
// starting on one 1.5 minutes slow left 17 minutes instead of 5 (or, the
// other way round, would let days overlap). Once every clip is in its final
// place, each day is slid as ONE piece so it starts `padSec` after the
// previous one ends. Nothing within a day moves relative to anything else.
//
// fileSpans:  { path: { startSec, endSec } } — final timeline positions
// embedded:   Set of paths with an embedded clock (they define the days)
// Files dated only by copy time join the day their final position overlaps
// most (else the nearest). A "day" that now sits well inside the previous one
// (a wrong clock the audio pass moved there) is merged into it, never pushed.
// Returns { deltaByPath, days: [{ index, startSec, endSec, shiftSec, merged }] }
const TIGHT_PAD_SEC = 60;
const TIGHT_MERGE_OVERLAP_SEC = 600;
const TIGHT_MIN_SHIFT_SEC = 0.5;

function tightenDays(plan, fileSpans, embedded, padSec) {
    const pad = padSec === undefined ? TIGHT_PAD_SEC : padSec;
    const days = [];
    const dayOfPath = {};
    for (const sess of plan.sessions) {
        const paths = sess.files.filter(p => (!embedded || embedded.has(p)) && fileSpans[p]);
        if (!paths.length) continue;
        const day = { index: sess.index, paths: paths.slice(), startSec: Infinity, endSec: -Infinity, shiftSec: 0, merged: false };
        for (const p of paths) {
            day.startSec = Math.min(day.startSec, fileSpans[p].startSec);
            day.endSec = Math.max(day.endSec, fileSpans[p].endSec);
            dayOfPath[p] = day;
        }
        days.push(day);
    }
    if (days.length < 2) return { deltaByPath: {}, days };
    days.sort((a, b) => a.startSec - b.startSec);

    // Files that belong to no day (copy-dated) follow the day they now overlap.
    for (const p of Object.keys(fileSpans)) {
        if (dayOfPath[p]) continue;
        const sp = fileSpans[p];
        let best = null, bestScore = -Infinity;
        for (const d of days) {
            const ov = Math.min(sp.endSec, d.endSec) - Math.max(sp.startSec, d.startSec);
            const mid = (sp.startSec + sp.endSec) / 2;
            const dist = mid < d.startSec ? d.startSec - mid : (mid > d.endSec ? mid - d.endSec : 0);
            const score = ov > 0 ? ov : -dist;
            if (score > bestScore) { bestScore = score; best = d; }
        }
        best.paths.push(p);
        dayOfPath[p] = best;
        best.startSec = Math.min(best.startSec, sp.startSec);
        best.endSec = Math.max(best.endSec, sp.endSec);
    }
    days.sort((a, b) => a.startSec - b.startSec);

    // Merge days that now overlap heavily — they were one day all along.
    const kept = [days[0]];
    for (let i = 1; i < days.length; i += 1) {
        const prev = kept[kept.length - 1];
        if (days[i].startSec < prev.endSec - TIGHT_MERGE_OVERLAP_SEC) {
            prev.paths.push(...days[i].paths);
            prev.endSec = Math.max(prev.endSec, days[i].endSec);
            days[i].merged = true;
        } else {
            kept.push(days[i]);
        }
    }

    const deltaByPath = {};
    let prevEnd = kept[0].endSec;
    for (let i = 1; i < kept.length; i += 1) {
        const d = kept[i];
        const shift = (prevEnd + pad) - d.startSec;
        d.shiftSec = Math.abs(shift) >= TIGHT_MIN_SHIFT_SEC ? Math.round(shift * 1000) / 1000 : 0;
        if (d.shiftSec) for (const p of d.paths) deltaByPath[p] = d.shiftSec;
        prevEnd = d.endSec + d.shiftSec;
    }
    return { deltaByPath, days };
}

// Marker names: "Day 1", "Day 2", … counted by calendar date (local time); a
// second session on the same date becomes "Day 2 (2)". `dateLabel(ms)` formats
// the start for the marker comment.
function sessionLabels(plan, dateLabel) {
    const dayOf = (ms) => { const d = new Date(ms); return d.getFullYear() + "-" + d.getMonth() + "-" + d.getDate(); };
    const out = [];
    let day = 0, lastKey = null, within = 0;
    for (const s of plan.sessions) {
        const comment = dateLabel ? dateLabel(s.startMs) : "";
        if (s.embedded === false) {
            // Only file dates: when files were copied or processed, which is
            // no recording day at all.
            out.push({ index: s.index, name: "File dates only", comment, fileDated: true });
            continue;
        }
        const key = dayOf(s.startMs);
        if (key !== lastKey) { day += 1; within = 1; lastKey = key; } else { within += 1; }
        out.push({ index: s.index, name: "Day " + day + (within > 1 ? " (" + within + ")" : ""), comment });
    }
    return out;
}

// Where each session starts on the finished timeline: the earliest clip of a
// file recorded in it. Only files with an embedded clock count — a file dated
// by its copy time may belong to another session entirely, and the audio pass
// will have moved it there. For the same reason a session that now starts
// well inside the previous one (a camera whose wrong clock made a "session" of
// its own, which the audio pass then put where it belongs) gets no marker.
// clips: scan clips [{ filePath, startSec, endSec }]; embeddedPaths: Set.
const MARKER_OVERLAP_TOL_SEC = 600;

function sessionStarts(plan, clips, embeddedPaths) {
    const span = {};
    for (const c of clips || []) {
        const e = span[c.filePath] || (span[c.filePath] = { start: Infinity, end: -Infinity });
        e.start = Math.min(e.start, c.startSec);
        e.end = Math.max(e.end, c.endSec === undefined ? c.startSec : c.endSec);
    }
    const out = [];
    let prevEnd = -Infinity;
    for (const s of plan.sessions) {
        let start = Infinity, end = -Infinity;
        for (const p of s.files) {
            if (embeddedPaths && !embeddedPaths.has(p)) continue;
            if (!span[p]) continue;
            start = Math.min(start, span[p].start);
            end = Math.max(end, span[p].end);
        }
        if (!isFinite(start)) continue;
        if (start < prevEnd - MARKER_OVERLAP_TOL_SEC) continue;
        out.push({ index: s.index, startSec: start });
        prevEnd = Math.max(prevEnd, end);
    }
    return out;
}

module.exports = {
    SESSION_GAP_SEC,
    SESSION_PAD_SEC,
    planSessions,
    closeGaps,
    spansDays,
    tightenDays,
    TIGHT_PAD_SEC,
    dayEvidence,
    sessionLabels,
    sessionStarts
};

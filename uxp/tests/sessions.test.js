"use strict";

const test = require("node:test");
const assert = require("node:assert");
const sessions = require("../js/sessions");
const dsp = require("../js/dsp");

const H = 3600 * 1000;
const DAY1 = new Date(2026, 7, 1, 9, 0, 0).getTime(); // local 09:00, 1 Aug
const DAY2 = new Date(2026, 7, 2, 9, 0, 0).getTime();

// Two cameras and a recorder, rolling 09:00–12:00 on each of two days.
function twoDays() {
    const out = [];
    for (const [day, base] of [[1, DAY1], [2, DAY2]]) {
        out.push({ filePath: `A_d${day}.mp4`, trackType: "video", trackIndex: 0, recordStartMs: base, durationSec: 3 * 3600, timingSource: "creation_time" });
        out.push({ filePath: `B_d${day}.mxf`, trackType: "video", trackIndex: 1, recordStartMs: base + 30000, durationSec: 3 * 3600 - 60, timingSource: "modification_date" });
        out.push({ filePath: `R_d${day}.wav`, trackType: "audio", trackIndex: 5, recordStartMs: base - 60000, durationSec: 3 * 3600 + 120, timingSource: "creation_time" });
    }
    return out;
}

test("planSessions finds one session per day and closes the overnight gap", () => {
    const plan = sessions.planSessions(twoDays());
    assert.strictEqual(plan.sessions.length, 2);
    assert.deepStrictEqual(plan.sessions[0].files.sort(), ["A_d1.mp4", "B_d1.mxf", "R_d1.wav"]);
    // Day 1 ends 12:01; day 2 starts 08:59 next day → gap 20h58m, closed to the pad.
    const gap = plan.sessions[1].startMs - plan.sessions[0].endMs;
    const pad = sessions.SESSION_PAD_SEC * 1000;
    assert.strictEqual(plan.sessions[1].shiftMs, gap - pad);
    assert.strictEqual(plan.shiftByPath["A_d2.mp4"], gap - pad);
    assert.strictEqual(plan.shiftByPath["A_d1.mp4"], 0);
});

test("planSessions keeps a lunch break inside one session", () => {
    const files = [
        { filePath: "a.mp4", recordStartMs: DAY1, durationSec: 3 * 3600, timingSource: "creation_time" },
        { filePath: "b.mp4", recordStartMs: DAY1 + 4 * H, durationSec: 3 * 3600, timingSource: "creation_time" }
    ];
    assert.strictEqual(sessions.planSessions(files).sessions.length, 1);
});

test("closeGaps preserves every offset within a session and keeps the clock reading", () => {
    const files = twoDays();
    const plan = sessions.planSessions(files);
    const closed = sessions.closeGaps(files, plan);
    const by = Object.fromEntries(closed.map(f => [f.filePath, f]));
    assert.strictEqual(by["B_d2.mxf"].recordStartMs - by["A_d2.mp4"].recordStartMs, 30000);
    assert.strictEqual(by["A_d2.mp4"].rawRecordStartMs, DAY2);
    // Day 2 now starts one pad after day 1 ends.
    assert.strictEqual(by["R_d2.wav"].recordStartMs - (by["R_d1.wav"].recordStartMs + (3 * 3600 + 120) * 1000),
        sessions.SESSION_PAD_SEC * 1000);
});

test("closing the gaps lets the build anchor the cameras together again", () => {
    const files = twoDays();
    const open = dsp.planBuildAnchors(files);
    assert.strictEqual(open.groups.length, 0, "two days of clock span cannot be one group");

    const closed = sessions.closeGaps(files, sessions.planSessions(files));
    const layout = dsp.planBuildAnchors(closed);
    assert.strictEqual(layout.groups.length, 1);
    assert.strictEqual(layout.groups[0].trackKeys.length, 3);
});

test("with days closed, day 2's own tracks land after day 1 instead of at 0:00", () => {
    // Each day's footage in its own folder → its own tracks after a rebuild.
    const files = twoDays().map(f => /_d2/.test(f.filePath) ? Object.assign({}, f, { trackIndex: f.trackIndex + 10 }) : f);
    const closed = sessions.closeGaps(files, sessions.planSessions(files));
    const perDay = dsp.planBuildAnchors(closed);
    assert.strictEqual(perDay.groups.length, 2, "without sharing, each day is its own group at 0:00");

    const shared = dsp.planBuildAnchors(closed, { shareAnchor: true, maxSpanSec: Infinity });
    assert.strictEqual(shared.groups.length, 1);
    assert.strictEqual(shared.groups[0].shared, true);
    const a = shared.anchorMsByTrack;
    const d2 = closed.find(f => f.filePath === "A_d2.mp4");
    const startSec = (d2.recordStartMs - a["video_10"]) / 1000;
    // Day 1 runs 3 h 2 min (R_d1 from 08:59), then the pad, then day 2's own lead.
    assert.strictEqual(startSec, 3 * 3600 + 120 + sessions.SESSION_PAD_SEC + 60);
});

test("spansDays asks only the embedded clocks", () => {
    assert.strictEqual(sessions.spansDays(twoDays()), true);
    assert.strictEqual(sessions.spansDays(twoDays().filter(f => /_d1/.test(f.filePath))), false);
    // A recorder whose files were copied two days later is not a two-day shoot.
    const day1 = twoDays().filter(f => /_d1/.test(f.filePath));
    day1.push({ filePath: "late.wav", recordStartMs: DAY2 + 24 * H, durationSec: 600, timingSource: "mtime" });
    assert.strictEqual(sessions.spansDays(day1), false);
});

test("sessionLabels counts calendar days and numbers a second session on the same date", () => {
    const plan = { sessions: [
        { index: 0, startMs: DAY1 }, { index: 1, startMs: DAY1 + 10 * H }, { index: 2, startMs: DAY2 }
    ] };
    const labels = sessions.sessionLabels(plan, (ms) => "at " + ms);
    assert.deepStrictEqual(labels.map(l => l.name), ["Day 1", "Day 1 (2)", "Day 2"]);
    assert.strictEqual(labels[2].comment, "at " + DAY2);
});

test("sessionLabels does not count a session dated only by file dates as a day", () => {
    const plan = { sessions: [
        { index: 0, startMs: DAY1, embedded: true }, { index: 1, startMs: DAY2, embedded: false },
        { index: 2, startMs: DAY2 + 24 * H, embedded: true }
    ] };
    assert.deepStrictEqual(sessions.sessionLabels(plan).map(l => l.name), ["Day 1", "File dates only", "Day 2"]);
});

test("sessionStarts uses the earliest clip of each session's clock-dated files", () => {
    const files = twoDays();
    const plan = sessions.planSessions(files);
    const clips = [
        { filePath: "A_d1.mp4", startSec: 60, endSec: 10860 }, { filePath: "R_d1.wav", startSec: 0, endSec: 10920 },
        { filePath: "A_d2.mp4", startSec: 11300, endSec: 22100 }, { filePath: "B_d2.mxf", startSec: 11330, endSec: 22070 },
        { filePath: "R_d2.wav", startSec: 5, endSec: 100 } // dated by its copy, moved by the audio pass
    ];
    const embedded = new Set(files.filter(f => f.filePath !== "R_d2.wav").map(f => f.filePath));
    assert.deepStrictEqual(sessions.sessionStarts(plan, clips, embedded), [
        { index: 0, startSec: 0 }, { index: 1, startSec: 11300 }
    ]);
});

test("sessionStarts skips a session the audio pass moved inside another one", () => {
    // A camera with a wrong clock made a session of its own; the sync put it
    // back in the middle of day 1.
    const plan = { sessions: [{ index: 0, files: ["a.mp4"] }, { index: 1, files: ["wrong.mp4"] }, { index: 2, files: ["b.mp4"] }] };
    const clips = [
        { filePath: "a.mp4", startSec: 0, endSec: 10000 },
        { filePath: "wrong.mp4", startSec: 4000, endSec: 6000 },
        { filePath: "b.mp4", startSec: 10300, endSec: 20000 }
    ];
    assert.deepStrictEqual(sessions.sessionStarts(plan, clips, null).map(s => s.index), [0, 2]);
});

test("dayEvidence: a device recording on both days makes it a multi-day shoot", () => {
    const files = twoDays();
    const deviceOf = Object.fromEntries(files.map(f => [f.filePath, f.filePath.split("_")[0]])); // A, B, R
    const ev = sessions.dayEvidence(files, { deviceOf });
    assert.strictEqual(ev.overDay, true);
    assert.strictEqual(ev.sharedDevice, "R"); // the first device seen on both days
    assert.deepStrictEqual(ev.sessions.map(s => s.devices), [["R", "A", "B"], ["R", "A", "B"]]);
});

test("dayEvidence: one camera with the wrong date is not a second day", () => {
    // Same interview, FX6 clock set to February, A7S3 right in October.
    const fx = new Date(2026, 1, 24, 16, 44, 27).getTime();
    const a7 = new Date(2026, 9, 23, 16, 45, 27).getTime();
    const files = [];
    for (let i = 0; i < 3; i += 1) {
        files.push({ filePath: `fx_${i}.mxf`, recordStartMs: fx + i * 900000, durationSec: 600, timingSource: "modification_date" });
        files.push({ filePath: `a7_${i}.mp4`, recordStartMs: a7 + i * 900000, durationSec: 600, timingSource: "creation_time" });
    }
    const deviceOf = Object.fromEntries(files.map(f => [f.filePath, f.filePath.split("_")[0]]));
    const ev = sessions.dayEvidence(files, { deviceOf });
    assert.strictEqual(ev.overDay, true);
    assert.strictEqual(ev.sharedDevice, null);
    assert.deepStrictEqual(ev.sessions.map(s => s.devices), [["fx"], ["a7"]]);
});

test("tightenDays closes the gap a wrong clock left, sliding each day as one piece", () => {
    // Day 1 ended on a camera 10 min fast; after the sync the real gap is 20 min.
    const plan = { sessions: [{ index: 0, files: ["a1", "b1"] }, { index: 1, files: ["a2", "b2"] }] };
    const spans = {
        a1: { startSec: 0, endSec: 6000 }, b1: { startSec: 100, endSec: 6700 },
        a2: { startSec: 7900, endSec: 9000 }, b2: { startSec: 7950, endSec: 9100 },
        rec: { startSec: 8000, endSec: 8800 }   // copy-dated, sits inside day 2
    };
    const t = sessions.tightenDays(plan, spans, new Set(["a1", "b1", "a2", "b2"]), 60);
    // Day 2 should start 60 s after day 1's end (6700) → shift 6760 − 7900.
    assert.strictEqual(t.deltaByPath.a2, -1140);
    assert.strictEqual(t.deltaByPath.b2, -1140);
    assert.strictEqual(t.deltaByPath.rec, -1140, "the copy-dated recorder moves with the day it belongs to");
    assert.strictEqual(t.deltaByPath.a1, undefined);
});

test("tightenDays pushes overlapping days apart, and merges a day the sync moved inside another", () => {
    const plan = { sessions: [{ index: 0, files: ["a"] }, { index: 1, files: ["b"] }, { index: 2, files: ["c"] }] };
    const spans = {
        a: { startSec: 0, endSec: 5000 },
        b: { startSec: 2000, endSec: 3000 },     // wrong clock: really part of day 1
        c: { startSec: 4980, endSec: 8000 }      // overlaps day 1 by 20 s
    };
    const t = sessions.tightenDays(plan, spans, null, 60);
    assert.strictEqual(t.deltaByPath.b, undefined, "merged into day 1, not moved");
    assert.strictEqual(t.deltaByPath.c, 80, "pushed to start 60 s after day 1");
    assert.ok(t.days.find(d => d.index === 1).merged);
});

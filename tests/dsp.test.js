"use strict";

const test = require("node:test");
const assert = require("node:assert");
const dsp = require("../js/dsp");

// ─── findBestLag ──────────────────────────────────────────────────────────────

// Deterministic pseudo-random envelope so the correlation has real variance.
function makeSignal(length, seed) {
    let state = seed >>> 0;
    const out = new Float32Array(length);
    for (let i = 0; i < length; i += 1) {
        state = (1664525 * state + 1013904223) >>> 0; // LCG
        out[i] = (state % 1000) + 50 * Math.sin(i / 7);
    }
    return out;
}

test("findBestLag recovers a known positive lag (target later than reference)", () => {
    const L = 600;
    const base = makeSignal(L, 42);
    const ref = base;

    // target is base delayed by D frames → target[i] = base[i - D].
    const D = 25;
    const target = new Float32Array(L);
    for (let i = D; i < L; i += 1) target[i] = base[i - D];

    const best = dsp.findBestLag(ref, target);
    assert.ok(best, "expected a lag candidate");
    // envelopeRate is 100 Hz → D=25 frames is 0.25 s.
    assert.ok(Math.abs(best.lagSec - 0.25) <= 0.01, `lagSec ${best.lagSec} should be ~0.25`);
    assert.ok(best.score > 0.99, `score ${best.score} should be near 1 for an exact shift`);
});

test("findBestLag returns null for flat / zero-variance signals", () => {
    const flat = new Float32Array(600).fill(500);
    assert.strictEqual(dsp.findBestLag(flat, flat), null);
});

test("findBestLag honours a custom maxShiftSec / envelopeRate", () => {
    const L = 200;
    const base = makeSignal(L, 7);
    const target = new Float32Array(L);
    const D = 8;
    for (let i = D; i < L; i += 1) target[i] = base[i - D];

    // At 10 Hz, D=8 frames is 0.8 s; allow a wide shift and small overlap.
    const best = dsp.findBestLag(base, target, {
        envelopeRate: 10,
        maxShiftSec: 5,
        minOverlapSec: 1,
    });
    assert.ok(best, "expected a candidate with custom options");
    assert.ok(Math.abs(best.lagSec - 0.8) <= 0.11, `lagSec ${best.lagSec} should be ~0.8`);
});

// ─── slideMatch ───────────────────────────────────────────────────────────────

test("slideMatch locates a short clip inside a long reference (large offset)", () => {
    const refLen = 2000;            // e.g. ~200s of reference at 10 Hz
    const ref = makeSignal(refLen, 99);
    // target is a 200-frame slice of the reference starting at frame 1500 —
    // a "large" offset that findBestLag's ±maxShift window could never reach.
    const at = 1500;
    const tgt = ref.slice(at, at + 200);

    const best = dsp.slideMatch(ref, tgt, { envelopeRate: 10, minOverlapSec: 5 });
    assert.ok(best, "expected a match");
    assert.ok(Math.abs(best.lagSec - at / 10) <= 0.1, `lagSec ${best.lagSec} should be ~${at / 10}`);
    assert.ok(best.score > 0.99, `score ${best.score} should be near 1 for an exact slice`);
});

test("slideMatch handles a target that starts before the reference (negative lag)", () => {
    const ref = makeSignal(1000, 5);
    // target = 300 frames, of which only the last 200 overlap ref's start.
    const tgt = new Float32Array(300);
    for (let i = 0; i < 200; i += 1) tgt[100 + i] = ref[i];
    const best = dsp.slideMatch(ref, tgt, { envelopeRate: 10, minOverlapSec: 5 });
    assert.ok(best);
    // target frame 0 sits 100 frames (10s) before reference frame 0.
    assert.ok(Math.abs(best.lagSec - (-10)) <= 0.1, `lagSec ${best.lagSec} should be ~-10`);
});

// ─── buildEnvelope ────────────────────────────────────────────────────────────

function pcmBuffer(samples) {
    const buf = Buffer.alloc(samples.length * 2);
    for (let i = 0; i < samples.length; i += 1) buf.writeInt16LE(samples[i], i * 2);
    return buf;
}

test("buildEnvelope averages absolute amplitude per window", () => {
    const win = 4;
    // frame 0 → |[-100,100,-100,100]| mean 100; frame 1 → all 200 → 200.
    const samples = [-100, 100, -100, 100, 200, 200, 200, 200];
    const env = dsp.buildEnvelope(pcmBuffer(samples), win);
    assert.strictEqual(env.length, 2);
    assert.strictEqual(env[0], 100);
    assert.strictEqual(env[1], 200);
});

test("buildEnvelope drops a trailing partial window", () => {
    const win = 4;
    const samples = [10, 10, 10, 10, 10, 10]; // 1 full window + 2 leftover
    const env = dsp.buildEnvelope(pcmBuffer(samples), win);
    assert.strictEqual(env.length, 1);
    assert.strictEqual(env[0], 10);
});

// ─── buildFineTuneAnchors ─────────────────────────────────────────────────────

test("buildFineTuneAnchors makes the longest-coverage track the reference (layer 0)", () => {
    const clips = [
        { filePath: "wav", startTicks: "100", clipName: "REC.wav", trackType: "audio", trackIndex: 0, startSec: 0, endSec: 60, inPointSec: 0 },
        { filePath: "camA", startTicks: "200", clipName: "A.mov", trackType: "video", trackIndex: 0, startSec: 5, endSec: 35, inPointSec: 0 },
    ];
    const anchors = dsp.buildFineTuneAnchors(clips);
    assert.strictEqual(anchors.length, 2);
    // REC.wav (60s) has more coverage than A.mov (30s) → it is the reference.
    assert.strictEqual(anchors[0].clipName, "REC.wav");
    assert.strictEqual(anchors[0].layerOrder, 0);
    assert.strictEqual(anchors[0].isReference, true);
    assert.strictEqual(anchors[1].clipName, "A.mov");
    assert.strictEqual(anchors[1].layerOrder, 1);
});

test("buildFineTuneAnchors picks the reference by coverage, not track position", () => {
    // B-roll (two short clips) on video track 0; the long main camera on track 1.
    const clips = [
        { filePath: "broll1", startTicks: "1", clipName: "BR1.mov", trackType: "video", trackIndex: 0, startSec: 0, endSec: 15, inPointSec: 0 },
        { filePath: "broll2", startTicks: "2", clipName: "BR2.mov", trackType: "video", trackIndex: 0, startSec: 40, endSec: 60, inPointSec: 0 },
        { filePath: "main", startTicks: "3", clipName: "MAIN.mp4", trackType: "video", trackIndex: 1, startSec: 0, endSec: 600, inPointSec: 0 },
    ];
    const anchors = dsp.buildFineTuneAnchors(clips);
    const main = anchors.find(a => a.clipName === "MAIN.mp4");
    const br1 = anchors.find(a => a.clipName === "BR1.mov");
    // The main camera is the reference even though it sits on the HIGHER track.
    assert.strictEqual(main.layerOrder, 0);
    assert.strictEqual(main.isReference, true);
    assert.strictEqual(br1.layerOrder, 1);
    assert.strictEqual(br1.isReference, false);
});

test("buildFineTuneAnchors prefers the video instance when a key has both", () => {
    const clips = [
        { filePath: "camB", startTicks: "300", clipName: "B-audio", trackType: "audio", trackIndex: 2, startSec: 0, endSec: 10, inPointSec: 0 },
        { filePath: "camB", startTicks: "300", clipName: "B.mov", trackType: "video", trackIndex: 1, startSec: 0, endSec: 10, inPointSec: 0 },
    ];
    const anchors = dsp.buildFineTuneAnchors(clips);
    assert.strictEqual(anchors.length, 1);
    assert.strictEqual(anchors[0].trackType, "video");
    assert.strictEqual(anchors[0].clipName, "B.mov");
    // Only one track, so it is the reference.
    assert.strictEqual(anchors[0].layerOrder, 0);
});

test("buildFineTuneAnchors skips clips without filePath or startTicks", () => {
    const clips = [
        { filePath: "", startTicks: "1", clipName: "x", trackType: "audio", trackIndex: 0, startSec: 0, endSec: 1, inPointSec: 0 },
        { filePath: "y", startTicks: "", clipName: "y", trackType: "audio", trackIndex: 0, startSec: 0, endSec: 1, inPointSec: 0 },
    ];
    assert.strictEqual(dsp.buildFineTuneAnchors(clips).length, 0);
});

// ─── buildCompareWindow ───────────────────────────────────────────────────────

test("buildCompareWindow plans three offset windows within the overlap", () => {
    const ref = { resolvedStartSec: 0, resolvedEndSec: 30, inPointSec: 0 };
    const target = { resolvedStartSec: 0, resolvedEndSec: 30, inPointSec: 0 };
    const plan = dsp.buildCompareWindow(ref, target);
    assert.ok(plan);
    assert.strictEqual(plan.overlapSec, 30);
    assert.strictEqual(plan.compareDurationSec, 20); // capped at MAX_COMPARE
    assert.strictEqual(plan.windows.length, 3);
    // slack = 10; positions 0.5/0.2/0.8 → starts 5/2/8.
    assert.strictEqual(plan.windows[0].compareStartSec, 5);
    assert.strictEqual(plan.windows[0].refSourceOffsetSec, 5);
});

test("buildCompareWindow returns null when overlap is below the minimum", () => {
    const ref = { resolvedStartSec: 0, resolvedEndSec: 2, inPointSec: 0 };
    const target = { resolvedStartSec: 0, resolvedEndSec: 2, inPointSec: 0 };
    assert.strictEqual(dsp.buildCompareWindow(ref, target), null);
});

// ─── formatting ───────────────────────────────────────────────────────────────

test("formatDuration renders h/m/s", () => {
    assert.strictEqual(dsp.formatDuration(0), "0s");
    assert.strictEqual(dsp.formatDuration(65000), "1m 5s");
    assert.strictEqual(dsp.formatDuration(3661000), "1h 1m 1s");
});

test("formatSignedSeconds always carries an explicit sign", () => {
    assert.strictEqual(dsp.formatSignedSeconds(0.1234), "+0.123s");
    assert.strictEqual(dsp.formatSignedSeconds(-1.5), "-1.5s");
    assert.strictEqual(dsp.formatSignedSeconds(0), "+0s");
});

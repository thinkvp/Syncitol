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

test("findBestLag flags a peak pinned to the ±maxShift search limit", () => {
    const L = 600;
    const base = makeSignal(L, 3);
    // Delay of 49 frames at 10 Hz with maxShift 5s (= 50 frames) → recovered lag of
    // 4.9s sits right at the search boundary.
    const D = 49;
    const target = new Float32Array(L);
    for (let i = D; i < L; i += 1) target[i] = base[i - D];
    const best = dsp.findBestLag(base, target, { envelopeRate: 10, maxShiftSec: 5, minOverlapSec: 1 });
    assert.ok(best, "expected a candidate");
    assert.ok(Math.abs(best.lagSec - 4.9) <= 0.11, `lagSec ${best.lagSec} should be ~4.9`);
    assert.strictEqual(best.atRail, true);
});

test("findBestLag does not flag an interior peak", () => {
    const L = 600;
    const base = makeSignal(L, 3);
    const D = 10; // 1.0s at 10 Hz — comfortably inside ±5s
    const target = new Float32Array(L);
    for (let i = D; i < L; i += 1) target[i] = base[i - D];
    const best = dsp.findBestLag(base, target, { envelopeRate: 10, maxShiftSec: 5, minOverlapSec: 1 });
    assert.ok(best && best.atRail === false, `expected interior, got ${JSON.stringify(best)}`);
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

test("slideMatch honours a raised overlap floor (rejects short edge matches)", () => {
    const ref = makeSignal(600, 23);
    // The target's last 50 frames replicate ref's first 50 → a perfect but tiny
    // (5s @ 10 Hz) overlap when the target hangs off the left edge. This mimics the
    // spurious short-overlap edge a bounded coarse window can produce.
    const tgt = new Float32Array(200);
    for (let i = 0; i < 50; i += 1) tgt[150 + i] = ref[i];

    const lax = dsp.slideMatch(ref, tgt, { envelopeRate: 10, minOverlapSec: 3 });
    assert.ok(lax && lax.score > 0.99 && Math.abs(lax.overlapSec - 5) <= 0.2,
        `lax should lock the 5s edge, got ${JSON.stringify(lax)}`);

    // Requiring ≥8s overlap excludes that 5s edge — exactly how the coarse pass now
    // stops a few seconds of unrelated audio from shifting a whole track.
    const strict = dsp.slideMatch(ref, tgt, { envelopeRate: 10, minOverlapSec: 8 });
    assert.ok(!strict || strict.overlapSec >= 8,
        `strict must not return a sub-8s overlap, got ${JSON.stringify(strict)}`);
    assert.ok(!strict || strict.score < 0.99,
        `strict must not return the perfect 5s edge, got ${JSON.stringify(strict)}`);
});

// ─── planCoarseSearch ───────────────────────────────────────────────────────────

const COARSE_CFG = {
    minOverlapSec: 8, targetMaxSec: 120, tcConfirmSec: 30, predictMarginSec: 300,
    headSec: 720, minScore: 0.3, strongScore: 0.5, confirmNearSec: 90,
};

// A reference 2h long; target placed `tsErrorSec` later than truth on the timeline.
function coarseGeom(tsErrorSec, opts) {
    opts = opts || {};
    return {
        refInPointSec: 0,
        refDurationFull: 7200,
        refResolvedStartSec: 0,
        targetInPointSec: 0,
        targetResolvedStartSec: tsErrorSec,
        targetAvailSec: opts.targetAvailSec || 6000,
        tcDelta: (opts.tcDelta === undefined ? null : opts.tcDelta),
    };
}

test("planCoarseSearch omits the timecode plan without a TC delta, keeps order", () => {
    const plans = dsp.planCoarseSearch(coarseGeom(639), COARSE_CFG);
    assert.deepStrictEqual(plans.map(p => p.label), ["timestamp", "head", "full"]);
    const ts = plans[0];
    assert.strictEqual(ts.predicts, true);
    // predTs = 639; window = [639-300, 639+120+300] → start 339, dur 720.
    assert.strictEqual(ts.winStart, 339);
    assert.strictEqual(ts.winDur, 720);
    const head = plans[1];
    assert.strictEqual(head.winStart, 0);
    assert.strictEqual(head.winDur, 720);
    assert.strictEqual(head.probeDur, 720); // symmetric long probe
    assert.strictEqual(head.predicts, false);
});

test("planCoarseSearch adds a tight timecode plan when a TC delta is present", () => {
    const plans = dsp.planCoarseSearch(coarseGeom(639, { tcDelta: 5 }), COARSE_CFG);
    assert.strictEqual(plans[0].label, "timecode");
    assert.strictEqual(plans[0].predicts, true);
    // predRefSrc = 0 + 5; window = [5-30, 5+120+30] clamped to ref start 0.
    assert.strictEqual(plans[0].winStart, 0);
});

test("planCoarseSearch clamps windows to the reference and dedupes identical ones", () => {
    // Short reference so head and full collapse to the same window/probe.
    const geom = { refInPointSec: 0, refDurationFull: 200, refResolvedStartSec: 0,
        targetInPointSec: 0, targetResolvedStartSec: 0, targetAvailSec: 60, tcDelta: null };
    const plans = dsp.planCoarseSearch(geom, COARSE_CFG);
    for (const p of plans) {
        assert.ok(p.winStart >= 0 && p.winStart + p.winDur <= 200, `window out of range: ${JSON.stringify(p)}`);
    }
    // head [0,200] probe 60 and full [0,200] probe 60 are identical → one survives.
    const labels = plans.map(p => p.label);
    assert.ok(!(labels.includes("head") && labels.includes("full")), `head/full not deduped: ${labels}`);
});

// ─── coarseConsider / coarseResolve ─────────────────────────────────────────────

// Drive the selection the way main.js does, but with a scripted matcher instead of
// ffmpeg, recording which plan labels were actually decoded.
function runCoarse(geom, byLabel) {
    const cfg = COARSE_CFG;
    const plans = dsp.planCoarseSearch(geom, cfg);
    const state = dsp.createCoarseState();
    const queried = [];
    for (const plan of plans) {
        if (plan.label === "full" && state.skipFull) continue;
        queried.push(plan.label);
        const candidate = byLabel[plan.label] || null;
        if (dsp.coarseConsider(state, plan, candidate, geom, cfg)) break;
    }
    return { result: dsp.coarseResolve(state, geom, cfg), queried };
}

test("coarse: a strong match anywhere overrides a wrong metadata prediction (MXF case)", () => {
    // Metadata 639s late; weak in-window spurious; the head pass matches the
    // near-simultaneous camera strongly at lag 0 → full ~-639s correction.
    const geom = coarseGeom(639);
    const { result, queried } = runCoarse(geom, {
        timestamp: { score: 0.36, lagSec: 86 },  // implied delta -214 → not confirmed
        head: { score: 0.72, lagSec: 0 },
    });
    assert.strictEqual(result.chosen.label, "head");
    assert.strictEqual(result.coarseDelta, -639);
    assert.ok(!queried.includes("full"), "strong head match should stop before full");
});

test("coarse: weak audio never lets a far spurious beat the prediction neighborhood", () => {
    // Reliable metadata (~0 error). A far, sub-strong full-scan peak must NOT win;
    // the near prediction match is kept.
    const geom = coarseGeom(0);
    const { result } = runCoarse(geom, {
        timestamp: { score: 0.31, lagSec: -150 }, // implied delta -150 → not confirmed → full runs
        head: { score: 0.2, lagSec: 0 },
        full: { score: 0.45, lagSec: 4000 },      // strong-ish but < 0.5 → must be ignored
    });
    assert.strictEqual(result.chosen.label, "timestamp");
    assert.strictEqual(result.chosen.score, 0.31);
});

test("coarse: a confirmed prediction skips the full scan but still runs head", () => {
    const geom = coarseGeom(0);
    const { result, queried } = runCoarse(geom, {
        timestamp: { score: 0.34, lagSec: 0 }, // implied delta 0 → confirmed
        head: { score: 0.2, lagSec: 0 },
    });
    assert.ok(queried.includes("head"), "head should still run as a safety net");
    assert.ok(!queried.includes("full"), "confirmed prediction should skip the full scan");
    assert.strictEqual(result.chosen.label, "timestamp");
    assert.ok(Math.abs(result.coarseDelta) < 0.001, `expected ~0 shift, got ${result.coarseDelta}`);
});

test("coarse: a strong predictor match stops immediately", () => {
    const geom = coarseGeom(0);
    const { queried } = runCoarse(geom, {
        timestamp: { score: 0.6, lagSec: 0 }, // strong → stop at once
        head: { score: 0.9, lagSec: 0 },
    });
    assert.deepStrictEqual(queried, ["timestamp"]);
});

test("coarse: nothing confident leaves the track to the fine pass", () => {
    const geom = coarseGeom(0);
    const { result } = runCoarse(geom, {
        timestamp: { score: 0.1, lagSec: 0 },
        head: { score: 0.15, lagSec: 0 },
        full: { score: 0.2, lagSec: 100 },
    });
    assert.strictEqual(result.chosen, null);
    assert.strictEqual(result.coarseDelta, null);
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

test("buildCompareWindow plans offset windows within the overlap", () => {
    const ref = { resolvedStartSec: 0, resolvedEndSec: 30, inPointSec: 0 };
    const target = { resolvedStartSec: 0, resolvedEndSec: 30, inPointSec: 0 };
    const plan = dsp.buildCompareWindow(ref, target);
    assert.ok(plan);
    assert.strictEqual(plan.overlapSec, 30);
    assert.strictEqual(plan.compareDurationSec, 10); // capped at MAX_COMPARE
    assert.strictEqual(plan.windows.length, 2);
    // slack = 20; positions 0.5/0.2 → starts 10/4.
    assert.strictEqual(plan.windows[0].compareStartSec, 10);
    assert.strictEqual(plan.windows[0].refSourceOffsetSec, 10);
    assert.strictEqual(plan.windows[1].compareStartSec, 4);
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

// ─── parseTimecodeToSeconds ─────────────────────────────────────────────────────

test("parseTimecodeToSeconds converts time-of-day TC with frames", () => {
    // 09:29:13:12 at 25 fps → 9*3600 + 29*60 + 13 + 12/25.
    const sec = dsp.parseTimecodeToSeconds("09:29:13:12", 25);
    assert.ok(Math.abs(sec - (9 * 3600 + 29 * 60 + 13 + 12 / 25)) < 1e-9, `got ${sec}`);
});

test("parseTimecodeToSeconds gives a usable cross-file delta", () => {
    // Two cameras' start TC ~10m39s apart → that is the predicted offset.
    const a = dsp.parseTimecodeToSeconds("09:18:34:00", 25);
    const b = dsp.parseTimecodeToSeconds("09:29:13:00", 25);
    assert.ok(Math.abs((b - a) - (10 * 60 + 39)) < 1e-9, `delta ${b - a}`);
});

test("parseTimecodeToSeconds accepts drop-frame separator and defaults fps", () => {
    assert.ok(dsp.parseTimecodeToSeconds("01:00:00;00", 29.97) !== null);
    assert.ok(Math.abs(dsp.parseTimecodeToSeconds("00:00:01:00") - 1) < 0.05); // default 25 fps
});

test("parseTimecodeToSeconds returns null for junk", () => {
    assert.strictEqual(dsp.parseTimecodeToSeconds("not-a-tc", 25), null);
    assert.strictEqual(dsp.parseTimecodeToSeconds(null, 25), null);
});

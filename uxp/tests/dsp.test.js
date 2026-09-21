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
    learnedMarginSec: 120, verifyMarginSec: 120,
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

// ─── planLearnedSearch ──────────────────────────────────────────────────────────

test("planLearnedSearch centers a confirm window on another track's offset", () => {
    // The motivating real-world case: track 1 proved -641.8s; this track's rep
    // clip sits at 5800s on the timeline with ~500s of audio available.
    const geom = {
        refInPointSec: 0, refDurationFull: 7200, refResolvedStartSec: 0,
        targetInPointSec: 0, targetResolvedStartSec: 5800, targetAvailSec: 500, tcDelta: null,
    };
    const plan = dsp.planLearnedSearch(geom, COARSE_CFG, -641.8);
    assert.ok(plan, "expected a learned plan");
    assert.strictEqual(plan.label, "learned");
    assert.strictEqual(plan.predicts, true);
    assert.strictEqual(plan.predictedDeltaSec, -641.8);
    // Predicted ref source = 5800 - 641.8 = 5158.2; window ±120 around
    // [predRefSrc, predRefSrc + probe(120)].
    assert.ok(Math.abs(plan.winStart - (5158.2 - 120)) < 1e-9, `winStart ${plan.winStart}`);
    assert.ok(Math.abs(plan.winDur - (120 + 120 + 120)) < 1e-9, `winDur ${plan.winDur}`);
    assert.strictEqual(plan.probeDur, 120);
    // A true offset 22s away from the hint (as in the real log) is inside it.
    const actualRefSrc = 5800 - 619.7;
    assert.ok(actualRefSrc > plan.winStart && actualRefSrc < plan.winStart + plan.winDur,
        "the sibling camera's true offset must fall inside the learned window");
});

test("planLearnedSearch clamps to the reference and rejects out-of-range hints", () => {
    const geom = {
        refInPointSec: 0, refDurationFull: 7200, refResolvedStartSec: 0,
        targetInPointSec: 0, targetResolvedStartSec: 60, targetAvailSec: 500, tcDelta: null,
    };
    // Hint near the reference start: window clamps at 0.
    const clamped = dsp.planLearnedSearch(geom, COARSE_CFG, -30);
    assert.ok(clamped);
    assert.strictEqual(clamped.winStart, 0);
    // Hint far beyond the reference end: nothing to search.
    assert.strictEqual(dsp.planLearnedSearch(geom, COARSE_CFG, 100000), null);
});

test("learned plan drives coarseConsider/coarseResolve to the sibling's offset", () => {
    const geom = {
        refInPointSec: 0, refDurationFull: 7200, refResolvedStartSec: 0,
        targetInPointSec: 0, targetResolvedStartSec: 5800, targetAvailSec: 500, tcDelta: null,
    };
    const plan = dsp.planLearnedSearch(geom, COARSE_CFG, -641.8);
    const state = dsp.createCoarseState();
    // The matcher finds the true spot 22.1s later than the hint predicted:
    // matchedRefSrc = 5800 - 619.7 → lag = that - winStart.
    const lagSec = (5800 - 619.7) - plan.winStart;
    const stop = dsp.coarseConsider(state, plan, { score: 0.72, lagSec }, geom, COARSE_CFG);
    assert.strictEqual(stop, true, "a strong learned match should stop the search");
    const result = dsp.coarseResolve(state, geom, COARSE_CFG);
    assert.strictEqual(result.chosen.label, "learned");
    assert.ok(Math.abs(result.coarseDelta - (-619.7)) < 0.01, `coarseDelta ${result.coarseDelta}`);
});

// ─── coarseConsider / coarseResolve ─────────────────────────────────────────────

// Drive the selection the way main.js does, but with a scripted matcher instead of
// the decoder, recording which plan labels were actually decoded.
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

test("coarse: a weak match near the TIMECODE's own predicted delta confirms it", () => {
    // Timestamps are 639s wrong but both files share a TC clock (tcDelta 0), so
    // the timecode plan PREDICTS delta ≈ -639. A weak match landing near that
    // prediction must set skipFull relative to the plan's own claim — not the
    // timestamp position (the pre-1.3.1 behavior, which never confirmed here).
    const geom = coarseGeom(639, { tcDelta: 0 });
    const { result, queried } = runCoarse(geom, {
        timecode: { score: 0.35, lagSec: 10 }, // implied delta -629, 10s from the TC claim
        head: { score: 0.2, lagSec: 0 },
    });
    assert.ok(queried.includes("head"), "head should still run as a safety net");
    assert.ok(!queried.includes("full"), "a TC-confirmed weak match should skip the full scan");
    assert.strictEqual(result.chosen.label, "timecode");
    assert.ok(Math.abs(result.coarseDelta - (-629)) < 0.01, `coarseDelta ${result.coarseDelta}`);
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

// ─── pickProbeWindows / planCoarseVerify ──────────────────────────────────────

// A recorder left running before the shoot: `silenceSec` of room tone, then real
// content. Room tone still has noise — the point is that its SPREAD is tiny.
function leadInSilenceEnvelope(silenceSec, contentSec, rate) {
    const env = new Float32Array(Math.round((silenceSec + contentSec) * rate));
    const quiet = Math.round(silenceSec * rate);
    for (let i = 0; i < env.length; i += 1) {
        env[i] = i < quiet
            ? 20 + ((i % 7) - 3)                     // room tone: ~20 ±3
            : 3000 + 2500 * Math.sin(i / 9);         // speech: large swings
    }
    return env;
}

test("pickProbeWindows skips a silent lead-in and probes the real content", () => {
    const rate = 10;
    const env = leadInSilenceEnvelope(300, 600, rate); // 5 min silence, 10 min content
    const [best] = dsp.pickProbeWindows(env, rate, 120, 1);
    assert.ok(best, "a window must be selected");
    // The probe must be essentially all content — not merely straddling the
    // boundary, which is what a variance-ranked pick does (it maximises spread by
    // wasting half the probe on room tone). Landing a frame or two early to catch
    // the onset edge is fine and mildly useful.
    const silentFraction = Math.max(0, 300 - best.offsetSec) / 120;
    assert.ok(silentFraction < 0.02,
        `probe should be nearly all content; ${(silentFraction * 100).toFixed(1)}% was room tone (offset ${best.offsetSec}s)`);
    // The old behaviour probed at offset 0 — pure room tone.
    assert.ok(best.offsetSec > 0, "the head of this clip is silence and must not be chosen");
});

test("pickProbeWindows returns non-overlapping windows, best first", () => {
    const rate = 10;
    const env = leadInSilenceEnvelope(60, 900, rate);
    const picks = dsp.pickProbeWindows(env, rate, 120, 2);
    assert.strictEqual(picks.length, 2);
    assert.ok(picks[0].activity >= picks[1].activity, "windows must be ranked by activity");
    assert.ok(Math.abs(picks[0].offsetSec - picks[1].offsetSec) >= 120,
        "the confirmation window must not overlap the probe window");
});

test("pickProbeWindows rates room tone far below real content", () => {
    const rate = 10;
    const env = leadInSilenceEnvelope(300, 600, rate);
    const quiet = dsp.pickProbeWindows(env.slice(0, 300 * rate), rate, 120, 1)[0];
    const loud = dsp.pickProbeWindows(env.slice(300 * rate), rate, 120, 1)[0];
    assert.ok(loud.activity > quiet.activity * 10,
        `content ${loud.activity} should dwarf room tone ${quiet.activity}`);
});

test("pickProbeWindows falls back to the whole clip when it is shorter than the probe", () => {
    // Callers ask for a probe as long as min(clipLength, targetMax), so on any
    // clip under the cap the request equals the envelope and one sample of
    // rounding used to mean "no window at all" — which silently disabled the
    // relay retry and the confirmation pass for every short clip.
    const env = new Float32Array(100);
    for (let i = 0; i < env.length; i += 1) env[i] = Math.abs(Math.sin(i / 7)) * 100;
    const [best] = dsp.pickProbeWindows(env, 10, 120, 2);
    assert.ok(best, "the window is the clip");
    assert.strictEqual(best.offsetSec, 0);
});

test("pickProbeWindows still gives up on an envelope too short to mean anything", () => {
    assert.deepStrictEqual(dsp.pickProbeWindows(new Float32Array(1), 10, 120, 2), []);
});

test("pickProbeWindows is stable on a perfectly flat envelope", () => {
    const env = new Float32Array(3000).fill(1200); // constant, loud
    const [best] = dsp.pickProbeWindows(env, 10, 60, 1);
    assert.ok(best, "a window is still returned");
    assert.ok(Number.isFinite(best.activity) && best.activity >= 0, `activity ${best.activity}`);
});

test("pickProbeWindowsSpread returns one window per region, covering the whole clip", () => {
    // The failure this guards: a recorder started ~20 min before the cameras has
    // its LOUDEST audio in that solo stretch, so every top-N window clustered
    // there — and a probe from there can never match any camera. Spread picking
    // must surface windows from later regions too.
    const rate = 10;
    const total = 6000; // 100 min
    const env = new Float32Array(total * rate);
    for (let i = 0; i < env.length; i += 1) {
        const t = i / rate;
        const loudness = t < 1500 ? 4000 : 1500; // head solo stretch is loudest
        env[i] = loudness + loudness * 0.8 * Math.sin(i / 7);
    }
    const wins = dsp.pickProbeWindowsSpread(env, rate, 120, 4);
    assert.strictEqual(wins.length, 4);
    // Best-first: the loud head region wins overall…
    assert.ok(wins[0].offsetSec < 1500, `top window should be in the head, got ${wins[0].offsetSec}`);
    // …but every quarter contributes a window, so retries reach the later regions.
    const quarters = new Set(wins.map(w => Math.min(3, Math.floor(w.offsetSec / (total / 4)))));
    assert.strictEqual(quarters.size, 4, `windows must span all quarters, got offsets ${wins.map(w => Math.round(w.offsetSec)).join(", ")}`);
});

test("pickProbeWindowsSpread falls back to plain picking on short clips", () => {
    const rate = 10;
    const env = leadInSilenceEnvelope(60, 240, rate); // 5 min total < 4 segments × 2 min
    const wins = dsp.pickProbeWindowsSpread(env, rate, 120, 4);
    assert.ok(wins.length >= 1, "short clips still yield windows");
    for (let i = 1; i < wins.length; i += 1) {
        assert.ok(Math.abs(wins[0].offsetSec - wins[i].offsetSec) >= 120, "fallback windows must not overlap");
    }
});

test("pickProbeWindowsSpread falls back to the whole clip when it is shorter than the probe", () => {
    const env = new Float32Array(100);
    for (let i = 0; i < env.length; i += 1) env[i] = Math.abs(Math.sin(i / 7)) * 100;
    const windows = dsp.pickProbeWindowsSpread(env, 10, 120, 4);
    assert.strictEqual(windows.length, 1, "one window, covering the whole clip");
});

test("pickProbeWindowsSpread survives an envelope one sample short of the probe", () => {
    // The exact shape that stopped a 27s clip from ever reaching the relay pass.
    const env = new Float32Array(269);
    for (let i = 0; i < env.length; i += 1) env[i] = Math.abs(Math.sin(i / 7)) * 100;
    assert.strictEqual(dsp.pickProbeWindowsSpread(env, 10, 27, 4).length, 1);
});

test("planCoarseVerify aims at where the second probe should land", () => {
    // Reference source 0..7200 at timeline 0; target probe origin at timeline 100.
    // A -40s shift puts the probe at timeline 60; a second probe 300s later in the
    // recording therefore belongs at timeline 360 → reference source 360.
    const geom = {
        refInPointSec: 0, refDurationFull: 7200, refResolvedStartSec: 0,
        targetInPointSec: 0, targetResolvedStartSec: 100, targetAvailSec: 3600, tcDelta: null
    };
    const plan = dsp.planCoarseVerify(geom, COARSE_CFG, -40, 300, 120);
    assert.ok(plan);
    // Window is centred on 360 with the configured margin either side.
    assert.strictEqual(plan.winStart, 360 - COARSE_CFG.verifyMarginSec);
    assert.ok(Math.abs(plan.expectedLagSec - COARSE_CFG.verifyMarginSec) < 1e-9,
        `a correct offset should produce lag ${COARSE_CFG.verifyMarginSec}, got ${plan.expectedLagSec}`);
});

test("planCoarseVerify declines when the reference doesn't reach the second probe", () => {
    const geom = {
        refInPointSec: 0, refDurationFull: 600, refResolvedStartSec: 0,
        targetInPointSec: 0, targetResolvedStartSec: 0, targetAvailSec: 3600, tcDelta: null
    };
    // Second probe sits 5000s in — far past the end of a 600s reference.
    assert.strictEqual(dsp.planCoarseVerify(geom, COARSE_CFG, 0, 5000, 120), null);
});

test("planCoarseVerify handles a confirmation window EARLIER than the probe", () => {
    const geom = {
        refInPointSec: 0, refDurationFull: 7200, refResolvedStartSec: 0,
        targetInPointSec: 0, targetResolvedStartSec: 1000, targetAvailSec: 3600, tcDelta: null
    };
    const plan = dsp.planCoarseVerify(geom, COARSE_CFG, 0, -400, 120);
    assert.ok(plan, "a negative relative offset is valid");
    assert.strictEqual(plan.winStart, 600 - COARSE_CFG.verifyMarginSec);
});

// ─── coarseResolveBest (multi-candidate reference selection) ──────────────────

// Build a resolved candidate by driving `state` through a scripted matcher, the
// way analyzeCoarseAlign does per reference candidate.
function candidate(geom, byLabel, cfg) {
    cfg = cfg || COARSE_CFG;
    const state = dsp.createCoarseState();
    for (const plan of dsp.planCoarseSearch(geom, cfg)) {
        if (plan.label === "full" && state.skipFull) continue;
        const c = byLabel[plan.label] || null;
        if (dsp.coarseConsider(state, plan, c, geom, cfg)) break;
    }
    return { state, geom };
}

test("coarseResolveBest picks the reference candidate the audio actually matches", () => {
    // The real-world failure: a second recorder that ran only in the afternoon.
    // Candidate 0 is the LONGEST reference clip (the morning file) — unrelated
    // content, so only a noise peak. Candidate 1 is the afternoon file it was
    // actually recorded alongside. Scoring only candidate 0 (the pre-fix
    // behavior) locked in the 0.48 noise match and parked the clip hours away.
    const morning = candidate(coarseGeom(0), { timestamp: { score: 0.48, lagSec: 12 } });
    const afternoon = candidate(coarseGeom(0), { timestamp: { score: 0.91, lagSec: -4 } });

    const pick = dsp.coarseResolveBest([morning, afternoon], COARSE_CFG);
    assert.strictEqual(pick.index, 1, "the higher-scoring reference must win");
    assert.strictEqual(pick.result.chosen.score, 0.91);
    assert.ok(Math.abs(pick.result.coarseDelta - (-4)) < 0.01, `delta ${pick.result.coarseDelta}`);

    // Scoring the longest candidate alone is what produced the wrong answer.
    const aloneDelta = dsp.coarseResolve(morning.state, morning.geom, COARSE_CFG).coarseDelta;
    assert.ok(Math.abs(aloneDelta - 12) < 0.01, `single-candidate delta ${aloneDelta}`);
});

test("coarseResolveBest reports the best score seen when NO candidate is confident", () => {
    const a = candidate(coarseGeom(0), { timestamp: { score: 0.11, lagSec: 3 }, head: { score: 0.18, lagSec: 0 } });
    const b = candidate(coarseGeom(0), { timestamp: { score: 0.22, lagSec: 9 }, head: { score: 0.07, lagSec: 0 } });

    const pick = dsp.coarseResolveBest([a, b], COARSE_CFG);
    assert.strictEqual(pick.result, null);
    assert.strictEqual(pick.index, -1);
    assert.strictEqual(pick.best.score, 0.22, "best-seen drives the 'no confident match' message");
});

test("coarseResolveBest tolerates an empty candidate list", () => {
    const pick = dsp.coarseResolveBest([], COARSE_CFG);
    assert.strictEqual(pick.result, null);
    assert.strictEqual(pick.index, -1);
    assert.strictEqual(pick.best, null);
});

test("an untrusted clock stops a weak Build-position match from being accepted", () => {
    // The guard analyzeCoarseAlign applies to mtime-derived clips in a sequence
    // whose devices disagree about the date: raise minScore to strongScore so a
    // prediction from a meaningless Build position can't qualify on the low bar.
    const byLabel = { timestamp: { score: 0.42, lagSec: 30 }, head: { score: 0.2, lagSec: 0 }, full: { score: 0.2, lagSec: 0 } };

    const trusting = candidate(coarseGeom(0), byLabel, COARSE_CFG);
    assert.strictEqual(dsp.coarseResolve(trusting.state, trusting.geom, COARSE_CFG).chosen.score, 0.42,
        "normally a 0.42 prediction clears the 0.30 bar");

    const strictCfg = Object.assign({}, COARSE_CFG, { minScore: COARSE_CFG.strongScore });
    const guarded = candidate(coarseGeom(0), byLabel, strictCfg);
    assert.strictEqual(dsp.coarseResolve(guarded.state, guarded.geom, strictCfg).chosen, null,
        "with an untrusted clock the same weak prediction is rejected");
});

test("DRIFT_IMPLAUSIBLE_PPM sits far above real hardware drift", () => {
    // Two consumer crystals at ±100 ppm each give ~200 ppm relative worst case.
    // The rejection bar must clear that, or good syncs get thrown away.
    assert.ok(dsp.DRIFT_IMPLAUSIBLE_PPM > 200, "must not reject plausible hardware drift");
});

// ─── buildEnvelope ────────────────────────────────────────────────────────────
// UXP delta: buildEnvelope takes an Int16Array of mono samples (from the native
// addon) instead of a Node Buffer of s16le bytes.

test("buildEnvelope averages absolute amplitude per window", () => {
    const win = 4;
    // frame 0 → |[-100,100,-100,100]| mean 100; frame 1 → all 200 → 200.
    const samples = new Int16Array([-100, 100, -100, 100, 200, 200, 200, 200]);
    const env = dsp.buildEnvelope(samples, win);
    assert.strictEqual(env.length, 2);
    assert.strictEqual(env[0], 100);
    assert.strictEqual(env[1], 200);
});

test("buildEnvelope drops a trailing partial window", () => {
    const win = 4;
    const samples = new Int16Array([10, 10, 10, 10, 10, 10]); // 1 full window + 2 leftover
    const env = dsp.buildEnvelope(samples, win);
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

test("buildFineTuneAnchors collapses a file's instances to ONE anchor even at different positions", () => {
    // Regression: a buggy Build once placed a camera's video and its linked
    // audio at different timeline positions. Fine tune must still treat them as
    // one file (one anchor → one shift for every instance) — computing separate
    // shifts for video vs audio of the SAME file tears A/V apart permanently.
    const clips = [
        { filePath: "camB", startTicks: "9000", clipName: "B-audio", trackType: "audio", trackIndex: 2, startSec: 120, endSec: 130, inPointSec: 0 },
        { filePath: "camB", startTicks: "300", clipName: "B.mov", trackType: "video", trackIndex: 1, startSec: 0, endSec: 10, inPointSec: 0 },
        { filePath: "wav", startTicks: "1", clipName: "REC.wav", trackType: "audio", trackIndex: 4, startSec: 0, endSec: 60, inPointSec: 0 },
    ];
    const anchors = dsp.buildFineTuneAnchors(clips);
    assert.strictEqual(anchors.length, 2);
    const camB = anchors.find(a => a.filePath === "camB");
    // Video-preferred: the anchor reflects the video instance.
    assert.strictEqual(camB.trackType, "video");
    assert.strictEqual(camB.clipName, "B.mov");
    assert.strictEqual(camB.startSec, 0);
    // Anchor identity is the file path — the apply step fans one delta out to
    // every instance of the file.
    assert.strictEqual(camB.key, "camB");
});

test("buildFineTuneAnchors anchors same-type duplicates at the earliest instance", () => {
    const clips = [
        { filePath: "wav", startTicks: "500", clipName: "REC.wav", trackType: "audio", trackIndex: 4, startSec: 50, endSec: 110, inPointSec: 0 },
        { filePath: "wav", startTicks: "10", clipName: "REC.wav", trackType: "audio", trackIndex: 5, startSec: 1, endSec: 61, inPointSec: 0 },
        { filePath: "camA", startTicks: "1", clipName: "A.mov", trackType: "video", trackIndex: 0, startSec: 0, endSec: 200, inPointSec: 0 },
    ];
    const anchors = dsp.buildFineTuneAnchors(clips);
    const wav = anchors.find(a => a.filePath === "wav");
    assert.strictEqual(wav.startSec, 1);
    assert.strictEqual(wav.trackIndex, 5);
});

test("buildFineTuneAnchors skips clips without filePath or startTicks", () => {
    const clips = [
        { filePath: "", startTicks: "1", clipName: "x", trackType: "audio", trackIndex: 0, startSec: 0, endSec: 1, inPointSec: 0 },
        { filePath: "y", startTicks: "", clipName: "y", trackType: "audio", trackIndex: 0, startSec: 0, endSec: 1, inPointSec: 0 },
    ];
    assert.strictEqual(dsp.buildFineTuneAnchors(clips).length, 0);
});

// ─── planReferenceLayer / forced reference track ───────────────────────────────

// A two-camera + field-recorder sequence: each camera's audio is linked onto an
// audio track, so choosing an audio track must still select the right FILES.
function multicamClips() {
    return [
        { filePath: "camA", startTicks: "1", clipName: "A.mov", trackType: "video", trackIndex: 0, startSec: 0, endSec: 600, inPointSec: 0 },
        { filePath: "camA", startTicks: "1", clipName: "A.mov", trackType: "audio", trackIndex: 0, startSec: 0, endSec: 600, inPointSec: 0 },
        { filePath: "camB", startTicks: "2", clipName: "B.mov", trackType: "video", trackIndex: 1, startSec: 10, endSec: 200, inPointSec: 0 },
        { filePath: "camB", startTicks: "2", clipName: "B.mov", trackType: "audio", trackIndex: 1, startSec: 10, endSec: 200, inPointSec: 0 },
        { filePath: "wav", startTicks: "3", clipName: "REC.wav", trackType: "audio", trackIndex: 2, startSec: 5, endSec: 400, inPointSec: 0 },
    ];
}

test("planReferenceLayer picks the most-covered track when nothing is forced", () => {
    const clips = multicamClips();
    const anchors = dsp.buildFineTuneAnchors(clips);
    const plan = dsp.planReferenceLayer(anchors, clips, null);
    assert.strictEqual(plan.forced, false);
    assert.strictEqual(plan.refTrackKey, "video_0"); // camA, 600s — the longest
    assert.strictEqual(plan.fallbackReason, null);
});

test("a forced track makes ITS recordings the reference layer", () => {
    const clips = multicamClips();
    const anchors = dsp.buildFineTuneAnchors(clips, "audio_2"); // the field recorder
    const wav = anchors.find(a => a.filePath === "wav");
    const camA = anchors.find(a => a.filePath === "camA");
    assert.strictEqual(wav.isReference, true);
    assert.strictEqual(wav.layerOrder, 0);
    assert.strictEqual(camA.isReference, false);
    assert.strictEqual(camA.layerOrder, 1);
    // The reference sorts first, so the coarse pass treats it as the base layer.
    assert.strictEqual(anchors[0].filePath, "wav");
});

test("forcing a camera's AUDIO track selects that camera, not its anchor track", () => {
    // camB anchors to its video instance (video-preferred), yet picking the audio
    // track its linked audio sits on must still make camB the reference.
    const clips = multicamClips();
    const anchors = dsp.buildFineTuneAnchors(clips, "audio_1");
    const camB = anchors.find(a => a.filePath === "camB");
    assert.strictEqual(camB.trackType, "video"); // anchor is still the video instance
    assert.strictEqual(camB.isReference, true);
    assert.strictEqual(anchors.filter(a => a.isReference).length, 1);
    const plan = dsp.planReferenceLayer(anchors, clips, "audio_1");
    assert.strictEqual(plan.forced, true);
    assert.strictEqual(plan.refTrackKey, "audio_1");
});

test("a forced track holding every file falls back to Auto with a reason", () => {
    // The realistic mistake: one audio track carries every camera's linked audio,
    // so forcing it would leave nothing to align to it.
    const clips = [
        { filePath: "camA", startTicks: "1", clipName: "A.mov", trackType: "video", trackIndex: 0, startSec: 0, endSec: 600, inPointSec: 0 },
        { filePath: "camA", startTicks: "1", clipName: "A.mov", trackType: "audio", trackIndex: 0, startSec: 0, endSec: 600, inPointSec: 0 },
        { filePath: "camB", startTicks: "2", clipName: "B.mov", trackType: "video", trackIndex: 1, startSec: 10, endSec: 200, inPointSec: 0 },
        { filePath: "camB", startTicks: "2", clipName: "B.mov", trackType: "audio", trackIndex: 0, startSec: 10, endSec: 200, inPointSec: 0 },
    ];
    const anchors = dsp.buildFineTuneAnchors(clips, "audio_0");
    const plan = dsp.planReferenceLayer(anchors, clips, "audio_0");
    assert.strictEqual(plan.forced, false);
    assert.strictEqual(plan.rejectedTrackKey, "audio_0");
    assert.ok(/every clip/.test(plan.fallbackReason), plan.fallbackReason);
    // Auto took over: the most-covered track (camA on V1) is the reference.
    assert.strictEqual(plan.refTrackKey, "video_0");
    assert.strictEqual(anchors.filter(a => a.isReference).length, 1);
    assert.strictEqual(anchors[0].filePath, "camA");
});

test("a forced track with no usable clip falls back to Auto with a reason", () => {
    const clips = multicamClips();
    const anchors = dsp.buildFineTuneAnchors(clips, "audio_7"); // empty / gone
    const plan = dsp.planReferenceLayer(anchors, clips, "audio_7");
    assert.strictEqual(plan.forced, false);
    assert.strictEqual(plan.rejectedTrackKey, "audio_7");
    assert.ok(/no clip/.test(plan.fallbackReason), plan.fallbackReason);
    assert.strictEqual(plan.refTrackKey, "video_0");
});

test("trackKeyLabel renders a 1-based track label", () => {
    assert.strictEqual(dsp.trackKeyLabel("audio_2"), "AUDIO 3");
    assert.strictEqual(dsp.trackKeyLabel("video_0"), "VIDEO 1");
    assert.strictEqual(dsp.trackKeyLabel(null), "");
});

// ─── diffInstanceMovement (A/V integrity) ─────────────────────────────────────

// One camera file, video on V1 and its linked audio on A1, both at t=0.
function linkedPair(startSec) {
    return [
        { filePath: "camA", clipName: "A.mov", trackType: "video", trackIndex: 0, startSec, endSec: startSec + 60 },
        { filePath: "camA", clipName: "A.mov", trackType: "audio", trackIndex: 0, startSec, endSec: startSec + 60 }
    ];
}

test("diffInstanceMovement is silent when a file's instances move together", () => {
    const r = dsp.diffInstanceMovement(linkedPair(10), linkedPair(15), { camA: 5 }, 0.001);
    assert.deepStrictEqual(r.torn, []);
    assert.deepStrictEqual(r.missing, []);
    assert.deepStrictEqual(r.quantized, []);
});

test("diffInstanceMovement reports a file whose video moved and audio did not", () => {
    // The reported failure: the host accepted one move and refused the other.
    const before = linkedPair(10);
    const after = [
        { filePath: "camA", clipName: "A.mov", trackType: "video", trackIndex: 0, startSec: 15, endSec: 75 },
        { filePath: "camA", clipName: "A.mov", trackType: "audio", trackIndex: 0, startSec: 10, endSec: 70 }
    ];
    const r = dsp.diffInstanceMovement(before, after, { camA: 5 }, 0.001);
    assert.strictEqual(r.torn.length, 1);
    assert.strictEqual(r.torn[0].filePath, "camA");
    assert.ok(Math.abs(r.torn[0].spreadSec - 5) < 1e-9, String(r.torn[0].spreadSec));
    assert.strictEqual(r.torn[0].instances.length, 2);
    const audio = r.torn[0].instances.find(i => i.trackType === "audio");
    assert.strictEqual(audio.movedSec, 0);
});

test("diffInstanceMovement calls a consistent but inexact landing quantized, not torn", () => {
    // Both instances snapped to the same frame: A/V is intact, so this must not
    // be reported as a tear.
    const r = dsp.diffInstanceMovement(linkedPair(10), linkedPair(14.96), { camA: 5 }, 0.001);
    assert.deepStrictEqual(r.torn, []);
    assert.strictEqual(r.quantized.length, 1);
    assert.ok(Math.abs(r.quantized[0].actualSec - 4.96) < 1e-9);
});

test("diffInstanceMovement ignores files that were never asked to move", () => {
    const before = linkedPair(10).concat([
        { filePath: "camB", clipName: "B.mov", trackType: "video", trackIndex: 1, startSec: 0, endSec: 30 }
    ]);
    const after = linkedPair(15).concat([
        { filePath: "camB", clipName: "B.mov", trackType: "video", trackIndex: 1, startSec: 0, endSec: 30 }
    ]);
    const r = dsp.diffInstanceMovement(before, after, { camA: 5 }, 0.001);
    assert.deepStrictEqual(r.torn, []);
    assert.deepStrictEqual(r.quantized, []);
});

test("diffInstanceMovement reports an instance that vanished from a track", () => {
    const after = [
        { filePath: "camA", clipName: "A.mov", trackType: "video", trackIndex: 0, startSec: 15, endSec: 75 }
    ];
    const r = dsp.diffInstanceMovement(linkedPair(10), after, { camA: 5 }, 0.001);
    assert.strictEqual(r.missing.length, 1);
    assert.strictEqual(r.missing[0].filePath, "camA");
    assert.strictEqual(r.missing[0].tracks[0].trackType, "audio");
    assert.strictEqual(r.missing[0].tracks[0].afterCount, 0);
});

test("diffInstanceMovement pairs multiple instances of one file on a track in time order", () => {
    const before = [
        { filePath: "camA", clipName: "A.mov", trackType: "video", trackIndex: 0, startSec: 0, endSec: 10 },
        { filePath: "camA", clipName: "A.mov", trackType: "video", trackIndex: 0, startSec: 30, endSec: 40 },
        { filePath: "camA", clipName: "A.mov", trackType: "audio", trackIndex: 0, startSec: 0, endSec: 10 },
        { filePath: "camA", clipName: "A.mov", trackType: "audio", trackIndex: 0, startSec: 30, endSec: 40 }
    ];
    const after = before.map(c => ({ ...c, startSec: c.startSec + 2, endSec: c.endSec + 2 }));
    const r = dsp.diffInstanceMovement(before, after, { camA: 2 }, 0.001);
    assert.deepStrictEqual(r.torn, []);
    assert.deepStrictEqual(r.quantized, []);
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

// ─── buildDriftProbe ──────────────────────────────────────────────────────────

test("buildDriftProbe plans early/late windows inside a long overlap", () => {
    // 2h overlap, both starting at 0; reference trimmed 30s into its source.
    const ref = { resolvedStartSec: 0, resolvedEndSec: 7200, inPointSec: 30 };
    const target = { resolvedStartSec: 0, resolvedEndSec: 7200, inPointSec: 0 };
    const probe = dsp.buildDriftProbe(ref, target);
    assert.ok(probe, "expected a drift probe for a 2h overlap");

    // Early window 5% in: timeline 360s → ref source 390s, target source 360s.
    assert.ok(Math.abs(probe.early.compareStartSec - 360) < 1e-9);
    assert.ok(Math.abs(probe.early.refSourceOffsetSec - 390) < 1e-9);
    assert.ok(Math.abs(probe.early.targetSourceOffsetSec - 360) < 1e-9);
    assert.strictEqual(probe.early.compareDurationSec, dsp.FINE_TUNE_MAX_COMPARE_SEC);

    // Late window 95% in, minus the window length: 6840 − 10 = 6830.
    assert.ok(Math.abs(probe.late.compareStartSec - 6830) < 1e-9);
    // Span between probes is what the ppm is computed over.
    assert.ok(Math.abs(probe.spanSec - (6830 - 360)) < 1e-9);
    // Both windows sit fully inside the overlap.
    assert.ok(probe.late.compareStartSec + probe.late.compareDurationSec <= 7200);
});

test("buildDriftProbe respects partial overlap (offset clips)", () => {
    // Target starts 600s into the reference; overlap = [600, 1800] = 1200s.
    const ref = { resolvedStartSec: 0, resolvedEndSec: 1800, inPointSec: 0 };
    const target = { resolvedStartSec: 600, resolvedEndSec: 1800, inPointSec: 0 };
    const probe = dsp.buildDriftProbe(ref, target);
    assert.ok(probe);
    // Early window 5% into the overlap: 600 + 60 = 660 on the timeline; the
    // target's source offset is measured from ITS OWN start (660 − 600 = 60).
    assert.ok(Math.abs(probe.early.compareStartSec - 660) < 1e-9);
    assert.ok(Math.abs(probe.early.refSourceOffsetSec - 660) < 1e-9);
    assert.ok(Math.abs(probe.early.targetSourceOffsetSec - 60) < 1e-9);
});

test("buildDriftProbe returns null when the overlap is too short to matter", () => {
    const ref = { resolvedStartSec: 0, resolvedEndSec: 500, inPointSec: 0 };
    const target = { resolvedStartSec: 0, resolvedEndSec: 500, inPointSec: 0 };
    assert.strictEqual(dsp.buildDriftProbe(ref, target), null);
});

// ─── parsePekInfo / pekToEnvelope ───────────────────────────────────────────────

// Build a synthetic .pek: channel-planar (int16 max, int16 min) per 256-sample
// block. ampOf(channel, block) gives the desired per-block amplitude.
function makePek(channels, blocks, sampleRate, ampOf) {
    const buf = Buffer.alloc(dsp.PEK_HEADER_BYTES + channels * blocks * 4);
    buf.writeUInt32LE(dsp.PEK_MAGIC, 0);
    buf.writeUInt32LE(8, 4);
    buf.writeUInt32LE(channels, 8);
    buf.writeDoubleLE(sampleRate, 12);
    buf.writeUInt32LE(channels * blocks * 4, 64);
    for (let c = 0; c < channels; c += 1) {
        for (let b = 0; b < blocks; b += 1) {
            const amp = ampOf(c, b);
            const base = dsp.PEK_HEADER_BYTES + ((c * blocks) + b) * 4;
            buf.writeInt16LE(amp, base);       // max
            buf.writeInt16LE(-amp, base + 2);  // min
        }
    }
    return buf;
}

test("parsePekInfo reads the validated header layout", () => {
    const buf = makePek(2, 750, 48000, () => 100);
    const info = dsp.parsePekInfo(buf);
    assert.ok(info);
    assert.strictEqual(info.channels, 2);
    assert.strictEqual(info.sampleRate, 48000);
    assert.strictEqual(info.blocks, 750);
    assert.strictEqual(info.blockRate, 187.5);
    assert.ok(Math.abs(info.durationSec - 4) < 1e-9); // 750 blocks @ 187.5 Hz
});

test("parsePekInfo rejects wrong magic, bad fields and truncated payloads", () => {
    const good = makePek(2, 100, 48000, () => 1);
    const badMagic = Buffer.from(good); badMagic.writeUInt32LE(0xdeadbeef, 0);
    assert.strictEqual(dsp.parsePekInfo(badMagic), null);
    const badRate = Buffer.from(good); badRate.writeDoubleLE(1e9, 12);
    assert.strictEqual(dsp.parsePekInfo(badRate), null);
    const truncated = good.slice(0, good.length - 8); // dataBytes overruns buffer
    assert.strictEqual(dsp.parsePekInfo(truncated), null);
    assert.strictEqual(dsp.parsePekInfo(null), null);
});

test("parsePekInfo / pekToEnvelope accept an ArrayBuffer (UXP fs.readFile shape)", () => {
    // UXP's fs.readFile returns an ArrayBuffer, not a Node Buffer — the byte-reader
    // shim must produce identical results for both.
    const buf = makePek(2, 375, 48000, (c, b) => (c === 0 ? b : 3 * b));
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const infoAb = dsp.parsePekInfo(ab);
    assert.ok(infoAb, "ArrayBuffer input should parse");
    assert.strictEqual(infoAb.channels, 2);
    const envAb = dsp.pekToEnvelope(ab, infoAb, 187.5, 0, null);
    const envBuf = dsp.pekToEnvelope(buf, dsp.parsePekInfo(buf), 187.5, 0, null);
    assert.strictEqual(envAb.length, envBuf.length);
    for (let i = 0; i < envAb.length; i += 1) {
        assert.strictEqual(envAb[i], envBuf[i], `frame ${i} differs`);
    }
    // A Uint8Array view works too.
    const u8 = new Uint8Array(ab);
    assert.ok(dsp.parsePekInfo(u8), "Uint8Array input should parse");
});

test("pekToEnvelope reads channel PLANES and averages them", () => {
    // ch0 amplitude = block index, ch1 = 3x block index → mean = 2x block index.
    // With an interleaved (wrong) read this would come out scrambled.
    const blocks = 375; // 2s at 187.5 Hz
    const buf = makePek(2, blocks, 48000, (c, b) => (c === 0 ? b : 3 * b));
    const info = dsp.parsePekInfo(buf);
    const env = dsp.pekToEnvelope(buf, info, 187.5, 0, null); // 1 block per frame
    assert.strictEqual(env.length, blocks);
    assert.strictEqual(env[10], 20);   // (10 + 30) / 2
    assert.strictEqual(env[100], 200); // (100 + 300) / 2
});

test("pekToEnvelope can isolate ONE channel plane instead of the mix", () => {
    // A 4-channel camera file: each channel carries a different microphone.
    const blocks = 375;
    const buf = makePek(4, blocks, 48000, (c, b) => (c + 1) * b);
    const info = dsp.parsePekInfo(buf);

    // The averaged mix blends all four — 1x + 2x + 3x + 4x over 4 = 2.5x.
    const mix = dsp.pekToEnvelope(buf, info, 187.5, 0, null);
    assert.strictEqual(mix[10], 25);

    // Each channel read alone returns exactly that microphone's amplitude. This
    // is what lets a lav recorder match the camera channel holding the same mic
    // instead of drowning in the other three.
    for (let c = 0; c < 4; c += 1) {
        const only = dsp.pekToEnvelope(buf, info, 187.5, 0, null, c);
        assert.strictEqual(only.length, blocks);
        assert.strictEqual(only[10], (c + 1) * 10, `channel ${c} plane`);
    }
});

test("pekToEnvelope falls back to the mix for an out-of-range channel", () => {
    const buf = makePek(2, 375, 48000, (c, b) => (c === 0 ? b : 3 * b));
    const info = dsp.parsePekInfo(buf);
    const mix = dsp.pekToEnvelope(buf, info, 187.5, 0, null)[10];
    assert.strictEqual(dsp.pekToEnvelope(buf, info, 187.5, 0, null, 7)[10], mix, "channel 7 of 2");
    assert.strictEqual(dsp.pekToEnvelope(buf, info, 187.5, 0, null, -1)[10], mix, "negative channel");
});

test("isolating the right channel beats the mix at recovering an offset", () => {
    // ch1 holds the same mic as the "recorder"; ch0/2/3 hold unrelated content.
    // Matching against the 4-channel MIX is what scored 0.25 in the field.
    const blocks = 1500;
    const rate = 187.5;
    const mic = b => 1000 + 900 * Math.sin(b / 11);
    const other = (c, b) => 1000 + 900 * Math.sin((b / (3 + c)) + c * 2.1);
    const shift = 200; // blocks

    const camera = makePek(4, blocks, 48000, (c, b) => (c === 1 ? mic(b) : other(c, b)));
    const recorder = makePek(1, blocks - shift, 48000, (c, b) => mic(b + shift));
    const camInfo = dsp.parsePekInfo(camera);
    const recInfo = dsp.parsePekInfo(recorder);

    const tgt = dsp.pekToEnvelope(recorder, recInfo, rate, 0, null);
    const viaMix = dsp.slideMatch(dsp.pekToEnvelope(camera, camInfo, rate, 0, null), tgt,
        { envelopeRate: rate, minOverlapSec: 1 });
    const viaCh1 = dsp.slideMatch(dsp.pekToEnvelope(camera, camInfo, rate, 0, null, 1), tgt,
        { envelopeRate: rate, minOverlapSec: 1 });

    assert.ok(viaCh1.score > viaMix.score,
        `channel ${viaCh1.score.toFixed(2)} should beat mix ${viaMix.score.toFixed(2)}`);
    assert.ok(Math.abs(viaCh1.lagSec - (shift / rate)) < 0.05,
        `channel read must recover the true offset, got ${viaCh1.lagSec}s`);
});

test("pekToEnvelope slices by time and aggregates to the target rate", () => {
    // 4s of stereo; amplitude = block index on both channels.
    const buf = makePek(2, 750, 48000, (c, b) => b);
    const info = dsp.parsePekInfo(buf);
    // 10 Hz envelope of [1s, 3s): 20 frames, each the mean of ~18.75 blocks
    // starting at block 187 (t=1s → block 187.5).
    const env = dsp.pekToEnvelope(buf, info, 10, 1, 2);
    assert.strictEqual(env.length, 20);
    // Frame 0 covers blocks ~187..205 → mean ≈ 196; linear ramp keeps frames
    // increasing by ~18.75.
    assert.ok(Math.abs(env[0] - 196) < 2, `env[0] ${env[0]}`);
    assert.ok(Math.abs((env[10] - env[0]) - 187.5) < 3, `slope ${env[10] - env[0]}`);
    // Out-of-range slice yields an empty envelope, not garbage.
    assert.strictEqual(dsp.pekToEnvelope(buf, info, 10, 100, 10).length, 0);
});

test("pek envelopes recover a known offset through slideMatch", () => {
    // Target = the reference's blocks 750.. shifted to its own start; matching
    // at 10 Hz should find the 750-block (4.0s) offset, mimicking stage 0.
    // Aperiodic LCG noise (like makeSignal) so the correlation has ONE peak; the
    // offset is a whole number of 18.75-block envelope frames because iid noise
    // (unlike real audio) has no sub-frame smoothness to survive misalignment.
    const blocks = 2000;
    const rnd = new Array(blocks);
    let st = 42 >>> 0;
    for (let i = 0; i < blocks; i += 1) {
        st = (1664525 * st + 1013904223) >>> 0;
        rnd[i] = 50 + (st % 1000);
    }
    const ref = makePek(1, blocks, 48000, (c, b) => rnd[b]);
    const refInfo = dsp.parsePekInfo(ref);
    const at = 750; // = 40 envelope frames at 10 Hz exactly
    const tgt = makePek(1, 600, 48000, (c, b) => rnd[b + at]);
    const tgtInfo = dsp.parsePekInfo(tgt);

    const refEnv = dsp.pekToEnvelope(ref, refInfo, 10, 0, null);
    const tgtEnv = dsp.pekToEnvelope(tgt, tgtInfo, 10, 0, null);
    const best = dsp.slideMatch(refEnv, tgtEnv, { envelopeRate: 10, minOverlapSec: 2 });
    assert.ok(best, "expected a match");
    const expected = at / 187.5;
    assert.ok(Math.abs(best.lagSec - expected) <= 0.2, `lagSec ${best.lagSec} should be ~${expected.toFixed(2)}`);
    assert.ok(best.score > 0.95, `score ${best.score}`);
});

// ─── escapeHtml ───────────────────────────────────────────────────────────────

test("escapeHtml neutralizes markup in user-controlled names", () => {
    assert.strictEqual(
        dsp.escapeHtml(`<b onmouseover="x()">Day 1 & "cut"</b>`),
        "&lt;b onmouseover=&quot;x()&quot;&gt;Day 1 &amp; &quot;cut&quot;&lt;/b&gt;"
    );
});

test("escapeHtml passes plain text through and tolerates null/undefined", () => {
    assert.strictEqual(dsp.escapeHtml("Sequence 01-SYNC"), "Sequence 01-SYNC");
    assert.strictEqual(dsp.escapeHtml(null), "");
    assert.strictEqual(dsp.escapeHtml(undefined), "");
    assert.strictEqual(dsp.escapeHtml(42), "42");
});

// ─── planTearRepair (A/V tear repair) ─────────────────────────────────────────

// One file, video on V1 and audio on A1, asked to move +5 s. The video made it,
// the audio did not: the exact shape of a clip coming unlinked.
function tornFile(requestedSec, movedVideoSec, movedAudioSec) {
    return [{
        filePath: "camA", clipName: "camA.mp4", requestedSec: requestedSec,
        spreadSec: Math.abs(movedVideoSec - movedAudioSec),
        instances: [
            { trackType: "video", trackIndex: 0, fromSec: 10, toSec: 10 + movedVideoSec, movedSec: movedVideoSec, afterIndex: 0 },
            { trackType: "audio", trackIndex: 0, fromSec: 10, toSec: 10 + movedAudioSec, movedSec: movedAudioSec, afterIndex: 2 }
        ]
    }];
}

test("planTearRepair completes the instance that did not move", () => {
    const moves = dsp.planTearRepair(tornFile(5, 5, 0), "complete");
    assert.strictEqual(moves.length, 1, "only the straggler needs moving");
    assert.strictEqual(moves[0].trackType, "audio");
    assert.strictEqual(moves[0].itemIndex, 2, "addresses the item by its AFTER index");
    assert.ok(Math.abs(moves[0].deltaSec - 5) < 1e-9);
});

test("planTearRepair restores every instance to where it started", () => {
    const moves = dsp.planTearRepair(tornFile(5, 5, 0), "restore");
    assert.strictEqual(moves.length, 1, "the instance that never moved needs no undo");
    assert.strictEqual(moves[0].trackType, "video");
    assert.ok(Math.abs(moves[0].deltaSec + 5) < 1e-9, "video goes back by -5 s");
});

test("planTearRepair restores BOTH instances when both moved, differently", () => {
    const moves = dsp.planTearRepair(tornFile(5, 5, 2), "restore");
    assert.strictEqual(moves.length, 2);
    const byTrack = Object.fromEntries(moves.map(m => [m.trackType, m.deltaSec]));
    assert.ok(Math.abs(byTrack.video + 5) < 1e-9);
    assert.ok(Math.abs(byTrack.audio + 2) < 1e-9);
});

test("planTearRepair ignores a sub-frame spread — that is the host snapping, not a tear", () => {
    assert.deepStrictEqual(dsp.planTearRepair(tornFile(5, 5, 4.998), "complete"), []);
});

test("planTearRepair skips instances with no handle in the after-scan", () => {
    const torn = tornFile(5, 5, 0);
    delete torn[0].instances[1].afterIndex;
    assert.deepStrictEqual(dsp.planTearRepair(torn, "complete"), []);
});

// ─── planLinkGroups (links the per-file rule cannot see) ──────────────────────

// A video item and an audio item from DIFFERENT files occupying the same span:
// a merged clip, a Synchronize, or a manual Clip > Link.
function crossFilePair(startSec, endSec) {
    return [
        { filePath: "camA.mp4", clipName: "camA.mp4", trackType: "video", trackIndex: 0, itemIndex: 0, startSec, endSec },
        { filePath: "rec.wav", clipName: "rec.wav", trackType: "audio", trackIndex: 0, itemIndex: 0, startSec, endSec }
    ];
}

test("planLinkGroups leaves a sequence with no cross-file links untouched", () => {
    const clips = [
        { filePath: "camA.mp4", clipName: "camA.mp4", trackType: "video", trackIndex: 0, itemIndex: 0, startSec: 0, endSec: 10 },
        { filePath: "camA.mp4", clipName: "camA.mp4", trackType: "audio", trackIndex: 0, itemIndex: 0, startSec: 0, endSec: 10 }
    ];
    const plan = dsp.planLinkGroups(clips, [], { "camA.mp4": 3 }, 0.002);
    assert.deepStrictEqual(plan.deltas, { "camA.mp4": 3 });
    assert.strictEqual(plan.unified.length, 0);
    assert.strictEqual(plan.blocked.length, 0);
});

test("planLinkGroups moves a linked video+audio pair by the video's shift", () => {
    const plan = dsp.planLinkGroups(crossFilePair(0, 10), [], { "camA.mp4": 3, "rec.wav": 3.4 }, 0.002);
    assert.strictEqual(plan.deltas["rec.wav"], 3, "the sound follows the picture");
    assert.strictEqual(plan.deltas["camA.mp4"], 3);
    assert.strictEqual(plan.unified.length, 1);
    assert.deepStrictEqual(plan.unified[0].names.sort(), ["camA.mp4", "rec.wav"]);
});

test("planLinkGroups pulls a linked file that was not moving at all along too", () => {
    const plan = dsp.planLinkGroups(crossFilePair(0, 10), [], { "camA.mp4": 3 }, 0.002);
    assert.strictEqual(plan.deltas["rec.wav"], 3);
});

test("planLinkGroups needs BOTH edges to match before it calls it a link", () => {
    const clips = crossFilePair(0, 10);
    clips[1].endSec = 12;   // same start, different end — not a linked pair
    const plan = dsp.planLinkGroups(clips, [], { "camA.mp4": 3, "rec.wav": 3.4 }, 0.002);
    assert.strictEqual(plan.deltas["rec.wav"], 3.4, "left to sync on its own");
    assert.strictEqual(plan.unified.length, 0);
});

test("planLinkGroups ignores same-media-type coincidences (two cameras, a stereo pair)", () => {
    const clips = [
        { filePath: "camA.mp4", clipName: "camA.mp4", trackType: "video", trackIndex: 0, itemIndex: 0, startSec: 0, endSec: 10 },
        { filePath: "camB.mp4", clipName: "camB.mp4", trackType: "video", trackIndex: 1, itemIndex: 0, startSec: 0, endSec: 10 }
    ];
    const plan = dsp.planLinkGroups(clips, [], { "camA.mp4": 3, "camB.mp4": -2 }, 0.002);
    assert.strictEqual(plan.deltas["camB.mp4"], -2);
    assert.strictEqual(plan.unified.length, 0);
});

test("planLinkGroups carries an unreadable item along with the clip it is linked to", () => {
    const clips = [
        { filePath: "camA.mp4", clipName: "camA.mp4", trackType: "video", trackIndex: 0, itemIndex: 0, startSec: 0, endSec: 10 }
    ];
    const opaque = [
        { clipName: "?", trackType: "audio", trackIndex: 2, itemIndex: 1, startSec: 0, endSec: 10 }
    ];
    const plan = dsp.planLinkGroups(clips, opaque, { "camA.mp4": 3 }, 0.002);
    assert.strictEqual(plan.opaqueTargets.length, 1);
    assert.strictEqual(plan.opaqueTargets[0].trackIndex, 2);
    assert.strictEqual(plan.opaqueTargets[0].itemIndex, 1);
    assert.strictEqual(plan.opaqueTargets[0].deltaSec, 3);
    assert.deepStrictEqual(plan.opaqueTargets[0].groupPaths, ["camA.mp4"]);
});

test("planLinkGroups blocks a group with no readable picture to anchor on", () => {
    const clips = [
        { filePath: "rec.wav", clipName: "rec.wav", trackType: "audio", trackIndex: 0, itemIndex: 0, startSec: 0, endSec: 10 }
    ];
    const opaque = [
        { clipName: "?", trackType: "video", trackIndex: 0, itemIndex: 0, startSec: 0, endSec: 10 }
    ];
    const plan = dsp.planLinkGroups(clips, opaque, { "rec.wav": 4 }, 0.002);
    assert.strictEqual(plan.deltas["rec.wav"], undefined, "not moved, so it cannot leave the video behind");
    assert.strictEqual(plan.blocked.length, 1);
});

test("planLinkGroups blocks a file two groups want in two different places", () => {
    const clips = [
        { filePath: "camA.mp4", clipName: "camA.mp4", trackType: "video", trackIndex: 0, itemIndex: 0, startSec: 0, endSec: 10 },
        { filePath: "rec.wav", clipName: "rec.wav", trackType: "audio", trackIndex: 0, itemIndex: 0, startSec: 0, endSec: 10 },
        { filePath: "camB.mp4", clipName: "camB.mp4", trackType: "video", trackIndex: 1, itemIndex: 0, startSec: 40, endSec: 50 },
        { filePath: "rec.wav", clipName: "rec.wav", trackType: "audio", trackIndex: 0, itemIndex: 1, startSec: 40, endSec: 50 }
    ];
    const plan = dsp.planLinkGroups(clips, [], { "camA.mp4": 3, "camB.mp4": -6, "rec.wav": 1 }, 0.002);
    assert.strictEqual(plan.deltas["rec.wav"], undefined);
    assert.strictEqual(plan.deltas["camA.mp4"], undefined, "its partner is stuck, so it stays put too");
    assert.strictEqual(plan.deltas["camB.mp4"], undefined);
    assert.strictEqual(plan.blocked.length, 2);
    assert.strictEqual(plan.unified.length, 0);
});

test("planLinkGroups does not mutate the deltas it was handed", () => {
    const deltas = { "camA.mp4": 3, "rec.wav": 3.4 };
    dsp.planLinkGroups(crossFilePair(0, 10), [], deltas, 0.002);
    assert.deepStrictEqual(deltas, { "camA.mp4": 3, "rec.wav": 3.4 });
});

test("diffInstanceMovement hands the repair pass an index for each instance", () => {
    const before = [
        { filePath: "camA", clipName: "camA", trackType: "video", trackIndex: 0, itemIndex: 0, startSec: 10, endSec: 20 },
        { filePath: "camA", clipName: "camA", trackType: "audio", trackIndex: 0, itemIndex: 3, startSec: 10, endSec: 20 }
    ];
    const after = [
        { filePath: "camA", clipName: "camA", trackType: "video", trackIndex: 0, itemIndex: 1, startSec: 15, endSec: 25 },
        { filePath: "camA", clipName: "camA", trackType: "audio", trackIndex: 0, itemIndex: 3, startSec: 10, endSec: 20 }
    ];
    const r = dsp.diffInstanceMovement(before, after, { camA: 5 }, 0.001);
    assert.strictEqual(r.torn.length, 1);
    const indices = r.torn[0].instances.map(i => i.afterIndex);
    assert.deepStrictEqual(indices, [1, 3], "indices come from the AFTER scan, where the repair has to act");
});

// ─── largestCluster ───────────────────────────────────────────────────────────

test("largestCluster finds the group that agrees and returns its median", () => {
    const c = dsp.largestCluster([12.1, 0.4, 12.6, 40, 12.3], 2);
    assert.deepStrictEqual(c.members, [12.1, 12.3, 12.6]);
    assert.strictEqual(c.centre, 12.3);
});

test("largestCluster on scattered values keeps the tightest pair", () => {
    const c = dsp.largestCluster([0, 30, 60], 2);
    assert.strictEqual(c.members.length, 1, "nothing is within tolerance of anything else");
});

test("largestCluster tolerates an empty list", () => {
    assert.strictEqual(dsp.largestCluster([], 2), null);
});

// ─── judgeTwoPointAgreement ───────────────────────────────────────────────────

const lagAt = (lagSec, score) => ({ lagSec, score, atRail: false });

test("judgeTwoPointAgreement accepts two windows telling the same story", () => {
    const r = dsp.judgeTwoPointAgreement(lagAt(0.30, 0.8), lagAt(0.34, 0.7), 300);
    assert.strictEqual(r.verdict, "agree");
});

test("judgeTwoPointAgreement rejects windows describing different alignments", () => {
    // 4 s apart over a 300 s span is 13000 ppm — no device drifts like that.
    const r = dsp.judgeTwoPointAgreement(lagAt(0.3, 0.8), lagAt(4.3, 0.8), 300);
    assert.strictEqual(r.verdict, "disagree");
    assert.ok(Math.abs(r.disagreeSec - 4) < 1e-9);
});

test("judgeTwoPointAgreement allows real clock drift over a long span", () => {
    // 200 ppm over an hour is 0.72 s — plausible for two consumer devices.
    const r = dsp.judgeTwoPointAgreement(lagAt(0, 0.8), lagAt(0.72, 0.8), 3600);
    assert.strictEqual(r.verdict, "agree");
    assert.ok(r.tolSec > 0.72, "tolerance grows with the span between the windows");
});

test("judgeTwoPointAgreement stays out of the way when a window has no signal", () => {
    assert.strictEqual(dsp.judgeTwoPointAgreement(lagAt(0.3, 0.8), null, 300).verdict, "inconclusive");
    assert.strictEqual(dsp.judgeTwoPointAgreement(lagAt(0.3, 0.8), lagAt(9, 0.05), 300).verdict, "inconclusive");
    assert.strictEqual(
        dsp.judgeTwoPointAgreement(lagAt(0.3, 0.8), { lagSec: 9, score: 0.8, atRail: true }, 300).verdict,
        "inconclusive");
});

// ─── judgeCorroboration ───────────────────────────────────────────────────────

const sib = (clipName, agreed, impliedDeltaSec) => ({ clipName, agreed, impliedDeltaSec, score: 0.5 });

test("judgeCorroboration confirms when the track's other clips back the offset", () => {
    const r = dsp.judgeCorroboration([sib("B.mp4", true, -12), sib("C.mp4", true, -12)], 2);
    assert.strictEqual(r.verdict, "confirmed");
    assert.strictEqual(r.agreed.length, 2);
});

test("judgeCorroboration says nothing when no sibling could be compared", () => {
    const r = dsp.judgeCorroboration([
        { clipName: "B.mp4", agreed: null, reason: "no overlap" },
        { clipName: "C.mp4", agreed: null, reason: "no usable audio" }
    ], 2);
    assert.strictEqual(r.verdict, "inconclusive");
});

test("judgeCorroboration adopts the offset the dissenting clips agree on", () => {
    // The matched clip claimed one thing; two other clips on the track both say
    // the track really belongs 41 s earlier. They outvote it.
    const r = dsp.judgeCorroboration([sib("B.mp4", false, -41.2), sib("C.mp4", false, -40.9)], 2);
    assert.strictEqual(r.verdict, "adopt");
    assert.ok(Math.abs(r.adoptedDeltaSec + 41.05) < 0.01, `got ${r.adoptedDeltaSec}`);
});

test("judgeCorroboration rejects dissent that agrees on nothing", () => {
    const r = dsp.judgeCorroboration([sib("B.mp4", false, -41), sib("C.mp4", false, 130)], 2);
    assert.strictEqual(r.verdict, "rejected");
    assert.strictEqual(r.adoptedDeltaSec, null);
});

test("judgeCorroboration keeps the offset when assent outnumbers dissent", () => {
    const r = dsp.judgeCorroboration([sib("B.mp4", true, -12), sib("C.mp4", true, -12), sib("D.mp4", false, 80)], 2);
    assert.strictEqual(r.verdict, "confirmed");
    assert.ok(r.note.includes("outnumbered"));
});

test("judgeCorroboration will not adopt on a single dissenting clip", () => {
    const r = dsp.judgeCorroboration([sib("B.mp4", false, -41)], 2);
    assert.strictEqual(r.verdict, "rejected", "one clip is not a consensus");
});

// ─── summarizeTrackResiduals ──────────────────────────────────────────────────

const fineRow = (label, status, deltaSec) => ({ label, filePath: label, status, deltaSec });

test("summarizeTrackResiduals finds the residual a track's clips agree on", () => {
    const r = dsp.summarizeTrackResiduals([
        fineRow("A.mp4", "shifted", 1.42),
        fineRow("B.mp4", "shifted", 1.39),
        fineRow("C.mp4", "unmatched")
    ], 2);
    assert.strictEqual(r.total, 3);
    assert.strictEqual(r.matched, 2);
    assert.strictEqual(r.failed, 1);
    assert.deepStrictEqual(r.failedPaths, ["C.mp4"]);
    assert.strictEqual(r.consensusCount, 2);
    assert.ok(Math.abs(r.consensusDeltaSec - 1.405) < 0.01);
    assert.strictEqual(r.suspect, false, "one clip failing out of three is ordinary");
});

test("summarizeTrackResiduals flags a track where most clips failed", () => {
    const r = dsp.summarizeTrackResiduals([
        fineRow("A.mp4", "shifted", 0.3),
        fineRow("B.mp4", "unmatched"),
        fineRow("C.mp4", "weak"),
        fineRow("D.mp4", "unmatched")
    ], 2);
    assert.strictEqual(r.suspect, true);
    assert.strictEqual(r.failed, 3);
});

test("summarizeTrackResiduals counts an already-aligned clip as a zero residual", () => {
    const r = dsp.summarizeTrackResiduals([
        fineRow("A.mp4", "aligned"),
        fineRow("B.mp4", "aligned"),
        fineRow("C.mp4", "unmatched")
    ], 2);
    assert.strictEqual(r.consensusDeltaSec, 0, "nothing to rescue anyone with");
    assert.strictEqual(r.consensusCount, 2);
});

test("summarizeTrackResiduals reports no consensus from a single matched clip", () => {
    const r = dsp.summarizeTrackResiduals([
        fineRow("A.mp4", "shifted", 1.4),
        fineRow("B.mp4", "unmatched")
    ], 2);
    assert.strictEqual(r.consensusDeltaSec, null, "one clip cannot corroborate itself");
});

test("summarizeTrackResiduals ignores scattered residuals", () => {
    const r = dsp.summarizeTrackResiduals([
        fineRow("A.mp4", "shifted", 0.2),
        fineRow("B.mp4", "shifted", 4.4)
    ], 2);
    assert.strictEqual(r.consensusDeltaSec, null);
});

// ─── buildDriftProbe with a caller-set minimum ────────────────────────────────

test("buildDriftProbe honours a lower overlap minimum than the drift default", () => {
    const reference = { resolvedStartSec: 0, resolvedEndSec: 300, inPointSec: 0 };
    const target = { resolvedStartSec: 0, resolvedEndSec: 300, inPointSec: 0 };
    assert.strictEqual(dsp.buildDriftProbe(reference, target), null, "300s is under the 600s drift default");
    const probe = dsp.buildDriftProbe(reference, target, dsp.FINE_TUNE_AGREE_MIN_OVERLAP_SEC);
    assert.ok(probe, "but over the two-point-agreement minimum");
    assert.ok(probe.spanSec > 0);
});

// ─── compareVersions (update check) ───────────────────────────────────────────

test("compareVersions orders releases and tolerates a leading v", () => {
    assert.strictEqual(dsp.compareVersions("1.6.0", "1.5.0"), 1);
    assert.strictEqual(dsp.compareVersions("v1.6.0", "1.5.0"), 1);
    assert.strictEqual(dsp.compareVersions("1.5.0", "v1.6.0"), -1);
    assert.strictEqual(dsp.compareVersions("1.5.0", "1.5.0"), 0);
});

test("compareVersions compares numerically, not as text", () => {
    assert.strictEqual(dsp.compareVersions("1.10.0", "1.9.3"), 1, "1.10 is newer than 1.9");
    assert.strictEqual(dsp.compareVersions("1.5.10", "1.5.9"), 1);
});

test("compareVersions ignores a pre-release or build suffix", () => {
    assert.strictEqual(dsp.compareVersions("v1.6.0-beta.1", "1.6.0"), 0);
});

test("compareVersions returns null rather than guessing at a bad version", () => {
    // A malformed tag must never read as "an update is available".
    assert.strictEqual(dsp.compareVersions("latest", "1.5.0"), null);
    assert.strictEqual(dsp.compareVersions("1.5.0", null), null);
    assert.strictEqual(dsp.compareVersions(undefined, undefined), null);
});

// ─── planBuildAnchors (build layout) ──────────────────────────────────────────

const HOUR_MS = 3600000;
const MIN_MS = 60000;

// One file on a track, timed from embedded metadata unless told otherwise.
function payload(trackType, trackIndex, startMs, durationSec, timingSource) {
    return {
        filePath: `${trackType}${trackIndex}@${startMs}`,
        trackType, trackIndex, recordStartMs: startMs, durationSec,
        timingSource: timingSource || "creation_time"
    };
}

test("planBuildAnchors shares one anchor when the tracks were recording together", () => {
    // Two cameras and a recorder, all rolling around 10:00: the clocks agree.
    const plan = dsp.planBuildAnchors([
        payload("video", 0, 10 * HOUR_MS, 600),
        payload("video", 1, 10 * HOUR_MS + 3 * MIN_MS, 600),
        payload("audio", 0, 10 * HOUR_MS - MIN_MS, 1800)
    ]);
    assert.strictEqual(plan.groups.length, 1);
    assert.strictEqual(plan.ungrouped.length, 0);
    const anchor = 10 * HOUR_MS - MIN_MS;   // the earliest of the three
    assert.strictEqual(plan.anchorMsByTrack["video_0"], anchor);
    assert.strictEqual(plan.anchorMsByTrack["video_1"], anchor);
    assert.strictEqual(plan.anchorMsByTrack["audio_0"], anchor);
});

test("planBuildAnchors lays a shared group out at its real clock offsets", () => {
    const plan = dsp.planBuildAnchors([
        payload("video", 0, 10 * HOUR_MS, 600),
        payload("video", 1, 10 * HOUR_MS + 3 * MIN_MS, 600)
    ]);
    const offset = (key, startMs) => (startMs - plan.anchorMsByTrack[key]) / 1000;
    assert.strictEqual(offset("video_0", 10 * HOUR_MS), 0, "the earliest track still starts at 0:00");
    assert.strictEqual(offset("video_1", 10 * HOUR_MS + 3 * MIN_MS), 180, "the later one starts 3 min in");
});

test("planBuildAnchors leaves a device with a wrong clock on its own anchor", () => {
    // Two cameras agree; the third reset itself to the epoch.
    const plan = dsp.planBuildAnchors([
        payload("video", 0, 10 * HOUR_MS, 600),
        payload("video", 1, 10 * HOUR_MS + 3 * MIN_MS, 600),
        payload("audio", 0, 0, 600)
    ]);
    assert.strictEqual(plan.groups.length, 1);
    assert.deepStrictEqual(plan.groups[0].trackKeys.sort(), ["video_0", "video_1"]);
    assert.deepStrictEqual(plan.ungrouped.map(u => u.trackKey), ["audio_0"]);
    // …and that one still starts at 0:00, i.e. anchored to itself.
    assert.strictEqual(plan.anchorMsByTrack["audio_0"], 0);
});

test("planBuildAnchors falls back entirely when no two tracks overlap", () => {
    const plan = dsp.planBuildAnchors([
        payload("video", 0, 10 * HOUR_MS, 60),
        payload("audio", 0, 14 * HOUR_MS, 60)
    ]);
    assert.strictEqual(plan.groups.length, 0, "nothing corroborates anything");
    assert.strictEqual(plan.anchorMsByTrack["video_0"], 10 * HOUR_MS);
    assert.strictEqual(plan.anchorMsByTrack["audio_0"], 14 * HOUR_MS);
});

test("planBuildAnchors groups transitively through a track that bridges two others", () => {
    // A ran 09:00-10:00, C ran 11:00-12:00 — they never overlap each other, but
    // the recorder B ran across both, so all three clocks corroborate.
    const plan = dsp.planBuildAnchors([
        payload("video", 0, 9 * HOUR_MS, 3600),
        payload("audio", 0, 9 * HOUR_MS, 3600 * 3),
        payload("video", 1, 11 * HOUR_MS, 3600)
    ]);
    assert.strictEqual(plan.groups.length, 1);
    assert.strictEqual(plan.groups[0].trackKeys.length, 3);
});

test("planBuildAnchors never groups a track timed from the file date", () => {
    // mtime is "file date minus duration" — wrong by however much a copy touched
    // the file, so it is not something to lay a timeline out on.
    const plan = dsp.planBuildAnchors([
        payload("video", 0, 10 * HOUR_MS, 600),
        payload("audio", 0, 10 * HOUR_MS, 600, "mtime")
    ]);
    assert.strictEqual(plan.groups.length, 0);
    const why = Object.fromEntries(plan.ungrouped.map(u => [u.trackKey, u.reason]));
    assert.ok(why["audio_0"].includes("file date"), "the mtime track is excluded outright");
    // …which leaves the video track with nobody to corroborate it, so it falls
    // back too rather than "grouping" with itself.
    assert.ok(why["video_0"].includes("no other track"));
    assert.strictEqual(plan.anchorMsByTrack["video_0"], 10 * HOUR_MS);
});

test("planBuildAnchors accepts timecode-derived starts alongside creation_time", () => {
    const plan = dsp.planBuildAnchors([
        payload("video", 0, 10 * HOUR_MS, 600, "creation_time"),
        payload("audio", 0, 10 * HOUR_MS, 600, "modification_date")
    ]);
    assert.strictEqual(plan.groups.length, 1);
});

test("planBuildAnchors refuses a group that would not fit a timeline", () => {
    // Overlapping, but spanning more than Premiere's 24-hour maximum.
    const plan = dsp.planBuildAnchors([
        payload("video", 0, 0, 3600),
        payload("audio", 0, 1000, dsp.MAX_SPAN_SEC + 3600)
    ]);
    assert.strictEqual(plan.groups.length, 0);
    assert.strictEqual(plan.ungrouped.length, 2);
    assert.ok(plan.ungrouped[0].reason.includes("24-hour"));
});

test("planBuildAnchors takes each track's span from all of its clips", () => {
    // V1 has two recordings; only the later one overlaps the audio track.
    const plan = dsp.planBuildAnchors([
        payload("video", 0, 8 * HOUR_MS, 600),
        payload("video", 0, 10 * HOUR_MS, 600),
        payload("audio", 0, 10 * HOUR_MS, 600)
    ]);
    assert.strictEqual(plan.groups.length, 1);
    assert.strictEqual(plan.anchorMsByTrack["video_0"], 8 * HOUR_MS, "anchored to the track's earliest clip");
    assert.strictEqual(plan.anchorMsByTrack["audio_0"], 8 * HOUR_MS, "and the audio shares it");
});

test("planBuildAnchors is a no-op shape for a single track", () => {
    const plan = dsp.planBuildAnchors([payload("video", 0, 10 * HOUR_MS, 600)]);
    assert.strictEqual(plan.groups.length, 0);
    assert.strictEqual(plan.anchorMsByTrack["video_0"], 10 * HOUR_MS, "starts at 0:00 as always");
});

test("planBuildAnchors tolerates an empty payload", () => {
    const plan = dsp.planBuildAnchors([]);
    assert.deepStrictEqual(plan.anchorMsByTrack, {});
    assert.deepStrictEqual(plan.groups, []);
});

// ─── assessTimingPlausibility (are these recording times at all?) ─────────────

const SEC_MS = 1000;

test("assessTimingPlausibility accepts sequential takes from one device", () => {
    const r = dsp.assessTimingPlausibility([
        payload("video", 0, 10 * HOUR_MS, 600),
        payload("video", 0, 10 * HOUR_MS + 11 * MIN_MS, 600),
        payload("video", 0, 10 * HOUR_MS + 25 * MIN_MS, 600)
    ]);
    assert.deepStrictEqual(r.implausible, []);
});

test("assessTimingPlausibility rejects a batch transcode's timestamps", () => {
    // Three 10-minute files all stamped within 60s of each other: consistent,
    // and impossible — one camera cannot record them simultaneously.
    const r = dsp.assessTimingPlausibility([
        payload("video", 0, 10 * HOUR_MS, 600),
        payload("video", 0, 10 * HOUR_MS + 30 * SEC_MS, 600),
        payload("video", 0, 10 * HOUR_MS + 60 * SEC_MS, 600)
    ]);
    assert.deepStrictEqual(r.implausible, ["video_0"]);
    assert.ok(r.tracks[0].overlapSec > 1000, "nearly all the footage overlaps itself");
});

test("assessTimingPlausibility rejects a camera whose clock was never set", () => {
    const r = dsp.assessTimingPlausibility([
        payload("video", 0, 0, 600),
        payload("video", 0, 0, 600)
    ]);
    assert.deepStrictEqual(r.implausible, ["video_0"]);
});

test("assessTimingPlausibility does NOT flag genuine multicam", () => {
    // The whole point of the per-device test: three cameras really do all start
    // within seconds of each other, and any "these are too close together" check
    // would throw that away. Each is its own track, so none overlaps itself.
    const r = dsp.assessTimingPlausibility([
        payload("video", 0, 10 * HOUR_MS, 1800),
        payload("video", 1, 10 * HOUR_MS + 3 * SEC_MS, 1800),
        payload("audio", 0, 10 * HOUR_MS + 5 * SEC_MS, 1800)
    ]);
    assert.deepStrictEqual(r.implausible, []);
});

test("assessTimingPlausibility tolerates a second-resolution rounding overlap", () => {
    // Back-to-back takes whose container stamps round into a 1s overlap.
    const r = dsp.assessTimingPlausibility([
        payload("video", 0, 10 * HOUR_MS, 600),
        payload("video", 0, 10 * HOUR_MS + 600 * SEC_MS - SEC_MS, 600)
    ]);
    assert.deepStrictEqual(r.implausible, []);
});

test("assessTimingPlausibility never flags a track holding one clip", () => {
    const r = dsp.assessTimingPlausibility([payload("video", 0, 0, 600)]);
    assert.deepStrictEqual(r.implausible, []);
});

test("assessTimingPlausibility spots file dates written by one bulk download", () => {
    // mtime files: recordStart = mtime − duration, so their ENDS are the file
    // dates. Three files covering an hour, all dated within 40s of each other.
    const now = 1700000000000;
    const r = dsp.assessTimingPlausibility([
        payload("video", 0, now - 600 * SEC_MS, 600, "mtime"),
        payload("video", 1, now - 900 * SEC_MS + 20 * SEC_MS, 900, "mtime"),
        payload("audio", 0, now - 2400 * SEC_MS + 40 * SEC_MS, 2400, "mtime")
    ]);
    assert.ok(r.bulkCopy, "the file dates cluster far too tightly for the footage");
    assert.strictEqual(r.bulkCopy.count, 3);
    assert.strictEqual(r.bulkCopy.windowSec, 40);
});

test("assessTimingPlausibility leaves genuinely spread file dates alone", () => {
    const base = 1700000000000;
    const r = dsp.assessTimingPlausibility([
        payload("video", 0, base, 600, "mtime"),
        payload("video", 1, base + 2 * HOUR_MS, 600, "mtime"),
        payload("audio", 0, base + 4 * HOUR_MS, 600, "mtime")
    ]);
    assert.strictEqual(r.bulkCopy, null);
});

test("assessTimingPlausibility ignores embedded-timed files when looking for a bulk copy", () => {
    // These share a creation_time window, but that is the transcode check's
    // business — bulkCopy is specifically about the filesystem date fallback.
    const r = dsp.assessTimingPlausibility([
        payload("video", 0, 10 * HOUR_MS, 600),
        payload("video", 1, 10 * HOUR_MS, 600),
        payload("audio", 0, 10 * HOUR_MS, 600)
    ]);
    assert.strictEqual(r.bulkCopy, null);
});

test("planBuildAnchors refuses to group a track with batch-stamped timestamps", () => {
    // V1 is a batch transcode; A1 is genuine. Neither should group: the bad one
    // because it is not a recording time, the good one because it is then alone.
    const plan = dsp.planBuildAnchors([
        payload("video", 0, 10 * HOUR_MS, 600),
        payload("video", 0, 10 * HOUR_MS + 30 * SEC_MS, 600),
        payload("audio", 0, 10 * HOUR_MS, 2400)
    ]);
    assert.strictEqual(plan.groups.length, 0);
    const why = Object.fromEntries(plan.ungrouped.map(u => [u.trackKey, u.reason]));
    assert.ok(why["video_0"].includes("batch-processing"));
    assert.strictEqual(plan.anchorMsByTrack["video_0"], 10 * HOUR_MS, "still anchors to itself");
});

test("planBuildAnchors still groups the honest tracks around a batch-stamped one", () => {
    const plan = dsp.planBuildAnchors([
        payload("video", 0, 10 * HOUR_MS, 600),           // batch-stamped:
        payload("video", 0, 10 * HOUR_MS + 30 * SEC_MS, 600),
        payload("video", 1, 10 * HOUR_MS, 1800),          // genuine, one clip each
        payload("audio", 0, 10 * HOUR_MS + 5 * SEC_MS, 1800)
    ]);
    assert.strictEqual(plan.groups.length, 1);
    assert.deepStrictEqual(plan.groups[0].trackKeys.sort(), ["audio_0", "video_1"]);
    assert.ok(plan.ungrouped.some(u => u.trackKey === "video_0"));
});

// ─── envelopeActivity (is there anything to correlate?) ───────────────────────

test("envelopeActivity calls digital silence unusable", () => {
    const r = dsp.envelopeActivity(new Float32Array(600));
    assert.strictEqual(r.usable, false);
    assert.strictEqual(r.stdDev, 0);
});

test("envelopeActivity calls a constant envelope unusable", () => {
    // Loud but unvarying: slideMatch divides by zero energy and returns null,
    // which is why a silent clip reports "no match" rather than a weak one.
    const flat = new Float32Array(600).fill(1200);
    assert.strictEqual(dsp.envelopeActivity(flat).usable, false);
    assert.strictEqual(dsp.slideMatch(makeSignal(3000, 9), flat, { envelopeRate: 10, minOverlapSec: 60 }), null);
});

test("envelopeActivity accepts quiet but varying audio", () => {
    // Quiet is still audio; only a constant signal is unusable.
    const quiet = new Float32Array(600);
    for (let i = 0; i < quiet.length; i += 1) quiet[i] = (i % 7) * 0.01;
    assert.strictEqual(dsp.envelopeActivity(quiet).usable, true);
});

test("envelopeActivity handles an empty envelope", () => {
    assert.strictEqual(dsp.envelopeActivity(new Float32Array(0)).usable, false);
    assert.strictEqual(dsp.envelopeActivity(null).usable, false);
});

// ─── summarizeTrackResiduals: out-of-range clips are not failures ─────────────

const rangeRow = (label, status, deltaSec, outOfRange) =>
    ({ label, filePath: label, status, deltaSec, outOfRange });

test("summarizeTrackResiduals does not blame a track for clips the reference never covered", () => {
    // The VIDEO 3 shape from the field log: a healthy track whose reference
    // recording simply does not span the whole shoot. Counting those as
    // failures made a perfectly good coarse offset look broken.
    const rows = [
        rangeRow("a", "shifted", -0.69), rangeRow("b", "shifted", -0.70),
        rangeRow("c", "shifted", -0.68), rangeRow("d", "unmatched", undefined, true),
        rangeRow("e", "unmatched", undefined, true), rangeRow("f", "unmatched", undefined, true),
        rangeRow("g", "unmatched", undefined, true), rangeRow("h", "unmatched", undefined, true)
    ];
    const r = dsp.summarizeTrackResiduals(rows, 2);
    assert.strictEqual(r.outOfRange, 5);
    assert.strictEqual(r.suspect, false, "the reference just did not reach them");
    assert.ok(Math.abs(r.consensusDeltaSec + 0.69) < 0.01);
    assert.strictEqual(r.failedPaths.length, 5, "they are still worth rescuing");
});

test("summarizeTrackResiduals still flags a track that failed with a reference present", () => {
    const rows = [
        rangeRow("a", "shifted", -0.69),
        rangeRow("b", "unmatched", undefined, false),
        rangeRow("c", "weak", undefined, false),
        rangeRow("d", "unmatched", undefined, false)
    ];
    const r = dsp.summarizeTrackResiduals(rows, 2);
    assert.strictEqual(r.outOfRange, 0);
    assert.strictEqual(r.suspect, true, "three clips had a reference and still failed");
});

test("summarizeTrackResiduals stays quiet when every clip was out of range", () => {
    // Nothing was testable, so there is no evidence either way.
    const rows = [
        rangeRow("a", "unmatched", undefined, true),
        rangeRow("b", "unmatched", undefined, true)
    ];
    const r = dsp.summarizeTrackResiduals(rows, 2);
    assert.strictEqual(r.suspect, false);
    assert.strictEqual(r.consensusDeltaSec, null);
});

// ─── auditLinkAlignment / planLinkRepair (absolute A/V alignment) ─────────────

const avClip = (filePath, trackType, trackIndex, itemIndex, startSec, endSec) =>
    ({ filePath, clipName: filePath, trackType, trackIndex, itemIndex, startSec, endSec });

test("auditLinkAlignment is silent when audio sits under its video", () => {
    const r = dsp.auditLinkAlignment([
        avClip("camA.mp4", "video", 3, 0, 100, 130),
        avClip("camA.mp4", "audio", 4, 0, 100, 130)
    ]);
    assert.strictEqual(r.checked, 1);
    assert.deepStrictEqual(r.misaligned, []);
});

test("auditLinkAlignment catches a tear the movement check cannot see", () => {
    // Both instances moved by the SAME +226.39s, so diffInstanceMovement reports
    // a spread of zero and calls it clean — while the audio sits 2s off the
    // picture the whole time. Only an absolute comparison finds this.
    const before = [
        avClip("camA.mp4", "video", 3, 0, 100, 130),
        avClip("camA.mp4", "audio", 4, 0, 102, 132)
    ];
    const after = [
        avClip("camA.mp4", "video", 3, 0, 326.39, 356.39),
        avClip("camA.mp4", "audio", 4, 0, 328.39, 358.39)
    ];
    const moved = dsp.diffInstanceMovement(before, after, { "camA.mp4": 226.39 }, 0.001);
    assert.deepStrictEqual(moved.torn, [], "the movement check sees nothing wrong");
    const r = dsp.auditLinkAlignment(after);
    assert.strictEqual(r.misaligned.length, 1, "the absolute check finds it");
    assert.strictEqual(r.misaligned[0].offsetSec, 2);
});

test("auditLinkAlignment will not guess at a file cut into several pieces", () => {
    const r = dsp.auditLinkAlignment([
        avClip("camA.mp4", "video", 3, 0, 100, 130),
        avClip("camA.mp4", "video", 3, 1, 200, 230),
        avClip("camA.mp4", "audio", 4, 0, 100, 130)
    ]);
    assert.strictEqual(r.checked, 0);
    assert.strictEqual(r.ambiguous.length, 1);
});

test("auditLinkAlignment ignores a file with no audio on the timeline", () => {
    const r = dsp.auditLinkAlignment([avClip("camA.mp4", "video", 3, 0, 100, 130)]);
    assert.strictEqual(r.checked, 0);
    assert.deepStrictEqual(r.misaligned, []);
});

test("diffLinkAlignment separates what an apply broke from what it inherited", () => {
    const before = { misaligned: [{ filePath: "old.mp4", offsetSec: 1.5 }] };
    const after = { misaligned: [
        { filePath: "old.mp4", offsetSec: 1.5, clipName: "old.mp4" },   // carried along
        { filePath: "new.mp4", offsetSec: -0.8, clipName: "new.mp4" },  // created here
        { filePath: "worse.mp4", offsetSec: 3.0, clipName: "worse.mp4" }
    ] };
    const beforeWithWorse = { misaligned: before.misaligned.concat([{ filePath: "worse.mp4", offsetSec: 0.2 }]) };
    const d = dsp.diffLinkAlignment(beforeWithWorse, after);
    assert.deepStrictEqual(d.created.map(x => x.filePath), ["new.mp4"]);
    assert.deepStrictEqual(d.worsened.map(x => x.filePath), ["worse.mp4"]);
    assert.deepStrictEqual(d.preexisting.map(x => x.filePath), ["old.mp4"]);
});

test("planLinkRepair moves the audio back under the picture, never the video", () => {
    const moves = dsp.planLinkRepair([{
        filePath: "camA.mp4", offsetSec: 2,
        audio: { trackType: "audio", trackIndex: 4, itemIndex: 7 },
        video: { trackType: "video", trackIndex: 3, itemIndex: 2 }
    }]);
    assert.strictEqual(moves.length, 1);
    assert.strictEqual(moves[0].trackType, "audio", "the picture is what the edit is cut against");
    assert.strictEqual(moves[0].itemIndex, 7);
    assert.strictEqual(moves[0].deltaSec, -2);
});

test("planLinkRepair ignores offsets too small to be worth a move", () => {
    assert.deepStrictEqual(dsp.planLinkRepair([{
        filePath: "camA.mp4", offsetSec: 0.001,
        audio: { trackType: "audio", trackIndex: 4, itemIndex: 7 }
    }]), []);
});

test("planTearRepair refuses to act on an ambiguous pairing", () => {
    // A file cut into pieces is paired in time order, which only holds while the
    // pieces move together — exactly what is in doubt. Moving on that guess
    // would relocate a clip rather than repair one.
    const torn = [{
        filePath: "camA", clipName: "camA", requestedSec: 5, spreadSec: 5, ambiguous: true,
        instances: [
            { trackType: "video", trackIndex: 0, movedSec: 5, afterIndex: 0 },
            { trackType: "audio", trackIndex: 0, movedSec: 0, afterIndex: 1 }
        ]
    }];
    assert.deepStrictEqual(dsp.planTearRepair(torn, "complete"), []);
    torn[0].ambiguous = false;
    assert.strictEqual(dsp.planTearRepair(torn, "complete").length, 1);
});

/**
 * Syncitol — dsp.js
 * Pure, host-independent core: audio-envelope DSP, waveform cross-correlation,
 * fine-tune anchor/window planning, coarse search policy (rail guard, predictor
 * tiers, learned offsets, strong-override / near-fallback), .pek peak-file
 * parsing, drift probing, and display formatting.
 *
 * Input shapes: buildEnvelope takes an Int16Array of mono samples (from the
 * native FFmpeg addon); parsePekInfo/pekToEnvelope accept a Node Buffer (unit
 * tests) OR an ArrayBuffer/TypedArray (UXP fs.readFile) via a small
 * byte-reader shim.
 *
 * Loadable as a CommonJS module (UXP `require()` and node:test) and, harmlessly,
 * as a browser global.
 */

(function (root, factory) {
    var api = factory();
    var key;
    if (typeof window !== "undefined") {
        for (key in api) {
            if (Object.prototype.hasOwnProperty.call(api, key)) {
                window[key] = api[key];
            }
        }
    }
    if (typeof module !== "undefined" && module.exports) {
        module.exports = api;
    }
})(typeof window !== "undefined" ? window : this, function () {
    "use strict";

    // ─── Constants ────────────────────────────────────────────────────────────
    var TICKS_PER_SECOND = 254016000000;
    var MAX_SPAN_SEC = 86400;

    var AUDIO_SAMPLE_RATE = 8000;
    var ENVELOPE_WINDOW_SAMPLES = 80;
    var ENVELOPE_RATE = AUDIO_SAMPLE_RATE / ENVELOPE_WINDOW_SAMPLES; // 100 Hz

    var FINE_TUNE_MAX_SHIFT_SEC = 5;
    var FINE_TUNE_MIN_OVERLAP_SEC = 3;
    // Audio window decoded per compare. The coarse pass lands tracks within a few
    // seconds, so the fine pass only refines a small residual — a 10s window keeps
    // ≥5s of overlap even at the ±5s search extreme (window − maxShift) while
    // halving the per-clip decode vs. the old 20s. Don't drop below
    // ~2×MAX_SHIFT or the extreme-lag overlap falls under MIN_OVERLAP.
    var FINE_TUNE_MAX_COMPARE_SEC = 10;
    var FINE_TUNE_MIN_SCORE = 0.2;
    var FINE_TUNE_MIN_APPLY_SEC = 0.02;
    // Window start positions (fraction of slack) tried in order until one scores
    // ≥ DECENT_SCORE. Two positions instead of three trims a third of the work on
    // weak-correlation footage where the short-circuit rarely fires.
    var FINE_TUNE_WINDOW_POSITIONS = [0.5, 0.2];
    var FINE_TUNE_DECENT_SCORE = 0.7;

    // ─── Two-point agreement ──────────────────────────────────────────────────
    // One window, however well it scores, only proves the two files share THAT
    // stretch of audio. On a long recording that is weak evidence: a repeated
    // announcement, a music bed or a stretch of room tone can correlate
    // beautifully at a position that is minutes wrong. A second window from a
    // different part of the same recording has to agree before the match is
    // believed. Only overlaps this long get the extra window — below it there is
    // nowhere independent to put one, and a short clip cannot hide a big error.
    var FINE_TUNE_AGREE_MIN_OVERLAP_SEC = 120;
    // Two honest windows still differ a little: the envelope resolves ~10 ms per
    // end, and the two devices' clocks genuinely run at different rates. Allow
    // the measurement floor plus the worst drift a real pair of devices could
    // show over the span between the windows (see DRIFT_IMPLAUSIBLE_PPM) —
    // beyond that they are not describing the same alignment.
    var FINE_TUNE_AGREE_BASE_TOL_SEC = 0.1;

    // Coarse: a target clip at least this long is probed from several points
    // spread across it rather than from its single most distinctive stretch, and
    // its offset has to be confirmed at more than one of them. Shorter clips
    // cannot hold enough independent content to be worth the extra passes.
    var COARSE_MULTI_PROBE_MIN_SEC = 90;
    // How far two clips' implied offsets may sit apart and still count as the
    // same answer. Generous: the coarse pass only has to land the track within
    // the fine pass's ±5 s reach.
    var COARSE_CORROBORATE_TOL_SEC = 2;

    // Drift detection. A single offset assumes both devices' clocks run at the
    // same RATE — consumer cameras drift ~10–50 ppm, which on a multi-hour
    // recording puts the tail audibly out even when the head is perfectly
    // aligned. We can't fix that (rate-stretch isn't scriptable cleanly), but we
    // can MEASURE it: correlate a window near each end of a long overlap and
    // compare the residual lags. Only overlaps this long are worth checking:
    var DRIFT_MIN_OVERLAP_SEC = 600;
    // Probe windows sit this fraction in from each end of the overlap.
    var DRIFT_EDGE_FRACTION = 0.05;
    // Report only when the ends diverge by more than this (the 100 Hz envelope
    // resolves ~10 ms per end, so anything under 40 ms is measurement noise).
    var DRIFT_MIN_REPORT_SEC = 0.04;
    // Above this, the two ends disagree by more than any real pair of devices can
    // drift apart (cheap consumer crystals are ±100 ppm each, so ~200 ppm relative
    // is the realistic worst case; 500 ppm is 1.8 s per hour). A "match" implying
    // this much drift is not the same audio at all — it's correlated noise — so it
    // is rejected rather than reported. Deliberately far above real drift: a false
    // rejection re-breaks a good sync, which is worse than an unflagged slow drift.
    var DRIFT_IMPLAUSIBLE_PPM = 500;

    // ─── Envelope extraction ──────────────────────────────────────────────────
    // Aggregate signed 16-bit mono samples into a mean-absolute-amplitude envelope,
    // one frame per `windowSamples` samples. `samples` is an Int16Array (or any
    // indexable of int16 values) decoded by the native addon.
    function buildEnvelope(samples, windowSamples) {
        windowSamples = windowSamples || ENVELOPE_WINDOW_SAMPLES;
        var sampleCount = samples.length;
        var frameCount = Math.floor(sampleCount / windowSamples);
        var envelope = new Float32Array(frameCount);

        for (var frame = 0; frame < frameCount; frame += 1) {
            var sum = 0;
            var base = frame * windowSamples;
            for (var s = 0; s < windowSamples; s += 1) {
                var v = samples[base + s];
                sum += v < 0 ? -v : v;
            }
            envelope[frame] = sum / windowSamples;
        }

        return envelope;
    }

    // ─── Cross-correlation ────────────────────────────────────────────────────
    // Normalized (Pearson) cross-correlation between two envelopes. Returns the
    // best lag (in seconds, positive = target later than reference) or null when
    // no candidate has enough overlap or variance.
    //
    // opts: { maxShiftSec, minOverlapSec, envelopeRate } — defaults to the
    // fine-tune constants. The coarse auto-align pass passes a wider maxShiftSec
    // and a lower-resolution envelopeRate.
    function findBestLag(refEnvelope, targetEnvelope, opts) {
        opts = opts || {};
        var envelopeRate = opts.envelopeRate || ENVELOPE_RATE;
        var maxShiftSec = opts.maxShiftSec || FINE_TUNE_MAX_SHIFT_SEC;
        var minOverlapSec = (opts.minOverlapSec !== undefined && opts.minOverlapSec !== null)
            ? opts.minOverlapSec
            : FINE_TUNE_MIN_OVERLAP_SEC;

        var maxLagFrames = Math.round(maxShiftSec * envelopeRate);
        var minOverlapFrames = Math.round(minOverlapSec * envelopeRate);
        var best = null;

        for (var lag = -maxLagFrames; lag <= maxLagFrames; lag += 1) {
            var refStart = lag < 0 ? -lag : 0;
            var targetStart = lag > 0 ? lag : 0;
            var overlap = Math.min(refEnvelope.length - refStart, targetEnvelope.length - targetStart);
            if (overlap < minOverlapFrames) continue;

            var refSum = 0;
            var targetSum = 0;
            for (var i = 0; i < overlap; i += 1) {
                refSum += refEnvelope[refStart + i];
                targetSum += targetEnvelope[targetStart + i];
            }

            var refMean = refSum / overlap;
            var targetMean = targetSum / overlap;
            var dot = 0;
            var refEnergy = 0;
            var targetEnergy = 0;

            for (var j = 0; j < overlap; j += 1) {
                var rv = refEnvelope[refStart + j] - refMean;
                var tv = targetEnvelope[targetStart + j] - targetMean;
                dot += rv * tv;
                refEnergy += rv * rv;
                targetEnergy += tv * tv;
            }

            if (!refEnergy || !targetEnergy) continue;
            var score = dot / Math.sqrt(refEnergy * targetEnergy);
            if (!best || score > best.score) {
                best = {
                    score: score,
                    lagSec: lag / envelopeRate,
                    overlapSec: overlap / envelopeRate
                };
            }
        }

        // Flag a best lag pinned to the search boundary. A peak at ±maxShift is the
        // classic signature of a spurious match (the true peak is elsewhere or
        // absent), so callers can distrust it rather than apply a boundary guess.
        if (best) {
            var bestFrames = Math.round(best.lagSec * envelopeRate);
            var railTol = Math.max(1, Math.round(maxLagFrames * 0.05));
            best.atRail = Math.abs(bestFrames) >= (maxLagFrames - railTol);
        }

        return best;
    }

    // Slide a SHORT target envelope across a LONG reference envelope to find
    // where it best matches — used by the coarse pass to locate one clip inside
    // a whole reference recording when the offset between devices may be large
    // (minutes), far beyond findBestLag's symmetric ±maxShift window.
    //
    // Returns { score, lagSec, overlapSec } where lagSec is the offset of the
    // target's first frame relative to the reference's first frame (positive =
    // target starts later into the reference). Caller maps that to a timeline
    // shift. opts: { envelopeRate, minOverlapSec, maxLagSec }.
    function slideMatch(refEnvelope, targetEnvelope, opts) {
        opts = opts || {};
        var envelopeRate = opts.envelopeRate || ENVELOPE_RATE;
        var minOverlapSec = (opts.minOverlapSec !== undefined && opts.minOverlapSec !== null)
            ? opts.minOverlapSec
            : FINE_TUNE_MIN_OVERLAP_SEC;

        var refLen = refEnvelope.length;
        var tgtLen = targetEnvelope.length;
        var minOverlap = Math.max(1, Math.round(minOverlapSec * envelopeRate));

        var lagMin = -(tgtLen - minOverlap);
        var lagMax = refLen - minOverlap;
        if (opts.maxLagSec !== undefined && opts.maxLagSec !== null) {
            var maxLagFrames = Math.round(opts.maxLagSec * envelopeRate);
            if (lagMin < -maxLagFrames) lagMin = -maxLagFrames;
            if (lagMax > maxLagFrames) lagMax = maxLagFrames;
        }

        var best = null;
        for (var lag = lagMin; lag <= lagMax; lag += 1) {
            var start = lag > 0 ? lag : 0;             // first ref index in overlap
            var end = Math.min(refLen, lag + tgtLen);  // one past last ref index
            var overlap = end - start;
            if (overlap < minOverlap) continue;
            var tgtBase = start - lag;                 // matching target index at `start`

            var refSum = 0, tgtSum = 0;
            for (var i = 0; i < overlap; i += 1) {
                refSum += refEnvelope[start + i];
                tgtSum += targetEnvelope[tgtBase + i];
            }
            var refMean = refSum / overlap;
            var tgtMean = tgtSum / overlap;

            var dot = 0, refEnergy = 0, tgtEnergy = 0;
            for (var j = 0; j < overlap; j += 1) {
                var rv = refEnvelope[start + j] - refMean;
                var tv = targetEnvelope[tgtBase + j] - tgtMean;
                dot += rv * tv;
                refEnergy += rv * rv;
                tgtEnergy += tv * tv;
            }

            if (!refEnergy || !tgtEnergy) continue;
            var s = dot / Math.sqrt(refEnergy * tgtEnergy);
            if (!best || s > best.score) {
                best = {
                    score: s,
                    lagSec: lag / envelopeRate,
                    overlapSec: overlap / envelopeRate
                };
            }
        }

        return best;
    }

    // ─── Fine-tune anchor planning ────────────────────────────────────────────
    // Collapse timeline clip instances to one anchor per source FILE, then mark
    // which files are the reference. One anchor per file guarantees the coarse and
    // fine passes compute ONE shift per file, which the apply step gives to every
    // timeline instance of that file — a clip's video and its linked audio can
    // never be shifted apart. Anchors get layerOrder 0 (reference) or 1
    // (everything else); the coarse and fine passes align layer-1 clips to the
    // layer-0 reference. `forcedRefTrackKey` ("video_0", "audio_2") is the
    // panel's reference dropdown; without it the reference is picked
    // automatically — see planReferenceLayer.
    function buildFineTuneAnchors(clips, forcedRefTrackKey) {
        var byKey = {};
        var order = [];

        for (var c = 0; c < clips.length; c += 1) {
            var clip = clips[c];
            if (!clip.filePath || !clip.startTicks) continue;
            var key = clip.filePath;

            if (!Object.prototype.hasOwnProperty.call(byKey, key)) {
                byKey[key] = {
                    key: key,
                    filePath: clip.filePath,
                    startTicks: clip.startTicks,
                    clipName: clip.clipName,
                    trackType: clip.trackType,
                    trackIndex: clip.trackIndex,
                    startSec: clip.startSec,
                    endSec: clip.endSec,
                    inPointSec: clip.inPointSec,
                    resolvedStartSec: clip.startSec,
                    resolvedEndSec: clip.endSec
                };
                order.push(key);
                continue;
            }

            // A file usually appears on both a video track and its linked audio
            // track(s); prefer the video instance so the anchor reflects the
            // video track, then the earliest instance of that type.
            var existing = byKey[key];
            var better =
                (clip.trackType === "video" && existing.trackType !== "video") ||
                (clip.trackType === existing.trackType && clip.startSec < existing.startSec);
            if (better) {
                existing.startTicks = clip.startTicks;
                existing.clipName = clip.clipName;
                existing.trackType = clip.trackType;
                existing.trackIndex = clip.trackIndex;
                existing.startSec = clip.startSec;
                existing.endSec = clip.endSec;
                existing.inPointSec = clip.inPointSec;
                existing.resolvedStartSec = clip.startSec;
                existing.resolvedEndSec = clip.endSec;
            }
        }

        var anchors = [];
        for (var k = 0; k < order.length; k += 1) anchors.push(byKey[order[k]]);

        var plan = planReferenceLayer(anchors, clips, forcedRefTrackKey);
        for (var b = 0; b < anchors.length; b += 1) {
            var isRef = Object.prototype.hasOwnProperty.call(plan.refPaths, anchors[b].filePath);
            anchors[b].layerOrder = isRef ? 0 : 1;
            anchors[b].isReference = isRef;
        }

        return anchors.sort(function (a, b) {
            if (a.layerOrder !== b.layerOrder) return a.layerOrder - b.layerOrder;
            if (a.startSec !== b.startSec) return a.startSec - b.startSec;
            return a.clipName.localeCompare(b.clipName);
        });
    }

    // ─── Reference layer selection ────────────────────────────────────────────
    // Decide which recordings form the reference layer — the layer every other
    // clip is aligned TO. Returns { refTrackKey, refPaths, forced,
    // rejectedTrackKey, fallbackReason }, where refPaths is the set of source
    // file paths in that layer.
    //
    // `forcedRefTrackKey` is the panel's reference dropdown ("video_0",
    // "audio_2"): every FILE with an instance on that timeline track joins the
    // reference layer. Picking a track therefore picks the recordings sitting on
    // it, not the anchors whose (video-preferred) position happens to be there —
    // a camera whose audio sits on A1 anchors to its V1 instance, yet choosing
    // A1 must still select that camera.
    //
    // Falls back to the automatic pick when no track is forced, when the forced
    // track holds no usable clip, or when it holds EVERY file and so leaves
    // nothing to align to it (the A1 that carries every camera's linked audio is
    // the realistic case). The automatic pick is the track with the most total
    // recorded coverage — typically the continuous main-camera/program recording
    // or a field-recorder WAV. That is chosen by content, NOT by track position,
    // so it works no matter which track the main recording sits on.
    function planReferenceLayer(anchors, clips, forcedRefTrackKey) {
        var i;

        if (forcedRefTrackKey) {
            var onTrack = {};
            for (i = 0; i < clips.length; i += 1) {
                var clip = clips[i];
                if (!clip.filePath) continue;
                if ((clip.trackType + "_" + clip.trackIndex) !== forcedRefTrackKey) continue;
                onTrack[clip.filePath] = true;
            }
            // Only files that survived as anchors count: a clip with no start
            // ticks or no readable media path never becomes one.
            var kept = {};
            var keptCount = 0;
            for (i = 0; i < anchors.length; i += 1) {
                if (!Object.prototype.hasOwnProperty.call(onTrack, anchors[i].filePath)) continue;
                if (Object.prototype.hasOwnProperty.call(kept, anchors[i].filePath)) continue;
                kept[anchors[i].filePath] = true;
                keptCount += 1;
            }
            if (!keptCount) {
                return autoReferenceLayer(anchors, forcedRefTrackKey, "it holds no clip the panel can read");
            }
            if (keptCount >= anchors.length) {
                return autoReferenceLayer(anchors, forcedRefTrackKey,
                    "it holds every clip in the sequence, so nothing would be left to align to it");
            }
            return {
                refTrackKey: forcedRefTrackKey, refPaths: kept, forced: true,
                rejectedTrackKey: null, fallbackReason: null
            };
        }

        return autoReferenceLayer(anchors, null, null);
    }

    function autoReferenceLayer(anchors, rejectedTrackKey, fallbackReason) {
        var coverage = {};
        var a, tk;
        for (a = 0; a < anchors.length; a += 1) {
            tk = anchors[a].trackType + "_" + anchors[a].trackIndex;
            coverage[tk] = (coverage[tk] || 0) + (anchors[a].endSec - anchors[a].startSec);
        }
        var refTrackKey = null;
        var refCoverage = -1;
        for (var tkey in coverage) {
            if (Object.prototype.hasOwnProperty.call(coverage, tkey) && coverage[tkey] > refCoverage) {
                refCoverage = coverage[tkey];
                refTrackKey = tkey;
            }
        }
        var refPaths = {};
        for (a = 0; a < anchors.length; a += 1) {
            tk = anchors[a].trackType + "_" + anchors[a].trackIndex;
            if (tk === refTrackKey) refPaths[anchors[a].filePath] = true;
        }
        return {
            refTrackKey: refTrackKey, refPaths: refPaths, forced: false,
            rejectedTrackKey: rejectedTrackKey, fallbackReason: fallbackReason
        };
    }

    // "audio_2" → "AUDIO 3" (1-based, matching Premiere's track headers).
    function trackKeyLabel(key) {
        if (!key) return "";
        var cut = String(key).lastIndexOf("_");
        if (cut < 1) return String(key);
        var type = key.slice(0, cut);
        var index = parseInt(key.slice(cut + 1), 10);
        if (isNaN(index)) return String(key);
        return type.toUpperCase() + " " + (index + 1);
    }

    // ─── Post-apply integrity check ───────────────────────────────────────────
    // Syncitol moves clips ONE DELTA PER SOURCE FILE, so a file's video and its
    // linked audio can never be asked to move apart. The host can still refuse
    // or alter an INDIVIDUAL move — a locked track, a destination that would
    // overlap a neighbour on that track, an item whose action could not be
    // built, or frame quantization applied to a video item but not its audio —
    // and Premiere reports that per action, not per file. A refusal therefore
    // tears the link group it belongs to, silently. UXP exposes no link API
    // (selection does not expand to linked items), so the only way to know is to
    // read the timeline back and compare.
    //
    // `before` and `after` are scan clip lists of the SAME sequence, taken
    // around one apply. Instances are paired per file+track in timeline order,
    // which is stable because every instance of a file is moved by the same
    // delta. What matters is that a file's instances all moved TOGETHER; moving
    // by something other than the request, but consistently (the host snapping
    // to the frame grid), keeps A/V intact and is reported separately.
    //
    // Returns { torn, missing, quantized } — see the three shapes below.
    function diffInstanceMovement(before, after, deltaByPath, toleranceSec) {
        var tol = (toleranceSec === undefined || toleranceSec === null) ? 0.001 : toleranceSec;

        function index(clips) {
            var out = {};
            for (var i = 0; i < clips.length; i += 1) {
                var c = clips[i];
                if (!c.filePath) continue;
                var key = c.filePath + "|" + c.trackType + "_" + c.trackIndex;
                if (!out[key]) out[key] = [];
                out[key].push(c);
            }
            for (var k in out) {
                if (Object.prototype.hasOwnProperty.call(out, k)) {
                    out[k].sort(function (a, b) { return a.startSec - b.startSec; });
                }
            }
            return out;
        }

        var beforeBy = index(before);
        var afterBy = index(after);

        // File → its requested delta, keeping only files we actually asked to move.
        var wanted = {};
        for (var path in deltaByPath) {
            if (!Object.prototype.hasOwnProperty.call(deltaByPath, path)) continue;
            if (Math.abs(deltaByPath[path]) < tol) continue;
            wanted[path] = deltaByPath[path];
        }

        var byFile = {};   // filePath → { moves: [...], missing: [...] }
        for (var bkey in beforeBy) {
            if (!Object.prototype.hasOwnProperty.call(beforeBy, bkey)) continue;
            var cut = bkey.lastIndexOf("|");
            var filePath = bkey.slice(0, cut);
            if (!Object.prototype.hasOwnProperty.call(wanted, filePath)) continue;

            if (!byFile[filePath]) byFile[filePath] = { moves: [], missing: [], clipName: null, ambiguous: false };
            var entry = byFile[filePath];
            var beforeList = beforeBy[bkey];
            var afterList = afterBy[bkey] || [];
            if (!entry.clipName) entry.clipName = beforeList[0].clipName;

            // More than one instance of this file on one track means the
            // before/after pairing is a guess (they are matched in time order,
            // which only holds while they move together — exactly what is in
            // doubt here). Repairing on a wrong pairing would move a clip
            // somewhere new, so the repair pass is told to keep its hands off.
            if (beforeList.length > 1) entry.ambiguous = true;

            if (afterList.length !== beforeList.length) {
                entry.missing.push({
                    trackType: beforeList[0].trackType,
                    trackIndex: beforeList[0].trackIndex,
                    beforeCount: beforeList.length,
                    afterCount: afterList.length
                });
                continue;
            }
            for (var i = 0; i < beforeList.length; i += 1) {
                entry.moves.push({
                    trackType: beforeList[i].trackType,
                    trackIndex: beforeList[i].trackIndex,
                    clipName: beforeList[i].clipName,
                    fromSec: beforeList[i].startSec,
                    toSec: afterList[i].startSec,
                    movedSec: afterList[i].startSec - beforeList[i].startSec,
                    // Index in the AFTER scan: the handle a repair pass needs to
                    // address this exact item again.
                    afterIndex: afterList[i].itemIndex
                });
            }
        }

        var torn = [];
        var missing = [];
        var quantized = [];
        for (var fp in byFile) {
            if (!Object.prototype.hasOwnProperty.call(byFile, fp)) continue;
            var f = byFile[fp];
            if (f.missing.length) {
                missing.push({ filePath: fp, clipName: f.clipName, tracks: f.missing });
            }
            if (!f.moves.length) continue;

            var lo = f.moves[0].movedSec;
            var hi = f.moves[0].movedSec;
            for (var m = 1; m < f.moves.length; m += 1) {
                if (f.moves[m].movedSec < lo) lo = f.moves[m].movedSec;
                if (f.moves[m].movedSec > hi) hi = f.moves[m].movedSec;
            }
            var requested = wanted[fp];
            if (hi - lo > tol) {
                torn.push({
                    filePath: fp, clipName: f.clipName, requestedSec: requested,
                    spreadSec: hi - lo, instances: f.moves, ambiguous: !!f.ambiguous
                });
            } else if (Math.abs(lo - requested) > tol) {
                // Consistent across the file, so A/V is intact — the host just
                // did not land exactly where it was asked (frame grid, t=0 edge).
                quantized.push({
                    filePath: fp, clipName: f.clipName, requestedSec: requested,
                    actualSec: lo, instances: f.moves.length
                });
            }
        }

        return { torn: torn, missing: missing, quantized: quantized };
    }

    // A spread this small is the host snapping a video item to the frame grid
    // while its audio sits at sample resolution — it is sub-frame at every sane
    // frame rate, inaudible, and not what "the clip came unlinked" means. Repair
    // only above it, so a healthy sync is never dragged around chasing rounding.
    var TEAR_REPAIR_MIN_SEC = 0.01;

    // ─── A/V alignment, measured absolutely ───────────────────────────────────
    // diffInstanceMovement answers "did this file's instances move together?".
    // That is the right question for a move we just made, and the wrong question
    // for the timeline as a whole: a clip whose video and audio were ALREADY out
    // of step stays out of step when both are moved rigidly, the movement spread
    // is zero, and the check reports everything clean. The tear is invisible to
    // it by construction — and survives into the next sequence, which is how a
    // sync run on an already-synced timeline inherits a fault it did not cause.
    //
    // This asks the absolute question instead: a file placed as one piece has
    // its video and audio starting at the same timeline position, so any
    // difference is a clip that is out of sync, whoever broke it.
    //
    // `clips` is a scan clip list. Files with more than one instance on a track
    // are reported as `ambiguous` rather than guessed at — the same file cut
    // into several pieces has no single right answer here.
    //
    // Returns { checked, misaligned, ambiguous }:
    //   misaligned — [{ filePath, clipName, offsetSec, videoTrack, audioTrack }]
    //                offsetSec is audio start minus video start
    //   ambiguous  — [{ filePath, clipName, reason }]
    function auditLinkAlignment(clips, tolSec) {
        var tol = (tolSec === undefined || tolSec === null) ? 0.005 : tolSec;
        var out = { checked: 0, misaligned: [], ambiguous: [] };

        var byPath = {};
        var order = [];
        for (var i = 0; i < (clips || []).length; i += 1) {
            var c = clips[i];
            if (!c.filePath) continue;
            if (!Object.prototype.hasOwnProperty.call(byPath, c.filePath)) {
                byPath[c.filePath] = { video: [], audio: [], clipName: c.clipName };
                order.push(c.filePath);
            }
            (c.trackType === "video" ? byPath[c.filePath].video : byPath[c.filePath].audio).push(c);
        }

        for (var k = 0; k < order.length; k += 1) {
            var path = order[k];
            var f = byPath[path];
            if (!f.video.length || !f.audio.length) continue;   // nothing to compare

            // One instance of each is the case this can speak to with certainty.
            // Anything else (a clip razored into pieces, multi-channel audio
            // spread over several tracks) has no single expected relationship.
            if (f.video.length !== 1 || f.audio.length !== 1) {
                out.ambiguous.push({
                    filePath: path, clipName: f.clipName,
                    reason: f.video.length + " video and " + f.audio.length +
                            " audio instances — no single pairing to check"
                });
                continue;
            }

            out.checked += 1;
            var v = f.video[0], a = f.audio[0];
            var offset = a.startSec - v.startSec;
            if (Math.abs(offset) <= tol) continue;
            out.misaligned.push({
                filePath: path, clipName: f.clipName,
                offsetSec: Math.round(offset * 1000) / 1000,
                videoTrack: v.trackType + "_" + v.trackIndex,
                audioTrack: a.trackType + "_" + a.trackIndex,
                // Handles for the repair: the audio is what moves, because the
                // picture is what the edit is cut against.
                audio: { trackType: a.trackType, trackIndex: a.trackIndex, itemIndex: a.itemIndex },
                video: { trackType: v.trackType, trackIndex: v.trackIndex, itemIndex: v.itemIndex }
            });
        }
        return out;
    }

    // Which files are newly out of step, as opposed to arriving that way? Takes
    // two auditLinkAlignment results around one apply and splits the second's
    // misalignments into the ones this apply created or changed, and the ones it
    // merely carried along. Only the first kind is anybody's fault here.
    function diffLinkAlignment(beforeAudit, afterAudit, tolSec) {
        var tol = (tolSec === undefined || tolSec === null) ? 0.005 : tolSec;
        var was = {};
        var i;
        for (i = 0; i < ((beforeAudit && beforeAudit.misaligned) || []).length; i += 1) {
            was[beforeAudit.misaligned[i].filePath] = beforeAudit.misaligned[i].offsetSec;
        }
        var out = { created: [], worsened: [], preexisting: [] };
        var list = (afterAudit && afterAudit.misaligned) || [];
        for (i = 0; i < list.length; i += 1) {
            var m = list[i];
            if (!Object.prototype.hasOwnProperty.call(was, m.filePath)) {
                out.created.push(m);
            } else if (Math.abs(m.offsetSec - was[m.filePath]) > tol) {
                out.worsened.push({
                    filePath: m.filePath, clipName: m.clipName,
                    offsetSec: m.offsetSec, wasSec: was[m.filePath],
                    videoTrack: m.videoTrack, audioTrack: m.audioTrack
                });
            } else {
                out.preexisting.push(m);
            }
        }
        return out;
    }

    // ─── Tear repair ──────────────────────────────────────────────────────────
    // Turn diffInstanceMovement().torn into the moves that put a file back
    // together. Two strategies, in order of preference:
    //
    //   "complete" — most instances landed on the requested delta, so nudge the
    //                stragglers the rest of the way. The file ends up synced.
    //   "restore"  — used when completing has already been tried and failed:
    //                move every instance back to where it started. The file is
    //                left unsynced, which is a great deal better than leaving a
    //                clip's audio hanging off its video.
    //
    // `torn` is integrity.torn; `mode` is "complete" or "restore". Returns
    // [{ filePath, trackType, trackIndex, itemIndex, deltaSec }] — exactly the
    // target shape applyStarts consumes — with no-op moves dropped.
    function planTearRepair(torn, mode, minMoveSec) {
        var floor = (minMoveSec === undefined || minMoveSec === null) ? TEAR_REPAIR_MIN_SEC : minMoveSec;
        var out = [];
        for (var i = 0; i < (torn || []).length; i += 1) {
            var f = torn[i];
            if (f.spreadSec !== undefined && f.spreadSec <= floor) continue;
            if (f.ambiguous) continue;   // pairing is a guess; do not move on a guess
            for (var j = 0; j < f.instances.length; j += 1) {
                var inst = f.instances[j];
                if (inst.afterIndex === undefined || inst.afterIndex === null) continue;
                var delta = (mode === "restore")
                    ? -inst.movedSec                    // back to fromSec
                    : f.requestedSec - inst.movedSec;   // on to the requested landing
                if (!isFinite(delta) || Math.abs(delta) < floor) continue;
                out.push({
                    filePath: f.filePath,
                    trackType: inst.trackType,
                    trackIndex: inst.trackIndex,
                    itemIndex: inst.afterIndex,
                    deltaSec: delta
                });
            }
        }
        return out;
    }

    // Moves that put a clip's sound back under its picture. `items` is a list of
    // auditLinkAlignment misalignments; each yields one move of the AUDIO
    // instance by minus its offset, addressed by the track and index it was seen
    // at. The video is left alone deliberately: it is what the edit is cut
    // against, and moving it would drag the problem into the timeline.
    //
    // Comparing the two instances to EACH OTHER is what makes this safe to act
    // on. Both sit on the same sequence's frame grid, so frame snapping moves
    // them together and cancels out — unlike a comparison against a requested
    // landing position, which has to guess the frame rate to know what "close
    // enough" means.
    function planLinkRepair(items, minMoveSec) {
        var floor = (minMoveSec === undefined || minMoveSec === null) ? 0.005 : minMoveSec;
        var out = [];
        for (var i = 0; i < (items || []).length; i += 1) {
            var m = items[i];
            if (!m || !m.audio || m.audio.itemIndex === undefined || m.audio.itemIndex === null) continue;
            if (!isFinite(m.offsetSec) || Math.abs(m.offsetSec) < floor) continue;
            out.push({
                filePath: m.filePath,
                trackType: m.audio.trackType,
                trackIndex: m.audio.trackIndex,
                itemIndex: m.audio.itemIndex,
                deltaSec: -m.offsetSec
            });
        }
        return out;
    }

    // ─── Link groups ──────────────────────────────────────────────────────────
    // Syncitol moves one delta per source FILE, which keeps a camera clip's own
    // video and audio together because they share a path. It does NOT cover the
    // other kind of link group: a video item linked to audio from a DIFFERENT
    // file (merged clips, "Synchronize", or a manual Clip > Link), and items
    // whose media path would not resolve at all — those are invisible to the
    // move, so their partner walks off without them. Both tear on apply.
    //
    // UXP exposes no link API (selection does not expand to linked items), so
    // the group has to be inferred. A linked V/A pair always occupies exactly
    // the same span, so: items on different tracks, of BOTH media types, whose
    // start AND end agree within `tolSec`. Two unrelated clips matching to the
    // millisecond on both edges is vanishingly rare; sharing only one edge is
    // common, which is why both are required.
    //
    //   clips   — scan clips: { filePath, trackType, trackIndex, itemIndex,
    //             startSec, endSec, clipName }
    //   opaque  — items the scan could not resolve a path for, same shape minus
    //             filePath. They can still be MOVED (track + index is enough).
    //   deltas  — { filePath: deltaSec } as planned so far.
    //
    // Returns { deltas, opaqueTargets, unified, blocked }:
    //   deltas        — a NEW map, with member files re-pointed at their group's
    //                   delta so every instance of a file still moves as one.
    //   opaqueTargets — explicit targets that carry unreadable items along.
    //   unified       — groups that were brought onto one delta (for the log).
    //   blocked       — groups left alone because no single delta could satisfy
    //                   them; their files are dropped from `deltas`.
    function planLinkGroups(clips, opaque, deltas, tolSec) {
        var tol = (tolSec === undefined || tolSec === null) ? 0.002 : tolSec;
        var result = { deltas: {}, opaqueTargets: [], unified: [], blocked: [] };
        for (var path in deltas) {
            if (Object.prototype.hasOwnProperty.call(deltas, path)) result.deltas[path] = deltas[path];
        }

        var members = [];
        var k;
        for (k = 0; k < (clips || []).length; k += 1) {
            members.push({
                filePath: clips[k].filePath, trackType: clips[k].trackType,
                trackIndex: clips[k].trackIndex, itemIndex: clips[k].itemIndex,
                startSec: clips[k].startSec, endSec: clips[k].endSec,
                clipName: clips[k].clipName, opaque: false
            });
        }
        for (k = 0; k < (opaque || []).length; k += 1) {
            members.push({
                filePath: null, trackType: opaque[k].trackType,
                trackIndex: opaque[k].trackIndex, itemIndex: opaque[k].itemIndex,
                startSec: opaque[k].startSec, endSec: opaque[k].endSec,
                clipName: opaque[k].clipName, opaque: true
            });
        }
        if (members.length < 2) return result;

        // Group by identical span. Sorting by start first means a group's members
        // are always adjacent, so one linear sweep finds them all.
        members.sort(function (a, b) { return (a.startSec - b.startSec) || (a.endSec - b.endSec); });
        var groups = [];
        var current = [members[0]];
        for (k = 1; k < members.length; k += 1) {
            var head = current[0];
            if (Math.abs(members[k].startSec - head.startSec) <= tol &&
                Math.abs(members[k].endSec - head.endSec) <= tol) {
                current.push(members[k]);
            } else {
                if (current.length > 1) groups.push(current);
                current = [members[k]];
            }
        }
        if (current.length > 1) groups.push(current);

        // A link group is a V/A pair, so demand both media types and more than
        // one track. Same-type coincidences (two cameras, a stereo pair split
        // over A1/A2) are not link groups and must not be touched.
        var candidates = [];
        for (k = 0; k < groups.length; k += 1) {
            var g = groups[k];
            var hasVideo = false, hasAudio = false, tracks = {};
            for (var m = 0; m < g.length; m += 1) {
                if (g[m].trackType === "video") hasVideo = true; else hasAudio = true;
                tracks[g[m].trackType + "_" + g[m].trackIndex] = true;
            }
            var trackCount = 0;
            for (var tkey in tracks) { if (Object.prototype.hasOwnProperty.call(tracks, tkey)) trackCount += 1; }
            if (hasVideo && hasAudio && trackCount > 1) candidates.push(g);
        }
        if (!candidates.length) return result;

        var deltaOf = function (member) {
            if (member.opaque) return 0;      // cannot be addressed by path: it stays put
            var d = deltas[member.filePath];
            return (d === undefined || d === null || !isFinite(d)) ? 0 : d;
        };

        // Per group: does one delta already satisfy it, and if not, which one
        // should? The video member's is the honest anchor — the picture is what
        // the edit is cut against, so the sound moves to it.
        var pending = [];   // { group, groupDelta }
        for (k = 0; k < candidates.length; k += 1) {
            var grp = candidates[k];
            var lo = deltaOf(grp[0]), hi = lo, i2;
            for (i2 = 1; i2 < grp.length; i2 += 1) {
                var dv = deltaOf(grp[i2]);
                if (dv < lo) lo = dv;
                if (dv > hi) hi = dv;
            }
            if (hi - lo <= tol) continue;   // already agrees — nothing to do

            var videoDeltas = [];
            for (i2 = 0; i2 < grp.length; i2 += 1) {
                if (grp[i2].trackType === "video" && !grp[i2].opaque) videoDeltas.push(deltaOf(grp[i2]));
            }
            var groupDelta = null, conflicted = false;
            if (videoDeltas.length) {
                groupDelta = videoDeltas[0];
                for (i2 = 1; i2 < videoDeltas.length; i2 += 1) {
                    if (Math.abs(videoDeltas[i2] - groupDelta) > tol) conflicted = true;
                }
            } else {
                conflicted = true;   // no readable picture to anchor on
            }
            pending.push({ group: grp, groupDelta: groupDelta, conflicted: conflicted });
        }
        if (!pending.length) return result;

        // A file may sit in more than one group. If those groups disagree about
        // where it should go, no single per-file delta can satisfy both, so both
        // groups are left alone rather than half-fixed.
        var claim = {};      // filePath -> groupDelta claimed
        var bad = {};        // filePath -> true
        for (k = 0; k < pending.length; k += 1) {
            if (pending[k].conflicted) {
                for (i2 = 0; i2 < pending[k].group.length; i2 += 1) {
                    if (pending[k].group[i2].filePath) bad[pending[k].group[i2].filePath] = true;
                }
                continue;
            }
            for (i2 = 0; i2 < pending[k].group.length; i2 += 1) {
                var mem = pending[k].group[i2];
                if (!mem.filePath) continue;
                if (Object.prototype.hasOwnProperty.call(claim, mem.filePath) &&
                    Math.abs(claim[mem.filePath] - pending[k].groupDelta) > tol) {
                    bad[mem.filePath] = true;
                } else {
                    claim[mem.filePath] = pending[k].groupDelta;
                }
            }
        }

        var names = function (group) {
            var out2 = [], seen = {};
            for (var q = 0; q < group.length; q += 1) {
                var label = group[q].clipName || (group[q].filePath ? group[q].filePath : "unreadable item");
                if (seen[label]) continue;
                seen[label] = true;
                out2.push(label);
            }
            return out2;
        };

        // Blocking a group strands every file in it, which can in turn block
        // another group that shares one of those files. Settle that before
        // touching the delta map, or the outcome would depend on group order.
        var groupBlocked = [];
        for (k = 0; k < pending.length; k += 1) groupBlocked.push(pending[k].conflicted);
        var changed = true;
        while (changed) {
            changed = false;
            for (k = 0; k < pending.length; k += 1) {
                if (groupBlocked[k]) {
                    for (i2 = 0; i2 < pending[k].group.length; i2 += 1) {
                        var bf = pending[k].group[i2].filePath;
                        if (bf && !bad[bf]) { bad[bf] = true; changed = true; }
                    }
                    continue;
                }
                for (i2 = 0; i2 < pending[k].group.length; i2 += 1) {
                    var cf = pending[k].group[i2].filePath;
                    if (cf && bad[cf]) { groupBlocked[k] = true; changed = true; break; }
                }
            }
        }

        for (k = 0; k < pending.length; k += 1) {
            var entry = pending[k];
            if (groupBlocked[k]) {
                for (i2 = 0; i2 < entry.group.length; i2 += 1) {
                    if (entry.group[i2].filePath) delete result.deltas[entry.group[i2].filePath];
                }
                result.blocked.push({
                    startSec: entry.group[0].startSec, endSec: entry.group[0].endSec,
                    names: names(entry.group)
                });
                continue;
            }
            var groupPaths = [];
            for (i2 = 0; i2 < entry.group.length; i2 += 1) {
                if (entry.group[i2].filePath) groupPaths.push(entry.group[i2].filePath);
            }
            for (i2 = 0; i2 < entry.group.length; i2 += 1) {
                var mb = entry.group[i2];
                if (mb.filePath) {
                    result.deltas[mb.filePath] = entry.groupDelta;
                } else if (Math.abs(entry.groupDelta) > tol) {
                    result.opaqueTargets.push({
                        // The file this item must move WITH. The caller keys the
                        // apply by it so the pair is all-or-nothing together —
                        // an unreadable item in a group of its own could be
                        // refused on its own and leave its partner behind.
                        filePath: null, anchorPath: groupPaths.length ? groupPaths[0] : null,
                        trackType: mb.trackType, trackIndex: mb.trackIndex,
                        itemIndex: mb.itemIndex, deltaSec: entry.groupDelta,
                        // The files this item is travelling with. If the caller
                        // later refuses to move one of them (the t=0 guard), it
                        // must hold this item back too or the group splits.
                        groupPaths: groupPaths
                    });
                }
            }
            result.unified.push({
                deltaSec: entry.groupDelta, paths: groupPaths,
                startSec: entry.group[0].startSec, endSec: entry.group[0].endSec,
                names: names(entry.group)
            });
        }
        return result;
    }

    // Plan the overlapping comparison windows for a reference/target anchor pair.
    function buildCompareWindow(reference, target) {
        var compareStart = Math.max(reference.resolvedStartSec, target.resolvedStartSec);
        var compareEnd = Math.min(reference.resolvedEndSec, target.resolvedEndSec);
        var overlap = compareEnd - compareStart;
        if (overlap < FINE_TUNE_MIN_OVERLAP_SEC) return null;

        var compareDuration = Math.min(overlap, FINE_TUNE_MAX_COMPARE_SEC);
        var slack = overlap - compareDuration;
        var windows = [];
        var seenStarts = {};

        for (var p = 0; p < FINE_TUNE_WINDOW_POSITIONS.length; p += 1) {
            var position = FINE_TUNE_WINDOW_POSITIONS[p];
            var start = compareStart + (slack * position);
            var roundedStart = Number(start.toFixed(3));
            if (Object.prototype.hasOwnProperty.call(seenStarts, roundedStart)) continue;
            seenStarts[roundedStart] = true;

            windows.push({
                compareStartSec: start,
                compareDurationSec: compareDuration,
                compareEndSec: start + compareDuration,
                refSourceOffsetSec: reference.inPointSec + (start - reference.resolvedStartSec),
                targetSourceOffsetSec: target.inPointSec + (start - target.resolvedStartSec)
            });
        }

        return {
            overlapSec: overlap,
            compareDurationSec: compareDuration,
            windows: windows
        };
    }

    // Plan the two probe windows for a drift check on a reference/target pair:
    // one near the start of their overlap, one near the end. Returns null when
    // the overlap is too short for drift to be measurable (or matter). The
    // caller correlates each window (same shape as buildCompareWindow windows)
    // and compares the two lags: driftSec = lateLag − earlyLag over spanSec.
    function buildDriftProbe(reference, target, minOverlapSec) {
        var floor = (minOverlapSec === undefined || minOverlapSec === null)
            ? DRIFT_MIN_OVERLAP_SEC : minOverlapSec;
        var overlapStart = Math.max(reference.resolvedStartSec, target.resolvedStartSec);
        var overlapEnd = Math.min(reference.resolvedEndSec, target.resolvedEndSec);
        var overlap = overlapEnd - overlapStart;
        if (overlap < floor) return null;

        var windowDur = FINE_TUNE_MAX_COMPARE_SEC;
        var earlyStart = overlapStart + (overlap * DRIFT_EDGE_FRACTION);
        var lateStart = overlapStart + (overlap * (1 - DRIFT_EDGE_FRACTION)) - windowDur;
        var spanSec = lateStart - earlyStart;
        if (spanSec <= 0) return null;

        function windowAt(startSec) {
            return {
                compareStartSec: startSec,
                compareDurationSec: windowDur,
                refSourceOffsetSec: reference.inPointSec + (startSec - reference.resolvedStartSec),
                targetSourceOffsetSec: target.inPointSec + (startSec - target.resolvedStartSec)
            };
        }

        return {
            spanSec: spanSec,
            early: windowAt(earlyStart),
            late: windowAt(lateStart)
        };
    }

    // ─── Premiere .pek peak files ─────────────────────────────────────────────
    // Premiere pre-computes an audio peak cache (.pek) for every imported media
    // file — effectively the envelope the coarse pass spends minutes decoding,
    // already on disk. Format (validated against ffmpeg ground truth on real
    // stereo MP4 and 4-channel MXF footage, r ≥ 0.99 at exact offsets):
    //   header, 68 bytes: u32 magic 0x67235411 @0, u32 @4, u32 channelCount @8,
    //     f64le sampleRate @12, ids/hashes, u32 payloadBytes @64
    //   payload, CHANNEL-PLANAR: for each channel in order, `blocks` consecutive
    //     4-byte entries (int16 max, int16 min), each covering
    //     PEK_SAMPLES_PER_BLOCK source samples (187.5 Hz at 48 kHz).
    // The planar layout matters: interleaving reads one channel at double speed
    // and produces a self-consistent but WRONG envelope.
    var PEK_MAGIC = 0x67235411;
    var PEK_HEADER_BYTES = 68;
    var PEK_SAMPLES_PER_BLOCK = 256;

    // Byte-reader shim: Node Buffers pass through untouched; ArrayBuffers and
    // TypedArrays (UXP fs.readFile) get a DataView wrapper with the same reader
    // methods. Returns null for anything else.
    function bytesReader(src) {
        if (!src) return null;
        if (typeof src.readUInt32LE === "function") return src; // Node Buffer
        var view = null;
        if (typeof ArrayBuffer !== "undefined") {
            if (src instanceof ArrayBuffer) view = new DataView(src);
            else if (src.buffer instanceof ArrayBuffer) {
                view = new DataView(src.buffer, src.byteOffset || 0, src.byteLength);
            }
        }
        if (!view) return null;
        return {
            length: view.byteLength,
            readUInt32LE: function (o) { return view.getUint32(o, true); },
            readDoubleLE: function (o) { return view.getFloat64(o, true); },
            readInt16LE: function (o) { return view.getInt16(o, true); }
        };
    }

    // Parse and sanity-check a .pek header. Returns the layout info or null when
    // the buffer is not a plausible peak file (callers then fall back to decode).
    function parsePekInfo(buffer) {
        buffer = bytesReader(buffer);
        if (!buffer || buffer.length < PEK_HEADER_BYTES + 4) return null;
        if (buffer.readUInt32LE(0) !== PEK_MAGIC) return null;
        var channels = buffer.readUInt32LE(8);
        var sampleRate = buffer.readDoubleLE(12);
        var dataBytes = buffer.readUInt32LE(64);
        if (!(channels >= 1 && channels <= 32)) return null;
        if (!(sampleRate >= 8000 && sampleRate <= 384000)) return null;
        if (dataBytes <= 0 || PEK_HEADER_BYTES + dataBytes > buffer.length) return null;
        var blocks = Math.floor(dataBytes / 4 / channels);
        if (blocks < 1) return null;
        var blockRate = sampleRate / PEK_SAMPLES_PER_BLOCK;
        return {
            channels: channels,
            sampleRate: sampleRate,
            blocks: blocks,
            blockRate: blockRate,
            durationSec: blocks / blockRate
        };
    }

    // Build an envelope at `targetRate` Hz for [startSec, startSec + durSec)
    // from a parsed .pek: mean over channels of per-block (max − min) / 2,
    // aggregated per target frame. Pass durSec null/undefined for "to the end".
    // Returns a Float32Array (possibly empty when the slice is out of range).
    // `channel` selects ONE channel plane instead of averaging all of them. A
    // 4-channel camera file carries a different microphone on each channel, and
    // the average buries any single one under the other three — so a lav recorder
    // correlates weakly with the mix but almost perfectly with the channel that
    // recorded the same mic. Pass null/undefined for the averaged mix.
    function pekToEnvelope(buffer, info, targetRate, startSec, durSec, channel) {
        buffer = bytesReader(buffer);
        var single = (typeof channel === "number" && channel >= 0 && channel < info.channels);
        var firstChan = single ? channel : 0;
        var lastChan = single ? channel + 1 : info.channels;
        var chanCount = lastChan - firstChan;
        var startBlock = Math.max(0, Math.floor((startSec || 0) * info.blockRate));
        var endBlock = (durSec === null || durSec === undefined)
            ? info.blocks
            : Math.min(info.blocks, Math.ceil(((startSec || 0) + durSec) * info.blockRate));
        var span = endBlock - startBlock;
        if (span < 1) return new Float32Array(0);

        var frames = Math.floor(span * targetRate / info.blockRate);
        var env = new Float32Array(frames);
        for (var f = 0; f < frames; f += 1) {
            var b0 = startBlock + Math.floor(f * info.blockRate / targetRate);
            var b1 = Math.max(b0 + 1, startBlock + Math.floor((f + 1) * info.blockRate / targetRate));
            if (b1 > endBlock) b1 = endBlock;
            var sum = 0;
            for (var b = b0; b < b1; b += 1) {
                for (var c = firstChan; c < lastChan; c += 1) {
                    var base = PEK_HEADER_BYTES + ((c * info.blocks) + b) * 4;
                    var hi = buffer.readInt16LE(base);
                    var lo = buffer.readInt16LE(base + 2);
                    sum += (hi >= lo ? hi - lo : lo - hi) / 2;
                }
            }
            env[f] = sum / ((b1 - b0) * chanCount);
        }
        return env;
    }

    // ─── HTML escaping ────────────────────────────────────────────────────────
    // Sequence names, clip names and file paths are user-controlled and get
    // interpolated into innerHTML in the panel — escape them so a name like
    // "<b>Day 1" can't break (or script) the UI.
    function escapeHtml(value) {
        return String(value === null || value === undefined ? "" : value)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    // ─── Display formatting ───────────────────────────────────────────────────
    function formatDuration(ms) {
        var totalSec = Math.round(ms / 1000);
        var h = Math.floor(totalSec / 3600);
        var m = Math.floor((totalSec % 3600) / 60);
        var s = totalSec % 60;
        if (h > 0) return h + "h " + m + "m " + s + "s";
        if (m > 0) return m + "m " + s + "s";
        return s + "s";
    }

    function formatTime(ms) {
        var d = new Date(ms);
        return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    }

    function formatDate(ms) {
        var d = new Date(ms);
        return d.toLocaleDateString([], { month: "short", day: "numeric" }) +
            " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    }

    function formatSignedSeconds(seconds) {
        var rounded = Math.round(seconds * 1000) / 1000;
        return (rounded >= 0 ? "+" : "") + rounded + "s";
    }

    function formatRange(startSec, durationSec) {
        var endSec = startSec + durationSec;
        return startSec.toFixed(2) + "s-" + endSec.toFixed(2) + "s (" + durationSec.toFixed(2) + "s)";
    }

    function describeAnchor(anchor) {
        return anchor.clipName + " [" + anchor.trackType.toUpperCase() + " " +
            (anchor.trackIndex + 1) + ", t=" + anchor.startSec.toFixed(2) +
            "s, startTicks=" + anchor.startTicks + "]";
    }

    // ─── Timecode ─────────────────────────────────────────────────────────────
    // Parse an SMPTE timecode ("HH:MM:SS:FF", or drop-frame "HH:MM:SS;FF") into
    // seconds from midnight. The frame field is converted with `fps`; drop-frame is
    // treated as non-drop, a sub-second approximation that's fine because the coarse
    // pass only uses this as a search PREDICTION that audio then confirms. Returns
    // null for anything unparseable so callers can fall back to other signals.
    function parseTimecodeToSeconds(tc, fps) {
        if (typeof tc !== "string") return null;
        var m = tc.match(/^(\d{1,2}):([0-5]?\d):([0-5]?\d)[:;](\d{1,3})$/);
        if (!m) return null;
        var rate = (fps && fps > 0) ? fps : 25;
        var frames = parseInt(m[4], 10);
        if (frames >= Math.round(rate) && rate >= 1) frames = Math.round(rate) - 1; // clamp a stray frame index
        return (parseInt(m[1], 10) * 3600) +
            (parseInt(m[2], 10) * 60) +
            parseInt(m[3], 10) +
            (frames / rate);
    }

    // ─── Coarse search planning + selection (pure; host supplies the matcher) ──
    // The whole-track coarse align is just arithmetic over slide-match candidates,
    // but it lives behind the decoder in main.js where it can't be unit-tested.
    // These pure helpers carry all of the bug-prone window math and selection
    // policy so they CAN be tested; main.js only owns the async decode loop.
    //
    // geom: { refInPointSec, refDurationFull, refResolvedStartSec, targetInPointSec,
    //         targetResolvedStartSec, targetAvailSec, tcDelta }
    // cfg:  { minOverlapSec, targetMaxSec, tcConfirmSec, predictMarginSec, headSec,
    //         minScore, strongScore, confirmNearSec, learnedMarginSec }

    // Ordered list of coarse search windows for one reference/target pair, cheapest
    // and most-reliable first. Each plan: { label, winStart, winDur, probeDur,
    // predicts, predictedDeltaSec }. `predicts` plans are centered on a metadata/TC
    // prediction (trusted even when weak); head/full scan blind (acted on only when
    // strong). predictedDeltaSec is the whole-track delta the plan EXPECTS, so a
    // match can be judged "near its prediction" relative to that plan's own claim
    // (a timecode prediction may legitimately disagree with the timestamps).
    function planCoarseSearch(geom, cfg) {
        var refMinSrc = geom.refInPointSec;
        var refMaxSrc = geom.refInPointSec + geom.refDurationFull;
        var probeShort = Math.min(geom.targetAvailSec, cfg.targetMaxSec);

        var plans = [];
        var seen = {};
        function addPlan(label, start, dur, probeDur, predicts, predictedDeltaSec) {
            var s = Math.max(refMinSrc, start);
            var e = Math.min(refMaxSrc, start + dur);
            var winDur = e - s;
            if (winDur < cfg.minOverlapSec) return;
            var key = Math.round(s) + "|" + Math.round(winDur) + "|" + Math.round(probeDur);
            if (seen[key]) return;                   // don't re-decode an identical window/probe
            seen[key] = true;
            plans.push({
                label: label, winStart: s, winDur: winDur, probeDur: probeDur,
                predicts: predicts, predictedDeltaSec: predictedDeltaSec || 0
            });
        }

        if (geom.tcDelta !== null && geom.tcDelta !== undefined) {
            var predRefSrc = geom.targetInPointSec + geom.tcDelta;
            var tcPredictedDelta = geom.refResolvedStartSec +
                (predRefSrc - geom.refInPointSec) - geom.targetResolvedStartSec;
            addPlan("timecode", predRefSrc - cfg.tcConfirmSec, probeShort + (2 * cfg.tcConfirmSec), probeShort, true, tcPredictedDelta);
        }
        var predTs = geom.refInPointSec + (geom.targetResolvedStartSec - geom.refResolvedStartSec);
        addPlan("timestamp", predTs - cfg.predictMarginSec, probeShort + (2 * cfg.predictMarginSec), probeShort, true, 0);
        // Head: first headSec of each file, matched symmetrically (long target probe)
        // so a camera that started before OR after the reference is found.
        addPlan("head", refMinSrc, cfg.headSec, Math.min(geom.targetAvailSec, cfg.headSec), false);
        addPlan("full", refMinSrc, geom.refDurationFull, probeShort, false);
        return plans;
    }

    // ─── Probe window selection ───────────────────────────────────────────────
    // Choose WHERE in a clip to take the coarse probe. Probing the head of the
    // clip — the old behaviour — fails badly on recorders that were started early
    // and left running: the first minutes are room tone, and a flat probe has no
    // structure to match on, so the correlation locks onto whichever quiet stretch
    // of the reference best fits its noise floor. That produces a high-scoring
    // match at an arbitrary offset (observed: 0.85 landing ~3 minutes out).
    //
    // Instead, rank every candidate window by its mean frame-to-frame ACTIVITY —
    // the average absolute change between neighbouring envelope frames. Speech and
    // music change constantly, so activity stays high across the whole window;
    // room tone barely moves and scores near zero.
    //
    // Activity is used in preference to plain variance because variance peaks on a
    // window that merely STRADDLES the silence→content boundary: one enormous step
    // maximises the spread while half the probe is still useless. A single step
    // contributes almost nothing to a mean over ~1200 frames, so activity picks a
    // window that is dynamic throughout.
    //
    // `envelope` is a mean-amplitude envelope at `envelopeRate` Hz. Returns
    // [{ offsetSec, activity }], non-overlapping and best first, so callers can
    // take [0] to probe and [1] as an independent confirmation point. Empty when
    // the envelope is shorter than one window. Linear in the envelope length.
    function pickProbeWindows(envelope, envelopeRate, probeDurSec, count) {
        var n = envelope.length;
        if (n < 2) return [];
        // Callers routinely ask for a probe as long as the clip itself (probeDur
        // is min(clipLength, targetMaxSec)), which put this on a knife edge: one
        // sample of rounding in the envelope and the answer was "no window at
        // all", silently disabling the relay retry and the confirmation pass for
        // every clip shorter than the probe. A clip shorter than the request
        // simply means the window IS the clip.
        var w = Math.max(2, Math.min(n, Math.round(probeDurSec * envelopeRate)));
        count = count || 1;

        var act = new Float64Array(n - 1);
        for (var i = 0; i < n - 1; i += 1) {
            act[i] = Math.abs(envelope[i + 1] - envelope[i]);
        }

        var lastStart = n - w;
        var span = w - 1; // activity samples that fall inside one window
        var scores = new Float64Array(lastStart + 1);
        var sum = 0;
        for (var j = 0; j < span; j += 1) sum += act[j];
        scores[0] = sum / span;
        for (var s = 1; s <= lastStart; s += 1) {
            sum += act[s + span - 1] - act[s - 1];
            scores[s] = sum / span;
        }

        // Greedily take the most active windows that don't overlap each other.
        var picked = [];
        var taken = [];
        for (var k = 0; k < count; k += 1) {
            var bestIdx = -1;
            var bestScore = -1;
            for (var c = 0; c <= lastStart; c += 1) {
                if (scores[c] <= bestScore) continue;
                var clash = false;
                for (var t = 0; t < taken.length; t += 1) {
                    if (Math.abs(c - taken[t]) < w) { clash = true; break; }
                }
                if (clash) continue;
                bestScore = scores[c];
                bestIdx = c;
            }
            if (bestIdx < 0) break;
            taken.push(bestIdx);
            picked.push({ offsetSec: bestIdx / envelopeRate, activity: bestScore });
        }
        return picked;
    }

    // Best window per equal SEGMENT of the clip, sorted most-active first. The
    // single most-active window can sit in a stretch no other device recorded —
    // a recorder started 20 minutes before the cameras has its loudest audio
    // while nothing else was rolling, and a probe from there can never match
    // anything. Spreading candidate windows across the whole recording lets a
    // retry escape such a region. Falls back to the plain top-N pick when the
    // clip is too short to segment.
    function pickProbeWindowsSpread(envelope, envelopeRate, probeDurSec, segments) {
        var n = envelope.length;
        if (n < 2) return [];
        var w = Math.max(2, Math.min(n, Math.round(probeDurSec * envelopeRate)));
        segments = Math.max(1, segments || 4);
        var segLen = Math.floor(n / segments);
        if (segLen < w) return pickProbeWindows(envelope, envelopeRate, probeDurSec, segments);

        var picked = [];
        for (var s = 0; s < segments; s += 1) {
            var start = s * segLen;
            var end = (s === segments - 1) ? n : (start + segLen);
            var seg = Array.prototype.slice.call(envelope, start, end);
            var best = pickProbeWindows(seg, envelopeRate, probeDurSec, 1)[0];
            if (best) picked.push({ offsetSec: best.offsetSec + (start / envelopeRate), activity: best.activity });
        }
        picked.sort(function (a, b) { return b.activity - a.activity; });
        return picked;
    }

    // Does this envelope carry anything a correlation could lock onto?
    //
    // slideMatch scores by Pearson correlation, whose denominator is the product
    // of the two signals' energies about their means. A FLAT envelope — digital
    // silence, or a clip whose audio never varies — has zero energy, so every
    // lag divides by zero and the whole comparison returns null rather than a
    // low score. That is why a silent clip reports "best score n/a" instead of
    // "weak match": there is no number to report. Checking for it up front lets
    // the caller pick a different clip instead of spending a full staged search
    // proving that silence matches nothing.
    //
    // The threshold is deliberately almost zero: quiet audio is still audio, and
    // rejecting it would be worse than letting the score thresholds judge it.
    // Only a genuinely constant signal is called unusable.
    var ENVELOPE_FLAT_EPSILON = 1e-6;

    function envelopeActivity(envelope) {
        var n = envelope ? envelope.length : 0;
        if (!n) return { mean: 0, stdDev: 0, usable: false };
        var sum = 0, i;
        for (i = 0; i < n; i += 1) sum += envelope[i];
        var mean = sum / n;
        var acc = 0;
        for (i = 0; i < n; i += 1) {
            var d = envelope[i] - mean;
            acc += d * d;
        }
        var stdDev = Math.sqrt(acc / n);
        return { mean: mean, stdDev: stdDev, usable: stdDev > ENVELOPE_FLAT_EPSILON };
    }

    // Fallback half-width for the confirmation search when cfg omits it, so a
    // partial config can never silently produce NaN window bounds.
    var COARSE_VERIFY_MARGIN_DEFAULT_SEC = 120;

    // Plan the confirmation window for an already-chosen coarse offset, using a
    // SECOND probe taken from a different part of the same recording. A peak
    // driven by silence or room tone won't reproduce the same offset elsewhere in
    // the file; a genuine alignment will. `probe2RelSec` is the second probe's
    // position relative to geom's probe origin (geom.targetInPointSec), and may
    // be negative when the better window sits earlier. Returns { winStart, winDur,
    // expectedLagSec } — the reference window to search and the lag a correct
    // offset should produce — or null when the reference doesn't reach that far.
    function planCoarseVerify(geom, cfg, coarseDeltaSec, probe2RelSec, probe2DurSec) {
        var timelinePos = geom.targetResolvedStartSec + coarseDeltaSec + probe2RelSec;
        var refSrc = geom.refInPointSec + (timelinePos - geom.refResolvedStartSec);
        var refMin = geom.refInPointSec;
        var refMax = geom.refInPointSec + geom.refDurationFull;
        var margin = (cfg && cfg.verifyMarginSec) || COARSE_VERIFY_MARGIN_DEFAULT_SEC;

        var start = Math.max(refMin, refSrc - margin);
        var end = Math.min(refMax, refSrc + probe2DurSec + margin);
        if (end - start < probe2DurSec) return null; // not enough reference there
        return { winStart: start, winDur: end - start, expectedLagSec: refSrc - start };
    }

    // Plan a bounded confirm window around an offset LEARNED from another track.
    // Devices from one shoot usually share the same clock-error family (in a real
    // log, two cameras' true offsets were -641.8s and -619.7s — 22s apart), so once
    // one track has found its offset confidently, the others should look there
    // before paying for a blind head/full scan. Returns one plan (same shape as
    // planCoarseSearch's) or null when the predicted spot falls outside the
    // reference.
    function planLearnedSearch(geom, cfg, learnedDeltaSec) {
        var refMinSrc = geom.refInPointSec;
        var refMaxSrc = geom.refInPointSec + geom.refDurationFull;
        var probeShort = Math.min(geom.targetAvailSec, cfg.targetMaxSec);

        // Where the target's in-point would sit in the reference source if this
        // track shared the learned offset (inverse of coarseResolve's mapping).
        var predRefSrc = geom.refInPointSec +
            ((geom.targetResolvedStartSec + learnedDeltaSec) - geom.refResolvedStartSec);

        var start = Math.max(refMinSrc, predRefSrc - cfg.learnedMarginSec);
        var end = Math.min(refMaxSrc, predRefSrc + probeShort + cfg.learnedMarginSec);
        var winDur = end - start;
        if (winDur < cfg.minOverlapSec) return null;

        return {
            label: "learned", winStart: start, winDur: winDur, probeDur: probeShort,
            predicts: true, predictedDeltaSec: learnedDeltaSec
        };
    }

    function createCoarseState() {
        return { best: null, near: null, skipFull: false };
    }

    // Fold one plan's slide-match candidate ({score, lagSec} | null) into `state`.
    // Returns true when the search should stop early (a strong match was found).
    // Sets state.skipFull when a prediction is confirmed near ITS OWN expected
    // delta (plan.predictedDeltaSec) — a timecode or learned-offset prediction can
    // legitimately sit far from the timestamp position and still be confirmed.
    function coarseConsider(state, plan, candidate, geom, cfg) {
        if (!candidate) return false;
        var entry = { score: candidate.score, lagSec: candidate.lagSec, winStart: plan.winStart, label: plan.label };
        if (!state.best || entry.score > state.best.score) state.best = entry;
        if (plan.predicts && (!state.near || entry.score > state.near.score)) state.near = entry;
        if (entry.score >= cfg.strongScore) return true;       // strong — trust it, stop searching
        if (plan.predicts && entry.score >= cfg.minScore) {
            var impliedDelta = geom.refResolvedStartSec +
                (plan.winStart + candidate.lagSec - geom.refInPointSec) - geom.targetResolvedStartSec;
            var predicted = plan.predictedDeltaSec || 0;
            if (Math.abs(impliedDelta - predicted) <= cfg.confirmNearSec) state.skipFull = true;
        }
        return false;
    }

    // Resolve the final coarse decision. A strong match anywhere overrides the
    // metadata; else trust the best prediction-aligned match; else nothing. Returns
    // { chosen, best, coarseDelta } — chosen/coarseDelta null when nothing confident.
    function coarseResolve(state, geom, cfg) {
        var chosen = null;
        if (state.best && state.best.score >= cfg.strongScore) chosen = state.best;
        else if (state.near && state.near.score >= cfg.minScore) chosen = state.near;

        var coarseDelta = null;
        if (chosen) {
            var matchedRefSrc = chosen.winStart + chosen.lagSec;
            var desiredTargetStart = geom.refResolvedStartSec + (matchedRefSrc - geom.refInPointSec);
            coarseDelta = Math.round((desiredTargetStart - geom.targetResolvedStartSec) * 1000) / 1000;
        }
        return { chosen: chosen, best: state.best, coarseDelta: coarseDelta };
    }

    // Resolve a whole track's search across SEVERAL reference candidates, keeping
    // the most confident one. A track is matched against every clip on the
    // reference track, not just the longest: when a recording belongs to a
    // different session than the longest reference clip (a second recorder that
    // ran only in the afternoon vs. a morning reference), that one comparison has
    // no correct answer available and settles on the best noise peak. Scoring each
    // candidate independently lets the right session win on audio content.
    //
    // `cands` is [{ state, geom }] in candidate order. Returns { index, result,
    // best } — index -1 and result null when no candidate reached a confident
    // match; `best` is the highest score seen anywhere, for the failure message.
    function coarseResolveBest(cands, cfg) {
        var winner = null;
        var winnerIndex = -1;
        var best = null;
        for (var i = 0; i < cands.length; i += 1) {
            var r = coarseResolve(cands[i].state, cands[i].geom, cfg);
            if (r.best && (!best || r.best.score > best.score)) best = r.best;
            if (r.chosen && (!winner || r.chosen.score > winner.chosen.score)) {
                winner = r;
                winnerIndex = i;
            }
        }
        return { index: winnerIndex, result: winner, best: best };
    }

    // How far apart two windows' measured lags may sit before they are describing
    // different alignments rather than the same one seen twice. Grows with the
    // span between them, because honest clock drift does too.
    // Compare two semantic versions. Accepts a leading "v" (GitHub tags carry
    // one) and ignores any pre-release/build suffix. Returns >0 when `a` is
    // newer than `b`, <0 when older, 0 when the same — and null when either is
    // unparseable, so a malformed tag can never be read as "an update exists".
    // ─── Are these timestamps recording times at all? ─────────────────────────
    // A timestamp being CONSISTENT across files does not make it a recording
    // time. Anything that processes a whole shoot in one batch stamps every
    // output within the same few minutes, and the result looks beautifully
    // self-consistent while describing when the batch ran:
    //
    //   * files downloaded from Google Drive / Dropbox / a transfer service —
    //     the OS sets the filesystem date to the download, which is what the
    //     `mtime` fallback reads;
    //   * a batch transcode or proxy render — HandBrake, Compressor, Media
    //     Encoder and Drive's own conversion all write a fresh `creation_time`
    //     into the container, so even an embedded source can be a lie;
    //   * a camera whose clock was never set — every file claims the same
    //     factory date.
    //
    // There is one thing none of those can fake: ONE DEVICE CANNOT RECORD TWO
    // FILES AT THE SAME TIME. Real recordings from a single source are
    // sequential, so their [start, start+duration) intervals never overlap. A
    // batch stamp squeezes every file onto the same instant, so they overlap
    // almost completely. That is the test, and it needs no cross-device
    // assumption — which matters, because genuine multicam footage DOES have
    // every camera starting within seconds of every other, and any check built
    // on "these all start too close together" would throw exactly that away.
    //
    // Tolerance is deliberately loose: container timestamps are often only
    // second-resolution, so two back-to-back takes can round into a small
    // overlap. Only overlap beyond that is evidence.
    //
    // Returns { tracks, implausible, bulkCopy }:
    //   tracks     — [{ trackKey, clipCount, footageSec, spanSec, overlapSec,
    //                  plausible, reason }]
    //   implausible— the track keys whose timestamps cannot be recording times
    //   bulkCopy   — set when the mtime-derived files' file dates cluster into a
    //                window far too short to have been recorded in, i.e. the
    //                dates were all set by one copy or download
    var TIMING_OVERLAP_TOL_SEC = 2;      // absolute slack for second-resolution stamps
    var TIMING_OVERLAP_TOL_FRACTION = 0.01;  // plus 1% of the track's footage
    var BULK_COPY_MAX_WINDOW_SEC = 120;  // file dates this tightly clustered…
    var BULK_COPY_MIN_RATIO = 10;        // …against this much more footage
    var BULK_COPY_MIN_FILES = 3;

    function assessTimingPlausibility(files, opts) {
        opts = opts || {};
        var tolSec = (opts.overlapToleranceSec === undefined || opts.overlapToleranceSec === null)
            ? TIMING_OVERLAP_TOL_SEC : opts.overlapToleranceSec;
        var out = { tracks: [], implausible: [], bulkCopy: null };

        var byKey = {}, order = [], i;
        for (i = 0; i < (files || []).length; i += 1) {
            var f = files[i];
            if (!isFinite(f.recordStartMs)) continue;
            var key = f.trackType + "_" + f.trackIndex;
            if (!Object.prototype.hasOwnProperty.call(byKey, key)) {
                byKey[key] = { trackKey: key, intervals: [] };
                order.push(key);
            }
            byKey[key].intervals.push({
                startMs: f.recordStartMs,
                endMs: f.recordStartMs + (f.durationSec || 0) * 1000
            });
        }

        for (var o = 0; o < order.length; o += 1) {
            var t = byKey[order[o]];
            var list = t.intervals.slice().sort(function (a, b) { return a.startMs - b.startMs; });
            var footageMs = 0, unionMs = 0;
            var runStart = null, runEnd = null;
            for (i = 0; i < list.length; i += 1) {
                footageMs += Math.max(0, list[i].endMs - list[i].startMs);
                if (runEnd === null || list[i].startMs > runEnd) {
                    if (runEnd !== null) unionMs += runEnd - runStart;
                    runStart = list[i].startMs;
                    runEnd = list[i].endMs;
                } else if (list[i].endMs > runEnd) {
                    runEnd = list[i].endMs;
                }
            }
            if (runEnd !== null) unionMs += runEnd - runStart;

            var footageSec = footageMs / 1000;
            var overlapSec = Math.max(0, (footageMs - unionMs) / 1000);
            var allowed = Math.max(tolSec, footageSec * TIMING_OVERLAP_TOL_FRACTION);
            var plausible = list.length < 2 || overlapSec <= allowed;
            var entry = {
                trackKey: t.trackKey, clipCount: list.length,
                footageSec: footageSec,
                spanSec: (list[list.length - 1].endMs - list[0].startMs) / 1000,
                overlapSec: Math.round(overlapSec * 1000) / 1000,
                plausible: plausible,
                reason: plausible ? null
                    : "its clips claim to have been recorded at overlapping times, which one device cannot do — " +
                      "these look like the times a batch copy, download or transcode ran, not recording times"
            };
            out.tracks.push(entry);
            if (!plausible) out.implausible.push(t.trackKey);
        }

        // ── Bulk copy of the FILE dates ──────────────────────────────────────
        // For an mtime-derived file, recordStart = mtime − duration, so its END
        // is exactly the mtime. If those ends bunch into a window far shorter
        // than the footage they represent, one copy or download wrote them all.
        var ends = [], footage = 0;
        for (i = 0; i < (files || []).length; i += 1) {
            if (isEmbeddedTimingSource(files[i].timingSource)) continue;
            if (!isFinite(files[i].recordStartMs)) continue;
            ends.push(files[i].recordStartMs + (files[i].durationSec || 0) * 1000);
            footage += (files[i].durationSec || 0);
        }
        if (ends.length >= BULK_COPY_MIN_FILES) {
            ends.sort(function (a, b) { return a - b; });
            var windowSec = (ends[ends.length - 1] - ends[0]) / 1000;
            if (windowSec <= BULK_COPY_MAX_WINDOW_SEC &&
                footage > Math.max(windowSec, 1) * BULK_COPY_MIN_RATIO) {
                out.bulkCopy = {
                    count: ends.length,
                    windowSec: Math.round(windowSec * 10) / 10,
                    footageSec: Math.round(footage)
                };
            }
        }

        return out;
    }

    // ─── Build layout: which tracks can trust each other's clocks ─────────────
    // Every track used to anchor to its OWN earliest recording, so every track
    // started at 0:00 and the audio coarse pass had to rediscover the
    // minute-scale offsets between devices from nothing. That is the right
    // choice when a device's clock is wrong — a camera reset to 2000-01-01
    // would otherwise be placed years from everything else — but it throws away
    // good information when the clocks are right, which is most of the time.
    //
    // So: tracks whose recordings CORROBORATE each other share one anchor and
    // are laid out at their true relative clock positions. Corroboration means
    // their clock spans overlap — two devices claiming to have been recording
    // at the same moment is evidence they agree about when the shoot was, and
    // no wrong clock produces that by accident. Tracks are grouped transitively,
    // so A overlapping B and B overlapping C puts all three together even if A
    // and C never ran at the same time.
    //
    // A track that corroborates nobody keeps its own anchor and starts at 0:00,
    // exactly as before. The fallback is therefore per-track, not all-or-
    // nothing: one camera with a dead clock battery no longer costs the other
    // four their layout.
    //
    // Files timed from the mtime fallback never join a group. That start is
    // "file date minus duration", which is wrong by however much the OS touched
    // the file on copy — not something to lay a timeline out on. Nor does a
    // track whose own clips claim overlapping recording times, however
    // consistent they look: see assessTimingPlausibility.
    //
    // `files`: [{ filePath, trackType, trackIndex, recordStartMs, durationSec,
    //             timingSource }]
    // Returns { anchorMsByTrack, groups, ungrouped, tracks, spanSec }:
    //   anchorMsByTrack — trackKey -> the clock time that track's 0:00 means
    //   groups          — [{ trackKeys, anchorMs, spanSec }] for the log
    //   ungrouped       — [{ trackKey, reason }] tracks left anchoring to
    //                     themselves, with why
    function planBuildAnchors(files, opts) {
        opts = opts || {};
        var maxSpanSec = (opts.maxSpanSec === undefined || opts.maxSpanSec === null)
            ? MAX_SPAN_SEC : opts.maxSpanSec;
        var timing = assessTimingPlausibility(files, opts);
        var implausible = {};
        for (var q = 0; q < timing.implausible.length; q += 1) implausible[timing.implausible[q]] = true;
        var out = { anchorMsByTrack: {}, groups: [], ungrouped: [], tracks: [], spanSec: 0, timing: timing };

        // ── Per-track clock span ─────────────────────────────────────────────
        var byKey = {};
        var order = [];
        for (var i = 0; i < (files || []).length; i += 1) {
            var f = files[i];
            if (!isFinite(f.recordStartMs)) continue;
            var key = f.trackType + "_" + f.trackIndex;
            var endMs = f.recordStartMs + (f.durationSec || 0) * 1000;
            if (!Object.prototype.hasOwnProperty.call(byKey, key)) {
                byKey[key] = {
                    trackKey: key, startMs: f.recordStartMs, endMs: endMs,
                    embedded: true, count: 0
                };
                order.push(key);
            }
            var t = byKey[key];
            if (f.recordStartMs < t.startMs) t.startMs = f.recordStartMs;
            if (endMs > t.endMs) t.endMs = endMs;
            if (!isEmbeddedTimingSource(f.timingSource)) t.embedded = false;
            t.count += 1;
        }
        for (var o = 0; o < order.length; o += 1) out.tracks.push(byKey[order[o]]);
        if (!out.tracks.length) return out;

        var lo = Infinity, hi = -Infinity;
        for (var g = 0; g < out.tracks.length; g += 1) {
            if (out.tracks[g].startMs < lo) lo = out.tracks[g].startMs;
            if (out.tracks[g].endMs > hi) hi = out.tracks[g].endMs;
        }
        out.spanSec = (hi - lo) / 1000;

        // Default for everyone: anchor to yourself, i.e. today's behaviour.
        for (var d = 0; d < out.tracks.length; d += 1) {
            out.anchorMsByTrack[out.tracks[d].trackKey] = out.tracks[d].startMs;
        }
        if (out.tracks.length < 2) {
            if (out.tracks.length) out.ungrouped.push({ trackKey: out.tracks[0].trackKey, reason: "it is the only track" });
            return out;
        }

        // ── Group the tracks whose spans overlap ─────────────────────────────
        var eligible = [];
        for (var e = 0; e < out.tracks.length; e += 1) {
            var cand = out.tracks[e];
            if (Object.prototype.hasOwnProperty.call(implausible, cand.trackKey)) {
                out.ungrouped.push({
                    trackKey: cand.trackKey,
                    reason: "its clips claim overlapping recording times, so these are batch-processing " +
                            "timestamps (a bulk download or transcode), not recording times"
                });
            } else if (cand.embedded) {
                eligible.push(cand);
            } else {
                out.ungrouped.push({
                    trackKey: cand.trackKey,
                    reason: "its start times come from the file date, which is not a recording time"
                });
            }
        }
        eligible.sort(function (a, b) { return a.startMs - b.startMs; });

        // Sorted by start, a run of overlapping spans is contiguous: each track
        // either reaches the running end of the current group or begins a new one.
        var runs = [];
        var run = null;
        for (var r = 0; r < eligible.length; r += 1) {
            var track = eligible[r];
            if (run && track.startMs < run.endMs) {
                run.members.push(track);
                if (track.endMs > run.endMs) run.endMs = track.endMs;
            } else {
                run = { members: [track], startMs: track.startMs, endMs: track.endMs };
                runs.push(run);
            }
        }

        for (var k = 0; k < runs.length; k += 1) {
            var members = runs[k].members;
            if (members.length < 2) {
                if (members.length) {
                    out.ungrouped.push({
                        trackKey: members[0].trackKey,
                        reason: "no other track was recording at the same time, so nothing corroborates its clock"
                    });
                }
                continue;
            }
            var spanSec = (runs[k].endMs - runs[k].startMs) / 1000;
            if (spanSec > maxSpanSec) {
                // Laying these out by the clock would not fit a Premiere
                // timeline, so they keep their own anchors.
                for (var m = 0; m < members.length; m += 1) {
                    out.ungrouped.push({
                        trackKey: members[m].trackKey,
                        reason: "the group spans " + Math.round(spanSec / 3600) + "h, beyond a timeline's 24-hour maximum"
                    });
                }
                continue;
            }
            var keys = [];
            for (var n = 0; n < members.length; n += 1) {
                keys.push(members[n].trackKey);
                out.anchorMsByTrack[members[n].trackKey] = runs[k].startMs;
            }
            out.groups.push({ trackKeys: keys, anchorMs: runs[k].startMs, spanSec: spanSec });
        }

        return out;
    }

    // A start time read out of the media itself, as opposed to derived from the
    // file's date on disk. Only these are real recording times.
    function isEmbeddedTimingSource(timingSource) {
        return timingSource === "creation_time" || timingSource === "modification_date";
    }

    function compareVersions(a, b) {
        function parts(v) {
            var m = /^\s*v?(\d+)\.(\d+)\.(\d+)/.exec(String(v === null || v === undefined ? "" : v));
            return m ? [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)] : null;
        }
        var pa = parts(a), pb = parts(b);
        if (!pa || !pb) return null;
        for (var i = 0; i < 3; i += 1) {
            if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
        }
        return 0;
    }

    function twoPointTolerance(spanSec) {
        return FINE_TUNE_AGREE_BASE_TOL_SEC +
            Math.abs(spanSec || 0) * (DRIFT_IMPLAUSIBLE_PPM / 1e6);
    }

    // Gate a fine-pass match on two windows agreeing. `early` and `late` are
    // findBestLag results (or null when that window had nothing to measure) taken
    // from opposite ends of the overlap, `spanSec` the distance between them.
    // Returns { verdict, disagreeSec, tolSec }:
    //   "agree"        — both measured and they line up: trust the match
    //   "disagree"     — both measured and they do not: the correlation found
    //                    something other than shared audio, so drop the match
    //   "inconclusive" — one or both windows had no usable signal (a quiet
    //                    passage); no evidence either way, so do not block
    function judgeTwoPointAgreement(early, late, spanSec, minScore) {
        var floor = (minScore === undefined || minScore === null) ? FINE_TUNE_MIN_SCORE : minScore;
        var tol = twoPointTolerance(spanSec);
        if (!early || !late || early.atRail || late.atRail ||
            early.score < floor || late.score < floor) {
            return { verdict: "inconclusive", disagreeSec: null, tolSec: tol };
        }
        var gap = Math.abs(late.lagSec - early.lagSec);
        return {
            verdict: gap <= tol ? "agree" : "disagree",
            disagreeSec: gap,
            tolSec: tol
        };
    }

    // ─── Cross-clip corroboration ─────────────────────────────────────────────
    // The coarse pass matches ONE clip per track and then shifts every clip on
    // that track by what it found. That is a track-wide claim resting on a single
    // comparison: if the one clip it chose matched the wrong part of the
    // reference, the whole track goes to the wrong place, confidently. Checking
    // the same offset against OTHER clips on the track is the test that claim
    // deserves — a real offset holds for every recording the device made, a
    // spurious one almost never does.
    //
    // `points` is one entry per sibling clip actually compared:
    //   { clipName, agreed: true|false|null, impliedDeltaSec, score, reason }
    // `agreed` is null when the sibling could not be compared at all (no overlap
    // with the reference, no usable audio) — that is absence of evidence, not
    // evidence against. Returns { verdict, agreed, disagreed, adoptedDeltaSec,
    // note }:
    //   "confirmed"    — at least one sibling agrees and they outnumber dissent
    //   "inconclusive" — nothing could be compared; the caller proceeds unconfirmed
    //   "adopt"        — the dissenters agree with EACH OTHER on a different
    //                    offset: that is the stronger match, so take theirs
    //   "rejected"     — dissent without a consensus to replace it; the offset
    //                    is not trustworthy and the track is left to the fine pass
    function judgeCorroboration(points, tolSec) {
        var tol = (tolSec === undefined || tolSec === null) ? COARSE_CORROBORATE_TOL_SEC : tolSec;
        var agreed = [], disagreed = [];
        for (var i = 0; i < (points || []).length; i += 1) {
            if (points[i].agreed === true) agreed.push(points[i]);
            else if (points[i].agreed === false) disagreed.push(points[i]);
        }
        if (!agreed.length && !disagreed.length) {
            return { verdict: "inconclusive", agreed: agreed, disagreed: disagreed, adoptedDeltaSec: null, note: null };
        }
        if (agreed.length > disagreed.length) {
            return {
                verdict: "confirmed", agreed: agreed, disagreed: disagreed, adoptedDeltaSec: null,
                note: disagreed.length ? (disagreed.length + " clip(s) disagreed but were outnumbered") : null
            };
        }

        // Dissent at least matches assent. Do the dissenters tell the same story?
        var cluster = largestCluster(disagreed.map(function (d) { return d.impliedDeltaSec; }), tol);
        if (cluster && cluster.members.length >= 2) {
            return {
                verdict: "adopt", agreed: agreed, disagreed: disagreed,
                adoptedDeltaSec: cluster.centre,
                note: cluster.members.length + " clip(s) agreed on a different offset"
            };
        }
        return {
            verdict: "rejected", agreed: agreed, disagreed: disagreed, adoptedDeltaSec: null,
            note: "no consensus among the clips that disagreed"
        };
    }

    // Largest group of values lying within `tol` of one another, and its median.
    // Ties break toward the group whose members sit closest together. Returns
    // null for an empty list.
    function largestCluster(values, tol) {
        var vals = (values || []).filter(function (v) { return isFinite(v); }).slice().sort(function (a, b) { return a - b; });
        if (!vals.length) return null;
        var bestStart = 0, bestLen = 0, bestSpread = Infinity;
        for (var i = 0; i < vals.length; i += 1) {
            var j = i;
            while (j + 1 < vals.length && vals[j + 1] - vals[i] <= tol) j += 1;
            var len = j - i + 1;
            var spread = vals[j] - vals[i];
            if (len > bestLen || (len === bestLen && spread < bestSpread)) {
                bestStart = i; bestLen = len; bestSpread = spread;
            }
        }
        var members = vals.slice(bestStart, bestStart + bestLen);
        var mid = Math.floor(members.length / 2);
        var centre = (members.length % 2) ? members[mid] : (members[mid - 1] + members[mid]) / 2;
        return { members: members, centre: Math.round(centre * 1000) / 1000, spreadSec: bestSpread };
    }

    // ─── Fine-pass feedback ───────────────────────────────────────────────────
    // What the fine pass has to say about a track the coarse pass moved. Coarse
    // commits a whole track on one clip's evidence; the fine pass then looks at
    // every clip on it independently, so its results are the first honest audit
    // of that decision. Two things are worth acting on:
    //
    //   * several clips landing on the SAME residual shift — the coarse offset
    //     was systematically off by that much. The fine pass already corrects the
    //     clips it matched; the ones it could not match are still sitting at the
    //     wrong offset, and their track-mates' consensus is the best estimate
    //     available for them.
    //   * most of the track failing to match at all — the coarse offset probably
    //     put the track somewhere its audio does not belong.
    //
    // `rows` is one entry per clip on the track:
    //   { clipName, filePath, status, deltaSec, score, outOfRange }
    // where status is the fine pass's own ("shifted", "aligned", "weak",
    // "unmatched", "kept") and `outOfRange` marks a clip that never overlapped
    // the reference at all.
    //
    // That distinction is the difference between a warning and a false alarm. A
    // clip sitting outside the reference recording's span had no chance to
    // match, and a reference that simply does not cover the whole shoot leaves
    // plenty of them — counting those as failures made a perfectly good track
    // look broken. Only clips that HAD a reference to compare against and still
    // failed say anything about the coarse offset. Out-of-range clips are still
    // worth rescuing, though: they are on the same track, carrying the same
    // clock error, as the clips that did match.
    //
    // Returns { total, matched, failed, outOfRange, failedPaths,
    // consensusDeltaSec, consensusCount, suspect }.
    function summarizeTrackResiduals(rows, tolSec) {
        var tol = (tolSec === undefined || tolSec === null) ? COARSE_CORROBORATE_TOL_SEC : tolSec;
        var out = {
            total: 0, matched: 0, failed: 0, outOfRange: 0, failedPaths: [],
            consensusDeltaSec: null, consensusCount: 0, suspect: false
        };
        var deltas = [], byDelta = {};
        for (var i = 0; i < (rows || []).length; i += 1) {
            var r = rows[i];
            out.total += 1;
            if (r.status === "shifted" || r.status === "aligned") {
                out.matched += 1;
                var d = (r.status === "aligned") ? 0 : r.deltaSec;
                if (isFinite(d)) { deltas.push(d); byDelta[d] = r.clipName; }
            } else {
                out.failed += 1;
                if (r.outOfRange) out.outOfRange += 1;
                if (r.filePath) out.failedPaths.push(r.filePath);
            }
        }
        if (!out.total) return out;

        var cluster = largestCluster(deltas, tol);
        if (cluster && cluster.members.length >= 2) {
            out.consensusDeltaSec = cluster.centre;
            out.consensusCount = cluster.members.length;
        }
        // More of the track failed than matched, counting only the clips that
        // had a reference to fail against. One clip failing is ordinary; half a
        // track failing with the reference right there is the coarse offset
        // being wrong.
        var couldHaveMatched = out.total - out.outOfRange;
        var genuineFailures = out.failed - out.outOfRange;
        out.suspect = couldHaveMatched >= 2 && genuineFailures > out.matched;
        return out;
    }

    return {
        TICKS_PER_SECOND: TICKS_PER_SECOND,
        MAX_SPAN_SEC: MAX_SPAN_SEC,
        AUDIO_SAMPLE_RATE: AUDIO_SAMPLE_RATE,
        ENVELOPE_WINDOW_SAMPLES: ENVELOPE_WINDOW_SAMPLES,
        ENVELOPE_RATE: ENVELOPE_RATE,
        FINE_TUNE_MAX_SHIFT_SEC: FINE_TUNE_MAX_SHIFT_SEC,
        FINE_TUNE_MIN_OVERLAP_SEC: FINE_TUNE_MIN_OVERLAP_SEC,
        FINE_TUNE_MAX_COMPARE_SEC: FINE_TUNE_MAX_COMPARE_SEC,
        FINE_TUNE_MIN_SCORE: FINE_TUNE_MIN_SCORE,
        FINE_TUNE_MIN_APPLY_SEC: FINE_TUNE_MIN_APPLY_SEC,
        FINE_TUNE_WINDOW_POSITIONS: FINE_TUNE_WINDOW_POSITIONS,
        FINE_TUNE_DECENT_SCORE: FINE_TUNE_DECENT_SCORE,
        FINE_TUNE_AGREE_MIN_OVERLAP_SEC: FINE_TUNE_AGREE_MIN_OVERLAP_SEC,
        FINE_TUNE_AGREE_BASE_TOL_SEC: FINE_TUNE_AGREE_BASE_TOL_SEC,
        COARSE_MULTI_PROBE_MIN_SEC: COARSE_MULTI_PROBE_MIN_SEC,
        COARSE_CORROBORATE_TOL_SEC: COARSE_CORROBORATE_TOL_SEC,
        DRIFT_MIN_OVERLAP_SEC: DRIFT_MIN_OVERLAP_SEC,
        DRIFT_EDGE_FRACTION: DRIFT_EDGE_FRACTION,
        DRIFT_MIN_REPORT_SEC: DRIFT_MIN_REPORT_SEC,
        DRIFT_IMPLAUSIBLE_PPM: DRIFT_IMPLAUSIBLE_PPM,
        PEK_MAGIC: PEK_MAGIC,
        PEK_HEADER_BYTES: PEK_HEADER_BYTES,
        PEK_SAMPLES_PER_BLOCK: PEK_SAMPLES_PER_BLOCK,
        parsePekInfo: parsePekInfo,
        pekToEnvelope: pekToEnvelope,
        buildEnvelope: buildEnvelope,
        findBestLag: findBestLag,
        slideMatch: slideMatch,
        buildFineTuneAnchors: buildFineTuneAnchors,
        diffInstanceMovement: diffInstanceMovement,
        planTearRepair: planTearRepair,
        auditLinkAlignment: auditLinkAlignment,
        diffLinkAlignment: diffLinkAlignment,
        planLinkRepair: planLinkRepair,
        planLinkGroups: planLinkGroups,
        TEAR_REPAIR_MIN_SEC: TEAR_REPAIR_MIN_SEC,
        planReferenceLayer: planReferenceLayer,
        trackKeyLabel: trackKeyLabel,
        buildCompareWindow: buildCompareWindow,
        buildDriftProbe: buildDriftProbe,
        escapeHtml: escapeHtml,
        formatDuration: formatDuration,
        formatTime: formatTime,
        formatDate: formatDate,
        formatSignedSeconds: formatSignedSeconds,
        formatRange: formatRange,
        describeAnchor: describeAnchor,
        parseTimecodeToSeconds: parseTimecodeToSeconds,
        planCoarseSearch: planCoarseSearch,
        planLearnedSearch: planLearnedSearch,
        pickProbeWindows: pickProbeWindows,
        pickProbeWindowsSpread: pickProbeWindowsSpread,
        planCoarseVerify: planCoarseVerify,
        createCoarseState: createCoarseState,
        coarseConsider: coarseConsider,
        coarseResolve: coarseResolve,
        coarseResolveBest: coarseResolveBest,
        compareVersions: compareVersions,
        envelopeActivity: envelopeActivity,
        isEmbeddedTimingSource: isEmbeddedTimingSource,
        planBuildAnchors: planBuildAnchors,
        assessTimingPlausibility: assessTimingPlausibility,
        twoPointTolerance: twoPointTolerance,
        judgeTwoPointAgreement: judgeTwoPointAgreement,
        judgeCorroboration: judgeCorroboration,
        largestCluster: largestCluster,
        summarizeTrackResiduals: summarizeTrackResiduals
    };
});

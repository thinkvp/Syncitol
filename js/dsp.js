/**
 * Syncitol — dsp.js
 * Pure, host-independent core: audio-envelope DSP, waveform cross-correlation,
 * fine-tune anchor/window planning, and display formatting.
 *
 * Deliberately free of DOM, CEP, ffmpeg and Node-only state so it can be:
 *   - loaded as a plain <script> in the CEP panel (exposes its API on window),
 *   - require()'d directly by the unit tests under Node (module.exports).
 *
 * main.js consumes these as globals; tests consume them via require("./dsp").
 */

(function (root, factory) {
    var api = factory();
    var key;
    // In the CEP panel a `window` always exists. Note that with --enable-nodejs
    // + --mixed-context, Node's `module` is ALSO present in the page, so we must
    // publish globals whenever `window` exists rather than treating the presence
    // of `module` as "Node only" — otherwise main.js can't see these names.
    if (typeof window !== "undefined") {
        for (key in api) {              // CEP panel / browser: publish as globals
            if (Object.prototype.hasOwnProperty.call(api, key)) {
                window[key] = api[key];
            }
        }
    }
    if (typeof module !== "undefined" && module.exports) {
        module.exports = api;          // Node / node:test
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
    var FINE_TUNE_MAX_COMPARE_SEC = 20;
    var FINE_TUNE_MIN_SCORE = 0.2;
    var FINE_TUNE_MIN_APPLY_SEC = 0.02;
    var FINE_TUNE_WINDOW_POSITIONS = [0.5, 0.2, 0.8];
    var FINE_TUNE_DECENT_SCORE = 0.7;

    // ─── Envelope extraction ──────────────────────────────────────────────────
    // Aggregate signed 16-bit LE PCM into a mean-absolute-amplitude envelope,
    // one frame per `windowSamples` samples.
    function buildEnvelope(buffer, windowSamples) {
        windowSamples = windowSamples || ENVELOPE_WINDOW_SAMPLES;
        var sampleCount = Math.floor(buffer.length / 2);
        var frameCount = Math.floor(sampleCount / windowSamples);
        var envelope = new Float32Array(frameCount);

        for (var frame = 0; frame < frameCount; frame += 1) {
            var sum = 0;
            var frameByteOffset = frame * windowSamples * 2;
            for (var s = 0; s < windowSamples; s += 1) {
                var byteOffset = frameByteOffset + (s * 2);
                sum += Math.abs(buffer.readInt16LE(byteOffset));
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
    // Collapse timeline clip instances to one anchor per (filePath, startTicks),
    // then mark which track is the reference. The reference is the track with the
    // most total recorded coverage (typically the continuous main-camera/program
    // recording or a field-recorder WAV) — everything else is aligned to it. This
    // is chosen by content, NOT by track position, so it works no matter which
    // track the main recording sits on. Anchors get layerOrder 0 (reference) or
    // 1 (everything else); the coarse and fine passes align layer-1 clips to the
    // layer-0 reference.
    function buildFineTuneAnchors(clips) {
        var byKey = {};
        var order = [];

        for (var c = 0; c < clips.length; c += 1) {
            var clip = clips[c];
            if (!clip.filePath || !clip.startTicks) continue;
            var key = clip.filePath + "|" + clip.startTicks;

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

            // A clip may appear on both a video track and its linked audio track;
            // prefer the video instance so the anchor reflects the video track.
            var existing = byKey[key];
            if (clip.trackType === "video" && existing.trackType !== "video") {
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

        // Reference track = the track (type + index) with the most total coverage.
        var coverage = {};
        for (var a = 0; a < anchors.length; a += 1) {
            var an = anchors[a];
            var tk = an.trackType + "_" + an.trackIndex;
            coverage[tk] = (coverage[tk] || 0) + (an.endSec - an.startSec);
        }
        var refTrackKey = null;
        var refCoverage = -1;
        for (var tkey in coverage) {
            if (Object.prototype.hasOwnProperty.call(coverage, tkey) && coverage[tkey] > refCoverage) {
                refCoverage = coverage[tkey];
                refTrackKey = tkey;
            }
        }

        for (var b = 0; b < anchors.length; b += 1) {
            var isRef = (anchors[b].trackType + "_" + anchors[b].trackIndex) === refTrackKey;
            anchors[b].layerOrder = isRef ? 0 : 1;
            anchors[b].isReference = isRef;
        }

        return anchors.sort(function (a, b) {
            if (a.layerOrder !== b.layerOrder) return a.layerOrder - b.layerOrder;
            if (a.startSec !== b.startSec) return a.startSec - b.startSec;
            return a.clipName.localeCompare(b.clipName);
        });
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
        buildEnvelope: buildEnvelope,
        findBestLag: findBestLag,
        slideMatch: slideMatch,
        buildFineTuneAnchors: buildFineTuneAnchors,
        buildCompareWindow: buildCompareWindow,
        formatDuration: formatDuration,
        formatTime: formatTime,
        formatDate: formatDate,
        formatSignedSeconds: formatSignedSeconds,
        formatRange: formatRange,
        describeAnchor: describeAnchor
    };
});

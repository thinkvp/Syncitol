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
    // Audio window decoded per compare. The coarse pass lands tracks within a few
    // seconds, so the fine pass only refines a small residual — a 10s window keeps
    // ≥5s of overlap even at the ±5s search extreme (window − maxShift) while
    // halving the per-clip ffmpeg decode vs. the old 20s. Don't drop below
    // ~2×MAX_SHIFT or the extreme-lag overlap falls under MIN_OVERLAP.
    var FINE_TUNE_MAX_COMPARE_SEC = 10;
    var FINE_TUNE_MIN_SCORE = 0.2;
    var FINE_TUNE_MIN_APPLY_SEC = 0.02;
    // Window start positions (fraction of slack) tried in order until one scores
    // ≥ DECENT_SCORE. Two positions instead of three trims a third of the work on
    // weak-correlation footage where the short-circuit rarely fires.
    var FINE_TUNE_WINDOW_POSITIONS = [0.5, 0.2];
    var FINE_TUNE_DECENT_SCORE = 0.7;

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

    // Plan the two probe windows for a drift check on a reference/target pair:
    // one near the start of their overlap, one near the end. Returns null when
    // the overlap is too short for drift to be measurable (or matter). The
    // caller correlates each window (same shape as buildCompareWindow windows)
    // and compares the two lags: driftSec = lateLag − earlyLag over spanSec.
    function buildDriftProbe(reference, target) {
        var overlapStart = Math.max(reference.resolvedStartSec, target.resolvedStartSec);
        var overlapEnd = Math.min(reference.resolvedEndSec, target.resolvedEndSec);
        var overlap = overlapEnd - overlapStart;
        if (overlap < DRIFT_MIN_OVERLAP_SEC) return null;

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
    // file — effectively the envelope the coarse pass spends minutes decoding
    // with ffmpeg, already on disk. Format (validated against ffmpeg ground
    // truth on real stereo MP4 and 4-channel MXF footage, r ≥ 0.99 at exact
    // offsets):
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

    // Parse and sanity-check a .pek header. Returns the layout info or null when
    // the buffer is not a plausible peak file (callers then fall back to ffmpeg).
    function parsePekInfo(buffer) {
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
    function pekToEnvelope(buffer, info, targetRate, startSec, durSec) {
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
                for (var c = 0; c < info.channels; c += 1) {
                    var base = PEK_HEADER_BYTES + ((c * info.blocks) + b) * 4;
                    var hi = buffer.readInt16LE(base);
                    var lo = buffer.readInt16LE(base + 2);
                    sum += (hi >= lo ? hi - lo : lo - hi) / 2;
                }
            }
            env[f] = sum / ((b1 - b0) * info.channels);
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
    // but it lives behind ffmpeg in main.js where it can't be unit-tested. These
    // three pure helpers carry all of the bug-prone window math and selection
    // policy so they CAN be tested; main.js only owns the async ffmpeg decode loop.
    //
    // geom: { refInPointSec, refDurationFull, refResolvedStartSec, targetInPointSec,
    //         targetResolvedStartSec, targetAvailSec, tcDelta }
    // cfg:  { minOverlapSec, targetMaxSec, tcConfirmSec, predictMarginSec, headSec,
    //         minScore, strongScore, confirmNearSec }

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
        DRIFT_MIN_OVERLAP_SEC: DRIFT_MIN_OVERLAP_SEC,
        DRIFT_EDGE_FRACTION: DRIFT_EDGE_FRACTION,
        DRIFT_MIN_REPORT_SEC: DRIFT_MIN_REPORT_SEC,
        PEK_MAGIC: PEK_MAGIC,
        PEK_HEADER_BYTES: PEK_HEADER_BYTES,
        PEK_SAMPLES_PER_BLOCK: PEK_SAMPLES_PER_BLOCK,
        parsePekInfo: parsePekInfo,
        pekToEnvelope: pekToEnvelope,
        buildEnvelope: buildEnvelope,
        findBestLag: findBestLag,
        slideMatch: slideMatch,
        buildFineTuneAnchors: buildFineTuneAnchors,
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
        createCoarseState: createCoarseState,
        coarseConsider: coarseConsider,
        coarseResolve: coarseResolve
    };
});

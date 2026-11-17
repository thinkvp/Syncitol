/**
 * Syncitol — sources.js
 * Pure, host-independent: which DEVICE recorded each file, whether the
 * timeline's tracks already hold one device each, and how to lay a rebuilt
 * sequence out with one block of tracks per device.
 *
 * Why it exists: every later stage (build anchors, timing plausibility, coarse
 * align, the residual audit) treats a TRACK as a device. That holds when the
 * editor laid the timeline out that way, and silently breaks when they did not
 * — two cameras on V1 look like one camera whose clips overlap in time, which
 * reads as batch-stamped timestamps, and the whole track's clock is thrown
 * away. Rather than teach every stage about devices, the build can lay the
 * -SYNC sequence out so that one track does mean one device again.
 *
 * Evidence, strongest first:
 *   HARD — proves two files came from different devices:
 *     · different container (.mxf vs .mp4 vs .wav)
 *     · one has picture, the other is sound only
 *     · different camera model / serial (Sony <clip>M01.XML sidecars)
 *     · they claim to have been recording at the same time (embedded clocks)
 *   SOFT — keeps files apart when grouping, but never proves a mix-up:
 *     · source folder on disk (card-structure folders such as XDROOT/Clip,
 *       PRIVATE/M4ROOT/CLIP and per-clip folders are looked through)
 *     · Premiere bin
 *     · file-name pattern (digits ignored: C0524 and C0525 match)
 *
 * Grouping errs towards SPLITTING: one device spread over two tracks only costs
 * a track, and every later stage copes; two devices sharing a track breaks the
 * sync. The layout check that decides whether to rebuild only listens to HARD
 * evidence, so a sensibly organised timeline (one camera's two cards on V1) is
 * left alone.
 *
 * Loadable as a CommonJS module (UXP `require()` and node:test).
 */

"use strict";

// Two takes from one device can round into a small overlap when the container
// timestamp is only second-resolution. Matches dsp's TIMING_OVERLAP_TOL_SEC.
const OVERLAP_TOL_SEC = 2;
// More parallel chains than this inside one look-alike group is not several
// identical cameras — it is a batch process stamping every file at once.
const MAX_PARALLEL_DEVICES = 4;
// Sony writes 4294967295 (0xFFFFFFFF) where a body has no serial to report.
const PLACEHOLDER_SERIALS = new Set(["", "0", "00000000", "4294967295", "ffffffff", "unknown"]);

// Folders that are part of a camera card's structure, never a name the user
// chose. Looked through when labelling a source.
const GENERIC_FOLDERS = new Set([
    "clip", "clips", "xdroot", "m4root", "private", "dcim", "contents", "video", "audio",
    "stream", "bdmv", "avchd", "bpav", "clpr", "sub", "media", "proxy", "proxies", "take",
    "general", "thumbnail", "edit", "hvr", "avf_info", "mp_root", "sony", "canon", "pana"
]);
const GENERIC_FOLDER_RE = /^(\d{3}[a-z_]{5}|clips\d+|\d{3}gopro|\d{3}media|\d{3}_?pana|\d{3}canon|\d{3}msdcf|\d{3}nikon)$/i;

const TIMING_EMBEDDED = new Set(["creation_time", "modification_date", "timecode"]);

function splitPath(p) {
    return String(p || "").split(/[\\/]+/).filter(Boolean);
}
function baseName(p) {
    const parts = splitPath(p);
    return parts.length ? parts[parts.length - 1] : "";
}
function extOf(p) {
    const b = baseName(p);
    const i = b.lastIndexOf(".");
    return i > 0 ? b.slice(i + 1).toLowerCase() : "";
}
function stemOf(p) {
    const b = baseName(p);
    const i = b.lastIndexOf(".");
    return i > 0 ? b.slice(0, i) : b;
}
function stripExt(name) {
    const i = name.lastIndexOf(".");
    return i > 0 ? name.slice(0, i) : name;
}
function isGenericFolder(name) {
    const n = String(name || "").toLowerCase();
    return GENERIC_FOLDERS.has(n) || GENERIC_FOLDER_RE.test(n);
}
function isEmbeddedTiming(source) {
    return TIMING_EMBEDDED.has(source);
}

// A folder that holds one clip and is named after it — RED's
// A001_C001_0101AB.RDC/A001_C001_0101AB_001.R3D, Canon XF's AA0001/AA000101.MXF,
// a Zoom recorder's ZOOM0001/ZOOM0001_LR.WAV. Keying on it would make every
// clip its own device.
function isPerClipFolder(folderName, fileStem) {
    const folder = stripExt(String(folderName || "")).toLowerCase();
    const stem = String(fileStem || "").toLowerCase();
    return folder.length >= 3 && stem.length > folder.length - 1 && stem.indexOf(folder) === 0;
}

// The folder that stands for the recording device: the file's own folder, or
// its parent when the file sits in a per-clip folder.
//   key   — case-folded full path, for grouping
//   label — the nearest folder name a person chose, for the log
function deviceFolder(filePath) {
    const parts = splitPath(filePath);
    const stem = stemOf(filePath);
    let end = parts.length - 2; // index of the file's own folder
    if (end >= 0 && isPerClipFolder(parts[end], stem)) end -= 1;
    if (end < 0) return { key: "", label: "" };
    let li = end;
    while (li > 0 && isGenericFolder(parts[li])) li -= 1;
    return {
        key: parts.slice(0, end + 1).join("/").toLowerCase(),
        label: parts[li] || ""
    };
}

// "C0524" → "c#", "20260801_C0524" → "#_c#", "DBTX-12" → "dbtx-#".
function namePattern(filePath) {
    return stemOf(filePath).toLowerCase().replace(/\d+/g, "#");
}

// The digits in a name that are NOT the take counter: "DBTX-1 _002" → "1",
// "ZOOM0001_Tr2" → "0001". Two recorders named DBTX-1 and DBTX-2 differ here;
// two takes from one of them do not.
function deviceDigits(filePath) {
    const runs = stemOf(filePath).match(/\d+/g) || [];
    return runs.slice(0, -1).join(".");
}

// Trailing counter of a file name: C0524 → 524. Used to keep a camera's takes
// in one chain when two look-alike cameras are told apart by timing alone.
function nameCounter(filePath) {
    const m = /(\d+)(?!.*\d)/.exec(stemOf(filePath));
    return m ? parseInt(m[1], 10) : null;
}

// ─── Sony XML sidecar ─────────────────────────────────────────────────────────
// XDCAM / XAVC cameras write <clip>M01.XML next to each clip with a
// <Device manufacturer="Sony" modelName="ILME-FX6V" serialNo="7600111"/> line.
function sidecarPaths(filePath) {
    const parts = String(filePath || "");
    const dot = parts.lastIndexOf(".");
    const sep = Math.max(parts.lastIndexOf("/"), parts.lastIndexOf("\\"));
    const stemPath = dot > sep ? parts.slice(0, dot) : parts;
    return [stemPath + "M01.XML", stemPath + "M01.xml"];
}

function xmlAttr(attrs, name) {
    const m = new RegExp("\\b" + name + "\\s*=\\s*\"([^\"]*)\"", "i").exec(attrs);
    return m ? m[1].trim() : "";
}

function parseSonyDevice(xmlText) {
    if (!xmlText) return null;
    const m = /<Device\b([^>]*)>/i.exec(String(xmlText));
    if (!m) return null;
    const manufacturer = xmlAttr(m[1], "manufacturer");
    const model = xmlAttr(m[1], "modelName");
    let serial = xmlAttr(m[1], "serialNo");
    if (PLACEHOLDER_SERIALS.has(serial.toLowerCase())) serial = "";
    if (!model && !serial) return null;
    return { manufacturer: manufacturer || null, model: model || null, serial: serial || null };
}

function deviceIdentity(device) {
    if (!device || (!device.model && !device.serial)) return null;
    return (device.model || "?") + "#" + (device.serial || "");
}

// True when both devices are known and cannot be the same body.
function devicesDiffer(a, b) {
    if (!a || !b) return false;
    if (a.model && b.model && a.model.toLowerCase() !== b.model.toLowerCase()) return true;
    if (a.serial && b.serial && a.serial !== b.serial) return true;
    return false;
}

function intervalOf(f) {
    if (!f || !isFinite(f.recordStartMs)) return null;
    return { startMs: f.recordStartMs, endMs: f.recordStartMs + Math.max(0, f.durationSec || 0) * 1000 };
}

function overlapMs(a, b) {
    return Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs);
}

// ─── Chains: tell look-alike devices apart by when they recorded ──────────────
// One device records one file at a time, so files whose embedded clocks overlap
// came from different devices. Greedy interval partitioning, preferring the
// chain whose last file's counter comes just before this one (C0011 follows
// C0010), else the chain that has been idle the shortest.
function partitionByOverlap(files, tolSec) {
    const tolMs = (tolSec === undefined ? OVERLAP_TOL_SEC : tolSec) * 1000;
    const list = files.slice().sort((a, b) =>
        (a.recordStartMs - b.recordStartMs) || String(a.filePath).localeCompare(String(b.filePath)));
    const chains = [];
    for (const f of list) {
        const iv = intervalOf(f);
        const counter = nameCounter(f.filePath);
        let best = null, bestScore = null;
        for (const ch of chains) {
            if (ch.lastEndMs - iv.startMs > tolMs) continue; // still recording
            const gap = counter !== null && ch.lastCounter !== null ? counter - ch.lastCounter : null;
            // Lower is better: a counter that follows on beats everything, then
            // the most recently busy chain.
            const score = (gap !== null && gap > 0 && gap <= 3 ? 0 : 1) * 1e15 + (iv.startMs - ch.lastEndMs);
            if (bestScore === null || score < bestScore) { best = ch; bestScore = score; }
        }
        if (!best) {
            best = { files: [], lastEndMs: -Infinity, lastCounter: null };
            chains.push(best);
        }
        best.files.push(f);
        best.lastEndMs = Math.max(best.lastEndMs, iv.endMs);
        best.lastCounter = counter;
    }
    return chains.map(c => c.files);
}

// ─── Detect sources ───────────────────────────────────────────────────────────
// files: [{ filePath, hasVideo, binPath, device: {model, serial}|null,
//           recordStartMs, durationSec, timingSource }]
// Returns {
//   sources:  [{ id, label, files:[path], hasVideo, ext, device, folderLabel,
//                binPath, timingSuspect, splitBy:[reason] }]
//   sourceOf: { path: id }
// }
function detectSources(files, opts) {
    opts = opts || {};
    const tolSec = opts.overlapToleranceSec === undefined ? OVERLAP_TOL_SEC : opts.overlapToleranceSec;
    const list = (files || []).filter(f => f && f.filePath);

    // Bins only say something when they differ: a project with every clip in
    // one bin (or the root) gives no evidence either way.
    const binSet = new Set(list.map(f => f.binPath || ""));
    const binsInformative = binSet.size > 1;

    // 1. Look-alike groups: same container, same picture/sound kind, same
    //    folder, bin and name pattern.
    const groups = new Map();
    for (const f of list) {
        const folder = deviceFolder(f.filePath);
        const key = [
            extOf(f.filePath), f.hasVideo ? "v" : "a",
            folder.key, binsInformative ? (f.binPath || "") : "", namePattern(f.filePath)
        ].join("|");
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(f);
    }

    const raw = []; // [{ files, timingSuspect, splitBy }]
    for (const members of groups.values()) {
        // 2. Split by camera body where sidecars name one. Files with no
        //    sidecar join the only known body, or stay together if there are
        //    several (nothing says which body they belong to).
        const byId = new Map();
        const unknown = [];
        for (const f of members) {
            const id = deviceIdentity(f.device);
            if (!id) { unknown.push(f); continue; }
            if (!byId.has(id)) byId.set(id, []);
            byId.get(id).push(f);
        }
        let bodies;
        if (byId.size <= 1) {
            bodies = [{ files: members, splitBy: [] }];
        } else {
            bodies = [...byId.values()].map(fs => ({ files: fs, splitBy: ["camera serial / model"] }));
            if (unknown.length) bodies.push({ files: unknown, splitBy: ["camera serial / model"] });
        }

        // 3. Split by recording time: one body cannot record two files at once.
        for (const body of bodies) {
            const timed = body.files.every(f => isFinite(f.recordStartMs));
            if (!timed || body.files.length < 2) {
                raw.push({ files: body.files, timingSuspect: false, splitBy: body.splitBy });
                continue;
            }
            const embedded = body.files.every(f => isEmbeddedTiming(f.timingSource));
            if (!embedded) {
                // A file date is when the file was last written — a copy, a
                // download, a processing pass — so overlapping dates prove
                // nothing about devices. Only the device number in the name
                // (DBTX-1 vs DBTX-2) separates these; overlapping takes of one
                // device are given lanes of their own by the layout instead.
                const byDigits = new Map();
                for (const f of body.files) {
                    const k = deviceDigits(f.filePath);
                    if (!byDigits.has(k)) byDigits.set(k, []);
                    byDigits.get(k).push(f);
                }
                for (const sub of byDigits.values()) {
                    raw.push({
                        files: sub,
                        timingSuspect: partitionByOverlap(sub, tolSec).length > MAX_PARALLEL_DEVICES,
                        splitBy: byDigits.size > 1 ? body.splitBy.concat(["device number in the file name"]) : body.splitBy
                    });
                }
                continue;
            }
            const chains = partitionByOverlap(body.files, tolSec);
            if (chains.length === 1) {
                raw.push({ files: body.files, timingSuspect: false, splitBy: body.splitBy });
            } else if (chains.length > MAX_PARALLEL_DEVICES) {
                // Everything overlaps everything: a batch transcode or a camera
                // with no clock — not a room full of identical cameras.
                raw.push({ files: body.files, timingSuspect: true, splitBy: body.splitBy });
            } else {
                const sibling = {};
                for (const ch of chains) {
                    raw.push({ files: ch, timingSuspect: false, splitBy: body.splitBy.concat(["recorded at the same time"]), sibling });
                }
            }
        }
    }

    // 4. Stable order and ids: earliest recording first, picture before sound.
    const firstStart = (r) => Math.min.apply(null, r.files.map(f => isFinite(f.recordStartMs) ? f.recordStartMs : Infinity));
    raw.sort((a, b) =>
        ((b.files[0].hasVideo ? 1 : 0) - (a.files[0].hasVideo ? 1 : 0)) ||
        (firstStart(a) - firstStart(b)) ||
        String(a.files[0].filePath).localeCompare(String(b.files[0].filePath)));

    const sources = [];
    const sourceOf = {};
    const labelCount = {};
    raw.forEach((r, i) => {
        const f0 = r.files[0];
        const device = r.files.map(f => f.device).find(d => d && (d.model || d.serial)) || null;
        const folder = deviceFolder(f0.filePath);
        const binLeaf = splitPath(f0.binPath || "").pop() || "";
        let label = (device && device.model) ||
            (binsInformative && binLeaf) || folder.label || stemOf(f0.filePath);
        labelCount[label] = (labelCount[label] || 0) + 1;
        const src = {
            id: "S" + (i + 1),
            label,
            files: r.files.map(f => f.filePath),
            hasVideo: !!f0.hasVideo,
            ext: extOf(f0.filePath),
            device,
            folderLabel: folder.label,
            binPath: f0.binPath || "",
            timingSuspect: r.timingSuspect,
            splitBy: r.splitBy,
            _sibling: r.sibling || null
        };
        sources.push(src);
        for (const f of r.files) sourceOf[f.filePath] = src.id;
    });
    // Same label twice ("A7S3" for two look-alike bodies) → add the first
    // file's name, which is what the editor will recognise in the timeline.
    for (const s of sources) {
        if (labelCount[s.label] > 1) s.label = s.label + " · " + stemOf(s.files[0]);
    }
    // Sources split apart purely by overlapping clocks are provably different
    // devices; record that pairwise for the layout check.
    for (const s of sources) {
        s.provenDistinctFrom = sources
            .filter(o => o !== s && s._sibling && o._sibling === s._sibling)
            .map(o => o.id);
    }
    for (const s of sources) delete s._sibling;

    return { sources, sourceOf };
}

// ─── Layout check ─────────────────────────────────────────────────────────────
// Does any timeline track hold files from two sources that are PROVABLY
// different devices? Soft differences (folder, bin, name) never count: one
// camera's two cards on V1 is a perfectly good layout.
//
// clips: scan clips [{ filePath, trackType, trackIndex }]
// files: the detection input (needs ext / hasVideo / device / times)
// Returns { ok, mixed: [{ trackKey, sourceIds, reason }] }
function sourcesProvablyDiffer(a, b) {
    if (a.ext !== b.ext) return `.${a.ext.toUpperCase() || "?"} and .${b.ext.toUpperCase() || "?"} files`;
    if (a.hasVideo !== b.hasVideo) return "camera clips and sound-only recordings";
    if (devicesDiffer(a.device, b.device)) {
        return `${(a.device.model || "") + (a.device.serial ? " #" + a.device.serial : "")} and ` +
            `${(b.device.model || "") + (b.device.serial ? " #" + b.device.serial : "")}`;
    }
    if ((a.provenDistinctFrom || []).indexOf(b.id) >= 0) return "files recorded at the same time";
    return null;
}

function checkTrackLayout(clips, detection, files, opts) {
    opts = opts || {};
    const tolMs = (opts.overlapToleranceSec === undefined ? OVERLAP_TOL_SEC : opts.overlapToleranceSec) * 1000;
    const fileByPath = {};
    for (const f of files || []) fileByPath[f.filePath] = f;
    const srcById = {};
    for (const s of detection.sources) srcById[s.id] = s;

    const byTrack = new Map();
    for (const c of clips || []) {
        const sid = detection.sourceOf[c.filePath];
        if (!sid) continue;
        const key = c.trackType + "_" + c.trackIndex;
        if (!byTrack.has(key)) byTrack.set(key, new Map());
        const m = byTrack.get(key);
        if (!m.has(sid)) m.set(sid, new Set());
        m.get(sid).add(c.filePath);
    }

    const mixed = [];
    for (const [trackKey, bySource] of byTrack) {
        if (bySource.size < 2) continue;
        const ids = [...bySource.keys()];
        let reason = null;
        for (let i = 0; i < ids.length && !reason; i += 1) {
            for (let j = i + 1; j < ids.length && !reason; j += 1) {
                const a = srcById[ids[i]], b = srcById[ids[j]];
                reason = sourcesProvablyDiffer(a, b);
                if (reason) break;
                // Two sources on this track whose trusted clocks say they were
                // both recording at once.
                for (const pa of bySource.get(ids[i])) {
                    const fa = fileByPath[pa];
                    if (!fa || !isEmbeddedTiming(fa.timingSource) || a.timingSuspect) continue;
                    const ia = intervalOf(fa);
                    for (const pb of bySource.get(ids[j])) {
                        const fb = fileByPath[pb];
                        if (!fb || !isEmbeddedTiming(fb.timingSource) || b.timingSuspect) continue;
                        const ib = intervalOf(fb);
                        if (ia && ib && overlapMs(ia, ib) > tolMs) {
                            reason = "files recorded at the same time";
                            break;
                        }
                    }
                    if (reason) break;
                }
            }
        }
        if (reason) mixed.push({ trackKey, sourceIds: ids, reason });
    }
    mixed.sort((x, y) => trackOrder(x.trackKey) - trackOrder(y.trackKey));
    return { ok: mixed.length === 0, mixed };
}

function trackOrder(key) {
    const m = /^(video|audio)_(\d+)$/.exec(key);
    return m ? (m[1] === "video" ? 0 : 10000) + parseInt(m[2], 10) : 1e9;
}

// ─── Rebuild layout ───────────────────────────────────────────────────────────
// One block of tracks per source: a camera gets one video track and however
// many audio tracks its clips need; a sound recorder gets audio tracks only.
// Within a source, files are laid out in recording order on one lane. A file
// whose clock overlaps the previous one by no more than the tolerance (second-
// resolution timestamps) is nudged to start where that one ends; a larger
// overlap — file dates that are processing times — opens a second lane, so no
// clip is ever trimmed by another and the coarse pass can place each lane on
// its own. A source whose timestamps are batch stamps (everything overlapping
// everything) is packed end to end instead, rather than one lane per file.
//
// files:   the enriched payload [{ filePath, recordStartMs, durationSec,
//          timingSource, ... }]
// clips:   scan clips of the ORIGINAL sequence (track order + audio width)
// Returns {
//   blocks:  [{ sourceId, label, lane, hasVideo, videoTrack, audioTrack,
//               audioWidth, files: [{ filePath, placeStartMs, nudgedMs }] }]
//   payload: files re-keyed to the track they will be placed on, each with
//            placeStartMs (clock time its start is laid out at), sourceId
//   nudged:  [{ filePath, nudgedMs }]
// }
function planSourceLayout(files, detection, clips, opts) {
    opts = opts || {};
    const tolMs = (opts.overlapToleranceSec === undefined ? OVERLAP_TOL_SEC : opts.overlapToleranceSec) * 1000;

    const inst = {}; // path → { minV, minA, audioTracks:Set }
    for (const c of clips || []) {
        const e = inst[c.filePath] || (inst[c.filePath] = { minV: Infinity, minA: Infinity, audioTracks: new Set() });
        if (c.trackType === "video") e.minV = Math.min(e.minV, c.trackIndex);
        else { e.minA = Math.min(e.minA, c.trackIndex); e.audioTracks.add(c.trackIndex); }
    }
    const fileByPath = {};
    for (const f of files || []) fileByPath[f.filePath] = f;

    const srcFiles = detection.sources.map(s => ({
        src: s,
        files: s.files.map(p => fileByPath[p]).filter(f => f && isFinite(f.recordStartMs))
    })).filter(x => x.files.length);

    const minOf = (x, k) => Math.min.apply(null, x.files.map(f => (inst[f.filePath] || {})[k]).concat([Infinity]));
    const earliest = (x) => Math.min.apply(null, x.files.map(f => f.recordStartMs));
    // Keep the editor's own track order where there is one.
    srcFiles.sort((a, b) =>
        ((b.src.hasVideo ? 1 : 0) - (a.src.hasVideo ? 1 : 0)) ||
        (a.src.hasVideo ? minOf(a, "minV") - minOf(b, "minV") : minOf(a, "minA") - minOf(b, "minA")) ||
        (earliest(a) - earliest(b)) ||
        a.src.id.localeCompare(b.src.id));

    const blocks = [];
    const nudged = [];
    for (const { src, files: fl } of srcFiles) {
        const packed = !!src.timingSuspect;
        const sorted = fl.slice().sort((a, b) =>
            (a.recordStartMs - b.recordStartMs) || String(a.filePath).localeCompare(String(b.filePath)));
        const lanes = [];
        for (const f of sorted) {
            const startMs = f.recordStartMs;
            const endMs = startMs + Math.max(0, f.durationSec || 0) * 1000;
            let lane = null;
            if (packed) {
                lane = lanes[0] || null;
            } else {
                for (const l of lanes) {
                    if (l.lastEndMs - startMs <= tolMs) { lane = l; break; }
                }
            }
            if (!lane) {
                lane = { files: [], lastEndMs: -Infinity };
                lanes.push(lane);
            }
            const placeStartMs = Math.max(startMs, lane.lastEndMs);
            const shift = placeStartMs - startMs;
            if (shift > 0) nudged.push({ filePath: f.filePath, nudgedMs: shift });
            lane.files.push({ filePath: f.filePath, placeStartMs, nudgedMs: shift });
            lane.lastEndMs = placeStartMs + (endMs - startMs);
        }
        lanes.forEach((l, li) => {
            let width = 0;
            for (const pf of l.files) width = Math.max(width, ((inst[pf.filePath] || {}).audioTracks || new Set()).size);
            blocks.push({
                sourceId: src.id,
                label: li ? `${src.label} (lane ${li + 1})` : src.label,
                lane: li, hasVideo: src.hasVideo,
                videoTrack: -1, audioTrack: -1,
                audioWidth: src.hasVideo ? width : Math.max(1, width),
                files: l.files
            });
        });
    }

    // Planned track positions. The audio ones are an estimate — a clip placed
    // fresh takes however many channels Premiere maps for it — so the host
    // side re-reads the timeline after each block; these are what the build
    // layout and the log are keyed on.
    let v = 0, a = 0;
    for (const b of blocks) {
        if (!b.hasVideo) continue;
        b.videoTrack = v++;
        b.audioTrack = a;
        a += b.audioWidth;
    }
    for (const b of blocks) {
        if (b.hasVideo) continue;
        b.audioTrack = a;
        a += b.audioWidth;
    }

    const payload = [];
    for (const b of blocks) {
        for (const pf of b.files) {
            const f = fileByPath[pf.filePath];
            payload.push(Object.assign({}, f, {
                trackType: b.hasVideo ? "video" : "audio",
                trackIndex: b.hasVideo ? b.videoTrack : b.audioTrack,
                placeStartMs: pf.placeStartMs,
                sourceId: b.sourceId
            }));
        }
    }
    return { blocks, payload, nudged };
}

// Timeline seconds for every placement, from the build anchors planned on the
// re-keyed payload (dsp.planBuildAnchors(plan.payload).anchorMsByTrack).
function placementTimes(plan, anchorMsByTrack) {
    const keyOf = (b) => (b.hasVideo ? "video_" + b.videoTrack : "audio_" + b.audioTrack);
    return plan.blocks.map(b => {
        const anchor = anchorMsByTrack[keyOf(b)];
        const base = isFinite(anchor) ? anchor : Math.min.apply(null, b.files.map(f => f.placeStartMs));
        return Object.assign({}, b, {
            files: b.files.map(f => Object.assign({}, f, {
                startSec: Math.max(0, (f.placeStartMs - base) / 1000)
            }))
        });
    });
}

module.exports = {
    OVERLAP_TOL_SEC,
    MAX_PARALLEL_DEVICES,
    deviceFolder,
    namePattern,
    deviceDigits,
    isPerClipFolder,
    sidecarPaths,
    parseSonyDevice,
    devicesDiffer,
    partitionByOverlap,
    detectSources,
    checkTrackLayout,
    planSourceLayout,
    placementTimes
};

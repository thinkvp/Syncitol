"use strict";

const test = require("node:test");
const assert = require("node:assert");
const sources = require("../js/sources");
const dsp = require("../js/dsp");

const T0 = Date.parse("2026-08-01T09:00:00Z");
const min = (m) => T0 + m * 60000;

// A small shoot like the FX6 + A7S3 interview: two cameras and two body-pack
// recorders, all rolling at once.
function shoot() {
    return [
        { filePath: "D:/Shoot/FX6/XDROOT/Clip/111_3871.mxf", hasVideo: true, recordStartMs: min(0), durationSec: 1800, timingSource: "modification_date",
          device: { model: "ILME-FX6V", serial: "7600111" }, binPath: "Video files/FX6" },
        { filePath: "D:/Shoot/FX6/XDROOT/Clip/111_3872.mxf", hasVideo: true, recordStartMs: min(31), durationSec: 1200, timingSource: "modification_date",
          device: { model: "ILME-FX6V", serial: "7600111" }, binPath: "Video files/FX6" },
        { filePath: "D:/Shoot/A7S3/PRIVATE/M4ROOT/CLIP/20260801_C0524.mp4", hasVideo: true, recordStartMs: min(0.2), durationSec: 1790, timingSource: "creation_time",
          device: { model: "ILCE-7SM3", serial: null }, binPath: "Video files/A7S3" },
        { filePath: "D:/Shoot/A7S3/PRIVATE/M4ROOT/CLIP/20260801_C0525.mp4", hasVideo: true, recordStartMs: min(31.1), durationSec: 1190, timingSource: "creation_time",
          device: { model: "ILCE-7SM3", serial: null }, binPath: "Video files/A7S3" },
        { filePath: "D:/Shoot/Audio/DBTX-1.wav", hasVideo: false, recordStartMs: min(-1), durationSec: 3300, timingSource: "creation_time", device: null, binPath: "Audio" },
        { filePath: "D:/Shoot/Audio/DBTX-2.wav", hasVideo: false, recordStartMs: min(-0.5), durationSec: 3300, timingSource: "creation_time", device: null, binPath: "Audio" }
    ];
}

function clipsFor(files, trackOf) {
    const out = [];
    for (const f of files) {
        for (const t of trackOf(f)) out.push({ filePath: f.filePath, trackType: t[0], trackIndex: t[1] });
    }
    return out;
}

function idsFor(det, files) {
    return files.map(f => det.sourceOf[f.filePath]);
}

// ─── Paths and names ──────────────────────────────────────────────────────────

test("deviceFolder looks through card structure for the label, keeps the full path as the key", () => {
    const sony = sources.deviceFolder("D:/Shoot/FX6 Card 2/XDROOT/Clip/111_3871.MXF");
    assert.strictEqual(sony.label, "FX6 Card 2");
    assert.strictEqual(sony.key, "d:/shoot/fx6 card 2/xdroot/clip");
    assert.strictEqual(sources.deviceFolder("E:\\B cam\\PRIVATE\\M4ROOT\\CLIP\\C0001.MP4").label, "B cam");
    assert.strictEqual(sources.deviceFolder("/Volumes/GOPRO/DCIM/100GOPRO/GX010001.MP4").label, "GOPRO");
});

test("deviceFolder treats a per-clip folder as part of the clip, not a device", () => {
    const a = sources.deviceFolder("D:/RED/A001_C001_0101AB.RDC/A001_C001_0101AB_001.R3D");
    const b = sources.deviceFolder("D:/RED/A001_C002_0101XY.RDC/A001_C002_0101XY_001.R3D");
    assert.strictEqual(a.key, b.key);
    assert.strictEqual(a.label, "RED");
    const z = sources.deviceFolder("D:/Zoom/ZOOM0001/ZOOM0001_LR.WAV");
    assert.strictEqual(z.key, "d:/zoom");
});

test("namePattern ignores take counters but keeps the naming scheme", () => {
    assert.strictEqual(sources.namePattern("x/C0524.MP4"), sources.namePattern("x/C0525.MP4"));
    assert.notStrictEqual(sources.namePattern("x/C0524.MP4"), sources.namePattern("x/GX010001.MP4"));
    assert.strictEqual(sources.namePattern("x/DBTX-1.wav"), sources.namePattern("x/DBTX-12.wav"));
});

test("parseSonyDevice reads model and serial and drops the placeholder serial", () => {
    const fx6 = sources.parseSonyDevice('<?xml?><NonRealTimeMeta><Device manufacturer="Sony" modelName="ILME-FX6V" serialNo="7600111"/></NonRealTimeMeta>');
    assert.deepStrictEqual(fx6, { manufacturer: "Sony", model: "ILME-FX6V", serial: "7600111" });
    const a7 = sources.parseSonyDevice('<Device manufacturer="Sony" modelName="ILCE-7SM3" serialNo="4294967295"/>');
    assert.strictEqual(a7.serial, null);
    assert.strictEqual(a7.model, "ILCE-7SM3");
    assert.strictEqual(sources.parseSonyDevice("<NoDevice/>"), null);
    assert.strictEqual(sources.parseSonyDevice(""), null);
});

test("sidecarPaths swaps the extension for M01.XML next to the clip", () => {
    assert.deepStrictEqual(sources.sidecarPaths("D:\\FX6\\Clip\\111_3871.MXF"),
        ["D:\\FX6\\Clip\\111_3871M01.XML", "D:\\FX6\\Clip\\111_3871M01.xml"]);
});

// ─── Detection ────────────────────────────────────────────────────────────────

test("detectSources finds each camera and each recorder in a mixed shoot", () => {
    const files = shoot();
    const det = sources.detectSources(files);
    assert.strictEqual(det.sources.length, 4);
    const [fx1, fx2, a1, a2, w1, w2] = idsFor(det, files);
    assert.strictEqual(fx1, fx2);
    assert.strictEqual(a1, a2);
    assert.notStrictEqual(fx1, a1);
    // Two look-alike recorders in one folder, told apart because both were
    // recording at once.
    assert.notStrictEqual(w1, w2);
    const byId = Object.fromEntries(det.sources.map(s => [s.id, s]));
    assert.strictEqual(byId[fx1].label, "ILME-FX6V");
    assert.ok(byId[w1].provenDistinctFrom.includes(w2));
    // Picture sources come first.
    assert.ok(det.sources[0].hasVideo && det.sources[1].hasVideo);
});

test("detectSources splits identical cameras sharing a folder by when they recorded", () => {
    const files = [
        { filePath: "D:/All/C0001.MP4", hasVideo: true, recordStartMs: min(0), durationSec: 600, timingSource: "creation_time" },
        { filePath: "D:/All/C0002.MP4", hasVideo: true, recordStartMs: min(11), durationSec: 600, timingSource: "creation_time" },
        // Second body, renamed on import so the names do not collide.
        { filePath: "D:/All/C0101.MP4", hasVideo: true, recordStartMs: min(0.5), durationSec: 590, timingSource: "creation_time" },
        { filePath: "D:/All/C0102.MP4", hasVideo: true, recordStartMs: min(11.2), durationSec: 590, timingSource: "creation_time" }
    ];
    const det = sources.detectSources(files);
    const ids = idsFor(det, files);
    assert.strictEqual(det.sources.length, 2);
    assert.strictEqual(ids[0], ids[1], "C0002 follows C0001 on the same body");
    assert.strictEqual(ids[2], ids[3], "C0102 follows C0101 on the same body");
    assert.notStrictEqual(ids[0], ids[2]);
});

test("detectSources does not explode batch-stamped files into one source each", () => {
    const files = [];
    for (let i = 0; i < 8; i += 1) {
        // A transcode wrote every creation_time within a minute.
        files.push({ filePath: `D:/Proxies/clip_${i}.mov`, hasVideo: true, recordStartMs: T0 + i * 5000, durationSec: 900, timingSource: "creation_time" });
    }
    const det = sources.detectSources(files);
    assert.strictEqual(det.sources.length, 1);
    assert.strictEqual(det.sources[0].timingSuspect, true);
});

test("detectSources splits by camera serial", () => {
    const files = [
        { filePath: "D:/FX6/111_0001.mxf", hasVideo: true, recordStartMs: min(0), durationSec: 60, timingSource: "modification_date", device: { model: "ILME-FX6V", serial: "1" } },
        { filePath: "D:/FX6/111_0002.mxf", hasVideo: true, recordStartMs: min(5), durationSec: 60, timingSource: "modification_date", device: { model: "ILME-FX6V", serial: "2" } }
    ];
    const ids = idsFor(sources.detectSources(files), files);
    assert.notStrictEqual(ids[0], ids[1]);
});

test("detectSources never splits on file dates, only on the device number in the name", () => {
    // Body-pack recordings run through a processing service: every file date
    // is when it was processed, so takes of ONE transmitter overlap.
    const files = [
        { filePath: "D:/Audio/DBTX-1 _001.wav", hasVideo: false, recordStartMs: min(0), durationSec: 10800, timingSource: "mtime" },
        { filePath: "D:/Audio/DBTX-1 _002.wav", hasVideo: false, recordStartMs: min(100), durationSec: 6200, timingSource: "mtime" },
        { filePath: "D:/Audio/DBTX-2 _001.wav", hasVideo: false, recordStartMs: min(95), durationSec: 6200, timingSource: "mtime" }
    ];
    const det = sources.detectSources(files);
    const ids = idsFor(det, files);
    assert.strictEqual(ids[0], ids[1], "two takes of DBTX-1");
    assert.notStrictEqual(ids[0], ids[2]);
    for (const s of det.sources) assert.deepStrictEqual(s.provenDistinctFrom, []);
    // The overlapping takes get a lane each, so the coarse pass places them separately.
    const plan = sources.planSourceLayout(files, det, []);
    assert.deepStrictEqual(plan.blocks.map(b => [b.sourceId === ids[0], b.lane]), [[true, 0], [true, 1], [false, 0]]);
});

test("deviceDigits drops only the take counter", () => {
    assert.strictEqual(sources.deviceDigits("x/DBTX-1 _002.wav"), "1");
    assert.strictEqual(sources.deviceDigits("x/C0524.MP4"), "");
    assert.strictEqual(sources.deviceDigits("x/ZOOM0001_Tr2.WAV"), "0001");
});

test("detectSources lets a file with no sidecar join the only known body", () => {
    const files = [
        { filePath: "D:/FX6/111_0001.mxf", hasVideo: true, recordStartMs: min(0), durationSec: 60, timingSource: "modification_date", device: { model: "ILME-FX6V", serial: "1" } },
        { filePath: "D:/FX6/111_0002.mxf", hasVideo: true, recordStartMs: min(5), durationSec: 60, timingSource: "modification_date", device: null }
    ];
    assert.strictEqual(sources.detectSources(files).sources.length, 1);
});

test("detectSources uses bins only when they differ", () => {
    const files = [
        { filePath: "D:/Footage/clip_1.mp4", hasVideo: true, recordStartMs: min(0), durationSec: 60, timingSource: "mtime", binPath: "A cam" },
        { filePath: "D:/Footage/clip_2.mp4", hasVideo: true, recordStartMs: min(5), durationSec: 60, timingSource: "mtime", binPath: "B cam" }
    ];
    const det = sources.detectSources(files);
    assert.strictEqual(det.sources.length, 2);
    assert.deepStrictEqual(det.sources.map(s => s.label).sort(), ["A cam", "B cam"]);
    const same = files.map(f => Object.assign({}, f, { binPath: "Footage" }));
    assert.strictEqual(sources.detectSources(same).sources.length, 1);
});

// ─── Layout check ─────────────────────────────────────────────────────────────

test("checkTrackLayout accepts a timeline already laid out one device per track", () => {
    const files = shoot();
    const det = sources.detectSources(files);
    const track = {
        "111_3871.mxf": [["video", 0], ["audio", 0], ["audio", 1], ["audio", 2], ["audio", 3]],
        "111_3872.mxf": [["video", 0], ["audio", 0], ["audio", 1], ["audio", 2], ["audio", 3]],
        "20260801_C0524.mp4": [["video", 1], ["audio", 4]],
        "20260801_C0525.mp4": [["video", 1], ["audio", 4]],
        "DBTX-1.wav": [["audio", 5]],
        "DBTX-2.wav": [["audio", 6]]
    };
    const clips = clipsFor(files, f => track[f.filePath.split("/").pop()]);
    const r = sources.checkTrackLayout(clips, det, files);
    assert.strictEqual(r.ok, true);
});

test("checkTrackLayout flags a timeline with everything dumped on V1/A1", () => {
    const files = shoot();
    const det = sources.detectSources(files);
    const clips = clipsFor(files, f => f.hasVideo ? [["video", 0], ["audio", 0]] : [["audio", 0]]);
    const r = sources.checkTrackLayout(clips, det, files);
    assert.strictEqual(r.ok, false);
    assert.deepStrictEqual(r.mixed.map(m => m.trackKey), ["video_0", "audio_0"]);
    assert.match(r.mixed[0].reason, /MXF|MP4|ILME|ILCE/);
});

test("checkTrackLayout leaves one camera's two cards on one track alone", () => {
    const files = [
        { filePath: "D:/Card1/C0001.MP4", hasVideo: true, recordStartMs: min(0), durationSec: 600, timingSource: "creation_time" },
        { filePath: "D:/Card2/C0050.MP4", hasVideo: true, recordStartMs: min(60), durationSec: 600, timingSource: "creation_time" }
    ];
    const det = sources.detectSources(files);
    assert.strictEqual(det.sources.length, 2, "folders keep them apart when grouping");
    const r = sources.checkTrackLayout(clipsFor(files, () => [["video", 0]]), det, files);
    assert.strictEqual(r.ok, true, "but a folder difference alone never proves a mix-up");
});

test("checkTrackLayout flags two look-alike cameras sharing a track while rolling at once", () => {
    const files = [
        { filePath: "D:/A cam/C0001.MP4", hasVideo: true, recordStartMs: min(0), durationSec: 600, timingSource: "creation_time" },
        { filePath: "D:/B cam/C0001.MP4", hasVideo: true, recordStartMs: min(1), durationSec: 600, timingSource: "creation_time" }
    ];
    const det = sources.detectSources(files);
    const r = sources.checkTrackLayout(clipsFor(files, () => [["video", 0]]), det, files);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.mixed[0].reason, "files recorded at the same time");
});

// ─── Rebuild layout ───────────────────────────────────────────────────────────

test("planSourceLayout gives each camera a video track and an audio block, recorders after", () => {
    const files = shoot();
    const det = sources.detectSources(files);
    // Messy original: A7S3 on V1, FX6 on V2, everything's sound on A1.
    const clips = clipsFor(files, (f) => {
        if (/mxf$/.test(f.filePath)) return [["video", 1], ["audio", 0], ["audio", 1], ["audio", 2], ["audio", 3]];
        if (/mp4$/.test(f.filePath)) return [["video", 0], ["audio", 0]];
        return [["audio", 0]];
    });
    const plan = sources.planSourceLayout(files, det, clips);
    assert.deepStrictEqual(plan.blocks.map(b => [b.label, b.videoTrack, b.audioTrack, b.audioWidth]), [
        ["ILCE-7SM3", 0, 0, 1],
        ["ILME-FX6V", 1, 1, 4],
        ["Audio · DBTX-1", -1, 5, 1],
        ["Audio · DBTX-2", -1, 6, 1]
    ]);
    const fx = plan.payload.find(p => /3871/.test(p.filePath));
    assert.strictEqual(fx.trackType, "video");
    assert.strictEqual(fx.trackIndex, 1);
    const w = plan.payload.find(p => /DBTX-2/.test(p.filePath));
    assert.strictEqual(w.trackType, "audio");
    assert.strictEqual(w.trackIndex, 6);
});

test("planSourceLayout nudges a second-resolution overlap and opens a lane for a real one", () => {
    const files = [
        { filePath: "D:/Cam/C0001.MP4", hasVideo: true, recordStartMs: min(0), durationSec: 60, timingSource: "creation_time" },
        // Starts 1 s before C0001 ends — the stamps are whole seconds.
        { filePath: "D:/Cam/C0002.MP4", hasVideo: true, recordStartMs: min(1) - 1000, durationSec: 60, timingSource: "creation_time" }
    ];
    const det = { sources: [{ id: "S1", label: "Cam", files: files.map(f => f.filePath), hasVideo: true, timingSuspect: false }], sourceOf: {} };
    const plan = sources.planSourceLayout(files, det, []);
    assert.strictEqual(plan.blocks.length, 1);
    assert.strictEqual(plan.blocks[0].files[1].nudgedMs, 1000);
    assert.strictEqual(plan.blocks[0].files[1].placeStartMs, min(1));

    files[1].recordStartMs = min(0.5); // 30 s inside the first take
    const plan2 = sources.planSourceLayout(files, det, []);
    assert.strictEqual(plan2.blocks.length, 2);
    assert.deepStrictEqual(plan2.blocks.map(b => b.videoTrack), [0, 1]);
});

test("planSourceLayout packs a source with untrusted timing end to end on one lane", () => {
    const files = [
        { filePath: "D:/Rec/A.wav", hasVideo: false, recordStartMs: min(0), durationSec: 120, timingSource: "mtime" },
        { filePath: "D:/Rec/B.wav", hasVideo: false, recordStartMs: min(1), durationSec: 120, timingSource: "mtime" }
    ];
    const det = { sources: [{ id: "S1", label: "Rec", files: files.map(f => f.filePath), hasVideo: false, timingSuspect: true }], sourceOf: {} };
    const plan = sources.planSourceLayout(files, det, []);
    assert.strictEqual(plan.blocks.length, 1);
    assert.strictEqual(plan.blocks[0].files[1].placeStartMs, min(2));
});

test("placementTimes lays out sources that rolled together at their real offsets", () => {
    const files = shoot();
    const det = sources.detectSources(files);
    const clips = clipsFor(files, f => f.hasVideo ? [["video", 0], ["audio", 0]] : [["audio", 0]]);
    const plan = sources.planSourceLayout(files, det, clips);
    const layout = dsp.planBuildAnchors(plan.payload);
    const placed = sources.placementTimes(plan, layout.anchorMsByTrack);
    const startOf = (re) => {
        for (const b of placed) for (const f of b.files) if (re.test(f.filePath)) return f.startSec;
        return null;
    };
    // Everyone overlapped, so they share the earliest clock (DBTX-1 at -1 min).
    assert.strictEqual(startOf(/DBTX-1/), 0);
    assert.strictEqual(startOf(/111_3871/), 60);
    assert.strictEqual(startOf(/C0524/), 72);
    assert.strictEqual(startOf(/111_3872/), 32 * 60);
});

test("followTrack finds where a forced reference's recordings went after a rebuild", () => {
    const clips = [
        { filePath: "cam.mxf", trackType: "audio", trackIndex: 0 },
        { filePath: "rec_1.wav", trackType: "audio", trackIndex: 5 },
        { filePath: "rec_2.wav", trackType: "audio", trackIndex: 5 },
        { filePath: "rec_2.wav", trackType: "audio", trackIndex: 6 },
        { filePath: "other.wav", trackType: "audio", trackIndex: 6 },
        { filePath: "rec_1.wav", trackType: "video", trackIndex: 0 }
    ];
    assert.strictEqual(sources.followTrack(clips, ["rec_1.wav", "rec_2.wav"], "audio"), "audio_5");
    assert.strictEqual(sources.followTrack(clips, ["rec_2.wav"], "audio"), "audio_5", "the purer track wins a tie");
    assert.strictEqual(sources.followTrack(clips, ["missing.wav"], "audio"), null);
});

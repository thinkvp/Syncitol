# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog and this project adheres to Semantic Versioning.

## [1.4.0] - 2026-07-02

### Added
- **Premiere peak-file (.pek) fast path for coarse align.** Premiere already
  computes a waveform cache for every imported media file; the coarse pass now
  reads it directly instead of decoding audio through ffmpeg. Reverse-engineered
  format, validated against ffmpeg ground truth on real stereo MP4 and 4-channel
  MXF footage (r ≥ 0.99 at exact offsets): a 68-byte header (magic `0x67235411`,
  channel count, f64 sample rate, payload size) followed by a **channel-planar**
  payload of int16 (max, min) peak pairs per 256-sample block (187.5 Hz at
  48 kHz). The parser and envelope builder are pure, unit-tested functions in
  `js/dsp.js` (`parsePekInfo`, `pekToEnvelope`).
- Media → .pek resolution goes through Adobe's media-cache database (`.mcdb`
  records, `OriginalWinPath` → `Item.WinPathN` keyed `pekNNNNN`), indexed once
  per session (~8k records in ~300 ms). A .pek is only trusted when the media
  hasn't been modified since the peaks were written, the header parses, and
  (when ffprobe is present) the durations agree — anything doubtful falls back
  to the ffmpeg pipeline unchanged.
- The pek match runs as **stage 0** of the staged coarse search, before any
  audio is touched, and strong matches also seed the learned-offset hints for
  tracks whose media has no usable peaks. On the footage that took ~6 minutes
  of coarse decode (v1.3.0), the same offsets now come back in ~300 ms with
  0.00 s error.

## [1.3.1] - 2026-07-02

### Changed
- **Coarse align is staged across tracks, with learned-offset hints.** Previously
  each track independently escalated timecode → timestamp → head → full, so a
  track whose clock was minutes off (outside every predictor window) paid for a
  blind full-reference scan even when a sibling track had already found the
  answer. Now every track runs its cheap metadata windows first, and before any
  blind head/full scan a track first checks a ±120 s window around each offset
  other tracks have already confirmed strongly — devices from one shoot share
  the same clock-error family (22 s apart in the motivating log, where this
  change eliminates a ~2-minute full scan). Cost also no longer swings on which
  of two near-equal-coverage recordings wins the reference coin-flip.

### Fixed
- A weak coarse match is now judged "near its prediction" against the plan's own
  predicted delta rather than always against the timestamp position, so a
  correct start-timecode prediction that disagrees with the timestamps can
  confirm (and skip the full scan) the way it was always meant to.

## [1.3.0] - 2026-07-02

### Added
- **Sync Results table.** After a fine tune / Auto Sync, a glanceable summary
  shows one row per coarse-aligned track and per fine-tuned clip: the shift
  applied, the signal it matched via (timecode / timestamp / head / full, or the
  reference clip), and a color-coded confidence score — so "which track failed
  and why" no longer requires scrolling the log.
- **✕ Cancel button.** Long operations (coarse scans especially) can now be
  stopped at any time: every in-flight ffmpeg/ffprobe child is killed and the
  pipeline unwinds cleanly without applying partial adjustments.
- **↩ Revert.** One click undoes exactly the shifts the last fine tune applied
  (including the boundary compensation), using each moved clip's post-move start
  ticks reported back by ExtendScript — a working undo despite Premiere's
  scripting API having no undo grouping.
- **Clock-drift detection.** On overlaps longer than 10 minutes, the fine pass
  also correlates a window near each END of the overlap; if the residual lags
  diverge (> 40 ms) it reports the drift and rate (ppm) — naming the one class
  of misalignment a single offset cannot fix, with the workaround (split long
  clips) in the message.
- **ffmpeg / ffprobe detected at panel load**, shown as ✓/✗ chips in the footer
  with an install hint — a missing tool is now known before clicking anything,
  not discovered mid-run. On macOS the Homebrew/manual install locations are
  probed too, since GUI apps don't inherit the shell PATH.
- **Persistent envelope cache.** Decoded audio envelopes are cached on disk
  (keyed by file path + mtime + size + slice/resolution, auto-pruned after 30
  days), so re-running a sync on unchanged media skips ffmpeg entirely — the
  dominant cost of a re-run. The in-memory cache is still cleared per run;
  changed files change the key, so stale audio can never be served.
- **Skipped-clip reporting.** Scan and Fine Tune now count clips they could not
  read (offline media, no file path) and say so, instead of silently showing
  fewer clips than the sequence contains.
- **`-SYNC` guard.** Auto Sync refuses to run on an already-built `-SYNC`
  sequence (which would clone it into `X-SYNC-SYNC` and re-shift aligned clips);
  the manual Build button warns but allows it.

### Changed
- **Scan is parallel.** Per-file record-start resolution (ffprobe + stat) now
  runs through the same bounded pool as the audio passes instead of serially —
  several times faster on multi-clip sequences.
- **One ffprobe pass per file.** The record-start tags and the start timecode
  used to be two separate ffprobe spawns per file; they are now read in a single
  cached probe, halving process spawns during Scan.

### Fixed
- Sequence names, clip names and file paths are HTML-escaped before being
  rendered into the panel — a sequence named `<b>Day 1` no longer breaks the
  header markup.
- The busy row now actually carries its `busy-row` class, so the spinner row
  lays out as designed.
- The ffmpeg availability check no longer runs a synchronous spawn on the UI
  thread at the start of every first fine tune.

## [1.2.0] - 2026-06-30

### Added
- **Timecode-predicted coarse align.** The whole-track coarse pass now plans its
  search windows from embedded SMPTE timecode and record-start timestamps before
  falling back to blind head/full scans, so large clock offsets are found faster
  and more reliably. The window math and selection policy are extracted into pure,
  unit-tested helpers (`planCoarseSearch` and friends in `js/dsp.js`).
- **Spurious-match guard.** A best lag pinned to the ±search boundary (`atRail`)
  is now flagged so a boundary guess is distrusted rather than applied.
- **Sony MXF record-start support.** Scan now reads `modification_date` (verified
  as the recording start) in addition to `creation_time`.
- **Busy indicator.** A spinner + phase label stays up for the whole operation and
  the progress bar shimmers, so a long ffmpeg decode never looks frozen.
- **Active-sequence freshness.** The panel polls the active sequence while idle and
  flags the scanned clip data as stale when you switch sequences in Premiere.

### Changed
- **Parallel ffmpeg passes.** The per-clip coarse/fine decodes (mutually
  independent) now run several at a time via a bounded pool, the biggest speedup
  for multi-clip projects.
- **Faster fine pass.** The compare window drops from 20 s to 10 s and from three
  window positions to two, roughly halving per-clip decode while keeping ≥5 s of
  overlap at the search extreme.
- **Manual Fine Tune is now the fine pass only.** The coarse whole-track align runs
  as part of ⚡ Auto Sync; the manual button does the fast ±5 s per-clip polish.
  The three manual steps are presented as a numbered step card.

## [1.1.0] - 2026-06-29

### Added
- **⚡ Auto Sync button** — runs Scan → Build Sync → Fine Tune in one hands-off
  click, stopping early with a clear message if a step can't proceed. The
  original three buttons remain as "Manual steps".
- **Embedded metadata timing source.** Scan now reads each clip's embedded
  `creation_time` via `ffprobe` (the true recording start) in preference to file
  `mtime`, falling back to `mtime − duration` when `ffprobe` or the tag is
  unavailable. The Detected Clips table tags each row `meta` or `mtime`, and the
  panel warns when a project mixes both sources.
- **Coarse auto-align pass in Fine Tune Audio.** Before the ±5 s fine pass, each
  track now has its longest clip matched against the **full** reference recording
  (a low-resolution envelope slid across the whole thing), and the whole track is
  shifted by the single offset found. This handles **large, minute-scale** clock
  differences between devices that the fine pass can't reach — automating what
  previously required manually dragging each track. Coarse and fine shifts are
  merged so each clip moves exactly once.
- **Unit tests** (`node --test`) for the pure DSP/anchor/format functions, now
  extracted into `js/dsp.js`, plus a `node scripts/check-syntax.js` syntax gate
  and a GitHub Actions CI workflow.
- **ZXP packaging** (`npm run build:zxp`) and a single-source version script
  (`scripts/set-version.js`) that keeps `VERSION`, the manifest, the footer and
  `package.json` in sync.
- **Tag-driven releases** (`.github/workflows/release.yml`): pushing a `vX.Y.Z`
  tag builds and self-signs the ZXP and publishes a GitHub Release with it
  attached, so distribution is a single download + extension-manager install.
- Repository metadata (`package.json` repo/homepage/bugs) and an MIT `LICENSE`.

### Changed
- **Renamed the extension from DateModSync to Syncitol** to reflect that it now
  syncs from embedded recording metadata and audio, not just file modification
  dates. The CEP bundle ID changed (`com.datemodsync.panel` →
  `com.syncitol.panel`), so Premiere treats it as a new extension — remove the
  old DateModSync panel if you had it installed.
- **Reference track is now auto-detected by content, not track position.** Fine
  Tune picks the track with the most total recorded coverage (the continuous main
  camera / program recording / field-recorder WAV) as the reference and aligns
  every other track to it. Previously the lowest track was assumed to be the
  reference, which broke if the main recording sat on a higher track (e.g. b-roll
  on V1, main camera on V2). Order no longer matters.
- **Build now anchors every track to one global wall clock** instead of giving
  each track its own independent `t=0`. With trustworthy `creation_time`, tracks
  line up automatically at Build time (within clock accuracy), so a program
  recorder and a camera that started minutes apart no longer land minutes out of
  sync. This is what made the previous manual track-drag necessary. The coarse
  pass is now gated to a high confidence so it cannot override these
  timestamp-based positions on weakly-correlating audio (e.g. board feed vs.
  camera mic).
- Record-start time is now computed once in the panel and passed to ExtendScript,
  removing a duplicated formula. Shared constants (`TICKS_PER_SECOND`, the
  24-hour span limit, fine-tune thresholds) are now named in one place per
  runtime.
- `evalScript` now surfaces structured `{ error }` payloads uniformly, and the
  two remaining ExtendScript entry points are wrapped in try/catch so failures
  carry a message instead of a bare `EvalScript error.`

### Fixed
- **Fonts are now bundled locally** (`fonts/`, IBM Plex woff2 under the SIL OFL)
  instead of fetched from Google Fonts, so the panel renders identically offline
  and behind network restrictions. Also lifted low-contrast UI text colours to
  meet WCAG AA.
- Bounded the fine-tune envelope cache (cleared per run) so it can no longer grow
  for the panel's lifetime.
- Guarded `JSON` usage in ExtendScript with a polyfill (`jsx/json2.js`) loaded
  ahead of `sync.jsx` for hosts without a native `JSON` object.
- Removed dead code (`findProjectItemByPath`) and corrected version drift across
  the manifest, footer and `VERSION`.

## [1.0.1] - 2026-05-18

### Fixed
- **Audio-only clips (e.g. field-recorder WAV) are now positioned correctly in the SYNC sequence.**
  Previously, audio-only tracks were anchored independently to t=0, placing them at the wrong
  wall-clock position relative to the video clips. They are now anchored to the global earliest
  recording start across all tracks, so their content lands at the correct timeline position
  before Fine Tune Audio runs.
- **Fine Tune Audio now aligns each video clip individually to the field-recorder reference,
  rather than shifting the field recorder once to best-fit a single video clip.**
  Audio-only clips on Audio Track 1 (track index 0) are now treated as the base reference layer
  (layerOrder 0). Video clips (layerOrder = trackIndex + 1) are each compared against the
  reference and shifted by their own computed offset. Their linked audio on Audio Track 2 is
  moved automatically via the existing filePath + startTicks matching logic.
- **Fine Tune Audio no longer fails silently when a clip sits too close to the sequence start.**
  Applying a negative shift to a clip within the first fraction of a second of the timeline
  caused Premiere to return `Invalid parameter`, leaving the clip unmoved with no explanation.
- **Fine Tune Audio now handles boundary clips hands-free.**
  When any fine-tuned clip would land before position 0, all clips in the sequence are shifted
  forward by the minimum amount needed to accommodate the move. Fine-tuned clips receive their
  waveform-computed delta on top of this global offset, so relative alignment across all tracks
  is fully preserved. A log line reports the compensation amount applied.

## [1.0.0] - 2026-05-17

### Added
- Initial DateModSync CEP extension release.
- Sequence scan and mtime-based sync sequence generation.
- Fine Tune Audio workflow powered by ffmpeg waveform correlation.
- In-panel instructions and compatibility guidance.
- README documentation for install, usage, and caveats.

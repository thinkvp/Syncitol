# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog and this project adheres to Semantic Versioning.

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

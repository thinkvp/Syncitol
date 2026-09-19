# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog and this project adheres to Semantic Versioning.

Syncitol's version numbering reset to 1.0.0 at the public GitHub launch.
The earlier internal history is a **separate 1.x line** that ran to its own
1.4.0 before that reset — unrelated to the 1.4.0 below — and is preserved in
[CHANGELOG-legacy.md](CHANGELOG-legacy.md).

## [1.5.0] - 2026-09-19

### Fixed
- **A clip's video and audio could be pulled apart without a word.** Syncitol
  computes one delta per source FILE and hands it to every timeline instance of
  that file, so the two halves are never *asked* to move apart — but the host
  can still refuse or alter a single move (a locked track, a destination
  blocked by a neighbouring clip on that track, an item whose action could not
  be built), and `applyStarts` queued each item independently, counted every
  `addAction` as a success without reading its documented boolean return, and
  reported per-item failures only to the developer console. One refused move
  therefore tore that clip's link group silently. Now:
  - moves are built and queued **per file, all or nothing** — if any instance
    of a file cannot be moved, none of them are, and the file is reported as
    left unsynced rather than torn;
  - `addAction`'s return value is honored;
  - every apply (build, fine tune, revert) **reads the timeline back** and
    compares each file's instances, so a move the host accepted and then did
    not perform is caught. Torn files are named in the log and in Sync Results
    with what each instance actually did and what to do about it. A file whose
    instances all moved together but not exactly as asked (frame snapping) is
    reported separately as harmless.
  - timeline items the scan could not read at all — no media path, or a getter
    that threw — are now surfaced as a warning instead of being dropped
    silently, since an unread item is one that never moves while its partner
    does.

### Added
- **Audio reference dropdown.** The Active Sequence card now carries an
  **Audio reference** picker, default **Auto**, listing every track that has
  clips. Choosing one forces the alignment to use the recordings on that
  track as its reference instead of the automatic pick (the track with the
  most recorded coverage). Selecting a track selects the *files* sitting on
  it, so forcing a camera's linked-audio track picks that camera even though
  its anchor is the video instance. A forced track that holds no usable clip
  — or that holds *every* clip, leaving nothing to align to it — falls back
  to Auto and says so in the log. The choice is session-only (never
  persisted: a track index means nothing in the next project) but survives
  Auto Sync's original → `-SYNC` switch, since the Build clone keeps the
  track layout.
  - New pure `dsp.planReferenceLayer()` owns the decision (unit-tested);
    `buildFineTuneAnchors(clips, forcedRefTrackKey)` marks the layers from it.
  - New `premiere.listTracks()` reads the track inventory without touching
    `getMediaFilePath()`, so the dropdown can follow the active sequence
    cheaply.
- **Copy the log.** A **⧉ Copy** button on the Log header puts the whole log on
  the clipboard, and the log text is selectable where the UXP build allows it.
  Reporting a bad sync no longer means retyping or screenshotting the panel.

## [1.4.0] - 2026-08-23

### Removed
- **Manual steps are gone.** The panel's three-step card (Scan Sequence /
  Build Sync / Fine Tune) and its instructions sections have been removed;
  **⚡ Auto Sync** is now the single entry point. The manual Fine Tune button
  ran the fast per-clip pass *only*, with no coarse whole-track phase, so
  reaching for it on footage with minute-scale clock offsets produced a
  confidently-reported result that was still minutes out. Removing the
  half-pipeline removes that trap — `fineTuneAudio()` no longer takes a
  `coarse` option and always runs both phases.
- **The CEP extension is discontinued.** Syncitol is now a UXP-only plugin
  requiring Premiere Pro 26.0+. The `cep/` tree, its CI and release
  workflows, and the CEP ↔ UXP version-sync gate have been removed from the
  repository. Existing releases keep their CEP `.zxp` and Windows installer
  `.exe` assets — they remain downloadable, unsupported and as-is — but no
  further CEP builds will be published.

### Changed
- The changelog moved from `cep/CHANGELOG.md` to the repository root, where
  it now covers the UXP plugin alone.
- `uxp/README.md` was folded into the root `README.md`. With one plugin left
  there is no reason to send users a directory deeper for install steps.

### Added
- The post-sync tips card now reports what the run actually did — total
  footage synced, clip count, and elapsed time — instead of a bare "Synced!".

### Documentation
- **Documented the macOS security prompt.** On first run after installing,
  Premiere reports that it can't load the plugin until Syncitol is approved
  under System Settings → Privacy & Security → Allow Anyway. The addon is
  unsigned because notarization requires a paid Apple Developer membership,
  which this free plugin does not carry.

## [1.3.0] - 2026-08-03

### Fixed
- **A/V links no longer break on Build.** A clip's video could be moved to
  its record-time position while its linked audio stayed behind, and Fine
  Tune would then shift the two apart further still. Per-track anchoring
  (1.1.0) placed each timeline instance from its own track's anchor, but
  camera-audio tracks are absent from the per-file clip list, so their
  anchor was undefined — the UXP panel silently skipped those clips and
  the CEP panel moved them by `NaN`.

  All placement and alignment is now keyed by **source file**: one delta
  per file, applied to every timeline instance of it. A clip's video and
  audio can no longer be moved independently.
- **Coarse align now compares against every clip on the reference track,**
  not just the longest one. A recording belonging to a different session
  than that single clip had no correct answer available and settled on
  whatever noise peak scored highest.
- **Clips that open with silence are no longer misaligned.** Probes were
  taken from the head of a clip; recorders left running before a shoot
  begin with minutes of room tone, and a flat probe correlates with any
  other quiet stretch — producing a confident-looking match minutes out of
  position. Probe windows are now chosen by audio content.
- A fine-tune match implying more than 500 ppm of clock drift is now
  rejected rather than reported. No real pair of devices drifts that far
  apart, so such a match is correlated noise, not shared audio.

### Added
- **Offset confirmation.** Every coarse offset is re-checked against a
  second, independent stretch of the same recording before it is applied.
  A match that came from room tone won't reproduce elsewhere in the file,
  so it is now reported honestly instead of silently applied. Confirmation
  runs before an offset is published as a hint to other tracks.
- **Per-channel relay matching.** Tracks that match nothing on the
  reference track are retried against the tracks that did align, one audio
  channel at a time. A lav recorder correlates poorly with a different lav
  — each is dominated by its own wearer — but almost perfectly with the
  camera channel that recorded the same microphone, which a multi-channel
  mix buries under the other channels. Runs entirely off Premiere's peak
  cache, so no media is decoded.
- Relay probe windows are spread across the whole recording, so a recorder
  that started before the cameras isn't stuck probing a stretch nothing
  else was rolling for.
- Clips whose record-start came from file mtime in a project where device
  clocks disagree about the date no longer have their Build position
  trusted on a weak match score.
- The log now names the reference clip and channel behind each match, the
  probe positions used, and — when alignment fails — the best-scoring
  candidates, so an unexpected result can be diagnosed from the log alone.

### Changed
- Sync Results now shows which reference clip (and channel) each track
  matched against, not just the search method.

## [1.2.0] - 2026-07-24

### Added
- **macOS UXP support:** the UXP plugin now ships a universal macOS addon
  (arm64 + x86_64) alongside the existing Windows addon. Mac users on
  Premiere 26+ can now use the UXP version with bundled FFmpeg — no system
  install needed.
- **Combined releases:** CEP and UXP now release together under a single
  `v*` tag. Each release bundles all four artifacts: UXP `.ccx` (Windows +
  macOS), CEP Windows installer `.exe`, CEP `.zxp`, and source archives.
- **CEP ↔ UXP version sync:** CI enforces that both plugins stay at the
  same version across all CI and release workflows.
- CEP ZXP now included in every release alongside the Windows installer.
- macOS addon build infrastructure: CMake build for `syncitol.uxpaddon`,
  CI-friendly FFmpeg 8.1.2 static build script with audio-only LGPL config.
- `workflow_dispatch` trigger on CEP release workflow for manual ZXP builds.

### Changed
- Documentation updated throughout for macOS UXP availability and combined
  releases.
- UXP `build-ccx.js` now includes macOS addons alongside Windows when
  present — a single `.ccx` targets both platforms.
- FFmpeg 8.1.2 x86 inline assembly disabled on macOS (`--disable-inline-asm`)
  for Clang 16+ compatibility.

## [1.1.0] - 2026-07-22

### Changed
- **Per-track anchoring:** each track now anchors to its own earliest clip
  instead of a single global anchor. A device whose clock is set to the
  wrong date (factory reset, dead battery) no longer pushes correctly-dated
  clips from other tracks past the 24-hour timeline limit. Cross-track
  alignment is handled by the audio coarse + fine tune passes.
- The Detected Clips table now shows offsets relative to each clip's own
  track earliest, not a global earliest.
- 24-hour span guard now checks per-track instead of globally, with a
  friendly info note when device clocks differ wildly but individual tracks
  stay within limits.

### Fixed
- CEP: multi-track audio groups unlinked by `clip.move()` during Build are
  now re-linked after placement (video + audio spanning 2+ tracks).
- CEP: `buildSyncSequence` now correctly escapes the payload through a JSX
  global (`$.timeSyncPayload`) rather than inline string interpolation,
  avoiding path-escaping bugs on Windows.

## [1.0.0] - 2026-07-10

### Added
- Public GitHub release, alongside the new UXP-based version of Syncitol.
- Ko-fi tips link in the panel footer.
- Windows installer (`Syncitol-CEP-Setup-<version>.exe`, built with Inno
  Setup) that sets the required `PlayerDebugMode` registry keys and copies
  the extension into place — no more manually editing the registry.

### Changed
- New pill/EKG-pulse brand icon in the panel header, matching the UXP port.

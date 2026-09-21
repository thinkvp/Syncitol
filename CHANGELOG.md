# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog and this project adheres to Semantic Versioning.

Syncitol's version numbering reset to 1.0.0 at the public GitHub launch.
The earlier internal history is a **separate 1.x line** that ran to its own
1.4.0 before that reset — unrelated to the 1.4.0 below — and is preserved in
[CHANGELOG-legacy.md](CHANGELOG-legacy.md).

## [1.6.0] - 2026-09-21

### Fixed
- **A clip’s audio could come off its video and the integrity check would
  call it clean.** `diffInstanceMovement` compares how far a file’s instances
  MOVED, not where they ended up. Two instances that move by the same amount
  pass it — even when the audio is sitting two seconds off the picture the
  whole way. Every existing guard was built on that one measurement, so a
  whole class of tear was structurally invisible: reported in the field as
  ~50% of a track’s clips unlinked, with a log showing no warnings at all.

  There is now an absolute check alongside it. `dsp.auditLinkAlignment` reads
  where each file’s video and audio actually sit and compares them to EACH
  OTHER — which is what makes it safe to act on, since both instances are on
  the same sequence’s frame grid and snapping cancels out, with no frame rate
  to guess at. After every apply, any clip whose audio came off its picture
  during that apply has the audio slid back underneath it, and the log says
  which clips and by how much. A clip that arrived out of step is reported but
  left alone — that offset may be deliberate.
- **An unreadable item could be left behind by the partner it travels with.**
  Items with no resolvable media path are carried along with the clip they are
  linked to, but each was keyed as its own all-or-nothing group, so the host
  could refuse it alone and split the pair. They now share their partner’s
  group and move with it or not at all.
- **The tear repair no longer acts on a pairing it cannot trust.** A file cut
  into several pieces on one track is paired before/after in time order, which
  only holds while the pieces move together — exactly what is in doubt when a
  tear is being repaired. Those files are now reported rather than moved, so a
  repair cannot relocate a clip while trying to mend one.
- **A track could be abandoned because the one clip standing in for it had
  nothing to offer.** The coarse pass picked a single clip per track — the
  longest on the timeline — and gave the whole track up the moment it failed,
  however many usable clips sat beside it. Found in the field: a 44-clip track
  was represented by a 27-second clip with no usable audio, reported "best
  score n/a", and was left 20 minutes out of sync. Three things were wrong:
  - **The search now tries other clips from the same track.** Up to four, in
    descending timeline length, whenever the track has no confident answer. An
    offset that was confident and then failed confirmation is still handled by
    the relay pass — that is a wrong answer, not a missing one.
  - **A clip with a flat waveform is skipped before it is searched.** Pearson
    correlation divides by the signal energy about the mean, so a silent clip
    makes `slideMatch` return null at every lag — "no match at all" rather
    than a low score, which is why it looked like a mystery rather than a
    quiet clip. `dsp.envelopeActivity` catches it from an envelope the setup
    already computes.
  - **The probe-window picker no longer gives up on short clips.** Callers ask
    for a probe as long as `min(clipLength, 120s)`, so on any clip under the
    cap the request equalled the whole envelope and one sample of rounding
    returned "no window at all" — silently disabling the relay retry and the
    multi-point confirmation for every clip shorter than two minutes. A clip
    shorter than the request now simply means the window is the clip.
- **"The coarse offset for this track is probably wrong" fired on healthy
  tracks.** The check counted every unmatched clip as a failure, including
  clips sitting outside the reference recording’s span entirely — which have
  no reference to fail against and say nothing about the track. With a
  reference that covers only part of the shoot that is most of the track: one
  field log warned about a track where 109 clips agreed on the same correction
  to within 10 ms. Only clips that had a reference and still failed now count,
  and the out-of-range ones are reported separately as a gap in the reference.
  They are still given the track’s consensus shift, as before.
- **The "How to use Syncitol" panel squeezed its text instead of scrolling.**
  Its body was a flex column whose sections shrank to fit the panel height, so
  on a short panel the whole guide compressed into an unreadable block. The
  sections now keep their natural height and the body scrolls.
- **The Audio reference dropdown listed video tracks.** Forcing a track selects
  the *files* on it, and a camera clip's picture and sound are the same file, so
  "V1" and "A1" picked exactly the same recordings — confusing under a control
  labelled Audio reference. The list is audio tracks only now. A sequence with
  no populated audio track leaves the menu empty, which is right — there is no
  audio to align anything to. Auto is unaffected and still considers every clip
  whatever track it is on.
- **The coarse pass could put a whole track in the wrong place, confidently.**
  It matched ONE clip per track against the reference and then shifted every
  clip on that track by what it found. If that one clip matched the wrong part
  of the reference — a music bed, a repeated announcement, a stretch of room
  tone — the entire track went minutes out, and the only check on it was a
  second window of the *same* clip, which cannot catch that error. Three
  safeguards now stand between a match and a track-wide move:
  - **Long clips are probed across their whole length.** A clip over 90 s picks
    its probe windows one per quarter of the recording instead of taking the two
    liveliest stretches wherever they fall — on a long clip both of those
    routinely landed in the same few minutes, which made the confirmation pass
    nearly worthless. The offset must now hold at more than one of them.
  - **The offset is re-tested against the track’s other clips.** This is the
    question the coarse pass is actually answering, and only a different
    recording can answer it. Clips that cannot be compared count as no evidence,
    never as dissent. If the dissenting clips agree with each other on a
    different offset, that is the better-supported answer and it is adopted; if
    they merely contradict it, the track is left to the fine pass.
  - **The fine pass is read back as an audit of the coarse one.** When most of a
    track fails to match, the log says so — that is what a wrong coarse offset
    looks like from the other side. When several clips on a track needed the
    same correction, that correction is also applied to the clips on that track
    the fine pass could not match; they are one device with one clock error, and
    their track-mates are better evidence than leaving them where they are.
- **A long fine-pass match is now checked at both ends of the overlap.** A
  single window scoring well only proves the two files share *that* stretch of
  audio. Any overlap over 120 s is matched near both ends and the two lags must
  agree before the shift is applied, with a tolerance that grows with the span
  so genuine clock drift still passes. This replaces the old drift check, which
  did the same two measurements but only from 10 minutes of overlap and only
  ever rejected the most extreme disagreements.
- **Clips could still come unlinked during a sync.** 1.5.0 made the tear
  *visible*; this release makes it not happen, and repairs it when it does.
  Three holes are closed:
  - **A refused move is rolled back.** `applyStarts` built a file's moves
    all-or-nothing, but still *queued* them one at a time: if the host refused
    the third of four, the first two were already in the compound and the file
    came out half-shifted. A move is a delta, so the inverse of each accepted
    move is now queued behind it — the file is left where it started, whole and
    unsynced, and said so in the log.
  - **A tear is now repaired, not just reported.** After every apply the
    timeline is read back as before; if a file's instances landed unevenly,
    Syncitol first nudges the stragglers onto the requested position, and if
    that will not take, moves every instance of the file back where it started.
    Unsynced with its A/V intact beats synced-and-torn. Only spreads above
    10 ms are acted on — anything smaller is the host snapping a video item to
    the frame grid, which is sub-frame and harmless.
  - **Links the per-file rule cannot see are honoured.** One delta per source
    file keeps a camera clip's own picture and sound together because they
    share a path. It does nothing for audio linked from a *different* file
    (merged clips, Synchronize, a manual Clip > Link) or for items whose media
    path will not resolve — those were moved apart from their partners every
    time. UXP exposes no link API, so link groups are now inferred from items
    that occupy exactly the same span across both media types, and moved as one
    on the picture's shift. Unreadable items are carried along with the clip
    they are linked to instead of being left behind; a group that no single
    shift can satisfy is left alone and named in the log.
- **There was no way to get the log out of the panel.** The Copy button always
  failed — it reached for `require("uxp").clipboard`, which does not exist, and
  the plugin never held the `clipboard` manifest permission that gates the real
  API — and the log could not be selected with the mouse either, because UXP
  only implements text selection inside form controls, so `user-select: text`
  on the log was never going to do anything. Both are gone, replaced by one
  button that writes a file.

### Changed
- **The build lays tracks out by the clock when the clocks agree.** Every
  track used to anchor to its own earliest recording, so every track started
  at 0:00 and the audio coarse pass had to rediscover the minute-scale offsets
  between devices from nothing. That is the right call when a device’s clock
  is wrong — a camera reset to 2000-01-01 would otherwise be placed years from
  everything else — but it threw away good information the rest of the time.
  Tracks whose recordings overlap in clock time now corroborate each other and
  share one anchor, landing at their true offsets from one another, so the
  audio pass starts close in and only has to fine-tune. Grouping is
  transitive, so a recorder that ran across two sessions vouches for both
  cameras even though they never overlapped each other.

  The fallback is per-track rather than all-or-nothing: a track nothing
  corroborates keeps its own anchor and starts at 0:00 exactly as before, so
  one camera with a dead clock battery no longer costs the other four their
  layout. Clips timed from the `mtime` fallback never join a group — that
  start is "file date minus duration", which is wrong by however much the OS
  touched the file on copy. A group that would not fit a timeline’s 24-hour
  maximum is refused too. The log says which tracks went which way, and the
  Detected Clips table’s Offset column shows the layout that will be built.

  **Consistent timestamps are checked for being real ones.** A bulk download
  from Google Drive or Dropbox rewrites every file’s date to when it arrived;
  a batch transcode or proxy render writes a fresh `creation_time` into every
  output; a camera with an unset clock stamps them all identically. All three
  look perfectly self-consistent and would otherwise have been laid out on.
  So the plan tests the one thing none of them can fake: **one device cannot
  record two files at the same time**. If a track’s own clips claim
  overlapping recording times, those are batch-processing timestamps — the
  track is excluded from the clock layout, flagged in the log, and its Build
  position is no longer treated as evidence by the coarse pass. The test is
  deliberately per-device rather than "these timestamps cluster too tightly":
  genuine multicam footage really does have every camera starting within
  seconds of the others, and a cluster test would have discarded it. There is
  also a separate warning when the `mtime`-derived file dates bunch into a
  window far too short for the footage they cover, which is what a bulk copy
  looks like from the filesystem side.

### Added
- **Update check.** Syncitol asks GitHub once a day whether a newer release
  exists and shows a banner when one does; dismissing it suppresses that
  version, not the next. Clicking the version number in the footer checks
  immediately and says so either way, falling back to just opening the
  releases page if the request cannot get through. Every failure mode — no
  network, a rate-limited API, an unparseable tag — is silent on the automatic
  check, and a version it cannot parse is never reported as an update. This
  adds one manifest permission: network access to `https://api.github.com`.
- **⬇ Export .txt** writes the whole log to a file through a save dialog (or
  the plugin's data folder on a build with no picker, with the path logged).
  Send that with a bug report and the whole sync can be replayed from it.

### Removed
- The Copy button, and with it the `clipboard` permission the plugin no longer
  needs.

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

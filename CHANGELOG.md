# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog and this project adheres to Semantic Versioning.

Syncitol's version numbering reset to 1.0.0 at the public GitHub launch.
The earlier internal history is a **separate 1.x line** that ran to its own
1.4.0 before that reset — unrelated to the 1.4.0 below — and is preserved in
[CHANGELOG-legacy.md](CHANGELOG-legacy.md).

## [Unreleased]

### Added
- **Timelines that aren't one device per track now sync.** Every stage of
  the sync treats a track as one recording device. Two cameras on V1 looked
  like one camera whose clips overlapped in time, which reads as
  batch-stamped timestamps, so the whole track's clock was thrown away and
  the audio pass worked from nothing. Syncitol now works out which device
  recorded each file. Hard evidence is the container, picture vs sound-only,
  the camera model and serial from Sony `<clip>M01.XML` sidecars, and
  embedded clocks that say two files were recording at once. Folder, bin and
  file-name pattern keep files apart without proving anything. When a track
  provably holds two devices, the `-SYNC` sequence is built fresh instead of
  cloned: the clone is emptied and every file is placed whole from the project
  onto its device's own block of tracks, at its recording time, before the
  audio pass runs as usual. Sequence settings carry over from the original.
  Trims, effects and titles do not, and the log says so.
- **Shoots over several days.** The build lays clips out by their
  recording clock, so a two-day shoot put day 2 a full night after day 1.
  That timeline ran past Premiere's 24-hour timecode, and the build refused
  it ("process one recording day at a time"). Syncitol now finds the
  recording sessions: runs of footage across every device with no break
  over two hours. It closes the gaps between them to five minutes. Within a
  session nothing moves, so each device keeps its offset from the others,
  and its clock error is the same on every day. With the gaps closed, every
  clock-dated track shares one anchor, so day 2's cameras land after day 1's
  instead of starting at 0:00. A sequence marker names each day ("Day 2",
  with the recording date). Only embedded clocks decide what counts as a day:
  files dated by a later copy or processing pass get no marker. A shoot that
  is still over 24 hours with the gaps closed now builds anyway. Premiere
  accepts it; only its timecode display rolls over.
- **Each recording day gets its own audio reference.** The audio pass used
  one reference track for the whole sequence: the one with the most
  recorded time. In a two-day shoot that is one day's device, so every
  track from the other day was searched against recordings it could never
  match. Each search fell through to whole-file decodes before giving up,
  which made a sync that took a minute per day run for 20 minutes or more.
  With the days closed up, each day now picks its own reference, and the
  coarse pass only compares clips from the same day.
  Recordings dated only by when they were copied or processed (no embedded
  clock) belong to no day. They are searched against every day's
  references, and never become a reference themselves. In a field test,
  DBTX-1 _001.wav was dated two days after the shoot, so it was made the
  reference of a "day" of its own, never aligned, and left sitting with
  the wrong day's footage.
- **"Check sync" markers and a one-line result.** Clips the fine pass could
  not vouch for get a sequence marker at their start, with the reason in the
  comment. Those are low-confidence matches (score under 0.5), clips it could
  not match, clips given their track-mates' shift, and outliers. The log
  opens its verdict with "Result: 140 clips — 10 reference, 118 matched, 6 to
  check (marked on the timeline), 6 outside every reference recording ·
  2 recording days · rebuilt by device".
- **A camera's clock off by whole hours or days is laid out where it
  belongs.** A wrong time zone, a missed daylight-saving change and a date
  reset after a flat battery all leave the minutes right. If shifting a
  track's clock by a whole number of hours lines its clips up with the main
  group's (at least two clips starting within 2 minutes of one there, and no
  other whole-hour shift coming close), the build lays it out there, and the
  audio pass only has to confirm. Before, such a track started at 0:00 and
  the audio pass searched for the multi-hour offset blind. Recurring
  same-time-every-day shoots are ambiguous, so they are left alone.
- **Gaps between recording days are tightened after the sync.** They were
  planned from the recording clocks, before the audio pass corrected them, so
  the finished gap was the 5-minute pad plus however wrong the clocks were.
  In a field test, a day ending on an FX6 10 minutes fast and the next
  starting on an A7S3 1.5 minutes slow left about 20 minutes. A clock error
  the other way could have made days overlap. Once every clip is in its
  final place, each later day slides, as one piece, to start a minute after
  the previous day ends. A "day" whose clips the sync put inside another day
  is merged into it, not moved.
- **Tracks are packed after the sync when the sequence was rebuilt by
  device.** The rebuild gives every device block its own tracks, because the
  analysis treats a track as one device. Once synced, blocks that never
  overlap in time share tracks: the same camera on two days, or two devices
  that never rolled together. Premiere can only slide clips along their own
  track, so the packed layout is placed afresh in a new copy of the original
  sequence. It replaces the first -SYNC only if every clip lands exactly;
  otherwise the unpacked one is kept. Revert is not available after packing.
- **Clear cache** (in the help panel, under "Speed and the cache") forgets
  the audio Syncitol has decoded (on disk and in memory) and the file
  metadata it has read, so the next sync decodes afresh and can be timed.
  Nothing to do with Premiere's peak files is touched.
- **The help panel is reorganised** into how it works, running a sync, the
  three options, clocks, how the alignment works, and speed. It was one long
  section, with the Audio reference note stranded under Recording days.
  Stale details are fixed: the fine pass's ±30 s re-search, Revert after
  packing, and the drift threshold.
- **The dropdowns show what Auto decided** after a run, e.g. "Auto · V3, V4",
  "Auto-detect · rebuilt by device", "Auto-detect · 2 days".
- **A note when Premiere has no peak files yet** for some clips. That happens
  right after import, or when a project opens in a new Premiere version, and
  it is the main reason a first sync is slow.
- **Elapsed time while syncing**, with "Step 2 of 4" and an estimate of the
  time left in the current step once it has run long enough to tell. The
  log's last line now breaks the run down by step (reading clips, building,
  coarse align, fine align).

### Fixed
- **A clip could be shifted seconds away from the rest of its camera on a
  weak match.** The fine pass applied any shift scoring 0.2 or more. One
  camera's clips share one clock error, so their corrections cluster within a
  second. A clip asking for more than 1.5 s away from its track-mates'
  typical shift now keeps its own shift only on a strong match (0.75 or
  more). Otherwise it takes the typical shift. Either way it is marked to
  check. In a field log, C9370 had been moved −4.12 s at score 0.52 while 30
  clips from the same A7S3 sat within ±0.8 s.
- **Clock-drift warnings on short clips were noise.** The help said drift is
  checked on overlaps over 10 minutes, but warnings appeared from 2 minutes.
  At ±10 ms per measurement, that produced "164–515 ppm" on 3–7 minute
  clips, several times what real clocks drift. Drift is now only reported,
  in the log and as the results table's "drift" badge, when it reaches a
  frame (40 ms) across an overlap of 10 minutes or more. Under a frame it is
  invisible, and within the measurement noise. The badge had appeared for
  any measured drift, down to 10 ms.
- **A first sync spent minutes decoding audio it did not need.** The coarse
  pass matches a track from Premiere's peak files in a moment, but then
  confirmed that match by decoding real audio: two more points in the clip,
  plus the track's other clips. From a network drive that took about 4
  minutes on a field test's first run, and about 2 seconds once the
  envelope disk cache had those stretches. A match made on peak files is now
  confirmed on peak files. The log also says what each phase actually
  decoded and how long it took. The old line claimed "no audio decoded" even
  when the confirmation had decoded plenty.
- **The coarse pass's relay retry crashed after its search** ("relay
  unavailable: scanned is not defined"). It read a variable that only
  existed inside a loop, so the confirmation of a relay match never ran.
  This had been there since the relay pass was written.
- **Recording days dropdown.** **Auto-detect** (default) closes the gaps only
  when the clock-dated footage spans more than 24 hours, and at least one
  device (the same camera serial, or the same detected source) recorded in
  more than one session. Without that, every "day" is a separate set of
  devices, which is exactly what a camera with the wrong date produces. In a
  field test, an FX6 dated February and an A7S3 dated October, filming the
  same interviews, were split into two days, each camera its own day's
  reference, and nothing was aligned. That is now laid out as one day, and
  the log explains why. **Single day** keeps
  the old layout. **Multiple days** always closes gaps over two hours.
- **Track layout dropdown.** **Auto-detect** (default) rebuilds only when a
  track mixes devices. **Keep my tracks** always clones the timeline as it is,
  the old behaviour. **Rebuild by device** always rebuilds. The choice is
  remembered. A forced **Audio reference** follows its recordings into the
  rebuilt sequence. It names a track of the original timeline, and a rebuild
  puts those recordings on a different one.

## [1.7.0] - 2026-10-30

### Fixed
- **Interviews shot on a multi-channel camera synced some clips well and
  others a few frames off.** The fine pass only ever heard the camera's first
  audio stream, usually a lav. A lav hears its wearer and barely anyone else,
  but the other camera's internal mic hears the whole room. So any window full
  of an interviewer's questions or crosstalk had little to line up with, and
  scored weakly or a little wrong. A camera's own internal-mic channel would
  have matched almost perfectly.

  When the mix comparison scores below 0.70, the fine pass now tries every
  pairing of the two files' channels from Premiere's peak files (up to 8 per
  side). It takes a channel match only if it beats the mix by at least 0.10,
  since picking the best of many pairings flatters the winner. The two-point
  agreement check then re-tests the match on the same channels. The log names
  the pairing, e.g. `vs C0012.MXF ch3 (from its ch1)`. Clips whose mix already
  matched well are untouched. When either file has no peak file, nothing
  changes.
- **Two cameras trimmed to the same in/out were never synced.** The link-group
  check treats items with matching start and end across video and audio as
  one linked group, and needs every picture in a group to share one shift.
  Two camera clips cut to the same span looked exactly like that, so each pair
  was logged "Left alone … linked but need different shifts". In the field
  log that blocked 19 of 23 pairs, and the run adjusted 0 clips. A group is
  now only enforced when it holds audio from a file with no picture in the
  group, or an unreadable item, which is what a real cross-file link is. Each
  camera's own audio already moves with its picture.
- **The second-point check rejected good matches on the mixed audio.** It now
  measures on the channel pairing the match was made on. On a mix match, each
  point gets the per-channel fallback when the mix scores below 0.70.
  Rejection lines also show the disagreement and tolerance to the hundredth of
  a second instead of rounding them to "0s".
- **A clip more than 5 s from where the track's offset put it could never be
  synced.** The coarse pass gives a whole track one offset, and the fine pass
  only reaches ±5 s around it. But a device's clips don't all sit at one
  offset: timestamps have whole-second resolution, two clocks drift apart over
  a day, and now and then one clip's timestamp is just off. In the field an
  A7S3 ran 64–71 s behind an FX6, with C1031 at 55 s and C1020 at 79 s. Both
  were about 12 s out of reach, matched noise, and stayed out of sync. A clip
  the fine pass can't place is now searched again over ±30 s of the reference,
  at the coarse rate and one channel pairing at a time. Probes from three
  points in the overlap must agree, then the whole fine pass, including the
  second-point check, runs again from the new position. The shift stands only
  if that passes, and the log shows the wide offset plus the total.
- **The rescue pass gave failed clips a "consensus" shift that fit none of
  them.** It averaged the residuals of matched clips within 2 s of each other,
  so a spread of per-clip offsets became one meaningless correction: +0.41 s
  handed to two clips that were 12 s out. It now acts only when the matched
  clips agree within 0.15 s, which is what one shared clock error looks like.

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

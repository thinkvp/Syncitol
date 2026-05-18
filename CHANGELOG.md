# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog and this project adheres to Semantic Versioning.

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

# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog and this project adheres to Semantic Versioning.

Syncitol's version numbering resets to 1.0.0 with this release, alongside the
new UXP version and the public GitHub launch. Earlier internal version
history (up to 1.4.0) is preserved in [CHANGELOG-legacy.md](CHANGELOG-legacy.md).

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

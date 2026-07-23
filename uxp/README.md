# Syncitol (UXP)

Recording-time + audio-waveform multicam sync for Premiere Pro — a UXP plugin
with a bundled FFmpeg decoder.

Part of the [Syncitol](../README.md) project. On Premiere 24/25, use the
[CEP version](../cep/README.md) instead. Free — if this saves you a re-sync
session, consider tipping on [Ko-fi](https://ko-fi.com/thinkvp).

Syncitol resolves each clip's real recording start time (embedded
creation-time/timecode metadata, falling back to file dates), lays every clip
out on a new timeline so gaps match real clock time, then fine-aligns the audio
by waveform cross-correlation. One click ("Auto Sync") runs the whole pipeline.

- **No ffmpeg install.** The decoder is a bundled native hybrid addon
  (`win/x64/syncitol.uxpaddon` / `mac/*/syncitol.uxpaddon`, ~2.3 MB each) — a
trimmed, statically linked LGPL FFmpeg 8.1.2 (audio demuxers/decoders only).
  `probe()` reads metadata, `decodePcm()` decodes audio. No PATH setup, no
  external downloads.
- **Tiny install.** `npm run build` produces a ~2-5 MB `.ccx` (platform addons).

## Status

**Verified end-to-end on Premiere Pro 26.3 (Windows, x64)** against a real 30-file
two-camera shoot: Auto Sync (scan → build → coarse+fine align) syncs every
file, multi-track A/V link groups survive the build, and the coarse pass
resolves from Premiere's `.pek` peak cache with no audio decoding.

| Area | State |
| --- | --- |
| DSP / sync brain (`js/dsp.js`) | Envelope cross-correlation, coarse search policy, pek parsing, drift probes, learned-offset search — `npm test` 45/45 |
| Native FFmpeg addon | Compiled for Windows (x64) and macOS (universal: arm64 + x86_64), self-contained, verified in-panel |
| Host ops (`js/premiere.js`) | Verified live: scan, clone-based Build (**createMoveAction**, not createSetStartAction — see note), transactional shifts, undo = one step |
| Engine (`js/main.js`) | Staged coarse (pek → timecode → timestamp → learned → head → full), fine pass with rail guard, clock-drift report, cancel, boundary compensation |
| Caches | Envelope disk cache in the plugin data folder (30-day prune); `.pek`/`.mcdb` index via UXP fs |
| UI | Auto Sync, manual steps, Detected Clips + Sync Results tables, score badges, Revert, Cancel, active-sequence polling, instructions overlay |
| Packaging | `npm run build` → `dist/Syncitol-UXP-<version>.ccx` (minimal staging; never bundles native sources or shared FFmpeg DLLs) |

## Architecture (4 layers)

1. **DSP (pure):** `js/dsp.js` — envelopes, cross-correlation, coarse policy,
   `.pek` parsing, timecode. `buildEnvelope` takes an `Int16Array` (from the
   addon) and the pek readers accept `ArrayBuffer` (UXP fs) or Node `Buffer`
   (tests). Unit-tested with `node --test`.
2. **Audio (JS → native):** `js/audio.js` — wraps the addon; per-run memory
   cache + persistent disk envelope cache keyed by path+mtime+size+slice.
3. **Pek fast path:** `js/pek.js` — maps media → `.pek` via Adobe's `.mcdb`
   media-cache records and serves coarse envelopes straight from the peaks.
4. **Host (JS → UXP DOM):** `js/premiere.js` — scan, clone-based build, delta
   moves, rename, all inside `lockedAccess` + `executeTransaction`.

### Host API notes (verified on PPro 26.3)

- `createSetStartAction` throws "Invalid parameter" whenever a new start lands
  inside another clip's span — timeline reshuffles must use the delta-based
  **`createMoveAction`**.
- Moving an item does NOT move its linked items; shift every member of a link
  group by the same delta. Links (including 4-item MXF video+3×audio groups)
  survive clone + move — no re-link API is needed (UXP has none).
- `Constants.TrackItemType`: EMPTY 0, CLIP 1, TRANSITION 2, PREVIEW 3, FEEDBACK 4.
- UXP `<button>` widgets ignore author CSS backgrounds — actions are styled
  `<div class="btn">` elements with an `.is-disabled` class.

## Develop & test

- **Load:** UXP Developer Tool, or the CLI: `uxp service start`, then
  `uxp plugin load|reload --apps premierepro` from this folder.
- **Offline checks:** `npm run lint` (parse gate) and `npm test` (DSP suite).

## Install (users)

**Requires Premiere Pro 26.0+ on Windows (x64) or macOS (arm64 / x86_64).**
The bundled FFmpeg decoder is a UXP hybrid addon; Premiere 25.x loads the panel
but reports "Addon is not supported", so 26.0 is the real floor. On older
Premiere versions, use the [CEP version](../cep/README.md) instead.

1. Download `Syncitol-UXP-<version>.ccx` from the
   [Releases](https://github.com/thinkvp/Syncitol/releases) page (tagged `v*`).
2. Double-click it. Creative Cloud Desktop opens an **"Install a
   non-marketplace plugin"** dialog — click **Install**.
3. On Windows, you may be prompted for your account credentials as part of
   installing the addon (it needs filesystem access to read your media) — this
   is a normal elevation prompt, not a malware warning. On macOS, Creative
   Cloud handles the install silently.
4. Once you see "Syncitol is now installed", open (or restart) Premiere Pro
   and find the panel under **Window → UXP Plugins → Syncitol**.

No Developer Mode toggle, no manual signing, no Marketplace submission
needed — independent `.ccx` distribution just works, as long as
`manifest.json`'s `host` field is a single object (not an array — that's the
UXP-devtools-only dev-loop format, and using it in a packaged build causes a
generic, hard-to-diagnose "Couldn't install plugin" failure).

If you had the earlier `v1.0.0` build installed under the old plugin id, remove
it first (Creative Cloud → Manage plugins → uninstall, or UXP Developer Tool →
Remove) before installing a new one — the id changed and Premiere doesn't
treat it as an upgrade.

## Versioning & packaging

- `node scripts/set-version.js 1.2.3` — updates manifest, package.json and the
  panel footer together. Also bump `cep/VERSION` to keep both plugins at the
  same version (enforced by CI).
- `npm run build` — stages the runtime files only and zips them (forward-slash
  entries) into `dist/Syncitol-UXP-<version>.ccx`, failing if the package is
  suspiciously large.

### Releasing

Push a single `v*` tag; both release workflows run in parallel and attach
their artifacts to the same GitHub Release:

```bash
# In uxp/:
node scripts/set-version.js 1.2.0
# In cep/:
npm run set-version 1.2.0
# Commit and tag:
git commit -am "Release v1.2.0"
git tag v1.2.0
git push --follow-tags
```

All four artifacts land on the same release: UXP `.ccx` (Windows + macOS
addons bundled), CEP Windows installer `.exe`, and CEP `.zxp`. CI enforces
that CEP and UXP versions match.

## Licensing

Bundling FFmpeg means complying with the **LGPL v2.1+**: the addon links an
LGPL-configured FFmpeg 8.1.2 (`--disable-everything` + audio-only components),
no GPL components enabled. FFmpeg source: https://ffmpeg.org. IBM Plex fonts
under the OFL (`fonts/LICENSE.txt`). If distributed commercially, ship an
offer to provide the FFmpeg build scripts/objects for relinking.

## Build (native addon)

The addon source lives under `native/`. Build scripts:

- **macOS:** `bash scripts/build-ffmpeg-mac.sh universal` then
  `cmake -S native -B native/build -DFFMPEG_ROOT=./ffmpeg-out/universal -DCMAKE_BUILD_TYPE=Release`
- **Windows:** Visual Studio project at `native/uxp/win/syncitol.vcxproj`

CI builds both platforms on tag push (`v*`); the resulting `.ccx` bundles
addons for Windows (x64) and macOS (universal arm64+x86_64).

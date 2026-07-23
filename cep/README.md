# Syncitol (CEP) — Premiere Pro Extension

[![CEP CI](https://github.com/thinkvp/Syncitol/actions/workflows/cep-ci.yml/badge.svg)](https://github.com/thinkvp/Syncitol/actions/workflows/cep-ci.yml)

Part of the [Syncitol](../README.md) project. On Premiere 26+
(Windows or macOS), the [UXP version](../uxp/README.md) is simpler (bundled
FFmpeg, no system install). Free — if this saves you a re-sync session,
consider tipping on [Ko-fi](https://ko-fi.com/thinkvp).

Rebuilds real-world recording timing on a new Premiere Pro timeline from each clip's **embedded recording time** (`creation_time`, falling back to file modification date), then refines the sync with **audio waveform matching** — no timecode, genlock, or slate required.

Tested against **Adobe Premiere Pro 24, 25, and 26**.

- **Repository:** <https://github.com/thinkvp/Syncitol>
- **Download:** grab the latest release (tagged `v*`) from the [Releases](https://github.com/thinkvp/Syncitol/releases) page, then see [Installation](#installation).

---

![Syncitol panel screenshot](docs/screenshots/screenshot.jpg)

> _One-click **⚡ Auto Sync**, a **Sync Results** table showing each track/clip's shift, the signal it matched on (here `pek` — Premiere's own peak cache) and a confidence score, with **↩ Revert** to undo the last fine tune and an `ffmpeg`/`ffprobe` status readout in the footer._

---

## How it works

Syncitol needs each clip's **record-start time**. It resolves that per clip
from the best available source:

| Priority | Source | Detail |
|----------|--------|--------|
| 1 (preferred) | **Embedded `creation_time`** | Read via `ffprobe` from the media's metadata — the actual recording start. Accurate and survives copying. |
| 2 (fallback) | **File `mtime`** | `date modified ≈ when recording finished`, so `mtime − clip duration ≈ record start`. Used when `ffprobe` is unavailable or the file has no `creation_time` tag. |

Every clip is then placed on a new sequence so the gaps between recordings match
real clock time. The **Detected Clips** table tags each row with the source used
(`meta` = embedded metadata, `mtime` = file date).

> **Note:** when relying on the `mtime` fallback, preserve file dates while
> copying media — if the OS rewrites `mtime` on copy (some cloud sync tools do),
> the estimated record-start time will be wrong. Clips carrying embedded
> `creation_time` are unaffected.
>
> If a project mixes both sources, the panel warns you: the two have different
> semantics, so run **Fine Tune Audio** afterwards to correct residual drift.

---

## Compatibility

| Item | Requirement |
|------|-------------|
| **Premiere Pro** | 24 (2024), 25 (2025), 26 (2026) and later |
| **CEP runtime** | CSXS 11.0+ |
| **Node.js bridge** | CEP `--enable-nodejs` flag (already set in manifest) |
| **ffmpeg / ffprobe** | `ffmpeg` is required for **Fine Tune Audio**; `ffprobe` (ships with ffmpeg) enables the embedded `creation_time` timing source. Optional — the plugin falls back to `mtime` without them. Availability is detected when the panel opens and shown as ✓/✗ chips in the footer. On macOS the Homebrew locations (`/opt/homebrew/bin`, `/usr/local/bin`) are checked too, since GUI apps don't see the shell PATH. |
| **OS** | macOS or Windows |

---

## Installation

### Option A — Windows installer (recommended on Windows)

1. Download `Syncitol-CEP-Setup-<version>.exe` from the
   [Releases](https://github.com/thinkvp/Syncitol/releases) page (tagged `v*`).
2. Run it. It's unsigned, so **Windows SmartScreen may show "Windows
   protected your PC"** — click **More info → Run anyway**. This is expected
   for a free, independent, open-source installer; the source is right here
   in this repo.
3. The installer sets the registry flags Premiere needs to load an unsigned
   CEP extension and copies the extension into place — no manual steps.
4. Launch (or restart) Premiere Pro → **Window → Extensions → Syncitol**.

Uninstalling removes the extension files but deliberately leaves the registry
flags in place, since they're a shared systemwide CEP developer setting other
extensions may also rely on — not something this installer should own.

### Option B — Signed ZXP (Windows or macOS)

1. Download `Syncitol-<version>.zxp` from the [Releases](https://github.com/thinkvp/Syncitol/releases) page (or build it yourself with `npm run build:zxp`, see [Development](#development)).
2. Install it with a free extension manager such as [Anastasiy's Extension Manager](https://install.anastasiy.com/) or [ZXPInstaller](https://zxpinstaller.com/).
3. Launch Premiere Pro → **Window → Extensions → Syncitol**.

This needs no `PlayerDebugMode`. The release ZXP is **self-signed**, so the
extension manager may note an unverified publisher — that is expected.

### Option C — Manual / developer install (Windows or macOS)

Use this for development, or if you'd rather not run an installer or
extension manager.

#### Step 1 — Enable unsigned CEP extensions (one-time)

Premiere Pro won't load unsigned extensions unless the matching CSXS-version
debug flag is set. The CSXS number is tied to the CEP runtime bundled with
your Premiere version, not just the year, so rather than guessing one number,
set the whole range CEP has used in practice (extra keys are harmless):

**macOS** (Terminal):
```bash
for v in 9 10 11 12 13 14; do defaults write "com.adobe.CSXS.$v" PlayerDebugMode 1; done
```

**Windows** (Command Prompt):
```
for %v in (9 10 11 12 13 14) do reg add HKEY_CURRENT_USER\Software\Adobe\CSXS.%v /v PlayerDebugMode /t REG_STRING /d 1 /f
```

#### Step 2 — Copy the extension folder

Place the `Syncitol` folder into your CEP extensions directory:

| Platform | Path |
|----------|------|
| macOS    | `~/Library/Application Support/Adobe/CEP/extensions/` |
| Windows  | `%APPDATA%\Adobe\CEP\extensions\` |

Result: `.../CEP/extensions/Syncitol/CSXS/manifest.xml`

#### Step 3 — Launch Premiere Pro

Go to **Window → Extensions → Syncitol**.

---

## Usage

### Auto Sync (hands-off)

Make your **original** sequence the active one (double-click it in the Project
panel — not an already-built `-SYNC`; Auto Sync refuses those to avoid building
`X-SYNC-SYNC`), then click **⚡ Auto Sync**. It runs the whole pipeline in one
go — **Scan → Build Sync → Fine Tune** — and stops with a clear message if a
step can't proceed. A **✕ Cancel** button next to the busy spinner stops long
audio scans at any point without applying partial adjustments.

When it finishes, the **Sync Results** table summarizes the outcome: one row
per track (coarse align) and per clip (fine pass) with the shift applied, the
signal it matched via, and a color-coded confidence score — plus a **↩ Revert**
button that undoes exactly the shifts the last fine tune applied.

The Manual steps below do the same thing in stages if you want to inspect the
result between each one.

### Manual sync (step by step)

1. Open your project and make the sequence you want to sync the **active sequence** (double-click it in the Project panel).
2. In the Syncitol panel, click **↺ Scan Sequence**.  
   The panel reads every clip in the sequence and resolves its record-start time (embedded `creation_time` when available, otherwise `mtime`).
3. Review the **Detected Clips** table — it shows each clip's file name, type, estimated record-start time (tagged `meta`/`mtime`), and offset from the earliest clip.
4. Click **⏱ Build Sync Sequence**.  
   A new sequence named `[original name]-SYNC` is created and opened. Clips are placed at their real-clock-time positions; gaps between recordings are preserved.
5. Click **≈ Fine Tune Audio** to align the tracks precisely. As of v1.1 this is hands-free — a coarse auto-align pass pulls each track into range automatically, so the old manual track-dragging step is no longer required (see below).

### Fine Tune Audio

Fine Tune aligns tracks using **audio waveform cross-correlation** via ffmpeg in two automatic phases — no configuration and no manual pre-alignment needed.

It first picks a **reference track** automatically: the track with the most total recorded coverage (typically your continuous main camera, program recording, or a field-recorder WAV). Every other track is aligned to it. This is chosen by content, **not** by track position — so it does not matter whether your main camera is on V1, V2, or an audio track.

1. **Coarse auto-align (large offsets)** — for each non-reference track it matches **one** representative clip (the longest) against the reference recording and shifts the **whole track** by the offset found. To avoid decoding hours of audio, the search runs in stages across all tracks, cheapest predictor first: **Premiere's own peak files** (`.pek` — the waveform cache Premiere builds for every imported file; when both files have trusted peaks the whole-reference match takes milliseconds with **no audio decoding at all**), then a tight window around the **start-timecode** delta, then around the **Build position**, then around **offsets already proven by other tracks** (devices from one shoot share the same clock error), then the **head region** of each file, and only as a last resort the **full** reference.
2. **Fine residual** — each non-reference clip is then compared per-clip against the reference track to find the best sub-second shift, bringing every clip to 100%.

Click **≈ Fine Tune Audio** once; both phases run in sequence. Only net shifts greater than **20 ms** are applied — smaller differences are considered already aligned.

**How the fine phase works:**

- Searches for the best lag within **±5 seconds** of the (coarse-aligned) position.
- Extracts up to **10 seconds** of audio per comparison pair (needs at least **3 seconds** of overlap between clips).
- Samples the overlap at two positions — centred (50%) and early (20%) — to avoid locking onto an unrepresentative section.
- If the centred window already produces a strong match (confidence ≥ 0.70), the alternate window is skipped for speed.
- Each non-reference clip is compared against the reference track; the highest-confidence overlap determines the final shift.
- On overlaps longer than **10 minutes** it additionally checks for **clock drift**: the residual lag is measured near both ends of the overlap, and if they diverge by more than 40 ms the panel reports the drift and rate (ppm). A single offset can't fix drift — split long clips before syncing when flagged.

Decoded audio envelopes are **cached on disk** (invalidated automatically when a
file changes), so re-running a sync on unchanged media skips the ffmpeg decode —
by far the slowest part — and completes in seconds.

> **Manual fallback:** for footage where a track has no usable overlapping audio (so coarse align can't lock), you can still drag that track roughly into place with the Selection tool before running Fine Tune.

> **ffmpeg must be on PATH.** Install from [ffmpeg.org](https://ffmpeg.org/download.html) and confirm with `ffmpeg -version` in a terminal before using this feature.

---

## Caveats

| Consideration | Notes |
|---------------|-------|
| **Local files only** | Timestamps are read from the local filesystem (`fs.statSync()`) and via `ffprobe`. Network drives or cloud-synced folders may not report reliable dates. |
| **mtime fallback accuracy** | When falling back to `mtime`, some copy tools (rsync without `--times`, cloud sync apps) reset it. Use tools that preserve file dates, or rely on clips that carry embedded `creation_time`. |
| **~1s fallback variance** | On the `mtime` fallback, filesystem timing means a clip's calculated start can be off by up to ~1 second; the coarse + fine Fine Tune passes correct the residual. Clips using embedded `creation_time` are more precise. |
| **Undo granularity** | Premiere's ExtendScript exposes no undo-group API, so Build and Fine Tune each register several undo steps rather than one. Use the panel's **↩ Revert** button to undo the last fine tune's shifts in one click, or delete the generated `-SYNC` sequence to start over. |
| **Camera clock drift** | If devices have different clock *settings*, clips first land at their own absolute times; Fine Tune's coarse pass then corrects large whole-track offsets automatically (when the audio overlaps), and the fine pass polishes the residual. Devices whose clocks run at different *rates* (drift) can't be fixed by an offset — the panel detects and reports drift on long overlaps so you can split the clips. Devices whose audio shares no common sound can't be auto-aligned. |
| **Linked audio** | The plugin processes video-track clips; linked audio follows via Premiere's clip model. Audio-only tracks are handled on dedicated audio tracks. |
| **Sequence must be active** | Double-click the sequence in the Project panel before scanning — the panel operates on the sequence currently open in the timeline. |

---

## File structure

```
cep/
├── CSXS/
│   └── manifest.xml       # CEP extension definition (bundle ID, host versions)
├── jsx/
│   ├── sync.jsx           # ExtendScript: sequence read + build + apply shifts
│   └── json2.js           # Guarded JSON polyfill (no-op on hosts with native JSON)
├── js/
│   ├── CSInterface.js     # Adobe CEP bridge library
│   ├── dsp.js             # Pure DSP/format core (also unit-tested under Node)
│   └── main.js            # Panel logic: timing lookup, UI, Fine Tune orchestration
├── css/
│   └── style.css          # Panel styles
├── fonts/                 # Bundled IBM Plex woff2 (SIL OFL, see fonts/LICENSE.txt)
├── installer/
│   └── syncitol-cep-installer.iss   # Inno Setup script for the Windows installer
├── scripts/
│   ├── set-version.js     # Single-source the version across files
│   ├── check-syntax.js    # Zero-dependency syntax gate
│   ├── stage.js            # Copy runtime files to dist/staging/ (shared by build-zxp.js and the installer)
│   └── build-zxp.js       # Package a signed ZXP
├── tests/
│   └── dsp.test.js        # Unit tests for js/dsp.js
├── index.html              # Panel HTML (includes Instructions view)
├── package.json            # Tooling scripts + repo metadata
├── CHANGELOG.md            # Current (1.0.0+) changelog
└── CHANGELOG-legacy.md     # Pre-relaunch version history (up to 1.4.0)
```

CI and release workflows live at the repo root, in
[`.github/workflows/`](../.github/workflows/) (`cep-ci.yml`, `cep-release.yml`).

---

## Development

No build step is required to run the panel — it is loaded directly by Premiere.
Tooling uses only Node's built-ins (no `npm install` needed for test/lint):

```bash
npm test                 # run unit tests (node --test) for js/dsp.js
npm run lint             # syntax-check all scripts
npm run set-version 1.2.0   # bump the version everywhere from one place
npm run set-version:check   # CI guard: fail if versions drift
npm run build:zxp        # package dist/Syncitol-<version>.zxp (needs ZXPSignCmd)
node scripts/stage.js    # stage runtime files at dist/staging/ (for the Inno installer)
```

`cep-ci.yml` runs lint, tests and the version check on Node 20/22/24,
triggered only by changes under `cep/`.

### Releasing

Distribution is tag-driven — no manual signing or uploading:

```bash
npm run set-version 1.2.0      # stamp VERSION + manifest + footer + package.json
git commit -am "Release v1.2.0"
git tag v1.2.0
git push --follow-tags
```

`cep-release.yml` then builds two release assets in parallel and attaches
both to the same GitHub Release (alongside the UXP `.ccx` built by
`uxp-release.yml`): a self-signed ZXP (fetches Adobe's
`ZXPSignCmd` on macOS) and a Windows installer `.exe` (via Inno Setup,
built from the staged runtime files). It fails fast if the tag and `VERSION`
disagree. For a properly verified ZXP publisher instead of a self-signed
certificate, sign locally with a real code-signing `.p12` and attach that
ZXP to the release yourself.

# Syncitol

Syncitol: fast relief from manual multicam sync in Premiere Pro.

Point it at a multicam sequence — separate cameras, audio recorders, whatever
— and it rebuilds real recording-time sync automatically: reads each clip's
real record-start time (embedded metadata, falling back to file dates), lays
everything out on a new timeline so the gaps match real clock time, then
fine-aligns the audio by waveform. One click ("⚡ Auto Sync") runs the whole
pipeline. Free, and it's yours to keep.

If Syncitol saves you a re-sync session, consider tipping on
[Ko-fi](https://ko-fi.com/thinkvp) — it's genuinely appreciated.

![Syncitol panel screenshot](docs/screenshots/uxp-panel.png)

## Which version do I need?

Syncitol ships as two separate plugins, built for different Premiere generations:

| | [`uxp/`](uxp/) — UXP plugin | [`cep/`](cep/) — CEP extension |
|---|---|---|
| **Premiere Pro** | 26.0+ | 24, 25, 26+ |
| **OS** | Windows | Windows or macOS |
| **ffmpeg** | Bundled — no install needed | System install needed, but only for Fine Tune Audio |
| **Install** | Download `.ccx`, double-click | Windows installer `.exe`, or ZXP via extension manager |

- **On Windows with Premiere 26+:** use the **UXP** version — it's simpler,
  self-contained, and it's where Adobe's extensibility platform is headed.
- **On macOS, or on an older Premiere (24/25):** use the **CEP** version.

### Why two versions?

Adobe is moving Premiere's plugin platform from CEP to UXP, but CEP extensions
still work today and UXP hybrid plugins (the kind Syncitol needs, for the
bundled FFmpeg decoder) only run on Premiere 26+ and only on Windows so far.
Building a macOS UXP version would mean paying for an Apple Developer Program
membership just to notarize one native binary — not something this free
project takes on right now. So: UXP where it can go furthest today, CEP
everywhere else, both maintained.

## Download

Grab the latest release for your platform from
**[Releases](https://github.com/thinkvp/Syncitol/releases)**:
- UXP builds are tagged `uxp-v*`.
- CEP builds are tagged `cep-v*`.

See [`uxp/README.md`](uxp/README.md) or [`cep/README.md`](cep/README.md) for
exact install steps.

## License

[MIT](LICENSE) for Syncitol's own code. Bundled third-party components (IBM
Plex fonts, FFmpeg) keep their own licenses — see [`LICENSE`](LICENSE) for
details.

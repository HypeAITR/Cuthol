# Changelog

## 0.3.9 — 2026-11-14

Colour grading for agents, transparent and 4K masters, timeline export, and keyless speech.

### Added
- **Colour (`cuthol color`, MCP tool `color`).** Cuthol measures and describes colour; it never changes it by itself.
  - `color map` gives an agent a ~100-token text map of a clip or a reference image (tone percentiles and clipping, neutral axis, colourfulness, hue sectors, evidence), so it can grade without opening frames.
  - `color set` writes editable blocks in a fixed order (white balance, exposure, tone, curves, colour wheels, HSL secondaries, saturation/vibrance, Look) on spine clips and b-roll cues, and answers with a render-free prediction of the result and its side effects (for example a white wall turning pink).
  - `color solve` proposes blocks toward an objective target (another clip, a reference, exposure or white-balance limits) and prints the exact `color set` arguments; a before/after pair becomes an exact LUT for a named Look (`color look from-pair`).
  - `color compare` renders a variant sheet with the untouched picture first; `color diff`, `color clusters`, `color kind` (camera / screen recording / graphic) and `color migrate` (from the old `spine grade`) complete the set.
  - Every item's blocks compile to one 3D LUT, so the render, the Live preview and the prediction agree. Keyframed colour (`spine envelope --param color.exposure.stops` …), HDR (HLG/PQ) sources tone-mapped to SDR, technical verify gates (G130–G137) and a post-render colour check (G510/G512).
  - New agent skill `cuthol-color` with a word-to-block guide ("warmer", "crushed blacks", "teal shadows", "pink skin" …).
- **Cuthol Live: Effects tab.** Effects are listed next to Clip Info and Notes; Color opens over the right column with before/after, waveform, parade, vectorscope and histogram, and sliders that work while the agent is paused (the change reaches the agent like any other edit). The preview shows the grade exactly as it renders.
- **Render presets** `master_2160p` (UHD for every aspect) and `master_alpha` (ProRes 4444 with a real alpha channel for compositions over a transparent backdrop).
- **Timeline export** to other editors: `cuthol export timeline fcpxml|xmeml|edl|otio --out <file>` (Final Cut Pro, Premiere, DaVinci Resolve, OpenTimelineIO). Anything that cannot travel (compositions, captions) is listed, never dropped silently. Also `render.export_timeline` over MCP.
- **Keyless speech.** `cuthol setup --local-speech --apply` installs a private local engine (faster-whisper for transcription, Piper for voiceover) and `--provider local` uses it; `cuthol doctor` reports it.
- Ready-made HyperFrames registry blocks work on lanes (`npx hyperframes add <block>` inside a composition), documented in `cuthol-motion`.

### Changed
- `--provider local` without an installation or an explicit `CUTHOL_LOCAL_*_CMD` now fails with `CUTHOL-G237` and the setup command, instead of producing a placeholder tone.

## 0.3.7 — 2026-11-14

### Fixed
- `cuthol doctor` reported GSAP as missing (and exited with 1) when npm installed it in a parent `node_modules` — the usual layout for `npx cuthol` and for installing Cuthol inside a project. It now finds GSAP the same way the renderer does. Rendering was not affected.

## 0.3.6 — 2026-11-14

Getting started takes one install and two commands.

### Added
- **`cuthol setup`** registers the Cuthol MCP server with the agent tools on your machine: Claude Code (through the `claude` CLI), Codex, Cursor and Gemini CLI. It shows the plan first; `--apply` writes it, with a backup of every config file, other entries kept byte for byte, and a different existing `cuthol` entry replaced only with `--force`. Running it twice changes nothing.
- **`cuthol doctor`** checks Node.js, ffmpeg/ffprobe 8.x, a Chromium browser for motion graphics, HyperFrames and GSAP, the optional speech keys (presence only, never the value) and the installed agent skills, with a one-line fix for each problem. `--json` returns the checks as data; the exit code is 1 when a required tool is missing.
- **npm package.** The package now ships only what runs (about 1.3 MB packed), and HyperFrames and GSAP are found even when npm installs them in a parent `node_modules`. `npm install -g cuthol` and `npx cuthol` work without a clone.

### Fixed
- `lane add-cue` without `--duration` caps the default length (3 s) at the media left after the in-point, so a sound shorter than three seconds is accepted instead of failing with `CUTHOL-G202`. Longer media keep the 3 s default.

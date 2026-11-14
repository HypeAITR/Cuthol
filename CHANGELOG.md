# Changelog

## 0.3.6 — 2026-11-14

Getting started takes one install and two commands.

### Added
- **`cuthol setup`** registers the Cuthol MCP server with the agent tools on your machine: Claude Code (through the `claude` CLI), Codex, Cursor and Gemini CLI. It shows the plan first; `--apply` writes it, with a backup of every config file, other entries kept byte for byte, and a different existing `cuthol` entry replaced only with `--force`. Running it twice changes nothing.
- **`cuthol doctor`** checks Node.js, ffmpeg/ffprobe 8.x, a Chromium browser for motion graphics, HyperFrames and GSAP, the optional speech keys (presence only, never the value) and the installed agent skills, with a one-line fix for each problem. `--json` returns the checks as data; the exit code is 1 when a required tool is missing.
- **npm package.** The package now ships only what runs (about 1.3 MB packed), and HyperFrames and GSAP are found even when npm installs them in a parent `node_modules`. `npm install -g cuthol` and `npx cuthol` work without a clone.

### Fixed
- `lane add-cue` without `--duration` caps the default length (3 s) at the media left after the in-point, so a sound shorter than three seconds is accepted instead of failing with `CUTHOL-G202`. Longer media keep the 3 s default.

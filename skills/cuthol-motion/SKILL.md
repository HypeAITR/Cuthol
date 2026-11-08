---
name: cuthol-motion
description: >
  Write HyperFrames motion graphics inside Cuthol: composition.scaffold,
  index.html with window.__cuthol (C.word, C.beats, C.beatGrid, C.audio, C.cuts,
  C.drive, C.value, C.global), mounting on lanes, overlay modes, composition
  preview, script errors, overlay cache, and deterministic GSAP animation.
  Load when coding, mounting, previewing or debugging overlays and animated
  graphics.
---

# Motion graphics: code your own overlays

A composition is a folder with an `index.html` that renders frame by frame in a
headless browser. Cuthol mounts it on a lane (normally `ln_motion`) for a time
window, renders it with real transparency and composites it over the edit.
Inside the page, `window.__cuthol` (`C`) gives you the edit's words, beats,
audio energy and cuts **in the composition's own seconds** (0 = cue start).

## Workflow

1. `composition.scaffold(comp_dir="compositions/intro", preset="blank",
   duration="4.5s")` → `index.html`, `assets/gsap.min.js`,
   `assets/cuthol-runtime.js`, `assets/cuthol-data.js`. Other presets
   (`counter`, `beat_cards`, `audio_glow`, `cut_phases`, `lower_third`,
   `title_card`, `stat_callout`, `badge_overlay`) are examples to read and
   adapt. Full template: `references/api.md`.
2. Write your animation into `index.html` — with your file tools, or
   `composition.write(comp_dir, content)` over MCP (`composition.read` reads;
   both are MCP-only, no CLI form).
3. `lane.add_composition(comp_dir="compositions/intro", at="1.5s",
   duration="4.5s", z_index?)` (or `anchor="sp_02"`). The duration must match
   `data-duration` in the HTML.
4. `composition.preview(cue="cue_05", at=["0.3","1.2","3.0"])` → contact sheet:
   checkerboard (true alpha) | over the real footage | alpha mask, plus WCAG
   contrast findings. (`composition.check` is the same call.)
5. `monitor.frame(at=<timeline time>)` to see it in context, then render.

Use the stage size from `brief` (16:9 → 1920x1080, 9:16 → 1080x1920) for `#root`
and `data-width/height`. `C.safe` gives the title-safe box in px.

## Long and layered compositions

- **Full-length single compositions are normal:** a composition can span the
  whole video (90+ seconds) and drive scenes from `C.global.words` or `C.word`.
  Split only if you want to.
- **Layers:** multiple composition cues can overlap — e.g. one renders scenes
  across `0..98.7s` while a second renders a continuous mascot or corner badge
  on top. Order: higher `lane.z_index` across lanes; within one lane, higher
  cue `z_index`, then cue order. New lanes via `lane.add_composition(lane=
  "ln_mascot", …)` sit above `ln_motion` by default.
- After any later edit or analysis, Cuthol rewrites `assets/cuthol-data.js`
  automatically if the data in the window changed (touching only its own two
  script tags). `composition.sync()` reports `updated: true` only when that
  call wrote files.

## Hard rules (the render is a frame-by-frame seek, not playback)

- One GSAP timeline, created `paused: true`, registered in
  `window.__timelines[<data-composition-id>]`, extended to `C.duration`.
- Everything visible must be a function of timeline time. No `setTimeout`,
  `setInterval`, `requestAnimationFrame`, `Date.now()`, unseeded
  `Math.random()`, CSS transitions/animations, or `onUpdate`-only logic —
  `tl.seek()` suppresses callbacks. Per-frame logic goes in `C.drive`, numbers
  in `C.value`.
- **`fromTo` / `immediateRender` trap at `t = 0`:** GSAP applies `from` values
  when the timeline is built, so a later tween on the same element (or a
  `fromTo` animating only `scale`/`y` while CSS leaves `opacity: 1`) shows the
  element at `t = 0`. Fix: hide in CSS (`opacity: 0`) or with
  `gsap.set(el, {opacity: 0})` **outside** the timeline, pass
  `immediateRender: false` on later chained tweens, or use `tl.set(…, 0)` +
  `tl.to(…)` instead. (A `tl.set(…, 0)` inside the timeline does not hide the
  very first frame.)
- Keep `html, body, #root` transparent. Don't paint a full-frame background
  unless you want to hide the video (G505 warns about opaque overlays).
- No network: no CDN scripts, web fonts or remote images. Put files in
  `assets/` and reference them relatively. System fonts are safe, but declare
  each used one with `@font-face`.
- Never tween `visibility`, `display` or `autoAlpha` on `.clip` elements, and
  never tween layout properties (`left`, `top`, `width`, `height`, `fontSize`)
  — use transforms (`x`, `y`, `scale`, `scaleX`, `scaleY`, `opacity`) instead.
- Don't give a CSS starting transform to a property GSAP animates (GSAP reads
  the CSS value into its own units and misplaces the element); set the start
  with `tl.set(el, {…}, 0)`.
- `verify` lints every mounted composition (cached by content hash) after
  syncing missing enabled extension asset packs into it, and surfaces findings
  as `CUTHOL-G407` (`duplicate_media_discovery_risk` on `<img>`-only is INFO;
  size/split advisories are ignored).

## `window.__cuthol`, briefly

All times are seconds relative to the composition start. Full table, template,
text measuring, transparent video and media rules: `references/api.md`.

| Call | Returns / does |
|---|---|
| `C.word(query, {nth, after, pre, post, minDur, fallback})` | `{found, start, end, text, clipped}` for a word/phrase in this window. Case- and diacritics-insensitive. Not found → `start = fallback ?? 0` + a `C.warnings` entry. Spell numbers as spoken words. |
| `C.beats({from, to, strong, threshold, div, grid})` | Onset times by default; `grid:true` gives the regular beat grid (`div:2` subdivides). `C.beatGrid(…)` is the grid shorthand. |
| `C.audio(band, t, smoothSec?)` | Mixed-audio energy at `t` (`"low"`/`"mid"`/`"high"`), normalized over this window (0 = silence). Empty audio warns (`CUTHOL-G507`). |
| `C.cuts()` | Spine cuts in the window + shot segments between them. |
| `C.drive(tl, fn, {start, end})` / `C.value(tl, {from, to, at, duration, ease}, fn)` | Per-frame callback / tweened number. Counters and audio-reactive motion go here, never in `onUpdate`. |
| `C.duration`, `C.fps`, `C.width`, `C.height`, `C.bpm`, `C.safe`, `C.props`, `C.warnings`, `C.data` | Composition facts, safe box, mount props, failed lookups, raw data. |
| `C.cueStart`, `C.cueEnd`, `C.toGlobal(t)`, `C.toLocal(t)` | Cue position on the sequence timeline. |
| `C.global` | Whole-sequence intelligence in absolute seconds: `word`, `words`, `pauses`, `sentences`, `audio`, `beats`, `cuts`, `drive`, `value`. |

Word data covers voiceover cues and transcribed spine clips; transcribe first.
Beats are analyzed automatically.

## Overlay modes

- `mode="overlay_alpha"` (default): real alpha channel, blended in 10-bit.
  Shadows, glows, anti-aliasing and green colours survive. Use this for almost
  everything.
- `mode="scene_host"`: only when CSS must read the video underneath
  (`backdrop-filter: blur()`, non-normal `mix-blend-mode`). Cuthol embeds the
  footage inside the page for that window; in overlay mode such CSS gives G406.

## Media, scripts, cache

- Every `<video class="clip">` needs an `id` (an id-less video freezes in
  renders). Size `<video>` with **pixel width and height** (and a pixel height
  on its box); when sizing by width, compute the height from that file's own
  aspect ratio.
- Sound: audible `<audio>`/`<video>` in a composition (with `<hf-audio-group>`,
  volume automation and fx) enters the Cuthol mix as a per-cue stem at the
  cue's lane time and follows the cue's gain, mute and envelopes. Silent
  compositions are untouched. Turn it off per cue with
  `lane.update_cue(cue, composition_audio="off")`. Details, diagnostics
  (G416/G435/G436): `cuthol-audio`.
- Transparent VP9 webm (`yuva420p`, `-auto-alt-ref 0`) keeps its alpha on
  render, monitor and preview; past its end the last frame holds.
- Overlays are cached by composition files + used data slices + backdrop; every
  render reports why each overlay re-rendered (`new`, `html_changed`,
  `slice_changed`, `global_used_changed`, `props_changed`, `backdrop_changed`,
  `blob_missing`, `renderer_version_changed`). Reasons and the
  `--overlay-res native` draft/master handoff: see `cuthol-render`.
- A composition whose script throws still snapshots a healthy-looking static
  page: read monitor/preview diagnostics (G430 ERROR before the timeline
  registers — render stops with G503; G431 WARN while running; G432 WARN on
  `console.error`, e.g. a failed shader compile). `verify` reports the recorded
  error without a browser — but only after the composition was measured once
  (monitor/preview/coords); an unmeasured composition stays silent, which is
  not "clean". After fixing, re-run `cuthol composition preview --cue <cue_XX>`.
- Animation craft that survives field use — masked reveals, state sets, stroke
  drawing, the camera pattern, word-locked timing, WebGL/3D packaging, stills
  from compositions: `references/craft.md`.

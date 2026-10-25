# Compositions: code your own motion graphics

A composition is a folder with an `index.html` that HyperFrames renders frame by frame in a headless
browser. Cuthol mounts it on a lane (normally `ln_motion`) for a time window, renders it with real
transparency and composites it over the edit. Inside the page, `window.__cuthol` (`C`) gives you the
edit's words, beats, audio energy and cuts **in the composition's own seconds** (0 = cue start).

## Workflow

1. `composition.scaffold(comp_dir="compositions/intro", preset="blank", duration="4.5s")`
   → creates `index.html`, `assets/gsap.min.js`, `assets/cuthol-runtime.js`, `assets/cuthol-data.js`.
   Other presets (`counter`, `beat_cards`, `audio_glow`, `cut_phases`, `lower_third`, `title_card`, `stat_callout`, `badge_overlay`) are examples you can read and adapt.
2. Write your animation into `index.html` (template below) — with your file tools, or `composition.write(comp_dir, content)` over MCP.
3. `lane.add_composition(comp_dir="compositions/intro", at="1.5s", duration="4.5s", z_index?)` (or `anchor="sp_02"`). The duration must match `data-duration` in the HTML.
4. `composition.preview(cue="cue_05", at=["0.3","1.2","3.0"])` → contact sheet image: checkerboard (true alpha) | over the real footage | alpha mask, plus WCAG contrast findings on the real background.
5. `monitor.frame(at=<timeline time>)` to see it in context with captions/titles, then render.

## Long single compositions and simultaneous layers

- **Full-length single compositions are normal:** A composition does not have to be a short 3–5 s card; it can span the entire video (e.g. 90+ seconds) and drive multiple scenes from `C.global.words` or `C.word`. You do not need to split a long composition into sub-compositions unless you want to.
- **Layered compositions at the same time:** Multiple composition cues can overlap in time. For example, one composition can render changing scenes across `0..98.7s` while a second composition renders a continuous mascot or corner badge on top across the same `0..98.7s` window.
- **Layer order:** Across lanes, higher `lane.z_index` renders on top (new composition lanes created via `lane.add_composition(lane="ln_mascot", ...)` default to a higher `z_index` above `ln_motion`). Within the same lane (`ln_motion`), cues with higher `z_index` render on top, and cues with equal/omitted `z_index` render in cue order (later cues on top of earlier cues). Use `z_index` on `lane.add_composition` or `lane.update_cue` whenever you want explicit ordering within a lane.

After any later edit (trim, cleanup, new music…) or media analysis, Cuthol rewrites `assets/cuthol-data.js` automatically if the data inside this composition's window changed. Your HTML does not change, so word-locked and beat-locked animation stays in sync. During sync, Cuthol only touches the exact `<script src="assets/cuthol-data.js"></script>` and `<script src="assets/cuthol-runtime.js"></script>` tags and never modifies any other `<script>` tags in your HTML. When you call `composition.sync()` explicitly, `updated: true` means files (`updated_files`) were written during that call (with `reason` explaining what changed), while `updated: false` (`in_sync: true`) means the files on disk already matched the current sequence state because Cuthol auto-synced them after the previous edit or analysis.

## Template (tested)

```html
<!doctype html>
<html lang="tr">
  <head>
    <meta charset="UTF-8" />
    <script src="assets/gsap.min.js"></script>
    <script src="assets/cuthol-data.js"></script>
    <script src="assets/cuthol-runtime.js"></script>
    <style>
      html, body { margin: 0; background: transparent; }
      #root { position: relative; width: 1920px; height: 1080px; overflow: hidden; background: transparent; }
      .clip { position: absolute; inset: 0; }
      #card { position: absolute; left: 1180px; top: 150px; padding: 36px 44px; border-radius: 28px;
              background: rgba(10,14,22,.78); box-shadow: 0 30px 80px rgba(0,0,0,.65); color: #fff; opacity: 0;
              font: 900 64px "Segoe UI", system-ui, sans-serif; }
      #count { font-size: 120px; color: #22C55E; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0"
         data-width="1920" data-height="1080" data-fps="30" data-duration="4.5">
      <section id="slot" class="clip" data-start="0" data-duration="4.5">
        <div id="card"><div>MOONSTAR</div><div id="count">0</div></div>
      </section>
    </div>
    <script>
      const C = window.__cuthol;
      const tl = gsap.timeline({ paused: true });

      // Appear exactly when the word is spoken
      const brand = C.word("moonstar", { fallback: 0.3 });
      tl.fromTo("#card", { opacity: 0, y: 40 }, { opacity: 1, y: 0, duration: 0.35, ease: "power3.out" }, brand.start);

      // Count up so that it lands on the spoken number
      const num = C.word("doksan", { fallback: 1.2 });
      C.value(tl, { from: 0, to: 990, at: num.start - 0.6, duration: 0.8 },
        (v) => { document.getElementById("count").textContent = Math.round(v); });

      // Continuous audio-reactive motion (seek-safe)
      C.drive(tl, (t) => {
        const low = C.audio("low", t, 0.05);
        gsap.set("#count", { scale: 1 + 0.08 * low });   // gsap.set keeps other GSAP transforms intact
      });

      tl.set({}, {}, C.duration);          // timeline must span the whole composition
      window.__timelines["main"] = tl;     // key = data-composition-id
    </script>
  </body>
</html>
```

Use the stage size from `brief` (16:9 → 1920x1080, 9:16 → 1080x1920) for `#root` and the `data-width/height`. `C.safe` gives the title-safe box in px.

## Hard rules (the render is a frame-by-frame seek, not playback)

- One GSAP timeline, created `paused: true`, registered in `window.__timelines[<data-composition-id>]`, extended to `C.duration`.
- Everything visible must be a function of timeline time. No `setTimeout`, `setInterval`, `requestAnimationFrame`, `Date.now()`, unseeded `Math.random()`, CSS transitions, or `onUpdate`-only logic — `tl.seek()` suppresses callbacks. For per-frame logic use `C.drive`; for numbers use `C.value`.
- **`gsap.fromTo` / `immediateRender` trap at `t = 0`:** Because GSAP defaults `immediateRender: true` on `fromTo`/`from` tweens, a later tween on the same element (or a `fromTo` that only animates `scale`/`y` while CSS leaves `opacity: 1`) applies its `from` values immediately when the timeline is built — making elements appear at `t = 0` before their cue time or overwriting an earlier tween's initial state during seek-based rendering. **Fix:** start elements hidden in CSS (`opacity: 0`) or with `tl.set(el, { opacity: 0 }, 0)`, pass `immediateRender: false` on later chained `fromTo`/`from` tweens on the same target, or use `tl.set(el, { opacity: 0, y: 40 }, 0)` followed by `tl.to(el, { opacity: 1, y: 0, duration: 0.35 }, startTime)`.
- Keep `html, body, #root` transparent. Don't paint a full-frame background unless you want to hide the video (G505 warns about an opaque overlay).
- No network: no CDN scripts, web fonts or remote images. Put files in `assets/` and reference them relatively. System fonts are safe.
- Never tween `visibility`, `display` or `autoAlpha` on `.clip` elements, and never tween layout/reflow properties (`left`, `top`, `width`, `height`, `fontSize`) with GSAP (`gsap_non_transform_motion` — use transforms `x`, `y`, `scale`, `scaleX`, `scaleY`, `opacity` instead).
- `verify` runs HyperFrames lint on every mounted composition (cached by content hash) after syncing any missing enabled extension asset packs (`assets/ext/<name>/`) into the composition, and surfaces real lint issues as `CUTHOL-G407` warnings; `duplicate_media_discovery_risk` is downgraded to `INFO` (`CUTHOL-G407`) when it only involves `<img>` elements (remaining `WARN` for `<video>`/`<audio>`), and size/splitting advisories (`composition_file_too_large`, `nested_structure_needs_subcomposition`, `timeline_track_too_dense`) are treated as info, not warnings.

## Measuring text after the font has loaded

Frame capture waits until `window.__timelines[<data-composition-id>]` is registered, then calls `window.__hfForceTimelineRebind()`. A width that depends on a local `@font-face` belongs in `document.fonts.ready`: measure there, build the paused GSAP timeline there, and assign `window.__timelines["main"]` at the end of that callback. An empty timeline assigned earlier is what capture treats as ready, so tweens added afterwards are not attached.

`getBoundingClientRect().width` includes CSS transforms. `draft_480p` `render` and `monitor frame` scale `#root` with `transform: scale(...)`. `composition preview` snapshots at stage size, so that scale is 1. Divide the measured width by the root scale before writing `style.width`. Writing the raw measured number makes the underline get scaled a second time on the draft paths.

```html
<style>
  @font-face {
    font-family: "MeasureFace";
    src: url("assets/inter-latin-wght-normal.woff2") format("woff2");
    font-weight: 100 900;
    font-display: block;
  }
</style>
<script>
  document.fonts.ready.then(function () {
    var title = document.getElementById("title");
    var measured = title.getBoundingClientRect().width;
    var transform = getComputedStyle(document.getElementById("root")).transform;
    var match = /matrix\(([^)]+)\)/.exec(transform || "");
    var scale = match ? parseFloat(match[1].split(",")[0]) || 1 : 1;
    document.getElementById("rule").style.width = (measured / scale) + "px";
    var tl = gsap.timeline({ paused: true });
    tl.set({}, {}, C.duration);
    window.__timelines["main"] = tl;
  });
</script>
```

Checked on `render` (`draft_480p`), `monitor frame`, and `composition preview`: the underline matched the title box. A twin that measures in the script body, without `fonts.ready`, also matched on those three paths. HyperFrames defers classic inline body scripts until fonts have loaded, so a file in `assets/` is already applied when that script runs. The callback is still where the timeline has to be registered when setup is asynchronous. Capture stops waiting for the timeline after the player-ready timeout (45 seconds by default). A `fonts.ready` that never settles is captured without that timeline.

## Transparent VP9 webm

A VP9 webm with alpha (`yuva420p`, `alpha_mode=1`, encoded with `-pix_fmt yuva420p -auto-alt-ref 0`) plays as `<video class="clip">` and keeps its transparency on `render`, `monitor frame`, and `composition preview`. Clear pixels show the edit underneath. When the file is shorter than the clip's `data-duration`, the rest of the clip holds the last frame: media time is clamped to the file duration.

## Overlay cache & what triggers a re-render

Each composition overlay is cached in `.cuthol/blobs/` keyed only by what affects its rendered pixels:
- **Composition files (`html_changed`):** `index.html`, user `.js`/`.css`, local media/font assets, `assets/cuthol-vars.json`, `assets/cuthol-runtime.js`, and enabled extension helper/asset copies (`assets/cuthol-ext-<name>.js`, `assets/ext/<name>/…`). Every composition that uses an extension carries its own copy of that extension's helper and assets, so any change to the extension (one CSS rule, one helper function) re-renders every composition that uses it. Finish kit/extension edits before taking drafts; a kit change late in a project costs a full overlay re-capture.
- **Used window-local slice (`slice_changed`):** Cuthol inspects the composition's HTML/JS (and enabled extension helpers) to see which local `window.__cuthol` (`C`) slices are referenced:
  - `C.word` / `words` / `sentences` / `pauses` → re-renders when words inside `[cueStart, cueEnd]` change.
  - `C.audio` → re-renders when the mixed audio envelope inside `[cueStart, cueEnd]` changes.
  - `C.beats` / `C.beatGrid` / `C.bpm` → re-renders when beats inside `[cueStart, cueEnd]` change.
  - `C.cuts` / `segments` → re-renders when spine/scene cuts inside `[cueStart, cueEnd]` change.
  - `C.sequenceStartSec` / `C.cueStart` / `C.cueEnd` / `C.toGlobal` / `C.toLocal` → re-renders when the cue's timeline start shifts.
- **Used global slice (`global_used_changed`):** Only the specific `C.global.*` slices (`C.global.word`/`words`, `C.global.audio`, `C.global.beats`/`beatGrid`, `C.global.cuts`, `C.global.duration`) actually referenced by the composition are included in its cache key. If a composition does not use `C.global.audio` or `C.audio`, adding an SFX cue elsewhere does not invalidate its cache; if it does not use `C.cuts` or `C.global.cuts`, spine edits that do not change its underlying backdrop do not invalidate its cache. When dynamic property access (`C[...]`, `C.data`, `__CUTHOL_DATA__`, `eval`) is present, Cuthol errs on the safe side and treats all slices as used.
- **Backdrop (`backdrop_changed`):** An opaque overlay is captured over the stage backdrop under it (by content hash), so a spine edit that changes what lies underneath re-renders it. If your composition paints its own opaque full-frame surface for its whole duration, put `data-cuthol-opaque="true"` on the root element (next to `data-composition-id`); its cache then ignores the backdrop. Do not declare it if any part of the frame is transparent, masked, or fades in.
- **Render summary (`overlays`):** Every `render` reports `overlays: { total, cached, rendered, reasons, elapsed_ms, rerendered, summary }` showing how many overlays came from cache, how many were re-rendered, why (`new`, `html_changed`, `renderer_version_changed`, `slice_changed`, `global_used_changed`, `props_changed`, `backdrop_changed`, `blob_missing`), and total overlay time. A cold overlay with no saved state file for that composition reports `new`. `renderer_version_changed` means the HyperFrames package version tagged on the composition files hash changed (not an HTML edit). If a state file exists, the hashes still match, and the blob file is gone, the reason is `blob_missing`. When a `master_1080p` native blob is already cached for the exact same state, `draft_480p` reuses and downscales it instead of launching a new browser render. The other direction is `--overlay-res native` (or `CUTHOL_DRAFT_OVERLAY_RES=native`; the flag wins) on `draft_480p` when a `master_1080p` will follow: the draft captures each overlay at the master's resolution, quality and cache key, then scales that blob down for the 480p picture, and `overlays.summary` says `native capture for master reuse`. The following master reads those blobs from cache. The draft takes longer because the capture is full size. `master_1080p` ignores the option. The default `draft` keeps the smaller capture.

## `window.__cuthol` API

All times are seconds relative to the composition start (`0 … C.duration`).

| Call | Returns / does |
|---|---|
| `C.word(query, {nth, after, pre, post, minDur, fallback})` | `{found, start, end, duration, text, clipped}` for a word or phrase spoken inside this window. Matching ignores case and Turkish diacritics (`çekiliş` = `cekilis`). Not found → `found:false`, `start = fallback ?? 0`, and a message in `C.warnings`. `clipped` = word only partly inside the window. Spell numbers as spoken words (`"doksan"`, not `"90"`). |
| `C.beats({from, to, strong, threshold, div, grid})` | Beat times (`number[]`) inside this window, from the music on `ln_bgm` (falls back to spine audio when there is no music). By default (`grid` omitted or `false`) returns detected spectral-flux **onset** times (`beats.times`; `strong:true` filters by `strength >= threshold`, default `0.7`, or downbeats). Pass `grid:true` to get the regular tempo/phase **beat grid** (`beats.grid`; `strong:true` returns bar downbeats every 4 beats). `div:2` subdivides into half-beats. |
| `C.beatGrid({from, to, strong, div})` | Shorthand for `C.beats({ ...opts, grid: true })` — returns the regular tempo/phase beat grid (`number[]`) inside this window (`strong:true` = bar downbeats, `div:2` = half-beats). |
| `C.audio(band, t, smoothSec?)` | Energy of the **mixed** audio (spine + voiceover + sfx + music) at `t`, band `"low"` (20–250 Hz), `"mid"` (250–4000 Hz, voice) or `"high"`. Each band is normalized over this window: ~0.05 quiet … 1.0 loudest moment; 0 = silence. When a composition references `C.audio`, Cuthol automatically analyzes waveforms (cached per asset) for every audible source in its window; if no audio energy can be extracted, a warning is added to `C.warnings` and `verify` (`CUTHOL-G507`). |
| `C.cuts()` | `{cuts: number[], segments: [{t0, t1, index, duration, clipId}]}` — spine cuts inside the window and the shot segments between them. |
| `C.drive(tl, fn, {start, end})` | Calls `fn(t)` for every rendered frame between `start` and `end` (default whole composition). |
| `C.value(tl, {from, to, at, duration, ease}, fn)` | Tweens a number and calls `fn(value)` each frame. |
| `C.duration`, `C.fps`, `C.width`, `C.height`, `C.bpm` | Composition facts. |
| `C.cueStart`, `C.cueEnd`, `C.sequenceDuration`, `C.toGlobal(t)`, `C.toLocal(t)` | Cue position on the sequence timeline (`globalTime = localTime + C.cueStart`). |
| `C.global` | Full-sequence timeline intelligence in **absolute sequence seconds** (`0 … C.global.duration`): `C.global.word(query, opts)` (finds words anywhere in the edit, returning `{found, start, end, duration, text, clipped, localStart, localEnd, inWindow}`), `C.global.audio(band, t, smoothSec?)` or `C.global.audio(t, smoothSec?)` (3-band energy normalized **once across the whole sequence**, so segments share identical thresholds), `C.global.words`, `C.global.pauses`, `C.global.sentences`, `C.global.beats(opts)`, `C.global.cuts()`, `C.global.drive(tl, fn, opts)`, `C.global.value(tl, spec, fn)`. |
| `C.safe` | `{x, y, w, h, cx, cy, norm}` title-safe area in px. |
| `C.props` | Props passed with `lane.add_composition(props={...})`. |
| `C.warnings` | Lookups that failed (e.g. word not found). Check during development. |
| `C.data` | Raw data (`words`, `beats`, `audio`, `cuts`, …) if you need something custom. |

Word data covers voiceover cues and transcribed spine clips; transcribe first (`speech.transcribe`). Beats are analyzed automatically.

## Overlay modes

- `mode="overlay_alpha"` (default): rendered with a real alpha channel (ProRes 4444) and blended in 10-bit. Shadows, glows, anti-aliasing and green colours survive. Use this for almost everything.
- `mode="scene_host"`: only when your CSS must read the video underneath — `backdrop-filter: blur()` (frosted glass) or `mix-blend-mode` other than normal. Cuthol embeds the underlying footage inside the page for that window. In overlay mode such CSS produces G406.

## Debugging an overlay

- Nothing visible in `composition.preview`? Check the alpha-mask column. Fully black = the page drew nothing: usually a script error (missing `assets/gsap.min.js`, a typo) or `opacity:0` never animated. Open the HTML in a browser or run `npx hyperframes lint <comp_dir>`.
- Element appears at the wrong time: print `brand.found` / `brand.start` into a temporary debug `<div>` and preview; remember times are composition-local.
- Wrong place: compositions use stage pixels; `monitor.frame` draws the measured overlay box (from its alpha) for comparison.

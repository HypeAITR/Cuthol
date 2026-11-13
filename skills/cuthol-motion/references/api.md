# `window.__cuthol` API, template, measuring, debugging

All times are seconds relative to the composition start (`0 … C.duration`).

| Call | Returns / does |
|---|---|
| `C.word(query, {nth, after, pre, post, minDur, fallback})` | `{found, start, end, duration, text, clipped}` for a word or phrase spoken inside this window. Matching ignores case and diacritics. Not found → `found:false`, `start = fallback ?? 0`, and a message in `C.warnings`. `clipped` = word only partly inside the window. Spell numbers as spoken words (`"ninety"`, not `"90"`). |
| `C.beats({from, to, strong, threshold, div, grid})` | Beat times (`number[]`) inside this window, from the music on `ln_bgm` (falls back to spine audio when there is no music). By default returns detected spectral-flux **onset** times (`strong:true` filters by `strength >= threshold`, default `0.7`, or downbeats). `grid:true` returns the regular tempo/phase **beat grid** (`strong:true` = bar downbeats every 4 beats). `div:2` subdivides into half-beats. |
| `C.beatGrid({from, to, strong, div})` | Shorthand for `C.beats({ ...opts, grid: true })`. |
| `C.audio(band, t, smoothSec?)` | Energy of the **mixed** audio (spine + voiceover + sfx + music) at `t`, band `"low"` (20–250 Hz), `"mid"` (250–4000 Hz, voice) or `"high"`. Each band is normalized over this window: ~0.05 quiet … 1.0 loudest moment; 0 = silence. Referencing `C.audio` makes Cuthol analyze waveforms (cached) for every audible source in the window; if no energy can be extracted, `C.warnings` and `verify` (`CUTHOL-G507`) say so. |
| `C.cuts()` | `{cuts: number[], segments: [{t0, t1, index, duration, clipId}]}` — spine cuts inside the window and the shot segments between them. |
| `C.drive(tl, fn, {start, end})` | Calls `fn(t)` for every rendered frame between `start` and `end` (default whole composition). |
| `C.value(tl, {from, to, at, duration, ease}, fn)` | Tweens a number and calls `fn(value)` each frame. |
| `C.duration`, `C.fps`, `C.width`, `C.height`, `C.bpm` | Composition facts. |
| `C.cueStart`, `C.cueEnd`, `C.sequenceDuration`, `C.toGlobal(t)`, `C.toLocal(t)` | Cue position on the sequence timeline (`globalTime = localTime + C.cueStart`). |
| `C.global` | Full-sequence intelligence in **absolute sequence seconds**: `C.global.word(query, opts)` (returns `{found, start, end, duration, text, clipped, localStart, localEnd, inWindow}`), `C.global.audio(band, t, smoothSec?)` or `C.global.audio(t, smoothSec?)` (3-band energy normalized **once across the whole sequence**), `C.global.words`, `C.global.pauses`, `C.global.sentences`, `C.global.beats(opts)` (the full-sequence beat grid in sequence seconds, same source as `C.beats` but not clipped to this cue — index it by global beat number), `C.global.cuts()`, `C.global.drive(tl, fn, opts)`, `C.global.value(tl, spec, fn)`. |
| `C.safe` | `{x, y, w, h, cx, cy, norm}` title-safe area in px. |
| `C.props` | Props passed with `lane.add_composition(props={...})`. |
| `C.warnings` | Lookups that failed (e.g. word not found). Check during development. |
| `C.data` | Raw data (`words`, `beats`, `audio`, `cuts`, …) for custom needs. |

## Mounting notes

`lane.add_composition(comp_dir, at|anchor+offset, duration, lane?, entry?,
props?, transparent?, mode?, z_index?, id?)` mounts the folder at
`<project>/<comp_dir>/<entry>` (`entry` defaults to `index.html`, `lane` to
`ln_motion`, `mode` to `overlay_alpha`). If the folder (or its entry file) does
not exist yet, it is scaffolded automatically — `--scaffold <preset>` on the
CLI picks the preset (default `lower_third`). Mounting also pre-syncs enabled
extension asset packs into the composition, and `verify` syncs any still
missing before linting — so enabling an extension before scaffolding no longer
loses its fonts. If a composition still renders with fallback fonts, re-run
`extension.enable` and check `assets/ext/<name>/` inside the composition.

## Template (tested)

```html
<!doctype html>
<html lang="en">
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
              font: 900 64px system-ui, sans-serif; }
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
      const num = C.word("ninety", { fallback: 1.2 });
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

## Measuring text after the font has loaded

Frame capture waits until `window.__timelines[<data-composition-id>]` is
registered, then calls `window.__hfForceTimelineRebind()`. A width that depends
on a local `@font-face` belongs in `document.fonts.ready`: measure there, build
the paused GSAP timeline there, and assign `window.__timelines["main"]` at the
end of that callback. An empty timeline assigned earlier is what capture treats
as ready, so tweens added afterwards are not attached.

`getBoundingClientRect().width` includes CSS transforms. Draft `render` and
`monitor frame` scale `#root` with `transform: scale(...)`; `composition
preview` snapshots at stage size, so that scale is 1. Divide the measured width
by the root scale before writing `style.width` — writing the raw number makes
the underline get scaled a second time on the draft paths.

```html
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

Inline body scripts run after project fonts have loaded, so a twin that
measures in the script body (without `fonts.ready`) usually matches too — but
when setup is asynchronous, the timeline must still be registered inside the
callback. Capture stops waiting for the timeline after the player-ready timeout
(45 s default); a `fonts.ready` that never settles is captured without that
timeline.

## Debugging an overlay

- Nothing visible in `composition.preview`? Check the alpha-mask column. Fully
  black = the page drew nothing: usually a script error (missing
  `assets/gsap.min.js`, a typo) or `opacity:0` never animated. Read the preview
  diagnostics first (`G430` names the throw with `file:line` when known); then
  open the HTML in a browser or run the HyperFrames linter on the folder.
- Element appears at the wrong time: print `brand.found` / `brand.start` into a
  temporary debug `<div>` and preview; remember times are composition-local.
- Wrong place: compositions use stage pixels; `monitor.frame` draws the
  measured overlay box (from its alpha) for comparison.
- WebGL object missing but its shadow renders: suspect a shader compile error
  (`G432` carries the `console.error`); fix the shader, then re-preview.

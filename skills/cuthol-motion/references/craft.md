# Animation craft: traps and patterns that survive real use

Seek-based rendering punishes everything that assumes playback. These patterns
all come from overlays that rendered wrong and were fixed.

## GSAP traps

- **Full state at every point.** "Close the previous, open the new" `tl.set`
  chains break under seek (a countdown's first item never showed). At each time
  point, set **every** affected element's value explicitly.
- **Mutually exclusive states never overlap.** Mouth/eye states, on/off pairs:
  exactly one visible at any time, the rest `opacity: 0`. Overlapping them
  leaks the lower state at the edges. Save state images lossless (PNG/lossless
  webp) — lossy compression re-encodes even unchanged regions per state and
  flickers at speech speed.
- **Stroke drawing:** draw the part you want as its own geometry and draw it
  fully (`pathLength="1" stroke-dasharray="1"` + `strokeDashoffset: 1 → 0`);
  leaving the offset halfway has left lines invisible. Invisible dashed strokes
  use `stroke-linecap: butt` (a `round` cap leaves a dot even when fully
  hidden); arrowheads go on with `tl.set(…, {attr: {"marker-end": …}})` only
  after the line has drawn. A `round`-capped line being drawn stays `opacity: 0`
  until drawing starts.
- **Stretched strokes:** `preserveAspectRatio="none"` may fit an SVG line to a
  row width, but never combine it with `vector-effect="non-scaling-stroke"`:
  the dash animates in viewBox units while the pattern applies in screen px, so
  the line looks like it slides.
- **Masked word reveals:** move the inner `.w` span, never the mask (a moving
  mask does not clip — the word slides naked). Start at `yPercent: 140` (`110`
  has leaked the word's top edge as a thin line). Large titles need
  `line-height ≥ 1.05` plus mask padding (`0.04em 0 0.1em`), or diacritics
  (dotted capitals) clip at the top. Split long titles into lines deliberately
  (one mask per line) — auto-wrapped lines have overflowed into each other.
- **Left-to-right wipe without layout tweens:** tween a CSS variable in a mask
  (`mask-image: linear-gradient(105deg, #000 calc(var(--p) - 10%), transparent
  var(--p))` + `tl.to(el, {"--p": "120%"})`) — seek-safe, soft-edged.
- **Directional blur (whip pans):** CSS `blur()` blurs every direction; a whip
  smears along motion only. Put an SVG filter on the scene container
  (`<feGaussianBlur stdDeviation="0 0">`) and drive the x value with `C.value`
  (attribute writes are seek-safe). Pin the incoming scene's blur for all
  pre-transition time too, or a backward seek can leave it at 0.
- **Narrow your selectors.** One shared class on two unrelated elements has
  broken visibility and position; scope selectors to their context.
- **Absolute-positioned shared classes inside flex rows** need `position: static`
  in that context, or the icons land on the text.

## Timing against speech

- An element enters with its word, or at most ~150 ms before it. Earlier feels
  like talking ahead of the voice.
- Exits go into speech pauses. In fast speech, tie the exit to the **last
  word's end**, not counted back from the next word — counted-back exits start
  while the last word is still spoken and collide with the next entrance.
- At most two motions share one transition instant; a new scene's second
  element enters ≥ 0.15 s after the first word.
- A scene change is carried by the new scene's first element (ready **before**
  the transition, so the move brings something in) and its sound; the outgoing
  scene stays visible until the incoming one has fully landed. Check
  transitions with consecutive-frame strips from the render, not single spaced
  frames — one-frame glitches hide between them.

## Annotations and layers

- Anything drawn at the composition root (rings, underlines, notes) outlives
  the scene change unless you hide it explicitly at its own end time. An
  annotation pointing at a window/panel belongs **inside** that panel's
  coordinates, so it is covered and closed together with it; root-level marks
  stay above everything later.
- Stacking inside one composition is document/z order; across compositions it
  is lane `z_index`, then cue `z_index`, then cue order (see the skill).
  Overlapping marks in the same corner read as one wrong shape — never place a
  second mark where one is still visible, or hide the first one first.

## Camera pattern for surfaces larger than the screen

Pan a map/board with a single `#cam` wrapper: `transformOrigin: "0 0"`, then one
`x`/`y`/`scale` tween. Land a point where you want with
`x = screenX − pointX·z`. Pins/labels that must stay screen-sized counter-scale
with `scale: 1/z` (nothing else tweens their `scale`; visibility via opacity).
Clamp the camera target at the edges — clamped targets have landed cards on
top of their own targets. When focusing one region, dim the rest to ~0.2–0.3
opacity instead of hiding it: context stays, attention moves.

## Text in other languages

- Set `<html lang="…">` for the content language. Bundle the font subsets the
  text needs (e.g. latin-ext for Turkish ş/ğ/ı/İ) — a missing subset falls back
  to a system font and can vary between renders.
- Write uppercase text with the correct capitals (BİLGİ, İSTANBUL), not
  `text-transform: uppercase`: CSS casing does not always apply language rules
  and the dotted İ can be lost.

## WebGL / 3D scenes

A real-time 3D scene can run inside a composition if it obeys the same rules:
no network, no async surprise, everything a function of `t`.

- Bundle the scene code into **one local file** (no CDN modules, no
  `onUpdate`-driven drawing — seek suppresses callbacks). Draw every frame
  inside `C.drive(tl, t => draw(t))`: compute camera/object state from `t`,
  then render. Renderer: `preserveDrawingBuffer: true`, `setPixelRatio(1)`.
- Load fonts and textures **synchronously** (embedded binary parsed at setup,
  e.g. raw RGBA bytes fed to a data texture). Async `Image`/font loads risk
  texture-less first frames under seek rendering. The price is bundle size.
- After any 3D change, look at `monitor.sheet`: "empty but a shadow renders"
  means a material/shader failed to compile (see G432 in the skill).

## Stills from a composition

For a still image (cover art, thumbnail): build a tiny project with a 1 s
composition, `render(preset="master_1080p")`, then grab the frame with ffmpeg.
Render titles and text in code rather than generating them into a picture —
spelling, diacritics and fonts stay exact. Check the still shrunk to its
display size.

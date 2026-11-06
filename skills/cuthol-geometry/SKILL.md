---
name: cuthol-geometry
description: >
  Measure composition layout without looking at pictures: composition.coords
  per-frame bounding boxes, ink boxes, quads, and the --at --elements geometry
  query (coverage, gaps, overlap, edge distance, paint order). Load when
  checking whether a title is covered, overflowing the frame, colliding with
  another element, or entering the caption band — before rendering.
---

# Geometry: measure layout, don't eyeball it

Frames sampled seconds apart miss what happens between them — a mark landing on
another mark mid-scene, a card sliding under a title for half a second. Measure
instead: Cuthol extracts per-frame boxes for the visible elements of
composition cues, and answers one-shot layout questions at any moment. It never
warns here; it reports measures, and the decision is yours.

## Coordinate measurement (`composition.coords`)

Boxes are measured against the same HTML the overlay renderer serves (locally
bundled fonts), in composition pixels, then mapped to stage pixels with the
compiler's own overlay formulas (mirror, composition-to-stage ratio, cue scale
with even-pixel rounding, centered rotation, overlay offset); enveloped
placement is evaluated at each frame's local time.

- CLI: `cuthol composition coords --cue <cue_XX> | --all [--frames <a..b> |
  --at <sn>[,<sn>...]] [--refresh]`. MCP: `composition(action="coords",
  cue=... | all=true, frames=... | at=[...], refresh=...)`.
- Output per cue: cue, composition, frame count, cached, ms, element count,
  full JSON path, optional queried frames. With `--cue` the element rows are
  listed too (up to 40: key, kind, label, visible sequence-frame range, union
  stage box; `items_total` gives the full count); `--all` returns counts only —
  query one cue or frames for detail. Full per-frame boxes live in
  `.cuthol/coords/<key>.json` (schema `cuthol.coords/2`: local boxes plus cue
  id, sequence start frame, mapping inputs, engine/renderer versions,
  `fonts_bundled`).
- Elements carry `parent` (nearest measured ancestor) and `group` (nearest
  measured painted non-stage-sized ancestor: a card and its own text share one
  group); frames carry `ink` rows (glyph/pixel boxes: text glyph ink, image
  asset minus transparent margins) wherever they differ from the item box by
  more than 0.5 px. Transformed elements additionally carry `quads`/`ink_quads`
  rows (the four rotated corners), emitted only when the corners verify against
  the measured box (±1.2 px per edge). The geometry query reads ink when
  present and falls back to the item box.
- Cache: keyed by composition files (bridge data excluded) + used bridge
  payload hashes + props + cue duration + stage size/fps + engine + renderer
  version. Placement is NOT in the key: placement edits re-map from cache
  without re-measuring. `--refresh` forces re-measurement.
- Frame queries take sequence frames; local frame f = sn − `sequence_start_frame`.
- Failures never stop the run: a failed cue is skipped with `CUTHOL-G417`
  (WARN); raw-HTML fallback warns `CUTHOL-G418`; page errors or unmappable
  placement warn `CUTHOL-G419` (INFO).
- CSS/WAAPI animations are pinned to film time during measurement. The renderer
  does not drive them (it captures wall-clock positions), so GSAP stays the
  supported path for animated boxes.

## Geometry query (one moment, no pictures)

One-shot layout inspection at a single sequence moment: is one element's text
covered by another, how close does it sit to the frame edge, how far apart are
two elements — then you decide.

- CLI: `cuthol composition coords --at <1500ms|1.5s|45f> [--cue <cue_XX>]
  [--elements <ref>[,<ref>...]] [--refresh]`. `--at` is always sequence time
  (a cue-local time is not accepted; add the cue start). An element ref is
  `<key>` with a single `--cue`, else `cue_XX/<key>`; the key is the coordinate
  document's element key. Bare `--at 75` without `--elements` keeps returning
  legacy per-frame boxes.
- MCP: `composition(action="coords", at=["1500ms"], cue=..., elements=[...])`.
- Without `--elements`: one short row per visible element (cue, key, kind,
  label, stage item/ink boxes, opacity, z). With `--elements`: full rows
  (visibility, `parent`/`group` keys, edge distances with negative = overflow,
  outside-frame area share) plus one row per pair (horizontal/vertical gap,
  shortest distance, intersection area and smaller-area share, which element is
  on top, relation `same_group`/`ancestor`/`descendant`/`none`).
- Gaps and overlap read ink boxes when present and fall back to item boxes.
  Paint order follows cue layer order across compositions and z (then document
  order) inside one composition. When at least one end of a pair has a measured
  quad, intersection and distance use convex-polygon math on the true corners
  (axis gaps stay defined on the polygon bounding boxes) and the pair row
  reports `shape: quad`; otherwise `shape: box` with axis-aligned math.
- Source is the cache; missing cues are measured (one browser) and the answer
  names them. An unknown ref errors with the nearest measured key
  (`CUTHOL-G428`).

Example:

`cuthol composition coords --at 1500ms --cue cue_01 --elements t,card --compact`

```text
OK composition.coords
Geometry at 1500ms (frame 45, stage 1920x1080): 2 element(s), 1 pair(s); measured: none; cached: cue_01
cue_01/t text "Cover me" item=[100,100.5,210.3,62.1] ink=[102.1,112.4,205.8,40.2] op=1 z=3 visible=true parent=null group=null edges=L102.1,T112.4,R1612.1,B927.4 out=0
cue_01/card box "card" item=[150,90,300,120] ink=null op=1 z=4 visible=true parent=null group=null edges=L150,T90,R1470,B870 out=0
cue_01/t <-> cue_01/card shape=box gap=0 dx=0 dy=0 inter=6347.6 ratio=0.7672 top=cue_01/card rel=none
```

## Recipes

- **Is the title covered before render?** Query the title + the suspect layer
  at the moment of doubt: `inter` (intersection area) and `ratio` (share of the
  smaller area) say how much hides; `top` says which one wins. Ink boxes make
  this exact inside rotated containers too.
- **Overflowing the frame?** Full rows report per-edge distances (`edges=L…,
  T…, R…, B…`, negative = overflow by that many px) and `out` (outside-frame
  area share). `out=0` with all edges positive = fully inside.
- **Gap between two elements?** The pair row's `gap` (shortest distance) plus
  `dx`/`dy` (axis gaps). `gap=0` with `inter=0` = touching exactly.
- **Entering the caption band?** Compare the element's bottom edge against the
  caption row's top edge (captions sit at `y=26` by default; read their boxes
  the same way) at several moments across the scene.
- **Pre-render layout pass:** for each scene, query the end state (last second)
  plus one mid-scene moment — the pairs you named in advance (title/card,
  note/evidence, caption/graphic). What you didn't name, still check on a
  `monitor.sheet`: measurement answers the questions you asked, only the eye
  sees the one you forgot.

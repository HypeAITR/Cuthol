---
name: cuthol-color
description: >
  Grade colour in Cuthol: measure a clip or a reference as text (color.map,
  color.diff), propose blocks toward an objective target (color.solve), write
  blocks (color.set) and read the render-free prediction, compare variants with
  the untouched picture (color.compare), named Looks (color.look), source kinds,
  clusters and keyframed colour. Load when the user asks for a look, warmer or
  cooler, brighter, punchier, "like this reference", matching shots, or fixing
  exposure or white balance.
---

# Colour

Cuthol measures and describes colour; **it never changes colour by itself**.
You write blocks with `color.set`; `color.solve` only proposes. Every item's
blocks compile into one 3D LUT used by the render, the Live preview and the
prediction, so what `set` predicts is what renders.

## Rules

1. **No change without a target.** A target is the user's words, a reference
   (another clip or an image), the same scene's other clips, or a technical
   limit (clipping, a colour cast with enough neutral pixels). "Make it look
   better" with no direction: ask, or offer 2–3 variants.
2. **Always offer untouched.** Taste varies by edit (pastel and cold looks are
   deliberate). `color.compare` puts the untouched picture first; show it.
3. **Screen recordings and graphics are designed colour.** Leave them alone
   unless asked; Looks skip them by default (`color.kind` tells you).
4. **Read the prediction.** `color.set` answers with the after-map and side
   effects (e.g. "neutral highlights a+9" = a white wall turning pink). Fix
   side effects before rendering; confirm with one `monitor.frame`.
5. Say what you changed in block units ("+20 mired warmer, −0.3 stop").

## Workflow

1. `color.map(item)` — ~100 tokens: tone percentiles and clipping, neutral axis
   (low-chroma pixels per tone band, with coverage), colourfulness, hue sectors,
   evidence. `image=<file>` measures a reference.
2. Optional: `color.diff(a, b)` (two items or files) or
   `color.solve(item, to=<item|file>)` / `mode=technical` → proposed blocks
   and the exact `color.set` arguments, with predicted residual ΔE.
3. `color.set(item, ...)` with the blocks below (`items=`/`cluster=` for
   several). `reason=match|technical|taste`.
4. `color.compare(item, variants=[...])` when taste decides; let the user pick.
5. `monitor.frame` at one instant; render.

## Blocks (fixed order: wb → exposure → tone → curves → wheels → hsl → saturation → look)

| Flag | Meaning |
|---|---|
| `wb="25,0.1"` | white balance: mired (+ warmer, − cooler; 10 is subtle, 40 strong), tint (+ magenta, − green, −1..1) |
| `exposure="-0.3"` | stops |
| `tone="contrast=0.2,shadows=-0.1,highlights=-0.2,blacks=-0.2,whites=0.1"` | each −1..1 |
| `curve="master=0:0.04,0.5:0.5,1:0.96;b=0:0.05"` | monotone curves, x:y in 0..1 |
| `wheel="lift=200,0.15;gain=35,0.08"` | hue degrees (0 red, 60 yellow, 120 green, 200 teal, 240 blue, 300 magenta), amount 0..1, optional luma |
| `hsl="hsl_01=center:25,width:30,shift:-6,sat:1.15"` | secondary on a hue window; several with `;` |
| `sat="1.1"`, `vibrance="0.3"` | global saturation ×, vibrance (protects skin) |
| `look="look_01:0.6"` | bind a project Look |
| `amount="tone=0.5,hsl_01=0.8"`, `remove="curves,hsl:hsl_01"` | strength, drop |

## Words → starting blocks (then read the prediction and adjust)

| The user says | Start with |
|---|---|
| warmer / cosier | `wb="+20"` |
| cooler / clinical | `wb="-20"` |
| brighter / darker | `exposure="±0.3"`; watch clipping in the map |
| punchy, contrasty | `tone="contrast=0.25"`, `vibrance="0.25"` |
| soft, faded, pastel | `curve="master=0:0.06,1:0.94"`, `sat="0.85"` |
| crushed blacks | `tone="blacks=-0.4"` |
| clean whites | `wb` from the neutral highlights in the map, `tone="whites=0.2"` |
| teal shadows / orange highlights | `wheel="lift=200,0.15;gain=30,0.08"` |
| pink / healthier skin | `hsl="hsl_01=center:20,width:30,shift:-5,sat:1.1"` (skin hues ~15–35°) |
| greener grass, bluer sky | `hsl` at ~100° / ~210°, `sat:1.2` |
| like this picture | `color.map(image=...)`, `color.solve(item, to=<file>)`; one frame cannot separate scene colour from look: say "approximately" |
| same as the other clip | `color.solve(item, to=<other>)` or `look create from-item` + bind |

## Looks, kinds, clusters

- `color.look(op="create", name, from-item=<id> | lut=<file.cube> | blocks=<json>, apply_to="all"|ids, kinds="camera")`,
  `op="from-pair"` (before/after files of the same frame → exact LUT),
  `op="bind" look items`, `op="list"`, `op="remove"`.
- `color.kind(handle)` measures camera/screen/graphic; `set=` corrects it,
  `input=auto` tone-maps HDR (HLG/PQ) sources to SDR.
- `color.clusters()` groups clips from the same setup and marks ungraded ones.
- Keyframes: `spine.envelope(param="color.exposure.stops", ...)`, also
  `color.white_balance.temp_mired`, `color.tone.contrast`,
  `color.saturation.saturation`, `color.look.amount`, `color.hsl.<id>.<field>`.
- `color.migrate(item | all)` converts an old `spine.grade` to blocks.

## Gates (technical only; appearance is never a warning)

G130–G133 ERROR: block amount out of range, unknown/duplicate Look, Look LUT
file missing. G134–G137 WARN: two Looks reach one item, a Look on a screen or
graphic source, HDR source with input `none`, an ungraded clip of the same
source as graded ones. G510 INFO: post-render colour check matches the
prediction (per-item mean dE). G512 WARN: rendered colour differs from the
prediction (mean dE > 3) → re-measure, check the stage LUT.

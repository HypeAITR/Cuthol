# Effects: transform, grade, fx, transitions, envelopes, reframe

## Static placement and edges (`spine.transform`)

`transform(clip, x, y, scale, scale_x, scale_y, rotation, opacity, fit,
mirror_x, mirror_y, edge)` — all values absolute (`"1.2"`) or relative
(`"+=0.1"`, `"-=5"`). `fit`: `cover` (fill, crop), `contain` (letterbox),
`fill` (stretch). `edge`: `transparent` (default, layer below shows), `mirror`
(reflected copy fills the uncovered area), `clamp` (stretched edge pixels);
spine clips only (G121 on lane cues). A clip that already covers the stage and
never moves makes any edge mode a no-op (G412).

## Colour (`spine.grade`)

`grade(clip, brightness?, contrast?, saturation?, temperature?, lut?)` —
constant grade of a spine clip. `brightness` −1..1 (default 0),
`contrast`/`saturation` multipliers (default 1), `temperature` white balance
1000..40000 K (default 6500 = neutral, no filter; out of range is G124), `lut`
a project-relative `.cube`/`.3dl` file applied last (`'none'` clears;
missing/unreadable/outside-project is G414 and blocks render). A keyframed
brightness/contrast/saturation envelope (CLI `cuthol spine envelope --param
treatments.color_grade.*`) overrides the matching constant in the render.

## Per-clip effects (`spine.fx`)

`fx_add(clip, kind|filter, params?)` / `fx_set(clip, fx, params?|filter?)` /
`fx_remove(clip, fx)` / `fx_list(clip)` — a chain compiled in the clip's own
filter graph after colour (source asset untouched, transcript bindings stay).
`kind="ext:<ext>/<fx>"` (enable the extension first) or raw
`filter="gblur=sigma=3"` (no `[` `]` `;`, no file-reading/command filters).
Params merge on set; ids are `fx_XX` per clip. Animate only manifest-declared
`animatable` params via `envelope(clip, param="fx.<id>.<param>", ...)` (G119
otherwise). Unknown kinds/params are G118, drifted extensions warn G411.

## Transitions (`spine.transition`)

`transition(clip, kind, duration, easing, params?)` — outgoing transition into
the next clip. Builtins: `dissolve`, `fade`, `wipe_left`, `wipe_right`,
`slide_up`, `zoom_in`, `none`; or an extension transition
`ext:<extension>/<name>` (see `cuthol-extensions`, manifest `transitions`
section). Extension transitions take `params` (`{"name": value}`; CLI
`--param name=value,...`); builtins take none (G123). Duration ≤ half of the
shorter neighbouring clip (G303, also for `ext:`). Unknown/disabled `ext:`
kinds are G122 (edits and render refuse); `cubic_bezier` easing on `ext:` takes
control points (CLI `--easing "cubic-bezier(x1,y1,x2,y2)"`; bad curves are
G120). The blend happens after the cut point (it overlaps the start of the
next clip). Transitions are video-only: spine audio hard-cuts at the boundary.

## Keyframe envelopes (`spine.envelope`)

`envelope(clip, param, points=["0ms:1.0","4s:1.15"], easing, bezier?)` —
keyframes over the item's own time (0 = its start), on spine clips and lane
cues. Params: `placement.x_pct`, `placement.y_pct`, `placement.scale_x`,
`placement.scale_y`, `placement.rotation_deg`, `placement.opacity`,
`audio_chain.gain_db`, `treatments.color_grade.brightness|contrast|saturation`,
`fx.<id>.<param>` (animatable only). A slow zoom needs both `scale_x` and
`scale_y` (compiled with sub-pixel interpolation, so slow ramps advance
smoothly without stepping or aspect wobble).

`easing`: `linear`, `ease_in`, `ease_out`, `ease_in_out`, `hold` (step: previous
value until the keyframe, jumps at it; envelopes only, G120 in transitions), or
CSS `cubic-bezier(x1,y1,x2,y2)` (CLI: `--easing "cubic-bezier(0.25,0.1,0.25,1)"`;
MCP: `bezier="0.25,0.1,0.25,1"`; x1,x2 in 0..1, else G120). Invalid curves are
rejected at input and by verify.

Envelope uses beyond motion: duck a music hit with a short `audio_chain.gain_db`
dip, dip to black with an `opacity` envelope, cut music instantly with a 50 ms
gain drop, punch in with two scale points 1 frame apart.

## Reframe (`spine.reframe`)

When wider footage (e.g. 16:9) is placed on a narrower stage (e.g. 9:16, where
`asset_aspect / stage_aspect > 1.03`), the default centre crop (`fit="cover"`,
`x=0`) shows roughly the middle third and can cut off a subject standing left
or right. Call `spine(action="reframe", clip="sp_01")` (or omit `clip` / pass
`all_spine=true` for all spine clips). On a `16:9` stage (or when the subject
stays centred within `deadband`) it leaves `scale_x=1, x_pct=0` and writes zero
unnecessary pan keyframes.

What it writes: `placement.fit_mode="cover"`, `placement.scale_x =
asset_aspect / stage_aspect` (`scale_y=1`), `treatments.reframe`
(`focal_points`), and a smooth `placement.x_pct` envelope (`ease_in_out` ramps
between stationary plateaus controlled by hysteresis `deadband`, default
`3.2`%). Later `spine.split`, `spine.excise` and `spine.speed` edits slice and
rescale both focal points and the envelope.

Modes: `mode="subject_track"` (default, automatic horizontal tracking),
`mode="center_lock"` (static crop at `x`, 0..100 in source width, default 50),
`mode="off"` (reset). Manual points (`points=["0ms:50", "40s:64"]`,
`offset:center_x_pct` with 0 = left edge, 100 = right edge) patch the auto
track within ±1.2 s with `replace=false` (default), or rebuild the envelope
from points alone with `replace=true`.

Limits: no neural detector — tracking uses a deterministic low-resolution
signal pipeline (skin-cluster + head silhouette, foreground motion,
border-contrast saliency) at 160 px wide @ 4 fps (8 fps for clips ≤ 4 s). It
assumes a **single primary subject**; multiple people, skin-coloured clutter or
heavy lighting shifts can pull the crop. Check `mean_confidence`,
`min_confidence` and `low_confidence_ranges_ms`, look at frames with
`monitor.frame` (especially around pan transitions), and pin bad spans with
`points` / `replace=true` / `mode="center_lock"`. Reframing is horizontal only.

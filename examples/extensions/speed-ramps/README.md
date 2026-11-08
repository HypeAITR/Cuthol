# speed-ramps (example recipes extension)

Two parameterized recipes over the core speed ramp. Shows the `recipes`
manifest gate: `{{param}}` interpolation into step args, and one atomic
undo unit for all steps (a failing step rolls everything back).

## Recipes

| Recipe | What it does |
|---|---|
| `slow_middle` | Ramps 1x to `rate` (default 0.5) between `b` and `c`, with a scale punch to `zoom` while slow. |
| `fast_middle` | Ramps 1x to `rate` (default 2) between `b` and `c`, with a scale punch to `zoom` while fast. |

Each recipe runs three steps: `spine.speed` (the ramp), then two
`spine.envelope` steps (scale x and y, which must move together).

## Enable and use

```sh
cp -r examples/extensions/speed-ramps <project>/.cuthol/extensions/
cuthol extension enable --name speed-ramps --dir <project>
cuthol extension run --name speed-ramps --recipe slow_middle --params '{"clip": "sp_01"}' --dry-run --dir <project>
cuthol extension run --name speed-ramps --recipe slow_middle --params '{"clip": "sp_01"}' --dir <project>
```

Preview with `--dry-run` first: it lists the steps without touching the
sequence.

## Parameters

- `clip` (required): spine clip id.
- `a`, `b`, `c`, `d`: ramp marks in source time (defaults fit a 4 s
  clip: `0s`, `1s`, `3s`, `4s`). Must increase and fit the clip's
  source span, otherwise the run fails and nothing is applied.
- `rate`: middle rate (0.1..16).
- `zoom`: middle scale (1..2).

## Known limits

- Ramp marks are source times; the scale envelope is clip-local, so on
  a steep ramp the punch and the rate dip overlap only roughly.
- Pitch preservation is pinned on; rates outside 0.5..2x raise a
  `CUTHOL-G410` warning (never an error).
- One `undo` reverts the whole recipe: ramp and both envelopes.

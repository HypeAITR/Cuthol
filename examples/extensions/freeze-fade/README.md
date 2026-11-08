# freeze-fade (example processor extension)

Two `ffmpeg` media processors. Shows the `processors` manifest gate: a
declarative filter turns an input handle into a new cached, journaled
library asset. No script needed.

## Processors

| Name | What it does | Audio |
|---|---|---|
| `hold` | Freezes the last frame for `seconds` (default 1) | dropped (`"audio": "drop"`) |
| `fade_in` | Fades video up from black over `seconds` (default 0.5) | kept (duration unchanged) |

## Enable and use

```sh
cp -r examples/extensions/freeze-fade <project>/.cuthol/extensions/
cuthol extension enable --name freeze-fade --dir <project>
cuthol extension run --name freeze-fade --processor hold --input vid_01 --params '{"seconds": 2}' --dir <project>
```

The run prints the new handle (e.g. `vid_02`); place it with
`cuthol spine append --asset vid_02 --dir <project>`.

## Parameters

- `hold.seconds`: number, 0.1..10.
- `fade_in.seconds`: number, 0.1..5.

## Known limits

- `hold` changes the duration, so it must declare `"audio": "drop"`;
  without it the old-length audio would be copied with a `CUTHOL-G209`
  warning. `fade_in` keeps the duration, so the default audio copy
  stays silent.
- Outputs cache by input + extension identity + params: re-running with
  identical bytes returns the cached library item.
- A `fade_in` clip starts on black frames, so the post-render blank scan
  reports them as `CUTHOL-G502` (a warning, not an error). It is the
  intended fade; check the frame with `monitor frame` and move on.
- Processors produce new assets; unlike `spine fx` they do not keep the
  clip's transcript binding. Prefer `fx` for looks, processors for new
  media (freeze holds, retimes, conversions).

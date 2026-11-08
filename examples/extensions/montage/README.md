# montage (example planners extension)

Two sandboxed Node planners. Shows the `planners` manifest gate: a
script reads a read-only snapshot (sequence, words, compositions,
events) and returns a Cue Sheet patch. `dry_run` previews the diff; a
real run applies it in one atomic revision.

## Planners

| Planner | Input it teaches | Output |
|---|---|---|
| `assemble` | `snapshot.sequence.library` + spine ids | `spine` entries appended after the current clips |
| `event_sfx` | `snapshot.events` (composition-declared, in `sequence_ms`) | `cues` on `ln_sfx` |

## Enable and use

```sh
cp -r examples/extensions/montage <project>/.cuthol/extensions/
cuthol extension enable --name montage --dir <project>
cuthol extension run --name montage --planner assemble --params '{"handles": "vid_01,vid_02", "clip_ms": 1500}' --dry-run --dir <project>
cuthol extension run --name montage --planner assemble --params '{"handles": "vid_01,vid_02", "clip_ms": 1500}' --dir <project>
```

For `event_sfx`, mount a composition that declares the event (e.g. an
`events.json` with `[{ "name": "paper_drop", "at_ms": 800 }]`), ingest an
audio asset, then:

```sh
cuthol extension run --name montage --planner event_sfx --params '{"drop_asset": "aud_01"}' --dir <project>
```

## Parameters

- `assemble.handles` (required): comma-separated library handles.
  Unknown handles are skipped with a note, never planned.
- `assemble.clip_ms`: head length taken from each asset, clamped to
  the asset duration (default 1500).
- `event_sfx.event` (default `paper_drop`), `drop_asset` (default
  `aud_02`), `duration_ms` (default 400), `gain_db` (default -5). A
  numeric `gain_db` in the event meta overrides the param.

## Known limits

- Scripts run in an isolated child process with their own temp dir;
  they may write only the patch file. Writing elsewhere fails with
  `CUTHOL-G206`.
- Default time budget is 120 s (`timeout_sec`, `0` removes it).
- An invalid patch (bad handle, bad lane) applies nothing and reports
  the gate that refused it.

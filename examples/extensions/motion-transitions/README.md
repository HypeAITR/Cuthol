# motion-transitions (example transitions extension)

Three spine transitions declared as ffmpeg templates, with no code.
Shows the `transitions` manifest gate: kinds used as
`transition_out.kind = "ext:motion-transitions/<name>"`.

## Transitions

| Kind | Look |
|---|---|
| `push` | Incoming slides in from the right, outgoing slides out left. |
| `flash` | White flash dissolve: outgoing burns to white while incoming dissolves in and fades back from white. |
| `wipe_reveal` | Incoming wipes in from the right over the held frame; `span` (0.1..1) scales the travel. |

`{{p}}` is the eased progress (0 to 1) and already carries the
transition easing. Chain fields (`outgoing_filter`, `incoming_filter`,
`incoming_scale`) run on local clip time; overlay fields (`incoming_x`,
`outgoing_x`) run on sequence time with `{{t1}}`, `{{W}}`, `{{x}}`.

Quoting rule: `{{p}}` expands to a comma-containing ffmpeg expression,
and the compiler quotes overlay fields but not chain fields. So a chain
template must quote it itself (`eq=brightness='{{p}}'`), while overlay
templates stay unquoted (`{{W}}-{{W}}*{{p}}`). An unquoted `{{p}}` in a
chain field fails the render with an ffmpeg parse error.

## Enable and use

Copy this folder to the project extensions directory, then enable it:

```sh
cp -r examples/extensions/motion-transitions <project>/.cuthol/extensions/
cuthol extension enable --name motion-transitions --dir <project>
cuthol spine transition --clip sp_01 --kind ext:motion-transitions/push --duration 400ms --dir <project>
```

There is no `--path` flag on `extension enable`; the core finds the
extension by `--name` in `<project>/.cuthol/extensions/` or in the
persistent extensions directory.

## Parameters

`push` and `flash` take none; `wipe_reveal` takes `span` (number,
0.1..1, default 1):

```sh
cuthol spine transition --clip sp_03 --kind ext:motion-transitions/wipe_reveal --duration 500ms --param span=0.6 --dir <project>
```

Unknown params or out-of-range values fail the edit with
`CUTHOL-G123`, never a silent default.

## Known limits

- Transitions are video-only: spine audio still hard-cuts at the clip
  boundary, exactly as with built-ins.
- Duration must fit the G303 bound (at most half of the shorter
  neighbour clip).
- `flash` relies on the default hold: the outgoing frame is held under
  the incoming one during the window. A chain filter on the outgoing side
  is only visible where the incoming clip lets it through, so the
  incoming side fades its own alpha in (`fade=t=in:...:alpha=1`, the same
  filter the built-in dissolve uses) before lifting brightness.
- `incoming_scale` is not used here. For a zoom, use the built-in `zoom_in`,
  which zooms through `perspective` at a constant frame size.

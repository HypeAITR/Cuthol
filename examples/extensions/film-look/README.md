# film-look (example clip-effects extension)

Five per-clip effects for `spine fx`. Shows the `fx` manifest gate:
each entry is a named ffmpeg template with `{{param}}` placeholders,
substituted per clip in the render graph. The source asset is never
touched.

## Effects

| Kind | Filter | Params |
|---|---|---|
| `ext:film-look/film_grain` | `noise=alls={{strength}}:allf=t` | `strength` 0..40, default 8 |
| `ext:film-look/vignette` | `vignette=angle={{angle}}` | `angle` 0.1..1.5, default 0.63 |
| `ext:film-look/rgb_split` | `rgbashift=rh={{shift_r}}:bh={{shift_b}}` | shifts in px, -40..40 |
| `ext:film-look/soft_focus` | `gblur=sigma={{sigma}}` | `sigma` 0..20, static |
| `ext:film-look/pulse` | `eq=brightness={{level}}:eval=frame` | `level` -1..1, envelopeable |

## Enable and use

```sh
cp -r examples/extensions/film-look <project>/.cuthol/extensions/
cuthol extension enable --name film-look --dir <project>
cuthol spine fx add --clip sp_01 --kind ext:film-look/film_grain --param strength=12 --dir <project>
cuthol spine fx add --clip sp_01 --kind ext:film-look/vignette --dir <project>
```

Effects on one clip form an ordered chain; list and reorder with
`spine fx list` / `remove` / `set`.

## Animating one param

`pulse` declares `"animatable": ["level"]`, so an envelope may drive it
(replace `fx_05` with the id from `spine fx list`):

```sh
cuthol spine envelope --clip sp_01 --param fx.fx_05.level --points "0ms:0,500ms:0.6,1s:0" --dir <project>
```

Two rules: the template must not quote the placeholder (the compiler
quotes the animated expression itself), and the ffmpeg option must
accept per-frame expressions (`eq` needs `:eval=frame`; `gblur`'s
`sigma` rejects expressions, so `soft_focus` stays static).

Envelopes on any other effect param fail with `CUTHOL-G119` instead of
silently doing nothing.

## Known limits

- Templates must not contain `[`, `]` or `;` (one shared chain), and
  every `{{name}}` must be a declared param, otherwise the manifest is
  rejected with `CUTHOL-G112`.
- Unknown effect params fail the edit (`CUTHOL-G118`); effects of a
  disabled extension fail the render (`CUTHOL-G118`), never silently.

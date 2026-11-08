# caption-kit (example helper + asset pack extension)

Small caption utilities for compositions. Shows the `helper` and
`assets` manifest gates: the helper is synced into every composition as
`assets/cuthol-ext-caption-kit.js` (exposed on
`window.__cuthol.ext["caption-kit"]`, usable as `C.ext["caption-kit"]`),
and the asset pack lands in `<composition>/assets/ext/caption-kit/`.

## Helper API (pure functions of time)

| Function | Signature | Returns |
|---|---|---|
| `activeWord` | `(words, t)` — words are `{start, end}` seconds | index spoken at `t`, or -1 |
| `typewriter` | `(text, t, cps)` | visible prefix at `t` for `cps` chars/sec |
| `counter` | `(target, t, dur)` | eased 0..`target` count at `t` |

```js
var kit = C.ext["caption-kit"];
var i = kit.activeWord([{ start: 0.4, end: 0.9 }], t);
```

## Asset pack

- `assets/caption-kit.css` — `.ck-caption` word-highlight style; link
  with `<link rel="stylesheet" href="assets/ext/caption-kit/caption-kit.css" />`.
- `assets/pill.svg` — rounded lower-third backdrop; use with
  `<img src="assets/ext/caption-kit/pill.svg" />`.

## Enable and use

```sh
cp -r examples/extensions/caption-kit <project>/.cuthol/extensions/
cuthol extension enable --name caption-kit --dir <project>
cuthol composition scaffold --comp-dir compositions/cap1 --duration 4s --dir <project>
```

`demo/index.html` is a complete composition that uses all three
helpers, the stylesheet and the SVG. Copy it over the scaffolded
`index.html`, then mount it:

```sh
cp examples/extensions/caption-kit/demo/index.html <project>/compositions/cap1/index.html
cuthol lane add-composition --lane ln_motion --comp-dir compositions/cap1 --at 1s --duration 4s --dir <project>
```

After enabling, new and existing compositions carry the `<script
src="assets/cuthol-ext-caption-kit.js"></script>` tag and the synced
asset folder. If a composition renders with missing styles, re-run
`extension enable` and check `assets/ext/caption-kit/` inside it.

## Known limits

- The helper must stay dependency-free: compositions render offline, so
  no network loads and no async font waits.
- If the extension sources drift after enabling, `verify` warns and
  `render` stops (`CUTHOL-G205`); re-run `extension enable` to accept
  the new hash.

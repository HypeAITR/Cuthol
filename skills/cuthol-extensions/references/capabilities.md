# Extension capabilities in detail

## 1. Composition helper (`helper`)

When the extension is enabled in a project (`extension.enable`),
`syncCompositionBridgeFiles` copies the helper into each composition's
`assets/cuthol-ext-<name>.js` and injects `<script
src="assets/cuthol-ext-<name>.js"></script>` immediately after `<script
src="assets/cuthol-runtime.js"></script>`. Only exact Cuthol-managed tags are
added or removed; user `<script>` tags are never modified. Projects with no
enabled extensions have zero extra tags or files touched.

Expose your helper on `window.__cuthol.ext.<name>` (accessible as `C.ext.<name>`):

```js
(function (root) {
  var C = (root && root.__cuthol) ? root.__cuthol : (root.__cuthol = {});
  C.ext = C.ext || {};
  C.ext.mouth = {
    state: function (t) {
      var e = C.global ? C.global.audio("mid", t) : C.audio("mid", t);
      return e > 0.45 ? "wide" : e > 0.18 ? "small" : "closed";
    }
  };
})(typeof window !== "undefined" ? window : globalThis);
```

## 2. Asset pack (`assets`)

Files inside the extension's `assets` directory sync into
`<composition>/assets/ext/<name>/…`. Reference them directly:

- Images: `<img src="assets/ext/kit/logo.png" />`
- Fonts: `@font-face { font-family: "Brand"; src: url("assets/ext/kit/brand.ttf"); }`

## 3. Media processors (`processors`)

Transform an input library handle (`aud_01`, `vid_01`, `img_01`, `vo_01`) or
file path into a new library asset:

- **`kind: "ffmpeg"`**: declarative filter chain (`audio_filter` / `filter` /
  `video_filter` / `ffmpeg_args`) with `{{param}}` interpolation. `atempo`
  values above `2.0` or below `0.5` chain automatically into valid stages.
- **`kind: "node"`**: runs `script` in an isolated child process (`node <script>
  <inputPath> <outputPath> <paramsJson>`). Must exit `0`, write the output file
  to `<outputPath>`, and print a single-line JSON summary to `stdout`. The
  child receives `CUTHOL_EXT_TMP`, a `tmp/` directory inside the sandbox, for
  side files (e.g. an ffmpeg `sendcmd` file); it is deleted when the run ends.
- **`asset_kind`** (optional): `footage`, `audio`, `graphic`, `voiceover`, or
  `composition`. Anything else is `[CUTHOL-G112]` and is not remapped. Omitted
  processors keep the probed kind.
- **`audio`** (optional, `kind: "ffmpeg"` only): `"copy"` (default) or
  `"drop"` (`-an`, removes the audio stream). Anything else, or `audio` on a
  node processor, is `[CUTHOL-G112]`.
- **`timeout_sec`** (optional, processors and planners): integer ≥ 0. Omitted
  node processors and planners are killed after 120 seconds. `0` means no
  limit. Invalid values are `[CUTHOL-G112]`; on timeout the error names the
  limit. An omitted ffmpeg processor has no wall-clock limit; a set
  `timeout_sec` applies to that ffmpeg run too.
- **A/V duration:** after every run (including cache hits) Cuthol probes the
  output streams. If both video and audio exist and differ by more than one
  frame (40 ms without a frame rate), the result includes `WARN [CUTHOL-G209]`
  with both durations. Fix with `"audio": "drop"` or an `audio_filter` that
  keeps the streams aligned. A `video_filter` that does not change duration
  (e.g. `hue=s=0`) stays silent and still copies audio.
- **Caching & journal:** outputs cache in `.cuthol/ledger.sqlite` (and the
  shared cache if enabled) keyed by `sha256(input_sha256 | ext_name |
  ext_version | ext_content_hash | processor | canonical_params)`. `audio` and
  `timeout_sec` join the key only when the manifest sets them, so existing
  processors keep their cache key. A library hit is reused only when the stored
  item's kind matches the processor's resolved kind. The result is probed and
  added to `seq.library` inside `JournalGuard`, so undo cleanly reverts it.

Example manifest excerpt:

```json
{
  "schema_version": "1.0.0",
  "name": "mouth",
  "version": "1.0.0",
  "description": "Audio-driven mascot mouth state helper.",
  "network": false,
  "helper": "helper.js",
  "assets": "assets",
  "processors": {
    "atempo": {
      "kind": "ffmpeg",
      "description": "Speed up audio via FFmpeg atempo.",
      "output_ext": ".wav",
      "asset_kind": "audio",
      "params": {
        "rate": { "type": "number", "default": 1.3, "min": 0.5, "max": 4.0 }
      },
      "audio_filter": "atempo={{rate}}"
    }
  },
  "recipes": {
    "fast_vo": {
      "description": "Speed up an audio handle and place it on ln_vo.",
      "params": {
        "handle": { "type": "string", "required": true },
        "rate": { "type": "number", "default": 1.3 },
        "at": { "type": "string", "default": "0s" }
      },
      "steps": [
        {
          "id": "spd",
          "tool": "extension",
          "action": "run",
          "args": { "name": "mouth", "processor": "atempo", "input": "{{handle}}", "params": { "rate": "{{rate}}" } }
        },
        {
          "id": "vo",
          "tool": "lane",
          "action": "add_cue",
          "args": { "lane": "ln_vo", "asset": "{{steps.spd.handle}}", "at": "{{at}}" }
        }
      ]
    }
  },
  "guide": "README.md"
}
```

### Per-clip effects (`fx`) — example

```json
{
  "name": "fxdemo",
  "version": "1.0.0",
  "description": "demo clip effects",
  "fx": {
    "soft_blur": {
      "description": "Gaussian blur",
      "params": { "sigma": { "type": "number", "default": 4, "min": 0, "max": 50 } },
      "animatable": ["sigma"],
      "video_filter": "gblur=sigma={{sigma}}"
    }
  }
}
```

After `extension.enable`, agents call `spine.fx_add(clip="sp_01",
kind="ext:fxdemo/soft_blur", params={"sigma": 8})`; the template is substituted
per clip in the render graph (source asset untouched). `fx` entries are
`{description?, params?, video_filter, animatable?}`: `video_filter` is an
ffmpeg template with `{{param}}` placeholders (no `[` `]` `;`);
`animatable` lists the number params keyframeable via
`envelope(param="fx.<id>.<param>")`; every `{{name}}` must be a declared param.
Unknown keys, undeclared placeholders and `[` `]` `;` are `[CUTHOL-G112]`.

## 4. Recipes (`recipes`)

Parameterized sequences of Cuthol actions (`steps`). Step arguments interpolate
`{{param}}`, `{{last_handle}}`, or `{{steps.<step_id>.handle}}`. **Single
atomic undo unit:** all sequence changes commit as one revision (`rN ->
r(N+1)`), while `steps_executed` reports each step. If any step fails, prior
steps roll back automatically.

## 5. Planners (`planners`)

When an edit needs a **data-dependent, variable number of cues** (e.g. sound
effects on every visual event across several compositions plus spoken
keywords), a static `recipe` is not enough. A **planner** runs a sandboxed
child-process Node script (`node <script> <snapshotJsonPath> <outputPatchJsonPath>
<paramsJson>`):

- **Read-only input snapshot (`cuthol.planner.snapshot/1`):** `sequence` (full
  state), `words` (all unexcised transcript words in sequence coordinates),
  `compositions` (each mounted composition: `cue_id`, `lane_id`,
  `composition_dir`, `at_ms`, `duration_ms`, `end_ms`, `props`, window `words`,
  `cuts`, `events`), `events` (flattened chronological list with local and
  sequence times, `meta`, `source`).
- **How a composition declares events (no browser render required):**
  1. `events.json` (or `cuthol-events.json` / `assets/events.json` /
     `assets/cuthol-events.json`): `[{ "name": "paper_drop", "at_ms": 800,
     "meta": { "gain_db": -4 } }]` (also `at_sec`, `t`, `offset_ms`, `at:
     "800ms"`).
  2. `<script id="cuthol-events" type="application/json">[…]</script>` in `index.html`.
  3. HTML attributes: `<div data-cuthol-event="paper_drop" data-cuthol-at="800ms"
     data-cuthol-meta='{"gain_db":-5}'></div>` (or `data-start="0.8"`).
  4. Static JS calls: `C.event("paper_drop", 0.8, { gain_db: -4 })`.
  
  Every local timestamp converts automatically to timeline coordinates
  (`sequence_ms = cueStartMs + local_ms`).
- **`timeout_sec`** and **`CUTHOL_EXT_TMP`**: same as processors (120 s default,
  `0` removes it; temp dir deleted afterwards).
- **Output (Cue Sheet patch), dry-run plan & atomic apply:** the script writes
  `{ "cues": [...], "notes": [...] }` (`id` optional on new cues, auto-allocated
  as `cue_XX`). Cuthol validates with `planCueSheet`: `dry_run=true` returns
  the planned diff without modifying the sequence; a failing gate (e.g. `G103`)
  or invalid patch applies **nothing**; otherwise the whole patch commits in
  **one atomic revision**.

#### Example: SFX on "paper drop" events (`paper_sfx`)

1. Declare the event in your composition:
   ```html
   <div class="sheet" data-cuthol-event="paper_drop" data-cuthol-at="800ms" data-cuthol-meta='{"gain_db":-4}'></div>
   ```
2. `.cuthol/extensions/paper_sfx/cuthol-extension.json`:
   ```json
   {
     "schema_version": "1.0.0",
     "name": "paper_sfx",
     "version": "1.0.0",
     "description": "Places SFX cues at composition paper_drop events and target spoken words.",
     "planners": {
       "sync_sfx": {
         "description": "Proposes ln_sfx cues from composition events and word timings.",
         "script": "planner.js",
         "params": {
           "drop_asset": { "type": "string", "default": "aud_02" },
           "gain_db": { "type": "number", "default": -5 }
         }
       }
     }
   }
   ```
3. `.cuthol/extensions/paper_sfx/planner.js`:
   ```js
   #!/usr/bin/env node
   const fs = require("node:fs");
   const [snapshotPath, outputPath, rawParams] = process.argv.slice(2);
   const snap = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
   const params = rawParams ? JSON.parse(rawParams) : (snap.params || {});
   const cues = [];
   for (const ev of snap.events) {
     if (ev.name === "paper_drop") {
       cues.push({
         lane_id: "ln_sfx",
         kind: "sfx",
         asset_handle: params.drop_asset,
         at_ms: ev.sequence_ms,
         duration_ms: 400,
         gain_db: (ev.meta && typeof ev.meta.gain_db === "number") ? ev.meta.gain_db : params.gain_db
       });
     }
   }
   fs.writeFileSync(outputPath, JSON.stringify({ cues }, null, 2), "utf8");
   ```
4. Preview and apply in one revision:
   - Preview: `extension(action="run", name="paper_sfx", planner="sync_sfx", dry_run=true)`
   - Apply: `extension(action="run", name="paper_sfx", planner="sync_sfx")`

## 6. Spine transition kinds (`transitions`)

An extension registers spine transition kinds used as
`transition_out.kind = "ext:<name>/<transition>"`
(`spine.transition(clip="sp_01", kind="ext:myext/push", duration="400ms",
params={"dir": "left"})`; CLI `cuthol spine transition --clip sp_01 --kind
ext:myext/push --duration 400ms --param dir=left`). No JS: a transition is
ffmpeg filter/expression templates with `{{placeholder}}` substitution.

Fields per transition (all optional except the name): `description`, `params`
(same schema as processor params), `hold_outgoing` (default `true`; `false` =
fade-like, outgoing not held under incoming), `outgoing_filter` /
`incoming_filter` (ffmpeg templates on the clip chains, local clip time `t`),
`incoming_scale` (centered scale-factor expression, e.g. `"0.8+0.2*{{p}}"`,
guarded to the window by the compiler), `incoming_x` / `incoming_y` and
`outgoing_x` / `outgoing_y` (overlay position expressions, sequence time `t`;
omitted = base position).

Placeholders: chain fields accept `t0` (window start, local s), `dur` (duration
s), `p` (eased progress in `[0,1]`, already carries the easing); overlay fields
additionally accept `t1` (window end, s), `W`/`H` (stage px), `x`/`y` (base
overlay expressions); every field accepts the transition's own `{{param}}`
values (validated numbers/strings/booleans; booleans render as `1`/`0`).
Unknown placeholders are `[CUTHOL-G112]`. `easing` is `linear`/`ease_in`/
`ease_out`/`ease_in_out`/`cubic_bezier` (bezier control points live on the
transition; bad curves are `[CUTHOL-G120]`). Guard position templates
builtin-style: `if(lt(t,{{t1}}),<motion>,{{x}})`.

```json
"transitions": {
  "push": {
    "description": "Incoming slides in from the right, outgoing slides out left.",
    "incoming_x": "if(lt(t,{{t1}}),{{W}}-{{W}}*{{p}},{{x}})",
    "outgoing_x": "if(lt(t,{{t1}}),{{x}}-{{W}}*{{p}},{{x}}-{{W}})"
  }
}
```

Rules: the G303 duration bound (≤ half of the shorter neighbour) applies to
`ext:` transitions too. Unknown/disabled `ext:` kinds fail edits and render
with `[CUTHOL-G122]` (never a silent dissolve); bad params with `[CUTHOL-G123]`
(builtins take no params); a changed extension warns `[CUTHOL-G413]` on
`verify` (re-pin with `extension.enable`). Transitions are video-only: spine
audio hard-cuts at the clip boundary exactly as with builtins. An extension
whose transitions are in use cannot be disabled until those transitions are
replaced (G122). `extension.show` returns the `transitions` manifest section.

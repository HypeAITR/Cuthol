# Cuthol Extensions (`extension` tool & `cuthol extension`)

Cuthol provides an extension environment so agents can package reusable composition helpers, brand kits (fonts/icons/images), media processors (`ffmpeg` filter chains or sandboxed child-process `node` scripts), timeline planners (`planners`, proposing variable-length Cue Sheet patches from composition events and word timings) and multi-step editing recipes without modifying or recompiling Cuthol or restarting the MCP server.

## Storage & precedence

- **Project-local (temporary):** `<project>/.cuthol/extensions/<name>/` (`scope="project"`). Available only in that project.
- **Persistent (user-level):** `~/.cuthol/extensions/<name>/` (`scope="persistent"`). Available across all Cuthol projects on the machine.
  - Redirect persistent location: `CUTHOL_EXTENSIONS_DIR=/path/to/extensions` (or `CUTHOL_USER_EXTENSIONS_DIR` / `CUTHOL_SHARED_EXTENSIONS_DIR`). If unset and `CUTHOL_CACHE_DIR` points to a custom cache folder, defaults to the sibling `extensions/` folder.
  - Disable persistent extensions: `CUTHOL_EXTENSIONS_DIR=0` (or `false`, `off`, `none`) or `CUTHOL_DISABLE_EXTENSIONS=1`. During `npm test`, `test_setup.ts` sets `CUTHOL_EXTENSIONS_DIR=0` by default so tests never write to `~/.cuthol/extensions`.
- **Precedence:** If an extension with the same `<name>` exists in both `<project>/.cuthol/extensions/<name>` and `~/.cuthol/extensions/<name>`, the **project-local version wins** (`scope="project"`, and `list` marks `shadowed_persistent: true`).
- **Zero-restart discovery:** Every `extension` call reads from disk on demand; newly created or edited extensions are immediately visible without restarting the MCP server.

## Closed manifest schema (`cuthol-extension.json`)

Every extension folder must contain a `cuthol-extension.json` file whose `name` matches the folder name (`^[a-z][a-z0-9_-]{0,63}$`). Unknown fields are rejected with `[CUTHOL-G112]`.

Allowed top-level fields:
- `schema_version` (optional): `"1.0.0"`
- `name` (required): lowercase identifier matching the folder name
- `version` (required): version string, e.g. `"1.0.0"`
- `description` (required): non-empty summary
- `network` (optional): `boolean` (default `false`). Declare `true` if the extension accesses the network; shown in `extension.list`.
- `helper` (optional): relative `.js` path (e.g. `"helper.js"` or `{ "entry": "helper.js" }`)
- `assets` (optional): relative folder path (e.g. `"assets"` or `{ "dir": "assets" }`)
- `processors` (optional): map of processor definitions (`Record<string, ExtensionProcessorSpec>`)
- `fx` (optional): map of per-clip effect definitions for `spine fx` (`Record<string, ExtensionFxSpec>`): each entry is `{ description?, params?, video_filter, animatable? }`. `video_filter` is an ffmpeg video-filter template with `{{param}}` placeholders (no `[` `]` `;`), substituted per clip at render time. `animatable` lists the number params whose option accepts a per-frame expression, so agents may keyframe them with `envelope(param="fx.<id>.<param>")`; every `{{name}}` must be a declared param.
- `planners` (optional): map of planner definitions (`Record<string, ExtensionPlannerSpec>`, each with `script`, optional `description`, `params`, and `timeout_sec`)
- `recipes` (optional): map of recipe definitions (`Record<string, ExtensionRecipeSpec>`)
- `transitions` (optional): map of spine transition definitions (see *Spine transition kinds* below)
- `guide` (optional): relative markdown path (default `"README.md"`), readable via `guide(topic="ext:<name>")`

Example `cuthol-extension.json`:

```json
{
  "schema_version": "1.0.0",
  "name": "mouth",
  "version": "1.0.0",
  "description": "Audio-driven mascot mouth state helper with hysteresis and 2-frame hold.",
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

After `extension.enable`, agents call `spine.fx_add(clip="sp_01", kind="ext:fxdemo/soft_blur", params={"sigma": 8})`; the template is substituted per clip in the render graph (source asset untouched). `animatable` must name declared number params; unknown keys, undeclared `{{placeholders}}` and `[` `]` `;` in the template are `[CUTHOL-G112]`.

## Six capability kinds

### 1. Composition helper (`helper`)
- When the extension is enabled in a project (`extension.enable`), `syncCompositionBridgeFiles` copies the helper into each composition's `assets/cuthol-ext-<name>.js` and injects `<script src="assets/cuthol-ext-<name>.js"></script>` immediately after `<script src="assets/cuthol-runtime.js"></script>`.
- Only exact `<script src="assets/cuthol-ext-<name>.js"></script>` tags managed by Cuthol are added or removed; user `<script>` tags are never modified. Projects with no enabled extensions have zero extra tags or files touched.
- Expose your helper on `window.__cuthol.ext.<name>` (accessible as `C.ext.<name>`):
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

### 2. Asset pack (`assets`)
- When enabled in a project, files inside the extension's `assets` directory are synced into `<composition>/assets/ext/<name>/…`.
- Reference them directly inside your composition HTML/CSS:
  - Images: `<img src="assets/ext/kit/logo.png" />`
  - Fonts: `@font-face { font-family: "Brand"; src: url("assets/ext/kit/brand.ttf"); }`

### 3. Media processors (`processors`)
Transforms an input library handle (`aud_01`, `vid_01`, `img_01`, `vo_01`) or file path into a new library asset:
- **`kind: "ffmpeg"`**: Declarative filter chain (`audio_filter` / `filter` / `video_filter` / `ffmpeg_args`) with `{{param}}` interpolation. `atempo` values above `2.0` or below `0.5` are automatically chained into valid stages.
- **`kind: "node"`**: Runs `script` in an isolated child process (`node <script> <inputPath> <outputPath> <paramsJson>`). Must exit with `0`, write the output file to `<outputPath>`, and print a single-line JSON summary to `stdout`. The child receives `CUTHOL_EXT_TMP`, a `tmp/` directory inside the sandbox, for side files (for example an ffmpeg `sendcmd` file). Files there are allowed; the directory is deleted when the run ends, whether it succeeds or fails.
- **`asset_kind`** (optional): `footage`, `audio`, `graphic`, `voiceover`, or `composition`. Any other value is `[CUTHOL-G112]` and is not remapped. Omitted processors keep the probed kind.
- **`audio`** (optional, `kind: "ffmpeg"` only): `"copy"` (default, same as omitting the field) or `"drop"`. `drop` passes `-an` and removes the audio stream. A value other than those two, or `audio` on a node processor, is `[CUTHOL-G112]`.
- **`timeout_sec`** (optional, processors and planners): integer ≥ 0. Omitted node processors and planners are killed after 120 seconds. `0` means no limit. An invalid value is `[CUTHOL-G112]`. On timeout the error names the limit that was exceeded and `timeout_sec`. An omitted ffmpeg processor is not given a wall-clock limit; a set `timeout_sec` applies to that ffmpeg run too.
- **A/V duration:** After every processor run (including a cache hit) Cuthol probes the output streams. If both video and audio exist and their durations differ by more than one frame (40 ms when the output has no frame rate), the result includes `WARN [CUTHOL-G209]` with both durations. Fix it with `"audio": "drop"` or an `audio_filter` that keeps the streams aligned. A `video_filter` that does not change duration (for example `hue=s=0`) stays silent and still copies audio.
- **Caching & Journal:** Outputs are cached in `.cuthol/ledger.sqlite` (and the shared cache if enabled) keyed by `sha256(input_sha256 | ext_name | ext_version | ext_content_hash | processor | canonical_params)`. `audio` and `timeout_sec` are appended to that key only when the manifest sets them, so existing processors keep their cache key. A library hit is reused only when the stored item's kind matches the processor's resolved kind. The resulting file is probed and added to `seq.library` inside `JournalGuard` so `workspace(action="undo")` cleanly reverts the library addition.

### 4. Recipes (`recipes`)
- Parameterized sequences of Cuthol actions (`steps`). Step arguments can interpolate `{{param}}`, `{{last_handle}}`, or `{{steps.<step_id>.handle}}`.
- **Single atomic undo unit:** All sequence changes performed by a recipe are committed as a single revision (`rN -> r(N+1)`) so `workspace(action="undo")` reverts the entire recipe at once, while `steps_executed` reports each individual step in the result payload. If any step fails, all prior steps in the recipe are rolled back automatically.

### 5. Planners (`planners`) — variable-length Cue Sheet patches from composition events & words
When an edit needs a **data-dependent, variable number of cues** (for example, placing sound effects on every visual event across several HyperFrames compositions and on specific spoken keywords), a static `recipe` step list is not enough. A **planner** runs a sandboxed child-process Node script (`node <script> <snapshotJsonPath> <outputPatchJsonPath> <paramsJson>`):
- **Read-only input snapshot (`cuthol.planner.snapshot/1`):**
  - `sequence`: full `cuthol.sequence.json` state.
  - `words`: all unexcised transcript words projected onto sequence coordinates (`word`, `norm`, `source_start_ms`, `source_end_ms`, `sequence_start_ms`, `sequence_end_ms`, `sequence_start_sec`, `sequence_end_sec`, `owner_id`, `asset_handle`).
  - `compositions`: each mounted composition (`cue_id`, `lane_id`, `composition_dir`, `at_ms`, `duration_ms`, `end_ms`, `props`, window `words`, `cuts`, and `events`).
  - `events`: flattened chronological list of all composition-declared events (`id`, `name`, `kind`, `cue_id`, `lane_id`, `composition_dir`, `local_ms`, `local_sec`, `sequence_ms`, `sequence_sec`, `meta`, `source`).
- **How a composition declares events (no browser render required):**
  Cuthol extracts events directly from the composition folder before running the planner:
  1. `events.json` (or `cuthol-events.json` / `assets/events.json` / `assets/cuthol-events.json`) inside the composition folder:
     `[{ "name": "paper_drop", "at_ms": 800, "meta": { "gain_db": -4 } }]` (also accepts `at_sec`, `t`, `offset_ms`, or `at: "800ms"`).
  2. `<script id="cuthol-events" type="application/json">[...]</script>` inside `index.html`.
  3. HTML attributes on elements in `index.html`: `<div data-cuthol-event="paper_drop" data-cuthol-at="800ms" data-cuthol-meta='{"gain_db":-5}'></div>` (or `data-start="0.8"`).
  4. Static JS calls in `index.html`: `C.event("paper_drop", 0.8, { gain_db: -4 })`.
  Every local timestamp (`local_ms`) is automatically converted to timeline coordinates (`sequence_ms = cueStartMs + local_ms`).
- **`timeout_sec`** and **`CUTHOL_EXT_TMP`**: same as processors. Omitted planners use a 120 second limit; `0` removes it. `CUTHOL_EXT_TMP` is a `tmp/` directory in the sandbox and is deleted when the run ends.
- **Output (Cue Sheet patch), dry-run plan & atomic apply:**
  The planner script writes `{ "cues": [...], "notes": [...] }` (a `CutholCueSheet` patch; `id` is optional on new cues and auto-allocated as `cue_XX`) to `<outputPatchJsonPath>`. Cuthol validates the patch with `planCueSheet` (`mergeCueSheetIntoSequence` + `verifySequence`):
  - If `dry_run=true`, Cuthol returns the planned diff (`would_commit`, `cues_added`, `cues_updated`, `cues_removed`, `snapshot_summary`) without modifying the sequence.
  - If any gate fails (e.g. `G103` unknown `asset_handle`, `G301` sub-frame duration) or the patch schema is invalid, **nothing is applied** and the sequence remains untouched.
  - Otherwise, Cuthol commits the entire patch in a **single atomic revision** (`rN -> r(N+1)`), so a single `workspace(action="undo")` reverts all generated cues at once.

#### Example planner extension: SFX on "paper drop" events (`paper_sfx`)

1. Declare the event in your composition (either `<comp_dir>/events.json` or `index.html`):
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

### 6. Guide (`guide`)
- Call `guide(topic="extensions")` for this manual, or `guide(topic="ext:<name>")` to read an extension's `README.md`.

## Spine transition kinds (`transitions`)

An extension can register spine transition kinds used as `transition_out.kind = "ext:<name>/<transition>"`
(`spine.transition(clip="sp_01", kind="ext:myext/push", duration="400ms", params={"dir": "left"})`;
CLI `cuthol spine transition --clip sp_01 --kind ext:myext/push --duration 400ms --param dir=left`).
There is no JS: a transition is ffmpeg filter/expression templates with `{{placeholder}}` substitution.

Fields per transition (all optional except the name): `description`, `params` (same schema as processor
params), `hold_outgoing` (default `true`; `false` = fade-like, the outgoing clip is not held under the
incoming one), `outgoing_filter` / `incoming_filter` (ffmpeg filter templates on the clip chains, local
clip time `t`), `incoming_scale` (centered scale-factor expression for the incoming clip, e.g.
`"0.8+0.2*{{p}}"`, guarded to the transition window by the compiler), `incoming_x` / `incoming_y` and
`outgoing_x` / `outgoing_y` (overlay position expressions, sequence time `t`; omitted = base position).

Placeholders: chain fields accept `t0` (window start, local s), `dur` (duration s), `p` (eased progress in
`[0,1]`, already carries the transition's `easing`); overlay fields additionally accept `t1` (window end,
s), `W`/`H` (stage px), `x`/`y` (base overlay expressions); every field accepts the transition's own
`{{param}}` values (validated numbers/strings/booleans; booleans render as `1`/`0`). Unknown placeholders
are `[CUTHOL-G112]`. `easing` is `linear`/`ease_in`/`ease_out`/`ease_in_out`/`cubic_bezier` (bezier
control points live on the transition; bad curves are `[CUTHOL-G120]`). Guard position templates
builtin-style:
`if(lt(t,{{t1}}),<motion>,{{x}})`.

```json
"transitions": {
  "push": {
    "description": "Incoming slides in from the right, outgoing slides out left.",
    "incoming_x": "if(lt(t,{{t1}}),{{W}}-{{W}}*{{p}},{{x}})",
    "outgoing_x": "if(lt(t,{{t1}}),{{x}}-{{W}}*{{p}},{{x}}-{{W}})"
  }
}
```

Rules: the G303 duration bound (≤ half of the shorter neighbour) applies to `ext:` transitions too.
Unknown/disabled `ext:` kinds fail edits and render with `[CUTHOL-G122]` (never a silent dissolve); bad
params with `[CUTHOL-G123]` (builtins take no params); a changed extension warns `[CUTHOL-G413]` on
`verify` (re-pin with `extension.enable`). Transitions are video-only: spine audio hard-cuts at the clip
boundary exactly as with builtins. An extension whose transitions are in use cannot be disabled until those
transitions are replaced (G122). `extension.show` returns the `transitions` manifest section.

## Reproducibility & verification (`CUTHOL-G205`)

- `extension.enable` records `{ name, version, content_hash, scope, enabled_at }` in `cuthol.sequence.json` (`extensions`) and syncs the extension's helper/assets into mounted compositions.
- If an enabled extension's source files/version on disk or a composition's local copy (`assets/cuthol-ext-<name>.js`, `assets/ext/<name>/…`) differs from the pinned `content_hash`, Cuthol does not silently overwrite existing composition copies: `verify` emits `WARN [CUTHOL-G205]` (`EXTENSION_HASH_MISMATCH`) and **`render` stops with `ERROR [CUTHOL-G205]`** so renders never proceed with stale or mismatched extension code.
- Run `extension(action="enable", name="<name>")` (`cuthol extension enable --name <name>`) to approve the new `content_hash` and re-sync all compositions.

## Security rules

- Node processors never run via `eval` or in-process `import()`; they execute in a separate `node` child process with an isolated temporary working directory.
- Every `extension.run` processor result reports `security_notice: { manifest_path, script_path, network_declared }`.
- Extensions are forbidden from writing into their own extension folder, into the workspace folder, or outside the designated output path (`[CUTHOL-G206]`). Node processor and planner scripts may also write inside `CUTHOL_EXT_TMP` (`tmp/` in the sandbox). That directory is removed when the run finishes. Writes beside the output (and, for planners, beside `snapshot.json` / `patch.json`) are still `[CUTHOL-G206]`.
- Node processor and planner scripts whose manifest has `network: false` (default) are forbidden from using network APIs (`fetch`, `node:http`, `node:https`, `node:net`, `WebSocket`) (`[CUTHOL-G206]`).

## Commands (`extension` MCP tool / `cuthol extension`)

| MCP call | CLI | Purpose |
|---|---|---|
| `extension(action="list", scope?)` | `cuthol extension list [--scope project\|persistent]` | List persistent, project-local and enabled extensions |
| `extension(action="create", name, scope?, template?, description?)` | `cuthol extension create --name <name> [--template full\|helper\|processor_ffmpeg\|processor_node\|assets\|recipe\|planner]` | Scaffold a new extension |
| `extension(action="show", name, scope?)` | `cuthol extension show --name <name>` | Inspect manifest, hash and file list |
| `extension(action="enable", name, scope?, dry_run?)` | `cuthol extension enable --name <name>` | Enable in project (or refresh pinned hash) & sync bridges |
| `extension(action="disable", name, dry_run?)` | `cuthol extension disable --name <name>` | Disable in project & remove helper script tags |
| `extension(action="promote", name, overwrite?)` | `cuthol extension promote --name <name>` | Copy project extension to persistent storage |
| `extension(action="remove", name, scope?)` | `cuthol extension remove --name <name> [--scope ...]` | Delete extension folder |
| `extension(action="run", name, processor?\|planner?\|recipe?, input?, params?, dry_run?)` | `cuthol extension run --name <name> [--planner <p> \| --processor <p> --input <h> \| --recipe <r>] [--params '{...}'] [--dry-run]` | Run a processor, planner or recipe |

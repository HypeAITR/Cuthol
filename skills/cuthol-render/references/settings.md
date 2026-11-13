# Settings layer (user and project)

Render behaviour is driven by environment variables first; when a variable is
unset, the stored settings layer applies. Precedence per key:
`environment > project file > user file > default`.

- User file: `~/.cuthol/settings.json` (`CUTHOL_SETTINGS_FILE` redirects it,
  `CUTHOL_SETTINGS_FILE=0` disables it, e.g. in tests).
- Project file: `<project>/.cuthol/settings.json` (only `render.output_dir`
  lives here; the rest is user scope).
- Every record is `{ "value": …, "set_by": "agent" | "human", "at": ISO }`;
  writes are atomic (tmp + rename).

| Key                        | Values                              | Env (always wins)          | Agent |
|----------------------------|-------------------------------------|----------------------------|-------|
| `render.encoder`           | `auto\|nvenc\|amf\|qsv\|vaapi\|videotoolbox\|x264` | `CUTHOL_ENCODER` | yes |
| `render.gpu`               | `true\|false` (`false` = `CUTHOL_DISABLE_GPU=1`) | `CUTHOL_DISABLE_GPU` | yes |
| `render.workers`           | `1`–`32` or `auto`                  | `CUTHOL_WORKERS`           | yes |
| `render.overlay_concurrency` | `1`–`16` or `auto`                | `CUTHOL_OVERLAY_CONCURRENCY` | yes |
| `render.output_dir`        | relative or absolute path (`output`) | — (project scope)         | yes |
| `render.stall_timeout_sec` | seconds (`0` disables)              | `CUTHOL_STALL_TIMEOUT_SEC` | yes |
| `cache.dir`                | absolute path                       | `CUTHOL_CACHE_DIR`         | yes |
| `live.mode`                | `ask\|on\|off`                      | `CUTHOL_LIVE`              | n/a (Live setting) |
| `live.shortcuts`           | action → key map                    | — (window only)            | no |

CLI: `cuthol settings [list|get <key>|set <key> <value>|reset <key>]
[--dir <dir>]` (typed validation; `CUTHOL-G620` unknown key, `CUTHOL-G621`
bad value, `CUTHOL-G622` agent writes a window-only key, `CUTHOL-G623`
unwritable file, `CUTHOL-G624` key locked by an environment variable).
MCP: `workspace` actions `settings_list|settings_get|settings_set|
settings_reset` (same CLI underneath; no new tool).

`set_by: "agent"` marks values the agent wrote; the Live window shows a "?"
badge ("Set by the agent") on those rows (except Live settings). A human
change in the window is queued to the inbox, so the agent's next response
ends with `human changed setting <key>: <old> → <new>`.

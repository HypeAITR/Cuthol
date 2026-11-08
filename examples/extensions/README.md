# Example extensions

Copy-pasteable extensions that teach one gate each. Copy a folder to
`<project>/.cuthol/extensions/<name>/` (or the persistent extensions
directory) and run `cuthol extension enable --name <name> --dir
<project>`. Details live in each folder's `README.md`.

| Name | Type | Teaches |
|---|---|---|
| `motion-transitions` | transitions | Spine transition kinds as ffmpeg templates (`ext:<ext>/<name>`): push (both overlay positions), wipe reveal with a param, white flash dissolve (chain filters + alpha). |
| `film-look` | clip effects (`fx`) | Per-clip `spine fx` templates: grain, vignette, channel split, plus one envelope-driven (`animatable`) param. |
| `freeze-fade` | processors (`ffmpeg`) | Media processors that mint new assets: a duration-changing freeze (`audio: drop`) vs a duration-keeping fade (audio copied). |
| `speed-ramps` | recipes | Parameterized multi-step workflows over the core speed ramp: `{{param}}` interpolation, dry-run, one atomic undo unit. |
| `montage` | planners | Sandboxed scripts returning Cue Sheet patches: spine assembly from the library snapshot, SFX cues from composition events. |
| `caption-kit` | composition helper + asset pack | Time-pure helpers on `C.ext["caption-kit"]` plus synced CSS/SVG assets; `demo/index.html` is a ready composition using both. |
| `asr-command` | provider (`asr`) | Bridge from any local speech-recognition command to the ASR provider contract. |
| `tts-command` | provider (`tts`) | Bridge from any local speech-synthesis command to the TTS provider contract. |
| `media-folder` | provider (`media`) | A local folder served as a searchable music/SFX shelf. |

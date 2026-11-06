# tts-command (example provider extension)

Generic bridge that connects **any local speech-synthesis command** to the Cuthol
TTS provider contract. Copy this folder to your project (`.cuthol/extensions/`) or
user extensions directory, set `config.command` to your own CLI, and use it with:

```sh
cuthol speech synthesize --text "Hello world" --provider ext:tts-command --voice default
```

## Configuration (`providers.tts.config`)

| Key | Default | Meaning |
|---|---|---|
| `command` (required) | — | Command template. Placeholders: `{text_file}` (UTF-8 text file), `{text}`, `{voice}`, `{model}`, `{output}` (audio file to write), `{language}`, `{speed}`. |
| `text_via` | `"file"` | `"file"` (use `{text_file}`) or `"stdin"` (pipe the text to stdin). |
| `alignment` | `"none"` | `"none"` or `"words_file"`. |
| `alignment_file` | `"{output}.words.json"` | Word-timing JSON the command may write alongside the audio (only with `"words_file"`): `{ "words": [{ "word", "start_ms", "end_ms" }] }`. Field mapping: `words_path`, `word_field`, `start_field`, `end_field`, `time_unit` (`"ms"`/`"s"`). |

With `"none"` (the default) the voiceover has **no word timings**: Cuthol says so
explicitly (`has_alignment: false` plus a warning) and never invents timings.
Captions and cleanup need timings — either use a TTS command that writes the
alignment file, or run `cuthol speech transcribe` on the voiceover afterwards.

The script needs no network access (`network: false`); it only spawns your local
command. Cuthol still runs it sandboxed (own temp dir, restricted environment).

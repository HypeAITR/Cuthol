# asr-command (example provider extension)

Generic bridge that connects **any local speech-recognition command** to the Cuthol
ASR provider contract. Copy this folder to your project (`.cuthol/extensions/`) or
user extensions directory, set `config.command` to your own CLI, and use it with:

```sh
cuthol speech transcribe --handle aud_01 --provider ext:asr-command
```

## Configuration (`providers.asr.config`)

| Key | Default | Meaning |
|---|---|---|
| `command` (required) | — | Command template. Placeholders: `{audio}` (input file), `{language}`, `{keyterms}`. Must print one JSON document to stdout. |
| `words_path` | `"words"` | Dot path to the word array in that JSON (e.g. `"results.words"`). |
| `word_field` | `"word"` | Word text field. |
| `start_field` / `end_field` | `"start_ms"` / `"end_ms"` | Start/end fields. |
| `time_unit` | `"ms"` | `"ms"` or `"s"`. |
| `confidence_field` | `"confidence"` | Optional confidence field. |
| `punctuated_field` | `"punctuated_word"` | Optional display-text field. |
| `text_field` / `language_field` / `model_field` | `"text"` / `"language"` / unset | Optional top-level fields. |

The JSON your command prints can be as simple as:

```json
{ "words": [{ "word": "hello", "start_ms": 120, "end_ms": 480, "confidence": 0.98 }] }
```

The script needs no network access (`network: false`); it only spawns your local
command. Cuthol still runs it sandboxed (own temp dir, restricted environment).

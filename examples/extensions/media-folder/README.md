# media-folder (example provider extension)

Reference **media provider**: serves music/sfx files from a local folder as a
searchable shelf. Copy this folder to your project (`.cuthol/extensions/`) or user
extensions directory, drop audio files into `tracks/`, and use it with:

```sh
cuthol library search --provider ext:media-folder --kind music --query "calm"
cuthol library fetch --provider ext:media-folder --id "calm_piano.wav"
```

Fetched files go through the normal ingest path (`aud_XX` handle, probe, ledger)
and keep their origin in the asset `source` field (provider, id, title, license),
visible in `cuthol brief --lens detail --id <handle>`.

## Layout

```text
media-folder/
  cuthol-extension.json
  media.js
  tracks/
    calm_piano.wav
    calm_piano.wav.json   # optional sidecar (title, kind, tags, mood, license, ...)
    riser_sfx.mp3
    riser_sfx.mp3.json
```

Sidecar (`<file>.json`, all fields optional):

```json
{
  "title": "Calm Piano Bed",
  "kind": "music",
  "tags": ["calm", "piano", "bed"],
  "mood": "calm",
  "license": "CC-BY 4.0, attribution: Example Artist",
  "source_url": "https://example.com/tracks/calm-piano",
  "duration_ms": 32000
}
```

`kind` defaults to `config.default_kind` (`"music"`). `duration_ms` defaults to the
WAV header for `.wav` files, otherwise unknown (unknown durations pass min/max
filters). Search matches the query (case-insensitive substring) against the title,
file name, tags, and mood.

## Configuration (`providers.media.config`)

| Key | Default | Meaning |
|---|---|---|
| `directory` (required) | `"tracks"` | Folder with the audio files (relative to the extension folder, or absolute). |
| `default_kind` | `"music"` | Kind for files without a sidecar `kind`. |

The script uses no network access (`network: false`). A real service-backed
provider keeps the same script shape (`search`/`fetch` operations) and only swaps
the folder scan for API calls — see the providers section in the extensions guide
for a skeleton.

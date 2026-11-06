# Extension providers: ASR, TTS, media

An extension can serve up to three provider kinds — `asr` (speech recognition),
`tts` (speech synthesis), and `media` (a searchable music/sfx shelf) — so
projects are not tied to the built-in providers. Each provider is a sandboxed
child-process `node` script speaking a fixed JSON contract.

```json
"providers": {
  "asr": {
    "description": "Local ASR via a configurable command line.",
    "script": "asr.js",
    "config": { "command": "my-asr --json {audio} --language {language}" },
    "env": ["MY_ASR_API_KEY"]
  },
  "tts": { "script": "tts.js", "config": {}, "env": ["MY_TTS_API_KEY"] },
  "media": { "script": "media.js", "config": { "directory": "tracks" } }
}
```

- `script` (required): relative `.js` file inside the extension (same rule as
  processor/planner scripts). Unknown kinds, unknown fields, a missing script,
  a non-object `config`, or a malformed `env` list are `[CUTHOL-G112]`.
- `config` (optional): static JSON object passed verbatim to every invocation
  (command lines, field mappings, folders, limits). Not a secret store.
- `env` (optional): environment variable **names** the provider needs
  (`["SOME_API_KEY"]`). Values are read from the process environment or the
  project `.env` at call time, passed to the child only, and never written to
  the sequence, journal, cache key, output, or logs. A missing variable fails
  with `[CUTHOL-G232]` naming the variable and where to set it. Undeclared
  variables — including other providers' keys — never reach the script.
- Providers run on demand and do **not** need `extension.enable` (like
  processors). `network: false` (default) still forbids network APIs in the
  script (`[CUTHOL-G206]`); API-backed providers declare `network: true`.

Invocation: `node <script> <requestJsonPath> <responseJsonPath>` in an isolated
temp working directory. No wall-clock limit, but the progress watchdog kills
trees that stall (`CUTHOL_STALL_TIMEOUT_SEC`, default 300 s). The script may
write only the response file, the audio output file (TTS/fetch, path given in
the request), and the `tmp/` scratch dir (`CUTHOL_PROVIDER_TMP`); anything else
is `[CUTHOL-G206]`, as is touching the extension folder. A crash, a missing
output file, or an unreadable response is `[CUTHOL-G234]`; a response violating
the contract below is `[CUTHOL-G233]`. The extension `version` and content hash
join every cache key, so upgrading a provider never reads another version's
cache.

**ASR** (`cuthol speech transcribe --provider ext:<name>`). Request:
`{ contract: "cuthol.provider.asr/1", audio_path, language, keyterms, config }`.
Response: `{ words: [{ word, start_ms, end_ms, confidence?, punctuated_word? }],
text?, language?, model? }`. Cuthol annotates fillers/repetitions, clamps to
the asset duration, and caches per provider identity + version + hash +
language.

**TTS** (`cuthol speech synthesize --provider ext:<name>`; `--voice`/`--model`/`--speed`
pass through, default `"default"`). Request: `{ contract:
"cuthol.provider.tts/1", text, voice_id, model_id, speed, language,
output_audio_path, config }`. The script writes audio to `output_audio_path`
and responds with `{ alignment: "word" | "character" | "none", words?,
characters? }` (`characters` is the `{ characters,
character_start_times_seconds, character_end_times_seconds }` shape). `"none"`
is explicit and honest: the voiceover keeps `has_alignment: false` plus a
warning (`[CUTHOL-G235]`), and Cuthol never invents timings. Declaring `"none"`
while returning timings is `[CUTHOL-G233]`.

**Media** (`cuthol library search` / `cuthol library fetch --provider ext:<name>`). Search
request: `{ contract: "cuthol.provider.media/1", operation: "search", kind:
"music"|"sfx", query, min_duration_ms, max_duration_ms, limit, config }`;
response: `{ candidates: [{ id, title?, duration_ms?, preview_url?, license?,
source_url?, tags? }] }`. Fetch request: `{ ..., operation: "fetch", id,
output_audio_path, config }`; the script writes the file and responds with
`{ found: true, title?, license?, source_url?, duration_ms?, filename? }`
(`{ found: false }` becomes `[CUTHOL-G236]`). Fetch ingests through the normal
path (`aud_XX`, probe, ledger) and records `source` (provider, id, title,
license) on the asset, shown by `library query` (`asset_source`) and
`cuthol brief --lens detail --id <handle>`.

Worked examples live in `examples/extensions/`:

- `asr-command`: any local ASR CLI + JSON field mapping.
- `tts-command`: any local TTS CLI, with optional `<output>.words.json`
  alignment.
- `media-folder`: a local folder of tracks (+ sidecar `<file>.json`
  tags/license) as a searchable shelf. Copy it into `.cuthol/extensions/` to
  try search/fetch.

Template for an API-backed provider (placeholder names/URLs only):

```json
"providers": {
  "tts": {
    "script": "tts.js",
    "config": { "endpoint": "https://api.example.com/v1/speak" },
    "env": ["ACME_TTS_API_KEY"]
  }
}
```

```js
// tts.js (skeleton; manifest needs "network": true for the fetch call)
const fs = require("node:fs");
const [requestPath, responsePath] = process.argv.slice(2);
const req = JSON.parse(fs.readFileSync(requestPath, "utf8"));
main().catch((err) => { process.stderr.write(String(err)); process.exit(1); });
async function main() {
  const res = await fetch(req.config.endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.ACME_TTS_API_KEY}` },
    body: JSON.stringify({ text: req.text, voice: req.voice_id }),
  });
  if (!res.ok) throw new Error(`provider HTTP ${res.status}`);
  const payload = await res.json(); // { audio_base64, words? }
  fs.writeFileSync(req.output_audio_path, Buffer.from(payload.audio_base64, "base64"));
  fs.writeFileSync(responsePath, payload.words
    ? JSON.stringify({ alignment: "word", words: payload.words })
    : JSON.stringify({ alignment: "none" }));
}
```

Provider scripts are plain CommonJS `.js` files (like processor/planner
scripts).

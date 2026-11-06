#!/usr/bin/env node
// Generic local-TTS bridge for the Cuthol provider contract.
// Runs `config.command` (a local speech-synthesis CLI) which must write the audio
// file to {output}. Word alignment is optional (see `config.alignment`).
//
// Usage: node tts.js <requestJsonPath> <responseJsonPath>
// Placeholders in `config.command`: {text_file} {text} {voice} {model} {output}
// {language} {speed}. When `text_via` is "stdin", the text goes to stdin instead.
"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function fail(msg) {
  process.stderr.write(`tts-command: ${msg}\n`);
  process.exit(1);
}

function quoteArg(value) {
  if (process.platform === "win32") {
    return `"${String(value).replace(/"/g, '""')}"`;
  }
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function pickPath(obj, dotted) {
  let cur = obj;
  for (const part of String(dotted).split(".")) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[part];
  }
  return cur;
}

function readWordAlignment(alignPath, config) {
  const parsed = JSON.parse(fs.readFileSync(alignPath, "utf8"));
  const rawWords = pickPath(parsed, config.words_path || "words");
  if (!Array.isArray(rawWords)) {
    fail(`alignment file has no array at '${config.words_path || "words"}'.`);
  }
  const wordField = config.word_field || "word";
  const startField = config.start_field || "start_ms";
  const endField = config.end_field || "end_ms";
  const toMs = config.time_unit === "s" ? 1000 : 1;
  return rawWords.map((w, i) => {
    const text = w ? w[wordField] : undefined;
    const start = w ? Number(w[startField]) * toMs : NaN;
    const end = w ? Number(w[endField]) * toMs : NaN;
    if (typeof text !== "string" || !text.trim() || !Number.isFinite(start) || !Number.isFinite(end)) {
      fail(`alignment word #${i} is missing '${wordField}'/'${startField}'/'${endField}'.`);
    }
    return { word: text.trim(), start_ms: Math.round(start), end_ms: Math.round(end) };
  });
}

function main() {
  const [requestPath, responsePath] = process.argv.slice(2);
  if (!requestPath || !responsePath) fail("expected <requestJsonPath> <responseJsonPath>.");
  const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
  const config = request.config || {};
  if (typeof config.command !== "string" || !config.command.trim()) {
    fail("manifest providers.tts.config.command is not configured (e.g. \"my-tts --out {output}\").");
  }
  if (!request.output_audio_path) fail("request has no output_audio_path.");

  const tmpDir = process.env.CUTHOL_PROVIDER_TMP || fs.mkdtempSync(path.join(os.tmpdir(), "tts-text-"));
  fs.mkdirSync(tmpDir, { recursive: true });
  const textFile = path.join(tmpDir, "text.txt");
  fs.writeFileSync(textFile, request.text || "", "utf8");

  const command = config.command
    .split("{text_file}")
    .join(quoteArg(textFile))
    .split("{text}")
    .join(quoteArg(request.text || ""))
    .split("{voice}")
    .join(quoteArg(request.voice_id || "default"))
    .split("{model}")
    .join(quoteArg(request.model_id || "default"))
    .split("{output}")
    .join(quoteArg(request.output_audio_path))
    .split("{language}")
    .join(quoteArg(request.language || "tr"))
    .split("{speed}")
    .join(quoteArg(String(request.speed ?? 1)));

  const proc = spawnSync(command, {
    shell: true,
    input: config.text_via === "stdin" ? request.text || "" : undefined,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (proc.status !== 0) {
    fail(`TTS command failed (exit ${proc.status}): ${(proc.stderr || proc.stdout || "").trim().slice(-500)}`);
  }
  if (!fs.existsSync(request.output_audio_path)) {
    fail("TTS command did not write the output audio file.");
  }

  // Optional word alignment: by convention the command may also write
  // `<output>.words.json` ({ words: [...] }); otherwise alignment is "none"
  // and Cuthol reports that honestly instead of inventing timings.
  let response = { alignment: "none" };
  const mode = config.alignment || "none";
  if (mode === "words_file") {
    const alignTemplate = config.alignment_file || "{output}.words.json";
    const alignPath = alignTemplate.split("{output}").join(request.output_audio_path);
    if (fs.existsSync(alignPath)) {
      response = { alignment: "word", words: readWordAlignment(alignPath, config) };
    }
  } else if (mode !== "none") {
    fail(`unknown config.alignment '${mode}' (expected "none" or "words_file").`);
  }
  fs.writeFileSync(responsePath, JSON.stringify(response), "utf8");
}

main();

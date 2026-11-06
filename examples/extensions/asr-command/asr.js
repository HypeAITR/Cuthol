#!/usr/bin/env node
// Generic local-ASR bridge for the Cuthol provider contract.
// Runs `config.command` (a local speech-recognition CLI) and maps its JSON
// output to `{ words: [{ word, start_ms, end_ms, ... }] }`.
//
// Usage: node asr.js <requestJsonPath> <responseJsonPath>
// Placeholders in `config.command`: {audio} {language} {keyterms}
// (words are picked from the command's stdout JSON via the `*_field` mapping).
"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");

function fail(msg) {
  process.stderr.write(`asr-command: ${msg}\n`);
  process.exit(1);
}

function quoteArg(value) {
  // Quote one argv token for the platform shell (used for {audio} etc.).
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

function main() {
  const [requestPath, responsePath] = process.argv.slice(2);
  if (!requestPath || !responsePath) fail("expected <requestJsonPath> <responseJsonPath>.");
  const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
  const config = request.config || {};
  if (typeof config.command !== "string" || !config.command.trim()) {
    fail("manifest providers.asr.config.command is not configured (e.g. \"my-asr --json {audio}\").");
  }

  const keyterms = Array.isArray(request.keyterms) ? request.keyterms.join(",") : "";
  const command = config.command
    .split("{audio}")
    .join(quoteArg(request.audio_path))
    .split("{language}")
    .join(quoteArg(request.language || "auto"))
    .split("{keyterms}")
    .join(quoteArg(keyterms));

  const proc = spawnSync(command, {
    shell: true,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (proc.status !== 0) {
    fail(`ASR command failed (exit ${proc.status}): ${(proc.stderr || proc.stdout || "").trim().slice(-500)}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(proc.stdout);
  } catch (err) {
    fail(`ASR command did not print valid JSON: ${err.message}`);
  }

  const wordsPath = config.words_path || "words";
  const rawWords = pickPath(parsed, wordsPath);
  if (!Array.isArray(rawWords)) {
    fail(`ASR JSON has no array at '${wordsPath}'. Adjust config.words_path.`);
  }

  const wordField = config.word_field || "word";
  const startField = config.start_field || "start_ms";
  const endField = config.end_field || "end_ms";
  const confField = config.confidence_field || "confidence";
  const punctField = config.punctuated_field || "punctuated_word";
  const toMs = config.time_unit === "s" ? 1000 : 1;

  const words = rawWords.map((w, i) => {
    const text = w ? w[wordField] : undefined;
    const start = w ? Number(w[startField]) * toMs : NaN;
    const end = w ? Number(w[endField]) * toMs : NaN;
    if (typeof text !== "string" || !text.trim() || !Number.isFinite(start) || !Number.isFinite(end)) {
      fail(`word #${i} is missing '${wordField}'/'${startField}'/'${endField}' (time_unit=${config.time_unit || "ms"}).`);
    }
    const out = { word: text.trim(), start_ms: Math.round(start), end_ms: Math.round(end) };
    if (w[confField] !== undefined) out.confidence = Number(w[confField]);
    if (typeof w[punctField] === "string" && w[punctField].trim()) {
      out.punctuated_word = w[punctField].trim();
    }
    return out;
  });

  const response = { words };
  if (config.text_field && typeof pickPath(parsed, config.text_field) === "string") {
    response.text = pickPath(parsed, config.text_field);
  }
  if (config.language_field && typeof pickPath(parsed, config.language_field) === "string") {
    response.language = pickPath(parsed, config.language_field);
  }
  if (config.model_field && typeof pickPath(parsed, config.model_field) === "string") {
    response.model = pickPath(parsed, config.model_field);
  }
  fs.writeFileSync(responsePath, JSON.stringify(response), "utf8");
}

main();

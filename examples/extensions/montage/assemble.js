#!/usr/bin/env node
// montage/assemble: build spine clips from a handle list.
// Args: <snapshotJsonPath> <outputPatchJsonPath> <paramsJson>
// Reads the read-only planner snapshot, writes a Cue Sheet patch
// ({spine, notes}). New clips get fresh sp_NN ids after the current max.
"use strict";
const fs = require("node:fs");

const [snapshotPath, outputPath, rawParams] = process.argv.slice(2);
const snap = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
const params = rawParams ? JSON.parse(rawParams) : {};

const handles = String(params.handles || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const clipMs = Number(params.clip_ms) || 1500;

const finish = (spine, notes) => {
  fs.writeFileSync(outputPath, JSON.stringify({ spine, notes }, null, 2), "utf8");
};

if (handles.length === 0) {
  finish([], ["assemble: no handles given, nothing planned."]);
  return;
}

const library = new Map((snap.sequence.library || []).map((item) => [item.handle, item]));
let maxId = 0;
for (const clip of snap.sequence.spine?.clips || []) {
  const m = /^sp_(\d+)$/.exec(clip.id || "");
  if (m) maxId = Math.max(maxId, parseInt(m[1], 10));
}

const spine = [];
const notes = [];
for (const handle of handles) {
  const item = library.get(handle);
  if (!item) {
    notes.push(`assemble: skip unknown handle ${handle}.`);
    continue;
  }
  const assetMs = Number(item.probe?.duration_ms) || clipMs;
  const takeMs = Math.max(1, Math.min(clipMs, assetMs));
  maxId += 1;
  const id = `sp_${String(maxId).padStart(2, "0")}`;
  spine.push({ id, asset_handle: handle, source_in_ms: 0, source_out_ms: Math.round(takeMs) });
  notes.push(`assemble: + ${id} from ${handle} (0..${Math.round(takeMs)}ms).`);
}
finish(spine, notes);

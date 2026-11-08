#!/usr/bin/env node
// montage/event_sfx: place ln_sfx cues on composition events.
// Args: <snapshotJsonPath> <outputPatchJsonPath> <paramsJson>
// A composition declares events via events.json, a cuthol-events script
// tag, data-cuthol-event attributes, or C.event() calls; the snapshot
// already projects them to sequence_ms. Per-event meta (e.g. gain_db)
// wins over the matching param.
"use strict";
const fs = require("node:fs");

const [snapshotPath, outputPath, rawParams] = process.argv.slice(2);
const snap = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
const params = rawParams ? JSON.parse(rawParams) : (snap.params || {});

const eventName = String(params.event || "paper_drop");
const cues = [];
for (const ev of snap.events || []) {
  if (ev.name !== eventName) continue;
  const metaGain = ev.meta && typeof ev.meta.gain_db === "number" ? ev.meta.gain_db : undefined;
  cues.push({
    lane_id: "ln_sfx",
    kind: "sfx",
    asset_handle: String(params.drop_asset || "aud_02"),
    at_ms: ev.sequence_ms,
    duration_ms: Number(params.duration_ms) || 400,
    gain_db: metaGain !== undefined ? metaGain : Number(params.gain_db ?? -5),
  });
}
const notes =
  cues.length > 0
    ? [`event_sfx: ${cues.length} cue(s) on '${eventName}'.`]
    : [`event_sfx: no '${eventName}' events in the snapshot.`];
fs.writeFileSync(outputPath, JSON.stringify({ cues, notes }, null, 2), "utf8");

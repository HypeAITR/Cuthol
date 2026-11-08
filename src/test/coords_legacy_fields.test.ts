// Retired review fields: old projects carrying `review.coords_suppress` /
// `review.coords_rules` still open; the fields are ignored but preserved
// byte-identical through edits and undo (no migration write on open).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { findBundledGsapMinJs } from "../compositor/bridge_hash.js";
import { CutholSequence, LaneCue } from "../core/schema.js";
import {
  commitSequenceMutation,
  initWorkspace,
  loadSequence,
  stepJournal,
} from "../core/workspace.js";
import { runWorkspaceVerification } from "../verify/gates.js";

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-coords-legacy-"));

const OLD_REVIEW = {
  coords_suppress: [
    {
      rule: "text_overlap",
      composition_dir: "compositions/card",
      a: "t",
      b: "card",
      note: "by design",
    },
  ],
  coords_rules: "off",
};

const GSAP = findBundledGsapMinJs();
assert.ok(GSAP, "bundled gsap.min.js must exist");

function makeOldProject(): string {
  const projDir = fs.mkdtempSync(path.join(TEST_ROOT, "proj-"));
  initWorkspace({ dir: projDir, title: "legacy", aspect: "16:9", fps: 30 });
  const compDir = path.join(projDir, "compositions", "card");
  fs.mkdirSync(path.join(compDir, "assets"), { recursive: true });
  fs.writeFileSync(
    path.join(compDir, "index.html"),
    `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:transparent}#root{position:relative;overflow:hidden}</style></head>
<body>
<div id="root" data-composition-id="main" data-start="0" data-width="1920" data-height="1080" data-fps="30" data-duration="1"><div id="t" style="position:absolute;left:100px;top:100px;font-size:60px;color:#fff">Cover me</div></div>
<script src="assets/gsap.min.js"></script>
<script>
window.__timelines = window.__timelines || {};
window.__timelines["main"] = gsap.timeline({paused:true});
</script>
</body></html>
`,
    "utf8"
  );
  fs.copyFileSync(GSAP as string, path.join(compDir, "assets", "gsap.min.js"));
  const cue: LaneCue = {
    id: "cue_01",
    kind: "composition",
    anchor: null,
    at_ms: 0,
    duration_ms: 1000,
    placement: {
      x_pct: 0, y_pct: 0, scale_x: 1, scale_y: 1, rotation_deg: 0, opacity: 1,
      fit_mode: "cover", crop: null, mirror_x: false, mirror_y: false,
    },
    composition: {
      composition_dir: "compositions/card",
      entry_html: "index.html",
      props: {},
      transparent: true,
      mode: "overlay_alpha",
    },
    envelopes: [],
  };
  const seqPath = path.join(projDir, "cuthol.sequence.json");
  const seq = JSON.parse(fs.readFileSync(seqPath, "utf8")) as CutholSequence;
  const lane = seq.lanes.find((l) => l.id === "ln_motion");
  assert.ok(lane, "initWorkspace must create ln_motion");
  lane.cues.push(cue);
  (seq as unknown as Record<string, unknown>).review = JSON.parse(JSON.stringify(OLD_REVIEW));
  fs.writeFileSync(seqPath, JSON.stringify(seq, null, 2), "utf8");
  return projDir;
}

function retiredCodes(report: { diagnostics: Array<{ code: string }> }): string[] {
  return report.diagnostics.map((d) => d.code).filter((c) => /^CUTHOL-G42[0-7]$/.test(c));
}

test("1. old review fields open, verify ignores them, undo preserves them", () => {
  const ws = makeOldProject();

  // Opens without error and the fields survive the load untouched.
  const loaded = loadSequence(ws).sequence as unknown as Record<string, unknown>;
  assert.deepEqual(loaded.review, OLD_REVIEW);

  // Verify runs and reports no retired warning-system code.
  const report = runWorkspaceVerification(ws);
  assert.equal(report.error_count, 0, JSON.stringify(report.diagnostics.slice(0, 3)));
  assert.deepEqual(retiredCodes(report), [], JSON.stringify(report.diagnostics));

  // An unrelated edit + undo keeps the fields byte-identical (journal-safe:
  // no migration rewrites the file outside the journal). The adopt commit first
  // journals the old on-disk state; undo then returns to exactly those bytes.
  commitSequenceMutation(ws, "legacy.adopt", (seq) => {
    seq.meta.title = "adopted";
  });
  const before = fs.readFileSync(path.join(ws, "cuthol.sequence.json"), "utf8");
  commitSequenceMutation(ws, "legacy.touch", (seq) => {
    seq.meta.title = "touched";
  });
  const edited = loadSequence(ws).sequence as unknown as Record<string, unknown>;
  assert.deepEqual(edited.review, OLD_REVIEW);
  stepJournal(ws, "undo", 1);
  const afterUndo = fs.readFileSync(path.join(ws, "cuthol.sequence.json"), "utf8");
  assert.equal(afterUndo, before);
});

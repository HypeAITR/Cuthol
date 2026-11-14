// Transparent master keeps the alpha plane end to end (spine-less composition).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compileSequenceRenderPlan } from "../compositor/compiler.js";
import type { CutholSequence } from "../core/schema.js";

function fakePaths(dir: string) {
  const blobsDir = path.join(dir, ".cuthol", "blobs");
  fs.mkdirSync(blobsDir, { recursive: true });
  return {
    rootDir: dir,
    blobsDir,
    ledgerFile: path.join(dir, ".cuthol", "ledger.db"),
  } as never;
}

function spineLessSequence(): CutholSequence {
  return {
    meta: { revision: 1, title: "alpha test" },
    stage: {
      width: 640,
      height: 360,
      fps: 30,
      backdrop: { color: "#000000" },
      master_audio: { music_db: -99, ducking_db: 0 },
    },
    library: [],
    spine: { clips: [] },
    lanes: [
      {
        id: "l1",
        kind: "overlay",
        z_index: 1,
        muted: false,
        cues: [
          {
            id: "c1",
            kind: "composition",
            anchor: null,
            at_ms: 0,
            duration_ms: 1000,
            envelopes: [],
            placement: {
              scale_x: 0.5,
              scale_y: 0.5,
              x_pct: 0,
              y_pct: 0,
              rotation_deg: 0,
              opacity: 1,
              fit_mode: "cover",
              crop: null,
              mirror_x: false,
              mirror_y: false,
            },
            composition: {
              composition_dir: "compositions/card",
              entry_html: "index.html",
              props: {},
              transparent: true,
              mode: "overlay_alpha",
            },
          },
        ],
      },
    ],
  } as unknown as CutholSequence;
}

function writeCard(dir: string): void {
  const compDir = path.join(dir, "compositions", "card");
  fs.mkdirSync(path.join(compDir, "assets"), { recursive: true });
  fs.writeFileSync(
    path.join(compDir, "index.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <script src="assets/gsap.min.js"></script>
    <script src="assets/cuthol-data.js"></script>
    <script src="assets/cuthol-runtime.js"></script>
    <style>html, body, #root { margin:0; width:320px; height:180px; background:transparent !important; overflow:hidden; }</style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-width="320" data-height="180" data-fps="30" data-duration="1.0">
      <div id="box" style="position:absolute;left:115px;top:65px;width:90px;height:50px;background:#ff0000"></div>
    </div>
    <script>
      const C = window.__cuthol;
      const tl = gsap.timeline({ paused: true });
      tl.set({}, {}, C.duration);
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>`,
    "utf8"
  );
}

describe("master_alpha keeps alpha through the composition overlay chain", () => {
  test("no opaque conversion in the alpha plan", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-plan-"));
    writeCard(dir);
    const plan = compileSequenceRenderPlan(spineLessSequence(), fakePaths(dir), "master_alpha", {
      includeAudio: false,
    });
    const graph = plan.filterComplex;
    assert.match(plan.inputArgs.join(" "), /color=c=0x00000000/, "backdrop must be transparent");
    assert.match(graph, /format=yuva444p10/, "overlay chain must stay yuva");
    assert.doesNotMatch(graph, /format=yuv444p10:/, "overlay must not drop alpha");
    assert.doesNotMatch(graph, /format=yuv420p/, "alpha plan must not convert to opaque yuv420p");
    assert.doesNotMatch(graph, /format=yuv444p10le/, "base must not go opaque yuv");
    assert.match(graph, /format=yuva420p/, "plan ends on an alpha pixel format");
  });

  test("full-frame composition over nothing stays transparent (no opaque bake)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-plan-"));
    writeCard(dir);
    const seq = spineLessSequence();
    const cue = seq.lanes[0].cues[0] as unknown as Record<string, unknown>;
    cue.placement = {
      scale_x: 1,
      scale_y: 1,
      x_pct: 0,
      y_pct: 0,
      rotation_deg: 0,
      opacity: 1,
      fit_mode: "cover",
      crop: null,
      mirror_x: false,
      mirror_y: false,
    };
    const plan = compileSequenceRenderPlan(seq, fakePaths(dir), "master_alpha", {
      includeAudio: false,
    });
    assert.equal(plan.directVideoBlobPath, null, "alpha preset never remuxes an opaque blob");
    assert.doesNotMatch(plan.filterComplex, /format=yuv420p/);
    assert.doesNotMatch(plan.filterComplex, /format=yuv444p10:/);
  });

  test("non-alpha presets still use the opaque fast path", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-plan-"));
    writeCard(dir);
    const plan = compileSequenceRenderPlan(spineLessSequence(), fakePaths(dir), "master_1080p", {
      includeAudio: false,
    });
    assert.match(plan.filterComplex, /format=yuv420p/);
  });
});

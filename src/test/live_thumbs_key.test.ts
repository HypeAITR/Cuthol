/**
 * Scene thumbnail keys refresh when the picture changes: an outside edit to a
 * composition source, a cue placement move, or a style/backdrop change alters
 * the key of the affected scene only; untouched scenes keep their key.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { computeSceneThumbKey, setSceneThumbProjectDir } from "../live/live_thumbs.js";
import { buildScenes } from "../live/live_state.js";

const FIXTURE = path.resolve(process.cwd(), "test-workspace/live-design/fixture/live_demo");

function copyFixture(): string | null {
  if (!fs.existsSync(path.join(FIXTURE, "cuthol.sequence.json"))) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-thumbkey-"));
  fs.cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

function readSequence(dir: string): any {
  return JSON.parse(fs.readFileSync(path.join(dir, "cuthol.sequence.json"), "utf8"));
}

function keysFor(dir: string, seq: any): Map<string, string> {
  setSceneThumbProjectDir(dir);
  const out = new Map<string, string>();
  for (const scene of buildScenes(seq, undefined, dir)) {
    const key = computeSceneThumbKey(seq, scene, dir);
    out.set(scene.id, key);
    assert.match(key, /^[0-9a-f]{16}$/);
  }
  return out;
}

test("scene thumb keys cover composition sources, placement, style and backdrop", (t) => {
  if (!fs.existsSync(path.join(FIXTURE, "cuthol.sequence.json"))) {
    t.skip(`fixture not present: ${FIXTURE}`);
    return;
  }
  const dir = copyFixture();
  if (!dir) return;
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const seq = readSequence(dir);
  const before = keysFor(dir, seq);
  assert.ok(before.size > 1);

  // 1. Outside edit: change a visible text in the title composition source.
  const indexHtml = path.join(dir, "comps/title/index.html");
  const html = fs.readFileSync(indexHtml, "utf8");
  // Bump mtime/size deterministically even if the text pattern is unchanged.
  fs.writeFileSync(indexHtml, `${html}\n<!-- thumb key probe -->\n`);
  const afterEdit = keysFor(dir, seq);
  const changedByEdit = [...before.keys()].filter((id) => before.get(id) !== afterEdit.get(id));
  // The title cue (1s-5s) overlaps only the first scene; nothing else may change.
  assert.deepEqual(changedByEdit, ["sc_1"]);

  // Restore the source, then move a caption cue: only its scene may change.
  fs.writeFileSync(indexHtml, html);
  const seq2 = readSequence(dir);
  const captionLane = seq2.lanes.find((l: any) => (l.cues ?? []).some((c: any) => c.kind === "caption"));
  const captionCue = captionLane.cues.find((c: any) => c.kind === "caption");
  const cueScene = [...before.keys()].find((id, i) => {
    const scenes = buildScenes(seq2, undefined, dir);
    const sc = scenes[i];
    return captionCue.at_ms < sc.end_ms && captionCue.at_ms + captionCue.duration_ms > sc.start_ms;
  });
  assert.ok(cueScene);
  const base2 = keysFor(dir, seq2);
  const oldY = captionCue.placement?.y_pct ?? 0;
  captionCue.placement = { ...captionCue.placement, y_pct: oldY === 26 ? 0 : 26 };
  const afterMove = keysFor(dir, seq2);
  const changedByMove = [...base2.keys()].filter((id) => base2.get(id) !== afterMove.get(id));
  assert.deepEqual(changedByMove, [cueScene]);

  // 3. Style and backdrop edits also change the key of the affected scene only.
  captionCue.placement = { ...captionCue.placement, y_pct: oldY };
  const base3 = keysFor(dir, seq2);
  captionCue.typography = { ...(captionCue.typography ?? {}), text: "changed caption", size_px: 999 };
  const afterStyle = keysFor(dir, seq2);
  assert.deepEqual(
    [...base3.keys()].filter((id) => base3.get(id) !== afterStyle.get(id)),
    [cueScene]
  );

  const seq4 = readSequence(dir);
  const base4 = keysFor(dir, seq4);
  seq4.stage = { ...seq4.stage, backdrop: { kind: "solid", color: "#112233", blur_sigma: 0 } };
  const afterBackdrop = keysFor(dir, seq4);
  assert.ok(
    [...base4.keys()].some((id) => base4.get(id) !== afterBackdrop.get(id)),
    "backdrop change must change at least one scene key"
  );

});

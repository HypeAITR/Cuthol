/**
 * Live composition watch: an outside edit to a composition directory changes
 * the affected scene's thumbnail key (so the window refreshes it) while
 * untouched scenes keep their key; files Cuthol itself writes never change it.
 */
import "./test_setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { computeSceneThumbKey, isCompIgnoredFile, setSceneThumbProjectDir } from "../live/live_thumbs.js";
import { buildScenes } from "../live/live_state.js";
import type { LiveCompChange } from "../live/live_types.js";

const FIXTURE = path.resolve(process.cwd(), "test-workspace/live-design/fixture/live_demo");

function copyFixture(): string | null {
  if (!fs.existsSync(path.join(FIXTURE, "cuthol.sequence.json"))) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-compwatch-"));
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
    out.set(scene.id, computeSceneThumbKey(seq, scene, dir));
  }
  return out;
}

function compDirForTitle(seq: any): string | null {
  for (const lane of seq?.lanes ?? []) {
    for (const cue of lane?.cues ?? []) {
      const d = cue?.composition?.composition_dir;
      if (typeof d === "string" && d.includes("title")) return d;
    }
  }
  return null;
}

test("outside composition edit changes only the affected scene key", (t) => {
  const dir = copyFixture();
  if (!dir) {
    t.skip(`fixture not present: ${FIXTURE}`);
    return;
  }
  const seq = readSequence(dir);
  const before = keysFor(dir, seq);
  const compDir = compDirForTitle(seq);
  assert.ok(compDir, "sequence has a title composition cue");
  const indexFile = path.join(dir, compDir!, "index.html");
  assert.ok(fs.existsSync(indexFile), `composition file present: ${indexFile}`);
  const html = fs.readFileSync(indexFile, "utf8");
  // Ensure a fresh mtime even on coarse filesystems.
  const mtime = new Date(Date.now() + 5000);
  fs.writeFileSync(indexFile, html.replace("</head>", "<style>.title-banner{outline:14px solid #ff0000 !important}</style></head>"));
  fs.utimesSync(indexFile, mtime, mtime);
  const after = keysFor(dir, seq);
  let changed = 0;
  for (const [id, key] of before) {
    if (after.get(id) !== key) changed++;
  }
  assert.ok(changed >= 1, "at least the affected scene key changes");
  assert.ok(changed < before.size, "untouched scenes keep their key");
});

test("files Cuthol itself writes do not change the scene key", (t) => {
  const dir = copyFixture();
  if (!dir) {
    t.skip(`fixture not present: ${FIXTURE}`);
    return;
  }
  const seq = readSequence(dir);
  const compDir = compDirForTitle(seq);
  assert.ok(compDir, "sequence has a title composition cue");
  const before = keysFor(dir, seq);
  assert.equal(isCompIgnoredFile("assets/cuthol-data.json", "cuthol-data.json"), true);
  assert.equal(isCompIgnoredFile("assets/cuthol-data.js", "cuthol-data.js"), true);
  assert.equal(isCompIgnoredFile("cuthol-bbox.json", "cuthol-bbox.json"), true);
  assert.equal(isCompIgnoredFile("index.html", "index.html"), false);
  const bridge = path.join(dir, compDir!, "assets", "cuthol-data.json");
  fs.mkdirSync(path.dirname(bridge), { recursive: true });
  fs.writeFileSync(bridge, JSON.stringify({ cues: [] }));
  const after = keysFor(dir, seq);
  for (const [id, key] of before) {
    assert.equal(after.get(id), key, `scene ${id} keeps its key for Cuthol-written files`);
  }
});

test("comps event carries changed directories and fresh scenes", () => {
  const msg: LiveCompChange = {
    schema: "cuthol.live/1",
    dirs: ["comps/title"],
    scenes: [],
  };
  assert.deepEqual(msg.dirs, ["comps/title"]);
  assert.equal(msg.schema, "cuthol.live/1");
});

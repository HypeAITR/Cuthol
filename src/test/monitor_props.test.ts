/**
 * Monitor frames show composition props (src/test/monitor_props.test.ts).
 *
 * The render path feeds cue props to HyperFrames with `--variables-file`,
 * but `hyperframes snapshot` (used by `monitor frame` and the composition
 * preview) has no variables option, so frames rendered from the raw
 * composition directory show the authored defaults instead of the props.
 * The snapshot callers therefore stage a temporary copy of the composition
 * with the prop values written into the `data-composition-variables`
 * defaults; the user's composition files are never modified.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyScalarVarsToStagedHtml, stageSnapshotDirWithScalarVars } from "../compositor/hf_frames.js";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "../..");
const FIXTURE = path.join(REPO, "test-workspace", "live-design", "fixture", "live_demo");

const ENTRY_HTML = [
  "<!doctype html>",
  "<html lang=\"en\" data-composition-variables='[",
  "  {\"id\":\"title\",\"type\":\"string\",\"label\":\"Title\",\"default\":\"Live Demo\"},",
  "  {\"id\":\"count\",\"type\":\"number\",\"label\":\"Count\",\"default\":3},",
  "  {\"id\":\"flag\",\"type\":\"boolean\",\"label\":\"Flag\",\"default\":false}",
  "]'>",
  "<head><meta charset=\"UTF-8\" /></head>",
  "<body><div id=\"root\"></div></body>",
  "</html>",
  "",
].join("\n");

function writeCompDir(entryHtml: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "monitor-props-"));
  fs.writeFileSync(path.join(dir, "index.html"), entryHtml, "utf8");
  return dir;
}

test("snapshot staging rewrites variable defaults with the render-time props", {
  skip: fs.existsSync(FIXTURE) ? false : `fixture not present: ${FIXTURE}`,
}, () => {
  const html = applyScalarVarsToStagedHtml(ENTRY_HTML, { title: "Launch Day" });
  assert.match(html, /"id":"title".*"default":"Launch Day"/);
  assert.match(html, /"id":"count".*"default":3/);
});

test("snapshot staging keeps defaults on type mismatch or unknown id", {
  skip: fs.existsSync(FIXTURE) ? false : `fixture not present: ${FIXTURE}`,
}, () => {
  const html = applyScalarVarsToStagedHtml(ENTRY_HTML, {
    count: "not-a-number",
    unknown: "value",
  } as unknown as Record<string, string | number | boolean>);
  assert.match(html, /"id":"count".*"default":3/);
  assert.doesNotMatch(html, /"default":"value"/);
});

test("snapshot staging copies the composition and leaves the source untouched", {
  skip: fs.existsSync(FIXTURE) ? false : `fixture not present: ${FIXTURE}`,
}, () => {
  const srcDir = writeCompDir(ENTRY_HTML);
  const blobsDir = fs.mkdtempSync(path.join(os.tmpdir(), "monitor-props-blobs-"));
  try {
    const staged = stageSnapshotDirWithScalarVars({
      absCompDir: srcDir,
      entryHtml: "index.html",
      blobsDir,
      hash: "testhash",
      scalarVars: { title: "Launch Day", flag: true },
    });
    assert.ok(staged && fs.existsSync(path.join(staged, "index.html")));
    const stagedHtml = fs.readFileSync(path.join(staged!, "index.html"), "utf8");
    assert.match(stagedHtml, /"default":"Launch Day"/);
    assert.match(stagedHtml, /"default":true/);
    assert.equal(fs.readFileSync(path.join(srcDir, "index.html"), "utf8"), ENTRY_HTML);
  } finally {
    fs.rmSync(srcDir, { recursive: true, force: true });
    fs.rmSync(blobsDir, { recursive: true, force: true });
  }
});

test("snapshot staging is a no-op without scalar variables", {
  skip: fs.existsSync(FIXTURE) ? false : `fixture not present: ${FIXTURE}`,
}, () => {
  assert.equal(applyScalarVarsToStagedHtml(ENTRY_HTML, {}), ENTRY_HTML);
  const srcDir = writeCompDir(ENTRY_HTML);
  const blobsDir = fs.mkdtempSync(path.join(os.tmpdir(), "monitor-props-blobs-"));
  try {
    assert.equal(
      stageSnapshotDirWithScalarVars({
        absCompDir: srcDir,
        entryHtml: "index.html",
        blobsDir,
        hash: "testhash",
        scalarVars: {},
      }),
      null
    );
  } finally {
    fs.rmSync(srcDir, { recursive: true, force: true });
    fs.rmSync(blobsDir, { recursive: true, force: true });
  }
});

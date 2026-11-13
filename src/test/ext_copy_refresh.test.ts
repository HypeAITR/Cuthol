// Changed extension helper is refreshed in compositions, user edits are not.
// A Cuthol-written helper copy (marker line) or asset-pack file (sidecar record)
// is refreshed on the next sync after the extension changes; a file the user
// edited inside the composition is left alone and still reports drift (G205).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  detectCompositionExtensionCopyDrift,
  syncEnabledExtensionAssetsToComposition,
} from "../compositor/bridge_extension_assets.js";
import { resolveWorkspacePaths } from "../core/workspace.js";
import { CutholSequence } from "../core/schema.js";
import { resolveExtension } from "../extensions/ext_registry.js";

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-ext-refresh-"));

function makeProject(name: string): { root: string; compDir: string } {
  const root = fs.mkdtempSync(path.join(TEST_ROOT, `${name}-`));
  fs.writeFileSync(path.join(root, "cuthol.sequence.json"), JSON.stringify({ title: name }), "utf8");
  const extDir = path.join(root, ".cuthol", "extensions", "kit");
  fs.mkdirSync(path.join(extDir, "assets"), { recursive: true });
  fs.writeFileSync(
    path.join(extDir, "cuthol-extension.json"),
    JSON.stringify({ name: "kit", version: "1.0.0", description: "kit", helper: "helper.js", assets: "assets" }),
    "utf8"
  );
  fs.writeFileSync(path.join(extDir, "helper.js"), "window.__kit = 1;\n", "utf8");
  fs.writeFileSync(path.join(extDir, "assets", "logo.txt"), "v1\n", "utf8");
  const compDir = path.join(root, "compositions", "cmp");
  fs.mkdirSync(path.join(compDir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(compDir, "index.html"), "<html></html>", "utf8");
  return { root, compDir };
}

function seqFor(root: string): CutholSequence {
  const ext = resolveExtension("kit", root);
  return {
    extensions: [
      {
        name: ext.name,
        version: ext.version,
        content_hash: ext.contentHash,
        scope: ext.scope,
        enabled_at: new Date().toISOString(),
      },
    ],
    lanes: [
      {
        id: "ln_01",
        kind: "overlay",
        muted: false,
        cues: [
          {
            id: "cue_01",
            kind: "composition",
            composition: { composition_dir: "compositions/cmp", entry_html: "index.html" },
          },
        ],
      },
    ],
  } as unknown as CutholSequence;
}

test("stale Cuthol-written copies refresh on next sync; user edits are left alone", () => {
  const { root, compDir } = makeProject("refresh");
  const paths = resolveWorkspacePaths(root);
  const helperCopy = path.join(compDir, "assets", "cuthol-ext-kit.js");
  const assetCopy = path.join(compDir, "assets", "ext", "kit", "logo.txt");

  // Seed.
  let seq = seqFor(root);
  const seed = syncEnabledExtensionAssetsToComposition(seq, compDir, "index.html", paths);
  assert.ok(seed.updatedFiles.includes("assets/cuthol-ext-kit.js"));
  const hashV1 = fs.readFileSync(helperCopy, "utf8");
  assert.ok(hashV1.includes("window.__kit = 1;"));
  assert.equal(fs.readFileSync(assetCopy, "utf8"), "v1\n");
  assert.equal(detectCompositionExtensionCopyDrift(seq, "kit", paths).drifted, false);

  // Change the extension on disk; next sync refreshes Cuthol-written copies.
  const extDir = path.join(root, ".cuthol", "extensions", "kit");
  fs.writeFileSync(path.join(extDir, "helper.js"), "window.__kit = 2;\n", "utf8");
  fs.writeFileSync(path.join(extDir, "assets", "logo.txt"), "v2\n", "utf8");
  seq = seqFor(root);
  const refreshed = syncEnabledExtensionAssetsToComposition(seq, compDir, "index.html", paths);
  assert.ok(refreshed.updatedFiles.includes("assets/cuthol-ext-kit.js"));
  assert.ok(refreshed.updatedFiles.includes("assets/ext/kit/logo.txt"));
  const hashV2 = fs.readFileSync(helperCopy, "utf8");
  assert.ok(hashV2.includes("window.__kit = 2;"));
  assert.notEqual(hashV1, hashV2);
  assert.equal(fs.readFileSync(assetCopy, "utf8"), "v2\n");
  assert.equal(detectCompositionExtensionCopyDrift(seq, "kit", paths).drifted, false);

  // User edits inside the composition are never overwritten.
  fs.writeFileSync(helperCopy, "// user tweak\n" + hashV2, "utf8");
  fs.writeFileSync(assetCopy, "user logo\n", "utf8");
  const kept = syncEnabledExtensionAssetsToComposition(seq, compDir, "index.html", paths);
  assert.ok(!kept.updatedFiles.includes("assets/cuthol-ext-kit.js"));
  assert.ok(!kept.updatedFiles.includes("assets/ext/kit/logo.txt"));
  assert.ok(fs.readFileSync(helperCopy, "utf8").startsWith("// user tweak"));
  assert.equal(fs.readFileSync(assetCopy, "utf8"), "user logo\n");
  const drift = detectCompositionExtensionCopyDrift(seq, "kit", paths);
  assert.equal(drift.drifted, true);
  assert.ok(drift.driftedCompositions.includes("compositions/cmp"));
});

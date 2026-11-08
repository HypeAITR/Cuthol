/**
 * external_changes: out-of-journal edits (composition folders + hand-edited
 * `cuthol.sequence.json`) are detected, reported, and resolved via
 * `workspace changes show/adopt/revert`.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { scaffoldHyperFramesComposition } from "../compositor/hyperframes_bridge.js";
import {
  adoptExternalChanges,
  buildChangesShow,
  detectExternalChanges,
  revertExternalChanges,
} from "../core/external_changes.js";
import {
  initWorkspace,
  loadJournalManifest,
  loadSequence,
  openWorkspaceSummary,
  resolveWorkspacePaths,
  setLaneLockStatus,
  stepJournal,
} from "../core/workspace.js";
import { CutholMcpServer } from "../mcp/server.js";
import { addLaneCue } from "../sequence/lanes.js";

const REPO_ROOT = process.cwd();
const CLI_PATH = path.resolve(REPO_ROOT, "dist/cli.js");
const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-external_changes-"));

function runCliJson(workspaceDir: string, args: string[]): Record<string, unknown> {
  const proc = spawnSync(process.execPath, [CLI_PATH, ...args, "--dir", workspaceDir], {
    encoding: "utf8",
  });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
  return JSON.parse(proc.stdout) as Record<string, unknown>;
}

function runCliText(workspaceDir: string, args: string[]): string {
  const proc = spawnSync(process.execPath, [CLI_PATH, ...args, "--dir", workspaceDir], {
    encoding: "utf8",
  });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
  return proc.stdout;
}

function mcpText(res: { content: Array<{ type: string; text?: string }> }): string {
  return res.content.map((c) => c.text ?? "").join("\n");
}

/** Fresh project with one mounted composition; returns ws dir + comp dir. */
function setupProject(name: string, compName = "cmp_intro"): { ws: string; compDir: string } {
  const ws = path.join(TEST_ROOT, name);
  fs.rmSync(ws, { recursive: true, force: true });
  initWorkspace({ dir: ws, title: name, aspect: "16:9", fps: 30 });
  const compDir = path.join(ws, "compositions", compName);
  scaffoldHyperFramesComposition({
    targetDir: compDir,
    width: 1920,
    height: 1080,
    fps: 30,
    durationMs: 3000,
    preset: "counter",
    props: {},
    transparent: true,
  });
  addLaneCue({
    workspaceDir: ws,
    laneId: "ln_motion",
    kind: "composition",
    atMs: 0,
    durationMs: 3000,
    composition: {
      composition_dir: `compositions/${compName}`,
      entry_html: "index.html",
      props: {},
      transparent: true,
      mode: "overlay_alpha",
    },
  });
  return { ws, compDir };
}

test("1. external comp edit is reported by open/brief/MCP with file names; bridge + synced files stay silent", async () => {
  const { ws, compDir } = setupProject("ws_notify");
  const indexHtml = path.join(compDir, "index.html");
  const orig = fs.readFileSync(indexHtml, "utf8");
  fs.writeFileSync(indexHtml, `${orig}\n<!-- dis duzenleme -->\n`, "utf8");
  fs.writeFileSync(path.join(compDir, "assets", "logo.png"), Buffer.from([137, 80, 78, 71, 1, 2, 3]));

  const opened = openWorkspaceSummary(ws);
  assert.ok(opened.summary_text.startsWith("> External project change detected: "), opened.summary_text.slice(0, 120));
  assert.ok(opened.summary_text.includes("index.html"));
  assert.ok(opened.summary_text.includes("assets/logo.png"));
  assert.ok(opened.external_changes);
  assert.equal(opened.external_changes?.diagnostic.code, "CUTHOL-G210");

  const briefOut = runCliText(ws, ["brief", "--lens=overview"]);
  assert.ok(briefOut.startsWith("> External project change detected: "), briefOut.slice(0, 120));
  assert.ok(briefOut.includes("index.html"));

  const shown = runCliJson(ws, ["workspace", "changes", "show"]);
  assert.equal(shown.has_changes, true);
  assert.equal((shown.diagnostic as { code: string }).code, "CUTHOL-G210");
  assert.ok((shown.summary_text as string).includes("<!-- dis duzenleme -->"));

  const mcp = new CutholMcpServer();
  const openedMcp = await mcp.callTool("workspace", { action: "open", dir: ws });
  assert.ok(mcpText(openedMcp).includes("External project change detected: "));
  // `open` was the session's first call (full text inside); the next call is a reminder.
  const second = await mcp.callTool("brief", { lens: "overview" });
  assert.ok(mcpText(second).startsWith("NOTE External change still pending ("), mcpText(second).slice(0, 100));
  // A fresh session's first call carries the full text with file names.
  const mcp2 = new CutholMcpServer();
  const first = await mcp2.callTool("brief", { lens: "overview", dir: ws });
  const firstText = mcpText(first);
  assert.ok(firstText.startsWith("NOTE External project change detected: "), firstText.slice(0, 120));
  assert.ok(firstText.includes("index.html"));

  // Bridge data files and Cuthol-synced files must NOT notify.
  adoptExternalChanges(ws);
  assert.equal(detectExternalChanges(ws).has_changes, false);
  const dataJson = path.join(compDir, "assets", "cuthol-data.json");
  assert.ok(fs.existsSync(dataJson));
  fs.writeFileSync(dataJson, `${fs.readFileSync(dataJson, "utf8").trimEnd()} \n`, "utf8");
  const varsJson = path.join(compDir, "assets", "cuthol-vars.json");
  if (fs.existsSync(varsJson)) fs.writeFileSync(varsJson, `${fs.readFileSync(varsJson, "utf8").trimEnd()} \n`, "utf8");
  fs.mkdirSync(path.join(compDir, "assets", "ext", "kit"), { recursive: true });
  fs.writeFileSync(path.join(compDir, "assets", "ext", "kit", "brand.txt"), "kit\n", "utf8");
  fs.writeFileSync(path.join(compDir, "assets", "gsap.min.js"), "/* gsap */\n", "utf8");
  fs.writeFileSync(path.join(compDir, ".cuthol-probe"), "x\n", "utf8");
  assert.equal(detectExternalChanges(ws).has_changes, false);
  const briefClean = runCliText(ws, ["brief", "--lens=overview"]);
  assert.ok(briefClean.startsWith("# CUTHOL BRIEF"), briefClean.slice(0, 60));
});

test("2. MCP note: full text first, one-line reminder while unchanged, full again when grown", async () => {
  const { ws, compDir } = setupProject("ws_mcpnote");
  const indexHtml = path.join(compDir, "index.html");
  const mcp = new CutholMcpServer();
  await mcp.callTool("workspace", { action: "open", dir: ws });

  fs.writeFileSync(indexHtml, `${fs.readFileSync(indexHtml, "utf8")}\n<!-- a -->\n`, "utf8");
  const t1 = mcpText(await mcp.callTool("brief", { lens: "overview" }));
  assert.ok(t1.startsWith("NOTE External project change detected: "), t1.slice(0, 100));

  const t2 = mcpText(await mcp.callTool("brief", { lens: "overview" }));
  assert.ok(t2.startsWith("NOTE External change still pending ("), t2.slice(0, 100));
  assert.equal(t2.split("\n")[0].includes("changes_adopt"), false);

  fs.writeFileSync(indexHtml, `${fs.readFileSync(indexHtml, "utf8")}\n<!-- b -->\n`, "utf8");
  const t3 = mcpText(await mcp.callTool("brief", { lens: "overview" }));
  assert.ok(t3.startsWith("NOTE External project change detected: "), t3.slice(0, 100));
});

test("3. adopt makes a revision; undo restores old content, redo restores new", () => {
  const { ws, compDir } = setupProject("ws_adopt");
  const indexHtml = path.join(compDir, "index.html");
  const orig = fs.readFileSync(indexHtml, "utf8");
  const revBefore = loadSequence(ws).sequence.meta.revision;

  fs.writeFileSync(indexHtml, `${orig}\n<!-- v2 -->\n`, "utf8");
  const adopted = adoptExternalChanges(ws);
  assert.equal(adopted.adopted, true);
  assert.equal(adopted.revision, revBefore + 1);
  assert.equal(detectExternalChanges(ws).has_changes, false);
  const paths = resolveWorkspacePaths(ws);
  const manifest = loadJournalManifest(paths);
  assert.ok(manifest.entries[manifest.entries.length - 1].operation.startsWith("workspace.changes.adopt"));

  stepJournal(ws, "undo");
  assert.equal(fs.readFileSync(indexHtml, "utf8"), orig);
  assert.equal(detectExternalChanges(ws).has_changes, false);

  const redone = stepJournal(ws, "redo");
  assert.ok(fs.readFileSync(indexHtml, "utf8").includes("<!-- v2 -->"));
  assert.equal(detectExternalChanges(ws).has_changes, false);
  assert.ok(redone.reverted_entries[0].inverse_summary.includes("composition files"));
});

test("4. revert restores known content; added files vanish, deleted files return", () => {
  const { ws, compDir } = setupProject("ws_revert");
  const indexHtml = path.join(compDir, "index.html");
  const notesFile = path.join(compDir, "notes.txt");
  fs.writeFileSync(notesFile, "not v1\n", "utf8");
  adoptExternalChanges(ws); // baseline now includes notes.txt
  const orig = fs.readFileSync(indexHtml, "utf8");

  fs.writeFileSync(indexHtml, `${orig}\n<!-- v3 -->\n`, "utf8");
  fs.writeFileSync(path.join(compDir, "extra.txt"), "hello\n", "utf8");
  fs.unlinkSync(notesFile);

  const reverted = revertExternalChanges(ws);
  assert.equal(reverted.reverted, true);
  assert.equal(fs.readFileSync(indexHtml, "utf8"), orig);
  assert.equal(fs.existsSync(path.join(compDir, "extra.txt")), false);
  assert.equal(fs.readFileSync(notesFile, "utf8"), "not v1\n");
  assert.equal(detectExternalChanges(ws).has_changes, false);

  // The revert itself is a revision: undo brings the pre-revert content back.
  stepJournal(ws, "undo");
  assert.ok(fs.readFileSync(indexHtml, "utf8").includes("<!-- v3 -->"));
  assert.equal(fs.existsSync(path.join(compDir, "extra.txt")), true);
  assert.equal(fs.existsSync(notesFile), false);
  assert.equal(detectExternalChanges(ws).has_changes, true);
});

test("5. G211: a Cuthol op that would silently revert the user's edit is refused, file untouched", () => {
  const { ws, compDir } = setupProject("ws_g211");
  const indexHtml = path.join(compDir, "index.html");
  const withTags = fs.readFileSync(indexHtml, "utf8");
  assert.ok(withTags.includes("assets/cuthol-data.js"), "scaffolded comp must carry bridge tags after mount");
  const stripped = withTags.replace(
    /<script\s+src=(["'])assets\/cuthol-data\.js\1\s*><\/script>/i,
    ""
  );
  assert.notEqual(stripped, withTags);
  fs.writeFileSync(indexHtml, stripped, "utf8");

  const revBefore = loadSequence(ws).sequence.meta.revision;
  assert.throws(
    () => setLaneLockStatus({ workspaceDir: ws, laneId: "ln_motion", locked: true }),
    (err: unknown) =>
      typeof err === "object" && err !== null && (err as { diagnostic?: { code?: string } }).diagnostic?.code === "CUTHOL-G211"
  );
  assert.equal(loadSequence(ws).sequence.meta.revision, revBefore);
  assert.equal(fs.readFileSync(indexHtml, "utf8"), stripped);

  // Negative control: a plain content edit does not block an unrelated commit.
  revertExternalChanges(ws);
  fs.writeFileSync(indexHtml, `${fs.readFileSync(indexHtml, "utf8")}\n<!-- div -->\n`, "utf8");
  const locked = setLaneLockStatus({ workspaceDir: ws, laneId: "ln_motion", locked: true });
  assert.equal(locked.locked, true);
  assert.equal(detectExternalChanges(ws).has_changes, true);
});

test("6. corrupt sequence.json: adopt is refused with a G1 diagnostic, file and journal untouched", () => {
  const { ws } = setupProject("ws_corrupt");
  const paths = resolveWorkspacePaths(ws);
  const revBefore = loadSequence(ws).sequence.meta.revision;
  const entriesBefore = loadJournalManifest(paths).entries.length;

  fs.writeFileSync(paths.sequenceFile, "{ bu gecerli bir json degil,,\n", "utf8");
  const detected = detectExternalChanges(ws);
  assert.equal(detected.has_changes, true);
  assert.equal(detected.sequence?.status, "corrupt");
  const shown = buildChangesShow(ws);
  assert.ok(shown.summary_text.includes("CORRUPT"));

  assert.throws(
    () => adoptExternalChanges(ws),
    (err: unknown) =>
      typeof err === "object" &&
      err !== null &&
      String((err as { diagnostic?: { code?: string } }).diagnostic?.code ?? "").startsWith("CUTHOL-G1")
  );
  assert.equal(fs.readFileSync(paths.sequenceFile, "utf8"), "{ bu gecerli bir json degil,,\n");
  assert.equal(loadJournalManifest(paths).entries.length, entriesBefore);

  // Revert recovers from the journal snapshot.
  const reverted = revertExternalChanges(ws);
  assert.equal(reverted.reverted, true);
  assert.equal(reverted.sequence_restored, true);
  assert.equal(loadSequence(ws).sequence.meta.revision, revBefore + 1);
  assert.equal(detectExternalChanges(ws).has_changes, false);
});

test("7. schema-broken sequence.json: adopt fails closed on the real gate error", () => {
  const { ws } = setupProject("ws_schemabroken");
  const paths = resolveWorkspacePaths(ws);
  const seq = JSON.parse(fs.readFileSync(paths.sequenceFile, "utf8")) as {
    lanes: Array<{ cues: Array<Record<string, unknown>> }>;
  };
  const cue = seq.lanes.find((l) => l.cues.length > 0)!.cues[0];
  seq.lanes.find((l) => l.cues.length > 0)!.cues.push({ ...cue }); // duplicate handle
  fs.writeFileSync(paths.sequenceFile, JSON.stringify(seq), "utf8");

  assert.equal(detectExternalChanges(ws).sequence?.status, "modified");
  assert.throws(
    () => adoptExternalChanges(ws),
    (err: unknown) =>
      typeof err === "object" &&
      err !== null &&
      (err as { diagnostic?: { code?: string } }).diagnostic?.code === "CUTHOL-G102"
  );
  assert.equal(detectExternalChanges(ws).has_changes, true);
});

test("8. --comp scoping: adopt/revert can target one composition", () => {
  const ws = path.join(TEST_ROOT, "ws_scope");
  fs.rmSync(ws, { recursive: true, force: true });
  initWorkspace({ dir: ws, title: "scope", aspect: "16:9", fps: 30 });
  const mk = (name: string): string => {
    const compDir = path.join(ws, "compositions", name);
    scaffoldHyperFramesComposition({
      targetDir: compDir, width: 1920, height: 1080, fps: 30, durationMs: 3000,
      preset: "counter", props: {}, transparent: true,
    });
    addLaneCue({
      workspaceDir: ws, laneId: "ln_motion", kind: "composition", atMs: 0, durationMs: 3000,
      composition: { composition_dir: `compositions/${name}`, entry_html: "index.html", props: {}, transparent: true, mode: "overlay_alpha" },
    });
    return compDir;
  };
  const dirA = mk("cmp_a");
  const dirB = mk("cmp_b");
  const idxA = path.join(dirA, "index.html");
  const idxB = path.join(dirB, "index.html");
  const origB = fs.readFileSync(idxB, "utf8");
  fs.writeFileSync(idxA, `${fs.readFileSync(idxA, "utf8")}\n<!-- a -->\n`, "utf8");
  fs.writeFileSync(idxB, `${origB}\n<!-- b -->\n`, "utf8");

  const adopted = adoptExternalChanges(ws, "compositions/cmp_a");
  assert.deepEqual(adopted.adopted_comps, ["compositions/cmp_a"]);
  const still = detectExternalChanges(ws);
  assert.equal(still.has_changes, true);
  assert.deepEqual(still.compositions.map((c) => c.key), ["compositions/cmp_b"]);

  const reverted = revertExternalChanges(ws, "cmp_b");
  assert.deepEqual(reverted.reverted_comps, ["compositions/cmp_b"]);
  assert.equal(fs.readFileSync(idxB, "utf8"), origB);
  assert.equal(detectExternalChanges(ws).has_changes, false);
});

test("9. valid hand-edited sequence.json folds into the next commit with a journal note", () => {
  const { ws } = setupProject("ws_fold");
  const paths = resolveWorkspacePaths(ws);
  const seq = JSON.parse(fs.readFileSync(paths.sequenceFile, "utf8")) as {
    meta: { title: string };
  };
  seq.meta.title = "Elle Degistirilmis Baslik";
  fs.writeFileSync(paths.sequenceFile, JSON.stringify(seq, null, 2), "utf8");
  assert.equal(detectExternalChanges(ws).sequence?.status, "modified");

  setLaneLockStatus({ workspaceDir: ws, laneId: "ln_motion", locked: true });
  const manifest = loadJournalManifest(paths);
  const last = manifest.entries[manifest.entries.length - 1];
  assert.ok(last.absorbed_external_sequence);
  assert.ok((last.delta_summary ?? "").includes("without adopt"));
  assert.equal(loadSequence(ws).sequence.meta.title, "Elle Degistirilmis Baslik");
  assert.equal(detectExternalChanges(ws).has_changes, false);
});

test("10. speed: no-change detection on a 30-composition project", () => {
  const ws = path.join(TEST_ROOT, "ws_perf");
  fs.rmSync(ws, { recursive: true, force: true });
  initWorkspace({ dir: ws, title: "perf", aspect: "16:9", fps: 30 });
  for (let i = 1; i <= 30; i++) {
    const name = `cmp_${String(i).padStart(2, "0")}`;
    const compDir = path.join(ws, "compositions", name);
    scaffoldHyperFramesComposition({
      targetDir: compDir, width: 1920, height: 1080, fps: 30, durationMs: 3000,
      preset: "counter", props: {}, transparent: true,
    });
    addLaneCue({
      workspaceDir: ws, laneId: "ln_motion", kind: "composition", atMs: 0, durationMs: 3000,
      composition: { composition_dir: `compositions/${name}`, entry_html: "index.html", props: {}, transparent: true, mode: "overlay_alpha" },
    });
  }
  assert.equal(detectExternalChanges(ws).has_changes, false);
  const samples: number[] = [];
  for (let i = 0; i < 5; i++) {
    const t0 = process.hrtime.bigint();
    const d = detectExternalChanges(ws);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    samples.push(ms);
    assert.equal(d.has_changes, false);
  }
  samples.sort((a, b) => a - b);
  console.log(`external_changes perf: 30 comps, no-change detection ms: ${samples.map((s) => s.toFixed(1)).join(", ")} (median ${samples[2].toFixed(1)})`);
  assert.ok(samples[2] < 10_000, `median detection too slow: ${samples[2]}ms`);
});

/**
 * Colour CLI/MCP surface: catalog registration, compact formatting, brief line.
 */
import "./test_setup.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createEmptySequence } from "../core/schema.js";
import { initWorkspace, loadSequence } from "../core/workspace.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { appendSpineClip } from "../sequence/spine.js";
import { CutholMcpServer } from "../mcp/server.js";
import { spawnSync } from "node:child_process";
import { describeSequenceColour } from "../brief/inspector.js";
import { renderSequenceBrief } from "../brief/inspector.js";
import { actionsForTool, findActionSpec, TOOL_SPECS } from "../mcp/catalog.js";
import { formatColorSummary } from "../mcp/mcp_format.js";
import { parseColorFlags } from "../color/cli_parse.js";

test("color tool is registered with actions", () => {
  assert.ok(TOOL_SPECS.some((t) => t.name === "color"), "TOOL_SPECS has color");
  const actions = actionsForTool("color").map((a) => a.action);
  for (const name of ["map", "diff", "solve", "set", "compare", "look", "kind", "clusters", "migrate"]) {
    assert.ok(actions.includes(name), `color action ${name} registered`);
  }
  const set = findActionSpec("color", "set");
  assert.ok(set && set.mutates === true);
  assert.deepEqual(set.argv, ["color", "set"]);
  const kind = findActionSpec("color", "kind");
  assert.ok(kind?.params.some((p) => p.name === "set" && p.enum?.includes("camera")));
});

test("spine envelope accepts keyframed colour params", () => {
  const env = findActionSpec("spine", "envelope");
  const param = env?.params.find((p) => p.name === "param");
  assert.ok(param?.enum?.includes("color.exposure.stops"), "color envelope param listed");
  assert.ok(param?.enum?.includes("treatments.color_grade.brightness"), "legacy param kept");
});

test("color compact output is the result lines", () => {
  assert.equal(formatColorSummary("set", { lines: ["sp_01: exp +0.4", "after: tone p50 .52"] }), "sp_01: exp +0.4\nafter: tone p50 .52");
  assert.equal(formatColorSummary("set", {}), null);
});

test("short colour flags parse into schema blocks", () => {
  const { patch, remove } = parseColorFlags({
    wb: "25,0.1",
    exposure: "-0.4",
    tone: "contrast=0.2,shadows=-0.1",
    curve: "master=0:0,0.25:0.18,1:1;r=0.5:0.55",
    wheel: "lift=200,0.15;gain=30,0.05,0.1",
    hsl: "hsl_01=center:25,width:30,shift:-6,sat:1.15",
    sat: "1.1",
    vibrance: "0.3",
    look: "look_01:0.6",
    remove: "curves,hsl:hsl_02",
  });
  assert.deepEqual(patch.white_balance, { temp_mired: 25, tint: 0.1 });
  assert.deepEqual(patch.exposure, { stops: -0.4 });
  assert.deepEqual(patch.tone, { contrast: 0.2, shadows: -0.1 });
  assert.deepEqual(patch.curves, { master: [[0, 0], [0.25, 0.18], [1, 1]], r: [[0.5, 0.55]] });
  assert.deepEqual(patch.wheels, { lift: { hue_deg: 200, amount: 0.15 }, gain: { hue_deg: 30, amount: 0.05, luma: 0.1 } });
  assert.deepEqual(patch.hsl, [{ id: "hsl_01", hue_center_deg: 25, hue_width_deg: 30, hue_shift_deg: -6, sat_scale: 1.15 }]);
  assert.deepEqual(patch.saturation, { saturation: 1.1, vibrance: 0.3 });
  assert.deepEqual(patch.look, { id: "look_01", amount: 0.6 });
  assert.deepEqual(remove, ["curves", "hsl:hsl_02"]);
  assert.throws(() => parseColorFlags({ tone: "punch=1" }), /unknown field 'punch'/);
  assert.throws(() => parseColorFlags({ patch: '{"sat":1.2}' }), /unknown block 'sat'/);
  assert.throws(() => parseColorFlags({ amount: "tone=0.5" }), /not set on this item/);
  const merged = parseColorFlags({ amount: "tone=0.5" }, { tone: { contrast: 0.3 } });
  assert.deepEqual(merged.patch.tone, { contrast: 0.3, amount: 0.5 });
});

test("color tool is listed and color.set runs through the MCP server", async () => {
  const wsDir = path.resolve(process.cwd(), "test-workspace/color_mcp_set");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "color mcp", aspect: "16:9", fps: 30 });
  // Synthetic clip: the test runs without the trial media.
  const media = path.join(wsDir, "..", "color_mcp_src.mp4");
  const mk = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30", "-t", "4", "-c:v", "libx264", "-pix_fmt", "yuv420p", media], { encoding: "utf8", windowsHide: true });
  assert.equal(mk.status, 0, mk.stderr);
  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [media] });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 3000 });
  const mcp = new CutholMcpServer({ defaultDir: wsDir });
  const list = await mcp.handleJsonRpcRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const names = ((list as { result: { tools: Array<{ name: string }> } }).result.tools).map((t) => t.name);
  assert.ok(names.includes("color"), `tools/list shows color, got ${names}`);
  const before = fs.readFileSync(path.join(wsDir, "cuthol.sequence.json"), "utf8");
  const res = await mcp.callTool("color", { action: "set", item: "sp_01", sat: "1.2", exposure: "0.3", reason: "taste" });
  assert.equal(res.isError, false, String(res.content[0].text).slice(0, 500));
  assert.ok(String(res.content[0].text).includes("sp_01: exp +0.3 | sat ×1.2"), String(res.content[0].text).slice(0, 400));
  const { sequence } = loadSequence(wsDir);
  const clip = sequence.spine.clips.find((c) => c.id === "sp_01");
  assert.deepEqual(clip?.treatments.color, { exposure: { stops: 0.3 }, saturation: { saturation: 1.2 } });
  const undo = await mcp.callTool("workspace", { action: "undo" });
  assert.equal(undo.isError, false, String(undo.content[0].text).slice(0, 300));
  assert.equal(JSON.parse(fs.readFileSync(path.join(wsDir, "cuthol.sequence.json"), "utf8")).spine.clips[0].treatments.color, undefined);
  void before;
});

test("brief overview carries a colour line", () => {
  const seq = createEmptySequence({ projectId: "color-c", title: "color" });
  const md = renderSequenceBrief(seq, { lens: "overview" });
  assert.ok(md.includes("- Colour: `no stages, no Looks`"), md);
  assert.equal(describeSequenceColour(seq), "no stages, no Looks");
});

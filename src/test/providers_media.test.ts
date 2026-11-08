/**
 * Extension media providers (`library search` / `library fetch`) over the `media-folder`
 * example (`src/test/providers_media.test.ts`). No network; the shelf is local files.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { CutholError } from "../core/diagnostics.js";
import { initWorkspace, loadSequence } from "../core/workspace.js";
import { renderSequenceBrief } from "../brief/inspector.js";
import { fetchMediaSource, searchMediaSource } from "../library/media_source.js";
import { buildCliArgv, findActionSpec, validateActionArgs } from "../mcp/catalog.js";

const TEST_ROOT = path.resolve(process.cwd(), "test-workspace/providers_media");
const CLI = path.resolve(process.cwd(), "dist/cli.js");

function writeToneWav(wavFile: string, durationSec: number, frequency: number): void {
  const ff = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=${frequency}:sample_rate=48000:duration=${durationSec}`,
      "-c:a",
      "pcm_s16le",
      "-ar",
      "48000",
      "-ac",
      "2",
      wavFile,
    ],
    { encoding: "utf8" }
  );
  assert.equal(ff.status, 0, ff.stderr);
}

function installMediaFolder(wsDir: string): string {
  const src = path.resolve(process.cwd(), "examples/extensions/media-folder");
  const dest = path.join(wsDir, ".cuthol", "extensions", "media-folder");
  fs.mkdirSync(dest, { recursive: true });
  for (const file of ["cuthol-extension.json", "media.js", "README.md"]) {
    fs.copyFileSync(path.join(src, file), path.join(dest, file));
  }
  // The example script is `.js`; test workspaces live under this repo's
  // `type: module` package, so the installed copy uses an identical `.cjs` file.
  const script = fs.readFileSync(path.join(dest, "media.js"), "utf8");
  fs.writeFileSync(path.join(dest, "media.cjs"), script, "utf8");
  const manifest = JSON.parse(fs.readFileSync(path.join(dest, "cuthol-extension.json"), "utf8")) as {
    providers: { media: { script: string } };
  };
  manifest.providers.media.script = "media.cjs";
  fs.writeFileSync(path.join(dest, "cuthol-extension.json"), JSON.stringify(manifest, null, 2), "utf8");
  const tracks = path.join(dest, "tracks");
  fs.mkdirSync(tracks, { recursive: true });

  writeToneWav(path.join(tracks, "calm_piano.wav"), 30, 440);
  fs.writeFileSync(
    path.join(tracks, "calm_piano.wav.json"),
    JSON.stringify({
      title: "Calm Piano Bed",
      kind: "music",
      tags: ["calm", "piano"],
      mood: "calm",
      license: "CC-BY 4.0, attribution: Example Artist",
      source_url: "https://example.com/tracks/calm-piano",
    }),
    "utf8"
  );
  writeToneWav(path.join(tracks, "riser_hit.wav"), 3, 880);
  fs.writeFileSync(
    path.join(tracks, "riser_hit.wav.json"),
    JSON.stringify({ title: "Riser Hit", kind: "sfx", tags: ["riser", "hit"], license: "CC0" }),
    "utf8"
  );
  writeToneWav(path.join(tracks, "untagged_loop.wav"), 8, 220);
  return dest;
}

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const proc = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
  return { status: proc.status, stdout: proc.stdout ?? "", stderr: proc.stderr ?? "" };
}

test("media search lists candidates and applies kind/query/range/limit filters", () => {
  const wsDir = path.join(TEST_ROOT, "ws_search");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "search", aspect: "16:9", fps: 30 });
  installMediaFolder(wsDir);

  const all = searchMediaSource({
    workspaceDir: wsDir,
    provider: "ext:media-folder",
    kind: "music",
    query: "calm",
  });
  assert.equal(all.count, 1);
  assert.equal(all.candidates[0].id, "calm_piano.wav");
  assert.equal(all.candidates[0].title, "Calm Piano Bed");
  assert.equal(all.candidates[0].duration_ms, 30000);
  assert.equal(all.candidates[0].license, "CC-BY 4.0, attribution: Example Artist");
  assert.equal(all.candidates[0].source_url, "https://example.com/tracks/calm-piano");
  assert.deepEqual(all.candidates[0].tags, ["calm", "piano"]);

  const sfx = searchMediaSource({
    workspaceDir: wsDir,
    provider: "ext:media-folder",
    kind: "sfx",
    query: "riser",
  });
  assert.equal(sfx.count, 1);
  assert.equal(sfx.candidates[0].id, "riser_hit.wav");

  // Duration range excludes the 3s sfx.
  const ranged = searchMediaSource({
    workspaceDir: wsDir,
    provider: "ext:media-folder",
    kind: "sfx",
    query: "riser",
    minDurationMs: 5000,
    maxDurationMs: 60000,
  });
  assert.equal(ranged.count, 0);

  const limited = searchMediaSource({
    workspaceDir: wsDir,
    provider: "ext:media-folder",
    kind: "music",
    query: "wav",
    limit: 1,
  });
  assert.equal(limited.count, 1);
});

test("media fetch ingests aud_XX with source; brief detail and query show the license", () => {
  const wsDir = path.join(TEST_ROOT, "ws_fetch");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "fetch", aspect: "16:9", fps: 30 });
  installMediaFolder(wsDir);

  const fetched = fetchMediaSource({
    workspaceDir: wsDir,
    provider: "ext:media-folder",
    id: "calm_piano.wav",
  });
  assert.equal(fetched.cached, false);
  assert.match(fetched.asset.handle, /^aud_\d+$/);
  assert.equal(fetched.asset.probe.duration_ms, 30000);
  assert.equal(fetched.source.provider, "ext:media-folder");
  assert.equal(fetched.source.id, "calm_piano.wav");
  assert.equal(fetched.source.license, "CC-BY 4.0, attribution: Example Artist");

  const seq = loadSequence(wsDir).sequence;
  const item = seq.library.find((x) => x.handle === fetched.asset.handle);
  assert.equal(item?.source?.title, "Calm Piano Bed");

  // The source and license surface in `brief --lens detail`.
  const detail = renderSequenceBrief(seq, { lens: "detail", targetIds: [fetched.asset.handle] });
  assert.ok(detail.includes("ext:media-folder"));
  assert.ok(detail.includes("CC-BY 4.0"));

  // ... and in `library query` output.
  const analyzed = runCli(["library", "waveform", "--handle", fetched.asset.handle, "--dir", wsDir]);
  assert.equal(analyzed.status, 0, analyzed.stderr);
  const queried = runCli([
    "library",
    "query",
    "--handle",
    fetched.asset.handle,
    "--kind",
    "waveform",
    "--dir",
    wsDir,
  ]);
  assert.equal(queried.status, 0, queried.stderr);
  const envelope = JSON.parse(queried.stdout) as {
    asset_source?: { provider?: string; license?: string };
  };
  assert.equal(envelope.asset_source?.provider, "ext:media-folder");
  assert.equal(envelope.asset_source?.license, "CC-BY 4.0, attribution: Example Artist");

  // Refetching is idempotent: same asset, no new library item.
  const again = fetchMediaSource({
    workspaceDir: wsDir,
    provider: "ext:media-folder",
    id: "calm_piano.wav",
  });
  assert.equal(again.cached, true);
  assert.equal(again.asset.handle, fetched.asset.handle);
  assert.equal(loadSequence(wsDir).sequence.library.length, 1);
});

test("media fetch of an unknown id fails with CUTHOL-G236", () => {
  const wsDir = path.join(TEST_ROOT, "ws_fetch_missing");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "missing", aspect: "16:9", fps: 30 });
  installMediaFolder(wsDir);
  assert.throws(
    () => fetchMediaSource({ workspaceDir: wsDir, provider: "ext:media-folder", id: "nope.wav" }),
    (err: unknown) => err instanceof CutholError && err.diagnostic.code === "CUTHOL-G236"
  );
});

test("media search validates kind and ranges; missing capability is G231", () => {
  const wsDir = path.join(TEST_ROOT, "ws_search_invalid");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "invalid", aspect: "16:9", fps: 30 });
  installMediaFolder(wsDir);

  assert.throws(
    () =>
      searchMediaSource({ workspaceDir: wsDir, provider: "ext:media-folder", kind: "video", query: "x" }),
    (err: unknown) => err instanceof CutholError && err.diagnostic.code === "CUTHOL-G110"
  );
  assert.throws(
    () =>
      searchMediaSource({
        workspaceDir: wsDir,
        provider: "ext:media-folder",
        kind: "music",
        query: "x",
        minDurationMs: 60000,
        maxDurationMs: 1000,
      }),
    (err: unknown) => err instanceof CutholError && err.diagnostic.code === "CUTHOL-G110"
  );

  const dir = path.join(wsDir, ".cuthol", "extensions", "asr-only");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "cuthol-extension.json"),
    JSON.stringify({
      schema_version: "1.0.0",
      name: "asr-only",
      version: "1.0.0",
      description: "asr only",
      providers: { asr: { script: "a.cjs" } },
    }),
    "utf8"
  );
  fs.writeFileSync(path.join(dir, "a.cjs"), "process.exit(0);\n", "utf8");
  assert.throws(
    () =>
      searchMediaSource({ workspaceDir: wsDir, provider: "ext:asr-only", kind: "music", query: "x" }),
    (err: unknown) => err instanceof CutholError && err.diagnostic.code === "CUTHOL-G231"
  );
});

test("library search/fetch work over the CLI and MCP argv mapping", () => {
  const wsDir = path.join(TEST_ROOT, "ws_cli_mcp");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "cli", aspect: "16:9", fps: 30 });
  installMediaFolder(wsDir);

  const searched = runCli([
    "library",
    "search",
    "--provider",
    "ext:media-folder",
    "--kind",
    "sfx",
    "--query",
    "riser",
    "--dir",
    wsDir,
  ]);
  assert.equal(searched.status, 0, searched.stderr);
  const searchEnv = JSON.parse(searched.stdout) as { count?: number; candidates?: Array<{ id?: string }> };
  assert.equal(searchEnv.count, 1);
  assert.equal(searchEnv.candidates?.[0]?.id, "riser_hit.wav");

  // The MCP catalog maps to the same argv the CLI accepts.
  const searchSpec = findActionSpec("library", "search");
  assert.ok(searchSpec);
  const validated = validateActionArgs(searchSpec, {
    provider: "ext:media-folder",
    kind: "sfx",
    query: "riser",
    limit: 5,
  });
  assert.deepEqual(validated.issues, []);
  assert.deepEqual(
    buildCliArgv(searchSpec, validated.values, wsDir),
    ["library", "search", "--provider=ext:media-folder", "--kind=sfx", "--query=riser", "--limit=5", `--dir=${wsDir}`]
  );
  const fetchSpec = findActionSpec("library", "fetch");
  assert.ok(fetchSpec);
  const validatedFetch = validateActionArgs(fetchSpec, { provider: "ext:media-folder", id: "riser_hit.wav" });
  assert.deepEqual(validatedFetch.issues, []);
  assert.deepEqual(
    buildCliArgv(fetchSpec, validatedFetch.values, wsDir),
    ["library", "fetch", "--provider=ext:media-folder", "--id=riser_hit.wav", `--dir=${wsDir}`]
  );
});

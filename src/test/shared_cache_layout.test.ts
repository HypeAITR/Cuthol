/**
 * Shared cache and layout defaults (`src/test/shared_cache_layout.test.ts`).
 *
 * Covers:
 * 1. User-level content-addressed (SHA-256) shared cache for ASR transcripts and TTS voiceovers,
 *    environment variable redirection (`CUTHOL_CACHE_DIR`), offline cross-project cache hits without API keys,
 *    and cache disablement (`CUTHOL_CACHE_DIR=0` / `CUTHOL_DISABLE_SHARED_CACHE=1`) while keeping project cache intact.
 * 2. Stage-scaled vertical (9:16) vs landscape (16:9) default caption & title typography sizing,
 *    2-line wrapping discipline, and zero Safe Zone (`CUTHOL-G401`) violations.
 * 3. Suppression of Node.js `ExperimentalWarning: SQLite` on `cuthol mcp` / CLI stderr while preserving other warnings.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { resolveSharedCacheConfig } from "../core/env.js";
import {
  resolveDefaultCaptionFontSizePx,
  resolveDefaultLaneTypographyFontSizePx,
} from "../core/standards.js";
import { initWorkspace, loadSequence } from "../core/workspace.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { addLaneCue } from "../sequence/lanes.js";
import { appendSpineClip } from "../sequence/spine.js";
import { generateSequenceCaptions } from "../speech/captions.js";
import { synthesizeVoiceover } from "../speech/synthesize.js";
import { transcribeLibraryAsset } from "../speech/transcribe.js";
import { runWorkspaceVerification } from "../verify/gates.js";

const TEST_ROOT = path.resolve(process.cwd(), "test-workspace", "shared_cache_layout");

function createSyntheticTalkClip(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const proc = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=#1E293B:s=640x360:r=30:d=4",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=220:sample_rate=16000:duration=4",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      filePath,
    ],
    { encoding: "utf8" }
  );
  assert.equal(proc.status, 0, proc.stderr);
}

test("1. Shared content-addressed transcript & TTS cache across projects, env override, and disable flag", async () => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  const sharedCacheDir = path.join(TEST_ROOT, "shared_cache");
  const projA = path.join(TEST_ROOT, "proj_a");
  const projB = path.join(TEST_ROOT, "proj_b");
  const projDisabled = path.join(TEST_ROOT, "proj_disabled");
  const mediaFile = path.join(TEST_ROOT, "media", "shared_talk.mp4");
  createSyntheticTalkClip(mediaFile);

  const sidecarPath = `${mediaFile}.transcript.json`;
  fs.writeFileSync(
    sidecarPath,
    JSON.stringify({
      language: "tr",
      words: [
        { word: "Merhaba", punctuated_word: "Merhaba", source_start_ms: 100, source_end_ms: 500 },
        { word: "ortak", punctuated_word: "ortak", source_start_ms: 550, source_end_ms: 950 },
        { word: "önbellek", punctuated_word: "önbellek", source_start_ms: 1000, source_end_ms: 1500 },
        { word: "testi.", punctuated_word: "testi.", source_start_ms: 1600, source_end_ms: 2200 },
      ],
    }),
    "utf8"
  );

  const prevCacheDir = process.env.CUTHOL_CACHE_DIR;
  const prevDeepgramKey = process.env.DEEPGRAM_API_KEY;
  const prevElevenKey = process.env.ELEVENLABS_API_KEY;

  try {
    process.env.CUTHOL_CACHE_DIR = sharedCacheDir;
    const cfg = resolveSharedCacheConfig();
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.cacheDir, path.resolve(sharedCacheDir));

    // Project A: transcribe and synthesize (populates both project cache and user-level shared cache)
    initWorkspace({ dir: projA, title: "Project A", aspect: "9:16", fps: 30 });
    ingestAssetsIntoWorkspace({ workspaceDir: projA, filePaths: [mediaFile] });
    appendSpineClip({ workspaceDir: projA, assetHandle: "vid_01" });

    const trA = await transcribeLibraryAsset({
      workspaceDir: projA,
      handle: "vid_01",
      provider: "local",
      language: "tr",
    });
    assert.equal(trA.cached, false);
    assert.equal(trA.transcript.words.length, 4);

    const ttsA = await synthesizeVoiceover({
      workspaceDir: projA,
      text: "Ortak seslendirme önbelleği doğrulaması.",
      provider: "local",
      language: "tr",
    });
    assert.equal(ttsA.cached, false);

    assert.ok(fs.existsSync(path.join(sharedCacheDir, "ledger.sqlite")));

    // Remove sidecar and clear cloud API keys so Project B cannot re-transcribe or call cloud APIs
    fs.unlinkSync(sidecarPath);
    process.env.DEEPGRAM_API_KEY = "";
    process.env.ELEVENLABS_API_KEY = "";

    // Project B: ingest the same media file -> must hit shared cache (`cached: true`) without API keys
    initWorkspace({ dir: projB, title: "Project B", aspect: "16:9", fps: 30 });
    ingestAssetsIntoWorkspace({ workspaceDir: projB, filePaths: [mediaFile] });
    appendSpineClip({ workspaceDir: projB, assetHandle: "vid_01" });

    const trB = await transcribeLibraryAsset({
      workspaceDir: projB,
      handle: "vid_01",
      language: "tr",
    });
    assert.equal(trB.cached, true, "Second project must hit shared transcript cache");
    assert.equal(trB.transcript.words.length, 4);

    const ttsB = await synthesizeVoiceover({
      workspaceDir: projB,
      text: "Ortak seslendirme önbelleği doğrulaması.",
      provider: "local",
      language: "tr",
    });
    assert.equal(ttsB.cached, true, "Second project must hit shared TTS cache");
    assert.ok(
      fs.existsSync(path.join(projB, ttsB.asset.uri)),
      "Synthesized audio blob must be hydrated into Project B's local blobs directory"
    );

    // Disable shared cache via environment variable (`CUTHOL_CACHE_DIR=0`) -> Project C must not read shared cache,
    // but its own project-local cache must still work on a second call.
    process.env.CUTHOL_CACHE_DIR = "0";
    assert.equal(resolveSharedCacheConfig().enabled, false);

    fs.writeFileSync(
      sidecarPath,
      JSON.stringify({
        language: "tr",
        words: [
          { word: "Yerel", punctuated_word: "Yerel", source_start_ms: 100, source_end_ms: 600 },
          { word: "proje.", punctuated_word: "proje.", source_start_ms: 650, source_end_ms: 1200 },
        ],
      }),
      "utf8"
    );

    initWorkspace({ dir: projDisabled, title: "Project Disabled Shared Cache", aspect: "16:9", fps: 30 });
    ingestAssetsIntoWorkspace({ workspaceDir: projDisabled, filePaths: [mediaFile] });
    const trC1 = await transcribeLibraryAsset({
      workspaceDir: projDisabled,
      handle: "vid_01",
      provider: "local",
      language: "tr",
    });
    assert.equal(trC1.cached, false, "With shared cache disabled, first call in new project must not hit shared cache");
    const trC2 = await transcribeLibraryAsset({
      workspaceDir: projDisabled,
      handle: "vid_01",
      provider: "local",
      language: "tr",
    });
    assert.equal(trC2.cached, true, "Project-level cache must still work when shared cache is disabled");
  } finally {
    if (prevCacheDir === undefined) delete process.env.CUTHOL_CACHE_DIR;
    else process.env.CUTHOL_CACHE_DIR = prevCacheDir;
    if (prevDeepgramKey === undefined) delete process.env.DEEPGRAM_API_KEY;
    else process.env.DEEPGRAM_API_KEY = prevDeepgramKey;
    if (prevElevenKey === undefined) delete process.env.ELEVENLABS_API_KEY;
    else process.env.ELEVENLABS_API_KEY = prevElevenKey;
  }
});

test("2. Stage-scaled vertical (9:16) vs landscape (16:9) caption & title defaults and safe zone compliance", async () => {
  // Unit checks for stage-scaled font size helpers
  assert.equal(resolveDefaultCaptionFontSizePx({ width: 1920, height: 1080, aspect: "16:9" }), 42);
  assert.equal(resolveDefaultCaptionFontSizePx({ width: 1080, height: 1920, aspect: "9:16" }), 64);
  assert.equal(resolveDefaultCaptionFontSizePx({ width: 720, height: 1280, aspect: "9:16" }), 43);

  assert.equal(
    resolveDefaultLaneTypographyFontSizePx({ width: 1920, height: 1080, aspect: "16:9" }, "title"),
    56
  );
  assert.equal(
    resolveDefaultLaneTypographyFontSizePx({ width: 1920, height: 1080, aspect: "16:9" }, "caption"),
    44
  );
  assert.equal(
    resolveDefaultLaneTypographyFontSizePx({ width: 1080, height: 1920, aspect: "9:16" }, "title"),
    76
  );
  assert.equal(
    resolveDefaultLaneTypographyFontSizePx({ width: 1080, height: 1920, aspect: "9:16" }, "caption"),
    64
  );

  const vertDir = path.join(TEST_ROOT, "vert_9_16");
  const landDir = path.join(TEST_ROOT, "land_16_9");
  const mediaFile = path.join(TEST_ROOT, "media", "caption_talk.mp4");
  createSyntheticTalkClip(mediaFile);

  fs.writeFileSync(
    `${mediaFile}.transcript.json`,
    JSON.stringify({
      language: "tr",
      words: [
        { word: "Bugün", punctuated_word: "Bugün", source_start_ms: 100, source_end_ms: 420 },
        { word: "dikey", punctuated_word: "dikey", source_start_ms: 450, source_end_ms: 800 },
        { word: "video", punctuated_word: "video", source_start_ms: 830, source_end_ms: 1200 },
        { word: "altyazı", punctuated_word: "altyazı", source_start_ms: 1250, source_end_ms: 1700 },
        { word: "boyutunu", punctuated_word: "boyutunu", source_start_ms: 1750, source_end_ms: 2300 },
        { word: "inceliyoruz.", punctuated_word: "inceliyoruz.", source_start_ms: 2350, source_end_ms: 3100 },
      ],
    }),
    "utf8"
  );

  // Vertical 9:16 workspace
  initWorkspace({ dir: vertDir, title: "Vertical 9:16", aspect: "9:16", fps: 30 });
  ingestAssetsIntoWorkspace({ workspaceDir: vertDir, filePaths: [mediaFile] });
  appendSpineClip({ workspaceDir: vertDir, assetHandle: "vid_01" });
  await transcribeLibraryAsset({ workspaceDir: vertDir, handle: "vid_01", provider: "local", language: "tr" });

  const vertCaps = generateSequenceCaptions({ workspaceDir: vertDir, language: "tr" });
  assert.ok(vertCaps.cues_created >= 2);
  for (const cue of vertCaps.cues) {
    assert.equal(cue.typography?.font_size_px, 64);
    assert.equal(cue.typography?.max_width_pct, 70);
  }
  const vertTitle = addLaneCue({
    workspaceDir: vertDir,
    laneId: "ln_titles",
    kind: "title",
    atMs: 200,
    durationMs: 1500,
    yPct: -28,
    text: "Dikey Başlık",
  });
  assert.equal(vertTitle.cue.typography?.font_size_px, 76);

  const vertVerify = runWorkspaceVerification(vertDir);
  const safeZoneWarnings = vertVerify.diagnostics.filter((d) => d.code === "CUTHOL-G401");
  assert.equal(safeZoneWarnings.length, 0, "Vertical 9:16 captions and titles must stay within safe zones");

  // Landscape 16:9 workspace
  initWorkspace({ dir: landDir, title: "Landscape 16:9", aspect: "16:9", fps: 30 });
  ingestAssetsIntoWorkspace({ workspaceDir: landDir, filePaths: [mediaFile] });
  appendSpineClip({ workspaceDir: landDir, assetHandle: "vid_01" });
  await transcribeLibraryAsset({ workspaceDir: landDir, handle: "vid_01", provider: "local", language: "tr" });

  const landCaps = generateSequenceCaptions({ workspaceDir: landDir, language: "tr" });
  assert.ok(landCaps.cues_created >= 1);
  assert.equal(landCaps.cues[0].typography?.font_size_px, 42);
  assert.equal(landCaps.cues[0].typography?.max_width_pct, 80);

  const landTitle = addLaneCue({
    workspaceDir: landDir,
    laneId: "ln_titles",
    kind: "title",
    atMs: 200,
    durationMs: 1500,
    yPct: -25,
    text: "Yatay Başlık",
  });
  assert.equal(landTitle.cue.typography?.font_size_px, 56);
  assert.equal(loadSequence(landDir).sequence.stage.aspect, "16:9");
});

test("3. MCP stdio server and CLI suppress SQLite ExperimentalWarning on stderr while preserving other warnings", () => {
  const wsDir = path.join(TEST_ROOT, "mcp_quiet_ws");
  initWorkspace({ dir: wsDir, title: "Quiet MCP", aspect: "16:9", fps: 30 });

  const cliPath = path.resolve(process.cwd(), "dist", "cli.js");
  const rpcInput =
    [
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "verify", arguments: { dir: wsDir } },
      }),
    ].join("\n") + "\n";

  const mcpRun = spawnSync(process.execPath, [cliPath, "mcp"], {
    input: rpcInput,
    encoding: "utf8",
  });
  assert.equal(mcpRun.status, 0);
  assert.equal(mcpRun.stderr.trim(), "", "MCP server stderr must be completely free of ExperimentalWarning: SQLite");

  // Non-SQLite warnings must still be emitted to stderr
  const warnCheck = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "import './dist/library/ledger.js'; process.emitWarning('Visible custom warning', 'CustomWarning');",
    ],
    { encoding: "utf8" }
  );
  assert.equal(warnCheck.status, 0);
  assert.ok(!warnCheck.stderr.includes("SQLite"), "SQLite warning must remain suppressed");
  assert.ok(warnCheck.stderr.includes("Visible custom warning"), "Other process warnings must still appear");
});

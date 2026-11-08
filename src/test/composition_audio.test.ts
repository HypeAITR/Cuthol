import "./test_setup.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { renderSequenceBrief } from "../brief/inspector.js";
import { compileSequenceRenderPlan } from "../compositor/compiler.js";
import {
  CompositionAudioAdapter,
  compositionAudioRequestForCue,
  ensureCompositionStem,
  readCompositionStemState,
  resolveCompositionAudioMode,
} from "../compositor/composition_audio.js";
import {
  hyperFramesCompositionAudioAdapter,
  readCompositionAudioHfStats,
  resetCompositionAudioHfStats,
} from "../compositor/composition_audio_hf.js";
import { initWorkspace, loadSequence } from "../core/workspace.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { duckMusicUnderDialogue } from "../mix/mix_duck.js";
import { normalizeSequenceAudio } from "../mix/mix_normalize.js";
import { buildOrRenderSequenceAudioForMixOrRender } from "../render/renderer.js";
import { addLaneCue, updateLaneCue } from "../sequence/lanes.js";
import { verifySequence } from "../verify/gates.js";

const CLI = path.resolve(process.cwd(), "dist/cli.js");
const GSAP_MIN_JS = path.resolve("node_modules/gsap/dist/gsap.min.js");
const FRAME_MS_30FPS = 1000 / 30;

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function safeRm(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore cleanup error
  }
}

function runFfmpeg(args: string[], cwd?: string): string {
  const proc = spawnSync("ffmpeg", args, { encoding: "utf8", timeout: 120_000, cwd });
  assert.equal(proc.status, 0, `ffmpeg failed: ${args.join(" ")}\n${proc.stderr}`);
  return String(proc.stderr ?? "");
}

/** Short tone burst (a "click") written with ffmpeg lavfi. */
function writeClickWav(outPath: string, freq = 880, seconds = 0.2): void {
  runFfmpeg([
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=${freq}:duration=${seconds}:sample_rate=48000`,
    "-c:a",
    "pcm_s16le",
    outPath,
  ]);
}

function writeToneWav(outPath: string, seconds: number, freq = 880): void {
  runFfmpeg([
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=${freq}:duration=${seconds}:sample_rate=48000`,
    "-c:a",
    "pcm_s16le",
    outPath,
  ]);
}

function compHtml(bodyInner: string, durationSec = 3): string {
  return `<!doctype html>
<html>
<head><meta charset="UTF-8" /></head>
<body>
<div id="root" data-composition-id="main" data-width="320" data-height="180" data-fps="30" data-duration="${durationSec}">
  <div id="box" class="clip" data-start="0" data-duration="${durationSec}" style="position:absolute;left:10px;top:10px;width:60px;height:60px;background:#ff0000;"></div>
${bodyInner}
</div>
<script src="assets/gsap.min.js"></script>
<script>
  window.__timelines = window.__timelines || {};
  const tl = gsap.timeline({ paused: true });
  tl.to("#box", { x: 100, duration: ${durationSec}, ease: "none" }, 0);
  window.__timelines["main"] = tl;
</script>
</body>
</html>
`;
}

function writeCompAudioFixture(compDir: string, bodyInner: string, durationSec = 3): void {
  fs.rmSync(compDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(compDir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(compDir, "index.html"), compHtml(bodyInner, durationSec), "utf8");
  assert.ok(fs.existsSync(GSAP_MIN_JS), "gsap missing");
  fs.copyFileSync(GSAP_MIN_JS, path.join(compDir, "assets/gsap.min.js"));
}

function initSmallWorkspace(title: string): string {
  const tmp = makeTempDir("cuthol-compaudio-");
  const wsDir = path.join(tmp, "ws");
  initWorkspace({ dir: wsDir, title, aspect: "16:9", fps: 30 });
  const seqPath = path.join(wsDir, "cuthol.sequence.json");
  const seqInit = JSON.parse(fs.readFileSync(seqPath, "utf8"));
  seqInit.stage.width = 320;
  seqInit.stage.height = 180;
  fs.writeFileSync(seqPath, JSON.stringify(seqInit, null, 2), "utf8");
  return wsDir;
}

function mountAudioComp(wsDir: string, compName: string, bodyInner: string, opts?: { atMs?: number; durationMs?: number; laneId?: string; transparent?: boolean }): string {
  const compDir = path.join(wsDir, "compositions", compName);
  writeCompAudioFixture(compDir, bodyInner, (opts?.durationMs ?? 3000) / 1000);
  const res = addLaneCue({
    workspaceDir: wsDir,
    laneId: opts?.laneId ?? "ln_motion",
    kind: "composition",
    atMs: opts?.atMs ?? 0,
    durationMs: opts?.durationMs ?? 3000,
    composition: {
      composition_dir: `compositions/${compName}`,
      entry_html: "index.html",
      props: {},
      transparent: opts?.transparent ?? true,
    },
  });
  return res.cue.id;
}

/** Renders the sequence mix (audio only) through the shared compiler to a wav file. */
function renderSequenceAudioToWav(wsDir: string, outWav: string, expectActiveAudio = true): void {
  const { sequence, paths } = loadSequence(wsDir);
  const build = buildOrRenderSequenceAudioForMixOrRender(sequence, paths, sequence.stage.master_audio);
  assert.equal(build.mode, "direct_plan", "tiny test mix must take the direct plan path");
  assert.ok(build.directPlan, "direct plan missing");
  const plan = build.directPlan!;
  assert.equal(plan.hasActiveAudio, expectActiveAudio, `hasActiveAudio must be ${expectActiveAudio}`);
  runFfmpeg(
    [
      "-y",
      "-v",
      "error",
      ...plan.inputArgs,
      "-filter_complex",
      plan.filterComplex,
      "-map",
      plan.audioOutPad,
      "-c:a",
      "pcm_s16le",
      "-ar",
      "48000",
      "-ac",
      "2",
      outWav,
    ],
    paths.rootDir
  );
}

function measureRmsDb(wavPath: string, startSec?: number, durSec?: number): number {
  const args = ["-hide_banner"];
  if (startSec !== undefined) args.push("-ss", String(startSec));
  if (durSec !== undefined) args.push("-t", String(durSec));
  args.push("-i", wavPath, "-af", "astats=metadata=1:reset=0", "-f", "null", "-");
  const proc = spawnSync("ffmpeg", args, { encoding: "utf8", timeout: 60_000 });
  assert.equal(proc.status, 0, `astats failed: ${proc.stderr}`);
  const text = String(proc.stderr ?? "");
  if (/RMS level dB:\s*-inf/.test(text)) return Number.NEGATIVE_INFINITY;
  const m = /RMS level dB:\s*(-?\d+(?:\.\d+)?)/.exec(text);
  assert.ok(m, `no RMS level in astats output for ${wavPath}`);
  return Number(m[1]);
}

/** First audible boundaries from silencedetect (seconds). */
function silenceBoundaries(wavPath: string): { silenceEnds: number[]; silenceStarts: number[] } {
  const proc = spawnSync(
    "ffmpeg",
    ["-v", "info", "-i", wavPath, "-af", "silencedetect=noise=-40dB:d=0.1", "-f", "null", "-"],
    { encoding: "utf8", timeout: 60_000 }
  );
  assert.equal(proc.status, 0, `silencedetect failed: ${proc.stderr}`);
  const text = String(proc.stderr ?? "");
  const silenceEnds: number[] = [];
  const silenceStarts: number[] = [];
  for (const m of text.matchAll(/silence_end:\s*([\d.]+)/g)) silenceEnds.push(Number(m[1]));
  for (const m of text.matchAll(/silence_start:\s*([\d.]+)/g)) silenceStarts.push(Number(m[1]));
  return { silenceEnds, silenceStarts };
}

function sha256File(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function setCueFieldDirect(wsDir: string, cueId: string, patch: Record<string, unknown>): void {
  const { sequence, paths } = loadSequence(wsDir);
  const cue = sequence.lanes.flatMap((l) => l.cues).find((c) => c.id === cueId);
  assert.ok(cue, `cue ${cueId} missing`);
  Object.assign(cue, patch);
  sequence.meta.revision += 1;
  fs.writeFileSync(paths.sequenceFile, JSON.stringify(sequence, null, 2), "utf8");
}

function runCli(wsDir: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const proc = spawnSync(process.execPath, [CLI, ...args, "--dir", wsDir], {
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  return { status: proc.status, stdout: String(proc.stdout ?? ""), stderr: String(proc.stderr ?? "") };
}

test("1. composition_audio defaults to mix; G1 rejects bad values and non-composition cues", () => {
  const wsDir = initSmallWorkspace("compaudio-g1");
  try {
    assert.equal(resolveCompositionAudioMode({}), "mix");
    assert.equal(resolveCompositionAudioMode({ composition_audio: "off" }), "off");

    const cueId = mountAudioComp(
      wsDir,
      "aud",
      '  <audio id="tone" src="assets/tone.wav" data-start="0" data-duration="1"></audio>'
    );
    writeToneWav(path.join(wsDir, "compositions/aud/assets/tone.wav"), 1);

    // Default (absent) passes G1.
    let rep = verifySequence(loadSequence(wsDir).sequence, loadSequence(wsDir).paths, ["G1_SCHEMA"]);
    assert.deepEqual(
      rep.diagnostics.filter((d) => d.code === "CUTHOL-G437"),
      []
    );

    // Invalid value fails G1.
    setCueFieldDirect(wsDir, cueId, { composition_audio: "loud" });
    rep = verifySequence(loadSequence(wsDir).sequence, loadSequence(wsDir).paths, ["G1_SCHEMA"]);
    const bad = rep.diagnostics.filter((d) => d.code === "CUTHOL-G437");
    assert.equal(bad.length, 1);
    assert.equal(bad[0].severity, "ERROR");
    assert.match(bad[0].what, /'loud'/);

    // Valid value passes; setting it on a non-composition cue fails.
    setCueFieldDirect(wsDir, cueId, { composition_audio: "off" });
    rep = verifySequence(loadSequence(wsDir).sequence, loadSequence(wsDir).paths, ["G1_SCHEMA"]);
    assert.deepEqual(
      rep.diagnostics.filter((d) => d.code === "CUTHOL-G437"),
      []
    );
    const titleRes = addLaneCue({
      workspaceDir: wsDir,
      laneId: "ln_titles",
      kind: "title",
      atMs: 0,
      durationMs: 1000,
      text: "hello",
    });
    setCueFieldDirect(wsDir, titleRes.cue.id, { composition_audio: "mix" });
    rep = verifySequence(loadSequence(wsDir).sequence, loadSequence(wsDir).paths, ["G1_SCHEMA"]);
    const misplaced = rep.diagnostics.filter((d) => d.code === "CUTHOL-G437");
    assert.equal(misplaced.length, 1);
    assert.match(misplaced[0].what, /non-composition/);
  } finally {
    safeRm(path.dirname(wsDir));
  }
});

test("2. stem lifecycle: pending warns, extracted stem is INFO with ms, off is INFO", () => {
  const wsDir = initSmallWorkspace("compaudio-life");
  try {
    const cueId = mountAudioComp(
      wsDir,
      "aud",
      '  <audio id="tone" src="assets/tone.wav" data-start="0" data-duration="1"></audio>'
    );
    writeToneWav(path.join(wsDir, "compositions/aud/assets/tone.wav"), 1);

    // Pending (never rendered): G416 still warns that the sound is not in the mix.
    let loaded = loadSequence(wsDir);
    let rep = verifySequence(loaded.sequence, loaded.paths, ["G4_STAGE"]);
    let found = rep.diagnostics.filter((d) => d.code === "CUTHOL-G416");
    assert.equal(found.length, 1);
    assert.equal(found[0].severity, "WARN");

    // Extract the stem (dedicated audio render; no overlay blob exists yet).
    resetCompositionAudioHfStats();
    loaded = loadSequence(wsDir);
    const cue = loaded.sequence.lanes.flatMap((l) => l.cues).find((c) => c.id === cueId)!;
    const request = compositionAudioRequestForCue(cue, loaded.paths, {
      fps: loaded.sequence.stage.fps,
      width: loaded.sequence.stage.width,
      height: loaded.sequence.stage.height,
    })!;
    const stem = ensureCompositionStem(cue, request, hyperFramesCompositionAudioAdapter);
    assert.ok(stem, "stem must be extracted");
    assert.ok(fs.existsSync(stem.stemPath), "stem wav must exist on disk");
    assert.ok(stem.stemDurationMs >= 2990 && stem.stemDurationMs <= 3050, `stem duration ${stem.stemDurationMs}ms`);
    const stats = readCompositionAudioHfStats();
    assert.equal(stats.dedicatedRenders, 1);
    assert.equal(stats.blobReuse, 0);
    const state = readCompositionStemState(cue, request, hyperFramesCompositionAudioAdapter);
    assert.equal(state.kind, "mixed");

    // Mixed: G416 is INFO and names the cue, the ms of audio and the off switch.
    loaded = loadSequence(wsDir);
    rep = verifySequence(loaded.sequence, loaded.paths, ["G4_STAGE"]);
    found = rep.diagnostics.filter((d) => d.code === "CUTHOL-G416");
    assert.equal(found.length, 1);
    assert.equal(found[0].severity, "INFO");
    assert.match(found[0].what, new RegExp(`${cueId}.*${stem.stemDurationMs}ms`));
    assert.match(found[0].suggestion, /--composition-audio off/);

    // Off: G416 is INFO with the old meaning (stays out) and the on switch.
    setCueFieldDirect(wsDir, cueId, { composition_audio: "off" });
    loaded = loadSequence(wsDir);
    rep = verifySequence(loaded.sequence, loaded.paths, ["G4_STAGE"]);
    found = rep.diagnostics.filter((d) => d.code === "CUTHOL-G416");
    assert.equal(found.length, 1);
    assert.equal(found[0].severity, "INFO");
    assert.match(found[0].what, /stays out/);
    assert.match(found[0].suggestion, /--composition-audio mix/);
  } finally {
    safeRm(path.dirname(wsDir));
  }
});

test("3. click lands at cue start + composition time within one frame", () => {
  const wsDir = initSmallWorkspace("compaudio-time");
  try {
    // 200ms click at composition-local 1000ms; cue starts at 500ms => click at 1500ms.
    const cueId = mountAudioComp(
      wsDir,
      "click",
      '  <audio id="click" src="assets/click.wav" data-start="1" data-duration="0.2"></audio>',
      { atMs: 500, durationMs: 3000 }
    );
    void cueId;
    writeClickWav(path.join(wsDir, "compositions/click/assets/click.wav"), 880, 0.2);

    const outWav = path.join(path.dirname(wsDir), "mix.wav");
    renderSequenceAudioToWav(wsDir, outWav);
    const { silenceEnds, silenceStarts } = silenceBoundaries(outWav);
    // First audible region must start at 1500ms and end at 1700ms (+-1 frame).
    const startsAudible = silenceEnds.find((t) => t > 0.2) ?? -1;
    const endsAudible = silenceStarts.find((t) => t > startsAudible) ?? -1;
    assert.ok(
      Math.abs(startsAudible - 1.5) < FRAME_MS_30FPS / 1000 + 0.002,
      `click starts at ${startsAudible}s, want 1.5s +-1 frame`
    );
    assert.ok(
      Math.abs(endsAudible - 1.7) < FRAME_MS_30FPS / 1000 + 0.002,
      `click ends at ${endsAudible}s, want 1.7s +-1 frame`
    );
  } finally {
    safeRm(path.dirname(wsDir));
  }
});

test("4. cue gain -6dB attenuates the stem; off removes its sound", () => {
  const wsDir = initSmallWorkspace("compaudio-gain");
  try {
    mountAudioComp(
      wsDir,
      "tone",
      '  <audio id="tone" src="assets/tone.wav" data-start="1" data-duration="1"></audio>',
      { atMs: 0, durationMs: 3000 }
    );
    writeToneWav(path.join(wsDir, "compositions/tone/assets/tone.wav"), 1);
    const cueId = loadSequence(wsDir).sequence.lanes.flatMap((l) => l.cues).find((c) => c.kind === "composition")!.id;

    const baseWav = path.join(path.dirname(wsDir), "base.wav");
    renderSequenceAudioToWav(wsDir, baseWav);
    const baseRms = measureRmsDb(baseWav, 1.1, 0.8);

    updateLaneCue({ workspaceDir: wsDir, cueId, gainDb: -6 });
    const cutWav = path.join(path.dirname(wsDir), "cut.wav");
    renderSequenceAudioToWav(wsDir, cutWav);
    const cutRms = measureRmsDb(cutWav, 1.1, 0.8);
    const delta = cutRms - baseRms;
    assert.ok(delta > -6.6 && delta < -5.4, `gain -6dB must cut the stem ~6dB, got ${delta.toFixed(2)}dB`);

    setCueFieldDirect(wsDir, cueId, { composition_audio: "off" });
    const offWav = path.join(path.dirname(wsDir), "off.wav");
    renderSequenceAudioToWav(wsDir, offWav, false);
    const offRms = measureRmsDb(offWav, 1.1, 0.8);
    assert.ok(offRms < -70, `off must remove the stem sound, window RMS is ${offRms}dB`);
  } finally {
    safeRm(path.dirname(wsDir));
  }
});

test("5. silent composition: no stem, render plan carries no audio additions", () => {
  const wsDir = initSmallWorkspace("compaudio-silent");
  try {
    const cueId = mountAudioComp(wsDir, "quiet", "  <!-- no audio elements -->");
    void cueId;
    const loaded = loadSequence(wsDir);
    const dumpPlan = (): string => {
      const plan = compileSequenceRenderPlan(loaded.sequence, loaded.paths, "draft_480p");
      return JSON.stringify({
        inputArgs: plan.inputArgs,
        filterComplex: plan.filterComplex,
        videoOutPad: plan.videoOutPad,
        audioOutPad: plan.audioOutPad,
        totalDurationMs: plan.totalDurationMs,
      });
    };
    resetCompositionAudioHfStats();
    const before = dumpPlan();
    assert.ok(!before.includes("a_comp"), "silent plan must not mention stem pads");
    assert.ok(!before.includes("compaudio_"), "silent plan must not mention stem files");
    const blobs = fs.existsSync(loaded.paths.blobsDir) ? fs.readdirSync(loaded.paths.blobsDir) : [];
    assert.ok(
      blobs.every((n) => !n.startsWith("compaudio_")),
      `no stem cache files for silent comps, found: ${blobs.filter((n) => n.startsWith("compaudio_")).join(",")}`
    );
    const stats = readCompositionAudioHfStats();
    assert.equal(stats.dedicatedRenders, 0);
    assert.equal(stats.blobReuse, 0);
    // Deterministic: compiling again yields the identical plan text.
    assert.equal(dumpPlan(), before);
  } finally {
    safeRm(path.dirname(wsDir));
  }
});

test("6. stem cache: unchanged composition reuses, edited composition regenerates", () => {
  const wsDir = initSmallWorkspace("compaudio-cache");
  try {
    const cueId = mountAudioComp(
      wsDir,
      "aud",
      '  <audio id="tone" src="assets/tone.wav" data-start="0" data-duration="1"></audio>'
    );
    writeToneWav(path.join(wsDir, "compositions/aud/assets/tone.wav"), 1);
    const resolveCurrent = () => {
      const loaded = loadSequence(wsDir);
      const cue = loaded.sequence.lanes.flatMap((l) => l.cues).find((c) => c.id === cueId)!;
      const request = compositionAudioRequestForCue(cue, loaded.paths, {
        fps: loaded.sequence.stage.fps,
        width: loaded.sequence.stage.width,
        height: loaded.sequence.stage.height,
      })!;
      return { cue, request };
    };

    resetCompositionAudioHfStats();
    let { cue, request } = resolveCurrent();
    const first = ensureCompositionStem(cue, request, hyperFramesCompositionAudioAdapter)!;
    assert.ok(first, "first ensure must extract");
    assert.equal(readCompositionAudioHfStats().dedicatedRenders, 1);
    const firstMtime = fs.statSync(first.stemPath).mtimeMs;
    const firstBytes = sha256File(first.stemPath);

    // Unchanged: same file, untouched mtime, no new render.
    ({ cue, request } = resolveCurrent());
    const second = ensureCompositionStem(cue, request, hyperFramesCompositionAudioAdapter)!;
    assert.ok(second, "second ensure must reuse");
    assert.equal(second.stemPath, first.stemPath);
    assert.equal(fs.statSync(second.stemPath).mtimeMs, firstMtime);
    assert.equal(sha256File(second.stemPath), firstBytes);
    assert.equal(readCompositionAudioHfStats().dedicatedRenders, 1);

    // Edited composition: new key, new stem file, one more render.
    fs.appendFileSync(path.join(wsDir, "compositions/aud/index.html"), "\n<!-- v2 -->\n", "utf8");
    ({ cue, request } = resolveCurrent());
    const third = ensureCompositionStem(cue, request, hyperFramesCompositionAudioAdapter)!;
    assert.ok(third, "third ensure must regenerate");
    assert.notEqual(third.stemPath, first.stemPath);
    assert.ok(fs.existsSync(first.stemPath), "old cached stem stays until cache eviction");
    assert.equal(readCompositionAudioHfStats().dedicatedRenders, 2);
  } finally {
    safeRm(path.dirname(wsDir));
  }
});

test("7. stem matches a standalone engine render sample-for-sample (group, automation, fx)", () => {
  const wsDir = initSmallWorkspace("compaudio-fx");
  try {
    mountAudioComp(
      wsDir,
      "fx",
      [
        '  <hf-audio-group id="sfx" data-volume="0.5"></hf-audio-group>',
        '  <audio id="a1" src="assets/tone.wav" data-start="0" data-duration="1" data-audio-group="sfx"></audio>',
        `  <audio id="a2" src="assets/tone.wav" data-start="1" data-duration="1" data-volume="0.5" data-automation='{"version":1,"lanes":[{"target":"volume","points":[{"t":0,"v":1},{"t":1,"v":0}]}]}'></audio>`,
        '  <audio id="a3" src="assets/tone.wav" data-start="2" data-duration="1" data-fx-chain="{&quot;version&quot;:1,&quot;nodes&quot;:[{&quot;type&quot;:&quot;gain&quot;,&quot;id&quot;:&quot;n1&quot;,&quot;params&quot;:{&quot;gain&quot;:-6}}]}"></audio>',
      ].join("\n")
    );
    const tonePath = path.join(wsDir, "compositions/fx/assets/tone.wav");
    writeToneWav(tonePath, 1);
    const baselineRms = measureRmsDb(tonePath);

    // Standalone engine render (full quality) and its audio track.
    const hfBin = path.resolve("node_modules/hyperframes/bin/hyperframes.mjs");
    const standaloneMp4 = path.join(path.dirname(wsDir), "standalone.mp4");
    const hfProc = spawnSync(
      process.execPath,
      [hfBin, "render", path.join(wsDir, "compositions/fx"), "--format", "mp4", "--quality", "looks", "--workers", "2", "--output", standaloneMp4],
      { encoding: "utf8", timeout: 240_000, maxBuffer: 64 * 1024 * 1024 }
    );
    assert.equal(hfProc.status, 0, `standalone render failed: ${hfProc.stderr}`);
    const standaloneWav = path.join(path.dirname(wsDir), "standalone.wav");
    runFfmpeg(["-y", "-v", "error", "-i", standaloneMp4, "-vn", "-c:a", "pcm_s16le", standaloneWav]);

    // Cuthol stem (draft audio render under the hood).
    const loaded = loadSequence(wsDir);
    const cue = loaded.sequence.lanes.flatMap((l) => l.cues).find((c) => c.kind === "composition")!;
    const request = compositionAudioRequestForCue(cue, loaded.paths, {
      fps: loaded.sequence.stage.fps,
      width: loaded.sequence.stage.width,
      height: loaded.sequence.stage.height,
    })!;
    const stem = ensureCompositionStem(cue, request, hyperFramesCompositionAudioAdapter)!;
    assert.ok(stem, "stem must be extracted");

    // Sample-for-sample identity with the standalone engine mix.
    assert.equal(
      sha256File(stem.stemPath),
      sha256File(standaloneWav),
      "stem must equal the standalone engine render audio"
    );

    // Engine mix fidelity pins: group bus -6.02dB, fx gain -6dB, volume fade exact.
    const seg0 = measureRmsDb(stem.stemPath, 0.05, 0.9);
    const seg1 = measureRmsDb(stem.stemPath, 1.0, 1.0);
    const seg2 = measureRmsDb(stem.stemPath, 2.05, 0.9);
    assert.ok(Math.abs(seg0 - (baselineRms - 6.02)) < 0.4, `group bus level ${seg0}dB`);
    assert.ok(Math.abs(seg2 - (baselineRms - 6.02)) < 0.4, `fx gain level ${seg2}dB`);
    assert.ok(
      Math.abs(seg1 - (baselineRms - 6.02 - 4.77)) < 0.6,
      `automation fade level ${seg1}dB`
    );
  } finally {
    safeRm(path.dirname(wsDir));
  }
});

test("8. opaque overlay blob supplies the stem without a dedicated render", async () => {
  const wsDir = initSmallWorkspace("compaudio-blob");
  try {
    const cueId = mountAudioComp(
      wsDir,
      "opaque",
      '  <audio id="tone" src="assets/tone.wav" data-start="0" data-duration="1"></audio>'
    );
    writeToneWav(path.join(wsDir, "compositions/opaque/assets/tone.wav"), 1);
    const loaded = loadSequence(wsDir);
    const cue = loaded.sequence.lanes.flatMap((l) => l.cues).find((c) => c.id === cueId)!;

    // Render the overlay blob exactly as the video path would for an opaque cue.
    const { renderHyperFramesCompositionToMp4 } = await import("../compositor/hyperframes_bridge.js");
    const blob = renderHyperFramesCompositionToMp4({
      compositionDir: path.join(wsDir, "compositions/opaque"),
      entryHtml: "index.html",
      blobsDir: loaded.paths.blobsDir,
      width: 320,
      height: 180,
      fps: 30,
      durationMs: cue.duration_ms,
      props: {},
      transparent: false,
      mode: "overlay_alpha",
      opaqueBackdropColor: loaded.sequence.stage.backdrop.color,
    });
    assert.ok(blob.endsWith(".mp4"), `opaque overlay must be mp4, got ${blob}`);

    resetCompositionAudioHfStats();
    const request = compositionAudioRequestForCue(cue, loaded.paths, {
      fps: loaded.sequence.stage.fps,
      width: loaded.sequence.stage.width,
      height: loaded.sequence.stage.height,
    })!;
    const stem = ensureCompositionStem(cue, request, hyperFramesCompositionAudioAdapter)!;
    assert.ok(stem, "stem must be extracted from the blob");
    const stats = readCompositionAudioHfStats();
    assert.equal(stats.blobReuse, 1);
    assert.equal(stats.dedicatedRenders, 0);

    // The stem is exactly the blob's audio track.
    const manualWav = path.join(path.dirname(wsDir), "manual.wav");
    runFfmpeg(["-y", "-v", "error", "-i", blob, "-vn", "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2", manualWav]);
    assert.equal(sha256File(stem.stemPath), sha256File(manualWav));
  } finally {
    safeRm(path.dirname(wsDir));
  }
});

test("9. CLI switch is journaled and undoable; bad values fail", () => {
  const wsDir = initSmallWorkspace("compaudio-cli");
  try {
    const cueId = mountAudioComp(
      wsDir,
      "aud",
      '  <audio id="tone" src="assets/tone.wav" data-start="0" data-duration="1"></audio>'
    );
    const readMode = () =>
      loadSequence(wsDir).sequence.lanes.flatMap((l) => l.cues).find((c) => c.id === cueId)!
        .composition_audio;

    const off = runCli(wsDir, ["lane", "update-cue", "--cue", cueId, "--composition-audio", "off"]);
    assert.equal(off.status, 0, `update-cue off failed: ${off.stdout}\n${off.stderr}`);
    assert.equal(readMode(), "off");

    const undo = runCli(wsDir, ["workspace", "journal", "undo"]);
    assert.equal(undo.status, 0, `journal undo failed: ${undo.stdout}\n${undo.stderr}`);
    assert.equal(readMode(), undefined);

    const bad = runCli(wsDir, ["lane", "update-cue", "--cue", cueId, "--composition-audio", "loud"]);
    assert.notEqual(bad.status, 0, "invalid mode must fail");
    assert.match(`${bad.stdout}\n${bad.stderr}`, /CUTHOL-G437/);
    assert.equal(readMode(), undefined);
  } finally {
    safeRm(path.dirname(wsDir));
  }
});

test("10. flow lens shows the per-cue composition audio switch", () => {
  const wsDir = initSmallWorkspace("compaudio-brief");
  try {
    const cueId = mountAudioComp(
      wsDir,
      "aud",
      '  <audio id="tone" src="assets/tone.wav" data-start="0" data-duration="1"></audio>'
    );
    let md = renderSequenceBrief(loadSequence(wsDir).sequence, { lens: "flow" });
    assert.match(md, new RegExp(`\`${cueId}\`.*comp-audio: mix`));
    setCueFieldDirect(wsDir, cueId, { composition_audio: "off" });
    md = renderSequenceBrief(loadSequence(wsDir).sequence, { lens: "flow" });
    assert.match(md, new RegExp(`\`${cueId}\`.*comp-audio: off`));
  } finally {
    safeRm(path.dirname(wsDir));
  }
});

test("11. normalize pre-gains a cached stem and measures it in the mix", () => {
  const wsDir = initSmallWorkspace("compaudio-norm");
  try {
    const cueId = mountAudioComp(
      wsDir,
      "aud",
      '  <audio id="tone" src="assets/tone.wav" data-start="0" data-duration="3"></audio>'
    );
    writeToneWav(path.join(wsDir, "compositions/aud/assets/tone.wav"), 3);
    // Cache the stem first (normalize itself never renders).
    const loaded = loadSequence(wsDir);
    const cue = loaded.sequence.lanes.flatMap((l) => l.cues).find((c) => c.id === cueId)!;
    const request = compositionAudioRequestForCue(cue, loaded.paths, {
      fps: loaded.sequence.stage.fps,
      width: loaded.sequence.stage.width,
      height: loaded.sequence.stage.height,
    })!;
    assert.ok(ensureCompositionStem(cue, request, hyperFramesCompositionAudioAdapter));

    const res = normalizeSequenceAudio({ workspaceDir: wsDir, clipIds: [cueId], targetLufs: -16 });
    const entry = res.adjusted_clips.find((c) => c.id === cueId);
    assert.ok(entry, "stem cue must be pre-gained by normalize");
    assert.ok(
      entry.applied_gain_db > 0 && entry.applied_gain_db <= 24,
      `quiet tone needs positive gain, got ${entry.applied_gain_db}dB`
    );
    // The closed-loop mix measurement hears the stem (not silence).
    assert.ok(
      res.measured_mix_before_lufs > -60,
      `mix measurement must include the stem, got ${res.measured_mix_before_lufs} LUFS`
    );
    const after = loadSequence(wsDir).sequence.lanes.flatMap((l) => l.cues).find((c) => c.id === cueId)!;
    assert.equal(after.audio_chain?.gain_db, entry.applied_gain_db);
  } finally {
    safeRm(path.dirname(wsDir));
  }
});

test("12. duck treats a voiced composition cue span as dialogue", () => {
  const wsDir = initSmallWorkspace("compaudio-duck");
  try {
    mountAudioComp(
      wsDir,
      "vo",
      '  <audio id="tone" src="assets/tone.wav" data-start="0" data-duration="3"></audio>',
      { laneId: "ln_vo", atMs: 0, durationMs: 3000 }
    );
    writeToneWav(path.join(wsDir, "compositions/vo/assets/tone.wav"), 3);
    const bedPath = path.join(path.dirname(wsDir), "bed.wav");
    writeToneWav(bedPath, 4, 220);
    ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [bedPath] });
    const bedHandle = loadSequence(wsDir).sequence.library.find((l) => l.kind === "audio")!.handle;
    const musicRes = addLaneCue({
      workspaceDir: wsDir,
      laneId: "ln_bgm",
      kind: "music",
      atMs: 0,
      durationMs: 4000,
      assetHandle: bedHandle,
    });

    const res = duckMusicUnderDialogue({ workspaceDir: wsDir, bgmLaneId: "ln_bgm" });
    assert.ok(
      res.dialogue_windows_ms.some((w) => w.start_ms <= 100 && w.end_ms >= 2900),
      `vo comp span must be a dialogue window, got ${JSON.stringify(res.dialogue_windows_ms)}`
    );
    const ducked = res.ducked_cues.find((c) => c.cue_id === musicRes.cue.id)!;
    assert.ok(ducked, "music cue must be ducked");
    const dipped = ducked.envelope_points.filter((p) => p.offset_ms >= 0 && p.offset_ms <= 3000);
    assert.ok(dipped.some((p) => p.value < -1), "music must dip under the voiced span");
  } finally {
    safeRm(path.dirname(wsDir));
  }
});

test("13. failed extraction is recorded and verify reports G435 with the reason", () => {
  const wsDir = initSmallWorkspace("compaudio-fail");
  try {
    const cueId = mountAudioComp(
      wsDir,
      "aud",
      '  <audio id="tone" src="assets/tone.wav" data-start="0" data-duration="1"></audio>'
    );
    const loaded = loadSequence(wsDir);
    const cue = loaded.sequence.lanes.flatMap((l) => l.cues).find((c) => c.id === cueId)!;
    const request = compositionAudioRequestForCue(cue, loaded.paths, {
      fps: loaded.sequence.stage.fps,
      width: loaded.sequence.stage.width,
      height: loaded.sequence.stage.height,
    })!;

    // A failing adapter records a sidecar error instead of throwing to the caller.
    const failingAdapter: CompositionAudioAdapter = {
      engine: "hyperframes",
      readEngineVersion: () => "0.0.0-test",
      cacheKeyFor: () => "failingadapter00",
      hasAudio: () => true,
      extractStem: () => {
        throw new Error("boom-synth-failure");
      },
    };
    assert.equal(ensureCompositionStem(cue, request, failingAdapter), null);
    const failingSidecar = JSON.parse(
      fs.readFileSync(path.join(loaded.paths.blobsDir, "compaudio_failingadapter00.stem.json"), "utf8")
    ) as { status: string; reason: string };
    assert.equal(failingSidecar.status, "error");
    assert.match(failingSidecar.reason, /boom-synth-failure/);

    // Verify surfaces a recorded stem failure as G435 (never silent).
    const realKey = hyperFramesCompositionAudioAdapter.cacheKeyFor(request);
    fs.mkdirSync(loaded.paths.blobsDir, { recursive: true });
    fs.writeFileSync(
      path.join(loaded.paths.blobsDir, `compaudio_${realKey}.stem.json`),
      JSON.stringify(
        { version: 1, engine: "hyperframes", engine_version: "0.9.15", status: "error", reason: "boom-synth-failure" },
        null,
        2
      ),
      "utf8"
    );
    const rep = verifySequence(loadSequence(wsDir).sequence, loadSequence(wsDir).paths, ["G4_STAGE"]);
    const failed = rep.diagnostics.filter((d) => d.code === "CUTHOL-G435");
    assert.equal(failed.length, 1);
    assert.equal(failed[0].severity, "WARN");
    assert.match(failed[0].what, /boom-synth-failure/);
  } finally {
    safeRm(path.dirname(wsDir));
  }
});

import "./test_setup.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const CLI = path.resolve(process.cwd(), "dist/cli.js");
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-scaffold-dur-"));

function runCli(args: string[]): { status: number; stdout: string; stderr: string } {
  const proc = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, CUTHOL_SKILLS_AUTO: "0", CUTHOL_ENCODER: "x264" },
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: proc.status ?? 1, stdout: proc.stdout ?? "", stderr: proc.stderr ?? "" };
}

function parseEnvelope(stdout: string): Record<string, unknown> {
  const trimmed = stdout.trim();
  return JSON.parse(trimmed.slice(trimmed.indexOf("{"), trimmed.lastIndexOf("}") + 1)) as Record<string, unknown>;
}

function diagnosticBlob(env: Record<string, unknown>): string {
  const list = Array.isArray(env.diagnostics) ? env.diagnostics : [];
  return (list as Array<{ code?: string; what?: string; suggestion?: string; formatted?: string }>)
    .map((d) => `${d.code ?? ""} ${d.what ?? ""} ${d.suggestion ?? ""} ${d.formatted ?? ""}`)
    .join("\n");
}

test("bare --duration under 100 warns it was read as milliseconds; units never warn", () => {
  const dir = path.join(ROOT, "scaff");
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(runCli(["workspace", "init", dir, "--aspect", "1:1", "--fps", "30"]).status, 0);

  const bare = runCli(["composition", "scaffold", "--dir", dir, "--comp-dir", "comps/a", "--duration", "4"]);
  assert.equal(bare.status, 0, bare.stderr || bare.stdout);
  const bareEnv = parseEnvelope(bare.stdout);
  assert.match(diagnosticBlob(bareEnv), /CUTHOL-G214/);
  assert.match(diagnosticBlob(bareEnv), /4 milliseconds/);
  const bareHtml = fs.readFileSync(path.join(dir, "comps/a/index.html"), "utf8");
  assert.match(bareHtml, /data-duration="0\.004"/);

  const secs = runCli(["composition", "scaffold", "--dir", dir, "--comp-dir", "comps/b", "--duration", "4s"]);
  assert.equal(secs.status, 0, secs.stderr || secs.stdout);
  assert.doesNotMatch(diagnosticBlob(parseEnvelope(secs.stdout)), /CUTHOL-G214/);
  const secsHtml = fs.readFileSync(path.join(dir, "comps/b/index.html"), "utf8");
  assert.match(secsHtml, /data-duration="4"/);

  const millis = runCli(["composition", "scaffold", "--dir", dir, "--comp-dir", "comps/c", "--duration", "4000"]);
  assert.equal(millis.status, 0, millis.stderr || millis.stdout);
  assert.doesNotMatch(diagnosticBlob(parseEnvelope(millis.stdout)), /CUTHOL-G214/);

  const lane = runCli([
    "lane",
    "add-composition",
    "--dir",
    dir,
    "--comp-dir",
    "comps/d",
    "--duration",
    "80",
    "--scaffold",
    "lower_third",
  ]);
  assert.equal(lane.status, 0, lane.stderr || lane.stdout);
  assert.match(diagnosticBlob(parseEnvelope(lane.stdout)), /CUTHOL-G214/);
});

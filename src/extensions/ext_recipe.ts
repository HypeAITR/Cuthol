// Runs extension recipes as one atomic revision of CLI steps (split out of manager.ts).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import { computeSequenceDelta } from "../core/envelope.js";
import {
  JournalEntry,
  loadJournalManifest,
  loadSequence,
  resolveWorkspacePaths
} from "../core/workspace.js";
import { verifySequence } from "../verify/gates.js";
import { ExtensionScope } from "./ext_manifest.js";
import { runExtensionPlanner } from "./ext_planner.js";
import { resolveValidatedParams, runExtensionProcessor } from "./ext_processor.js";
import { resolveExtension } from "./ext_registry.js";

function resolveTemplateValue(
  rawVal: unknown,
  params: Record<string, number | string | boolean>,
  stepOutputs: Map<string, Record<string, unknown>>,
  lastHandle: string | null
): unknown {
  if (typeof rawVal === "string") {
    const exactMatch = /^\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}$/.exec(rawVal);
    if (exactMatch) {
      const expr = exactMatch[1];
      if (expr === "last_handle" && lastHandle !== null) return lastHandle;
      if (expr.startsWith("steps.")) {
        const [, stepId, field] = expr.split(".");
        const stepObj = stepOutputs.get(stepId);
        if (stepObj && field in stepObj) return stepObj[field];
      }
      if (expr in params) return params[expr];
    }
    return rawVal.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_, expr: string) => {
      if (expr === "last_handle" && lastHandle !== null) return lastHandle;
      if (expr.startsWith("steps.")) {
        const [, stepId, field] = expr.split(".");
        const stepObj = stepOutputs.get(stepId);
        if (stepObj && field in stepObj && stepObj[field] !== undefined) {
          return String(stepObj[field]);
        }
      }
      if (expr in params) return String(params[expr]);
      return `{{${expr}}}`;
    });
  }
  if (Array.isArray(rawVal)) {
    return rawVal.map((item) => resolveTemplateValue(item, params, stepOutputs, lastHandle));
  }
  if (rawVal && typeof rawVal === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rawVal as Record<string, unknown>)) {
      out[k] = resolveTemplateValue(v, params, stepOutputs, lastHandle);
    }
    return out;
  }
  return rawVal;
}

function buildCliArgsFromRecipeStep(
  tool: string,
  action: string | undefined,
  args: Record<string, unknown>,
  workspaceDir: string
): string[] {
  const argv: string[] = [tool];
  if (action) argv.push(action.replace(/_/g, "-"));

  for (const [rawKey, rawVal] of Object.entries(args)) {
    if (rawVal === undefined || rawVal === null) continue;
    if (tool === "library" && action === "ingest" && rawKey === "files") {
      const files = Array.isArray(rawVal) ? rawVal.map(String) : [String(rawVal)];
      argv.push(...files);
      continue;
    }
    const flag = rawKey.replace(/_/g, "-");
    if (typeof rawVal === "boolean") {
      if (rawVal) argv.push(`--${flag}=true`);
      else argv.push(`--${flag}=false`);
    } else if (Array.isArray(rawVal)) {
      argv.push(`--${flag}=${rawVal.map(String).join(",")}`);
    } else if (typeof rawVal === "object") {
      argv.push(`--${flag}=${JSON.stringify(rawVal)}`);
    } else {
      argv.push(`--${flag}=${String(rawVal)}`);
    }
  }
  argv.push(`--dir=${workspaceDir}`);
  return argv;
}

/**
 * Executes a parameterized extension recipe as a single atomic journal unit:
 * - Every step's outcome is reported individually in `steps_executed`.
 * - If any step fails, the sequence and journal are rolled back to the pre-recipe state.
 * - On success, all sequence mutations across the recipe are collapsed into a single undo revision (`rN -> r(N+1)`).
 */
export function runExtensionRecipe(options: {
  workspaceDir: string;
  extensionName: string;
  recipeName?: string;
  params?: Record<string, unknown>;
  scope?: ExtensionScope;
  dryRun?: boolean;
}): {
  extension: string;
  version: string;
  recipe: string;
  undo_policy: "single_atomic_revision";
  params: Record<string, number | string | boolean>;
  steps_executed: Array<{
    index: number;
    id: string;
    tool: string;
    action: string | null;
    handle: string | null;
    summary: string;
  }>;
  last_handle: string | null;
  security_notice: {
    manifest_path: string;
    script_paths: string[];
    network_declared: boolean;
  };
  dry_run?: boolean;
} {
  const ext = resolveExtension(options.extensionName, options.workspaceDir, options.scope);
  const scriptPaths = Object.values(ext.manifest.processors ?? {})
    .filter((p) => p.kind === "node" && p.script)
    .map((p) => path.resolve(ext.dir, p.script!));
  const securityNotice = {
    manifest_path: ext.manifestPath,
    script_paths: scriptPaths,
    network_declared: ext.network,
  };
  const recipes = ext.manifest.recipes ?? {};
  const recNames = Object.keys(recipes);
  if (recNames.length === 0) {
    throw new CutholError(
      DIAGNOSTICS.EXTENSION_EXECUTION_FAILED(
        ext.name,
        options.recipeName || "recipe",
        `Extension '${ext.name}' defines no recipes ('recipes').`
      )
    );
  }

  const recName = options.recipeName?.trim() || (recNames.length === 1 ? recNames[0] : "");
  if (!recName || !recipes[recName]) {
    throw new CutholError(
      DIAGNOSTICS.EXTENSION_EXECUTION_FAILED(
        ext.name,
        recName || "(belirtilmedi)",
        `Recipe not found. Available recipes: ${recNames.join(", ")}.`
      )
    );
  }
  const recipe = recipes[recName];
  const resolvedParams = resolveValidatedParams(
    recipe.params,
    options.params,
    ext.name,
    `recipe:${recName}`
  );

  if (options.dryRun) {
    return {
      extension: ext.name,
      version: ext.version,
      recipe: recName,
      undo_policy: "single_atomic_revision",
      params: resolvedParams,
      steps_executed: recipe.steps.map((s, idx) => ({
        index: idx + 1,
        id: s.id ?? `step_${idx + 1}`,
        tool: s.tool,
        action: s.action ?? null,
        handle: null,
        summary: `dry-run: ${s.tool}${s.action ? `.${s.action}` : ""}`,
      })),
      last_handle: null,
      security_notice: securityNotice,
      dry_run: true,
    };
  }

  const paths = resolveWorkspacePaths(options.workspaceDir);
  const { sequence: preSeq } = loadSequence(options.workspaceDir);
  const preSeqRaw = fs.readFileSync(paths.sequenceFile, "utf8");
  const preManifest = loadJournalManifest(paths);
  const preManifestRaw = fs.existsSync(paths.journalIndexFile)
    ? fs.readFileSync(paths.journalIndexFile, "utf8")
    : null;
  const preRev = preSeq.meta.revision;

  const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../cli.js");
  const stepOutputs = new Map<string, Record<string, unknown>>();
  const stepsExecuted: Array<{
    index: number;
    id: string;
    tool: string;
    action: string | null;
    handle: string | null;
    summary: string;
  }> = [];
  let lastHandle: string | null = null;

  try {
    for (let i = 0; i < recipe.steps.length; i++) {
      const step = recipe.steps[i];
      const stepId = step.id ?? `step_${i + 1}`;
      const resolvedArgs = (resolveTemplateValue(
        step.args ?? {},
        resolvedParams,
        stepOutputs,
        lastHandle
      ) ?? {}) as Record<string, unknown>;

      if (step.tool === "extension" && (!step.action || step.action === "run")) {
        const targetExt = String(resolvedArgs.name ?? ext.name);
        const procName =
          typeof resolvedArgs.processor === "string" ? resolvedArgs.processor : undefined;
        const planName =
          typeof resolvedArgs.planner === "string" ? resolvedArgs.planner : undefined;
        const inputVal = String(resolvedArgs.input ?? resolvedArgs.handle ?? "");
        const stepParams =
          resolvedArgs.params && typeof resolvedArgs.params === "object"
            ? (resolvedArgs.params as Record<string, unknown>)
            : {};
        if (planName) {
          const planRes = runExtensionPlanner({
            workspaceDir: options.workspaceDir,
            extensionName: targetExt,
            plannerName: planName,
            params: stepParams,
          });
          const firstAdded = planRes.cues_added[0] ?? null;
          if (firstAdded) lastHandle = firstAdded;
          stepOutputs.set(stepId, {
            handle: firstAdded,
            id: firstAdded,
            cues_added: planRes.cues_added,
          });
          stepsExecuted.push({
            index: i + 1,
            id: stepId,
            tool: "extension",
            action: "run",
            handle: firstAdded,
            summary: `${targetExt}.${planRes.planner} -> +${planRes.cues_added.length} cue(s)`,
          });
          continue;
        }
        const procRes = runExtensionProcessor({
          workspaceDir: options.workspaceDir,
          extensionName: targetExt,
          processorName: procName,
          inputHandleOrPath: inputVal,
          targetHandle:
            typeof resolvedArgs.target_handle === "string" ? resolvedArgs.target_handle : undefined,
          params: stepParams,
        });
        const handle = procRes.output_asset.handle;
        lastHandle = handle;
        stepOutputs.set(stepId, {
          handle,
          id: handle,
          uri: procRes.output_asset.uri,
          duration_ms: `${procRes.output_asset.probe.duration_ms}ms`,
          cached: procRes.cached,
        });
        stepsExecuted.push({
          index: i + 1,
          id: stepId,
          tool: "extension",
          action: "run",
          handle,
          summary: `${targetExt}.${procRes.processor} -> ${handle} (${procRes.cached ? "cached" : "processed"})`,
        });
        continue;
      }

      const cliArgv = buildCliArgsFromRecipeStep(
        step.tool,
        step.action,
        resolvedArgs,
        paths.rootDir
      );
      const proc = spawnSync(process.execPath, [cliPath, ...cliArgv], {
        cwd: paths.rootDir,
        env: process.env,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
      });

      if (proc.status !== 0) {
        throw new CutholError(
          DIAGNOSTICS.EXTENSION_EXECUTION_FAILED(
            ext.name,
            `recipe:${recName}#${stepId}`,
            `Step ${i + 1} (${step.tool}.${step.action ?? ""}) failed: ${(proc.stderr || proc.stdout || "").trim()}`
          )
        );
      }

      let parsedEnv: Record<string, unknown> = {};
      try {
        parsedEnv = JSON.parse(proc.stdout) as Record<string, unknown>;
      } catch {
        parsedEnv = {};
      }

      let producedHandle: string | null = null;
      if (Array.isArray(parsedEnv.ingested) && parsedEnv.ingested[0]?.handle) {
        producedHandle = String(parsedEnv.ingested[0].handle);
      } else if (parsedEnv.clip && typeof (parsedEnv.clip as { id?: unknown }).id === "string") {
        producedHandle = String((parsedEnv.clip as { id: string }).id);
      } else if (parsedEnv.cue && typeof (parsedEnv.cue as { id?: unknown }).id === "string") {
        producedHandle = String((parsedEnv.cue as { id: string }).id);
      } else if (parsedEnv.asset && typeof (parsedEnv.asset as { handle?: unknown }).handle === "string") {
        producedHandle = String((parsedEnv.asset as { handle: string }).handle);
      } else if (typeof parsedEnv.handle === "string") {
        producedHandle = parsedEnv.handle;
      }

      if (producedHandle) lastHandle = producedHandle;
      stepOutputs.set(stepId, {
        ...parsedEnv,
        handle: producedHandle,
        id: producedHandle,
      });
      const deltaSummary =
        parsedEnv.delta && typeof (parsedEnv.delta as { summary?: unknown }).summary === "string"
          ? String((parsedEnv.delta as { summary: string }).summary)
          : `${step.tool}${step.action ? `.${step.action}` : ""}`;
      stepsExecuted.push({
        index: i + 1,
        id: stepId,
        tool: step.tool,
        action: step.action ?? null,
        handle: producedHandle,
        summary: deltaSummary,
      });
    }

    // Collapse all mutations from the recipe into a single atomic revision (preRev + 1)
    const { sequence: postSeq } = loadSequence(options.workspaceDir);
    if (JSON.stringify(postSeq) !== JSON.stringify(preSeq)) {
      const targetRev = preRev + 1;
      postSeq.meta.revision = targetRev;
      postSeq.meta.updated_at = new Date().toISOString();

      const ver = verifySequence(postSeq, paths);
      if (!ver.ok) {
        const firstErr = ver.diagnostics.find((d) => d.severity === "ERROR")!;
        throw new CutholError(firstErr, ver.diagnostics);
      }

      // Remove intermediate snapshots > targetRev
      if (fs.existsSync(paths.journalDir)) {
        for (const f of fs.readdirSync(paths.journalDir)) {
          const m = /^rev_(\d+)\.json$/.exec(f);
          if (m && parseInt(m[1], 10) > targetRev) {
            try {
              fs.unlinkSync(path.join(paths.journalDir, f));
            } catch {
              // ignore
            }
          }
        }
      }

      const snapName = `rev_${String(targetRev).padStart(4, "0")}.json`;
      fs.writeFileSync(paths.sequenceFile, JSON.stringify(postSeq, null, 2), "utf8");
      fs.writeFileSync(path.join(paths.journalDir, snapName), JSON.stringify(postSeq, null, 2), "utf8");

      const operationName = `extension.run:${ext.name}.${recName}`;
      const deltaInfo = computeSequenceDelta(preSeq, postSeq, operationName);
      const baseEntries = preManifest.entries.filter((e) => e.revision <= preRev);
      const newEntry: JournalEntry = {
        revision: targetRev,
        timestamp: postSeq.meta.updated_at,
        operation: operationName,
        tag: null,
        snapshot_file: snapName,
        delta_summary: deltaInfo.summary,
        inverse_kind: deltaInfo.inverse_kind,
        inverse_summary: deltaInfo.inverse_summary,
        affected_ids: deltaInfo.affected_ids,
        touches_protected: deltaInfo.touches_protected,
        protected_ids: deltaInfo.protected_ids,
      };
      const nextManifest = {
        cursor_revision: targetRev,
        entries: [...baseEntries, newEntry],
      };
      fs.writeFileSync(paths.journalIndexFile, JSON.stringify(nextManifest, null, 2), "utf8");
    }
  } catch (err) {
    // Full atomic rollback to pre-recipe state
    fs.writeFileSync(paths.sequenceFile, preSeqRaw, "utf8");
    if (preManifestRaw !== null) {
      fs.writeFileSync(paths.journalIndexFile, preManifestRaw, "utf8");
    }
    throw err;
  }

  return {
    extension: ext.name,
    version: ext.version,
    recipe: recName,
    undo_policy: "single_atomic_revision",
    params: resolvedParams,
    steps_executed: stepsExecuted,
    last_handle: lastHandle,
    security_notice: securityNotice,
  };
}

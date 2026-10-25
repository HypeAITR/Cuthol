// Runs extension planners and validates their cue-sheet patches (split out of manager.ts).
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import { parseTimeMs } from "../core/time.js";
import {
  loadSequence
} from "../core/workspace.js";
import {
  CueSheetCueEntry,
  CueSheetDiff,
  CutholCueSheet,
  mergeCueSheetIntoSequence,
} from "../sequence/cuesheet.js";
import { commitVerifiedMutation, VerificationReport, verifySequence } from "../verify/gates.js";
import { buildPlannerSnapshot } from "./ext_events.js";
import { ExtensionScope, assertStayInsideDir, assertScriptRespectsNetworkPolicy } from "./ext_manifest.js";
import { resolveValidatedParams } from "./ext_processor.js";
import { resolveExtension, listFilesRecursiveRelative, hashExtensionDirectory } from "./ext_registry.js";

const ALLOWED_PATCH_ROOT_KEYS = new Set([
  "title",
  "stage",
  "spine",
  "cues",
  "notes",
  "summary",
  "ok",
]);

function normalizeAndValidatePlannerPatch(
  rawPatch: unknown,
  extName: string,
  plannerName: string
): { sheet: CutholCueSheet; notes: string[] } {
  if (!rawPatch || typeof rawPatch !== "object" || Array.isArray(rawPatch)) {
    throw new CutholError(
      DIAGNOSTICS.EXTENSION_EXECUTION_FAILED(
        extName,
        `planner:${plannerName}`,
        `Planlayıcı çıktısı bir Cue Sheet JSON nesnesi olmalıdır.`
      )
    );
  }
  const topObj = rawPatch as Record<string, unknown>;
  const rootObj =
    topObj.patch && typeof topObj.patch === "object" && !Array.isArray(topObj.patch)
      ? (topObj.patch as Record<string, unknown>)
      : topObj;

  for (const k of Object.keys(rootObj)) {
    if (!ALLOWED_PATCH_ROOT_KEYS.has(k)) {
      throw new CutholError(
        DIAGNOSTICS.EXTENSION_EXECUTION_FAILED(
          extName,
          `planner:${plannerName}`,
          `Planlayıcı yamasında bilinmeyen alan '${k}' (izin verilenler: title, stage, spine, cues, notes).`
        )
      );
    }
  }

  const notes: string[] = [];
  if (Array.isArray(rootObj.notes)) {
    for (const n of rootObj.notes) notes.push(String(n));
  } else if (typeof topObj.summary === "string" && topObj.summary.trim()) {
    notes.push(topObj.summary.trim());
  }

  const sheet: CutholCueSheet = {};
  if (typeof rootObj.title === "string") sheet.title = rootObj.title;
  if (rootObj.stage !== undefined) {
    if (!rootObj.stage || typeof rootObj.stage !== "object" || Array.isArray(rootObj.stage)) {
      throw new CutholError(
        DIAGNOSTICS.EXTENSION_EXECUTION_FAILED(
          extName,
          `planner:${plannerName}`,
          `Planlayıcı yamasındaki 'stage' alanı bir nesne olmalıdır.`
        )
      );
    }
    sheet.stage = rootObj.stage as CutholCueSheet["stage"];
  }

  if (rootObj.spine !== undefined) {
    if (!Array.isArray(rootObj.spine)) {
      throw new CutholError(
        DIAGNOSTICS.EXTENSION_EXECUTION_FAILED(
          extName,
          `planner:${plannerName}`,
          `Planlayıcı yamasındaki 'spine' alanı bir dizi olmalıdır.`
        )
      );
    }
    sheet.spine = rootObj.spine as CutholCueSheet["spine"];
  }

  if (rootObj.cues !== undefined) {
    if (!Array.isArray(rootObj.cues)) {
      throw new CutholError(
        DIAGNOSTICS.EXTENSION_EXECUTION_FAILED(
          extName,
          `planner:${plannerName}`,
          `Planlayıcı yamasındaki 'cues' alanı bir dizi olmalıdır.`
        )
      );
    }
    const normalizedCues: CueSheetCueEntry[] = [];
    for (let i = 0; i < rootObj.cues.length; i++) {
      const rawCue = rootObj.cues[i];
      if (!rawCue || typeof rawCue !== "object" || Array.isArray(rawCue)) {
        throw new CutholError(
          DIAGNOSTICS.EXTENSION_EXECUTION_FAILED(
            extName,
            `planner:${plannerName}`,
            `'cues[${i}]' bir nesne olmalıdır.`
          )
        );
      }
      const cObj = { ...(rawCue as Record<string, unknown>) };
      const laneId = typeof cObj.lane_id === "string" ? cObj.lane_id.trim() : typeof cObj.lane === "string" ? cObj.lane.trim() : "";
      if (!laneId && cObj.op !== "delete") {
        throw new CutholError(
          DIAGNOSTICS.EXTENSION_EXECUTION_FAILED(
            extName,
            `planner:${plannerName}`,
            `'cues[${i}].lane_id' alanı zorunludur.`
          )
        );
      }
      cObj.lane_id = laneId || "ln_sfx";
      delete cObj.lane;

      if (cObj.asset !== undefined && cObj.asset_handle === undefined) {
        cObj.asset_handle = cObj.asset;
        delete cObj.asset;
      }

      if (cObj.at !== undefined && cObj.at_ms === undefined) {
        cObj.at_ms = typeof cObj.at === "number" ? cObj.at : parseTimeMs(String(cObj.at));
        delete cObj.at;
      } else if (typeof cObj.at_ms === "string") {
        cObj.at_ms = parseTimeMs(cObj.at_ms);
      }

      if (cObj.duration !== undefined && cObj.duration_ms === undefined) {
        cObj.duration_ms =
          typeof cObj.duration === "number" ? cObj.duration : parseTimeMs(String(cObj.duration));
        delete cObj.duration;
      } else if (typeof cObj.duration_ms === "string") {
        cObj.duration_ms = parseTimeMs(cObj.duration_ms);
      }

      if (cObj.in !== undefined && cObj.source_in_ms === undefined) {
        cObj.source_in_ms = typeof cObj.in === "number" ? cObj.in : parseTimeMs(String(cObj.in));
        delete cObj.in;
      }
      if (cObj.out !== undefined && cObj.source_out_ms === undefined) {
        cObj.source_out_ms = typeof cObj.out === "number" ? cObj.out : parseTimeMs(String(cObj.out));
        delete cObj.out;
      }

      if (
        cObj.at_ms !== undefined &&
        (typeof cObj.at_ms !== "number" || !Number.isFinite(cObj.at_ms) || cObj.at_ms < 0)
      ) {
        throw new CutholError(
          DIAGNOSTICS.EXTENSION_EXECUTION_FAILED(
            extName,
            `planner:${plannerName}`,
            `'cues[${i}].at_ms' negatif olmayan geçerli bir milisaniye değeri olmalıdır (verilen: ${String(cObj.at_ms)}).`
          )
        );
      }
      if (
        cObj.duration_ms !== undefined &&
        (typeof cObj.duration_ms !== "number" || !Number.isFinite(cObj.duration_ms) || cObj.duration_ms <= 0)
      ) {
        throw new CutholError(
          DIAGNOSTICS.EXTENSION_EXECUTION_FAILED(
            extName,
            `planner:${plannerName}`,
            `'cues[${i}].duration_ms' pozitif bir milisaniye değeri olmalıdır (verilen: ${String(cObj.duration_ms)}).`
          )
        );
      }

      normalizedCues.push(cObj as unknown as CueSheetCueEntry);
    }
    sheet.cues = normalizedCues;
  }

  return { sheet, notes };
}

/**
 * Runs an extension planner script in an isolated child process:
 * - Passes a read-only `CutholPlannerSnapshot` (sequence + sequence-projected words + composition-declared events).
 * - Enforces file-write and network security rules (`CUTHOL-G206`).
 * - Validates the returned Cue Sheet patch via `mergeCueSheetIntoSequence` + `verifySequence` (`planCueSheet`).
 * - On `dryRun: true`, returns the plan without mutating the sequence.
 * - On `dryRun: false`, applies the patch in a single atomic revision (`rN -> r(N+1)`) so `undo` reverts all added/updated cues at once.
 */
export function runExtensionPlanner(options: {
  workspaceDir: string;
  extensionName: string;
  plannerName?: string;
  params?: Record<string, unknown>;
  scope?: ExtensionScope;
  dryRun?: boolean;
}): {
  extension: string;
  version: string;
  planner: string;
  kind: "planner";
  undo_policy: "single_atomic_revision";
  params: Record<string, number | string | boolean>;
  snapshot_summary: {
    compositions_count: number;
    declared_events_count: number;
    projected_words_count: number;
  };
  diff: CueSheetDiff;
  would_commit: boolean;
  cues_added: string[];
  cues_updated: string[];
  cues_removed: string[];
  notes?: string[];
  revision: number;
  verification: VerificationReport;
  security_notice: {
    manifest_path: string;
    script_path: string;
    network_declared: boolean;
  };
  dry_run?: boolean;
} {
  const ext = resolveExtension(options.extensionName, options.workspaceDir, options.scope);
  const planners = ext.manifest.planners ?? {};
  const planNames = Object.keys(planners);
  if (planNames.length === 0) {
    throw new CutholError(
      DIAGNOSTICS.EXTENSION_EXECUTION_FAILED(
        ext.name,
        options.plannerName || "planner",
        `'${ext.name}' eklentisinde tanımlı hiçbir planlayıcı ('planners') yok.`
      )
    );
  }

  const planName =
    options.plannerName?.trim() || (planNames.length === 1 ? planNames[0] : "");
  if (!planName || !planners[planName]) {
    throw new CutholError(
      DIAGNOSTICS.EXTENSION_EXECUTION_FAILED(
        ext.name,
        planName || "(belirtilmedi)",
        `Planlayıcı bulunamadı. Mevcut planlayıcılar: ${planNames.join(", ")}.`
      )
    );
  }

  const planner = planners[planName];
  const resolvedParams = resolveValidatedParams(
    planner.params,
    options.params,
    ext.name,
    `planner:${planName}`
  );
  const scriptAbsPath = assertStayInsideDir(ext.dir, planner.script, ext.name);
  assertScriptRespectsNetworkPolicy(scriptAbsPath, ext);

  const securityNotice = {
    manifest_path: ext.manifestPath,
    script_path: scriptAbsPath,
    network_declared: ext.network,
  };

  const { paths, sequence: initialSeq } = loadSequence(options.workspaceDir);
  const preSeqRaw = fs.readFileSync(paths.sequenceFile, "utf8");
  const snapshot = buildPlannerSnapshot(initialSeq, paths, ext, resolvedParams);

  const extFilesBefore = new Map(
    listFilesRecursiveRelative(ext.dir).map((f) => [
      f.path,
      crypto
        .createHash("sha256")
        .update(fs.readFileSync(path.join(ext.dir, f.path)))
        .digest("hex"),
    ])
  );
  const extHashBefore = hashExtensionDirectory(ext.dir);
  const rootEntriesBefore = new Set(fs.readdirSync(paths.rootDir));

  const isolatedTmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `cuthol-ext-planner-${ext.name}-`)
  );
  const snapshotPath = path.join(isolatedTmpDir, "snapshot.json");
  const patchOutPath = path.join(isolatedTmpDir, "patch.json");

  let rawPatchObj: unknown;
  try {
    fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2), "utf8");
    const nodeProc = spawnSync(
      process.execPath,
      [scriptAbsPath, snapshotPath, patchOutPath, JSON.stringify(resolvedParams)],
      {
        cwd: isolatedTmpDir,
        env: {
          ...process.env,
          CUTHOL_EXT_NAME: ext.name,
          CUTHOL_EXT_VERSION: ext.version,
          CUTHOL_EXT_DIR: ext.dir,
          CUTHOL_EXT_SNAPSHOT: snapshotPath,
          CUTHOL_EXT_OUTPUT: patchOutPath,
          CUTHOL_EXT_PARAMS: JSON.stringify(resolvedParams),
        },
        encoding: "utf8",
        timeout: 120_000,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
      }
    );

    // 1. Check extension folder write violation
    const extHashAfter = hashExtensionDirectory(ext.dir);
    if (extHashAfter !== extHashBefore) {
      for (const f of listFilesRecursiveRelative(ext.dir)) {
        if (!extFilesBefore.has(f.path)) {
          try {
            fs.unlinkSync(path.join(ext.dir, f.path));
          } catch {
            // ignore
          }
        }
      }
      throw new CutholError(
        DIAGNOSTICS.EXTENSION_SECURITY_VIOLATION(
          ext.name,
          `Planlayıcı betiği eklenti klasörünün içine yazma girişiminde bulundu.`
        )
      );
    }

    // 2. Check workspace folder write violation
    const postSeqRaw = fs.existsSync(paths.sequenceFile)
      ? fs.readFileSync(paths.sequenceFile, "utf8")
      : "";
    const rootEntriesAfter = fs.readdirSync(paths.rootDir);
    const extraRootEntries = rootEntriesAfter.filter((e) => !rootEntriesBefore.has(e));
    if (postSeqRaw !== preSeqRaw || extraRootEntries.length > 0) {
      fs.writeFileSync(paths.sequenceFile, preSeqRaw, "utf8");
      for (const extra of extraRootEntries) {
        try {
          fs.rmSync(path.join(paths.rootDir, extra), { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
      throw new CutholError(
        DIAGNOSTICS.EXTENSION_SECURITY_VIOLATION(
          ext.name,
          `Planlayıcı betiği doğrudan çalışma alanı klasörüne ('${extraRootEntries.join(", ") || "cuthol.sequence.json"}') yazma girişiminde bulundu.`
        )
      );
    }

    // 3. Check sandbox extra files violation
    const sandboxEntries = fs.readdirSync(isolatedTmpDir);
    const extraSandbox = sandboxEntries.filter(
      (e) => e !== "snapshot.json" && e !== "patch.json"
    );
    if (extraSandbox.length > 0) {
      throw new CutholError(
        DIAGNOSTICS.EXTENSION_SECURITY_VIOLATION(
          ext.name,
          `Planlayıcı betiği Cuthol'un verdiği çıktı yolu dışına ('${extraSandbox.join(", ")}') dosya yazdı.`
        )
      );
    }

    if (nodeProc.status !== 0) {
      throw new CutholError(
        DIAGNOSTICS.EXTENSION_EXECUTION_FAILED(
          ext.name,
          `planner:${planName}`,
          `Planlayıcı betiği çıkış kodu ${nodeProc.status}: ${(nodeProc.stderr || nodeProc.stdout || "").trim()}`
        )
      );
    }

    if (fs.existsSync(patchOutPath)) {
      const patchRaw = fs.readFileSync(patchOutPath, "utf8").trim();
      try {
        rawPatchObj = JSON.parse(patchRaw);
      } catch (err) {
        throw new CutholError(
          DIAGNOSTICS.EXTENSION_EXECUTION_FAILED(
            ext.name,
            `planner:${planName}`,
            `Planlayıcı çıktı dosyası geçerli bir JSON değil: ${err instanceof Error ? err.message : String(err)}`
          )
        );
      }
    } else {
      const stdoutTrimmed = (nodeProc.stdout || "").trim();
      if (!stdoutTrimmed) {
        throw new CutholError(
          DIAGNOSTICS.EXTENSION_EXECUTION_FAILED(
            ext.name,
            `planner:${planName}`,
            `Planlayıcı betiği ne çıktı dosyası ('patch.json') üretti ne de stdout üzerinde JSON döndürdü.`
          )
        );
      }
      const lastLine = stdoutTrimmed.split(/\r?\n/).pop()!.trim();
      try {
        rawPatchObj = JSON.parse(lastLine);
      } catch {
        try {
          rawPatchObj = JSON.parse(stdoutTrimmed);
        } catch {
          throw new CutholError(
            DIAGNOSTICS.EXTENSION_EXECUTION_FAILED(
              ext.name,
              `planner:${planName}`,
              `Planlayıcı betiği geçerli bir JSON döndürmedi: '${lastLine.slice(0, 120)}'`
            )
          );
        }
      }
    }
  } finally {
    fs.rmSync(isolatedTmpDir, { recursive: true, force: true });
  }

  const { sheet, notes } = normalizeAndValidatePlannerPatch(rawPatchObj, ext.name, planName);

  // Plan & validate via the Cue Sheet engine first (guarantees zero partial application on invalid patch)
  const { nextSeq: plannedSeq, diff: plannedDiff } = mergeCueSheetIntoSequence(initialSeq, sheet);
  const plannedVer = verifySequence(plannedSeq, paths);

  if (!plannedVer.ok) {
    const firstErr = plannedVer.diagnostics.find((d) => d.severity === "ERROR")!;
    throw new CutholError(firstErr, plannedVer.diagnostics);
  }

  const snapshotSummary = {
    compositions_count: snapshot.compositions.length,
    declared_events_count: snapshot.events.length,
    projected_words_count: snapshot.words.length,
  };

  if (options.dryRun) {
    return {
      extension: ext.name,
      version: ext.version,
      planner: planName,
      kind: "planner",
      undo_policy: "single_atomic_revision",
      params: resolvedParams,
      snapshot_summary: snapshotSummary,
      diff: plannedDiff,
      would_commit: plannedVer.ok,
      cues_added: plannedDiff.cues_added,
      cues_updated: plannedDiff.cues_updated,
      cues_removed: plannedDiff.cues_removed,
      ...(notes.length > 0 ? { notes } : {}),
      revision: initialSeq.meta.revision,
      verification: plannedVer,
      security_notice: securityNotice,
      dry_run: true,
    };
  }

  const hasChanges =
    plannedDiff.stage_changed ||
    plannedDiff.spine_added.length > 0 ||
    plannedDiff.spine_updated.length > 0 ||
    plannedDiff.spine_removed.length > 0 ||
    plannedDiff.cues_added.length > 0 ||
    plannedDiff.cues_updated.length > 0 ||
    plannedDiff.cues_removed.length > 0;

  if (!hasChanges) {
    return {
      extension: ext.name,
      version: ext.version,
      planner: planName,
      kind: "planner",
      undo_policy: "single_atomic_revision",
      params: resolvedParams,
      snapshot_summary: snapshotSummary,
      diff: plannedDiff,
      would_commit: true,
      cues_added: [],
      cues_updated: [],
      cues_removed: [],
      ...(notes.length > 0 ? { notes } : {}),
      revision: initialSeq.meta.revision,
      verification: plannedVer,
      security_notice: securityNotice,
    };
  }

  let appliedDiff: CueSheetDiff = plannedDiff;
  const { revision, verification } = commitVerifiedMutation(
    options.workspaceDir,
    `extension.run:${ext.name}.${planName}`,
    (seq) => {
      const { nextSeq, diff } = mergeCueSheetIntoSequence(seq, sheet);
      appliedDiff = diff;
      Object.assign(seq, nextSeq);
    }
  );

  return {
    extension: ext.name,
    version: ext.version,
    planner: planName,
    kind: "planner",
    undo_policy: "single_atomic_revision",
    params: resolvedParams,
    snapshot_summary: snapshotSummary,
    diff: appliedDiff,
    would_commit: true,
    cues_added: appliedDiff.cues_added,
    cues_updated: appliedDiff.cues_updated,
    cues_removed: appliedDiff.cues_removed,
    ...(notes.length > 0 ? { notes } : {}),
    revision,
    verification,
    security_notice: securityNotice,
  };
}

// Runs extension processors (ffmpeg filter chains or node scripts) with cached outputs (split out of manager.ts).
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CutholDiagnostic, CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import {
  allocateNextHandle,
  AssetKind,
  assetPrefixForKind, LibraryItem
} from "../core/schema.js";
import {
  ensureWorkspaceDirectories, loadSequence
} from "../core/workspace.js";
import { MediaLedger } from "../library/ledger.js";
import { probeLocalMediaFile, resolveLibraryItemPath } from "../library/probe.js";
import { commitVerifiedMutation } from "../verify/gates.js";
import { ExtensionParamDef, ExtensionScope, assertStayInsideDir, assertScriptRespectsNetworkPolicy } from "./ext_manifest.js";
import { resolveExtension, listFilesRecursiveRelative, hashExtensionDirectory } from "./ext_registry.js";

export function resolveValidatedParams(
  schema: Record<string, ExtensionParamDef> | undefined,
  supplied: Record<string, unknown> | undefined,
  extName: string,
  targetLabel: string
): Record<string, number | string | boolean> {
  const defs = schema ?? {};
  const raw = supplied ?? {};
  const out: Record<string, number | string | boolean> = {};

  for (const k of Object.keys(raw)) {
    if (!(k in defs) && Object.keys(defs).length > 0) {
      throw new CutholError(
        DIAGNOSTICS.EXTENSION_EXECUTION_FAILED(
          extName,
          targetLabel,
          `Unknown parameter '${k}' (valid parameters: ${Object.keys(defs).join(", ")}).`
        )
      );
    }
  }

  for (const [k, def] of Object.entries(defs)) {
    const val = raw[k] !== undefined ? raw[k] : def.default;
    if (val === undefined || val === null) {
      if (def.required) {
        throw new CutholError(
          DIAGNOSTICS.EXTENSION_EXECUTION_FAILED(
            extName,
            targetLabel,
            `Required parameter '${k}' is missing.`
          )
        );
      }
      continue;
    }
    if (def.type === "number") {
      const n = typeof val === "number" ? val : Number(val);
      if (!Number.isFinite(n)) {
        throw new CutholError(
          DIAGNOSTICS.EXTENSION_EXECUTION_FAILED(
            extName,
            targetLabel,
            `'${k}' must be a number (given: ${JSON.stringify(val)}).`
          )
        );
      }
      if (def.min !== undefined && n < def.min) {
        throw new CutholError(
          DIAGNOSTICS.EXTENSION_EXECUTION_FAILED(
            extName,
            targetLabel,
            `'${k}' (${n}) is below the minimum (${def.min}).`
          )
        );
      }
      if (def.max !== undefined && n > def.max) {
        throw new CutholError(
          DIAGNOSTICS.EXTENSION_EXECUTION_FAILED(
            extName,
            targetLabel,
            `'${k}' (${n}) is above the maximum (${def.max}).`
          )
        );
      }
      out[k] = n;
    } else if (def.type === "boolean") {
      out[k] =
        typeof val === "boolean"
          ? val
          : ["true", "1", "yes"].includes(String(val).toLowerCase());
    } else {
      const s = String(val);
      out[k] = s;
    }
    if (def.enum && !def.enum.includes(out[k] as string | number)) {
      throw new CutholError(
        DIAGNOSTICS.EXTENSION_EXECUTION_FAILED(
          extName,
          targetLabel,
          `'${k}' must be one of: ${def.enum.join(", ")}.`
        )
      );
    }
  }

  if (Object.keys(defs).length === 0) {
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") {
        out[k] = v;
      }
    }
  }

  return out;
}

function interpolateFilterTemplate(
  template: string,
  params: Record<string, number | string | boolean>,
  extName: string,
  procName: string
): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_-]+)\s*\}\}/g, (_, key: string) => {
    if (!(key in params)) {
      throw new CutholError(
        DIAGNOSTICS.EXTENSION_EXECUTION_FAILED(
          extName,
          procName,
          `No value was given for the '{{${key}}}' parameter in the filter template.`
        )
      );
    }
    const val = String(params[key]);
    if (/[;&|`$\r\n]/.test(val)) {
      throw new CutholError(
        DIAGNOSTICS.EXTENSION_SECURITY_VIOLATION(
          extName,
          `Filter parameter '${key}' contains characters that are not allowed for security.`
        )
      );
    }
    return val;
  });
}

const DEFAULT_CHILD_TIMEOUT_SEC = 120;
const SANDBOX_TMP_DIR = "tmp";

/** Child timeout in milliseconds. `undefined` means no limit (`timeout_sec: 0`, or ffmpeg when omitted). */
export function resolveExtensionTimeoutMs(
  timeoutSec: number | undefined,
  whenOmitted: "120" | "none"
): number | undefined {
  const sec = timeoutSec === undefined ? (whenOmitted === "120" ? DEFAULT_CHILD_TIMEOUT_SEC : 0) : timeoutSec;
  if (sec === 0) return undefined;
  return sec * 1000;
}

export function extensionTimeoutFailureDetail(
  subject: string,
  timeoutSec: number | undefined,
  whenOmitted: "120" | "none"
): string {
  const sec = timeoutSec === undefined ? (whenOmitted === "120" ? DEFAULT_CHILD_TIMEOUT_SEC : 0) : timeoutSec;
  const which =
    timeoutSec === undefined ? `default limit ${sec} s` : `'timeout_sec' limit ${sec} s`;
  return `${subject} timed out (${which} exceeded). Change the limit with the manifest 'timeout_sec' field (integer, seconds; 0 = no limit).`;
}

export function isSpawnTimeout(result: { error?: Error | null }): boolean {
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ETIMEDOUT";
}

function streamDurationMs(stream: Record<string, unknown>): number | null {
  const direct = Number(stream.duration);
  if (Number.isFinite(direct) && direct >= 0) return direct * 1000;
  const ts = Number(stream.duration_ts);
  const timeBase = typeof stream.time_base === "string" ? stream.time_base : "";
  const match = /^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/.exec(timeBase);
  if (Number.isFinite(ts) && ts >= 0 && match) {
    const den = Number(match[2]);
    if (den > 0) return ((ts * Number(match[1])) / den) * 1000;
  }
  return null;
}

function probeAvStreamDurations(filePath: string): { videoMs: number | null; audioMs: number | null } {
  const proc = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "stream=codec_type,duration,duration_ts,time_base",
      "-of",
      "json",
      filePath,
    ],
    { encoding: "utf8", windowsHide: true, maxBuffer: 4 * 1024 * 1024 }
  );
  if (proc.status !== 0 || !proc.stdout) return { videoMs: null, audioMs: null };
  try {
    const parsed = JSON.parse(proc.stdout) as { streams?: Array<Record<string, unknown>> };
    const streams = parsed.streams ?? [];
    const video = streams.find((stream) => stream.codec_type === "video");
    const audio = streams.find((stream) => stream.codec_type === "audio");
    return {
      videoMs: video ? streamDurationMs(video) : null,
      audioMs: audio ? streamDurationMs(audio) : null,
    };
  } catch {
    return { videoMs: null, audioMs: null };
  }
}

function avDurationDiagnostics(filePath: string, fps: number, handle: string): CutholDiagnostic[] {
  const { videoMs, audioMs } = probeAvStreamDurations(filePath);
  if (videoMs == null || audioMs == null) return [];
  const frameMs = fps > 0 ? 1000 / fps : 40;
  if (Math.abs(videoMs - audioMs) <= frameMs) return [];
  return [DIAGNOSTICS.AV_STREAM_DURATION_MISMATCH(videoMs, audioMs, frameMs, handle)];
}

function buildAtEmpoChainIfNeeded(filterExpr: string): string {
  return filterExpr.replace(/\batempo\s*=\s*([0-9]+(?:\.[0-9]+)?)/gi, (_, rawRate: string) => {
    let rate = Number(rawRate);
    if (!Number.isFinite(rate) || rate <= 0) return `atempo=${rawRate}`;
    const stages: string[] = [];
    while (rate > 2.0 + 1e-6) {
      stages.push("atempo=2.0");
      rate /= 2.0;
    }
    while (rate < 0.5 - 1e-6) {
      stages.push("atempo=0.5");
      rate /= 0.5;
    }
    stages.push(`atempo=${Number(rate.toFixed(6))}`);
    return stages.join(",");
  });
}

export function runExtensionProcessor(options: {
  workspaceDir: string;
  extensionName: string;
  processorName?: string;
  inputHandleOrPath: string;
  targetHandle?: string;
  params?: Record<string, unknown>;
  scope?: ExtensionScope;
  dryRun?: boolean;
}): {
  extension: string;
  version: string;
  processor: string;
  kind: "ffmpeg" | "node";
  cached: boolean;
  cache_key: string;
  elapsed_ms: number;
  input_handle: string | null;
  input_path: string;
  input_sha256: string;
  output_asset: LibraryItem;
  params: Record<string, number | string | boolean>;
  security_notice: {
    manifest_path: string;
    script_path: string | null;
    network_declared: boolean;
  };
  script_output?: Record<string, unknown> | null;
  diagnostics?: CutholDiagnostic[];
  dry_run?: boolean;
} {
  const startedAt = Date.now();
  const ext = resolveExtension(options.extensionName, options.workspaceDir, options.scope);
  const procs = ext.manifest.processors ?? {};
  const procNames = Object.keys(procs);
  if (procNames.length === 0) {
    throw new CutholError(
      DIAGNOSTICS.EXTENSION_EXECUTION_FAILED(
        ext.name,
        options.processorName || "processor",
        `Extension '${ext.name}' defines no processors ('processors').`
      )
    );
  }

  const procName =
    options.processorName?.trim() || (procNames.length === 1 ? procNames[0] : "");
  if (!procName || !procs[procName]) {
    throw new CutholError(
      DIAGNOSTICS.EXTENSION_EXECUTION_FAILED(
        ext.name,
        procName || "(belirtilmedi)",
        `Processor not found. Available processors: ${procNames.join(", ")}.`
      )
    );
  }
  const proc = procs[procName];
  const resolvedParams = resolveValidatedParams(
    proc.params,
    options.params,
    ext.name,
    `processor:${procName}`
  );

  const { paths, sequence } = loadSequence(options.workspaceDir);
  const ledger = new MediaLedger(paths.ledgerFile);

  try {
    let inputAbsPath: string;
    let inputHandle: string | null = null;
    const libItem = sequence.library.find((item) => item.handle === options.inputHandleOrPath);
    if (libItem) {
      inputHandle = libItem.handle;
      inputAbsPath = resolveLibraryItemPath(paths.rootDir, libItem);
    } else {
      const candidate = path.isAbsolute(options.inputHandleOrPath)
        ? options.inputHandleOrPath
        : path.resolve(paths.rootDir, options.inputHandleOrPath);
      inputAbsPath = fs.existsSync(candidate)
        ? candidate
        : path.resolve(options.inputHandleOrPath);
    }

    if (!fs.existsSync(inputAbsPath)) {
      throw new CutholError(
        DIAGNOSTICS.MISSING_FILE_ON_DISK(options.inputHandleOrPath, inputAbsPath)
      );
    }

    const { sha256: inputSha256, probe: inputProbe } = probeLocalMediaFile(inputAbsPath, ledger);
    const sortedParamsKeys = Object.keys(resolvedParams).sort();
    const canonicalParams: Record<string, unknown> = {};
    for (const k of sortedParamsKeys) canonicalParams[k] = resolvedParams[k];

    const cacheParts = [
      "cuthol.ext.proc/1",
      inputSha256,
      ext.name,
      ext.version,
      ext.contentHash,
      procName,
      JSON.stringify(canonicalParams),
    ];
    if (proc.audio !== undefined) cacheParts.push(`audio=${proc.audio}`);
    if (proc.timeout_sec !== undefined) cacheParts.push(`timeout_sec=${proc.timeout_sec}`);
    const rawCacheKey = cacheParts.join("|");
    const cacheKey = crypto.createHash("sha256").update(rawCacheKey).digest("hex");

    const scriptAbsPath =
      proc.kind === "node" && proc.script
        ? assertStayInsideDir(ext.dir, proc.script, ext.name)
        : null;

    const securityNotice = {
      manifest_path: ext.manifestPath,
      script_path: scriptAbsPath,
      network_declared: ext.network,
    };

    const inExt = path.extname(inputAbsPath) || (inputProbe.has_video ? ".mp4" : ".wav");
    const outExtRaw = proc.output_ext?.trim() || inExt;
    const outExt = outExtRaw.startsWith(".") ? outExtRaw : `.${outExtRaw}`;

    if (options.dryRun) {
      const cachedHit = ledger.getExtensionProcessorResult<Record<string, unknown>>(
        cacheKey,
        paths.blobsDir
      );
      return {
        extension: ext.name,
        version: ext.version,
        processor: procName,
        kind: proc.kind,
        cached: Boolean(cachedHit),
        cache_key: cacheKey,
        elapsed_ms: Date.now() - startedAt,
        input_handle: inputHandle,
        input_path: inputAbsPath,
        input_sha256: inputSha256,
        output_asset:
          libItem ?? {
            handle: options.targetHandle ?? "aud_dry",
            kind: proc.asset_kind ?? "audio",
            uri: `.cuthol/blobs/ext_${ext.name}_${procName}_${cacheKey.slice(0, 12)}${outExt}`,
            digest_sha256: cacheKey,
            probe: inputProbe,
            analysis_refs: {},
          },
        params: resolvedParams,
        security_notice: securityNotice,
        dry_run: true,
      };
    }

    ensureWorkspaceDirectories(paths);
    let finalOutputPath: string;
    let cached = false;
    let scriptOutput: Record<string, unknown> | null = null;

    const cachedEntry = ledger.getExtensionProcessorResult<{
      script_output?: Record<string, unknown> | null;
    }>(cacheKey, paths.blobsDir);

    if (cachedEntry && fs.existsSync(cachedEntry.outputPath)) {
      cached = true;
      finalOutputPath = cachedEntry.outputPath;
      scriptOutput = cachedEntry.meta?.script_output ?? null;
    } else {
      finalOutputPath = path.join(
        paths.blobsDir,
        `ext_${ext.name}_${procName}_${cacheKey.slice(0, 14)}${outExt}`
      );
      const tmpOutputPath = `${finalOutputPath}.tmp_${process.pid}_${Date.now()}${outExt}`;

      if (proc.kind === "ffmpeg") {
        const ffArgs: string[] = ["-y", "-v", "error", "-i", inputAbsPath];
        const afRaw = proc.audio_filter ?? (!proc.video_filter ? proc.filter : undefined);
        const vfRaw = proc.video_filter;
        if (afRaw) {
          const interpolatedAf = buildAtEmpoChainIfNeeded(
            interpolateFilterTemplate(afRaw, resolvedParams, ext.name, procName)
          );
          ffArgs.push("-af", interpolatedAf);
        }
        if (vfRaw) {
          const interpolatedVf = interpolateFilterTemplate(
            vfRaw,
            resolvedParams,
            ext.name,
            procName
          );
          ffArgs.push("-vf", interpolatedVf);
        }
        if (proc.ffmpeg_args && proc.ffmpeg_args.length > 0) {
          for (const argTpl of proc.ffmpeg_args) {
            ffArgs.push(interpolateFilterTemplate(argTpl, resolvedParams, ext.name, procName));
          }
        }
        if (proc.audio === "drop") {
          ffArgs.push("-an");
        } else if (vfRaw && !afRaw && inputProbe.has_audio && [".mp4", ".mov", ".mkv"].includes(outExt.toLowerCase())) {
          ffArgs.push("-c:a", "copy");
        }
        if (afRaw && !vfRaw && inputProbe.has_video && [".mp4", ".mov", ".mkv"].includes(outExt.toLowerCase())) {
          ffArgs.push("-c:v", "copy");
        }
        ffArgs.push(tmpOutputPath);

        const ffTimeoutMs = resolveExtensionTimeoutMs(proc.timeout_sec, "none");
        const ffProc = spawnSync("ffmpeg", ffArgs, {
          encoding: "utf8",
          maxBuffer: 16 * 1024 * 1024,
          windowsHide: true,
          ...(ffTimeoutMs !== undefined ? { timeout: ffTimeoutMs } : {}),
        });
        if (isSpawnTimeout(ffProc) || ffProc.status !== 0 || !fs.existsSync(tmpOutputPath)) {
          if (fs.existsSync(tmpOutputPath)) {
            try {
              fs.unlinkSync(tmpOutputPath);
            } catch {
              // ignore
            }
          }
          const detail = isSpawnTimeout(ffProc)
            ? extensionTimeoutFailureDetail("ffmpeg run", proc.timeout_sec, "none")
            : `ffmpeg error: ${(ffProc.stderr || ffProc.stdout || "unknown error").trim()}`;
          throw new CutholError(
            DIAGNOSTICS.EXTENSION_EXECUTION_FAILED(ext.name, procName, detail)
          );
        }
      } else {
        // Node processor in isolated child process
        assertScriptRespectsNetworkPolicy(scriptAbsPath!, ext);
        const extFilesBefore = new Map(
          listFilesRecursiveRelative(ext.dir).map((f) => [
            f.path,
            crypto.createHash("sha256").update(fs.readFileSync(path.join(ext.dir, f.path))).digest("hex"),
          ])
        );
        const extHashBefore = hashExtensionDirectory(ext.dir);
        const isolatedTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `cuthol-ext-node-${ext.name}-`));
        const sandboxOutPath = path.join(isolatedTmpDir, `out${outExt}`);
        const extTmpDir = path.join(isolatedTmpDir, SANDBOX_TMP_DIR);
        fs.mkdirSync(extTmpDir);
        const nodeTimeoutMs = resolveExtensionTimeoutMs(proc.timeout_sec, "120");

        try {
          const nodeProc = spawnSync(
            process.execPath,
            [scriptAbsPath!, inputAbsPath, sandboxOutPath, JSON.stringify(resolvedParams)],
            {
              cwd: isolatedTmpDir,
              env: {
                ...process.env,
                CUTHOL_EXT_NAME: ext.name,
                CUTHOL_EXT_VERSION: ext.version,
                CUTHOL_EXT_INPUT: inputAbsPath,
                CUTHOL_EXT_OUTPUT: sandboxOutPath,
                CUTHOL_EXT_PARAMS: JSON.stringify(resolvedParams),
                CUTHOL_EXT_TMP: extTmpDir,
              },
              encoding: "utf8",
              ...(nodeTimeoutMs !== undefined ? { timeout: nodeTimeoutMs } : {}),
              maxBuffer: 8 * 1024 * 1024,
              windowsHide: true,
            }
          );

          const extHashAfter = hashExtensionDirectory(ext.dir);
          if (extHashAfter !== extHashBefore) {
            // Clean up any unauthorized files written into extension directory
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
                `The processor script attempted to write inside the extension folder.`
              )
            );
          }

          // `tmp/` is the script scratch directory; anything else beside the output is a violation.
          const sandboxEntries = fs.readdirSync(isolatedTmpDir);
          const extraEntries = sandboxEntries.filter(
            (entry) => entry !== path.basename(sandboxOutPath) && entry !== SANDBOX_TMP_DIR
          );
          if (extraEntries.length > 0) {
            throw new CutholError(
              DIAGNOSTICS.EXTENSION_SECURITY_VIOLATION(
                ext.name,
                `The processor script wrote a file outside the output path Cuthol gave it ('${extraEntries.join(", ")}').`
              )
            );
          }

          if (isSpawnTimeout(nodeProc)) {
            throw new CutholError(
              DIAGNOSTICS.EXTENSION_EXECUTION_FAILED(
                ext.name,
                procName,
                extensionTimeoutFailureDetail("Node script", proc.timeout_sec, "120")
              )
            );
          }

          if (nodeProc.status !== 0) {
            throw new CutholError(
              DIAGNOSTICS.EXTENSION_EXECUTION_FAILED(
                ext.name,
                procName,
                `Node script exit code ${nodeProc.status}: ${(nodeProc.stderr || nodeProc.stdout || "").trim()}`
              )
            );
          }

          if (!fs.existsSync(sandboxOutPath)) {
            throw new CutholError(
              DIAGNOSTICS.EXTENSION_EXECUTION_FAILED(
                ext.name,
                procName,
                `The Node script did not produce the expected output file.`
              )
            );
          }

          const stdoutTrimmed = (nodeProc.stdout || "").trim();
          if (stdoutTrimmed) {
            const lastLine = stdoutTrimmed.split(/\r?\n/).pop()!.trim();
            try {
              const parsed = JSON.parse(lastLine);
              if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                scriptOutput = parsed as Record<string, unknown>;
              }
            } catch {
              throw new CutholError(
                DIAGNOSTICS.EXTENSION_EXECUTION_FAILED(
                  ext.name,
                  procName,
                  `The Node script did not return valid JSON on stdout: '${lastLine.slice(0, 120)}'`
                )
              );
            }
          }

          fs.copyFileSync(sandboxOutPath, tmpOutputPath);
        } finally {
          fs.rmSync(extTmpDir, { recursive: true, force: true });
          fs.rmSync(isolatedTmpDir, { recursive: true, force: true });
        }
      }

      fs.renameSync(tmpOutputPath, finalOutputPath);
      ledger.setExtensionProcessorResult(cacheKey, finalOutputPath, {
        extension: ext.name,
        version: ext.version,
        processor: procName,
        params: resolvedParams,
        script_output: scriptOutput,
      });
    }

    const { sha256: outSha256, probe: outProbe, kind: detectedKind } = probeLocalMediaFile(
      finalOutputPath,
      ledger
    );
    const finalKind: AssetKind = proc.asset_kind ?? detectedKind;

    const { result: outputAsset } = commitVerifiedMutation(
      options.workspaceDir,
      `extension.run:${ext.name}.${procName}`,
      (seq) => {
        const existing = seq.library.find(
          (item) =>
            item.digest_sha256 === outSha256 &&
            item.kind === finalKind &&
            (!options.targetHandle || item.handle === options.targetHandle)
        );
        if (existing) {
          return existing;
        }
        const handle =
          options.targetHandle ?? allocateNextHandle(seq, assetPrefixForKind(finalKind));
        if (seq.library.some((item) => item.handle === handle)) {
          throw new CutholError(DIAGNOSTICS.DUPLICATE_HANDLE(handle));
        }
        const relUri = path.relative(paths.rootDir, finalOutputPath).replace(/\\/g, "/");
        const uri = relUri.startsWith("..") ? finalOutputPath.replace(/\\/g, "/") : relUri;
        const item: LibraryItem = {
          handle,
          kind: finalKind,
          uri,
          digest_sha256: outSha256,
          probe: outProbe,
          analysis_refs: {},
        };
        seq.library.push(item);
        return item;
      }
    );

    return {
      extension: ext.name,
      version: ext.version,
      processor: procName,
      kind: proc.kind,
      cached,
      cache_key: cacheKey,
      elapsed_ms: Date.now() - startedAt,
      input_handle: inputHandle,
      input_path: inputAbsPath,
      input_sha256: inputSha256,
      output_asset: outputAsset,
      params: resolvedParams,
      security_notice: securityNotice,
      diagnostics: avDurationDiagnostics(finalOutputPath, outProbe.fps, outputAsset.handle),
      ...(scriptOutput ? { script_output: scriptOutput } : {}),
    };
  } finally {
    ledger.close();
  }
}

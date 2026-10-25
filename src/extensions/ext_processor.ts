// Runs extension processors (ffmpeg filter chains or node scripts) with cached outputs (split out of manager.ts).
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
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
          `Bilinmeyen parametre '${k}' (geçerli parametreler: ${Object.keys(defs).join(", ")}).`
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
            `Zorunlu parametre '${k}' eksik.`
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
            `'${k}' parametresi sayı olmalıdır (verilen: ${JSON.stringify(val)}).`
          )
        );
      }
      if (def.min !== undefined && n < def.min) {
        throw new CutholError(
          DIAGNOSTICS.EXTENSION_EXECUTION_FAILED(
            extName,
            targetLabel,
            `'${k}' parametresi (${n}) alt sınırın (${def.min}) altında.`
          )
        );
      }
      if (def.max !== undefined && n > def.max) {
        throw new CutholError(
          DIAGNOSTICS.EXTENSION_EXECUTION_FAILED(
            extName,
            targetLabel,
            `'${k}' parametresi (${n}) üst sınırın (${def.max}) üzerinde.`
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
          `'${k}' parametresi şu değerlerden biri olmalıdır: ${def.enum.join(", ")}.`
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
          `Filtre şablonundaki '{{${key}}}' parametresi için değer verilmedi.`
        )
      );
    }
    const val = String(params[key]);
    if (/[;&|`$\r\n]/.test(val)) {
      throw new CutholError(
        DIAGNOSTICS.EXTENSION_SECURITY_VIOLATION(
          extName,
          `'${key}' filtre parametresi güvenlik açısından izin verilmeyen karakterler içeriyor.`
        )
      );
    }
    return val;
  });
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
        `'${ext.name}' eklentisinde tanımlı hiçbir işlemci ('processors') yok.`
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
        `İşlemci bulunamadı. Mevcut işlemciler: ${procNames.join(", ")}.`
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

    const rawCacheKey = [
      "cuthol.ext.proc/1",
      inputSha256,
      ext.name,
      ext.version,
      ext.contentHash,
      procName,
      JSON.stringify(canonicalParams),
    ].join("|");
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
        if (vfRaw && !afRaw && inputProbe.has_audio && [".mp4", ".mov", ".mkv"].includes(outExt.toLowerCase())) {
          ffArgs.push("-c:a", "copy");
        }
        if (afRaw && !vfRaw && inputProbe.has_video && [".mp4", ".mov", ".mkv"].includes(outExt.toLowerCase())) {
          ffArgs.push("-c:v", "copy");
        }
        ffArgs.push(tmpOutputPath);

        const ffProc = spawnSync("ffmpeg", ffArgs, {
          encoding: "utf8",
          maxBuffer: 16 * 1024 * 1024,
          windowsHide: true,
        });
        if (ffProc.status !== 0 || !fs.existsSync(tmpOutputPath)) {
          if (fs.existsSync(tmpOutputPath)) {
            try {
              fs.unlinkSync(tmpOutputPath);
            } catch {
              // ignore
            }
          }
          throw new CutholError(
            DIAGNOSTICS.EXTENSION_EXECUTION_FAILED(
              ext.name,
              procName,
              `ffmpeg hatası: ${(ffProc.stderr || ffProc.stdout || "bilinmeyen hata").trim()}`
            )
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
              },
              encoding: "utf8",
              timeout: 120_000,
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
                `İşlemci betiği eklenti klasörünün içine yazma girişiminde bulundu.`
              )
            );
          }

          // Check if the script wrote any unauthorized files in isolatedTmpDir other than sandboxOutPath
          const sandboxEntries = fs.readdirSync(isolatedTmpDir);
          const extraEntries = sandboxEntries.filter((e) => e !== path.basename(sandboxOutPath));
          if (extraEntries.length > 0) {
            throw new CutholError(
              DIAGNOSTICS.EXTENSION_SECURITY_VIOLATION(
                ext.name,
                `İşlemci betiği Cuthol'un verdiği çıktı yolu dışına ('${extraEntries.join(", ")}') dosya yazdı.`
              )
            );
          }

          if (nodeProc.status !== 0) {
            throw new CutholError(
              DIAGNOSTICS.EXTENSION_EXECUTION_FAILED(
                ext.name,
                procName,
                `Node betiği çıkış kodu ${nodeProc.status}: ${(nodeProc.stderr || nodeProc.stdout || "").trim()}`
              )
            );
          }

          if (!fs.existsSync(sandboxOutPath)) {
            throw new CutholError(
              DIAGNOSTICS.EXTENSION_EXECUTION_FAILED(
                ext.name,
                procName,
                `Node betiği beklenen çıktı dosyasını üretmedi.`
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
                  `Node betiği stdout üzerinde geçerli bir JSON döndürmedi: '${lastLine.slice(0, 120)}'`
                )
              );
            }
          }

          fs.copyFileSync(sandboxOutPath, tmpOutputPath);
        } finally {
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
      ...(scriptOutput ? { script_output: scriptOutput } : {}),
    };
  } finally {
    ledger.close();
  }
}

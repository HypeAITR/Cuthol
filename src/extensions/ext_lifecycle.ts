// Extension create/promote/remove and per-project enable/disable (split out of manager.ts).
import fs from "node:fs";
import path from "node:path";
import { CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import {
  MountedExtensionRef
} from "../core/schema.js";
import {
  loadSequence
} from "../core/workspace.js";
import { commitVerifiedMutation } from "../verify/gates.js";
import { syncAllCompositionBridges } from "../compositor/bridge_exporter.js";
import { ExtensionScope, EXTENSION_NAME_RE, ExtensionManifest, EXTENSION_MANIFEST_FILENAME } from "./ext_manifest.js";
import { resolveExtensionRoots, loadExtensionFromDir, resolveExtension } from "./ext_registry.js";

export type ExtensionTemplateKind =
  | "full"
  | "helper"
  | "processor_ffmpeg"
  | "processor_node"
  | "assets"
  | "recipe"
  | "planner";

export function createExtension(options: {
  name: string;
  workspaceDir?: string | null;
  scope?: ExtensionScope;
  template?: ExtensionTemplateKind;
  description?: string;
  version?: string;
  network?: boolean;
  overwrite?: boolean;
}): {
  name: string;
  scope: ExtensionScope;
  dir: string;
  manifest_path: string;
  content_hash: string;
  files_created: string[];
} {
  const cleanName = (options.name || "").trim();
  if (!EXTENSION_NAME_RE.test(cleanName)) {
    throw new CutholError(
      DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
        cleanName || "extension",
        `Invalid extension name '${cleanName}'. Extension names must start lowercase and contain only [a-z0-9_-].`
      )
    );
  }

  const { projectExtensionsDir, persistentExtensionsDir } = resolveExtensionRoots(
    options.workspaceDir
  );
  const scope: ExtensionScope =
    options.scope ?? (projectExtensionsDir ? "project" : "persistent");

  let targetRoot: string | null =
    scope === "project" ? projectExtensionsDir : persistentExtensionsDir;
  if (!targetRoot && scope === "project" && options.workspaceDir) {
    targetRoot = path.join(path.resolve(options.workspaceDir), ".cuthol", "extensions");
  }
  if (!targetRoot) {
    throw new CutholError(
      DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
        cleanName,
        scope === "persistent"
          ? "The persistent extensions folder is disabled ('CUTHOL_EXTENSIONS_DIR=0'). Use '--scope project' or open the 'CUTHOL_EXTENSIONS_DIR' folder."
          : "The project extensions folder could not be resolved. Pass a workspace ('--dir') or use '--scope persistent'."
      )
    );
  }

  const extDir = path.join(targetRoot, cleanName);
  if (fs.existsSync(extDir) && !options.overwrite) {
    throw new CutholError(DIAGNOSTICS.EXTENSION_ALREADY_EXISTS(cleanName, extDir));
  }

  fs.mkdirSync(extDir, { recursive: true });
  const tpl: ExtensionTemplateKind = options.template ?? "full";
  const version = options.version?.trim() || "1.0.0";
  const description =
    options.description?.trim() || `Cuthol '${cleanName}' extension (${tpl}).`;

  const manifest: ExtensionManifest = {
    schema_version: "1.0.0",
    name: cleanName,
    version,
    description,
    ...(options.network ? { network: true } : {}),
    guide: "README.md",
  };

  const filesCreated: string[] = [];

  if (tpl === "full" || tpl === "helper") {
    manifest.helper = "helper.js";
    const helperContent = [
      `/* Cuthol Composition Helper: window.__cuthol.ext.${cleanName} */`,
      `(function (root) {`,
      `  var C = (root && root.__cuthol) ? root.__cuthol : (root.__cuthol = {});`,
      `  C.ext = C.ext || {};`,
      `  C.ext[${JSON.stringify(cleanName)}] = {`,
      `    version: ${JSON.stringify(version)},`,
      `    sample: function (t) {`,
      `      return typeof C.audio === "function" ? C.audio("mid", t) : 0;`,
      `    }`,
      `  };`,
      `})(typeof window !== "undefined" ? window : globalThis);`,
      ``,
    ].join("\n");
    fs.writeFileSync(path.join(extDir, "helper.js"), helperContent, "utf8");
    filesCreated.push("helper.js");
  }

  if (tpl === "full" || tpl === "assets") {
    manifest.assets = "assets";
    const assetsDir = path.join(extDir, "assets");
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.writeFileSync(
      path.join(assetsDir, "info.json"),
      JSON.stringify({ extension: cleanName, version }, null, 2),
      "utf8"
    );
    filesCreated.push("assets/info.json");
  }

  if (tpl === "full" || tpl === "processor_ffmpeg") {
    manifest.processors = {
      ...(manifest.processors ?? {}),
      atempo: {
        kind: "ffmpeg",
        description: "Speeds up or slows down audio using FFmpeg atempo filter.",
        output_ext: ".wav",
        asset_kind: "audio",
        params: {
          rate: {
            type: "number",
            default: 1.25,
            min: 0.5,
            max: 2.0,
            description: "Tempo multiplier (0.5 .. 2.0).",
          },
        },
        audio_filter: "atempo={{rate}}",
      },
    };
  }

  if (tpl === "processor_node") {
    manifest.processors = {
      ...(manifest.processors ?? {}),
      transform: {
        kind: "node",
        description: "Transforms an input file via a sandboxed child-process Node script.",
        script: "processor.js",
        params: {
          gain_db: {
            type: "number",
            default: 0,
            description: "Optional gain offset parameter.",
          },
        },
      },
    };
    const procScript = [
      `#!/usr/bin/env node`,
      `const fs = require("node:fs");`,
      `const [inputPath, outputPath, rawParams] = process.argv.slice(2);`,
      `const params = rawParams ? JSON.parse(rawParams) : {};`,
      `fs.copyFileSync(inputPath, outputPath);`,
      `process.stdout.write(JSON.stringify({ ok: true, params }) + "\\n");`,
      ``,
    ].join("\n");
    fs.writeFileSync(path.join(extDir, "processor.js"), procScript, "utf8");
    filesCreated.push("processor.js");
  }

  if (tpl === "full" || tpl === "recipe") {
    manifest.recipes = {
      ...(manifest.recipes ?? {}),
      quick_vo: {
        description: "Runs the atempo processor on an audio handle and places it on ln_vo.",
        params: {
          handle: { type: "string", required: true, description: "Input audio library handle." },
          rate: { type: "number", default: 1.25, description: "Playback rate for atempo." },
          at: { type: "string", default: "0s", description: "Timeline start position." },
        },
        steps: [
          {
            id: "speed_step",
            tool: "extension",
            action: "run",
            args: {
              name: cleanName,
              processor: "atempo",
              input: "{{handle}}",
              params: { rate: "{{rate}}" },
            },
          },
          {
            id: "place_vo",
            tool: "lane",
            action: "add_cue",
            args: {
              lane: "ln_vo",
              asset: "{{steps.speed_step.handle}}",
              at: "{{at}}",
              duration: "{{steps.speed_step.duration_ms}}",
            },
          },
        ],
      },
    };
  }

  if (tpl === "planner") {
    manifest.planners = {
      ...(manifest.planners ?? {}),
      event_sfx: {
        description: "Reads composition declared events and word timings, and proposes SFX cues.",
        script: "planner.js",
        params: {
          asset_handle: {
            type: "string",
            required: false,
            description: "SFX library handle to place at matching events.",
          },
          lane_id: {
            type: "string",
            default: "ln_sfx",
            description: "Target audio lane for generated SFX cues.",
          },
          gain_db: {
            type: "number",
            default: -6,
            description: "Gain in dB for generated SFX cues.",
          },
        },
      },
    };
    const plannerScript = [
      `#!/usr/bin/env node`,
      `const fs = require("node:fs");`,
      `const [snapshotPath, outputPath, rawParams] = process.argv.slice(2);`,
      `const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));`,
      `const params = rawParams ? JSON.parse(rawParams) : (snapshot.params || {});`,
      `const laneId = params.lane_id || "ln_sfx";`,
      `const gainDb = typeof params.gain_db === "number" ? params.gain_db : -6;`,
      `const defaultAsset = params.asset_handle || (snapshot.sequence.library.find((a) => a.kind === "audio")?.handle);`,
      `const cues = [];`,
      `for (const ev of snapshot.events || []) {`,
      `  const assetHandle = (ev.meta && ev.meta.asset_handle) || defaultAsset;`,
      `  if (!assetHandle) continue;`,
      `  cues.push({`,
      `    lane_id: laneId,`,
      `    kind: "sfx",`,
      `    asset_handle: assetHandle,`,
      `    at_ms: ev.sequence_ms,`,
      `    duration_ms: (ev.meta && ev.meta.duration_ms) || 500,`,
      `    gain_db: (ev.meta && typeof ev.meta.gain_db === "number") ? ev.meta.gain_db : gainDb,`,
      `  });`,
      `}`,
      `fs.writeFileSync(outputPath, JSON.stringify({ cues }, null, 2), "utf8");`,
      ``,
    ].join("\n");
    fs.writeFileSync(path.join(extDir, "planner.js"), plannerScript, "utf8");
    filesCreated.push("planner.js");
  }

  const readmeContent = [
    `# ${cleanName} (v${version})`,
    ``,
    description,
    ``,
    `## Capabilities`,
    manifest.helper ? `- **Composition helper:** \`window.__cuthol.ext.${cleanName}\` (\`${manifest.helper}\`)` : null,
    manifest.assets ? `- **Asset pack:** \`assets/ext/${cleanName}/...\`` : null,
    manifest.processors
      ? `- **Processors:** ${Object.keys(manifest.processors).map((k) => `\`${k}\``).join(", ")}`
      : null,
    manifest.planners
      ? `- **Planners:** ${Object.keys(manifest.planners).map((k) => `\`${k}\``).join(", ")}`
      : null,
    manifest.recipes
      ? `- **Recipes:** ${Object.keys(manifest.recipes).map((k) => `\`${k}\``).join(", ")}`
      : null,
  ]
    .filter(Boolean)
    .join("\n") + "\n";

  fs.writeFileSync(path.join(extDir, "README.md"), readmeContent, "utf8");
  filesCreated.push("README.md");

  const manifestPath = path.join(extDir, EXTENSION_MANIFEST_FILENAME);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  filesCreated.unshift(EXTENSION_MANIFEST_FILENAME);

  const loaded = loadExtensionFromDir(extDir, scope, cleanName);
  return {
    name: loaded.name,
    scope: loaded.scope,
    dir: loaded.dir,
    manifest_path: loaded.manifestPath,
    content_hash: loaded.contentHash,
    files_created: filesCreated,
  };
}

function copyDirectoryRecursiveSync(srcDir: string, destDir: string): void {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.name.startsWith(".tmp")) continue;
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirectoryRecursiveSync(srcPath, destPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

export function promoteExtension(options: {
  name: string;
  workspaceDir: string;
  overwrite?: boolean;
}): {
  name: string;
  version: string;
  from_dir: string;
  persistent_dir: string;
  content_hash: string;
} {
  const projExt = resolveExtension(options.name, options.workspaceDir, "project");
  const { persistentExtensionsDir } = resolveExtensionRoots(options.workspaceDir);
  if (!persistentExtensionsDir) {
    throw new CutholError(
      DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
        projExt.name,
        "The persistent extensions folder is disabled ('CUTHOL_EXTENSIONS_DIR=0')."
      )
    );
  }
  const targetDir = path.join(persistentExtensionsDir, projExt.name);
  if (fs.existsSync(targetDir) && options.overwrite === false) {
    throw new CutholError(DIAGNOSTICS.EXTENSION_ALREADY_EXISTS(projExt.name, targetDir));
  }
  if (fs.existsSync(targetDir)) {
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
  copyDirectoryRecursiveSync(projExt.dir, targetDir);
  const loaded = loadExtensionFromDir(targetDir, "persistent", projExt.name);
  return {
    name: loaded.name,
    version: loaded.version,
    from_dir: projExt.dir,
    persistent_dir: loaded.dir,
    content_hash: loaded.contentHash,
  };
}

export function removeExtension(options: {
  name: string;
  workspaceDir?: string | null;
  scope?: ExtensionScope;
}): {
  name: string;
  removed_scope: ExtensionScope;
  removed_dir: string;
} {
  const ext = resolveExtension(options.name, options.workspaceDir, options.scope);
  fs.rmSync(ext.dir, { recursive: true, force: true });
  return {
    name: ext.name,
    removed_scope: ext.scope,
    removed_dir: ext.dir,
  };
}

export function enableExtensionInWorkspace(options: {
  workspaceDir: string;
  name: string;
  scope?: ExtensionScope;
  dryRun?: boolean;
}): {
  extension: MountedExtensionRef;
  manifest_path: string;
  updated_previous: boolean;
  previous_hash: string | null;
  dry_run?: boolean;
} {
  const ext = resolveExtension(options.name, options.workspaceDir, options.scope);
  const { sequence } = loadSequence(options.workspaceDir);
  const existing = (sequence.extensions ?? []).find((e) => e.name === ext.name) ?? null;

  const newRef: MountedExtensionRef = {
    name: ext.name,
    version: ext.version,
    content_hash: ext.contentHash,
    scope: ext.scope,
    enabled_at: new Date().toISOString(),
  };

  if (options.dryRun) {
    return {
      extension: newRef,
      manifest_path: ext.manifestPath,
      updated_previous: Boolean(existing),
      previous_hash: existing?.content_hash ?? null,
      dry_run: true,
    };
  }

  commitVerifiedMutation(options.workspaceDir, "extension.enable", (seq, paths) => {
    if (!seq.extensions) seq.extensions = [];
    const idx = seq.extensions.findIndex((e) => e.name === ext.name);
    if (idx >= 0) {
      seq.extensions[idx] = newRef;
    } else {
      seq.extensions.push(newRef);
    }
    seq.extensions.sort((a, b) => a.name.localeCompare(b.name));
    try {
      syncAllCompositionBridges(seq, paths, { explicit: true });
    } catch {
      // non-blocking bridge sync
    }
  });

  return {
    extension: newRef,
    manifest_path: ext.manifestPath,
    updated_previous: Boolean(existing),
    previous_hash: existing?.content_hash ?? null,
  };
}

export function disableExtensionInWorkspace(options: {
  workspaceDir: string;
  name: string;
  dryRun?: boolean;
}): {
  disabled: string;
  was_enabled: boolean;
  previous_ref: MountedExtensionRef | null;
  dry_run?: boolean;
} {
  const cleanName = options.name.trim();
  const { sequence } = loadSequence(options.workspaceDir);
  const existing = (sequence.extensions ?? []).find((e) => e.name === cleanName) ?? null;

  if (options.dryRun || !existing) {
    return {
      disabled: cleanName,
      was_enabled: Boolean(existing),
      previous_ref: existing,
      ...(options.dryRun ? { dry_run: true } : {}),
    };
  }

  commitVerifiedMutation(options.workspaceDir, "extension.disable", (seq) => {
    if (!seq.extensions) return;
    seq.extensions = seq.extensions.filter((e) => e.name !== cleanName);
    if (seq.extensions.length === 0) {
      delete seq.extensions;
    }
  });

  return {
    disabled: cleanName,
    was_enabled: true,
    previous_ref: existing,
  };
}

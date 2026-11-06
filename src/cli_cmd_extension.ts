// CLI 'extension' command group handler (split out of cli.ts).
import { CutholError, DIAGNOSTICS } from "./core/diagnostics.js";
import {
  createExtension,
  disableExtensionInWorkspace,
  enableExtensionInWorkspace,
  ExtensionScope,
  ExtensionTemplateKind,
  listExtensions,
  promoteExtension,
  removeExtension,
  resolveExtension,
  runExtensionPlanner,
  runExtensionProcessor,
  runExtensionRecipe,
  showExtension,
} from "./extensions/manager.js";
import { boolFlag, parsePropsJsonFlag, strFlag } from "./cli_args.js";
import {
  CLI_NOT_HANDLED,
  CliCommandContext,
  CliCommandResult,
  emitEnvelopeJson,
} from "./cli_output.js";

export function runExtensionCommand(ctx: CliCommandContext): CliCommandResult {
  const { action, rest, flags, workspaceDir } = ctx;
  const extAction = action ?? "list";
  const scopeRaw = strFlag(flags, "scope") as ExtensionScope | undefined;
  if (extAction === "list") {
    const res = listExtensions(workspaceDir);
    const filtered = scopeRaw
      ? res.extensions.filter((e) => e.scope === scopeRaw)
      : res.extensions;
    emitEnvelopeJson(workspaceDir, "extension.list", {
      ...res,
      extensions: filtered,
    });
    return;
  }

  if (extAction === "create") {
    const name = strFlag(flags, "name") ?? rest[0];
    if (!name) {
      throw new CutholError(
        DIAGNOSTICS.INVALID_EXTENSION_MANIFEST("extension", "Extension name ('--name') is required.")
      );
    }
    const res = createExtension({
      name,
      workspaceDir,
      scope: scopeRaw,
      template: strFlag(flags, "template") as ExtensionTemplateKind | undefined,
      description: strFlag(flags, "description"),
      version: strFlag(flags, "version"),
      network: boolFlag(flags, "network", false),
      overwrite: boolFlag(flags, "overwrite", false),
    });
    emitEnvelopeJson(workspaceDir, "extension.create", { ...res });
    return;
  }

  if (extAction === "show") {
    const name = strFlag(flags, "name") ?? rest[0];
    if (!name) {
      throw new CutholError(
        DIAGNOSTICS.INVALID_EXTENSION_MANIFEST("extension", "Extension name ('--name') is required.")
      );
    }
    const res = showExtension({
      name,
      workspaceDir,
      scope: scopeRaw,
    });
    emitEnvelopeJson(workspaceDir, "extension.show", { ...res });
    return;
  }

  if (extAction === "enable") {
    const name = strFlag(flags, "name") ?? rest[0];
    if (!name) {
      throw new CutholError(
        DIAGNOSTICS.INVALID_EXTENSION_MANIFEST("extension", "Extension name ('--name') is required.")
      );
    }
    const res = enableExtensionInWorkspace({
      workspaceDir,
      name,
      scope: scopeRaw,
      dryRun: boolFlag(flags, "dry-run", false),
    });
    emitEnvelopeJson(workspaceDir, "extension.enable", { ...res });
    return;
  }

  if (extAction === "disable") {
    const name = strFlag(flags, "name") ?? rest[0];
    if (!name) {
      throw new CutholError(
        DIAGNOSTICS.INVALID_EXTENSION_MANIFEST("extension", "Extension name ('--name') is required.")
      );
    }
    const res = disableExtensionInWorkspace({
      workspaceDir,
      name,
      dryRun: boolFlag(flags, "dry-run", false),
    });
    emitEnvelopeJson(workspaceDir, "extension.disable", { ...res });
    return;
  }

  if (extAction === "promote") {
    const name = strFlag(flags, "name") ?? rest[0];
    if (!name) {
      throw new CutholError(
        DIAGNOSTICS.INVALID_EXTENSION_MANIFEST("extension", "Extension name ('--name') is required.")
      );
    }
    const res = promoteExtension({
      name,
      workspaceDir,
      overwrite: boolFlag(flags, "overwrite", true),
    });
    emitEnvelopeJson(workspaceDir, "extension.promote", { ...res });
    return;
  }

  if (extAction === "remove") {
    const name = strFlag(flags, "name") ?? rest[0];
    if (!name) {
      throw new CutholError(
        DIAGNOSTICS.INVALID_EXTENSION_MANIFEST("extension", "Extension name ('--name') is required.")
      );
    }
    const res = removeExtension({
      name,
      workspaceDir,
      scope: scopeRaw,
    });
    emitEnvelopeJson(workspaceDir, "extension.remove", { ...res });
    return;
  }

  if (extAction === "run") {
    const name = strFlag(flags, "name") ?? rest[0];
    if (!name) {
      throw new CutholError(
        DIAGNOSTICS.INVALID_EXTENSION_MANIFEST("extension", "Extension name ('--name') is required.")
      );
    }
    const processorName = strFlag(flags, "processor");
    const plannerName = strFlag(flags, "planner");
    const recipeName = strFlag(flags, "recipe");
    const inputVal = strFlag(flags, "input") ?? strFlag(flags, "handle");
    const rawParams = strFlag(flags, "params");
    const paramsObj = rawParams ? parsePropsJsonFlag(rawParams, "extension.run") : {};
    const dryRun = boolFlag(flags, "dry-run", false);

    const ext = resolveExtension(name, workspaceDir, scopeRaw);
    const hasProcs = Object.keys(ext.manifest.processors ?? {}).length > 0;
    const hasPlanners = Object.keys(ext.manifest.planners ?? {}).length > 0;
    const hasRecipes = Object.keys(ext.manifest.recipes ?? {}).length > 0;

    const shouldRunPlanner =
      Boolean(plannerName) ||
      (!processorName && !recipeName && !inputVal && hasPlanners && !hasRecipes);

    if (shouldRunPlanner) {
      const res = runExtensionPlanner({
        workspaceDir,
        extensionName: name,
        plannerName,
        params: paramsObj,
        scope: scopeRaw,
        dryRun,
      });
      emitEnvelopeJson(workspaceDir, "extension.run", { ...res });
      return;
    }

    const shouldRunRecipe =
      Boolean(recipeName) || (!processorName && !inputVal && hasRecipes && !hasProcs);

    if (shouldRunRecipe) {
      const res = runExtensionRecipe({
        workspaceDir,
        extensionName: name,
        recipeName,
        params: paramsObj,
        scope: scopeRaw,
        dryRun,
      });
      emitEnvelopeJson(workspaceDir, "extension.run", { ...res });
      return;
    }

    if (!inputVal) {
      throw new CutholError(
        DIAGNOSTICS.EXTENSION_EXECUTION_FAILED(
          name,
          processorName || "processor",
          "Running a processor requires '--input <handle|path>' (or '--handle')."
        )
      );
    }
    const res = runExtensionProcessor({
      workspaceDir,
      extensionName: name,
      processorName,
      inputHandleOrPath: inputVal,
      targetHandle: strFlag(flags, "target-handle"),
      params: paramsObj,
      scope: scopeRaw,
      dryRun,
    });
    emitEnvelopeJson(workspaceDir, "extension.run", { ...res });
    return;
  }
  return CLI_NOT_HANDLED;
}

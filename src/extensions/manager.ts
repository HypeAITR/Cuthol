/**
 * Cuthol Extension Environment (`src/extensions/manager.ts`).
 *
 * Provides a clean, deterministic extension system for AI agents:
 * - Persistent extensions in `~/.cuthol/extensions/<name>/` (redirectable via `CUTHOL_EXTENSIONS_DIR` / `CUTHOL_CACHE_DIR`).
 * - Project-local (temporary) extensions in `<project>/.cuthol/extensions/<name>/` (overrides persistent on name collision).
 * - Closed, validated manifest (`cuthol-extension.json`) with 5 optional capability kinds:
 *   1. Composition helper (`helper`) -> injected after `cuthol-runtime.js` as `window.__cuthol.ext.<name>`
 *   2. Asset pack (`assets`) -> synced to `assets/ext/<name>/...` in mounted compositions
 *   3. Media processor (`processors`) -> declarative `ffmpeg` filter chains or sandboxed child-process `node` scripts,
 *      cached by `(input_digest + ext_version + ext_hash + params)` and ingested into the library with journal undo
 *   4. Recipe (`recipes`) -> parameterized sequence of Cuthol actions committed as a single atomic undo step
 *   5. Guide (`guide` / `README.md`) -> readable via `guide(topic="ext:<name>")`
 */

export { EXTENSION_MANIFEST_FILENAME, assertStayInsideDir, assertScriptRespectsNetworkPolicy, validateExtensionManifest } from "./ext_manifest.js";
export type { ExtensionScope, ExtensionParamDef, ExtensionProcessorSpec, ExtensionRecipeStepSpec, ExtensionRecipeSpec, ExtensionPlannerSpec, ExtensionManifest, ResolvedExtension, ExtensionListItem } from "./ext_manifest.js";
export { hashExtensionDirectory, resolveExtensionRoots, loadExtensionFromDir, resolveExtension, listExtensions, showExtension } from "./ext_registry.js";
export { createExtension, promoteExtension, removeExtension, enableExtensionInWorkspace, disableExtensionInWorkspace } from "./ext_lifecycle.js";
export type { ExtensionTemplateKind } from "./ext_lifecycle.js";
export { runExtensionProcessor } from "./ext_processor.js";
export { runExtensionRecipe } from "./ext_recipe.js";
export { extractCompositionDeclaredEvents, buildPlannerSnapshot } from "./ext_events.js";
export type { CompositionDeclaredEvent, PlannerCompositionSnapshot, CutholPlannerSnapshot } from "./ext_events.js";
export { runExtensionPlanner } from "./ext_planner.js";


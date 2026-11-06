/**
 * Agent Skill Installer (`src/core/skills_install.ts`).
 *
 * Cuthol teaches agents through skill files (`skills/<name>/SKILL.md` plus optional
 * `skills/<name>/references/*.md`). This module copies those skills into the skill
 * folders of the agent tools installed on the machine, keeps them up to date, and
 * resolves MCP `guide` topics from the same scan so both surfaces always agree.
 *
 * Safety rules:
 * - A target is only used when the agent's own home folder already exists; folders
 *   for tools the user does not have are never created.
 * - Every installed skill carries a `.cuthol-skill.json` marker (package version,
 *   content hash, install time, source path). Updates overwrite only skills whose
 *   files still match the recorded hash; user edits are reported as `modified` and
 *   kept unless `--force` is passed. Folders without a marker are never touched.
 * - Writes are atomic (build in a temp folder next to the destination, then rename),
 *   which also works on Windows where rename cannot replace an existing folder.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT_DIR = path.resolve(MODULE_DIR, "../..");

export const MAIN_SKILL_NAME = "cuthol";
export const SKILL_MARKER_FILE = ".cuthol-skill.json";
export const SKILLS_AUTO_ENV = "CUTHOL_SKILLS_AUTO";
export const SKILLS_DIR_ENV = "CUTHOL_SKILLS_DIR";
const AUTO_INSTALL_MARKER_REL = path.join(".cuthol", "skills-installed.json");

let cachedPackageVersion: string | null = null;

// ---------------------------------------------------------------------------
// Agent targets: the single commented table. Detection = the agent's own home
// folder exists. The `skills/` subfolder is created on install when missing.
// ---------------------------------------------------------------------------

export interface AgentTarget {
  /** Stable id used by `--agent` and in reports. */
  id: string;
  /** The agent tool's own home folder; must already exist to be detected. */
  baseDir: string;
  /** Where skill folders live (`<baseDir>/skills`). */
  skillsDir: string;
}

export interface SelectedTarget extends AgentTarget {
  detected: boolean;
}

interface AgentTargetDef {
  id: string;
  /** Resolve the agent's home folder for a user home folder. */
  baseDir: (homeDir: string) => string;
}

function envDir(name: string): string | null {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return null;
  return path.resolve(raw.trim());
}

const AGENT_TARGET_DEFS: AgentTargetDef[] = [
  // Claude Code reads `<config>/skills/`; the config folder moves with the env var.
  { id: "claude-code", baseDir: (home) => envDir("CLAUDE_CONFIG_DIR") ?? path.join(home, ".claude") },
  // Codex reads `<home>/skills/`; same env override pattern.
  { id: "codex", baseDir: (home) => envDir("CODEX_HOME") ?? path.join(home, ".codex") },
  // Cursor, Gemini CLI and GitHub Copilot keep a fixed dot-folder under home.
  { id: "cursor", baseDir: (home) => path.join(home, ".cursor") },
  { id: "gemini-cli", baseDir: (home) => path.join(home, ".gemini") },
  { id: "copilot", baseDir: (home) => path.join(home, ".copilot") },
  // OpenCode follows XDG (`$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode`).
  {
    id: "opencode",
    baseDir: (home) => {
      const xdg = envDir("XDG_CONFIG_HOME");
      return xdg ? path.join(xdg, "opencode") : path.join(home, ".config", "opencode");
    },
  },
  // Shared folder read by several tools.
  { id: "agents", baseDir: (home) => path.join(home, ".agents") },
];

export const AGENT_IDS: string[] = AGENT_TARGET_DEFS.map((d) => d.id);

export function isValidAgentId(id: string): boolean {
  return AGENT_TARGET_DEFS.some((d) => d.id === id);
}

export function resolveHomeDir(): string {
  return os.homedir();
}

export function defaultBaseDirForAgent(id: string, homeDir?: string): string {
  const def = AGENT_TARGET_DEFS.find((d) => d.id === id);
  if (!def) throw new Error(`Unknown agent id '${id}'. | Suggestion: use one of: ${AGENT_IDS.join(", ")}.`);
  return def.baseDir(homeDir ?? resolveHomeDir());
}

function isExistingDir(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

export function detectAgentTargets(homeDir?: string): AgentTarget[] {
  const home = homeDir ?? resolveHomeDir();
  const out: AgentTarget[] = [];
  for (const def of AGENT_TARGET_DEFS) {
    const baseDir = def.baseDir(home);
    if (!isExistingDir(baseDir)) continue;
    out.push({ id: def.id, baseDir, skillsDir: path.join(baseDir, "skills") });
  }
  return out;
}

export function resolveSelectedTargets(options?: {
  ids?: string[];
  customDir?: string;
  homeDir?: string;
}): SelectedTarget[] {
  const home = options?.homeDir ?? resolveHomeDir();
  const detected = detectAgentTargets(home);
  const out: SelectedTarget[] = [];
  const ids = options?.ids;
  if (ids && ids.length > 0) {
    for (const id of ids) {
      if (!isValidAgentId(id)) {
        throw new Error(`Unknown agent id '${id}'. | Suggestion: use one of: ${AGENT_IDS.join(", ")}.`);
      }
      const hit = detected.find((t) => t.id === id);
      if (hit) out.push({ ...hit, detected: true });
      else {
        const baseDir = defaultBaseDirForAgent(id, home);
        out.push({ id, baseDir, skillsDir: path.join(baseDir, "skills"), detected: false });
      }
    }
  } else {
    for (const target of detected) out.push({ ...target, detected: true });
  }
  if (options?.customDir) {
    const skillsDir = path.resolve(options.customDir);
    out.push({ id: "custom", baseDir: skillsDir, skillsDir, detected: true });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Package skills: scan, frontmatter, hashing.
// ---------------------------------------------------------------------------

export interface SkillInfo {
  name: string;
  dir: string;
  description: string;
  /** Markdown reference file names under `references/` (sorted, with extension). */
  references: string[];
}

export function resolvePackageSkillsDir(): string {
  const override = envDir(SKILLS_DIR_ENV);
  return override ?? path.join(PACKAGE_ROOT_DIR, "skills");
}

export function readPackageVersion(): string {
  if (cachedPackageVersion) return cachedPackageVersion;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT_DIR, "package.json"), "utf8")) as {
      version?: string;
    };
    cachedPackageVersion = pkg.version ?? "0.0.0";
  } catch {
    cachedPackageVersion = "0.0.0";
  }
  return cachedPackageVersion;
}

/** Read the `name`/`description` frontmatter of a `SKILL.md` (folded `>` form supported). */
function parseSkillFrontmatter(skillFile: string): { name: string; description: string } {
  let name = "";
  let description = "";
  try {
    const text = fs.readFileSync(skillFile, "utf8");
    const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) return { name, description };
    const lines = match[1].split(/\r?\n/);
    let collectingDescription = false;
    const descriptionLines: string[] = [];
    for (const line of lines) {
      const keyMatch = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (keyMatch && !line.startsWith(" ") && !line.startsWith("\t")) {
        collectingDescription = false;
        if (keyMatch[1] === "name") name = keyMatch[2].trim();
        else if (keyMatch[1] === "description") {
          const rest = keyMatch[2].trim();
          if (rest !== "" && rest !== ">" && rest !== "|") descriptionLines.push(rest);
          collectingDescription = true;
        }
        continue;
      }
      if (collectingDescription && (line.startsWith(" ") || line.startsWith("\t") || line.trim() === "")) {
        descriptionLines.push(line.trim());
      } else if (collectingDescription && line.trim() !== "") {
        collectingDescription = false;
      }
    }
    description = descriptionLines.join(" ").replace(/\s+/g, " ").trim();
  } catch {
    // Unreadable frontmatter: the skill is still usable, only its listing is bare.
  }
  return { name, description };
}

/**
 * Find every skill in a `skills/` folder: each subfolder with a `SKILL.md`.
 * The list is never fixed in code so later skills are picked up automatically.
 */
export function scanSkills(skillsDir?: string): SkillInfo[] {
  const dir = skillsDir ?? resolvePackageSkillsDir();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    throw new Error(
      `Skills folder not found: '${dir}' (${err instanceof Error ? err.message : String(err)}). | Suggestion: reinstall the Cuthol package.`
    );
  }
  const out: SkillInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const skillDir = path.join(dir, entry.name);
    if (!fs.existsSync(path.join(skillDir, "SKILL.md"))) continue;
    const { description } = parseSkillFrontmatter(path.join(skillDir, "SKILL.md"));
    const references: string[] = [];
    const referencesDir = path.join(skillDir, "references");
    if (isExistingDir(referencesDir)) {
      for (const file of fs.readdirSync(referencesDir)) {
        if (file.toLowerCase().endsWith(".md")) references.push(file);
      }
    }
    out.push({ name: entry.name, dir: skillDir, description, references: references.sort() });
  }
  out.sort((a, b) =>
    a.name === MAIN_SKILL_NAME ? -1 : b.name === MAIN_SKILL_NAME ? 1 : a.name.localeCompare(b.name)
  );
  return out;
}

function listFilesRecursive(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === SKILL_MARKER_FILE) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) out.push(path.relative(root, full));
    }
  }
  return out.sort();
}

/** Content hash of a skill folder (relative paths + bytes; the marker itself excluded). */
export function hashSkillDir(dir: string): string {
  const hash = crypto.createHash("sha256");
  for (const rel of listFilesRecursive(dir)) {
    hash.update(`${rel}\0`);
    hash.update(fs.readFileSync(path.join(dir, rel)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export interface SkillMarker {
  package_version: string;
  content_hash: string;
  installed_at: string;
  source_path: string;
}

export function readSkillMarker(skillDir: string): SkillMarker | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(skillDir, SKILL_MARKER_FILE), "utf8")) as Partial<SkillMarker>;
    if (typeof parsed.package_version !== "string" || typeof parsed.content_hash !== "string") return null;
    return {
      package_version: parsed.package_version,
      content_hash: parsed.content_hash,
      installed_at: typeof parsed.installed_at === "string" ? parsed.installed_at : "",
      source_path: typeof parsed.source_path === "string" ? parsed.source_path : "",
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Status, install, remove, list.
// ---------------------------------------------------------------------------

export type SkillStatus = "installed" | "outdated" | "modified" | "missing";

export interface SkillState {
  name: string;
  status: SkillStatus;
  /** False when the folder exists but was not installed by Cuthol (no marker). */
  managed: boolean;
  installed_version?: string;
  note?: string;
}

export function inspectTargetSkills(
  targetSkillsDir: string,
  skills: SkillInfo[],
  packageVersion: string
): SkillState[] {
  return skills.map((skill) => {
    const dest = path.join(targetSkillsDir, skill.name);
    if (!isExistingDir(dest)) {
      return { name: skill.name, status: "missing", managed: true };
    }
    const markerPath = path.join(dest, SKILL_MARKER_FILE);
    if (!fs.existsSync(markerPath)) {
      return {
        name: skill.name,
        status: "modified",
        managed: false,
        note: "Not installed by Cuthol; left untouched.",
      };
    }
    const marker = readSkillMarker(dest);
    const currentHash = hashSkillDir(dest);
    if (!marker || marker.content_hash !== currentHash) {
      return {
        name: skill.name,
        status: "modified",
        managed: true,
        ...(marker ? { installed_version: marker.package_version } : {}),
        note: "Changed after installation; kept. Reinstall with --force to overwrite.",
      };
    }
    if (marker.package_version !== packageVersion || hashSkillDir(skill.dir) !== currentHash) {
      return { name: skill.name, status: "outdated", managed: true, installed_version: marker.package_version };
    }
    return { name: skill.name, status: "installed", managed: true, installed_version: marker.package_version };
  });
}

let installCounter = 0;

function uniqueSiblingName(parent: string, prefix: string, skillName: string): string {
  installCounter += 1;
  return path.join(parent, `${prefix}${skillName}-${process.pid}-${installCounter}-${Date.now()}`);
}

/**
 * Copy a package skill into place atomically: build the full folder (files plus a
 * fresh marker) under a temp name in the same folder, then rename it over the
 * destination. The old folder is first renamed aside and restored on failure, so a
 * crash never leaves a half-written skill behind.
 */
function atomicInstallSkill(skill: SkillInfo, dest: string, packageVersion: string): void {
  const parent = path.dirname(dest);
  fs.mkdirSync(parent, { recursive: true });
  const staging = uniqueSiblingName(parent, ".cuthol-staging-", skill.name);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.cpSync(skill.dir, staging, { recursive: true });
  const marker: SkillMarker = {
    package_version: packageVersion,
    content_hash: hashSkillDir(staging),
    installed_at: new Date().toISOString(),
    source_path: skill.dir,
  };
  fs.writeFileSync(path.join(staging, SKILL_MARKER_FILE), JSON.stringify(marker, null, 2), "utf8");
  const hadDest = isExistingDir(dest);
  const backup = hadDest ? uniqueSiblingName(parent, ".cuthol-backup-", skill.name) : null;
  try {
    if (hadDest && backup) fs.renameSync(dest, backup);
    fs.renameSync(staging, dest);
  } catch (err) {
    try {
      fs.rmSync(staging, { recursive: true, force: true });
      if (hadDest && backup && !isExistingDir(dest)) fs.renameSync(backup, dest);
    } catch {
      // Best effort; report the original failure below.
    }
    throw new Error(
      `Cannot install skill '${skill.name}' into '${dest}' (${err instanceof Error ? err.message : String(err)}). | Suggestion: check write permissions for the target skills folder.`
    );
  }
  if (backup) fs.rmSync(backup, { recursive: true, force: true });
}

export interface TargetInstallResult {
  id: string;
  skills_dir: string;
  detected: boolean;
  installed: string[];
  updated: string[];
  unchanged: string[];
  skipped_modified: Array<{ name: string; reason: string }>;
  removed_stale: string[];
  skipped?: string;
  error?: string;
}

export interface InstallReport {
  package_version: string;
  skills: string[];
  targets: TargetInstallResult[];
}

export interface InstallOptions {
  targets?: SelectedTarget[];
  skillsDir?: string;
  packageVersion?: string;
  force?: boolean;
}

function resolveInstallInput(options?: InstallOptions): {
  skills: SkillInfo[];
  packageVersion: string;
  targets: SelectedTarget[];
} {
  const skillsDir = options?.skillsDir ?? resolvePackageSkillsDir();
  const skills = scanSkills(skillsDir);
  if (skills.length === 0) {
    throw new Error(
      `No skills found in '${skillsDir}'. | Suggestion: reinstall the Cuthol package.`
    );
  }
  return {
    skills,
    packageVersion: options?.packageVersion ?? readPackageVersion(),
    targets:
      options?.targets ??
      detectAgentTargets().map((t) => ({ ...t, detected: true }) as SelectedTarget),
  };
}

export function installSkills(options?: InstallOptions): InstallReport {
  const { skills, packageVersion, targets } = resolveInstallInput(options);
  const force = options?.force === true;
  const byName = new Map(skills.map((s) => [s.name, s]));
  const report: InstallReport = {
    package_version: packageVersion,
    skills: skills.map((s) => s.name),
    targets: [],
  };
  for (const target of targets) {
    const result: TargetInstallResult = {
      id: target.id,
      skills_dir: target.skillsDir,
      detected: target.detected,
      installed: [],
      updated: [],
      unchanged: [],
      skipped_modified: [],
      removed_stale: [],
    };
    if (!target.detected) {
      result.skipped = `Agent folder '${target.baseDir}' not found; skipped.`;
      report.targets.push(result);
      continue;
    }
    try {
      fs.mkdirSync(target.skillsDir, { recursive: true });
      const packageHashes = new Map<string, string>();
      for (const skill of skills) {
        const dest = path.join(target.skillsDir, skill.name);
        if (!isExistingDir(dest)) {
          atomicInstallSkill(skill, dest, packageVersion);
          result.installed.push(skill.name);
          continue;
        }
        if (!fs.existsSync(path.join(dest, SKILL_MARKER_FILE))) {
          result.skipped_modified.push({ name: skill.name, reason: "Not installed by Cuthol; left untouched." });
          continue;
        }
        const marker = readSkillMarker(dest);
        const currentHash = hashSkillDir(dest);
        if (!marker || marker.content_hash !== currentHash) {
          if (!force) {
            result.skipped_modified.push({
              name: skill.name,
              reason: "Changed after installation; kept. Reinstall with --force to overwrite.",
            });
            continue;
          }
          atomicInstallSkill(skill, dest, packageVersion);
          result.updated.push(skill.name);
          continue;
        }
        let packageHash = packageHashes.get(skill.name);
        if (packageHash === undefined) {
          packageHash = hashSkillDir(skill.dir);
          packageHashes.set(skill.name, packageHash);
        }
        if (marker.package_version !== packageVersion || packageHash !== currentHash) {
          atomicInstallSkill(skill, dest, packageVersion);
          result.updated.push(skill.name);
        } else {
          result.unchanged.push(skill.name);
        }
      }
      // Drop skills Cuthol installed earlier but the package no longer ships.
      // Only marker-carrying folders are removed; user folders stay.
      for (const entry of fs.readdirSync(target.skillsDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith(".") || byName.has(entry.name)) continue;
        const dir = path.join(target.skillsDir, entry.name);
        if (!fs.existsSync(path.join(dir, SKILL_MARKER_FILE))) continue;
        fs.rmSync(dir, { recursive: true, force: true });
        result.removed_stale.push(entry.name);
      }
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
    }
    report.targets.push(result);
  }
  return report;
}

export interface TargetRemoveResult {
  id: string;
  skills_dir: string;
  detected: boolean;
  removed: string[];
  skipped?: string;
  error?: string;
}

export interface RemoveReport {
  targets: TargetRemoveResult[];
}

export function removeSkills(options?: { targets?: SelectedTarget[] }): RemoveReport {
  const targets =
    options?.targets ?? detectAgentTargets().map((t) => ({ ...t, detected: true }) as SelectedTarget);
  const report: RemoveReport = { targets: [] };
  for (const target of targets) {
    const result: TargetRemoveResult = {
      id: target.id,
      skills_dir: target.skillsDir,
      detected: target.detected,
      removed: [],
    };
    if (!target.detected) {
      result.skipped = `Agent folder '${target.baseDir}' not found; skipped.`;
      report.targets.push(result);
      continue;
    }
    try {
      if (isExistingDir(target.skillsDir)) {
        for (const entry of fs.readdirSync(target.skillsDir, { withFileTypes: true })) {
          if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
          const dir = path.join(target.skillsDir, entry.name);
          if (!fs.existsSync(path.join(dir, SKILL_MARKER_FILE))) continue;
          fs.rmSync(dir, { recursive: true, force: true });
          result.removed.push(entry.name);
        }
      }
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
    }
    report.targets.push(result);
  }
  return report;
}

export interface TargetStatusResult {
  id: string;
  skills_dir: string;
  detected: boolean;
  skills: SkillState[];
  skipped?: string;
}

export interface SkillsStatusReport {
  package_version: string;
  skills: Array<{ name: string; description: string }>;
  targets: TargetStatusResult[];
}

export function listSkillsStatus(options?: {
  targets?: SelectedTarget[];
  skillsDir?: string;
  packageVersion?: string;
}): SkillsStatusReport {
  const skillsDir = options?.skillsDir ?? resolvePackageSkillsDir();
  const skills = scanSkills(skillsDir);
  const packageVersion = options?.packageVersion ?? readPackageVersion();
  const targets =
    options?.targets ?? detectAgentTargets().map((t) => ({ ...t, detected: true }) as SelectedTarget);
  return {
    package_version: packageVersion,
    skills: skills.map((s) => ({ name: s.name, description: s.description })),
    targets: targets.map((target) =>
      target.detected
        ? {
            id: target.id,
            skills_dir: target.skillsDir,
            detected: true,
            skills: inspectTargetSkills(target.skillsDir, skills, packageVersion),
          }
        : {
            id: target.id,
            skills_dir: target.skillsDir,
            detected: false,
            skills: [],
            skipped: `Agent folder '${target.baseDir}' not found; skipped.`,
          }
    ),
  };
}

// ---------------------------------------------------------------------------
// Automatic install: runs on every CLI command and MCP start; silent and fast
// once this package version is installed (a single small marker read).
// ---------------------------------------------------------------------------

export interface AutoInstallMarker {
  version: string;
  /** Cheap fingerprint of the package skills tree (paths, sizes, mtimes), so edits within one version re-install. */
  skills_fingerprint?: string;
  targets: string[];
  installed_at: string;
}

/** Stat-only fingerprint of the package skills tree (no file contents read). */
export function skillsTreeFingerprint(skillsDir: string): string {
  const hash = crypto.createHash("sha256");
  const walk = (dir: string, rel: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(abs, r);
      else if (e.isFile()) {
        try {
          const st = fs.statSync(abs);
          hash.update(`${r}|${st.size}|${Math.floor(st.mtimeMs)}
`);
        } catch {
          // unreadable entry: leave it out
        }
      }
    }
  };
  walk(skillsDir, "");
  return hash.digest("hex").slice(0, 16);
}

export function readAutoInstallMarker(homeDir?: string): AutoInstallMarker | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(homeDir ?? resolveHomeDir(), AUTO_INSTALL_MARKER_REL), "utf8")
    ) as Partial<AutoInstallMarker>;
    if (typeof parsed.version !== "string" || !Array.isArray(parsed.targets)) return null;
    return {
      version: parsed.version,
      ...(typeof parsed.skills_fingerprint === "string" ? { skills_fingerprint: parsed.skills_fingerprint } : {}),
      targets: parsed.targets.filter((t): t is string => typeof t === "string"),
      installed_at: typeof parsed.installed_at === "string" ? parsed.installed_at : "",
    };
  } catch {
    return null;
  }
}

function isAutoInstallDisabled(): boolean {
  const raw = process.env[SKILLS_AUTO_ENV];
  if (raw === undefined) return false;
  return ["0", "false", "off", "no", "disable", "disabled"].includes(raw.trim().toLowerCase());
}

/**
 * Install Cuthol skills into every detected agent tool when this package version
 * has not been installed yet. Returns the one-line note for the user, or null when
 * nothing was done. Never throws: a failure must not break the running command.
 */
export function maybeAutoInstallSkills(options?: {
  homeDir?: string;
  skillsDir?: string;
  packageVersion?: string;
}): string | null {
  try {
    if (isAutoInstallDisabled()) return null;
    const home = options?.homeDir ?? resolveHomeDir();
    const skillsDir = options?.skillsDir ?? resolvePackageSkillsDir();
    const packageVersion = options?.packageVersion ?? readPackageVersion();
    const markerPath = path.join(home, AUTO_INSTALL_MARKER_REL);
    const detected = detectAgentTargets(home);
    const prev = readAutoInstallMarker(home);
    const fingerprint = skillsTreeFingerprint(skillsDir);
    if (
      prev &&
      prev.version === packageVersion &&
      prev.skills_fingerprint === fingerprint &&
      detected.every((t) => prev.targets.includes(t.id))
    ) {
      return null;
    }
    const report = installSkills({
      targets: detected.map((t) => ({ ...t, detected: true }) as SelectedTarget),
      skillsDir,
      packageVersion,
    });
    try {
      fs.mkdirSync(path.dirname(markerPath), { recursive: true });
      const marker: AutoInstallMarker = {
        version: packageVersion,
        skills_fingerprint: fingerprint,
        targets: detected.map((t) => t.id),
        installed_at: new Date().toISOString(),
      };
      fs.writeFileSync(markerPath, JSON.stringify(marker, null, 2), "utf8");
    } catch {
      // A best-effort stamp; the install itself already succeeded or reported errors.
    }
    const changed = report.targets.filter(
      (t) => !t.error && t.installed.length + t.updated.length + t.removed_stale.length > 0
    );
    if (changed.length === 0) return null;
    return `Installed Cuthol skills for: ${changed.map((t) => t.id).join(", ")}. Start a new session to load them.`;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Guide topics: resolved from the same scan, so `guide` and the installed
// skills always agree. Legacy topic names stay valid as aliases.
// ---------------------------------------------------------------------------

/** Legacy `guide` topic -> current skill topic (`<skill>` or `<skill>/<reference>`). */
export const GUIDE_LEGACY_ALIASES: Record<string, string> = {
  overview: "cuthol",
  editing: "cuthol-editing",
  speech_mix: "cuthol-speech",
  compositions: "cuthol-motion",
  verify_monitor: "cuthol-review",
  extensions: "cuthol-extensions",
  mcp: "cuthol/mcp",
};

/** Legacy topic -> file under `skills/cuthol/`, used while the old tree is in place. */
export const LEGACY_GUIDE_FILES: Record<string, string> = {
  overview: "SKILL.md",
  editing: "references/editing.md",
  speech_mix: "references/speech-and-mix.md",
  compositions: "references/compositions.md",
  verify_monitor: "references/verify-and-monitor.md",
  extensions: "references/extensions.md",
  mcp: "references/mcp.md",
};

export type GuideResolution =
  | { ok: true; kind: "file"; file: string; skill: string; appendAudioPointer: boolean }
  | { ok: true; kind: "catalog"; mainFile: string; skills: SkillInfo[] }
  | { ok: false; message: string };

function guideAvailableTopics(skills: SkillInfo[]): string {
  return [...skills.map((s) => s.name), ...Object.keys(GUIDE_LEGACY_ALIASES)].join(", ");
}

function stripMdExtension(ref: string): string {
  return ref.toLowerCase().endsWith(".md") ? ref.slice(0, -3) : ref;
}

export function resolveGuideTopic(topic: string, skillsDir?: string): GuideResolution {
  const dir = skillsDir ?? resolvePackageSkillsDir();
  let skills: SkillInfo[];
  try {
    skills = scanSkills(dir);
  } catch {
    skills = [];
  }
  const byName = new Map(skills.map((s) => [s.name, s]));
  const hasAudioSkill = byName.has("cuthol-audio");
  const trimmed = topic.trim();

  if (trimmed === "") {
    const main = byName.get(MAIN_SKILL_NAME);
    if (!main) {
      return {
        ok: false,
        message: `Main skill '${MAIN_SKILL_NAME}' is not available in '${dir}'. | Suggestion: reinstall the Cuthol package.`,
      };
    }
    return { ok: true, kind: "catalog", mainFile: path.join(main.dir, "SKILL.md"), skills };
  }

  const serveFile = (file: string, skillName: string, pointerForSpeechRoot: boolean): GuideResolution => ({
    ok: true,
    kind: "file",
    file,
    skill: skillName,
    appendAudioPointer: pointerForSpeechRoot && skillName === "cuthol-speech" && hasAudioSkill,
  });
  const serveLegacy = (alias: string): GuideResolution => {
    const file = path.join(dir, MAIN_SKILL_NAME, LEGACY_GUIDE_FILES[alias]);
    if (fs.existsSync(file)) return serveFile(file, MAIN_SKILL_NAME, false);
    return {
      ok: false,
      message: `Topic '${trimmed}' is not available. Topics: ${guideAvailableTopics(skills)}, '<skill>/<reference>', or ext:<name>.`,
    };
  };

  const slash = trimmed.indexOf("/");
  if (slash > 0) {
    const skillName = trimmed.slice(0, slash);
    const ref = stripMdExtension(trimmed.slice(slash + 1).trim());
    const skill = byName.get(skillName);
    if (!skill) {
      return {
        ok: false,
        message: `Topic '${trimmed}' is not available (no skill '${skillName}'). Topics: ${guideAvailableTopics(skills)}, '<skill>/<reference>', or ext:<name>.`,
      };
    }
    if (!ref || ref.includes("/") || ref.includes("\\") || ref.startsWith(".")) {
      return { ok: false, message: `Topic '${trimmed}' is not available. References of '${skillName}': ${skill.references.join(", ") || "(none)"}.` };
    }
    const file = path.join(skill.dir, "references", `${ref}.md`);
    if (!fs.existsSync(file)) {
      return { ok: false, message: `Topic '${trimmed}' is not available. References of '${skillName}': ${skill.references.join(", ") || "(none)"}.` };
    }
    return serveFile(file, skillName, false);
  }

  const direct = byName.get(trimmed);
  if (direct) return serveFile(path.join(direct.dir, "SKILL.md"), direct.name, true);

  const aliasTarget = GUIDE_LEGACY_ALIASES[trimmed];
  if (aliasTarget) {
    const aliasSlash = aliasTarget.indexOf("/");
    if (aliasSlash > 0) {
      const skill = byName.get(aliasTarget.slice(0, aliasSlash));
      const refFile =
        skill && path.join(skill.dir, "references", `${stripMdExtension(aliasTarget.slice(aliasSlash + 1))}.md`);
      if (refFile && fs.existsSync(refFile)) return serveFile(refFile, skill.name, false);
      return serveLegacy(trimmed);
    }
    const skill = byName.get(aliasTarget);
    if (skill) return serveFile(path.join(skill.dir, "SKILL.md"), skill.name, true);
    return serveLegacy(trimmed);
  }

  return {
    ok: false,
    message: `Topic '${trimmed}' is not available. Topics: ${guideAvailableTopics(skills)}, '<skill>/<reference>', or ext:<name>.`,
  };
}

export function buildSkillsCatalogSection(skills: SkillInfo[]): string {
  const lines = skills.map((s) => `- ${s.name}${s.description ? `: ${s.description}` : ""}`);
  return [`Available skills (read only what you need with guide(topic="<name>")):`, ...lines].join("\n");
}

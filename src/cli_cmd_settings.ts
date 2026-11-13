import { CutholError, DIAGNOSTICS } from "./core/diagnostics.js";
import {
  currentSettingsActor,
  displaySettingValue,
  envSettingValue,
  isSettingKey,
  listSettings,
  resetSetting,
  resolveSetting,
  setSetting,
  settingEnvVar,
} from "./core/settings.js";
import { CLI_NOT_HANDLED, type CliCommandContext, emitEnvelopeJson } from "./cli_output.js";

/**
 * `cuthol settings [list|get <key>|set <key> <value>|reset <key>]`.
 * Writes are stamped `set_by: "agent"` unless CUTHOL_LIVE_ACTOR=human.
 */
export function runSettingsCommand(ctx: CliCommandContext): unknown {
  const { action, rest, workspaceDir } = ctx;
  const sub = action ?? "list";
  switch (sub) {
    case "list": {
      const settings = listSettings(workspaceDir).map((s) => ({
        key: s.key,
        value: s.value,
        source: s.source,
        set_by: s.set_by,
      }));
      emitEnvelopeJson(workspaceDir, "settings list", { settings });
      return;
    }
    case "get": {
      const key = rest[0];
      if (!key || !isSettingKey(key)) {
        throw new CutholError(DIAGNOSTICS.SETTINGS_UNKNOWN_KEY(String(key ?? "(missing)")));
      }
      const r = resolveSetting(workspaceDir, key);
      emitEnvelopeJson(workspaceDir, "settings get", {
        settings: [{ key, value: r.value, source: r.source, set_by: r.set_by }],
      });
      return;
    }
    case "set": {
      const [key, ...valueParts] = rest;
      if (!key || !isSettingKey(key)) {
        throw new CutholError(DIAGNOSTICS.SETTINGS_UNKNOWN_KEY(String(key ?? "(missing)")));
      }
      if (valueParts.length === 0) {
        throw new CutholError(
          DIAGNOSTICS.SETTINGS_INVALID_VALUE(key, "(missing)", "a value, e.g. 'cuthol settings set render.workers 4'")
        );
      }
      const envName = settingEnvVar(key);
      if (envName && envSettingValue(key) !== undefined) {
        throw new CutholError(DIAGNOSTICS.SETTINGS_ENV_LOCKED(key, envName));
      }
      if (key === "live.shortcuts" && currentSettingsActor() === "agent") {
        throw new CutholError(DIAGNOSTICS.SETTINGS_AGENT_READONLY(key));
      }
      let value: unknown = valueParts.join(" ");
      if (key === "live.shortcuts" && typeof value === "string" && value.trim().startsWith("{")) {
        try {
          value = JSON.parse(value);
        } catch {
          // fall through to validation, which reports the failure
        }
      }
      const before = resolveSetting(workspaceDir, key);
      const r = setSetting(workspaceDir, key, value);
      emitEnvelopeJson(workspaceDir, "settings set", {
        settings: [
          {
            key,
            value: r.value,
            source: r.source,
            set_by: r.set_by,
            previous: { value: before.value, source: before.source },
            display: displaySettingValue(key, r.value),
          },
        ],
      });
      return;
    }
    case "reset": {
      const key = rest[0];
      if (!key || !isSettingKey(key)) {
        throw new CutholError(DIAGNOSTICS.SETTINGS_UNKNOWN_KEY(String(key ?? "(missing)")));
      }
      const removed = resetSetting(workspaceDir, key);
      const r = resolveSetting(workspaceDir, key);
      emitEnvelopeJson(workspaceDir, "settings reset", {
        settings: [{ key, value: r.value, source: r.source, set_by: r.set_by, reset: removed }],
      });
      return;
    }
    default:
      return CLI_NOT_HANDLED;
  }
}

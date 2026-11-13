// Single registry for every Live window keyboard shortcut.
// Regions bind their keydown handlers through this table; the map itself
// comes from `live.shortcuts` (GET /api/settings) with built-in defaults.
export const DEFAULT_SHORTCUTS = {
  "play-pause": "Space",
  "step-forward": "ArrowRight",
  "step-back": "ArrowLeft",
  "step-forward-10": "Shift+ArrowRight",
  "step-back-10": "Shift+ArrowLeft",
  "go-start": "Home",
  "go-end": "End",
  "new-note": "KeyN",
  "send-notes": "Ctrl+Enter",
  "close-panel": "Escape",
};

export const SHORTCUT_LABELS = {
  "play-pause": "Play / pause",
  "step-forward": "Step one frame forward",
  "step-back": "Step one frame back",
  "step-forward-10": "Step 10 frames forward",
  "step-back-10": "Step 10 frames back",
  "go-start": "Go to start",
  "go-end": "Go to end",
  "new-note": "New note at playhead",
  "send-notes": "Send notes to the agent",
  "close-panel": "Close panel",
};

const ACTION_ORDER = [
  "play-pause",
  "step-forward",
  "step-back",
  "step-forward-10",
  "step-back-10",
  "go-start",
  "go-end",
  "new-note",
  "send-notes",
  "close-panel",
];

export function shortcutActions() {
  return [...ACTION_ORDER];
}

/** Effective map: stored overrides merged over the defaults. Never throws. */
export function resolveShortcuts(stored) {
  const base = { ...DEFAULT_SHORTCUTS };
  if (stored && typeof stored === "object" && !Array.isArray(stored)) {
    for (const [action, binding] of Object.entries(stored)) {
      if (typeof binding === "string" && binding.trim()) base[action] = binding.trim();
    }
  }
  return base;
}

/** True while the user types (shortcuts stay out of the way there). */
export function isTypingTarget(e) {
  const tag = (e.target?.tagName ?? "").toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || e.target?.isContentEditable;
}

/** Canonical `code` chord of a key event, e.g. "Shift+ArrowRight", "Ctrl+Enter". */
export function eventChord(e) {
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
  if (e.shiftKey) parts.push("Shift");
  if (e.altKey) parts.push("Alt");
  let code = e.code;
  if (code === "Enter" && (e.ctrlKey || e.metaKey)) code = "Enter";
  parts.push(code);
  // A bare modifier press is not a shortcut.
  if (["ControlLeft", "ControlRight", "ShiftLeft", "ShiftRight", "AltLeft", "AltRight", "MetaLeft", "MetaRight"].includes(e.code)) return "";
  return parts.join("+");
}

/** Human label for a chord ("Space", "Ctrl+Enter"). */
export function chordLabel(chord) {
  return String(chord ?? "")
    .replace("Key", "")
    .replace("Arrow", "")
    .replace("Digit", "");
}

/** Filter a keydown event to its matching action, or null. */
export function matchShortcut(map, e, action) {
  const want = map?.[action];
  if (!want || isTypingTarget(e)) return false;
  return eventChord(e) === want;
}

/** All actions currently bound to the same chord (for conflict warnings). */
export function shortcutConflicts(map, chord, exceptAction) {
  return ACTION_ORDER.filter((a) => a !== exceptAction && map[a] === chord);
}

/** Load the stored map through the settings endpoint; defaults on any failure. */
export async function loadShortcuts(api) {
  try {
    const view = await api.get("/api/settings");
    const entry = (view?.settings ?? []).find((s) => s.key === "live.shortcuts");
    if (entry && entry.value && typeof entry.value === "object") return resolveShortcuts(entry.value);
  } catch {
    // offline or old server: defaults
  }
  return { ...DEFAULT_SHORTCUTS };
}

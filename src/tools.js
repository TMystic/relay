// Only bundled, reviewed tools run here. No downloaded extension code is evaluated.
export const tools = [
  {
    id: "minimap",
    name: "Code minimap",
    summary: "A compact overview of the current file.",
    badge: "M",
    options: (enabled) => ({ minimap: { enabled } }),
  },
  {
    id: "wrap",
    name: "Word wrap",
    summary: "Keep long lines within the editor width.",
    badge: "W",
    options: (enabled) => ({ wordWrap: enabled ? "on" : "off" }),
  },
  {
    id: "brackets",
    name: "Bracket guides",
    summary: "Highlight matching brackets and nesting.",
    badge: "{ }",
    options: (enabled) => ({
      guides: { bracketPairs: enabled },
      bracketPairColorization: { enabled },
    }),
  },
  {
    id: "json",
    name: "JSON formatter",
    summary: "Format the current JSON file on demand.",
    badge: "{}",
    options: () => ({}),
  },
];
export const defaultPreferences = {
  fontSize: 14,
  lineNumbers: true,
  highlight: true,
  enabledTools: [],
};
export function loadPreferences(storage) {
  try {
    const value = JSON.parse(
      storage.getItem("relay-editor-preferences") || "null",
    );
    if (!value) return structuredClone(defaultPreferences);
    return {
      fontSize: Math.max(11, Math.min(24, Number(value.fontSize) || 14)),
      lineNumbers: value.lineNumbers !== false,
      highlight: value.highlight !== false,
      enabledTools: Array.isArray(value.enabledTools)
        ? value.enabledTools.filter((id) => tools.some((t) => t.id === id))
        : [],
    };
  } catch {
    return structuredClone(defaultPreferences);
  }
}

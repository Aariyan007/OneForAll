// Visual vocabulary of the repository graph. Every kind and relationship type has a text label and a distinct line
// pattern or glyph, so meaning never depends on colour alone.

export const KIND_META: Record<string, { label: string; glyph: string; color: string }> = {
  MODULE: { label: "Module", glyph: "MOD", color: "var(--fg-3)" },
  CLASS: { label: "Class", glyph: "C", color: "var(--accent)" },
  INTERFACE: { label: "Interface", glyph: "I", color: "var(--info)" },
  FUNCTION: { label: "Function", glyph: "fn", color: "var(--success)" },
  METHOD: { label: "Method", glyph: "m", color: "var(--success)" },
  CONSTRUCTOR: { label: "Constructor", glyph: "new", color: "var(--success)" },
  ENUM: { label: "Enum", glyph: "E", color: "var(--warning)" },
  VARIABLE: { label: "Variable", glyph: "var", color: "var(--fg-2)" },
  CONSTANT: { label: "Constant", glyph: "K", color: "var(--fg-2)" },
  TYPE: { label: "Type", glyph: "T", color: "var(--info)" },
};

export function kindMeta(kind: string) {
  return KIND_META[kind] ?? { label: kind, glyph: "?", color: "var(--fg-3)" };
}

// Direction: every edge is drawn from the stored source to the stored target (arrowhead at the target).
export const TYPE_META: Record<string, { label: string; verb: string; direction: string; dash: string; color: string; width: number }> = {
  CONTAINS: { label: "Contains", verb: "contains", direction: "container → contained element", dash: "", color: "var(--border-strong)", width: 1.25 },
  IMPORTS: { label: "Imports", verb: "imports", direction: "file module → imported name (same file, not resolved)", dash: "6 4", color: "var(--info)", width: 1.25 },
  EXTENDS: { label: "Extends", verb: "extends", direction: "subtype → base type (same file)", dash: "", color: "var(--accent)", width: 2 },
  IMPLEMENTS: { label: "Implements", verb: "implements", direction: "class → interface (same file)", dash: "8 3 2 3", color: "var(--warning)", width: 1.75 },
  CALLS: { label: "Calls", verb: "calls", direction: "caller → callee", dash: "1.5 4", color: "var(--success)", width: 1.5 },
  REFERENCES: { label: "References", verb: "references", direction: "source → referenced symbol", dash: "1.5 4", color: "var(--fg-2)", width: 1.25 },
};

export function typeMeta(type: string) {
  return TYPE_META[type] ?? { label: type, verb: type.toLowerCase(), direction: "source → target", dash: "3 3", color: "var(--fg-3)", width: 1.25 };
}

export const KIND_ORDER = ["MODULE", "CLASS", "INTERFACE", "ENUM", "TYPE", "FUNCTION", "CONSTRUCTOR", "METHOD", "CONSTANT", "VARIABLE"];
export const TYPE_ORDER = ["CONTAINS", "IMPORTS", "EXTENDS", "IMPLEMENTS", "CALLS", "REFERENCES"];

export function byOrder(order: readonly string[]) {
  return (a: string, b: string) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    return (ia < 0 ? order.length : ia) - (ib < 0 ? order.length : ib) || a.localeCompare(b);
  };
}

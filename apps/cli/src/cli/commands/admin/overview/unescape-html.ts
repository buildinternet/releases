const ENTITY_MAP: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
};

// Narrow decode for entities sub-agents reflexively emit in markdown bodies.
// Single-pass regex so &amp;lt; stays &lt; rather than collapsing to <.
export function unescapeHtmlEntities(s: string): string {
  return s.replace(/&amp;|&lt;|&gt;|&quot;|&#39;/g, (m) => ENTITY_MAP[m] ?? m);
}

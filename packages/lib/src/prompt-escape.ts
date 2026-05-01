/**
 * Helpers for safely interpolating caller-supplied strings into LLM prompts.
 */

/**
 * Escape a caller-supplied string for safe interpolation inside an
 * XML-tagged data block in an LLM prompt.
 *
 * Strips closing XML tags that could let injected text break out of its
 * container. Also removes ASCII non-printable control characters
 * (except tab U+0009 and newline U+000A) that confuse the model.
 */
export function escapeForPromptTag(value: string): string {
  return (
    value
      // Strip closing XML tags so injected content cannot break out of its wrapper.
      .replace(/<\/[a-zA-Z][^>]*>/g, "")
      // Strip ASCII control characters (keep \t U+0009 and \n U+000A).
      .split("")
      .filter((ch) => {
        const cp = ch.charCodeAt(0);
        return cp === 0x09 || cp === 0x0a || (cp >= 0x20 && cp !== 0x7f);
      })
      .join("")
      .trim()
  );
}

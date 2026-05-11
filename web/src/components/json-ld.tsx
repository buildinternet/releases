import { safeStringifyJsonLd } from "@/lib/json-ld";

/**
 * Emits a <script type="application/ld+json"> block with the given payload
 * stringified through safeStringifyJsonLd. The helper escapes `</script>`,
 * U+2028, and U+2029 so attacker-controlled fields can't close the surrounding
 * script tag (#644).
 */
export function JsonLd({ data }: { data: unknown }) {
  return (
    <script
      type="application/ld+json"
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: safeStringifyJsonLd(data) }}
    />
  );
}

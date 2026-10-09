/**
 * Make a Zod-generated JSON Schema acceptable to Gemini's constrained decoding (Vertex AI).
 *
 * Found empirically against Vertex (gemini-2.5-flash, 2026-10-09): the full schema is rejected
 * ("too many states for serving") because of `pattern`, `format`, `minItems`/`maxItems`, `default`,
 * `additionalProperties` and `$schema`. Removing those makes it work; `const` -> `enum` and
 * `oneOf` -> `anyOf` are the portable spellings.
 *
 * SAFETY: this only loosens what we ASK the model for. The authoritative check is the strict Zod
 * parse of whatever comes back (src/lib/agent/geap.ts), which still enforces every removed constraint
 * (currency pattern, rule-count bounds, integer cents, …). A schema the model ignores can't hurt us.
 */
const DROP = new Set(["$schema", "additionalProperties", "pattern", "format", "default", "minItems", "maxItems"]);

export function toModelSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(toModelSchema);
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (DROP.has(k)) continue;
      if (k === "const") out.enum = [v];
      else if (k === "oneOf") out.anyOf = toModelSchema(v);
      else out[k] = toModelSchema(v);
    }
    return out;
  }
  return node;
}

import fs from "node:fs";
import path from "node:path";
import { CONTENT_ROOT } from "@/lib/docs";

/**
 * The production OpenAPI snapshot behind the docs API reference
 * (`src/content/openapi.json`, written by `bun run docs:openapi`). Read from
 * disk so the `.md` exports and `bun test` can use it without the compiled MDX.
 */

export const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export type SchemaObject = {
  $ref?: string;
  type?: string | string[];
  format?: string;
  enum?: unknown[];
  items?: SchemaObject;
  properties?: Record<string, SchemaObject>;
  required?: string[];
  description?: string;
  default?: unknown;
  anyOf?: SchemaObject[];
  oneOf?: SchemaObject[];
  allOf?: SchemaObject[];
};

export type ParameterObject = {
  name: string;
  in: string;
  required?: boolean;
  description?: string;
  schema?: SchemaObject;
};

export type OperationObject = {
  operationId?: string;
  tags?: string[];
  summary?: string;
  description?: string;
  deprecated?: boolean;
  parameters?: ParameterObject[];
  requestBody?: { content?: Record<string, { schema?: SchemaObject }> };
  responses?: Record<string, { description?: string }>;
  security?: Array<Record<string, string[]>>;
};

export type OpenAPISpec = {
  openapi: string;
  info: { title: string; version: string; description?: string };
  servers?: Array<{ url: string; description?: string }>;
  tags?: Array<{ name: string; description?: string }>;
  paths: Record<string, Partial<Record<HttpMethod, OperationObject>>>;
  components?: Record<string, unknown>;
};

export type OperationRef = { path: string; method: HttpMethod };

let cached: OpenAPISpec | undefined;

export function loadOpenAPISpec(): OpenAPISpec {
  cached ??= JSON.parse(
    fs.readFileSync(path.join(CONTENT_ROOT, "openapi.json"), "utf8"),
  ) as OpenAPISpec;
  return cached;
}

/** `<APIPage operations="a,b" />` attribute → operationId list. */
export function parseIdList(ids: string): string[] {
  return ids
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

/** Every operation in spec order, with its operationId. */
export function allOperations(spec: OpenAPISpec): Array<OperationRef & { operationId?: string }> {
  const out: Array<OperationRef & { operationId?: string }> = [];
  for (const [p, item] of Object.entries(spec.paths)) {
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (op) out.push({ path: p, method, operationId: op.operationId });
    }
  }
  return out;
}

/** The operations with these operationIds, in the given order. Unknown ids throw. */
export function operationsByIds(spec: OpenAPISpec, ids: readonly string[]): OperationRef[] {
  const byId = new Map(allOperations(spec).map((o) => [o.operationId, o]));
  return ids.map((id) => {
    const op = byId.get(id);
    if (!op) throw new Error(`OpenAPI operation "${id}" not found; run \`bun run docs:openapi\``);
    return { path: op.path, method: op.method };
  });
}

/**
 * The spec trimmed to `operations`, so each reference page ships only its own
 * paths to the client instead of the whole document.
 */
export function specForOperations(spec: OpenAPISpec, operations: OperationRef[]): OpenAPISpec {
  const paths: OpenAPISpec["paths"] = {};
  for (const { path: p, method } of operations) {
    paths[p] = { ...paths[p], [method]: spec.paths[p]?.[method] };
  }
  const tags = new Set(operations.flatMap((o) => spec.paths[o.path]?.[o.method]?.tags ?? []));
  return { ...spec, paths, tags: spec.tags?.filter((t) => tags.has(t.name)) };
}

// ── Markdown rendering (the `.md` export / llms-full.txt / Copy page) ────────

function refName(ref: string): string {
  return ref.split("/").pop() ?? ref;
}

/** A short, human-readable type for a schema, e.g. `string`, `integer[]`, `"a" | "b"`. */
export function schemaType(schema: SchemaObject | undefined): string {
  if (!schema) return "any";
  if (schema.$ref) return refName(schema.$ref);
  if (schema.enum?.length) return schema.enum.map((v) => JSON.stringify(v)).join(" \\| ");
  const union = schema.anyOf ?? schema.oneOf;
  if (union?.length) return union.map(schemaType).join(" \\| ");
  if (schema.allOf?.length) return schema.allOf.map(schemaType).join(" & ");
  const type = Array.isArray(schema.type) ? schema.type.join(" \\| ") : schema.type;
  if (type === "array") return `${schemaType(schema.items)}[]`;
  if (type) return schema.format ? `${type} (${schema.format})` : type;
  return schema.properties ? "object" : "any";
}

/** Table cells can't hold newlines or bare pipes. */
function cell(text: string | undefined): string {
  return (text ?? "").replace(/\s*\n+\s*/g, " ").replace(/(?<!\\)\|/g, "\\|");
}

function operationMarkdown(
  spec: OpenAPISpec,
  { path: p, method }: OperationRef,
  { heading }: { heading: boolean },
): string {
  const op = spec.paths[p]?.[method];
  if (!op) return "";
  const base = spec.servers?.[0]?.url ?? "";
  const lines: string[] = heading ? [`## ${method.toUpperCase()} ${p}`, ""] : [];
  lines.push(`\`${method.toUpperCase()} ${base}${p}\``, "");
  if (op.deprecated) lines.push("> **Deprecated.**", "");
  if (op.description) lines.push(op.description.trim(), "");

  const auth = op.security ?? [];
  const optional = auth.some((req) => Object.keys(req).length === 0);
  if (auth.length > 0) {
    lines.push(
      optional ? "**Auth:** optional Bearer token." : "**Auth:** Bearer token required.",
      "",
    );
  }

  if (op.parameters?.length) {
    lines.push("**Parameters**", "", "| Name | In | Type | Required | Description |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const prm of op.parameters) {
      lines.push(
        `| \`${prm.name}\` | ${prm.in} | ${cell(schemaType(prm.schema))} | ${prm.required ? "yes" : "no"} | ${cell(prm.description)} |`,
      );
    }
    lines.push("");
  }

  const body = op.requestBody?.content;
  const bodyType = body && Object.keys(body)[0];
  const bodySchema = bodyType ? body[bodyType]?.schema : undefined;
  if (bodyType) {
    lines.push(`**Request body** (\`${bodyType}\`)`, "");
    const props = bodySchema?.properties;
    if (props && Object.keys(props).length > 0) {
      const required = new Set(bodySchema.required ?? []);
      lines.push("| Field | Type | Required | Description |", "| --- | --- | --- | --- |");
      for (const [name, prop] of Object.entries(props)) {
        lines.push(
          `| \`${name}\` | ${cell(schemaType(prop))} | ${required.has(name) ? "yes" : "no"} | ${cell(prop.description)} |`,
        );
      }
      lines.push("");
    } else {
      lines.push(`Type: ${schemaType(bodySchema)}`, "");
    }
  }

  const responses = Object.entries(op.responses ?? {});
  if (responses.length) {
    lines.push("**Responses**", "");
    for (const [status, r] of responses) lines.push(`- \`${status}\` ${cell(r.description)}`);
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Plain-markdown stand-in for `<APIPage operations="…" />`: the URL, auth,
 * parameters, body fields, and response codes of each operation, plus a
 * pointer to the full spec for exact schemas. A page's title is already its
 * h1, so a single operation gets no heading of its own.
 */
export function apiPageMarkdown(ids: readonly string[], spec = loadOpenAPISpec()): string {
  const ops = operationsByIds(spec, ids);
  const sections = ops.map((op) => operationMarkdown(spec, op, { heading: ops.length > 1 }));
  sections.push(
    "Full request and response schemas: [OpenAPI 3.1 spec](https://api.releases.sh/v1/openapi.json).",
  );
  return sections.join("\n");
}

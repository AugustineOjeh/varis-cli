// Validating a service's input and output against its JSON Schemas, for
// varis test.
//
// The point of varis test is to catch, before publishing, the failures the
// gateway would otherwise catch on a paid call: an input the service won't
// accept, and an output that doesn't match what the service promised. The
// gateway reverses the charge for a schema violation, so every one caught
// here is a failed call a customer never sees.
//
// So this validator is configured exactly like the gateway's
// (lib/gateway/validators.ts in the varis repository): the same library,
// Ajv, the same options, and the same formats. A test passes or fails for
// the same reasons a real call would. If you change one, change the other.

import { Ajv, type ErrorObject } from "ajv";
import addFormatsModule from "ajv-formats";

// ajv-formats is CommonJS; depending on how it's loaded, the function is the
// module itself or its default export.
const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ??
  addFormatsModule) as (ajv: Ajv) => void;

/** One schema problem, ready to print. */
export type SchemaProblem = { path: string; message: string };

export type Validation =
  | { ok: true }
  | { ok: false; problems: SchemaProblem[] }
  /** The schema itself doesn't compile. A bug in the definition, not the data. */
  | { ok: false; invalidSchema: string };

/**
 * Checks `value` against `schema`, reporting every problem, not just the
 * first, so a developer fixes them all in one pass.
 */
export function validate(schema: unknown, value: unknown): Validation {
  // strict: false, like the gateway, so a keyword Ajv doesn't know doesn't
  // stop compilation. A fresh instance each time, because Ajv remembers every
  // compiled schema and rejects a second one with the same $id.
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);

  let check;
  try {
    check = ajv.compile(schema as object);
  } catch (error) {
    return {
      ok: false,
      invalidSchema: error instanceof Error ? error.message : String(error),
    };
  }

  if (check(value)) return { ok: true };
  return { ok: false, problems: (check.errors ?? []).map(describe) };
}

/**
 * Turns Ajv's error into a path and a sentence. The path is the JSON Pointer
 * to the value, or "(root)" for the value as a whole, so "/data/0/max_temp"
 * points straight at the field.
 */
function describe(error: ErrorObject): SchemaProblem {
  let path = error.instancePath || "(root)";
  let message = error.message ?? "is invalid";

  // "must have required property 'city'" reads better against the missing
  // field itself.
  if (error.keyword === "required") {
    const missing = (error.params as { missingProperty?: string }).missingProperty;
    if (missing) {
      path = `${error.instancePath}/${missing}`;
      message = "is required";
    }
  }
  if (error.keyword === "additionalProperties") {
    const extra = (error.params as { additionalProperty?: string }).additionalProperty;
    if (extra) {
      path = `${error.instancePath}/${extra}`;
      message = "isn't in the schema";
    }
  }
  if (error.keyword === "enum") {
    const allowed = (error.params as { allowedValues?: unknown[] }).allowedValues;
    if (allowed) message = `must be one of: ${allowed.map((v) => JSON.stringify(v)).join(", ")}`;
  }

  return { path, message };
}

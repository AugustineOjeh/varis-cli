// Encoding a GET service's input as a query string, for varis test.
//
// This mirrors the gateway exactly (lib/gateway/query-string.ts in the varis
// repository): a test must send the same bytes a real call would, or it
// proves nothing about how the service handles real traffic. If you change
// one, change the other.
//
// The rules, and why:
//   - Keys in code-unit order, so the same input always gives the same query,
//     which the signature covers.
//   - An array repeats its key once per item, in order: ?tag=a&tag=b.
//   - Numbers and booleans become strings. The provider parses them back.
//   - null, undefined, and empty arrays are left out.
//   - Only keys the input schema declares are sent. publish checks that a
//     GET service's declared keys are all flat; an undeclared key could be
//     anything.
//   - Serialised by URLSearchParams, so a space is +. Frameworks that
//     normalise request.url (Next.js does) re-serialise the query the same
//     way, so the signed bytes survive the round trip. %20 wouldn't.

type Scalar = string | number | boolean;

function isScalar(value: unknown): value is Scalar {
  return typeof value === "string" || typeof value === "number" ||
    typeof value === "boolean";
}

/**
 * "" for no parameters, otherwise a string starting with "?". Throws on a
 * nested value under a declared key; varis test reports that before
 * sending, as the input not fitting a GET service.
 */
export function toQueryString(input: unknown, inputSchema: unknown): string {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return "";
  }

  const declared = new Set(
    Object.keys(
      (inputSchema as { properties?: Record<string, unknown> } | null)
        ?.properties ?? {},
    ),
  );

  const values = input as Record<string, unknown>;
  const keys = Object.keys(values)
    .filter((key) => declared.has(key))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const params = new URLSearchParams();
  for (const key of keys) {
    const value = values[key];
    if (value === undefined || value === null) continue;

    const items = Array.isArray(value) ? value : [value];
    for (const item of items) {
      if (item === undefined || item === null) continue;
      if (!isScalar(item)) {
        throw new Error(`input field "${key}" is not flat`);
      }
      params.append(key, String(item));
    }
  }

  const query = params.toString();
  return query === "" ? "" : `?${query}`;
}

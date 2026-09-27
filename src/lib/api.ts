// The one way the CLI talks to the Varis API.
//
// Every command goes through apiRequest, which builds the URL from the API
// origin, attaches this machine's device token and the owner when asked,
// and turns whatever comes back into either the parsed body or an ApiError
// with a message a developer can act on. It never throws for an ordinary
// failure: a bad token, a 4xx, a 5xx, and a network failure all come back as
// ApiError, so each command decides what to print and which exit code to use.
//
// The API answers errors in one of two shapes:
//   Varis    { "error": { "code", "message", "details"? }, "request_id" }
//   OAuth    { "error": "authorization_pending", "error_description" }
// The second is the device flow's token endpoint. Both land in ApiError.code.

import { apiOrigin, type Env } from "./constants.ts";
import { bugReportUrl } from "./issues.ts";
import {
  type CredentialsLocation,
  defaultLocation,
  readToken,
} from "./credentials.ts";
import { VERSION } from "./version.ts";

export type ErrorDetail = { path: string; message: string };

export type ApiErrorKind =
  /** No token on this machine. */
  | "signed_out"
  /** A token, but issued by another Varis server. */
  | "signed_in_elsewhere"
  /** The credentials file can't be read. */
  | "damaged_credentials"
  /** 401: the token was rejected (unknown, revoked, or expired). */
  | "rejected_token"
  /** 403: the token is fine; this action isn't allowed. */
  | "forbidden"
  /** 400, 404, 409, and other 4xx: the request itself. */
  | "request"
  | "rate_limited"
  /** 5xx. */
  | "server"
  /** Never reached the server, or no answer in time. */
  | "network"
  /** A 2xx whose body isn't JSON. */
  | "unexpected";

export type ApiError = {
  kind: ApiErrorKind;
  /** Plain language, ready to print. */
  message: string;
  status?: number;
  /** The server's error code, for example "not_a_member" or "slow_down". */
  code?: string;
  details?: ErrorDetail[];
  requestId?: string;
  /** The whole error body, for callers that need a field this doesn't lift. */
  body?: unknown;
};

export type ApiResult<T> =
  | { ok: true; status: number; body: T }
  | { ok: false; error: ApiError };

export type RequestOptions = {
  /** Sent as JSON. */
  body?: unknown;
  /** "device" attaches this machine's token; "none" sends no credential. */
  auth: "device" | "none";
  /**
   * A specific device token to send instead, such as the one a new sign-in
   * is replacing. Only with auth "none", so it never mixes with the file's.
   */
  bearer?: string;
  /** Sent as X-Varis-Owner-Identifier, for commands that act for an owner. */
  owner?: string;
  /** Injectable for tests. */
  fetch?: typeof fetch;
  env?: Env;
  credentials?: CredentialsLocation;
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 30_000;

/** apiRequest's shape, so commands can take a stand-in in tests. */
export type ApiRequestFn = <T>(
  method: "GET" | "POST" | "PATCH",
  path: `/v1/${string}`,
  options: RequestOptions,
) => Promise<ApiResult<T>>;

export async function apiRequest<T>(
  method: "GET" | "POST" | "PATCH",
  path: `/v1/${string}`,
  options: RequestOptions,
): Promise<ApiResult<T>> {
  const env = options.env ?? process.env;
  const origin = apiOrigin(env);
  const doFetch = options.fetch ?? fetch;

  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": `varis-cli/${VERSION} (${process.platform})`,
  };

  if (options.auth === "device") {
    const token = await readToken(
      origin,
      options.credentials ?? defaultLocation(),
    );
    switch (token.status) {
      case "signed_out":
        return fail({
          kind: "signed_out",
          message: "You're not signed in on this machine. Run varis login.",
        });
      case "signed_in_elsewhere":
        return fail({
          kind: "signed_in_elsewhere",
          message:
            `This machine is signed in to ${token.api}, not ${origin}. Run varis login to sign in to ${origin}.`,
        });
      case "corrupt":
        return fail({
          kind: "damaged_credentials",
          message:
            `Your credentials file at ${token.path} is damaged: ${token.reason}. Run varis login to replace it.`,
        });
      case "signed_in":
        headers.Authorization = `Bearer ${token.token}`;
    }
  }

  if (options.auth === "none" && options.bearer) {
    headers.Authorization = `Bearer ${options.bearer}`;
  }
  if (options.owner) headers["X-Varis-Owner-Identifier"] = options.owner;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";

  let response: Response;
  try {
    response = await doFetch(`${origin}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    return fail(networkError(error, origin, env));
  }

  const text = await response.text();
  let body: unknown;
  try {
    body = text === "" ? undefined : JSON.parse(text);
  } catch {
    body = undefined;
  }

  if (response.ok) {
    if (text !== "" && body === undefined) {
      return fail({
        kind: "unexpected",
        status: response.status,
        message: `Varis answered with something that isn't JSON (HTTP ${response.status}). Try again, and update the CLI if it keeps happening.`,
      });
    }
    return { ok: true, status: response.status, body: body as T };
  }

  return fail(httpError(response, body));
}

function fail(error: ApiError): { ok: false; error: ApiError } {
  return { ok: false, error };
}

/** The server's code, message, details, and request ID, from either shape. */
function readErrorBody(body: unknown): {
  code?: string;
  message?: string;
  details?: ErrorDetail[];
  requestId?: string;
} {
  if (typeof body !== "object" || body === null) return {};
  const b = body as Record<string, unknown>;
  const requestId = typeof b.request_id === "string" ? b.request_id : undefined;

  // OAuth: { error: "slow_down", error_description: "..." }
  if (typeof b.error === "string") {
    return {
      code: b.error,
      message: typeof b.error_description === "string"
        ? b.error_description
        : undefined,
      requestId,
    };
  }

  // Varis: { error: { code, message, details } }
  if (typeof b.error === "object" && b.error !== null) {
    const e = b.error as Record<string, unknown>;
    return {
      code: typeof e.code === "string" ? e.code : undefined,
      message: typeof e.message === "string" ? e.message : undefined,
      details: Array.isArray(e.details)
        ? (e.details as ErrorDetail[])
        : undefined,
      requestId,
    };
  }

  return { requestId };
}

/** Server messages mark commands with backticks; a terminal doesn't need them. */
function plain(message: string): string {
  return message.replace(/`/g, "");
}

function httpError(response: Response, body: unknown): ApiError {
  const status = response.status;
  const { code, message, details, requestId } = readErrorBody(body);
  const said = message ? plain(message) : undefined;
  const base = { status, code, details, requestId, body };

  if (status === 401) {
    const fix = said?.includes("varis login") ? "" : " Run varis login.";
    return {
      ...base,
      kind: "rejected_token",
      message: `${said ?? "Varis didn't accept this machine's sign-in."}${fix}`,
    };
  }

  if (status === 403) {
    return {
      ...base,
      kind: "forbidden",
      message: said ?? "Varis doesn't allow that operation for this account.",
    };
  }

  if (status === 429) {
    const retry = response.headers.get("retry-after");
    return {
      ...base,
      kind: "rate_limited",
      message: `Varis is limiting requests from this machine. Wait ${
        retry ? `${retry} seconds` : "a minute"
      } and try again.`,
    };
  }

  if (status >= 500) {
    return {
      ...base,
      kind: "server",
      message: `Varis had a problem on its side (HTTP ${status}${
        requestId ? `, request ${requestId}` : ""
      }). Try again in a moment. If it keeps happening, report it on GitHub: ${
        bugReportUrl({ requestId, error: `HTTP ${status}` })
      }`,
    };
  }

  return {
    ...base,
    kind: "request",
    message: said ?? `Varis rejected the request (HTTP ${status}).`,
  };
}

function networkError(
  error: unknown,
  origin: string,
  env: Env,
): ApiError {
  const name = (error as { name?: string } | null)?.name;
  const timedOut = name === "TimeoutError" || name === "AbortError";
  const overridden = env.VARIS_API_URL?.trim()
    ? " (set by VARIS_API_URL)"
    : "";

  return {
    kind: "network",
    message: timedOut
      ? `Varis at ${origin}${overridden} didn't answer in time. Check your connection and try again.`
      : `Couldn't reach Varis at ${origin}${overridden}. Check your connection and try again.`,
  };
}

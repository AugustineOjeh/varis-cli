import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiRequest, type RequestOptions } from "../src/lib/api.ts";
import { VARIS_API_ORIGIN } from "../src/lib/constants.ts";
import {
  type CredentialsLocation,
  saveToken,
} from "../src/lib/credentials.ts";

const TOKEN = `var_dt_${"a".repeat(40)}`;
const OWNER = "var_ownr_aaaaaaaaaaaaaa";

let home: string;
let credentials: CredentialsLocation;

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "varis-cli-api-"));
  credentials = { env: {}, platform: process.platform, home };
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

/** A fetch that answers once with `status` and `body`, recording the call. */
function answer(status: number, body: unknown, headers: Record<string, string> = {}) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", ...headers },
    })
  );
}

function options(overrides: Partial<RequestOptions> = {}): RequestOptions {
  return { auth: "device", credentials, env: {}, ...overrides };
}

describe("a successful request", () => {
  it("sends the token, the owner, and JSON, and returns the body", async () => {
    await saveToken(VARIS_API_ORIGIN, TOKEN, credentials);
    const fetch = answer(201, { id: "var_srvc_x", unchanged: false });

    const result = await apiRequest("POST", "/v1/services", options({
      fetch,
      owner: OWNER,
      body: { slug: "weather" },
    }));

    expect(result).toEqual({
      ok: true,
      status: 201,
      body: { id: "var_srvc_x", unchanged: false },
    });

    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`${VARIS_API_ORIGIN}/v1/services`);
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify({ slug: "weather" }));
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers["X-Varis-Owner-Identifier"]).toBe(OWNER);
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["User-Agent"]).toMatch(/^varis-cli\//);
  });

  it("sends no credential when the route needs none", async () => {
    const fetch = answer(200, { device_code: "var_dc_x" });
    await apiRequest("POST", "/v1/cli/device/code", options({ fetch, auth: "none" }));
    const headers = fetch.mock.calls[0]![1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it("talks to VARIS_API_URL when set", async () => {
    const local = "http://localhost:3000/api";
    await saveToken(local, TOKEN, credentials);
    const fetch = answer(200, { owners: [] });

    await apiRequest("GET", "/v1/me/owners", options({
      fetch,
      env: { VARIS_API_URL: local },
    }));

    expect(fetch.mock.calls[0]![0]).toBe(`${local}/v1/me/owners`);
  });
});

describe("before any request", () => {
  it("stops when signed out, without calling the server", async () => {
    const fetch = answer(200, {});
    const result = await apiRequest("GET", "/v1/me/owners", options({ fetch }));

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "signed_out", message: expect.stringContaining("varis login") },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("never sends a token to a server that didn't issue it", async () => {
    await saveToken("http://localhost:3000/api", TOKEN, credentials);
    const fetch = answer(200, {});

    const result = await apiRequest("GET", "/v1/me/owners", options({ fetch }));

    expect(result).toMatchObject({ ok: false, error: { kind: "signed_in_elsewhere" } });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("a rejected token", () => {
  it("passes on the server's reason, which already says what to do", async () => {
    await saveToken(VARIS_API_ORIGIN, TOKEN, credentials);
    const fetch = answer(401, {
      error: {
        code: "unauthorized",
        message: "This machine was signed out. Run `varis login`.",
      },
      request_id: "var_req_1",
    });

    const result = await apiRequest("GET", "/v1/me/owners", options({ fetch }));

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({
        kind: "rejected_token",
        status: 401,
        code: "unauthorized",
        message: "This machine was signed out. Run varis login.",
        requestId: "var_req_1",
      }),
    });
  });

  it("adds the fix when the server's reason doesn't", async () => {
    await saveToken(VARIS_API_ORIGIN, TOKEN, credentials);
    const fetch = answer(401, { error: { code: "unauthorized", message: "Nope." } });

    const result = await apiRequest("GET", "/v1/me/owners", options({ fetch }));

    expect(result.ok === false && result.error.message).toBe("Nope. Run varis login.");
  });
});

describe("a network failure", () => {
  it("names the server it couldn't reach", async () => {
    await saveToken(VARIS_API_ORIGIN, TOKEN, credentials);
    const fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });

    const result = await apiRequest("GET", "/v1/me/owners", options({ fetch }));

    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: "network",
        message: expect.stringContaining(`Couldn't reach Varis at ${VARIS_API_ORIGIN}`),
      },
    });
  });

  it("says when VARIS_API_URL sent it somewhere else", async () => {
    const local = "http://localhost:3000/api";
    const fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });

    const result = await apiRequest("POST", "/v1/cli/device/code", options({
      fetch,
      auth: "none",
      env: { VARIS_API_URL: local },
    }));

    expect(result.ok === false && result.error.message).toContain(
      "(set by VARIS_API_URL)",
    );
  });

  it("reports a timeout as no answer in time", async () => {
    const fetch = vi.fn(async () => {
      throw new DOMException("timed out", "TimeoutError");
    });
    const result = await apiRequest("POST", "/v1/cli/device/code", options({
      fetch,
      auth: "none",
    }));
    expect(result.ok === false && result.error.message).toContain("didn't answer in time");
  });
});

describe("other server answers", () => {
  it("keeps a 400's field details", async () => {
    await saveToken(VARIS_API_ORIGIN, TOKEN, credentials);
    const fetch = answer(400, {
      error: {
        code: "invalid_request",
        message: "The service definition is invalid.",
        details: [{ path: "/endpoint_url", message: "must use https" }],
      },
    });

    const result = await apiRequest("POST", "/v1/services", options({ fetch, owner: OWNER }));

    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: "request",
        message: "The service definition is invalid.",
        details: [{ path: "/endpoint_url", message: "must use https" }],
      },
    });
  });

  it("reads the device flow's OAuth-shaped errors", async () => {
    const fetch = answer(400, {
      error: "slow_down",
      error_description: "Polling too often.",
      interval: 10,
    });

    const result = await apiRequest("POST", "/v1/cli/device/token", options({
      fetch,
      auth: "none",
    }));

    expect(result).toMatchObject({
      ok: false,
      error: { code: "slow_down", message: "Polling too often.", body: { interval: 10 } },
    });
  });

  it("reports a 403 as forbidden, with the server's reason", async () => {
    await saveToken(VARIS_API_ORIGIN, TOKEN, credentials);
    const fetch = answer(403, {
      error: { code: "forbidden", message: "You are not a member of var_ownr_x." },
    });
    const result = await apiRequest("POST", "/v1/services", options({ fetch, owner: OWNER }));
    expect(result).toMatchObject({
      ok: false,
      error: { kind: "forbidden", message: "You are not a member of var_ownr_x." },
    });
  });

  it("gives a 5xx's request ID, for support", async () => {
    await saveToken(VARIS_API_ORIGIN, TOKEN, credentials);
    const fetch = answer(500, {
      error: { code: "internal_error", message: "boom" },
      request_id: "var_req_42",
    });
    const result = await apiRequest("GET", "/v1/me/owners", options({ fetch }));
    expect(result.ok === false && result.error.message).toContain("request var_req_42");
    expect(result.ok === false && result.error.message).not.toContain("boom");
  });

  it("uses Retry-After in a rate limit message", async () => {
    const fetch = answer(429, {}, { "Retry-After": "30" });
    const result = await apiRequest("POST", "/v1/cli/device/code", options({
      fetch,
      auth: "none",
    }));
    expect(result.ok === false && result.error.message).toContain("Wait 30 seconds");
  });

  it("flags a success that isn't JSON", async () => {
    const fetch = answer(200, "<html>proxy page</html>");
    const result = await apiRequest("POST", "/v1/cli/device/code", options({
      fetch,
      auth: "none",
    }));
    expect(result).toMatchObject({ ok: false, error: { kind: "unexpected" } });
  });
});
